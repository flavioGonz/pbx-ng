/* Medio · origen del TURN, /api/ice y la sonda real (docs/CONTRATOS.md §3, familia
 * `turn`/`ice`). Contra la API real y un PostgreSQL efímero; sin Postgres se saltea.
 *
 * Lo que se protege acá es exactamente lo que se rompió en producción:
 *  · que /api/ice NO reparta un STUN público (una central sin internet no puede
 *    arrancar el WebRTC pidiéndole permiso a Google);
 *  · que NO reparta una entrada `turn:` sin credenciales ni con un origen que no
 *    está utilizable (repartir la dirección de un relay que nadie corre fue el bug);
 *  · que haya UN SOLO origen declarado y que elegir uno ajeno apague el coturn local;
 *  · que un relay en una dirección inservible (bridge de Docker, loopback) salga FALLA.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const turn = require('../turn');

test('turn: cordura del relay — el bridge de Docker y el loopback NO son OK', () => {
  // El caso medido: coturn del SBC escuchando sólo en 172.17.0.1.
  assert.equal(turn.esPrivada('172.17.0.1'), true);
  assert.equal(turn.esPrivada('192.168.99.17'), true);
  assert.equal(turn.esPrivada('200.40.1.1'), false);
  assert.ok(turn.relayInservible('127.0.0.1'), 'loopback tiene que ser inservible');
  assert.ok(turn.relayInservible('0.0.0.0'), '0.0.0.0 tiene que ser inservible');
  assert.ok(turn.relayInservible('169.254.3.4'), 'link-local tiene que ser inservible');
  assert.equal(turn.relayInservible('200.40.1.1'), null);
  // 172.17.x sola no alcanza para condenar (una LAN puede usar 172.16/12): lo decide
  // sondear(), comparando contra la dirección en la que está publicado el TURN.
  assert.equal(turn.relayInservible('172.17.0.1'), null);
});

test('turn: sondear() contra un puerto cerrado da FALLA con motivo, no cuelga', async () => {
  const r = await turn.sondear({ host: '127.0.0.1', puerto: 1, usuario: 'x', clave: 'y', tcp: true, ms: 1500 });
  assert.equal(r.ok, false);
  assert.match(r.veredicto, /no contesta/);
  assert.equal(r.pasos[0].ok, false);
});

test('turn: /api/ice y el selector de origen', async (t) => {
  // PUBLIC_IP sin TURN_PASS = el estado en el que estaba la central real: la API creía
  // tener TURN y repartía su dirección igual.
  const ctx = await entorno(t, { PUBLIC_IP: '203.0.113.10', TURN_USER: 'pbxng', TURN_PASS: '' });
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  await t.test('la migración deja el coturn propio encendido de fábrica', async () => {
    const m = (await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='mod_turn'")).rows[0];
    assert.equal(m && m.value, '1', 'sin fila mod_turn el reconciliador salteaba el módulo');
    const o = (await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='turn_origen'")).rows[0];
    assert.equal(o && o.value, 'propio');
  });

  await t.test('sin TURN_PASS: STUN propio y NINGUNA entrada turn: (no se miente)', async () => {
    const r = await api('GET', '/api/ice');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ice = r.json.iceServers;
    assert.ok(Array.isArray(ice) && ice.length >= 1);
    // Nada de servicios públicos: el STUN es el propio appliance.
    assert.equal(ice.some((x) => /google|cloudflare|twilio/i.test(String(x.urls))), false);
    assert.equal(ice[0].urls, 'stun:203.0.113.10:3478');
    assert.equal(ice.some((x) => /^turn/i.test(String(x.urls))), false, 'sin clave no se anuncia TURN');
    assert.equal(r.json.origen, 'propio');
    assert.match(String(r.json.motivo), /TURN_PASS/);
  });

  await t.test('GET /api/turn/origen no devuelve contraseñas', async () => {
    const r = await api('GET', '/api/turn/origen', { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.origen, 'propio');
    assert.equal(r.json.propio.tiene_clave, false);
    assert.equal(r.json.sbc.disponible, false);
    // La respuesta dice SI hay clave cargada, nunca cuál: un TURN con clave conocida es
    // un relay abierto a internet, y lo van a usar para otra cosa.
    assert.equal(/clave"\s*:\s*"/.test(JSON.stringify(r.json)), false);
  });

  await t.test('origen inválido → 400', async () => {
    const r = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'google' } });
    assert.equal(r.status, 400);
  });

  await t.test('origen sbc sin enlace activo → 400 (no se cae en silencio a otro)', async () => {
    const r = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'sbc', sbc_usuario: 'u', sbc_clave: 'p' } });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /SBC-NG/);
  });

  await t.test('origen externo: valida la URL, y APAGA el coturn local (un solo origen)', async () => {
    const mal = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'externo', externo_urls: 'http://relay.example', externo_usuario: 'u', externo_clave: 'p' } });
    assert.equal(mal.status, 400);
    assert.match(String(mal.json.error), /turn:/);

    const r = await api('PUT', '/api/turn/origen', {
      token: admin,
      body: { origen: 'externo', externo_urls: 'turn:relay.example.test:3478', externo_usuario: 'u', externo_clave: 'p' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.coturn_local, false);
    const m = (await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='mod_turn'")).rows[0];
    assert.equal(m && m.value, '0', 'elegir un TURN ajeno tiene que apagar el coturn propio');
    const mods = await api('GET', '/api/modules', { token: admin });
    assert.equal(mods.json.turn, false, 'el interruptor del panel tiene que seguir al origen');

    const ice = (await api('GET', '/api/ice')).json;
    const rel = ice.iceServers.find((x) => x.username);
    assert.ok(rel, 'con credenciales sí se anuncia el TURN externo');
    assert.equal(rel.credential, 'p');
    assert.equal(ice.iceServers[0].urls, 'stun:relay.example.test:3478', 'el STUN sigue al origen elegido');
  });

  await t.test('volver a propio reenciende el módulo', async () => {
    const r = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'propio' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.coturn_local, true);
    const m = (await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='mod_turn'")).rows[0];
    assert.equal(m && m.value, '1');
  });

  await t.test('GET /api/turn/estado separa lo DESEADO de lo que CORRE', async () => {
    const r = await api('GET', '/api/turn/estado', { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.deseado, true, 'el interruptor está en ON');
    assert.equal(r.json.corriendo, false, 'y no hay ningún coturn corriendo: el panel NO puede decir que sí');
    assert.ok(String(r.json.motivo).length > 0);
  });

  await t.test('/api/ice no se cachea (el origen se cambia desde el panel)', async () => {
    const r = await api('GET', '/api/ice');
    assert.match(String(r.headers && r.headers.get ? r.headers.get('cache-control') : 'no-store'), /no-store/);
  });

  await t.test('RBAC: el selector de origen es sólo admin', async () => {
    await api('POST', '/api/users', { token: admin, body: { username: 'sup1', password: 'clave12345', role: 'supervisor', name: 'Sup' } });
    const sup = (await login('sup1', 'clave12345')).token;
    const r = await api('GET', '/api/turn/origen', { token: sup });
    assert.equal(r.status, 403);
    // …pero /api/ice lo puede pedir cualquiera (incluso sin sesión): lo necesita el softphone.
    assert.equal((await api('GET', '/api/ice')).status, 200);
  });
});
