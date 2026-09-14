/* ============================================================================
 *  PBX-NG · Telefonía clásica de oficina (sprint 6, bloque A de
 *  docs/BRECHA-UCM-XORCOM.md): horarios y modo noche, desvíos / DND / sígueme
 *  por interno y el catálogo editable de códigos de función.
 *
 *  POR QUÉ ESTÁ PARTIDO EN DOS LUGARES (Postgres + AstDB):
 *  la fuente de verdad es PostgreSQL —es lo que se respalda, lo que ve el panel y
 *  lo que sobrevive a una reinstalación de Asterisk—, pero el dialplan NO consulta
 *  la base: lee la AstDB (`DB(dnd/<ext>)`, `DB(cfu/<ext>)`…), igual que ya hace la
 *  grabación con `DB(rec/<ext>)`. Así cambiar un desvío es un DBPut por AMI: no
 *  recarga el dialplan, no reconstruye la imagen y funciona en medio de una llamada.
 *  Cada escritura de acá toca las dos cosas, y `syncFeatures()` vuelca Postgres →
 *  AstDB al arrancar (por si Asterisk se reinició y perdió el astdb, o al revés).
 *
 *  Claves de AstDB que escribe este módulo (las lee el dialplan):
 *    dnd/<ext>=1 · cfu/<ext> · cfb/<ext> · cfnr/<ext> · fm/<ext> · fmt/<ext>
 *    nightmode = auto|abierto|cerrado · hol/<MM-DD> y hol/<YYYY-MM-DD> = 1
 *  `rec/<ext>` y `rec/_ALL_` son de recordings.js y acá no se tocan.
 *
 *  Las rutas ENTRANTES con horario las genera trunks.js (es el dueño de
 *  `routes/inbound`): acá sólo se le pide que regenere cuando cambia un horario o
 *  un feriado, vía `regenerarEntrantes` de deps.
 *
 *  Acceso (rbac.js): features del interno propio = cualquier rol y el token de
 *  softphone (la ruta exige la ext propia con `exigirExt`); horarios, feriados,
 *  códigos de función y el PUT de modo noche = admin; `GET /api/nightmode` también
 *  supervisor. `POST /api/internal/feature` es público (PUBLIC_API) pero sólo se acepta
 *  desde LOOPBACK, sin cabecera de proxy y con el token de /etc/pbxng/agent.token: lo
 *  llama el dialplan por CURL contra 127.0.0.1. Ojo: "red privada" NO alcanzaba como
 *  filtro, porque el panel proxya /backend/** y la IP que ve la API es la del navegador.
 * ==========================================================================*/
'use strict';

const express = require('express');
const crypto = require('crypto');
/* Quién ocupa cada extensión del contexto compartido `internal`: la lista es única y la
 * comparten marcacion.js y este módulo (ver el encabezado de dueno-internal.js). */
const dueno = require('./dueno-internal');

/**
 * deps:
 *   app                Express (las rutas se registran acá, DESPUÉS del gate de auth + RBAC)
 *   pool               pg.Pool
 *   amiAction          (action) => respuesta AMI; se usa para DBPut/DBDel sobre la AstDB
 *   setDialplan        (client, context, exten, rows) escribe una extensión en el dialplan realtime (app.js)
 *   exigirExt          (req, res, ext) => false y responde 403 si la sesión no alcanza a ese interno (auth.js)
 *   clientIp           (req) => IP real del cliente (auth.js, respeta trust proxy)
 *   agentToken         secreto compartido con los agentes (/etc/pbxng/agent.token, app.js);
 *                      viaja en el CURL del dialplan y se exige en POST /api/internal/feature
 *   errorHttp          traduce errores a {error} con status (errores.js)
 *   broadcastSoon      refresca el snapshot del socket
 *   regenerarEntrantes ({horario_id}) => regenera el dialplan de las rutas entrantes (trunks.js)
 *   logger             fábrica de loggers (log.js)
 *
 * Devuelve: { syncFeatures, estadoNightmode, filasCodigo, tramoAhora }
 * (lo último, generadores puros, para las pruebas).
 */
module.exports = function init(deps) {
  const { app, pool, amiAction, setDialplan, exigirExt, clientIp, errorHttp, broadcastSoon, regenerarEntrantes, logger } = deps;
  const log = logger ? logger('telefonia') : { info() {}, error() {} };

  /* URL con la que ASTERISK ve a esta API. Asterisk corre en la red del host y la API
   * publica :3000 sólo en loopback, así que 127.0.0.1:3000 es el caso normal; se puede
   * cambiar con AST_API_URL (mismo valor que API_URL del contenedor de Asterisk). */
  const API_URL = String(process.env.AST_API_URL || process.env.API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const API_BASE = /^https?:\/\//.test(API_URL) ? API_URL : 'http://' + API_URL;

  // ── Ayudantes ────────────────────────────────────────────────────────────
  const err = (status, msg) => Object.assign(new Error(msg), { status });
  /* Destino de un desvío / sígueme: SÓLO dígitos. Un destino es siempre un interno o un
   * número marcable por la ruta saliente, y ambos son dígitos. `*` y `#` están prohibidos a
   * propósito: el destino termina dentro de un `Goto(internal,<destino>,1)` y en ese mismo
   * contexto viven los códigos de función, que toman la identidad del canal EN CURSO (el
   * que LLAMA, no el dueño del desvío). Con `cfu=*21*099…` el que te llamaba se llevaba el
   * desvío puesto a él —interceptación y fraude de tarifación—, y con `cfu=*78` quedaba en
   * no molestar. Sin `*` ni `#` no hay código de función que matchear. */
  const DESTINO = /^[0-9]{1,32}$/;
  const EXT_OK = /^[A-Za-z0-9_-]{1,32}$/;
  const CODE_OK = /^_?[*#0-9][*#0-9A-Za-z.!\][-]{0,23}$/;
  const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const DIAS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const DIA_OK = new RegExp('^(\\*|(' + DIAS.join('|') + ')(-(' + DIAS.join('|') + '))?)$');
  const MD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  /* SÓLO loopback. El criterio anterior ("red privada", el mismo que usa el agente de
   * Asterisk) era un agujero: el panel (dashboard/server.js) proxya TODO /backend/** a la
   * API y deja la IP real del cliente como ÚLTIMO elemento de X-Forwarded-For, y la API
   * confía un salto (trust proxy = 1), así que req.ip terminaba siendo la IP LAN del
   * navegador — privada, o sea que pasaba. Cualquiera en la oficina, sin sesión, podía
   * POSTear /backend/api/internal/feature y ponerle un desvío al interno ajeno (escucha de
   * llamadas) o dejarlo en no molestar. Asterisk corre en network_mode: host y llega por
   * http://127.0.0.1:3000 (ver API_BASE), así que loopback alcanza y sobra. */
  function esLoopback(ip) {
    const s = String(ip || '').replace(/^::ffff:/i, '');
    return s === '::1' || s === '127.0.0.1' || /^127\./.test(s);
  }

  /* Defensa en profundidad sobre lo anterior: el mismo secreto compartido que la API ya
   * usa con los agentes (/etc/pbxng/agent.token, volumen `certs`, montado ro en Asterisk).
   * Viaja en el CURL de los códigos de función y se compara en tiempo constante. Si
   * alguna vez hay que aflojar el filtro de loopback (Asterisk en otro host), esto es lo
   * único que queda separando al dialplan de cualquiera que llegue al puerto. Una
   * instalación sin token (no debería: app.js lo genera al arrancar) no exige nada. */
  const TOKEN = String(deps.agentToken || '');
  const TOK_Q = TOKEN ? '&tok=' + encodeURIComponent(TOKEN) : '';
  function tokenOk(req) {
    const dado = Buffer.from(String((req.body || {}).tok || (req.query || {}).tok || ''), 'utf8');
    const esp = Buffer.from(TOKEN, 'utf8');
    return dado.length === esp.length && crypto.timingSafeEqual(dado, esp);
  }
  /* Único armador del CURL al que avisan los códigos: así el token no se olvida en ninguno. */
  const curlFeat = (qs) => 'FEATRES=${CURL(' + API_BASE + '/api/internal/feature,' + qs + TOK_Q + ')}';

  /* AstDB por AMI. Se traga los errores a propósito (mismo criterio que setRecFlag de
   * recordings.js): si Asterisk está caído la verdad sigue en Postgres y syncFeatures()
   * la vuelve a volcar al reconectar; fallar el PUT dejaría al panel sin poder guardar. */
  async function astPut(family, key, val) {
    try { await amiAction({ Action: 'DBPut', Family: family, Key: String(key), Val: String(val) }); } catch (_) {}
  }
  async function astDel(family, key) {
    try { await amiAction({ Action: 'DBDel', Family: family, Key: String(key) }); } catch (_) {}
  }

  /* Modo noche en la AstDB. El contrato del sprint lo llamó `DB(nightmode)` a secas, pero
   * la función DB() de Asterisk EXIGE familia/clave (func_db.c: "DB requires an argument,
   * DB(<family>/<key>)"), así que sería siempre vacío y con un WARNING por llamada. Se usa
   * `DB(nightmode/modo)`, que es lo mismo con la forma que Asterisk acepta; todos los que
   * lo leen son dialplan generado por esta API (rutas entrantes y el código *28). */
  const NM_FAM = 'nightmode', NM_KEY = 'modo';
  const NM_VAR = 'DB(' + NM_FAM + '/' + NM_KEY + ')';

  const setGet = async (k, def) => { try { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value != null ? rows[0].value : def; } catch (_) { return def; } };
  const setPut = (k, v) => pool.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, String(v)]);

  // ═══════════════ Desvíos, DND y sígueme por interno ══════════════════════

  const FEAT_DEF = { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '', fm_seg: 15 };
  const salidaFeat = (r) => (r
    ? { dnd: r.dnd === true, cfu: r.cfu || '', cfb: r.cfb || '', cfnr: r.cfnr || '', fm: r.fm || '', fm_seg: r.fm_seg == null ? 15 : r.fm_seg }
    : Object.assign({}, FEAT_DEF));

  /* Estado del interno → AstDB. Vacío = borrar la clave: el dialplan pregunta por el
   * contenido, y una clave con '' no es lo mismo que una clave ausente en DB_EXISTS. */
  async function aplicarFeat(ext, f) {
    if (f.dnd) await astPut('dnd', ext, '1'); else await astDel('dnd', ext);
    for (const k of ['cfu', 'cfb', 'cfnr', 'fm']) {
      if (f[k]) await astPut(k, ext, f[k]); else await astDel(k, ext);
    }
    if (f.fm) await astPut('fmt', ext, f.fm_seg || 15); else await astDel('fmt', ext);
  }

  async function leerFeat(ext) {
    const { rows } = await pool.query('SELECT * FROM pbxng_ext_features WHERE ext=$1', [ext]);
    return salidaFeat(rows[0]);
  }

  /* Guarda el estado del interno en Postgres (fuente de verdad) y en la AstDB (lo que
   * lee el dialplan). `parcial` sólo pisa los campos presentes. */
  async function guardarFeat(ext, parcial) {
    const actual = await leerFeat(ext);
    const f = Object.assign({}, actual, parcial);
    f.dnd = !!f.dnd;
    for (const k of ['cfu', 'cfb', 'cfnr', 'fm']) {
      f[k] = String(f[k] || '').trim();
      if (f[k] && !DESTINO.test(f[k])) throw err(400, 'destino inválido en ' + k + ' (sólo dígitos, hasta 32)');
    }
    f.fm_seg = Math.min(120, Math.max(5, parseInt(f.fm_seg, 10) || 15));
    await pool.query(
      `INSERT INTO pbxng_ext_features (ext,dnd,cfu,cfb,cfnr,fm,fm_seg,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (ext) DO UPDATE SET dnd=$2, cfu=$3, cfb=$4, cfnr=$5, fm=$6, fm_seg=$7, updated_at=now()`,
      [ext, f.dnd, f.cfu || null, f.cfb || null, f.cfnr || null, f.fm || null, f.fm_seg]);
    await aplicarFeat(ext, f);
    return f;
  }

  /* Postgres → AstDB al arrancar: internos, feriados y modo noche. Va junto a
   * syncRecFlags de recordings.js (~9 s) porque antes de eso el AMI todavía no conectó. */
  async function syncFeatures() {
    try {
      const { rows } = await pool.query('SELECT * FROM pbxng_ext_features');
      for (const r of rows) await aplicarFeat(r.ext, salidaFeat(r));
      const { rows: fer } = await pool.query('SELECT md, fecha, anual FROM pbxng_feriados');
      for (const f of fer) { const k = claveFeriado(f); if (k) await astPut('hol', k, '1'); }
      await astPut(NM_FAM, NM_KEY, await setGet('nightmode', 'auto'));
      log.info('estado de telefonía volcado a la AstDB', { internos: rows.length, feriados: fer.length });
    } catch (e) { log.error('syncFeatures: ' + (e && e.message)); }
  }

  app.get('/api/extensions/:ext/features', async (req, res) => {
    const ext = String(req.params.ext || '');
    if (!EXT_OK.test(ext)) return res.status(400).json({ error: 'interno inválido' });
    if (!exigirExt(req, res, ext)) return;
    try { res.json(await leerFeat(ext)); } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/extensions/:ext/features', async (req, res) => {
    const ext = String(req.params.ext || '');
    if (!EXT_OK.test(ext)) return res.status(400).json({ error: 'interno inválido' });
    if (!exigirExt(req, res, ext)) return;
    const b = req.body || {};
    const parcial = {};
    if (b.dnd !== undefined) parcial.dnd = !!b.dnd;
    for (const k of ['cfu', 'cfb', 'cfnr', 'fm']) if (b[k] !== undefined) parcial[k] = b[k] == null ? '' : String(b[k]);
    if (b.fm_seg !== undefined) parcial.fm_seg = b.fm_seg;
    try { res.json(await guardarFeat(ext, parcial)); } catch (e) { errorHttp(res, e); }
  });

  // ═══════════════ Horarios ════════════════════════════════════════════════

  /* Un tramo es {dias, desde, hasta} en el formato de GotoIfTime: dias 'mon-fri' o '*',
   * horas 'HH:MM'. Se valida acá porque estos valores se escriben tal cual en el dialplan. */
  function limpiarTramos(v) {
    if (!Array.isArray(v)) throw err(400, 'tramos tiene que ser una lista');
    if (v.length > 20) throw err(400, 'demasiados tramos (máximo 20)');
    return v.map((t) => {
      const dias = String((t && t.dias) || '*').toLowerCase().trim();
      const desde = String((t && t.desde) || '').trim();
      const hasta = String((t && t.hasta) || '').trim();
      if (!DIA_OK.test(dias)) throw err(400, 'días inválidos: ' + dias + " (ej. 'mon-fri' o '*')");
      if (!HORA.test(desde) || !HORA.test(hasta)) throw err(400, 'horas inválidas: se esperan HH:MM');
      return { dias, desde, hasta };
    });
  }

  app.get('/api/horarios', async (req, res) => {
    try { const { rows } = await pool.query('SELECT id,nombre,tramos,activo FROM pbxng_horarios ORDER BY id'); res.json(rows); }
    catch (e) { errorHttp(res, e); }
  });
  app.post('/api/horarios', async (req, res) => {
    const b = req.body || {};
    try {
      const tramos = limpiarTramos(b.tramos || []);
      const { rows } = await pool.query('INSERT INTO pbxng_horarios (nombre,tramos,activo) VALUES ($1,$2,$3) RETURNING id,nombre,tramos,activo',
        [String(b.nombre || 'Horario').slice(0, 80), JSON.stringify(tramos), b.activo !== false]);
      res.status(201).json(rows[0]);
    } catch (e) { errorHttp(res, e); }
  });
  app.put('/api/horarios/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    try {
      const tramos = b.tramos === undefined ? null : limpiarTramos(b.tramos);
      const { rows } = await pool.query(
        `UPDATE pbxng_horarios SET nombre=COALESCE($2,nombre), tramos=COALESCE($3,tramos), activo=COALESCE($4,activo)
         WHERE id=$1 RETURNING id,nombre,tramos,activo`,
        [id, b.nombre === undefined ? null : String(b.nombre).slice(0, 80), tramos ? JSON.stringify(tramos) : null, b.activo === undefined ? null : !!b.activo]);
      if (!rows[0]) return res.status(404).json({ error: 'horario inexistente' });
      // Los tramos viven en el dialplan de cada DID: cambiar el horario obliga a regenerarlos.
      await regenerar({ horario_id: id });
      res.json(rows[0]);
    } catch (e) { errorHttp(res, e); }
  });
  app.delete('/api/horarios/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { rowCount } = await pool.query('DELETE FROM pbxng_horarios WHERE id=$1', [id]);
      if (!rowCount) return res.status(404).json({ error: 'horario inexistente' });
      // Las rutas que lo usaban vuelven a ser de 24 h (una sola extensión, sin ramas).
      await pool.query('UPDATE pbxng_inbound_routes SET horario_id=NULL WHERE horario_id=$1', [id]);
      await regenerar({});
      if (String(await setGet('nightmode_horario_id', '')) === String(id)) await setPut('nightmode_horario_id', '');
      res.json({ deleted: id });
    } catch (e) { errorHttp(res, e); }
  });

  async function regenerar(filtro) {
    if (typeof regenerarEntrantes !== 'function') return;
    try { await regenerarEntrantes(filtro || {}); } catch (e) { log.error('regenerar rutas entrantes: ' + (e && e.message)); }
  }

  // ═══════════════ Feriados ════════════════════════════════════════════════

  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  /* La clave en la AstDB es 'MM-DD' para los anuales y 'YYYY-MM-DD' para los puntuales:
   * el dialplan pregunta por las dos con DB_EXISTS y le alcanza una. */
  function claveFeriado(f) {
    if (f.anual) return f.md || (f.fecha ? ymd(new Date(f.fecha)).slice(5) : '');
    return f.fecha ? ymd(new Date(f.fecha)) : '';
  }

  app.get('/api/feriados', async (req, res) => {
    try { const { rows } = await pool.query('SELECT id,md,fecha,nombre,anual FROM pbxng_feriados ORDER BY anual DESC, COALESCE(md, to_char(fecha,\'MM-DD\'))'); res.json(rows); }
    catch (e) { errorHttp(res, e); }
  });
  app.post('/api/feriados', async (req, res) => {
    const b = req.body || {};
    const anual = b.anual !== false;
    try {
      let md = b.md ? String(b.md).trim() : null;
      let fecha = b.fecha ? String(b.fecha).trim() : null;
      if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw err(400, 'fecha inválida (YYYY-MM-DD)');
      if (!md && fecha) md = fecha.slice(5);
      if (anual && (!md || !MD.test(md))) throw err(400, 'feriado anual: se espera md con formato MM-DD');
      if (!anual && !fecha) throw err(400, 'feriado puntual: se espera fecha YYYY-MM-DD');
      const { rows } = await pool.query('INSERT INTO pbxng_feriados (md,fecha,nombre,anual) VALUES ($1,$2,$3,$4) RETURNING id,md,fecha,nombre,anual',
        [anual ? md : null, fecha, String(b.nombre || '').slice(0, 80) || null, anual]);
      await astPut('hol', claveFeriado(rows[0]), '1');
      await regenerar({});
      res.status(201).json(rows[0]);
    } catch (e) { errorHttp(res, e); }
  });
  app.put('/api/feriados/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    try {
      const { rows: viejo } = await pool.query('SELECT id,md,fecha,anual FROM pbxng_feriados WHERE id=$1', [id]);
      if (!viejo[0]) return res.status(404).json({ error: 'feriado inexistente' });
      const md = b.md === undefined ? null : String(b.md).trim();
      if (md && !MD.test(md)) throw err(400, 'md inválido (MM-DD)');
      const fecha = b.fecha === undefined ? null : (b.fecha ? String(b.fecha).trim() : null);
      if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw err(400, 'fecha inválida (YYYY-MM-DD)');
      const { rows } = await pool.query(
        `UPDATE pbxng_feriados SET md=COALESCE($2,md), fecha=COALESCE($3,fecha), nombre=COALESCE($4,nombre), anual=COALESCE($5,anual)
         WHERE id=$1 RETURNING id,md,fecha,nombre,anual`,
        [id, md, fecha, b.nombre === undefined ? null : String(b.nombre).slice(0, 80), b.anual === undefined ? null : !!b.anual]);
      const antes = claveFeriado(viejo[0]);
      const ahora = claveFeriado(rows[0]);
      if (antes && antes !== ahora) await astDel('hol', antes);
      if (ahora) await astPut('hol', ahora, '1');
      await regenerar({});
      res.json(rows[0]);
    } catch (e) { errorHttp(res, e); }
  });
  app.delete('/api/feriados/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { rows } = await pool.query('DELETE FROM pbxng_feriados WHERE id=$1 RETURNING id,md,fecha,anual', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'feriado inexistente' });
      const k = claveFeriado(rows[0]);
      if (k) await astDel('hol', k);
      await regenerar({});
      res.json({ deleted: id });
    } catch (e) { errorHttp(res, e); }
  });

  // ═══════════════ Modo noche ══════════════════════════════════════════════

  const idxDia = (d) => DIAS.indexOf(d);
  /* ¿El día de la semana `dow` (0=domingo) entra en 'mon-fri' / 'sat' / '*'? El rango
   * puede dar la vuelta a la semana (p. ej. 'fri-mon'), como en GotoIfTime. */
  function diaEn(spec, dow) {
    if (spec === '*') return true;
    const [a, b] = spec.split('-');
    const ia = idxDia(a), ib = b ? idxDia(b) : ia;
    if (ia < 0 || ib < 0) return false;
    return ia <= ib ? (dow >= ia && dow <= ib) : (dow >= ia || dow <= ib);
  }
  const minutos = (hhmm) => (+hhmm.slice(0, 2)) * 60 + (+hhmm.slice(3, 5));
  /* ¿`ahora` cae dentro de algún tramo? Un tramo que cruza medianoche ('22:00'-'06:00')
   * se evalúa como dos mitades, igual que lo haría GotoIfTime. */
  function tramoAhora(tramos, ahora) {
    const d = ahora || new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    for (const t of tramos || []) {
      if (!t || !HORA.test(String(t.desde || '')) || !HORA.test(String(t.hasta || ''))) continue;
      if (!diaEn(String(t.dias || '*'), d.getDay())) continue;
      const a = minutos(t.desde), b = minutos(t.hasta);
      if (a <= b ? (m >= a && m <= b) : (m >= a || m <= b)) return true;
    }
    return false;
  }

  async function horarioDeNoche() {
    const id = parseInt(await setGet('nightmode_horario_id', ''), 10);
    const { rows } = id
      ? await pool.query('SELECT id,nombre,tramos,activo FROM pbxng_horarios WHERE id=$1', [id])
      : await pool.query('SELECT id,nombre,tramos,activo FROM pbxng_horarios WHERE activo=true ORDER BY id LIMIT 1');
    return rows[0] || null;
  }

  /* 'abierto' | 'cerrado' AHORA. Prioridad: modo forzado → feriado (siempre cerrado) →
   * tramos del horario. Sin horario configurado la central está siempre abierta: nadie
   * espera que instalar la actualización empiece a mandar todo al buzón. */
  async function estadoNightmode() {
    const modo = await setGet('nightmode', 'auto');
    if (modo === 'abierto' || modo === 'cerrado') return { modo, estado: modo, motivo: 'forzado desde el panel' };
    const hoy = new Date();
    const { rows: fer } = await pool.query(
      "SELECT nombre FROM pbxng_feriados WHERE (anual=true AND md=$1) OR (anual=false AND fecha=$2::date) LIMIT 1",
      [ymd(hoy).slice(5), ymd(hoy)]);
    if (fer[0]) return { modo: 'auto', estado: 'cerrado', motivo: 'feriado' + (fer[0].nombre ? ': ' + fer[0].nombre : '') };
    const h = await horarioDeNoche();
    if (!h || !h.activo || !Array.isArray(h.tramos) || !h.tramos.length) return { modo: 'auto', estado: 'abierto', motivo: 'sin horario configurado' };
    const dentro = tramoAhora(h.tramos, hoy);
    return { modo: 'auto', estado: dentro ? 'abierto' : 'cerrado', motivo: (dentro ? 'dentro' : 'fuera') + ' del horario ' + (h.nombre || h.id), horario_id: h.id };
  }

  app.get('/api/nightmode', async (req, res) => {
    try {
      const e = await estadoNightmode();
      e.horario_id = e.horario_id != null ? e.horario_id : (parseInt(await setGet('nightmode_horario_id', ''), 10) || null);
      res.json(e);
    } catch (e) { errorHttp(res, e); }
  });
  app.put('/api/nightmode', async (req, res) => {
    const b = req.body || {};
    const modo = String(b.modo || '').trim();
    try {
      if (modo && !['auto', 'abierto', 'cerrado'].includes(modo)) return res.status(400).json({ error: "modo tiene que ser auto, abierto o cerrado" });
      if (modo) { await setPut('nightmode', modo); await astPut(NM_FAM, NM_KEY, modo); }
      if (b.horario_id !== undefined) await setPut('nightmode_horario_id', b.horario_id == null ? '' : String(parseInt(b.horario_id, 10) || ''));
      const e = await estadoNightmode();
      broadcastSoon();
      res.json(e);
    } catch (e) { errorHttp(res, e); }
  });

  // ═══════════════ Códigos de función ══════════════════════════════════════

  /* Un código de función tiene DOS formas y confundirlas rompe el marcado:
   *  - `extenDe`: sin el `_` inicial. Es la que se le muestra al usuario y la que sirve
   *    para contar posiciones (`${EXTEN:N}`).
   *  - `extenDp`: la que va a la tabla realtime `extensions`, con el `_` puesto cuando el
   *    código es un patrón. pbx_realtime sólo corre ast_extension_match sobre las filas
   *    que empiezan con `_` (su segunda consulta es literalmente `exten LIKE '\_%'`); una
   *    fila sin `_` se compara como texto literal, así que `*21*.` guardado pelado no
   *    matchea `*21*1002#` y la llamada se muere sin hacer nada. Misma convención que
   *    `outExten()` de trunks.js, que agrega el `_` por este mismo motivo. */
  const extenDe = (code) => String(code || '').replace(/^_/, '');
  /* Caracteres que convierten un código en patrón de Asterisk: comodines de dígito
   * (X/Z/N), rangos `[...]`, y `.`/`!` de "uno o más". */
  const esPatron = (code) => /[.![NXZnxz]/.test(extenDe(code));
  const extenDp = (code) => {
    const c = String(code || '');
    if (c[0] === '_') return c;
    return esPatron(c) ? '_' + c : c;
  };
  /* Dónde empiezan los dígitos que marcó el usuario en un patrón: '_*21*.' → EXTEN:4. */
  function desplazamiento(code) {
    const ex = extenDe(code);
    if (!esPatron(code)) return 0;
    const i = ex.indexOf('.');
    return i > 0 ? i : ex.length;
  }
  /* Aviso a Postgres de lo que el usuario acaba de hacer desde el teléfono: el dialplan
   * ya escribió la AstDB, este CURL es el que mantiene la base y el panel al día. */
  function avisar(accion, valorExpr) {
    const v = valorExpr ? '${URIENCODE(' + valorExpr + ')}' : '';
    return [null, 'Set', curlFeat('ext=${URIENCODE(${MIEXT})}&accion=' + accion + '&valor=' + v)];
  }

  /* Filas del dialplan de una acción. MIEXT sale de CHANNEL(endpoint) en PJSIP y no de
   * CALLERID(num) por el mismo motivo que *97 en extensions.conf: el CALLERID lo pone el
   * teléfono, así que un interno podría poner desvío en el interno de otro. */
  function filasCodigo(accion, code, nombre) {
    const off = desplazamiento(code);
    /* Lo que el usuario marcó DESPUÉS del código, pasado por FILTER(0-9,...): el `.` del
     * patrón `_*21*.` también matchea `*` y `#`, así que sin filtrar se podía marcar
     * `*21**78` y dejar en la AstDB un destino que después el dialplan mete crudo en un
     * `Goto(internal,...)` —el mismo contexto donde viven estos códigos, que toman la
     * identidad del canal en curso—. Validar sólo en la API no alcanzaba porque este
     * camino escribe la AstDB sin pasar por ella. FILTER está en func_strings.so, que
     * modules.conf ya exige. */
    const dest = '${FDEST}';
    const yo = '${MIEXT}';
    const cab = [
      [null, 'NoOp', (nombre || accion) + ' (' + code + ')'],
      [null, 'Answer', ''],
      [null, 'Set', 'MIEXT=${IF($["${CHANNEL(channeltype)}"="PJSIP"]?${CHANNEL(endpoint)}:${CALLERID(num)})}'],
    ];
    const fin = [[null, 'Hangup', '']];
    /* Cabecera de las acciones que reciben destino: lo filtra y, si no queda ni un dígito
     * (marcaron `*21*` a secas o `*21**78`), locuta error y corta SIN escribir la AstDB —
     * una clave vacía es peor que ninguna, porque DB_EXISTS la da por puesta. */
    const conDest = cab.concat([
      [null, 'Set', 'FDEST=${FILTER(0-9,${EXTEN:' + off + '})}'],
      [null, 'ExecIf', '$["' + dest + '"=""]?Playback(invalid)'],
      [null, 'ExecIf', '$["' + dest + '"=""]?Hangup()'],
    ]);
    const prender = (fam, sonido) => conDest.concat([
      [null, 'Set', 'DB(' + fam + '/' + yo + ')=' + dest],
      avisar(fam, dest),
      [null, 'Playback', sonido + '&activated'],
      [null, 'SayDigits', dest],
    ], fin);
    const apagar = (fam, sonido) => cab.concat([
      [null, 'Set', 'BORRADO=${DB_DELETE(' + fam + '/' + yo + ')}'],
      [null, 'Set', curlFeat('ext=${URIENCODE(' + yo + ')}&accion=off&valor=' + fam)],
      [null, 'Playback', sonido + '&de-activated'],
    ], fin);

    switch (accion) {
      case 'dnd_on':
        return cab.concat([
          [null, 'Set', 'DB(dnd/' + yo + ')=1'],
          avisar('dnd_on', null),
          [null, 'Playback', 'do-not-disturb&activated'],
        ], fin);
      case 'dnd_off':
        return cab.concat([
          [null, 'Set', 'BORRADO=${DB_DELETE(dnd/' + yo + ')}'],
          avisar('dnd_off', null),
          [null, 'Playback', 'do-not-disturb&de-activated'],
        ], fin);
      case 'cfu_set':  return prender('cfu', 'call-fwd-unconditional');
      case 'cfu_off':  return apagar('cfu', 'call-fwd-unconditional');
      case 'cfb_set':  return prender('cfb', 'call-fwd-on-busy');
      case 'cfb_off':  return apagar('cfb', 'call-fwd-on-busy');
      case 'cfnr_set': return prender('cfnr', 'call-fwd-no-answer');
      case 'cfnr_off': return apagar('cfnr', 'call-fwd-no-answer');
      case 'fm_set':
        return conDest.concat([
          [null, 'Set', 'DB(fm/' + yo + ')=' + dest],
          // El tiempo de timbrado antes de saltar al celular sólo se fija si no había uno.
          [null, 'ExecIf', '$["${DB(fmt/' + yo + ')}"=""]?Set(DB(fmt/' + yo + ')=15)'],
          avisar('fm', dest),
          [null, 'Playback', 'call-fwd-unconditional&activated'],
          [null, 'SayDigits', dest],
        ], fin);
      case 'fm_off':
        return cab.concat([
          [null, 'Set', 'BORRADO=${DB_DELETE(fm/' + yo + ')}'],
          [null, 'Set', 'BORRADO=${DB_DELETE(fmt/' + yo + ')}'],
          [null, 'Set', curlFeat('ext=${URIENCODE(' + yo + ')}&accion=off&valor=fm')],
          [null, 'Playback', 'call-fwd-unconditional&de-activated'],
        ], fin);
      case 'night':
        return cab.concat([
          [null, 'Set', 'NMODO=${' + NM_VAR + '}'],
          [null, 'Set', 'NMODO=${IF($["${NMODO}"="cerrado"]?abierto:cerrado)}'],
          [null, 'Set', NM_VAR + '=${NMODO}'],
          [null, 'Set', curlFeat('ext=${URIENCODE(' + yo + ')}&accion=night&valor=${NMODO}')],
          [null, 'Playback', 'activated'],
        ], fin);
      // Los cuatro de siempre: mismas filas que tenía el FEATURE_CODES fijo de apps.js.
      case 'eco':       return [[1, 'Answer', ''], [2, 'Echo', ''], [3, 'Hangup', '']];
      case 'midigito':  return [[1, 'Answer', ''], [2, 'SayDigits', '${CALLERID(num)}'], [3, 'Hangup', '']];
      case 'vm_propio': return [[1, 'Answer', ''], [2, 'VoiceMailMain', '${CALLERID(num)}@default'], [3, 'Hangup', '']];
      case 'vm_otro':   return [[1, 'Answer', ''], [2, 'VoiceMailMain', ''], [3, 'Hangup', '']];
      default: return null;
    }
  }

  /* Numera las filas (las de arriba se arman sin prioridad para poder concatenarlas). */
  const numerar = (filas) => filas.map((f, i) => [i + 1, f[1], f[2]]);

  const DESC = {
    dnd_on: 'Activa no molestar: las llamadas van directo al buzón',
    dnd_off: 'Desactiva no molestar',
    cfu_set: 'Desvía todas las llamadas al destino que marques',
    cfu_off: 'Apaga el desvío incondicional',
    cfb_set: 'Desvía cuando estás ocupado',
    cfb_off: 'Apaga el desvío si ocupado',
    cfnr_set: 'Desvía cuando no contestás',
    cfnr_off: 'Apaga el desvío si no contesta',
    fm_set: 'Sígueme: después de timbrar tu interno suena el número que marques',
    fm_off: 'Apaga el sígueme',
    night: 'Alterna el modo noche entre abierto y cerrado',
    eco: 'Repite tu voz para probar audio',
    midigito: 'Locuta el número del interno',
    vm_propio: 'Entra al buzón del interno que llama',
    vm_otro: 'Pide número de buzón y PIN',
  };

  async function catalogo(client) {
    const q = client || pool;
    const { rows } = await q.query('SELECT accion,code,nombre,enabled FROM pbxng_featurecodes ORDER BY code');
    return rows;
  }

  /* Publica en el dialplan realtime los códigos habilitados y borra los apagados.
   *
   * `internal` es un contexto COMPARTIDO y `setDialplan` es DELETE + INSERT: publicar un
   * código de función sobre una extensión que ya usa una DISA le borraba el dialplan sin
   * avisar. Es el mismo error que marcacion.js ya no comete contra estos códigos, en
   * espejo, así que la pregunta la contesta el MISMO lugar para los dos
   * (`dueno-internal.js`).
   *
   * DOS PASADAS, Y SIGUE SIENDO TODO O NADA. La primera pregunta por TODOS los códigos y no
   * escribe; si alguno choca, no se instala ninguno y el 409 los nombra a TODOS, con el
   * código, la función y quién ocupa el número. Antes se cortaba en el primero: el que
   * apretaba «Reinstalar todos» se quedaba sin catálogo y con un mensaje que no decía cuál
   * era el código culpable, y con dos choques había que descubrirlos de a uno.
   *
   * Por qué no se instala «lo que se puede» y se listan los que quedaron afuera: la pantalla
   * de códigos de función no muestra cuáles están publicados —sólo el catálogo y su
   * interruptor—, así que una instalación parcial es invisible para el que la está mirando y
   * lo deja creyendo que quedó todo. Entre media central publicada en silencio y un mensaje
   * que dice exactamente qué arreglar, sobre una central que cursa llamadas reales, preferimos
   * lo segundo. Si algún día el panel muestra el estado por fila, esto se puede revisar. */
  async function publicar(c, codes) {
    const chocan = [];
    const listos = [];
    for (const f of codes) {
      const exten = extenDp(f.code);
      const filas = filasCodigo(f.accion, f.code, f.nombre);
      if (!filas) continue;                                        // acción desconocida: no se inventa dialplan
      if (!f.enabled) { await dueno.borrarPropio(c, exten, 'featurecode', f.accion, log); continue; }
      const d = await dueno.duenoDeInternal(c, exten, 'featurecode', f.accion);
      if (d) chocan.push(f.code + ' «' + (f.nombre || f.accion) + '», que ocupa ' + d.que);
      else listos.push([exten, filas]);
    }
    if (chocan.length) {
      throw err(409, 'no se instaló ningún código para no pisar lo que ya está publicado: '
        + chocan.join('; ') + '. Cambiá ' + (chocan.length > 1 ? 'esos códigos' : 'ese código')
        + ' (o la aplicación que los ocupa) y volvé a instalar.');
    }
    for (const [exten, filas] of listos) await setDialplan(c, 'internal', exten, numerar(filas));
  }

  app.get('/api/featurecodes', async (req, res) => {
    try {
      const codes = await catalogo();
      const { rows } = await pool.query("SELECT exten FROM extensions WHERE context='internal' AND exten = ANY($1)", [codes.map((f) => extenDp(f.code))]);
      const puestos = new Set(rows.map((r) => r.exten));
      // `name`/`desc` se mantienen por compatibilidad con el panel 1.8.0.
      res.json(codes.map((f) => ({
        accion: f.accion, code: f.code, nombre: f.nombre, name: f.nombre,
        desc: DESC[f.accion] || '', enabled: f.enabled !== false, installed: puestos.has(extenDp(f.code)),
      })));
    } catch (e) { errorHttp(res, e); }
  });

  /* PUT: el CÓDIGO de cada acción es editable. Cambiarlo borra el dialplan del código
   * viejo antes de escribir el nuevo (si no, quedaba marcando el anterior para siempre). */
  app.put('/api/featurecodes', async (req, res) => {
    const b = req.body || {};
    const lista = Array.isArray(b) ? b : (Array.isArray(b.codes) ? b.codes : [b]);
    if (!lista.length) return res.status(400).json({ error: 'no hay códigos para actualizar' });
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }
    try {
      await c.query('BEGIN');
      const previos = await catalogo(c);
      const porAccion = new Map(previos.map((f) => [f.accion, f]));
      for (const item of lista) {
        const accion = String((item && item.accion) || '').trim();
        const viejo = porAccion.get(accion);
        if (!viejo) throw err(404, 'acción desconocida: ' + (accion || '(vacía)'));
        const code = item.code === undefined ? viejo.code : String(item.code).trim();
        if (!CODE_OK.test(code)) throw err(400, 'código inválido: ' + code);
        const enabled = item.enabled === undefined ? viejo.enabled : !!item.enabled;
        /* Mover un código encima de una DISA, un callback o un número corto se rechaza acá
         * aunque el código todavía no esté instalado: el catálogo es la fuente, y el
         * `install` de mañana habría publicado encima sin que nadie eligiera eso. Es la
         * misma regla —y el mismo chequeo— que aplica marcacion.js cuando el que llega
         * segundo es él. */
        await dueno.exigirLibre(c, extenDp(code), 'featurecode', accion);
        // El código viejo se saca del dialplan ANTES de mover el catálogo (si no, quedaba
        // marcando el anterior para siempre), y sólo si ahí está publicado lo nuestro.
        if (code !== viejo.code) await dueno.borrarPropio(c, extenDp(viejo.code), 'featurecode', accion, log);
        await c.query('UPDATE pbxng_featurecodes SET code=$2, enabled=$3, nombre=COALESCE($4,nombre) WHERE accion=$1',
          [accion, code, enabled, item.nombre === undefined ? null : String(item.nombre).slice(0, 80)]);
      }
      // Sólo se reescribe el dialplan si los códigos YA estaban instalados: editar el
      // catálogo no tiene por qué instalar nada en una central donde nadie lo pidió.
      const { rows: hay } = await c.query("SELECT 1 FROM extensions WHERE context='internal' AND exten = ANY($1) LIMIT 1", [previos.map((f) => extenDp(f.code))]);
      if (hay.length) await publicar(c, await catalogo(c));
      await c.query('COMMIT');
      broadcastSoon();
      res.json(await catalogo());
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} errorHttp(res, e); } finally { c.release(); }
  });

  app.post('/api/featurecodes/install', async (req, res) => {
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }
    try {
      await c.query('BEGIN');
      const codes = await catalogo(c);
      await publicar(c, codes);
      await c.query('COMMIT'); broadcastSoon();
      res.json({ ok: true, count: codes.filter((f) => f.enabled !== false).length });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} errorHttp(res, e); } finally { c.release(); }
  });
  app.post('/api/featurecodes/uninstall', async (req, res) => {
    try {
      const codes = await catalogo();
      // Uno por uno y sólo lo propio: un DELETE por lista se llevaba puesto el dialplan de
      // quien hubiera quedado en esa extensión (una DISA, un abreviado) además del nuestro.
      for (const f of codes) await dueno.borrarPropio(pool, extenDp(f.code), 'featurecode', f.accion, log);
      broadcastSoon();
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });

  // ═══════════════ Lo que el dialplan le cuenta a la base ══════════════════

  /* Público (PUBLIC_API) y restringido a loopback + sin cabecera de proxy + token
   * compartido: lo llama el dialplan por CURL contra 127.0.0.1 (Asterisk corre en la red
   * del host) después de escribir la AstDB, para que lo que el usuario hace DESDE EL TELÉFONO
   * quede también en Postgres y se vea en el panel. func_curl manda el cuerpo como
   * formulario, así que acá hace falta el parser de urlencoded (express.json no alcanza). */
  app.post('/api/internal/feature', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    /* Una cabecera de proxy es la marca inequívoca de que el pedido NO vino del CURL del
     * dialplan (que pega derecho a 127.0.0.1 sin proxy de por medio) sino de alguien que
     * pasó por el panel. Se rechaza ANTES de mirar la IP, porque con trust proxy = 1 esa
     * cabecera es justamente la que hace que req.ip sea la del navegador. */
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return res.status(403).json({ error: 'sólo desde la central' });
    if (!esLoopback(clientIp(req))) return res.status(403).json({ error: 'sólo desde la central' });
    if (TOKEN && !tokenOk(req)) return res.status(403).json({ error: 'sólo desde la central' });
    const b = Object.assign({}, req.body || {}, req.query || {});
    const ext = String(b.ext || '').trim();
    const accion = String(b.accion || '').trim();
    const valor = String(b.valor == null ? '' : b.valor).trim();
    try {
      if (accion === 'night') {
        const modo = ['auto', 'abierto', 'cerrado'].includes(valor) ? valor : 'auto';
        await setPut('nightmode', modo);
        await astPut(NM_FAM, NM_KEY, modo);   // idempotente: el *28 ya la escribió, pero así vale para cualquier origen
        broadcastSoon();
        return res.json({ ok: true, modo });
      }
      if (!EXT_OK.test(ext)) return res.status(400).json({ error: 'interno inválido' });
      let parcial;
      if (accion === 'dnd_on') parcial = { dnd: true };
      else if (accion === 'dnd_off') parcial = { dnd: false };
      else if (['cfu', 'cfb', 'cfnr', 'fm'].includes(accion)) parcial = { [accion]: valor };
      else if (accion === 'off') {
        if (['cfu', 'cfb', 'cfnr', 'fm'].includes(valor)) parcial = { [valor]: '' };
        else if (valor === 'dnd') parcial = { dnd: false };
        else parcial = { dnd: false, cfu: '', cfb: '', cfnr: '', fm: '' };
      } else return res.status(400).json({ error: 'acción desconocida' });
      const f = await guardarFeat(ext, parcial);
      broadcastSoon();
      res.json({ ok: true, ext, features: f });
    } catch (e) { errorHttp(res, e); }
  });

  // Postgres → AstDB al arrancar, en la misma ventana que syncRecFlags de recordings.js.
  setTimeout(() => { syncFeatures().catch(() => {}); }, 9000);

  return { syncFeatures, estadoNightmode, filasCodigo: (a, c, n) => { const f = filasCodigo(a, c, n); return f ? numerar(f) : null; }, tramoAhora, leerFeat, guardarFeat };
};
