/* ============================================================================
 *  Centro de seguridad (guard.js): los bordes que no tocan guard.test.js (la ráfaga y
 *  v6) ni guard-rutas.test.js (las rutas contra una base real).
 *
 *  Todo con dependencias falsas —pool en memoria, agente de firewall falso, Express de
 *  mentira— para poder romper cada pieza por separado y ver que el guardia se degrada
 *  como dice el diseño:
 *   - la base caída o lenta no tumba al guardia ni deja una IP marcada a medias, y al
 *     cliente le llega un error traducido (nunca el texto crudo de Postgres);
 *   - el agente de nftables que contesta raro (sin JSON, 400, 503, sin `enabled`) cambia
 *     el estado del firewall SÓLO cuando habla del firewall y no de un pedido puntual;
 *   - el contador por IP: cuentas inexistentes que se enumeran, la lista blanca que
 *     mira pero no cuenta, el país vetado que banea a la primera;
 *   - los relojes del guardia (vuelco de fallos, vencimientos, sync, «bajo ataque»,
 *     recarga de listas, poda) hacen su trabajo y no dejan promesas rechazadas sueltas;
 *   - la sala de socket 'security' es sólo para admin/supervisor y nunca para un
 *     token de teléfono.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
/* astconf.js lee AST_CONF_DIR al cargarse (lo carga guard.js recién en iniciar()): un
 * directorio vacío propio garantiza que pjsip-security.conf «no exista» y se intente
 * escribir, sin depender de lo que haya en /etc de la máquina que corre la prueba. */
const CONF = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-ramas-guard-'));
process.env.AST_CONF_DIR = CONF;
process.on('exit', () => { try { fs.rmSync(CONF, { recursive: true, force: true }); } catch (_) {} });
const initGuard = require('../guard');
const { ipEn, parseRemote, normalizarIp, esPrivada } = require('../guard');

const respuesta = ({ ok = true, status = 200, cuerpo = { ok: true, enabled: true }, sinJson = false } = {}) =>
  ({ ok, status, json: async () => { if (sinJson) throw new Error('no es JSON'); return cuerpo; } });
const tandas = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* Guardia con todo falso. `q` intercepta consultas (devolver undefined = comportamiento
 * por defecto); `fw` decide qué contesta el agente de firewall. */
function armar(o = {}) {
  const rutas = {};
  const reg = (m) => (p, h) => { rutas[m + ' ' + p] = h; };
  const app = o.sinApp ? null : { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  const sql = [];
  const settings = new Map(Object.entries(o.settings || {}));
  const pool = {
    async query(q, args) {
      const s = String(q).replace(/\s+/g, ' ').trim();
      sql.push({ q: s, args });
      if (o.q) { const r = await o.q(s, args); if (r !== undefined) { if (r instanceof Error) throw r; return r; } }
      if (/FROM pbxng_settings WHERE key LIKE/.test(s)) return { rows: [...settings].map(([key, value]) => ({ key, value })) };
      if (/INSERT INTO pbxng_blocked/.test(s)) return { rows: [{ ip: args[0], reason: args[1], hits: 1, permanent: args[5], exp: args[6] > 0 ? Date.now() + args[6] * 1000 : null }] };
      if (/DELETE FROM pbxng_blocked WHERE ip=\$1/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      if (o.connect) return o.connect();
      return { query: (q, a) => pool.query(q, a), release() {} };
    },
  };
  const fwPedidos = [];
  const astFwd = async (method, ruta, body) => {
    fwPedidos.push({ method, ruta, body });
    if (o.fw) return o.fw(method, ruta, body);
    return respuesta();
  };
  const correos = [];
  const alerts = o.sinAlerts ? null : { raise: async (k, d) => { correos.push({ k, d }); if (o.alertaFalla) throw new Error('SMTP'); } };
  const ami = o.sinAmi ? null : new EventEmitter();
  const escritos = {};
  const emitidos = [];
  const io = o.ioRoto ? { to() { throw new Error('socket caído'); } } : { to: (sala) => ({ emit: (ev, d) => emitidos.push({ sala, ev, d }) }) };
  const errores = [];
  const log = { debug() {}, info() {}, warn(...a) { errores.push(['warn', ...a]); }, error(...a) { errores.push(['error', ...a]); } };
  const guard = initGuard({
    app, pool, ami, io, astFwd,
    escribir: o.escribir || ((n, t) => { escritos[n] = t; }),
    alerts,
    geoLookup: o.geoLookup || (async (ips) => Object.fromEntries(ips.map((ip) => [ip, { country: 'Testlandia', cc: 'TL', isp: 'ISP' }]))),
    amiCommand: async () => 'ok',
    log,
  });
  const llamar = async (ruta, { body, query = {}, params = {}, user } = {}) => {
    const r = { status: 200, json: undefined };
    const res = { status(s) { r.status = s; return this; }, json(j) { r.json = j; return this; } };
    await rutas[ruta]({ body, query, params, user }, res);
    return r;
  };
  return { guard, rutas, llamar, sql, fwPedidos, correos, ami, escritos, emitidos, errores };
}

/* ── Funciones puras ──────────────────────────────────────────────────────*/

test('ipEn: IP o regla inválida, familias cruzadas y prefijos imposibles no eximen a nadie', () => {
  assert.equal(ipEn('nada', '0.0.0.0/0'), false);
  assert.equal(ipEn('203.0.113.9', null), false);
  assert.equal(ipEn('203.0.113.9', 'basura/24'), false);
  assert.equal(ipEn('203.0.113.9', '203.0.113.0/40'), false, '/40 no existe en v4');
  assert.equal(ipEn('203.0.113.9', '203.0.113.9'), true, 'IP suelta = /32');
  assert.equal(ipEn('203.0.113.9', '203.0.112.0/23'), true, 'máscara que corta a mitad de byte');
  assert.equal(ipEn('203.0.114.9', '203.0.112.0/23'), false);
  assert.equal(ipEn('2001:db8::1', '2001:db8::/0'), true);
});

test('normalizar, privadas y parseRemote con entradas vacías o raras', () => {
  assert.equal(normalizarIp(undefined), null);
  assert.equal(normalizarIp('   '), null);
  assert.equal(normalizarIp('999.1.1.1'), null, 'un octeto fuera de rango no es una IP');
  assert.equal(esPrivada(null), false);
  assert.equal(esPrivada('100.64.0.1'), true, 'CGNAT es red propia');
  assert.equal(esPrivada('172.32.0.1'), false);
  assert.equal(parseRemote(undefined), null);
  assert.equal(parseRemote('IPV4/UDP/no-ip/5060'), null);
  assert.deepEqual(parseRemote('203.0.113.9:5061'), { ip: '203.0.113.9', proto: '', puerto: '5061' });
  assert.deepEqual(parseRemote('ipv4/TCP/203.0.113.9'), { ip: '203.0.113.9', proto: 'TCP', puerto: '' });
  assert.deepEqual(parseRemote('IPV6/UDP/[2001:db8::1]/5060'), { ip: '2001:db8::1', proto: 'UDP', puerto: '5060' });
  const { guard } = armar();
  assert.equal(guard.esIpv4(''), false);
  assert.equal(guard.esIpv6('2001:db8::1'), true);
  assert.equal(guard.esIpv6('203.0.113.1'), false);
  assert.equal(guard.bandera(''), '');
});

/* ── Ajustes ──────────────────────────────────────────────────────────────*/

test('ajustes: los guardados pisan los defaults; valores basura se ignoran', async () => {
  const { guard } = armar({ settings: { sec_max_fallos: '9', sec_ventana_s: 'abc', sec_alertar: '0', sec_escaneres: '1', sec_otra: 'x' } });
  const s = await guard._cargar.settings();
  assert.equal(s.max_fallos, 9);
  assert.equal(s.ventana_s, 60, 'un entero ilegible deja el default');
  assert.equal(s.alertar, false);
  assert.equal(s.escaneres, true);
});

test('ajustes: si la base falla a mitad de la transacción se hace ROLLBACK y no queda nada aplicado', async () => {
  const consultas = [];
  let liberado = false;
  const { llamar, guard } = armar({
    connect: async () => ({
      async query(q) { consultas.push(q); if (/INSERT INTO pbxng_settings/.test(q)) throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); return { rows: [] }; },
      release() { liberado = true; },
    }),
  });
  const r = await llamar('PUT /api/security/settings', { body: { max_fallos: 7 } });
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.json.error, /deadlock/, 'el error de Postgres llega traducido');
  assert.ok(consultas.includes('ROLLBACK'));
  assert.ok(liberado, 'la conexión vuelve al pool');
  assert.equal(guard.settings().max_fallos, 5, 'en memoria siguen los ajustes anteriores');
  // ROLLBACK que también falla: se traga y el error que llega es el original.
  const { llamar: ll2 } = armar({
    connect: async () => ({ async query() { throw new Error('Connection terminated'); }, release() {} }),
  });
  assert.equal((await ll2('PUT /api/security/settings', { body: {} })).status, 503);
});

test('ajustes: bool como texto y sin cuerpo', async () => {
  const { llamar } = armar();
  const r = await llamar('PUT /api/security/settings', { body: { alertar: '0', escaneres: 'true', ban_s: 0 }, user: { username: 'ana' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.alertar, false);
  assert.equal(r.json.escaneres, true);
  assert.equal(r.json.ban_s, 0, '0 = permanente es válido');
  assert.equal((await llamar('PUT /api/security/settings', {})).status, 200);
});

/* ── Firewall ─────────────────────────────────────────────────────────────*/

test('sync con el firewall: respuesta sin `enabled` consulta /bans; errores con y sin JSON', async () => {
  let modo = 'sinEnabled';
  const { guard, fwPedidos } = armar({
    fw: (m, ruta) => {
      if (modo === 'sinEnabled') return ruta === '/fw/sync' ? respuesta({ cuerpo: { ok: true } }) : respuesta({ cuerpo: { enabled: false, error: 'tabla inet ausente' } });
      if (modo === 'nulo') return ruta === '/fw/sync' ? respuesta({ sinJson: true }) : respuesta({ sinJson: true });
      if (modo === '503motivo') return respuesta({ ok: false, status: 503, cuerpo: { motivo: 'sin nft' } });
      if (modo === '500sinJson') return respuesta({ ok: false, status: 500, sinJson: true });
      return respuesta();
    },
  });
  let e = await guard.sincronizarFw();
  assert.deepEqual(fwPedidos.map((p) => p.ruta), ['/fw/sync', '/fw/bans']);
  assert.equal(e.nft, false);
  assert.equal(e.motivo, 'tabla inet ausente');
  modo = 'nulo';
  e = await guard.sincronizarFw();
  assert.equal(e.agente, true);
  assert.match(e.motivo, /nftables no disponible/, 'sin JSON se asume que no hay nft');
  modo = '503motivo';
  e = await guard.sincronizarFw();
  assert.deepEqual([e.agente, e.nft, e.motivo], [true, false, 'sin nft']);
  modo = '500sinJson';
  e = await guard.sincronizarFw();
  assert.equal(e.agente, false);
  assert.match(e.motivo, /el agente respondió 500/);
});

test('sync: un ban temporal viaja con los segundos que le quedan, uno permanente con 0', async () => {
  const { guard, fwPedidos } = armar({
    q: (s) => (/FROM pbxng_blocked$/.test(s) || /AS exp FROM pbxng_blocked/.test(s)
      ? { rows: [{ ip: '203.0.113.1', permanent: false, exp: Date.now() + 120000 }, { ip: '203.0.113.2', permanent: true, exp: null }, { ip: '203.0.113.3', permanent: false, exp: Date.now() - 5000 }] }
      : undefined),
  });
  await guard._cargar.bloqueadas();
  await guard.sincronizarFw();
  const bans = fwPedidos[0].body.bans;
  const s1 = bans.find((b) => b.ip === '203.0.113.1').seconds;
  assert.ok(s1 >= 119 && s1 <= 120, String(s1));
  assert.equal(bans.find((b) => b.ip === '203.0.113.2').seconds, 0);
  assert.equal(bans.find((b) => b.ip === '203.0.113.3').seconds, 1, 'uno vencido que todavía no se podó dura 1 s, no 0 (0 sería permanente)');
});

/* ── Bloquear / desbloquear ──────────────────────────────────────────────*/

test('banear: automático sobre privada o lista blanca no hace nada; a mano explica por qué', async () => {
  const { guard, fwPedidos } = armar({ q: (s) => (/FROM pbxng_f2b_whitelist/.test(s) ? { rows: [{ ip: '198.51.100.0/24' }, { ip: null }, { ip: '  ' }] } : undefined) });
  await guard._cargar.whitelist();
  await assert.rejects(guard.banear('x'), /IP inválida/);
  assert.equal(await guard.banear('10.1.1.1'), null);
  assert.equal(await guard.banear('198.51.100.7'), null);
  await assert.rejects(guard.banear('198.51.100.7', { manual: true }), (e) => e.status === 409);
  assert.equal(fwPedidos.length, 0);
});

test('banear: un 400 del agente no baja el estado del firewall; sin respuesta sí; el correo que falla no rompe', async () => {
  let fwModo = 'ok';
  const { guard, correos } = armar({
    alertaFalla: true,
    geoLookup: async () => ({}),   // ip-api sin datos: el ban sale igual, sin país
    fw: (m, ruta) => {
      if (ruta === '/fw/ban' && fwModo === '400') return respuesta({ ok: false, status: 400, cuerpo: { error: 'IP rechazada' } });
      if (ruta === '/fw/ban' && fwModo === 'caido') throw new Error('ECONNREFUSED');
      return respuesta();
    },
  });
  await guard.sincronizarFw();
  assert.equal(guard.enforcement().nft, true);
  fwModo = '400';
  const f = await guard.banear('203.0.113.50', { manual: true, permanent: false });
  assert.equal(f.permanent, false);
  assert.equal(guard.enforcement().nft, true, 'un pedido rechazado no dice nada del firewall');
  fwModo = 'caido';
  await guard.banear('203.0.113.51', { manual: true, permanent: true });
  assert.equal(guard.enforcement().agente, false);
  assert.match(guard.enforcement().motivo, /sin respuesta del agente/);
  await tandas();
  assert.equal(correos.length, 2);
  assert.ok(correos[0].d.lines.some(([k, v]) => k === 'País' && v === '—'));
  assert.match(correos[1].d.foot, /ATENCIÓN/);
  const ev = guard.recientes().filter((e) => e.tipo === 'ban');
  assert.ok(ev.every((e) => !/ · Testlandia/.test(e.texto)), 'sin país no se agrega el sufijo');
});

test('banear sin alertas configuradas, y la geo que falla deja el país en blanco', async () => {
  const { guard, correos } = armar({ sinAlerts: true, geoLookup: async () => { throw new Error('ip-api 429'); } });
  const f = await guard.banear('203.0.113.60');
  assert.equal(f.reason, 'fuerza bruta SIP');
  assert.equal(correos.length, 0);
});

test('desbloquear: IP inválida, el agente caído no impide soltarla y sin fila no se publica', async () => {
  let filas = 1;
  const { guard } = armar({
    q: (s) => (/DELETE FROM pbxng_blocked WHERE ip=\$1/.test(s) ? { rows: [], rowCount: filas } : undefined),
    fw: () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(guard.desbloquear(''), /IP inválida/);
  assert.equal(await guard.desbloquear('203.0.113.70'), true);
  assert.ok(guard.recientes().some((e) => e.texto === 'desbloqueada · manual'));
  filas = 0;
  const n = guard.recientes().length;
  assert.equal(await guard.desbloquear('203.0.113.71', 'otra'), false);
  assert.equal(guard.recientes().length, n);
});

test('expirar: el unban que falla en el agente no frena el resto', async () => {
  const { guard } = armar({
    q: (s) => (/expires_at < now\(\) RETURNING ip/.test(s) ? { rows: [{ ip: '203.0.113.80' }, { ip: '203.0.113.81' }] } : undefined),
    fw: () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(await guard.expirar(), 2);
  assert.equal(guard.recientes().filter((e) => /bloqueo vencido/.test(e.texto)).length, 2);
});

/* ── Clasificación y procesar ────────────────────────────────────────────*/

test('enumeración de cuentas: tres inexistentes distintas en la ventana es un escáner', async () => {
  const { guard } = armar();
  const r = [];
  for (const c of ['100', '101', '102']) r.push(await guard.procesar({ SecurityEvent: 'InvalidAccountID', RemoteAddress: 'IPV4/UDP/203.0.113.90/5060', AccountID: c }));
  assert.equal(r[1].tipo, 'cuenta');
  assert.equal(r[2].tipo, 'escaner');
  assert.equal(r[2].banear, true);
  assert.match(r[2].texto, /enumeración de cuentas \(3 distintas\)/);
  assert.ok(guard.recientes().some((e) => e.tipo === 'ban' && e.ip === '203.0.113.90'));
});

test('enumeración con escáneres apagados: se marca pero no banea; cuentas viejas se olvidan', () => {
  const { guard } = armar();
  const st = { fallos: [], cuentas: new Map([['viejo', Date.now() - 3600000]]), bans: [] };
  const s = { ...initGuard.DEFAULTS, escaneres: false, max_fallos: 99 };
  guard.clasificar('InvalidAccountID', { estado: st, cuenta: 'a', settings: s });
  assert.equal(st.cuentas.has('viejo'), false, 'una cuenta de fuera de la ventana no suma');
  guard.clasificar('InvalidAccountID', { estado: st, cuenta: 'b', settings: s });
  const r = guard.clasificar('InvalidAccountID', { estado: st, cuenta: 'c', settings: s });
  assert.equal(r.tipo, 'escaner');
  assert.equal(r.banear, false);
  // Sin cuenta no se enumera nada; sin settings en el contexto se usan los vigentes.
  const st2 = { fallos: [], cuentas: new Map(), bans: [] };
  const r2 = guard.clasificar('InvalidAccountID', { estado: st2 });
  assert.equal(r2.tipo, 'cuenta');
  assert.equal(guard.clasificar('NoExiste', { estado: st2 }), null);
});

test('procesar: eventos ajenos, dirección ilegible y el nombre en cualquiera de sus claves', async () => {
  const { guard } = armar();
  assert.equal(await guard.procesar({ event: 'PeerStatus' }), null);
  assert.equal(await guard.procesar({}), null);
  assert.equal(await guard.procesar({ Event: 'InvalidPassword', remoteaddress: 'IPV4/UDP/no/1' }), null);
  const r = await guard.procesar({ Event: 'InvalidPassword', remoteaddress: '203.0.113.91' });
  assert.equal(r.tipo, 'auth');
  const ev = guard.recientes().at(-1);
  assert.equal(ev.cuenta, null);
  assert.doesNotMatch(ev.texto, / · cuenta /, 'sin cuenta no se agrega el sufijo');
});

test('lista blanca: el fallo se ve pero no cuenta; el login correcto se ve como info', async () => {
  const { guard } = armar({ q: (s) => (/FROM pbxng_f2b_whitelist/.test(s) ? { rows: [{ ip: '203.0.113.0/24' }] } : undefined) });
  await guard._cargar.whitelist();
  for (let i = 0; i < 8; i++) await guard.procesar({ event: 'InvalidPassword', remoteaddress: 'IPV4/UDP/203.0.113.5/5060', accountid: '1001' });
  const ok = await guard.procesar({ event: 'SuccessfulAuth', remoteaddress: 'IPV4/UDP/203.0.113.5/5060' });
  assert.deepEqual(ok, { tipo: 'ok', whitelist: true });
  const evs = guard.recientes();
  assert.ok(evs.every((e) => e.tipo !== 'ban'), 'la lista blanca nunca se banea');
  assert.equal(evs.at(-1).sev, 'info');
  assert.equal(evs[0].sev, 'warn');
  assert.match(evs[0].texto, /\(lista blanca, no cuenta\) · Testlandia/);
});

test('geo-bloqueo en modo permitir: fuera de la lista se banea, sin país no se decide', async () => {
  const paises = { '203.0.113.20': { country: 'Uruguay', cc: 'UY' }, '203.0.113.21': { country: 'Rusia', cc: 'RU' }, '203.0.113.22': { country: null, cc: null } };
  const { guard } = armar({
    geoLookup: async (ips) => Object.fromEntries(ips.map((ip) => [ip, paises[ip]])),
    q: (s) => {
      if (/SELECT cc FROM pbxng_geoblock/.test(s)) return { rows: [{ cc: 'uy' }, { cc: null }] };
      if (/key='sec_geoblock_modo'/.test(s)) return { rows: [{ value: 'permitir' }] };
      return undefined;
    },
  });
  await guard._cargar.geoblock();
  assert.equal((await guard.procesar({ event: 'SuccessfulAuth', remoteaddress: '203.0.113.20' })).tipo, 'ok');
  assert.equal((await guard.procesar({ event: 'SuccessfulAuth', remoteaddress: '203.0.113.21' })).tipo, 'geo');
  assert.equal((await guard.procesar({ event: 'SuccessfulAuth', remoteaddress: '203.0.113.22' })).tipo, 'ok', 'ip-api sin datos no deja afuera a nadie');
  assert.ok(guard.recientes().some((e) => e.tipo === 'geo' && /país vetado: Rusia/.test(e.texto)));
});

test('geo-bloqueo con modo permitir y lista vacía no veta a nadie', async () => {
  const { guard } = armar({ q: (s) => (/key='sec_geoblock_modo'/.test(s) ? { rows: [{ value: 'permitir' }] } : undefined) });
  await guard._cargar.geoblock();
  assert.equal((await guard.procesar({ event: 'SuccessfulAuth', remoteaddress: '203.0.113.23' })).tipo, 'ok');
});

test('publicar: los login correctos de la LAN no ensucian el buffer; el socket roto no corta', async () => {
  const { guard, emitidos } = armar();
  await guard.procesar({ event: 'SuccessfulAuth', remoteaddress: 'IPV4/UDP/192.168.1.10/5060' });
  assert.equal(guard.recientes().length, 0);
  await guard.procesar({ event: 'InvalidPassword', remoteaddress: 'IPV4/UDP/192.168.1.10/5060', accountid: '1001' });
  assert.match(guard.recientes()[0].texto, / · red local$/);
  assert.equal(emitidos[0].sala, 'security');
  const roto = armar({ ioRoto: true });
  await roto.guard.procesar({ event: 'InvalidPassword', remoteaddress: '203.0.113.30' });
  assert.equal(roto.guard.recientes().length, 1);
});

test('publicar: el buffer en vivo se queda con los últimos 200', async () => {
  const { guard } = armar({ settings: { sec_max_fallos: '100000' } });
  await guard._cargar.settings();
  for (let i = 0; i < 205; i++) await guard.procesar({ event: 'RequestBadFormat', remoteaddress: '203.0.113.31' });
  assert.equal(guard.recientes().length, 200);
});

test('web(): IPv6, IP inválida y un error adentro no se propaga', async () => {
  const { guard } = armar();
  const r = await guard.web('2a02:1234::9', 'sala:xyz');
  assert.equal(r.tipo, 'escaner');
  assert.equal(guard.recientes().at(-1).ip, '2a02:1234::9');
  assert.equal(await guard.web(null), null);
  const roto = armar({ geoLookup: async () => ({}), q: (s) => (/INSERT INTO pbxng_blocked/.test(s) ? new Error('base caída') : undefined), settings: { sec_max_fallos: '1' } });
  await roto.guard._cargar.settings();
  assert.equal(await roto.guard.web('203.0.113.32', null), null, 'si banear tira, web() devuelve null');
});

/* ── Socket ───────────────────────────────────────────────────────────────*/

test('sala security: sólo admin y supervisor, nunca un token de teléfono', () => {
  const { guard } = armar();
  const sock = (user) => ({ user, salas: [], emitidos: [], join(s) { this.salas.push(s); }, emit(e, d) { this.emitidos.push([e, d]); } });
  assert.equal(guard.unirSocket(null), false);
  assert.equal(guard.unirSocket(sock(undefined)), false);
  assert.equal(guard.unirSocket(sock({ role: 'admin', scope: 'phone' })), false);
  assert.equal(guard.unirSocket(sock({ role: 'agente' })), false);
  const s = sock({ role: 'supervisor' });
  assert.equal(guard.unirSocket(s), true);
  assert.deepEqual(s.salas, ['security']);
  assert.equal(s.emitidos[0][0], 'sec:hist');
});

/* ── Resumen ──────────────────────────────────────────────────────────────*/

test('resumen: bloqueos sin país, tabla de geo-bloqueo ausente y KPIs vacíos', async () => {
  const { guard } = armar({
    q: (s) => {
      if (/FROM pbxng_blocked ORDER BY blocked_at/.test(s)) return { rows: [
        { ip: '203.0.113.1', cc: null, country: null, hits: null, permanent: true },
        { ip: '203.0.113.2', cc: 'UY', country: 'Uruguay', hits: 4, permanent: false },
        { ip: '203.0.113.3', cc: 'UY', country: 'Uruguay', hits: 2, permanent: false },
      ] };
      if (/FROM pbxng_geoblock ORDER BY nombre/.test(s)) return new Error('relation "pbxng_geoblock" does not exist');
      if (/key='sec_geoblock_modo'/.test(s)) return new Error('relation "pbxng_settings" does not exist');
      return undefined;
    },
  });
  const r = await guard.resumen();
  assert.equal(r.kpis.bloqueados, 3);
  assert.equal(r.kpis.permanentes, 1);
  assert.equal(r.kpis.ultimas_24h, 0);
  assert.equal(r.kpis.fallos_24h, 0);
  assert.equal(r.bloqueos[0].flag, '');
  assert.equal(r.bloqueos[0].cc, null);
  assert.deepEqual(r.top_paises.map((p) => [p.pais, p.n]), [['Uruguay', 2], ['Desconocido', 1]]);
  assert.deepEqual(r.top_atacantes.map((b) => b.ip), ['203.0.113.2', '203.0.113.3', '203.0.113.1']);
  assert.deepEqual(r.geoblock, { modo: 'bloquear', paises: [] });
});

/* ── Rutas: errores de la base y bordes de validación ────────────────────*/

test('rutas: con la base caída cada una contesta un error traducido, nunca el de Postgres', async () => {
  const caida = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED', syscall: 'connect', port: 5432 });
  const { llamar } = armar({ q: () => caida(), connect: async () => { throw caida(); } });
  for (const [ruta, o] of [
    ['GET /api/security', {}],
    ['GET /api/security/settings', {}],
    ['POST /api/security/apply', {}],
    ['GET /api/security/whitelist', {}],
    ['POST /api/security/whitelist', { body: { ip: '203.0.113.1' } }],
    ['DELETE /api/security/whitelist', { query: { ip: '203.0.113.1' } }],
    ['GET /api/security/geoblock', {}],
    ['PUT /api/security/geoblock', { body: { paises: ['UY'] } }],
    ['POST /api/security/geoblock/add', { body: { cc: 'UY' } }],
    ['POST /api/security/geoblock/apply', {}],
    ['POST /api/security/block', { body: { ip: '203.0.113.1' } }],
    ['POST /api/security/unblock', { body: { ip: '203.0.113.1' } }],
  ]) {
    const r = await llamar(ruta, o);
    assert.equal(r.status, 503, ruta + ' → ' + r.status);
    assert.doesNotMatch(r.json.error, /ECONNREFUSED|5432/, ruta);
  }
});

test('rutas: block/unblock sin cuerpo, block temporal con motivo y el usuario que lo hizo', async () => {
  const { llamar, sql } = armar();
  assert.equal((await llamar('POST /api/security/block', {})).status, 400);
  assert.equal((await llamar('POST /api/security/unblock', {})).status, 400);
  const r = await llamar('POST /api/security/block', { body: { ip: '203.0.113.40', permanent: 0, reason: 'x'.repeat(200) }, user: { username: 'ana' } });
  assert.deepEqual(r.json, { ok: true, ip: '203.0.113.40', permanent: false });
  const ins = sql.find((x) => /INSERT INTO pbxng_sec_events/.test(x.q) && x.args[0] === 'bloqueo');
  const det = JSON.parse(ins.args[2]);
  assert.equal(det.por, 'ana');
  assert.equal(det.motivo.length, 120, 'el motivo se acota');
  const u = await llamar('POST /api/security/unblock', { body: { ip: '203.0.113.40' }, user: { username: 'ana' } });
  assert.equal(u.json.habia, true);
  // Bloqueo a mano de una ya bloqueada: vuelve a pasar (sube hits), no se ignora.
  await llamar('POST /api/security/block', { body: { ip: '203.0.113.41' } });
  const r2 = await llamar('POST /api/security/block', { body: { ip: '203.0.113.41' } });
  assert.equal(r2.json.permanent, true);
});

test('rutas: lista blanca con CIDR v6 inválido, nota vacía, y quitar por params o sin IP', async () => {
  const { llamar, sql } = armar();
  assert.equal((await llamar('POST /api/security/whitelist', {})).status, 400);
  assert.equal((await llamar('POST /api/security/whitelist', { body: { ip: '2001:db8::/129' } })).status, 400);
  const ok = await llamar('POST /api/security/whitelist', { body: { ip: '2001:db8::/48' } });
  assert.equal(ok.json.ip, '2001:db8::/48');
  assert.equal(sql.find((x) => /INSERT INTO pbxng_f2b_whitelist/.test(x.q)).args[1], null);
  assert.equal((await llamar('DELETE /api/security/whitelist/:ip', { params: { ip: '2001:db8::/48' } })).json.ip, '2001:db8::/48');
  assert.equal((await llamar('POST /api/security/whitelist/remove', { body: { ip: ' 1.2.3.4 ' } })).json.ip, '1.2.3.4');
  assert.equal((await llamar('DELETE /api/security/whitelist', {})).status, 400);
});

test('rutas: geo-bloqueo sin cuerpo, rollback si falla a mitad, alta con nombre por defecto', async () => {
  const consultas = [];
  let falla = false;
  const { llamar, sql } = armar({
    connect: async () => ({
      async query(q) { consultas.push(q); if (falla && /INSERT INTO pbxng_geoblock/.test(q)) throw new Error('violates check constraint'); if (falla && q === 'ROLLBACK') throw new Error('sin conexión'); return { rows: [] }; },
      release() {},
    }),
  });
  const vacio = await llamar('PUT /api/security/geoblock', {});
  assert.deepEqual([vacio.json.total, vacio.json.modo], [0, 'bloquear']);
  falla = true;
  const r = await llamar('PUT /api/security/geoblock', { body: { paises: [null, { cc: 'ar' }] } });
  assert.equal(r.status, 500);
  assert.ok(consultas.includes('ROLLBACK'));
  assert.equal((await llamar('POST /api/security/geoblock/add', {})).status, 400);
  await llamar('POST /api/security/geoblock/add', { body: { cc: 'kp' } });
  const ins = sql.find((x) => /INSERT INTO pbxng_geoblock/.test(x.q));
  assert.deepEqual(ins.args, ['KP', 'KP'], 'sin nombre, el país se nombra por su código');
});

test('geo-bloqueo aplicado: ip-api caído no banea a nadie; lista blanca y privadas quedan afuera', async () => {
  const pedidas = [];
  const { guard } = armar({
    geoLookup: async (ips) => { pedidas.push(...ips); throw new Error('ip-api caído'); },
    q: (s) => {
      if (/SELECT cc FROM pbxng_geoblock/.test(s)) return { rows: [{ cc: 'RU' }] };
      if (/SELECT DISTINCT ip/.test(s)) return { rows: [{ ip: '203.0.113.1' }, { ip: '10.0.0.1' }, { ip: 'basura' }, { ip: '198.51.100.9' }] };
      if (/FROM pbxng_f2b_whitelist/.test(s)) return { rows: [{ ip: '198.51.100.9' }] };
      return undefined;
    },
  });
  await guard._cargar.whitelist();
  const r = await guard.aplicarGeoblock();
  assert.deepEqual(pedidas, ['203.0.113.1']);
  assert.equal(r.bloqueadas, 0);
});

test('rutas: /api/ipgeo con geo caída devuelve error y la vista en vivo el historial', async () => {
  const { llamar, guard } = armar({ geoLookup: async () => { throw new Error('ip-api caído'); } });
  assert.equal((await llamar('GET /api/ipgeo', { query: { ips: '203.0.113.1' } })).status, 500);
  await guard.procesar({ event: 'InvalidPassword', remoteaddress: '203.0.113.2' });
  assert.equal((await llamar('GET /api/security/live')).json.length, 1);
});

/* ── Arranque y relojes ───────────────────────────────────────────────────*/

test('arranque con la base caída: avisa y sigue con los defaults', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { guard, errores } = armar({ sinApp: true, sinAmi: true, q: () => new Error('base caída'), escribir: () => { throw new Error('disco lleno'); } });
  try { await guard.iniciar(); } finally { guard.detener(); }
  assert.ok(errores.some((e) => /estado inicial/.test(e[1])));
  assert.ok(errores.some((e) => /pjsip-security.conf/.test(e[1])), 'si no se puede escribir el archivo, avisa y sigue');
  assert.equal(guard.settings().max_fallos, 5);
});

test('relojes: vuelco de fallos, golpes, vencimientos, sync, ataque, recarga, poda y olvido', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
  let hitsFalla = true;
  const { guard, sql, fwPedidos, correos, ami, errores } = armar({
    settings: { sec_max_fallos: '3' },
    alertaFalla: true,
    q: (s) => {
      if (/UPDATE pbxng_blocked SET hits/.test(s) && hitsFalla) return new Error('base lenta');
      if (/expires_at < now\(\) RETURNING ip/.test(s)) return new Error('base caída');
      return undefined;
    },
  });
  await guard.iniciar();
  t.after(() => guard.detener());

  // Un ataque: 13 IPs distintas con fallos, dos con cuenta, más una que sigue golpeando ya bloqueada.
  for (let i = 1; i <= 13; i++) ami.emit('managerevent', { event: 'InvalidPassword', remoteaddress: `IPV4/UDP/203.0.113.${100 + i}/5060`, accountid: i % 2 ? '1001' : '' });
  ami.emit('managerevent', { event: 'SessionLimit', remoteaddress: 'IPV4/UDP/203.0.113.101/5060' });
  ami.emit('managerevent', { event: 'NoEsDeSeguridad' });
  ami.emit('managerevent', null);
  await tandas(10);
  await guard.banear('203.0.113.200', { manual: true });
  await guard.procesar({ event: 'InvalidPassword', remoteaddress: '203.0.113.200' });

  // 10 s: vigilar ataque (umbral 12) → evento 'ataque' + correo (que falla sin romper).
  t.mock.timers.tick(10000);
  await tandas(10);
  assert.ok(sql.some((x) => /INSERT INTO pbxng_sec_events/.test(x.q) && x.args[0] === 'ataque'));
  assert.ok(correos.some((c) => c.k === 'security.attack'));
  const ataques = () => sql.filter((x) => /INSERT INTO pbxng_sec_events/.test(x.q) && x.args[0] === 'ataque').length;
  t.mock.timers.tick(10000);
  await tandas(10);
  assert.equal(ataques(), 1, 'un aviso cada 10 minutos, no uno por vuelta');

  // 15 s: vuelco de fallos agregados por IP y de golpes a bloqueadas (el UPDATE que falla se traga).
  t.mock.timers.tick(10000);
  await tandas(20);
  const fallos = sql.filter((x) => /INSERT INTO pbxng_sec_events/.test(x.q) && x.args[0] === 'fallo').map((x) => JSON.parse(x.args[2]));
  assert.ok(fallos.length >= 13);
  const f101 = fallos.find((f) => f.ip === '203.0.113.101');
  assert.equal(f101.n, 2);
  assert.deepEqual(f101.tipos, { auth: 1, flood: 1 });
  assert.deepEqual(f101.cuentas, ['1001']);
  assert.ok(sql.some((x) => /UPDATE pbxng_blocked SET hits/.test(x.q)));
  hitsFalla = false;

  // 60 s: vencimientos (la base caída queda en el log) y recarga de listas.
  const antes = sql.filter((x) => /SELECT ip FROM pbxng_f2b_whitelist/.test(x.q)).length;
  t.mock.timers.tick(30000);
  await tandas(10);
  assert.ok(errores.some((e) => e[1] === 'expirando bloqueos'));
  assert.ok(sql.filter((x) => /SELECT ip FROM pbxng_f2b_whitelist/.test(x.q)).length > antes);

  // 5 min: sync con el firewall. 10 min: se olvida a quien no golpea; 6 h: poda de eventos.
  t.mock.timers.tick(300000);
  await tandas(10);
  assert.ok(fwPedidos.filter((p) => p.ruta === '/fw/sync').length >= 2, 'el sync inicial (8 s) y el periódico');
  t.mock.timers.tick(25 * 3600000);
  await tandas(10);
  assert.ok(sql.some((x) => /DELETE FROM pbxng_sec_events WHERE \(kind='fallo'/.test(x.q)));
  // Después del olvido, la misma IP arranca el contador de cero: dos fallos no banean (max 3).
  const bansAntes = fwPedidos.filter((p) => p.ruta === '/fw/ban').length;
  await guard.procesar({ event: 'InvalidPassword', remoteaddress: '203.0.113.102' });
  await guard.procesar({ event: 'InvalidPassword', remoteaddress: '203.0.113.102' });
  assert.equal(fwPedidos.filter((p) => p.ruta === '/fw/ban').length, bansAntes);
});

test('relojes: los fallos de los relojes quedan en el log, nunca como promesa rechazada suelta', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
  let romper = false;
  const { guard, errores, ami } = armar({
    sinAlerts: true,
    settings: { sec_alertar: '1' },
    q: (s) => (romper && /INSERT INTO pbxng_sec_events|SELECT ip FROM pbxng_f2b_whitelist|DELETE FROM pbxng_sec_events/.test(s) ? new Error('base caída') : undefined),
    fw: () => { throw new Error('ECONNREFUSED'); },
  });
  await guard.iniciar();
  t.after(() => guard.detener());
  for (let i = 0; i < 13; i++) ami.emit('managerevent', { event: 'RequestBadFormat', remoteaddress: 'IPV4/UDP/203.0.113.150/5060' });
  await tandas(10);
  romper = true;
  t.mock.timers.tick(6 * 3600000);
  await tandas(20);
  // evento() se traga sus propios errores (warn), así que vigilar y volcar no llegan a tirar.
  assert.ok(errores.some((e) => e[0] === 'warn' && /no se pudo guardar el evento/.test(e[1])));
  assert.equal(guard.enforcement().agente, false);
});
