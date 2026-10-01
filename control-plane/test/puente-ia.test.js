/* El puente del agente de IA no le saca el video al portero (conexion-con-pbx, 30/09).
 *
 * Con `type: 'mixing'`, para dos canales Asterisk usa el puente simple, que iguala las
 * negociaciones de las dos puntas (bridge_simple.c). El canal de audio de la IA (AudioSocket)
 * no tiene video, así que Asterisk le mandaba al portero un re-INVITE con `m=video 0`, y la
 * derivación al agente (`Dial` desde ese canal) salía solo con audio: el agente no veía la
 * cámara. Verificado con el registro SIP en la central local. `video_sfu` es la única opción
 * de ARI que fuerza el softmix (res_stasis.c, bridge_create_common), que no toca la
 * negociación del portero.
 *
 * Son archivos de texto del repo: no necesita Asterisk. Se corre con `npm test`. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

test('el puente de la IA es de mezcla con video_sfu, para que Asterisk use softmix', () => {
  const pipeline = leer('control-plane', 'ai-pipeline.js');
  const tipos = [...pipeline.matchAll(/bridge\.create\(\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(tipos, ['mixing,video_sfu'], 'el único puente que arma la IA tiene que ser mixing,video_sfu');
});

test('la imagen de Asterisk verifica que esté bridge_softmix.so (sin él la IA no arma su puente)', () => {
  const dockerfile = leer('docker', 'images', 'asterisk', 'Dockerfile');
  const entrypoint = leer('docker', 'images', 'asterisk', 'docker-entrypoint.sh');
  assert.match(dockerfile, /for m in [^;]*bridge_softmix\.so/, 'el gate del build tiene que cortar si falta');
  assert.match(entrypoint, /for m in [^;]*bridge_softmix\.so/, 'el arranque tiene que avisar si falta');
  // Es esperado, no requerido: que falte no puede dejar sin teléfonos a toda la central.
  assert.doesNotMatch(leer('docker', 'config', 'asterisk', 'modules.conf'), /^\s*require\s*=\s*bridge_softmix/m);
});
