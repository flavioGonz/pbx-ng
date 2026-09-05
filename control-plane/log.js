'use strict';
/* PBX-NG · Logger mínimo con niveles y salida JSON (sin dependencias).
 *
 * Por qué existe: la API escribía con console.log/console.error y prefijos a mano
 * ('[ARI] ...', '[PUSH] ...'). Eso no se puede filtrar por nivel ni indexar en un
 * colector de logs (Loki, Datadog, journald con JSON) sin parsear texto. Acá cada
 * línea es un objeto {ts, level, mod, msg, ...campos} y el prefijo pasa a ser el
 * campo `mod`, que es lo que un colector usa para agrupar.
 *
 * Uso:  const log = require('./log')('ARI');  log.info('conectado', { url });
 *
 * LOG_LEVEL  = debug | info | warn | error   (default info; lo que esté por debajo se calla)
 * LOG_FORMAT = json (default) | text          (text = legible para desarrollo, una línea por evento)
 *
 * Los errores se pueden pasar como campo ({ err }) o como último argumento: se
 * serializan a {message, code, stack} para que el stack no se pierda en el JSON.
 * Nada de acá tira excepciones: un logger que rompe la app es peor que no loguear. */

const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 };
const PLANO = (process.env.LOG_FORMAT || 'json').toLowerCase() === 'text';

function nivelActual() {
  const n = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return NIVELES[n] || NIVELES.info;
}

function serializarError(e) {
  if (!e || typeof e !== 'object') return e;
  const o = { message: e.message || String(e) };
  if (e.code) o.code = e.code;
  if (e.status) o.status = e.status;
  if (e.stack) o.stack = e.stack;
  return o;
}

/* Un valor cualquiera dentro del JSON: los Error no se serializan solos
 * (JSON.stringify(new Error('x')) === '{}'), así que se convierten a mano. */
function limpiar(v) {
  if (v instanceof Error) return serializarError(v);
  return v;
}

function armar(mod, level, args) {
  const rec = { ts: new Date().toISOString(), level, mod };
  const partes = [];
  for (const a of args) {
    if (a instanceof Error) { rec.err = serializarError(a); continue; }
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      for (const k of Object.keys(a)) rec[k] = limpiar(a[k]);
      continue;
    }
    partes.push(typeof a === 'string' ? a : (a === undefined ? 'undefined' : JSON.stringify(a)));
  }
  rec.msg = partes.join(' ');
  return rec;
}

function escribir(rec) {
  const out = NIVELES[rec.level] >= NIVELES.warn ? process.stderr : process.stdout;
  let linea;
  if (PLANO) {
    const extra = {};
    for (const k of Object.keys(rec)) if (!['ts', 'level', 'mod', 'msg'].includes(k)) extra[k] = rec[k];
    // En texto, del error alcanza con el mensaje; el stack completo sólo en debug.
    if (extra.err && typeof extra.err === 'object' && nivelActual() > NIVELES.debug) extra.err = extra.err.message;
    const cola = Object.keys(extra).length ? ' ' + safeJson(extra) : '';
    linea = rec.ts + ' ' + rec.level.toUpperCase().padEnd(5) + ' [' + rec.mod + '] ' + rec.msg + cola;
  } else {
    linea = safeJson(rec);
  }
  try { out.write(linea + '\n'); } catch (_) { /* stdout cerrado: no hay a quién avisarle */ }
}

function safeJson(o) {
  try { return JSON.stringify(o); }
  catch (_) { try { return JSON.stringify({ msg: String(o && o.msg), err: 'no serializable' }); } catch (__) { return '{}'; } }
}

function logger(mod) {
  const m = String(mod || 'app');
  const hacer = (level) => (...args) => {
    if (NIVELES[level] < nivelActual()) return;
    escribir(armar(m, level, args));
  };
  return { debug: hacer('debug'), info: hacer('info'), warn: hacer('warn'), error: hacer('error'), mod: m };
}

module.exports = logger;
module.exports.logger = logger;
module.exports.NIVELES = NIVELES;
