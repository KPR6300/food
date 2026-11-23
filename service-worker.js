"use strict";

self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (error) {
      console.error("Could not parse owner push notification:", error);
    }
  }
  const title = typeof payload.title === "string" ? payload.title : "New order received";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "A new order is waiting in the owner dashboard.",
    tag: typeof payload.tag === "string" ? payload.tag : "new-order",
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { url: typeof payload.url === "string" ? payload.url : "/admin" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data.url, self.location.origin);
  const path = destination.origin === self.location.origin ? destination.href : new URL("/admin", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      const current = new URL(client.url);
      if (current.origin === self.location.origin && /^\/admin(?:\.html)?\/?$/.test(current.pathname) && "focus" in client) {
        return client.focus();
      }
    }
    return self.clients.openWindow(path);
  }));
});
