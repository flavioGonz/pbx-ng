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
const { turnFalso } = require('./helpers/turn-falso');
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

test('turn: parseUrlTurn — una URL de TURN sin host NO es válida', () => {
  /* El bloqueante de 1.11.0: el PUT sólo miraba que empezara con `turn:`, así que un
   * `turn:` pelado se guardaba, dejaba el host vacío y /api/ice salía sin un solo
   * `stun:` y con una `urls` que le hace tirar SyntaxError al navegador. La validación y
   * el parseo son AHORA la misma función; esto lo fija. */
  assert.equal(turn.parseUrlTurn('turn:'), null, 'sin host no hay URL válida');
  assert.equal(turn.parseUrlTurn('turns:'), null);
  assert.equal(turn.parseUrlTurn('http://relay.example'), null);
  assert.equal(turn.parseUrlTurn('relay.example:3478'), null, 'sin esquema tampoco');
  assert.equal(turn.parseUrlTurn('turn:h:0'), null, 'puerto fuera de rango');
  assert.deepEqual(turn.parseUrlTurn('turn:relay.example'), { host: 'relay.example', puerto: 3478 });
  assert.deepEqual(turn.parseUrlTurn('turns:relay.example:5349'), { host: 'relay.example', puerto: 5349 });
  assert.deepEqual(turn.parseUrlTurn('turn:relay.example:3478?transport=udp'), { host: 'relay.example', puerto: 3478 });
  assert.deepEqual(turn.parseUrlTurn('turn:[2001:db8::1]:3478'), { host: '2001:db8::1', puerto: 3478 });
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

  await t.test('origen externo: una URL sin host se rechaza (y no queda nada guardado)', async () => {
    /* EL BLOQUEANTE de 1.11.0, medido contra la API real: `turn:` pelado pasaba la
     * validación («empieza con turn:»), el host quedaba vacío, el fallback de STUN
     * devolvía lista VACÍA y /api/ice salía sin un solo `stun:` y con una `urls` que le
     * hace tirar SyntaxError al RTCPeerConnection… y el panel cantaba verde. */
    const mal = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'externo', externo_urls: 'http://relay.example', externo_usuario: 'u', externo_clave: 'p' } });
    assert.equal(mal.status, 400);
    assert.match(String(mal.json.error), /turn:/);

    const pelada = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'externo', externo_urls: 'turn:', externo_usuario: 'u', externo_clave: 'p' } });
    assert.equal(pelada.status, 400, JSON.stringify(pelada.json));
    assert.match(String(pelada.json.error), /host/);
    const o = (await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='turn_origen'")).rows[0];
    assert.equal(o && o.value, 'propio', 'un PUT rechazado no cambia el origen');
  });

  await t.test('no se apaga lo que anda: si el TURN nuevo no contesta, 409 y NADA cambia', async () => {
    /* Antes el PUT guardaba, apagaba el coturn local y recién después alguien se
     * enteraba —mirando el panel— de si el relay nuevo existía. Un dedazo en el host
     * dejaba la central sin ningún relay, y sin aviso, porque las llamadas detrás de NAT
     * simétrico se caen calladas. */
    const r = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'externo', externo_urls: 'turn:relay.example.test:3478', externo_usuario: 'u', externo_clave: 'p' }, timeout: 20000 });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.sin_cambios, true);
    assert.equal(r.json.verificacion.ok, false);
    const o = (await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='turn_origen'")).rows[0];
    assert.equal(o && o.value, 'propio', 'el origen sigue siendo el de antes');
    const m = (await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='mod_turn'")).rows[0];
    assert.equal(m && m.value, '1', 'y el coturn local sigue encendido: no se apaga lo que anda');
  });

  await t.test('un TURN externo que SÍ contesta entra sin forzar, y apaga el coturn local', async () => {
    const srv = await turnFalso({});
    try {
      const r = await api('PUT', '/api/turn/origen', {
        token: admin,
        body: { origen: 'externo', externo_urls: 'turn:127.0.0.1:' + srv.puerto, externo_usuario: 'u', externo_clave: 'p' },
        timeout: 20000,
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.verificacion.ok, true, 'se verificó ANTES de guardar y de apagar');
      assert.equal(r.json.coturn_local, false);
      const m = (await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='mod_turn'")).rows[0];
      assert.equal(m && m.value, '0', 'elegir un TURN ajeno tiene que apagar el coturn propio');
      const mods = await api('GET', '/api/modules', { token: admin });
      assert.equal(mods.json.turn, false, 'el interruptor del panel tiene que seguir al origen');

      const ice = (await api('GET', '/api/ice')).json;
      const rel = ice.iceServers.find((x) => x.username);
      assert.ok(rel, 'con credenciales sí se anuncia el TURN externo');
      assert.equal(rel.credential, 'p');
      assert.equal(ice.iceServers[0].urls, 'stun:127.0.0.1:' + srv.puerto, 'el STUN sigue al origen elegido');
    } finally { await srv.cerrar(); }
  });

  await t.test('forzar: el administrador puede cambiar igual (relay sin hairpin)', async () => {
    const r = await api('PUT', '/api/turn/origen', {
      token: admin,
      body: { origen: 'externo', externo_urls: 'turn:relay.example.test:3478', externo_usuario: 'u', externo_clave: 'p', forzar: true },
      timeout: 20000,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.forzado, true);
    assert.equal(r.json.verificacion, null, 'forzado = no se sondeó: queda dicho en la respuesta');
  });

  await t.test('/api/ice SIEMPRE trae al menos un stun: (es la última red del WebRTC)', async () => {
    /* Se escribe la fila a mano para reproducir una central que YA quedó con la URL rota
     * guardada de antes del arreglo: el 400 del PUT protege de acá en adelante, pero el
     * que ya la tiene tiene que seguir teniendo STUN. Sin una sola entrada `stun:` el
     * navegador junta sólo candidatos de host y cualquiera detrás de un NAT se queda
     * mudo, sin un mensaje de error. */
    await ctx.db.query("UPDATE pbxng_settings SET value='turn:' WHERE key='turn_ext_urls'");
    const r = await api('GET', '/api/ice');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ice = r.json.iceServers;
    assert.ok(ice.some((x) => /^stun:/i.test(String(x.urls))), 'tiene que quedar el STUN del propio appliance');
    assert.equal(ice[0].urls, 'stun:203.0.113.10:3478');
    assert.equal(ice.some((x) => /google|cloudflare|twilio/i.test(String(x.urls))), false, 'y nunca un servicio público');
    // La entrada turn: inválida NO se publica: rompe el RTCPeerConnection entero.
    assert.equal(ice.some((x) => String(x.urls) === 'turn:' || (Array.isArray(x.urls) && x.urls.includes('turn:'))), false);
    assert.match(String(r.json.motivo), /host/, 'y se dice por qué no hay TURN');

    // El QR de provisión sale de la MISMA función: lo que se graba en un teléfono de
    // escritorio no puede ser una configuración que /api/ice ya no entrega.
    await ctx.db.query("INSERT INTO ps_auths(id, auth_type, username, password) VALUES('1099','userpass','1099','clave-de-prueba') ON CONFLICT (id) DO NOTHING");
    const prov = await api('GET', '/api/provision?ext=1099', { token: admin });
    assert.equal(prov.status, 200, JSON.stringify(prov.json));
    assert.match(String(prov.json.stun), /^stun:/, 'el teléfono también se lleva un STUN utilizable');
    assert.equal(prov.json.turn, '', 'y ningún TURN inválido grabado en la config local del aparato');
  });

  /* El mismo agujero por las OTRAS puertas. El bloqueante se cerró para `turn:` y seguía
   * abierto en `stun_url` y en el host propio: todo lo que sale por /api/ice sale también
   * por el QR, o sea GRABADO en un teléfono que no se arregla cuando alguien corrige el
   * panel. Se prueban las formas que el revisor midió a mano, una por una. */
  await t.test('un STUN o un host propio mal escritos se rechazan, y lo ya guardado no se publica', async () => {
    for (const malo of ['stun:', 'no es una url', 'http://stun.example', 'stun:,,']) {
      const r = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'propio', stun_url: malo } });
      assert.equal(r.status, 400, 'stun_url «' + malo + '» tendría que dar 400: ' + JSON.stringify(r.json));
    }
    for (const malo of ['mi central', 'http://foo/bar', 'turn:']) {
      const r = await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'propio', propio_host: malo } });
      assert.equal(r.status, 400, 'propio_host «' + malo + '» tendría que dar 400: ' + JSON.stringify(r.json));
    }
    assert.equal((await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'propio', propio_puerto: 99999 } })).status, 400);

    // Y una central que YA quedó con la basura guardada de antes: se filtra, no se publica.
    await ctx.db.query("INSERT INTO pbxng_settings(key,value) VALUES('stun_url','stun:') ON CONFLICT (key) DO UPDATE SET value='stun:'");
    const ice = (await api('GET', '/api/ice')).json.iceServers;
    assert.ok(ice.some((x) => /^stun:[^:]/i.test(String(x.urls))), 'cae al STUN del appliance en vez de publicar el roto');
    assert.equal(ice.some((x) => String(x.urls) === 'stun:'), false);
    await ctx.db.query("DELETE FROM pbxng_settings WHERE key='stun_url'");
  });

  /* Con el interruptor del módulo en OFF, la API repartía igual `turn:<host>` CON la
   * clave, de un coturn que ella misma acababa de parar. Es el bug fundacional del
   * módulo, alcanzable con un solo clic. */
  await t.test('módulo turn apagado: se mantiene el stun: y NO se reparte el turn: ni la clave', async () => {
    await api('PUT', '/api/turn/origen', { token: admin, body: { origen: 'propio' } });
    await api('POST', '/api/modules', { token: admin, body: { id: 'turn', on: false } });
    const r = await api('GET', '/api/ice');
    const ice = r.json.iceServers;
    assert.ok(ice.some((x) => /^stun:/i.test(String(x.urls))), 'el STUN se mantiene: el appliance sigue ahí');
    assert.equal(ice.some((x) => /^turn:/i.test(String(x.urls)) || (Array.isArray(x.urls) && x.urls.some((u) => /^turn:/i.test(u)))), false,
      'no se reparte el TURN de un coturn apagado');
    assert.equal(ice.some((x) => x.credential), false, 'ni la credencial');
    assert.match(String(r.json.motivo || ''), /apagado/i);
    await api('POST', '/api/modules', { token: admin, body: { id: 'turn', on: true } });
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
    assert.equal(r.json.sondeado, true, 'con host y el interruptor en ON sí se mide');
    assert.ok(String(r.json.motivo).length > 0);
  });

  await t.test('con el módulo apagado no se sondea nada (y el cache se invalida solo)', async () => {
    /* `estado()` la piden dos pantallas en bucle (el TURN cada 30 s, el Resumen cada
     * 60). Correr la sonda con el coturn propio apagado a propósito es gastar tres
     * intercambios por vuelta para confirmar lo que el motivo ya explica. Y mover el
     * interruptor desde Configuración → Módulos tiene que invalidar el cache, si no el
     * panel sigue mostrando 20 s lo de antes. */
    const off = await api('POST', '/api/modules', { token: admin, body: { id: 'turn', enabled: false } });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    const r = await api('GET', '/api/turn/estado', { token: admin });
    assert.equal(r.json.deseado, false);
    assert.equal(r.json.corriendo, false);
    assert.equal(r.json.sondeado, false, 'con el interruptor en OFF no se gasta una sonda en cada vuelta');
    await api('POST', '/api/modules', { token: admin, body: { id: 'turn', enabled: true } });
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
