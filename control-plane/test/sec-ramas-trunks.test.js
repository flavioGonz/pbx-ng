/* ============================================================================
 *  Troncales y rutas (trunks.js) con dependencias falsas: sin Postgres, sin Asterisk.
 *
 *  trunks.test.js / trunks-extra.test.js / sbc-link.test.js prueban el camino feliz
 *  contra una base real. Acá se fijan los bordes que, si se rompen, dejan a la central
 *  SIN SALIDA o con dialplan a medias, y que con una base real son difíciles de provocar:
 *
 *   - la base que se cae a mitad de una transacción: ROLLBACK, conexión devuelta y error
 *     traducido, en TODAS las rutas que escriben (troncales, rutas, enlace SBC);
 *   - el sondeo de estado con AMI/ARI ausentes: la pantalla puede ver rojo, pero el
 *     failover NO puede apagar troncales con un sondeo que no sirvió (`_sondeoFiable`);
 *   - el sondeo OPTIONS UDP de las troncales vía SBC (responde / no resuelve / cache);
 *   - la validación de rutas salientes (respaldos repetidos, de WebRTC, demasiados, sin
 *     troncal posible) y entrantes con horario (rama abierta/cerrada y su fallback);
 *   - la lectura de «qué troncal está cursando» desde la AstDB y la marca `trunkup/`.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const initTrunks = require('../trunks');

const tandas = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/* Todo falso. `q(sql, args, enTx)` intercepta consultas (undefined = default vacío; un
 * Error se tira). `enTx` dice si viene de un cliente de transacción o del pool. */
function armar(o = {}) {
  const rutas = {};
  const reg = (m) => (p, h) => { rutas[m + ' ' + p] = h; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  const sql = [];
  const liberados = { n: 0 };
  const correr = async (q, args, enTx) => {
    const s = String(q).replace(/\s+/g, ' ').trim();
    sql.push({ q: s, args, enTx });
    if (o.q) { const r = await o.q(s, args, enTx); if (r !== undefined) { if (r instanceof Error) throw r; return r; } }
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query: (q, a) => correr(q, a, false),
    async connect() {
      if (o.connectFalla) throw Object.assign(new Error('timeout exceeded when trying to connect'), {});
      return { query: (q, a) => correr(q, a, true), release() { liberados.n++; } };
    },
  };
  const dialplan = [];
  const ami = [];
  const errores = [];
  const logger = () => ({ debug() {}, info() {}, warn() {}, error(...a) { errores.push(a); } });
  const errorHttp = require('../errores').errorHttp;
  let broadcasts = 0;
  const trk = initTrunks({
    app, pool, NODES: o.NODES || { domain: 'pbx.ejemplo' },
    amiCommand: o.amiCommand || (async () => ''),
    amiAction: o.amiAction || (async (a) => { ami.push(a); return {}; }),
    endpointStates: o.endpointStates || (async () => ({})),
    moduleEnabled: o.moduleEnabled || (async () => false),
    setDialplan: async (c, ctx, exten, rows) => { dialplan.push({ ctx, exten, rows }); },
    astFwd: o.astFwd || (async () => ({ ok: true })),
    salud: o.salud || { probarPuerto: async () => ({ vivo: true, ms: 3 }) },
    diagtrunk: o.diagtrunk || { diagnosticar: async (b) => ({ ok: true, b }) },
    errorHttp, broadcastSoon: () => { broadcasts++; }, logger,
  });
  const llamar = async (ruta, { body, params = {}, query = {} } = {}) => {
    const r = { status: 200, json: undefined };
    const res = { status(s) { r.status = s; return this; }, json(j) { r.json = j; return this; } };
    await rutas[ruta]({ body, params, query }, res);
    return r;
  };
  return { trk, rutas, llamar, sql, dialplan, ami, errores, liberados, broadcasts: () => broadcasts };
}

const pgCaida = () => Object.assign(new Error('Connection terminated unexpectedly'), {});

/* ── Enlace SBC ───────────────────────────────────────────────────────────*/

test('sbcLink: con la base caída devuelve «sin SBC» en vez de tirar; se puede invalidar el cache', async () => {
  let rompe = true;
  const { trk } = armar({
    moduleEnabled: async () => { if (rompe) throw new Error('base caída'); return true; },
    q: (s) => {
      if (/FROM pbxng_trunks WHERE kind='sbc'/.test(s)) return { rows: [{ name: 'to-sbc', provider_host: null, provider_port: null, adv_config: null }] };
      return undefined;
    },
  });
  const a = await trk.sbcLink();
  assert.deepEqual([a.enabled, a.configured, a.active], [false, false, false]);
  rompe = false;
  assert.equal((await trk.sbcLink()).active, false, 'dentro de los 5 s se sirve del cache');
  trk.invalidarSbcLink();
  const b = await trk.sbcLink();
  assert.equal(b.active, true);
  assert.deepEqual([b.host, b.port, b.transport, b.context, b.panel_url], ['', 5060, 'udp', 'from-trunk', '']);
  assert.deepEqual(b.codecs, ['ulaw', 'alaw', 'g722'], 'sin codecs propios quedan los de fábrica');
});

test('upsertSbcLink: puerto por defecto, URL del panel, sin ruta semilla si se pide, y el reload que falla no rompe', async () => {
  const { trk, sql } = armar({
    astFwd: async () => { throw new Error('agente caído'); },
    q: (s) => (/SELECT count\(\*\)::int AS n FROM pbxng_outbound_routes$/.test(s) ? { rows: [] } : undefined),
  });
  await assert.rejects(trk.upsertSbcLink({ host: '  ' }), (e) => e.status === 400);
  const r = await trk.upsertSbcLink({ host: '10.0.0.5', transport: 'tls', panel_url: null, codecs: ['alaw'], create_route: false });
  assert.equal(r.ruta, null);
  const aor = sql.find((x) => /INSERT INTO ps_aors/.test(x.q));
  assert.equal(aor.args[1], 'sip:10.0.0.5:5060;transport=tls');
  assert.deepEqual(sql.find((x) => /sbc_panel_url/.test(x.q)).args, ['']);
  assert.ok(!sql.some((x) => /count\(\*\)/.test(x.q)), 'create_route:false no mira las rutas');
  // Con create_route y la cuenta sin filas: se siembra la ruta «marca 0».
  const { trk: t2, dialplan } = armar({
    q: (s) => {
      if (/SELECT count\(\*\)::int AS n FROM pbxng_outbound_routes$/.test(s)) return { rows: [] };
      if (/INSERT INTO pbxng_outbound_routes/.test(s)) return { rows: [{ id: 9, pattern: '0X.', trunk: 'to-sbc', strip: 1 }] };
      return undefined;
    },
  });
  assert.equal((await t2.upsertSbcLink({ host: '10.0.0.5', port: '5070' })).ruta, '0X.');
  assert.equal(dialplan[0].exten, '_0X.');
});

test('upsertSbcLink: si falla a mitad hace ROLLBACK (aunque el ROLLBACK también falle) y libera', async () => {
  const { trk, sql, liberados } = armar({ q: (s) => (/INSERT INTO ps_endpoints/.test(s) || s === 'ROLLBACK' ? pgCaida() : undefined) });
  await assert.rejects(trk.upsertSbcLink({ host: '10.0.0.5' }), /Connection terminated/);
  assert.ok(sql.some((x) => x.q === 'ROLLBACK'));
  assert.equal(liberados.n, 1);
});

test('GET /api/sbc-link: medido con ms ausente, cuenta de rutas que falla y error al medir', async () => {
  let medir = async () => ({ vivo: false, motivo: undefined });
  const { llamar } = armar({
    moduleEnabled: async () => true,
    salud: { probarPuerto: (...a) => medir(...a) },
    q: (s) => {
      if (/FROM pbxng_trunks WHERE kind='sbc'/.test(s)) return { rows: [{ name: 'to-sbc', provider_host: '10.0.0.5', provider_port: 5080, adv_config: { transport: 'tcp', context: 'desde-sbc', codecs: ['g722'] } }] };
      if (/key='sbc_panel_url'/.test(s)) return { rows: [{ value: 'https://sbc' }] };
      if (/count\(\*\)::int AS n FROM pbxng_outbound_routes WHERE trunk/.test(s)) return pgCaida();
      return undefined;
    },
  });
  const r = await llamar('GET /api/sbc-link');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.estado, { vivo: false, ms: null, motivo: null });
  assert.equal(r.json.rutas_salientes, 0, 'si no se puede contar, 0 y no un error');
  assert.deepEqual([r.json.transport, r.json.context, r.json.codecs, r.json.panel_url], ['tcp', 'desde-sbc', ['g722'], 'https://sbc']);
  medir = async () => { throw new Error('socket roto'); };
  assert.equal((await llamar('GET /api/sbc-link')).status, 500);
});

test('GET /api/sbc-link: la cuenta vacía da 0 rutas', async () => {
  const { llamar } = armar({ q: (s) => (/WHERE trunk=\$1/.test(s) ? { rows: [] } : undefined) });
  const r = await llamar('GET /api/sbc-link');
  assert.equal(r.json.rutas_salientes, 0);
  assert.equal(r.json.estado, null, 'sin SBC configurado no se mide nada');
});

test('POST y DELETE /api/sbc-link: sin cuerpo, base caída, rollback y reload que falla', async () => {
  const { llamar } = armar();
  assert.equal((await llamar('POST /api/sbc-link', {})).status, 400);
  const caida = armar({ connectFalla: true });
  assert.equal((await caida.llamar('DELETE /api/sbc-link')).status, 503);
  const mitad = armar({ q: (s) => (/DELETE FROM pbxng_trunks WHERE kind/.test(s) ? pgCaida() : undefined) });
  assert.equal((await mitad.llamar('DELETE /api/sbc-link')).status, 503);
  assert.equal(mitad.liberados.n, 1);
  const sinAgente = armar({
    astFwd: async () => { throw new Error('agente caído'); },
    q: (s) => (/SELECT id, pattern FROM pbxng_outbound_routes WHERE trunk/.test(s) ? { rows: [{ id: 3, pattern: '_0X.' }] } : undefined),
  });
  const r = await sinAgente.llamar('DELETE /api/sbc-link');
  assert.deepEqual(r.json, { ok: true, rutas_borradas: 1 });
  assert.ok(sinAgente.sql.some((x) => /SELECT app, appdata FROM extensions/.test(x.q) && x.args[0] === '_0X.'), 'un patrón que ya trae _ no se le duplica');
});

/* ── Estado de troncales ─────────────────────────────────────────────────*/

test('estado: con AMI caído y sin contactos, nada se marca firme y el sondeo no es fiable', async () => {
  const { trk } = armar({ amiCommand: async () => { throw new Error('AMI caído'); } });
  const st = await trk.trunkStatuses([
    { name: 'antel', do_register: true },
    { name: 'ip1', do_register: false },
    { name: 'wc', kind: 'webrtc-client' },
  ]);
  assert.deepEqual(st.antel, { status: 'offline', detail: 'Sin registro' });
  assert.deepEqual(st.ip1, { status: 'offline', detail: 'No responde' });
  assert.match(st.wc.detail, /SBC-NG/);
  assert.equal(st.antel.firme, undefined);
});

test('estado: registro sin vencimiento visible y troncal registrable alcanzable sin línea', async () => {
  const { trk } = armar({
    endpointStates: async () => ({ claro: { state: 'online' } }),
    amiCommand: async (c) => (c === 'pjsip show registrations' ? ' antel/sip:x  antel  Registered\n' : '  Contact:  claro/sip:1.2.3.4  abc Avail  n/a\n'),
  });
  const st = await trk.trunkStatuses([{ name: 'antel', do_register: true }, { name: 'claro', do_register: true }]);
  assert.deepEqual(st.antel, { status: 'online', detail: 'Registrada' });
  assert.deepEqual(st.claro, { status: 'online', detail: 'Alcanzable' }, 'un RTT ilegible no se informa');
});

test('sondeo OPTIONS de troncales vía SBC: responde, no resuelve, y se cachea 15 s', async (t) => {
  const srv = dgram.createSocket('udp4');
  let recibidos = 0;
  srv.on('message', (m, rinfo) => { recibidos++; srv.send(Buffer.from('SIP/2.0 200 OK\r\n\r\n'), rinfo.port, rinfo.address); });
  await new Promise((r) => srv.bind(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const { trk } = armar();
  const tk = [
    { name: 'kam-ok', kind: 'kamailio', provider_host: '127.0.0.1', provider_port: srv.address().port },
    { name: 'kam-mal', kind: 'kamailio', provider_host: 'no-existe.invalid', provider_port: null },
  ];
  const st = await trk.trunkStatuses(tk);
  assert.equal(st['kam-ok'].status, 'online');
  assert.equal(st['kam-mal'].status, 'offline');
  assert.equal(st['kam-mal'].firme, true, 'un OPTIONS que no vuelve sí es evidencia de caída');
  await trk.trunkStatuses(tk);
  assert.equal(recibidos, 1, 'el segundo sondeo sale del cache');
});

/* ── Rutas salientes ─────────────────────────────────────────────────────*/

const conTroncales = (tk, extra) => (s, a, enTx) => {
  if (/SELECT name, COALESCE\(kind,'asterisk'\) AS kind FROM pbxng_trunks/.test(s)) return { rows: Object.entries(tk).map(([name, kind]) => ({ name, kind })) };
  return extra ? extra(s, a, enTx) : undefined;
};

test('filasSalida: respaldos que no son lista y tiempos ausentes toman los de fábrica', () => {
  const { trk } = armar();
  const simple = trk.filasSalida({ id: 1, trunk: 'a', backups: 'b', strip: 'x' });
  assert.deepEqual(simple.map((r) => r[1]), ['NoOp', 'Dial', 'Hangup']);
  const esc = trk.filasSalida({ id: 2, trunk: 'a', backups: ['b'], intento_seg: null, total_seg: undefined });
  assert.ok(esc.some((r) => r[1] === 'Set' && r[2] === 'TOPE=$[${EPOCH} + 45]'));
  assert.ok(esc.some((r) => r[1] === 'Dial' && /,20$/.test(r[2])));
});

test('rutas salientes: cada validación de la cadena de troncales tiene su 400', async () => {
  const { llamar } = armar({ q: conTroncales({ a: 'asterisk', b: 'asterisk', w: 'webrtc' }) });
  const post = (body) => llamar('POST /api/routes/outbound', { body });
  assert.equal((await post({})).status, 400);
  for (const [body, txt] of [
    [{ pattern: '0X.', trunk: 'a', prepend: 'abc' }, /antepone/],
    [{ pattern: '0X.', trunk: 'a', callerid: 'x' }, /CallerID/],
    [{ pattern: '0X.', trunk: 'a b' }, /troncal principal inválida/],
    [{ pattern: '0X.', trunk: 'zz' }, /no existe/],
    [{ pattern: '0X.', trunk: 'w' }, /cliente WebRTC/],
    [{ pattern: '0X.', trunk: 'a', backups: 'b, a' }, /repetida/],
    [{ pattern: '0X.', trunk: 'a', backups: ['b', 'c', 'd', 'e', 'f', 'g'] }, /como máximo 5/],
    [{ pattern: '0X;', trunk: 'a' }, /patrón inválido/],
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, txt);
  }
});

test('rutas salientes: sin ninguna troncal posible se explica qué hacer', async () => {
  const { llamar } = armar({ q: (s) => (/NOT IN \('webrtc'/.test(s) ? pgCaida() : undefined) });
  const r = await llamar('POST /api/routes/outbound', { body: { pattern: '0X.' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /No hay ninguna troncal/);
});

test('rutas salientes: alta con troncal por defecto, nulos que se vacían y tiempos acotados', async () => {
  const { llamar, sql } = armar({
    q: conTroncales({ a: 'asterisk', b: null }, (s, a) => {
      if (/NOT IN \('webrtc'/.test(s)) return { rows: [{ name: 'a' }] };
      if (/INSERT INTO pbxng_outbound_routes/.test(s)) return { rows: [{ id: 5, pattern: a[1], trunk: a[2], backups: JSON.parse(a[6]) }] };
      return undefined;
    }),
  });
  const r = await llamar('POST /api/routes/outbound', { body: { pattern: '_9X.', name: null, prepend: null, backups: '', strip: '50', intento_seg: '1', total_seg: '0' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.created, r.json.trunk, r.json.backups], ['9X.', 'a', []]);
  const ins = sql.find((x) => /INSERT INTO pbxng_outbound_routes/.test(x.q));
  assert.deepEqual(ins.args.slice(3, 9), [20, null, null, '[]', 5, 45], 'strip ≤ 20, intento ≥ 5; un total en 0 vuelve al de fábrica');
});

test('rutas salientes: PUT y DELETE con la base caída, inexistente y patrón que cambia', async () => {
  assert.equal((await armar({ connectFalla: true }).llamar('POST /api/routes/outbound', { body: { pattern: '0X.' } })).status, 503);
  assert.equal((await armar({ connectFalla: true }).llamar('PUT /api/routes/outbound/:id', { params: { id: '1' } })).status, 503);
  assert.equal((await armar({ connectFalla: true }).llamar('DELETE /api/routes/outbound/:id', { params: { id: '1' } })).status, 503);
  const { llamar } = armar({ q: (s) => (s === 'ROLLBACK' ? pgCaida() : undefined) });
  assert.equal((await llamar('PUT /api/routes/outbound/:id', { params: { id: '1' } })).status, 404, 'aunque el ROLLBACK falle');
  const del = await llamar('DELETE /api/routes/outbound/:id', { params: { id: '7' } });
  assert.deepEqual(del.json, { deleted: '7' });
  const viejo = { id: 4, name: 'Vieja', pattern: '0X.', trunk: 'a', strip: 1, prepend: null, callerid: null, backups: null, intento_seg: 20, total_seg: 45 };
  const ed = armar({
    q: conTroncales({ a: 'asterisk' }, (s, a) => {
      if (/FROM pbxng_outbound_routes WHERE id=\$1/.test(s)) return { rows: [viejo] };
      if (/UPDATE pbxng_outbound_routes SET name/.test(s)) return { rows: [{ ...viejo, pattern: a[2] }] };
      return undefined;
    }),
  });
  const r = await ed.llamar('PUT /api/routes/outbound/:id', { params: { id: '4' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!ed.sql.some((x) => /DELETE FROM extensions WHERE context='internal'/.test(x.q)), 'sin cambio de patrón no se borra nada');
  const r2 = await ed.llamar('PUT /api/routes/outbound/:id', { params: { id: '4' }, body: { pattern: '00X.' } });
  assert.equal(r2.status, 200);
  assert.equal(ed.dialplan.at(-1).exten, '_00X.');
  const fallo = armar({ q: conTroncales({ a: 'asterisk' }, (s) => (/FROM pbxng_outbound_routes WHERE id=\$1/.test(s) ? { rows: [viejo] } : /UPDATE pbxng_outbound_routes/.test(s) ? pgCaida() : undefined)) });
  assert.equal((await fallo.llamar('PUT /api/routes/outbound/:id', { params: { id: '4' }, body: {} })).status, 503);
  const fDel = armar({ q: (s) => (/DELETE FROM pbxng_outbound_routes/.test(s) ? pgCaida() : undefined) });
  assert.equal((await fDel.llamar('DELETE /api/routes/outbound/:id', { params: { id: '4' } })).status, 503);
  assert.equal((await armar({ q: () => pgCaida() }).llamar('GET /api/routes/outbound')).status, 503);
});

/* ── Failover ─────────────────────────────────────────────────────────────*/

test('failover: en uso según la AstDB, prevista sin estado y cache de 8 s', async () => {
  let lecturas = 0;
  const { trk, llamar } = armar({
    endpointStates: async () => { throw new Error('ARI caído'); },
    amiCommand: async (c) => {
      if (c === 'database show rutasal') { lecturas++; return '/rutasal/1     : b\nbasura\n/rutasal/2 : !sin-salida\n'; }
      return '';
    },
    q: (s) => {
      if (/FROM pbxng_outbound_routes ORDER BY id/.test(s)) return { rows: [
        { id: 1, name: 'r1', pattern: '0X.', trunk: 'a', backups: ['b'] },
        { id: 2, name: 'r2', pattern: '9X.', trunk: 'a', backups: ['c'] },
        { id: 3, name: 'r3', pattern: '8X.', trunk: 'a', backups: null },
      ] };
      if (/FROM pbxng_trunks ORDER BY id/.test(s)) return { rows: [] };
      return undefined;
    },
  });
  const f = await trk.failoverStates();
  assert.deepEqual([f[0].en_uso, f[0].en_respaldo, f[0].prevista], ['b', true, 'a']);
  assert.equal(f[0].cadena[0].estado, 'desconocido', 'si el sondeo tira, el estado es «desconocido», no un 500');
  assert.equal(f[1].sin_salida, true);
  assert.equal(f[1].en_uso, null);
  assert.deepEqual(f[2].backups, []);
  const r = await llamar('GET /api/routes/outbound/failover');
  assert.equal(r.json, f, 'dentro de los 8 s se sirve del cache');
  assert.equal(lecturas, 1);
});

test('failover: AstDB ilegible no rompe y sin rutas no se pregunta nada', async () => {
  const { trk, sql } = armar({ amiCommand: async () => { throw new Error('AMI caído'); } });
  assert.deepEqual(await trk.failoverStates(true), []);
  assert.ok(!sql.some((x) => /FROM pbxng_trunks ORDER BY id/.test(x.q)), 'sin rutas no se sondean troncales');
  const t2 = armar({
    amiCommand: async (c) => { if (c === 'database show rutasal') throw new Error('AMI caído'); return ''; },
    q: (s) => (/FROM pbxng_outbound_routes ORDER BY id/.test(s) ? { rows: [{ id: 1, trunk: 'a', backups: ['b'] }] } : undefined),
  });
  const f = await t2.trk.failoverStates(true);
  assert.equal(f[0].en_uso, null);
  assert.equal(f[0].prevista, 'a', 'nada online: la principal');
  assert.equal((await armar({ q: () => pgCaida() }).llamar('GET /api/routes/outbound/failover')).status, 503);
});

test('trunkup: el reloj apaga sólo con sondeo fiable y evidencia firme; la principal nunca si caen todas', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let fiable = true;
  let dbputFalla = false;
  const puestos = [];
  const { trk } = armar({
    endpointStates: async () => (fiable ? { x: { state: 'online' } } : {}),
    amiAction: async (a) => { puestos.push(a); if (dbputFalla) throw new Error('AMI caído'); },
    amiCommand: async (c) => (c === 'pjsip show registrations'
      ? ' a/sip:x a Rejected\n b/sip:y b Rejected\n c/sip:z c Rejected\n d/sip:w d Registered\n' : ''),
    q: (s) => {
      if (/jsonb_array_length\(backups\) > 0/.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/FROM pbxng_outbound_routes ORDER BY id/.test(s)) return { rows: [
        { id: 1, trunk: 'a', backups: ['b'] },           // las dos caídas: la principal queda en 1
        { id: 2, trunk: 'd', backups: ['c'] },           // c caída, d viva
        { id: 3, trunk: 'c', backups: [] },              // sin respaldos: no cuenta
        { id: 4, trunk: 'b', backups: ['d'] },           // b es principal acá y respaldo allá
      ] };
      if (/FROM pbxng_trunks ORDER BY id/.test(s)) return { rows: ['a', 'b', 'c', 'd'].map((name) => ({ name, do_register: true })) };
      return undefined;
    },
  });
  void trk;
  t.mock.timers.tick(20000);
  await tandas(30);
  const val = Object.fromEntries(puestos.map((p) => [p.Key, p.Val]));
  assert.deepEqual(val, { a: '1', b: '0', c: '0', d: '1' });
  // Sondeo no fiable (ARI sin endpoints): no se apaga nada.
  fiable = false; dbputFalla = true; puestos.length = 0;
  t.mock.timers.tick(60000);
  await tandas(30);
  assert.ok(puestos.length > 0 && puestos.every((p) => p.Val === '1'));
});

test('trunkup: sin rutas con respaldo no se molesta al AMI, y una base caída no tira el reloj', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const puestos = [];
  let caida = false;
  armar({ amiAction: async (a) => { puestos.push(a); }, q: (s) => (caida && /jsonb_array_length/.test(s) ? pgCaida() : undefined) });
  t.mock.timers.tick(20000);
  await tandas(10);
  assert.equal(puestos.length, 0);
  caida = true;
  t.mock.timers.tick(60000);
  await tandas(10);
  assert.equal(puestos.length, 0);
});

/* ── Rutas entrantes ─────────────────────────────────────────────────────*/

test('entrantes con horario: decide, abierto y cerrado según el destino de fuera de hora', async () => {
  const tramos = [{ desde: '09:00', hasta: '18:00', dias: 'mon-fri' }];
  const horarios = { 1: { tramos, activo: true }, 2: { tramos, activo: false }, 3: { tramos: 'nada', activo: true } };
  const filas = [
    { id: 1, did: '100', dest_type: 'cola', dest_value: 'ventas', horario_id: 1, dest_cerrado_type: 'ivr', dest_cerrado_value: '5' },
    { id: 2, did: '200', dest_type: 'interno', dest_value: '1001', horario_id: 1 },
    { id: 3, did: '300', dest_type: 'app', dest_value: '*50', horario_id: 1 },
    { id: 4, did: '400', dest_type: null, dest_value: '1002', horario_id: 2 },
    { id: 5, did: '500', dest_type: 'interno', dest_value: '1003', horario_id: 3 },
    { id: 6, did: '600', dest_type: 'interno', dest_value: '1004', horario_id: 9 },
  ];
  const { trk, dialplan } = armar({
    q: (s, a) => {
      if (/FROM pbxng_horarios WHERE id=\$1/.test(s)) return { rows: horarios[a[0]] ? [horarios[a[0]]] : [] };
      if (/FROM pbxng_inbound_routes WHERE horario_id=\$1/.test(s)) return { rows: filas.filter((f) => f.horario_id === a[0]) };
      if (/FROM pbxng_inbound_routes ORDER BY id/.test(s)) return { rows: filas };
      return undefined;
    },
  });
  assert.equal(await trk.regenerarEntrantes(), 6);
  const de = (exten) => dialplan.filter((d) => d.exten === exten).at(-1).rows;
  assert.ok(de('100').some((r) => r[1] === 'GotoIfTime' && r[2] === '09:00-18:00,mon-fri,*,*?from-trunk,abierto-100,1'));
  assert.deepEqual(de('abierto-100').map((r) => r[1]), ['Answer', 'Queue', 'Hangup']);
  assert.deepEqual(de('cerrado-100'), [[1, 'Goto', 'ivr,5,1']]);
  assert.deepEqual(de('cerrado-200').map((r) => r[2]), ['', '1001@default,u', ''], 'interno sin destino de fuera de hora: su buzón');
  assert.deepEqual(de('cerrado-300')[1], [2, 'Playback', 'vm-goodbye']);
  assert.deepEqual(de('abierto-300'), [[1, 'Goto', 'internal,*50,1']]);
  assert.equal(de('400')[0][1], 'Dial', 'horario inactivo: una sola extensión, como sin horario');
  assert.equal(de('500')[0][1], 'Dial', 'tramos ilegibles: como sin horario');
  assert.equal(de('600')[0][1], 'Dial', 'horario borrado: como sin horario');
  dialplan.length = 0;
  assert.equal(await trk.regenerarEntrantes({ horario_id: 2 }), 1);
  assert.equal(await trk.regenerarEntrantes({ horario_id: 77 }), 0);
});

test('regenerarEntrantes: si falla, ROLLBACK y el error sube', async () => {
  const { trk, sql, liberados } = armar({ q: (s) => (/FROM pbxng_inbound_routes ORDER BY id/.test(s) ? pgCaida() : s === 'ROLLBACK' ? pgCaida() : undefined) });
  await assert.rejects(trk.regenerarEntrantes(), /Connection terminated/);
  assert.ok(sql.some((x) => x.q === 'ROLLBACK'));
  assert.equal(liberados.n, 1);
});

test('entrantes: validación del destino efectivo y del de fuera de hora', async () => {
  let fila;
  const { llamar } = armar({
    q: (s, a) => {
      if (/INSERT INTO pbxng_inbound_routes/.test(s)) { fila = { id: 1, did: a[0], name: a[1], dest_type: a[2], dest_value: a[3], horario_id: a[4], dest_cerrado_type: a[5], dest_cerrado_value: a[6] }; return { rows: [fila] }; }
      if (/SELECT id,did,name,dest_type/.test(s)) return { rows: [{ id: 1, did: '100', dest_type: 'fax', dest_value: '1', horario_id: 4, dest_cerrado_type: null, dest_cerrado_value: null }] };
      if (/UPDATE pbxng_inbound_routes/.test(s)) return { rows: [{ id: 1, did: '100', dest_type: a[2] || 'fax', dest_value: a[3] || '1', horario_id: a[4], dest_cerrado_type: a[5], dest_cerrado_value: a[6] }] };
      return undefined;
    },
  });
  assert.equal((await llamar('POST /api/routes/inbound', {})).status, 400);
  for (const [body, txt] of [
    [{ did: '1', dest_value: '1001', dest_type: 'fax' }, /destino inválido: fax/],
    [{ did: '1', dest_value: '1001', dest_cerrado_type: 'fax' }, /fuera de hora inválido: fax/],
    [{ did: '1', dest_value: '10a' }, /para el tipo «interno»/],
    [{ did: '1', dest_value: '1001', dest_cerrado_type: 'cola', dest_cerrado_value: 'a,b' }, /fuera de hora inválido para el tipo «cola»/],
  ]) {
    const r = await llamar('POST /api/routes/inbound', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, txt);
  }
  const ok = await llamar('POST /api/routes/inbound', { body: { did: '29001234', dest_value: '1001', horario_id: 'x' } });
  assert.equal(ok.status, 201);
  assert.equal(fila.name, '29001234', 'sin nombre se usa el DID');
  assert.equal(fila.horario_id, null);
  // PUT que deja la fila con el tipo viejo `fax`: no se publica.
  const viejo = await llamar('PUT /api/routes/inbound/:id', { params: { id: '1' } });
  assert.equal(viejo.status, 400);
  assert.match(viejo.json.error, /destino inválido: fax/);
  const bien = await llamar('PUT /api/routes/inbound/:id', { params: { id: '1' }, body: { name: 'X', dest_type: 'interno', dest_value: '1002', horario_id: '', dest_cerrado_type: '', dest_cerrado_value: '' } });
  assert.equal(bien.status, 200);
  assert.equal(bien.json.horario_id, null);
  assert.equal(bien.json.dest_cerrado_type, null);
  // Sin el dato pero con tipo: falta el destino.
  const { llamar: ll2 } = armar({ q: (s) => (/INSERT INTO pbxng_inbound_routes/.test(s) ? { rows: [{ id: 2, did: '1', dest_type: 'interno', dest_value: null }] } : undefined) });
  assert.match((await ll2('POST /api/routes/inbound', { body: { did: '1', dest_value: '5' } })).json.error, /falta el destino/);
  // Tipo de fuera de hora que la fila trae de antes y ya no existe.
  const { llamar: ll3 } = armar({ q: (s) => (/INSERT INTO pbxng_inbound_routes/.test(s) ? { rows: [{ id: 2, did: '1', dest_type: 'interno', dest_value: '5', dest_cerrado_type: 'fax', dest_cerrado_value: '9' }] } : undefined) });
  assert.match((await ll3('POST /api/routes/inbound', { body: { did: '1', dest_value: '5' } })).json.error, /fuera de hora inválido: fax/);
});

test('entrantes: base caída, PUT inexistente y DELETE de una que no está', async () => {
  for (const [ruta, o] of [
    ['POST /api/routes/inbound', { body: { did: '1', dest_value: '1001' } }],
    ['PUT /api/routes/inbound/:id', { params: { id: '1' } }],
    ['DELETE /api/routes/inbound/:id', { params: { id: '1' } }],
  ]) assert.equal((await armar({ connectFalla: true }).llamar(ruta, o)).status, 503, ruta);
  const { llamar, sql } = armar({ q: (s) => (s === 'ROLLBACK' ? pgCaida() : undefined) });
  assert.equal((await llamar('PUT /api/routes/inbound/:id', { params: { id: '1' }, body: {} })).status, 404);
  assert.deepEqual((await llamar('DELETE /api/routes/inbound/:id', { params: { id: '9' } })).json, { deleted: '9' });
  assert.ok(!sql.some((x) => /DELETE FROM extensions WHERE context='from-trunk' AND exten = ANY/.test(x.q)), 'sin fila no hay dialplan que borrar');
  const mal = armar({ q: (s) => (/DELETE FROM pbxng_inbound_routes/.test(s) ? pgCaida() : undefined) });
  assert.equal((await mal.llamar('DELETE /api/routes/inbound/:id', { params: { id: '1' } })).status, 503);
  assert.equal((await armar({ q: () => pgCaida() }).llamar('GET /api/routes/inbound')).status, 503);
  const mal2 = armar({ q: (s) => (/INSERT INTO pbxng_inbound_routes/.test(s) ? pgCaida() : undefined) });
  assert.equal((await mal2.llamar('POST /api/routes/inbound', { body: { did: '1', dest_value: '1001' } })).status, 503);
});

/* ── Troncales ────────────────────────────────────────────────────────────*/

test('GET /api/trunks: forma de cada tipo (WebRTC, cliente WSS, viejas con kam_config) y base caída', async () => {
  const { llamar } = armar({
    q: (s) => (/FROM pbxng_trunks ORDER BY id/.test(s) ? { rows: [
      { name: 'w', kind: 'webrtc', provider_host: 'pbx', kam_config: { link: 'wss://pbx/ws', logo: 'l.png', dids: ['1'], channels: 2, gateway: 'g' }, adv_config: null },
      { name: 'wc', kind: 'webrtc-client', provider_host: 'h', kam_config: { remote_url: 'wss://remoto.ej:8443/ws', register: true }, adv_config: null },
      { name: 'wc2', kind: 'webrtc-client', provider_host: 'h2', kam_config: { remote_url: 'nada' }, adv_config: null },
      { name: 'wc3', kind: 'webrtc-client', provider_host: null, kam_config: null, adv_config: null },
      { name: 'ip', kind: 'asterisk', do_register: false, kam_config: null, adv_config: null },
      { name: 'reg', kind: 'asterisk', do_register: true, kam_config: null, adv_config: { mode: 'register', transport: 'tls', logo: 'r.png', dids: ['2'], channels: 4, gateway: 'gw' } },
    ] } : undefined),
  });
  const l = (await llamar('GET /api/trunks')).json;
  const p = Object.fromEntries(l.map((x) => [x.name, x]));
  assert.deepEqual([p.w.link, p.w.target, p.w.logo, p.w.mode, p.w.transport, p.w.channels, p.w.gateway], ['wss://pbx/ws', 'pbx', 'l.png', 'webrtc', 'wss', 2, 'g']);
  assert.deepEqual(p.w.adv, { logo: 'l.png' });
  assert.deepEqual([p.wc.target, p.wc.register_provider, p.wc.link], ['remoto.ej', true, 'wss://remoto.ej:8443/ws']);
  assert.equal(p.wc2.target, 'h2');
  assert.deepEqual([p.wc3.target, p.wc3.link], [null, null]);
  assert.deepEqual([p.ip.mode, p.ip.transport, p.ip.adv, p.ip.logo, p.ip.dids, p.ip.channels, p.ip.gateway, p.ip.rtt], ['ip', 'udp', null, null, [], 0, '', null]);
  assert.deepEqual([p.reg.mode, p.reg.transport, p.reg.logo, p.reg.dids], ['register', 'tls', 'r.png', ['2']]);
  assert.equal((await armar({ q: () => pgCaida() }).llamar('GET /api/trunks')).status, 503);
});

test('detalle de troncal: 404, WebRTC sin dominio, cliente WSS y una vieja sin adv_config', async () => {
  const filas = {
    w: { name: 'w', kind: 'webrtc', kam_config: null, adv_config: null },
    wl: { name: 'wl', kind: 'webrtc', kam_config: { link: 'wss://x/ws', username: 'u' } },
    wc: { name: 'wc', kind: 'webrtc-client', kam_config: {} },
    vieja: { name: 'vieja', kind: 'asterisk', provider_host: 'h', provider_port: null, username: 'u', do_register: false, kam_config: null, adv_config: null },
    adv: { name: 'adv', kind: 'asterisk', username: null, adv_config: { provider_host: 'h', mode: 'ip', adv_config: { logo: 'z', channels: '3', gateway: 'gw', dids: ['9'] }, dids: '1 2,3', codecs: [], dtmf_mode: 'xx', transport: 'sctp', outbound_prefix: null } },
  };
  const { llamar } = armar({
    NODES: {},
    q: (s, a) => {
      if (/WHERE name=\$1/.test(s) && /SELECT name,provider_host/.test(s)) return { rows: filas[a[0]] ? [filas[a[0]]] : [] };
      if (/SELECT 1 FROM ps_auths/.test(s)) return { rows: a[0] === 'wl' ? [{}] : [] };
      return undefined;
    },
  });
  assert.equal((await llamar('GET /api/trunks/:name/detail', { params: { name: 'nada' } })).status, 404);
  const w = (await llamar('GET /api/trunks/:name/detail', { params: { name: 'w' } })).json;
  assert.deepEqual([w.link, w.username, w.has_password, w.remote_url], ['wss:///ws', '', false, null]);
  const wl = (await llamar('GET /api/trunks/:name/detail', { params: { name: 'wl' } })).json;
  assert.deepEqual([wl.link, wl.username, wl.has_password], ['wss://x/ws', 'u', true]);
  assert.equal((await llamar('GET /api/trunks/:name/detail', { params: { name: 'wc' } })).json.remote_url, '');
  const v = (await llamar('GET /api/trunks/:name/detail', { params: { name: 'vieja' } })).json;
  assert.deepEqual([v.adv.mode, v.adv.provider_port, v.adv.from_user, v.adv.from_domain, v.adv.dids], ['ip', 5060, 'u', 'h', []]);
  const a = (await llamar('GET /api/trunks/:name/detail', { params: { name: 'adv' } })).json.adv;
  assert.deepEqual([a.dids, a.codecs, a.dtmf_mode, a.transport, a.outbound_prefix, a.logo, a.channels, a.gateway], [['1', '2', '3'], ['ulaw', 'alaw'], 'rfc4733', 'udp', '0', 'z', 3, 'gw']);
  assert.equal((await armar({ q: () => pgCaida() }).llamar('GET /api/trunks/:name/detail', { params: { name: 'x' } })).status, 503);
});

test('alta de troncal: WebRTC sin datos o con la base caída, tipos vía SBC, kind sbc con error', async () => {
  const { llamar } = armar({ NODES: {} });
  assert.equal((await llamar('POST /api/trunks', { body: { kind: 'webrtc', name: 'w' } })).status, 400);
  const w = await llamar('POST /api/trunks', { body: { kind: 'webrtc', name: 'w', password: 'p' } });
  assert.deepEqual([w.status, w.json.link, w.json.username], [201, 'wss:///ws', 'w']);
  assert.equal((await armar({ connectFalla: true }).llamar('POST /api/trunks', { body: { kind: 'webrtc', name: 'w', password: 'p' } })).status, 503);
  const mitad = armar({ q: (s) => (/INSERT INTO ps_endpoints/.test(s) ? pgCaida() : undefined) });
  assert.equal((await mitad.llamar('POST /api/trunks', { body: { kind: 'webrtc', name: 'w', password: 'p', username: 'u' } })).status, 503);
  for (const kind of ['kamailio', 'webrtc-client']) assert.match((await llamar('POST /api/trunks', { body: { kind } })).json.error, /SBC-NG/);
  assert.equal((await llamar('POST /api/trunks', { body: { kind: 'sbc' } })).status, 400, 'kind sbc sin host');
  assert.equal((await llamar('POST /api/trunks')).status, 400, 'sin cuerpo');
  assert.equal((await armar({ connectFalla: true }).llamar('POST /api/trunks', { body: { name: 'x', provider_host: 'h', mode: 'ip' } })).status, 503);
});

test('alta de troncal SIP: TLS, sin salida automática y prefijo ocupado por otro (409)', async () => {
  const { llamar, sql, dialplan } = armar();
  const r = await llamar('POST /api/trunks', { body: { name: 'tls1', provider_host: 'h', mode: 'register', username: 'u', password: 'p', transport: 'tls', nat: false, direct_media: true, outbound_enabled: false } });
  assert.equal(r.status, 201);
  assert.match(sql.find((x) => /INSERT INTO ps_aors/.test(x.q)).args[1], /;transport=tls$/);
  const ep = sql.find((x) => /INSERT INTO ps_endpoints/.test(x.q)).args;
  assert.deepEqual([ep[9], ep[10]], ['yes', 'no'], 'direct_media sí, NAT no');
  assert.equal(dialplan.length, 0, 'sin salida automática no se publica nada en internal');
  // Prefijo que ya usa un interno: 409 y ROLLBACK.
  const ocupado = armar({ q: (s) => (/SELECT 1 FROM ps_endpoints WHERE id=\$1 LIMIT 1/.test(s) ? { rows: [{}] } : undefined) });
  const o = await ocupado.llamar('POST /api/trunks', { body: { name: 'ip9', provider_host: 'h', mode: 'ip', outbound_prefix: '1001', outbound_strip: 4 } });
  assert.equal(o.status, 409);
  assert.ok(ocupado.sql.some((x) => x.q === 'ROLLBACK'));
});

test('edición de troncal: WebRTC (404, sin clave, base caída), cliente WSS y kamailio', async () => {
  const existe = new Set(['w', 'wc', 'k', 'sip']);
  let claveVieja = null;
  const q = (s, a) => {
    if (/SELECT 1 FROM pbxng_trunks WHERE name=\$1/.test(s)) return { rows: existe.has(a[0]) ? [{}] : [] };
    if (/SELECT password FROM ps_auths/.test(s)) return { rows: claveVieja ? [{ password: claveVieja }] : [] };
    if (/SELECT kam_config FROM pbxng_trunks/.test(s)) return { rows: existe.has(a[0]) ? [{ kam_config: a[0] === 'k' ? { password: 'vieja' } : null }] : [] };
    if (/SELECT COALESCE\(kind,'asterisk'\) AS kind, adv_config/.test(s)) return { rows: existe.has(a[0]) ? [{ kind: 'asterisk', adv_config: a[0] === 'sip' ? { outbound_enabled: true, outbound_prefix: '9' } : null }] : [] };
    return undefined;
  };
  const { llamar, sql } = armar({ q, NODES: { domain: 'pbx.ej' } });
  const put = (name, body) => llamar('PUT /api/trunks/:name', { params: { name }, body });
  assert.equal((await put('nada', { kind: 'webrtc' })).status, 404);
  assert.equal((await put('w', { kind: 'webrtc' })).status, 400, 'sin clave nueva ni vieja');
  claveVieja = 'guardada';
  const w = await put('w', { kind: 'webrtc', note: 'n' });
  assert.deepEqual([w.status, w.json.link], [200, 'wss://pbx.ej/ws']);
  assert.equal(sql.filter((x) => /INSERT INTO ps_auths/.test(x.q)).at(-1).args[2], 'guardada', 'conserva la clave vieja');
  assert.equal((await armar({ connectFalla: true }).llamar('PUT /api/trunks/:name', { params: { name: 'w' }, body: { kind: 'webrtc' } })).status, 503);
  assert.equal((await armar({ q: (s) => (/SELECT 1 FROM pbxng_trunks/.test(s) ? pgCaida() : undefined) }).llamar('PUT /api/trunks/:name', { params: { name: 'w' }, body: { kind: 'webrtc' } })).status, 503);

  // Cliente WSS: obligatorios, 404, sin clave, OK y base caída.
  assert.equal((await put('wc', { kind: 'webrtc-client' })).status, 400);
  assert.equal((await put('nada', { kind: 'webrtc-client', remote_url: 'wss://r/ws', username: 'u' })).status, 404);
  assert.equal((await put('wc', { kind: 'webrtc-client', remote_url: 'wss://r/ws', username: 'u' })).status, 400);
  const wc = await put('wc', { kind: 'webrtc-client', remote_url: 'ws-mal', username: 'u', password: 'p' });
  assert.equal(wc.json.kind, 'webrtc-client');
  assert.equal(sql.filter((x) => /kind='webrtc-client'/.test(x.q)).at(-1).args[1], '', 'una URL sin host deja el host vacío');
  assert.equal((await armar({ q: () => pgCaida() }).llamar('PUT /api/trunks/:name', { params: { name: 'wc' }, body: { kind: 'webrtc-client', remote_url: 'wss://r', username: 'u' } })).status, 503);

  // Kamailio (heredada): conserva la clave vieja si no viene una nueva.
  const k = await put('k', { kind: 'kamailio', provider_host: 'h', mode: 'ip' });
  assert.equal(k.json.kind, 'kamailio');
  const kam = JSON.parse(sql.filter((x) => /kind='kamailio'/.test(x.q)).at(-1).args[4]);
  assert.deepEqual([kam.password, kam.register, kam.port], ['vieja', false, 5060]);
  claveVieja = null;
  const k2 = await put('k2', { kind: 'kamailio', provider_host: 'h' });
  assert.equal(k2.status, 404);
  existe.add('k2');
  await put('k2', { kind: 'kamailio', provider_host: 'h', provider_port: '5070', username: 'u' });
  const kam2 = JSON.parse(sql.filter((x) => /kind='kamailio'/.test(x.q)).at(-1).args[4]);
  assert.deepEqual([kam2.password, kam2.register, kam2.port], [null, true, 5070]);
});

test('edición de troncal SIP: obligatorios, clave vieja, prefijo que cambia y base caída', async () => {
  let adv = { outbound_enabled: true, outbound_prefix: '9' };
  const q = (s, a) => {
    if (/SELECT COALESCE\(kind,'asterisk'\) AS kind, adv_config/.test(s)) return { rows: a[0] === 'nada' ? [] : [{ kind: 'asterisk', adv_config: adv }] };
    if (/SELECT password FROM ps_auths/.test(s)) return { rows: [] };
    return undefined;
  };
  const { llamar, sql } = armar({ q });
  const put = (name, body) => llamar('PUT /api/trunks/:name', { params: { name }, body });
  assert.equal((await put('sip', {})).status, 400);
  assert.equal((await armar({ connectFalla: true }).llamar('PUT /api/trunks/:name', { params: { name: 'sip' }, body: { provider_host: 'h' } })).status, 503);
  assert.equal((await put('nada', { provider_host: 'h' })).status, 404);
  assert.equal((await put('sip', { provider_host: 'h', mode: 'register', username: 'u' })).status, 400, 'sin clave nueva ni vieja en modo Registro');
  // Apagar la salida automática se lleva el dialplan viejo (si es propio).
  const r = await put('sip', { provider_host: 'h', mode: 'ip', outbound_enabled: false });
  assert.equal(r.status, 200);
  assert.ok(sql.some((x) => /SELECT app, appdata FROM extensions/.test(x.q) && x.args[0] === '_9.'));
  // Antes no publicaba: nada que borrar.
  adv = { outbound_enabled: false };
  const n = sql.length;
  await put('sip', { provider_host: 'h', mode: 'ip', outbound_enabled: false });
  assert.ok(!sql.slice(n).some((x) => /SELECT app, appdata FROM extensions/.test(x.q)));
  // Mismo prefijo: no se borra (se reescribe encima).
  adv = { outbound_enabled: true, outbound_prefix: '9' };
  const n2 = sql.length;
  await put('sip', { provider_host: 'h', mode: 'ip', outbound_prefix: '9' });
  assert.ok(!sql.slice(n2).some((x) => /DELETE FROM extensions WHERE context='internal'/.test(x.q)));
  const mal = armar({ q: (s, a) => (/UPDATE pbxng_trunks SET provider_host/.test(s) ? pgCaida() : q(s, a)) });
  assert.equal((await mal.llamar('PUT /api/trunks/:name', { params: { name: 'sip' }, body: { provider_host: 'h', mode: 'ip' } })).status, 503);
});

test('baja de troncal: la del SBC marca «quitado», los respaldos se reescriben y la base caída devuelve 503', async () => {
  const { llamar, sql, dialplan, broadcasts } = armar({
    q: (s) => {
      if (/SELECT adv_config FROM pbxng_trunks WHERE name/.test(s)) return { rows: [{ adv_config: null }] };
      if (/backups @> to_jsonb/.test(s)) return { rows: [{ id: 1, pattern: '0X.', trunk: 'a', backups: ['to-sbc', 'b'] }, { id: 2, pattern: '9X.', trunk: 'a', backups: null }] };
      return undefined;
    },
  });
  const r = await llamar('DELETE /api/trunks/:name', { params: { name: 'to-sbc' } });
  assert.deepEqual(r.json, { deleted: 'to-sbc', rutas_sin_respaldo: 2 });
  assert.ok(sql.some((x) => /sbc_link_removed/.test(x.q)));
  assert.deepEqual(sql.filter((x) => /UPDATE pbxng_outbound_routes SET backups/.test(x.q)).map((x) => x.args[1]), ['["b"]', '[]']);
  assert.equal(dialplan.length, 2);
  assert.equal(broadcasts(), 1);
  const sinRutas = armar();
  assert.deepEqual((await sinRutas.llamar('DELETE /api/trunks/:name', { params: { name: 'x' } })).json, { deleted: 'x', rutas_sin_respaldo: 0 });
  assert.equal(sinRutas.broadcasts(), 0);
  assert.equal((await armar({ connectFalla: true }).llamar('DELETE /api/trunks/:name', { params: { name: 'x' } })).status, 503);
  const mal = armar({ q: (s) => (/DELETE FROM pbxng_trunks WHERE name/.test(s) ? pgCaida() : undefined) });
  assert.equal((await mal.llamar('DELETE /api/trunks/:name', { params: { name: 'x' } })).status, 503);
});

test('diagnóstico y registros: pasan al módulo y los errores se traducen', async () => {
  const { llamar } = armar({ amiCommand: async () => 'reg ok' });
  assert.deepEqual((await llamar('POST /api/trunks/diagnose')).json, { ok: true, b: {} });
  assert.deepEqual((await llamar('GET /api/registrations')).json, { output: 'reg ok' });
  const roto = armar({ amiCommand: async () => { throw new Error('AMI no conectado'); }, diagtrunk: { diagnosticar: async () => { throw Object.assign(new Error('host requerido'), { status: 400 }); } } });
  assert.equal((await roto.llamar('POST /api/trunks/diagnose', { body: {} })).status, 400);
  assert.equal((await roto.llamar('GET /api/registrations')).status, 500);
});

test('semillas de arranque: con la base caída se loguea y no tira', async () => {
  const { errores } = armar({ q: () => pgCaida() });
  await tandas();
  assert.ok(errores.some((a) => a[0] === 'sbc-seed'));
  assert.ok(errores.some((a) => a[0] === 'mod-seed'));
});
