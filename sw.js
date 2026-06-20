const C = "port-v13";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(SHELL).catch(()=>{}))); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.hostname.includes("supabase") || u.hostname.includes("esm.sh") || u.hostname.includes("fonts")) return; // never cache API/CDN
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "Port", body: (e.data && e.data.text()) || "" }; }
  e.waitUntil((async () => {
    const cls = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (cls.some((c) => c.visibilityState === "visible")) return; // app open -> skip
    await self.registration.showNotification(d.title || "Port", {
      body: d.body || "", data: { url: d.url || "/" }, icon: "./icon.svg", badge: "./icon.svg", tag: "port"
    });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const cls = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cls) { if ("focus" in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
