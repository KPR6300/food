"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const MENU = Object.freeze({
  "butter-paneer": { name: "Butter Paneer Bowl", price: 289 },
  "chicken-biryani-full": { name: "Chicken Biryani Full", price: 190 },
  "chicken-biryani-mini": { name: "Chicken Biryani Mini", price: 120 },
  "egg-fried-rice": { name: "Egg Fried Rice", price: 149 },
  "dal-khichdi": { name: "Ghee Khichdi & Tadka", price: 229 },
  "masala-fries": { name: "Chatpata Masala Fries", price: 149 },
  "chocolate-cake": { name: "Chocolate Cake Slice", price: 99 },
  "mango-lassi": { name: "Mango Lassi", price: 119 }
});
const ORDER_STATUSES = Object.freeze({
  received: "Order received",
  confirmed: "Confirmed",
  preparing: "Preparing",
  ready: "Ready for pickup",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled"
});

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

function normalizeCustomerPhone(phone) {
  if (typeof phone !== "string") return null;
  const trimmed = phone.trim();
  const digits = normalizePhone(trimmed);
  if (trimmed.startsWith("+") && /^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

function phoneIdentity(phone) {
  let digits = normalizePhone(phone);
  if (digits.length === 12 && /^91[6-9]\d{9}$/.test(digits)) digits = digits.slice(2);
  if (digits.length === 11 && /^0[6-9]\d{9}$/.test(digits)) digits = digits.slice(1);
  return digits;
}

function phonesMatch(left, right) {
  return phoneIdentity(left) === phoneIdentity(right);
}

function allowLimitedAttempt(attempts, key, limit, windowMs) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.until <= now) {
    attempts.set(key, { count: 1, until: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function safeEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

async function readJsonBody(request, maximumBytes = 20_000) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maximumBytes) {
      const error = new Error("Request is too large.");
      error.status = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Please send valid JSON.");
    error.status = 400;
    throw error;
  }
}

function validateOrder(body, availability, paymentAvailable) {
  const customer = body && body.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    return { error: "Please enter your contact and delivery details." };
  }

  const name = typeof customer.name === "string" ? customer.name.trim() : "";
  const phone = typeof customer.phone === "string" ? normalizePhone(customer.phone) : "";
  const houseNumber = typeof customer.houseNumber === "string" ? customer.houseNumber.trim() : "";
  const buildingName = typeof customer.buildingName === "string" ? customer.buildingName.trim() : "";
  const streetAddress = typeof customer.address === "string" ? customer.address.trim() : "";
  if (houseNumber.length > 40) return { error: "House or flat number must be 40 characters or fewer." };
  if (buildingName.length > 80) return { error: "Building name must be 80 characters or fewer." };
  const addressParts = [houseNumber, buildingName, streetAddress].filter(Boolean);
  const address = addressParts.join(", ");
  const hasLatitude = customer.latitude !== undefined && customer.latitude !== "";
  const hasLongitude = customer.longitude !== undefined && customer.longitude !== "";
  let location = null;
  if (hasLatitude !== hasLongitude) return { error: "Select a complete location on the map." };
  if (hasLatitude) {
    const latitude = Number(customer.latitude);
    const longitude = Number(customer.longitude);
    if (typeof customer.latitude !== "string" || typeof customer.longitude !== "string" ||
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return { error: "The selected map location is invalid. Please choose it again." };
    }
    location = { latitude, longitude };
  }
  if (name.length < 2 || name.length > 80) return { error: "Enter a name between 2 and 80 characters." };
  if (phone.length < 10 || phone.length > 15) return { error: "Enter a valid phone number." };
  if (address.length < 8 || address.length > 420) return { error: "Enter a complete delivery address within 420 characters." };
  const paymentMethod = customer.paymentMethod === "cash_on_delivery" ? "cash_on_delivery" : "upi";
  if (paymentMethod === "upi") {
    if (!paymentAvailable) return { error: "UPI payments are not set up yet. Please choose cash on delivery." };
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
    return { error: "Your bag is empty or contains too many items." };
  }

  const quantities = new Map();
  for (const item of body.items) {
    if (!item || typeof item.id !== "string" || !MENU[item.id] ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) {
      return { error: "One or more menu items are invalid." };
    }
    if (availability[item.id] !== true) return { error: `${MENU[item.id].name} is currently unavailable.` };
    quantities.set(item.id, (quantities.get(item.id) || 0) + item.quantity);
    if (quantities.get(item.id) > 20) return { error: "You can order up to 20 of each item." };
  }

  const items = [...quantities].map(([id, quantity]) => ({
    id,
    name: MENU[id].name,
    price: MENU[id].price,
    quantity
  }));
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (total > 100_000) return { error: "This order is over the online order limit." };
  return {
    order: {
      code: crypto.randomBytes(5).toString("hex").toUpperCase(),
      customer: {
        name,
        phone,
        address,
        ...(houseNumber ? { houseNumber } : {}),
        ...(buildingName ? { buildingName } : {}),
        ...(location ? { location } : {})
      },
      items,
      paymentMethod,
      paymentStatus: paymentMethod === "upi" ? "pending" : "pay_on_delivery",
      total,
      status: "received",
      statusHistory: [{ status: "received", at: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

function createApp({
  adminPassword,
  upiId,
  upiPayeeName,
  ordersFile = path.join(ROOT, "data", "orders.json"),
  availabilityFile = path.join(path.dirname(ordersFile), "menu-availability.json"),
  secureCookies = false
} = {}) {
  if (typeof adminPassword !== "string" || adminPassword.length < 12) {
    throw new Error("Set ADMIN_PASSWORD to a password with at least 12 characters.");
  }
  const normalizedUpiId = typeof upiId === "string" ? upiId.trim() : "";
  const normalizedPayeeName = typeof upiPayeeName === "string" ? upiPayeeName.trim() : "";
  const hasUpiDetails = Boolean(normalizedUpiId || normalizedPayeeName);
  if (hasUpiDetails &&
      (!normalizedUpiId || !/^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/.test(normalizedUpiId) ||
       normalizedPayeeName.length < 2 || normalizedPayeeName.length > 80)) {
    throw new Error("UPI_ID and UPI_PAYEE_NAME must be valid payment details.");
  }
  const upiPayment = hasUpiDetails
    ? { upiId: normalizedUpiId, payeeName: normalizedPayeeName }
    : null;
  let orders;
  let availability;
  let mutationQueue = Promise.resolve();
  let settingsMutationQueue = Promise.resolve();
  const sessions = new Map();
  const loginAttempts = new Map();
  const customerOrderLookupAttempts = new Map();
  const ordersReady = fs.readFile(ordersFile, "utf8")
    .then((contents) => {
      orders = JSON.parse(contents);
      if (!Array.isArray(orders)) throw new Error("Order database must contain a JSON array.");
    })
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
      orders = [];
    });

  const availabilityReady = fs.readFile(availabilityFile, "utf8")
    .then((contents) => {
      const saved = JSON.parse(contents);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
        throw new Error("Menu availability must contain a JSON object.");
      }
      if (saved["chicken-biryani"] !== undefined && typeof saved["chicken-biryani"] !== "boolean") {
        throw new Error("Availability for chicken-biryani must be true or false.");
      }
      const legacyBiryaniAvailable = saved["chicken-biryani"] === true;
      availability = Object.fromEntries(Object.keys(MENU).map((id) => {
        if (saved[id] !== undefined && typeof saved[id] !== "boolean") {
          throw new Error(`Availability for ${id} must be true or false.`);
        }
        const wasLegacyBiryani = id === "chicken-biryani-full" || id === "chicken-biryani-mini";
        return [id, saved[id] === true || (saved[id] === undefined && wasLegacyBiryani && legacyBiryaniAvailable)];
      }));
    })
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
      availability = Object.fromEntries(Object.keys(MENU).map((id) => [id, false]));
    });

  function mutateSettings(mutation) {
    const operation = settingsMutationQueue.then(async () => {
      await availabilityReady;
      return mutation();
    });
    settingsMutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function saveJsonAtomically(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temporaryFile, file);
  }

  function mutateOrders(mutation) {
    const operation = mutationQueue.then(async () => {
      await ordersReady;
      const result = mutation(orders);
      await saveJsonAtomically(ordersFile, orders);
      return result;
    });
    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function isAdmin(request) {
    const sessionId = parseCookies(request.headers.cookie).kitchen_session;
    if (!sessionId) return false;
    const session = sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' https://images.unsplash.com https://*.tile.openstreetmap.org https://unpkg.com data:; style-src 'self' 'unsafe-inline' https://unpkg.com; script-src 'self' 'unsafe-inline' https://unpkg.com; connect-src 'self' https://nominatim.openstreetmap.org; form-action 'self'; base-uri 'self'; frame-ancestors 'none'");

    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/menu") {
        await availabilityReady;
        const items = Object.entries(MENU).map(([id, item]) => ({
          id,
          ...item,
          available: availability[id] === true
        }));
        return sendJson(response, 200, {
          items,
          upiPayment
        });
      }

      if (request.method === "POST" && url.pathname === "/api/orders") {
        await availabilityReady;
        const body = await readJsonBody(request);
        const validated = validateOrder(body, availability, upiPayment !== null);
        if (validated.error) return sendJson(response, 400, { error: validated.error });
        const order = await mutateOrders((savedOrders) => {
          savedOrders.unshift(validated.order);
          return validated.order;
        });
        return sendJson(response, 201, {
          order: { code: order.code, total: order.total, status: order.status }
        });
      }

      if (request.method === "POST" && url.pathname === "/api/customer/orders/lookup") {
        const body = await readJsonBody(request);
        const phone = body && typeof body.phone === "string" ? body.phone.trim() : "";
        const phoneDigits = normalizePhone(phone);
        if (!normalizeCustomerPhone(phone)) {
          return sendJson(response, 400, { error: "Enter a valid mobile number, including the country code if needed." });
        }
        const ip = request.socket.remoteAddress || "unknown";
        const ipAttemptKey = `${ip}:customer-orders`;
        const phoneAttemptKey = `${ip}:customer-orders:${phoneIdentity(phoneDigits)}`;
        if (!allowLimitedAttempt(customerOrderLookupAttempts, ipAttemptKey, 30, 15 * 60_000) ||
            !allowLimitedAttempt(customerOrderLookupAttempts, phoneAttemptKey, 10, 15 * 60_000)) {
          return sendJson(response, 429, { error: "Too many order searches. Try again in 15 minutes." });
        }
        await ordersReady;
        const customerOrders = orders
          .filter((order) =>
            order.customer && typeof order.customer.phone === "string" &&
            phonesMatch(order.customer.phone, phoneDigits))
          .map((order) => ({
            code: order.code,
            items: order.items,
            total: order.total,
            status: order.status,
            statusLabel: ORDER_STATUSES[order.status] || "Order status unavailable",
            createdAt: order.createdAt,
            paymentMethod: order.paymentMethod,
            rating: order.rating || null
          }));
        return sendJson(response, 200, { orders: customerOrders });
      }

      const orderMatch = url.pathname.match(/^\/api\/orders\/([A-Fa-f0-9]{10})$/);
      if (request.method === "GET" && orderMatch) {
        await ordersReady;
        const phone = url.searchParams.get("phone") || "";
        const order = orders.find((entry) => entry.code === orderMatch[1].toUpperCase());
        if (!order || normalizePhone(phone) !== order.customer.phone) {
          return sendJson(response, 404, { error: "We couldn't find an order matching those details." });
        }
        return sendJson(response, 200, {
          order: {
            code: order.code,
            items: order.items,
            total: order.total,
            status: order.status,
            statusLabel: ORDER_STATUSES[order.status],
            updatedAt: order.updatedAt,
            rating: order.rating || null
          }
        });
      }

      const ratingMatch = url.pathname.match(/^\/api\/orders\/([A-Fa-f0-9]{10})\/rating$/);
      if (request.method === "POST" && ratingMatch) {
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            (body.comment !== undefined && typeof body.comment !== "string")) {
          return sendJson(response, 400, { error: "Please send a valid rating and optional comment." });
        }
        const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : "";
        const stars = body.rating;
        const comment = typeof body.comment === "string" ? body.comment.trim() : "";
        if (phone.length < 10 || phone.length > 15) {
          return sendJson(response, 400, { error: "Enter the phone number used for this order." });
        }
        if (!Number.isInteger(stars) || stars < 1 || stars > 5 || comment.length > 300) {
          return sendJson(response, 400, { error: "Choose 1–5 stars and keep your comment under 300 characters." });
        }
        const result = await mutateOrders((savedOrders) => {
          const order = savedOrders.find((entry) => entry.code === ratingMatch[1].toUpperCase());
          if (!order || order.customer.phone !== phone) return { error: "Order not found.", status: 404 };
          if (order.status !== "delivered") return { error: "You can rate an order after it is delivered.", status: 409 };
          if (order.rating) return { error: "This order has already been rated.", status: 409 };
          order.rating = { stars, comment, createdAt: new Date().toISOString() };
          order.updatedAt = order.rating.createdAt;
          return { rating: order.rating };
        });
        if (result.error) return sendJson(response, result.status, { error: result.error });
        return sendJson(response, 201, { rating: result.rating });
      }

      const customerDeleteMatch = url.pathname.match(/^\/api\/orders\/([A-Fa-f0-9]{10})$/);
      if (request.method === "DELETE" && customerDeleteMatch) {
        const body = await readJsonBody(request);
        const phone = body && typeof body.phone === "string" ? normalizePhone(body.phone) : "";
        if (phone.length < 10 || phone.length > 15) {
          return sendJson(response, 400, { error: "Enter the phone number used for this order." });
        }
        const deleted = await mutateOrders((savedOrders) => {
          const index = savedOrders.findIndex((entry) =>
            entry.code === customerDeleteMatch[1].toUpperCase() &&
            entry.customer &&
            typeof entry.customer.phone === "string" &&
            phonesMatch(entry.customer.phone, phone));
          if (index === -1) return false;
          savedOrders.splice(index, 1);
          return true;
        });
        if (!deleted) return sendJson(response, 404, { error: "We couldn't find an order matching those details." });
        return sendJson(response, 200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/admin/login") {
        const ip = request.socket.remoteAddress || "unknown";
        const attempt = loginAttempts.get(ip);
        if (attempt && attempt.until > Date.now() && attempt.count >= 5) {
          return sendJson(response, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
        }
        const body = await readJsonBody(request);
        const supplied = body && typeof body.password === "string" ? body.password : "";
        if (!safeEqual(supplied, adminPassword)) {
          const current = attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 15 * 60_000 };
          current.count += 1;
          loginAttempts.set(ip, current);
          return sendJson(response, 401, { error: "Incorrect password." });
        }
        loginAttempts.delete(ip);
        const sessionId = crypto.randomBytes(32).toString("hex");
        sessions.set(sessionId, { expiresAt: Date.now() + 12 * 60 * 60_000 });
        const cookie = `kitchen_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secureCookies ? "; Secure" : ""}`;
        return sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie });
      }

      if (request.method === "POST" && url.pathname === "/api/admin/logout") {
        const sessionId = parseCookies(request.headers.cookie).kitchen_session;
        if (sessionId) sessions.delete(sessionId);
        return sendJson(response, 200, { ok: true }, {
          "Set-Cookie": `kitchen_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? "; Secure" : ""}`
        });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/session") {
        return sendJson(response, 200, { authenticated: isAdmin(request) });
      }

      if (url.pathname.startsWith("/api/admin/") && !isAdmin(request)) {
        return sendJson(response, 401, { error: "Please sign in to the owner dashboard." });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/orders") {
        await ordersReady;
        return sendJson(response, 200, { orders });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/menu") {
        await availabilityReady;
        return sendJson(response, 200, {
          items: Object.entries(MENU).map(([id, item]) => ({
            id,
            ...item,
            available: availability[id] === true
          }))
        });
      }

      const availabilityMatch = url.pathname.match(/^\/api\/admin\/menu\/([a-z0-9-]+)\/availability$/);
      if (request.method === "PATCH" && availabilityMatch) {
        const id = availabilityMatch[1];
        if (!MENU[id]) return sendJson(response, 404, { error: "Menu item not found." });
        const body = await readJsonBody(request);
        if (!body || typeof body.available !== "boolean") {
          return sendJson(response, 400, { error: "Set availability to true or false." });
        }
        const item = await mutateSettings(async () => {
          const next = { ...availability, [id]: body.available };
          await saveJsonAtomically(availabilityFile, next);
          availability = next;
          return { id, available: next[id] };
        });
        return sendJson(response, 200, { item });
      }

      const statusMatch = url.pathname.match(/^\/api\/admin\/orders\/([A-Fa-f0-9]{10})\/status$/);
      if (request.method === "PATCH" && statusMatch) {
        const body = await readJsonBody(request);
        if (!body || !Object.hasOwn(ORDER_STATUSES, body.status)) {
          return sendJson(response, 400, { error: "Choose a valid order status." });
        }
        const updatedOrder = await mutateOrders((savedOrders) => {
          const order = savedOrders.find((entry) => entry.code === statusMatch[1].toUpperCase());
          if (!order) return null;
          order.status = body.status;
          order.updatedAt = new Date().toISOString();
          order.statusHistory.push({ status: body.status, at: order.updatedAt });
          return order;
        });
        if (!updatedOrder) return sendJson(response, 404, { error: "Order not found." });
        return sendJson(response, 200, {
          order: { code: updatedOrder.code, status: updatedOrder.status, updatedAt: updatedOrder.updatedAt }
        });
      }

      const paymentStatusMatch = url.pathname.match(/^\/api\/admin\/orders\/([A-Fa-f0-9]{10})\/payment$/);
      if (request.method === "PATCH" && paymentStatusMatch) {
        const body = await readJsonBody(request);
        if (!body || !["pending", "verified", "pay_on_delivery"].includes(body.status)) {
          return sendJson(response, 400, { error: "Choose a valid payment status." });
        }
        const updatedOrder = await mutateOrders((savedOrders) => {
          const order = savedOrders.find((entry) => entry.code === paymentStatusMatch[1].toUpperCase());
          if (!order) return null;
          order.paymentStatus = body.status;
          order.updatedAt = new Date().toISOString();
          return order;
        });
        if (!updatedOrder) return sendJson(response, 404, { error: "Order not found." });
        return sendJson(response, 200, {
          order: { code: updatedOrder.code, paymentStatus: updatedOrder.paymentStatus }
        });
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/admin" || url.pathname === "/admin.html")) {
        const file = url.pathname === "/admin" || url.pathname === "/admin.html" ? "admin.html" : "index.html";
        const contents = await fs.readFile(path.join(ROOT, file));
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache"
        });
        return response.end(contents);
      }

      return sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (response.headersSent) return response.destroy();
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error("Request failed:", error);
      return sendJson(response, status, { error: status >= 500 ? "The kitchen server had a problem. Please try again." : error.message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp({
    adminPassword: process.env.ADMIN_PASSWORD,
    upiId: process.env.UPI_ID,
    upiPayeeName: process.env.UPI_PAYEE_NAME,
    ordersFile: process.env.ORDERS_FILE ? path.resolve(process.env.ORDERS_FILE) : undefined,
    secureCookies: process.env.NODE_ENV === "production"
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`Cloud kitchen site listening on port ${port}`);
    console.log(`Owner dashboard: http://localhost:${port}/admin`);
  });
}

module.exports = { createApp };
