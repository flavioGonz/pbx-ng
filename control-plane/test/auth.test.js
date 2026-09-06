/* Integración · autenticación (docs/CONTRATOS.md §2) contra la API real y un
 * PostgreSQL efímero (test/helpers/db.js). Sin Postgres disponible se saltea. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

test('auth: login, must_change, cambio de clave, rate limit y token phone', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api } = ctx.api;

  let token;
  await t.test('bootstrap: admin entra con ADMIN_DEFAULT_PASS y must_change=true', async () => {
    const r = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.token);
    assert.equal(r.json.user.role, 'admin');
    assert.equal(r.json.must_change, true);
    token = r.json.token;
    const s = await api('GET', '/api/auth/setup');
    assert.equal(s.json.defaultAdmin, true);
  });

  await t.test('sin token → 401; token inválido → 401', async () => {
    assert.equal((await api('GET', '/api/auth/me')).status, 401);
    assert.equal((await api('GET', '/api/auth/me', { token: 'x.y.z' })).status, 401);
    const me = await api('GET', '/api/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.username, 'admin');
  });

  await t.test('cambio de clave: corta → 400; primer ingreso no exige current', async () => {
    assert.equal((await api('POST', '/api/auth/password', { token, body: { password: 'corta' } })).status, 400);
    const r = await api('POST', '/api/auth/password', { token, body: { password: 'ClaveNueva-123' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // A partir de acá must_change es false: la clave vieja ya no entra y setup lo refleja.
    assert.equal((await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin' } })).status, 401);
    const l = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'ClaveNueva-123' } });
    assert.equal(l.status, 200);
    assert.equal(l.json.must_change, false);
    token = l.json.token;
    assert.equal((await api('GET', '/api/auth/setup')).json.defaultAdmin, false);
  });

  await t.test('cambio de clave después del primer ingreso exige current correcta', async () => {
    let r = await api('POST', '/api/auth/password', { token, body: { password: 'OtraClave-456' } });
    assert.equal(r.status, 400);
    r = await api('POST', '/api/auth/password', { token, body: { password: 'OtraClave-456', current: 'no-es' } });
    assert.equal(r.status, 403);
    r = await api('POST', '/api/auth/password', { token, body: { password: 'OtraClave-456', current: 'ClaveNueva-123' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'OtraClave-456' } })).status, 200);
  });

  await t.test('rate limit: 10 fallos por IP+usuario → 429 (y el login correcto no consume cupo)', async () => {
    // Usuario propio para no ensuciar el contador del admin en las demás subpruebas.
    const alta = await api('POST', '/api/users', { token, body: { username: 'victima', password: 'Victima-12345', role: 'agente' } });
    assert.equal(alta.status, 201, JSON.stringify(alta.json));
    for (let i = 0; i < 10; i++) {
      const r = await api('POST', '/api/auth/login', { body: { username: 'victima', password: 'mal-' + i } });
      assert.equal(r.status, 401, 'fallo ' + (i + 1) + ' → ' + r.status);
    }
    const r11 = await api('POST', '/api/auth/login', { body: { username: 'victima', password: 'Victima-12345' } });
    assert.equal(r11.status, 429);
    assert.match(String(r11.json.error), /Demasiados intentos/);
    // Otro usuario desde la misma IP sigue pudiendo entrar: la clave del límite es IP+usuario.
    assert.equal((await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'OtraClave-456' } })).status, 200);
  });

  await t.test('token de softphone (scope phone) no entra a /api/settings ni a /api/auth/me', async () => {
    // Un interno con clave SIP conocida (la fila de ps_auths alcanza para POST phone/token).
    await ctx.db.query("INSERT INTO ps_auths (id,auth_type,username,password) VALUES ('1001','userpass','1001','ClaveSip-1001')");
    const mal = await api('POST', '/api/phone/token', { body: { ext: '1001', password: 'otra' } });
    assert.equal(mal.status, 401);
    const ok = await api('POST', '/api/phone/token', { body: { ext: '1001', password: 'ClaveSip-1001' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const ph = ok.json.token;
    const s = await api('GET', '/api/settings', { token: ph });
    assert.equal(s.status, 403);
    assert.match(String(s.json.error), /softphone/);
    assert.equal((await api('GET', '/api/auth/me', { token: ph })).status, 403);
    assert.equal((await api('GET', '/api/users', { token: ph })).status, 403);
    // Lo que sí lista FONO_PERMITIDO responde (branding es público además; directory exige sesión).
    assert.equal((await api('GET', '/api/directory', { token: ph })).status, 200);
  });
});
