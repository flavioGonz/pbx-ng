/* ============================================================================
 *  Arnés de las pruebas `tel-ramas-*`: arma apps.js, telefonia.js o marcacion.js con
 *  dependencias de mentira, sin Postgres, sin Asterisk y sin Express.
 *
 *  Por qué existe además del entorno de integración (helpers/db.js): los caminos que
 *  quedaban sin probar en esos tres módulos son casi todos los de FALLA —la base que se
 *  cae a mitad de una transacción, el AMI que no contesta, el TTS que devuelve vacío—, y
 *  contra un Postgres de verdad no hay forma limpia de hacer que el tercer INSERT de una
 *  transacción falle. Acá cada consulta se contesta por expresión regular, y una regla
 *  puede devolver filas, una función o un Error que se tira.
 *
 *    const pool = poolFalso();
 *    pool.cuando(/FROM pbxng_ivr WHERE id/, [{ exten: '600' }]);   // filas
 *    pool.cuando(/INSERT INTO extensions/, new Error('se cayó'));   // tira
 *    pool.conectar = new Error('sin base');                         // falla el connect()
 *    const app = appFalsa();
 *    const r = await app.pedir('POST', '/api/ivr', { body: {...} });  // { status, json, headers }
 * ==========================================================================*/
'use strict';

/* Respuesta de Express con lo justo que usan los módulos: status/json/send/set/type/end. */
function resFalsa() {
  const r = {
    statusCode: 200, headers: {}, cuerpo: undefined, terminado: false,
    status(c) { r.statusCode = c; return r; },
    set(k, v) { r.headers[String(k).toLowerCase()] = v; return r; },
    type(t) { r.headers['content-type'] = t; return r; },
    json(o) { r.cuerpo = o; r.terminado = true; return r; },
    send(b) { r.cuerpo = b; r.terminado = true; return r; },
    end() { r.terminado = true; return r; },
  };
  return r;
}

/* Express de mentira: guarda el ÚLTIMO manejador de cada ruta (los middlewares de parseo,
 * como el urlencoded de /api/internal/*, no hacen falta porque el cuerpo llega armado). */
function appFalsa() {
  const rutas = new Map();
  const reg = (m) => (p, ...fns) => { rutas.set(m + ' ' + p, fns[fns.length - 1]); };
  const app = {
    rutas,
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {},
    async pedir(method, ruta, o = {}) {
      const h = rutas.get(method + ' ' + ruta);
      if (!h) throw new Error('la app falsa no tiene ' + method + ' ' + ruta);
      const req = {
        params: o.params || {}, query: o.query || {}, body: o.body, user: o.user,
        headers: o.headers || {}, ip: o.ip || '127.0.0.1', socket: { remoteAddress: o.ip || '127.0.0.1' },
      };
      const res = resFalsa();
      await h(req, res);
      return { status: res.statusCode, json: res.cuerpo, headers: res.headers, terminado: res.terminado };
    },
  };
  return app;
}

/* Pool de pg de mentira. Las reglas más nuevas ganan (así una prueba pisa una general). */
function poolFalso() {
  const reglas = [];
  const llamadas = [];
  const normal = (v) => (Array.isArray(v) ? { rows: v, rowCount: v.length } : Object.assign({ rows: [], rowCount: 0 }, v));
  async function responder(sql, args) {
    llamadas.push({ sql, args });
    for (const [re, r] of reglas) {
      if (!re.test(sql)) continue;
      const v = typeof r === 'function' ? await r(args, sql) : r;
      if (v instanceof Error) throw v;
      return normal(v);
    }
    return { rows: [], rowCount: 0 };
  }
  const pool = {
    llamadas, reglas, sueltos: 0, conectar: null,
    cuando(re, r) { reglas.unshift([re, r]); return pool; },
    query: responder,
    async connect() {
      if (pool.conectar) throw pool.conectar;
      return { query: responder, release() { pool.sueltos++; } };
    },
    /* Las sentencias que matchean, para mirar qué se escribió y con qué. */
    hechas(re) { return llamadas.filter((l) => re.test(l.sql)); },
  };
  return pool;
}

/* errorHttp de mentira: respeta e.status como el de verdad (errores.js) y deja el mensaje
 * a la vista, que es lo que las pruebas comparan. */
const errorHttp = (res, e) => res.status((e && e.status) || 500).json({ error: (e && e.message) || String(e) });

/* Logger que guarda lo que se registró, para comprobar que una falla no fue muda. */
function loggerFalso() {
  const lineas = [];
  const fab = (mod) => {
    const l = {};
    for (const n of ['debug', 'info', 'warn', 'error']) l[n] = (...a) => lineas.push({ mod, nivel: n, msg: String(a[0] && a[0].message ? a[0].message : a[0]) });
    return l;
  };
  fab.lineas = lineas;
  return fab;
}

/* Deja pasar las promesas pendientes (las cadenas de await que dispara un timer). */
const vaciar = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((ok) => setImmediate(ok)); };
/* Espera a que algo pase (p. ej. lo que dispara un timer y lee el disco). Con setImmediate y
 * reloj de verdad porque las pruebas que lo usan tienen setTimeout simulado. */
async function hasta(cond, ms = 3000) {
  const fin = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fin) throw new Error('no pasó lo esperado en ' + ms + ' ms');
    await new Promise((ok) => setImmediate(ok));
  }
}

module.exports = { appFalsa, poolFalso, resFalsa, errorHttp, loggerFalso, vaciar, hasta };
