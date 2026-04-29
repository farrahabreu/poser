/* POSER Service Worker — Push Notifications */
'use strict';

const ICON = '/icon-192.png';

// Activate immediately — no waiting for old SW to die
self.addEventListener('install',   () => self.skipWaiting());
self.addEventListener('activate',  e  => e.waitUntil(clients.claim()));

// ── Push handler ──────────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch {}

  const title   = payload.title  || 'POSER';
  const body    = payload.body   || '';
  const url     = payload.url    || '/';
  const type    = payload.type   || '';

  const icon    = ICON;
  const badge   = ICON;
  const tag     = `poser-${type || 'notif'}-${Date.now()}`;

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag,
      data: { url },
      vibrate: [100, 50, 100],
    })
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus an existing POSER tab if one is open
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      // Otherwise open a new tab
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
