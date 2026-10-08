/* ============================================================================
 *  Salas de reunión (salas.js) con dependencias falsas: sin Postgres, sin Asterisk y
 *  sin SMTP. salas.test.js / salas-vivo.test.js recorren el camino feliz contra la API
 *  real; acá se fijan los bordes que deciden si una reunión es SEGURA y si el panel
 *  dice la verdad cuando algo falla:
 *
 *   - la AstDB que no toma el PIN (AMI caído): la sala se guarda, pero el que apretó
 *     Guardar recibe el aviso, y el estado de la agenda se reintenta en vez de quedar
 *     «publicado» en un caché mentiroso;
 *   - el dialplan con PIN sólo de participante (sin entrada de moderador) y la etiqueta
 *     vacía; el renombrado de una sala, que se lleva sus claves viejas de la AstDB;
 *   - moderar (silenciar/expulsar) sólo canales que están EN esa sala, con 503 si no se
 *     puede saber quién está adentro;
 *   - la invitación por correo: rebotes parciales, todo rebotado (502), PIN de moderador
 *     sólo al moderador, el enlace web sólo al participante;
 *   - el enlace público: tope de invitados, sala cerrada por agenda, el aviso al guardia
 *     recién al quinto token inventado desde la misma IP, y la entrada de un solo uso;
 *   - el historial armado con eventos AMI (entrada, salida, fin) y la base caída.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const nodemailer = require('nodemailer');
const initSalas = require('../salas');
const { errorHttp } = require('../errores');

const tandas = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const pgCaida = () => new Error('Connection terminated unexpectedly');

const SALA = {
  id: 1, name: 'directorio', label: 'Directorio', access_exten: '9001', pin: '123456', pin_mod: '654321',
  max_part: 0, moh_hasta_moderador: true, anunciar: true, grabar: false, agenda_inicio: null, agenda_min: null,
  aviso_cerrada: 'conf-locked', invitados: [], invitado_at: null, tenant_id: 1, video: false, web_token: null,
};

/* `q(sql, args, enTx)` intercepta consultas; undefined = default vacío; un Error se tira. */
function armar(o = {}) {
  const rutas = {};
  const reg = (m) => (p, ...hs) => { rutas[m + ' ' + p] = hs[hs.length - 1]; rutas['MW ' + m + ' ' + p] = hs.length > 1 ? hs[0] : null; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  const sql = [];
  const correr = async (q, args, enTx) => {
    const s = String(q).replace(/\s+/g, ' ').trim();
    sql.push({ q: s, args, enTx });
    if (o.q) { const r = await o.q(s, args, enTx); if (r !== undefined) { if (r instanceof Error) throw r; return r; } }
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query: (q, a) => correr(q, a, false),
    async connect() {
      if (o.connectFalla) throw pgCaida();
      return { query: (q, a) => correr(q, a, true), release() {} };
    },
  };
  const amiAcc = [];
  const avisos = [];
  const logger = () => ({ debug() {}, info() {}, warn(...a) { avisos.push(a); }, error(...a) { avisos.push(a); } });
  const ami = new EventEmitter();
  const reportes = [];
  const endpoints = [];
  const salas = initSalas({
    app, pool, ami,
    amiAction: o.amiAction || (async (a) => { amiAcc.push(a); return {}; }),
    amiList: o.amiList || (async () => []),
    setDialplan: o.setDialplan || (async () => {}),
    smtpHint: o.smtpHint,
    errorHttp, broadcastSoon: () => {},
    ...(o.sinLogger ? {} : { logger }),
    createWebrtcEndpoint: async (...a) => { endpoints.push(a); },
    rateLimit: o.rateLimit,
    reportarWeb: o.sinReportar ? undefined : (ip, cuenta) => reportes.push([ip, cuenta]),
    clientIp: o.clientIp,
  });
  const llamar = async (ruta, { body, params = {}, query = {}, user, ip } = {}) => {
    const r = { status: 200, json: undefined };
    const res = { status(s) { r.status = s; return this; }, json(j) { r.json = j; return this; } };
    await rutas[ruta]({ body, params, query, user, ip }, res);
    return r;
  };
  return { salas, rutas, llamar, sql, amiAcc, avisos, ami, reportes, endpoints };
}

/* ── AstDB y agenda ───────────────────────────────────────────────────────*/

test('syncSalas: PIN vacíos se BORRAN de la AstDB (nunca se escribe un vacío) y la base caída sólo avisa', async () => {
  const { salas, amiAcc } = armar({ q: (s) => (/SELECT name, pin, pin_mod, agenda_inicio, agenda_min FROM pbxng_conferences$/.test(s)
    ? { rows: [{ name: 'vieja', pin: null, pin_mod: '  ', agenda_inicio: null }, { name: 'nueva', pin: 1234, pin_mod: '5678', agenda_inicio: 'no es fecha' }] } : undefined) });
  await salas.syncSalas();
  const de = (k) => amiAcc.filter((a) => a.Key === k).map((a) => a.Action + ' ' + a.Family + (a.Val !== undefined ? '=' + a.Val : ''));
  assert.deepEqual(de('vieja'), ['DBDel salapin', 'DBDel salamod', 'DBPut sala=1']);
  assert.deepEqual(de('nueva'), ['DBPut salapin=1234', 'DBPut salamod=5678', 'DBPut sala=1'], 'una fecha ilegible deja la sala abierta');
  const caida = armar({ q: () => pgCaida() });
  await caida.salas.syncSalas();
  assert.ok(caida.avisos.some((a) => a[0] === 'sync'));
});

test('agenda: un DBPut que falla no queda como publicado y se reintenta en la vuelta siguiente', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let falla = true;
  const intentos = [];
  const ahora = Date.now();
  const { avisos } = armar({
    amiAction: async (a) => { intentos.push(a); if (falla) throw new Error('AMI caído'); },
    q: (s) => (/WHERE agenda_inicio IS NOT NULL/.test(s) ? { rows: [{ name: 'agendada', agenda_inicio: new Date(ahora - 60000).toISOString(), agenda_min: null }] } : undefined),
  });
  t.mock.timers.tick(30000);
  await tandas();
  assert.equal(intentos.length, 1);
  assert.equal(intentos[0].Val, '1', 'dentro de la ventana por defecto de 60 minutos');
  assert.ok(avisos.some((a) => /AstDB: no se pudo escribir sala\/agendada/.test(a[0])));
  falla = false;
  t.mock.timers.tick(30000);
  await tandas();
  assert.equal(intentos.length, 2, 'no quedó en el caché: se reintenta');
  t.mock.timers.tick(30000);
  await tandas();
  assert.equal(intentos.length, 2, 'ya publicado: no se repite');
});

test('agenda: la base caída en el reloj no tira, y ventanaAbierta respeta inicio y duración', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { salas } = armar({ q: () => pgCaida(), sinLogger: true });
  t.mock.timers.tick(30000);
  await tandas();
  const ini = new Date('2026-05-01T10:00:00Z');
  const s = { agenda_inicio: ini.toISOString(), agenda_min: 30 };
  assert.equal(salas.ventanaAbierta(s, new Date('2026-05-01T09:59:59Z')), false);
  assert.equal(salas.ventanaAbierta(s, new Date('2026-05-01T10:29:59Z')), true);
  assert.equal(salas.ventanaAbierta(s, new Date('2026-05-01T10:30:00Z')), false);
  assert.equal(salas.ventanaAbierta(null), true);
});

/* ── Dialplan ─────────────────────────────────────────────────────────────*/

test('dialplan: PIN sólo de participante no publica la entrada de moderador', () => {
  const { salas } = armar();
  const rows = salas.salaDialplan({ ...SALA, label: '$""', pin_mod: undefined, aviso_cerrada: '' });
  assert.equal(rows[0][2], 'Sala de reunion directorio (directorio)', 'etiqueta que queda vacía: se usa el nombre');
  assert.deepEqual(rows.find((r) => r[0] === 4), [4, 'Playback', 'conf-locked']);
  assert.ok(!rows.some((r) => r[0] === 60), 'sin PIN de moderador no hay bloque 60');
  assert.ok(!rows.some((r) => /salamod/.test(r[2])));
  const invalido = rows.find((r) => r[1] === 'GotoIf' && /SALAPIN}"=""/.test(r[2]));
  assert.match(invalido[2], /\?9$/, 'el vacío salta directo al rechazo (dos GotoIf, no tres)');
  assert.ok(rows.some((r) => r[1] === 'Playback' && r[2] === 'conf-invalidpin' && r[0] === 9));
  assert.ok(!rows.some((r) => /wait_marked/.test(r[2])), 'sin moderador posible no se espera a nadie');
});

test('republicarDialplan: si falla la escritura de una sala se avisa y sigue con las demás', async () => {
  const otra = { ...SALA, name: 'otra', access_exten: '9002' };
  const { salas, avisos, sql } = armar({
    setDialplan: async (c, ctx, exten) => { if (exten === '9001') throw new Error('extensions bloqueada'); },
    q: (s) => {
      if (/SELECT id, name, label/.test(s) && /FROM pbxng_conferences$/.test(s)) return { rows: [SALA, otra] };
      if (s === 'ROLLBACK') return pgCaida();
      return undefined;
    },
  });
  assert.equal(await salas.republicarDialplan(), 1);
  assert.ok(avisos.some((a) => /republicar el dialplan de la sala directorio/.test(a[0])));
  assert.ok(sql.some((x) => x.q === 'ROLLBACK'));
});

/* ── Alta, edición y baja ─────────────────────────────────────────────────*/

test('guardar: renombrar se lleva las claves viejas; AMI caído devuelve el aviso; validaciones', async () => {
  let ami = true;
  let fila = { ...SALA };
  const { llamar, amiAcc, sql } = armar({
    amiAction: async (a) => { amiAcc.push(a); if (!ami) throw new Error('AMI caído'); },
    q: (s, a) => {
      if (/FROM pbxng_conferences WHERE name=\$1/.test(s) && /SELECT id, name/.test(s)) return { rows: a[0] === 'directorio' || a[0] === fila.name ? [fila] : [] };
      if (/UPDATE pbxng_conferences SET name=\$2/.test(s)) { fila = { ...fila, name: a[1], access_exten: a[3], pin: a[4], pin_mod: a[5] }; return { rowCount: 1 }; }
      return undefined;
    },
  });
  const amiAccLocal = amiAcc;
  const r = await llamar('PUT /api/salas/:name', { params: { name: 'directorio' }, body: { name: 'junta', access_exten: '9010' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(sql.some((x) => /DELETE FROM extensions WHERE context='ivr'/.test(x.q) && x.args[0] === '9001'), 'el número viejo deja de entrar a la sala');
  for (const f of ['sala', 'salapin', 'salamod']) assert.ok(amiAccLocal.some((a) => a.Action === 'DBDel' && a.Family === f && a.Key === 'directorio'));
  assert.equal(r.json.aviso, undefined);
  ami = false;
  const r2 = await llamar('PUT /api/salas/:name', { params: { name: 'junta' }, body: { pin: '111111' } });
  assert.match(r2.json.aviso, /Asterisk no tomó el cambio/);
  for (const [body, txt] of [
    [{ pin: '12' }, /4 a 10 dígitos/],
    [{ aviso_cerrada: 'a b' }, /aviso de sala cerrada/],
    [{ agenda_inicio: 'cuando sea' }, /fecha y hora/],
  ]) {
    const x = await llamar('PUT /api/salas/:name', { params: { name: 'junta' }, body });
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.match(x.json.error, txt);
  }
  assert.equal((await llamar('PUT /api/salas/:name', { params: { name: 'nada' }, body: {} })).status, 404);
  assert.equal((await llamar('POST /api/salas', {})).status, 400, 'sin cuerpo: nombre inválido');
});

test('guardar: agenda con duración por defecto, número en uso (409) y ROLLBACK si falla la escritura', async () => {
  const { llamar, sql } = armar({
    q: (s, a) => {
      if (/WHERE access_exten=\$1 AND name<>\$2/.test(s)) return { rows: a[0] === '9999' ? [{ name: 'otra' }] : [] };
      if (/INSERT INTO pbxng_conferences/.test(s)) return a[0] === 'rompe' ? pgCaida() : { rowCount: 1 };
      if (s === 'ROLLBACK') return pgCaida();
      return undefined;
    },
  });
  const c = await llamar('POST /api/salas', { body: { name: 'agendada', access_exten: '9020', agenda_inicio: '2026-05-01T10:00:00Z', agenda_min: '' } });
  assert.equal(c.status, 201);
  const ins = sql.find((x) => /INSERT INTO pbxng_conferences/.test(x.q));
  assert.deepEqual([ins.args[9], ins.args[10]], ['2026-05-01T10:00:00.000Z', 60]);
  assert.equal(c.json, null, 'sin fila que leer después, devuelve null');
  const choque = await llamar('POST /api/salas', { body: { name: 'b', access_exten: '9999' } });
  assert.equal(choque.status, 409);
  assert.match(choque.json.error, /la sala otra/);
  assert.equal((await llamar('POST /api/salas', { body: { name: 'rompe', access_exten: '9030' } })).status, 503);
});

test('baja: base caída, 404 con ROLLBACK que falla, error a mitad y AMI caído al limpiar', async () => {
  assert.equal((await armar({ connectFalla: true }).llamar('DELETE /api/salas/:name', { params: { name: 'x' } })).status, 503);
  const { llamar } = armar({ q: (s) => (s === 'ROLLBACK' ? pgCaida() : undefined) });
  assert.equal((await llamar('DELETE /api/salas/:name', { params: { name: 'x' } })).status, 404);
  const mitad = armar({ q: (s) => (/SELECT access_exten/.test(s) ? { rows: [{ access_exten: '9001' }] } : /DELETE FROM pbxng_conferences/.test(s) ? pgCaida() : undefined) });
  assert.equal((await mitad.llamar('DELETE /api/salas/:name', { params: { name: 'x' } })).status, 503);
  const sinAmi = armar({ amiAction: async () => { throw new Error('AMI caído'); }, q: (s) => (/SELECT access_exten/.test(s) ? { rows: [{ access_exten: '9001' }] } : undefined) });
  const r = await sinAmi.llamar('DELETE /api/salas/:name', { params: { name: 'x' } });
  assert.deepEqual(r.json, { deleted: 'x' }, 'la baja en la base manda aunque la AstDB no conteste');
  assert.ok(sinAmi.avisos.some((a) => /no se pudo borrar salapin\/x/.test(a[0])));
});

/* ── Lista, detalle y vista en vivo ──────────────────────────────────────*/

test('lista: conteos de AMI (con y sin respuesta), banderas de PIN y del enlace', async () => {
  let roto = false;
  const { llamar } = armar({
    amiList: async (a) => { if (roto) throw new Error('AMI caído'); return a.Action === 'ConfbridgeListRooms' ? [{ Conference: 'directorio', Parties: '3' }, { conference: 'otra', parties: 'x' }] : []; },
    q: (s) => (/ORDER BY access_exten/.test(s) ? { rows: [{ ...SALA, web_token: 'tok' }, { ...SALA, name: 'otra', pin: null, pin_mod: '1' }] } : undefined),
  });
  const l = (await llamar('GET /api/salas')).json;
  assert.deepEqual([l[0].participantes, l[0].tiene_pin, l[0].web, l[0].pin, l[0].web_token], [3, true, true, undefined, undefined]);
  assert.deepEqual([l[1].participantes, l[1].tiene_pin, l[1].tiene_pin_mod], [0, false, true]);
  roto = true;
  assert.equal((await llamar('GET /api/salas')).json[0].participantes, 0, 'sin AMI la lista sale igual');
  assert.equal((await armar({ q: () => pgCaida() }).llamar('GET /api/salas')).status, 503);
});

test('detalle, vivo, mute y kick: 404, base caída, AMI caído y canales ajenos', async () => {
  let amiOk = true;
  const filas = [{ Channel: 'PJSIP/1001-0001', CallerIDNum: '1001', Admin: 'Yes', Muted: 'yes', WaitMarked: 'yes' }];
  const { llamar, amiAcc } = armar({
    amiList: async () => { if (!amiOk) throw new Error('AMI caído'); return filas; },
    q: (s, a) => (/WHERE name=\$1/.test(s) && /SELECT id, name/.test(s) ? { rows: a[0] === 'directorio' ? [{ ...SALA, grabar: true }] : [] } : undefined),
  });
  for (const r of ['GET /api/salas/:name', 'GET /api/salas/:name/live', 'POST /api/salas/:name/mute', 'POST /api/salas/:name/kick', 'POST /api/salas/:name/invitar', 'POST /api/salas/:name/enlace']) {
    assert.equal((await llamar(r, { params: { name: 'nada' } })).status, 404, r);
    assert.equal((await armar({ q: () => pgCaida() }).llamar(r, { params: { name: 'x' } })).status, 503, r);
  }
  const v = (await llamar('GET /api/salas/:name/live', { params: { name: 'directorio' } })).json;
  assert.equal(v.grabando, true);
  assert.deepEqual([v.participantes[0].moderador, v.participantes[0].mudo, v.participantes[0].esperando, v.participantes[0].nombre], [true, true, true, '']);
  assert.equal((await llamar('POST /api/salas/:name/mute', { params: { name: 'directorio' } })).status, 400, 'sin canal');
  assert.equal((await llamar('POST /api/salas/:name/kick', { params: { name: 'directorio' }, body: { canal: 'PJSIP/9999-1' } })).status, 404, 'canal que no está en la sala');
  const m = await llamar('POST /api/salas/:name/mute', { params: { name: 'directorio' }, body: { canal: 'PJSIP/1001-0001', mudo: false } });
  assert.deepEqual(m.json, { ok: true, canal: 'PJSIP/1001-0001', mudo: false });
  assert.equal(amiAcc.at(-1).Action, 'ConfbridgeUnmute');
  const k = await llamar('POST /api/salas/:name/kick', { params: { name: 'directorio' }, body: { canal: 'PJSIP/1001-0001' }, user: { user: 'ana' } });
  assert.equal(k.json.ok, true);
  amiOk = false;
  const v2 = (await llamar('GET /api/salas/:name/live', { params: { name: 'directorio' } })).json;
  assert.deepEqual([v2.ami, v2.grabando, v2.participantes], [false, false, []]);
  assert.equal((await llamar('POST /api/salas/:name/kick', { params: { name: 'directorio' }, body: { canal: 'PJSIP/1001-0001' } })).status, 503);
});

/* ── Invitación por correo ───────────────────────────────────────────────*/

test('invitar: destinatarios, sin SMTP, rebotes parciales y totales, PIN y enlace según el rol', async (t) => {
  const enviados = [];
  let rebota = () => false;
  t.mock.method(nodemailer, 'createTransport', (cfg) => ({
    cfg,
    async sendMail(m) { if (rebota(m.to)) throw Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }); enviados.push({ cfg, m }); },
  }));
  let smtp = null;
  let sala = { ...SALA, web_token: 'TOK', agenda_inicio: '2026-05-01T13:00:00Z', agenda_min: 45 };
  const settings = { domain: 'pbx.ej', sala_numero_externo: '29001234' };
  const { llamar, sql } = armar({
    smtpHint: (e) => 'rebote: ' + e.responseCode,
    q: (s, a) => {
      if (/SELECT id, name/.test(s) && /WHERE name=\$1/.test(s)) return { rows: [sala] };
      if (/FROM pbxng_email_config/.test(s)) return { rows: smtp ? [smtp] : [] };
      if (/FROM pbxng_settings WHERE key=\$1/.test(s)) return a[0] === 'brand_name' ? pgCaida() : { rows: settings[a[0]] ? [{ value: settings[a[0]] }] : [] };
      return undefined;
    },
  });
  const inv = (body) => llamar('POST /api/salas/:name/invitar', { params: { name: 'directorio' }, body });
  assert.equal((await inv({})).status, 400);
  assert.match((await inv({ destinatarios: Array.from({ length: 51 }, (_, i) => `a${i}@b.com`) })).json.error, /hasta 50/);
  assert.match((await inv({ destinatarios: 'a@b.com; nada' })).json.error, /inválida: nada/);
  assert.match((await inv({ destinatarios: ['a@b.com'] })).json.error, /sin configuración SMTP/);
  smtp = { host: 'smtp.ej', port: null, secure: 1, username: 'u', password: 'p', from_addr: null, enabled: true };
  const r = await inv({ destinatarios: 'a@b.com, c@d.com', mensaje: 'traé $café' });
  assert.deepEqual(r.json, { enviados: ['a@b.com', 'c@d.com'], fallados: [] });
  const m = enviados[0];
  assert.deepEqual([m.cfg.port, m.cfg.secure, m.cfg.auth.user, m.m.from], [587, true, 'u', 'u']);
  assert.match(m.m.text, /Entrá desde el navegador: https:\/\/pbx\.ej\/sala\/TOK/);
  assert.match(m.m.text, /desde afuera: 29001234/);
  assert.match(m.m.text, /PIN: 123456/);
  assert.match(m.m.text, /\(45 minutos\)/);
  assert.match(m.m.subject, /^Reunión: Directorio · /);
  assert.ok(sql.some((x) => /SET invitados = COALESCE/.test(x.q)));

  // Moderador: su PIN, sin enlace web; uno rebota y el otro sale → 200 con el fallado.
  rebota = (to) => to === 'x@y.com';
  enviados.length = 0;
  const mod = await inv({ destinatarios: ['jefe@b.com', 'x@y.com'], moderador: true });
  assert.equal(mod.status, 200);
  assert.deepEqual(mod.json.fallados, [{ destino: 'x@y.com', error: 'rebote: 550' }]);
  assert.match(enviados[0].m.text, /PIN de moderador: 654321/);
  assert.doesNotMatch(enviados[0].m.text, /navegador/);

  // Todo rebota → 502 y no se marca como invitado; sin agenda ni etiqueta ni usuario SMTP.
  rebota = () => true;
  smtp = { host: 'smtp.ej', port: 25, secure: false, username: '', from_addr: 'pbx@ej', enabled: true };
  sala = { ...SALA, label: '', web_token: null };
  delete settings.sala_numero_externo;
  delete settings.domain;
  const n = sql.length;
  const todo = await inv({ destinatarios: 'x@y.com' });
  assert.equal(todo.status, 502);
  assert.ok(!sql.slice(n).some((x) => /SET invitados/.test(x.q)));
  rebota = () => false;
  enviados.length = 0;
  await inv({ destinatarios: 'x@y.com' });
  assert.equal(enviados[0].cfg.auth, undefined);
  assert.match(enviados[0].m.text, /La sala está siempre disponible/);
  assert.equal(enviados[0].m.subject, 'Reunión: directorio');
});

test('invitar sin smtpHint: el error del SMTP va tal cual', async (t) => {
  t.mock.method(nodemailer, 'createTransport', () => ({ async sendMail() { throw new Error('ECONNREFUSED'); } }));
  const { llamar } = armar({
    q: (s) => {
      if (/SELECT id, name/.test(s)) return { rows: [{ ...SALA, tenant_id: null }] };
      if (/FROM pbxng_email_config/.test(s)) return { rows: [{ host: 'h', enabled: true }] };
      return undefined;
    },
  });
  const r = await llamar('POST /api/salas/:name/invitar', { params: { name: 'directorio' }, body: { destinatarios: 'a@b.com' } });
  assert.equal(r.status, 502);
  assert.equal(r.json.fallados[0].error, 'ECONNREFUSED');
});

/* ── Enlace web ───────────────────────────────────────────────────────────*/

test('enlace: crear sin dominio, revocar inexistente, y la página pública', async () => {
  const { llamar } = armar({
    q: (s, a) => {
      if (/SELECT id, name/.test(s) && /WHERE name=\$1/.test(s)) return { rows: [SALA] };
      if (/SET web_token=NULL/.test(s)) return { rowCount: a[0] === 'directorio' ? 1 : 0 };
      if (/WHERE web_token=\$1/.test(s) && /SELECT name,label,video/.test(s)) return { rows: a[0] === 'TOK' ? [{ name: 'directorio', label: '', video: 1, agenda_inicio: null }] : [] };
      return undefined;
    },
  });
  const e = await llamar('POST /api/salas/:name/enlace', { params: { name: 'directorio' } });
  assert.match(e.json.url, /^\/sala\/[A-Za-z0-9_-]{16}$/, 'sin dominio, la URL es relativa');
  assert.equal((await llamar('DELETE /api/salas/:name/enlace', { params: { name: 'nada' } })).status, 404);
  assert.deepEqual((await llamar('DELETE /api/salas/:name/enlace', { params: { name: 'directorio' } })).json, { ok: true });
  const p = (await llamar('GET /api/salas/web/:token', { params: { token: 'TOK' } })).json;
  assert.deepEqual([p.sala, p.video, p.abierta], ['directorio', true, true]);
  assert.equal((await armar({ q: () => pgCaida() }).llamar('DELETE /api/salas/:name/enlace', { params: { name: 'x' } })).status, 503);
  assert.equal((await armar({ q: () => pgCaida() }).llamar('GET /api/salas/web/:token', { params: { token: 'x' } })).status, 503);
});

test('guardia: recién el quinto token inventado desde la misma IP se reporta; sin IP no se cuenta', async () => {
  let ip = '203.0.113.7';
  const { llamar, reportes } = armar({ clientIp: () => ip });
  for (let i = 0; i < 4; i++) await llamar('GET /api/salas/web/:token', { params: { token: 'falso' + i } });
  assert.equal(reportes.length, 0, 'cuatro errores pueden ser de un invitado honesto');
  await llamar('POST /api/salas/web/:token/session', { params: { token: 'x'.repeat(40) } });
  assert.deepEqual(reportes, [['203.0.113.7', 'sala:' + 'x'.repeat(24)]]);
  ip = '';
  for (let i = 0; i < 6; i++) await llamar('POST /api/salas/entrada/:id', { params: { id: 'nada' } });
  assert.equal(reportes.length, 1);
  // Sin clientIp se usa req.ip; sin reportarWeb no se rompe nada.
  const sinIp = armar({ sinReportar: true });
  for (let i = 0; i < 6; i++) assert.equal((await sinIp.llamar('GET /api/salas/web/:token', { params: { token: 'f' }, ip: '198.51.100.1' })).status, 404);
});

test('guardia: con miles de IPs distintas el registro se poda solo', async () => {
  let n = 0;
  const { llamar, reportes } = armar({ clientIp: () => '10.0.' + Math.floor(n / 250) + '.' + (n++ % 250) });
  for (let i = 0; i < 5005; i++) await llamar('GET /api/salas/web/:token', { params: { token: 't' } });
  assert.equal(reportes.length, 0);
});

test('rate limit del enlace: usa la IP del proxy y contesta 429 en español', async () => {
  const { ipKeyGenerator } = require('express-rate-limit');
  let opciones;
  const { rutas } = armar({ rateLimit: (o) => { opciones = o; return function limitador() {}; }, clientIp: () => '2001:db8::1' });
  assert.equal(typeof rutas['MW POST /api/salas/web/:token/session'], 'function');
  assert.equal(opciones.keyGenerator({ ip: '1.1.1.1' }), ipKeyGenerator('2001:db8::1'), 'manda la IP del proxy, no req.ip');
  let st, js;
  opciones.handler({}, { status(x) { st = x; return this; }, json(j) { js = j; } });
  assert.equal(st, 429);
  assert.match(js.error, /Demasiados intentos/);
  // Sin clientIp (o sin IP del proxy) cae a req.ip, y sin nada a la cadena vacía.
  armar({ rateLimit: (o) => { opciones = o; return () => {}; }, clientIp: () => '' });
  assert.equal(opciones.keyGenerator({ ip: '1.2.3.4' }), '1.2.3.4');
  armar({ rateLimit: (o) => { opciones = o; return () => {}; } });
  assert.equal(opciones.keyGenerator({}), '');
});

test('sesión de invitado: tope, sala cerrada, nombre saneado, base caída y rollback', async () => {
  let vivos = 0;
  let sala = { ...SALA, web_token: 'TOK', video: true, tenant_id: null };
  const { llamar, endpoints, sql } = armar({
    q: (s, a) => {
      if (/WHERE web_token=\$1/.test(s) && /SELECT id, name/.test(s)) return { rows: a[0] === 'TOK' ? [sala] : [] };
      if (/count\(\*\)::int AS n FROM pbxng_c2c_sessions/.test(s)) return { rows: vivos === null ? [] : [{ n: vivos }] };
      return undefined;
    },
  });
  const ses = (body) => llamar('POST /api/salas/web/:token/session', { params: { token: 'TOK' }, body });
  vivos = 40;
  assert.equal((await ses({})).status, 429);
  vivos = null;
  sala = { ...sala, agenda_inicio: new Date(Date.now() + 3600000).toISOString(), agenda_min: 30 };
  assert.equal((await ses({})).status, 409, 'agendada para dentro de una hora');
  sala = { ...sala, agenda_inicio: null };
  const r = await ses({ name: '<script>Ana</script>' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.video, r.json.sala], [true, 'Directorio']);
  assert.deepEqual(endpoints[0].slice(4), [1, true, 1], 'tenant por defecto y video');
  const cid = sql.find((x) => /INSERT INTO extensions/.test(x.q) && /CALLERID/.test(x.args[4]));
  assert.equal(cid.args[4], 'CALLERID(name)=scriptAnascript');
  const anon = await ses({ name: '<<>>' });
  assert.equal(anon.status, 200);
  assert.ok(sql.some((x) => /INSERT INTO extensions/.test(x.q) && x.args[4] === 'CALLERID(name)=Invitado'));
  assert.equal((await armar({ connectFalla: true }).llamar('POST /api/salas/web/:token/session', { params: { token: 'TOK' } })).status, 503);
  const mal = armar({ q: (s) => (/WHERE web_token=\$1/.test(s) ? { rows: [SALA] } : /INSERT INTO pbxng_c2c_sessions/.test(s) || s === 'ROLLBACK' ? pgCaida() : undefined) });
  assert.equal((await mal.llamar('POST /api/salas/web/:token/session', { params: { token: 'T' }, body: {} })).status, 503);
});

test('moderar desde el panel: 404, crea el enlace si falta, nombre por defecto y base caída', async () => {
  const { llamar, sql } = armar({ q: (s, a) => (/SELECT id, name/.test(s) && /WHERE name=\$1/.test(s) ? { rows: a[0] === 'directorio' ? [{ ...SALA, label: null, tenant_id: null }] : [] } : undefined) });
  assert.equal((await llamar('POST /api/salas/:name/moderar', { params: { name: 'nada' } })).status, 404);
  const r = await llamar('POST /api/salas/:name/moderar', { params: { name: 'directorio' } });
  assert.match(r.json.url, /^\/sala\/[A-Za-z0-9_-]+\?e=[0-9a-f]{24}$/);
  assert.equal(r.json.sala, 'directorio');
  assert.ok(sql.some((x) => /UPDATE pbxng_conferences SET web_token=\$2/.test(x.q)), 'sin enlace previo se crea uno');
  assert.ok(sql.some((x) => /INSERT INTO extensions/.test(x.q) && x.args[4] === 'CALLERID(name)=Moderador'));
  const con = armar({ q: (s) => (/SELECT id, name/.test(s) ? { rows: [{ ...SALA, web_token: 'YA' }] } : undefined) });
  const r2 = await con.llamar('POST /api/salas/:name/moderar', { params: { name: 'directorio' }, user: { username: 'ana' } });
  assert.match(r2.json.url, /^\/sala\/YA\?e=/);
  assert.ok(!con.sql.some((x) => /SET web_token=\$2/.test(x.q)));
  assert.ok(con.sql.some((x) => x.args && x.args[4] === 'CALLERID(name)=ana'));
  assert.equal((await armar({ connectFalla: true }).llamar('POST /api/salas/:name/moderar', { params: { name: 'x' } })).status, 503);
  const mal = armar({ q: (s) => (/SELECT id, name/.test(s) ? { rows: [SALA] } : /INSERT INTO pbxng_c2c_sessions/.test(s) || s === 'ROLLBACK' ? pgCaida() : undefined) });
  assert.equal((await mal.llamar('POST /api/salas/:name/moderar', { params: { name: 'x' } })).status, 503);
});

test('entrada de un solo uso: meta ilegible, sala borrada y base caída', async () => {
  let ses = { guest_ext: 'c2cabc', dial_exten: '8123456', meta: '{roto' };
  let salaFila = [];
  const { llamar } = armar({
    q: (s) => {
      if (/UPDATE pbxng_c2c_sessions SET meta/.test(s)) return { rows: ses ? [ses] : [] };
      if (/SELECT label, name, video FROM pbxng_conferences/.test(s)) return { rows: salaFila };
      return undefined;
    },
  });
  const r = await llamar('POST /api/salas/entrada/:id', { params: { id: 'x' } });
  assert.deepEqual([r.json.moderador, r.json.video, r.json.sala, r.json.ext], [false, false, '', 'c2cabc']);
  ses = { ...ses, meta: null };
  salaFila = [{ label: null, name: 'directorio', video: true }];
  const r2 = await llamar('POST /api/salas/entrada/:id', { params: { id: 'x' } });
  assert.deepEqual([r2.json.sala, r2.json.video], ['directorio', true]);
  ses = { ...ses, meta: '{"sala":"directorio","moderar":true}' };
  salaFila = [{ label: 'Dir', name: 'directorio', video: false }];
  assert.equal((await llamar('POST /api/salas/entrada/:id', { params: { id: 'x' } })).json.moderador, true);
  assert.equal((await armar({ q: () => pgCaida() }).llamar('POST /api/salas/entrada/:id', { params: { id: 'x' } })).status, 503);
});

/* ── Historial ────────────────────────────────────────────────────────────*/

test('historial por eventos AMI: reunión nueva o retomada, presencias y cierre', async () => {
  let abierta = null;
  const { ami, sql, avisos } = armar({
    q: (s, a) => {
      if (/SELECT grabar FROM pbxng_conferences/.test(s)) return { rows: a[0] === 'directorio' ? [{ grabar: true }] : [] };
      if (/SELECT id FROM pbxng_conf_reuniones/.test(s)) return { rows: abierta ? [{ id: abierta }] : [] };
      if (/INSERT INTO pbxng_conf_reuniones/.test(s)) return { rows: [{ id: 77 }] };
      if (/INSERT INTO pbxng_conf_presencias/.test(s) && a[2] === 'ROMPE') return pgCaida();
      return undefined;
    },
  });
  ami.emit('managerevent', { event: 'ConfbridgeJoin', conference: 'directorio', channel: 'PJSIP/c2cab-1', calleridnum: 'c2cab', admin: 'Yes' });
  await tandas();
  ami.emit('managerevent', { Event: 'ConfbridgeJoin', Conference: 'directorio', Channel: 'PJSIP/1001-2' });
  await tandas();
  const pres = sql.filter((x) => /INSERT INTO pbxng_conf_presencias/.test(x.q)).map((x) => x.args);
  assert.deepEqual(pres[0].slice(0, 7), [77, 'directorio', 'PJSIP/c2cab-1', null, 'c2cab', true, true]);
  assert.deepEqual(pres[1].slice(3, 7), [null, null, false, false]);
  assert.equal(sql.filter((x) => /INSERT INTO pbxng_conf_reuniones/.test(x.q)).length, 1, 'la segunda entrada usa la reunión en memoria');
  ami.emit('managerevent', { event: 'ConfbridgeJoin', conference: 'ajena', channel: 'X' });
  ami.emit('managerevent', { event: 'ConfbridgeJoin', conference: 'directorio' });
  ami.emit('managerevent', { event: 'ConfbridgeJoin', conference: 'directorio', channel: 'ROMPE' });
  ami.emit('managerevent', { event: 'ConfbridgeLeave', channel: 'PJSIP/1001-2' });
  ami.emit('managerevent', { event: 'ConfbridgeLeave' });
  ami.emit('managerevent', { event: 'ConfbridgeEnd', conference: 'directorio' });
  ami.emit('managerevent', { event: 'ConfbridgeEnd' });
  ami.emit('managerevent', null);
  ami.emit('managerevent', { event: 'Otro' });
  await tandas();
  assert.ok(avisos.some((a) => /no se pudo anotar una entrada/.test(a[0])));
  assert.ok(sql.some((x) => /SET salio=now\(\) WHERE canal=\$1/.test(x.q) && x.args[0] === 'PJSIP/1001-2'));
  const fin = sql.find((x) => /SET fin=now\(\) WHERE id=\$1/.test(x.q));
  assert.deepEqual(fin.args, [77]);
  // Fin de una reunión que no está en memoria (reinicio): se cierra por sala.
  abierta = 5;
  ami.emit('managerevent', { event: 'ConfbridgeEnd', conference: 'otra' });
  await tandas();
  assert.ok(sql.some((x) => /SET fin=now\(\) WHERE sala=\$1 AND fin IS NULL/.test(x.q) && x.args[0] === 'otra'));
  // Retomada desde la base tras un reinicio (la entrada ROMPE, asíncrona, había reabierto una en memoria).
  ami.emit('managerevent', { event: 'ConfbridgeEnd', conference: 'directorio' });
  await tandas();
  ami.emit('managerevent', { event: 'ConfbridgeJoin', conference: 'directorio', channel: 'PJSIP/1002-3' });
  await tandas();
  assert.equal(sql.filter((x) => /INSERT INTO pbxng_conf_presencias/.test(x.q)).at(-1).args[0], 5);
});

test('historial: la base caída en salida, fin y cierre de colgadas sólo deja aviso', async () => {
  const { ami, avisos } = armar({ q: () => pgCaida() });
  ami.emit('managerevent', { event: 'ConfbridgeLeave', channel: 'X' });
  ami.emit('managerevent', { event: 'ConfbridgeEnd', conference: 'directorio' });
  await tandas();
  for (const txt of [/anotar una salida/, /cerrar la reunión/, /cerrar las colgadas/]) assert.ok(avisos.some((a) => txt.test(a[0])), String(txt));
  const ok = armar({ q: (s) => (/fin_estimado=true WHERE fin IS NULL/.test(s) ? { rowCount: 2 } : undefined) });
  await tandas();
  void ok;
});

test('historial por la API: vacío, con participantes agrupados, límite y base caída', async () => {
  const { llamar, sql } = armar({
    q: (s, a) => {
      if (/FROM pbxng_conf_reuniones WHERE sala=\$1/.test(s)) return { rows: a[0] === 'directorio' ? [{ id: 1 }, { id: 2 }] : [] };
      if (/FROM pbxng_conf_presencias WHERE reunion_id = ANY/.test(s)) return { rows: [{ reunion_id: 1, quien: 'a' }, { reunion_id: 1, quien: 'b' }] };
      return undefined;
    },
  });
  assert.deepEqual((await llamar('GET /api/salas/:name/historial', { params: { name: 'nada' }, query: { limite: '500' } })).json, []);
  assert.equal(sql.find((x) => /FROM pbxng_conf_reuniones WHERE sala=\$1/.test(x.q)).args[1], 100, 'el límite se topa en 100');
  const h = (await llamar('GET /api/salas/:name/historial', { params: { name: 'directorio' } })).json;
  assert.deepEqual(h.map((r) => r.participantes.length), [2, 0]);
  assert.equal((await armar({ q: () => pgCaida() }).llamar('GET /api/salas/:name/historial', { params: { name: 'x' } })).status, 503);
});

test('arranque: a los 9 s se vuelca la AstDB y después se republica; un fallo queda en el log', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const orden = [];
  const { avisos } = armar({
    q: (s) => {
      if (/SELECT name, pin, pin_mod/.test(s)) { orden.push('sync'); return { rows: [] }; }
      if (/SELECT id, name, label/.test(s) && /FROM pbxng_conferences$/.test(s)) { orden.push('republicar'); return pgCaida(); }
      return undefined;
    },
  });
  t.mock.timers.tick(9000);
  await tandas();
  assert.deepEqual(orden, ['sync', 'republicar']);
  assert.ok(avisos.some((a) => a[0] === 'republicar salas'));
});

test('historial: dos que entran a la vez no parten la reunión en dos (carrera vista en la suite, 07/10)', async () => {
  /* Al arrancar una reunión entran varios casi juntos. Si cada entrada busca la reunión en
   * la base por su cuenta, las dos ven «no hay ninguna abierta» y crean una cada una: el
   * historial muestra dos reuniones de pico 1 en vez de una de pico 2. */
  let n = 0;
  const { ami, sql } = armar({
    q: async (s, a) => {
      if (/SELECT grabar FROM pbxng_conferences/.test(s)) return { rows: [{ grabar: false }] };
      if (/SELECT id FROM pbxng_conf_reuniones/.test(s)) { await new Promise((r) => setTimeout(r, 5)); return { rows: [] }; }
      if (/INSERT INTO pbxng_conf_reuniones/.test(s)) return { rows: [{ id: 100 + (++n) }] };
      return undefined;
    },
  });
  ami.emit('managerevent', { event: 'ConfbridgeJoin', conference: 'directorio', channel: 'PJSIP/2001-1', calleridnum: '2001' });
  ami.emit('managerevent', { event: 'ConfbridgeJoin', conference: 'directorio', channel: 'PJSIP/2002-2', calleridnum: '2002' });
  await new Promise((r) => setTimeout(r, 30));
  await tandas();
  assert.equal(sql.filter((x) => /INSERT INTO pbxng_conf_reuniones/.test(x.q)).length, 1, 'se crearon dos reuniones');
  const ids = sql.filter((x) => /INSERT INTO pbxng_conf_presencias/.test(x.q)).map((x) => x.args[0]);
  assert.deepEqual(ids, [101, 101]);
});

test('historial: si no se puede abrir la reunión, la próxima entrada lo vuelve a intentar', async () => {
  let falla = true;
  const { ami, sql } = armar({
    q: (s) => {
      if (/SELECT grabar FROM pbxng_conferences/.test(s)) return { rows: [{ grabar: false }] };
      if (/SELECT id FROM pbxng_conf_reuniones/.test(s)) return falla ? pgCaida() : { rows: [] };
      if (/INSERT INTO pbxng_conf_reuniones/.test(s)) return { rows: [{ id: 9 }] };
      return undefined;
    },
  });
  ami.emit('managerevent', { event: 'ConfbridgeJoin', conference: 'directorio', channel: 'PJSIP/2001-1' });
  await tandas();
  falla = false;
  ami.emit('managerevent', { event: 'ConfbridgeJoin', conference: 'directorio', channel: 'PJSIP/2002-2' });
  await tandas();
  assert.deepEqual(sql.filter((x) => /INSERT INTO pbxng_conf_presencias/.test(x.q)).map((x) => x.args[0]), [9]);
});
