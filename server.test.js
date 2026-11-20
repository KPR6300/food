"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createApp } = require("./server");

test("owner dashboard inline script is valid JavaScript", async () => {
  const html = await fs.readFile(path.join(__dirname, "admin.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
});

test("customer page inline script is valid JavaScript", async () => {
  const html = await fs.readFile(path.join(__dirname, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
});

test("COD and UPI orders enforce menu availability and owner settings", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-kitchen-"));
  const ordersFile = path.join(directory, "orders.json");
  const availabilityFile = path.join(directory, "menu-availability.json");
  const server = createApp({
    adminPassword: "a-unique-test-password",
    upiId: "9177333167-2@ybl",
    upiPayeeName: "BANDARI RAVI",
    ordersFile,
    availabilityFile
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const initialMenu = await fetch(`${baseUrl}/api/menu`);
  const initialMenuData = await initialMenu.json();
  assert.equal(Object.hasOwn(initialMenuData, "paymentQrAvailable"), false);
  assert.ok(initialMenuData.items.every((item) => item.available === false));
  assert.deepEqual(initialMenuData.items.map((item) => [item.id, item.name, item.price]), [
    ["butter-paneer", "Butter Paneer Bowl", 289],
    ["chicken-biryani-full", "Chicken Biryani Full", 190],
    ["chicken-biryani-mini", "Chicken Biryani Mini", 120],
    ["egg-fried-rice", "Egg Fried Rice", 149],
    ["dal-khichdi", "Ghee Khichdi & Tadka", 229],
    ["masala-fries", "Chatpata Masala Fries", 149],
    ["chocolate-cake", "Chocolate Cake Slice", 99],
    ["mango-lassi", "Mango Lassi", 119]
  ]);

  const customer = {
    name: "A Customer",
    phone: "9876543210",
    houseNumber: "12B",
    buildingName: "Green Residency",
    address: "12 Example Road, Bengaluru",
    paymentMethod: "cash_on_delivery"
  };
  const items = [{ id: "butter-paneer", quantity: 2 }];
  const unauthorized = await fetch(`${baseUrl}/api/admin/menu`);
  assert.equal(unauthorized.status, 401);
  const anonymousSession = await fetch(`${baseUrl}/api/admin/session`);
  assert.equal((await anonymousSession.json()).authenticated, false);
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "a-unique-test-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const availability = await fetch(`${baseUrl}/api/admin/menu/butter-paneer/availability`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ available: true })
  });
  assert.equal(availability.status, 200);
  const removedQrUpload = await fetch(`${baseUrl}/api/admin/payment-qr`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ contentType: "image/png", encoded: "unused" })
  });
  assert.equal(removedQrUpload.status, 404);

  const unavailableItem = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer, items: [{ id: "chicken-biryani-full", quantity: 1 }] })
  });
  assert.equal(unavailableItem.status, 400);

  const incompleteLocation = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer: { ...customer, latitude: "17.45" },
      items
    })
  });
  assert.equal(incompleteLocation.status, 400);

  const created = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer: { ...customer, paymentMethod: "upi", latitude: "17.45", longitude: "78.61" },
      items: [{ id: "butter-paneer", quantity: 2, price: 1 }]
    })
  });
  assert.equal(created.status, 201);
  const { order } = await created.json();
  assert.equal(order.total, 578);

  const incorrectPhone = await fetch(`${baseUrl}/api/orders/${order.code}?phone=9999999999`);
  assert.equal(incorrectPhone.status, 404);
  const tracking = await fetch(`${baseUrl}/api/orders/${order.code}?phone=987-654-3210`);
  assert.equal(tracking.status, 200);
  assert.equal((await tracking.json()).order.status, "received");

  const authenticatedSession = await fetch(`${baseUrl}/api/admin/session`, { headers: { Cookie: cookie } });
  assert.equal((await authenticatedSession.json()).authenticated, true);
  const listed = await fetch(`${baseUrl}/api/admin/orders`, { headers: { Cookie: cookie } });
  assert.equal(listed.status, 200);
  const listedOrders = await listed.json();
  assert.equal(listedOrders.orders.length, 1);
  assert.equal(listedOrders.orders[0].paymentMethod, "upi");
  assert.equal(listedOrders.orders[0].paymentStatus, "pending");
  assert.equal(listedOrders.orders[0].customer.houseNumber, "12B");
  assert.equal(listedOrders.orders[0].customer.buildingName, "Green Residency");
  assert.deepEqual(listedOrders.orders[0].customer.location, { latitude: 17.45, longitude: 78.61 });

  const updated = await fetch(`${baseUrl}/api/admin/orders/${order.code}/status`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "preparing" })
  });
  assert.equal(updated.status, 200);
  const paymentVerified = await fetch(`${baseUrl}/api/admin/orders/${order.code}/payment`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "verified" })
  });
  assert.equal(paymentVerified.status, 200);
  const updatedTracking = await fetch(`${baseUrl}/api/orders/${order.code}?phone=9876543210`);
  assert.equal((await updatedTracking.json()).order.status, "preparing");

  const prematureRating = await fetch(`${baseUrl}/api/orders/${order.code}/rating`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "9876543210", rating: 5, comment: "Great meal" })
  });
  assert.equal(prematureRating.status, 409);

  const delivered = await fetch(`${baseUrl}/api/admin/orders/${order.code}/status`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "delivered" })
  });
  assert.equal(delivered.status, 200);
  const ratingForWrongPhone = await fetch(`${baseUrl}/api/orders/${order.code}/rating`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "9999999999", rating: 5, comment: "Great meal" })
  });
  assert.equal(ratingForWrongPhone.status, 404);
  const ratingResponse = await fetch(`${baseUrl}/api/orders/${order.code}/rating`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "987-654-3210", rating: 5, comment: "Great meal" })
  });
  assert.equal(ratingResponse.status, 201);
  const duplicateRating = await fetch(`${baseUrl}/api/orders/${order.code}/rating`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "9876543210", rating: 4, comment: "" })
  });
  assert.equal(duplicateRating.status, 409);

  const deliveredTracking = await fetch(`${baseUrl}/api/orders/${order.code}?phone=9876543210`);
  const deliveredOrder = (await deliveredTracking.json()).order;
  assert.equal(deliveredOrder.status, "delivered");
  assert.equal(deliveredOrder.rating.stars, 5);
  assert.equal(deliveredOrder.rating.comment, "Great meal");

  const logout = await fetch(`${baseUrl}/api/admin/logout`, {
    method: "POST",
    headers: { Cookie: cookie }
  });
  assert.equal(logout.status, 200);
  const signedOutOrders = await fetch(`${baseUrl}/api/admin/orders`, { headers: { Cookie: cookie } });
  assert.equal(signedOutOrders.status, 401);

  const relogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "a-unique-test-password" })
  });
  assert.equal(relogin.status, 200);
  const reloginCookie = relogin.headers.get("set-cookie").split(";")[0];
  const ordersAfterRelogin = await fetch(`${baseUrl}/api/admin/orders`, {
    headers: { Cookie: reloginCookie }
  });
  assert.equal(ordersAfterRelogin.status, 200);
  const restoredOrders = await ordersAfterRelogin.json();
  assert.equal(restoredOrders.orders.length, 1);
  assert.equal(restoredOrders.orders[0].code, order.code);

  const persistedOrders = JSON.parse(await fs.readFile(ordersFile, "utf8"));
  assert.equal(persistedOrders.length, 1);
  assert.equal(persistedOrders[0].statusHistory.length, 3);
  assert.equal(persistedOrders[0].paymentStatus, "verified");
  assert.equal(persistedOrders[0].rating.stars, 5);
  assert.deepEqual(JSON.parse(await fs.readFile(availabilityFile, "utf8")), {
    "butter-paneer": true,
    "chicken-biryani-full": false,
    "chicken-biryani-mini": false,
    "egg-fried-rice": false,
    "dal-khichdi": false,
    "masala-fries": false,
    "chocolate-cake": false,
    "mango-lassi": false
  });
});

test("owner password must be configured securely", () => {
  assert.throws(() => createApp({ adminPassword: "short" }), /at least 12 characters/);
});

test("COD remains available when UPI settings are missing", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-kitchen-no-upi-"));
  const availabilityFile = path.join(directory, "menu-availability.json");
  await fs.writeFile(availabilityFile, JSON.stringify({ "butter-paneer": true }));
  const server = createApp({
    adminPassword: "a-unique-test-password",
    ordersFile: path.join(directory, "orders.json"),
    availabilityFile
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer: {
        name: "A Customer",
        phone: "9876543210",
        address: "12 Example Road, Bengaluru",
        paymentMethod: "cash_on_delivery"
      },
      items: [{ id: "butter-paneer", quantity: 1 }]
    })
  });
  assert.equal(response.status, 201);
  const order = (await response.json()).order;
  assert.equal(order.total, 289);
});

test("configured UPI app details enable UPI-only checkout", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-kitchen-upi-intent-"));
  const availabilityFile = path.join(directory, "menu-availability.json");
  await fs.writeFile(availabilityFile, JSON.stringify({ "butter-paneer": true }));
  const server = createApp({
    adminPassword: "a-unique-test-password",
    upiId: "9177333167-2@ybl",
    upiPayeeName: "BANDARI RAVI",
    ordersFile: path.join(directory, "orders.json"),
    availabilityFile
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const menu = await fetch(`${baseUrl}/api/menu`);
  const menuData = await menu.json();
  assert.deepEqual(menuData.upiPayment, {
    upiId: "9177333167-2@ybl",
    payeeName: "BANDARI RAVI"
  });
  assert.equal(Object.hasOwn(menuData, "paymentQrAvailable"), false);

  const response = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer: {
        name: "A Customer",
        phone: "9876543210",
        address: "12 Example Road, Bengaluru",
        paymentMethod: "upi"
      },
      items: [{ id: "butter-paneer", quantity: 1 }]
    })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).order.total, 289);
  assert.throws(() => createApp({
    adminPassword: "a-unique-test-password",
    upiId: "not-a-vpa",
    upiPayeeName: "BANDARI RAVI"
  }), /valid payment details/);
});

test("phone OTP verifies customers before returning their order history", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-kitchen-my-orders-"));
  const ordersFile = path.join(directory, "orders.json");
  await fs.writeFile(ordersFile, JSON.stringify([
    {
      code: "AABBCCDDEE",
      customer: { name: "First Customer", phone: "9876543210", address: "Example Road" },
      items: [{ id: "butter-paneer", name: "Butter Paneer Bowl", price: 289, quantity: 1 }],
      total: 289,
      status: "delivered",
      paymentMethod: "cash_on_delivery",
      createdAt: "2026-11-20T10:00:00.000Z"
    },
    {
      code: "1122334455",
      customer: { name: "Another Customer", phone: "9999999999", address: "Other Road" },
      items: [{ id: "egg-fried-rice", name: "Egg Fried Rice", price: 149, quantity: 1 }],
      total: 149,
      status: "received",
      paymentMethod: "upi",
      createdAt: "2026-11-20T11:00:00.000Z"
    }
  ]));
  const twilioRequests = [];
  const server = createApp({
    adminPassword: "a-unique-test-password",
    ordersFile,
    twilioAccountSid: "AC00000000000000000000000000000000",
    twilioAuthToken: "test-auth-token",
    twilioVerifyServiceSid: "VA00000000000000000000000000000000",
    fetchImpl: async (url, options) => {
      const fields = new URLSearchParams(options.body);
      twilioRequests.push({ url, fields, authorization: options.headers.Authorization });
      const isCheck = url.endsWith("/VerificationCheck");
      const status = !isCheck ? "pending" : fields.get("Code") === "123456" ? "approved" : "pending";
      return new Response(JSON.stringify({ status }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sendCode = await fetch(`${baseUrl}/api/customer/orders/send-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "+91 98765 43210" })
  });
  assert.equal(sendCode.status, 200);
  assert.equal(twilioRequests[0].fields.get("To"), "+919876543210");
  assert.equal(twilioRequests[0].fields.get("Channel"), "sms");

  const unknownNumber = await fetch(`${baseUrl}/api/customer/orders/send-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "9123456789" })
  });
  assert.equal(unknownNumber.status, 200);
  assert.equal(twilioRequests.length, 1);

  const invalidCode = await fetch(`${baseUrl}/api/customer/orders/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "9876543210", code: "000000" })
  });
  assert.equal(invalidCode.status, 401);

  const verified = await fetch(`${baseUrl}/api/customer/orders/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "9876543210", code: "123456" })
  });
  assert.equal(verified.status, 200);
  const history = await verified.json();
  assert.deepEqual(history.orders.map((order) => order.code), ["AABBCCDDEE"]);
  assert.equal(history.orders[0].statusLabel, "Delivered");
  assert.equal(Object.hasOwn(history.orders[0], "customer"), false);
  assert.equal(twilioRequests.length, 3);
});

test("owner menu availability survives a server restart", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-kitchen-availability-"));
  const ordersFile = path.join(directory, "orders.json");
  const availabilityFile = path.join(directory, "menu-availability.json");
  let server = createApp({
    adminPassword: "a-unique-test-password",
    ordersFile,
    availabilityFile
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  let baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "a-unique-test-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const changedAvailability = await fetch(`${baseUrl}/api/admin/menu/butter-paneer/availability`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ available: true })
  });
  assert.equal(changedAvailability.status, 200);
  const beforeRestart = await fetch(`${baseUrl}/api/menu`);
  const beforeRestartItems = (await beforeRestart.json()).items;
  assert.equal(beforeRestartItems.find((item) => item.id === "butter-paneer").available, true);

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = createApp({ adminPassword: "a-unique-test-password", ordersFile, availabilityFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const afterRestart = await fetch(`${baseUrl}/api/menu`);
  const afterRestartItems = (await afterRestart.json()).items;
  assert.equal(afterRestartItems.find((item) => item.id === "butter-paneer").available, true);
  assert.equal(afterRestartItems.find((item) => item.id === "egg-fried-rice").available, false);
});

test("saved chicken biryani availability carries over to its full and mini menu items", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-kitchen-menu-migration-"));
  const availabilityFile = path.join(directory, "menu-availability.json");
  await fs.writeFile(availabilityFile, JSON.stringify({ "chicken-biryani": true }));
  const server = createApp({
    adminPassword: "a-unique-test-password",
    ordersFile: path.join(directory, "orders.json"),
    availabilityFile
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/menu`);
  const { items } = await response.json();
  const availability = Object.fromEntries(items.map((item) => [item.id, item.available]));
  assert.equal(availability["chicken-biryani-full"], true);
  assert.equal(availability["chicken-biryani-mini"], true);
  assert.equal(availability["egg-fried-rice"], false);
});
