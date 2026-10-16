/* ============================================================================
 *  Candado por cuenta: el ataque que el contador por IP no puede ver.
 *
 *  POR QUÉ ESTE ARCHIVO: los internos WebRTC entran por el proxy inverso y Asterisk
 *  reporta SIEMPRE la IP del proxy. Medido en una central real:
 *    SecurityEvent="InvalidAccountID" AccountID="999999" RemoteAddress="IPV4/WS/10.1.1.221/47920"
 *  Esa IP es privada, y guard.js exime a las privadas a propósito, así que una fuerza
 *  bruta por WebRTC no se contaba, no se avisaba y no se baneaba. Lo que se prueba acá
 *  es justamente el caso que antes se caía por el agujero: fallos desde una IP PRIVADA,
 *  que no tienen que producir ningún ban y SÍ tienen que avisar por cuenta.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const initGuard = require('../guard');

function armar(ajustes) {
  const cont = { fwBan: [], secEvents: [], raise: [], sql: [], endpointAuth: '1001', candado: null };
  const filasSettings = Object.entries(ajustes || {}).map(([k, v]) => ({ key: 'sec_' + k, value: String(v) }));
  const responder = (s, params) => {
    cont.sql.push(s.replace(/\s+/g, ' ').trim().slice(0, 80));
    if (s.includes("key LIKE 'sec")) return { rows: filasSettings };
    if (s.includes('INSERT INTO pbxng_sec_events')) { cont.secEvents.push({ kind: params[0], sev: params[1], detail: JSON.parse(params[2]) }); return { rows: [], rowCount: 1 }; }
    if (s.includes('INSERT INTO pbxng_blocked')) { return { rows: [{ ip: params[0], reason: params[1], hits: 1, permanent: false, exp: null }] }; }
    if (s.includes('FROM ps_endpoints WHERE id=')) return { rows: [{ auth: cont.endpointAuth }] };
    if (s.includes('UPDATE ps_endpoints SET auth=')) { cont.endpointAuth = params[1]; return { rows: [], rowCount: 1 }; }
    if (s.includes('SELECT auth_previo FROM pbxng_cuenta_candado')) return { rows: cont.candado ? [{ auth_previo: cont.candado.auth_previo }] : [] };
    if (s.includes('INSERT INTO pbxng_cuenta_candado')) { cont.candado = { ext: params[0], hasta: params[1], motivo: params[2], auth_previo: params[5], manual: params[6] }; return { rows: [], rowCount: 1 }; }
    if (s.includes('DELETE FROM pbxng_cuenta_candado')) { cont.candado = null; return { rows: [], rowCount: 1 }; }
    if (s.includes('FROM pbxng_cuenta_candado')) return { rows: cont.candado ? [cont.candado] : [] };
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    async query(sql, params) { return responder(String(sql), params || []); },
    async connect() { return { async query(sql, params) { return responder(String(sql), params || []); }, release() {} }; },
  };
  const ami = new EventEmitter();
  const astFwd = async (method, path, body) => {
    if (path === '/fw/ban') cont.fwBan.push(body);
    return { ok: true, status: 200, json: async () => ({ ok: true, enabled: true, bans: [] }) };
  };
  const geoLookup = async (ips) => { const o = {}; for (const ip of ips) o[ip] = { country: 'Testland', cc: 'TL', isp: 'ISP' }; return o; };
  const alerts = { raise: async (k, d) => { cont.raise.push({ k, d }); } };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const guard = initGuard({ app: null, pool, ami, io: null, astFwd, escribir() {}, alerts, geoLookup, amiCommand: async () => '', log });
  return { guard, cont };
}

/* El sobre tal cual lo manda Asterisk para un WebSocket: `WS` como transporte y la IP
 * del proxy, que es privada. Es el caso real, no uno inventado para el test. */
const evWs = (cuenta, ip) => ({
  securityevent: 'InvalidPassword', accountid: cuenta,
  remoteaddress: 'IPV4/WS/' + (ip || '10.1.1.221') + '/47920',
});

test('WebRTC detrás del proxy: 20 fallos contra un interno avisan, y NO banean al proxy', async () => {
  const { guard, cont } = armar({ cuenta_max_fallos: 20, cuenta_ventana_s: 300, cuenta_candado_s: 0 });
  await guard._cargar.settings();
  for (let i = 0; i < 20; i++) await guard.procesar(evWs('1001'));

  assert.equal(cont.fwBan.length, 0, 'la IP del proxy es privada: banearla dejaría sin WebRTC a todos');
  const aviso = cont.secEvents.find((e) => e.kind === 'cuenta');
  assert.ok(aviso, 'tiene que quedar un evento `cuenta` en la bitácora');
  assert.equal(aviso.detail.ext, '1001');
  assert.equal(aviso.detail.fallos, 20);
  assert.equal(cont.raise.filter((r) => r.k === 'security.cuenta').length, 1, 'un correo, no veinte');
  assert.ok(guard.recientes().some((e) => e.tipo === 'cuenta' && /bajo ataque/.test(e.texto)),
    'el registro en vivo tiene que mostrarlo: ' + JSON.stringify(guard.recientes().slice(-2)));
  assert.equal(cont.candado, null, 'con cuenta_candado_s en 0 no se canda nada');
});

test('un aviso por ventana: el ataque sigue y el correo no se repite', async () => {
  const { guard, cont } = armar({ cuenta_max_fallos: 5, cuenta_ventana_s: 300, cuenta_candado_s: 0 });
  await guard._cargar.settings();
  for (let i = 0; i < 60; i++) await guard.procesar(evWs('1002'));
  assert.equal(cont.raise.filter((r) => r.k === 'security.cuenta').length, 1);
});

test('ataque distribuido: muchas IPs públicas contra una cuenta, ninguna llega al umbral por IP', async () => {
  const { guard, cont } = armar({ max_fallos: 5, cuenta_max_fallos: 10, cuenta_ventana_s: 300, cuenta_candado_s: 0 });
  await guard._cargar.settings();
  // 10 IPs distintas, 1 fallo cada una: el contador por IP (5) no se entera.
  for (let i = 1; i <= 10; i++) await guard.procesar(evWs('1003', '203.0.113.' + i));
  assert.equal(cont.fwBan.length, 0, 'ninguna IP llegó a su umbral');
  const aviso = cont.secEvents.find((e) => e.kind === 'cuenta');
  assert.ok(aviso, 'el contador por cuenta sí tiene que verlo');
  assert.equal(aviso.detail.n_ips, 10, 'y tiene que decir desde cuántas IPs vino');
});

test('candar y abrir: el endpoint cambia de auth y vuelve al de antes', async () => {
  const { guard, cont } = armar({ cuenta_candado_s: 0 });
  await guard._cargar.settings();
  const r = await guard.candar('1001', { segundos: 900, motivo: 'prueba', manual: true });
  assert.equal(r.ext, '1001');
  assert.ok(r.hasta, 'con segundos > 0 el candado vence solo');
  assert.equal(cont.endpointAuth, 'candado-1001', 'ninguna clave entra mientras apunte al auth descartable');
  assert.equal(cont.candado.auth_previo, '1001', 'hay que saber a qué volver');
  assert.ok(cont.sql.some((s) => /DELETE FROM ps_contacts/.test(s)), 'candar también echa al que ya estaba registrado');

  const a = await guard.abrir('1001', 'prueba');
  assert.equal(a.abierto, true);
  assert.equal(cont.endpointAuth, '1001', 'el endpoint vuelve a su auth de siempre');
  assert.equal(cont.candado, null);
});

test('candar dos veces no pierde el auth original', async () => {
  const { guard, cont } = armar({});
  await guard._cargar.settings();
  await guard.candar('1001', { segundos: 60 });
  await guard.candar('1001', { segundos: 60 });
  assert.equal(cont.candado.auth_previo, '1001', 'el segundo candado no puede guardar `candado-1001` como el auth de antes');
  await guard.abrir('1001');
  assert.equal(cont.endpointAuth, '1001');
});

test('candar sin interno se rechaza antes de tocar la base', async () => {
  const { guard, cont } = armar({});
  await guard._cargar.settings();
  await assert.rejects(() => guard.candar('', {}), /falta el interno/);
  await assert.rejects(() => guard.candar(null, {}), /falta el interno/);
  await assert.rejects(() => guard.abrir(''), /falta el interno/);
  assert.equal(cont.candado, null);
  assert.equal(cont.endpointAuth, '1001', 'el endpoint no se tocó');
});

test('el umbral en 0 apaga el contador por cuenta', async () => {
  const { guard, cont } = armar({ cuenta_max_fallos: 0 });
  await guard._cargar.settings();
  for (let i = 0; i < 50; i++) await guard.procesar(evWs('1004'));
  assert.equal(cont.secEvents.filter((e) => e.kind === 'cuenta').length, 0);
  assert.equal(cont.raise.length, 0);
});
