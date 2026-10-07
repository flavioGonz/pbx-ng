/* ============================================================================
 *  Integración · troncales (trunks.js) con Asterisk de mentira: el estado que se lee del
 *  AMI y del ARI, el enlace al SBC-NG, editar una troncal en sus tres tipos, y editar y
 *  borrar rutas entrantes y salientes.
 *
 *  El estado de una troncal no es decorativo: el failover decide con él. Por eso se mira
 *  que «Autenticando…» NO cuente como caída (es un REGISTER en vuelo) y que «Rechazada»
 *  y «Sin registrar» sí.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { ariFalso } = require('./helpers/ari-falso');
const { httpFalso } = require('./helpers/http-falso');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 6000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(80); } return fn(); }

test('troncales: estado real, enlace SBC, edición y rutas', async (t) => {
  const ami = await amiFalso();
  const ari = await ariFalso();
  const agente = await httpFalso();
  const sbc = await new Promise((ok) => { const s = net.createServer((c) => c.end()); s.listen(0, '127.0.0.1', () => ok(s)); });
  t.after(async () => { await ami.cerrar(); await ari.cerrar(); await agente.cerrar(); sbc.close(); });
  const ctx = await entorno(t, Object.assign({}, ami.env, ari.env, { AST_AGENT: agente.url }));
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  await ari.conectado();
  agente.ruta('POST', '/reload', { ok: true });

  const crear = (b) => api('POST', '/api/trunks', { token: admin, body: b });
  assert.equal((await crear({ name: 'antel', provider_host: 'sip.antel.test', mode: 'register', username: 'u1', password: 'p1', transport: 'tls', codecs: ['alaw'], dids: '29001234, 29001235', channels: 10, outbound_prefix: '9', outbound_strip: 1 })).status, 201);
  assert.equal((await crear({ name: 'movi', provider_host: 'sip.movi.test', mode: 'register', username: 'u2', password: 'p2', outbound_enabled: false })).status, 201);
  assert.equal((await crear({ name: 'claro', provider_host: 'sip.claro.test', mode: 'register', username: 'u3', password: 'p3', outbound_prefix: '8' })).status, 201);
  assert.equal((await crear({ name: 'ipauth', provider_host: '10.9.9.9', mode: 'ip', transport: 'tcp', outbound_prefix: '7' })).status, 201);
  assert.equal((await crear({ name: 'ipcaida', provider_host: '10.9.9.8', mode: 'ip', outbound_enabled: false })).status, 201);
  assert.equal((await crear({ name: 'wrtc', kind: 'webrtc', password: 'Clave-wrtc-1' })).status, 201);

  await t.test('estado: registrada, rechazada, autenticando, sin registrar, alcanzable, WebRTC y RTT', async () => {
    ami.comando(/^pjsip show registrations/, [
      ' antel/sip:sip.antel.test:5061   antel   Registered   (exp. 3540s)',
      ' movi/sip:sip.movi.test:5060     movi    Rejected',
      ' claro/sip:sip.claro.test:5060   claro   Unregistered',
    ].join('\n'));
    ami.comando(/^pjsip show contacts/, [
      '  Contact:  ipauth/sip:10.9.9.9:5060                  abc Avail    12.345',
      '  Contact:  antel/sip:sip.antel.test:5061              def Avail    48.1',
      'otra línea cualquiera',
    ].join('\n'));
    /* El motor de llamadas lleva el estado de los endpoints por eventos de ARI. */
    for (const r of ['ipauth', 'wrtc']) ari.emitir({ type: 'EndpointStateChange', endpoint: { technology: 'PJSIP', resource: r, state: 'online', channel_ids: [] } });
    const l = await hasta(async () => { const r = (await api('GET', '/api/trunks', { token: admin })).json; return r.find((x) => x.name === 'wrtc').status === 'online' ? r : null; });
    assert.ok(l, 'el estado de WebRTC no se leyó del ARI');
    const por = Object.fromEntries(l.map((x) => [x.name, x]));
    assert.equal(por.antel.status, 'online');
    assert.match(por.antel.detail, /Registrada \(exp 3540s\)/);
    assert.equal(por.antel.rtt, 48.1);
    assert.equal(por.antel.transport, 'tls');
    assert.deepEqual(por.antel.dids, ['29001234', '29001235']);
    assert.equal(por.antel.channels, 10);
    assert.equal(por.movi.detail, 'Rechazada por el proveedor');
    assert.equal(por.claro.detail, 'Sin registrar', '«Unregistered» contiene «Registered»: no puede salir en verde');
    assert.equal(por.claro.status, 'offline');
    assert.equal(por.ipauth.status, 'online');
    assert.equal(por.ipauth.rtt, 12.345);
    assert.equal(por.ipcaida.detail, 'No responde');
    assert.equal(por.wrtc.mode, 'webrtc');
    ami.comando(/^pjsip show registrations/, ' antel/sip:x   antel   Auth Sent');
    const auth = (await api('GET', '/api/trunks', { token: admin })).json.find((x) => x.name === 'antel');
    assert.equal(auth.detail, 'Autenticando…', 'un REGISTER en vuelo no es una caída');
    assert.match((await api('GET', '/api/registrations', { token: admin })).json.output, /antel/);
  });

  await t.test('detalle y edición: SIP, WebRTC (con y sin clave) y la salida directa que se mueve', async () => {
    const d = (await api('GET', '/api/trunks/antel/detail', { token: admin })).json;
    assert.equal(d.has_password, true);
    assert.equal(d.adv.outbound_prefix, '9');
    assert.equal((await api('GET', '/api/trunks/no-existe/detail', { token: admin })).status, 404);
    assert.equal((await api('PUT', '/api/trunks/antel', { token: admin, body: {} })).status, 400);
    assert.equal((await api('PUT', '/api/trunks/no-existe', { token: admin, body: { provider_host: 'x' } })).status, 404);
    assert.equal((await api('PUT', '/api/trunks/antel', { token: admin, body: { provider_host: 'x', mode: 'register' } })).status, 400, 'en registro hace falta usuario');
    /* Cambiar el prefijo borra la salida vieja (_9.) y publica la nueva (_6.), sin pedir la clave otra vez. */
    const u = await api('PUT', '/api/trunks/antel', { token: admin, body: { provider_host: 'sip.antel.test', mode: 'register', username: 'u1', outbound_prefix: '6' } });
    assert.equal(u.status, 200, JSON.stringify(u.json));
    const ext = async (x) => (await ctx.db.query("SELECT count(*)::int n FROM extensions WHERE context='internal' AND exten=$1", [x])).rows[0].n;
    assert.equal(await ext('_9.'), 0);
    assert.ok(await ext('_6.') > 0);
    await api('PUT', '/api/trunks/antel', { token: admin, body: { provider_host: 'sip.antel.test', mode: 'ip', outbound_enabled: false } });
    assert.equal(await ext('_6.'), 0, 'apagar la salida automática la saca del dialplan');
    await api('PUT', '/api/trunks/ipcaida', { token: admin, body: { provider_host: '10.9.9.8', kind: 'kamailio', mode: 'register', password: 'x' } });
    assert.equal((await api('PUT', '/api/trunks/wrtc', { token: admin, body: { kind: 'webrtc', note: 'nueva' } })).json.kind, 'webrtc', 'sin clave nueva se conserva la vieja');
    assert.equal((await api('PUT', '/api/trunks/no-existe', { token: admin, body: { kind: 'webrtc' } })).status, 404);
    assert.equal((await api('PUT', '/api/trunks/wrtc', { token: admin, body: { kind: 'webrtc-client' } })).status, 400);
    assert.equal((await api('PUT', '/api/trunks/no-existe', { token: admin, body: { kind: 'webrtc-client', remote_url: 'wss://x/ws', username: 'a' } })).status, 404);
    assert.equal((await api('PUT', '/api/trunks/movi', { token: admin, body: { kind: 'webrtc-client', remote_url: 'wss://sbc.test/ws', username: 'a' } })).status, 400, 'sin clave no se puede');
    assert.equal((await api('PUT', '/api/trunks/movi', { token: admin, body: { kind: 'webrtc-client', remote_url: 'wss://sbc.test/ws', username: 'a', password: 'b' } })).json.kind, 'webrtc-client');
    const l = (await api('GET', '/api/trunks', { token: admin })).json;
    assert.match(l.find((x) => x.name === 'movi').detail, /Requiere SBC-NG/);
    assert.equal(l.find((x) => x.name === 'movi').target, 'sbc.test');
    assert.equal((await crear({ name: 'k', kind: 'kamailio' })).status, 400);
    assert.equal((await crear({ name: 'w', kind: 'webrtc' })).status, 400);
    assert.equal((await crear({ name: 'x' })).status, 400);
  });

  await t.test('enlace al SBC-NG: alta con la ruta semilla, estado medido y baja', async () => {
    assert.equal((await api('GET', '/api/sbc-link', { token: admin })).json.configured, false);
    assert.equal((await api('POST', '/api/sbc-link', { token: admin, body: {} })).status, 400);
    await ctx.db.query('DELETE FROM pbxng_outbound_routes');
    const r = await api('POST', '/api/sbc-link', { token: admin, body: { host: '127.0.0.1', port: sbc.address().port, transport: 'tcp', panel_url: 'https://sbc.test', codecs: ['alaw'] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ruta_creada, '0X.', 'sin rutas salientes, se siembra «marca 0» por el SBC');
    assert.ok(agente.pedidos('/reload').length >= 1);
    const g = (await api('GET', '/api/sbc-link', { token: admin })).json;
    assert.equal(g.configured, true);
    assert.equal(g.estado.vivo, true);
    assert.equal(g.rutas_salientes, 1);
    const k = await api('POST', '/api/trunks', { token: admin, body: { kind: 'sbc', provider_host: '127.0.0.1', provider_port: sbc.address().port } });
    assert.equal(k.status, 201);
    assert.equal(k.json.ruta_creada, null, 'con rutas, no se siembra otra');
    const b = await api('DELETE', '/api/sbc-link', { token: admin });
    assert.equal(b.json.rutas_borradas, 1);
    assert.equal((await api('GET', '/api/sbc-link', { token: admin })).json.configured, false);
  });

  await t.test('rutas: editar la saliente (patrón, respaldos, CallerID) y la entrante; borrar', async () => {
    const o = await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'Cel', pattern: '_09XXXXXXX', trunk: 'claro', strip: 0, callerid: '29001234', backups: ['ipauth'], intento_seg: 1, total_seg: 9999 } });
    assert.equal(o.status, 201, JSON.stringify(o.json));
    for (const malo of [{ pattern: '' }, { pattern: 'a;b' }, { callerid: 'abc' }, { trunk: 'no existe' }, { trunk: 'wrtc' }, { backups: ['a', 'b', 'c', 'd', 'e', 'f'] }]) {
      assert.equal((await api('PUT', '/api/routes/outbound/' + o.json.id, { token: admin, body: malo })).status, 400, JSON.stringify(malo));
    }
    assert.equal((await api('PUT', '/api/routes/outbound/999999', { token: admin, body: { pattern: '1X' } })).status, 404);
    const u = await api('PUT', '/api/routes/outbound/' + o.json.id, { token: admin, body: { pattern: '099XXXXXX', backups: [] } });
    assert.equal(u.status, 200, JSON.stringify(u.json));
    const f = (await api('GET', '/api/routes/outbound/failover', { token: admin })).json;
    assert.ok(Array.isArray(f));
    assert.equal((await api('DELETE', '/api/routes/outbound/' + o.json.id, { token: admin })).status, 200);
    assert.equal((await api('DELETE', '/api/routes/outbound/999999', { token: admin })).status, 200, 'borrar lo que no está es idempotente');

    const i = await api('POST', '/api/routes/inbound', { token: admin, body: { name: 'Principal', did: '29001234', dest_type: 'interno', dest_value: '2001' } });
    assert.equal(i.status, 201, JSON.stringify(i.json));
    for (const malo of [{ dest_type: 'raro' }, { dest_cerrado_type: 'raro' }, { dest_cerrado_type: 'interno', dest_cerrado_value: 'a;b' }]) {
      assert.equal((await api('PUT', '/api/routes/inbound/' + i.json.id, { token: admin, body: malo })).status, 400, JSON.stringify(malo));
    }
    assert.equal((await api('PUT', '/api/routes/inbound/999999', { token: admin, body: { name: 'x' } })).status, 404);
    for (const [tipo, valor] of [['app', '*31'], ['interno', '2002']]) {
      const r = await api('PUT', '/api/routes/inbound/' + i.json.id, { token: admin, body: { dest_type: tipo, dest_value: valor, dest_cerrado_type: 'interno', dest_cerrado_value: '2003' } });
      assert.equal(r.status, 200, tipo + ' ' + JSON.stringify(r.json));
    }
    assert.equal((await api('DELETE', '/api/routes/inbound/' + i.json.id, { token: admin })).status, 200);
    assert.equal((await api('DELETE', '/api/routes/inbound/999999', { token: admin })).status, 200, 'idempotente, como la saliente');
  });
});
