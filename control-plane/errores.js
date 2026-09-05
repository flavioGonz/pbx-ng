'use strict';
/* PBX-NG · Traducción de errores a respuestas HTTP (docs/CONTRATOS.md §3).
 *
 * Regla del contrato: el cliente recibe `{ error: '<mensaje en español>' }` y NUNCA un
 * mensaje crudo de PostgreSQL. Antes casi todos los catch hacían
 * `res.status(500).json({ error: e.message })`, y un `relation "x" does not exist` o un
 * `duplicate key value violates unique constraint "..."` terminaba en un toast del
 * panel: feo para el usuario y una radiografía del esquema para cualquiera.
 *
 * errorHttp(res, e):
 *   - e.status (400/403/404/409…) se respeta: son errores nuestros con mensaje propio.
 *   - error de PostgreSQL → status según la clase SQLSTATE y mensaje genérico; el
 *     detalle real va al log (nivel error, con código y consulta si la trae).
 *   - cualquier otro error → 500 con e.message (son mensajes que ya escribimos nosotros:
 *     'AMI no conectado', 'Asterisk no disponible'…).
 */
const log = require('./log')('HTTP');

/* Un error de node-postgres trae `code` (SQLSTATE de 5 caracteres) y campos como
 * severity/routine. Las clases que nos interesan: 2x (datos), 4x (sintaxis/permisos/
 * esquema), 5x (recursos, cancelación, statement_timeout) y 08 (conexión). Por las dudas
 * se mira también el texto: hay errores que llegan sin code (pool cerrado, timeout de
 * conexión) pero con la misma pinta. */
const PG_MSG = /relation |syntax error|violates |column .* does not exist|does not exist|invalid input syntax|Connection terminated|timeout exceeded when trying to connect|canceling statement|Query read timeout|pool is draining|Cannot use a pool after calling end/i;
/* Un ECONNREFUSED/ETIMEDOUT hacia el puerto de la base también es "error de la DB":
 * el socket lo abre node-postgres y el mensaje trae host:puerto del servidor. */
const DB_PORT = String(process.env.DB_PORT || 5432);
function esErrorPg(e) {
  if (!e) return false;
  if (typeof e.code === 'string' && /^(0[08]|2\w|4\w|5\w)[0-9A-Z]{3}$/.test(e.code)) return true;
  if (e.severity && e.routine) return true;
  if (e.syscall === 'connect' && String(e.port || '') === DB_PORT) return true;
  if (/^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH)$/.test(String(e.code || '')) && new RegExp(':' + DB_PORT + '$').test(String(e.message || ''))) return true;
  return PG_MSG.test(String(e.message || ''));
}

/* Mensaje y status para el cliente según la clase de error. Se mantienen en español
 * y sin nombres de tablas/columnas/constraints. */
function traducirPg(e) {
  const c = String(e.code || '');
  if (c === '23505') return { status: 409, error: 'ya existe un registro con ese valor' };
  if (c === '23503') return { status: 409, error: 'no se puede: hay otros registros que dependen de este' };
  if (c === '23502') return { status: 400, error: 'falta un dato obligatorio' };
  if (c === '23514' || c.startsWith('22')) return { status: 400, error: 'alguno de los datos no es válido' };
  if (c === '57014' || /canceling statement|Query read timeout/i.test(e.message || '')) return { status: 504, error: 'la consulta a la base de datos tardó demasiado' };
  if (c.startsWith('08') || c.startsWith('57P') || c.startsWith('53') || /^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH)$/.test(c) || /Connection terminated|timeout exceeded when trying to connect|pool is draining|after calling end/i.test(e.message || '')) return { status: 503, error: 'sin conexión con la base de datos, probá de nuevo en unos segundos' };
  return { status: 500, error: 'error interno de la base de datos' };
}

function errorHttp(res, e, extra) {
  const err = e || new Error('error desconocido');
  const req = res && res.req;
  const ctx = Object.assign({ method: req && req.method, path: req && (req.originalUrl || req.url) }, extra || {});
  if (err.status && err.status >= 400 && err.status < 600 && !esErrorPg(err)) {
    if (err.status >= 500) log.error(err.message, ctx, err);
    if (res.headersSent) return;
    return res.status(err.status).json({ error: err.message });
  }
  if (esErrorPg(err)) {
    const t = traducirPg(err);
    log.error('error de PostgreSQL', Object.assign(ctx, { code: err.code, detail: err.detail, table: err.table, constraint: err.constraint }), err);
    if (res.headersSent) return;
    return res.status(t.status).json({ error: t.error });
  }
  log.error(err.message || String(err), ctx, err);
  if (res.headersSent) return;
  return res.status(500).json({ error: err.message || 'error interno' });
}

/* Middleware final de Express: lo que ninguna ruta atrapó (throw sincrónico, next(err),
 * async sin try). Se monta DESPUÉS de todas las rutas y del 404 de /api. Nunca se
 * devuelve e.message crudo: a esta altura no sabemos de dónde viene. */
function middlewareFinal(err, req, res, next) {   // eslint-disable-line no-unused-vars
  const ctx = { method: req.method, path: req.originalUrl || req.url, ip: req.ip };
  if (esErrorPg(err)) {
    log.error('error de PostgreSQL sin atrapar', Object.assign(ctx, { code: err && err.code }), err);
    if (res.headersSent) return;
    return res.status(500).json({ error: 'error interno' });
  }
  const status = (err && err.status >= 400 && err.status < 600) ? err.status : 500;
  if (status >= 500) log.error('error sin atrapar', ctx, err);
  else log.warn('rechazo sin atrapar', Object.assign(ctx, { status }), err);
  if (res.headersSent) return;
  // 4xx con mensaje propio (validaciones que hacen throw con e.status) se dejan pasar; 5xx no.
  res.status(status).json({ error: status < 500 && err && err.message ? err.message : 'error interno' });
}

module.exports = { errorHttp, esErrorPg, traducirPg, middlewareFinal };
