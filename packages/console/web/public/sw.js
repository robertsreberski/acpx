/*
 * Installability only. This worker deliberately caches nothing.
 *
 * The console is a live view of a local service: a cached shell would happily
 * show a stale transcript, or serve an old bundle against a newer API, and the
 * operator would have no way to tell. Chrome asks for a fetch handler before it
 * will offer to install, so this provides one and gets out of the way.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // No respondWith: every request goes to the network exactly as it would
  // without a worker.
});
