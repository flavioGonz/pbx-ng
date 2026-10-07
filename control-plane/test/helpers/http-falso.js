/* ============================================================================
 *  PBX-NG · Un servidor HTTP de mentira para los servicios a los que la API reenvía.
 *
 *  El agente del contenedor de Asterisk, el de coturn, el servicio de voz, el proxy
 *  inverso, un webhook de Telegram: la API les habla por HTTP. En las pruebas apuntan
 *  todos acá, y cada prueba define qué contesta cada ruta y mira qué le pidieron.
 *
 *    const f = await httpFalso();
 *    f.ruta('GET', '/net', { ifaces: [...] });              // JSON 200
 *    f.ruta('POST', '/netmode', (req) => ({ ok: true }));    // función del pedido
 *    f.ruta('POST', '/tts', { status: 500, cuerpo: 'x' });   // status y cuerpo crudo
 *    f.pedidos('/netmode')                                    // [{ method, url, headers, body }]
 * ==========================================================================*/
'use strict';
const http = require('http');

async function httpFalso() {
  const rutas = new Map();
  const recibidos = [];
  const server = http.createServer((req, res) => {
    let datos = [];
    req.on('data', (c) => datos.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(datos);
      let body = raw.toString('utf8');
      try { body = body ? JSON.parse(body) : null; } catch (_) {}
      const url = req.url.split('?')[0];
      const pedido = { method: req.method, url, query: req.url.split('?')[1] || '', headers: req.headers, body, raw };
      recibidos.push(pedido);
      let r = rutas.get(req.method + ' ' + url) || rutas.get('* ' + url);
      if (typeof r === 'function') r = r(pedido);
      if (r === undefined) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"sin ruta en el falso"}'); }
      if (r && r.__crudo) {
        res.writeHead(r.status || 200, r.headers || {});
        return res.end(r.cuerpo);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  return {
    port,
    url: 'http://127.0.0.1:' + port,
    /* respuesta: objeto (JSON 200), función(pedido) → objeto, o crudo(status, cuerpo, headers). */
    ruta(method, url, respuesta) { rutas.set(method + ' ' + url, respuesta); },
    quitar(method, url) { rutas.delete(method + ' ' + url); },
    pedidos(url) { return url ? recibidos.filter((p) => p.url === url) : recibidos.slice(); },
    olvidar() { recibidos.length = 0; },
    cerrar() { return new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }); },
  };
}
/* Respuesta con status y cuerpo a elección (texto o Buffer). */
const crudo = (status, cuerpo, headers) => ({ __crudo: true, status, cuerpo: cuerpo == null ? '' : cuerpo, headers: headers || {} });

module.exports = { httpFalso, crudo };
