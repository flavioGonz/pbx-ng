/* ============================================================================
 *  telefonia.js · desvíos, horarios, feriados, modo noche y códigos de función por los
 *  caminos que la prueba de integración (telefonia.test.js) no recorre, con base y AMI
 *  de mentira.
 *
 *  Lo que se fija y por qué:
 *   - Postgres es la fuente de verdad y la AstDB es lo que lee el dialplan. Si el AMI
 *     no toma un cambio, el panel tiene que decirlo (`aviso`) y el volcado del arranque
 *     tiene que dejarlo en el log: si no, la central sigue desviando en silencio.
 *   - Un bucle de desvíos se corta al guardar, aunque se arme en tres pasos.
 *   - El modo noche decide a dónde entra CADA llamada de la calle: forzado > feriado >
 *     horario, y sin horario la central está abierta.
 *   - Los códigos de función se publican todos o ninguno, y el 409 nombra a todos los
 *     que chocan.
 *   - Lo que el teléfono escribe en la AstDB y la API rechaza se revierte desde Postgres.
 *   - Las fallas de la base responden error y no dejan clientes sin devolver.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { appFalsa, poolFalso, errorHttp, loggerFalso, vaciar, hasta } = require('./helpers/tel-ramas-arnes');

function armar(t, extra = {}) {
  // Una prueba puede armar dos módulos (p. ej. uno con exigirExt que niega): el reloj se simula una vez.
  try { t.mock.timers.enable({ apis: ['setTimeout'] }); } catch (e) { if (e.code !== 'ERR_INVALID_STATE') throw e; }
  const app = appFalsa();
  const pool = poolFalso();
  const logger = loggerFalso();
  const ami = { hechas: [], falla: null };
  const tocados = [];
  const regenerados = [];
  const dialplan = [];
  const deps = Object.assign({
    app, pool, logger, errorHttp,
    amiAction: async (a) => { if (ami.falla && ami.falla(a)) throw new Error('AMI caído'); ami.hechas.push(a); return {}; },
    setDialplan: async (c, ctx, exten, rows) => { dialplan.push({ ctx, exten, rows }); },
    exigirExt: () => true,
    clientIp: (req) => req.ip,
    agentToken: 'secreto',
    broadcastSoon: () => {},
    regenerarEntrantes: async (f) => { regenerados.push(f); },
    estadoTocado: (ext) => tocados.push(ext),
  }, extra);
  const mod = require('../telefonia')(deps);
  return { app, pool, logger, ami, tocados, regenerados, dialplan, mod };
}

/* Tabla pbxng_ext_features en memoria: lo que se guarda se vuelve a leer. */
function features(pool, inicial = {}) {
  const filas = Object.assign({}, inicial);
  pool.cuando(/SELECT \* FROM pbxng_ext_features WHERE ext=\$1/, (a) => (filas[a[0]] ? [filas[a[0]]] : []));
  pool.cuando(/SELECT cfu, cfb, cfnr, fm FROM pbxng_ext_features WHERE ext=\$1/, (a) => (filas[a[0]] ? [filas[a[0]]] : []));
  pool.cuando(/INSERT INTO pbxng_ext_features/, (a) => { filas[a[0]] = { ext: a[0], dnd: a[1], cfu: a[2], cfb: a[3], cfnr: a[4], fm: a[5], fm_seg: a[6] }; return []; });
  return filas;
}

test('arranque sin lo opcional: sin logger, sin estadoTocado, sin token y con API_URL sin esquema', async (t) => {
  const antes = process.env.AST_API_URL;
  process.env.AST_API_URL = '10.1.2.3:3000/';
  t.after(() => { if (antes === undefined) delete process.env.AST_API_URL; else process.env.AST_API_URL = antes; });
  const { mod, app, pool } = armar(t, { logger: undefined, estadoTocado: undefined, agentToken: undefined, regenerarEntrantes: undefined });
  const f = mod.filasCodigo('dnd_on', '*78').map((r) => r[2]).join('\n');
  assert.match(f, /CURL\(http:\/\/10\.1\.2\.3:3000\/api\/internal\/feature,/, 'sin esquema se le pone http://');
  assert.doesNotMatch(f, /tok=/, 'sin token no viaja ninguno');
  features(pool);
  const r = await app.pedir('PUT', '/api/extensions/:ext/features', { params: { ext: '1001' }, body: { dnd: true } });
  assert.equal(r.json.dnd, true, 'sin estadoTocado guarda igual');
  // Sin regenerarEntrantes (pruebas que arman el módulo a mano) cambiar un horario no rompe.
  pool.cuando(/UPDATE pbxng_horarios/, [{ id: 1 }]);
  assert.equal((await app.pedir('PUT', '/api/horarios/:id', { params: { id: '1' }, body: {} })).status, 200);
});

test('volcado Postgres → AstDB al arrancar: completo, incompleto y con la base caída', async (t) => {
  await t.test('completo: internos, feriados de las tres formas y modo noche', async (t) => {
    const { pool, ami, logger } = armar(t);
    pool.cuando(/SELECT \* FROM pbxng_ext_features$/, [{ ext: '1001', dnd: true, cfu: '1002', fm: '099', fm_seg: null }]);
    pool.cuando(/SELECT md, fecha, anual FROM pbxng_feriados/, [
      { anual: true, md: '05-01' },
      { anual: true, md: null, fecha: new Date(2026, 6, 18) },
      { anual: false, fecha: new Date(2026, 9, 12) },
      { anual: false, fecha: null },                         // sin fecha: no hay clave que escribir
    ]);
    t.mock.timers.tick(9000);
    await hasta(() => logger.lineas.some((l) => /volcado/.test(l.msg)));
    const claves = ami.hechas.filter((a) => a.Action === 'DBPut').map((a) => a.Family + '/' + a.Key + '=' + a.Val);
    assert.deepEqual(claves, ['dnd/1001=1', 'cfu/1001=1002', 'fm/1001=099', 'fmt/1001=15', 'hol/05-01=1', 'hol/07-18=1', 'hol/2026-10-12=1', 'nightmode/modo=auto']);
    assert.deepEqual(ami.hechas.filter((a) => a.Action === 'DBDel').map((a) => a.Family), ['cfb', 'cfnr']);
    assert.ok(logger.lineas.some((l) => l.nivel === 'info'));
  });
  await t.test('con el AMI caído queda un warn con la cuenta', async (t) => {
    const { pool, ami, logger } = armar(t);
    pool.cuando(/SELECT \* FROM pbxng_ext_features$/, [{ ext: '1001', dnd: false }]);
    pool.cuando(/SELECT md, fecha, anual FROM pbxng_feriados/, [{ anual: true, md: '01-01' }]);
    ami.falla = () => true;
    t.mock.timers.tick(9000);
    await hasta(() => logger.lineas.some((l) => l.nivel === 'warn'));
    assert.ok(logger.lineas.some((l) => l.nivel === 'warn' && /incompleto/.test(l.msg)));
    assert.ok(logger.lineas.filter((l) => l.nivel === 'error' && /AstDB/.test(l.msg)).length >= 6, 'cada clave perdida queda nombrada');
  });
  await t.test('con la base caída es un error, no una excepción suelta', async (t) => {
    const { pool, logger } = armar(t);
    pool.cuando(/SELECT \* FROM pbxng_ext_features$/, new Error('sin base'));
    t.mock.timers.tick(9000);
    await hasta(() => logger.lineas.length > 0);
    assert.match(logger.lineas[0].msg, /syncFeatures: sin base/);
  });
});

test('desvíos y DND del interno: validación, alcance, bucles y AMI caído', async (t) => {
  const { app, pool, ami, tocados } = armar(t);
  const filas = features(pool);
  const put = (ext, body) => app.pedir('PUT', '/api/extensions/:ext/features', { params: { ext }, body });

  assert.equal((await app.pedir('GET', '/api/extensions/:ext/features', { params: { ext: 'a b' } })).status, 400);
  assert.equal((await app.pedir('GET', '/api/extensions/:ext/features', { params: {} })).status, 400);
  assert.equal((await put('a;b', {})).status, 400);
  assert.deepEqual((await app.pedir('GET', '/api/extensions/:ext/features', { params: { ext: '1001' } })).json,
    { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '', fm_seg: 15 }, 'sin fila: todo apagado');

  // Sin cuerpo no cambia nada; null en un destino lo borra; fm_seg se acota.
  assert.equal((await put('1001', undefined)).status, 200);
  const r = await put('1001', { cfu: null, cfb: 2000, fm: '099', fm_seg: 500 });
  assert.deepEqual([r.json.cfu, r.json.cfb, r.json.fm_seg], ['', '2000', 120]);
  assert.deepEqual(tocados.slice(-1), ['1001']);
  assert.equal((await put('1001', { fm_seg: 'x' })).json.fm_seg, 15);
  assert.equal(filas['1001'].cfu, null, 'un destino vacío se guarda como NULL');

  // Bucle armado en tres pasos: 1001 → 1002 → 1003 → 1001. 1002 además va a un celular.
  filas['1002'] = { ext: '1002', cfu: '1003', cfb: '099111', cfnr: '1003', fm: null };
  filas['1003'] = { ext: '1003', cfu: null, cfb: null, cfnr: null, fm: '1001' };
  const bucle = await put('1001', { cfnr: '1002' });
  assert.equal(bucle.status, 400);
  assert.match(bucle.json.error, /1001 → 1002 → 1003 → 1001/);
  // Reenviar el mismo destino que ya estaba (cfb=2000) no siembra nada.
  filas['2000'] = { ext: '2000', cfu: '1001' };
  assert.equal((await put('1001', { cfb: '2000', dnd: true })).status, 200, 'un ciclo heredado no impide prender el DND');

  // El AMI caído: se guarda en la base y se avisa.
  ami.falla = (a) => a.Family === 'dnd';
  const av = await put('1001', { dnd: false });
  assert.match(av.json.aviso, /Asterisk no tomó el cambio/);
  ami.falla = null;

  pool.cuando(/SELECT \* FROM pbxng_ext_features WHERE ext=\$1/, new Error('caída'));
  assert.equal((await app.pedir('GET', '/api/extensions/:ext/features', { params: { ext: '1001' } })).status, 500);
  assert.equal((await put('1001', { dnd: true })).status, 500);

  const prohibido = armar(t, { exigirExt: (req, res) => { res.status(403).json({ error: 'no' }); return false; } }).app;
  assert.equal((await prohibido.pedir('GET', '/api/extensions/:ext/features', { params: { ext: '1001' } })).status, 403);
  assert.equal((await prohibido.pedir('PUT', '/api/extensions/:ext/features', { params: { ext: '1001' }, body: {} })).status, 403);
});

test('horarios: tramos validados, regenerar las rutas entrantes y el horario del modo noche', async (t) => {
  const { app, pool, regenerados, logger } = armar(t);
  const alta = (body) => app.pedir('POST', '/api/horarios', { body });
  pool.cuando(/INSERT INTO pbxng_horarios/, (a) => [{ id: 1, nombre: a[0], tramos: JSON.parse(a[1]), activo: a[2] }]);

  assert.match((await alta({ tramos: 'lunes' })).json.error, /lista/);
  assert.match((await alta({ tramos: Array(21).fill({ desde: '09:00', hasta: '10:00' }) })).json.error, /máximo 20/);
  assert.match((await alta({ tramos: [null] })).json.error, /horas inválidas/, 'un tramo nulo no tiene horas');
  assert.match((await alta({ tramos: [{ dias: 'lunes', desde: '09:00', hasta: '18:00' }] })).json.error, /días inválidos/);
  assert.match((await alta({ tramos: [{ dias: 'mon', desde: '9:00', hasta: '18:00' }] })).json.error, /horas/);
  const ok = await alta({ tramos: [{ dias: ' MON-FRI ', desde: '09:00', hasta: '18:00' }, { desde: '10:00', hasta: '12:00' }], activo: false });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json, { id: 1, nombre: 'Horario', tramos: [{ dias: 'mon-fri', desde: '09:00', hasta: '18:00' }, { dias: '*', desde: '10:00', hasta: '12:00' }], activo: false });
  assert.equal((await alta(undefined)).status, 201, 'sin cuerpo: un horario vacío');

  const put = (id, body) => app.pedir('PUT', '/api/horarios/:id', { params: { id }, body });
  assert.equal((await put('9', { nombre: 'x' })).status, 404);
  pool.cuando(/UPDATE pbxng_horarios/, (a) => [{ id: a[0], nombre: a[1], tramos: a[2], activo: a[3] }]);
  const e = await put('3', { nombre: 'Oficina', tramos: [{ dias: '*', desde: '08:00', hasta: '17:00' }], activo: 0 });
  assert.deepEqual([e.json.nombre, e.json.activo], ['Oficina', false]);
  assert.deepEqual(regenerados.pop(), { horario_id: 3 });
  const sin = await put('3', undefined);
  assert.deepEqual([sin.json.nombre, sin.json.tramos, sin.json.activo], [null, null, null], 'lo que no viene no se pisa');
  // Si regenerar las rutas falla, el horario queda guardado y la falla en el log.
  const roto = armar(t, { regenerarEntrantes: async () => { throw new Error('trunks caído'); } });
  roto.pool.cuando(/UPDATE pbxng_horarios/, [{ id: 3 }]);
  assert.equal((await roto.app.pedir('PUT', '/api/horarios/:id', { params: { id: '3' }, body: {} })).status, 200);
  assert.ok(roto.logger.lineas.some((l) => /regenerar rutas entrantes: trunks caído/.test(l.msg)));

  // Borrar: 404, el que usaba el modo noche lo suelta, y el que no, no lo toca.
  assert.equal((await app.pedir('DELETE', '/api/horarios/:id', { params: { id: '5' } })).status, 404);
  pool.cuando(/DELETE FROM pbxng_horarios/, { rowCount: 1 });
  pool.cuando(/key=\$1/, (a) => (a[0] === 'nightmode_horario_id' ? [{ value: '5' }] : []));
  pool.llamadas.length = 0;
  assert.deepEqual((await app.pedir('DELETE', '/api/horarios/:id', { params: { id: '5' } })).json, { deleted: 5 });
  assert.deepEqual(pool.hechas(/INSERT INTO pbxng_settings/).map((q) => q.args), [['nightmode_horario_id', '']]);
  pool.llamadas.length = 0;
  await app.pedir('DELETE', '/api/horarios/:id', { params: { id: '6' } });
  assert.equal(pool.hechas(/INSERT INTO pbxng_settings/).length, 0);

  for (const re of [/FROM pbxng_horarios ORDER BY id/, /INSERT INTO pbxng_horarios/, /UPDATE pbxng_horarios/, /DELETE FROM pbxng_horarios/]) pool.cuando(re, new Error('caída'));
  assert.equal((await app.pedir('GET', '/api/horarios')).status, 500);
  assert.equal((await alta({ tramos: [] })).status, 500);
  assert.equal((await put('3', {})).status, 500);
  assert.equal((await app.pedir('DELETE', '/api/horarios/:id', { params: { id: '5' } })).status, 500);
  void logger;
});

test('feriados: anuales y puntuales, la clave de la AstDB al editar y al borrar', async (t) => {
  const { app, pool, ami } = armar(t);
  const alta = (body) => app.pedir('POST', '/api/feriados', { body });
  /* pg devuelve una columna DATE como medianoche LOCAL: así la arma también el falso. */
  const fechaPg = (s) => (s ? new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : null);
  pool.cuando(/INSERT INTO pbxng_feriados/, (a) => [{ id: 1, md: a[0], fecha: fechaPg(a[1]), nombre: a[2], anual: a[3] }]);
  const puts = () => ami.hechas.filter((a) => a.Action === 'DBPut').map((a) => a.Key);
  const dels = () => ami.hechas.filter((a) => a.Action === 'DBDel').map((a) => a.Key);

  assert.match((await alta({ fecha: '1/5/2026' })).json.error, /fecha inválida/);
  assert.match((await alta(undefined)).json.error, /feriado anual/);
  assert.match((await alta({ md: '13-01' })).json.error, /MM-DD/);
  assert.match((await alta({ anual: false })).json.error, /puntual/);
  const a = await alta({ fecha: '2026-05-01', nombre: '' });
  assert.deepEqual([a.json.md, a.json.nombre], ['05-01', null], 'anual con fecha: el MM-DD sale de la fecha');
  const p = await alta({ anual: false, fecha: '2026-10-12', md: '10-12', nombre: 'Diversidad' });
  assert.deepEqual([p.json.md, p.json.fecha.getDate()], [null, 12]);
  assert.deepEqual(puts(), ['05-01', '2026-10-12']);

  const put = (id, body) => app.pedir('PUT', '/api/feriados/:id', { params: { id }, body });
  assert.equal((await put('9', {})).status, 404);
  pool.cuando(/SELECT id,md,fecha,anual FROM pbxng_feriados WHERE id/, [{ id: 2, md: '05-01', fecha: null, anual: true }]);
  assert.match((await put('2', { md: '5-1' })).json.error, /md inválido/);
  assert.match((await put('2', { fecha: '2026/1/1' })).json.error, /fecha inválida/);
  let despues = { id: 2, md: '05-02', fecha: null, anual: true };
  pool.cuando(/UPDATE pbxng_feriados/, () => [despues]);
  await put('2', { md: '05-02', nombre: 'x', anual: 1 });
  assert.deepEqual([dels().pop(), puts().pop()], ['05-01', '05-02'], 'cambiar el día borra la clave vieja');
  ami.hechas.length = 0;
  despues = { id: 2, md: '05-01', fecha: null, anual: true };
  await put('2', { fecha: '' });
  assert.deepEqual([dels(), puts()], [[], ['05-01']], 'misma clave: no se borra');
  ami.hechas.length = 0;
  // Uno puntual al que se le sacó la fecha: no queda clave que escribir.
  pool.cuando(/SELECT id,md,fecha,anual FROM pbxng_feriados WHERE id/, [{ id: 3, md: null, fecha: null, anual: false }]);
  despues = { id: 3, md: null, fecha: null, anual: false };
  await put('3', {});
  assert.deepEqual([dels(), puts()], [[], []]);

  assert.equal((await app.pedir('DELETE', '/api/feriados/:id', { params: { id: '9' } })).status, 404);
  pool.cuando(/DELETE FROM pbxng_feriados/, [{ id: 3, md: null, fecha: null, anual: false }]);
  assert.deepEqual((await app.pedir('DELETE', '/api/feriados/:id', { params: { id: '3' } })).json, { deleted: 3 });
  assert.deepEqual(dels(), [], 'sin clave no hay nada que borrar en la AstDB');
  pool.cuando(/DELETE FROM pbxng_feriados/, [{ id: 4, md: '12-25', anual: true }]);
  await app.pedir('DELETE', '/api/feriados/:id', { params: { id: '4' } });
  assert.deepEqual(dels(), ['12-25']);

  for (const re of [/FROM pbxng_feriados ORDER BY/, /INSERT INTO pbxng_feriados/, /SELECT id,md,fecha,anual FROM pbxng_feriados/, /DELETE FROM pbxng_feriados/]) pool.cuando(re, new Error('caída'));
  assert.equal((await app.pedir('GET', '/api/feriados')).status, 500);
  assert.equal((await alta({ md: '01-01' })).status, 500);
  assert.equal((await put('2', {})).status, 500);
  assert.equal((await app.pedir('DELETE', '/api/feriados/:id', { params: { id: '4' } })).status, 500);
});

test('tramoAhora: días, rangos que dan la vuelta y tramos que cruzan medianoche', (t) => {
  const { mod } = armar(t);
  const lun10 = new Date(2026, 9, 5, 10, 0);   // lunes 5/10/2026 10:00
  const dom23 = new Date(2026, 9, 4, 23, 30);  // domingo 23:30
  assert.equal(mod.tramoAhora(null, lun10), false);
  assert.equal(mod.tramoAhora([null, { desde: '9', hasta: '10:00' }, { desde: '09:00' }], lun10), false, 'tramos rotos se ignoran');
  assert.equal(mod.tramoAhora([{ desde: '09:00', hasta: '18:00' }], lun10), true, 'sin días = todos');
  assert.equal(mod.tramoAhora([{ dias: 'mon-fri', desde: '09:00', hasta: '18:00' }], lun10), true);
  assert.equal(mod.tramoAhora([{ dias: 'tue', desde: '09:00', hasta: '18:00' }], lun10), false);
  assert.equal(mod.tramoAhora([{ dias: 'fri-mon', desde: '09:00', hasta: '18:00' }], lun10), true, 'el rango da la vuelta a la semana');
  assert.equal(mod.tramoAhora([{ dias: 'fri-mon', desde: '09:00', hasta: '18:00' }], new Date(2026, 9, 7, 10)), false, 'miércoles queda afuera');
  assert.equal(mod.tramoAhora([{ dias: 'lun', desde: '09:00', hasta: '18:00' }], lun10), false, 'un día que no se entiende no entra');
  assert.equal(mod.tramoAhora([{ dias: 'mon-xyz', desde: '09:00', hasta: '18:00' }], lun10), false);
  assert.equal(mod.tramoAhora([{ dias: '*', desde: '22:00', hasta: '06:00' }], dom23), true, 'cruza medianoche');
  assert.equal(mod.tramoAhora([{ dias: '*', desde: '22:00', hasta: '06:00' }], lun10), false);
  assert.equal(typeof mod.tramoAhora([{ desde: '00:00', hasta: '23:59' }]), 'boolean', 'sin fecha usa ahora');
});

test('modo noche: forzado, feriado, horario y el aviso cuando el AMI no lo toma', async (t) => {
  const { app, pool, ami } = armar(t);
  const ajustes = {};
  pool.cuando(/SELECT value FROM pbxng_settings WHERE key=\$1/, (a) => (a[0] in ajustes ? [{ value: ajustes[a[0]] }] : []));
  pool.cuando(/INSERT INTO pbxng_settings/, (a) => { ajustes[a[0]] = a[1]; return []; });
  let feriado = [];
  pool.cuando(/FROM pbxng_feriados WHERE \(anual=true/, () => feriado);
  let horario = null;
  pool.cuando(/FROM pbxng_horarios WHERE/, (a, sql) => { if (/id=\$1/.test(sql)) assert.equal(a[0], 7); return horario ? [horario] : []; });
  const get = async () => (await app.pedir('GET', '/api/nightmode')).json;

  assert.deepEqual(await get(), { modo: 'auto', estado: 'abierto', motivo: 'sin horario configurado', horario_id: null });
  horario = { id: 4, nombre: '', tramos: [{ dias: '*', desde: '00:00', hasta: '23:59' }], activo: false };
  assert.equal((await get()).motivo, 'sin horario configurado', 'un horario inactivo no cierra');
  horario = Object.assign({}, horario, { activo: true, tramos: 'x' });
  assert.equal((await get()).estado, 'abierto');
  horario = Object.assign({}, horario, { tramos: [] });
  assert.equal((await get()).estado, 'abierto');
  horario = Object.assign({}, horario, { tramos: [{ dias: '*', desde: '00:00', hasta: '23:59' }] });
  const d = await get();
  assert.deepEqual([d.estado, d.motivo, d.horario_id], ['abierto', 'dentro del horario 4', 4]);
  horario = Object.assign({}, horario, { nombre: 'Oficina', tramos: [{ dias: '*', desde: '03:00', hasta: '03:00' }] });
  ajustes.nightmode_horario_id = '7';
  const f = await get();
  assert.deepEqual([f.estado, f.motivo], [new Date().getHours() === 3 && new Date().getMinutes() === 0 ? 'abierto' : 'cerrado', (new Date().getHours() === 3 && new Date().getMinutes() === 0 ? 'dentro' : 'fuera') + ' del horario Oficina']);
  feriado = [{ nombre: null }];
  assert.deepEqual((await get()).motivo, 'feriado');
  feriado = [{ nombre: 'Navidad' }];
  const fe = await get();
  assert.deepEqual([fe.estado, fe.motivo, fe.horario_id], ['cerrado', 'feriado: Navidad', 7], 'el horario del modo noche se informa igual');

  const put = (body) => app.pedir('PUT', '/api/nightmode', { body });
  assert.equal((await put({ modo: 'siempre' })).status, 400);
  ami.falla = () => true;
  const c = await put({ modo: 'cerrado', horario_id: null });
  assert.deepEqual([c.json.estado, c.json.motivo], ['cerrado', 'forzado desde el panel']);
  assert.match(c.json.aviso, /AMI caído/);
  assert.equal(ajustes.nightmode_horario_id, '');
  ami.falla = null;
  const sin = await put(undefined);
  assert.equal(sin.json.aviso, undefined, 'sin modo no se escribe la AstDB ni se avisa');
  await put({ horario_id: 'abc' });
  assert.equal(ajustes.nightmode_horario_id, '');
  await put({ modo: 'abierto', horario_id: '7' });
  assert.equal(ajustes.nightmode_horario_id, '7');
  assert.deepEqual(ami.hechas.pop(), { Action: 'DBPut', Family: 'nightmode', Key: 'modo', Val: 'abierto' });

  pool.cuando(/INSERT INTO pbxng_settings/, new Error('caída'));
  assert.equal((await put({ modo: 'auto' })).status, 500);
  ajustes.nightmode = 'auto';
  pool.cuando(/FROM pbxng_feriados WHERE \(anual=true/, new Error('caída'));
  assert.equal((await app.pedir('GET', '/api/nightmode')).status, 500);
});

test('códigos de función: dialplan de cada acción y la forma del código', (t) => {
  const { mod } = armar(t);
  const txt = (a, c, n) => mod.filasCodigo(a, c, n).map((r) => r[0] + ' ' + r[1] + ' ' + r[2]).join('\n');
  assert.equal(mod.filasCodigo('inventada', '*1'), null);
  assert.match(txt('cfu_set', '_*21*.'), /FDEST=\$\{FILTER\(0-9,\$\{EXTEN:4\}\)\}/);
  assert.match(txt('cfu_set', '*21*X'), /EXTEN:5\}/, 'patrón sin punto: desde el final del código');
  assert.match(txt('cfu_set', '*21*.'), /EXTEN:4\}/);
  assert.match(txt('dnd_on', '*78', 'No molestar'), /^1 NoOp No molestar \(\*78\)/);
  assert.match(txt('dnd_on', '*78'), /^1 NoOp dnd_on/);
  for (const [accion, marca] of [['dnd_off', 'DB_DELETE\\(dnd'], ['cfu_off', 'accion=off&valor=cfu'], ['cfb_set', 'DB\\(cfb/'], ['cfb_off', 'valor=cfb'],
    ['cfnr_set', 'DB\\(cfnr/'], ['cfnr_off', 'valor=cfnr'], ['fm_set', 'Set\\(DB\\(fmt/\\$\\{MIEXT\\}\\)=15\\)'], ['fm_off', 'DB_DELETE\\(fmt'],
    ['night', 'NMODO=\\$\\{IF'], ['eco', 'Echo'], ['midigito', 'SayDigits \\$\\{CALLERID'], ['vm_propio', 'VoiceMailMain \\$\\{CHANNEL\\(endpoint\\)\\}@'], ['vm_otro', 'VoiceMailMain @']]) {
    assert.match(txt(accion, '*9'), new RegExp(marca), accion);
  }
  assert.match(txt('cfu_off', '*9'), /tok=secreto/, 'el token viaja en cada CURL');
});

test('códigos de función: catálogo, edición, instalación todo-o-nada y desinstalación', async (t) => {
  const { app, pool, dialplan } = armar(t);
  let catalogo = [
    { accion: 'dnd_on', code: '*78', nombre: 'DND', enabled: true },
    { accion: 'cfu_set', code: '*21*.', nombre: null, enabled: true },
    { accion: 'eco', code: '*43', nombre: 'Eco', enabled: false },
    { accion: 'vieja', code: '*99', nombre: 'de otra versión', enabled: true },
  ];
  pool.cuando(/FROM pbxng_featurecodes ORDER BY code/, () => catalogo.map((f) => Object.assign({}, f)));
  pool.cuando(/UPDATE pbxng_featurecodes SET code/, (a) => { const f = catalogo.find((x) => x.accion === a[0]); Object.assign(f, { code: a[1], enabled: a[2] }); if (a[3] != null) f.nombre = a[3]; return []; });
  let instalados = [];
  pool.cuando(/SELECT exten FROM extensions WHERE context='internal' AND exten = ANY/, () => instalados.map((e) => ({ exten: e })));
  pool.cuando(/SELECT 1 FROM extensions WHERE context='internal' AND exten = ANY/, () => instalados.slice(0, 1).map(() => ({})));
  const internos = new Set();
  pool.cuando(/SELECT 1 FROM ps_endpoints WHERE id=\$1/, (a) => (internos.has(a[0]) ? [{}] : []));

  await t.test('catálogo con lo instalado y descripción', async () => {
    instalados = ['*78', '_*21*.'];
    const l = (await app.pedir('GET', '/api/featurecodes')).json;
    assert.deepEqual(l.map((f) => [f.accion, f.installed, f.enabled, f.desc !== '']), [['dnd_on', true, true, true], ['cfu_set', true, true, true], ['eco', false, false, true], ['vieja', false, true, false]]);
  });

  await t.test('edición: formas del cuerpo, validaciones y reescritura de lo instalado', async () => {
    const put = (body) => app.pedir('PUT', '/api/featurecodes', { body });
    assert.equal((await put([])).status, 400);
    assert.equal((await put({ codes: [null] })).json.error, 'acción desconocida: (vacía)');
    assert.equal((await put({ accion: 'nada' })).status, 404);
    assert.match((await put([{ accion: 'dnd_on', code: 'abc' }])).json.error, /código inválido/);
    internos.add('*77');
    assert.equal((await put({ accion: 'dnd_on', code: '*77' })).status, 409, 'no se mueve encima de un interno');
    internos.clear();

    dialplan.length = 0;
    const r = await put({ codes: [{ accion: 'dnd_on', code: '*77', nombre: 'No molestar' }, { accion: 'cfu_set' }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(catalogo[0].code, '*77');
    assert.equal(catalogo[0].nombre, 'No molestar');
    assert.equal(catalogo[1].code, '*21*.', 'sin code se conserva el que tenía');
    assert.deepEqual(dialplan.map((d) => d.exten).sort(), ['*77', '_*21*.'], 'lo instalado se reescribe con el catálogo nuevo; una acción desconocida no inventa dialplan');
    // Sin nada instalado, editar no instala.
    instalados = [];
    dialplan.length = 0;
    await put({ accion: 'eco', enabled: true });
    assert.equal(catalogo[2].enabled, true);
    assert.equal(dialplan.length, 0);
    await put([{ accion: 'eco' }]);
    assert.equal(catalogo[2].enabled, true, 'sin enabled se conserva');
  });

  await t.test('instalar: todos o ninguno, y el 409 nombra a cada uno', async () => {
    catalogo[2].enabled = false;
    dialplan.length = 0;
    const ok = await app.pedir('POST', '/api/featurecodes/install');
    assert.deepEqual(ok.json, { ok: true, count: 3 });
    assert.deepEqual(dialplan.map((d) => d.exten).sort(), ['*77', '_*21*.'], 'el apagado y la acción desconocida no se publican');
    catalogo[2].enabled = true;
    internos.add('*77');
    dialplan.length = 0;
    const uno = await app.pedir('POST', '/api/featurecodes/install');
    assert.equal(uno.status, 409);
    assert.match(uno.json.error, /\*77 «No molestar», que ocupa un interno\. Cambiá ese código/);
    internos.add('*21*.');
    const dos = await app.pedir('POST', '/api/featurecodes/install');
    assert.match(dos.json.error, /\*77 «No molestar».*; \*21\*\. «cfu_set», que ocupa un interno\. Cambiá esos códigos/, 'sin nombre se nombra la acción');
    assert.equal(dialplan.length, 0, 'con un choque no se instala ninguno');
    internos.clear();
  });

  await t.test('desinstalar y fallas de la base', async () => {
    assert.deepEqual((await app.pedir('POST', '/api/featurecodes/uninstall')).json, { ok: true });
    pool.cuando(/FROM pbxng_featurecodes ORDER BY code/, new Error('caída'));
    pool.cuando(/ROLLBACK/, new Error('ni eso'));
    const sueltos = pool.sueltos;
    assert.equal((await app.pedir('GET', '/api/featurecodes')).status, 500);
    assert.equal((await app.pedir('POST', '/api/featurecodes/uninstall')).status, 500);
    assert.equal((await app.pedir('PUT', '/api/featurecodes', { body: { accion: 'eco' } })).status, 500);
    assert.equal((await app.pedir('POST', '/api/featurecodes/install')).status, 500);
    assert.equal(pool.sueltos, sueltos + 2);
    pool.conectar = new Error('sin base');
    assert.equal((await app.pedir('PUT', '/api/featurecodes', { body: { accion: 'eco' } })).status, 500);
    assert.equal((await app.pedir('POST', '/api/featurecodes/install')).status, 500);
  });
});

test('lo que el teléfono le cuenta a la base (POST /api/internal/feature)', async (t) => {
  const { app, pool, ami, logger } = armar(t);
  const filas = features(pool, { 1002: { ext: '1002', cfu: '1001' } });
  const tok = 'secreto';
  const feat = (body, o = {}) => app.pedir('POST', '/api/internal/feature', Object.assign({ body: Object.assign({ tok }, body) }, o));

  assert.equal((await feat({ accion: 'dnd_on', ext: '1001' }, { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 403, 'pasó por un proxy');
  assert.equal((await feat({ accion: 'dnd_on', ext: '1001', tok: 'otro' })).status, 403);
  const n = await feat({ accion: 'night', valor: 'raro' });
  assert.deepEqual(n.json, { ok: true, modo: 'auto' });
  assert.deepEqual((await app.pedir('POST', '/api/internal/feature', { query: { tok, accion: 'night', valor: 'cerrado' } })).json, { ok: true, modo: 'cerrado' }, 'el CURL puede mandar todo por query');
  assert.equal((await feat({ accion: 'dnd_on', ext: 'a b' })).status, 400);
  assert.equal((await feat({ accion: 'cualquiera', ext: '1001' })).status, 400);

  assert.equal((await feat({ accion: 'dnd_on', ext: '1001' })).json.features.dnd, true);
  assert.equal((await feat({ accion: 'cfb', ext: '1001', valor: ' 2000 ' })).json.features.cfb, '2000');
  assert.equal((await feat({ accion: 'off', ext: '1001', valor: 'cfb' })).json.features.cfb, '');
  assert.equal((await feat({ accion: 'off', ext: '1001', valor: 'dnd' })).json.features.dnd, false);
  await feat({ accion: 'fm', ext: '1001', valor: '099' });
  await feat({ accion: 'dnd_on', ext: '1001' });
  const todo = await feat({ accion: 'off', ext: '1001' });
  assert.deepEqual(todo.json.features, { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '', fm_seg: 15 }, 'off sin valor apaga todo');
  assert.equal((await feat({ accion: 'dnd_off', ext: '1001' })).status, 200);

  // El teléfono armó un bucle (1001 → 1002 → 1001): la API lo rechaza y la AstDB vuelve a lo de Postgres.
  ami.hechas.length = 0;
  const b = await feat({ accion: 'cfu', ext: '1001', valor: '1002' });
  assert.equal(b.status, 400);
  assert.ok(ami.hechas.some((a) => a.Action === 'DBDel' && a.Family === 'cfu' && a.Key === '1001'), 'se borra el desvío que el dialplan ya había escrito');
  assert.equal(filas['1001'].cfu, null);
  // Si ni siquiera se puede releer la base para revertir, queda en el log y sale el 400 igual.
  let lecturas = 0;
  pool.cuando(/SELECT \* FROM pbxng_ext_features WHERE ext=\$1/, (a) => { lecturas++; if (lecturas > 1) throw new Error('caída'); return filas[a[0]] ? [filas[a[0]]] : []; });
  assert.equal((await feat({ accion: 'cfu', ext: '1001', valor: 'x1' })).status, 400);
  assert.ok(logger.lineas.some((l) => /no se pudo revertir/.test(l.msg)));
  // Un error que no es de validación (la base) no intenta revertir.
  pool.cuando(/SELECT \* FROM pbxng_ext_features WHERE ext=\$1/, new Error('caída'));
  ami.hechas.length = 0;
  assert.equal((await feat({ accion: 'dnd_on', ext: '1001' })).status, 500);
  assert.equal(ami.hechas.length, 0);
  pool.cuando(/INSERT INTO pbxng_settings/, new Error('caída'));
  assert.equal((await feat({ accion: 'night', valor: 'abierto' })).status, 500);
  await vaciar();
});
