// Trickle Down's service worker: daily reminders only. No caching, no fetch
// handler, so the site behaves exactly as it does without it.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(String(data.title || 'Trickle Down').slice(0, 60), {
    body: String(data.body || 'The coin is waiting.').slice(0, 200),
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'trickle-daily',
  }));
});

// Tapping it opens (or focuses) the game. Only ever this site.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const home = self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(home) && 'focus' in c) return c.focus();
    return self.clients.openWindow(home);
  }));
});
