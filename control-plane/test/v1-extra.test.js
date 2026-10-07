/* ============================================================================
 *  Integración · /api/v1 con todos los alcances y Asterisk de mentira: grabaciones por
 *  rango y por call_id, llamadas en curso (y el 503 honesto sin ARI), internos con su
 *  estado, originar con idempotencia, el 404 de v1 y la gestión de credenciales.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const { ariFalso } = require('./helpers/ari-falso');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 6000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(80); } return fn(); }

test('v1 con todos los alcances: grabaciones, llamadas, internos, originar y credenciales', async (t) => {
  const ari = await ariFalso();
  t.after(() => ari.cerrar());
  const ctx = await entorno(t, ari.env);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  const alta = await api('POST', '/api/api-clients', { token: admin, body: { client_id: 'todo', nombre: 'Todo', alcances: ['cdr:leer', 'grabaciones:leer', 'llamadas:ver', 'llamadas:ordenar', 'internos:ver'] } });
  assert.equal(alta.status, 201, JSON.stringify(alta.json));
  const tok = (await api('POST', '/api/v1/auth/token', { body: { client_id: 'todo', secreto: alta.json.secreto } })).json.token;
  const v1 = (m, r, o) => api(m, '/api/v1' + r, Object.assign({ token: tok }, o || {}));

  await ari.conectado();
  await hasta(async () => (await api('GET', '/health')).json.ari === true);

  await t.test('grabaciones: por rango, por call_id y el rango demasiado largo', async () => {
    await ctx.db.query("INSERT INTO pbxng_recordings (filename, ext, src, dst, started_at, bytes, duration, storage, deleted, linkedid, origen) VALUES ('a.wav','2001','2001','099',now() - interval '1 hour',1000,5,'local',false,'L-1','interno'),('b.wav','2002','2002','098',now() - interval '2 hour',1000,5,'local',false,'L-2','interno'),('c.wav','2003','2003','097',now(),1000,5,'local',true,'L-3','interno')");
    const d = new Date(Date.now() - 864e5).toISOString(), h = new Date(Date.now() + 60e3).toISOString();
    const todas = await v1('GET', '/grabaciones?desde=' + d + '&hasta=' + h);
    assert.equal(todas.status, 200, JSON.stringify(todas.json));
    assert.deepEqual(todas.json.items.map((x) => x.call_id), ['L-1', 'L-2'], 'las borradas no salen, de la más nueva a la más vieja');
    const una = await v1('GET', '/grabaciones?desde=' + d + '&hasta=' + h + '&call_id=L-2');
    assert.deepEqual(una.json.items.map((x) => x.call_id), ['L-2']);
    assert.equal((await v1('GET', '/grabaciones?desde=2020-01-01T00:00:00Z&hasta=' + h)).status, 400);
  });

  await t.test('llamadas en curso e internos con su estado', async () => {
    ari.canal({ id: 'c1', name: 'PJSIP/2001-0001', state: 'Up', caller: { name: 'Ana', number: '2001' } });
    const l = await hasta(async () => { const r = await v1('GET', '/llamadas'); return r.status === 200 && r.json.items.length ? r : null; });
    assert.equal(l.json.items[0].ext, '2001');
    await api('POST', '/api/endpoints', { token: admin, body: { id: '2001', password: 'Clave-2001-xx', name: 'Ana' } });
    await api('POST', '/api/endpoints', { token: admin, body: { id: '2002', password: 'Clave-2002-xx' } });
    ari.emitir({ type: 'EndpointStateChange', endpoint: { technology: 'PJSIP', resource: '2001', state: 'online', channel_ids: ['c1'] } });
    const i = await hasta(async () => { const r = (await v1('GET', '/internos')).json; return r.items.find((x) => x.interno === '2001' && x.estado === 'online') ? r : null; });
    assert.ok(i, 'el estado del interno no viene del ARI');
    assert.deepEqual(i.items.find((x) => x.interno === '2001'), { interno: '2001', nombre: 'Ana', estado: 'online', canales: 1 });
    assert.equal(i.items.find((x) => x.interno === '2002').estado, 'offline');
  });

  await t.test('originar: validaciones, 202, y la misma clave de idempotencia no llama dos veces', async () => {
    assert.equal((await v1('POST', '/llamadas/originar', { body: {} })).status, 400);
    assert.equal((await v1('POST', '/llamadas/originar', { body: { desde: '2001', hacia: '099;rm' } })).status, 400);
    ari.olvidar();
    const h = { 'Idempotency-Key': 'orden-1' };
    const a = await v1('POST', '/llamadas/originar', { body: { desde: '2001', hacia: '099123456' }, headers: h });
    assert.equal(a.status, 202, JSON.stringify(a.json));
    const b = await v1('POST', '/llamadas/originar', { body: { desde: '2001', hacia: '099123456' }, headers: h });
    assert.deepEqual(b.json, a.json);
    assert.equal(ari.pedidos('POST', /^\/channels$/).length, 1, 'reintentar con la misma clave no origina otra llamada');
    ari.fallar('POST', '/channels', 500);
    assert.ok((await v1('POST', '/llamadas/originar', { body: { desde: '2001', hacia: '099' } })).status >= 500);
    ari.sanar();
  });

  await t.test('el 404 de v1 dice que es un subconjunto', async () => {
    const r = await v1('GET', '/lo-que-sea');
    assert.equal(r.status, 404);
    assert.match(r.json.detalle, /subconjunto chico y congelado/);
  });

  await t.test('credenciales: rotar el secreto, revocar, y una revocada no entra', async () => {
    assert.ok((await api('GET', '/api/api-clients/alcances', { token: admin })).json['grabaciones:leer']);
    assert.equal((await api('PUT', '/api/api-clients/todo', { token: admin, body: { nombre: 'Todo 2', notas: 'x' } })).status, 200);
    assert.equal((await api('PUT', '/api/api-clients/no-existe', { token: admin, body: { nombre: 'x' } })).status, 404);
    const rot = await api('POST', '/api/api-clients/todo/rotar', { token: admin });
    assert.equal(rot.status, 200, JSON.stringify(rot.json));
    assert.equal((await api('POST', '/api/v1/auth/token', { body: { client_id: 'todo', secreto: alta.json.secreto } })).status, 401, 'el secreto viejo ya no sirve');
    assert.equal((await api('POST', '/api/api-clients/no-existe/rotar', { token: admin })).status, 404);
    assert.equal((await api('POST', '/api/api-clients/todo/revocar', { token: admin })).status, 200);
    assert.equal((await api('POST', '/api/api-clients/todo/revocar', { token: admin })).status, 404, 'ya estaba revocado');
    await dormir(5200);   // el estado del cliente se recuerda 5 s
    assert.equal((await v1('GET', '/yo')).status, 401, 'una credencial revocada no entra aunque el token no haya vencido');
    assert.ok((await api('DELETE', '/api/api-clients/todo', { token: admin })).status < 300);
    assert.equal((await api('DELETE', '/api/api-clients/todo', { token: admin })).status, 404);
  });
});
