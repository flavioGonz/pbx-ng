'use strict';
/* ============================================================================
 *  PBX-NG · `/api/v1` — el contrato PÚBLICO, el que se entrega a un tercero.
 *
 *  POR QUÉ EXISTE, Y POR QUÉ NO ES «/api con un prefijo»
 *  ------------------------------------------------------
 *  Las 346 rutas de `/api` son la API PRIVADA de nuestro panel: nacieron con él, cambian
 *  con él, y eso está bien porque los dos se despliegan juntos. El backoffice del cliente
 *  no se despliega con nosotros: si le movemos un campo, se le rompe en producción un
 *  martes a las tres de la tarde y no hay forma de coordinar.
 *
 *  Así que `/api/v1` NO es un alias de `/api`. Es un subconjunto chico y CONGELADO, con
 *  su propia credencial (de sistema, no de persona), su propia forma de respuesta y su
 *  propia política de cambios. Que sean pocas rutas es la característica, no una etapa.
 *
 *  POLÍTICA DE COMPATIBILIDAD (una línea, para que el equipo externo la pueda citar)
 *  --------------------------------------------------------------------------------
 *  **Dentro de `v1` sólo se AGREGAN campos opcionales y rutas nuevas. Quitar o renombrar
 *  un campo, cambiar su tipo o su significado, o endurecer una validación, es `v2`, y las
 *  dos versiones conviven por 12 meses.**
 *
 *  Consecuencia para quien consume: **ignorá los campos que no conocés**. Un cliente que
 *  se rompe porque apareció un campo nuevo no es un cambio incompatible nuestro: es un
 *  cliente mal escrito, y está dicho acá para que no haya discusión después.
 *
 *  FORMA DE LAS RESPUESTAS
 *  -----------------------
 *  Toda lista devuelve un SOBRE, nunca un arreglo pelado:
 *      { items: [...], next_cursor: "…"|null, tope_aplicado: 200, truncado: false }
 *  Tres razones, todas aprendidas de `/api`:
 *    · un arreglo pelado no tiene dónde crecer (agregar paginación después es incompatible);
 *    · `tope_aplicado` + `truncado` hacen que un recorte NUNCA sea silencioso — hoy
 *      `/api/cdr` corta en 500 filas y el que pregunta no se entera, que es cómo se
 *      construye un reporte al que le faltan llamadas y nadie lo nota;
 *    · un arreglo de nivel superior en JSON es un problema de seguridad viejo pero real.
 *
 *  Y los errores son siempre `{ error, detalle? }` con el status HTTP correcto. Un `200`
 *  con `{error}` adentro no es un error: es una respuesta buena que miente.
 *
 *  QUÉ HAY ACÁ Y QUÉ NO (todavía)
 *  ------------------------------
 *  Esta primera tanda cubre LEER: historial, grabaciones, llamadas en curso e internos.
 *  Ordenar llamadas (originar/transferir/colgar) entra con su idempotencia —ya está el
 *  middleware— y los EVENTOS salientes son la otra mitad del contrato, que vive en el
 *  outbox. Lo que no está, no está: se prefiere una v1 chica y cumplida a una grande y
 *  parcial.
 * ==========================================================================*/
const express = require('express');
const crypto = require('crypto');

const TOPE_DEF = 100;
const TOPE_MAX = 500;
const RANGO_MAX_DIAS = 92;          /* Un trimestre. Sin tope, un `from=2020-01-01` barre la
                                     * tabla entera y se lleva puesta una conexión del pool;
                                     * con tope, el que quiere un año hace cuatro pedidos. */
const IDEM_HORAS = 24;

module.exports = function init(deps) {
  const { pool, authServicio, exigirAlcance, errorHttp, logger, getChannels, endpointStates } = deps;
  const log = logger('v1');
  const router = express.Router();

  /* ── Utilidades del sobre ─────────────────────────────────────────────────── */
  function tope(req) {
    const n = parseInt(req.query.limite || req.query.limit, 10);
    if (!Number.isFinite(n) || n <= 0) return TOPE_DEF;
    return Math.min(n, TOPE_MAX);
  }
  const sobre = (items, next, lim) => ({ items, next_cursor: next || null, tope_aplicado: lim, truncado: items.length >= lim });

  /* El cursor es opaco por fuera y trivial por dentro: base64url de `<iso>|<leg_id>`. Va
   * sobre (start, uniqueid) y no sobre un OFFSET porque el CDR crece por la punta: con
   * OFFSET, una llamada nueva entre dos pedidos corre todas las filas y el que pagina se
   * saltea una. El par es único aunque dos llamadas compartan el mismo `start`. */
  function leerCursor(v) {
    if (!v) return null;
    try {
      const s = Buffer.from(String(v), 'base64url').toString('utf8');
      const i = s.lastIndexOf('|');
      if (i < 0) return null;
      const t = new Date(s.slice(0, i));
      if (isNaN(t.getTime())) return null;
      return { start: s.slice(0, i), leg: s.slice(i + 1) };
    } catch (_) { return null; }
  }
  /* `cdr.start` es `timestamp` SIN zona: guarda la hora de la central tal cual, y node-pg
   * la lee como hora local. El cursor tiene que volver a la base en esa MISMA hora de
   * pared: con toISOString() viajaba en UTC (+3 h en Montevideo), el `::timestamp` le
   * tiraba la zona y la comparación quedaba corrida tres horas — repetía o salteaba. */
  const pared = (d) => {
    const n = (x, k = 2) => String(x).padStart(k, '0');
    return d.getFullYear() + '-' + n(d.getMonth() + 1) + '-' + n(d.getDate()) + 'T'
      + n(d.getHours()) + ':' + n(d.getMinutes()) + ':' + n(d.getSeconds()) + '.' + n(d.getMilliseconds(), 3);
  };
  const armarCursor = (fila) => (fila && fila.start
    ? Buffer.from(pared(new Date(fila.start)) + '|' + String(fila.leg_id || ''), 'utf8').toString('base64url')
    : null);

  function rango(req) {
    const hoy = Date.now();
    const hasta = req.query.hasta || req.query.to;
    const desde = req.query.desde || req.query.from;
    const fh = hasta ? new Date(String(hasta)) : new Date(hoy);
    const fd = desde ? new Date(String(desde)) : new Date(fh.getTime() - 7 * 86400000);
    if (isNaN(fd.getTime()) || isNaN(fh.getTime())) return { error: 'fechas inválidas: usá ISO 8601 (2026-09-01T00:00:00Z)' };
    if (fd > fh) return { error: 'el desde es posterior al hasta' };
    const dias = (fh - fd) / 86400000;
    if (dias > RANGO_MAX_DIAS) {
      return { error: 'el rango pedido es de ' + Math.round(dias) + ' días y el máximo es ' + RANGO_MAX_DIAS + '. Pedí de a tramos usando next_cursor.' };
    }
    return { desde: fd, hasta: fh };
  }

  /* ── Idempotencia (B5) ────────────────────────────────────────────────────────
   * Middleware, no un parche por ruta: si fuera por ruta, la ruta 8 se iba a olvidar.
   *
   * Lo que resuelve: el backoffice manda `POST /llamadas/originar`, la llamada SALE, y en
   * ese momento se le corta la red antes de recibir la respuesta. Reintentar es lo único
   * razonable que puede hacer — y sin esto, reintentar llama dos veces al mismo cliente.
   *
   * Con `Idempotency-Key`, el segundo pedido devuelve la MISMA respuesta que el primero.
   * La huella del cuerpo se guarda y se compara: la misma clave con otro cuerpo es un bug
   * del que llama y se contesta 409, porque contestarle la respuesta vieja a un pedido
   * distinto sería peor que fallar. */
  function idempotente(req, res, next) {
    const clave = String(req.headers['idempotency-key'] || '').trim();
    if (!clave) return next();
    if (clave.length > 200) return res.status(400).json({ error: 'Idempotency-Key demasiado larga (máximo 200)' });
    const cuerpo = JSON.stringify(req.body || {});
    const huella = crypto.createHash('sha256').update(req.method + ' ' + req.originalUrl + ' ' + cuerpo).digest('hex');
    const cid = req.cliente.id;
    pool.query('SELECT huella, estado, cuerpo FROM pbxng_idempotencia WHERE client_id=$1 AND clave=$2', [cid, clave])
      .then(({ rows }) => {
        const prev = rows[0];
        if (prev) {
          if (prev.huella !== huella) {
            return res.status(409).json({ error: 'esa Idempotency-Key ya se usó con otro cuerpo: usá una clave nueva' });
          }
          if (prev.estado == null) {
            /* El primer pedido todavía está corriendo. 409 y no 202: el que llama tiene
             * que reintentar en un momento, no asumir que quedó encolado. */
            return res.status(409).json({ error: 'ese pedido está en curso, reintentá en unos segundos' });
          }
          res.set('Idempotent-Replay', 'true');
          return res.status(prev.estado).json(prev.cuerpo);
        }
        /* Se reserva la clave ANTES de hacer nada: dos reintentos simultáneos chocan acá
         * (la PK es (client_id, clave)) y sólo uno pasa a ejecutar. */
        return pool.query('INSERT INTO pbxng_idempotencia (client_id, clave, huella) VALUES ($1,$2,$3)', [cid, clave, huella])
          .then(() => {
            /* Se intercepta `res.json` para guardar lo que efectivamente se respondió.
             *
             * EL GUARDADO VA ANTES DE CONTESTAR, y eso importa. Antes se disparaba el
             * UPDATE sin esperarlo y se contestaba en el mismo tick: el cliente ya tenía
             * la respuesta en la mano mientras la fila seguía con `estado = NULL`. El
             * reintento —que es LA razón de ser de esto: el backoffice manda originar, se
             * le corta la conexión y vuelve a mandar— leía ese NULL y se comía un
             * «ese pedido está en curso» por un pedido que ya había terminado. Encima
             * dejaba la clave quemada: 409 para siempre, sin poder recuperar la respuesta.
             *
             * Se demora el envío hasta que el UPDATE resuelve (o falla: ahí igual se
             * contesta, perder la idempotencia es mejor que no contestarle al cliente).
             * Nadie depende de que el cuerpo salga en el mismo tick; los handlers hacen
             * `return res.json(...)` y se devuelve `res` para no romper el encadenado. */
            const json = res.json.bind(res);
            res.json = (cuerpoResp) => {
              pool.query('UPDATE pbxng_idempotencia SET estado=$3, cuerpo=$4 WHERE client_id=$1 AND clave=$2',
                [cid, clave, res.statusCode, JSON.stringify(cuerpoResp)])
                .catch((e) => log.error('idempotencia: no se pudo guardar la respuesta', e))
                .finally(() => json(cuerpoResp));
              return res;
            };
            next();
          })
          .catch((e) => {
            if (e && e.code === '23505') return res.status(409).json({ error: 'ese pedido está en curso, reintentá en unos segundos' });
            throw e;
          });
      })
      .catch((e) => errorHttp(res, e));
  }

  /* Poda de las claves vencidas. Barata (hay índice por fecha) y silenciosa. */
  setInterval(() => {
    pool.query("DELETE FROM pbxng_idempotencia WHERE creado_at < now() - interval '" + IDEM_HORAS + " hours'")
      .catch((e) => log.debug('poda de idempotencia', e));
  }, 3600000).unref();

  /* ── De acá para abajo, TODO exige credencial de sistema ─────────────────────── */
  router.use(authServicio);

  /* Quién soy y qué puedo: lo primero que va a pegar el equipo externo, y lo que le
   * evita adivinar por qué le dan 403. */
  router.get('/yo', (req, res) => res.json({
    client_id: req.cliente.id, nombre: req.cliente.nombre, alcances: req.cliente.alcances,
    version: 'v1', politica: 'dentro de v1 sólo se agregan campos opcionales y rutas nuevas; un cambio incompatible es v2 y conviven 12 meses',
  }));

  const CAMPOS = "linkedid AS call_id, uniqueid AS leg_id, start, clid, src, dst, dcontext, duration, billsec, disposition, channel, dstchannel";

  /* ── Historial ────────────────────────────────────────────────────────────────
   * Paginado con cursor y con el tope SIEMPRE dicho en la respuesta. */
  router.get('/cdr', exigirAlcance('cdr:leer'), async (req, res) => {
    const lim = tope(req);
    const r = rango(req);
    if (r.error) return res.status(400).json({ error: r.error });
    const cur = leerCursor(req.query.cursor);
    if (req.query.cursor && !cur) return res.status(400).json({ error: 'cursor inválido: usá tal cual el next_cursor de la respuesta anterior' });
    const cond = ['start >= $1', 'start <= $2'];
    const args = [r.desde, r.hasta];
    if (req.query.interno) { args.push(String(req.query.interno)); cond.push('(src = $' + args.length + ' OR dst = $' + args.length + ')'); }
    if (cur) {
      args.push(cur.start, cur.leg);
      cond.push('(start, uniqueid) < ($' + (args.length - 1) + '::timestamp, $' + args.length + ')');
    }
    args.push(lim);
    try {
      const { rows } = await pool.query(
        'SELECT ' + CAMPOS + ' FROM cdr WHERE ' + cond.join(' AND ') + ' ORDER BY start DESC, uniqueid DESC LIMIT $' + args.length, args);
      res.json(sobre(rows, rows.length === lim ? armarCursor(rows[rows.length - 1]) : null, lim));
    } catch (e) { errorHttp(res, e); }
  });

  /* Todos los tramos de UNA llamada. Es la ruta que hace útil a `call_id`: el backoffice
   * guarda ese valor con su ticket y después pide la llamada entera sin adivinar por
   * número y hora. */
  router.get('/cdr/:call_id', exigirAlcance('cdr:leer'), async (req, res) => {
    const id = String(req.params.call_id || '').slice(0, 150);
    if (!id) return res.status(400).json({ error: 'falta call_id' });
    try {
      const { rows } = await pool.query('SELECT ' + CAMPOS + ' FROM cdr WHERE linkedid = $1 ORDER BY start ASC, uniqueid ASC LIMIT 200', [id]);
      if (!rows.length) return res.status(404).json({ error: 'no hay ninguna llamada con ese call_id' });
      res.json({ call_id: id, tramos: rows });
    } catch (e) { errorHttp(res, e); }
  });

  /* ── Grabaciones ──────────────────────────────────────────────────────────────
   * Metadatos, no audio. La descarga va aparte porque necesita enlace firmado de corta
   * vida (para que el backoffice pueda embeberlo sin repartir su credencial), y eso se
   * diseña con el outbox. */
  router.get('/grabaciones', exigirAlcance('grabaciones:leer'), async (req, res) => {
    const lim = tope(req);
    const r = rango(req);
    if (r.error) return res.status(400).json({ error: r.error });
    const args = [r.desde, r.hasta];
    let cond = 'deleted = false AND started_at >= $1 AND started_at <= $2';
    if (req.query.call_id) { args.push(String(req.query.call_id).slice(0, 150)); cond += ' AND linkedid = $' + args.length; }
    args.push(lim);
    try {
      const { rows } = await pool.query(
        'SELECT id, linkedid AS call_id, ext, src, dst, started_at, duration, bytes, storage FROM pbxng_recordings WHERE ' + cond
        + ' ORDER BY started_at DESC NULLS LAST, id DESC LIMIT $' + args.length, args);
      res.json(sobre(rows, null, lim));
    } catch (e) { errorHttp(res, e); }
  });

  /* ── Llamadas en curso ────────────────────────────────────────────────────────
   * Sin ARI esto NO es una lista vacía: es «no lo sé». Devolver `[]` cuando la central
   * está muda haría que el backoffice muestre «no hay llamadas» durante una caída, que es
   * la peor mentira posible en un tablero de operación. */
  router.get('/llamadas', exigirAlcance('llamadas:ver'), async (req, res) => {
    try {
      const ch = await getChannels();
      res.json({ items: ch, tope_aplicado: ch.length, truncado: false, next_cursor: null });
    } catch (e) {
      log.warn('llamadas en curso: la central no contesta', e);
      res.status(503).json({ error: 'la central no está respondiendo: no se puede saber qué llamadas hay en curso' });
    }
  });

  /* ── Internos ─────────────────────────────────────────────────────────────── */
  router.get('/internos', exigirAlcance('internos:ver'), async (req, res) => {
    try {
      const est = await endpointStates();
      const { rows } = await pool.query(
        "SELECT e.id AS interno, COALESCE(d.name,'') AS nombre FROM ps_endpoints e LEFT JOIN pbxng_directory d ON d.ext = e.id"
        + " WHERE COALESCE(e.pbxng_kind,'extension') = 'extension' ORDER BY e.id");
      const items = rows.map((r) => ({
        interno: r.interno, nombre: r.nombre || null,
        estado: (est && est[r.interno] && est[r.interno].state) || 'offline',
        canales: (est && est[r.interno] && est[r.interno].channels) || 0,
      }));
      res.json({ items, tope_aplicado: items.length, truncado: false, next_cursor: null });
    } catch (e) { errorHttp(res, e); }
  });

  /* ── Ordenar una llamada ──────────────────────────────────────────────────────
   * La primera ruta de ESCRITURA del contrato, y por eso la que estrena la
   * idempotencia. El caso real que resuelve: el backoffice manda originar, la llamada
   * SALE, y justo ahí se le corta la red antes de recibir la respuesta. Reintentar es lo
   * único razonable que puede hacer — y sin `Idempotency-Key`, reintentar llama dos veces
   * al mismo cliente. Con la clave, el segundo pedido devuelve la MISMA respuesta.
   *
   * La cabecera no es obligatoria a propósito: obligarla rompería a un consumidor que
   * recién arranca, y el que no la manda simplemente no tiene la red. El contrato dice
   * que para escrituras conviene mandarla siempre. */
  router.post('/llamadas/originar', exigirAlcance('llamadas:ordenar'), idempotente, async (req, res) => {
    const b = req.body || {};
    const desde = String(b.desde || b.from || '').trim();
    const hacia = String(b.hacia || b.to || '').trim();
    if (!desde || !hacia) return res.status(400).json({ error: 'desde (interno que llama) y hacia (destino) son obligatorios' });
    if (!/^[0-9*#+]{1,32}$/.test(hacia)) return res.status(400).json({ error: 'el destino sólo puede tener dígitos, * , # y +' });
    try {
      const r = await deps.originar({ from: desde, to: hacia, context: b.contexto });
      log.info('llamada originada por el contrato', { cliente: req.cliente.id, desde, hacia });
      res.status(202).json({ aceptado: true, canal: r.channel, desde, hacia });
    } catch (e) {
      /* 503 cuando la central no está: es distinto de «pediste mal», y el backoffice
       * tiene que poder reintentar sin cambiar nada. */
      if (e && e.status === 503) return res.status(503).json({ error: 'la central no está disponible en este momento' });
      if (e && e.status === 400) return res.status(400).json({ error: e.message });
      errorHttp(res, e);
    }
  });

  /* El 404 va ÚLTIMO, y por eso se registra desde afuera: otros módulos (el outbox, con
   * `/eventos`) cuelgan rutas de este mismo router después de que init() vuelve, y un
   * `router.use` catch-all registrado acá se las comería a todas sin un solo error
   * visible —la ruta existiría y contestaría «esa ruta no existe»—. `app.js` llama a
   * `cerrar()` cuando ya no queda nadie por montar. */
  function cerrar() {
    router.use((req, res) => res.status(404).json({
      error: 'esa ruta no existe en /api/v1',
      detalle: 'v1 es un subconjunto chico y congelado, no un espejo de /api. Ver docs/CONTRATOS.md §3.2.',
    }));
  }

  return { router, idempotente, cerrar, TOPE_MAX, RANGO_MAX_DIAS };
};
