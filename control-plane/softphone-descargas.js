'use strict';
/* ============================================================================
 *  PBX-NG · qué softphone puede bajar el que entra al panel
 *
 *  Cada central sirve SUS instaladores desde /descargas/softphone/. Hasta ahora eso
 *  era sólo Windows, porque el feed de electron-builder (latest.yml) sólo habla de
 *  Windows. El teléfono Android se publica como un .apk suelto al lado —no hay tienda
 *  de por medio en una instalación on-prem— así que la lista se arma mirando el
 *  directorio, y la versión sale del propio nombre del archivo.
 *
 *  Está acá y no dentro de app.js para poder probarlo sin levantar el servidor.
 * ==========================================================================*/

/** Lee los campos que nos importan de un latest.yml de electron-builder. */
function leerLatest(texto) {
  const y = String(texto || '');
  const g = (k) => {
    const m = new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(y);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
  };
  return { file: g('path'), version: g('version'), date: g('releaseDate') || null };
}

/* Versión dentro del nombre: pbxng-softphone-0.6.0.apk, PBX-NG_1.2.apk, app-v3.apk… */
function versionDeNombre(nombre) {
  const m = /(\d+(?:\.\d+){0,3})(?=[^\d]*\.apk$)/i.exec(String(nombre || ''));
  return m ? m[1] : '';
}

/* Compara 1.10.0 > 1.9.3 como números, no como texto: ordenar por string deja 1.9 arriba. */
function compararVersiones(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Elige el APK a ofrecer entre los archivos del directorio.
 * @param {string[]} nombres  lo que hay en /descargas/softphone/
 * @returns {string|null} el nombre del .apk de versión más alta (o el único que haya)
 */
function elegirApk(nombres) {
  const apks = (nombres || []).filter((n) => /\.apk$/i.test(n));
  if (!apks.length) return null;
  return apks.slice().sort((a, b) => {
    const d = compararVersiones(versionDeNombre(b), versionDeNombre(a));
    return d || a.localeCompare(b);
  })[0];
}

/**
 * Arma la respuesta de /api/softphone/latest.
 * Los campos de arriba siguen siendo los de Windows para no romper al softphone ya
 * instalado, que los lee tal cual para actualizarse; Android viaja aparte.
 *
 * @param {object} o { latestYml?, nombres?, tamano(nombre)->number|null }
 */
function armar(o) {
  const cfg = o || {};
  const tam = cfg.tamano || (() => null);
  const res = { available: false };

  const l = cfg.latestYml ? leerLatest(cfg.latestYml) : null;
  if (l && l.file && l.version) {
    const size = tam(l.file);
    if (size != null) {
      Object.assign(res, {
        available: true, version: l.version, file: l.file, size, date: l.date, platform: 'windows',
        url: '/descargas/softphone/' + encodeURIComponent(l.file),
      });
    } else {
      res.reason = 'falta ' + l.file;
    }
  }

  const apk = elegirApk(cfg.nombres);
  if (apk) {
    const size = tam(apk);
    if (size != null) {
      res.android = {
        available: true, file: apk, size, version: versionDeNombre(apk) || null,
        url: '/descargas/softphone/' + encodeURIComponent(apk),
      };
    }
  }
  if (!res.android) res.android = { available: false };
  return res;
}

module.exports = { leerLatest, versionDeNombre, compararVersiones, elegirApk, armar };
