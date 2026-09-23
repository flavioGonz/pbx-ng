/* ============================================================================
 *  Tanda 0 de la auditoría de entrega · las tres puertas que estaban abiertas.
 *
 *  No son pruebas de funcionalidad: son las que dejan clavado el arreglo, porque las
 *  tres fallas eran de esas que vuelven solas cuando alguien «simplifica» una línea.
 *
 *   C4 · /api/internal/wake estaba SIN NINGUNA guarda. El dialplan la llama por CURL
 *        para despertar la PWA de un interno apagado; cualquiera que llegara al puerto
 *        podía hacer sonar el push de «llamada entrante» en el teléfono de cualquier
 *        interno, cuantas veces quisiera.
 *   C2 · el freno del click-to-call leía el PRIMER elemento de X-Forwarded-For, que lo
 *        escribe el cliente. Medido antes del arreglo: 30 sesiones de 30, cada una con
 *        un endpoint WebRTC y filas de dialplan nuevas. Acá se simula el proxy real
 *        (NPM agrega la IP verdadera al FINAL) y se rota lo que el cliente controla.
 *   C5 · un usuario con alcance limitado y SIN interno asignado: `extPropia()` devuelve
 *        '' y la comparación lo daba por bueno (`[''].includes('')`). `/api/cdr` ya lo
 *        cortaba; las dos rutas de grabaciones, no.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { entorno } = require('./helpers/db');

test('tanda 0: las guardas de wake, click-to-call y grabaciones', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login, confDir } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  const tok = fs.readFileSync(path.join(confDir, 'agent.token'), 'utf8').trim();

  await t.test('C4 · wake: con el token sí, sin el token no, con proxy no', async () => {
    // Mismo criterio que los códigos de función y la DISA (ver desde-la-central.js): con
    // token configurado, el token es obligatorio aunque el pedido venga de loopback.
    assert.equal((await api('GET', '/api/internal/wake?ext=1001&from=1002&tok=' + encodeURIComponent(tok))).status, 200);

    assert.equal((await api('GET', '/api/internal/wake?ext=1001&from=1002')).status, 403,
      'el wake entró sin token: se puede hacer sonar el teléfono de cualquiera desde el host');
    assert.equal((await api('GET', '/api/internal/wake?ext=1001&from=1002&tok=noesteotro')).status, 403,
      'un token equivocado entró igual: la comparación no está frenando');

    // Si el pedido pasó por un proxy, no vino del dialplan de esta máquina.
    for (const h of ['x-forwarded-for', 'x-real-ip']) {
      const r = await api('GET', '/api/internal/wake?ext=1001&from=1002&tok=' + encodeURIComponent(tok), { headers: { [h]: '203.0.113.9' } });
      assert.equal(r.status, 403, 'entró un wake con ' + h + ': se puede hacer sonar el teléfono de cualquiera desde afuera');
    }
  });

  await t.test('C2 · click-to-call: rotar X-Forwarded-For ya no saltea el cupo', async () => {
    const link = await api('POST', '/api/c2c', { token: admin, body: { name: 'Prueba', dest_type: 'extension', dest_value: '1001' } });
    assert.equal(link.status, 201, JSON.stringify(link.json));
    const url = '/api/c2c/public/' + link.json.token + '/session';

    /* Cómo llega un pedido en producción: el cliente escribe lo que quiere y NUESTRO
     * proxy agrega la IP real al final. Con `trust proxy = 1` Express toma la última,
     * así que rotar la primera —que es todo lo que el atacante controla— no mueve la
     * clave del cupo. Es exactamente el caso que medimos en 30/30. */
    const comoProxy = (falsa) => ({ 'x-forwarded-for': falsa + ', 198.51.100.7' });
    let ok = 0, frenados = 0;
    for (let i = 0; i < 12; i++) {
      const r = await api('POST', url, { headers: comoProxy('203.0.113.' + i), body: { name: 'Visitante ' + i } });
      if (r.status === 429) frenados++; else if (r.status === 200) ok++;
    }
    assert.equal(ok, 6, 'el cupo por IP es de 6 sesiones cada 5 minutos y entraron ' + ok);
    assert.ok(frenados >= 6, 'los pedidos de más tienen que volver 429, y volvieron ' + frenados);

    // Y que el freno sea POR IP, no global: otra IP real arranca con su propio cupo.
    const otra = await api('POST', url, { headers: { 'x-forwarded-for': '203.0.113.200, 198.51.100.8' }, body: { name: 'Otro' } });
    assert.equal(otra.status, 200, 'el cupo se volvió global: un visitante frena a todos los demás');
  });

  await t.test('C5 · grabaciones: alcance limitado sin interno asignado no escucha nada', async () => {
    // Un agente sin interno: es el caso que devolvía '' y pasaba el filtro.
    const alta = await api('POST', '/api/users', { token: admin, body: { username: 'sinInterno', password: 'clave-de-prueba-1', role: 'agente' } });
    assert.equal(alta.status, 201, JSON.stringify(alta.json));
    const agente = (await login('sinInterno', 'clave-de-prueba-1')).token;

    // Una grabación con los campos vacíos, que es lo que hacía cierto el `includes('')`.
    const { rows } = await ctx.db.query(
      "INSERT INTO pbxng_recordings (filename, ext, src, dst, duration, started_at, deleted) VALUES ('x.wav','','','',10, now(), false) RETURNING id");
    const id = rows[0].id;

    const audio = await api('GET', '/api/recordings/' + id + '/audio', { token: agente });
    assert.equal(audio.status, 403, 'un agente sin interno se bajó el audio de una llamada que no es suya');

    /* El caso exacto del agujero: un extremo vacío contra un `propio` vacío daba
     * igualdad, así que salían las grabaciones del interno del OTRO extremo. */
    const match = await api('GET', '/api/recordings/match?from=&to=1002&ts=0', { token: agente });
    assert.equal(match.status, 403, 'un agente sin interno buscó grabaciones ajenas por /match');

    // Y el admin sigue viendo lo suyo: la guarda no se llevó puesto el caso bueno.
    assert.notEqual((await api('GET', '/api/recordings/' + id + '/audio', { token: admin })).status, 403);
  });
});
