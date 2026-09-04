/* ArakIce service worker — PWA + Web Push notifications. */

// Take control ASAP so the app is controlled on first load.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Network-passthrough fetch handler (required for installability). No caching
// so the app is never served stale; swap for a cache strategy if you want
// offline support.
self.addEventListener("fetch", () => { /* let the browser handle it */ });

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }

  const title = data.title || "IceEdge";
  const options = {
    body: data.body || "",
    // 192/96 px et non /arakice-logo.png : ce dernier est le master 1024×1024
    // de 1,49 Mo, téléchargé à chaque notification pour une icône de 24 px.
    icon: "/arakice-mark-192.png",
    badge: "/arakice-mark-96.png",
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) { client.navigate(url); return client.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
