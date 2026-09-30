/* ============================================================================
 *  La API del proveedor «IA externa» (apps.js + migración 0029), contra un Postgres de
 *  verdad: lo que se guarda es lo que después usa la llamada para hablar con el backend.
 *
 *  Lo que se cuida: sin la URL y el token del backend, un agente de IA externa no se
 *  guarda (si se guardara, cada llamada iría al respaldo sin que nadie entienda por qué),
 *  y lo guardado vuelve en la lista para que el panel lo muestre.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

test('ia externa: se guarda con URL y token del backend; sin ellos, 400', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  const prov = await api('GET', '/api/ai-agents/proveedores', { token: admin });
  assert.ok(prov.json['ia-externa'], 'el proveedor tiene que figurar para que el panel lo ofrezca');

  const sinBackend = await api('POST', '/api/ai-agents', { token: admin, body: { name: 'Portería', exten: '9750', provider: 'ia-externa' } });
  assert.equal(sinBackend.status, 400, JSON.stringify(sinBackend.json));
  const base = { name: 'Portería', exten: '9750', provider: 'ia-externa', externo_token: 'x', default_exten: '1001' };
  for (const [caso, body] of [
    ['URL inválida', { ...base, externo_url: 'asistente' }],
    ['URL que no es http ni https', { ...base, externo_url: 'ftp://asistente.example.com' }],
    ['sin ningún destino', { ...base, externo_url: 'https://asistente.example.com', default_exten: '' }],
    ['tono de apertura inválido', { ...base, externo_url: 'https://asistente.example.com', herramientas: { abrir_porton: { on: true, modo: 'dtmf', dtmf: '1w' } } }],
  ]) {
    const r = await api('POST', '/api/ai-agents', { token: admin, body });
    assert.equal(r.status, 400, caso + ': ' + JSON.stringify(r.json));
  }

  const ok = await api('POST', '/api/ai-agents', { token: admin, body: {
    name: 'Portería', exten: '9750', provider: 'ia-externa', default_exten: '1001',
    externo_url: 'http://asistente.example.com:3100', externo_token: 'token-compartido', agentes_exten: '600' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const id = ok.json.created;

  const lista = await api('GET', '/api/ai-agents', { token: admin });
  const guardado = lista.json.find((a) => a.id === id);
  assert.equal(guardado.provider, 'ia-externa');
  assert.equal(guardado.externo_url, 'http://asistente.example.com:3100', 'http por internet se acepta: lo decide la instalación');
  assert.equal(guardado.externo_token, 'token-compartido');
  assert.equal(guardado.agentes_exten, '600');

  const cambio = await api('PUT', '/api/ai-agents/' + id, { token: admin, body: { ...guardado, agentes_exten: '601' } });
  assert.equal(cambio.status, 200, JSON.stringify(cambio.json));
  const despues = (await api('GET', '/api/ai-agents', { token: admin })).json.find((a) => a.id === id);
  assert.equal(despues.agentes_exten, '601');

  /* La tabla de la configuración bajada existe y se borra con el agente. */
  await ctx.db.query("INSERT INTO pbxng_ia_externa_config (agente_id, version, session) VALUES ($1, 'v1', '{}')", [id]);
  const baja = await api('DELETE', '/api/ai-agents/' + id, { token: admin });
  assert.equal(baja.status, 200);
  const quedo = await ctx.db.query('SELECT count(*)::int AS n FROM pbxng_ia_externa_config WHERE agente_id=$1', [id]);
  assert.equal(quedo.rows[0].n, 0);
});

test('un agente de otro proveedor no necesita backend', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  const r = await api('POST', '/api/ai-agents', { token: admin, body: { name: 'Demo', exten: '9751', provider: 'demo' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});
