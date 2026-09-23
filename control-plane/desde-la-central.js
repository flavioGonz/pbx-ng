'use strict';
/* ============================================================================
 *  ¿Este pedido lo hizo el dialplan de ESTA central?
 *
 *  POR QUÉ EXISTE ESTE ARCHIVO
 *  ---------------------------
 *  Hay cuatro rutas que atienden sin sesión porque el que llama es Asterisk, por
 *  `${CURL(...)}` desde el dialplan: los códigos de función (`/api/internal/feature`), la
 *  DISA y el callback (`/api/internal/disa|callback`) y el despertador de la PWA
 *  (`/api/internal/wake`). Las cuatro tenían —o les faltaba— su propia copia del mismo
 *  filtro, y la copia estaba MAL.
 *
 *  EL BUG, MEDIDO EN PRODUCCIÓN
 *  ----------------------------
 *  El filtro exigía origen loopback: `127.0.0.1` o `::1`. Es lo correcto sobre el papel
 *  —Asterisk corre con `network_mode: host` y pega a `http://127.0.0.1:3000`— pero la API
 *  NO está en la red del host: está en la red bridge del compose, con el puerto publicado
 *  en `127.0.0.1:3000`. Ese publicado lo atiende `docker-proxy`, que abre una conexión
 *  NUEVA hacia el contenedor: adentro, la IP de origen es la del gateway del bridge
 *  (172.18.0.1), no loopback. O sea que el filtro rechazaba exactamente al único que tenía
 *  que dejar pasar.
 *
 *  Verificado en pbx01 con el token correcto:
 *      POST /api/internal/feature  ->  403 {"error":"sólo desde la central"}
 *  Traducido: los desvíos, el no-molestar, el sígueme, la DISA y el callback marcados
 *  DESDE UN TELÉFONO no hacían nada. El panel sí funcionaba (ese camino tiene sesión), así
 *  que el síntoma era «lo pongo desde el teléfono y no pasa nada», sin un solo error.
 *
 *  Las pruebas no lo veían porque hablan con la API directo por loopback: el ayudante de
 *  integración levanta `app.js` como proceso hijo y le pega a `127.0.0.1:<puerto>`, sin
 *  contenedor y sin docker-proxy en el medio. Por eso este archivo exporta el predicado
 *  suelto: se puede probar con pedidos falsos, que es la única forma de cubrir un caso que
 *  depende de la red de abajo.
 *
 *  QUÉ SE ACEPTA AHORA, Y POR QUÉ ES SEGURO
 *  ----------------------------------------
 *  1. Nunca con `X-Forwarded-For` ni `X-Real-IP`. Es la marca inequívoca de que el pedido
 *     pasó por un proxy —o sea, no vino del dialplan de esta máquina— y además, con
 *     `trust proxy = 1`, esa cabecera es justo la que decide `req.ip`. Se mira PRIMERO.
 *  2. Loopback pasa, como siempre (instalación sin Docker, o Asterisk adentro del mismo
 *     netns).
 *  3. Si no es loopback, se exige **el token compartido** (`/etc/pbxng/agent.token`, que
 *     la API genera y Asterisk monta de sólo lectura) **y** que el origen sea una IP
 *     privada. El token es el que autentica de verdad: son 32 bytes al azar que sólo
 *     tienen la API y el contenedor de Asterisk, y se compara en tiempo constante. La IP
 *     privada es defensa en profundidad: aunque alguien filtrara el token, el pedido
 *     tiene que venir igual de adentro, y la API no escucha en ninguna dirección pública.
 *  4. Sin token configurado (no debería pasar: `app.js` lo genera al arrancar) se vuelve
 *     al criterio estricto de loopback. Preferimos que no ande a que quede abierto.
 * ==========================================================================*/
const crypto = require('crypto');

const PRIVADA = [
  /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^169\.254\./,            // link-local IPv4
  /^f[cd][0-9a-f]{2}:/i,    // ULA IPv6 (fc00::/7)
  /^fe80:/i,                // link-local IPv6
];

function normalizar(ip) { return String(ip || '').replace(/^::ffff:/i, '').trim(); }
function esLoopback(ip) { const s = normalizar(ip); return s === '::1' || s === '127.0.0.1' || /^127\./.test(s); }
function esPrivada(ip) { const s = normalizar(ip); return PRIVADA.some((re) => re.test(s)); }

/**
 * Fábrica del filtro.
 * @param {object} deps
 *   - token    secreto compartido con los agentes (puede ser '' si no hay)
 *   - clientIp (req) => IP del cliente respetando `trust proxy` (auth.js)
 * @returns {{ permitido(req): {ok: boolean, motivo: string}, exigir(req, res): boolean }}
 */
module.exports = function crearFiltro(deps) {
  const TOKEN = String((deps && deps.token) || '');
  const clientIp = (deps && deps.clientIp) || ((req) => (req.socket && req.socket.remoteAddress) || '');

  /* El token puede venir por query (el CURL del dialplan lo manda así) o en el cuerpo. */
  function tokenOk(req) {
    if (!TOKEN) return false;
    const dado = String(((req.body || {}).tok) || ((req.query || {}).tok) || '');
    const a = Buffer.from(dado, 'utf8'), b = Buffer.from(TOKEN, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function permitido(req) {
    if (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) {
      return { ok: false, motivo: 'viene con cabecera de proxy: no salió del dialplan de esta máquina' };
    }
    const ip = clientIp(req);
    /* Con token configurado, el token es OBLIGATORIO, venga de donde venga —también desde
     * loopback—. Es el criterio que ya tenían los códigos de función y la DISA, y no se
     * afloja: loopback prueba que el pedido nació en esta máquina, no que lo hizo el
     * dialplan (cualquier proceso del host llega igual al puerto publicado). */
    if (TOKEN) {
      if (!tokenOk(req)) return { ok: false, motivo: 'falta el token del agente o no coincide' };
      if (esLoopback(ip)) return { ok: true, motivo: 'token del agente + loopback' };
      /* Y acá está el arreglo: detrás del bridge de Docker el origen es el gateway
       * (172.18.0.1), no loopback. Se acepta cualquier privada porque la red del compose
       * la elige Docker y cambia de instalación en instalación. */
      if (esPrivada(ip)) return { ok: true, motivo: 'token del agente + origen privado (' + normalizar(ip) + ')' };
      return { ok: false, motivo: 'token correcto pero origen ' + normalizar(ip) + ', que no es de adentro' };
    }
    /* Sin token (primer arranque, antes de que la API escriba agent.token): sólo loopback.
     * Preferimos que no ande a que quede abierto. */
    if (esLoopback(ip)) return { ok: true, motivo: 'loopback (todavía no hay token del agente)' };
    return { ok: false, motivo: 'sin token configurado sólo se acepta loopback, y el origen es ' + normalizar(ip) };
  }

  /* Corta el pedido con 403 y devuelve false; el cuerpo es el mismo que ya esperaban las
   * rutas que hacían esto a mano. `tipo` elige texto plano (lo lee un ${CURL}) o JSON. */
  function exigir(req, res, tipo) {
    const r = permitido(req);
    if (r.ok) return true;
    if (tipo === 'texto') res.status(403).type('text/plain').send('no');
    else res.status(403).json({ error: 'sólo desde la central' });
    return false;
  }

  return { permitido, exigir };
};
module.exports.esLoopback = esLoopback;
module.exports.esPrivada = esPrivada;
