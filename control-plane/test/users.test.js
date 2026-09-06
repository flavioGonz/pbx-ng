/* Integración · usuarios (/api/users, docs/CONTRATOS.md §2) contra la API real y un
 * PostgreSQL efímero. Sin Postgres disponible se saltea. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

test('users: alta con rol default agente, clave corta 400, último admin no se borra', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  await t.test('alta sin role → agente; role inválido → 400; duplicado → 409', async () => {
    const r = await api('POST', '/api/users', { token: admin, body: { username: 'juan', password: 'Clave-juan-123', name: 'Juan' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const lista = await api('GET', '/api/users', { token: admin });
    assert.equal(lista.status, 200);
    const juan = lista.json.find((u) => u.username === 'juan');
    assert.ok(juan);
    assert.equal(juan.role, 'agente');
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'x', password: 'Clave-x-12345', role: 'operator' } })).status, 400);
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'juan', password: 'Clave-juan-123' } })).status, 409);
  });

  await t.test('contraseña corta → 400 (alta y cambio por admin)', async () => {
    const r = await api('POST', '/api/users', { token: admin, body: { username: 'corto', password: '1234567' } });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /8 caracteres/);
    const lista = (await api('GET', '/api/users', { token: admin })).json;
    const juan = lista.find((u) => u.username === 'juan');
    assert.equal((await api('POST', '/api/users/' + juan.id + '/password', { token: admin, body: { password: 'corta' } })).status, 400);
    assert.equal((await api('POST', '/api/users/' + juan.id + '/password', { token: admin, body: { password: 'Clave-nueva-999' } })).status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { username: 'juan', password: 'Clave-nueva-999' } })).status, 200);
  });

  await t.test('no se borra el propio usuario ni el último admin', async () => {
    const lista = (await api('GET', '/api/users', { token: admin })).json;
    const yo = lista.find((u) => u.username === 'admin');
    const propio = await api('DELETE', '/api/users/' + yo.id, { token: admin });
    assert.equal(propio.status, 400);
    assert.match(String(propio.json.error), /propio usuario/);
    // Con dos admins, borrar uno (que no sea uno mismo) está permitido.
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'admin2', password: 'Clave-admin2-1', role: 'admin' } })).status, 201);
    let a2 = (await api('GET', '/api/users', { token: admin })).json.find((u) => u.username === 'admin2');
    assert.equal((await api('DELETE', '/api/users/' + a2.id, { token: admin })).status, 200);
    /* La regla del ÚLTIMO admin: como nadie puede borrarse a sí mismo, hace falta otra
     * sesión de admin cuyo usuario ya no cuente como admin en la base. Se crea admin2 de
     * nuevo, se le degrada el rol por SQL (el JWT de 12 h sigue diciendo admin: el RBAC lo
     * deja pasar) y con esa sesión se intenta borrar al único admin que queda. */
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'admin2', password: 'Clave-admin2-1', role: 'admin' } })).status, 201);
    const admin2 = (await login('admin2', 'Clave-admin2-1')).token;
    await ctx.db.query("UPDATE pbxng_users SET role='supervisor' WHERE username='admin2'");
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM pbxng_users WHERE role='admin'")).rows[0].n, 1);
    const ultimo = await api('DELETE', '/api/users/' + yo.id, { token: admin2 });
    assert.equal(ultimo.status, 400, JSON.stringify(ultimo.json));
    assert.match(String(ultimo.json.error), /último administrador/);
    // Un usuario que no es admin sí se puede borrar; uno inexistente da 404.
    a2 = (await api('GET', '/api/users', { token: admin })).json.find((u) => u.username === 'admin2');
    assert.equal((await api('DELETE', '/api/users/' + a2.id, { token: admin })).status, 200);
    assert.equal((await api('DELETE', '/api/users/999999', { token: admin })).status, 404);
  });
});
