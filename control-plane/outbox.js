'use strict';
/* ============================================================================
 *  PBX-NG · Outbox de eventos salientes — «la central avisa».
 *
 *  POR QUÉ EXISTE
 *  --------------
 *  PBX-NG tenía TODO lo necesario para saber qué pasa —ARI da los eventos de canal, el AMI
 *  da `DialBegin`/`DialEnd` con su `dialstatus`, el indexador sabe cuándo quedó lista una
 *  grabación— y NADA para contarlo afuera: cero eventos de negocio salientes. El backoffice
 *  sólo podía preguntar, y preguntar cada dos segundos por si sonó un teléfono no es una
 *  integración: es una encuesta que llega tarde y cuesta una conexión del pool por vuelta.
 *
 *  POR QUÉ UNA TABLA Y NO UN POST DIRECTO
 *  --------------------------------------
 *  Porque el POST se pierde. Si el destino está caído, si el certificado venció, si hay
 *  cinco segundos de red mala justo cuando terminó la llamada, un `fetch` suelto se traga
 *  el evento y nadie se entera nunca. El patrón de outbox es viejo y aburrido justamente
 *  porque funciona: **se escribe primero, se entrega después**, y mientras no haya acuse
 *  sigue ahí.
 *
 *  LAS TRES REGLAS QUE ESTE ARCHIVO CUMPLE, Y POR QUÉ
 *  --------------------------------------------------
 *  1. **El camino de la llamada no toca la base.** `emitir()` encola en memoria y vuelve;
 *     un temporizador vuelca de a lotes en un INSERT multi-fila. Un evento NUNCA espera a
 *     Postgres, porque quien lo emite es el manejador de un evento de AMI que está corriendo
 *     mientras la llamada pasa.
 *  2. **El orden que se promete es POR LLAMADA, no global.** `secuencia` es creciente y la
 *     entrega va en ese orden por destino, así que los eventos de UNA llamada llegan en
 *     orden. Prometer orden global obligaría a una sola entrega a la vez para toda la
 *     central: con 30 llamadas en curso, el destino se queda atrás y no alcanza nunca.
 *  3. **Nada de dedup por `Map` que se vacía solo.** El repo tiene tres (`pushDedup`,
 *     `missedDedup`, `incomingPushDedup`) que hacen `clear()` al pasar el tope: borran la
 *     memoria de TODAS las llamadas, no las entradas viejas, así que con la central llena
 *     vuelven a disparar lo ya disparado. Acá la unicidad la garantiza Postgres
 *     (`evento_id` único) y el debounce que sí hay (registros de internos) expira POR
 *     ENTRADA.
 *
 *  ENTREGA: DOS MODOS
 *  ------------------
 *  · **push**: POST al `url` de la suscripción, firmado con HMAC-SHA256 para que el que
 *    recibe pueda comprobar que salió de esta central y no de cualquiera que sepa la URL.
 *  · **pull**: una suscripción SIN `url` es «el backoffice viene a buscar»
 *    (`GET /api/v1/eventos` + acuse). Es el modo que salva a la mitad de los clientes
 *    reales, que están detrás de un NAT corporativo y no pueden exponer un webhook.
 *
 *  El avance se guarda como **cursor por destino** (última `secuencia` con acuse), no como
 *  un flag por evento: así no hay forma de que una fila quede «en vuelo» para siempre si el
 *  proceso se muere en el medio, y agregar un segundo consumidor no toca a los eventos.
 * ==========================================================================*/
const crypto = require('crypto');

/* ── Catálogo cerrado. Siete tipos, y la versión es POR TIPO ──────────────────────
 * Por tipo y no global porque el día que `llamada.terminada` gane un campo obligatorio,
 * eso no tiene por qué obligar a nadie a revisar `grabacion.lista`. */
const CATALOGO = {
  'llamada.entrante':    { version: 1, desc: 'empezó a timbrar un interno' },
  'llamada.contestada':  { version: 1, desc: 'alguien atendió' },
  'llamada.terminada':   { version: 1, desc: 'la llamada terminó (con su duración y resultado)' },
  'llamada.transferida': { version: 1, desc: 'la llamada cambió de destino' },
  'grabacion.lista':     { version: 1, desc: 'el archivo de la grabación ya se puede pedir' },
  'interno.registrado':  { version: 1, desc: 'un teléfono apareció o desapareció (con debounce)' },
  'seguridad.ataque':    { version: 1, desc: 'el SOC bloqueó una IP (agregado)' },
};
const TIPOS = Object.keys(CATALOGO);

const VOLCADO_MS = 250;          // cada cuánto se vuelca la cola en memoria a la base
const TOPE_MEMORIA = 5000;       /* Si Postgres no está, la cola crece. A las 5000 se
                                  * descarta lo MÁS VIEJO y se avisa una vez: perder los
                                  * eventos de hace diez minutos es malo, quedarse sin
                                  * memoria y llevarse la central puesta es peor. */
const LOTE_ENTREGA = 100;        // eventos por POST
const TOPE_INTENTOS = 12;        // ~2 h con el backoff de abajo, y después avisa
const RETENCION_DIAS = 7;

/* Backoff: 5 s, 10, 20, 40… con techo de 10 min. Un destino que volvió no espera 10
 * minutos: al primer 2xx los intentos se ponen en cero. */
const espera = (intentos) => Math.min(600, 5 * Math.pow(2, Math.max(0, intentos - 1)));

module.exports = function init(deps) {
  const { pool, logger, alerts, app, auth, errorHttp, authServicio, exigirAlcance } = deps;
  const log = logger('outbox');

  let cola = [];
  let descartados = 0;
  let avisadoDescarte = false;
  let corriendo = false;

  /* ── Producción ───────────────────────────────────────────────────────────────
   * Sincrónica y sin promesas a propósito: la llaman manejadores de eventos de AMI. */
  function emitir(tipo, ev) {
    const c = CATALOGO[tipo];
    if (!c) { log.error('tipo de evento desconocido: ' + tipo); return null; }
    const e = {
      evento_id: crypto.randomUUID(),
      tipo, version: c.version,
      ts: new Date(),
      call_id: (ev && ev.call_id) ? String(ev.call_id).slice(0, 150) : null,
      leg_id: (ev && ev.leg_id) ? String(ev.leg_id).slice(0, 150) : null,
      datos: (ev && ev.datos) || {},
    };
    cola.push(e);
    if (cola.length > TOPE_MEMORIA) {
      const sobran = cola.length - TOPE_MEMORIA;
      cola.splice(0, sobran);
      descartados += sobran;
      if (!avisadoDescarte) {
        avisadoDescarte = true;
        log.error('la cola de eventos llegó al tope: se descartan los más viejos', { tope: TOPE_MEMORIA });
        if (alerts && alerts.raise) alerts.raise('outbox.saturado', { tope: TOPE_MEMORIA }).catch(() => {});
      }
    }
    return e.evento_id;
  }

  async function volcar() {
    if (!cola.length) return;
    const lote = cola;
    cola = [];
    /* Un solo INSERT multi-fila para todo el lote: con una llamada activa esto puede ser
     * media docena de eventos en el mismo cuarto de segundo, y seis INSERT son seis idas
     * a la base por algo que no las necesita. */
    const sql = 'INSERT INTO pbxng_eventos_salida (evento_id, tipo, version, ts, call_id, leg_id, datos) VALUES '
      + lote.map((e, i) => {
        const b = i * 7;
        return '($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ',$' + (b + 6) + ',$' + (b + 7) + '::jsonb)';
      }).join(',')
      + ' ON CONFLICT (evento_id) DO NOTHING';
    const args = [];
    for (const e of lote) args.push(e.evento_id, e.tipo, e.version, e.ts, e.call_id, e.leg_id, JSON.stringify(e.datos || {}));
    try {
      await pool.query(sql, args);
      if (descartados) { log.warn('se descartaron eventos por saturación', { descartados }); descartados = 0; avisadoDescarte = false; }
    } catch (e) {
      /* Se devuelven a la cola: el próximo volcado los reintenta. Si Postgres no vuelve,
       * el tope de memoria decide, que es el comportamiento que queremos y está dicho. */
      cola = lote.concat(cola);
      log.error('no se pudo volcar el lote de eventos', e);
    }
  }

  /* ── Entrega ──────────────────────────────────────────────────────────────────
   * Una vuelta por suscripción activa que esté en hora. Concurrencia 1 por destino: el
   * `corriendo` de arriba evita que dos vueltas se pisen, y dentro se recorre de a uno. */
  function firmar(secreto, cuerpo) {
    return 'sha256=' + crypto.createHmac('sha256', String(secreto || '')).update(cuerpo).digest('hex');
  }

  async function entregarUna(sub) {
    const { rows } = await pool.query(
      'SELECT secuencia, evento_id, tipo, version, ts, call_id, leg_id, datos FROM pbxng_eventos_salida'
      + ' WHERE secuencia > $1 AND ($2::text[] = \'{}\' OR tipo = ANY($2)) ORDER BY secuencia ASC LIMIT ' + LOTE_ENTREGA,
      [sub.cursor, sub.tipos || []]);
    if (!rows.length) return;
    const cuerpo = JSON.stringify({ central: deps.nombreCentral || '', eventos: rows });
    const hasta = rows[rows.length - 1].secuencia;
    try {
      const r = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PBXNG-Firma': firmar(sub.secreto, cuerpo),
          'X-PBXNG-Eventos': String(rows.length),
        },
        body: cuerpo,
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error('el destino respondió ' + r.status);
      await pool.query('UPDATE pbxng_suscripciones SET cursor=$2, intentos=0, ultimo_error=NULL, ultimo_ok_at=now(), proximo_at=NULL WHERE id=$1', [sub.id, hasta]);
      log.debug('entregados', { sub: sub.nombre, n: rows.length, hasta });
    } catch (e) {
      const intentos = (sub.intentos || 0) + 1;
      const s = espera(intentos);
      await pool.query("UPDATE pbxng_suscripciones SET intentos=$2, ultimo_error=$3, proximo_at=now() + ($4 || ' seconds')::interval WHERE id=$1",
        [sub.id, intentos, String((e && e.message) || e).slice(0, 300), String(s)]);
      /* El aviso llega UNA vez, al cruzar el tope: el modo de falla de una integración es
       * silencioso y diferido —los eventos se acumulan, el worker reintenta, el log escupe
       * y nadie mira el log—, así que al cruzarlo tiene que sonar el mismo timbre que usa
       * el resto del producto. */
      if (intentos === TOPE_INTENTOS) {
        log.error('la integración lleva ' + intentos + ' intentos fallidos', { sub: sub.nombre, error: String((e && e.message) || e) });
        if (alerts && alerts.raise) alerts.raise('outbox.destino_caido', { suscripcion: sub.nombre, intentos, error: String((e && e.message) || e) }).catch(() => {});
      }
    }
  }

  async function vuelta() {
    if (corriendo) return;
    corriendo = true;
    try {
      await volcar();
      const { rows } = await pool.query(
        "SELECT id, nombre, url, secreto, tipos, cursor, intentos FROM pbxng_suscripciones"
        + " WHERE activa AND url IS NOT NULL AND url <> '' AND (proximo_at IS NULL OR proximo_at <= now()) ORDER BY id");
      for (const sub of rows) await entregarUna(sub);
    } catch (e) {
      log.error('vuelta del outbox', e);
    } finally { corriendo = false; }
  }

  /* Poda: se borra lo entregado a TODOS los destinos activos y lo más viejo que la
   * retención. El `min(cursor)` es la parte importante: sin eso, una suscripción caída
   * pierde eventos que todavía no vio. */
  async function podar() {
    try {
      const { rows } = await pool.query("SELECT COALESCE(MIN(cursor), 0) AS piso, count(*)::int AS n FROM pbxng_suscripciones WHERE activa");
      const piso = rows[0] && rows[0].n ? rows[0].piso : null;
      if (piso === null) {
        await pool.query("DELETE FROM pbxng_eventos_salida WHERE ts < now() - interval '" + RETENCION_DIAS + " days'");
        return;
      }
      const r = await pool.query("DELETE FROM pbxng_eventos_salida WHERE secuencia <= $1 AND ts < now() - interval '" + RETENCION_DIAS + " days'", [piso]);
      if (r.rowCount) log.debug('podados', { eventos: r.rowCount });
    } catch (e) { log.debug('poda del outbox', e); }
  }

  const tVuelta = setInterval(vuelta, 1000); tVuelta.unref();
  const tVolcado = setInterval(volcar, VOLCADO_MS); tVolcado.unref();
  const tPoda = setInterval(podar, 3600000); tPoda.unref();

  /* ── Administración de suscripciones (panel, sólo admin por el RBAC) ──────────── */
  app.get('/api/eventos/catalogo', auth, (req, res) => res.json(CATALOGO));

  app.get('/api/eventos/suscripciones', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, nombre, client_id, url, tipos, activa, cursor, intentos, ultimo_error, ultimo_ok_at, proximo_at, creada_at,'
        + " (secreto IS NOT NULL AND secreto <> '') AS tiene_secreto FROM pbxng_suscripciones ORDER BY id");
      const { rows: pend } = await pool.query('SELECT COALESCE(MAX(secuencia),0) AS ultima FROM pbxng_eventos_salida');
      res.json({ suscripciones: rows.map((s) => ({ ...s, pendientes: Math.max(0, Number(pend[0].ultima) - Number(s.cursor)) })), ultima_secuencia: Number(pend[0].ultima) });
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/eventos/suscripciones', auth, async (req, res) => {
    const b = req.body || {};
    if (!String(b.nombre || '').trim()) return res.status(400).json({ error: 'poné un nombre que diga quién recibe' });
    const tipos = Array.isArray(b.tipos) ? b.tipos.filter((t) => TIPOS.includes(t)) : [];
    if (Array.isArray(b.tipos) && tipos.length !== b.tipos.length) return res.status(400).json({ error: 'hay tipos de evento desconocidos', tipos_validos: TIPOS });
    const url = String(b.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'la URL tiene que empezar con http:// o https://' });
    try {
      /* El secreto lo generamos nosotros si no lo traen: uno elegido a mano suele ser
       * corto y adivinable, y este firma cada entrega. */
      const secreto = String(b.secreto || '') || crypto.randomBytes(24).toString('base64url');
      const { rows } = await pool.query(
        'INSERT INTO pbxng_suscripciones (nombre, client_id, url, secreto, tipos, activa, cursor) VALUES ($1,$2,$3,$4,$5,$6, COALESCE((SELECT MAX(secuencia) FROM pbxng_eventos_salida),0)) RETURNING id',
        [String(b.nombre).trim().slice(0, 120), b.client_id || null, url || null, secreto, tipos, b.activa !== false]);
      /* Arranca desde el ÚLTIMO evento, no desde el primero: dar de alta un destino no
       * tiene que dispararle una semana de historia de golpe. */
      res.status(201).json({ id: rows[0].id, secreto, aviso: 'Guardá el secreto: firma cada entrega (X-PBXNG-Firma) y no se vuelve a mostrar.' });
    } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/eventos/suscripciones/:id', auth, async (req, res) => {
    const b = req.body || {};
    const tipos = b.tipos === undefined ? null : (Array.isArray(b.tipos) ? b.tipos.filter((t) => TIPOS.includes(t)) : []);
    try {
      const { rowCount } = await pool.query(
        'UPDATE pbxng_suscripciones SET nombre=COALESCE($2,nombre), url=COALESCE($3,url), tipos=COALESCE($4,tipos), activa=COALESCE($5,activa),'
        + ' intentos=CASE WHEN COALESCE($5,activa) THEN intentos ELSE 0 END, proximo_at=NULL WHERE id=$1',
        [req.params.id, b.nombre || null, b.url === undefined ? null : String(b.url), tipos, b.activa === undefined ? null : !!b.activa]);
      if (!rowCount) return res.status(404).json({ error: 'no existe esa suscripción' });
      res.json({ updated: +req.params.id });
    } catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/eventos/suscripciones/:id', auth, async (req, res) => {
    try {
      const { rowCount } = await pool.query('DELETE FROM pbxng_suscripciones WHERE id=$1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'no existe esa suscripción' });
      res.json({ deleted: +req.params.id });
    } catch (e) { errorHttp(res, e); }
  });

  /* Un evento de prueba, para que el equipo externo pueda enchufar su webhook sin esperar
   * a que alguien llame. Va por el mismo camino que los de verdad. */
  app.post('/api/eventos/prueba', auth, (req, res) => {
    const id = emitir('llamada.terminada', {
      call_id: 'prueba.' + Date.now(), leg_id: 'prueba.' + Date.now(),
      datos: { prueba: true, origen: (req.user && req.user.username) || 'panel', desde: '1001', hacia: '1002', duracion_s: 12, resultado: 'ANSWERED' },
    });
    res.json({ emitido: id, aviso: 'sale por la próxima vuelta del outbox (1 s)' });
  });

  /* ── Modo PULL para el contrato público ───────────────────────────────────────
   * Para el consumidor que no puede exponer un webhook. Mismo cursor, mismo orden. */
  if (deps.routerV1 && authServicio && exigirAlcance) {
    deps.routerV1.get('/eventos', exigirAlcance('eventos:recibir'), async (req, res) => {
      const lim = Math.min(parseInt(req.query.limite, 10) || 100, 500);
      const desde = /^\d+$/.test(String(req.query.desde_cursor || '')) ? String(req.query.desde_cursor) : null;
      try {
        const { rows: sub } = await pool.query('SELECT id, cursor, tipos FROM pbxng_suscripciones WHERE client_id=$1 AND activa ORDER BY id LIMIT 1', [req.cliente.id]);
        if (!sub[0]) return res.status(409).json({ error: 'tu credencial no tiene una suscripción de eventos: creala desde el panel' });
        const cur = desde !== null ? desde : sub[0].cursor;
        const { rows } = await pool.query(
          'SELECT secuencia, evento_id, tipo, version, ts, call_id, leg_id, datos FROM pbxng_eventos_salida'
          + " WHERE secuencia > $1 AND ($2::text[] = '{}' OR tipo = ANY($2)) ORDER BY secuencia ASC LIMIT " + lim,
          [cur, sub[0].tipos || []]);
        res.json({
          items: rows, tope_aplicado: lim, truncado: rows.length >= lim,
          next_cursor: rows.length ? String(rows[rows.length - 1].secuencia) : String(cur),
          aviso: rows.length ? 'confirmá con POST /api/v1/eventos/acuse {cursor} o los vas a volver a recibir' : undefined,
        });
      } catch (e) { errorHttp(res, e); }
    });

    deps.routerV1.post('/eventos/acuse', exigirAlcance('eventos:recibir'), async (req, res) => {
      const cur = String((req.body || {}).cursor || '');
      if (!/^\d+$/.test(cur)) return res.status(400).json({ error: 'cursor inválido: mandá el next_cursor que te dimos' });
      try {
        /* El cursor sólo AVANZA. Un acuse hacia atrás sería un cliente reprocesando, y
         * dejarlo retroceder el cursor compartido le reenviaría eventos a sí mismo para
         * siempre; si quiere releer, usa `desde_cursor` y no toca el acuse. */
        const { rowCount } = await pool.query('UPDATE pbxng_suscripciones SET cursor=GREATEST(cursor, $2::bigint), ultimo_ok_at=now() WHERE client_id=$1 AND activa', [req.cliente.id, cur]);
        if (!rowCount) return res.status(409).json({ error: 'tu credencial no tiene una suscripción de eventos' });
        res.json({ ok: true, cursor: cur });
      } catch (e) { errorHttp(res, e); }
    });
  }

  return { emitir, CATALOGO, TIPOS, _volcar: volcar, _vuelta: vuelta, _podar: podar };
};
module.exports.CATALOGO = CATALOGO;
