/* ============================================================================
 *  Integración · el video de las cámaras pasa por la API (intercom-proxy.js) hacia un
 *  go2rtc de mentira.
 *
 *  Lo que se mira: que a go2rtc no le llegue nuestra sesión ni el Origin del navegador
 *  (con él, go2rtc corta con 403 y las cámaras quedan «Sin señal» sin pista), que un
 *  token de softphone sólo pueda mirar, que el WebSocket del video entre con la entrada
 *  de un solo uso o con una sesión, y que go2rtc caído se diga.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { entorno } = require('./helpers/db');

async function go2rtcFalso() {
  const g = { pedidos: [] };
  const srv = http.createServer((req, res) => {
    g.pedidos.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"camara1":{}}');
  });
  const wss = new WebSocketServer({ server: srv, path: '/api/ws' });
  wss.on('connection', (ws, req) => { g.wsHeaders = req.headers; g.wsUrl = req.url; ws.on('message', (d) => ws.send('eco:' + d)); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  g.url = 'http://127.0.0.1:' + srv.address().port;
  g.cerrar = () => new Promise((ok) => { for (const c of wss.clients) c.terminate(); srv.closeAllConnections?.(); srv.close(ok); });
  return g;
}
function abrirWs(url, headers) {
  return new Promise((ok) => {
    const ws = new WebSocket(url, { headers: headers || {} });
    ws.on('open', () => ok({ ws, abierto: true }));
    ws.on('unexpected-response', (_q, r) => ok({ status: r.statusCode }));
    ws.on('error', (e) => ok({ error: e.message }));
  });
}

test('video del Intercom por la API: HTTP, WebSocket, permisos y go2rtc caído', async (t) => {
  const g2 = await go2rtcFalso();
  t.after(() => g2.cerrar());
  const ctx = await entorno(t, { GO2RTC_URL: g2.url });
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login, base } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await api('POST', '/api/endpoints', { token: admin, body: { id: '2001', password: 'Clave-2001-xx' } });
  const tel = (await api('POST', '/api/phone/token', { body: { ext: '2001', password: 'Clave-2001-xx' } })).json.token;
  const wsBase = base.replace(/^http/, 'ws') + '/api/intercom/g2';

  await t.test('HTTP: se reenvía sin la sesión, sin cookie y sin Origin', async () => {
    const r = await fetch(base + '/api/intercom/g2/api/streams', { headers: { Authorization: 'Bearer ' + admin, Origin: 'https://panel.x', Cookie: 'a=b', Referer: 'https://panel.x/intercom' } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { camara1: {} });
    const h = g2.pedidos.at(-1).headers;
    assert.equal(h.authorization, undefined);
    assert.equal(h.cookie, undefined);
    assert.equal(h.origin, undefined, 'con el Origin del navegador go2rtc corta con 403');
    assert.equal(h.referer, undefined);
    assert.equal((await fetch(base + '/api/intercom/g2/api/streams')).status, 401);
  });

  await t.test('un token de softphone mira, pero no toca la configuración de go2rtc', async () => {
    assert.equal((await fetch(base + '/api/intercom/g2/api/frame.jpeg?src=c', { headers: { Authorization: 'Bearer ' + tel } })).status, 200);
    assert.equal((await fetch(base + '/api/intercom/g2/api/streams?src=x', { method: 'PUT', headers: { Authorization: 'Bearer ' + tel } })).status, 403);
    assert.equal((await fetch(base + '/api/intercom/g2/api/config', { headers: { Authorization: 'Bearer ' + tel } })).status, 403);
  });

  await t.test('WebSocket: sin credencial no entra; con sesión o con entrada de un solo uso, sí', async () => {
    const sin = await abrirWs(wsBase + '/api/ws?src=c');
    assert.equal(sin.status, 401);
    const conSesion = await abrirWs(wsBase + '/api/ws?src=c&token=' + admin, { Origin: 'https://panel.x' });
    assert.equal(conSesion.abierto, true);
    const eco = await new Promise((ok) => { conSesion.ws.once('message', (d) => ok(String(d))); conSesion.ws.send('hola'); });
    assert.equal(eco, 'eco:hola');
    assert.doesNotMatch(g2.wsUrl, /token=/, 'el token no se le pasa a go2rtc');
    assert.equal(g2.wsHeaders.origin, undefined);
    conSesion.ws.close();
    const porCabecera = await abrirWs(wsBase + '/api/ws?src=c', { Authorization: 'Bearer ' + admin });
    assert.equal(porCabecera.abierto, true);
    porCabecera.ws.close();
    /* La entrada de un solo uso: la emite el panel para un canal que existe. */
    await ctx.db.query("INSERT INTO pbxng_clients (id, name) VALUES (1, 'Sol')");
    await ctx.db.query("INSERT INTO pbxng_client_devices (client_id, label, type, go2rtc_src, enabled) VALUES (1, 'Portón', 'intercom', 'cam-1', true)");
    const tk = (await api('GET', '/api/intercom/ticket?src=cam-1', { token: admin })).json.ticket;
    const conEntrada = await abrirWs(wsBase + '/api/ws?src=cam-1&t=' + tk);
    assert.equal(conEntrada.abierto, true);
    conEntrada.ws.close();
    assert.equal((await abrirWs(wsBase + '/api/ws?src=cam-1&t=' + tk)).status, 401, 'la entrada se quema al usarla');
    assert.equal((await abrirWs(wsBase + '/api/config?token=' + tel)).status, 403, 'un softphone no abre otra cosa que el video');
  });

  await t.test('go2rtc caído: 502 en HTTP y en el WebSocket', async () => {
    await g2.cerrar();
    const r = await fetch(base + '/api/intercom/g2/api/streams', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /no se llegó a go2rtc/);
    assert.equal((await abrirWs(wsBase + '/api/ws?token=' + admin)).status, 502);
  });
});
