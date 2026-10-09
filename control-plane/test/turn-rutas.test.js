/* ============================================================================
 *  Integración · las rutas de TURN que faltaban (turn.js): probar el origen efectivo
 *  contra un TURN de mentira (UDP y TCP), la consola del coturn propio reenviada a su
 *  agente, y los rechazos al elegir origen.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const { turnFalso } = require('./helpers/turn-falso');
const { httpFalso } = require('./helpers/http-falso');

test('TURN: probar y testear el origen efectivo, la consola del coturn y los rechazos', async (t) => {
  const agente = await httpFalso();
  const srv = await turnFalso({});
  t.after(async () => { await agente.cerrar(); await srv.cerrar(); });
  const ctx = await entorno(t, { TURN_AGENT: agente.url });
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  await t.test('elegir origen: inválido, SBC sin enlace, externo sin URL', async () => {
    assert.equal((await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'marte' } })).status, 400);
    assert.match((await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'sbc' } })).json.error, /no hay un enlace a SBC-NG/);
    assert.match((await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'externo', externo_urls: '' } })).json.error, /al menos una URL/);
  });

  await t.test('probar y testear contra un TURN externo que contesta por UDP y TCP', async () => {
    const r = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'externo', externo_urls: 'turn:127.0.0.1:' + srv.puerto, externo_usuario: 'u', externo_clave: 'p' }, timeout: 20000 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const p = await api('POST', '/api/turn/probe', { token: admin, body: { host: '10.0.0.1' }, timeout: 20000 });
    assert.equal(p.status, 200);
    assert.equal(p.json.origen, 'externo');
    assert.equal(p.json.host, '127.0.0.1', 'el cuerpo se ignora: se sondea el origen efectivo y nada más');
    assert.ok(p.json.udp && p.json.tcp);
    const tt = await api('POST', '/api/turn/test', { token: admin, timeout: 20000 });
    assert.equal(tt.status, 200);
    assert.match(tt.json.out, /^UDP 127\.0\.0\.1:\d+/m);
    assert.match(tt.json.out, /^TCP 127\.0\.0\.1:\d+/m);
    assert.match(tt.json.out, /=> /);
  });

  await t.test('la consola del coturn propio pasa por su agente', async () => {
    agente.ruta('GET', '/health', { ok: true, up: true });
    agente.ruta('GET', '/config', { realm: 'pbx' });
    agente.ruta('POST', '/config', (q) => ({ guardado: q.body }));
    agente.ruta('POST', '/restart', { ok: true });
    agente.ruta('GET', '/logs', { lineas: ['a'] });
    assert.equal((await api('GET', '/api/turn', { token: admin })).json.up, true);
    assert.equal((await api('GET', '/api/turn/config', { token: admin })).json.realm, 'pbx');
    assert.deepEqual((await api('POST', '/api/turn/config', { token: admin, body: { realm: 'x' } })).json.guardado, { realm: 'x' });
    assert.equal((await api('POST', '/api/turn/restart', { token: admin })).json.ok, true);
    assert.deepEqual((await api('GET', '/api/turn/logs', { token: admin })).json.lineas, ['a']);
    await agente.cerrar();
    assert.ok((await api('GET', '/api/turn', { token: admin })).status >= 500, 'sin agente se dice, no se cuelga');
  });
});
