'use strict';
/* ============================================================================
 *  PBX-NG · la central se trae sola el instalador nuevo del softphone
 *
 *  QUE PROBLEMA RESUELVE. El instalador y el feed OTA que sirve cada central
 *  (`/descargas/softphone/`) se llenaban en el build de la imagen (fetch-softphone.sh) o
 *  a mano por SSH. Resultado real: CI publico 0.17.0 el 30/09 y pbx01 siguio sirviendo
 *  0.5.0 dentro de la imagen hasta que alguien se acordo de copiar los archivos. El boton
 *  del login y el actualizador del softphone leen ESE directorio, asi que mientras nadie
 *  copiaba, para la gente la version nueva no existia — y el actualizador informaba, con
 *  razon, que estaba al dia.
 *
 *  POR QUE PULL Y NO PUSH (cambia la decision escrita en el design del cambio).
 *  El design decia que el workflow le entregaba los archivos a cada central. No se
 *  implementa asi, y conviene decir por que:
 *
 *   1. Las centrales son equipos on-prem en la red del cliente, detras de NAT. Para que
 *      GitHub Actions les entregue algo hay que darle a CI un camino ENTRANTE a cada una.
 *      Eso es justo lo que un cliente on-prem no da, y es la superficie mas peligrosa de
 *      todo el cambio: un endpoint de administracion publicado en cada PBX, con una
 *      credencial de larga vida guardada en los secretos del repo, a cambio de no
 *      consultar una URL.
 *   2. El argumento contra pull era «muchas centrales sin salida libre a internet». Pero
 *      la central YA necesita salida HTTPS para Let's Encrypt (acme.js). Y si de verdad no
 *      tiene salida, el push tampoco la salva: no le llega nada igual. Para ese caso la
 *      respuesta honesta es subir el archivo a mano desde el panel, que es un camino que
 *      conviene tener de todas formas.
 *   3. Pull atraviesa NAT sin abrir nada, no necesita credencial mientras el repo sea
 *      publico, y degrada bien: si no se llega a GitHub, la central sigue sirviendo la
 *      version que ya tiene.
 *
 *  LO QUE NO HACE. No decide actualizar los softphones: eso lo hace electron-updater
 *  contra el feed de la central, como siempre. Esto sólo deja los archivos ahi.
 *
 *  CONFIGURABLE DESDE EL PANEL, no por .env: `softphone_ota_auto` (si sale a buscar),
 *  `softphone_ota_repo` (de donde) y `softphone_ota_cada_h` (cada cuanto).
 * ==========================================================================*/

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const logger = require('./log');
const desc = require('./softphone-descargas');

/* `logger` es una FABRICA: se la llama con el nombre del modulo y devuelve los cuatro
 * niveles. Tratarla como un logger ya armado deja `log.warn` sin definir, y entonces el
 * primer camino de error del modulo revienta con «log.warn is not a function» en vez de
 * reportar el problema real — que es exactamente lo que paso la primera vez. */
const log = logger('softphone-ota');
/* El texto va como argumento aparte, NO como `msg:` dentro del objeto: armar() pisa
 * `rec.msg` con la union de los argumentos string al final, asi que un msg puesto en el
 * objeto se publica vacio. */

const DEFAULTS = { auto: false, repo: 'flavioGonz/pbx-ng', cada_h: 6 };
/* Un instalador pesa ~85 MB y durante la descarga conviven el viejo y el nuevo. Por debajo
 * de esto no se baja NADA: dejar el disco de una central telefonica sin espacio corta
 * llamadas, graba mal y rompe Postgres, y una version nueva del softphone no vale eso. */
const MIN_LIBRE_MB = 600;
const TOPE_MB = 400;              // un .exe mas grande que esto es sospechoso, no se baja

function initOta(deps) {
  const { pool, dir } = deps;
  let corriendo = false;          // una sola descarga a la vez
  let timer = null;
  let estado = { ultimo_intento: null, ultimo_ok: null, resultado: null, detalle: null, bajando: null };

  const ajuste = async (k, def) => {
    try { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value !== null && rows[0].value !== '' ? rows[0].value : def; }
    catch (_) { return def; }
  };
  async function config() {
    return {
      auto: String(await ajuste('softphone_ota_auto', DEFAULTS.auto ? '1' : '0')) === '1',
      repo: String(await ajuste('softphone_ota_repo', DEFAULTS.repo)).trim().replace(/^\/+|\/+$/g, ''),
      cada_h: Math.max(1, Math.min(168, parseInt(await ajuste('softphone_ota_cada_h', String(DEFAULTS.cada_h)), 10) || DEFAULTS.cada_h)),
    };
  }

  /* Lo que la central sirve AHORA. Sale del mismo armador que /api/softphone/latest para
   * que las dos cosas no puedan discrepar. */
  function local() {
    let yml = null; let nombres = [];
    try { yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'); } catch (_) {}
    try { nombres = fs.readdirSync(dir); } catch (_) {}
    return desc.armar({ latestYml: yml, nombres, tamano: (f) => { try { return fs.statSync(path.join(dir, f)).size; } catch (_) { return null; } } });
  }

  async function libreMB() {
    try { const s = await fsp.statfs(dir); return Math.floor((s.bsize * s.bavail) / (1024 * 1024)); }
    catch (_) { return null; }    // sin dato no se bloquea: se avisa y se sigue
  }

  const base = (repo, ver) => 'https://github.com/' + repo + '/releases/' + (ver ? 'download/softphone-v' + ver : 'latest/download');

  async function traer(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 20000);
    try { return await fetch(url, { signal: ctl.signal, redirect: 'follow' }); }
    finally { clearTimeout(t); }
  }

  /* Baja a `<archivo>.part` y recien al terminar renombra. Un corte a mitad deja un .part
   * que nadie sirve, en vez de un .exe truncado que el actualizador intentaria instalar. */
  async function bajarArchivo(url, destino, maxBytes) {
    const r = await traer(url, 30000);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' en ' + url.split('/').pop());
    const largo = parseInt(r.headers.get('content-length') || '0', 10);
    if (largo && maxBytes && largo > maxBytes) throw new Error('el archivo pesa ' + Math.round(largo / 1048576) + ' MB, mas que el tope');
    const parte = destino + '.part';
    await fsp.writeFile(parte, Buffer.from(await r.arrayBuffer()));
    const st = await fsp.stat(parte);
    if (largo && st.size !== largo) { await fsp.rm(parte, { force: true }); throw new Error('descarga incompleta (' + st.size + ' de ' + largo + ')'); }
    await fsp.rename(parte, destino);
    return st.size;
  }

  /* Deja la actual y la anterior. La anterior importa: si la nueva sale mal, alguien que
   * todavia no actualizo puede bajar la que le andaba, sin esperar un release de arreglo. */
  async function podar(conservar) {
    let nombres = [];
    try { nombres = await fsp.readdir(dir); } catch (_) { return; }
    const exes = nombres.filter((n) => /\.exe$/i.test(n))
      .sort((a, b) => desc.compararVersiones(verDeExe(b), verDeExe(a)));
    const vivos = new Set();
    for (const n of exes.slice(0, 2)) { vivos.add(n); vivos.add(n + '.blockmap'); }
    for (const n of conservar || []) vivos.add(n);
    for (const n of nombres) {
      if (!/\.(exe|blockmap|msi)$/i.test(n) || vivos.has(n)) continue;
      try { await fsp.rm(path.join(dir, n), { force: true }); log.info({ archivo: n }, 'instalador viejo borrado'); } catch (_) {}
    }
    /* Los .part de un intento que se corto no se sirven, pero ocupan. */
    for (const n of nombres) if (/\.part$/.test(n)) { try { await fsp.rm(path.join(dir, n), { force: true }); } catch (_) {} }
  }
  const verDeExe = (n) => { const m = /(\d+(?:\.\d+){1,3})/.exec(String(n || '')); return m ? m[1] : '0'; };

  /**
   * Un ciclo: mirar que hay publicado y, si es mas nuevo, bajarlo.
   * @param {object} o { forzar?: boolean, version?: string }
   */
  async function revisar(o) {
    const op = o || {};
    if (corriendo) return { ok: false, motivo: 'ya hay una descarga en curso' };
    corriendo = true;
    estado.ultimo_intento = new Date().toISOString();
    try {
      const cfg = await config();
      if (!cfg.repo) { estado.resultado = 'sin_repo'; return { ok: false, motivo: 'no hay repositorio configurado' }; }
      const b = base(cfg.repo, op.version);

      const rY = await traer(b + '/latest.yml', 15000);
      if (!rY.ok) { estado.resultado = 'sin_release'; estado.detalle = 'HTTP ' + rY.status; return { ok: false, motivo: 'no se pudo leer el feed del release (HTTP ' + rY.status + ')' }; }
      const texto = await rY.text();
      const rem = desc.leerLatest(texto);
      if (!rem.file || !rem.version) { estado.resultado = 'feed_invalido'; return { ok: false, motivo: 'el latest.yml del release no trae path/version' }; }

      const act = local();
      const mismaOMejor = act.available && desc.compararVersiones(act.version, rem.version) >= 0;
      if (mismaOMejor && !op.forzar) {
        estado.resultado = 'al_dia'; estado.ultimo_ok = estado.ultimo_intento; estado.detalle = null;
        return { ok: true, al_dia: true, version: act.version };
      }

      const libre = await libreMB();
      if (libre != null && libre < MIN_LIBRE_MB) {
        estado.resultado = 'sin_disco'; estado.detalle = libre + ' MB libres';
        log.warn({ libre_mb: libre }, 'no se baja el instalador: poco disco');
        return { ok: false, motivo: 'quedan ' + libre + ' MB libres y hacen falta ' + MIN_LIBRE_MB };
      }

      estado.bajando = rem.version;
      log.info({ version: rem.version, archivo: rem.file }, 'bajando instalador del softphone');
      /* GitHub publica los assets con los espacios convertidos en puntos, pero
       * electron-builder los referencia con el nombre original en el latest.yml. */
      const asset = String(rem.file).replace(/ /g, '.');
      const destino = path.join(dir, rem.file);
      const bytes = await bajarArchivo(b + '/' + asset, destino, TOPE_MB * 1048576);
      /* Sin blockmap la actualizacion es completa en vez de diferencial: molesta, no rompe. */
      try { await bajarArchivo(b + '/' + asset + '.blockmap', destino + '.blockmap', 4 * 1048576); }
      catch (e) { log.warn({ err: e && e.message }, 'sin blockmap: la actualizacion sera completa'); }

      /* El latest.yml SIEMPRE al final: es lo que el actualizador lee para decidir. Si se
       * escribiera primero, un softphone que consulta en el medio se iria a buscar un .exe
       * que todavia no termino de bajar. */
      await fsp.writeFile(path.join(dir, 'latest.yml'), texto);
      await podar([rem.file, rem.file + '.blockmap', 'latest.yml']);

      estado.resultado = 'actualizado'; estado.ultimo_ok = new Date().toISOString();
      estado.detalle = rem.version + ' (' + Math.round(bytes / 1048576) + ' MB)';
      log.info({ version: rem.version, mb: Math.round(bytes / 1048576) }, 'instalador nuevo publicado en esta central');
      return { ok: true, actualizado: true, version: rem.version, anterior: act.version || null };
    } catch (e) {
      /* Una central sin salida a internet cae aca en cada ciclo. Es normal y no es un error
       * de la central: queda en warn y se sigue sirviendo lo que ya tiene. */
      estado.resultado = 'error'; estado.detalle = (e && e.message) || 'error';
      log.warn({ err: estado.detalle }, 'no se pudo revisar el release del softphone');
      return { ok: false, motivo: estado.detalle };
    } finally { corriendo = false; estado.bajando = null; }
  }

  /* El reloj se re-lee de la configuracion en cada vuelta: cambiar el intervalo en el panel
   * no obliga a reiniciar la API. */
  async function programar() {
    if (timer) { clearTimeout(timer); timer = null; }
    let cfg;
    try { cfg = await config(); } catch (_) { cfg = { auto: false, cada_h: DEFAULTS.cada_h }; }
    const ms = cfg.cada_h * 3600 * 1000;
    timer = setTimeout(async () => { try { const c = await config(); if (c.auto) await revisar({}); } catch (_) {} programar(); }, ms);
    if (timer.unref) timer.unref();
  }

  async function estadoCompleto() {
    const cfg = await config();
    const act = local();
    return {
      auto: cfg.auto, repo: cfg.repo, cada_h: cfg.cada_h,
      sirviendo: act.available ? { version: act.version, file: act.file, size: act.size, date: act.date } : null,
      android: act.android && act.android.available ? act.android : null,
      ...estado,
    };
  }

  /* Arranque: una revision a los 90 s para no competir con el resto del arranque, y
   * despues el reloj. Si `auto` esta apagado no sale a buscar nada. */
  const t0 = setTimeout(async () => { try { const c = await config(); if (c.auto) await revisar({}); } catch (_) {} }, 90000);
  if (t0.unref) t0.unref();
  programar();

  return { revisar, estado: estadoCompleto, local, config, programar };
}

module.exports = initOta;
module.exports.MIN_LIBRE_MB = MIN_LIBRE_MB;
module.exports.DEFAULTS = DEFAULTS;
