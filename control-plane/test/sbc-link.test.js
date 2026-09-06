/* Integración · enlace con SBC-NG (/api/sbc-link, docs/CONTRATOS.md §3) contra la API
 * real y un PostgreSQL efímero. Sin Postgres disponible se saltea. El agente de
 * Asterisk no está (el reload posterior falla en silencio, como está previsto). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

test('sbc-link: GET sin SBC → active:false; POST → active:true (mod_sbc=1); DELETE', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  await t.test('sin SBC: active:false, módulo apagado', async () => {
    const r = await api('GET', '/api/sbc-link', { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.active, false);
    assert.equal(r.json.configured, false);
    assert.equal(r.json.enabled, false);
    assert.equal(r.json.rutas_salientes, 0);
    const m = await api('GET', '/api/modules', { token: admin });
    assert.equal(m.status, 200);
  });

  await t.test('POST sin host → 400', async () => {
    const r = await api('POST', '/api/sbc-link', { token: admin, body: { port: 5060 } });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /IP del SBC-NG/);
  });

  await t.test('POST con host → active:true, mod_sbc=1, troncal to-sbc y ruta "marca 0"', async () => {
    const r = await api('POST', '/api/sbc-link', { token: admin, body: { host: '127.0.0.1', port: 5060, transport: 'udp', panel_url: 'https://sbc.ejemplo.test' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.link.active, true);
    assert.equal(r.json.link.host, '127.0.0.1');
    assert.equal(r.json.ruta_creada, '0X.');
    const s = (await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='mod_sbc'")).rows[0];
    assert.equal(s && s.value, '1');
    assert.equal((await ctx.db.query("SELECT 1 FROM pbxng_trunks WHERE name='to-sbc' AND kind='sbc'")).rows.length, 1);
    assert.equal((await ctx.db.query("SELECT 1 FROM ps_endpoint_id_ips WHERE id='to-sbc' AND match='127.0.0.1'")).rows.length, 1);
    const g = await api('GET', '/api/sbc-link', { token: admin });
    assert.equal(g.json.active, true);
    assert.equal(g.json.panel_url, 'https://sbc.ejemplo.test');
    assert.equal(g.json.rutas_salientes, 1);
    assert.ok(g.json.estado && typeof g.json.estado.vivo === 'boolean');   // se midió el puerto (está cerrado)
    // Con SBC activo, una ruta saliente nueva sale por to-sbc por defecto.
    const ruta = await api('POST', '/api/routes/outbound', { token: admin, body: { pattern: '1X.' } });
    assert.equal(ruta.status, 201);
    assert.equal(ruta.json.trunk, 'to-sbc');
    const lista = (await api('GET', '/api/trunks', { token: admin })).json;
    assert.ok(lista.some((x) => x.name === 'to-sbc' && x.kind === 'sbc'));
  });

  await t.test('DELETE: borra troncal y rutas dependientes, apaga el módulo', async () => {
    const d = await api('DELETE', '/api/sbc-link', { token: admin });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.rutas_borradas, 2);
    const g = await api('GET', '/api/sbc-link', { token: admin });
    assert.equal(g.json.active, false);
    assert.equal(g.json.configured, false);
    assert.equal((await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='mod_sbc'")).rows[0].value, '0');
    assert.equal((await ctx.db.query("SELECT 1 FROM pbxng_trunks WHERE kind='sbc'")).rows.length, 0);
    assert.equal((await ctx.db.query("SELECT 1 FROM ps_endpoints WHERE id='to-sbc'")).rows.length, 0);
    assert.equal((await ctx.db.query("SELECT 1 FROM pbxng_outbound_routes WHERE trunk='to-sbc'")).rows.length, 0);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten IN ('_0X.','_1X.')")).rows.length, 0);
  });
});
