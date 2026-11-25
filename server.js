"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const webPushReady = import("web-push");
const mysql = require("mysql2/promise");

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

function isValidPushSubject(subject) {
  try {
    const parsed = new URL(subject);
    return parsed.protocol === "https:"
      ? Boolean(parsed.hostname)
      : parsed.protocol === "mailto:" && parsed.pathname.includes("@");
  } catch {
    return false;
  }
}

function createApp({
  adminPassword,
  upiId,
  upiPayeeName,
  ordersFile = path.join(ROOT, "data", "orders.json"),
  availabilityFile = path.join(path.dirname(ordersFile), "menu-availability.json"),
  pushSubscriptionsFile = path.join(path.dirname(ordersFile), "push-subscriptions.json"),
  databasePool = null,
  pushPublicKey,
  pushPrivateKey,
  pushSubject,
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
  const normalizedPushPublicKey = typeof pushPublicKey === "string" ? pushPublicKey.trim() : "";
  const normalizedPushPrivateKey = typeof pushPrivateKey === "string" ? pushPrivateKey.trim() : "";
  const normalizedPushSubject = typeof pushSubject === "string" ? pushSubject.trim() : "";
  const hasPushConfiguration = Boolean(normalizedPushPublicKey || normalizedPushPrivateKey || normalizedPushSubject);
  const publicPushKeyBytes = /^[A-Za-z0-9_-]+$/.test(normalizedPushPublicKey)
    ? Buffer.from(normalizedPushPublicKey, "base64url")
    : Buffer.alloc(0);
  const privatePushKeyBytes = /^[A-Za-z0-9_-]+$/.test(normalizedPushPrivateKey)
    ? Buffer.from(normalizedPushPrivateKey, "base64url")
    : Buffer.alloc(0);
  if (hasPushConfiguration &&
      (publicPushKeyBytes.length !== 65 || publicPushKeyBytes.toString("base64url") !== normalizedPushPublicKey ||
       privatePushKeyBytes.length !== 32 || privatePushKeyBytes.toString("base64url") !== normalizedPushPrivateKey ||
       publicPushKeyBytes[0] !== 4 || !isValidPushSubject(normalizedPushSubject))) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be configured.");
  }
  const pushClientReady = hasPushConfiguration
    ? webPushReady.then((webPushModule) => {
      webPushModule.setVapidDetails(normalizedPushSubject, normalizedPushPublicKey, normalizedPushPrivateKey);
      return webPushModule;
    })
    : Promise.resolve(null);
  const pushNotificationsEnabled = hasPushConfiguration;
  let orders;
  let availability;
  let mutationQueue = Promise.resolve();
  let settingsMutationQueue = Promise.resolve();
  let pushSubscriptions;
  let pushSubscriptionsQueue = Promise.resolve();
  const sessions = new Map();
  const loginAttempts = new Map();
  const customerOrderLookupAttempts = new Map();
  const databaseReady = databasePool
    ? (async () => {
      const connection = await databasePool.getConnection();
      try {
        await connection.beginTransaction();
        const [migrationRows] = await connection.execute(
          "SELECT meta_value FROM app_metadata WHERE meta_key = ?",
          ["json_storage_migration_v1"]
        );
        if (migrationRows.length > 0) {
          await connection.commit();
          return;
        }

        const readLegacyJson = async (file) => {
          try {
            return JSON.parse(await fs.readFile(file, "utf8"));
          } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
          }
        };
        const legacyOrders = await readLegacyJson(ordersFile);
        if (legacyOrders !== null && !Array.isArray(legacyOrders)) {
          throw new Error("Existing orders file must contain a JSON array before MySQL migration.");
        }
        const [orderCounts] = await connection.query("SELECT COUNT(*) AS count FROM orders");
        if (orderCounts[0].count === 0 && Array.isArray(legacyOrders)) {
          for (const order of legacyOrders) {
            if (!order.code || !order.customer || !order.customer.phone) {
              throw new Error("Cannot migrate an order without its code and customer phone.");
            }
            await connection.execute(
              `INSERT INTO orders (order_code, customer_phone, status, payment_status, created_at, order_data)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                order.code,
                order.customer.phone,
                order.status || "received",
                order.paymentStatus || null,
                order.createdAt || new Date().toISOString(),
                JSON.stringify(order)
              ]
            );
          }
        }

        const legacyAvailability = await readLegacyJson(availabilityFile);
        if (legacyAvailability !== null &&
            (!legacyAvailability || typeof legacyAvailability !== "object" || Array.isArray(legacyAvailability))) {
          throw new Error("Existing menu availability file must contain a JSON object before MySQL migration.");
        }
        const [availabilityCounts] = await connection.query("SELECT COUNT(*) AS count FROM menu_availability");
        if (availabilityCounts[0].count === 0 && legacyAvailability &&
            typeof legacyAvailability === "object" && !Array.isArray(legacyAvailability)) {
          if (legacyAvailability["chicken-biryani"] !== undefined &&
              typeof legacyAvailability["chicken-biryani"] !== "boolean") {
            throw new Error("Existing chicken-biryani availability must be true or false.");
          }
          for (const id of Object.keys(MENU)) {
            if (legacyAvailability[id] !== undefined && typeof legacyAvailability[id] !== "boolean") {
              throw new Error(`Existing availability for ${id} must be true or false.`);
            }
            const isLegacyBiryani = id === "chicken-biryani-full" || id === "chicken-biryani-mini";
            const value = legacyAvailability[id] !== undefined
              ? legacyAvailability[id]
              : isLegacyBiryani && legacyAvailability["chicken-biryani"] === true;
            await connection.execute(
              "INSERT INTO menu_availability (item_id, available) VALUES (?, ?)",
              [id, value === true]
            );
          }
        }

        const legacySubscriptions = await readLegacyJson(pushSubscriptionsFile);
        if (legacySubscriptions !== null && !Array.isArray(legacySubscriptions)) {
          throw new Error("Existing push subscriptions file must contain a JSON array before MySQL migration.");
        }
        const [subscriptionCounts] = await connection.query("SELECT COUNT(*) AS count FROM push_subscriptions");
        if (subscriptionCounts[0].count === 0 && Array.isArray(legacySubscriptions)) {
          for (const subscription of legacySubscriptions) {
            const endpointHash = crypto.createHash("sha256").update(subscription.endpoint).digest("hex");
            await connection.execute(
              "INSERT INTO push_subscriptions (endpoint_hash, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)",
              [endpointHash, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
            );
          }
        }
        await connection.execute(
          "INSERT INTO app_metadata (meta_key, meta_value) VALUES (?, ?)",
          ["json_storage_migration_v1", new Date().toISOString()]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    })()
    : Promise.resolve();

  const ordersReady = databasePool
    ? databaseReady.then(() => databasePool.query("SELECT order_data FROM orders ORDER BY created_at DESC"))
      .then(([rows]) => {
        orders = rows.map((row) => typeof row.order_data === "string" ? JSON.parse(row.order_data) : row.order_data);
      })
    : fs.readFile(ordersFile, "utf8")
      .then((contents) => {
        orders = JSON.parse(contents);
        if (!Array.isArray(orders)) throw new Error("Order database must contain a JSON array.");
      })
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        orders = [];
      });

  const availabilityReady = databasePool
    ? databaseReady.then(() => databasePool.query("SELECT item_id, available FROM menu_availability"))
      .then(([rows]) => {
        availability = Object.fromEntries(Object.keys(MENU).map((id) => [id, false]));
        for (const row of rows) {
          if (Object.hasOwn(availability, row.item_id)) availability[row.item_id] = Boolean(row.available);
        }
      })
    : fs.readFile(availabilityFile, "utf8")
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
        if (saved[id] !== undefined) return [id, saved[id]];
        if (wasLegacyBiryani && saved["chicken-biryani"] !== undefined) {
          return [id, legacyBiryaniAvailable];
        }
        return [id, false];
      }));
      })
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        availability = Object.fromEntries(Object.keys(MENU).map((id) => [id, false]));
      });

  const pushSubscriptionsReady = databasePool
    ? databaseReady.then(() => databasePool.query("SELECT endpoint, p256dh, auth FROM push_subscriptions"))
      .then(([rows]) => {
        pushSubscriptions = rows.map((row) => ({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth }
        }));
      })
    : fs.readFile(pushSubscriptionsFile, "utf8")
      .then((contents) => {
      pushSubscriptions = JSON.parse(contents);
      if (!Array.isArray(pushSubscriptions)) {
        throw new Error("Push subscriptions database must contain a JSON array.");
      }
      })
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        pushSubscriptions = [];
      });

  if (databasePool) {
    Promise.all([ordersReady, availabilityReady, pushSubscriptionsReady]).catch((error) => {
      console.error("Could not initialize MySQL storage:", error);
    });
  }

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

  async function saveOrderToDatabase(order) {
    await databasePool.execute(
      `INSERT INTO orders (order_code, customer_phone, status, payment_status, created_at, order_data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE customer_phone = VALUES(customer_phone), status = VALUES(status),
       payment_status = VALUES(payment_status), created_at = VALUES(created_at), order_data = VALUES(order_data)`,
      [
        order.code,
        order.customer.phone,
        order.status,
        order.paymentStatus || null,
        order.createdAt,
        JSON.stringify(order)
      ]
    );
  }

  async function savePushSubscriptionsToDatabase(subscriptions) {
    const connection = await databasePool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("DELETE FROM push_subscriptions");
      for (const subscription of subscriptions) {
        const endpointHash = crypto.createHash("sha256").update(subscription.endpoint).digest("hex");
        await connection.execute(
          "INSERT INTO push_subscriptions (endpoint_hash, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)",
          [endpointHash, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  function mutateOrders(mutation) {
    const operation = mutationQueue.then(async () => {
      await ordersReady;
      const updatedOrders = structuredClone(orders);
      const result = mutation(updatedOrders);
      const changedOrder = result && result.order
        ? result.order
        : result && typeof result.code === "string" ? result : null;
      if (databasePool) {
        if (changedOrder) await saveOrderToDatabase(changedOrder);
      } else {
        await saveJsonAtomically(ordersFile, updatedOrders);
      }
      orders = updatedOrders;
      return result;
    });
    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function mutatePushSubscriptions(mutation) {
    const operation = pushSubscriptionsQueue.then(async () => {
      await pushSubscriptionsReady;
      const updatedSubscriptions = pushSubscriptions.map((subscription) => ({
        ...subscription,
        keys: { ...subscription.keys }
      }));
      const result = mutation(updatedSubscriptions);
      if (databasePool) {
        await savePushSubscriptionsToDatabase(updatedSubscriptions);
      } else {
        await saveJsonAtomically(pushSubscriptionsFile, updatedSubscriptions);
      }
      pushSubscriptions = updatedSubscriptions;
      return result;
    });
    pushSubscriptionsQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function notifyOwnerOfOrder(order) {
    if (!pushNotificationsEnabled) return;
    await pushSubscriptionsReady;
    const webPush = await pushClientReady;
    const payload = JSON.stringify({
      title: "New order received",
      body: `Order ${order.code} · Total ₹${order.total}`,
      tag: `new-order-${order.code}`,
      url: "/admin"
    });
    const staleEndpoints = [];
    await Promise.all(pushSubscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(subscription, payload);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          staleEndpoints.push(subscription.endpoint);
        } else {
          console.error("Could not deliver owner order notification:", error);
        }
      }
    }));
    if (staleEndpoints.length > 0) {
      await mutatePushSubscriptions((subscriptions) => {
        const stale = new Set(staleEndpoints);
        subscriptions.splice(0, subscriptions.length,
          ...subscriptions.filter((subscription) => !stale.has(subscription.endpoint)));
      });
    }
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
        notifyOwnerOfOrder(order).catch((error) => {
          console.error("Could not send owner order notification:", error);
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
          return { rating: order.rating, order };
        });
        if (result.error) return sendJson(response, result.status, { error: result.error });
        return sendJson(response, 201, { rating: result.rating });
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

      if (request.method === "GET" && url.pathname === "/api/admin/push/config") {
        return sendJson(response, 200, {
          enabled: pushNotificationsEnabled,
          publicKey: pushNotificationsEnabled ? normalizedPushPublicKey : null
        });
      }

      if (url.pathname === "/api/admin/push/subscriptions" &&
          (request.method === "POST" || request.method === "DELETE")) {
        if (!pushNotificationsEnabled) {
          return sendJson(response, 503, { error: "Owner push notifications are not configured on the server." });
        }
        const body = await readJsonBody(request);
        if (!body || typeof body.endpoint !== "string") {
          return sendJson(response, 400, { error: "A valid push subscription is required." });
        }
        let endpoint;
        try {
          endpoint = new URL(body.endpoint);
        } catch {
          return sendJson(response, 400, { error: "A valid push subscription is required." });
        }
        if (endpoint.protocol !== "https:") {
          return sendJson(response, 400, { error: "Push subscription endpoint must use HTTPS." });
        }
        if (request.method === "POST") {
          if (!body.keys || typeof body.keys.p256dh !== "string" ||
              typeof body.keys.auth !== "string" || body.keys.p256dh.length > 200 ||
              body.keys.auth.length > 100) {
            return sendJson(response, 400, { error: "Push subscription keys are invalid." });
          }
          await mutatePushSubscriptions((subscriptions) => {
            const existingIndex = subscriptions.findIndex((entry) => entry.endpoint === endpoint.href);
            const subscription = {
              endpoint: endpoint.href,
              keys: { p256dh: body.keys.p256dh, auth: body.keys.auth }
            };
            if (existingIndex === -1) subscriptions.push(subscription);
            else subscriptions[existingIndex] = subscription;
          });
          return sendJson(response, 201, { ok: true });
        }
        await mutatePushSubscriptions((subscriptions) => {
          subscriptions.splice(0, subscriptions.length,
            ...subscriptions.filter((entry) => entry.endpoint !== endpoint.href));
        });
        return sendJson(response, 200, { ok: true });
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
          if (databasePool) {
            await databasePool.execute(
              "INSERT INTO menu_availability (item_id, available) VALUES (?, ?) ON DUPLICATE KEY UPDATE available = VALUES(available)",
              [id, body.available]
            );
          } else {
            await saveJsonAtomically(availabilityFile, next);
          }
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

      if (request.method === "GET" && url.pathname === "/service-worker.js") {
        const contents = await fs.readFile(path.join(ROOT, "service-worker.js"));
        response.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
          "Service-Worker-Allowed": "/"
        });
        return response.end(contents);
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
  require("dotenv").config();
  const port = Number(process.env.PORT) || 3000;
  const hasMysqlSettings = Boolean(
    process.env.MYSQL_HOST || process.env.MYSQL_DATABASE ||
    process.env.MYSQL_USER || process.env.MYSQL_PASSWORD
  );
  if (hasMysqlSettings &&
      (!process.env.MYSQL_HOST || !process.env.MYSQL_DATABASE || !process.env.MYSQL_USER)) {
    throw new Error("Set MYSQL_HOST, MYSQL_DATABASE, and MYSQL_USER to enable MySQL storage.");
  }
  const databasePool = hasMysqlSettings
    ? mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT) || 3306,
      database: process.env.MYSQL_DATABASE,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD || "",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: "Z"
    })
    : null;
  const server = createApp({
    adminPassword: process.env.ADMIN_PASSWORD,
    upiId: process.env.UPI_ID,
    upiPayeeName: process.env.UPI_PAYEE_NAME,
    ordersFile: process.env.ORDERS_FILE ? path.resolve(process.env.ORDERS_FILE) : undefined,
    pushPublicKey: process.env.VAPID_PUBLIC_KEY,
    pushPrivateKey: process.env.VAPID_PRIVATE_KEY,
    pushSubject: process.env.VAPID_SUBJECT,
    databasePool,
    secureCookies: process.env.NODE_ENV === "production"
  });
  if (databasePool) {
    server.on("close", () => {
      databasePool.end().catch((error) => console.error("Could not close the MySQL pool:", error));
    });
  }
  server.listen(port, "0.0.0.0", () => {
    console.log(`Cloud kitchen site listening on port ${port}`);
    console.log(`Owner dashboard: http://localhost:${port}/admin`);
  });
}

module.exports = { createApp };
