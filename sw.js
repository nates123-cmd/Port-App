const C = "port-v5";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(SHELL).catch(()=>{}))); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.hostname.includes("supabase") || u.hostname.includes("esm.sh") || u.hostname.includes("fonts")) return; // never cache API/CDN
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
