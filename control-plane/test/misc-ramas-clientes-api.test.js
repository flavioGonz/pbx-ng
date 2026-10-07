/* ============================================================================
 *  Credenciales de sistema de /api/v1 (clientes-api.js), en unidad.
 *
 *  Lo que se fija, porque es el contrato con el backoffice y con quien audita:
 *   - el canje client_id+secreto da el MISMO 401 para «no existe», «revocado» y
 *     «secreto incorrecto» (quien prueba credenciales no aprende cuál es);
 *   - el token se verifica contra la tabla en cada pedido: un cliente borrado o revocado
 *     deja de entrar aunque su token siga firmado, y una sesión de panel no sirve acá;
 *   - la caché de 5 s es el retraso máximo prometido y se olvida al canjear/rotar;
 *   - los alcances son una lista cerrada (se rechaza el desconocido, se deduplica, una
 *     credencial sin alcances no se crea) y cada ruta exige el suyo;
 *   - toda falla de base sale por errorHttp, nunca el mensaje crudo de Postgres.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initClientes = require('../clientes-api');

const SECRETO_JWT = 'secreto-de-prueba';

function armar({ query, conLimite = false, clientIp } = {}) {
  const consultas = [];
  const pool = { query: async (sql, args) => { consultas.push({ sql, args }); return query(sql, args); } };
  const rutas = {};
  const registrar = (m) => (ruta, ...h) => { rutas[m + ' ' + ruta] = h; };
  const app = { get: registrar('GET'), post: registrar('POST'), put: registrar('PUT'), delete: registrar('DELETE') };
  const errorHttp = (res, e) => res.status(500).json({ error: 'error interno', _causa: e.message });
  const deps = { app, pool, auth: () => {}, errorHttp, logger: () => require('../log').mudo, secret: SECRETO_JWT, clientIp };
  if (conLimite) deps.limiteIntentos = () => [(req, res, next) => next()];
  const m = initClientes(deps);
  return { m, rutas, consultas };
}

function resFalsa() {
  return { statusCode: 200, cuerpo: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.cuerpo = b; return this; } };
}
async function llamar(handlers, req = {}) {
  const res = resFalsa();
  await handlers[handlers.length - 1]({ params: {}, headers: {}, ...req }, res);
  return res;
}
async function pasar(mw, req) {
  const res = resFalsa();
  let siguio = false;
  await mw({ headers: {}, ...req }, res, () => { siguio = true; });
  return { res, siguio };
}

test('canje del token: validaciones, mismo 401 para todo lo malo y token con alcances', async () => {
  const hash = await bcrypt.hash('el-secreto', 4);
  const filas = {
    'erp.uno': { client_id: 'erp.uno', nombre: 'ERP', secreto_hash: hash, alcances: ['cdr:leer'], revocado_at: null },
    'erp.revocado': { client_id: 'erp.revocado', nombre: 'Viejo', secreto_hash: hash, alcances: null, revocado_at: new Date() },
    'sin.alcances': { client_id: 'sin.alcances', nombre: 'X', secreto_hash: hash, alcances: null, revocado_at: null },
  };
  let romper = false;
  const { rutas } = armar({ conLimite: true, query: (sql, args) => { if (romper) throw new Error('base caída'); return { rows: filas[args[0]] ? [filas[args[0]]] : [] }; } });
  const canje = rutas['POST /api/v1/auth/token'];
  assert.equal(canje.length, 2, 'con limitador de intentos, va delante del handler');

  assert.equal((await llamar(canje, {})).statusCode, 400, 'sin cuerpo');
  let r = await llamar(canje, { body: { client_id: 'X!', secret: 'algo' } });
  assert.equal(r.statusCode, 400);
  assert.match(r.cuerpo.error, /formato inválido/, '«secret» en inglés también se acepta, y el error dice que el id está mal');

  const malos = [];
  for (const body of [{ client_id: 'no.existe', secreto: 'x' }, { client_id: 'erp.revocado', secreto: 'el-secreto' }, { client_id: 'erp.uno', secreto: 'otro' }]) {
    r = await llamar(canje, { body });
    malos.push([r.statusCode, r.cuerpo.error]);
  }
  assert.deepEqual(new Set(malos.map((m) => JSON.stringify(m))).size, 1, 'los tres casos dan exactamente la misma respuesta');
  assert.equal(malos[0][0], 401);

  r = await llamar(canje, { body: { client_id: '  ERP.UNO ', secreto: 'el-secreto' } });
  assert.equal(r.statusCode, 200);
  const dato = jwt.verify(r.cuerpo.token, SECRETO_JWT);
  assert.equal(dato.scope, 'service');
  assert.deepEqual(dato.alc, ['cdr:leer']);
  r = await llamar(canje, { body: { client_id: 'sin.alcances', secreto: 'el-secreto' } });
  assert.deepEqual(r.cuerpo.alcances, []);

  romper = true;
  r = await llamar(canje, { body: { client_id: 'erp.uno', secreto: 'el-secreto' } });
  assert.equal(r.statusCode, 500);
  assert.equal(r.cuerpo.error, 'error interno');
});

test('sin limitador de intentos el canje es el handler solo', () => {
  const { rutas } = armar({ query: () => ({ rows: [] }) });
  assert.equal(rutas['POST /api/v1/auth/token'].length, 1);
});

test('authServicio: sólo tokens de servicio vigentes, verificados contra la tabla (con caché de 5 s)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const tabla = { 'erp.uno': { client_id: 'erp.uno', nombre: 'ERP', alcances: null, revocado_at: null } };
  let romper = false;
  let rechazarUso = false;
  const { m, consultas } = armar({
    clientIp: () => '10.0.0.9',
    query: async (sql, args) => {
      if (/^UPDATE/.test(sql)) { if (rechazarUso) throw new Error('no se pudo anotar'); return { rowCount: 1 }; }
      if (romper) throw new Error('base caída');
      return { rows: tabla[args[0]] ? [tabla[args[0]]] : [] };
    },
  });
  const tok = (p) => 'Bearer ' + jwt.sign(p, SECRETO_JWT);

  let x = await pasar(m.authServicio, {});
  assert.equal(x.res.statusCode, 401);
  assert.equal(x.res.cuerpo.doc, '/api/v1/auth/token');
  x = await pasar(m.authServicio, { headers: { authorization: 'Basic abc' } });
  assert.equal(x.res.statusCode, 401);
  x = await pasar(m.authServicio, { headers: { authorization: 'Bearer basura' } });
  assert.match(x.res.cuerpo.error, /inválido o vencido/);
  x = await pasar(m.authServicio, { headers: { authorization: tok({ scope: 'panel', sub: 1 }) } });
  assert.equal(x.res.statusCode, 403, 'una sesión de panel no sirve en /api/v1');
  x = await pasar(m.authServicio, { headers: { authorization: tok({ scope: 'service' }) } });
  assert.equal(x.res.statusCode, 403, 'sin cid tampoco');

  const req = { headers: { authorization: tok({ scope: 'service', cid: 'erp.uno' }) } };
  x = await pasar(m.authServicio, req);
  assert.equal(x.siguio, true);
  const upd = consultas.find((c) => /usado_at/.test(c.sql));
  assert.deepEqual(upd.args, ['erp.uno', '10.0.0.9']);

  // Revocado en la tabla: durante la caché sigue entrando (el retraso prometido)…
  tabla['erp.uno'] = { ...tabla['erp.uno'], revocado_at: new Date() };
  rechazarUso = true;                                   // y si anotar el uso falla, el pedido igual pasa
  x = await pasar(m.authServicio, req);
  assert.equal(x.siguio, true);
  await new Promise((r) => setImmediate(r));
  // …y pasados los 5 s deja de entrar.
  t.mock.timers.tick(m.CACHE_MS + 1);
  x = await pasar(m.authServicio, req);
  assert.equal(x.res.statusCode, 401);
  assert.equal(x.res.cuerpo.error, 'credencial revocada');

  m._olvidar('erp.uno');
  delete tabla['erp.uno'];
  x = await pasar(m.authServicio, req);
  assert.equal(x.res.cuerpo.error, 'el cliente de API ya no existe');

  m._olvidar('erp.uno');
  romper = true;
  x = await pasar(m.authServicio, req);
  assert.equal(x.res.statusCode, 500);
});

test('authServicio sin clientIp anota el uso con IP vacía', async () => {
  const { m, consultas } = armar({ query: async (sql) => (/^UPDATE/.test(sql) ? { rowCount: 1 } : { rows: [{ client_id: 'a.b.c', nombre: 'n', alcances: ['x'], revocado_at: null }] }) });
  const req = { headers: { authorization: 'Bearer ' + jwt.sign({ scope: 'service', cid: 'a.b.c' }, SECRETO_JWT) } };
  const x = await pasar(m.authServicio, req);
  assert.equal(x.siguio, true);
  assert.deepEqual(consultas.find((c) => /usado_at/.test(c.sql)).args, ['a.b.c', '']);
});

test('exigirAlcance: deny-by-default, aun sin req.cliente', async () => {
  const { m } = armar({ query: () => ({ rows: [] }) });
  const mw = m.exigirAlcance('cdr:leer');
  assert.equal((await pasar(mw, {})).res.statusCode, 403);
  assert.equal((await pasar(mw, { cliente: { alcances: 'cdr:leer' } })).res.statusCode, 403, 'un string no es una lista');
  const x = await pasar(mw, { cliente: { alcances: ['llamadas:ver'] } });
  assert.equal(x.res.cuerpo.alcance_requerido, 'cdr:leer');
  assert.equal((await pasar(mw, { cliente: { alcances: ['cdr:leer'] } })).siguio, true);
});

test('administración: alta, edición, rotación, revocación y baja validan y no filtran errores de base', async () => {
  let modo = 'ok';
  const { rutas, consultas } = armar({
    query: (sql) => {
      if (modo === 'rota') throw new Error('duplicate key value violates unique constraint');
      if (/^SELECT/.test(sql)) return { rows: [{ client_id: 'a' }] };
      return { rows: [], rowCount: modo === 'cero' ? 0 : 1 };
    },
  });
  const alta = rutas['POST /api/api-clients'];
  assert.equal((await llamar(alta, {})).statusCode, 400, 'sin cuerpo: id inválido');
  assert.match((await llamar(alta, { body: { client_id: 'erp.dos' } })).cuerpo.error, /nombre/);
  let r = await llamar(alta, { body: { client_id: 'erp.dos', nombre: 'ERP', alcances: 'cdr:leer,inventado' } });
  assert.equal(r.statusCode, 400);
  assert.match(r.cuerpo.error, /alcance desconocido: inventado/);
  assert.ok(r.cuerpo.alcances_validos.includes('eventos:recibir'));
  assert.match((await llamar(alta, { body: { client_id: 'erp.dos', nombre: 'ERP', alcances: ' , ' } })).cuerpo.error, /sin alcances/);
  r = await llamar(alta, { body: { client_id: 'erp.dos', nombre: ' ERP ', alcances: ['cdr:leer', null, 'cdr:leer', 'llamadas:ver'] } });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(r.cuerpo.alcances, ['cdr:leer', 'llamadas:ver'], 'duplicados y vacíos fuera');
  const ins = consultas.find((c) => /INSERT/.test(c.sql));
  assert.equal(ins.args[1], 'ERP');
  assert.equal(ins.args[4], '', 'sin notas guarda vacío');
  assert.equal(ins.args[5], null, 'sin usuario (token de servicio) no inventa autor');
  assert.ok(await bcrypt.compare(r.cuerpo.secreto, ins.args[2]), 'se guarda el hash del secreto que se mostró');
  await llamar(alta, { body: { client_id: 'erp.tres', nombre: 'X', alcances: ['cdr:leer'], notas: 'n' }, user: { username: 'admin' } });
  assert.equal(consultas.filter((c) => /INSERT/.test(c.sql)).at(-1).args[5], 'admin');

  const editar = rutas['PUT /api/api-clients/:id'];
  assert.equal((await llamar(editar, { params: { id: '!' } })).statusCode, 400);
  assert.equal((await llamar(editar, { params: { id: 'erp.dos' }, body: { alcances: ['nada'] } })).statusCode, 400);
  assert.equal((await llamar(editar, { params: { id: 'erp.dos' }, body: { alcances: [] } })).statusCode, 400);
  r = await llamar(editar, { params: { id: 'erp.dos' } });
  assert.deepEqual(r.cuerpo, { updated: 'erp.dos' });
  assert.deepEqual(consultas.at(-1).args, ['erp.dos', null, null, null], 'sin cuerpo no cambia nada');
  await llamar(editar, { params: { id: 'erp.dos' }, body: { nombre: ' Nuevo ', alcances: ['cdr:leer'], notas: '' } });
  assert.deepEqual(consultas.at(-1).args, ['erp.dos', 'Nuevo', ['cdr:leer'], '']);

  const rotar = rutas['POST /api/api-clients/:id/rotar'];
  const revocar = rutas['POST /api/api-clients/:id/revocar'];
  const borrar = rutas['DELETE /api/api-clients/:id'];
  for (const h of [rotar, revocar, borrar]) assert.equal((await llamar(h, { params: { id: 'x' } })).statusCode, 400);
  r = await llamar(rotar, { params: { id: 'erp.dos' }, user: { username: 'admin' } });
  assert.ok(r.cuerpo.secreto);
  r = await llamar(revocar, { params: { id: 'erp.dos' } });
  assert.match(r.cuerpo.aviso, /5 segundos/);
  assert.deepEqual((await llamar(borrar, { params: { id: 'erp.dos' } })).cuerpo, { deleted: 'erp.dos' });

  modo = 'cero';
  for (const h of [editar, rotar, revocar, borrar]) assert.equal((await llamar(h, { params: { id: 'erp.dos' }, body: {} })).statusCode, 404);

  modo = 'rota';
  for (const h of [rutas['GET /api/api-clients'], alta, editar, rotar, revocar, borrar]) {
    r = await llamar(h, { params: { id: 'erp.dos' }, body: { client_id: 'erp.dos', nombre: 'X', alcances: ['cdr:leer'] } });
    assert.equal(r.statusCode, 500);
    assert.equal(r.cuerpo.error, 'error interno');
  }
  modo = 'ok';
  assert.deepEqual((await llamar(rutas['GET /api/api-clients'])).cuerpo, [{ client_id: 'a' }]);
  assert.ok((await llamar(rutas['GET /api/api-clients/alcances'])).cuerpo['cdr:leer']);
});
