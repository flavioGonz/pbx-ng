/* Integración · permisos por rol (rbac.js, docs/CONTRATOS.md §2) contra la API real
 * y un PostgreSQL efímero. Sin Postgres disponible se saltea. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

test('rbac: agente, supervisor y admin sobre users/settings/trunks/security', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;

  const admin = (await login('admin', 'admin')).token;
  for (const [u, role] of [['sup', 'supervisor'], ['age', 'agente']]) {
    const r = await api('POST', '/api/users', { token: admin, body: { username: u, password: 'Clave-' + u + '-123', role } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }
  const sup = (await login('sup', 'Clave-sup-123')).token;
  const age = (await login('age', 'Clave-age-123')).token;

  await t.test('agente: 403 en users, settings y trunks; 200 en lo propio', async () => {
    for (const ruta of ['/api/users', '/api/settings', '/api/trunks', '/api/security', '/api/calls/live']) {
      const r = await api('GET', ruta, { token: age });
      assert.equal(r.status, 403, ruta + ' → ' + r.status);
      assert.equal(r.json.error, 'no tenés permiso para esta acción');
    }
    assert.equal((await api('POST', '/api/users', { token: age, body: { username: 'x', password: 'Clave-x-12345' } })).status, 403);
    assert.equal((await api('GET', '/api/auth/me', { token: age })).status, 200);
    assert.equal((await api('GET', '/api/modules', { token: age })).status, 200);
  });

  await t.test('supervisor: 200 en /api/security (lectura) y 403 en POST security/block', async () => {
    const r = await api('GET', '/api/security', { token: sup });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.kpis && Array.isArray(r.json.bloqueos));
    assert.equal((await api('GET', '/api/security/live', { token: sup })).status, 200);
    const b = await api('POST', '/api/security/block', { token: sup, body: { ip: '203.0.113.5' } });
    assert.equal(b.status, 403);
    assert.equal((await api('GET', '/api/security/whitelist', { token: sup })).status, 403);
    // Operación sí, configuración de sistema no.
    assert.equal((await api('GET', '/api/calls/live', { token: sup })).status, 200);
    assert.equal((await api('GET', '/api/users', { token: sup })).status, 403);
    assert.equal((await api('GET', '/api/settings', { token: sup })).status, 403);
    assert.equal((await api('GET', '/api/trunks', { token: sup })).status, 403);
  });

  await t.test('admin: 200 en todo eso', async () => {
    for (const ruta of ['/api/users', '/api/settings', '/api/trunks', '/api/security', '/api/security/whitelist', '/api/calls/live']) {
      const r = await api('GET', ruta, { token: admin });
      assert.equal(r.status, 200, ruta + ' → ' + r.status + ' ' + JSON.stringify(r.json));
    }
    // El bloqueo manual llega a la base aunque el agente de Asterisk no conteste (enforcement.nft=false).
    const b = await api('POST', '/api/security/block', { token: admin, body: { ip: '203.0.113.5', reason: 'prueba' } });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const priv = await api('POST', '/api/security/block', { token: admin, body: { ip: '192.168.1.10' } });
    assert.equal(priv.status, 400);
    const u = await api('POST', '/api/security/unblock', { token: admin, body: { ip: '203.0.113.5' } });
    assert.equal(u.status, 200);
  });

  await t.test('ruta inexistente bajo /api: 404 JSON con sesión, 401 sin sesión', async () => {
    const r = await api('GET', '/api/no-existe', { token: admin });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'ruta inexistente');
    assert.equal((await api('GET', '/api/no-existe')).status, 401);
  });
});
