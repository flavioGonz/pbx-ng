'use strict';
/* ============================================================================
 *  PBX-NG · configuración de Asterisk que genera el panel.
 *
 *  Hay cosas que Asterisk NO lee de la base (realtime): el aparcado de llamadas y
 *  las clases de música en espera viven en archivos. Para no obligar a reconstruir
 *  la imagen cada vez que el operador cambia un número o sube un audio, los .conf
 *  horneados hacen `#include "pbxng.d/*.conf"` y ACÁ generamos ese directorio, que
 *  es un volumen compartido entre la API y Asterisk.
 *
 *  Después de escribir hay que recargar: `parking reload` y `moh reload` por AMI.
 *  Sin el reload, el panel dice "guardado" y Asterisk sigue con lo de antes.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

const DIR = process.env.AST_CONF_DIR || '/etc/asterisk/pbxng.d';
const MOH_DIR = process.env.AST_MOH_DIR || '/var/lib/asterisk/sounds/custom/moh';
// Cómo ve Asterisk esa carpeta (el volumen está montado igual en los dos contenedores).
const MOH_DIR_AST = process.env.AST_MOH_DIR_ASTERISK || '/var/lib/asterisk/sounds/custom/moh';

function escribir(nombre, texto) {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
  const ruta = path.join(DIR, nombre);
  fs.writeFileSync(ruta, texto);
  return ruta;
}

const limpio = (s) => String(s || '').replace(/[^\w.\-]/g, '');

/* ---------- Aparcado de llamadas ----------
 * Un lote = a qué número se transfiere para aparcar, qué plazas hay, y cuánto espera
 * antes de volver a timbrar donde estaba. */
function parking(cfg) {
  const c = cfg || {};
  const ext = limpio(c.parkext || '700');
  const desde = parseInt(c.desde, 10) || 701;
  const hasta = parseInt(c.hasta, 10) || 720;
  const tiempo = Math.max(10, parseInt(c.parkingtime, 10) || 300);
  const vuelve = c.comebacktoorigin === false ? 'no' : 'yes';
  const L = [
    '; ============================================================',
    ';  Aparcado de llamadas · GENERADO POR EL PANEL — no editar a mano',
    `;  ${new Date().toISOString()}`,
    '; ============================================================',
    '[default]',
    `parkext = ${ext}`,
    `parkpos = ${Math.min(desde, hasta)}-${Math.max(desde, hasta)}`,
    'context = parkedcalls',
    `parkingtime = ${tiempo}`,
    `comebacktoorigin = ${vuelve}`,
    'comebackdialtime = 30',
    'parkedplay = caller',
    'parkedcalltransfers = caller',
    'parkedcallreparking = caller',
    'findslot = first',
    'parkinghints = yes',
    '',
  ];
  return escribir('parking.conf', L.join('\n'));
}

/* ---------- Música en espera ----------
 * Cada clase es una carpeta con los audios que subió el operador. `sort` define si
 * suenan en orden o al azar; `announcement` es el mensaje opcional al entrar en espera. */
function moh(clases) {
  const L = [
    '; ============================================================',
    ';  Música en espera · GENERADO POR EL PANEL — no editar a mano',
    `;  ${new Date().toISOString()} · ${(clases || []).length} clase(s)`,
    '; ============================================================',
  ];
  for (const cl of (clases || [])) {
    const nombre = limpio(cl.nombre);
    if (!nombre || nombre === 'default') continue;   // 'default' es la de fábrica
    L.push('', `[${nombre}]`, 'mode=files', `directory=${MOH_DIR_AST}/${nombre}`);
    const sort = ['alpha', 'random', 'randstart'].includes(cl.sort) ? cl.sort : 'alpha';
    L.push(`sort=${sort}`);
    if (cl.announcement) L.push(`announcement=${limpio(cl.announcement)}`);
  }
  L.push('');
  return escribir('moh.conf', L.join('\n'));
}

/* Carpeta física de una clase (donde se guardan los audios subidos). */
function mohCarpeta(nombre) {
  const n = limpio(nombre);
  const d = path.join(MOH_DIR, n);
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
function mohBorrarCarpeta(nombre) {
  const n = limpio(nombre);
  if (!n) return;
  try { fs.rmSync(path.join(MOH_DIR, n), { recursive: true, force: true }); } catch (_) {}
}
function mohArchivos(nombre) {
  try {
    return fs.readdirSync(path.join(MOH_DIR, limpio(nombre)))
      .filter((f) => /\.(wav|gsm|ulaw|alaw|sln|g722|mp3)$/i.test(f))
      .sort();
  } catch (_) { return []; }
}

module.exports = { parking, moh, mohCarpeta, mohBorrarCarpeta, mohArchivos, DIR, MOH_DIR };
