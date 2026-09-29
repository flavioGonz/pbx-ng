/* ============================================================================
 *  PBX-NG · Estado en vivo de los internos (carril rápido del socket).
 *
 *  POR QUÉ ESTE MÓDULO EXISTE, aparte del `snapshot` que ya había.
 *
 *  El snapshot completo es CARO: arma la lista de internos leyendo `ps_endpoints`,
 *  `ps_contacts`, el directorio, y encima pide `pjsip show contacts` por la CLI del AMI
 *  para sacar la latencia. Eso está bien cada 15 s o cuando cambia la configuración, pero
 *  es exactamente lo que NO se puede hacer cada vez que un teléfono empieza a timbrar.
 *  Por eso el snapshot va con un freno de 300 ms y encima se saltea si el anterior sigue
 *  en curso: en una central con movimiento, el estado del interno llegaba tarde o no
 *  llegaba.
 *
 *  Acá va el carril rápido: un evento `estados` con SÓLO lo que cambió, sin tocar la base
 *  ni el AMI para armarlo (la información ya está en memoria), con un freno de 60 ms para
 *  no mandar un paquete por cada evento de una ráfaga. Un `DeviceStateChange` de Asterisk
 *  llega al navegador en el orden de la décima de segundo.
 *
 *  DE DÓNDE SALE CADA COSA:
 *    · qué está haciendo el aparato  → `DeviceStateChange` del AMI (el mismo estado que
 *      usa Asterisk para los hints de BLF: NOT_INUSE / RINGING / INUSE / RINGINUSE /
 *      ONHOLD / BUSY / UNAVAILABLE). Es el que empuja Asterisk en el instante en que pasa.
 *    · pausa de agente              → `QueueMemberPause`/`QueueMemberStatus` del AMI, y
 *      `queue_members.paused` como red de seguridad.
 *    · DND y desvíos                → `pbxng_ext_features` (Postgres es la fuente de
 *      verdad; el dialplan lee la AstDB, que es un espejo de eso).
 *
 *  La actividad y las marcas son COSAS DISTINTAS y se mandan por separado a propósito: un
 *  agente puede estar libre Y pausado, o en llamada Y con DND puesto para la próxima. El
 *  panel decide qué muestra primero; el servidor no le miente juntándolas en un solo campo.
 * ==========================================================================*/
'use strict';

/* El estado del dispositivo, traducido a lo que le importa a quien mira el panel. */
function actividadDe(d) {
  switch (String(d || '').toUpperCase().replace(/\s+/g, '_')) {
    case 'INUSE': case 'BUSY': return 'en_llamada';
    case 'RINGING': return 'timbrando';
    case 'RINGINUSE': return 'en_llamada_timbrando';
    case 'ONHOLD': return 'en_espera';
    case 'NOT_INUSE': return 'libre';
    default: return 'desconectado';   // UNAVAILABLE, INVALID, UNKNOWN, y lo que venga nuevo
  }
}
const extDeDispositivo = (d) => { const m = /^PJSIP\/([^-\s]+)$/.exec(String(d || '').trim()); return m ? m[1] : null; };
const extDeInterfaz = (i) => { const m = /^PJSIP\/([^-\s@]+)/.exec(String(i || '').trim()); return m ? m[1] : null; };
const campo = (e, k) => (e && (e[k] !== undefined ? e[k] : e[k.toLowerCase()] !== undefined ? e[k.toLowerCase()] : e[k.charAt(0).toUpperCase() + k.slice(1)]));

module.exports = function init(deps) {
  const { pool, ami, io, amiList, logger } = deps;
  const log = (logger ? logger('estados') : { info: () => {}, warn: () => {}, error: () => {} });

  const dev = new Map();      // ext -> estado crudo del dispositivo
  const marcas = new Map();   // ext -> { dnd, desvio, desvioA, pausa, pausaMotivo, colas }
  /* La pertenencia a colas y la pausa se llevan APARTE y salen de Asterisk, no de la base.
   * `queue_members` sólo tiene a los miembros permanentes: un agente que entra a la cola
   * en el momento (el `queue add member` de la CLI, o un login de agente) existe en
   * Asterisk y no en la tabla, y leyendo la tabla el panel lo daba por fuera de la cola —
   * y por lo tanto nunca pausado. Clave: ext -> Map(cola -> pausado). */
  const colas = new Map();
  const pendientes = new Set();
  let reloj = null;

  const vacio = { dnd: false, desvio: null, desvioA: null, pausa: false, pausaMotivo: '', colas: [] };
  function filaDe(ext) {
    const m = marcas.get(ext) || vacio;
    return {
      ext,
      dev: dev.get(ext) || null,
      act: actividadDe(dev.get(ext)),
      dnd: !!m.dnd,
      desvio: m.desvio || null,
      desvio_a: m.desvioA || null,
      pausa: !!m.pausa,
      pausa_motivo: m.pausaMotivo || '',
      colas: m.colas || [],
    };
  }
  function instantanea() {
    const internos = {};
    const todos = new Set([...dev.keys(), ...marcas.keys()]);
    for (const e of todos) internos[e] = filaDe(e);
    return { ts: Date.now(), completo: true, internos };
  }
  /* El freno es de 60 ms, no de 300 como el del snapshot: alcanza para juntar la ráfaga de
   * eventos de una sola llamada (Newchannel + DeviceStateChange + Newstate llegan casi
   * juntos) sin que se note la demora en pantalla. */
  function avisar(ext) {
    if (ext) pendientes.add(ext);
    if (reloj) return;
    reloj = setTimeout(() => {
      reloj = null;
      if (!pendientes.size) return;
      const internos = {};
      for (const e of pendientes) internos[e] = filaDe(e);
      pendientes.clear();
      try { io.to('state').emit('estados', { ts: Date.now(), internos }); } catch (_) {}
    }, 60);
  }

  function ponerDev(ext, estado) {
    if (!ext) return;
    const nuevo = String(estado || '').toUpperCase().replace(/\s+/g, '_');
    if (dev.get(ext) === nuevo) return;
    dev.set(ext, nuevo);
    avisar(ext);
  }
  function ponerMarca(ext, parcial) {
    if (!ext) return;
    const antes = marcas.get(ext) || { ...vacio };
    const despues = { ...antes, ...parcial };
    if (JSON.stringify(antes) === JSON.stringify(despues)) return;
    marcas.set(ext, despues);
    avisar(ext);
  }

  /* ---------- lo que vive en Postgres: DND, desvíos y pausa ---------- */
  async function releerMarcas() {
    try {
      const [{ rows: feats }, { rows: qm }] = await Promise.all([
        pool.query('SELECT ext, dnd, cfu, cfb, cfnr, fm FROM pbxng_ext_features'),
        pool.query("SELECT queue_name, interface, COALESCE(paused,0) AS paused FROM queue_members WHERE interface LIKE 'PJSIP/%'"),
      ]);
      const porExt = new Map();
      const tomar = (e) => { if (!porExt.has(e)) porExt.set(e, { ...vacio, colas: [] }); return porExt.get(e); };
      for (const f of feats) {
        const m = tomar(String(f.ext));
        m.dnd = !!f.dnd;
        /* Un solo desvío en la insignia, el que más manda: incondicional primero. `fm`
         * (sígueme) va último porque no corta la llamada acá, la duplica hacia otro lado. */
        if (f.cfu) { m.desvio = 'incondicional'; m.desvioA = String(f.cfu); }
        else if (f.cfb) { m.desvio = 'ocupado'; m.desvioA = String(f.cfb); }
        else if (f.cfnr) { m.desvio = 'sin_respuesta'; m.desvioA = String(f.cfnr); }
        else if (f.fm) { m.desvio = 'sigueme'; m.desvioA = String(f.fm); }
      }
      /* La tabla siembra a los miembros permanentes; lo que manda es lo que dice Asterisk
       * (ver `colas`), que además incluye a los que entraron en caliente. */
      for (const q of qm) {
        const e = extDeInterfaz(q.interface); if (!e) continue;
        if (!colas.has(e)) colas.set(e, new Map());
        const c = colas.get(e);
        if (!c.has(q.queue_name)) c.set(q.queue_name, Number(q.paused) === 1);
      }
      for (const e of colas.keys()) tomar(e);
      for (const [e, m] of porExt) {
        const c = colas.get(e);
        m.colas = c ? [...c.keys()] : [];
        /* Pausado = pausado en TODAS sus colas. Pausado en una y activo en otra sigue
         * atendiendo, así que decir «pausado» ahí sería mentira. */
        m.pausa = !!(c && c.size && [...c.values()].every(Boolean));
        const antes = marcas.get(e);
        m.pausaMotivo = (antes && m.pausa) ? (antes.pausaMotivo || '') : '';
        ponerMarca(e, m);
      }
      // Internos que dejaron de tener marcas (se les quitó el DND, salieron de la cola)
      for (const e of marcas.keys()) if (!porExt.has(e)) ponerMarca(e, { ...vacio });
    } catch (e) { log.warn('no se pudieron releer DND/desvíos/pausa: ' + (e && e.message)); }
  }

  /* ---------- sembrado: el estado de TODOS los dispositivos de una ---------- */
  async function sembrar() {
    try {
      const filas = await amiList({ Action: 'DeviceStateList' }, { evento: 'DeviceStateChange', fin: 'DeviceStateListComplete', ms: 6000 });
      let n = 0;
      for (const f of filas) { const e = extDeDispositivo(campo(f, 'Device')); if (e) { ponerDev(e, campo(f, 'State')); n++; } }
      log.info('estado de dispositivos sembrado desde el AMI', { internos: n });
    } catch (e) { log.warn('DeviceStateList falló: el estado se va llenando con los eventos (' + (e && e.message) + ')'); }
    /* Quién está en cada cola y quién está pausado, según Asterisk. Es lo que corrige la
     * foto después de un reinicio de la API: los eventos de cola que pasaron mientras no
     * estábamos no vuelven. */
    try {
      const filas = await amiList({ Action: 'QueueStatus' }, { evento: 'QueueMember', fin: 'QueueStatusComplete', ms: 6000 });
      const vistos = new Map();
      for (const f of filas) {
        const ext = extDeInterfaz(campo(f, 'Location') || campo(f, 'Interface')); if (!ext) continue;
        const cola = String(campo(f, 'Queue') || ''); if (!cola) continue;
        if (!vistos.has(ext)) vistos.set(ext, new Map());
        vistos.get(ext).set(cola, String(campo(f, 'Paused') || '0') === '1');
      }
      if (vistos.size) { colas.clear(); for (const [e, c] of vistos) colas.set(e, c); }
    } catch (e) { log.warn('QueueStatus falló: la pausa se lee de la base hasta el próximo evento (' + (e && e.message) + ')'); }
    await releerMarcas();
  }

  function iniciar() {
    ami.on('managerevent', (e) => {
      const ev = String((e && (e.event || e.Event)) || '').toLowerCase();
      if (ev === 'devicestatechange') { ponerDev(extDeDispositivo(campo(e, 'Device')), campo(e, 'State')); return; }
      if (ev === 'queuememberpause' || ev === 'queuememberstatus' || ev === 'queuememberadded' || ev === 'queuememberremoved') {
        const ext = extDeInterfaz(campo(e, 'Interface')); if (!ext) return;
        const cola = String(campo(e, 'Queue') || '');
        if (!colas.has(ext)) colas.set(ext, new Map());
        const c = colas.get(ext);
        if (ev === 'queuememberremoved') c.delete(cola);
        else if (cola) c.set(cola, String(campo(e, 'Paused') || '0') === '1');
        const motivo = String(campo(e, 'PausedReason') || '');
        const pausa = !!(c.size && [...c.values()].every(Boolean));
        ponerMarca(ext, { colas: [...c.keys()], pausa, pausaMotivo: pausa ? motivo : '' });
        return;
      }
    });
    /* Reconciliado lento por si se perdió un evento (reconexión del AMI, arranque de un
     * teléfono justo en el corte). Barato: dos consultas chicas y una lista del AMI. */
    setInterval(() => { releerMarcas(); }, 5000);
    setInterval(() => { sembrar(); }, 30000);
    setTimeout(() => { sembrar(); }, 2500);
  }

  return { iniciar, instantanea, releerMarcas, sembrar, filaDe };
};
