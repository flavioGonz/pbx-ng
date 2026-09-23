'use strict';
/* ============================================================================
 *  PBX-NG · Credenciales de SISTEMA para la API pública (`/api/v1`).
 *
 *  QUÉ RESUELVE
 *  ------------
 *  El backoffice no es una persona. No puede cambiar una contraseña vencida, no mira un
 *  cartel de error, y cuando hay que sacarle el acceso hay que poder hacerlo sin tocar a
 *  nadie más. Las dos credenciales que existían —sesión de panel y token de softphone—
 *  están hechas para personas, así que un sistema entraba de una de estas dos formas, las
 *  dos malas: un usuario «api» con rol admin (el día que se filtra, entra a todo y las
 *  bitácoras dicen que fue «alguien»), o una clave fija en el `.env` (no se rota sin
 *  reiniciar, no admite dos consumidores y no deja rastro de cuál se usó).
 *
 *  CÓMO FUNCIONA
 *  -------------
 *    1. Un admin da de alta un cliente desde el panel: sale `client_id` + `secreto`. El
 *       secreto se muestra UNA vez y se guarda hasheado con bcrypt.
 *    2. El sistema cambia ese par por un token corto:
 *         POST /api/v1/auth/token  { client_id, secreto }  ->  { token, expira_en, alcances }
 *    3. El token se verifica en CADA pedido CONTRA LA TABLA, no sólo por firma. Esa es la
 *       diferencia que importa: revocar es un UPDATE y corta el acceso al instante, en vez
 *       de esperar a que venza algo que ya está emitido.
 *
 *  ALCANCES, Y POR QUÉ SON UNA LISTA Y NO UN ROL
 *  ---------------------------------------------
 *  Un rol es una bolsa que crece: el día que alguien le agrega una ruta al rol, todos los
 *  que lo tienen la reciben sin que nadie lo decida. Acá cada cliente lleva la lista
 *  explícita de lo que puede hacer, deny-by-default como `rbac.js`, y la lista de valores
 *  válidos vive en este archivo (ALCANCES) porque es el único que los interpreta. Un
 *  cliente con `cdr:leer` no origina una llamada aunque adivine la ruta.
 *
 *  LO QUE ESTE MÓDULO NO HACE
 *  --------------------------
 *  No esquiva el RBAC: los tokens de servicio sólo sirven bajo `/api/v1`, y el gate de
 *  `/api` los rechaza explícitamente. Un token de sistema NO es una sesión de panel y no
 *  hereda ningún rol: si mañana se quiere que el backoffice toque configuración, se agrega
 *  un alcance y se escribe en el contrato, no se le da un rol.
 * ==========================================================================*/
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

/* Catálogo cerrado de alcances. Cada uno dice, en una línea, qué habilita. Agregar uno es
 * una decisión de contrato: va con su renglón en docs/CONTRATOS.md §3.2. */
const ALCANCES = {
  'cdr:leer': 'historial de llamadas y su detalle',
  'grabaciones:leer': 'listado y descarga de grabaciones',
  'llamadas:ver': 'llamadas en curso (sólo lectura)',
  'llamadas:ordenar': 'originar, transferir, colgar, aparcar',
  'internos:ver': 'estado de los internos y del directorio',
  'eventos:recibir': 'ser destino del outbox de eventos',
};
const ALCANCES_VALIDOS = Object.keys(ALCANCES);

const VIDA_TOKEN_S = 3600;           // 1 h: corto porque se renueva solo, sin nadie mirando
const CACHE_MS = 5000;               /* Cuánto se recuerda el estado de un cliente entre
                                      * pedidos. No es rendimiento por gusto: sin esto,
                                      * cada pedido del backoffice es un SELECT más, y el
                                      * outbox puede hacer varios por segundo. 5 s es el
                                      * retraso máximo entre «revoqué» y «dejó de entrar»,
                                      * y está escrito en el contrato. */

module.exports = function init(deps) {
  const { app, pool, auth, errorHttp, logger, secret } = deps;
  const log = logger('apiclients');
  const SECRET = String(secret || '');

  const cache = new Map();           // client_id -> { at, fila }
  const generarSecreto = () => crypto.randomBytes(24).toString('base64url');

  function limpiarId(v) {
    const s = String(v || '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(s) ? s : null;
  }
  function limpiarAlcances(v) {
    const lista = Array.isArray(v) ? v : String(v || '').split(',');
    const out = [];
    for (const a of lista) {
      const s = String(a || '').trim();
      if (!s) continue;
      if (!ALCANCES_VALIDOS.includes(s)) return { error: 'alcance desconocido: ' + s };
      if (!out.includes(s)) out.push(s);
    }
    return { alcances: out };
  }

  async function traerCliente(id, forzar) {
    const c = cache.get(id);
    if (!forzar && c && (Date.now() - c.at) < CACHE_MS) return c.fila;
    const { rows } = await pool.query('SELECT client_id, nombre, alcances, revocado_at FROM pbxng_api_clients WHERE client_id=$1', [id]);
    const fila = rows[0] || null;
    cache.set(id, { at: Date.now(), fila });
    return fila;
  }
  const olvidar = (id) => cache.delete(id);

  /* ── Middleware: exige un token de SERVICIO válido y vigente ──────────────────
   * Se monta en `/api/v1`. Deja `req.cliente = { id, alcances }`. */
  async function authServicio(req, res, next) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) return res.status(401).json({ error: 'falta el token de servicio', doc: '/api/v1/auth/token' });
    let dato;
    try { dato = jwt.verify(t, SECRET); } catch (_) { return res.status(401).json({ error: 'token inválido o vencido' }); }
    if (dato.scope !== 'service' || !dato.cid) {
      /* Una sesión de panel NO sirve acá, y esto es a propósito: `/api/v1` es el contrato
       * con un sistema, y si un navegador con sesión pudiera usarlo, cualquier bug de CSRF
       * del panel sería un bug del contrato público. */
      return res.status(403).json({ error: 'este endpoint sólo acepta credenciales de sistema (/api/v1/auth/token)' });
    }
    try {
      const fila = await traerCliente(String(dato.cid));
      if (!fila) return res.status(401).json({ error: 'el cliente de API ya no existe' });
      if (fila.revocado_at) return res.status(401).json({ error: 'credencial revocada' });
      req.cliente = { id: fila.client_id, nombre: fila.nombre, alcances: fila.alcances || [] };
      /* El «último uso» se escribe sin esperar y sin romper el pedido si falla: sirve para
       * ver de un vistazo qué integración se calló, no es parte de la respuesta. */
      pool.query('UPDATE pbxng_api_clients SET usado_at=now(), usado_ip=$2 WHERE client_id=$1',
        [fila.client_id, String((deps.clientIp && deps.clientIp(req)) || '').slice(0, 45)]).catch(() => {});
      next();
    } catch (e) { errorHttp(res, e); }
  }

  /* Exige un alcance concreto. Se usa por ruta, no por familia: la lista de lo que puede
   * cada cliente tiene que poder leerse al lado de la ruta que la usa. */
  const exigirAlcance = (alcance) => (req, res, next) => {
    const tiene = req.cliente && Array.isArray(req.cliente.alcances) && req.cliente.alcances.includes(alcance);
    if (tiene) return next();
    return res.status(403).json({ error: 'tu credencial no tiene el alcance «' + alcance + '»', alcance_requerido: alcance });
  };

  /* ── Emisión del token ────────────────────────────────────────────────────────
   * Es pública (no lleva sesión): la credencial ES el cuerpo. Por eso tiene el mismo
   * freno de fuerza bruta que el login del panel, con la misma razón. */
  app.post('/api/v1/auth/token', ...(deps.limiteIntentos ? deps.limiteIntentos('client_id') : []), async (req, res) => {
    const b = req.body || {};
    const id = limpiarId(b.client_id);
    const sec = String(b.secreto || b.secret || '');
    if (!id || !sec) return res.status(400).json({ error: 'client_id y secreto son obligatorios' });
    try {
      const { rows } = await pool.query('SELECT client_id, nombre, secreto_hash, alcances, revocado_at FROM pbxng_api_clients WHERE client_id=$1', [id]);
      const c = rows[0];
      /* Mismo mensaje para «no existe», «secreto incorrecto» y «revocado»: quien prueba
       * credenciales no tiene por qué enterarse de cuál de las tres es. */
      const malo = () => res.status(401).json({ error: 'client_id o secreto incorrectos' });
      if (!c || c.revocado_at) { await bcrypt.compare(sec, '$2a$10$' + 'x'.repeat(53)).catch(() => {}); return malo(); }
      if (!(await bcrypt.compare(sec, c.secreto_hash))) return malo();
      const token = jwt.sign({ scope: 'service', cid: c.client_id, alc: c.alcances || [] }, SECRET, { expiresIn: VIDA_TOKEN_S });
      olvidar(c.client_id);
      log.info('token de servicio emitido', { cliente: c.client_id });
      res.json({ token, tipo: 'Bearer', expira_en: VIDA_TOKEN_S, alcances: c.alcances || [] });
    } catch (e) { errorHttp(res, e); }
  });

  /* ── Administración (panel, sólo admin por el RBAC) ───────────────────────────
   * El secreto se devuelve UNA vez, al crear y al rotar. No hay forma de volver a verlo:
   * si se pierde, se rota. Es la misma regla que el PIN del buzón desde 1.11.0. */
  app.get('/api/api-clients', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT client_id, nombre, alcances, notas, creado_at, creado_por, revocado_at, usado_at, usado_ip FROM pbxng_api_clients ORDER BY usado_at DESC NULLS LAST, creado_at DESC');
      res.json(rows);
    } catch (e) { errorHttp(res, e); }
  });

  app.get('/api/api-clients/alcances', auth, (req, res) => res.json(ALCANCES));

  app.post('/api/api-clients', auth, async (req, res) => {
    const b = req.body || {};
    const id = limpiarId(b.client_id);
    if (!id) return res.status(400).json({ error: 'client_id inválido: minúsculas, números, punto, guion y guion bajo; entre 3 y 64' });
    if (!String(b.nombre || '').trim()) return res.status(400).json({ error: 'poné un nombre que diga quién es (aparece en las bitácoras)' });
    const al = limpiarAlcances(b.alcances);
    if (al.error) return res.status(400).json({ error: al.error, alcances_validos: ALCANCES_VALIDOS });
    if (!al.alcances.length) return res.status(400).json({ error: 'una credencial sin alcances no sirve para nada: elegí al menos uno' });
    try {
      const sec = generarSecreto();
      const hash = await bcrypt.hash(sec, 10);
      await pool.query(
        'INSERT INTO pbxng_api_clients (client_id, nombre, secreto_hash, alcances, notas, creado_por) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, String(b.nombre).trim().slice(0, 120), hash, al.alcances, String(b.notas || '').slice(0, 500), (req.user && req.user.username) || null]);
      olvidar(id);
      log.info('cliente de API creado', { cliente: id, alcances: al.alcances, por: (req.user || {}).username });
      res.status(201).json({ client_id: id, secreto: sec, alcances: al.alcances, aviso: 'Guardá el secreto ahora: no se puede volver a ver. Si se pierde, se rota.' });
    } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/api-clients/:id', auth, async (req, res) => {
    const id = limpiarId(req.params.id);
    if (!id) return res.status(400).json({ error: 'client_id inválido' });
    const b = req.body || {};
    const al = b.alcances === undefined ? null : limpiarAlcances(b.alcances);
    if (al && al.error) return res.status(400).json({ error: al.error, alcances_validos: ALCANCES_VALIDOS });
    if (al && !al.alcances.length) return res.status(400).json({ error: 'una credencial sin alcances no sirve para nada' });
    try {
      const { rowCount } = await pool.query(
        'UPDATE pbxng_api_clients SET nombre=COALESCE($2,nombre), alcances=COALESCE($3,alcances), notas=COALESCE($4,notas) WHERE client_id=$1',
        [id, b.nombre ? String(b.nombre).trim().slice(0, 120) : null, al ? al.alcances : null, b.notas === undefined ? null : String(b.notas).slice(0, 500)]);
      if (!rowCount) return res.status(404).json({ error: 'no existe ese cliente de API' });
      olvidar(id);
      res.json({ updated: id });
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/api-clients/:id/rotar', auth, async (req, res) => {
    const id = limpiarId(req.params.id);
    if (!id) return res.status(400).json({ error: 'client_id inválido' });
    try {
      const sec = generarSecreto();
      const hash = await bcrypt.hash(sec, 10);
      /* Rotar REVIVE una credencial revocada a propósito: es el camino de «se filtró el
       * secreto, cortame ya y dame uno nuevo» sin tener que recrear el cliente y perder
       * su historial. Los tokens viejos siguen sin servir: se verifican contra la tabla y
       * el hash ya no es el mismo. */
      const { rowCount } = await pool.query('UPDATE pbxng_api_clients SET secreto_hash=$2, revocado_at=NULL WHERE client_id=$1', [id, hash]);
      if (!rowCount) return res.status(404).json({ error: 'no existe ese cliente de API' });
      olvidar(id);
      log.warn('secreto rotado', { cliente: id, por: (req.user || {}).username });
      res.json({ client_id: id, secreto: sec, aviso: 'Guardá el secreto ahora: no se puede volver a ver. El anterior dejó de servir.' });
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/api-clients/:id/revocar', auth, async (req, res) => {
    const id = limpiarId(req.params.id);
    if (!id) return res.status(400).json({ error: 'client_id inválido' });
    try {
      const { rowCount } = await pool.query('UPDATE pbxng_api_clients SET revocado_at=now() WHERE client_id=$1 AND revocado_at IS NULL', [id]);
      olvidar(id);
      if (!rowCount) return res.status(404).json({ error: 'no existe, o ya estaba revocado' });
      log.warn('credencial revocada', { cliente: id, por: (req.user || {}).username });
      /* El aviso dice el retraso REAL, que es la caché de arriba: prometer «inmediato» y
       * que un pedido entre 3 s después es la clase de mentira que se paga en una
       * auditoría de seguridad. */
      res.json({ revoked: id, aviso: 'Los pedidos en curso pueden entrar hasta ' + (CACHE_MS / 1000) + ' segundos más.' });
    } catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/api-clients/:id', auth, async (req, res) => {
    const id = limpiarId(req.params.id);
    if (!id) return res.status(400).json({ error: 'client_id inválido' });
    try {
      const { rowCount } = await pool.query('DELETE FROM pbxng_api_clients WHERE client_id=$1', [id]);
      olvidar(id);
      if (!rowCount) return res.status(404).json({ error: 'no existe ese cliente de API' });
      res.json({ deleted: id });
    } catch (e) { errorHttp(res, e); }
  });

  return { authServicio, exigirAlcance, ALCANCES, ALCANCES_VALIDOS, CACHE_MS, VIDA_TOKEN_S, _olvidar: olvidar };
};
module.exports.ALCANCES = ALCANCES;
