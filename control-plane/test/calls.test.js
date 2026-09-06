/* Integración · control de llamadas sin Asterisk (callengine.js): la API tiene que
 * responder de forma honesta cuando ARI no está (docs/CONTRATOS.md §3, §5). Contra
 * la API real y un PostgreSQL efímero; sin Postgres disponible se saltea. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

test('calls: /api/calls/live sin ARI → via sin-ari; dial → 503', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  await t.test('GET /api/calls/live → 200 {channels:[], via:"sin-ari"}', async () => {
    const r = await api('GET', '/api/calls/live', { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.channels, []);
    assert.deepEqual(r.json.spies, []);
    assert.equal(r.json.via, 'sin-ari');
    const h = await api('GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.db, true);
    assert.equal(h.json.ari, false);
    assert.equal(h.json.ami, false);
  });

  await t.test('POST /api/calls/dial → 503 "ARI no disponible" (y 400 sin from/to)', async () => {
    assert.equal((await api('POST', '/api/calls/dial', { token: admin, body: { to: '1002' } })).status, 400);
    const r = await api('POST', '/api/calls/dial', { token: admin, body: { from: '1001', to: '1002' } });
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.match(String(r.json.error), /ARI no disponible/);
    assert.equal((await api('POST', '/api/calls/abc/hangup', { token: admin })).status, 503);
  });

  await t.test('un agente no puede marcar desde otra extensión (403) aunque ARI falte', async () => {
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'age', password: 'Clave-age-123', role: 'agente', ext: '1001' } })).status, 201);
    const age = (await login('age', 'Clave-age-123')).token;
    const ajena = await api('POST', '/api/calls/dial', { token: age, body: { from: '1002', to: '1003' } });
    assert.equal(ajena.status, 403, JSON.stringify(ajena.json));
    const propia = await api('POST', '/api/calls/dial', { token: age, body: { from: '1001', to: '1003' } });
    assert.equal(propia.status, 503);   // pasó el alcance; lo que falta es ARI
    assert.equal((await api('GET', '/api/calls/live', { token: age })).status, 403);   // live es SUP
  });
});
