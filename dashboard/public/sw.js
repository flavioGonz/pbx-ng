const CACHE = 'pbxng-phone-v5';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try { const ks = await caches.keys(); await Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))); } catch (_) {}
    await self.clients.claim();
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach((c) => { try { c.postMessage({ type: 'sw-activated' }); } catch (_) {} });
  })());
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting' || (e.data && e.data.type === 'skipWaiting')) self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (_) { return; }
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith('/ws') || u.pathname.startsWith('/socket.io') || u.pathname.startsWith('/backend')) return;
  if (u.pathname === '/version.json') return;                    // siempre fresco
  if (req.headers.get('upgrade') === 'websocket') return;
  e.respondWith(
    fetch(req).catch(async () => (await caches.match(req)) || new Response('', { status: 504, statusText: 'offline' }))
  );
});

// -------- Web Push --------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'PBX-NG', body: e.data && e.data.text() }; }
  const isCall = d.type === 'call';
  const title = d.title || (isCall ? 'Llamada entrante' : 'PBX-NG');
  const opts = {
    body: d.body || (isCall ? ('Llamada de ' + (d.from || 'desconocido')) : ''),
    icon: '/icon-192.png', badge: '/icon-192.png',
    tag: d.tag || (isCall ? 'pbxng-call' : 'pbxng'),
    renotify: true, requireInteraction: isCall,
    vibrate: isCall ? [200, 100, 200, 100, 200] : [120],
    data: { url: d.url || '/phone', type: d.type, from: d.from },
    actions: isCall ? [{ action: 'answer', title: 'Atender' }, { action: 'reject', title: 'Rechazar' }] : [],
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const action = e.action || 'open';
  const from = data.from || '';
  const isCall = data.type === 'call';
  const target = isCall ? ('/phone?incall=' + encodeURIComponent(from)) : (data.url || '/phone');
  const msg = isCall
    ? { kind: 'incoming', from, autoAccept: action === 'answer', decline: action === 'reject' }
    : { kind: 'push-action', action, data };
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    let client = all.find((c) => c.url.includes('/phone')) || all[0];
    if (client) { try { await client.focus(); } catch (_) {} try { client.postMessage(msg); } catch (_) {} }
    else { const w = await clients.openWindow(target); if (w) { try { w.postMessage(msg); } catch (_) {} } }
  })());
});
