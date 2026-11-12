// Brindle's service worker. It exists so a phone can install the app; it caches nothing, because a stale copy of
// the app talking to a newer server is worse than a blank page when the server cannot be reached.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
