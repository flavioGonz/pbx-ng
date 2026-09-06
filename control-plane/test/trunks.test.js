/* Integración · troncales y rutas (trunks.js, docs/CONTRATOS.md §3) contra la API real
 * y un PostgreSQL efímero. Sin Postgres disponible se saltea. Asterisk no está: el
 * estado de las troncales sale 'offline' y eso es lo esperado acá. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

test('trunks/routes: crear troncal SIP, listar, ruta saliente, borrar', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  await t.test('validaciones: sin host 400; registro sin usuario/clave 400', async () => {
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'sinhost' } })).status, 400);
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'reg', provider_host: 'sip.ejemplo.test', mode: 'register' } })).status, 400);
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'kam', kind: 'kamailio', provider_host: 'x' } })).status, 400);
  });

  await t.test('crear troncal SIP con registro y listarla (con sus filas pjsip)', async () => {
    const r = await api('POST', '/api/trunks', { token: admin, body: { name: 'operador', provider_host: 'sip.ejemplo.test', provider_port: 5060, mode: 'register', username: 'usr', password: 'clave', codecs: ['alaw', 'ulaw'], outbound_prefix: '9' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.mode, 'register');
    const lista = await api('GET', '/api/trunks', { token: admin });
    assert.equal(lista.status, 200);
    const tk = lista.json.find((x) => x.name === 'operador');
    assert.ok(tk, 'la troncal tiene que aparecer en GET /api/trunks');
    assert.equal(tk.kind, 'asterisk');
    assert.equal(tk.mode, 'register');
    assert.equal(tk.status, 'offline');   // sin Asterisk no hay registro
    for (const tabla of ['ps_endpoints', 'ps_aors', 'ps_auths', 'ps_registrations', 'ps_endpoint_id_ips']) {
      const { rows } = await ctx.db.query('SELECT 1 FROM ' + tabla + " WHERE id='operador'");
      assert.equal(rows.length, 1, tabla + ' debería tener la fila de la troncal');
    }
    // El prefijo de salida '9' dejó la extensión _9. en el dialplan realtime.
    const { rows: dp } = await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten='_9.' ORDER BY priority");
    assert.ok(dp.some((x) => x.app === 'Dial' && /@operador/.test(x.appdata)), JSON.stringify(dp));
    const det = await api('GET', '/api/trunks/operador/detail', { token: admin });
    assert.equal(det.status, 200);
    assert.equal(det.json.has_password, true);
    assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'operador', provider_host: 'otro', mode: 'ip' } })).status, 409);   // 23505 → 409 (errores.js)
  });

  await t.test('ruta saliente: sin patrón 400; crear (troncal por defecto), listar, borrar', async () => {
    assert.equal((await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'x' } })).status, 400);
    const r = await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'Celulares', pattern: '09XXXXXXX', strip: 0 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.trunk, 'operador');   // sin SBC, sale por la primera troncal de operador
    const lista = await api('GET', '/api/routes/outbound', { token: admin });
    assert.equal(lista.status, 200);
    const ruta = lista.json.find((x) => x.pattern === '09XXXXXXX');
    assert.ok(ruta);
    const { rows: dp } = await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='internal' AND exten='_09XXXXXXX' ORDER BY priority");
    assert.ok(dp.some((x) => x.app === 'Dial' && /@operador,60/.test(x.appdata)), JSON.stringify(dp));
    const d = await api('DELETE', '/api/routes/outbound/' + ruta.id, { token: admin });
    assert.equal(d.status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='_09XXXXXXX'")).rows.length, 0);
    assert.equal((await api('GET', '/api/routes/outbound', { token: admin })).json.length, 0);
  });

  await t.test('ruta entrante: crear, listar, borrar', async () => {
    assert.equal((await api('POST', '/api/routes/inbound', { token: admin, body: { did: '24000000' } })).status, 400);
    const r = await api('POST', '/api/routes/inbound', { token: admin, body: { did: '24000000', dest_type: 'interno', dest_value: '1001' } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const lista = (await api('GET', '/api/routes/inbound', { token: admin })).json;
    const ruta = lista.find((x) => x.did === '24000000');
    assert.ok(ruta);
    assert.equal((await api('DELETE', '/api/routes/inbound/' + ruta.id, { token: admin })).status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM extensions WHERE context='from-trunk' AND exten='24000000'")).rows.length, 0);
  });

  await t.test('borrar la troncal limpia pbxng_trunks y las tablas pjsip', async () => {
    const d = await api('DELETE', '/api/trunks/operador', { token: admin });
    assert.equal(d.status, 200);
    for (const tabla of ['pbxng_trunks', 'ps_endpoints', 'ps_aors', 'ps_auths', 'ps_registrations', 'ps_endpoint_id_ips']) {
      const col = tabla === 'pbxng_trunks' ? 'name' : 'id';
      assert.equal((await ctx.db.query('SELECT 1 FROM ' + tabla + ' WHERE ' + col + "='operador'")).rows.length, 0, tabla);
    }
    // Sin troncal ni SBC, una ruta saliente nueva no tiene por dónde salir.
    const r = await api('POST', '/api/routes/outbound', { token: admin, body: { pattern: '0X.' } });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /troncal/);
  });
});
