/* ============================================================================
 *  PBX-NG · Fax (ítem 7 de docs/BRECHA-UCM-XORCOM.md, bloque B): T.38 entrante y
 *  saliente, fax a correo y envío desde el panel. En Uruguay lo siguen pidiendo
 *  estudios contables, escribanías y organismos públicos.
 *
 *  CÓMO ESTÁ REPARTIDO EL TRABAJO
 *    Asterisk  habla con el otro módem: `ReceiveFAX` / `SendFAX` (res_fax +
 *              res_fax_spandsp) y escribe / lee un TIFF G3 en el volumen compartido.
 *    Esta API   convierte (PDF ⇄ TIFF con ghostscript / tiff2pdf), guarda el índice en
 *              Postgres, manda el correo y maneja la COLA de envío con reintentos.
 *    El panel   sube el PDF, elige el número y mira las dos bandejas.
 *
 *  POR QUÉ UNA COLA Y NO UN BOTÓN: un fax que no entra a la primera es lo normal
 *  (ocupado, del otro lado atiende una persona, el módem no engancha). Sin cola cada
 *  fallo obliga a volver a subir el PDF.
 *
 *  POR QUÉ EL AVISO DE FIN VIENE DEL DIALPLAN (`POST /api/internal/fax`): el resultado
 *  de un fax vive en `FAXOPT(status|statusstr|pages|error|remotestationid)`, que sólo
 *  existe en el canal. Mismo mecanismo (y mismos tres candados: loopback, sin cabecera
 *  de proxy y el token de /etc/pbxng/agent.token) que `internal/feature` de telefonia.js
 *  y `internal/disa` de marcacion.js. Y como una llamada se puede cortar justo antes de
 *  ese aviso, además hay un BARRIDO del directorio de entrada que importa el TIFF
 *  huérfano (misma idea que `indexRecordings` de recordings.js): un fax recibido no se
 *  pierde porque el que llamaba colgó dos segundos antes de tiempo.
 *
 *  T.38 Y EL SBC: el dialplan pide T.38 con la opción `z` pero SIEMPRE deja el respaldo
 *  en audio con `f`. Si adelante hay un SBC-NG que no pasa el reinvite —o la troncal no
 *  tiene T.38— el fax sale igual en G.711 en vez de cortarse. El caso "sin SBC" no
 *  cambia en nada: es exactamente el mismo dialplan.
 *
 *  LÍMITES (un PDF de 300 MB no puede voltear la central): el tamaño se corta en el
 *  parser (`express.raw`, tope duro `FAX_MAX_MB`), se comprueba la firma `%PDF-` antes de
 *  tocar nada, la conversión corre con `execFile` (NUNCA shell), con `-dSAFER`, con
 *  tiempo máximo y en un directorio nuestro, y recién después se cuenta la cantidad de
 *  páginas contra el tope configurado.
 *
 *  DEPENDENCIAS DE EMPAQUETADO (ver el informe del sprint): la imagen de Asterisk tiene
 *  que traer `res_fax` + `res_fax_spandsp` (libspandsp) y la de la API `ghostscript` y
 *  `libtiff-tools`. Mientras no estén, TODO esto funciona salvo la conversión: el estado
 *  (`GET /api/fax/estado`) lo dice con nombre y apellido y el panel lo muestra en rojo,
 *  el TIFF recibido se guarda igual y el correo sale con el TIFF adjunto.
 * ==========================================================================*/
'use strict';

const express = require('express');
/* `internal/fax-tx` vive en un contexto COMPARTIDO y `setDialplan()` es DELETE + INSERT:
 * quién puede ocupar cada extensión de `internal` lo contesta un solo lugar, el mismo que
 * usan telefonia.js, marcacion.js y trunks.js (ver el encabezado de `dueno-internal.js`). */
const dueno = require('./dueno-internal');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const nodemailer = require('nodemailer');
const emails = require('./emails');

/**
 * deps:
 *   app            Express (las rutas se registran acá, DESPUÉS del gate de auth + RBAC)
 *   pool           pg.Pool
 *   amiAction      (action) => respuesta AMI; se usa para el Originate del envío
 *   amiCommand     (cmd) => salida de consola; se usa para ver si res_fax está cargado
 *   setDialplan    (client, context, exten, rows) escribe una extensión en el dialplan realtime (app.js)
 *   clientIp       (req) => IP real del cliente (auth.js, respeta trust proxy)
 *   agentToken     secreto compartido con los agentes (/etc/pbxng/agent.token, app.js)
 *   smtpHint       traduce el error de nodemailer a algo accionable (app.js)
 *   errorHttp      traduce errores a {error} con status (errores.js)
 *   broadcastSoon  refresca el snapshot del socket
 *   logger         fábrica de loggers (log.js)
 *
 * Devuelve: { syncFax, filasRx, filasTx, paginasTiff } (los tres últimos son puros y se
 * exportan para poder probarlos sin base, sin Asterisk y sin ghostscript).
 */
module.exports = function init(deps) {
  const { app, pool, amiAction, amiCommand, setDialplan, clientIp, errorHttp, broadcastSoon, smtpHint, logger } = deps;
  const log = logger ? logger('fax') : { info() {}, warn() {}, error() {} };

  /* URL con la que ASTERISK ve a esta API (mismo criterio y misma variable que telefonia.js). */
  const API_URL = String(process.env.AST_API_URL || process.env.API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const API_BASE = /^https?:\/\//.test(API_URL) ? API_URL : 'http://' + API_URL;

  /* Los dos nombres del MISMO directorio: la API lo ve montado en `FAX_DIR` y Asterisk en
   * `FAX_DIR_AST`. Por defecto cuelga del volumen `recordings`, que ya está montado en los
   * dos contenedores (api rw en /recordings, asterisk en /var/spool/asterisk/monitor), así
   * que el fax funciona sin tocar el compose. El volumen propio está pedido a empaquetado;
   * el día que exista alcanza con cambiar estas dos variables.
   * `indexRecordings` de recordings.js sólo mira los .wav de la raíz de /recordings, así que
   * un subdirectorio con TIFF y PDF no le ensucia el índice de grabaciones.
   * El default cuelga de `REC_DIR` (misma variable que recstore.js/sysmon.js) y no de
   * '/recordings' literal: fuera del contenedor —las pruebas de integración— eso apunta a un
   * temporal, y si no la API crearía un /recordings en la raíz de la máquina de quien prueba. */
  const DIR = process.env.FAX_DIR || path.join(process.env.REC_DIR || '/recordings', 'fax');
  const DIR_AST = process.env.FAX_DIR_AST || '/var/spool/asterisk/monitor/fax';
  const DIR_IN = path.join(DIR, 'in');
  const DIR_OUT = path.join(DIR, 'out');
  /* Tope DURO de tamaño del PDF que se sube. Va acá y no en la configuración porque el
   * límite de `express.raw` se fija al registrar la ruta: la configuración puede BAJARLO
   * (se comprueba en el handler) pero nunca subirlo, así que nadie deja la central
   * recibiendo cuerpos de 300 MB editando una fila de la base. */
  const MAX_MB = Math.min(64, Math.max(1, parseInt(process.env.FAX_MAX_MB, 10) || 20));
  const TICK_MS = Math.max(5000, parseInt(process.env.FAX_TICK_MS, 10) || 20000);
  const CONV_MS = Math.max(10000, parseInt(process.env.FAX_CONVERT_MS, 10) || 120000);

  /* 0o777: el TIFF lo escribe Asterisk (otro contenedor, otro usuario) en un directorio
   * que crea la API. Con 0o755 el ReceiveFAX falla con "permission denied" y el fax se
   * pierde sin que nadie se entere hasta que el cliente reclama. */
  for (const d of [DIR, DIR_IN, DIR_OUT]) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o777 }); fs.chmodSync(d, 0o777); }
    catch (e) { log.warn('no se pudo preparar el directorio de fax ' + d + ': ' + (e && e.message)); }
  }

  const err = (status, msg) => Object.assign(new Error(msg), { status });

  // ── Listas blancas de todo lo que termina dentro del dialplan ─────────────
  /* Mismo motivo que en telefonia.js, trunks.js y marcacion.js: un destino con `*` dejaba
   * al que LLAMABA ejecutar códigos de función con su propia identidad (fraude de
   * tarifación). Un número de fax es un número marcable por la ruta saliente: dígitos. */
  const NUMERO = /^[0-9]{2,32}$/;
  /* CSID y cabecera se los anunciamos al otro aparato Y van crudos dentro de un
   * `Set(FAXOPT(...)=…)`: sin filtrar, una coma abre un argumento nuevo y un `${` deja
   * expandir variables del canal ajeno. */
  const LIMPIO = (s, n) => String(s == null ? '' : s).replace(/[^0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ .+()_-]/g, '').slice(0, n);
  const EMAILS = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+(\s*,\s*[^\s@,]+@[^\s@,]+\.[^\s@,]+)*$/;
  /* UNIQUEID de Asterisk: <epoch>.<secuencia>. Se valida porque con él se arma un nombre
   * de archivo; lo que viene del dialplan es de confianza limitada igual que todo lo demás. */
  const UID = /^[0-9]{8,14}\.[0-9]{1,8}$/;
  /* El TIFF entrante se llama `<caja>-<uniqueid>.tif` y NO `<uniqueid>.tif`. El motivo es el
   * barrido: cuando el que llamaba corta dos segundos antes del CURL final, el archivo
   * huérfano es lo único que queda, y antes se le adjudicaba a la caja de la detección de
   * tono — o sea, un fax entrado por el DID de la escribanía se le mandaba por correo a la
   * contaduría, con el PDF adjunto y sin dejar rastro de que fue a la caja equivocada.
   * Con la caja en el propio nombre el barrido la deduce del archivo; si no la puede
   * deducir, entra sin caja y sin correo. */
  const NOMBRE_TIFF = /^([0-9]{1,9})-([0-9]{8,14}\.[0-9]{1,8})\.tif$/;
  const tiffRx = (boxId, uid) => boxId + '-' + uid + '.tif';
  const T38_EC = ['none', 'fec', 'redundancy'];

  // ── El candado de lo que llama el dialplan (idéntico a telefonia.js / marcacion.js) ──
  function esLoopback(ip) {
    const s = String(ip || '').replace(/^::ffff:/i, '');
    return s === '::1' || s === '127.0.0.1' || /^127\./.test(s);
  }
  const TOKEN = String(deps.agentToken || '');
  const TOK_Q = TOKEN ? '&tok=' + encodeURIComponent(TOKEN) : '';
  function tokenOk(req) {
    const dado = Buffer.from(String((req.body || {}).tok || (req.query || {}).tok || ''), 'utf8');
    const esp = Buffer.from(TOKEN, 'utf8');
    return dado.length === esp.length && crypto.timingSafeEqual(dado, esp);
  }
  function soloDesdeLaCentral(req, res) {
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) { res.status(403).type('text/plain').send('no'); return false; }
    if (!esLoopback(clientIp(req))) { res.status(403).type('text/plain').send('no'); return false; }
    if (TOKEN && !tokenOk(req)) { res.status(403).type('text/plain').send('no'); return false; }
    return true;
  }
  const curlA = (ruta, qs) => '${CURL(' + API_BASE + ruta + ',' + qs + TOK_Q + ')}';

  /* Armador de filas con etiquetas `<<nombre>>` → prioridad real. Es el mismo de
   * marcacion.js y está acá por la misma razón: contar prioridades a mano funciona hasta
   * que alguien agrega una línea en el medio y corre todos los Goto sin que se note. */
  function armar(def) {
    const filas = [];
    const etq = Object.create(null);
    for (const f of def) {
      if (!f) continue;
      if (typeof f === 'string') { etq[f] = filas.length + 1; continue; }
      filas.push(f);
    }
    return filas.map((f, i) => {
      const data = String(f[1]).replace(/<<([a-z0-9_]+)>>/g, (m, k) => (etq[k] != null ? String(etq[k]) : m));
      /* `extensions.appdata` es varchar(256) (esquema realtime de Asterisk). Pasarse no da
       * un error entendible: Postgres contesta 22001 y el panel muestra «alguno de los
       * datos no es válido» sin decir dónde. Por eso el aviso al final del fax va partido
       * en varias variables (FQ1/FQ2/FQ3) en lugar de un CURL gigante, y por eso está
       * este freno: si alguien agrega un parámetro más, se entera acá y no en producción. */
      if (data.length > 255) throw err(500, 'la línea de dialplan «' + f[0] + '» no entra en appdata (256): ' + data.length + ' caracteres');
      return [i + 1, f[0], data];
    });
  }

  async function conCliente(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }

  // ═══════════════ Herramientas externas (ghostscript / tiff2pdf) ══════════

  /* execFile y no exec: NUNCA una shell con algo que vino de afuera (el nombre del archivo
   * lo ponemos nosotros, pero la regla es la regla y acá la entrada es un PDF de un usuario). */
  function correr(cmd, args, ms) {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: ms || CONV_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (e, stdout, stderr) => resolve({ ok: !e, salida: String(stdout || '') + String(stderr || ''), error: e ? String(e.message || e) : null }));
    });
  }

  /* Qué hay instalado de verdad. Se cachea 60 s: lo pregunta el panel cada vez que abre la
   * pantalla y no tiene sentido lanzar dos procesos por visita. */
  const _tools = { v: null, t: 0 };
  async function herramientas() {
    if (_tools.v && Date.now() - _tools.t < 60000) return _tools.v;
    const gs = await correr('gs', ['--version'], 8000);
    const t2p = await correr('tiff2pdf', ['-h'], 8000);
    /* tiff2pdf sin argumentos válidos sale con código != 0 pero imprime su ayuda: lo que
     * distingue "no está instalado" de "está y se quejó" es el ENOENT. */
    const v = {
      gs: gs.ok, gs_version: gs.ok ? gs.salida.trim().split('\n')[0] : null,
      tiff2pdf: t2p.ok || /usage|tiff2pdf/i.test(t2p.salida),
    };
    _tools.v = v; _tools.t = Date.now();
    return v;
  }

  /* ¿Asterisk tiene los módulos de fax? Sin res_fax_spandsp, ReceiveFAX/SendFAX no existen
   * y el dialplan falla en tiempo de llamada con "no such application", que es justo lo que
   * nadie quiere descubrir el día de la demo. */
  async function modulosAsterisk() {
    try {
      const out = String(await amiCommand('module show like res_fax'));
      return { res_fax: /res_fax\.so/.test(out), spandsp: /res_fax_spandsp\.so/.test(out) };
    } catch (_) { return { res_fax: null, spandsp: null }; }   // null = no se pudo preguntar (Asterisk caído)
  }

  // ═══════════════ TIFF: contar páginas sin depender de nadie ══════════════

  /* Cuenta las páginas de un TIFF recorriendo la cadena de IFD. Son veinte líneas y evita
   * depender de `tiffinfo` sólo para saber si un fax de 80 páginas supera el tope. Devuelve
   * 0 si el archivo no es un TIFF entendible (y entonces el que llama decide: para el envío,
   * rechazar; para lo recibido, confiar en lo que dijo el dialplan). */
  function paginasTiff(buf) {
    try {
      if (!buf || buf.length < 8) return 0;
      const le = buf[0] === 0x49 && buf[1] === 0x49;
      const be = buf[0] === 0x4d && buf[1] === 0x4d;
      if (!le && !be) return 0;
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      if (u16(2) !== 42) return 0;
      let off = u32(4);
      let n = 0;
      const vistos = new Set();
      while (off > 0 && off + 2 <= buf.length && n < 10000 && !vistos.has(off)) {
        vistos.add(off);
        const campos = u16(off);
        const sig = off + 2 + campos * 12;
        if (sig + 4 > buf.length) break;
        n++;
        off = u32(sig);
      }
      return n;
    } catch (_) { return 0; }
  }

  // ═══════════════ Conversión ══════════════════════════════════════════════

  /* PDF → TIFF G3 a 204x196 (fine), que es lo que entiende un aparato de fax. `-dSAFER` no
   * es opcional: el PDF lo sube un usuario y sin eso el intérprete de PostScript puede leer
   * y escribir archivos del contenedor. */
  async function pdfATiff(pdf, tif, cfg) {
    const t = await herramientas();
    if (!t.gs) throw err(503, 'falta ghostscript en el contenedor de la API: no se puede convertir el PDF a fax (pedido a empaquetado)');
    const r = await correr('gs', [
      '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=tiffg3', '-r204x196',
      '-dFIXEDMEDIA', '-sPAPERSIZE=a4', '-dPDFFitPage',
      '-sOutputFile=' + tif, pdf,
    ]);
    if (!r.ok || !fs.existsSync(tif)) throw err(422, 'no se pudo convertir el PDF (¿está dañado o protegido con contraseña?)');
    const pag = paginasTiff(fs.readFileSync(tif));
    const tope = Math.min(500, Math.max(1, parseInt(cfg.max_paginas, 10) || 50));
    if (pag > tope) { try { fs.unlinkSync(tif); } catch (_) {} throw err(413, 'el documento tiene ' + pag + ' páginas y el máximo configurado es ' + tope); }
    return pag || 1;
  }

  /* TIFF → PDF para que el que recibe el correo no tenga que pelearse con un TIFF
   * multipágina. Si no está tiff2pdf NO se rompe nada: se devuelve null y el correo sale
   * con el TIFF, que es mejor que no mandar el fax. */
  async function tiffAPdf(tif, pdf) {
    const t = await herramientas();
    if (!t.tiff2pdf) return null;
    const r = await correr('tiff2pdf', ['-o', pdf, tif]);
    if (!r.ok || !fs.existsSync(pdf)) { log.warn('tiff2pdf falló: ' + (r.error || r.salida).slice(0, 200)); return null; }
    return pdf;
  }

  // ═══════════════ Configuración ═══════════════════════════════════════════

  const COLS_CFG = 'id,station_id,header,ecm,t38,t38_ec,trunks,detect,detect_box,detect_seg,max_mb,max_paginas,reintentos,reintento_min,dial_seg';

  /* Cuántas veces se intenta un trabajo. El PARSEO va separado del default a propósito:
   * con `parseInt(co.reintentos, 10) || 3` un 0 legítimo se convierte en 3, y 0 es un valor
   * que la columna acepta y el panel deja poner ("no reintentar"). El que configura una sola
   * llamada no se tiene que llevar tres, que son tres llamadas facturadas. */
  function maxIntentos(co) {
    const n = parseInt(co && co.reintentos, 10);
    return Math.min(10, Math.max(0, Number.isFinite(n) ? n : 3));
  }
  async function cfg() {
    const { rows } = await pool.query('SELECT ' + COLS_CFG + ' FROM pbxng_fax_config WHERE id=1');
    return rows[0] || { station_id: '', header: '', ecm: true, t38: true, t38_ec: 'redundancy', trunks: [], detect: false, detect_box: null, detect_seg: 4, max_mb: 10, max_paginas: 50, reintentos: 3, reintento_min: 5, dial_seg: 60 };
  }

  // ═══════════════ Dialplan ════════════════════════════════════════════════

  /* Opciones de ReceiveFAX/SendFAX:
   *   f = permitir modo audio (soft-modem sobre G.711) — el respaldo cuando no hay T.38.
   *   z = pedir T.38 con un reinvite.
   * Las dos juntas es lo que hace que el mismo dialplan sirva con T.38, sin T.38 y con un
   * SBC-NG en el medio que no lo pase. */
  const opciones = (c) => (c.t38 ? 'fz' : 'f');

  /* Fax ENTRANTE de una caja. Va en el contexto `from-trunk` porque es el único contexto de
   * entrada con `switch => Realtime` (extensions.conf): un contexto nuevo no existiría para
   * Asterisk sin reconstruir la imagen. */
  /* El resultado se arma en tres variables antes del CURL porque `appdata` es varchar(256):
   * todo junto en una línea no entra (ver el freno de `armar`). */
  const FQ = [
    ['Set', 'FQ1=status=${FAXOPT(status)}&pag=${FAXOPT(pages)}&rem=${URIENCODE(${FAXOPT(remotestationid)})}'],
    ['Set', 'FQ2=str=${URIENCODE(${FAXOPT(statusstr)})}&err=${URIENCODE(${FAXOPT(error)})}'],
  ];

  function filasRx(box, c) {
    const sid = LIMPIO(box.station_id || c.station_id, 40);
    const hdr = LIMPIO(box.header || c.header, 60);
    const qs = 'dir=in&box=' + box.id + '&uid=${UNIQUEID}&${FQ1}&${FQ2}&${FQ3}';
    return armar([
      ['NoOp', 'fax entrante · caja ' + box.id + ' (' + LIMPIO(box.nombre, 40) + ')'],
      ['Answer', ''],
      /* Un segundo antes de empezar a modular: contra troncales que todavía están armando
       * el audio cuando la llamada ya figura contestada, sin esto el CED se pierde y el
       * aparato del otro lado reintenta o cuelga. */
      ['Wait', '1'],
      ['Set', 'FAXOPT(ecm)=' + (c.ecm ? 'yes' : 'no')],
      sid ? ['Set', 'FAXOPT(localstationid)=' + sid] : null,
      hdr ? ['Set', 'FAXOPT(headerinfo)=' + hdr] : null,
      ['ReceiveFAX', DIR_AST + '/in/' + box.id + '-${UNIQUEID}.tif,' + opciones(c)],
      /* El aviso va SIEMPRE, haya salido bien o mal: un fax cortado a la mitad también es
       * información (es lo que explica por qué el cliente dice que lo mandó). */
      FQ[0], FQ[1],
      ['Set', 'FQ3=cid=${URIENCODE(${CALLERID(num)})}&did=${URIENCODE(${CALLERID(dnid)})}'],
      ['Set', 'FAXRES=' + curlA('/api/internal/fax', qs)],
      ['Hangup', ''],
    ]);
  }

  /* Fax SALIENTE. Se ejecuta en el lado que ORIGINA la llamada: el Originate marca
   * `Local/<numero>@internal` (o sea por la ruta saliente de siempre, con su prefijo, su
   * CallerID y su cadena de failover — reimplementar eso acá sería tener dos verdades) y,
   * cuando el otro lado atiende, cae en esta extensión con FAXJOB y FAXFILE ya puestos.
   * Va en `internal`, que también tiene `switch => Realtime`.
   *
   * El GotoIf del principio es el candado: `fax-tx` es una extensión del contexto de los
   * internos y un softphone puede marcar texto. Sin FAXJOB no hace absolutamente nada. */
  function filasTx(c) {
    const qs = 'dir=out&job=${FAXJOB}&uid=${UNIQUEID}&${FQ1}&${FQ2}';
    return armar([
      ['NoOp', 'fax saliente · trabajo ${FAXJOB}'],
      ['GotoIf', '$["${FAXJOB}" = "" | "${FAXFILE}" = ""]?<<fin>>'],
      ['Set', 'FAXOPT(ecm)=' + (c.ecm ? 'yes' : 'no')],
      ['Set', 'FAXOPT(localstationid)=${FAXSID}'],
      ['Set', 'FAXOPT(headerinfo)=${FAXHDR}'],
      ['SendFAX', '${FAXFILE},' + opciones(c)],
      FQ[0], FQ[1],
      ['Set', 'FAXRES=' + curlA('/api/internal/fax', qs)],
      'fin',
      ['Hangup', ''],
    ]);
  }

  /* Detección de tono de fax (CNG) en una ruta de VOZ: cuando chan_pjsip la detecta manda
   * la llamada a la extensión `fax` del contexto del endpoint, que es `from-trunk`. Esta es
   * esa extensión: deriva a la caja elegida. Sin caja elegida no se escribe nada (y la
   * detección tampoco se enciende en las troncales). */
  const filasDetect = (boxId) => [[1, 'NoOp', 'tono de fax detectado'], [2, 'Goto', 'from-trunk,fax-rx-' + boxId + ',1']];

  const extenRx = (id) => 'fax-rx-' + id;

  /* ¿Esta central USA el fax? La fila de `pbxng_fax_config` existe siempre (la crea la
   * migración 0016), así que no sirve para saberlo: lo que lo dice es que haya al menos una
   * caja de recepción o al menos un trabajo de salida. Se pregunta antes de publicar nada,
   * porque `extensions` es la tabla realtime que Asterisk consulta en CADA llamada y no
   * tiene por qué comerse un DELETE + INSERT por arranque en una central sin fax. */
  async function hayFax(q) {
    const { rows } = await q.query(
      'SELECT EXISTS (SELECT 1 FROM pbxng_fax_boxes) OR EXISTS (SELECT 1 FROM pbxng_fax_out) AS usa');
    return !!(rows[0] && rows[0].usa);
  }

  /* Reescribe TODO el dialplan de fax. Se llama al guardar configuración o cajas: son
   * pocas filas y así no hay forma de que una caja quede con la cabecera vieja. */
  async function escribirDialplan(c, conf) {
    const co = conf || (await cfg());
    const { rows: boxes } = await c.query('SELECT id,nombre,station_id,header,enabled FROM pbxng_fax_boxes ORDER BY id');
    const vivas = boxes.filter((b) => b.enabled !== false);
    // Lo que ya no está (o quedó apagado) se borra: dialplan muerto marcable es dialplan peligroso.
    await c.query("DELETE FROM extensions WHERE context='from-trunk' AND exten LIKE 'fax-rx-%'");
    for (const b of vivas) await setDialplan(c, 'from-trunk', extenRx(b.id), filasRx(b, co));
    /* `fax-tx` es del contexto COMPARTIDO: se publica sólo si esta central usa el fax y sólo
     * si el número no es de otro (409 diciendo quién), y cuando deja de usarlo se borra —pero
     * sólo si el dialplan que hay ahí lo pusimos nosotros—. `from-trunk`, en cambio, es
     * nuestro y de las rutas entrantes: ahí no hace falta preguntarle a nadie. */
    if (await hayFax(c)) {
      await dueno.exigirLibre(c, 'fax-tx', 'fax', 1);
      await setDialplan(c, 'internal', 'fax-tx', filasTx(co));
    } else await dueno.borrarPropio(c, 'fax-tx', 'fax', 1, log);
    const detectBox = co.detect && co.detect_box && vivas.some((b) => b.id === co.detect_box) ? co.detect_box : null;
    if (detectBox) await setDialplan(c, 'from-trunk', 'fax', filasDetect(detectBox));
    else await c.query("DELETE FROM extensions WHERE context='from-trunk' AND exten='fax'");
  }

  // ═══════════════ T.38 y detección en las troncales ═══════════════════════

  /* Lo único que hay que tocar FUERA de este módulo: las columnas de T.38 y de detección
   * del endpoint de la troncal (`ps_endpoints`, realtime).
   *
   * POR QUÉ SE RECONCILIA EN CADA VUELTA DE LA COLA y no una sola vez: `writeAsteriskTrunk`
   * de trunks.js BORRA y vuelve a insertar la fila de `ps_endpoints` cada vez que alguien
   * edita la troncal, así que cualquier cosa que escribamos acá se pierde en la próxima
   * edición. Hasta que trunks.js llame a `aplicarT38()` después de escribir (pedido a api),
   * esto lo repara solo en menos de un minuto. El UPDATE sólo toca lo que está distinto,
   * así que en el caso normal no escribe nada.
   *
   * QUÉ APAGA Y QUÉ NO (esto se arregló después de una segunda revisión): el módulo apaga
   * T.38 SÓLO en las troncales que SALIERON de la lista —`quitadas`, que se calcula al
   * guardar la configuración comparando la lista vieja con la nueva—, nunca en "todas las
   * que no están en la lista". Barrer con `NOT (id = ANY(lista))` en cada vuelta del reloj
   * significaba que, con la lista vacía (el default de la migración 0016, o sea TODA central
   * que no usa fax), el UPDATE era verdadero para todas las filas: cualquier T.38 puesto a
   * mano en `ps_endpoints` se apagaba solo en menos de un minuto y no había forma de saber
   * quién lo hizo. El fax no es dueño de lo que nunca encendió.
   *
   * Y si no hay ninguna troncal en la lista ni ninguna que sacar, se sale antes de tocar la
   * base: `ps_endpoints` es una tabla realtime que Asterisk consulta en CADA llamada y no
   * tiene por qué comerse dos UPDATE cada FAX_TICK_MS en una central sin fax. */
  async function aplicarT38(conf, quitadas) {
    const co = conf || (await cfg());
    const lista = Array.isArray(co.trunks) ? co.trunks.filter((t) => typeof t === 'string' && t) : [];
    const quitar = (Array.isArray(quitadas) ? quitadas : []).filter((t) => typeof t === 'string' && t && !lista.includes(t));
    if (!lista.length && !quitar.length) return 0;
    const ec = T38_EC.includes(co.t38_ec) ? co.t38_ec : 'redundancy';
    const seg = Math.min(30, Math.max(1, parseInt(co.detect_seg, 10) || 4));
    try {
      // Sacar una troncal de la lista tiene que apagarle el T.38 de verdad, no dejárselo
      // puesto para siempre; pero sólo a ESA, que es la que el módulo había encendido.
      if (quitar.length) {
        await pool.query(
          `UPDATE ps_endpoints SET t38_udptl='no'::ast_bool_values, fax_detect='no'::ast_bool_values
             WHERE pbxng_kind='trunk' AND id = ANY($1::text[])
               AND (t38_udptl IS DISTINCT FROM 'no'::ast_bool_values OR fax_detect IS DISTINCT FROM 'no'::ast_bool_values)`, [quitar]);
      }
      if (!lista.length) return 0;
      const detect = co.detect && co.detect_box ? 'yes' : 'no';
      /* El `pbxng_kind='trunk'` va en los DOS UPDATE, no sólo en el que apaga: `ps_endpoints`
       * es una sola tabla donde conviven troncales e INTERNOS, y el id de la lista es texto
       * libre que viene del cuerpo del PUT. Sin este filtro, una lista con el número de un
       * interno le encendía T.38 y detección de fax al teléfono de esa persona —y encima
       * quedaba pegado, porque al sacarlo de la lista el UPDATE que apaga sí filtraba por
       * troncal y no lo alcanzaba nunca. La ruta ya valida que cada nombre sea una troncal
       * conocida; esto es el cinturón además de los tirantes, por si algún día se escribe
       * la lista desde otro lado. */
      const { rowCount } = await pool.query(
        `UPDATE ps_endpoints
            SET t38_udptl=$2::ast_bool_values, t38_udptl_ec=$3::pjsip_t38udptl_ec_values, t38_udptl_nat=rtp_symmetric,
                t38_udptl_maxdatagram=400, fax_detect=$4::ast_bool_values, fax_detect_timeout=$5
          WHERE pbxng_kind='trunk' AND id = ANY($1::text[])
            AND (t38_udptl IS DISTINCT FROM $2::ast_bool_values OR fax_detect IS DISTINCT FROM $4::ast_bool_values
                 OR t38_udptl_ec IS DISTINCT FROM $3::pjsip_t38udptl_ec_values)`,
        [lista, co.t38 ? 'yes' : 'no', ec, detect, seg]);
      return rowCount;
    } catch (e) { log.warn('no se pudo aplicar T.38 a las troncales: ' + (e && e.message)); return 0; }
  }

  /* Volcado al arrancar y en cada (re)conexión del AMI, igual que `syncFeatures` de
   * telefonia.js: el dialplan realtime sobrevive (vive en Postgres), pero las columnas de
   * T.38 pueden haber quedado pisadas por una edición de troncal mientras la API no estaba. */
  async function syncFax() {
    try {
      /* En una central SIN fax no se toca nada. Esto era lo ÚNICO que escribía dialplan en el
       * arranque de la API, y lo hacía siempre: borraba `from-trunk/fax-rx-%`, `from-trunk/fax`
       * e `internal/fax-tx` y los volvía a insertar en cada arranque aunque no hubiera una sola
       * caja de fax configurada. Escrituras sobre la tabla que Asterisk consulta en cada
       * llamada, para nada. `aplicarT38()` ya se cuida solo (con la lista vacía sale antes de
       * tocar `ps_endpoints`), así que se lo sigue llamando igual. */
      const co = await cfg();
      if (await hayFax(pool)) await conCliente((c) => escribirDialplan(c, co));
      const n = await aplicarT38(co);
      log.info('fax sincronizado', { troncales_t38: n });
    } catch (e) { log.error('syncFax: ' + (e && e.message)); }
  }

  // ═══════════════ Correo del fax recibido ═════════════════════════════════

  async function smtpFor(tenantId = 1) {
    const { rows } = await pool.query('SELECT host,port,secure,username,password,from_addr,enabled FROM pbxng_email_config WHERE tenant_id=$1', [tenantId]);
    const c = rows[0];
    return (c && c.enabled && c.host) ? c : null;
  }

  async function mandarCorreo(fila, box) {
    const to = String((box && box.email) || '').trim();
    if (!to) return { ok: null, err: null };            // la caja no manda correo: no es un error
    const smtp = await smtpFor(1);
    if (!smtp) return { ok: false, err: 'no hay SMTP configurado (Configuración → Correo)' };
    const { rows: br } = await pool.query("SELECT value FROM pbxng_settings WHERE key='brand_name'");
    const brand = (br[0] && br[0].value) || 'PBX-NG';
    const { rows: dm } = await pool.query("SELECT value FROM pbxng_settings WHERE key='domain'");
    const dom = (dm[0] && dm[0].value) || process.env.DOMAIN || '';
    const cuando = new Date(fila.recibido_at || Date.now()).toLocaleString('es-UY', { timeZone: process.env.TZ || 'America/Montevideo' });
    const adjuntos = [];
    /* El PDF es lo que la gente quiere abrir; el TIFF va sólo si la caja lo pide (o si no
     * hubo PDF porque falta tiff2pdf): mandar los dos siempre duplica el peso del correo. */
    if (fila.pdf) { try { adjuntos.push({ filename: 'fax-' + fila.id + '.pdf', content: fs.readFileSync(path.join(DIR_IN, fila.pdf)) }); } catch (_) {} }
    if (fila.tiff && (box.adjuntar_tiff || !fila.pdf)) { try { adjuntos.push({ filename: 'fax-' + fila.id + '.tif', content: fs.readFileSync(path.join(DIR_IN, fila.tiff)) }); } catch (_) {} }
    const tx = nodemailer.createTransport({ host: smtp.host, port: smtp.port || 587, secure: !!smtp.secure, auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined });
    try {
      await tx.sendMail({
        from: smtp.from_addr || smtp.username,
        to,
        subject: 'Fax de ' + (fila.cid || 'desconocido') + ' · ' + (fila.paginas || 0) + (fila.paginas === 1 ? ' página' : ' páginas'),
        html: emails.faxEmail({ brand, caja: box.nombre, de: fila.cid, remoto: fila.remoto, did: fila.did, cuando, paginas: fila.paginas, estado: fila.estado, detalle: fila.detalle, adjuntos: adjuntos.map((a) => a.filename), panelUrl: dom ? 'https://' + dom + '/fax' : '' }),
        text: 'Fax recibido en «' + box.nombre + '»\nDe: ' + (fila.cid || 'desconocido') + '\nFecha: ' + cuando + '\nPáginas: ' + (fila.paginas || 0) + '\n',
        attachments: adjuntos,
      });
      return { ok: true, err: null };
    } catch (e) { return { ok: false, err: (smtpHint ? smtpHint(e) : String(e.message || e)).slice(0, 300) }; }
  }

  // ═══════════════ Lo que avisa el dialplan ════════════════════════════════

  /* Igual que `internal/disa`: contesta TEXTO PLANO, porque el que lee es un `${CURL(...)}`. */
  const urlenc = express.urlencoded({ extended: false, limit: '8kb' });
  const texto = (res, s) => res.type('text/plain').send(s);

  app.post('/api/internal/fax', urlenc, async (req, res) => {
    if (!soloDesdeLaCentral(req, res)) return;
    const b = Object.assign({}, req.body || {}, req.query || {});
    const dir = String(b.dir || '');
    /* Se contesta ANTES de convertir y mandar el correo: del otro lado hay un canal de
     * Asterisk esperando el CURL, y ghostscript + SMTP pueden tardar treinta segundos. */
    texto(res, 'ok');
    try {
      if (dir === 'in') await registrarEntrante(b);
      else if (dir === 'out') await registrarSaliente(b);
    } catch (e) { log.error('internal/fax (' + dir + '): ' + (e && e.message)); }
  });

  const nEntero = (v, max) => Math.min(max, Math.max(0, parseInt(v, 10) || 0));
  const okStatus = (v) => (String(v || '').toUpperCase() === 'SUCCESS' ? 'ok' : 'error');

  async function registrarEntrante(b) {
    const uid = String(b.uid || '');
    if (!UID.test(uid)) throw new Error('uniqueid inválido');
    const boxId = parseInt(b.box, 10) || 0;
    const { rows: bx } = await pool.query('SELECT id,nombre,email,adjuntar_tiff FROM pbxng_fax_boxes WHERE id=$1', [boxId]);
    const box = bx[0];
    const estado = okStatus(b.status);
    /* Respaldo al nombre viejo (`<uniqueid>.tif`): un fax que empezó con el dialplan anterior
     * y termina después de actualizar la API dejó el archivo con el nombre de antes. Sin esto
     * ese fax quedaría anotado como «no llegó ninguna página». */
    let tif = tiffRx(boxId, uid);
    if (!fs.existsSync(path.join(DIR_IN, tif)) && fs.existsSync(path.join(DIR_IN, uid + '.tif'))) tif = uid + '.tif';
    await importarTiff({
      uid, tiff: tif, box,
      cid: LIMPIO(b.cid, 40), did: LIMPIO(b.did, 40), remoto: LIMPIO(b.rem, 60),
      paginas: nEntero(b.pag, 5000), estado,
      detalle: (String(b.str || '') + (b.err ? ' · ' + b.err : '')).slice(0, 300) || null,
    });
  }

  /* Alta de un fax recibido: convierte, guarda la fila y manda el correo. La usan las dos
   * vías (el aviso del dialplan y el barrido del directorio), y es idempotente por
   * `uniqueid` (UNIQUE en la tabla): si las dos llegan al mismo fax, entra una sola vez. */
  async function importarTiff(d) {
    const tifPath = path.join(DIR_IN, d.tiff);
    let bytes = 0;
    try { bytes = fs.statSync(tifPath).size; } catch (_) {}
    /* Un TIFF vacío no es un fax: es una llamada que atendió el módem y se cortó. Se anota
     * igual (explica el reclamo del cliente) pero no se convierte ni se manda por correo. */
    const hayImagen = bytes > 512;
    let pdf = null;
    let paginas = d.paginas || 0;
    if (hayImagen) {
      if (!paginas) { try { paginas = paginasTiff(fs.readFileSync(tifPath)); } catch (_) {} }
      /* El PDF se nombra a partir del TIFF y no del uniqueid pelado: son el mismo documento
       * y así los dos archivos de un fax caen juntos al ordenar el directorio. */
      const basePdf = d.tiff.replace(/\.tif$/i, '') + '.pdf';
      try { pdf = (await tiffAPdf(tifPath, path.join(DIR_IN, basePdf))) ? basePdf : null; }
      catch (e) { log.warn('no se pudo pasar el fax a PDF: ' + (e && e.message)); }
    }
    const { rows } = await pool.query(
      `INSERT INTO pbxng_fax_in (box_id,uniqueid,cid,did,paginas,estado,detalle,remoto,tiff,pdf,bytes,email_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (uniqueid) DO NOTHING
       RETURNING id,box_id,uniqueid,cid,did,recibido_at,paginas,estado,detalle,remoto,tiff,pdf,bytes`,
      [d.box ? d.box.id : null, d.uid, d.cid || null, d.did || null, paginas, hayImagen ? d.estado : 'error',
        hayImagen ? d.detalle : (d.detalle || 'no llegó ninguna página'), d.remoto || null, d.tiff, pdf, bytes,
        (d.box && d.box.email) || null]);
    const fila = rows[0];
    if (!fila) return null;                              // ya estaba: la otra vía ganó
    broadcastSoon();
    if (hayImagen && d.box) {
      const r = await mandarCorreo(fila, d.box);
      if (r.ok !== null) await pool.query('UPDATE pbxng_fax_in SET email_ok=$2, email_err=$3 WHERE id=$1', [fila.id, r.ok, r.err]);
      if (r.err) log.warn('fax recibido sin poder avisar por correo', { id: fila.id, error: r.err });
    } else if (hayImagen && d.sinCaja) {
      /* Sin caja NO se manda a ningún lado: adivinar el destinatario de un documento es
       * justo lo que causó la fuga entre áreas. Queda marcado en la bandeja (correo «falló»
       * con el motivo) para que alguien lo baje y lo reenvíe a mano. */
      await pool.query('UPDATE pbxng_fax_in SET email_ok=false, email_err=$2 WHERE id=$1', [fila.id, d.sinCaja.slice(0, 300)]);
      log.warn('fax recibido sin poder saber a qué caja entró', { id: fila.id, tiff: d.tiff });
    }
    log.info('fax recibido', { id: fila.id, paginas, caja: d.box ? d.box.id : null, estado: fila.estado });
    return fila;
  }

  async function registrarSaliente(b) {
    const job = parseInt(b.job, 10) || 0;
    if (!job) throw new Error('trabajo inválido');
    const ok = okStatus(b.status) === 'ok';
    const detalle = (String(b.str || '') + (b.err ? ' · ' + b.err : '')).slice(0, 300) || null;
    await cerrarIntento(job, ok, detalle, LIMPIO(b.rem, 60), nEntero(b.pag, 5000), String(b.uid || '').slice(0, 40));
  }

  /* Cierra un intento de envío: o quedó `ok`, o se reprograma, o se agotaron los intentos,
   * o el trabajo se había cancelado mientras el canal seguía vivo (estado `cancelando`) y
   * recién ahora se lo puede dar por terminado.
   * Toda la decisión está acá y en un solo UPDATE para que dos avisos simultáneos (el del
   * dialplan y el del reloj que destraba los colgados) no dejen el trabajo en dos estados.
   * `estado` dentro del CASE es el valor VIEJO de la fila (así funciona un UPDATE en
   * Postgres), que es justo lo que hace falta para distinguir el cancelado del normal. */
  async function cerrarIntento(job, ok, detalle, remoto, paginas, uid) {
    const co = await cfg();
    const min = Math.min(180, Math.max(1, parseInt(co.reintento_min, 10) || 5));
    const { rows } = await pool.query(
      `UPDATE pbxng_fax_out SET
         estado = CASE WHEN $2 THEN 'ok'
                       WHEN estado='cancelando' THEN 'cancelado'
                       WHEN intentos >= max_intentos THEN 'error'
                       ELSE 'pendiente' END,
         proximo_intento = CASE WHEN $2 OR estado='cancelando' OR intentos >= max_intentos THEN proximo_intento
                                ELSE now() + ($6 || ' minutes')::interval END,
         enviando_desde = NULL,
         detalle = $3, remoto = COALESCE(NULLIF($4,''), remoto),
         paginas = CASE WHEN $5 > 0 THEN $5 ELSE paginas END,
         uniqueid = COALESCE(NULLIF($7,''), uniqueid),
         updated_at = now()
       WHERE id=$1 AND estado IN ('enviando','cancelando')
       RETURNING id, estado, intentos, max_intentos`,
      [job, ok, detalle, remoto || '', paginas || 0, String(min), uid || '']);
    if (rows[0]) { broadcastSoon(); log.info('fax saliente', { id: job, estado: rows[0].estado, intento: rows[0].intentos, detalle: detalle || '' }); }
    return rows[0] || null;
  }

  // ═══════════════ Cola de envío ═══════════════════════════════════════════

  /* El envío NO necesita cajas de recepción: una central puede mandar faxes sin recibir
   * ninguno. Como el arranque dejó de publicar el dialplan de fax a ciegas (ver `syncFax`),
   * el primer envío es el que tiene que dejar `internal/fax-tx` en su lugar. Se comprueba
   * antes de escribir: en el caso normal —que es todos los envíos menos el primero— esto es
   * un SELECT y nada más, no otro DELETE + INSERT sobre la tabla realtime. */
  async function asegurarTx(co) {
    const { rows } = await pool.query("SELECT 1 FROM extensions WHERE context='internal' AND exten='fax-tx' AND priority=1");
    if (rows.length) return;
    await conCliente(async (c) => {
      await dueno.exigirLibre(c, 'fax-tx', 'fax', 1);
      await setDialplan(c, 'internal', 'fax-tx', filasTx(co));
    });
  }

  async function originar(j, co) {
    await asegurarTx(co);
    const sid = LIMPIO(co.station_id, 40);
    const hdr = LIMPIO(co.header, 60);
    const seg = Math.min(300, Math.max(15, parseInt(co.dial_seg, 10) || 60));
    await amiAction({
      Action: 'Originate',
      /* Local/<numero>@internal: la única salida a la calle que conoce esta central son las
       * rutas salientes que trunks.js publica en `internal`, con su prefijo, su CallerID y
       * su failover. `/n` (sin optimizar) mantiene el canal vivo, que es lo que necesita
       * T.38 para reinvitar y el CDR para registrar la llamada. */
      Channel: 'Local/' + j.numero + '@internal/n',
      Context: 'internal', Exten: 'fax-tx', Priority: 1,
      CallerID: (sid ? 'Fax <' + sid + '>' : 'Fax'),
      Async: 'true', Timeout: seg * 1000,
      /* Objeto y no array: asterisk-manager serializa un array uniendo con comas (una sola
       * cabecera Variable), y un objeto sí emite una cabecera `Variable:` por clave, que es
       * lo que espera el AMI. */
      Variable: { FAXJOB: String(j.id), FAXFILE: path.join(DIR_AST, 'out', j.tiff), FAXSID: sid, FAXHDR: hdr },
    });
  }

  let COLA_OCUPADA = false;
  async function colaTick() {
    if (COLA_OCUPADA) return;
    COLA_OCUPADA = true;
    try {
      const co = await cfg();
      /* Trabajos colgados: el aviso del dialplan nunca llegó (no atendió, se cayó el canal,
       * la API se reinició en el medio). Se cuentan como intento fallido, no como error
       * definitivo: es exactamente el caso "el fax no entró a la primera". */
      const colgadoSeg = Math.min(3600, Math.max(60, (parseInt(co.dial_seg, 10) || 60) + 300));
      const { rows: colgados } = await pool.query(
        "SELECT id FROM pbxng_fax_out WHERE estado IN ('enviando','cancelando') AND enviando_desde < now() - ($1 || ' seconds')::interval", [String(colgadoSeg)]);
      for (const c of colgados) await cerrarIntento(c.id, false, 'la llamada no llegó a completarse', '', 0, '');

      /* Un fax a la vez a propósito: dos SendFAX simultáneos por la misma troncal es la
       * forma más rápida de que no entre ninguno de los dos. `cancelando` cuenta como
       * ocupado: la fila ya no se va a reintentar, pero el CANAL sigue en el aire hasta que
       * SendFAX termine, y arrancar el siguiente ahí es exactamente los dos faxes a la vez
       * que esta cola existe para evitar. */
      const { rows: enviando } = await pool.query("SELECT 1 FROM pbxng_fax_out WHERE estado IN ('enviando','cancelando') LIMIT 1");
      if (enviando.length) return;

      const { rows } = await pool.query(
        `UPDATE pbxng_fax_out SET estado='enviando', enviando_desde=now(), intentos=intentos+1, updated_at=now()
          WHERE id = (SELECT id FROM pbxng_fax_out WHERE estado='pendiente' AND proximo_intento <= now()
                       ORDER BY proximo_intento, id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id,numero,tiff,intentos,max_intentos`);
      const j = rows[0];
      if (!j) return;
      if (!j.tiff || !fs.existsSync(path.join(DIR_OUT, j.tiff))) { await cerrarIntento(j.id, false, 'el archivo convertido ya no está en disco', '', 0, ''); return; }
      try { await originar(j, co); broadcastSoon(); }
      catch (e) {
        /* El Originate falló acá mismo (Asterisk caído, sin ruta saliente): se cierra el
         * intento ya, sin esperar el timeout del colgado. */
        await cerrarIntento(j.id, false, 'no se pudo iniciar la llamada: ' + String(e.message || e).slice(0, 160), '', 0, '');
      }
    } catch (e) { log.error('cola de fax: ' + (e && e.message)); }
    finally { COLA_OCUPADA = false; }
  }

  /* Barrido del directorio de entrada: TIFF que quedaron sin fila porque la llamada se
   * cortó antes del aviso. Misma idea que `indexRecordings` de recordings.js. Se espera un
   * minuto de quietud para no importar un fax que se está escribiendo en este momento. */
  const SIN_CAJA = 'no se pudo saber a qué caja entró este fax, así que no se mandó por correo: bajalo y reenvialo a mano';

  async function barrerEntrantes() {
    let archivos;
    try { archivos = fs.readdirSync(DIR_IN).filter((f) => f.endsWith('.tif')); } catch (_) { return; }
    if (!archivos.length) return;
    for (const f of archivos.slice(0, 200)) {
      /* La caja sale del NOMBRE del archivo, que es lo único que se sabe de un fax huérfano.
       * Los nombres viejos (`<uniqueid>.tif`, sin caja) se siguen importando, pero sin caja
       * y sin correo: mandárselo a una caja elegida por default es filtrar el documento. */
      const m = NOMBRE_TIFF.exec(f);
      const uid = m ? m[2] : f.slice(0, -4);
      if (!m && !UID.test(uid)) continue;
      let st; try { st = fs.statSync(path.join(DIR_IN, f)); } catch (_) { continue; }
      if (Date.now() - st.mtimeMs < 60000) continue;
      const { rowCount } = await pool.query('SELECT 1 FROM pbxng_fax_in WHERE uniqueid=$1', [uid]);
      if (rowCount) continue;
      /* Se relee la caja de la base y no se confía en el número a secas: la caja pudo haberse
       * borrado mientras el TIFF esperaba en el spool. */
      const { rows: bx } = m
        ? await pool.query('SELECT id,nombre,email,adjuntar_tiff FROM pbxng_fax_boxes WHERE id=$1', [parseInt(m[1], 10)])
        : { rows: [] };
      const box = bx[0] || null;
      try {
        await importarTiff({
          uid, tiff: f, box, cid: null, did: null, remoto: null, paginas: 0, estado: 'ok',
          detalle: 'importado del spool (la llamada terminó sin avisar)' + (box ? '' : ' · ' + SIN_CAJA),
          sinCaja: box ? null : SIN_CAJA,
        });
      } catch (e) { log.warn('no se pudo importar el fax ' + f + ': ' + (e && e.message)); }
    }
  }

  /* Lo que corre en el reloj en una central SIN fax: `aplicarT38()` sale antes de tocar la
   * base (lista vacía, ver arriba) y `barrerEntrantes()` hace un solo `readdirSync` de un
   * directorio vacío y se va sin una sola consulta. El barrido NO se condiciona a que haya
   * cajas a propósito: si alguien borra la caja con un TIFF todavía en el spool, ese fax
   * tiene que entrar igual (sin caja y sin correo) en vez de quedarse en el disco. */
  const reloj = setInterval(() => {
    colaTick().catch(() => {});
    barrerEntrantes().catch((e) => log.warn('barrido de fax: ' + (e && e.message)));
    aplicarT38().catch(() => {});
  }, TICK_MS);
  if (reloj.unref) reloj.unref();   // no le tiene que impedir a Node salir en las pruebas

  // ═══════════════ API ═════════════════════════════════════════════════════

  /* Estado del subsistema: es lo primero que pide el panel. Dice con nombre y apellido qué
   * falta (ghostscript, tiff2pdf, res_fax_spandsp) en vez de dejar que el fax falle en
   * tiempo de llamada, que es cuando ya hay un cliente esperando del otro lado. */
  app.get('/api/fax/estado', async (req, res) => {
    try {
      const [t, m, co] = await Promise.all([herramientas(), modulosAsterisk(), cfg()]);
      let escribible = true;
      try { fs.accessSync(DIR_IN, fs.constants.W_OK); } catch (_) { escribible = false; }
      const { rows: p } = await pool.query("SELECT count(*)::int n FROM pbxng_fax_out WHERE estado IN ('pendiente','enviando')");
      res.json({
        herramientas: { ghostscript: t.gs, ghostscript_version: t.gs_version, tiff2pdf: t.tiff2pdf },
        asterisk: m,
        spool: { dir: DIR, dir_asterisk: DIR_AST, escribible },
        limites: { max_mb: Math.min(co.max_mb || MAX_MB, MAX_MB), max_mb_duro: MAX_MB, max_paginas: co.max_paginas },
        en_cola: p[0] ? p[0].n : 0,
        listo: !!(t.gs && escribible && m.spandsp !== false),
      });
    } catch (e) { errorHttp(res, e); }
  });

  app.get('/api/fax/config', async (req, res) => {
    try { res.json(await cfg()); } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/fax/config', async (req, res) => {
    const b = req.body || {};
    try {
      const co = await cfg();
      const n = (v, def, min, max) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def; };
      if (b.t38_ec !== undefined && !T38_EC.includes(String(b.t38_ec))) throw err(400, 'corrección de errores T.38 inválida');
      if (b.trunks !== undefined && !Array.isArray(b.trunks)) throw err(400, 'las troncales tienen que venir como lista');
      /* Antes esta lista se limpiaba con un filtro de formato y lo que no pasaba se tiraba en
       * silencio: el panel guardaba «bien», la troncal mal escrita no aparecía más y nadie
       * entendía por qué el fax seguía sin T.38. Y peor: un nombre con formato válido que NO
       * fuera una troncal (el número de un interno, por ejemplo) igual se guardaba y llegaba
       * al UPDATE de `ps_endpoints`. Ahora se valida contra las troncales que existen —las
       * mismas que ofrece el selector del panel— y lo que no está da 400 diciendo cuál. */
      let trunks = co.trunks;
      if (b.trunks !== undefined) {
        trunks = [...new Set(b.trunks.map((t) => String(t == null ? '' : t).trim()).filter(Boolean))];
        const malos = trunks.filter((t) => !/^[A-Za-z0-9_-]{1,64}$/.test(t));
        if (malos.length) throw err(400, 'nombre de troncal inválido: ' + malos.join(', '));
        if (trunks.length) {
          const { rows: conocidas } = await pool.query('SELECT name FROM pbxng_trunks WHERE name = ANY($1::text[])', [trunks]);
          const hay = new Set(conocidas.map((r) => r.name));
          const faltan = trunks.filter((t) => !hay.has(t));
          if (faltan.length) throw err(400, 'no existe la troncal: ' + faltan.join(', '));
        }
      }
      const detectBox = b.detect_box === undefined ? co.detect_box : (parseInt(b.detect_box, 10) || null);
      if (detectBox) {
        const { rowCount } = await pool.query('SELECT 1 FROM pbxng_fax_boxes WHERE id=$1', [detectBox]);
        if (!rowCount) throw err(400, 'la caja de fax elegida para la detección no existe');
      }
      const nuevo = {
        station_id: b.station_id === undefined ? co.station_id : LIMPIO(b.station_id, 40),
        header: b.header === undefined ? co.header : LIMPIO(b.header, 60),
        ecm: b.ecm === undefined ? co.ecm : !!b.ecm,
        t38: b.t38 === undefined ? co.t38 : !!b.t38,
        t38_ec: b.t38_ec === undefined ? co.t38_ec : String(b.t38_ec),
        trunks, detect: b.detect === undefined ? co.detect : !!b.detect, detect_box: detectBox,
        detect_seg: n(b.detect_seg, co.detect_seg, 1, 30),
        max_mb: n(b.max_mb, co.max_mb, 1, MAX_MB),
        max_paginas: n(b.max_paginas, co.max_paginas, 1, 500),
        reintentos: n(b.reintentos, co.reintentos, 0, 10),
        reintento_min: n(b.reintento_min, co.reintento_min, 1, 180),
        dial_seg: n(b.dial_seg, co.dial_seg, 15, 300),
      };
      const { rows } = await pool.query(
        `UPDATE pbxng_fax_config SET station_id=$1, header=$2, ecm=$3, t38=$4, t38_ec=$5, trunks=$6, detect=$7,
           detect_box=$8, detect_seg=$9, max_mb=$10, max_paginas=$11, reintentos=$12, reintento_min=$13,
           dial_seg=$14, updated_at=now() WHERE id=1 RETURNING ` + COLS_CFG,
        [nuevo.station_id, nuevo.header, nuevo.ecm, nuevo.t38, nuevo.t38_ec, JSON.stringify(nuevo.trunks), nuevo.detect,
          nuevo.detect_box, nuevo.detect_seg, nuevo.max_mb, nuevo.max_paginas, nuevo.reintentos, nuevo.reintento_min, nuevo.dial_seg]);
      await conCliente((c) => escribirDialplan(c, rows[0]));
      /* Las que SALIERON de la lista son las únicas a las que hay que apagarles el T.38, y
       * este es el único momento en que se sabe cuáles son (acá está la lista vieja). */
      const antes = Array.isArray(co.trunks) ? co.trunks.map((t) => String(t)) : [];
      await aplicarT38(rows[0], antes.filter((t) => !nuevo.trunks.includes(t)));
      broadcastSoon();
      res.json(rows[0]);
    } catch (e) { errorHttp(res, e); }
  });

  // ── Cajas ────────────────────────────────────────────────────────────────
  const COLS_BOX = 'id,nombre,email,station_id,header,adjuntar_tiff,enabled,created_at';

  function validarCaja(b, viejo) {
    const nombre = String(b.nombre === undefined ? (viejo ? viejo.nombre : '') : b.nombre).trim();
    if (!nombre) throw err(400, 'la caja de fax necesita un nombre');
    const email = String(b.email === undefined ? (viejo ? viejo.email : '') : (b.email || '')).trim();
    if (email && !EMAILS.test(email)) throw err(400, 'el correo no es válido (podés poner varios separados por coma)');
    return {
      nombre: nombre.slice(0, 80),
      email,
      station_id: b.station_id === undefined ? (viejo ? viejo.station_id : null) : (LIMPIO(b.station_id, 40) || null),
      header: b.header === undefined ? (viejo ? viejo.header : null) : (LIMPIO(b.header, 60) || null),
      adjuntar_tiff: b.adjuntar_tiff === undefined ? (viejo ? viejo.adjuntar_tiff : false) : !!b.adjuntar_tiff,
      enabled: b.enabled === undefined ? (viejo ? viejo.enabled !== false : true) : !!b.enabled,
    };
  }

  app.get('/api/fax/boxes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.${COLS_BOX.split(',').join(', b.')},
                (SELECT count(*)::int FROM pbxng_fax_in i WHERE i.box_id=b.id) AS recibidos,
                (SELECT count(*)::int FROM pbxng_inbound_routes r WHERE r.dest_type='fax' AND r.dest_value=b.id::text) AS rutas
           FROM pbxng_fax_boxes b ORDER BY b.id`);
      res.json(rows);
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/fax/boxes', async (req, res) => {
    try {
      const v = validarCaja(req.body || {}, null);
      const fila = await conCliente(async (c) => {
        const { rows } = await c.query(
          'INSERT INTO pbxng_fax_boxes (nombre,email,station_id,header,adjuntar_tiff,enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ' + COLS_BOX,
          [v.nombre, v.email, v.station_id, v.header, v.adjuntar_tiff, v.enabled]);
        await escribirDialplan(c);
        return rows[0];
      });
      broadcastSoon();
      res.status(201).json(fila);
    } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/fax/boxes/:id', async (req, res) => {
    try {
      const fila = await conCliente(async (c) => {
        const { rows: viejo } = await c.query('SELECT ' + COLS_BOX + ' FROM pbxng_fax_boxes WHERE id=$1', [req.params.id]);
        if (!viejo[0]) throw err(404, 'la caja de fax no existe');
        const v = validarCaja(req.body || {}, viejo[0]);
        const { rows } = await c.query(
          'UPDATE pbxng_fax_boxes SET nombre=$2, email=$3, station_id=$4, header=$5, adjuntar_tiff=$6, enabled=$7 WHERE id=$1 RETURNING ' + COLS_BOX,
          [viejo[0].id, v.nombre, v.email, v.station_id, v.header, v.adjuntar_tiff, v.enabled]);
        await escribirDialplan(c);
        return rows[0];
      });
      broadcastSoon();
      res.json(fila);
    } catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/fax/boxes/:id', async (req, res) => {
    try {
      const r = await conCliente(async (c) => {
        /* Una caja con una ruta entrante apuntándole no se borra: quedaría un DID mandando
         * llamadas a un dialplan que ya no existe (Asterisk contesta y cuelga sin decir por
         * qué). Primero se cambia el destino de la ruta. */
        const { rows: usada } = await c.query("SELECT did FROM pbxng_inbound_routes WHERE dest_type='fax' AND dest_value=$1", [String(req.params.id)]);
        if (usada.length) throw err(409, 'la usan las rutas entrantes ' + usada.map((u) => u.did).join(', ') + ': cambiales el destino primero');
        const { rowCount } = await c.query('DELETE FROM pbxng_fax_boxes WHERE id=$1', [req.params.id]);
        if (!rowCount) throw err(404, 'la caja de fax no existe');
        await escribirDialplan(c);
        return { deleted: req.params.id };
      });
      broadcastSoon();
      res.json(r);
    } catch (e) { errorHttp(res, e); }
  });

  // ── Bandeja de entrada ───────────────────────────────────────────────────
  const COLS_IN = 'id,box_id,uniqueid,cid,did,recibido_at,paginas,estado,detalle,remoto,tiff,pdf,bytes,email_to,email_ok,email_err';

  app.get('/api/fax/in', async (req, res) => {
    try {
      const lim = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const box = parseInt(req.query.box, 10) || 0;
      const { rows } = await pool.query(
        'SELECT ' + COLS_IN + ', (SELECT nombre FROM pbxng_fax_boxes b WHERE b.id=i.box_id) AS caja FROM pbxng_fax_in i'
        + (box ? ' WHERE box_id=$2' : '') + ' ORDER BY recibido_at DESC LIMIT $1', box ? [lim, box] : [lim]);
      res.json(rows);
    } catch (e) { errorHttp(res, e); }
  });

  /* Descarga. El panel la pide con `raw: true` (app/api.js): un `<a href download>` no pasa
   * por el parche de window.fetch de auth.jsx y bajaría un 401 disfrazado de archivo.
   * El nombre del archivo sale de la BASE, nunca de la query: `path.basename` además corta
   * cualquier `..` que hubiera entrado por otro lado. */
  function bajar(res, dir, nombre, tipo, comoSeLlama) {
    if (!nombre) return res.status(404).json({ error: 'no hay archivo para este fax' });
    const p = path.join(dir, path.basename(String(nombre)));
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'el archivo ya no está en disco' });
    res.set('Content-Type', tipo);
    res.set('Content-Disposition', 'attachment; filename="' + comoSeLlama + '"');
    return res.send(fs.readFileSync(p));
  }

  app.get('/api/fax/in/:id/pdf', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT id,pdf,tiff FROM pbxng_fax_in WHERE id=$1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'no existe' });
      const tiff = req.query.tiff === '1' || !rows[0].pdf;
      return bajar(res, DIR_IN, tiff ? rows[0].tiff : rows[0].pdf, tiff ? 'image/tiff' : 'application/pdf', 'fax-' + rows[0].id + (tiff ? '.tif' : '.pdf'));
    } catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/fax/in/:id', async (req, res) => {
    try {
      const { rows } = await pool.query('DELETE FROM pbxng_fax_in WHERE id=$1 RETURNING tiff,pdf', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'no existe' });
      for (const f of [rows[0].tiff, rows[0].pdf]) if (f) { try { fs.unlinkSync(path.join(DIR_IN, path.basename(f))); } catch (_) {} }
      broadcastSoon();
      res.json({ deleted: req.params.id });
    } catch (e) { errorHttp(res, e); }
  });

  // ── Bandeja de salida ────────────────────────────────────────────────────
  const COLS_OUT = 'id,numero,nombre,asunto,archivo,tiff,paginas,bytes,estado,intentos,max_intentos,proximo_intento,detalle,remoto,usuario,created_at,updated_at';

  app.get('/api/fax/out', async (req, res) => {
    try {
      const lim = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const { rows } = await pool.query('SELECT ' + COLS_OUT + ' FROM pbxng_fax_out ORDER BY id DESC LIMIT $1', [lim]);
      res.json(rows);
    } catch (e) { errorHttp(res, e); }
  });

  /* Enviar: el PDF viaja como CUERPO CRUDO (`Content-Type: application/pdf`) y los datos en
   * la query. Sin multipart y sin una dependencia nueva para parsearlo, que es lo que ya
   * hace `backup/subir`. El tope de `limit` es el que protege la memoria de la central: un
   * PDF de 300 MB lo corta el parser, antes de que exista un Buffer. */
  app.post('/api/fax/out', express.raw({ type: 'application/pdf', limit: MAX_MB + 'mb' }), async (req, res) => {
    const base = 'out-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const pdfPath = path.join(DIR_OUT, base + '.pdf');
    const tifPath = path.join(DIR_OUT, base + '.tif');
    try {
      /* Se sacan sólo los separadores con los que la gente escribe un número (espacios,
       * puntos, guiones, paréntesis). Cualquier OTRA cosa se RECHAZA en vez de limpiarse:
       * un `*21*099…` limpiado a dígitos sería marcar un número que nadie pidió, y sin
       * limpiar sería un código de función ejecutándose dentro del dialplan (telefonia.js). */
      const numero = String(req.query.numero || '').replace(/[\s.()-]/g, '');
      if (!NUMERO.test(numero)) throw err(400, 'poné el número de fax tal como lo marcarías desde un teléfono, con el prefijo de salida (sólo dígitos)');
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) throw err(415, 'subí el documento como PDF (Content-Type: application/pdf)');
      const co = await cfg();
      const topeMb = Math.min(co.max_mb || MAX_MB, MAX_MB);
      if (buf.length > topeMb * 1024 * 1024) throw err(413, 'el PDF pesa más de ' + topeMb + ' MB');
      /* Firma antes de tocar nada: ghostscript con un archivo que no es PDF es un proceso
       * más y un error feo; además así un .exe renombrado ni siquiera llega al disco. */
      if (buf.slice(0, 5).toString('latin1') !== '%PDF-') throw err(415, 'el archivo no es un PDF');
      if (!buf.slice(-4096).toString('latin1').includes('%%EOF')) throw err(415, 'el PDF está incompleto o dañado');

      fs.writeFileSync(pdfPath, buf, { mode: 0o644 });
      const paginas = await pdfATiff(pdfPath, tifPath, co);
      const { rows } = await pool.query(
        `INSERT INTO pbxng_fax_out (numero,nombre,asunto,archivo,tiff,paginas,bytes,max_intentos,usuario)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ` + COLS_OUT,
        [numero, String(req.query.nombre || '').slice(0, 80) || null, String(req.query.asunto || '').slice(0, 120) || null,
          base + '.pdf', base + '.tif', paginas, buf.length,
          maxIntentos(co), (req.user && req.user.username) || null]);
      broadcastSoon();
      colaTick().catch(() => {});     // que salga ya, sin esperar la próxima vuelta del reloj
      res.status(201).json(rows[0]);
    } catch (e) {
      for (const f of [pdfPath, tifPath]) { try { fs.unlinkSync(f); } catch (_) {} }
      errorHttp(res, e);
    }
  });

  app.get('/api/fax/out/:id/pdf', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT id,archivo FROM pbxng_fax_out WHERE id=$1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'no existe' });
      return bajar(res, DIR_OUT, rows[0].archivo, 'application/pdf', 'fax-enviado-' + rows[0].id + '.pdf');
    } catch (e) { errorHttp(res, e); }
  });

  /* Reintentar a mano lo que ya se dio por perdido: el PDF sigue en disco, así que no hay
   * que volver a subirlo (que es justo la molestia que evita tener cola). */
  app.post('/api/fax/out/:id/retry', async (req, res) => {
    try {
      const co = await cfg();
      const { rows } = await pool.query(
        `UPDATE pbxng_fax_out SET estado='pendiente', proximo_intento=now(), intentos=0,
           max_intentos=$2, detalle=NULL, enviando_desde=NULL, updated_at=now()
         WHERE id=$1 AND estado IN ('error','cancelado') RETURNING ` + COLS_OUT,
        [req.params.id, maxIntentos(co)]);
      if (!rows[0]) return res.status(409).json({ error: 'sólo se pueden reintentar los faxes que fallaron o se cancelaron' });
      broadcastSoon();
      colaTick().catch(() => {});
      res.json(rows[0]);
    } catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/fax/out/:id', async (req, res) => {
    try {
      /* Un trabajo que está sonando en este momento no se borra: se cancela para que no se
       * reintente, y la llamada en curso termina sola. Borrarle el archivo en el medio es
       * dejar a SendFAX leyendo un archivo que ya no está.
       * Y queda en `cancelando`, NO en `cancelado`: el canal sigue vivo unos segundos más y
       * darlo por cerrado de una lo sacaría del chequeo de "un fax a la vez" de la cola, que
       * arrancaría el siguiente con el anterior todavía modulando en la misma troncal.
       * `cerrarIntento` lo pasa a `cancelado` cuando el dialplan avisa, y si ese aviso nunca
       * llega lo destraba el barrido de colgados del reloj. */
      const { rows } = await pool.query('SELECT id,estado,archivo,tiff FROM pbxng_fax_out WHERE id=$1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'no existe' });
      if (rows[0].estado === 'enviando' || rows[0].estado === 'cancelando') {
        await pool.query("UPDATE pbxng_fax_out SET estado='cancelando', max_intentos=0, updated_at=now() WHERE id=$1", [rows[0].id]);
        broadcastSoon();
        return res.json({ cancelled: rows[0].id });
      }
      await pool.query('DELETE FROM pbxng_fax_out WHERE id=$1', [rows[0].id]);
      for (const f of [rows[0].archivo, rows[0].tiff]) if (f) { try { fs.unlinkSync(path.join(DIR_OUT, path.basename(f))); } catch (_) {} }
      broadcastSoon();
      res.json({ deleted: rows[0].id });
    } catch (e) { errorHttp(res, e); }
  });

  return { syncFax, filasRx, filasTx, paginasTiff, aplicarT38 };
};
