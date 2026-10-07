/* ============================================================================
 *  Origen del TURN y /api/ice (turn.js · init) en unidad: base, enlace al SBC,
 *  módulos y agente del coturn de mentira; el relay, un TURN de mentira en loopback.
 *
 *  test/turn.test.js recorre esto contra la API real. Acá se fijan las combinaciones
 *  que allá costaría armar y que deciden QUÉ se le reparte a un softphone:
 *   - con cada origen (propio / sbc / externo) y cada dato faltante, el origen sale
 *     NO utilizable diciendo por qué, y /api/ice no publica una entrada `turn:`;
 *   - el STUN cargado a mano se normaliza y se filtra; si no queda ninguno sano se cae
 *     al propio appliance, y la lista nunca queda vacía si hay con qué llenarla;
 *   - el PUT del origen valida antes de tocar nada, sondea lo nuevo antes de apagar lo
 *     que anda (409 si no contesta) y, una vez guardado, sobrevive a que fallen el
 *     interruptor del módulo o el agente del coturn;
 *   - el estado se cachea 20 s y no se sondea un coturn apagado a propósito;
 *   - la consola del coturn y «Probar TURN» dicen el error en vez de colgarse.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const initTurn = require('../turn');
const { turnFalso } = require('./helpers/turn-falso');

const VARS = ['PUBLIC_IP', 'DOMAIN', 'TURN_PASS', 'TURN_USER', 'STUN_URL'];

function armar(t, { ajustes = {}, env = {}, modulo = true, lk = null, nodes = {} } = {}) {
  const antes = {};
  for (const k of VARS) { antes[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => { for (const k of VARS) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; } });

  const st = { ajustes: { ...ajustes }, modulo, lk, romperLectura: false, romperEscritura: false, romperModulo: false, romperSetModule: false, romperLink: false, fwd: [], fwdFalla: null, setModule: [] };
  const pool = {
    async query(sql, args) {
      if (/^SELECT key, value/.test(sql)) {
        if (st.romperLectura) throw new Error('base caída');
        return { rows: Object.entries(st.ajustes).map(([key, value]) => ({ key, value })) };
      }
      if (/^INSERT INTO pbxng_settings/.test(sql)) {
        if (st.romperEscritura) throw new Error('disco lleno');
        st.ajustes[args[0]] = args[1];
        return { rowCount: 1 };
      }
      throw new Error('consulta inesperada: ' + sql);
    },
  };
  const rutas = {};
  const reg = (m) => (ruta, ...h) => { rutas[m + ' ' + ruta] = h[h.length - 1]; };
  const m = initTurn({
    app: { get: reg('GET'), post: reg('POST'), put: reg('PUT') },
    pool, NODES: nodes,
    moduleEnabled: async () => { if (st.romperModulo) throw new Error('settings ilegibles'); return st.modulo; },
    setModule: async (id, on) => { if (st.romperSetModule) throw new Error('no se pudo'); st.setModule.push([id, on]); },
    sbcLink: async () => { if (st.romperLink) throw new Error('trunks caído'); return st.lk; },
    turnFwd: async (metodo, ruta, cuerpo) => {
      st.fwd.push([metodo, ruta, cuerpo]);
      if (st.fwdFalla) throw new Error(st.fwdFalla);
      return { json: async () => ({ ok: true, ruta, cuerpo }) };
    },
  });
  return { m, st, rutas };
}

async function http(handler, req = {}) {
  const res = { statusCode: 200, cuerpo: undefined, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.cuerpo = b; return this; } };
  await handler({ params: {}, query: {}, ...req }, res);
  return res;
}

/* Un servidor que contesta STUN a todo: el Binding pasa, el Allocate no es un 401 y la
 * sonda da FALLA enseguida (sin esperar timeouts). TCP en ese puerto: rechazado. */
async function stunPelado(t) {
  const s = dgram.createSocket('udp4');
  s.on('message', (d, r) => { const h = Buffer.alloc(20); h.writeUInt16BE(0x0101, 0); h.writeUInt32BE(0x2112a442, 4); d.copy(h, 8, 8, 20); s.send(h, r.port, r.address); });
  const puerto = await new Promise((ok) => s.bind(0, '127.0.0.1', () => ok(s.address().port)));
  t.after(() => new Promise((ok) => s.close(ok)));
  return puerto;
}

test('origen propio: host manual, del .env, módulo apagado y sin clave', async (t) => {
  const { m, st, rutas } = armar(t, { env: { DOMAIN: 'central.ejemplo', TURN_PASS: 'clave' } });
  let ice = (await http(rutas['GET /api/ice'])).cuerpo;
  assert.deepEqual(ice.iceServers.map((s) => s.urls), ['stun:central.ejemplo:3478', 'turn:central.ejemplo:3478?transport=udp', 'turn:central.ejemplo:3478?transport=tcp']);
  assert.equal(ice.iceServers[1].username, 'pbxng');
  assert.equal(ice.motivo, undefined);

  st.ajustes.turn_host = 'no es un host';
  st.ajustes.turn_puerto = '3479';
  let e = await m.origenEfectivo();
  assert.equal(e.host, 'central.ejemplo', 'un host manual inválido no se usa: se cae al del .env');
  assert.match(e.motivo, /no es un nombre ni una dirección válida/);
  assert.equal(e.puerto, 3479);

  st.modulo = false;
  delete st.ajustes.turn_host;
  e = await m.origenEfectivo();
  assert.match(e.motivo, /apagado desde Configuración/);
  ice = (await http(rutas['GET /api/ice'])).cuerpo;
  assert.deepEqual(ice.iceServers, [{ urls: 'stun:central.ejemplo:3479' }], 'apagado: sólo el STUN, sin turn: ni clave');

  st.modulo = true;
  delete process.env.TURN_PASS;
  e = await m.origenEfectivo();
  assert.match(e.motivo, /falta TURN_PASS/);

  delete process.env.DOMAIN;
  e = await m.origenEfectivo();
  assert.match(e.motivo, /no tiene dirección pública/);
  assert.deepEqual(e.stun, [], 'sin ningún host no hay STUN que inventar');

  // Si la base no se puede leer, se toman los valores por defecto (y no revienta).
  st.romperLectura = true;
  e = await m.origenEfectivo();
  assert.equal(e.origen, 'propio');
});

test('el host del .env sale de NODES cuando no hay PUBLIC_IP ni DOMAIN', async (t) => {
  const { m } = armar(t, { nodes: { domain: 'nodo.ejemplo' }, env: { TURN_PASS: 'x', TURN_USER: 'otro' } });
  const e = await m.origenEfectivo();
  assert.equal(e.host, 'nodo.ejemplo');
  assert.equal(e.usuario, 'otro');
  const { m: m2 } = armar(t, { nodes: { public_ip: '203.0.113.5' } });
  assert.equal((await m2.origenEfectivo()).host, '203.0.113.5');
});

test('origen sbc: sin enlace, enlace caído, sin credenciales y utilizable', async (t) => {
  const { m, st, rutas } = armar(t, { ajustes: { turn_origen: 'sbc' }, env: { PUBLIC_IP: '203.0.113.9' } });
  st.romperLink = true;
  let e = await m.origenEfectivo();
  assert.match(e.motivo, /Conexión a SBC-NG/);
  assert.deepEqual(e.stun, ['stun:203.0.113.9:3478'], 'sin host del SBC el STUN cae al appliance');
  st.romperLink = false;
  st.lk = { active: true, host: 'sbc.ejemplo' };
  e = await m.origenEfectivo();
  assert.equal(e.motivo, 'faltan las credenciales TURN del SBC-NG');
  Object.assign(st.ajustes, { turn_sbc_user: 'u', turn_sbc_pass: 'p', turn_sbc_puerto: '3490' });
  const ice = (await http(rutas['GET /api/ice'])).cuerpo;
  assert.deepEqual(ice.iceServers.map((s) => s.urls), ['stun:sbc.ejemplo:3490', 'turn:sbc.ejemplo:3490?transport=udp', 'turn:sbc.ejemplo:3490?transport=tcp']);
  assert.equal(ice.origen, 'sbc');
});

test('origen externo: sin URL, URL sin host, sin credenciales y utilizable', async (t) => {
  const { m, st, rutas } = armar(t, { ajustes: { turn_origen: 'externo' } });
  let e = await m.origenEfectivo();
  assert.equal(e.motivo, 'no se cargó ninguna URL de TURN externo');
  st.ajustes.turn_ext_urls = 'turn:relay.ejemplo:3478, turn:';
  e = await m.origenEfectivo();
  assert.match(e.motivo, /la URL «turn:» no tiene host/);
  st.ajustes.turn_ext_urls = 'turn:relay.ejemplo:3478,turns:relay.ejemplo:5349';
  e = await m.origenEfectivo();
  assert.equal(e.motivo, 'faltan usuario y clave del TURN externo');
  Object.assign(st.ajustes, { turn_ext_user: 'u', turn_ext_pass: 'p' });
  const ice = (await http(rutas['GET /api/ice'])).cuerpo;
  assert.deepEqual(ice.iceServers.at(-1), { urls: ['turn:relay.ejemplo:3478', 'turns:relay.ejemplo:5349'], username: 'u', credential: 'p' });
});

test('STUN a mano: se normaliza, se filtra lo roto y si no queda nada cae al appliance', async (t) => {
  const { m, st } = armar(t, { env: { PUBLIC_IP: '203.0.113.9', STUN_URL: 'stun.uno.ejemplo, stun:dos.ejemplo:3479, ,stun:no sirve' } });
  let e = await m.origenEfectivo();
  assert.deepEqual(e.stun, ['stun:stun.uno.ejemplo', 'stun:dos.ejemplo:3479'], 'desde el .env cuando el panel no dice nada');
  st.ajustes.stun_url = 'stun:mal host';
  e = await m.origenEfectivo();
  assert.deepEqual(e.stun, ['stun:203.0.113.9:3478']);
});

test('estado: caché de 20 s, coturn apagado sin sondear, y sondeo real cuando corresponde', async (t) => {
  const srv = await turnFalso({ soloUdp: true });
  t.after(() => srv.cerrar());
  const { m, st, rutas } = armar(t, { ajustes: { turn_host: '127.0.0.1', turn_puerto: String(srv.puerto) }, env: { TURN_PASS: 'p' } });
  let r = (await http(rutas['GET /api/turn/estado'])).cuerpo;
  assert.equal(r.sondeado, true);
  assert.equal(r.corriendo, true);
  assert.equal(r.motivo, '');
  const binds = srv.pedidos('UDP').length;
  assert.equal((await http(rutas['GET /api/turn/estado'])).cuerpo.corriendo, true);
  assert.equal(srv.pedidos('UDP').length, binds, 'dentro de los 20 s sale de la caché');
  st.modulo = false;
  r = (await http(rutas['GET /api/turn/estado'], { query: { fresco: '1' } })).cuerpo;
  assert.equal(r.sondeado, false);
  assert.match(r.motivo, /apagado/);
  assert.equal(srv.pedidos('UDP').length, binds, 'apagado a propósito: no se sondea');
  delete st.ajustes.turn_host;
  st.modulo = true;
  m.invalidar();
  r = await m.estado();
  assert.equal(r.sondeado, false);
  assert.match(r.motivo, /no tiene dirección pública/);
  st.romperModulo = true;
  assert.equal((await http(rutas['GET /api/turn/estado'], { query: { fresco: '1' } })).statusCode, 500);
  st.ajustes.turn_host = '127.0.0.1';                 // con host se consulta el módulo también para /api/ice
  assert.equal((await http(rutas['GET /api/ice'])).statusCode, 500);
});

test('estado sin host en un origen ajeno: «no hay ningún host» y no se sondea', async (t) => {
  const { m } = armar(t, { ajustes: { turn_origen: 'externo' }, modulo: false });
  const r = await m.estado(true);
  assert.equal(r.sondeado, false);
  assert.equal(r.local, false);
  assert.equal(r.motivo, 'no se cargó ninguna URL de TURN externo');
});

test('GET /api/turn/origen no devuelve claves y tolera el enlace al SBC roto', async (t) => {
  const { st, rutas } = armar(t, { ajustes: { turn_sbc_pass: 'secreta', turn_ext_pass: 'otra', turn_ext_urls: 'turn:x' }, env: { DOMAIN: 'c.ejemplo', TURN_PASS: 'p' } });
  st.romperLink = true;
  let r = (await http(rutas['GET /api/turn/origen'])).cuerpo;
  assert.equal(r.sbc.disponible, false);
  assert.equal(r.sbc.tiene_clave, true);
  assert.equal(r.externo.tiene_clave, true);
  assert.equal(r.propio.tiene_clave, true);
  assert.ok(!JSON.stringify(r).includes('secreta'));
  assert.equal(r.propio.host_efectivo, 'c.ejemplo');
  st.romperLink = false;
  st.ajustes.turn_origen = 'externo';
  st.lk = { active: true, host: 'sbc.ejemplo' };
  r = (await http(rutas['GET /api/turn/origen'])).cuerpo;
  assert.equal(r.propio.host_efectivo, 'c.ejemplo', 'con otro origen igual muestra el host propio que quedaría');
  assert.equal(r.sbc.host, 'sbc.ejemplo');
  // Un fallo inesperado (moduleEnabled) sale por errorHttp.
  st.ajustes.turn_origen = 'propio';
  st.romperModulo = true;
  assert.equal((await http(rutas['GET /api/turn/origen'])).statusCode, 500);
});

test('PUT origen: validaciones antes de tocar nada', async (t) => {
  const { st, rutas } = armar(t, { ajustes: { turn_sbc_user: '' } });
  const put = (body) => http(rutas['PUT /api/turn/origen'], { body });
  assert.equal((await http(rutas['PUT /api/turn/origen'], {})).statusCode, 400, 'sin cuerpo');
  st.lk = { active: false };
  assert.match((await put({ origen: 'sbc' })).cuerpo.error, /no hay un enlace a SBC-NG activo/);
  st.lk = { active: true, host: 'sbc.ejemplo' };
  assert.match((await put({ origen: 'sbc' })).cuerpo.error, /hace falta el usuario TURN/);
  assert.match((await put({ origen: 'sbc', sbc_usuario: '  ' })).cuerpo.error, /hace falta el usuario TURN/);
  st.ajustes.turn_ext_urls = 'turn:';
  assert.match((await put({ origen: 'externo' })).cuerpo.error, /no es una URL de TURN válida/, 'sin URLs nuevas se validan las guardadas');
  assert.match((await put({ origen: 'propio', stun_url: 'stun:no anda' })).cuerpo.error, /el STUN «stun:no anda» no es válido/);
  assert.match((await put({ origen: 'propio', propio_host: 'http://x' })).cuerpo.error, /no puede tener espacios/);
  assert.match((await put({ origen: 'propio', propio_puerto: '70000' })).cuerpo.error, /entre 1 y 65535/);
  assert.equal(Object.keys(st.ajustes).length, 2, 'nada se escribió');
  assert.deepEqual(st.fwd, []);
});

test('PUT origen externo: no utilizable → 400, relay que no contesta → 409, y nada cambia', async (t) => {
  const puerto = await stunPelado(t);
  const { st, rutas } = armar(t);
  const put = (body) => http(rutas['PUT /api/turn/origen'], { body });
  let r = await put({ origen: 'externo', externo_urls: 'turn:127.0.0.1:' + puerto });
  assert.equal(r.statusCode, 400);
  assert.equal(r.cuerpo.sin_cambios, true);
  assert.match(r.cuerpo.error, /faltan usuario y clave/);
  r = await put({ origen: 'externo', externo_urls: 'turn:127.0.0.1:' + puerto, externo_usuario: 'u', externo_clave: 'p' });
  assert.equal(r.statusCode, 409);
  assert.match(r.cuerpo.error, /no se comporta como TURN/);
  assert.equal(r.cuerpo.verificacion.ok, false);
  assert.deepEqual(st.ajustes, {}, 'no se guardó nada');
  assert.deepEqual(st.setModule, []);
});

test('PUT origen: guardar sobrevive a que fallen el módulo y el agente; un error de base es 500', async (t) => {
  const srv = await turnFalso({ soloUdp: true });
  t.after(() => srv.cerrar());
  const { st, rutas } = armar(t, { env: { PUBLIC_IP: '203.0.113.9', TURN_PASS: 'p' } });
  const put = (body) => http(rutas['PUT /api/turn/origen'], { body });

  // Externo verificado de verdad (sólo UDP): pasa, con el aviso de TCP.
  let r = await put({ origen: 'externo', externo_urls: 'turn:127.0.0.1:' + srv.puerto, externo_usuario: 'u', externo_clave: 'p', stun_url: '' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.verificacion.ok, true);
  assert.match(r.cuerpo.verificacion.aviso, /TCP/);
  assert.deepEqual(st.setModule.at(-1), ['turn', false], 'otro origen apaga el coturn local');
  assert.deepEqual(st.fwd.at(-1), ['POST', '/service', { action: 'stop' }]);

  // SBC forzado, con el módulo y el agente rotos: se guarda igual y se informa.
  st.lk = { active: true, host: 'sbc.ejemplo' };
  st.romperSetModule = true;
  st.fwdFalla = 'agente caído';
  r = await put({ origen: 'sbc', sbc_usuario: ' u ', sbc_clave: 'k', sbc_puerto: 'x', forzar: true });
  assert.equal(r.statusCode, 200);
  assert.equal(r.cuerpo.forzado, true);
  assert.equal(r.cuerpo.verificacion, null);
  assert.deepEqual(r.cuerpo.svc, { error: 'agente caído' });
  assert.equal(st.ajustes.turn_sbc_user, 'u');
  assert.equal(st.ajustes.turn_sbc_puerto, '', 'un puerto que no es número se guarda vacío (= por defecto)');

  // Volver a propio no se verifica (es la salida de emergencia) y enciende.
  st.romperSetModule = false;
  st.fwdFalla = null;
  r = await put({ origen: 'propio', propio_host: ' central.ejemplo ', propio_puerto: '3480', stun_url: 'stun.ejemplo' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.cuerpo.coturn_local, true);
  assert.deepEqual(r.cuerpo.svc, { ok: true, ruta: '/service', cuerpo: { action: 'start' } });
  assert.equal(r.cuerpo.efectivo.host, 'central.ejemplo');
  assert.deepEqual(r.cuerpo.efectivo.stun, ['stun:stun.ejemplo']);

  st.romperEscritura = true;
  r = await put({ origen: 'propio' });
  assert.equal(r.statusCode, 500);
});

test('probar y testear: el texto de «Probar TURN» lleva cada paso y el aviso', async (t) => {
  const srv = await turnFalso({ soloUdp: true });
  t.after(() => srv.cerrar());
  const { rutas } = armar(t, { ajustes: { turn_host: '127.0.0.1', turn_puerto: String(srv.puerto) }, env: { TURN_PASS: 'p' } });
  const r = (await http(rutas['POST /api/turn/test'])).cuerpo;
  assert.equal(r.ok, true);
  assert.match(r.out, /^UDP 127\.0\.0\.1:\d+\n {2}OK {2}STUN Binding/m);
  assert.match(r.out, /^TCP .*\n {2}FALLA STUN Binding/m);
  assert.match(r.out, /=> OK · /);
  assert.match(r.out, /=> FALLA · /);
  assert.match(r.out, /\n\nAVISO · TURN sobre TCP/);
  const p = (await http(rutas['POST /api/turn/probe'])).cuerpo;
  assert.equal(p.ok, true);
  assert.equal(p.origen, 'propio');
});

test('probar y testear sin aviso, y errores de la consola del coturn', async (t) => {
  const { st, rutas } = armar(t);
  // Sin host: los dos transportes fallan igual, no hay aviso que dar.
  let r = (await http(rutas['POST /api/turn/test'])).cuerpo;
  assert.equal(r.ok, false);
  assert.ok(!/AVISO/.test(r.out));
  for (const k of ['GET /api/turn', 'GET /api/turn/config', 'POST /api/turn/config', 'POST /api/turn/restart', 'GET /api/turn/logs']) {
    assert.equal((await http(rutas[k])).cuerpo.ok, true, k);
  }
  assert.deepEqual(st.fwd.find((f) => f[1] === '/config' && f[0] === 'POST')[2], {}, 'sin cuerpo manda un objeto vacío');
  st.fwdFalla = 'ECONNREFUSED';
  for (const k of ['GET /api/turn', 'GET /api/turn/config', 'POST /api/turn/config', 'POST /api/turn/restart', 'GET /api/turn/logs']) {
    assert.equal((await http(rutas[k])).statusCode, 500, k);
  }
  process.env.PUBLIC_IP = '203.0.113.9';             // con host, el origen consulta el módulo
  st.romperModulo = true;
  assert.equal((await http(rutas['POST /api/turn/probe'])).statusCode, 500);
  assert.equal((await http(rutas['POST /api/turn/test'])).statusCode, 500);
});
