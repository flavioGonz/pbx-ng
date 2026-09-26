'use strict';
/* ============================================================================
 *  PBX-NG · Las cámaras del Intercom, servidas por la propia central.
 *
 *  EL PROBLEMA QUE RESUELVE: go2rtc —el que convierte el RTSP del portero en algo que
 *  un navegador puede mostrar— escucha en su propio puerto (1984). Para que un softphone
 *  lo vea, ese puerto tiene que estar publicado y alcanzable desde donde esté el
 *  teléfono. En una instalación real eso significa abrir otro puerto en el borde, o
 *  tocar el proxy inverso del cliente, en cada central. Mientras tanto el panel guardaba
 *  una `go2rtc_url` a mano y, si estaba vacía —el caso normal—, el softphone mostraba
 *  «sin go2rtc_url · Sin señal» sin más explicación.
 *
 *  LA SOLUCIÓN: la central ya tiene una puerta abierta y con sesión, la API. Este módulo
 *  pasa por ahí lo de go2rtc: las peticiones HTTP y —lo que de verdad importa— el
 *  WebSocket por donde viaja el video. Para el cliente es la misma URL de siempre con
 *  otro prefijo, así que no hay nada nuevo que configurar: si el teléfono llega al panel,
 *  ve las cámaras.
 *
 *  QUIÉN PUEDE MIRAR: un WebSocket del navegador no puede mandar cabecera Authorization,
 *  así que el token viaja en la query. Se verifica igual que en cualquier otra ruta y,
 *  si es un token de softphone (scope 'phone'), se le deja ver las cámaras —que es lo
 *  que necesita para saber quién está en la puerta— y nada más.
 * ==========================================================================*/

const http = require('http');
const net = require('net');
const { URL } = require('url');

const RUTA = '/api/intercom/g2';

/* A dónde mandamos lo que llega. Por defecto, el contenedor go2rtc que viaja con la
 * central; se puede apuntar a otro con GO2RTC_URL sin tocar código. */
function destinoDe(url) {
  const u = String(url || '').trim() || 'http://pbxng-go2rtc:1984';
  const p = new URL(u);
  return { host: p.hostname, port: Number(p.port || (p.protocol === 'https:' ? 443 : 80)), tls: p.protocol === 'https:' };
}

/* La URL pública de ESTE proxy, vista desde el cliente que preguntó. Se arma con lo que
 * dice el proxy inverso (x-forwarded-proto / host), porque la central no sabe con qué
 * nombre la llaman desde afuera. */
function basePublica(req, prefijoPanel) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  /* El panel publica la API bajo /backend; si algún día cambia, se cambia acá y en un
   * solo lugar. */
  return proto + '://' + host + (prefijoPanel || '/backend') + RUTA;
}

/* Lo que un token de softphone puede pedir por acá: mirar, nada más. */
function permitidoParaTelefono(metodo, camino) {
  if (metodo !== 'GET') return false;
  return /^\/api\/(ws|streams|frame\.jpeg|stream\.m3u8|stream\.mp4)/.test(camino) || camino === '' || camino === '/';
}

/**
 * Monta el proxy.
 * @param {object} o { app, server, auth, verificar, destino, log }
 *   verificar(token) -> payload | null   (jwt.verify envuelto por quien llama)
 */
function montar(o) {
  const { app, server, auth, verificar } = o;
  const consumirTicket = o.consumirTicket || (() => false);
  const log = o.log || (() => {});
  const dst = () => destinoDe(o.destino && o.destino());

  /* ---- HTTP: lista de streams, capturas, HLS. Con la sesión del panel. ---- */
  app.use(RUTA, auth, (req, res) => {
    const d = dst();
    if (req.user && req.user.scope === 'phone' && !permitidoParaTelefono(req.method, req.url.split('?')[0])) {
      return res.status(403).json({ error: 'este token sólo sirve para mirar las cámaras' });
    }
    /* Las cabeceras que se reenvían: las del cliente menos la sesión (go2rtc no tiene
     * nada que hacer con ella) y con el Host del destino. Ojo: poner una cabecera en
     * `undefined` no la borra, hace que Node tire «Invalid value» y el pedido muera con
     * un 500 sin explicación —así se rompió la primera vez—. */
    const cabeceras = Object.assign({}, req.headers, { host: d.host + ':' + d.port });
    delete cabeceras.authorization;
    delete cabeceras.cookie;
    const arriba = http.request({
      host: d.host, port: d.port, method: req.method, path: req.url, headers: cabeceras, timeout: 15000,
    }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    arriba.on('timeout', () => { arriba.destroy(); if (!res.headersSent) res.status(504).json({ error: 'go2rtc no contestó' }); });
    arriba.on('error', (e) => { if (!res.headersSent) res.status(502).json({ error: 'no se llegó a go2rtc: ' + e.message }); });
    req.pipe(arriba);
  });

  /* ---- WebSocket: por acá viaja el video. ----
   * Se reenvía el handshake tal cual y después los dos sockets se pegan uno al otro: no
   * hay que entender una sola trama del protocolo, y eso es bueno —cada trama que uno
   * interpreta es una que puede romper cuando go2rtc cambie—. */
  server.on('upgrade', (req, socket, head) => {
    let camino = '';
    try { camino = new URL(req.url, 'http://x').pathname; } catch (_) { return; }
    if (!camino.startsWith(RUTA)) return;   // no es nuestro: lo atiende socket.io u otro

    const cortar = (codigo, por) => {
      try { socket.write('HTTP/1.1 ' + codigo + ' ' + por + '\r\nConnection: close\r\n\r\n'); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
    };

    /* El token viaja en la query porque el navegador no deja poner cabeceras en un
     * WebSocket. Se acepta también la cabecera, que es lo que manda el softphone de
     * escritorio (ahí sí se puede). */
    let usuario = null;
    try {
      const u = new URL(req.url, 'http://x');
      /* Primero la entrada de un solo uso (?t=), que es lo que debería usar todo el
       * mundo. Si no hay, se acepta una sesión normal —la manda el softphone de
       * escritorio por cabecera, donde sí puede—. */
      const entrada = u.searchParams.get('t');
      if (entrada && consumirTicket(entrada, u.searchParams.get('src') || '')) usuario = { scope: 'phone', via: 'ticket' };
      if (!usuario) {
        const h = String(req.headers.authorization || '');
        const t = u.searchParams.get('token') || (h.startsWith('Bearer ') ? h.slice(7) : '');
        usuario = t ? verificar(t) : null;
      }
    } catch (_) { usuario = null; }
    if (!usuario) return cortar(401, 'Unauthorized');

    const restoCamino = camino.slice(RUTA.length) || '/';
    if (usuario.scope === 'phone' && !permitidoParaTelefono('GET', restoCamino)) return cortar(403, 'Forbidden');

    const d = dst();
    const arriba = net.connect(d.port, d.host, () => {
      /* El handshake, con el camino de go2rtc y sin nuestro token: go2rtc no tiene nada
       * que hacer con él, y un token que no hace falta no se reenvía. */
      let q = '';
      try { const u = new URL(req.url, 'http://x'); u.searchParams.delete('token'); q = u.search; } catch (_) {}
      const cabeceras = Object.entries(req.headers)
        .filter(([k]) => k.toLowerCase() !== 'authorization' && k.toLowerCase() !== 'host')
        .map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : v));
      arriba.write('GET ' + restoCamino + q + ' HTTP/1.1\r\nHost: ' + d.host + ':' + d.port + '\r\n' + cabeceras.join('\r\n') + '\r\n\r\n');
      if (head && head.length) arriba.write(head);
      arriba.pipe(socket);
      socket.pipe(arriba);
    });
    arriba.on('error', (e) => { log('intercom: no se llegó a go2rtc', e.message); cortar(502, 'Bad Gateway'); });
    socket.on('error', () => { try { arriba.destroy(); } catch (_) {} });
  });

  return { RUTA };
}

module.exports = { montar, destinoDe, basePublica, permitidoParaTelefono, RUTA };
