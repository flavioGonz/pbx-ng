/* ============================================================================
 *  Integración · lo de marcación que la prueba principal no toca, ahora con un AMI de
 *  mentira: la llamada que el callback devuelve de verdad (Originate) y a dónde la
 *  manda según el destino, editar y borrar un callback y una DISA, el prefijo de los
 *  abreviados personales y el volcado de abreviados a la AstDB cuando vuelve el AMI.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');

const txt = (r) => String((r.json && r.json._raw != null ? r.json._raw : r.json) || '').trim();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 6000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(100); } return fn(); }

test('marcación: callback que devuelve la llamada, edición, bajas y prefijo de abreviados', async (t) => {
  const ami = await amiFalso();
  t.after(() => ami.cerrar());
  const ctx = await entorno(t, ami.env);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  const tok = fs.readFileSync(path.join(ctx.api.confDir, 'agent.token'), 'utf8').trim();
  assert.equal((await api('POST', '/api/trunks', { token: admin, body: { name: 'op1', provider_host: 'sip.ejemplo.test', mode: 'ip' } })).status, 201);
  const ruta = await api('POST', '/api/routes/outbound', { token: admin, body: { name: 'Celulares', pattern: '09XXXXXXX', trunk: 'op1', strip: 0 } });
  assert.equal(ruta.status, 201, JSON.stringify(ruta.json));
  const rutaId = ruta.json.id;

  let cb;
  await t.test('callback: el Originate sale tras la demora, hacia el IVR o hacia internal según el destino', async () => {
    const r = await api('POST', '/api/callback', { token: admin, body: { nombre: 'Vuelta', exten: '*41', enabled: true, numeros: '099111222, 099333444', dest_type: 'ivr', dest_value: '8000', demora_seg: 1, cooldown_seg: 5, max_dia: 1 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    cb = r.json;
    assert.equal(cb.demora_seg, 2, 'la demora tiene piso de 2 s');
    assert.equal(cb.cooldown_seg, 10);
    assert.deepEqual(cb.numeros, ['099111222', '099333444']);
    assert.equal(cb.tiene_pin, false);
    assert.equal(cb.pin_hash, undefined, 'el hash del PIN no sale por la API');
    ami.olvidar();
    assert.equal(txt(await api('POST', '/api/internal/callback', { body: { tok, id: cb.id, cid: '099111222' } })), 'ok');
    const o = await hasta(() => ami.pedidos('Originate')[0], 5000);
    assert.ok(o, 'no devolvió la llamada');
    assert.equal(o.channel, 'Local/099111222@internal');
    assert.equal(o.context, 'ivr');
    assert.equal(o.exten, '8000');
    assert.equal(txt(await api('POST', '/api/internal/callback', { body: { tok, id: cb.id, cid: '099333444' } })), 'no', 'tope diario de uno');
    assert.equal(txt(await api('POST', '/api/internal/callback', { body: { tok, id: 99999, cid: '099333444' } })), 'no', 'un callback que no existe');
    assert.equal(txt(await api('POST', '/api/internal/callback', { body: { id: cb.id, cid: '099333444' } })), 'no', 'sin el token del agente no se dispara nada');
  });

  await t.test('callback: listar, editar (cambia la entrada, pasa a PIN), validaciones y baja', async () => {
    const l = (await api('GET', '/api/callback', { token: admin })).json;
    assert.equal(l.length, 1);
    assert.equal((await api('PUT', '/api/callback/99999', { token: admin, body: {} })).status, 404);
    for (const malo of [{ exten: 'x' }, { modo: 'otro' }, { dest_type: 'cola' }, { dest_value: 'a;b' }, { numeros: Array.from({ length: 201 }, (_, i) => '09900' + i) }, { modo: 'lista_pin' }]) {
      assert.equal((await api('PUT', '/api/callback/' + cb.id, { token: admin, body: malo })).status, 400, JSON.stringify(malo).slice(0, 60));
    }
    const u = await api('PUT', '/api/callback/' + cb.id, { token: admin, body: { exten: '*42', modo: 'lista_pin', pin: '582914', nombre: '', dest_type: 'app', dest_value: '*31' } });
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.equal(u.json.nombre, 'Callback');
    assert.equal(u.json.tiene_pin, true);
    assert.equal((await ctx.db.query("SELECT count(*)::int n FROM extensions WHERE context='internal' AND exten='*41'")).rows[0].n, 0, 'la entrada vieja no queda en el dialplan');
    assert.ok((await ctx.db.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='*42' AND app='Read'")).rows.length, 'con PIN se pide la clave');
    {
      const conRuta = await api('PUT', '/api/callback/' + cb.id, { token: admin, body: { rutas: [rutaId] } });
      assert.equal(conRuta.status, 200);
      assert.equal(txt(await api('POST', '/api/internal/callback', { body: { tok, id: cb.id, cid: '099333444', pin: '582914' } })), 'no', 'el tope diario sigue valiendo después de editar');
    }
    assert.equal((await api('PUT', '/api/callback/' + cb.id, { token: admin, body: { rutas: [987654] } })).status, 400, 'una ruta que no existe');
    assert.equal((await api('DELETE', '/api/callback/' + cb.id, { token: admin })).json.deleted, cb.id);
    assert.equal((await api('DELETE', '/api/callback/' + cb.id, { token: admin })).status, 404);
  });

  await t.test('DISA: editar con PIN nuevo y borrar saca su entrada del dialplan', async () => {
    const d = await api('POST', '/api/disa', { token: admin, body: { nombre: 'Guardia', exten: '*51', pin: '736251', enabled: true, rutas: [rutaId], callerid: '29001234' } });
    assert.equal(d.status, 201, JSON.stringify(d.json));
    assert.equal(d.json.tiene_pin, true);
    assert.equal((await api('PUT', '/api/disa/' + d.json.id, { token: admin, body: { callerid: 'abc' } })).status, 400);
    assert.equal((await api('PUT', '/api/disa/' + d.json.id, { token: admin, body: { pin: '12' } })).status, 400);
    const u = await api('PUT', '/api/disa/' + d.json.id, { token: admin, body: { nombre: '', pin: '846251', max_intentos: 50, dur_seg: 1 } });
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.equal(u.json.nombre, 'DISA');
    assert.equal(u.json.max_intentos, 10);
    assert.equal(u.json.dur_seg, 30);
    assert.equal((await api('PUT', '/api/disa/99999', { token: admin, body: {} })).status, 404);
    assert.equal((await api('DELETE', '/api/disa/' + d.json.id, { token: admin })).json.deleted, d.json.id);
    assert.equal((await ctx.db.query("SELECT count(*)::int n FROM extensions WHERE context='internal' AND exten='*51'")).rows[0].n, 0);
    assert.equal((await api('DELETE', '/api/disa/' + d.json.id, { token: admin })).status, 404);
  });

  await t.test('abreviados: cambiar el prefijo mueve el patrón; uno inválido no', async () => {
    await api('POST', '/api/endpoints', { token: admin, body: { id: '2001', password: 'Clave-2001-xx' } });
    const p = await api('PUT', '/api/extensions/2001/abreviados', { token: admin, body: { entradas: [{ code: '01', destino: '099123456', nombre: 'Casa' }] } });
    assert.ok(p.status < 300, JSON.stringify(p.json));
    const patron = async (pref) => (await ctx.db.query("SELECT count(*)::int n FROM extensions WHERE context='internal' AND exten=$1", ['_' + pref + 'XX'])).rows[0].n;
    assert.ok(await patron('*75') > 0, 'con un abreviado personal se publica el patrón');
    assert.equal((await api('PUT', '/api/abreviados/prefijo', { token: admin, body: { prefijo: '75' } })).status, 400);
    assert.deepEqual((await api('PUT', '/api/abreviados/prefijo', { token: admin, body: { prefijo: '*76' } })).json, { prefijo: '*76' });
    assert.equal(await patron('*75'), 0, 'el patrón viejo se borra');
    assert.ok(await patron('*76') > 0);
    /* Cuando el AMI vuelve, los abreviados se vuelcan a la AstDB. */
    ami.olvidar();
    ami.cortar();
    await ami.conectado(20000);
    assert.ok(await hasta(() => ami.pedidos('DBPut').some((x) => x.family === 'abrev'), 15000), 'no volcó los abreviados a la AstDB al reconectar');
  });
});
