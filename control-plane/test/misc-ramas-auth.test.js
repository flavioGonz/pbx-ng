/* ============================================================================
 *  Autenticación, aprovisionamiento y usuarios (auth.js) sobre un Express de verdad
 *  pero con la base, el SMTP y el ICE de mentira.
 *
 *  test/auth.test.js, users.test.js y enrolado.test.js recorren esto contra la API
 *  real. Acá se fijan los caminos que allá no se pueden provocar sin romper Postgres a
 *  mano, y que son los que deciden quién entra y qué se lleva un teléfono:
 *   - el alcance por interno: un token de softphone sólo opera SU interno, un agente sin
 *     interno no ve nada, admin/supervisor ven todo;
 *   - el login no se cae si las alertas fallan, rechaza roles viejos y no filtra el
 *     error de la base;
 *   - el QR de provisión y el canje del enrolado llevan el ICE de turn.js tal cual (STUN
 *     y TURN con credencial) y, sin ICE, salen sin TURN en vez de inventar uno; el
 *     transporte SIP sale del endpoint real (tls/tcp/udp) y el host, del ajuste o del
 *     enlace al SBC;
 *   - el enrolado por correo no deja tokens huérfanos si no hay SMTP o dominio, y si el
 *     envío falla hace ROLLBACK aunque el ROLLBACK mismo falle;
 *   - el bootstrap crea el admin con la clave del .env, y si la base no está lo registra.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const initAuth = require('../auth');

const SECRET = 'secreto-de-prueba';
const tok = (p) => jwt.sign(p, SECRET);
const ADMIN = tok({ uid: 1, username: 'admin', role: 'admin', name: 'Admin' });

/* Base de mentira: cada prueba pone su `manejar(sql, args)`. `connect()` da un cliente
 * que pasa por el mismo manejador y anota BEGIN/COMMIT/ROLLBACK. */
function baseFalsa() {
  const st = { manejar: () => null, consultas: [], sinConexion: false, romperRollback: false, liberados: 0 };
  const query = async (sql, args) => {
    st.consultas.push({ sql, args });
    if (sql === 'ROLLBACK' && st.romperRollback) throw new Error('conexión perdida');
    const r = await st.manejar(sql, args);
    return r || { rows: [], rowCount: 0 };
  };
  st.pool = {
    query,
    connect: async () => { if (st.sinConexion) throw Object.assign(new Error('sin base'), { status: 503 }); return { query, release: () => { st.liberados++; } }; },
  };
  return st;
}

async function levantar(t, { base, deps = {}, bootstrap } = {}) {
  const db = base || baseFalsa();
  if (bootstrap) db.manejar = bootstrap;
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  let mod;
  app.use('/api', (req, res, next) => (mod.isPublicApi(req) ? next() : mod.auth(req, res, next)));
  const logins = [];
  mod = initAuth({
    app, pool: db.pool, SECRET, NODES: {},
    alerts: { onLogin: async (x) => { logins.push(x); throw new Error('alertas caídas'); } },
    sbcLink: async () => ({ active: false }),
    broadcastSoon: () => {},
    createWebrtcEndpoint: async () => {},
    smtpHint: (e) => 'SMTP: ' + e.message,
    ...deps,
  });
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  t.after(() => new Promise((ok) => srv.close(ok)));
  const base0 = 'http://127.0.0.1:' + srv.address().port;
  async function api(metodo, ruta, { token, body, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base0 + ruta, { method: metodo, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch (_) {}
    return { status: r.status, json };
  }
  return { mod, db, api, logins };
}
const tic = () => new Promise((r) => setImmediate(r));

test('alcance por interno: softphone, agente sin interno, admin; e IP del cliente', async (t) => {
  const { mod } = await levantar(t);
  assert.equal(mod.mismaExt({}, '2001'), false, 'sin usuario no hay alcance');
  assert.equal(mod.mismaExt({ user: { role: 'admin' } }, ''), false, 'sin extensión no hay nada que operar');
  assert.equal(mod.mismaExt({ user: { scope: 'phone', ext: 2001 } }, '2001'), true);
  assert.equal(mod.mismaExt({ user: { scope: 'phone', ext: '2001' } }, '2002'), false);
  assert.equal(mod.mismaExt({ user: { role: 'supervisor' } }, '2002'), true);
  assert.equal(mod.mismaExt({ user: { role: 'agente' } }, '2002'), false, 'agente sin interno');
  assert.equal(mod.extPropia({}), '');
  assert.equal(mod.extPropia({ user: { scope: 'phone' } }), '');
  assert.equal(mod.extPropia({ user: { role: 'admin' } }), null);
  assert.equal(mod.extPropia({ user: { role: 'agente', ext: 7 } }), '7');
  assert.equal(mod.clientIp({ socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  assert.equal(mod.clientIp({}), '');
  assert.equal(mod.isPublicApi({ method: 'GET', path: '/api/ice' }), true, 'sin baseUrl se mira la ruta sola');
  assert.equal(mod.isPublicApi({ method: 'DELETE', baseUrl: '/api', path: '/v1/x' }), true, 'v1 tiene su propia puerta, con cualquier método');
});

test('login: alertas que fallan no lo frenan, rol viejo 403, sin cuerpo 401 y base caída 500', async (t) => {
  const hash = await bcrypt.hash('clave-buena', 4);
  const x = await levantar(t);
  x.db.manejar = (sql, args) => {
    if (/FROM pbxng_users WHERE username=\$1/.test(sql)) {
      if (args[0] === 'boom') throw new Error('relation "pbxng_users" does not exist');
      if (args[0] === 'ana') return { rows: [{ id: 2, username: 'ana', name: 'Ana', role: 'agente', ext: null, password_hash: hash, must_change: false }] };
      if (args[0] === 'viejo') return { rows: [{ id: 3, username: 'viejo', role: 'operator', password_hash: hash }] };
    }
    return null;
  };
  let r = await x.api('POST', '/api/auth/login', { headers: { 'User-Agent': 'prueba' } });
  assert.equal(r.status, 401, 'sin cuerpo: usuario o contraseña incorrectos');
  r = await x.api('POST', '/api/auth/login', { body: { username: 'ana', password: 'clave-buena' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.ext, null);
  assert.equal(r.json.must_change, false);
  await tic();
  assert.deepEqual(x.logins.map((l) => l.ok), [false, true], 'las dos alertas se pidieron aunque fallen');
  r = await x.api('POST', '/api/auth/login', { body: { username: 'viejo', password: 'clave-buena' } });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /rol no soportado \(operator\)/);
  r = await x.api('POST', '/api/auth/login', { body: { username: 'boom', password: 'x' } });
  assert.equal(r.status, 500);
  assert.ok(!/pbxng_users/.test(r.json.error), 'el error de Postgres no llega crudo');
});

test('cambio de clave propia: validaciones, usuario borrado y base caída', async (t) => {
  const hash = await bcrypt.hash('actual-123', 4);
  const x = await levantar(t);
  let fila = { password_hash: hash, must_change: false };
  x.db.manejar = (sql) => {
    if (/SELECT password_hash, must_change/.test(sql)) { if (fila === 'boom') throw new Error('x'); return { rows: fila ? [fila] : [] }; }
    return null;
  };
  const cambiar = (body) => x.api('POST', '/api/auth/password', { token: ADMIN, body });
  assert.equal((await x.api('POST', '/api/auth/password', { token: ADMIN })).status, 400, 'sin cuerpo');
  assert.equal((await cambiar({ password: 'nueva-1234' })).status, 400, 'falta la actual');
  assert.equal((await cambiar({ password: 'nueva-1234', current: 'otra' })).status, 403);
  assert.equal((await cambiar({ password: 'nueva-1234', current: 'actual-123' })).status, 200);
  fila = { password_hash: hash, must_change: true };
  assert.equal((await cambiar({ password: 'nueva-1234' })).status, 200, 'primer ingreso: no pide la actual');
  fila = null;
  assert.equal((await cambiar({ password: 'nueva-1234' })).status, 404);
  fila = 'boom';
  assert.equal((await cambiar({ password: 'nueva-1234' })).status, 500);
});

test('QR de provisión: ICE de turn.js tal cual, sin ICE sin TURN, permisos y errores', async (t) => {
  let ice = { iceServers: [{ urls: 'stun:central.ejemplo:3478' }, { urls: ['turn:central.ejemplo:3478?transport=udp', 'turn:x?transport=tcp'], username: 'u', credential: 'p' }, { urls: 'turn:sin-credencial' }] };
  const x = await levantar(t, { deps: { iceMedio: async () => ice } });
  let ajustes = { wss: 'wss://central.ejemplo/ws', domain: 'central.ejemplo' };
  x.db.manejar = (sql, args) => {
    if (/FROM ps_auths/.test(sql)) { if (args[0] === 'boom') throw new Error('x'); return { rows: args[0] === '2001' ? [{ password: 'sip-secreta' }] : [] }; }
    if (/FROM pbxng_settings WHERE key=\$1/.test(sql)) return { rows: ajustes[args[0]] ? [{ value: ajustes[args[0]] }] : [] };
    if (/FROM pbxng_users WHERE ext=\$1/.test(sql)) return { rows: [] };
    return null;
  };
  const agente = tok({ uid: 5, role: 'agente', ext: '2001' });
  assert.equal((await x.api('GET', '/api/provision?ext=2001', { token: agente })).status, 403);
  assert.equal((await x.api('GET', '/api/provision', { token: ADMIN })).status, 400);
  assert.equal((await x.api('GET', '/api/provision?ext=2999', { token: ADMIN })).status, 404);
  assert.equal((await x.api('GET', '/api/provision?ext=boom', { token: ADMIN })).status, 500);
  let r = await x.api('GET', '/api/provision?ext=2001', { token: ADMIN, headers: { 'X-Forwarded-Proto': 'http, https', 'X-Forwarded-Host': 'panel.ejemplo' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, '2001', 'sin usuario asociado el nombre es el interno');
  assert.equal(r.json.stun, 'stun:central.ejemplo:3478');
  assert.equal(r.json.turn, 'turn:central.ejemplo:3478', 'sin el ?transport=');
  assert.deepEqual([r.json.turnUser, r.json.turnPass], ['u', 'p']);
  assert.equal(r.json.apiBase, 'http://panel.ejemplo');
  assert.equal(jwt.verify(r.json.apiToken, SECRET).scope, 'phone');
  ice = { iceServers: [{ urls: 'turn:solo.ejemplo?transport=udp', username: 'u', credential: 'p' }] };
  ajustes = { public_base: 'https://publico.ejemplo' };
  r = await x.api('GET', '/api/provision?ext=2001', { token: ADMIN });
  assert.equal(r.json.turn, 'turn:solo.ejemplo');
  assert.equal(r.json.stun, '');
  assert.equal(r.json.apiBase, 'https://publico.ejemplo');
  ice = null;
  r = await x.api('GET', '/api/provision?ext=2001', { token: ADMIN });
  assert.deepEqual([r.json.stun, r.json.turn, r.json.turnUser], ['', '', '']);
});

test('QR de provisión sin función de ICE: sale sin STUN ni TURN', async (t) => {
  const x = await levantar(t, { deps: { iceMedio: undefined } });
  x.db.manejar = (sql) => (/FROM ps_auths/.test(sql) ? { rows: [{ password: 's' }] } : /FROM pbxng_users WHERE ext/.test(sql) ? { rows: [{ name: 'Ana' }] } : null);
  const r = await x.api('GET', '/api/provision?ext=2001', { token: ADMIN });
  assert.equal(r.json.name, 'Ana');
  assert.deepEqual([r.json.stun, r.json.turn], ['', '']);
  assert.match(r.json.apiBase, /^http:\/\/127\.0\.0\.1:\d+$/, 'sin dominio ni proxy, el host del pedido');
});

test('canje de enrolado: aparato por User-Agent, transporte del endpoint real y host SIP', async (t) => {
  let ep = null;
  let lk = { active: true, host: 'sbc.ejemplo' };
  let ajustes = {};
  let ice = { iceServers: [{ urls: 'stun:a' }, { urls: 'turn:a:3478?transport=udp', username: 'u', credential: 'p' }] };
  const x = await levantar(t, { deps: { iceMedio: async () => ice, sbcLink: async () => lk } });
  x.db.manejar = (sql, args) => {
    if (/FROM pbxng_enroll WHERE token/.test(sql)) return { rows: args[0] === 'boom' ? (() => { throw new Error('x'); })() : [{ token: args[0], ext: '2001', password: 'sip', expires_at: null, used_at: null }] };
    if (/FROM pbxng_settings WHERE key=\$1/.test(sql)) return { rows: ajustes[args[0]] ? [{ value: ajustes[args[0]] }] : [] };
    if (/FROM ps_endpoints/.test(sql)) return { rows: ep ? [ep] : [] };
    if (/^UPDATE pbxng_enroll/.test(sql)) return { rowCount: 1 };
    return null;
  };
  const aparato = async (ua) => (await x.api('GET', '/api/enroll/t1', { headers: { 'User-Agent': ua } }), x.db.consultas.filter((c) => /^UPDATE pbxng_enroll/.test(c.sql)).at(-1).args.slice(1, 3));
  assert.deepEqual(await aparato('PBXNG-Desktop Windows NT'), ['App de escritorio', 'Windows']);
  assert.deepEqual(await aparato('Electron Macintosh'), ['App de escritorio', 'macOS']);
  assert.deepEqual(await aparato('Electron X11'), ['App de escritorio', 'Escritorio']);
  assert.deepEqual(await aparato('Mozilla (iPhone) Safari/1'), ['iPhone', 'iOS']);
  assert.deepEqual(await aparato('Mozilla (iPad)'), ['iPad', 'iOS']);
  assert.deepEqual(await aparato('Mozilla (Linux; Android 14) Chrome/120'), ['Celular Android', 'Android']);
  assert.deepEqual(await aparato('Mozilla (Windows NT 10) Chrome/1 Edg/120'), ['Edge', 'Windows']);
  assert.deepEqual(await aparato('Mozilla (Macintosh; Mac OS X) Safari/605'), ['Safari', 'macOS']);
  assert.deepEqual(await aparato('Mozilla (X11; Linux) Firefox/120'), ['Firefox', 'Linux']);
  assert.deepEqual(await aparato('curl/8'), ['Navegador', 'Desconocida']);

  // Sin endpoint en la base: SIP nativo por UDP, host del enlace al SBC, sin dominio.
  let r = await x.api('GET', '/api/enroll/t1', { headers: { 'X-Forwarded-Host': 'panel.ejemplo' } });
  assert.equal(r.json.prov.transport, 'sip');
  assert.deepEqual([r.json.prov.sipServer, r.json.prov.sipPort, r.json.prov.sipTransport, r.json.prov.sipSrtp], ['sbc.ejemplo', '5060', 'udp', 'none']);
  assert.equal(r.json.prov.apiBase, 'http://panel.ejemplo');
  assert.equal(r.json.prov.turn, '', 'el TURN es sólo para WebRTC');
  ep = { transport: 'transport-tls', media_encryption: 'sdes', webrtc: 'no' };
  ajustes = { sip_host: 'sip.ejemplo', domain: 'central.ejemplo' };
  r = await x.api('GET', '/api/enroll/t1');
  assert.deepEqual([r.json.prov.sipServer, r.json.prov.sipPort, r.json.prov.sipTransport, r.json.prov.sipSrtp], ['sip.ejemplo', '5061', 'tls', 'sdes']);
  assert.equal(r.json.prov.apiBase, 'https://central.ejemplo');
  ep = { transport: 'transport-tcp' };
  lk = { active: false };
  ajustes = {};
  r = await x.api('GET', '/api/enroll/t1');
  assert.equal(r.json.prov.sipTransport, 'tcp');
  assert.equal(r.json.prov.sipServer, '', 'sin ajuste, sin SBC y sin dominio no hay host que inventar');
  // WebRTC: TURN de turn.js; sin ICE, vacío.
  ep = { transport: 'transport-wss', webrtc: 'yes' };
  r = await x.api('GET', '/api/enroll/t1');
  assert.deepEqual([r.json.prov.transport, r.json.prov.stun, r.json.prov.turn, r.json.prov.turnUser], ['webrtc', 'stun:a', 'turn:a:3478', 'u']);
  assert.equal(r.json.prov.wss, '', 'sin dominio no hay wss que armar');
  ice = { iceServers: [{ urls: 'stun:a' }] };
  r = await x.api('GET', '/api/enroll/t1');
  assert.deepEqual([r.json.prov.turn, r.json.prov.turnUser, r.json.prov.turnPass], ['', '', '']);
  ice = null;
  r = await x.api('GET', '/api/enroll/t1');
  assert.equal(r.json.prov.stun, '');
  assert.equal((await x.api('GET', '/api/enroll/boom')).status, 500);
});

test('canje de enrolado sin función de ICE', async (t) => {
  const x = await levantar(t, { deps: { iceMedio: undefined } });
  x.db.manejar = (sql) => {
    if (/FROM pbxng_enroll WHERE token/.test(sql)) return { rows: [{ ext: '2001', password: 'sip' }] };
    if (/FROM ps_endpoints/.test(sql)) return { rows: [{ webrtc: 'yes' }] };
    if (/FROM pbxng_users WHERE ext/.test(sql)) return { rows: [{ name: 'Ana' }] };
    return null;
  };
  const r = await x.api('GET', '/api/enroll/t1');
  assert.equal(r.json.prov.name, 'Ana');
  assert.equal(r.json.prov.stun, '');
});

test('alta de enrolado: sin cuerpo, sin base, reuso de clave y ROLLBACK que también falla', async (t) => {
  let falla = false;
  const x = await levantar(t, { deps: { createWebrtcEndpoint: async () => { if (falla) throw new Error('ext duplicada'); } } });
  x.db.manejar = (sql, args) => (/FROM ps_auths/.test(sql) ? { rows: args[0] === '2001' ? [{ password: 'vieja' }] : [] } : null);
  assert.equal((await x.api('POST', '/api/enroll', { token: ADMIN })).status, 400);
  let r = await x.api('POST', '/api/enroll', { token: ADMIN, body: { ext: '2001' } });
  assert.equal(r.json.password, 'vieja', 'un interno que ya existe conserva su clave');
  assert.equal(x.db.consultas.find((c) => /INSERT INTO pbxng_enroll/.test(c.sql)).args[3], null, 'sin etiqueta: null');
  x.db.romperRollback = true;
  falla = true;
  r = await x.api('POST', '/api/enroll', { token: ADMIN, body: { ext: '2002', video: true } });
  assert.equal(r.status, 500);
  assert.equal(x.db.liberados, 2, 'la conexión se devuelve siempre');
  x.db.sinConexion = true;
  assert.equal((await x.api('POST', '/api/enroll', { token: ADMIN, body: { ext: '2002' } })).status, 503);
});

test('enrolado por correo: sin SMTP o sin dominio no crea nada; envío con y sin usuario; falla con ROLLBACK', async (t) => {
  const x = await levantar(t);
  let cfg = null;
  let dominio = null;
  let marca = null;
  x.db.manejar = (sql, args) => {
    if (/FROM pbxng_email_config/.test(sql)) return { rows: cfg ? [cfg] : [] };
    if (/key='domain'/.test(sql)) return { rows: dominio ? [{ value: dominio }] : [] };
    if (/key='brand_name'/.test(sql)) return { rows: marca ? [{ value: marca }] : [] };
    if (/FROM ps_auths/.test(sql)) return { rows: args[0] === '2001' ? [{ password: 'vieja' }] : [] };
    return null;
  };
  const enviados = [];
  let smtpFalla = null;
  t.mock.method(nodemailer, 'createTransport', (o) => ({ sendMail: async (m) => { if (smtpFalla) throw new Error(smtpFalla); enviados.push({ o, m }); } }));
  const mandar = (body) => x.api('POST', '/api/enroll/email', { token: ADMIN, body });
  assert.equal((await x.api('POST', '/api/enroll/email', { token: ADMIN })).status, 400);
  assert.match((await mandar({ ext: '2001', to: 'a@b.uy' })).json.error, /Configurá y activá el email/);
  cfg = { host: 'smtp.local', enabled: true };
  const antes = process.env.DOMAIN;
  delete process.env.DOMAIN;
  t.after(() => { if (antes !== undefined) process.env.DOMAIN = antes; });
  assert.match((await mandar({ ext: '2001', to: 'a@b.uy' })).json.error, /Falta el dominio público/);
  assert.ok(!x.db.consultas.some((c) => /INSERT INTO pbxng_enroll/.test(c.sql)), 'no quedó ningún token huérfano');
  dominio = 'central.ejemplo';
  cfg = { host: 'smtp.local', enabled: true, username: 'central@ejemplo.uy', password: 'k' };
  let r = await mandar({ ext: '2001', to: 'a@b.uy' });
  assert.equal(r.status, 200);
  assert.equal(enviados[0].o.port, 587);
  assert.deepEqual(enviados[0].o.auth, { user: 'central@ejemplo.uy', pass: 'k' });
  assert.equal(enviados[0].m.from, 'central@ejemplo.uy');
  cfg = { host: 'smtp.local', port: 465, secure: true, enabled: true, from_addr: 'no-responder@ejemplo.uy' };
  marca = 'Portería Sur';
  assert.equal((await mandar({ ext: '2002', to: 'a@b.uy' })).status, 200);
  assert.equal(enviados[1].o.auth, undefined);
  assert.equal(enviados[1].m.from, 'no-responder@ejemplo.uy');
  smtpFalla = '535 auth';
  x.db.romperRollback = true;
  r = await mandar({ ext: '2001', to: 'a@b.uy' });
  assert.deepEqual([r.status, r.json.error], [500, 'SMTP: 535 auth']);
  x.db.sinConexion = true;
  assert.equal((await mandar({ ext: '2001', to: 'a@b.uy' })).status, 503);
});

test('usuarios: validaciones y errores de base', async (t) => {
  const x = await levantar(t);
  let romper = false;
  let filas = 1;
  x.db.manejar = (sql) => { if (romper) throw new Error('base caída'); if (/^UPDATE pbxng_users/.test(sql)) return { rowCount: filas }; return null; };
  assert.equal((await x.api('POST', '/api/users', { token: ADMIN })).status, 400);
  assert.equal((await x.api('POST', '/api/users/9/password', { token: ADMIN })).status, 400);
  filas = 0;
  assert.equal((await x.api('POST', '/api/users/9/password', { token: ADMIN, body: { password: 'larga-1234' } })).status, 404);
  romper = true;
  assert.equal((await x.api('POST', '/api/users/9/password', { token: ADMIN, body: { password: 'larga-1234' } })).status, 500);
  assert.equal((await x.api('GET', '/api/users', { token: ADMIN })).status, 500);
  assert.equal((await x.api('POST', '/api/users', { token: ADMIN, body: { username: 'x', password: 'larga-1234' } })).status, 500);
  assert.equal((await x.api('DELETE', '/api/users/9', { token: ADMIN })).status, 500);
});

test('canje de token de softphone y credenciales SIP: sin cuerpo y con la base caída', async (t) => {
  const x = await levantar(t);
  x.db.manejar = () => { throw new Error('base caída'); };
  assert.equal((await x.api('POST', '/api/phone/token')).status, 400);
  assert.equal((await x.api('POST', '/api/phone/token', { body: { ext: '2001', password: 'x' } })).status, 500);
  assert.equal((await x.api('GET', '/api/me/sipcreds', { token: tok({ uid: 2, role: 'agente', ext: '2001' }) })).status, 500);
  assert.deepEqual((await x.api('GET', '/api/auth/setup')).json, { defaultAdmin: false }, 'sin base, no sugiere nada');
});

test('bootstrap: sin usuarios crea el admin con la clave del .env; sin base lo registra', async (t) => {
  const antes = process.env.ADMIN_DEFAULT_PASS;
  process.env.ADMIN_DEFAULT_PASS = 'clave-de-fabrica';
  t.after(() => { if (antes === undefined) delete process.env.ADMIN_DEFAULT_PASS; else process.env.ADMIN_DEFAULT_PASS = antes; });
  const db = baseFalsa();
  db.manejar = (sql) => (/count\(\*\)::int n FROM pbxng_users/.test(sql) ? { rows: [{ n: 0 }] } : null);
  await levantar(t, { base: db });
  for (let i = 0; i < 50 && !db.consultas.some((c) => /INSERT INTO pbxng_users/.test(c.sql)); i++) await new Promise((r) => setTimeout(r, 10));
  const ins = db.consultas.find((c) => /INSERT INTO pbxng_users/.test(c.sql));
  assert.ok(ins, 'se creó el admin');
  assert.ok(await bcrypt.compare('clave-de-fabrica', ins.args[0]));
  const rota = baseFalsa();
  rota.manejar = () => { throw new Error('base caída'); };
  await levantar(t, { base: rota });            // no tira: el error queda en el log
  await tic();
});
