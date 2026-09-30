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

/* El guard de bucle del contexto `internal` tiene que escribir SALTOS con el prefijo
 * heredable. Vive acá porque es un invariante del archivo del repo, como los `require`:
 * `Set(SALTOS=...)` a secas compila y funciona igual para los desvios (mismo canal), asi
 * que nada lo delata hasta que alguien arma un sigueme cruzado —el canal Local nace con el
 * contador en cero y la llamada gira sola hasta que cuelgan—. Es exactamente el tipo de
 * linea que una edicion distraida "simplifica" sacando los dos guiones bajos. */
test('el guard de bucle de internal escribe __SALTOS (heredable por el canal Local del sigueme)', () => {
  const ext = leer('config/asterisk/extensions.conf');
  assert.ok(/Set\(__SALTOS=\$\[\$\{SALTOS\} \+ 1\]\)/.test(ext),
    'extensions.conf tiene que incrementar __SALTOS (con doble guion bajo): sin herencia el sigueme cruzado no se corta nunca');
  assert.ok(/ExecIf\(\$\["\$\{SALTOS\}"=""\]\?Set\(__SALTOS=0\)\)/.test(ext),
    'la inicializacion del contador tambien va con __SALTOS, o el primer salto pierde la herencia');
  assert.ok(!/[^_]\bSet\(SALTOS=/.test(ext), 'quedo un Set(SALTOS=...) sin prefijo heredable');
});

/* El tono de llamada en las transferencias de la IA: ai-pipeline.js pone DIAL_OPCIONES=r en
 * el canal antes de mandarlo a `internal`, y los dos Dial del interno (el directo y el del
 * sigueme) la usan. Lo que se fija aca es lo que no se ve hasta que alguien llama:
 *  · si un Dial pierde la variable, una derivacion a un destino que no avisa que suena
 *    vuelve a quedar muda y el softphone del panel corta a los ~8 s (29/09);
 *  · si alguien la pone fija en el dialplan (o heredable, con `_`), el `r` pasa a las
 *    llamadas comunes entre internos, que hoy suenan con el 180 del telefono;
 *  · con la variable vacia el Dial tiene que quedar EXACTAMENTE como era antes. */
test('los Dial del interno usan ${DIAL_OPCIONES} y nada mas del dialplan la toca', () => {
  const ext = leer('config/asterisk/extensions.conf');
  const sinComentario = (l) => l.replace(/;.*$/, '').trim();
  const ini = ext.indexOf('\n[internal]');
  const fin = ext.indexOf('\n[', ini + 1);
  assert.ok(ini >= 0 && fin > ini, 'no se encontro el contexto [internal]');
  const internal = ext.slice(ini, fin).split('\n').map(sinComentario).filter(Boolean);

  const dials = internal.filter((l) => /\bDial\(/.test(l));
  assert.deepEqual(dials, [
    'same => n(marcar),Dial(PJSIP/${EXTEN},${TIMBRE},${DIAL_OPCIONES})',
    'same => n,Dial(Local/${DB(fm/${EXTEN})}@internal/n,45,${DIAL_OPCIONES})',
  ], 'los dos Dial del interno tienen que pasar ${DIAL_OPCIONES} como opciones');
  /* Con la variable vacia, lo que marca Asterisk es el Dial de siempre. */
  assert.deepEqual(dials.map((l) => l.replace(',${DIAL_OPCIONES})', ')')), [
    'same => n(marcar),Dial(PJSIP/${EXTEN},${TIMBRE})',
    'same => n,Dial(Local/${DB(fm/${EXTEN})}@internal/n,45)',
  ]);

  const todas = ext.split('\n').map(sinComentario).filter((l) => /DIAL_OPCIONES/.test(l));
  assert.deepEqual(todas, [RINGING_DESPERTAR, ...dials],
    'DIAL_OPCIONES solo se lee en el Ringing() del despertar y en esos dos Dial: nadie la escribe en el dialplan');
  assert.ok(!/_DIAL_OPCIONES/.test(ext), 'DIAL_OPCIONES no se hereda: el `r` no tiene que pasar a los canales que se marcan despues');
});

/* El tramo de despertar al interno (CURL + poll de contactos) puede durar ~14 s antes del
 * Dial. En una derivacion de la IA el canal ya esta atendido: sin un Ringing() al empezar
 * ese tramo, quien llama escucha silencio todo ese rato aunque el Dial despues de tono. Se
 * fija que la linea este ANTES del tope y del CURL (con la etiqueta a la que salta el
 * GotoIf) y que solo corra con la variable puesta: en una llamada comun no hace nada. */
const RINGING_DESPERTAR = 'same => n(wake),ExecIf($["${DIAL_OPCIONES}"!=""]?Ringing())';
test('el despertar del interno arranca con Ringing() solo cuando la IA deriva', () => {
  const ext = leer('config/asterisk/extensions.conf');
  const lineas = ext.slice(ext.indexOf('\n[internal]')).split('\n').map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
  const i = lineas.indexOf(RINGING_DESPERTAR);
  assert.ok(i >= 0, 'falta el Ringing() condicionado al principio del tramo (wake)');
  const tope = lineas.findIndex((l) => /CURLOPT\(conntimeout\)/.test(l));
  const curl = lineas.findIndex((l) => /CURL\(http:.*\/api\/internal\/wake/.test(l));
  const poll = lineas.findIndex((l) => /^same => n\(poll\)/.test(l));
  assert.ok(i === tope - 1 && tope < curl && curl < poll, 'el Ringing() tiene que ir justo antes del tope del CURL, y los dos antes del poll');
  assert.equal(lineas.filter((l) => /\(wake\)/.test(l)).length, 1, 'la etiqueta (wake) tiene que estar en una sola linea: la del Ringing()');
  assert.ok(!lineas.some((l) => /Ringing\(\)/.test(l) && l !== RINGING_DESPERTAR), 'hay un Ringing() sin condicion: cambiaria las llamadas comunes');

  /* La condicion, evaluada como la evaluaria Asterisk con la variable vacia y con `r`. */
  const m = /ExecIf\(\$\[(.*)\]\?Ringing\(\)\)/.exec(RINGING_DESPERTAR);
  const corre = (valor) => {
    const [izq, der] = m[1].replace('${DIAL_OPCIONES}', valor).split('!=');
    return JSON.parse(izq) !== JSON.parse(der);
  };
  assert.equal(corre(''), false, 'en una llamada comun (sin la variable) no tiene que sonar nada nuevo');
  assert.equal(corre('r'), true);
});

/* Las zonas de tono: sin indications.conf la tabla queda vacia y la central no genera
 * NINGUN tono por audio. Sobre un canal ya atendido (una derivacion de la IA) eso es
 * silencio mientras suena el interno, con `r`, con Ringing() y con el aviso de ringing del
 * propio interno: la causa de fondo de los cortes del 29/09. Se fija el archivo, el tono de
 * llamada del pais por defecto, que el Dockerfile lo copia y que los dos compose pasan el
 * pais igual (el de release es el que corre el cliente). */
test('la imagen trae las zonas de tono y el pais por defecto tiene tono de llamada', () => {
  const ind = leer('config/asterisk/indications.conf');
  const secciones = {};
  let actual = null;
  for (const linea of ind.split('\n')) {
    const l = linea.replace(/;.*$/, '').trim();
    if (!l) continue;
    const s = /^\[([^\]]+)\]$/.exec(l);
    if (s) { actual = s[1]; secciones[actual] = {}; continue; }
    const kv = /^([a-z]+)\s*=\s*(.+)$/.exec(l);
    if (kv && actual) secciones[actual][kv[1]] = kv[2];
  }
  const pais = secciones.general && secciones.general.country;
  assert.ok(pais, 'indications.conf no tiene [general] country=');
  for (const z of ['uy', 'ar']) {
    for (const tono of ['ring', 'busy', 'congestion']) assert.ok(secciones[z] && secciones[z][tono], `falta ${tono} en la zona ${z}`);
  }
  assert.ok(secciones[pais] && secciones[pais].ring, `el pais por defecto (${pais}) no tiene zona con ring: la central quedaria muda`);
  /* Los valores son los de la UIT (Anexo al Boletin de Explotacion 781, 1.II.2003), no los
   * de dahdi-tools/zonedata.c, que para Argentina difieren. */
  assert.deepEqual(
    ['dial', 'ring', 'busy', 'congestion', 'ringcadence'].map((k) => secciones.uy[k]),
    ['425', '425/1000,0/4000', '425/500,0/500', '425/250,0/250', '1000,4000'], 'Uruguay: UIT OB 781');
  assert.deepEqual(
    ['dial', 'ring', 'busy', 'congestion', 'ringcadence'].map((k) => secciones.ar[k]),
    ['425', '425/1000,0/4000', '425/300,0/200', '425/300,0/400', '1000,4000'], 'Argentina: UIT OB 781');
  assert.match(ind, /tones-0203\.pdf/, 'indications.conf tiene que citar la fuente de las zonas');

  /* El Dockerfile copia el directorio entero: el archivo entra solo por estar ahi. */
  assert.match(leer('images/asterisk/Dockerfile'), /^COPY config\/asterisk\/ \/etc\/asterisk\/$/m,
    'el Dockerfile dejo de copiar config/asterisk/ entero: indications.conf no llegaria a la imagen');

  /* Paridad: los dos compose pasan TONE_COUNTRY al servicio asterisk con el mismo default,
   * que es el pais de fabrica del archivo. */
  for (const f of ['docker-compose.yml', 'docker-compose.release.yml']) {
    const txt = leer(f);
    const ini = txt.indexOf('\n  asterisk:');
    const ast = txt.slice(ini, txt.indexOf('\n    volumes:', ini));   // el environment del servicio
    assert.ok(ast.includes('TONE_COUNTRY: ${TONE_COUNTRY:-' + pais + '}'), `${f}: el servicio asterisk no pasa TONE_COUNTRY con default ${pais}`);
  }
  assert.match(leer('.env.example'), new RegExp('^TONE_COUNTRY=' + pais + '$', 'm'), '.env.example no documenta TONE_COUNTRY');
  /* El entrypoint lo aplica solo si la zona existe: un pais sin zona dejaria todo mudo. */
  const ep = leer('images/asterisk/docker-entrypoint.sh');
  assert.match(ep, /TONE_COUNTRY/, 'el entrypoint no aplica TONE_COUNTRY');
  assert.match(ep, /grep -q "\^\\\[\$\{TONE_COUNTRY\}\\\]" \/etc\/asterisk\/indications\.conf/, 'el entrypoint tiene que verificar que la zona exista antes de usarla');
});

/* La astdb (astdb.sqlite3) es la que lee el dialplan en cada llamada: desvios, no-molestar,
 * modo noche y PIN de las salas. Vivia en la capa de escritura del contenedor, asi que
 * recrear Asterisk la vaciaba y quedaba una ventana —hasta el resync del AMI— en la que la
 * central atendia como si nada de eso estuviera configurado. Este invariante ata las tres
 * piezas que tienen que moverse juntas (astdbdir, el montaje y la declaracion del volumen en
 * los DOS compose): con una sola que se caiga, la astdb vuelve a ser efimera en silencio. */
test('la astdb vive en un volumen propio en los dos compose', () => {
  const conf = leer('config/asterisk/asterisk.conf');
  assert.ok(!/^\[directories\]\(!\)/m.test(conf),
    'la stanza [directories] volvio a ser plantilla ((!)): Asterisk la ignora y astdbdir no aplica');
  const m = /^astdbdir\s*=>\s*(\S+)\s*$/m.exec(conf);
  assert.ok(m, 'asterisk.conf perdio el astdbdir');
  const dir = m[1];
  assert.ok(dir !== '/var/lib/asterisk',
    'astdbdir volvio a /var/lib/asterisk: ahi no se puede montar un volumen sin tapar sonidos, agi-bin y claves');
  for (const f of ['docker-compose.yml', 'docker-compose.release.yml']) {
    const c = leer(f);
    assert.ok(c.includes('asterisk_db:' + dir),
      `${f} no monta el volumen asterisk_db en ${dir}: la astdb se vacia al recrear el contenedor`);
    assert.ok(/^\s{2}asterisk_db:\s*$/m.test(c), `${f} no declara el volumen asterisk_db`);
  }
});

/* El AudioSocket de la IA (:9092) tiene que estar PUBLICADO en los dos compose.
 *
 * Por qué vive acá y no en una prueba de integración: las pruebas levantan la API sobre
 * loopback, sin Docker, así que el puerto siempre está a mano y el agujero es invisible.
 * En producción no: Asterisk corre en la red del host y se conecta al 9092 de la API, que
 * vive en la red bridge. Sin la publicación, `externalMedia` muere con «Connection
 * refused», la llamada al agente se corta antes de que el modelo entre en juego, y no hay
 * ningún error que lo diga — el panel muestra la clave y el modelo perfectos. Así estuvo
 * el IVR con IA en TODOS los despliegues Docker hasta la 1.14.3. */
test('el AudioSocket de la IA esta publicado en los dos compose, y en loopback', () => {
  for (const f of ['docker-compose.yml', 'docker-compose.release.yml']) {
    const txt = leer(f);
    const api = txt.slice(txt.indexOf('\n  api:'), txt.indexOf('\n  dashboard:'));
    assert.ok(/ports:/.test(api), `${f}: el servicio api no publica ningun puerto`);
    /* Un solo bloque `ports:`. Dos claves iguales en el mismo servicio no son un detalle de
     * estilo: el compose no parsea y NINGUN contenedor levanta. Se descubrio desplegando. */
    assert.equal((api.match(/^\s+ports:/gm) || []).length, 1, `${f}: el servicio api tiene dos bloques ports: el compose no parsea`);
    assert.match(api, /\$\{MEDIA_BIND:-127\.0\.0\.1\}:9092:9092/,
      `${f}: el 9092 del AudioSocket no esta publicado (o dejo de ser en loopback por defecto)`);
    assert.match(api, /MEDIA_HOST: \$\{MEDIA_HOST:-127\.0\.0\.1\}/,
      `${f}: MEDIA_HOST es lo que marca ASTERISK desde la red del host; con el 9092 en loopback va 127.0.0.1`);
  }
});
