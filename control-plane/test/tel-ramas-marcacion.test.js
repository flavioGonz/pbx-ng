/* ============================================================================
 *  marcacion.js · DISA, callback, directorio por nombre y abreviados por los caminos que
 *  la integración (marcacion.test.js) no recorre, con base y AMI de mentira.
 *
 *  Es el módulo que deja a alguien de AFUERA marcar a la calle pagando la central, así
 *  que lo que se fija acá es sobre todo el lado seguro:
 *   - Las dos rutas que consulta el dialplan (/api/internal/disa y /callback) contestan
 *     "no" ante CUALQUIER cosa rara: la base caída, la DISA apagada, un número vacío, una
 *     ruta que empata con otra, un interno que no se puede consultar.
 *   - El bloqueo por intentos se activa y se mira ANTES de comparar el PIN; en modo pin
 *     del callback el balde es por callback (el CallerID lo elige el atacante).
 *   - El callback tiene cooldown y tope diario: sin eso la central es un amplificador.
 *   - Cada alta pregunta antes de publicar en `internal` (409 si está ocupado) y una
 *     transacción que falla hace ROLLBACK y devuelve el cliente.
 *   - Los abreviados personales: si el AMI no los toma, el usuario se entera (`aviso`).
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { appFalsa, poolFalso, errorHttp, loggerFalso, hasta } = require('./helpers/tel-ramas-arnes');

const PIN = '482915';
const HASH = bcrypt.hashSync(PIN, 4);   // costo bajo: es una prueba, no una base de verdad
const TOK = 'secreto';
const txt = (r) => String(r.json);

function armar(t, extra = {}) {
  try { t.mock.timers.enable({ apis: ['setTimeout'] }); } catch (e) { if (e.code !== 'ERR_INVALID_STATE') throw e; }
  const app = appFalsa();
  const pool = poolFalso();
  const logger = loggerFalso();
  const ami = { hechas: [], falla: null };
  const dialplan = [];
  const deps = Object.assign({
    app, pool, logger, errorHttp,
    amiAction: async (a) => { if (ami.falla && ami.falla(a)) throw new Error('AMI caído'); ami.hechas.push(a); return {}; },
    setDialplan: async (c, ctx, exten, rows) => { dialplan.push({ ctx, exten, rows }); },
    exigirExt: () => true,
    clientIp: (req) => req.ip,
    agentToken: TOK,
    broadcastSoon: () => {},
  }, extra);
  const mod = require('../marcacion')(deps);
  /* Las rutas salientes de la central (para decidir qué ruta cursaría cada número). */
  pool.cuando(/SELECT id, pattern FROM pbxng_outbound_routes$/, [{ id: 1, pattern: '_09XXXXXXX' }, { id: 2, pattern: '_00.' }, { id: 3, pattern: '_2XXXXXXX' }, { id: 4, pattern: '_2[0-9]XXXXXX' }]);
  pool.cuando(/SELECT id FROM pbxng_outbound_routes WHERE id = ANY/, (a) => a[0].filter((x) => x <= 4).map((id) => ({ id })));
  return { app, pool, logger, ami, dialplan, mod };
}

/* El registro de uso: qué evento y con qué motivo quedó cada intento. */
const registro = (pool) => pool.hechas(/INSERT INTO pbxng_marcacion_log/).map((q) => [q.args[3], q.args[5]]);

test('arranque sin logger y con API_URL sin esquema; volcado de abreviados al arrancar', async (t) => {
  const antes = process.env.AST_API_URL;
  process.env.AST_API_URL = 'api.local:3000';
  t.after(() => { if (antes === undefined) delete process.env.AST_API_URL; else process.env.AST_API_URL = antes; });
  await t.test('sin logger: el CURL de la DISA apunta a http://<host> y el volcado no rompe', async (t) => {
    const { mod, pool } = armar(t, { logger: undefined });
    const f = mod.filasDisa({ id: 1 }).map((r) => r[2]).join('\n');
    assert.match(f, /CURL\(http:\/\/api\.local:3000\/api\/internal\/disa,/);
    pool.cuando(/WHERE ext IS NOT NULL$/, new Error('x'));
    t.mock.timers.tick(9000);
  });
  await t.test('volcado completo, incompleto y con la base caída', async (t) => {
    const { pool, ami, logger } = armar(t);
    pool.cuando(/SELECT ext,code,destino FROM pbxng_abreviados WHERE ext IS NOT NULL/, [{ ext: '1001', code: '01', destino: '099' }]);
    t.mock.timers.tick(9000);
    await hasta(() => logger.lineas.length > 0);
    assert.deepEqual(ami.hechas, [{ Action: 'DBPut', Family: 'abrev', Key: '1001-01', Val: '099' }]);
    assert.equal(logger.lineas[0].nivel, 'info');
  });
  await t.test('AMI caído: warn con la cuenta', async (t) => {
    const { pool, ami, logger } = armar(t);
    pool.cuando(/SELECT ext,code,destino FROM pbxng_abreviados WHERE ext IS NOT NULL/, [{ ext: '1001', code: '01', destino: '099' }]);
    ami.falla = () => true;
    t.mock.timers.tick(9000);
    await hasta(() => logger.lineas.some((l) => l.nivel === 'warn'));
    assert.ok(logger.lineas.some((l) => l.nivel === 'error' && /AstDB/.test(l.msg)));
  });
  await t.test('base caída: error en el log', async (t) => {
    const { pool, logger } = armar(t);
    pool.cuando(/SELECT ext,code,destino FROM pbxng_abreviados WHERE ext IS NOT NULL/, new Error('sin base'));
    t.mock.timers.tick(9000);
    await hasta(() => logger.lineas.length > 0);
    assert.match(logger.lineas[0].msg, /syncAbreviados: sin base/);
  });
});

test('rutaGanadora: Z y N compiten por cuántos dígitos aceptan', (t) => {
  const { mod } = armar(t);
  assert.equal(mod.rutaGanadora([{ id: 1, pattern: '_ZXX' }, { id: 2, pattern: '_NXX' }], '345').ruta.id, 2, 'N (8 dígitos) es más específico que Z (9)');
  assert.equal(mod.rutaGanadora([{ id: 1, pattern: '_zX' }, { id: 2, pattern: '_9X' }], '91').ruta.id, 2);
  assert.equal(mod.rutaGanadora([{ id: 1, pattern: '_2' }, { id: 2, pattern: '_2!' }], '2').ruta.id, 1);
});

test('DISA: alta, edición y baja con cada validación y falla', async (t) => {
  const { app, pool, dialplan } = armar(t);
  pool.cuando(/INSERT INTO pbxng_disa/, (a) => [{ id: 5, nombre: a[0], exten: a[1], enabled: a[3], rutas: JSON.parse(a[4]), internos: a[5], callerid: a[6], max_intentos: a[7], bloqueo_min: a[8], dur_seg: a[9], dial_seg: a[10], max_digitos: a[11] }]);
  const alta = (body) => app.pedir('POST', '/api/disa', { body });

  await t.test('validaciones', async () => {
    assert.match((await alta(undefined)).json.error, /extensión de entrada/);
    assert.match((await alta({ exten: '*30', callerid: 'abc' })).json.error, /CallerID/);
    assert.match((await alta({ exten: '*30', rutas: [99] })).json.error, /ruta saliente inexistente: 99/);
    assert.match((await alta({ exten: '*30', enabled: true, rutas: 'todas' })).json.error, /para activar la DISA/);
    assert.match((await alta({ exten: '*30', pin: 'abcd' })).json.error, /de 4 a 12 dígitos/);
    assert.match((await alta({ exten: '*30', pin: '98765' })).json.error, /secuencia/);
  });

  await t.test('alta: topes acotados, PIN que no se puede consultar contra los internos y 409', async () => {
    // Si ps_endpoints no contesta, el PIN no se rechaza por eso (el alta sigue).
    pool.cuando(/SELECT 1 FROM ps_endpoints WHERE id=\$1/, (a) => { if (a[0] === PIN) throw new Error('caída'); return []; });
    const r = await alta({ exten: '*30', pin: PIN, nombre: '', internos: true, enabled: true, callerid: '+598 24',
      max_intentos: 99, bloqueo_min: 0, dur_seg: 5, dial_seg: 'x', max_digitos: 1 });
    assert.equal(r.status, 400, 'el CallerID con espacio adentro no pasa');
    const ok = await alta({ exten: '*30', pin: PIN, nombre: '', internos: true, enabled: true, callerid: '+598',
      max_intentos: 99, bloqueo_min: 0, dur_seg: 5, dial_seg: 'x', max_digitos: 1 });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.deepEqual([ok.json.nombre, ok.json.max_intentos, ok.json.bloqueo_min, ok.json.dur_seg, ok.json.dial_seg, ok.json.max_digitos],
      ['DISA', 10, 15, 30, 60, 3]);
    assert.equal(ok.json.pin_hash, undefined);
    assert.equal(ok.json.tiene_pin, true);
    assert.equal(dialplan.pop().exten, '*30');
    // Apagada: no publica.
    const n = dialplan.length;
    await alta({ exten: '*31', pin: PIN, callerid: '' });
    assert.equal(dialplan.length, n);
    pool.cuando(/SELECT 1 FROM ps_endpoints WHERE id=\$1/, (a) => (a[0] === '*32' ? [{}] : []));
    assert.equal((await alta({ exten: '*32', pin: PIN })).status, 409);
  });

  await t.test('edición y baja', async () => {
    const put = (id, body) => app.pedir('PUT', '/api/disa/:id', { params: { id }, body });
    assert.equal((await put('9', {})).status, 404);
    const viejo = { id: 5, nombre: 'D', exten: '*30', enabled: true, rutas: [1], internos: false, callerid: null, max_intentos: 3, bloqueo_min: 15, dur_seg: 300, dial_seg: 60, max_digitos: 20 };
    pool.cuando(/FROM pbxng_disa WHERE id=\$1$/, [viejo]);
    pool.cuando(/UPDATE pbxng_disa SET/, (a) => [Object.assign({}, viejo, { exten: a[2], enabled: a[3] })]);
    pool.cuando(/SELECT app, appdata FROM extensions WHERE context='internal' AND exten=\$1 AND priority=1/, (a) => [{ app: 'NoOp', appdata: 'DISA x', exten: a[0] }]);
    pool.llamadas.length = 0;
    const r = await put('5', { exten: '*35', pin: '' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(pool.hechas(/UPDATE pbxng_disa SET/)[0].args[12], null, 'PIN vacío = no se cambia');
    assert.deepEqual(pool.hechas(/DELETE FROM extensions WHERE context='internal'/).map((q) => q.args[0]), ['*30', '*35'], 'la extensión vieja se borra');
    pool.llamadas.length = 0;
    await put('5', { pin: PIN });
    assert.ok(pool.hechas(/UPDATE pbxng_disa SET/)[0].args[12].startsWith('$2'));
    assert.equal(pool.hechas(/DELETE FROM extensions WHERE context='internal'/).length, 1, 'misma extensión: un solo borrado');
    pool.cuando(/UPDATE pbxng_disa SET/, new Error('caída'));
    pool.cuando(/ROLLBACK/, new Error('ni eso'));
    const sueltos = pool.sueltos;
    assert.equal((await put('5', {})).status, 500);
    assert.equal(pool.sueltos, sueltos + 1);

    assert.equal((await app.pedir('DELETE', '/api/disa/:id', { params: { id: '9' } })).status, 404);
    pool.cuando(/DELETE FROM pbxng_disa/, [{ exten: '*30' }]);
    assert.deepEqual((await app.pedir('DELETE', '/api/disa/:id', { params: { id: '5' } })).json, { deleted: 5 });
    pool.cuando(/DELETE FROM pbxng_disa/, new Error('caída'));
    assert.equal((await app.pedir('DELETE', '/api/disa/:id', { params: { id: '5' } })).status, 500);
    pool.cuando(/FROM pbxng_disa ORDER BY id/, new Error('caída'));
    assert.equal((await app.pedir('GET', '/api/disa')).status, 500);
    pool.conectar = new Error('sin base');
    assert.equal((await alta({ exten: '*30', pin: PIN })).status, 500);
  });

  await t.test('registro de uso: límite y error', async () => {
    pool.cuando(/FROM pbxng_marcacion_log WHERE familia=\$1/, (a) => [{ familia: a[0], lim: a[1] }]);
    assert.deepEqual((await app.pedir('GET', '/api/disa/registro', { query: {} })).json, [{ familia: 'disa', lim: 200 }]);
    assert.deepEqual((await app.pedir('GET', '/api/callback/registro', { query: { limit: '0' } })).json, [{ familia: 'callback', lim: 200 }]);
    assert.deepEqual((await app.pedir('GET', '/api/callback/registro', { query: { limit: '9999' } })).json, [{ familia: 'callback', lim: 500 }]);
    pool.cuando(/FROM pbxng_marcacion_log WHERE familia=\$1/, new Error('caída'));
    assert.equal((await app.pedir('GET', '/api/disa/registro', { query: {} })).status, 500);
  });
});

test('callback: alta, edición y baja con cada validación', async (t) => {
  const { app, pool, dialplan } = armar(t);
  pool.cuando(/INSERT INTO pbxng_callback/, (a) => [{ id: 3, nombre: a[0], exten: a[1], enabled: a[2], modo: a[3], pin_hash: a[4], numeros: JSON.parse(a[5]), rutas: JSON.parse(a[6]), demora_seg: a[7], cooldown_seg: a[8], max_dia: a[9], dest_type: a[10], dest_value: a[11] }]);
  const alta = (body) => app.pedir('POST', '/api/callback', { body });
  const base = { exten: '*40', dest_value: '*30' };

  assert.match((await alta(undefined)).json.error, /extensión de entrada/);
  assert.match((await alta(Object.assign({}, base, { modo: 'todos' }))).json.error, /modo inválido/);
  assert.match((await alta(Object.assign({}, base, { dest_type: 'calle' }))).json.error, /destino inválido/);
  assert.match((await alta(Object.assign({}, base, { dest_value: '' }))).json.error, /destino del callback/);
  assert.match((await alta(Object.assign({}, base, { numeros: Array(201).fill(0).map((_, i) => String(9000 + i)) }))).json.error, /200/);
  assert.match((await alta(Object.assign({}, base, { numeros: '099,abc' }))).json.error, /número inválido en la lista: abc/);
  assert.match((await alta(Object.assign({}, base, { enabled: true }))).json.error, /al menos un número/);
  assert.match((await alta(Object.assign({}, base, { enabled: true, modo: 'pin', pin: PIN }))).json.error, /ruta saliente habilitada/);
  assert.match((await alta(Object.assign({}, base, { modo: 'lista_pin' }))).json.error, /necesita un PIN/);

  const ok = await alta(Object.assign({}, base, { nombre: '', enabled: true, modo: 'lista_pin', pin: PIN, numeros: ' 099111222 , 099111222,', rutas: 'x',
    demora_seg: 999, cooldown_seg: 1, max_dia: 0, dest_type: 'ivr' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.nombre, ok.json.numeros, ok.json.rutas, ok.json.demora_seg, ok.json.cooldown_seg, ok.json.max_dia, ok.json.tiene_pin, ok.json.pin_hash],
    ['Callback', ['099111222'], [], 120, 10, 20, true, undefined]);
  assert.equal(dialplan.pop().exten, '*40');
  const lista = await alta(Object.assign({}, base, { numeros: ['099', null] }));
  assert.equal(lista.json.tiene_pin, false);

  const put = (id, body) => app.pedir('PUT', '/api/callback/:id', { params: { id }, body });
  assert.equal((await put('9', {})).status, 404);
  const viejo = { id: 3, nombre: 'C', exten: '*40', enabled: false, modo: 'lista', numeros: ['099'], rutas: [], demora_seg: 5, cooldown_seg: 60, max_dia: 20, dest_type: 'disa', dest_value: '*30', pin_hash: null };
  pool.cuando(/FROM pbxng_callback WHERE id=\$1$/, [viejo]);
  pool.cuando(/UPDATE pbxng_callback SET/, (a) => [Object.assign({}, viejo, { exten: a[2], modo: a[4] })]);
  assert.match((await put('3', { modo: 'pin' })).json.error, /necesita un PIN/, 'pasar a modo PIN sin PIN guardado ni nuevo');
  pool.cuando(/SELECT app, appdata FROM extensions WHERE context='internal' AND exten=\$1 AND priority=1/, [{ app: 'NoOp', appdata: 'Callback x' }]);
  pool.llamadas.length = 0;
  assert.equal((await put('3', { exten: '*41', pin: '' })).status, 200);
  assert.deepEqual(pool.hechas(/DELETE FROM extensions WHERE context='internal'/).map((q) => q.args[0]), ['*40', '*41']);
  pool.llamadas.length = 0;
  assert.equal((await put('3', { modo: 'lista_pin', pin: PIN })).status, 200);
  assert.ok(pool.hechas(/UPDATE pbxng_callback SET/)[0].args[12].startsWith('$2'));
  pool.cuando(/FROM pbxng_callback WHERE id=\$1$/, [Object.assign({}, viejo, { pin_hash: HASH })]);
  assert.equal((await put('3', { modo: 'pin', rutas: [1] })).status, 200, 'con PIN guardado no hace falta reenviarlo');
  pool.cuando(/UPDATE pbxng_callback SET/, new Error('caída'));
  assert.equal((await put('3', {})).status, 500);

  assert.equal((await app.pedir('DELETE', '/api/callback/:id', { params: { id: '9' } })).status, 404);
  pool.cuando(/DELETE FROM pbxng_callback/, [{ exten: '*40' }]);
  assert.deepEqual((await app.pedir('DELETE', '/api/callback/:id', { params: { id: '3' } })).json, { deleted: 3 });
  pool.cuando(/DELETE FROM pbxng_callback/, new Error('caída'));
  assert.equal((await app.pedir('DELETE', '/api/callback/:id', { params: { id: '3' } })).status, 500);
  pool.cuando(/FROM pbxng_callback ORDER BY id/, new Error('caída'));
  assert.equal((await app.pedir('GET', '/api/callback')).status, 500);
  pool.cuando(/INSERT INTO pbxng_callback/, new Error('caída'));
  assert.equal((await alta(Object.assign({}, base, { numeros: '099' }))).status, 500);
});

test('directorio por nombre: quién aparece, alta, mudanza y validaciones', async (t) => {
  const { app, pool, dialplan, mod } = armar(t);
  pool.cuando(/SELECT mailbox, COALESCE\(fullname,''\) AS fullname FROM voicemail/, (a) => (a[0] === 'default'
    ? [{ mailbox: '1001', fullname: 'Ana' }, { mailbox: '1002', fullname: '  ' }]
    : []));
  const g = await app.pedir('GET', '/api/dialbyname');
  assert.deepEqual([g.json.id, g.json.directorio, g.json.sin_nombre], [0, [{ mailbox: '1001', fullname: 'Ana' }], ['1002']]);

  const put = (body) => app.pedir('PUT', '/api/dialbyname', { body });
  assert.match((await put({ exten: '_X.' })).json.error, /extensión del directorio/);
  assert.match((await put({ exten: '*411', opciones: 'z' })).json.error, /opciones/);
  assert.match((await put({ exten: '*411', vm_context: 'a b' })).json.error, /contexto/);
  pool.cuando(/INSERT INTO pbxng_dialbyname/, (a) => [{ id: 1, exten: a[0], enabled: a[1], opciones: a[2], vm_context: a[3] }]);
  const alta = await put({ exten: '*411', enabled: true, opciones: '', vm_context: 'oficina' });
  assert.equal(alta.json.id, 1);
  assert.deepEqual(dialplan.pop().rows[3], [4, 'Directory', 'oficina,internal'], 'sin opciones no queda una coma colgando');

  pool.cuando(/FROM pbxng_dialbyname ORDER BY id LIMIT 1/, [{ id: 1, exten: '*411', enabled: true, opciones: 'e', vm_context: 'default' }]);
  pool.cuando(/UPDATE pbxng_dialbyname/, (a) => [{ id: a[0], exten: a[1], enabled: a[2] }]);
  pool.cuando(/SELECT app, appdata FROM extensions WHERE context='internal' AND exten=\$1 AND priority=1/, [{ app: 'NoOp', appdata: 'Directorio por nombre' }]);
  pool.llamadas.length = 0;
  const n = dialplan.length;
  const mud = await put({ exten: '*412', enabled: false });
  assert.deepEqual(mud.json, { id: 1, exten: '*412', enabled: false });
  assert.deepEqual(pool.hechas(/DELETE FROM extensions WHERE context='internal'/).map((q) => q.args[0]), ['*411', '*412']);
  assert.equal(dialplan.length, n, 'apagado no publica');
  pool.llamadas.length = 0;
  await put(undefined);
  assert.deepEqual(pool.hechas(/DELETE FROM extensions WHERE context='internal'/).map((q) => q.args[0]), ['*411'], 'sin cambio de extensión, un borrado');
  assert.equal((await put({ exten: '' })).status, 400, 'sin extensión no hay directorio');
  await put({ opciones: null, enabled: false });
  assert.equal(pool.hechas(/UPDATE pbxng_dialbyname/).pop().args[3], '', 'opciones nulas = ninguna');

  // Opciones o contexto raros en la fila: el dialplan cae a los valores seguros.
  assert.deepEqual(mod.filasDbn({ opciones: 'zz', vm_context: '../x' })[3], [4, 'Directory', 'default,internal,e']);
  pool.cuando(/UPDATE pbxng_dialbyname/, new Error('caída'));
  assert.equal((await put({ exten: '*411' })).status, 500);
  pool.cuando(/FROM pbxng_dialbyname ORDER BY id LIMIT 1/, new Error('caída'));
  assert.equal((await app.pedir('GET', '/api/dialbyname')).status, 500);
});

test('abreviados globales y prefijo de los personales', async (t) => {
  const { app, pool, dialplan } = armar(t);
  const ajustes = {};
  pool.cuando(/SELECT value FROM pbxng_settings WHERE key=\$1/, (a) => (a[0] in ajustes ? [{ value: ajustes[a[0]] }] : []));
  pool.cuando(/INSERT INTO pbxng_settings/, (a) => { ajustes[a[0]] = a[1]; return []; });
  pool.cuando(/INSERT INTO pbxng_abreviados \(ext,code,destino,nombre\) VALUES \(NULL/, (a) => [{ id: 9, code: a[0], destino: a[1], nombre: a[2] }]);

  ajustes.abrev_prefijo = 'mal';
  assert.deepEqual((await app.pedir('GET', '/api/abreviados')).json, { prefijo: '*75', globales: [] }, 'un prefijo guardado inválido cae al de fábrica');
  ajustes.abrev_prefijo = null;
  assert.equal((await app.pedir('GET', '/api/abreviados')).json.prefijo, '*75');
  delete ajustes.abrev_prefijo;

  const alta = (body) => app.pedir('POST', '/api/abreviados', { body });
  assert.match((await alta(undefined)).json.error, /número corto inválido/);
  assert.match((await alta({ code: '*9', destino: '*78' })).json.error, /destino inválido/);
  const ok = await alta({ code: '*9', destino: '099' });
  assert.deepEqual(ok.json, { id: 9, code: '*9', destino: '099', nombre: null });
  assert.equal(dialplan.pop().rows[0][2], 'Abreviado *9 → 099');
  await alta({ code: '*8', destino: '099', nombre: 'Taxi' });
  assert.equal(dialplan.pop().rows[0][2], 'Abreviado *8 → 099 (Taxi)');

  // Prefijo: inválido, igual al actual, distinto (borra el patrón viejo) y con personales cargados (publica).
  const pref = (prefijo) => app.pedir('PUT', '/api/abreviados/prefijo', { body: prefijo === undefined ? undefined : { prefijo } });
  assert.equal((await pref(undefined)).status, 400);
  pool.cuando(/SELECT app, appdata FROM extensions WHERE context='internal' AND exten=\$1 AND priority=1/, [{ app: 'NoOp', appdata: 'Abreviado personal' }]);
  pool.llamadas.length = 0;
  assert.deepEqual((await pref('*75')).json, { prefijo: '*75' });
  assert.equal(pool.hechas(/DELETE FROM extensions WHERE context='internal'/).length, 1, 'mismo prefijo: sólo se reescribe el patrón');
  pool.cuando(/SELECT 1 FROM pbxng_abreviados WHERE ext IS NOT NULL/, [{}]);
  pool.llamadas.length = 0;
  await pref('#7');
  assert.deepEqual(pool.hechas(/DELETE FROM extensions WHERE context='internal'/).map((q) => q.args[0]), ['_*75XX', '_#7XX']);
  assert.equal(dialplan.pop().exten, '_#7XX');
  pool.cuando(/SELECT 1 FROM ps_endpoints WHERE id=\$1/, (a) => (a[0] === '*6XX' ? [{}] : []));
  assert.equal((await pref('*6')).status, 409, 'el patrón nuevo pisa un interno');

  const put = (id, body) => app.pedir('PUT', '/api/abreviados/:id', { params: { id }, body });
  assert.equal((await put('1', {})).status, 404);
  pool.cuando(/SELECT id,code,destino,nombre FROM pbxng_abreviados WHERE id=\$1/, [{ id: 9, code: '*9', destino: '099', nombre: 'x' }]);
  pool.cuando(/UPDATE pbxng_abreviados SET code/, (a) => [{ id: a[0], code: a[1], destino: a[2], nombre: a[3] }]);
  assert.match((await put('9', { code: '9' })).json.error, /número corto inválido/);
  assert.match((await put('9', { destino: 'abc' })).json.error, /destino inválido/);
  pool.llamadas.length = 0;
  assert.deepEqual((await put('9', undefined)).json, { id: 9, code: '*9', destino: '099', nombre: null });
  assert.equal(pool.hechas(/DELETE FROM extensions/).length, 0, 'sin cambio de código no se borra nada');
  pool.cuando(/SELECT app, appdata FROM extensions WHERE context='internal' AND exten=\$1 AND priority=1/, [{ app: 'NoOp', appdata: 'Abreviado *9' }]);
  pool.llamadas.length = 0;
  await put('9', { code: '*10', nombre: 'Taxi' });
  assert.deepEqual(pool.hechas(/DELETE FROM extensions WHERE context='internal'/).map((q) => q.args[0]), ['*9']);
  pool.cuando(/UPDATE pbxng_abreviados SET code/, new Error('caída'));
  assert.equal((await put('9', {})).status, 500);

  assert.equal((await app.pedir('DELETE', '/api/abreviados/:id', { params: { id: '1' } })).status, 404);
  pool.cuando(/DELETE FROM pbxng_abreviados WHERE id=\$1/, [{ code: '*9' }]);
  assert.deepEqual((await app.pedir('DELETE', '/api/abreviados/:id', { params: { id: '9' } })).json, { deleted: 9 });
  pool.cuando(/DELETE FROM pbxng_abreviados WHERE id=\$1/, new Error('caída'));
  assert.equal((await app.pedir('DELETE', '/api/abreviados/:id', { params: { id: '9' } })).status, 500);
  pool.cuando(/WHERE ext IS NULL ORDER BY code/, new Error('caída'));
  assert.equal((await app.pedir('GET', '/api/abreviados')).status, 500);
  pool.cuando(/INSERT INTO pbxng_settings/, new Error('caída'));
  assert.equal((await pref('*7')).status, 500);
  pool.conectar = new Error('sin base');
  assert.equal((await alta({ code: '*9', destino: '099' })).status, 500);
});

test('abreviados personales del interno: lista completa, borrados y AMI caído', async (t) => {
  const { app, pool, ami } = armar(t);
  const get = (ext) => app.pedir('GET', '/api/extensions/:ext/abreviados', { params: { ext } });
  const put = (ext, body) => app.pedir('PUT', '/api/extensions/:ext/abreviados', { params: { ext }, body });
  assert.equal((await get('a b')).status, 400);
  assert.equal((await get(undefined)).status, 400);
  pool.cuando(/WHERE ext=\$1 ORDER BY code/, [{ code: '01' }]);
  assert.deepEqual((await get('1001')).json, { prefijo: '*75', entradas: [{ code: '01' }] });

  assert.equal((await put('a b', {})).status, 400);
  assert.match((await put('1001', undefined)).json.error, /se espera/);
  assert.match((await put('1001', { entradas: Array(101).fill({}) })).json.error, /100/);
  assert.match((await put('1001', { entradas: [null] })).json.error, /código inválido/);
  assert.match((await put('1001', { entradas: [{ code: '01', destino: '*78' }] })).json.error, /destino inválido en 01/);
  assert.match((await put('1001', { entradas: [{ code: '01', destino: '099' }, { code: '01', destino: '098' }] })).json.error, /repetido: 01/);

  pool.cuando(/SELECT code FROM pbxng_abreviados WHERE ext=\$1/, [{ code: '01' }, { code: '02' }]);
  const ok = await put('1001', { entradas: [{ code: '01', destino: '099', nombre: 'Casa' }] });
  assert.deepEqual(ok.json, { prefijo: '*75', entradas: [{ code: '01', destino: '099', nombre: 'Casa' }] });
  assert.deepEqual(ami.hechas.map((a) => a.Action + ' ' + a.Key), ['DBDel 1001-02', 'DBPut 1001-01'], 'el que ya no está se borra de la AstDB');
  ami.falla = () => true;
  const av = await put('1001', { entradas: [{ code: '01', destino: '099' }] });
  assert.match(av.json.aviso, /Asterisk no tomó el cambio/);
  assert.equal(av.json.entradas[0].nombre, null);
  pool.cuando(/DELETE FROM pbxng_abreviados WHERE ext=\$1/, new Error('caída'));
  assert.equal((await put('1001', { entradas: [] })).status, 500);
  pool.cuando(/WHERE ext=\$1 ORDER BY code/, new Error('caída'));
  assert.equal((await get('1001')).status, 500);

  const prohibido = armar(t, { exigirExt: (req, res) => { res.status(403).json({ error: 'no' }); return false; } }).app;
  assert.equal((await prohibido.pedir('GET', '/api/extensions/:ext/abreviados', { params: { ext: '1001' } })).status, 403);
  assert.equal((await prohibido.pedir('PUT', '/api/extensions/:ext/abreviados', { params: { ext: '1001' }, body: { entradas: [] } })).status, 403);
});

test('lo que pregunta el dialplan de la DISA: PIN, bloqueo y a dónde puede marcar', async (t) => {
  const { app, pool } = armar(t);
  let disa = { id: 5, enabled: true, pin_hash: HASH, rutas: [1], internos: false, max_intentos: 2, bloqueo_min: 15 };
  pool.cuando(/FROM pbxng_disa WHERE id=\$1$/, () => (disa ? [disa] : []));
  const preguntar = (body, o = {}) => app.pedir('POST', '/api/internal/disa', Object.assign({ body: Object.assign({ tok: TOK, id: '5', cid: '099 111' }, body) }, o));

  const prox = await preguntar({ accion: 'pin', pin: PIN }, { headers: { 'x-real-ip': '1.1.1.1' } });
  assert.deepEqual([prox.status, txt(prox)], [403, 'no']);
  assert.equal(prox.headers['content-type'], 'text/plain', 'el que lee es un CURL: texto plano, no JSON');

  assert.equal(txt(await preguntar({ accion: 'pin', pin: PIN })), 'ok');
  assert.equal(txt(await preguntar({ accion: 'otra' })), 'no');
  assert.equal(txt(await preguntar({ accion: 'marcar', num: '-' })), 'no', 'número vacío');
  assert.equal(txt(await preguntar({ accion: 'marcar', num: '099123456' })), 'ok');
  assert.equal(txt(await preguntar({ accion: 'marcar', num: '0034911222333' })), 'no', 'la internacional no está habilitada en esta DISA');
  assert.equal(txt(await preguntar({ accion: 'marcar', num: '29001234' })), 'no', 'dos rutas igual de específicas: no se sabe cuál cursa');
  assert.equal(txt(await preguntar({ accion: 'marcar', num: '5555' })), 'no', 'no entra en ninguna ruta');
  const motivos = registro(pool).slice(-3).map((r) => r[1]);
  assert.match(motivos[0], /no está habilitada/);
  assert.match(motivos[1], /igual de específicas/);
  assert.match(motivos[2], /ninguna ruta/);

  // Internos: se miran primero; si ps_endpoints no contesta, se sigue por las rutas.
  disa = Object.assign({}, disa, { internos: true, rutas: 'x' });
  pool.cuando(/SELECT 1 FROM ps_endpoints WHERE id=\$1/, (a) => { if (a[0] === '1002') throw new Error('caída'); return a[0] === '1001' ? [{}] : []; });
  assert.equal(txt(await preguntar({ accion: 'marcar', num: '1001' })), 'ok');
  assert.equal(txt(await preguntar({ accion: 'marcar', num: '1002' })), 'no');
  assert.match(registro(pool).pop()[1], /ninguna ruta saliente habilitada/);

  // Dos PIN mal con max_intentos=2: el segundo bloquea, y bloqueado ni se compara.
  assert.equal(txt(await preguntar({ accion: 'pin', pin: '000000', cid: '' })), 'no');
  assert.equal(txt(await preguntar({ accion: 'pin', pin: '000000', cid: '' })), 'bloqueado');
  assert.equal(txt(await preguntar({ accion: 'pin', pin: PIN, cid: '' })), 'bloqueado', 'con el PIN bueno también: el bloqueo va primero');
  assert.deepEqual(registro(pool).slice(-3).map((r) => r[0]), ['pin_mal', 'bloqueado', 'bloqueado']);
  // Un hash roto en la base no deja pasar a nadie (bcrypt tira y cuenta como PIN malo).
  disa = Object.assign({}, disa, { pin_hash: null, max_intentos: 0, bloqueo_min: 0 });
  assert.equal(txt(await preguntar({ accion: 'pin', pin: PIN, cid: '1' })), 'no');
  assert.equal(txt(await preguntar({ accion: 'pin', pin: PIN, cid: '1' })), 'no');
  assert.equal(txt(await preguntar({ accion: 'pin', pin: PIN, cid: '1' })), 'bloqueado', 'max_intentos 0 vale 3');

  disa = Object.assign({}, disa, { enabled: false });
  assert.equal(txt(await app.pedir('POST', '/api/internal/disa', { query: { tok: TOK, id: 'x' } })), 'no', 'apagada o inexistente');
  disa = null;
  assert.equal(txt(await preguntar({ accion: 'pin' })), 'no');
  // El registro que falla no cambia la respuesta; la base que falla responde "no".
  pool.cuando(/INSERT INTO pbxng_marcacion_log/, new Error('caída'));
  assert.equal(txt(await preguntar({ accion: 'pin' })), 'no');
  pool.cuando(/FROM pbxng_disa WHERE id=\$1$/, new Error('caída'));
  assert.equal(txt(await preguntar({ accion: 'pin', pin: PIN })), 'no');
});

test('lo que pregunta el dialplan del callback: lista, rutas, PIN, cooldown, tope y la devolución', async (t) => {
  const { app, pool, ami, logger } = armar(t);
  let cb = { id: 3, enabled: true, modo: 'lista', numeros: ['099111222'], rutas: [], pin_hash: HASH, demora_seg: 5, cooldown_seg: 60, max_dia: 2, dest_type: 'disa', dest_value: '*30' };
  pool.cuando(/FROM pbxng_callback WHERE id=\$1$/, () => (cb ? [cb] : []));
  let ultima = [];
  let hoy = [{ n: 0 }];
  pool.cuando(/ORDER BY ts DESC LIMIT 1/, () => ultima);
  pool.cuando(/count\(\*\)::int AS n/, () => hoy);
  const pedir = (body, o = {}) => app.pedir('POST', '/api/internal/callback', Object.assign({ body: Object.assign({ tok: TOK, id: '3', cid: '099111222' }, body) }, o));

  assert.equal((await pedir({}, { ip: '8.8.8.8' })).status, 403, 'de afuera de la central');
  assert.equal(txt(await pedir({ cid: '' })), 'no');
  assert.match(registro(pool).pop()[1], /sin CallerID/);
  assert.equal(txt(await pedir({ cid: '098' })), 'no');
  assert.match(registro(pool).pop()[1], /fuera de la lista/);

  // OK: contesta y DESPUÉS de la demora origina la llamada.
  assert.equal(txt(await pedir({})), 'ok');
  assert.equal(ami.hechas.length, 0, 'la devolución no sale antes de colgar la entrante');
  t.mock.timers.tick(5000);
  await hasta(() => ami.hechas.length === 1);
  assert.deepEqual([ami.hechas[0].Channel, ami.hechas[0].Context, ami.hechas[0].Exten], ['Local/099111222@internal', 'internal', '*30']);

  // Cooldown y tope diario.
  ultima = [{ ts: new Date() }];
  assert.equal(txt(await pedir({})), 'no');
  assert.match(registro(pool).pop()[1], /tiempo de espera/);
  ultima = [{ ts: new Date(Date.now() - 3600 * 1000) }];
  hoy = [{ n: 2 }];
  assert.equal(txt(await pedir({})), 'no');
  assert.match(registro(pool).pop()[1], /tope diario/);
  hoy = [];

  // Con rutas en modo lista: el número tiene que salir por una de ellas.
  cb = Object.assign({}, cb, { rutas: [3] });
  assert.equal(txt(await pedir({})), 'no');
  assert.match(registro(pool).pop()[1], /no está habilitada/);

  // Modo pin: sin rutas no devuelve (fila vieja), con rutas pide el PIN; el balde es por callback.
  cb = Object.assign({}, cb, { modo: 'pin', rutas: 'x', numeros: null });
  assert.equal(txt(await pedir({ pin: PIN })), 'no');
  assert.match(registro(pool).pop()[1], /modo PIN sin ninguna ruta/);
  cb = Object.assign({}, cb, { rutas: [1], dest_type: 'ivr', dest_value: '600' });
  assert.equal(txt(await pedir({ pin: PIN })), 'ok');
  for (const cid of ['099000001', '099000002', '099000003']) assert.equal(txt(await pedir({ pin: '1', cid })), 'no');
  assert.equal(txt(await pedir({ pin: PIN, cid: '099000004' })), 'no', 'rotar el CallerID no da un balde nuevo');
  assert.equal(registro(pool).pop()[0], 'bloqueado');

  // lista_pin: el balde es por origen y un PIN roto en la base no deja pasar.
  cb = Object.assign({}, cb, { id: 4, modo: 'lista_pin', numeros: ['099111222'], rutas: [], pin_hash: null });
  assert.equal(txt(await pedir({ id: '4', pin: PIN })), 'no');
  assert.equal(registro(pool).pop()[0], 'pin_mal');

  // El Originate que falla queda registrado como rechazo.
  ami.falla = () => true;
  cb = Object.assign({}, cb, { pin_hash: HASH });
  assert.equal(txt(await pedir({ id: '4', pin: PIN })), 'ok');
  t.mock.timers.tick(5000);
  await hasta(() => logger.lineas.some((l) => /no se pudo devolver la llamada/.test(l.msg)));
  await hasta(() => registro(pool).some((r) => r[1] === 'no se pudo originar la llamada'));

  cb = Object.assign({}, cb, { enabled: false });
  assert.equal(txt(await app.pedir('POST', '/api/internal/callback', { query: { tok: TOK } })), 'no');
  pool.cuando(/FROM pbxng_callback WHERE id=\$1$/, new Error('caída'));
  assert.equal(txt(await pedir({})), 'no');
});
