/* ============================================================================
 *  PBX-NG · Reportes de call center (ítem 8 de docs/BRECHA-UCM-XORCOM.md, sprint 8)
 *
 *  El informe que firma un supervisor: por cola y por agente, sobre un rango de
 *  fechas — atendidas, abandonadas, nivel de servicio, espera media y máxima,
 *  conversación media y llamadas fuera de horario. Con export CSV, informe A4 para
 *  imprimir/guardar como PDF y envío programado por correo.
 *
 *  DE DÓNDE SALEN LOS NÚMEROS (y por qué no del CDR)
 *  El `cdr` cuenta llamadas: quién llamó a quién, cuánto duró, cómo terminó. No sabe
 *  nada de la cola. «Esperó 40 s y colgó» y «sonó 40 s en un interno y no atendieron»
 *  son la misma resta `duration - billsec` en el CDR, y no son lo mismo para un
 *  supervisor: una es abandono con nivel de servicio incumplido y la otra no es ni
 *  siquiera una llamada de cola. Quien sí lo sabe es `app_queue`, que lo publica por
 *  AMI. Este módulo escucha esos eventos y los guarda en `pbxng_queue_events`
 *  (migración 0012), que es la única fuente de este informe.
 *
 *  Eventos AMI que se guardan y qué aportan:
 *    QueueCallerJoin    → 'entra'          la llamada se puso en cola
 *    AgentConnect       → 'atendida'       un agente la tomó; HoldTime = lo que esperó
 *    AgentComplete      → 'fin'            terminó de hablar; TalkTime = conversación
 *    QueueCallerAbandon → 'abandona'       colgó esperando; HoldTime = lo que esperó
 *    AgentRingNoAnswer  → 'sin_respuesta'  le sonó a un agente y no atendió
 *
 *  QueueCallerLeave NO se guarda a propósito: Asterisk lo emite también cuando la
 *  llamada sale de la cola porque la atendieron, así que contarlo sería contar dos
 *  veces la misma llamada. Las salidas por desborde o por timeout se deducen como
 *  entradas − atendidas − abandonadas y se muestran aparte ("otras salidas").
 *
 *  EL CONSUMIDOR ESTÁ ACOTADO A PROPÓSITO: es la única pieza del informe que escribe en
 *  la base al ritmo de las llamadas, y el pool de Postgres es el mismo que usan los
 *  `CURL()` del dialplan (el PIN de la DISA, el código de función, el fin de un fax). Los
 *  eventos se juntan en memoria y se vuelcan en un INSERT multi-fila cada `CC_LOTE_MS`,
 *  de a un volcado por vez: como máximo UNA conexión del pool ocupada y UNA adquisición
 *  cada dos segundos, con o sin pico de cola. El buffer tiene tope (`CC_LOTE_TOPE`) y
 *  pasado ese tope se descartan eventos con aviso en el log. El detalle y el porqué están
 *  abajo, en «Cota del consumidor».
 *
 *  LO QUE ESTE INFORME NO PUEDE DECIR (y dice que no puede):
 *    - Nada anterior a la instalación de esta versión: los eventos se registran desde
 *      que el módulo corre. El informe muestra la fecha del primer evento registrado y
 *      avisa cuando el rango pedido empieza antes.
 *    - El último lote de eventos si el proceso se cae entre dos volcados (hasta dos
 *      segundos de cola). Es el precio de no encolar conexiones contra el pool que usan
 *      las llamadas, y se paga en el informe, que es donde se puede pagar.
 *    - Tiempo de pausa / sesión de agente (login-logout): `QueuePause` no se registra
 *      todavía, así que no hay ocupación ni disponibilidad del agente. Se prefiere no
 *      mostrar el dato antes que inventarlo.
 *
 *  FUERA DE HORARIO: se evalúa cada entrada a cola contra el horario de atención de
 *  telefonia.js (el mismo que usa el modo noche) y los feriados. Sin horario
 *  configurado el dato viaja en `null` y la pantalla lo dice; no se asume "9 a 18".
 *
 *  Acceso (rbac.js): ver y exportar = admin + supervisor; las programaciones de envío
 *  = admin (caen al deny-by-default).
 * ==========================================================================*/
'use strict';

const report = require('./report');   // CSS, gráficos SVG y marca del informe ejecutivo de CDR

/**
 * deps:
 *   app        Express (rutas registradas DESPUÉS del gate de auth + RBAC)
 *   pool       pg.Pool
 *   ami        cliente AMI (se le engancha un listener de 'managerevent')
 *   alerts     motor de correo (alerts.js): se usa `raise()` para el envío programado
 *   errorHttp  traduce errores a {error} con status (errores.js)
 *   logger     fábrica de loggers (log.js)
 *
 * Devuelve: { metricas, filasCsv, tick, ventana, toca, volcar, pendientes } (todo lo que no
 * sean rutas es para las pruebas y el motor de envíos).
 */
module.exports = function init(deps) {
  const { app, pool, ami, alerts, errorHttp, logger } = deps;
  const log = logger ? logger('ccreport') : { info() {}, debug() {}, error() {} };

  /* Tope de rango. Un informe no puede colgar la pantalla ni el pool: con 92 días el
   * agregado en SQL sigue siendo instantáneo y cubre el trimestre, que es lo que se
   * firma. El panel lo dice antes de que el usuario elija mal. */
  const MAX_DIAS = 92;
  const AGENTES_TOPE = 200;          // filas de la tabla por agente (el CSV no tiene tope)
  const DETALLE_TOPE = 300;          // filas del detalle en el informe A4

  const err = (status, msg) => Object.assign(new Error(msg), { status });
  const FECHA = /^\d{4}-\d{2}-\d{2}$/;
  /* Nombre de cola: el mismo alfabeto que acepta `apps.js` al crearlas. Va a parar a un
   * WHERE parametrizado, pero también al nombre del archivo CSV y al asunto del correo,
   * así que se valida igual: lo que viene del usuario no se pasea sin revisar. */
  const COLA_OK = /^[A-Za-z0-9_-]{1,64}$/;

  const num = (v, def, min, max) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };

  /* ── Consumidor AMI ──────────────────────────────────────────────────────
   * asterisk-manager entrega las CLAVES en minúscula (ver guard.js), pero no cuesta
   * nada tolerar las dos formas: si mañana se cambia de librería, el informe no se
   * queda mudo sin que nadie se entere. */
  const campo = (e, nombre) => {
    if (!e) return undefined;
    const l = nombre.toLowerCase();
    return e[l] !== undefined ? e[l] : e[nombre];
  };
  const entero = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
  /* Nombre del agente: `MemberName` es lo que configura el panel (el interno); si la cola
   * se armó a mano puede venir vacío y queda la interfaz (PJSIP/1001) sin el prefijo. */
  const agenteDe = (e) => {
    const n = String(campo(e, 'MemberName') || '').trim();
    if (n) return n.slice(0, 64);
    const i = String(campo(e, 'Interface') || '').trim();
    return i ? i.replace(/^[A-Za-z]+\//, '').replace(/-[^-]*$/, '').slice(0, 64) : null;
  };

  /* ── Cota del consumidor: buffer en memoria + INSERT por lotes ────────────
   * Esta es la ÚNICA pieza del informe que escribe en la base al ritmo de las llamadas,
   * y el pool de Postgres (`PG_POOL_MAX`, 10 por defecto) es el MISMO que usan los
   * `CURL()` del dialplan: el PIN de la DISA (`internal/disa`), el aviso de código de
   * función (`internal/feature`) y el fin de un fax (`internal/fax`). Un INSERT por
   * evento y sin esperar a nadie hace que, cuando la base se pone lenta un rato (un
   * vacuum, el respaldo nocturno, la poda de `pbxng_sec_events`), las adquisiciones de
   * conexión se encolen sin límite adentro de `pg.Pool` — y las que quedan atrás son las
   * del camino de llamada: el `CURL()` vuelve vacío y la DISA rechaza la llamada.
   * Acoplar «los informes» con «las llamadas» no es un precio que valga la pena pagar
   * por una métrica.
   *
   * EL TECHO, escrito: los eventos se acumulan en memoria y se vuelcan cada `LOTE_MS`
   * en un INSERT multi-fila. El volcado es de a uno (`volcando`), así que este módulo
   * ocupa COMO MÁXIMO **1 conexión de las 10** y hace como mucho **1 adquisición cada
   * LOTE_MS** (2 s por defecto), pase lo que pase con el volumen de llamadas. Si la base
   * tarda más que eso, el ciclo siguiente no arranca otro: se saltea y el buffer crece,
   * acotado a `LOTE_TOPE` filas (~2000, unos pocos cientos de kB); pasado el tope se
   * DESCARTAN los eventos nuevos y se avisa en el log con la cuenta. Perder filas del
   * informe es aceptable y se ve; frenar una llamada no lo es.
   *
   * Lo que se paga: hasta `LOTE_MS` de retraso en que el evento llegue a la tabla (el
   * informe es por día, no importa) y hasta un lote perdido si el proceso se cae entre
   * dos volcados. Por eso `ts` se toma acá, cuando llega el evento, y no con el `now()`
   * de la base: la hora del informe tiene que ser la de la llamada, no la del INSERT. */
  const LOTE_MS    = Math.max(250, parseInt(process.env.CC_LOTE_MS, 10) || 2000);
  const LOTE_TOPE  = Math.max(100, parseInt(process.env.CC_LOTE_TOPE, 10) || 2000);
  const LOTE_FILAS = Math.max(20,  parseInt(process.env.CC_LOTE_FILAS, 10) || 250);
  const COLS = ['ts', 'cola', 'evento', 'uniqueid', 'agente', 'espera_s', 'habla_s', 'posicion', 'origen', 'motivo'];

  const pendientes = [];
  let volcando = false, descartados = 0, avisadoAt = 0;

  /* Del handler del AMI sale por acá y nada más: sin `await`, sin tocar el pool. */
  function encolar(fila) {
    if (pendientes.length >= LOTE_TOPE) {
      descartados++;
      /* Un aviso por minuto como mucho: si la base está caída, el log no tiene que ser
       * el segundo problema. La cuenta acumulada sale igual en el próximo. */
      if (Date.now() - avisadoAt > 60000) {
        avisadoAt = Date.now();
        log.error('buffer de eventos de cola lleno: se descartan eventos del informe para no frenar las llamadas',
          { tope: LOTE_TOPE, descartados });
      }
      return;
    }
    pendientes.push(fila);
  }

  async function volcar() {
    if (volcando || !pendientes.length) return;
    volcando = true;
    try {
      /* Se vacía todo lo que haya, pero SIEMPRE de a un INSERT por vez: varios lotes
       * seguidos siguen siendo una sola conexión ocupada, no N. */
      while (pendientes.length) {
        const lote = pendientes.splice(0, LOTE_FILAS);
        const params = [];
        const tuplas = lote.map((f, i) => {
          const b = i * COLS.length;
          params.push(f.ts, f.cola, f.evento, f.uniqueid || null, f.agente || null,
            f.espera_s, f.habla_s, f.posicion, f.origen || null, f.motivo || null);
          return '(' + COLS.map((_, j) => '$' + (b + j + 1)).join(',') + ')';
        });
        try {
          await pool.query('INSERT INTO pbxng_queue_events (' + COLS.join(', ') + ') VALUES ' + tuplas.join(','), params);
        } catch (e) {
          /* Que no se caiga el proceso por un lote: el informe puede perder filas, la
           * central no puede perder la llamada. Queda en el log para que se note. */
          log.error('no se pudo guardar el lote de eventos de cola', { filas: lote.length }, e);
        }
      }
      if (descartados) {
        log.error('eventos de cola descartados por buffer lleno', { descartados });
        descartados = 0;
      }
    } finally { volcando = false; }
  }

  /* `unref()` por lo mismo que los relojes de abajo: este reloj no sostiene el proceso. */
  const relojLote = setInterval(() => { volcar().catch((e) => log.error('volcado de eventos de cola', e)); }, LOTE_MS);
  relojLote.unref();

  const MAPA = {
    QueueCallerJoin:    (e) => ({ evento: 'entra',         espera_s: null, habla_s: null, posicion: entero(campo(e, 'Position')), agente: null }),
    AgentConnect:       (e) => ({ evento: 'atendida',      espera_s: entero(campo(e, 'HoldTime')), habla_s: null, posicion: null, agente: agenteDe(e) }),
    AgentComplete:      (e) => ({ evento: 'fin',           espera_s: entero(campo(e, 'HoldTime')), habla_s: entero(campo(e, 'TalkTime')), posicion: null, agente: agenteDe(e) }),
    QueueCallerAbandon: (e) => ({ evento: 'abandona',      espera_s: entero(campo(e, 'HoldTime')), habla_s: null, posicion: entero(campo(e, 'OriginalPosition')), agente: null }),
    AgentRingNoAnswer:  (e) => ({ evento: 'sin_respuesta', espera_s: entero(campo(e, 'RingTime')), habla_s: null, posicion: null, agente: agenteDe(e) }),
  };

  if (ami && typeof ami.on === 'function') {
    ami.on('managerevent', (e) => {
      const t = e && e.event;
      const armar = t && Object.prototype.hasOwnProperty.call(MAPA, t) ? MAPA[t] : null;
      if (!armar) return;
      const cola = String(campo(e, 'Queue') || '').trim();
      if (!cola) return;                       // sin cola no hay informe que hacer con esto
      const base = armar(e);
      encolar({
        ts: new Date(),
        cola: cola.slice(0, 64),
        uniqueid: String(campo(e, 'Uniqueid') || campo(e, 'Linkedid') || '').slice(0, 64),
        origen: String(campo(e, 'CallerIDNum') || '').slice(0, 64),
        motivo: t === 'AgentComplete' ? String(campo(e, 'Reason') || '').slice(0, 32) : null,
        ...base,
      });
    });
  }

  /* ── Horario de atención (para "fuera de horario") ────────────────────────
   * Es el MISMO horario que decide el modo noche (telefonia.js): si el informe usara
   * otro, el supervisor vería "fuera de horario" llamadas que la central atendió como
   * si estuviera abierta. Sin horario configurado no se inventa ninguno. */
  async function horarioVigente() {
    const { rows: s } = await pool.query("SELECT value FROM pbxng_settings WHERE key='nightmode_horario_id'");
    const id = parseInt(s[0] && s[0].value, 10);
    const { rows } = Number.isFinite(id)
      ? await pool.query('SELECT id,nombre,tramos,activo FROM pbxng_horarios WHERE id=$1', [id])
      : await pool.query('SELECT id,nombre,tramos,activo FROM pbxng_horarios WHERE activo=true ORDER BY id LIMIT 1');
    const h = rows[0];
    if (!h || !h.activo || !Array.isArray(h.tramos) || !h.tramos.length) return null;
    return h;
  }
  /* Los feriados salen en dos listas (anuales 'MM-DD' y puntuales 'YYYY-MM-DD') porque
   * viajan como parámetro DENTRO de la consulta: el filtro de "fuera de horario" se
   * resuelve en la base, no en la memoria de la API. La fecha se formatea con el reloj
   * local y no con `toISOString()`: la columna es un `date` (un día de calendario, no un
   * instante) y en una zona con desfase positivo el ISO lo corría al día anterior. */
  async function feriados() {
    const { rows } = await pool.query('SELECT md, fecha, anual FROM pbxng_feriados');
    const anuales = [], fechas = [];
    for (const f of rows) {
      if (f.anual && f.md) anuales.push(String(f.md));
      else if (!f.anual && f.fecha) fechas.push(ymd(new Date(f.fecha)));
    }
    return { anuales, fechas };
  }
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /* ── "Fuera de horario", resuelto EN SQL ──────────────────────────────────
   * Antes esto se contaba en JavaScript: la consulta traía una fila por cola y por
   * MINUTO con entradas y el bucle las clasificaba. Era la única de las siete consultas
   * del informe sin cota — 92 días por varias colas son cientos de miles de filas en la
   * memoria de la API, en un pedido que cualquier supervisor repite apretando el botón.
   * Ahora la condición del horario viaja dentro del WHERE y vuelve UNA fila por cola.
   *
   * La contrapartida es que la semántica de los tramos queda escrita dos veces: acá y en
   * `tramoAhora()` / `diaEn()` de telefonia.js, que es la autoridad. Si allá cambia el
   * formato de un tramo, este traductor cambia con él (lo cubre ccreport.test.js con
   * tramos que cruzan medianoche, rangos de días con vuelta de semana y feriados).
   *
   * `ts` es timestamptz y un tramo es hora de PARED ("09:00-18:00"), así que hay que
   * bajarlo a la zona local antes de comparar: la misma con la que telefonia.js decide
   * el modo noche, o sea el reloj del contenedor (§6 de CONTRATOS, `TZ`). Se toma de
   * Intl —que ya refleja `TZ` cuando es válida y cae a la zona del sistema cuando no—
   * para que el nombre que recibe Postgres sea siempre un IANA que conozca. */
  const TZ_LOCAL = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return process.env.TZ || 'UTC'; }
  })();
  const DIAS_SEM = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const HORA_OK = /^([01]\d|2[0-3]):([0-5]\d)$/;
  /* Días (0=domingo, como EXTRACT(DOW) y Date#getDay) que cubre un `dias` del formato de
   * GotoIfTime. `null` = todos (no hace falta condición); `[]` = spec inválido, no matchea
   * ningún día. El rango puede dar la vuelta a la semana ('fri-mon'), igual que diaEn(). */
  function diasDe(spec) {
    const t = String(spec || '*');
    if (t === '*') return null;
    const [a, b] = t.split('-');
    const ia = DIAS_SEM.indexOf(a), ib = b ? DIAS_SEM.indexOf(b) : ia;
    if (ia < 0 || ib < 0) return [];
    const out = [];
    for (let d = 0; d < 7; d++) if (ia <= ib ? (d >= ia && d <= ib) : (d >= ia || d <= ib)) out.push(d);
    return out;
  }
  const minutosDe = (hhmm) => (+hhmm.slice(0, 2)) * 60 + (+hhmm.slice(3, 5));

  /* Expresión booleana SQL «esta llamada entró fuera del horario de atención». Los
   * valores (zona, feriados, minutos de cada tramo) se agregan a `args` y van por `$n`:
   * lo único que se interpola son los días de la semana, que son enteros 0-6 que calcula
   * diasDe() y nunca texto del usuario. */
  function sqlFuera(h, fer, args) {
    const p = (v) => { args.push(v); return '$' + args.length; };
    const L = `(ts AT TIME ZONE ${p(TZ_LOCAL)})`;
    const feriado = `(to_char(${L}, 'MM-DD') = ANY(${p(fer.anuales)}::text[])`
      + ` OR to_char(${L}, 'YYYY-MM-DD') = ANY(${p(fer.fechas)}::text[]))`;
    const m = `(EXTRACT(HOUR FROM ${L}) * 60 + EXTRACT(MINUTE FROM ${L}))`;
    const dentro = [];
    for (const t of h.tramos || []) {
      if (!t || !HORA_OK.test(String(t.desde || '')) || !HORA_OK.test(String(t.hasta || ''))) continue;
      const dias = diasDe(t.dias);
      if (dias && !dias.length) continue;
      const a = minutosDe(String(t.desde)), b = minutosDe(String(t.hasta));
      const cond = [];
      if (dias) cond.push(`EXTRACT(DOW FROM ${L}) IN (${dias.join(',')})`);
      /* Un tramo que cruza medianoche ('22:00'-'06:00') son dos mitades, como en GotoIfTime. */
      cond.push(a <= b ? `${m} BETWEEN ${p(a)} AND ${p(b)}` : `(${m} >= ${p(a)} OR ${m} <= ${p(b)})`);
      dentro.push('(' + cond.join(' AND ') + ')');
    }
    /* Sin ningún tramo válido no hay horario que cumplir y TODO queda fuera: es lo que
     * devuelve tramoAhora() con la misma entrada, y es el lado prudente del error. */
    return dentro.length ? `(${feriado} OR NOT (${dentro.join(' OR ')}))` : 'true';
  }

  /* ── Métricas ────────────────────────────────────────────────────────────
   * Todo lo pesado se agrega en SQL (`count(*) FILTER`), así que el costo no depende
   * del volumen de llamadas sino de la cantidad de colas y agentes: NINGUNA de las
   * consultas devuelve más de una fila por cola, por agente o por día del rango (que ya
   * está topado en MAX_DIAS). Eso incluye "fuera de horario", que se filtra en la base
   * con sqlFuera() en vez de traerse una fila por minuto. */
  async function metricas({ from, to, cola, sla, limite } = {}) {
    if (from && !FECHA.test(from)) throw err(400, 'la fecha "desde" no es válida');
    if (to && !FECHA.test(to)) throw err(400, 'la fecha "hasta" no es válida');
    if (cola && !COLA_OK.test(cola)) throw err(400, 'el nombre de la cola no es válido');

    const hasta = to ? new Date(to + 'T23:59:59.999') : new Date();
    const desde = from ? new Date(from + 'T00:00:00') : new Date(hasta.getTime() - 6 * 864e5);
    if (isNaN(desde.getTime()) || isNaN(hasta.getTime())) throw err(400, 'el rango de fechas no es válido');
    if (desde > hasta) throw err(400, 'la fecha "desde" es posterior a la fecha "hasta"');
    const dias = Math.ceil((hasta - desde) / 864e5);
    if (dias > MAX_DIAS) throw err(400, `el rango no puede pasar de ${MAX_DIAS} días (pediste ${dias}); partilo en tramos o usá el envío mensual`);

    const slaSeg = num(sla, 20, 1, 3600);
    const tope = num(limite, AGENTES_TOPE, 1, 1000);
    /* Dos juegos de parámetros: las consultas con umbral de nivel de servicio usan $3 y
     * el filtro de cola queda en $4; las que no lo usan tienen la cola en $3. Mezclarlos
     * era el error: Postgres rechaza el bind si sobran parámetros. */
    const args = [desde, hasta, slaSeg];
    const filtro = cola ? ' AND cola=$4' : '';
    if (cola) args.push(cola);
    const args2 = [desde, hasta];
    const filtro2 = cola ? ' AND cola=$3' : '';
    if (cola) args2.push(cola);

    /* El horario y los feriados se resuelven ANTES que las métricas porque son parte de
     * la consulta de "fuera de horario". Sin horario configurado esa consulta ni se
     * hace: el informe no inventa un "9 a 18" y el dato viaja en null. */
    const h = await horarioVigente();
    const fer = h ? await feriados() : null;
    const argsFuera = args2.slice();
    const condFuera = h ? sqlFuera(h, fer, argsFuera) : null;

    const [porCola, porAgente, porDia, fueraRows, primera, nombres, etiquetas] = await Promise.all([
      pool.query(`
        SELECT cola,
               count(*) FILTER (WHERE evento='entra')::int            AS entradas,
               count(*) FILTER (WHERE evento='atendida')::int         AS atendidas,
               count(*) FILTER (WHERE evento='abandona')::int         AS abandonadas,
               count(*) FILTER (WHERE evento='sin_respuesta')::int    AS sin_respuesta,
               count(*) FILTER (WHERE evento='atendida' AND espera_s IS NOT NULL AND espera_s <= $3)::int AS en_sla,
               COALESCE(round(avg(espera_s) FILTER (WHERE evento IN ('atendida','abandona')))::int, 0)    AS espera_media,
               COALESCE(max(espera_s) FILTER (WHERE evento IN ('atendida','abandona')), 0)::int           AS espera_max,
               COALESCE(round(avg(espera_s) FILTER (WHERE evento='abandona'))::int, 0)                    AS espera_abandono,
               COALESCE(round(avg(habla_s) FILTER (WHERE evento='fin'))::int, 0)                          AS habla_media,
               COALESCE(sum(habla_s) FILTER (WHERE evento='fin'), 0)::int                                 AS habla_total
          FROM pbxng_queue_events
         WHERE ts >= $1 AND ts <= $2${filtro}
         GROUP BY cola ORDER BY cola`, args),
      pool.query(`
        SELECT agente,
               count(*) FILTER (WHERE evento='atendida')::int      AS atendidas,
               count(*) FILTER (WHERE evento='sin_respuesta')::int AS sin_respuesta,
               COALESCE(round(avg(espera_s) FILTER (WHERE evento='atendida'))::int, 0) AS espera_media,
               COALESCE(round(avg(habla_s) FILTER (WHERE evento='fin'))::int, 0)       AS habla_media,
               COALESCE(max(habla_s) FILTER (WHERE evento='fin'), 0)::int              AS habla_max,
               COALESCE(sum(habla_s) FILTER (WHERE evento='fin'), 0)::int              AS habla_total
          FROM pbxng_queue_events
         WHERE ts >= $1 AND ts <= $2 AND agente IS NOT NULL AND agente <> ''${filtro2}
         GROUP BY agente ORDER BY atendidas DESC, agente ASC LIMIT ${tope + 1}`, args2),
      pool.query(`
        SELECT to_char(ts, 'YYYY-MM-DD') AS dia,
               count(*) FILTER (WHERE evento='atendida')::int  AS atendidas,
               count(*) FILTER (WHERE evento='abandona')::int  AS abandonadas
          FROM pbxng_queue_events
         WHERE ts >= $1 AND ts <= $2${filtro2}
         GROUP BY 1 ORDER BY 1`, args2),
      h ? pool.query(`
        SELECT cola, count(*)::int AS fuera
          FROM pbxng_queue_events
         WHERE evento='entra' AND ts >= $1 AND ts <= $2${filtro2} AND ${condFuera}
         GROUP BY cola`, argsFuera) : { rows: [] },
      pool.query('SELECT min(ts) AS t FROM pbxng_queue_events'),
      pool.query('SELECT ext, name FROM pbxng_directory'),
      pool.query('SELECT name, label FROM pbxng_queues'),
    ]);

    // Ya viene contado por cola desde la base (ver sqlFuera).
    const fuera = new Map(fueraRows.rows.map((r) => [String(r.cola), r.fuera]));

    const nombrePorExt = new Map(nombres.rows.map((r) => [String(r.ext), r.name]));
    const labelPorCola = new Map(etiquetas.rows.map((r) => [String(r.name), r.label]));

    const colas = porCola.rows.map((r) => {
      /* Base del nivel de servicio: llamadas OFRECIDAS. Se toma la mayor entre las
       * entradas registradas y atendidas+abandonadas porque si el AMI estuvo caído
       * cuando la llamada entró pero no cuando la atendieron, falta el 'entra' y el
       * porcentaje daría más de 100. */
      const resueltas = r.atendidas + r.abandonadas;
      const ofrecidas = Math.max(r.entradas, resueltas);
      return {
        cola: r.cola,
        label: labelPorCola.get(r.cola) || r.cola,
        ofrecidas,
        atendidas: r.atendidas,
        abandonadas: r.abandonadas,
        otras_salidas: Math.max(0, r.entradas - resueltas),
        sin_respuesta: r.sin_respuesta,
        sla_pct: ofrecidas ? Math.round((r.en_sla * 1000) / ofrecidas) / 10 : null,
        abandono_pct: ofrecidas ? Math.round((r.abandonadas * 1000) / ofrecidas) / 10 : null,
        espera_media: r.espera_media,
        espera_max: r.espera_max,
        espera_abandono: r.espera_abandono,
        habla_media: r.habla_media,
        habla_total: r.habla_total,
        fuera_horario: h ? (fuera.get(r.cola) || 0) : null,
      };
    });

    const agentes = porAgente.rows.slice(0, tope).map((r) => ({
      agente: r.agente,
      nombre: nombrePorExt.get(String(r.agente)) || '',
      atendidas: r.atendidas,
      sin_respuesta: r.sin_respuesta,
      espera_media: r.espera_media,
      habla_media: r.habla_media,
      habla_max: r.habla_max,
      habla_total: r.habla_total,
    }));

    const sum = (k) => colas.reduce((a, c) => a + (c[k] || 0), 0);
    const ofrecidas = sum('ofrecidas');
    const atendidas = sum('atendidas');
    const abandonadas = sum('abandonadas');
    const enSla = porCola.rows.reduce((a, r) => a + r.en_sla, 0);
    const pesoEspera = porCola.rows.reduce((a, r) => a + r.espera_media * (r.atendidas + r.abandonadas), 0);
    const pesoHabla = colas.reduce((a, c) => a + c.habla_total, 0);

    const t0 = primera.rows[0] && primera.rows[0].t ? new Date(primera.rows[0].t) : null;
    return {
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      dias,
      sla_seg: slaSeg,
      cola: cola || null,
      colas,
      agentes,
      serie: porDia.rows.map((r) => ({ dia: r.dia, atendidas: r.atendidas, abandonadas: r.abandonadas })),
      totales: {
        ofrecidas,
        atendidas,
        abandonadas,
        otras_salidas: sum('otras_salidas'),
        sla_pct: ofrecidas ? Math.round((enSla * 1000) / ofrecidas) / 10 : null,
        abandono_pct: ofrecidas ? Math.round((abandonadas * 1000) / ofrecidas) / 10 : null,
        espera_media: atendidas + abandonadas ? Math.round(pesoEspera / (atendidas + abandonadas)) : 0,
        espera_max: colas.reduce((a, c) => Math.max(a, c.espera_max), 0),
        habla_media: atendidas ? Math.round(pesoHabla / atendidas) : 0,
        habla_total: pesoHabla,
        fuera_horario: h ? colas.reduce((a, c) => a + (c.fuera_horario || 0), 0) : null,
      },
      horario: h ? { id: h.id, nombre: h.nombre || ('horario ' + h.id) } : null,
      /* Honestidad del informe: qué se pudo medir y desde cuándo. El panel y el PDF lo
       * muestran tal cual; sin esto, un rango anterior a la instalación se ve como un
       * call center que no atendió a nadie. */
      fuente: {
        tabla: 'pbxng_queue_events',
        primer_evento: t0 ? t0.toISOString() : null,
        rango_incompleto: !!(t0 && t0 > desde),
        sin_datos: !t0,
        sin_horario: !h,
      },
      agentes_truncado: porAgente.rows.length > tope,
      agentes_tope: tope,
    };
  }

  /* ── CSV ─────────────────────────────────────────────────────────────────
   * Dos bloques en un archivo (colas y agentes) con una línea en blanco entre medio:
   * es lo que espera quien lo abre en una planilla y lo que evita tener que bajar dos
   * archivos para armar el mismo cuadro. Separador `;` y BOM porque Excel en es-UY
   * abre con coma decimal y, sin BOM, se come los acentos. */
  function filasCsv(m) {
    const q = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const dec = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
    const out = [];
    out.push(['Informe de call center'].map(q).join(';'));
    out.push(['Desde', new Date(m.desde).toLocaleString('es-UY'), 'Hasta', new Date(m.hasta).toLocaleString('es-UY')].map(q).join(';'));
    out.push(['Nivel de servicio', 'atendidas antes de ' + m.sla_seg + ' s'].map(q).join(';'));
    out.push('');
    out.push(['Cola', 'Nombre', 'Ofrecidas', 'Atendidas', 'Abandonadas', 'Otras salidas',
      'Nivel de servicio %', 'Abandono %', 'Espera media (s)', 'Espera maxima (s)',
      'Espera media al abandonar (s)', 'Conversacion media (s)', 'Conversacion total (s)',
      'Fuera de horario'].map(q).join(';'));
    for (const c of m.colas) {
      out.push([c.cola, c.label, c.ofrecidas, c.atendidas, c.abandonadas, c.otras_salidas,
        dec(c.sla_pct), dec(c.abandono_pct), c.espera_media, c.espera_max, c.espera_abandono,
        c.habla_media, c.habla_total, c.fuera_horario === null ? 'sin horario' : c.fuera_horario].map(q).join(';'));
    }
    out.push('');
    out.push(['Agente', 'Nombre', 'Atendidas', 'No contesto', 'Espera media (s)',
      'Conversacion media (s)', 'Conversacion maxima (s)', 'Conversacion total (s)'].map(q).join(';'));
    for (const a of m.agentes) {
      out.push([a.agente, a.nombre, a.atendidas, a.sin_respuesta, a.espera_media,
        a.habla_media, a.habla_max, a.habla_total].map(q).join(';'));
    }
    return '﻿' + out.join('\r\n') + '\r\n';
  }

  /* ── Informe A4 (imprimir → guardar como PDF) ─────────────────────────────
   * Misma identidad visual que el informe ejecutivo de CDR: se reusan el CSS, los
   * gráficos SVG y la marca de report.js en vez de copiarlos. */
  const { esc, dur, pct, fLargo, fHora, barras, dona, CSS, branding, logoHtml } = report;

  function html(m, { usuario } = {}, brand) {
    const marca = brand.name;
    const T = m.totales;
    const kpi = (v, l, s, c) => `<div class="kpi"><div class="kv" style="color:${c}">${v}</div><div class="kl">${l}</div>${s ? `<div class="ks">${s}</div>` : ''}</div>`;
    const npct = (v) => (v === null ? '—' : String(v).replace('.', ',') + '%');

    const serie = m.serie.map((r) => ({ l: r.dia.slice(8) + '/' + r.dia.slice(5, 7), v: r.atendidas + r.abandonadas }));
    const resultado = [
      { l: 'Atendidas', v: T.atendidas, c: '#10b981' },
      { l: 'Abandonadas', v: T.abandonadas, c: '#ef4444' },
      { l: 'Otras salidas', v: T.otras_salidas, c: '#f59e0b' },
    ].filter((x) => x.v > 0);

    const avisos = [];
    if (m.fuente.sin_datos) avisos.push('No hay <b>ningún</b> evento de cola registrado todavía. Los eventos se empiezan a guardar cuando la central procesa la primera llamada por cola con esta versión instalada.');
    else if (m.fuente.rango_incompleto) avisos.push(`El registro de colas arranca el <b>${fLargo(new Date(m.fuente.primer_evento))}</b>: lo anterior a esa fecha no está medido y no se cuenta acá.`);
    if (m.fuente.sin_horario) avisos.push('No hay un horario de atención configurado (Telefonía → Horarios y modo noche), así que <b>no se puede decir qué llamadas entraron fuera de hora</b>.');
    if (m.agentes_truncado) avisos.push(`Se listan los <b>${m.agentes_tope}</b> agentes con más llamadas atendidas; el resto está en la exportación CSV.`);
    avisos.push(`El nivel de servicio es el porcentaje de llamadas <b>atendidas antes de ${m.sla_seg} segundos</b> sobre las ofrecidas (atendidas + abandonadas + las que salieron por desborde).`);

    const conclusiones = [];
    if (T.ofrecidas) {
      conclusiones.push(`Entraron <b>${T.ofrecidas}</b> llamadas a las colas: se atendieron <b>${T.atendidas}</b> (<b>${pct(T.atendidas, T.ofrecidas)}%</b>) y se abandonaron <b>${T.abandonadas}</b> (<b>${npct(T.abandono_pct)}</b>).`);
      conclusiones.push(`El nivel de servicio del período es <b>${npct(T.sla_pct)}</b> con un umbral de ${m.sla_seg} s. La espera media fue de <b>${dur(T.espera_media)}</b> y la peor espera, de <b>${dur(T.espera_max)}</b>.`);
      if (T.habla_media) conclusiones.push(`La conversación media duró <b>${dur(T.habla_media)}</b> y se hablaron <b>${dur(T.habla_total)}</b> en total.`);
      if (T.fuera_horario) conclusiones.push(`<b>${T.fuera_horario}</b> llamadas entraron fuera del horario de atención${m.horario ? ` (${esc(m.horario.nombre)})` : ''}: son las que conviene revisar contra el destino de fuera de hora de la ruta.`);
      const peor = m.colas.slice().sort((a, b) => (a.sla_pct === null ? 101 : a.sla_pct) - (b.sla_pct === null ? 101 : b.sla_pct))[0];
      if (peor && m.colas.length > 1) conclusiones.push(`La cola con peor nivel de servicio es <b>${esc(peor.label)}</b> (${npct(peor.sla_pct)}).`);
    } else {
      conclusiones.push('No hubo llamadas de cola en el período seleccionado.');
    }

    const filaCola = (c) => `<tr>
      <td><b>${esc(c.label)}</b>${c.label !== c.cola ? `<span class="sm">${esc(c.cola)}</span>` : ''}</td>
      <td>${c.ofrecidas}</td><td>${c.atendidas}</td><td>${c.abandonadas}</td>
      <td><span class="chip ${c.sla_pct === null || c.sla_pct >= 80 ? 'ok' : 'no'}">${npct(c.sla_pct)}</span></td>
      <td class="mono">${dur(c.espera_media)}</td><td class="mono">${dur(c.espera_max)}</td>
      <td class="mono">${dur(c.habla_media)}</td>
      <td>${c.fuera_horario === null ? '—' : c.fuera_horario}</td></tr>`;

    const filaAg = (a) => `<tr>
      <td class="mono">${esc(a.agente)}${a.nombre ? `<span class="sm">${esc(a.nombre)}</span>` : ''}</td>
      <td>${a.atendidas}</td><td>${a.sin_respuesta}</td>
      <td class="mono">${dur(a.espera_media)}</td><td class="mono">${dur(a.habla_media)}</td>
      <td class="mono">${dur(a.habla_max)}</td><td class="mono">${dur(a.habla_total)}</td></tr>`;

    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Informe de call center · ${esc(marca)}</title>
<style>
${CSS}
</style></head><body>
<div class="barra"><span>Informe listo · usá <b>Imprimir → Guardar como PDF</b> (tamaño A4, márgenes por defecto)</span><button onclick="window.print()">Imprimir / Guardar PDF</button></div>

<div class="page">
  <div class="tapa">
    <div class="hd">${logoHtml(brand)}<div><div class="marca">${esc(marca)}</div><div class="sub">${esc(brand.subtitle)}</div></div></div>
    <div>
      <div class="rule"></div>
      <h1>Informe<br>de call center</h1>
      <div class="peri">${fLargo(new Date(m.desde))} — ${fLargo(new Date(m.hasta))}</div>
      <div class="peri" style="font-size:12px;opacity:.7;margin-top:6px">${m.cola ? 'Cola ' + esc(m.cola) : 'Todas las colas'} · nivel de servicio a ${m.sla_seg} s</div>
    </div>
    <div class="meta">
      <div><b>${T.ofrecidas}</b>llamadas ofrecidas</div>
      <div><b>${npct(T.sla_pct)}</b>nivel de servicio</div>
      <div><b>${npct(T.abandono_pct)}</b>abandono</div>
      <div><b>${fHora(new Date())}</b>generado${usuario ? ' por ' + esc(usuario) : ''}</div>
    </div>
  </div>
</div>

<div class="page">
  <section>
    <h2><span class="n">1</span>Resumen del período</h2>
    <p class="dsc">Indicadores de las colas de atención. Salen de los eventos de cola de Asterisk, no del CDR.</p>
    <div class="kpis">
      ${kpi(T.ofrecidas, 'Ofrecidas', '', '#0f172a')}
      ${kpi(T.atendidas, 'Atendidas', pct(T.atendidas, T.ofrecidas) + '% del total', '#10b981')}
      ${kpi(T.abandonadas, 'Abandonadas', npct(T.abandono_pct), '#ef4444')}
      ${kpi(npct(T.sla_pct), 'Nivel de servicio', 'antes de ' + m.sla_seg + ' s', '#2f80ff')}
      ${kpi(dur(T.espera_media), 'Espera media', 'máxima ' + dur(T.espera_max), '#f59e0b')}
      ${kpi(dur(T.habla_media), 'Conversación media', 'total ' + dur(T.habla_total), '#7c3aed')}
    </div>
    <div class="box"><ul>${conclusiones.map((c) => `<li>${c}</li>`).join('')}</ul></div>
  </section>

  <section>
    <h2><span class="n">2</span>Volumen por día</h2>
    <p class="dsc">Llamadas ofrecidas a las colas por jornada.</p>
    ${barras(serie, { color: '#2f80ff' })}
  </section>

  <section>
    <h2><span class="n">3</span>Cómo terminaron</h2>
    <p class="dsc">«Otras salidas» son las que dejaron la cola sin que el que llamaba colgara: desborde, timeout o salto a otro destino.</p>
    ${resultado.length ? dona(resultado) : '<p class="vacio">Sin llamadas de cola en el período.</p>'}
  </section>
</div>

<div class="page">
  <section>
    <h2><span class="n">4</span>Por cola</h2>
    <p class="dsc">Una fila por cola. El nivel de servicio se pinta en verde a partir del 80 %.</p>
    <table><thead><tr><th>Cola</th><th>Ofrec.</th><th>Atend.</th><th>Aband.</th><th>Nivel serv.</th><th>Espera media</th><th>Espera máx.</th><th>Conv. media</th><th>Fuera de hora</th></tr></thead>
    <tbody>${m.colas.map(filaCola).join('') || '<tr><td colspan="9" class="vacio">Sin datos de cola en el período.</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2><span class="n">5</span>Por agente</h2>
    <p class="dsc">Ordenado por llamadas atendidas${m.agentes.length > DETALLE_TOPE ? ` (se muestran los primeros ${DETALLE_TOPE})` : ''}. «No contestó» es cuando la llamada le sonó y no la tomó.</p>
    <table><thead><tr><th>Agente</th><th>Atendidas</th><th>No contestó</th><th>Espera media</th><th>Conv. media</th><th>Conv. máxima</th><th>Conv. total</th></tr></thead>
    <tbody>${m.agentes.slice(0, DETALLE_TOPE).map(filaAg).join('') || '<tr><td colspan="7" class="vacio">Ningún agente atendió llamadas de cola en el período.</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2><span class="n">6</span>Cómo leer este informe</h2>
    <div class="box"><ul>${avisos.map((a) => `<li>${a}</li>`).join('')}</ul></div>
  </section>
  <div class="pie"><span>${esc(marca)} · Informe de call center</span><span>Generado por PBX-NG el ${fHora(new Date())}</span></div>
</div>
</body></html>`;
  }

  /* ── Rutas de consulta (admin + supervisor, ver rbac.js) ──────────────────*/
  const params = (req) => ({ from: req.query.from, to: req.query.to, cola: req.query.cola, sla: req.query.sla, limite: req.query.limite });

  app.get('/api/ccreport', async (req, res) => {
    try { res.json(await metricas(params(req))); } catch (e) { errorHttp(res, e); }
  });

  app.get('/api/ccreport/csv', async (req, res) => {
    try {
      const m = await metricas({ ...params(req), limite: 1000 });
      const nombre = 'callcenter-' + new Date(m.desde).toISOString().slice(0, 10) + '_' + new Date(m.hasta).toISOString().slice(0, 10) + (m.cola ? '-' + m.cola : '') + '.csv';
      res.type('text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '"');
      res.send(filasCsv(m));
    } catch (e) { errorHttp(res, e); }
  });

  app.get('/api/ccreport/report', async (req, res) => {
    try {
      const m = await metricas(params(req));
      const brand = await branding(pool);
      res.type('html').send(html(m, { usuario: (req.user && (req.user.name || req.user.username)) || '' }, brand));
    } catch (e) { errorHttp(res, e); }
  });

  /* ── Programaciones de envío (admin) ─────────────────────────────────────*/
  const PERIODOS = ['diario', 'semanal', 'mensual'];
  /* Destinatarios: lista separada por coma. Se valida acá y no sólo en el panel porque
   * termina en la cabecera `To` de un correo que manda la central: una coma de más con
   * basura adentro es un intento de inyección de cabecera, no un error de tipeo. */
  const MAIL_OK = /^[^\s@,;:<>"]+@[^\s@,;:<>"]+\.[A-Za-z]{2,}$/;
  function destinatarios(v) {
    const lista = String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean);
    if (lista.length > 20) throw err(400, 'demasiados destinatarios (máximo 20)');
    for (const d of lista) if (!MAIL_OK.test(d)) throw err(400, `"${d}" no parece una dirección de correo`);
    return lista.join(',');
  }

  function normalizar(b) {
    const periodo = String(b.periodo || 'diario').trim();
    if (!PERIODOS.includes(periodo)) throw err(400, 'el período tiene que ser diario, semanal o mensual');
    const cola = String(b.cola || '').trim();
    if (cola && !COLA_OK.test(cola)) throw err(400, 'el nombre de la cola no es válido');
    const nombre = String(b.nombre || '').trim().slice(0, 80);
    /* El día del mes se topa en 28 a propósito: un envío el 31 no existiría en febrero y
     * el informe de ese mes nunca se mandaría, sin que nadie se entere. */
    const dia = periodo === 'semanal' ? num(b.dia, 1, 1, 7) : periodo === 'mensual' ? num(b.dia, 1, 1, 28) : null;
    return {
      nombre: nombre || ('Informe ' + periodo + (cola ? ' · ' + cola : '')),
      cola: cola || null,
      periodo,
      hora: num(b.hora, 8, 0, 23),
      dia,
      sla_seg: num(b.sla_seg, 20, 1, 3600),
      destinatarios: destinatarios(b.destinatarios),
      enabled: b.enabled === undefined ? true : !!b.enabled,
    };
  }

  app.get('/api/ccreport/schedules', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT id,nombre,cola,periodo,hora,dia,sla_seg,destinatarios,enabled,last_run_at FROM pbxng_cc_reports ORDER BY id');
      res.json(rows);
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/ccreport/schedules', async (req, res) => {
    try {
      const p = normalizar(req.body || {});
      const { rows } = await pool.query(
        `INSERT INTO pbxng_cc_reports (nombre,cola,periodo,hora,dia,sla_seg,destinatarios,enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,nombre,cola,periodo,hora,dia,sla_seg,destinatarios,enabled,last_run_at`,
        [p.nombre, p.cola, p.periodo, p.hora, p.dia, p.sla_seg, p.destinatarios, p.enabled]);
      res.status(201).json(rows[0]);
    } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/ccreport/schedules/:id', async (req, res) => {
    try {
      const id = num(req.params.id, 0, 1, 2147483647);
      const p = normalizar(req.body || {});
      const { rows } = await pool.query(
        `UPDATE pbxng_cc_reports SET nombre=$2,cola=$3,periodo=$4,hora=$5,dia=$6,sla_seg=$7,destinatarios=$8,enabled=$9
          WHERE id=$1 RETURNING id,nombre,cola,periodo,hora,dia,sla_seg,destinatarios,enabled,last_run_at`,
        [id, p.nombre, p.cola, p.periodo, p.hora, p.dia, p.sla_seg, p.destinatarios, p.enabled]);
      if (!rows[0]) return res.status(404).json({ error: 'no existe esa programación' });
      res.json(rows[0]);
    } catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/ccreport/schedules/:id', async (req, res) => {
    try {
      const id = num(req.params.id, 0, 1, 2147483647);
      const r = await pool.query('DELETE FROM pbxng_cc_reports WHERE id=$1', [id]);
      if (!r.rowCount) return res.status(404).json({ error: 'no existe esa programación' });
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });

  /* Probar el envío ahora, con el rango que le tocaría. Sin esto el administrador se
   * entera de que el SMTP está mal recién al día siguiente a las 8. */
  app.post('/api/ccreport/schedules/:id/test', async (req, res) => {
    try {
      const id = num(req.params.id, 0, 1, 2147483647);
      const { rows } = await pool.query('SELECT * FROM pbxng_cc_reports WHERE id=$1', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'no existe esa programación' });
      const enviado = await enviar(rows[0], { forzar: true });
      if (!enviado) return res.status(502).json({ error: 'no se pudo enviar: revisá la configuración de correo (Configuración → Correo) y el destinatario por defecto de las alertas' });
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });

  /* ── Envío programado ────────────────────────────────────────────────────
   * Se apoya en alerts.raise(): ahí ya están resueltos el SMTP, la marca, el enlace al
   * panel, el registro en `pbxng_alerts` y el manejo de errores. Acá sólo se arma el
   * contenido y se le pasa el destinatario de ESTA programación. */
  function ventana(p, ahora) {
    const fin = new Date(ahora);
    fin.setHours(0, 0, 0, 0);
    const ini = new Date(fin);
    if (p.periodo === 'semanal') ini.setDate(ini.getDate() - 7);
    else if (p.periodo === 'mensual') ini.setMonth(ini.getMonth() - 1);
    else ini.setDate(ini.getDate() - 1);
    fin.setMilliseconds(-1);                      // hasta las 23:59:59.999 de ayer
    return { from: ymd(ini), to: ymd(new Date(fin.getTime())) };
  }

  async function enviar(p, { forzar = false } = {}) {
    const { from, to } = ventana(p, new Date());
    const m = await metricas({ from, to, cola: p.cola || undefined, sla: p.sla_seg });
    const T = m.totales;
    const npct = (v) => (v === null ? '—' : String(v).replace('.', ',') + '%');
    const titulo = `${p.nombre || 'Informe de call center'} · ${T.ofrecidas} llamadas`;
    const lines = [
      ['Llamadas ofrecidas', T.ofrecidas],
      ['Atendidas', T.atendidas],
      ['Abandonadas', T.abandonadas],
      ['Nivel de servicio', npct(T.sla_pct)],
      ['Espera media', dur(T.espera_media)],
      ['Conversación media', dur(T.habla_media)],
      ['Espera máxima', dur(T.espera_max)],
      ['Fuera de horario', T.fuera_horario === null ? 'sin horario configurado' : T.fuera_horario],
      ...m.colas.slice(0, 8).map((c) => ['Top cola ' + c.label, `${c.atendidas} atendidas · ${npct(c.sla_pct)} nivel de servicio`]),
      ...m.agentes.slice(0, 8).map((a) => ['Top agente ' + a.agente, `${a.atendidas} atendidas · ${dur(a.habla_media)} de conversación media`]),
    ];
    const ok = await alerts.raise('ccreport.scheduled', {
      severity: 'info',
      title: titulo,
      lines,
      foot: `Período ${from} a ${to}${m.cola ? ' · cola ' + esc(m.cola) : ' · todas las colas'}. El detalle completo, el CSV y el informe para imprimir están en el panel, en Operación → Reportes.`,
      key: 'sched:' + p.id,
      to: p.destinatarios || '',
      force: forzar,
    });
    return ok;
  }

  /* El período queda marcado como procesado lo llame quien lo llame (menos la prueba
   * manual, que no tiene período). Antes se marcaba sólo `if (ok)`, y `alerts.raise()`
   * devuelve false por varios motivos que NO son un fallo pasajero —la regla
   * `ccreport.scheduled` apagada, sin SMTP configurado, sin destinatario—: con
   * cualquiera de esos, `last_run_at` no avanzaba nunca y el tick volvía a calcular la
   * consulta pesada cada minuto durante toda la hora de envío, todos los días. Que no
   * haya correo se ve igual: queda en el log y en `pbxng_alerts` (con el error, si lo
   * hubo), y `POST /api/ccreport/schedules/:id/test` lo prueba en el momento. */
  async function marcarCorrido(p) {
    await pool.query('UPDATE pbxng_cc_reports SET last_run_at=now() WHERE id=$1', [p.id]);
  }

  /* ¿Le toca ahora? Se compara contra `last_run_at` en vez de llevar un temporizador:
   * si la central estuvo apagada a las 8, el informe sale igual cuando vuelve, y si se
   * reinicia tres veces a las 8:05 no sale tres veces. */
  function toca(p, ahora, ultimo) {
    if (ahora.getHours() !== p.hora) return false;
    if (p.periodo === 'semanal') {
      const dow = ahora.getDay() === 0 ? 7 : ahora.getDay();       // 1=lunes … 7=domingo
      if (dow !== (p.dia || 1)) return false;
      if (ultimo && ahora - ultimo < 6 * 864e5) return false;
    } else if (p.periodo === 'mensual') {
      if (ahora.getDate() !== (p.dia || 1)) return false;
      if (ultimo && ahora - ultimo < 27 * 864e5) return false;
    } else if (ultimo && ymd(ultimo) === ymd(ahora)) return false;
    return true;
  }

  async function tick() {
    const ahora = new Date();
    const { rows } = await pool.query('SELECT * FROM pbxng_cc_reports WHERE enabled=true');
    for (const p of rows) {
      try {
        if (!toca(p, ahora, p.last_run_at ? new Date(p.last_run_at) : null)) continue;
        let ok = false;
        try {
          ok = await enviar(p);
        } finally {
          /* Se calculó el informe y se intentó entregarlo: el período está procesado,
           * salga o no el correo. Si `enviar()` tiró (la consulta o el SMTP), el catch
           * de afuera lo registra; lo que no puede pasar es reintentar en bucle. */
          await marcarCorrido(p);
        }
        if (ok) log.info('informe programado enviado', { id: p.id, nombre: p.nombre });
        else log.error('informe programado NO enviado: revisá la regla ccreport.scheduled, el SMTP y los destinatarios', { id: p.id, nombre: p.nombre });
      } catch (e) { log.error('informe programado', { id: p.id }, e); }
    }
    await podar();
  }

  /* Poda de eventos viejos. Igual criterio que pbxng_sec_events: el informe no necesita
   * cinco años de historia y la tabla crece con cada llamada de cola. */
  let podadoAt = 0;
  async function podar() {
    if (Date.now() - podadoAt < 6 * 3600e3) return;
    podadoAt = Date.now();
    try {
      const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='cc_retencion_dias'");
      const d = parseInt(rows[0] && rows[0].value, 10);
      if (!Number.isFinite(d) || d <= 0) return;
      const r = await pool.query("DELETE FROM pbxng_queue_events WHERE ts < now() - ($1::int || ' days')::interval", [d]);
      if (r.rowCount) log.info('eventos de cola podados', { filas: r.rowCount, retencion_dias: d });
    } catch (e) { log.error('poda de eventos de cola', e); }
  }

  /* Mismo pulso que alerts.js: una vuelta por minuto alcanza para una hora de envío. */
  /* `unref()`: estos dos relojes no tienen que sostener solos el bucle de eventos. En la
   * central lo sostiene el `listen()` de Express y siguen corriendo igual; en las pruebas
   * el módulo se carga sin servidor y, sin esto, el proceso no terminaba nunca. */
  setInterval(() => { tick().catch((e) => log.error('tick', e)); }, 60000).unref();
  setTimeout(() => { podar().catch(() => {}); }, 45000).unref();

  /* `volcar` y `pendientes` se devuelven para la prueba del consumidor (test/ccreport-consumidor.test.js):
   * es la única forma de verificar el techo sin depender del reloj. */
  return { metricas, filasCsv, tick, ventana, toca, volcar, pendientes };
};
