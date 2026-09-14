/* Invariante de la IMAGEN de Asterisk, no de la API: todo modulo que modules.conf pide
 * con `require =` tiene que estar tambien en las DOS listas de verificacion de la imagen
 * (el gate que corta el build y el aviso del entrypoint).
 *
 * Por que vive en `npm test` y no en el build: cuando el build se entera ya es tarde. Un
 * `require =` que falta no degrada una funcion —Asterisk sale con codigo 2 apenas arranca,
 * el contenedor queda en crash-loop y la central entera se queda sin telefonos—, y el gate
 * del Dockerfile no puede avisar de un modulo que nadie le nombro: pasa verde. Asi se
 * escapo `func_hangupcause.so` del failover de troncales.
 *
 * Se corre con `npm test` (node --test) desde control-plane/. No necesita Docker: son
 * archivos de texto del repo. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..', 'docker');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');

/* Los `require = modulo.so` de modules.conf, ignorando los comentados (`;`) y el
 * comentario al final de la linea, que en Asterisk tambien empieza con `;`. */
function requeridos(txt) {
  const out = [];
  for (const linea of txt.split('\n')) {
    const m = /^\s*require\s*=\s*([A-Za-z0-9_]+\.so)/.exec(linea);
    if (m) out.push(m[1]);
  }
  return out;
}

test('modules.conf declara al menos los require que ya estan en produccion', () => {
  const req = requeridos(leer('config/asterisk/modules.conf'));
  /* No es la lista completa a futuro: es el piso verificado contra la central
   * (`module show like …` -> Running). Si alguien saca uno de aca, que se note. */
  for (const m of ['func_curl.so', 'func_uri.so', 'func_db.so', 'func_strings.so',
    'app_directory.so', 'app_read.so', 'func_hangupcause.so']) {
    assert.ok(req.includes(m), `modules.conf dejo de pedir ${m} con require =`);
  }
});

test('cada require de modules.conf esta en el gate de build de la imagen', () => {
  const req = requeridos(leer('config/asterisk/modules.conf'));
  const dockerfile = leer('images/asterisk/Dockerfile');
  for (const m of req) {
    assert.ok(
      dockerfile.includes(m),
      `${m} esta en el require de modules.conf pero NO en el gate de images/asterisk/Dockerfile: ` +
      'el build saldria verde sobre una imagen que no arranca (Asterisk sale con codigo 2).');
  }
});

test('cada require de modules.conf esta en el aviso del entrypoint', () => {
  const req = requeridos(leer('config/asterisk/modules.conf'));
  const entrypoint = leer('images/asterisk/docker-entrypoint.sh');
  for (const m of req) {
    assert.ok(
      entrypoint.includes(m),
      `${m} esta en el require de modules.conf pero NO en el aviso de ` +
      'images/asterisk/docker-entrypoint.sh: el contenedor entraria en crash-loop sin decir por que.');
  }
});

/* La imagen all-in-one es una demo del panel y la API: usa el Asterisk de Debian y NO copia
 * config/asterisk/, asi que no recibe ningun require. Eso esta decidido y escrito; esta
 * prueba es para que no se convierta en una equivalencia a medias sin que nadie lo note
 * (copiar solo el config la dejaria peor: realtime sin res_pgsql.conf y @@API_URL@@ sin
 * resolver). Si alguna vez se la hace equivalente de verdad, esta prueba cae y ahi se
 * decide de nuevo. */
test('la imagen all-in-one sigue declarando que no es equivalente a produccion', () => {
  const aio = leer('Dockerfile.allinone');
  assert.ok(!/COPY\s+docker\/config\/asterisk\//.test(aio),
    'Dockerfile.allinone empezo a copiar config/asterisk/: o se la hace equivalente de verdad ' +
    '(entrypoint incluido) o se saca esa copia; a medias es peor que nada.');
  assert.ok(/NO es equivalente a la de\s*\n?#\s*produccion/.test(aio) || aio.includes('NO es equivalente a la de'),
    'se borro del encabezado de Dockerfile.allinone la advertencia de que no es equivalente a produccion.');
});
