const CACHE = 'pbxng-phone-v6';
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

/* Páginas PÚBLICAS que se le mandan a alguien de afuera: la sala de reunión y la llamada
 * desde la web. No pasan por el service worker.
 *
 * Por qué merecen la excepción: el invitado abre ese enlace UNA vez, en su teléfono, desde
 * una red que no controlamos, y muchas veces es la primera impresión que tiene del sistema.
 * Si algo falla ahí no hay una segunda oportunidad ni alguien a quien preguntarle. El
 * service worker existe para el teléfono web (la caché se llama `pbxng-phone-*`); meter en
 * el medio una capa pensada para otra cosa sólo agrega formas de fallar. */
const PUBLICAS = ['/sala/', '/call/'];

const PAGINA_SIN_RED = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sin conexion</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;align-items:center;
justify-content:center;background:#12141a;color:#e8ebf0;font:15px/1.5 system-ui,sans-serif;padding:24px}
.c{max-width:360px;text-align:center}h1{font-size:19px;margin:0 0 8px}p{margin:0 0 18px;color:#9fb0cc}
button{font:inherit;padding:10px 20px;border-radius:10px;border:none;background:#2563eb;color:#fff;cursor:pointer}
</style></head><body><div class="c"><h1>Sin conexion</h1>
<p>No se pudo contactar a la central. Revisa tu conexion y volve a intentar.</p>
<button onclick="location.reload()">Reintentar</button></div></body></html>`;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (_) { return; }
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith('/ws') || u.pathname.startsWith('/socket.io') || u.pathname.startsWith('/backend')) return;
  if (u.pathname === '/version.json') return;                    // siempre fresco
  if (PUBLICAS.some((p) => u.pathname.startsWith(p))) return;
  if (req.headers.get('upgrade') === 'websocket') return;
  e.respondWith(
    fetch(req).catch(async () => {
      const guardada = await caches.match(req);
      if (guardada) return guardada;
      /* Una navegación que falla tiene que DECIR que falló. Antes se devolvía
       * `new Response('', { status: 504 })`: cuerpo vacío, o sea pantalla en blanco y un
       * «504 (offline)» en la consola que parece un error del servidor y no lo es — lo
       * fabrica esta línea. Un corte de red de un segundo al despertar la máquina dejaba
       * la pantalla muerta sin una palabra.
       *
       * Para lo que no es una navegación (un .js, una imagen) NO se inventa respuesta: se
       * deja pasar el error real de red, que es lo que el próximo que depure necesita ver. */
      if (req.mode !== 'navigate') throw new Error('sin red');
      return new Response(PAGINA_SIN_RED, { status: 503, statusText: 'sin conexion',
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    })
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
