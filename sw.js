/* Offline support: serve from network when available, fall back to the cached copy. */
var CACHE = "material-orders-v10";
var FILES = ["./", "index.html", "css/app.css", "js/search.js", "js/app.js", "data/catalog.js", "manifest.webmanifest",
  "js/config.js", "js/cloud.js", "js/vendor/supabase.js", "js/vendor/jspdf.umd.min.js", "js/vendor/jspdf.plugin.autotable.min.js",
  "assets/kim-logo.png", "assets/icon-192.png", "assets/icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(function (r) { return r || caches.match("index.html"); });
    })
  );
});
