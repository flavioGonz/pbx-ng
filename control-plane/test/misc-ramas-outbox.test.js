/* ============================================================================
 *  Outbox de eventos (outbox.js) en unidad: base, destino y reloj de mentira.
 *
 *  test/outbox.test.js prueba el camino feliz de punta a punta contra Postgres. Acá se
 *  fijan los bordes que ahí no se ven y que son justamente los que hacen que un outbox
 *  no pierda nada ni se lleve la central puesta:
 *   - un tipo que no está en el catálogo no se encola (y no revienta al que emite);
 *   - con Postgres caído la cola en memoria tiene tope: se descarta lo MÁS VIEJO, se
 *     avisa UNA vez y, cuando la base vuelve, se informa cuánto se perdió;
 *   - un lote que no se pudo volcar vuelve a la cola, en orden, para el próximo volcado;
 *   - un destino que falla acumula intentos y, al cruzar el tope, suena la alerta una
 *     sola vez (aunque la alerta misma falle);
 *   - dos vueltas superpuestas no entregan dos veces;
 *   - la poda respeta el cursor más atrasado y, sin destinos, sólo la retención;
 *   - las rutas de administración y del modo pull validan y no filtran errores crudos.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const initOutbox = require('../outbox');

function armar(t, { query, alerts, conV1 = true } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const consultas = [];
  const pool = { async query(sql, args) { consultas.push({ sql, args }); return query ? query(sql, args) : { rows: [], rowCount: 0 }; } };
  const logs = [];
  const logger = () => ({ debug() {}, info() {}, warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) });
  const rutas = {};
  const registrar = (metodo) => (ruta, ...h) => { rutas[metodo + ' ' + ruta] = h[h.length - 1]; };
  const app = { get: registrar('GET'), post: registrar('POST'), put: registrar('PUT'), delete: registrar('DELETE') };
  const routerV1 = { get: registrar('GET /api/v1'), post: registrar('POST /api/v1') };
  const errorHttp = (res, e) => res.status(500).json({ error: 'error interno', _causa: e.message });
  const ob = initOutbox({
    pool, logger, alerts, app, auth: () => {}, errorHttp, nombreCentral: 'central-prueba',
    ...(conV1 ? { routerV1, authServicio: () => {}, exigirAlcance: () => () => {} } : {}),
  });
  return { ob, consultas, logs, rutas };
}

async function llamar(handler, req = {}) {
  const res = { statusCode: 200, cuerpo: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.cuerpo = b; return this; } };
  await handler({ params: {}, query: {}, ...req }, res);
  return res;
}

test('emitir: un tipo fuera del catálogo no se encola; sin datos viaja un objeto vacío', async (t) => {
  const { ob, consultas, logs } = armar(t);
  assert.equal(ob.emitir('llamada.inventada', { call_id: 'x' }), null);
  assert.match(logs[0][1], /tipo de evento desconocido/);
  const id = ob.emitir('llamada.entrante');
  assert.match(id, /^[0-9a-f-]{36}$/);
  await ob._volcar();
  const ins = consultas.find((c) => /INSERT INTO pbxng_eventos_salida/.test(c.sql));
  assert.equal(ins.args.length, 7, 'un solo evento: el inventado no llegó a la base');
  assert.equal(ins.args[1], 'llamada.entrante');
  assert.equal(ins.args[4], null);
  assert.equal(ins.args[6], '{}');
  // Con la cola vacía no se va a la base.
  const n = consultas.length;
  await ob._volcar();
  assert.equal(consultas.length, n);
});

test('cola saturada: se descarta lo más viejo, se avisa una vez y al volver la base se informa', async (t) => {
  let baseArriba = false;
  const avisos = [];
  const alerts = { raise: async (clave, datos) => { avisos.push({ clave, datos }); throw new Error('alertas caídas'); } };
  const { ob, consultas, logs } = armar(t, { alerts, query: (sql) => { if (!baseArriba) throw new Error('base caída'); return { rows: [], rowCount: 1 }; } });
  const primero = ob.emitir('llamada.entrante', { call_id: 'primero' });
  await ob._volcar();                                       // falla: el lote vuelve a la cola
  assert.ok(logs.some((l) => l[0] === 'error' && /no se pudo volcar/.test(l[1])));
  for (let i = 0; i < 5001; i++) ob.emitir('llamada.terminada', { call_id: 'c' + i, leg_id: 'l' + i });
  assert.equal(avisos.length, 1, 'el aviso de saturación suena una sola vez');
  assert.equal(avisos[0].clave, 'outbox.saturado');
  await new Promise((r) => setImmediate(r));                // la alerta que falla no deja una promesa rechazada suelta
  baseArriba = true;
  await ob._volcar();
  const ins = consultas.filter((c) => /INSERT/.test(c.sql)).at(-1);
  assert.equal(ins.args.length, 5000 * 7, 'quedan exactamente TOPE eventos');
  assert.ok(!ins.args.includes(primero), 'el más viejo fue el descartado');
  assert.ok(ins.args.includes('c5000'), 'el más nuevo sigue');
  assert.ok(logs.some((l) => l[0] === 'warn' && /se descartaron/.test(l[1]) && l[2].descartados === 2));
});

test('entrega: firma, cuerpo con la central, y backoff con alerta única al tope de intentos', async (t) => {
  const evento = { secuencia: 9, evento_id: 'e9', tipo: 'llamada.entrante', version: 1, ts: 't', call_id: 'c', leg_id: 'l', datos: {} };
  const subs = [
    { id: 1, nombre: 'ok', url: 'http://destino/ok', secreto: 's1', tipos: ['llamada.entrante'], cursor: 0, intentos: 3 },
    { id: 2, nombre: 'cae', url: 'http://destino/cae', secreto: null, tipos: null, cursor: 0, intentos: 11 },
    { id: 3, nombre: 'tira', url: 'http://destino/tira', secreto: '', tipos: null, cursor: 0, intentos: null },
    { id: 4, nombre: 'vacia', url: 'http://destino/vacia', secreto: 'x', tipos: [], cursor: 99, intentos: 0 },
  ];
  const avisos = [];
  const alerts = { raise: async (clave, datos) => { avisos.push({ clave, datos }); throw new Error('alertas caídas'); } };
  const { ob, consultas } = armar(t, {
    alerts,
    query: (sql, args) => {
      if (/FROM pbxng_suscripciones/.test(sql) && /SELECT/.test(sql)) return { rows: subs };
      if (/FROM pbxng_eventos_salida/.test(sql)) return { rows: args[0] === 99 ? [] : [evento] };
      return { rows: [], rowCount: 1 };
    },
  });
  const pedidos = [];
  t.mock.method(globalThis, 'fetch', async (url, o) => {
    pedidos.push({ url, o });
    if (url.endsWith('/ok')) return { ok: true, status: 200 };
    if (url.endsWith('/cae')) return { ok: false, status: 503 };
    throw 'socket colgado';   // un rechazo que no es un Error
  });
  await ob._vuelta();
  assert.deepEqual(pedidos.map((p) => p.url), ['http://destino/ok', 'http://destino/cae', 'http://destino/tira'], 'sin eventos nuevos no se postea');
  const ok = pedidos[0].o;
  assert.equal(JSON.parse(ok.body).central, 'central-prueba');
  assert.equal(ok.headers['X-PBXNG-Firma'], 'sha256=' + crypto.createHmac('sha256', 's1').update(ok.body).digest('hex'));
  assert.equal(pedidos[1].o.headers['X-PBXNG-Firma'], 'sha256=' + crypto.createHmac('sha256', '').update(pedidos[1].o.body).digest('hex'), 'sin secreto firma con clave vacía, no revienta');
  const sel = consultas.filter((c) => /FROM pbxng_eventos_salida/.test(c.sql));
  assert.deepEqual(sel[1].args[1], [], 'tipos null es «todos»');
  const upd = consultas.filter((c) => /UPDATE pbxng_suscripciones/.test(c.sql));
  assert.deepEqual(upd[0].args, [1, 9], 'el 2xx avanza el cursor');
  assert.deepEqual(upd[1].args, [2, 12, 'el destino respondió 503', '600'], 'el intento 12 espera el techo de 10 min');
  assert.deepEqual(upd[2].args, [3, 1, 'socket colgado', '5'], 'un error que no es Error igual se guarda legible');
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].clave, 'outbox.destino_caido');
  assert.equal(avisos[0].datos.intentos, 12);
  await new Promise((r) => setImmediate(r));
});

test('vuelta: dos superpuestas no entregan dos veces, y una base caída se registra sin romper', async (t) => {
  let soltar;
  let n = 0;
  const { ob, logs } = armar(t, {
    query: async (sql) => {
      if (/FROM pbxng_suscripciones/.test(sql)) {
        n++;
        if (n === 1) { await new Promise((r) => { soltar = r; }); return { rows: [] }; }
        throw new Error('base caída');
      }
      return { rows: [] };
    },
  });
  const a = ob._vuelta();
  await new Promise((r) => setImmediate(r));
  await ob._vuelta();                       // vuelve en el acto: la primera sigue corriendo
  assert.equal(n, 1);
  soltar();
  await a;
  await ob._vuelta();                       // ya libre: entra y la base falla
  assert.equal(n, 2);
  assert.ok(logs.some((l) => l[0] === 'error' && l[1] === 'vuelta del outbox'));
});

test('poda: sin destinos sólo retención; con destinos respeta el cursor más atrasado; error no rompe', async (t) => {
  let modo = 'sin';
  const { ob, consultas } = armar(t, {
    query: (sql) => {
      if (modo === 'rota') throw new Error('base caída');
      if (/MIN\(cursor\)/.test(sql)) return { rows: modo === 'sin' ? [{ piso: 0, n: 0 }] : modo === 'vacia' ? [] : [{ piso: 40, n: 2 }] };
      return { rows: [], rowCount: modo === 'con' ? 3 : 0 };
    },
  });
  await ob._podar();
  let del = consultas.filter((c) => /DELETE/.test(c.sql)).at(-1);
  assert.ok(!/secuencia/.test(del.sql), 'sin destinos activos no hay cursor que respetar');
  modo = 'vacia';
  await ob._podar();
  del = consultas.filter((c) => /DELETE/.test(c.sql)).at(-1);
  assert.ok(!/secuencia/.test(del.sql));
  modo = 'con';
  await ob._podar();
  del = consultas.filter((c) => /DELETE/.test(c.sql)).at(-1);
  assert.match(del.sql, /secuencia <= \$1/);
  assert.deepEqual(del.args, [40]);
  modo = 'rota';
  await ob._podar();                         // no tira
});

test('rutas de administración: validan y los errores de base pasan por errorHttp', async (t) => {
  let romper = false;
  let filas = 1;
  const { rutas } = armar(t, {
    query: (sql) => {
      if (romper) throw new Error('relation "pbxng_suscripciones" does not exist');
      if (/INSERT/.test(sql)) return { rows: [{ id: 7 }] };
      return { rows: [{ ultima: 0 }], rowCount: filas };
    },
  });
  const alta = rutas['POST /api/eventos/suscripciones'];
  assert.equal((await llamar(alta, {})).statusCode, 400, 'sin cuerpo: falta el nombre');
  let r = await llamar(alta, { body: { nombre: 'x', tipos: ['llamada.entrante', 'no.existe'] } });
  assert.equal(r.statusCode, 400);
  assert.ok(r.cuerpo.tipos_validos.includes('grabacion.lista'));
  r = await llamar(alta, { body: { nombre: 'x', url: 'ftp://algo' } });
  assert.equal(r.statusCode, 400);
  assert.match(r.cuerpo.error, /http:\/\//);
  r = await llamar(alta, { body: { nombre: 'pull', secreto: 'elegido-a-mano', activa: false } });
  assert.equal(r.statusCode, 201);
  assert.equal(r.cuerpo.secreto, 'elegido-a-mano', 'si lo traen, se respeta');
  romper = true;
  r = await llamar(alta, { body: { nombre: 'x' } });
  assert.equal(r.statusCode, 500);

  const listar = rutas['GET /api/eventos/suscripciones'];
  assert.equal((await llamar(listar)).statusCode, 500);

  const editar = rutas['PUT /api/eventos/suscripciones/:id'];
  assert.equal((await llamar(editar, { params: { id: '3' } })).statusCode, 500);
  romper = false;
  r = await llamar(editar, { params: { id: '3' }, body: { tipos: 'no-es-lista', url: 5, activa: 0 } });
  assert.deepEqual(r.cuerpo, { updated: 3 });
  r = await llamar(editar, { params: { id: '3' } });
  assert.deepEqual(r.cuerpo, { updated: 3 }, 'sin cuerpo no cambia nada pero no revienta');
  filas = 0;
  assert.equal((await llamar(editar, { params: { id: '9' }, body: {} })).statusCode, 404);

  const borrar = rutas['DELETE /api/eventos/suscripciones/:id'];
  assert.equal((await llamar(borrar, { params: { id: '9' } })).statusCode, 404);
  romper = true;
  assert.equal((await llamar(borrar, { params: { id: '9' } })).statusCode, 500);

  // El evento de prueba sin usuario (token de servicio) dice que vino del panel.
  romper = false;
  r = await llamar(rutas['POST /api/eventos/prueba'], {});
  assert.match(r.cuerpo.emitido, /^[0-9a-f-]{36}$/);
});

test('modo pull: cursor explícito, sin eventos, acuse inválido y errores de base', async (t) => {
  let modo = 'ok';
  const { rutas } = armar(t, {
    query: (sql, args) => {
      if (modo === 'rota') throw new Error('base caída');
      if (/SELECT id, cursor, tipos/.test(sql)) return { rows: [{ id: 1, cursor: '5', tipos: null }] };
      if (/FROM pbxng_eventos_salida/.test(sql)) { assert.deepEqual(args, ['12', []]); return { rows: [] }; }
      return { rows: [], rowCount: modo === 'sin-sub' ? 0 : 1 };
    },
  });
  const leer = rutas['GET /api/v1 /eventos'];
  let r = await llamar(leer, { query: { desde_cursor: '12', limite: '9999' }, cliente: { id: 'c1' } });
  assert.equal(r.cuerpo.tope_aplicado, 500, 'el límite tiene techo');
  assert.equal(r.cuerpo.next_cursor, '12', 'sin eventos el cursor no se mueve');
  assert.equal(r.cuerpo.aviso, undefined);
  assert.equal(r.cuerpo.truncado, false);
  modo = 'rota';
  assert.equal((await llamar(leer, { cliente: { id: 'c1' } })).statusCode, 500);

  const acuse = rutas['POST /api/v1 /eventos/acuse'];
  assert.equal((await llamar(acuse, { cliente: { id: 'c1' } })).statusCode, 400, 'sin cuerpo no hay cursor');
  assert.equal((await llamar(acuse, { body: { cursor: '-3' }, cliente: { id: 'c1' } })).statusCode, 400);
  assert.equal((await llamar(acuse, { body: { cursor: '3' }, cliente: { id: 'c1' } })).statusCode, 500);
  modo = 'sin-sub';
  assert.equal((await llamar(acuse, { body: { cursor: '3' }, cliente: { id: 'c1' } })).statusCode, 409);
  modo = 'ok';
  r = await llamar(acuse, { body: { cursor: 3 }, cliente: { id: 'c1' } });
  assert.deepEqual(r.cuerpo, { ok: true, cursor: '3' });
});

test('sin router v1 ni alcance no se montan las rutas del modo pull', (t) => {
  const { rutas } = armar(t, { conV1: false });
  assert.equal(rutas['GET /api/v1 /eventos'], undefined);
  assert.ok(rutas['GET /api/eventos/catalogo']);
});

test('sin alertas configuradas el tope de intentos sólo deja log; el listado calcula pendientes', async (t) => {
  const { ob, logs, rutas } = armar(t, {
    query: (sql) => {
      if (/SELECT id, nombre, url, secreto/.test(sql)) return { rows: [{ id: 5, nombre: 'n', url: 'http://d/x', secreto: 's', tipos: [], cursor: 0, intentos: 11 }] };
      if (/MAX\(secuencia\)/.test(sql)) return { rows: [{ ultima: '30' }] };
      if (/FROM pbxng_suscripciones ORDER BY id/.test(sql)) return { rows: [{ id: 1, cursor: '10' }, { id: 2, cursor: '45' }] };
      if (/FROM pbxng_eventos_salida/.test(sql)) return { rows: [{ secuencia: 1 }] };
      return { rows: [], rowCount: 1 };
    },
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  await ob._vuelta();
  assert.ok(logs.some((l) => l[0] === 'error' && /12 intentos fallidos/.test(l[1])));
  const r = await llamar(rutas['GET /api/eventos/suscripciones']);
  assert.equal(r.cuerpo.ultima_secuencia, 30);
  assert.deepEqual(r.cuerpo.suscripciones.map((s) => s.pendientes), [20, 0], 'un cursor adelantado no da pendientes negativos');
  const cat = await llamar(rutas['GET /api/eventos/catalogo']);
  assert.equal(cat.cuerpo['grabacion.lista'].version, 1);
  const e = await llamar(rutas['PUT /api/eventos/suscripciones/:id'], { params: { id: '1' }, body: { tipos: ['llamada.entrante', 'basura'], nombre: 'nuevo' } });
  assert.deepEqual(e.cuerpo, { updated: 1 });
});
