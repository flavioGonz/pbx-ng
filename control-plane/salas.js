/* ============================================================================
 *  PBX-NG · Salas de reunión (ítem 9 de docs/BRECHA-UCM-XORCOM.md).
 *
 *  Antes había «conferencias»: una fila con nombre, número y un PIN opcional, y un
 *  dialplan de cuatro líneas (Answer · Authenticate · ConfBridge · Hangup). Eso alcanza
 *  para una demo y no para vender: no había moderador, no había tope de participantes,
 *  el primero en llegar escuchaba silencio, nadie sabía quién estaba adentro y la sala
 *  quedaba abierta las 24 horas aunque la reunión fuera el martes a las 10.
 *
 *  Acá la sala es un objeto administrable: dos PIN (participante y moderador, distintos),
 *  tope de participantes, música en espera hasta que entre el moderador, anuncio de
 *  entrada/salida, grabación opcional, una reunión agendada y la invitación por correo.
 *
 *  POR QUÉ NO SE TOCA confbridge.conf: todo lo que ConfBridge necesita saber se le dice
 *  con la función CONFBRIDGE() DESDE EL DIALPLAN (perfiles al vuelo, sobre default_user /
 *  default_bridge). Un perfil por sala en `pbxng.d/` obligaría a un `module reload
 *  app_confbridge` por cada cambio —que además desarma los perfiles de las salas que están
 *  reunidas en ese momento— y a que docker/config/asterisk/confbridge.conf aprendiera un
 *  `#include` que hoy no tiene (eso es del agente telefonia, no de la API).
 *
 *  POR QUÉ LOS PIN Y LA VENTANA VIVEN TAMBIÉN EN LA AstDB: el dialplan no consulta
 *  PostgreSQL. Igual que los desvíos de telefonia.js, la fuente de verdad es Postgres y el
 *  estado caliente se lee con DB(familia/clave) —DB() SIEMPRE con familia Y clave—:
 *    sala/<nombre>    = 1 abierta · 0 fuera de la ventana agendada
 *    salapin/<nombre> = PIN de participante
 *    salamod/<nombre> = PIN de moderador
 *  Así cambiar un PIN o que se abra la reunión es un DBPut por AMI: no reescribe el
 *  dialplan, no corta a nadie y funciona con la sala llena. `syncSalas()` vuelca
 *  Postgres → AstDB al arrancar y en cada reconexión del AMI (red por si la astdb quedó
 *  desincronizada de Postgres; desde 1.11.0 tiene volumen propio y ya no nace vacía al
 *  recrear el contenedor de Asterisk).
 *
 *  Acceso (rbac.js): ver la lista y la vista en vivo, silenciar y expulsar es OPERACIÓN
 *  (admin + supervisor: es lo que hace el que modera la reunión desde el panel). Crear,
 *  editar, borrar e invitar es configuración → admin (cae al default deny-by-default).
 *  Los DOS PIN son lo único que no viaja en la lista: salen por el detalle
 *  `GET /api/salas/:name`, que es admin. Con el PIN de moderador se entra a la reunión y
 *  se silencia y expulsa, así que darlo en un listado de supervisor es regalar el control
 *  de la reunión —la misma razón por la que `invitar` quedó en admin—.
 * ==========================================================================*/
'use strict';

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const emails = require('./emails');

/**
 * deps:
 *   app            Express (las rutas se registran acá, DESPUÉS del gate de auth + RBAC)
 *   pool           pg.Pool
 *   amiAction      (action) => respuesta AMI: DBPut/DBDel y las acciones Confbridge*
 *   setDialplan    (client, context, exten, rows) escribe una extensión en el dialplan realtime (app.js)
 *   smtpHint       (err) => mensaje entendible de un fallo SMTP (app.js, Configuración → Correo)
 *   errorHttp      traduce errores a {error} con status (errores.js)
 *   broadcastSoon  refresca el snapshot del socket tras cambiar una sala
 *   logger         fábrica de loggers de log.js
 *
 * Devuelve: { syncSalas, salaDialplan, ventanaAbierta, republicarDialplan } (los dos del
 * medio, puros, para las pruebas; el último se dispara solo al arrancar y se expone para
 * poder forzarlo).
 */
module.exports = function init(deps) {
  const { app, pool, amiAction, setDialplan, smtpHint, errorHttp, broadcastSoon, logger } = deps;
  const log = logger ? logger('salas') : { info() {}, warn() {}, error() {} };

  const err = (status, msg) => Object.assign(new Error(msg), { status });

  /* ── Listas blancas ───────────────────────────────────────────────────────
   * TODO esto termina dentro del dialplan (nombre de la sala en ConfBridge(), número en
   * la extensión, PIN en una comparación de $[…]). Ya nos pasó con los desvíos: un valor
   * con `*` o con una coma deja de ser un dato y pasa a ser sintaxis —una coma en el
   * nombre convierte `ConfBridge(sala)` en `ConfBridge(sala,perfil_de_bridge,…)` y el que
   * llama elige el perfil, incluido uno con grabación o sin tope—. Dígitos y letras. */
  const NOMBRE = /^[A-Za-z0-9_-]{1,32}$/;
  const NUMERO = /^[0-9]{2,10}$/;
  const PIN = /^[0-9]{4,10}$/;
  const PROMPT = /^[A-Za-z0-9_/-]{1,64}$/;
  const CORREO = /^[^\s@,;]+@[^\s@,;.]+\.[^\s@,;]{2,}$/;
  /* El canal viene del propio ConfbridgeList, pero igual se valida antes de mandarlo por
   * AMI: un Channel con \r\n mete una acción AMI extra (inyección de cabeceras). */
  const CANAL = /^[A-Za-z0-9_./:@-]{1,80}$/;
  /* La etiqueta sólo se muestra (NoOp del dialplan y correo), pero el `$` se le saca:
   * dentro del dialplan `${...}` se sustituye y lo que se lee en el log deja de ser lo
   * que escribió el operador. */
  const etiqueta = (s) => String(s || '').replace(/[$"',\r\n]/g, ' ').trim().slice(0, 60);

  /* PIN al azar de 6 dígitos, con crypto (Math.random no sirve para un secreto que abre
   * una reunión de directorio). Se permiten ceros a la izquierda: el usuario los marca. */
  const pinNuevo = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

  // ── AstDB ─────────────────────────────────────────────────────────────────
  /* El guardado NO se cae por un AMI caído (la verdad sigue en Postgres y syncSalas() la
   * vuelve a volcar al reconectar), pero el error se REGISTRA y el resultado vuelve al que
   * llamó: el `catch (_) {}` mudo de antes dejaba una sala que en el panel figuraba con PIN
   * nuevo y en la central seguía abriéndose con el viejo, sin una sola línea de log. */
  async function astPut(family, key, val) {
    try { await amiAction({ Action: 'DBPut', Family: family, Key: String(key), Val: String(val) }); return true; }
    catch (e) { log.error('AstDB: no se pudo escribir ' + family + '/' + key, e); return false; }
  }
  async function astDel(family, key) {
    try { await amiAction({ Action: 'DBDel', Family: family, Key: String(key) }); return true; }
    catch (e) { log.error('AstDB: no se pudo borrar ' + family + '/' + key, e); return false; }
  }
  const AVISO_ASTDB = 'Guardado en la base, pero Asterisk no tomó el cambio (AMI caído): se aplica solo cuando la central vuelva.';
  /* Un PIN vacío NO se escribe: se borra la clave. En telefonia.js una clave ausente es
   * «sin desvío» y no pasa nada, pero acá `DB(salamod/<sala>)` vacío contra un SALAPIN
   * vacío daba $[""=""] → verdadero, o sea que el que se quedaba callado entraba de
   * MODERADOR. Sin clave la sala queda cerrada (que es el lado seguro del error) y el
   * dialplan además rechaza el PIN vacío antes de comparar. */
  async function astPin(family, key, val) {
    const v = String(val === undefined || val === null ? '' : val).trim();
    return v ? await astPut(family, key, v) : await astDel(family, key);
  }

  // ── Agenda ────────────────────────────────────────────────────────────────
  /* ¿La sala está abierta AHORA? Sin agenda, siempre. Con agenda, sólo dentro de
   * [inicio, inicio + duración). La cuenta se hace acá y el resultado (1/0) va a la AstDB:
   * el dialplan no sabe de fechas, sólo pregunta si está abierta. */
  function ventanaAbierta(sala, ahora = new Date()) {
    if (!sala || !sala.agenda_inicio) return true;
    const ini = new Date(sala.agenda_inicio).getTime();
    if (isNaN(ini)) return true;
    const min = Math.max(1, parseInt(sala.agenda_min, 10) || 60);
    const t = ahora.getTime();
    return t >= ini && t < ini + min * 60000;
  }

  /* Estado ya publicado en la AstDB, para no repetir el DBPut cada 30 s por sala. */
  const publicado = new Map();
  async function publicarEstado(sala) {
    const abierta = ventanaAbierta(sala) ? '1' : '0';
    if (publicado.get(sala.name) !== abierta) {
      /* Sólo se anota como publicado si el DBPut SALIÓ. Antes se anotaba igual, así que un
       * AMI caído en el momento justo dejaba la sala agendada abierta (o cerrada) para
       * siempre: el reloj de la agenda comparaba contra este caché y no volvía a intentar. */
      if (await astPut('sala', sala.name, abierta)) publicado.set(sala.name, abierta);
      else publicado.delete(sala.name);
    }
    return abierta === '1';
  }

  /* Postgres → AstDB. Se llama al arrancar y en cada reconexión del AMI (app.js lo mete en
   * `resincronizar`), y también después de guardar una sala. */
  async function syncSalas() {
    try {
      const { rows } = await pool.query('SELECT name, pin, pin_mod, agenda_inicio, agenda_min FROM pbxng_conferences');
      publicado.clear();
      for (const s of rows) {
        await astPin('salapin', s.name, s.pin);
        await astPin('salamod', s.name, s.pin_mod);
        await publicarEstado(s);
      }
    } catch (e) { log.warn('sync', e.message); }
  }

  /* ── Republicar el dialplan de las salas que ya existían ──────────────────
   * Una sala creada con 1.9.x tiene el dialplan viejo de `conferences`: Answer ·
   * Authenticate · ConfBridge · Hangup. Nada de lo que agrega esta versión (tope de
   * participantes, grabación, música hasta el moderador, anuncios, agenda, PIN contra la
   * AstDB) le aplica hasta que alguien entre al panel y la edite una por una — y el
   * administrador no tiene forma de saber cuáles le faltan.
   *
   * Así que se republica al arrancar, desde lo que dice Postgres, que es la fuente de
   * verdad: el dialplan generado refleja la fila TAL CUAL está (una sala sin PIN sigue
   * sin pedir PIN, ver salaDialplan). Se compara antes de escribir para no hacer un
   * DELETE + INSERT en cada arranque cuando ya está al día: las salas son pocas, pero
   * esta tabla la lee Asterisk en vivo.
   *
   * Va acá y no en la migración 0014 a propósito: generar este dialplan es lógica de
   * `salas.js` (prioridades, perfiles de ConfBridge, claves de la AstDB), no algo que se
   * pueda escribir a mano en un UPDATE sin condenarse a mantenerlo en dos lugares. */
  async function republicarDialplan() {
    const { rows: salas } = await pool.query('SELECT ' + CAMPOS + ' FROM pbxng_conferences');
    let hechas = 0;
    for (const s of salas) {
      try {
        const plan = salaDialplan(s);
        const { rows: actual } = await pool.query(
          "SELECT priority, app, appdata FROM extensions WHERE context='ivr' AND exten=$1 ORDER BY priority", [s.access_exten]);
        const igual = actual.length === plan.length && plan.every((r, i) =>
          Number(actual[i].priority) === Number(r[0]) && actual[i].app === r[1] && String(actual[i].appdata || '') === String(r[2] || ''));
        if (igual) continue;
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await setDialplan(c, 'ivr', s.access_exten, plan);
          await c.query('COMMIT');
        } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
        finally { c.release(); }
        hechas++;
        log.info('dialplan de sala republicado', { sala: s.name, numero: s.access_exten, tiene_pin: !!(s.pin || s.pin_mod) });
      } catch (e) { log.warn('no se pudo republicar el dialplan de la sala ' + s.name, e.message); }
    }
    /* Las salas sin PIN se nombran una sola vez en el arranque: el panel las marca igual,
     * pero el que mira el log de la actualización también tiene que verlas. */
    const sinPinAlguno = salas.filter((s) => !String(s.pin || '').trim() && !String(s.pin_mod || '').trim()).map((s) => s.name);
    if (sinPinAlguno.length) {
      log.warn('salas sin PIN: se entra sin marcar nada (se respeta como estaba; para ponerle PIN, editala en el panel)', { salas: sinPinAlguno });
    }
    if (hechas) log.info('salas republicadas', { salas: hechas });
    return hechas;
  }

  /* Reloj de la agenda: abre y cierra las salas agendadas sin que nadie toque nada. 30 s
   * es suficiente (una reunión no empieza al segundo) y sólo escribe cuando cambia. */
  const AGENDA_MS = Math.max(10000, parseInt(process.env.SALAS_AGENDA_MS, 10) || 30000);
  const relojAgenda = setInterval(async () => {
    try {
      const { rows } = await pool.query('SELECT name, agenda_inicio, agenda_min FROM pbxng_conferences WHERE agenda_inicio IS NOT NULL');
      for (const s of rows) await publicarEstado(s);
    } catch (_) {}
  }, AGENDA_MS);
  relojAgenda.unref();

  // ── Dialplan ──────────────────────────────────────────────────────────────
  /* Una sala = una extensión en el contexto `ivr` (igual que colas, IVR y grupos).
   *
   * El plan, en orden: ¿está abierta? → perfil del bridge (tope, grabación) → PIN →
   * según qué PIN marcó, entra como participante o como moderador. Los dos PIN se
   * comparan contra la AstDB, así cambiarlos NO reescribe esta extensión.
   *
   * Sin etiquetas (`setDialplan` sólo escribe prioridad/app/appdata), así que los saltos
   * son números fijos: 20 = participante, 40 = moderador. El bloque de arriba nunca pasa
   * de 12 prioridades, así que no puede pisarlos. */
  function salaDialplan(s) {
    const rows = [];
    const nom = s.name;
    /* Salas heredadas: `pin` vacío o NULL es «esta sala no pide PIN», una decisión que
     * alguien tomó (la de recepción, la de soporte) y que la migración 0014 respeta a
     * propósito. El dialplan tiene que decir lo mismo que la base: si se pidiera un PIN
     * que no existe, la sala quedaría inaccesible (el PIN vacío se rechaza antes de
     * comparar), y si se le inventara uno, nadie lo sabría. */
    const pin = String(s.pin === undefined || s.pin === null ? '' : s.pin).trim();
    const pinMod = String(s.pin_mod === undefined || s.pin_mod === null ? '' : s.pin_mod).trim();
    const maxdig = Math.max(pin.length, pinMod.length) || 6;
    /* Prioridades fijas para los tres destinos, así el salto no depende de cuántas
     * opciones tenga la sala: 4 = fuera de la ventana, 6 = entrada, 20 = participante,
     * 40 = moderador. Del 6 en adelante nunca hay más de diez prioridades. */
    const CERRADA = 4, ENTRADA = 6, PARTICIPANTE = 20, MODERADOR = 40;
    rows.push([1, 'NoOp', 'Sala de reunion ' + nom + ' (' + (etiqueta(s.label) || nom) + ')']);
    rows.push([2, 'Answer', '']);
    // La agenda la resuelve la API y la deja en DB(sala/<nombre>); acá sólo se pregunta.
    rows.push([3, 'GotoIf', '$["${DB(sala/' + nom + ')}"="0"]?' + CERRADA + ':' + ENTRADA]);
    rows.push([CERRADA, 'Playback', s.aviso_cerrada || 'conf-locked']);
    rows.push([CERRADA + 1, 'Hangup', '']);
    let p = ENTRADA;
    // Perfil del bridge: lo fija el primero que entra y vale para toda la sala.
    if (Number(s.max_part) > 0) rows.push([p++, 'Set', 'CONFBRIDGE(bridge,max_members)=' + parseInt(s.max_part, 10)]);
    if (s.grabar) {
      rows.push([p++, 'Set', 'CONFBRIDGE(bridge,record_conference)=yes']);
      /* Nombre `pbxng-sala<numero>-<epoch>.wav` a propósito: es el patrón que ya indexa
       * recordings.js (`pbxng-<alnum>-<epoch>.wav`), así la reunión aparece en Grabaciones
       * como cualquier otra llamada en vez de quedar suelta en el volumen. */
      rows.push([p++, 'Set', 'CONFBRIDGE(bridge,record_file)=/var/spool/asterisk/monitor/pbxng-sala' + s.access_exten + '-${EPOCH}.wav']);
    }
    if (!pin && !pinMod) {
      /* Sala sin ningún PIN: se entra derecho, igual que con el dialplan viejo de
       * `conferences` (Answer · ConfBridge). Lo que cambia es todo lo demás —tope,
       * grabación, música hasta el moderador, anuncios, agenda—, que ahora sí le aplica. */
      rows.push([p, 'Goto', String(PARTICIPANTE)]);
    } else if (!pin) {
      /* Sólo PIN de moderador: el que no marca nada (o marca cualquier cosa) entra de
       * participante, que es lo que significa «sin PIN de participante»; el que marca el
       * del moderador, entra de moderador. Un intento y 5 s: al participante no se lo
       * puede dejar escuchando silencio veinte segundos por una clave que no tiene. */
      rows.push([p++, 'Read', 'SALAPIN,conf-getpin,' + maxdig + ',,1,5']);
      rows.push([p++, 'GotoIf', '$["${SALAPIN}"=""]?' + PARTICIPANTE]);
      rows.push([p++, 'GotoIf', '$["${SALAPIN}"="${DB(salamod/' + nom + ')}"]?' + MODERADOR]);
      rows.push([p, 'Goto', String(PARTICIPANTE)]);
    } else {
      // PIN: dos intentos, 10 s cada uno. `conf-getpin` es el prompt de fábrica de Asterisk.
      rows.push([p++, 'Read', 'SALAPIN,conf-getpin,' + maxdig + ',,2,10']);
      /* El PIN vacío se rechaza ANTES de comparar. Si `Read` se queda sin dígitos (el que
       * llama no marca nada) SALAPIN queda en "", y si además falta la clave en la AstDB
       * —una sala guardada con el AMI caído, o un PIN NULL en la columna— la comparación
       * daba $[""=""] = verdadero contra `salamod` y el silencio entraba de MODERADOR
       * (admin + marked: silencia y expulsa). Nada de comparar contra el vacío. */
      const INVALIDO = p + (pinMod ? 3 : 2);   // los GotoIf que siguen; el bloque cae justo después
      rows.push([p++, 'GotoIf', '$["${SALAPIN}"=""]?' + INVALIDO]);
      // Sin PIN de moderador no se publica la comparación: no hay forma de entrar como tal.
      if (pinMod) rows.push([p++, 'GotoIf', '$["${SALAPIN}"="${DB(salamod/' + nom + ')}"]?' + MODERADOR]);
      rows.push([p++, 'GotoIf', '$["${SALAPIN}"="${DB(salapin/' + nom + ')}"]?' + PARTICIPANTE]);
      rows.push([p++, 'Playback', 'conf-invalidpin']);
      rows.push([p, 'Hangup', '']);
    }

    const comunes = (moderador) => {
      const out = [];
      if (s.anunciar) out.push(['Set', 'CONFBRIDGE(user,announce_join_leave)=yes']);
      if (s.moh_hasta_moderador) {
        /* El que llega antes que el moderador escucha música, no silencio. `wait_marked`
         * lo deja fuera del mezclador hasta que entra un usuario `marked` (el moderador),
         * y `music_on_hold_when_empty` es lo que suena mientras tanto.
         *
         * `wait_marked` SÓLO si la sala tiene PIN de moderador: en una sala heredada sin
         * PIN nadie puede entrar como `marked`, así que la espera no terminaría nunca y
         * toda la reunión se quedaría escuchando música. La música cuando la sala está
         * vacía no molesta a nadie y se deja igual. */
        out.push(['Set', 'CONFBRIDGE(user,music_on_hold_when_empty)=yes']);
        if (!moderador && pinMod) out.push(['Set', 'CONFBRIDGE(user,wait_marked)=yes']);
      }
      if (moderador) {
        out.push(['Set', 'CONFBRIDGE(user,admin)=yes']);
        out.push(['Set', 'CONFBRIDGE(user,marked)=yes']);
      }
      out.push(['ConfBridge', nom]);
      out.push(['Hangup', '']);
      return out;
    };
    let q = PARTICIPANTE;
    rows.push([q++, 'NoOp', 'Participante de ' + nom]);
    for (const [a, d] of comunes(false)) rows.push([q++, a, d]);
    /* Sin PIN de moderador no hay salto que caiga acá: publicar el bloque sería dejar en
     * la tabla realtime una entrada de admin que nadie alcanza (y que un `Goto` mal
     * escrito mañana sí alcanzaría). */
    if (pinMod) {
      q = MODERADOR;
      rows.push([q++, 'NoOp', 'Moderador de ' + nom]);
      for (const [a, d] of comunes(true)) rows.push([q++, a, d]);
    }
    return rows;
  }

  // ── Validación y guardado ─────────────────────────────────────────────────
  const CAMPOS = 'id, name, label, access_exten, pin, pin_mod, max_part, moh_hasta_moderador, anunciar, grabar, agenda_inicio, agenda_min, aviso_cerrada, invitados, invitado_at, tenant_id';

  function normalizar(b, previa) {
    const s = {};
    s.name = String((b.name !== undefined ? b.name : (previa && previa.name)) || '').trim();
    if (!NOMBRE.test(s.name)) throw err(400, 'el nombre de la sala sólo admite letras, números, guion y guion bajo (hasta 32)');
    s.access_exten = String((b.access_exten !== undefined ? b.access_exten : (previa && previa.access_exten)) || '').trim();
    if (!NUMERO.test(s.access_exten)) throw err(400, 'el número de la sala tiene que ser de 2 a 10 dígitos');
    s.label = etiqueta(b.label !== undefined ? b.label : (previa && previa.label)) || s.name;

    /* PIN al azar si no vienen: una sala nueva NUNCA nace sin PIN ni con un PIN adivinable
     * (con los buzones ya vimos a dónde lleva «el PIN es el número del interno»). */
    const tomar = (v, ant) => {
      const x = String(v === undefined || v === null || v === '' ? (ant || '') : v).trim();
      return x || pinNuevo();
    };
    s.pin = tomar(b.pin, previa && previa.pin);
    s.pin_mod = tomar(b.pin_mod, previa && previa.pin_mod);
    if (!PIN.test(s.pin) || !PIN.test(s.pin_mod)) throw err(400, 'los PIN tienen que ser de 4 a 10 dígitos');
    if (s.pin === s.pin_mod) throw err(400, 'el PIN del moderador tiene que ser distinto al de los participantes');
    if (s.pin === s.access_exten || s.pin_mod === s.access_exten) throw err(400, 'el PIN no puede ser el número de la sala');

    const n = (v, ant, def) => { const x = (v === undefined || v === null || v === '') ? ant : v; const i = parseInt(x, 10); return isNaN(i) ? def : i; };
    s.max_part = Math.max(0, Math.min(500, n(b.max_part, previa && previa.max_part, 0)));
    const bool = (v, ant, def) => (v === undefined || v === null || v === '' ? (ant === undefined || ant === null ? def : !!ant) : !!v);
    s.moh_hasta_moderador = bool(b.moh_hasta_moderador, previa && previa.moh_hasta_moderador, true);
    s.anunciar = bool(b.anunciar, previa && previa.anunciar, true);
    s.grabar = bool(b.grabar, previa && previa.grabar, false);
    s.aviso_cerrada = String((b.aviso_cerrada !== undefined ? b.aviso_cerrada : (previa && previa.aviso_cerrada)) || 'conf-locked').trim();
    if (!PROMPT.test(s.aviso_cerrada)) throw err(400, 'el aviso de sala cerrada tiene que ser el nombre de un audio de Asterisk');

    // Agenda: las dos cosas o ninguna. `agenda_inicio: null` borra la agenda (sala abierta).
    const ini = b.agenda_inicio !== undefined ? b.agenda_inicio : (previa && previa.agenda_inicio);
    if (ini === null || ini === '' || ini === undefined) { s.agenda_inicio = null; s.agenda_min = null; }
    else {
      const d = new Date(ini);
      if (isNaN(d.getTime())) throw err(400, 'la fecha y hora de la reunión no es válida');
      s.agenda_inicio = d.toISOString();
      s.agenda_min = Math.max(5, Math.min(24 * 60, n(b.agenda_min, previa && previa.agenda_min, 60)));
    }
    return s;
  }

  async function guardar(b, creando, nombrePrevio) {
    let previa = null;
    if (!creando) {
      const { rows } = await pool.query('SELECT ' + CAMPOS + ' FROM pbxng_conferences WHERE name=$1', [nombrePrevio]);
      previa = rows[0];
      if (!previa) throw err(404, 'no existe la sala ' + nombrePrevio);
    }
    const s = normalizar(b, previa);
    /* El número de la sala no puede ser el de otra aplicación: el dialplan realtime no
     * avisa, simplemente gana una de las dos y la otra deja de existir. */
    const { rows: choque } = await pool.query(
      "SELECT name FROM pbxng_conferences WHERE access_exten=$1 AND name<>$2", [s.access_exten, previa ? previa.name : '']);
    if (choque.length) throw err(409, 'el número ' + s.access_exten + ' ya lo usa la sala ' + choque[0].name);

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (creando) {
        await c.query(`INSERT INTO pbxng_conferences
            (name,label,access_exten,pin,pin_mod,max_part,moh_hasta_moderador,anunciar,grabar,agenda_inicio,agenda_min,aviso_cerrada,tenant_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [s.name, s.label, s.access_exten, s.pin, s.pin_mod, s.max_part, s.moh_hasta_moderador, s.anunciar, s.grabar,
          s.agenda_inicio, s.agenda_min, s.aviso_cerrada, b.tenant_id || 1]);
      } else {
        await c.query(`UPDATE pbxng_conferences SET
            name=$2, label=$3, access_exten=$4, pin=$5, pin_mod=$6, max_part=$7, moh_hasta_moderador=$8,
            anunciar=$9, grabar=$10, agenda_inicio=$11, agenda_min=$12, aviso_cerrada=$13
          WHERE name=$1`,
        [previa.name, s.name, s.label, s.access_exten, s.pin, s.pin_mod, s.max_part, s.moh_hasta_moderador,
          s.anunciar, s.grabar, s.agenda_inicio, s.agenda_min, s.aviso_cerrada]);
        /* Si cambió el número, la extensión vieja queda apuntando a la sala: hay que
         * borrarla o el número anterior sigue entrando a la reunión sin pedir nada. */
        if (previa.access_exten !== s.access_exten) {
          await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [previa.access_exten]);
        }
      }
      await setDialplan(c, 'ivr', s.access_exten, salaDialplan(s));
      await c.query('COMMIT');
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }

    // Postgres ya está: ahora el estado caliente. Si el AMI está caído, syncSalas() lo arregla.
    if (!creando && nombrePrevio !== s.name) {
      for (const f of ['sala', 'salapin', 'salamod']) await astDel(f, nombrePrevio);
      publicado.delete(nombrePrevio);
    }
    const okPin = await astPin('salapin', s.name, s.pin);
    const okMod = await astPin('salamod', s.name, s.pin_mod);
    publicado.delete(s.name);
    await publicarEstado(s);
    broadcastSoon && broadcastSoon();
    const out = await leerSala(s.name);
    /* Sin esto, cambiar el PIN de una sala con el AMI caído se veía como un guardado
     * perfecto y la reunión seguía abriéndose con el PIN anterior —justo el que se estaba
     * cambiando porque se filtró—. La sala queda guardada igual (Postgres manda), pero el
     * que apretó Guardar tiene que saber que todavía no está en la central. */
    if (out && !(okPin && okMod)) { out.aviso = AVISO_ASTDB; log.warn('sala guardada sin llegar a la AstDB', { sala: s.name }); }
    return out;
  }

  async function leerSala(name) {
    const { rows } = await pool.query('SELECT ' + CAMPOS + ' FROM pbxng_conferences WHERE name=$1', [name]);
    if (!rows[0]) return null;
    return { ...rows[0], abierta: ventanaAbierta(rows[0]) };
  }

  // ── Vista en vivo (AMI Confbridge*) ───────────────────────────────────────
  /* Por qué AMI y no ARI: el motor ARI (callengine.js) ve CANALES y bridges, pero no sabe
   * qué canal está en qué conferencia ni quién es admin o está mudo, y no tiene forma de
   * silenciar a un participante de ConfBridge (mutear un canal de ARI no es lo mismo: no
   * avisa al bridge y el panel quedaría mostrando otra cosa). app_confbridge publica
   * exactamente eso por AMI: ConfbridgeList / ConfbridgeMute / ConfbridgeUnmute /
   * ConfbridgeKick. Es el mismo camino que ya usa el aparcado con ParkedCalls. */
  const evs = (r) => { const e = (r && (r.events || r.eventlist)) || []; return Array.isArray(e) ? e : []; };
  const campo = (e, ...ks) => { for (const k of ks) { if (e[k] !== undefined) return e[k]; if (e[k.toLowerCase()] !== undefined) return e[k.toLowerCase()]; } return ''; };
  const si = (v) => String(v || '').toLowerCase() === 'yes';

  async function participantes(name) {
    const r = await amiAction({ Action: 'ConfbridgeList', Conference: name });
    return evs(r)
      .filter((e) => String(campo(e, 'Event')).toLowerCase() === 'confbridgelist')
      .map((e) => ({
        canal: campo(e, 'Channel'),
        numero: campo(e, 'CallerIDNum'),
        nombre: campo(e, 'CallerIDName'),
        moderador: si(campo(e, 'Admin')),
        mudo: si(campo(e, 'MuteStatus')),
        desde: campo(e, 'AnsweredTime'),
      }));
  }

  /* Cuántos hay en cada sala, de una sola pasada (lo usa la lista). Una sala sin nadie
   * adentro no existe para ConfBridge: no aparece y eso es 0, no un error. */
  async function conteos() {
    const out = {};
    try {
      const r = await amiAction({ Action: 'ConfbridgeListRooms' });
      for (const e of evs(r)) {
        if (String(campo(e, 'Event')).toLowerCase() !== 'confbridgelistrooms') continue;
        out[campo(e, 'Conference')] = parseInt(campo(e, 'Parties'), 10) || 0;
      }
    } catch (_) {}
    return out;
  }

  /* El canal a silenciar o expulsar tiene que estar EN ESA SALA. Sin este chequeo, la ruta
   * es un «colgá cualquier canal de la central» con permiso de supervisor: alcanza con
   * mandar el nombre de un canal que esté en una llamada común. */
  async function canalDeLaSala(name, canal) {
    const ch = String(canal || '').trim();
    if (!CANAL.test(ch)) throw err(400, 'canal inválido');
    /* Sin AMI no hay forma de saber quién está adentro, y sin eso no se silencia ni se
     * expulsa a ciegas: es un 503 («ahora no se puede»), no un 500 con el error crudo. */
    let lista;
    try { lista = await participantes(name); }
    catch (_) { throw err(503, 'Asterisk no está disponible: no se puede ver quién está en la sala'); }
    const p = lista.find((x) => x.canal === ch);
    if (!p) throw err(404, 'ese canal no está en la sala');
    return p;
  }

  // ── Invitación por correo ─────────────────────────────────────────────────
  async function smtpFor(tenantId = 1) {
    const { rows } = await pool.query('SELECT host,port,secure,username,password,from_addr,enabled FROM pbxng_email_config WHERE tenant_id=$1', [tenantId]);
    const c = rows[0];
    return (c && c.enabled && c.host) ? c : null;
  }
  const setting = async (k, def) => { try { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return (rows[0] && rows[0].value) || def; } catch (_) { return def; } };

  // ── Rutas ─────────────────────────────────────────────────────────────────
  /* El LISTADO no lleva los PIN. Es rol supervisor (moderar la reunión desde el panel es
   * operación), y un PIN de moderador que se ve en una lista es exactamente lo que el
   * módulo evita al dejar `invitar` en admin: con ese PIN cualquiera entra a la reunión de
   * directorio, silencia y expulsa, y encima no queda rastro (invitar al menos escribe
   * `invitados`/`invitado_at`). Se devuelve `tiene_pin`, como salidaDisa() en marcacion.js.
   * Para moderar alcanza con live/mute/kick; los PIN salen sólo por el detalle (admin).
   *
   * Son DOS banderas y no una: una sala heredada de 1.9.x puede tener PIN de participante
   * y no de moderador, y decirle «Sin PIN» a esa sala es mentirle al administrador. El
   * panel las distingue y nombra arriba de la tabla las que no piden nada. */
  const sinPin = (s) => {
    const o = { ...s, tiene_pin: !!String(s.pin || '').trim(), tiene_pin_mod: !!String(s.pin_mod || '').trim() };
    delete o.pin; delete o.pin_mod; return o;
  };

  app.get('/api/salas', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT ' + CAMPOS + ' FROM pbxng_conferences ORDER BY access_exten');
      const dentro = await conteos();
      res.json(rows.map((s) => sinPin({ ...s, abierta: ventanaAbierta(s), participantes: dentro[s.name] || 0 })));
    } catch (e) { errorHttp(res, e); }
  });

  /* Detalle CON los dos PIN: admin (cae al default deny-by-default de rbac.js, y además
   * tiene su regla explícita). Es lo que usa el panel para editar una sala, ahora que el
   * listado no los trae. Va DESPUÉS de la lista y no tapa a `/live` (Express compara la
   * ruta completa), pero sí tiene que quedar antes que cualquier regla más general. */
  app.get('/api/salas/:name', async (req, res) => {
    try {
      const sala = await leerSala(req.params.name);
      if (!sala) return res.status(404).json({ error: 'no existe esa sala' });
      res.json(sala);
    } catch (e) { errorHttp(res, e); }
  });

  app.get('/api/salas/:name/live', async (req, res) => {
    try {
      const sala = await leerSala(req.params.name);
      if (!sala) return res.status(404).json({ error: 'no existe esa sala' });
      let lista = [], ami_ok = true;
      try { lista = await participantes(sala.name); } catch (_) { ami_ok = false; }
      res.json({ sala: sala.name, numero: sala.access_exten, abierta: sala.abierta, grabando: !!sala.grabar && lista.length > 0, ami: ami_ok, participantes: lista });
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/salas/:name/mute', async (req, res) => {
    try {
      const sala = await leerSala(req.params.name);
      if (!sala) return res.status(404).json({ error: 'no existe esa sala' });
      const p = await canalDeLaSala(sala.name, (req.body || {}).canal);
      const mudo = (req.body || {}).mudo !== false;
      await amiAction({ Action: mudo ? 'ConfbridgeMute' : 'ConfbridgeUnmute', Conference: sala.name, Channel: p.canal });
      res.json({ ok: true, canal: p.canal, mudo });
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/salas/:name/kick', async (req, res) => {
    try {
      const sala = await leerSala(req.params.name);
      if (!sala) return res.status(404).json({ error: 'no existe esa sala' });
      const p = await canalDeLaSala(sala.name, (req.body || {}).canal);
      await amiAction({ Action: 'ConfbridgeKick', Conference: sala.name, Channel: p.canal });
      log.info('expulsado ' + p.canal + ' de ' + sala.name + ' por ' + ((req.user && req.user.user) || '?'));
      res.json({ ok: true, canal: p.canal });
    } catch (e) { errorHttp(res, e); }
  });

  /* Invitación por correo. El PIN de MODERADOR sólo viaja a quien se invita como
   * moderador: mandarle a los 20 participantes el PIN que silencia y expulsa es regalar
   * el control de la reunión. */
  app.post('/api/salas/:name/invitar', async (req, res) => {
    try {
      const sala = await leerSala(req.params.name);
      if (!sala) return res.status(404).json({ error: 'no existe esa sala' });
      const b = req.body || {};
      const crudos = Array.isArray(b.destinatarios) ? b.destinatarios : String(b.destinatarios || '').split(/[,;\s]+/);
      const destinos = crudos.map((x) => String(x || '').trim()).filter(Boolean);
      if (!destinos.length) return res.status(400).json({ error: 'poné al menos un destinatario' });
      if (destinos.length > 50) return res.status(400).json({ error: 'hasta 50 destinatarios por invitación' });
      for (const d of destinos) if (!CORREO.test(d)) return res.status(400).json({ error: 'dirección inválida: ' + d });
      const comoModerador = b.moderador === true;

      const smtp = await smtpFor(sala.tenant_id || 1);
      if (!smtp) return res.status(400).json({ error: 'sin configuración SMTP activa (Configuración → Correo)' });
      const brand = await setting('brand_name', 'PBX-NG');
      const dom = await setting('domain', process.env.DOMAIN || '');
      const externo = await setting('sala_numero_externo', '');   // DID por el que se entra desde afuera, si lo hay

      const cuando = sala.agenda_inicio
        ? new Date(sala.agenda_inicio).toLocaleString('es-UY', { timeZone: process.env.TZ || 'America/Montevideo' })
        : null;
      const html = emails.meetingEmail({
        brand, sala: sala.label || sala.name, numero: sala.access_exten, externo,
        pin: comoModerador ? sala.pin_mod : sala.pin, moderador: comoModerador,
        cuando, duracion: sala.agenda_min, nota: etiqueta(b.mensaje),
        panelUrl: dom ? 'https://' + dom + '/salas' : '',
      });
      const asunto = 'Reunión: ' + (sala.label || sala.name) + (cuando ? ' · ' + cuando : '');
      const tx = nodemailer.createTransport({ host: smtp.host, port: smtp.port || 587, secure: !!smtp.secure, auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined });
      const texto = [
        'Te invitaron a la reunión «' + (sala.label || sala.name) + '».',
        'Marcá: ' + sala.access_exten + (externo ? ' (desde afuera: ' + externo + ')' : ''),
        'PIN' + (comoModerador ? ' de moderador' : '') + ': ' + (comoModerador ? sala.pin_mod : sala.pin),
        cuando ? 'Cuándo: ' + cuando + (sala.agenda_min ? ' (' + sala.agenda_min + ' minutos)' : '') : 'La sala está siempre disponible.',
      ].join('\n');

      /* Un correo por destinatario y no un `to` con los 20: así el PIN de uno no viaja con
       * la lista de direcciones de todos, y un rebote no tumba el resto del envío. */
      const enviados = [], fallados = [];
      for (const d of destinos) {
        try {
          await tx.sendMail({ from: smtp.from_addr || smtp.username, to: d, subject: asunto, html, text: texto });
          enviados.push(d);
        } catch (e) { fallados.push({ destino: d, error: smtpHint ? smtpHint(e) : e.message }); }
      }
      if (enviados.length) {
        const marca = enviados.map((d) => ({ email: d, moderador: comoModerador, at: new Date().toISOString() }));
        await pool.query('UPDATE pbxng_conferences SET invitados = COALESCE(invitados,\'[]\'::jsonb) || $2::jsonb, invitado_at = now() WHERE name=$1',
          [sala.name, JSON.stringify(marca)]);
      }
      res.status(fallados.length && !enviados.length ? 502 : 200).json({ enviados, fallados });
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/salas', async (req, res) => {
    try { res.status(201).json(await guardar(req.body || {}, true)); }
    catch (e) { errorHttp(res, e); }
  });

  app.put('/api/salas/:name', async (req, res) => {
    try { res.json(await guardar(req.body || {}, false, req.params.name)); }
    catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/salas/:name', async (req, res) => {
    const { name } = req.params;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('SELECT access_exten FROM pbxng_conferences WHERE name=$1', [name]);
      if (!rows[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'no existe esa sala' }); }
      await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].access_exten]);
      await c.query('DELETE FROM pbxng_conferences WHERE name=$1', [name]);
      await c.query('COMMIT');
      for (const f of ['sala', 'salapin', 'salamod']) await astDel(f, name);
      publicado.delete(name);
      broadcastSoon && broadcastSoon();
      res.json({ deleted: name });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} errorHttp(res, e); }
    finally { c.release(); }
  });

  /* Volcado inicial: el AMI puede haber conectado ANTES de que este módulo existiera
   * (mismo criterio y mismo retardo que telefonia.js), y sin esto una central recién
   * arrancada tendría las salas sin PIN en la AstDB hasta la próxima reconexión. En la
   * misma vuelta se republica el dialplan de las salas que ya existían, que para ese
   * momento ya tiene las migraciones aplicadas (docker-entrypoint las corre ANTES de
   * levantar la API).
   *
   * `unref()` por lo mismo que los relojes de ccreport.js: este temporizador no tiene que
   * sostener solo el bucle de eventos. En la central lo sostiene el `listen()` de Express
   * y corre igual; en las pruebas el módulo se carga sin servidor y, sin esto, el proceso
   * se quedaba nueve segundos esperándolo. */
  setTimeout(() => {
    /* Encadenadas, y en este orden: el dialplan nuevo compara lo que marcó el que llama
     * (`${SALAPIN}`) contra `${DB(salapin/<sala>)}`, y con la AstDB todavía vacía esa
     * comparación falla cerrado y la sala rechaza a TODO el mundo. Disparar las dos a la
     * vez dejaba una ventana —lo que tarde el volcado a la AstDB por AMI— en la que una
     * sala con PIN no dejaba entrar a nadie. Primero se escriben los PIN, después se
     * publica el dialplan que los lee. */
    syncSalas()
      .then(() => republicarDialplan())
      .catch((e) => log.warn('republicar salas', e.message));
  }, 9000).unref();

  return { syncSalas, salaDialplan, ventanaAbierta, republicarDialplan };
};
