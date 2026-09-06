/* ============================================================================
 *  PBX-NG · Autenticación y usuarios.
 *
 *  Todo lo que decide QUIÉN es el que pide y qué extensión puede tocar vive acá,
 *  movido de app.js sin cambiar rutas, mensajes ni comportamiento (mismo patrón
 *  que callengine.js / sipconf.js / guard.js: init(deps) registra las rutas en
 *  deps.app y devuelve lo que otros módulos usan):
 *    - auth(): el JWT de panel o el token de softphone (scope 'phone', acotado a
 *      FONO_PERMITIDO); isPublicApi()/PUBLIC_API: la allowlist del gate deny-by-default.
 *    - mismaExt / exigirExt / extPropia: a qué extensión queda acotado el que pide.
 *    - clientIp / limiteIntentos: freno a la fuerza bruta en login y phone/token.
 *    - Rutas: auth/login, auth/setup, auth/password, auth/me, me/sipcreds,
 *      provision, phone/token, enroll/*, enrollments, users/*.
 *    - Bootstrap del usuario 'admin' en el primer arranque.
 *
 *  ORDEN: app.js monta el gate de auth + RBAC (`app.use('/api', …)`) ANTES de
 *  llamar a este init; el gate llama a auth()/isPublicApi() recién en tiempo de
 *  request, así que puede referirlas antes de que existan, pero las RUTAS de acá
 *  tienen que registrarse después del gate o quedarían fuera de él
 *  (docs/CONTRATOS.md §2).
 * ==========================================================================*/
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const logger = require('./log');
const { errorHttp } = require('./errores');   // errores de pg → mensaje genérico (docs/CONTRATOS.md §3)
const emails = require('./emails');

/**
 * deps:
 *   app                 Express (las rutas se registran acá, DESPUÉS del gate)
 *   pool                pg.Pool
 *   SECRET              JWT_SECRET ya validado por app.js (firma y verifica sesiones y tokens phone)
 *   NODES               direcciones del despliegue (domain/asterisk) para provision y enroll
 *   alerts              alerts.onLogin (bitácora de ingresos)
 *   sbcLink             () => estado del enlace SBC-NG (host SIP nativo en el enrolado)
 *   broadcastSoon       refresca el snapshot del socket tras crear un interno
 *   createWebrtcEndpoint(c, ext, password, context, tenant, video)  alta de interno WebRTC (app.js)
 *   smtpHint            traduce errores SMTP a un mensaje útil (app.js, lo comparte /api/email/test)
 */
module.exports = function init(deps) {
  const { app, pool, SECRET, NODES, alerts, sbcLink, broadcastSoon, createWebrtcEndpoint, smtpHint } = deps;

  // ---------------- Autenticación ----------------
  function auth(req, res, next) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) return res.status(401).json({ error: 'no autenticado' });
    try { req.user = jwt.verify(t, SECRET); } catch (e) { return res.status(401).json({ error: 'sesión inválida' }); }

    /* Un token de softphone (scope 'phone') NO es una sesión de panel. Lo emite quien
     * demuestra tener las credenciales SIP de una extensión, así que sólo puede tocar
     * lo de ESA extensión — nunca la configuración de la central. Sin esta barrera,
     * cerrar el buzón habría abierto algo peor: cualquiera con una clave SIP entrando
     * al panel. La lista es explícita a propósito: lo que no está acá, no se puede. */
    if (req.user && req.user.scope === 'phone') {
      // El middleware va montado en '/api', así que req.path acá es '/vm', no '/api/vm'.
      // Hay que rearmar la ruta completa igual que isPublicApi, o no matchea nada.
      const full = (req.baseUrl || '') + req.path;
      const permitido = FONO_PERMITIDO.some(([m, rx]) => (m === req.method || m === '*') && rx.test(full));
      if (!permitido) return res.status(403).json({ error: 'este token sólo sirve para el softphone' });
    }
    next();
  }

  /* Lo único que un token de softphone puede pedir. Las rutas con extensión además
   * verifican, adentro, que la extensión sea la suya (ver mismaExt). */
  const FONO_PERMITIDO = [
    ['GET',  /^\/api\/vm$/],
    ['GET',  /^\/api\/vm\/audio$/],
    ['POST', /^\/api\/vm\/(del|read|transcribe)$/],
    ['GET',  /^\/api\/directory$/],
    ['GET',  /^\/api\/presence$/],
    ['GET',  /^\/api\/ice$/],
    ['GET',  /^\/api\/branding$/],
    ['POST', /^\/api\/calls\/(record|conference)$/],
    // Sólo lo que necesita el propio aparato para sus notificaciones: el comodín push/*
    // dejaba leer GET push/devices (inventario push de todas las extensiones, sólo admin).
    ['POST', /^\/api\/push\/(subscribe|register|unsubscribe|test)$/],
    // Desde 1.4.0 el enrolado entrega un token phone (no una sesión de panel): para que
    // el softphone conserve el historial propio y el screen-pop, se abren estas dos
    // lecturas. /api/cdr fuerza ext = la del token (ver la ruta).
    ['GET',  /^\/api\/cdr$/],
    ['GET',  /^\/api\/clients\/lookup$/],
  ];

  /* ¿El que pide puede meterse con la extensión `ext`?
   *   - token de softphone  -> sólo la suya
   *   - sesión de panel     -> admin y supervisor ven todo; el resto, la suya
   * Antes esto no existía: alcanzaba con mandar ?ext=NNNN y te daban el buzón ajeno. */
  function mismaExt(req, ext) {
    const u = req.user || {};
    const e = String(ext || '');
    if (!e) return false;
    if (u.scope === 'phone') return String(u.ext) === e;
    if (u.role === 'admin' || u.role === 'supervisor') return true;
    return String(u.ext || '') === e;
  }
  function exigirExt(req, res, ext) {
    if (mismaExt(req, ext)) return true;
    res.status(403).json({ error: 'no podés acceder a los datos de otra extensión' });
    return false;
  }
  /* ¿A qué extensión queda ACOTADO el que pide?
   *   null  -> a ninguna: admin/supervisor ven todo
   *   'NNN' -> sólo esa (agente o token de softphone)
   *   ''    -> agente sin interno asignado: no puede ver nada de nadie */
  function extPropia(req) {
    const u = req.user || {};
    if (u.scope === 'phone') return String(u.ext || '');
    if (u.role === 'admin' || u.role === 'supervisor') return null;
    return String(u.ext || '');
  }
  // --- Gate de autenticacion deny-by-default: TODA /api requiere JWT salvo la allowlist publica explicita ---
  const PUBLIC_API = [
    ['POST', /^\/api\/auth\/login$/],
    ['POST', /^\/api\/phone\/token$/],
    ['GET',  /^\/api\/auth\/setup$/],
    ['GET',  /^\/api\/ice$/],
    ['GET',  /^\/api\/branding$/],
    ['GET',  /^\/api\/enroll\/[^/]+$/],
    ['GET',  /^\/api\/prompts\/[^/]+\/audio$/],
    ['GET',  /^\/api\/push\/vapid$/],
    ['POST', /^\/api\/push\/(subscribe|register|unsubscribe)$/],
    ['GET',  /^\/api\/internal\/wake$/],
    ['GET',  /^\/api\/c2c\/public\/[^/]+$/],
    ['GET',  /^\/api\/softphone\/latest$/],       // el login muestra la version descargable sin sesion
    ['POST', /^\/api\/c2c\/public\/[^/]+\/session$/],
    ['POST', /^\/api\/geo\/report$/],
    // Las capturas de los manuales se piden con <img src>, que NO manda el token.
    // Sólo la LECTURA es pública (subir y borrar siguen pidiendo sesión).
    ['GET',  /^\/api\/manuales\/img\/[A-Za-z0-9._-]+$/],
  ];
  function isPublicApi(req) { const full = (req.baseUrl || '') + req.path; return PUBLIC_API.some(([m, re]) => m === req.method && re.test(full)); }

  /* IP del cliente = req.ip: Express ya aplicó `trust proxy = 1`, así que es la que
   * agregó el proxy al FINAL de X-Forwarded-For. Antes se leía el PRIMER elemento del
   * header, que lo escribe el propio cliente: alcanzaba con rotar ese valor para
   * saltear el rate limit del login y falsear la IP de la bitácora y del enrolado. */
  function clientIp(req) {
    return req.ip || (req.socket && req.socket.remoteAddress) || '';
  }
  /* Freno a la fuerza bruta en las dos puertas que validan contraseñas sin sesión.
   * Dos límites encadenados, ambos sobre req.ip (ver clientIp):
   *   - por IP + usuario (o IP + interno), 10 fallos / 10 min: quien rota IPs contra
   *     un usuario no puede bloquear al usuario legítimo desde otra red (sólo se
   *     cuenta SU par IP+usuario).
   *   - por IP sola, 50 fallos / 10 min: la clave IP+usuario NO frena a quien rota
   *     usuarios desde una misma IP (password spraying); este segundo tope sí.
   * Sólo cuentan los intentos fallidos: un login correcto no consume cupo. */
  const MSG_429 = 'Demasiados intentos. Esperá 10 minutos y volvé a probar.';
  function limiteIntentos(campo) {
    const porIp = rateLimit({
      windowMs: 10 * 60 * 1000, limit: 50,
      standardHeaders: 'draft-7', legacyHeaders: false,
      skipSuccessfulRequests: true,
      keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
      handler: (req, res) => res.status(429).json({ error: MSG_429 }),
    });
    const porIpUsuario = rateLimit({
      windowMs: 10 * 60 * 1000, limit: 10,
      standardHeaders: 'draft-7', legacyHeaders: false,
      skipSuccessfulRequests: true,
      keyGenerator: (req) => ipKeyGenerator(clientIp(req)) + ':' + String((req.body || {})[campo] || '').toLowerCase().slice(0, 64),
      handler: (req, res) => res.status(429).json({ error: MSG_429 }),
    });
    return [porIp, porIpUsuario];
  }
  /* Roles que la API entiende. Un usuario con otro rol (p.ej. 'operator'/'viewer', que
   * el panel ofrecía antes de 1.4.0) no debe recibir sesión: la migración 0008 (y el
   * bootstrap de más abajo) los convierte, pero si alguno quedara, el RBAC le daría 403
   * hasta en /api/auth/me y el panel lo dejaría en un bucle login → 403 → login. */
  const ROLES = ['admin', 'supervisor', 'agente'];
  app.post('/api/auth/login', limiteIntentos('username'), async (req, res) => {
    const { username, password } = req.body || {};
    const ip = clientIp(req), ua = String(req.headers['user-agent'] || '').slice(0, 120);
    try {
      const { rows } = await pool.query('SELECT id,username,name,role,ext,password_hash,must_change FROM pbxng_users WHERE username=$1', [username]);
      const u = rows[0];
      /* bcrypt async: compareSync bloquea el event loop ~100 ms por intento, y con el
       * socket.io, el ARI y el AudioSocket de la IA en el mismo proceso eso se nota. */
      if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) {
        alerts.onLogin({ ok: false, username, ip, ua }).catch(() => {});   // no bloquea la respuesta
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      }
      if (!ROLES.includes(u.role)) {
        return res.status(403).json({ error: 'Tu usuario tiene un rol no soportado (' + String(u.role) + '). Pedile al administrador que lo corrija desde Usuarios.' });
      }
      const token = jwt.sign({ uid: u.id, username: u.username, role: u.role, name: u.name, ext: u.ext || null }, SECRET, { expiresIn: '12h' });
      alerts.onLogin({ ok: true, username: u.username, role: u.role, ip, ua }).catch(() => {});
      res.json({ token, user: { username: u.username, name: u.name, role: u.role, ext: u.ext || null }, must_change: !!u.must_change });
    } catch (e) { errorHttp(res, e); }
  });
  app.get('/api/me/sipcreds', auth, async (req, res) => {
    const ext = req.user.ext;
    if (!ext) return res.status(400).json({ error: 'usuario sin interno asignado' });
    try {
      const { rows } = await pool.query('SELECT password FROM ps_auths WHERE id=$1', [String(ext)]);
      if (!rows[0]) return res.status(404).json({ error: 'interno no existe' });
      res.json({ ext: String(ext), password: rows[0].password });
    } catch (e) { errorHttp(res, e); }
  });
  // Aprovisionamiento remoto de un telefono: arma la config completa (SIP + ICE + CRM)
  // para un interno y devuelve tambien el prov_url (pbxng://prov#<b64url>) listo para QR.
  // Solo admin/supervisor. Expone el secret del interno + un token del telefono: uso interno.
  app.get('/api/provision', auth, async (req, res) => {
    if (!['admin', 'supervisor'].includes(req.user.role)) return res.status(403).json({ error: 'no autorizado' });
    const ext = String(req.query.ext || '').trim();
    if (!ext) return res.status(400).json({ error: 'falta ext' });
    try {
      const { rows: au } = await pool.query('SELECT password FROM ps_auths WHERE id=$1', [ext]);
      if (!au[0]) return res.status(404).json({ error: 'interno no existe' });
      const getS = async (k) => { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] ? rows[0].value : ''; };
      const wss = await getS('wss');
      const domain = (await getS('domain')) || NODES.domain || process.env.DOMAIN || '';
      const { rows: us } = await pool.query('SELECT id, username, name, role FROM pbxng_users WHERE ext=$1 LIMIT 1', [ext]);
      const u = us[0] || null;
      const name = (u && u.name) || ext;
      const pub = process.env.PUBLIC_IP || process.env.DOMAIN || domain || '';
      const tuser = process.env.TURN_USER || 'pbxng';
      const tpass = process.env.TURN_PASS || '';
      const stun = process.env.STUN_URL || 'stun:stun.l.google.com:19302';
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
      const host = req.headers['x-forwarded-host'] || req.get('host') || '';
      const apiBase = (await getS('public_base')) || (host ? (proto + '://' + host) : '');
      const useTurn = !!(pub && tpass);
      const cfg = {
        transport: 'webrtc', name, domain, ext, pass: au[0].password, wss,
        stun, turn: useTurn ? ('turn:' + pub + ':3478') : '', turnUser: useTurn ? tuser : '', turnPass: useTurn ? tpass : '',
        apiBase,
        /* Token de softphone (scope 'phone'), no una sesión de panel: si no, un supervisor
         * pidiendo la config del interno de un admin se llevaba una sesión de admin por 30 días. */
        apiToken: jwt.sign({ scope: 'phone', ext }, SECRET, { expiresIn: '30d' }),
      };
      const b64url = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      res.json({ ...cfg, prov_url: 'pbxng://prov#' + b64url });
    } catch (e) { errorHttp(res, e); }
  });
  // Estado de setup (publico): si el admin sigue con la clave por defecto, el login lo sugiere
  app.get('/api/auth/setup', async (req, res) => {
    try { const { rows } = await pool.query("SELECT must_change FROM pbxng_users WHERE username='admin'"); res.json({ defaultAdmin: !!(rows[0] && rows[0].must_change), user: 'admin' }); }
    catch (e) { res.json({ defaultAdmin: false }); }
  });
  // Cambio de contrasena propia (autenticado); limpia el flag must_change
  /* Pide la clave ACTUAL (`current`): una sesión robada del localStorage no debe alcanzar
   * para cambiar la contraseña y dejar afuera al dueño. La única excepción es el primer
   * ingreso (must_change=true), donde la clave actual es la que estamos obligando a cambiar. */
  app.post('/api/auth/password', auth, async (req, res) => {
    const { password, current } = req.body || {};
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'la contraseña nueva debe tener al menos 8 caracteres' });
    try {
      const { rows } = await pool.query('SELECT password_hash, must_change FROM pbxng_users WHERE id=$1', [req.user.uid]);
      if (!rows[0]) return res.status(404).json({ error: 'usuario inexistente' });
      if (!rows[0].must_change) {
        if (!current) return res.status(400).json({ error: 'indicá tu contraseña actual' });
        if (!(await bcrypt.compare(String(current), rows[0].password_hash))) return res.status(403).json({ error: 'la contraseña actual no es correcta' });
      }
      await pool.query('UPDATE pbxng_users SET password_hash=$1, must_change=false WHERE id=$2', [await bcrypt.hash(String(password), 10), req.user.uid]);
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });
  app.get('/api/auth/me', auth, (req, res) => res.json({ user: { username: req.user.username, name: req.user.name, role: req.user.role, ext: req.user.ext || null } }));

  // --- Bootstrap primer arranque: admin por defecto si no hay usuarios ---
  pool.query('SELECT count(*)::int n FROM pbxng_users').then(async ({ rows }) => {
    if (rows[0].n === 0) {
      const pass = process.env.ADMIN_DEFAULT_PASS || 'admin';
      await pool.query("INSERT INTO pbxng_users (username,password_hash,name,role,must_change) VALUES ('admin',$1,'Administrador','admin',true)", [await bcrypt.hash(pass, 10)]);
      logger('BOOTSTRAP').info("usuario 'admin' creado (clave por defecto: '" + pass + "') - cambiala en el primer ingreso");
    }
  }).catch(e => logger('BOOTSTRAP').error('admin', e));

  // Del User-Agent sacamos algo legible para el panel ("iPhone · Safari", "Windows · Escritorio PBX-NG").
  function parseDevice(ua) {
    const u = String(ua || '');
    if (/PBXNG-Desktop|Electron/i.test(u)) return { device: 'App de escritorio', platform: /Windows/i.test(u) ? 'Windows' : /Mac/i.test(u) ? 'macOS' : 'Escritorio' };
    let platform = /iPhone|iPad/i.test(u) ? 'iOS' : /Android/i.test(u) ? 'Android' : /Windows/i.test(u) ? 'Windows' : /Mac OS X|Macintosh/i.test(u) ? 'macOS' : /Linux/i.test(u) ? 'Linux' : 'Desconocida';
    let device = /iPhone/i.test(u) ? 'iPhone' : /iPad/i.test(u) ? 'iPad' : /Android/i.test(u) ? 'Celular Android' : 'Navegador';
    const nav = /Edg\//i.test(u) ? 'Edge' : /Chrome\//i.test(u) ? 'Chrome' : /Firefox\//i.test(u) ? 'Firefox' : /Safari\//i.test(u) ? 'Safari' : '';
    if (device === 'Navegador' && nav) device = nav;
    return { device, platform };
  }

  // Enrollment: canje publico del token (la PWA lo usa sin JWT)
  /* Canje de credenciales SIP por un token del softphone.
   *
   * El softphone tiene la extensión y su clave SIP (con eso se registra), pero no una
   * sesión de panel. Antes, el buzón de voz confiaba en el parámetro ?ext= que mandaba
   * el cliente: cualquiera en internet podía pedir —y borrar— los mensajes de otro.
   * Ahora prueba que tiene la clave de ESA extensión y recibe un token atado a ella.
   *
   * No hace falta volver a enrolar ningún teléfono: el softphone ya guarda ext y clave,
   * así que canjea solo la primera vez que arranca. */
  /* Freno contra la fuerza bruta (mismo limitador que el login: 10 fallos / 10 min por
   * IP + interno). Las claves SIP son largas y generadas, pero un endpoint que valida
   * contraseñas sin límite es una invitación. */
  app.post('/api/phone/token', limiteIntentos('ext'), async (req, res) => {
    const { ext, password } = req.body || {};
    if (!ext || !password) return res.status(400).json({ error: 'ext y password son obligatorios' });
    try {
      const { rows } = await pool.query('SELECT password FROM ps_auths WHERE id=$1', [String(ext)]);
      const ok = rows[0] && String(rows[0].password) === String(password);
      if (!ok) return res.status(401).json({ error: 'extensión o clave incorrecta' });
      const token = jwt.sign({ scope: 'phone', ext: String(ext) }, SECRET, { expiresIn: '30d' });
      res.json({ token, ext: String(ext) });
    } catch (e) { errorHttp(res, e); }
  });

  /* El enlace/QR de enrolado es de UN solo uso: entrega la clave SIP en claro, así que
   * un link reenviado o un QR fotografiado no puede seguir canjeándose días después.
   * Ventana de gracia (ENROLL_REUSE_SECONDS, 120 s): el mismo aparato suele canjearlo
   * dos veces seguidas (la PWA abre el link y el softphone de escritorio lo toma por
   * pbxng://), y un reintento por red lenta no debe dejar al usuario sin teléfono. */
  const ENROLL_REUSE_MS = Math.max(0, +(process.env.ENROLL_REUSE_SECONDS || 120)) * 1000;
  app.get('/api/enroll/:token', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT token,ext,password,expires_at,used_at FROM pbxng_enroll WHERE token=$1', [req.params.token]);
      const e = rows[0];
      if (!e) return res.status(404).json({ error: 'token invalido' });
      if (e.expires_at && new Date(e.expires_at) < new Date()) return res.status(410).json({ error: 'token expirado' });
      if (e.used_at && (Date.now() - new Date(e.used_at).getTime()) > ENROLL_REUSE_MS) return res.status(410).json({ error: 'token ya usado' });
      const ua = req.headers['user-agent'] || '';
      const dv = parseDevice(ua);
      await pool.query(
        `UPDATE pbxng_enroll SET used_at = COALESCE(used_at, now()), activated_at = COALESCE(activated_at, now()),
                device = COALESCE(device, $2), platform = COALESCE(platform, $3), user_agent = COALESCE(user_agent, $4),
                ip = COALESCE(ip, $5), uses = COALESCE(uses, 0) + 1
           WHERE token = $1`,
        [req.params.token, dv.device, dv.platform, ua.slice(0, 400), clientIp(req)]);
      // Config completa de aprovisionamiento. El MISMO link/QR sirve para la PWA, el softphone de
      // escritorio y el celular; y el transporte se deduce del ENDPOINT REAL (no se asume WebRTC):
      // un interno con transport-ws/wss es WebRTC; uno con udp/tcp/tls es SIP nativo. Mezclarlos
      // autentica pero deja la llamada sin audio (el endpoint WebRTC exige DTLS-SRTP).
      const gS = async (k) => { const { rows: r2 } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return r2[0] ? r2[0].value : ''; };
      const dom = (await gS('domain')) || NODES.domain || process.env.DOMAIN || '';
      const wssU = (await gS('wss')) || (dom ? ('wss://' + dom + '/ws') : '');
      const { rows: epr } = await pool.query("SELECT transport, media_encryption, COALESCE(webrtc,'no') AS webrtc FROM ps_endpoints WHERE id=$1", [String(e.ext)]);
      const ep = epr[0] || {};
      const tr = String(ep.transport || '');
      const isWeb = ep.webrtc === 'yes' || /ws/i.test(tr);
      const sipTransport = /tls/i.test(tr) ? 'tls' : /tcp/i.test(tr) ? 'tcp' : 'udp';
      const sipPort = sipTransport === 'tls' ? '5061' : '5060';
      const _lk = await sbcLink();
      const sipHost = (await gS('sip_host')) || (_lk.active ? _lk.host : '') || NODES.asterisk || dom;
      const { rows: un } = await pool.query('SELECT id, username, name, role FROM pbxng_users WHERE ext=$1 LIMIT 1', [String(e.ext)]);
      const u = un[0] || null;
      const pubIp = process.env.PUBLIC_IP || process.env.DOMAIN || dom || '';
      const tU = process.env.TURN_USER || 'pbxng', tP = process.env.TURN_PASS || '';
      const withTurn = !!(pubIp && tP);
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
      const host = req.headers['x-forwarded-host'] || req.get('host') || '';
      const apiBase = (await gS('public_base')) || (dom ? 'https://' + dom : (host ? proto + '://' + host : ''));
      const prov = {
        transport: isWeb ? 'webrtc' : 'sip',
        name: (u && u.name) || String(e.ext),
        domain: dom, ext: String(e.ext), pass: e.password,
        // WebRTC
        wss: isWeb ? wssU : '',
        stun: process.env.STUN_URL || 'stun:stun.l.google.com:19302',
        turn: (isWeb && withTurn) ? ('turn:' + pubIp + ':3478') : '',
        turnUser: (isWeb && withTurn) ? tU : '', turnPass: (isWeb && withTurn) ? tP : '',
        // SIP nativo
        sipServer: isWeb ? '' : sipHost, sipPort: isWeb ? '' : sipPort,
        sipTransport: isWeb ? '' : sipTransport,
        sipSrtp: (!isWeb && String(ep.media_encryption || '') === 'sdes') ? 'sdes' : 'none',
        /* Token de SOFTPHONE (scope 'phone', 30 d), igual al que da POST /api/phone/token:
         * sólo lo que lista FONO_PERMITIDO y sólo sobre esta extensión. Antes salía una
         * sesión de panel con el rol del usuario: quien tuviera el QR de un admin tenía
         * la central entera por 30 días. Para el CRM completo o supervisar, el softphone
         * inicia sesión con usuario y contraseña (POST /api/auth/login). */
        apiBase,
        apiToken: jwt.sign({ scope: 'phone', ext: String(e.ext) }, SECRET, { expiresIn: '30d' }),
      };
      const b64u = Buffer.from(JSON.stringify(prov), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      res.json({ ext: e.ext, password: e.password, server: dom, prov, prov_url: 'pbxng://prov#' + b64u });
    } catch (e) { errorHttp(res, e); }
  });

  // Enrollment: generar acceso (crea interno WebRTC + token) -> QR
  // Estado del acceso enviado a cada extension: si lo activaron, cuando y con que aparato.
  app.get('/api/enrollments', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (ext) ext, created_at, expires_at, activated_at, device, platform, ip, uses
          FROM pbxng_enroll ORDER BY ext, created_at DESC`);
      res.json(rows.map(r => ({
        ...r,
        estado: r.activated_at ? 'activado'
              : (r.expires_at && new Date(r.expires_at) < new Date()) ? 'vencido' : 'pendiente',
      })));
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/enroll', async (req, res) => {
    const { ext, label, video = false } = req.body || {};
    if (!ext) return res.status(400).json({ error: 'ext requerido' });
    const token = crypto.randomBytes(18).toString('hex');
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      // Si el interno ya existe, reusar su contraseña (no romper registros existentes); si no, crear WebRTC nuevo.
      const ex = await c.query('SELECT password FROM ps_auths WHERE id=$1', [String(ext)]);
      let password;
      if (ex.rows[0] && ex.rows[0].password) { password = ex.rows[0].password; }
      else { password = 'Pbx' + crypto.randomBytes(4).toString('hex') + '#' + (10 + Math.floor(Math.random() * 89)); await createWebrtcEndpoint(c, String(ext), password, 'internal', 1, !!video); }
      await c.query("INSERT INTO pbxng_enroll (token,ext,password,label,expires_at) VALUES ($1,$2,$3,$4, now() + interval '24 hours')", [token, String(ext), password, label || null]);
      await c.query('COMMIT'); broadcastSoon();
      res.json({ token, ext: String(ext), password, path: '/enroll?token=' + token });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  app.post('/api/enroll/email', async (req, res) => {
    const { ext, to, tenant_id = 1 } = req.body || {};
    if (!ext || !to) return res.status(400).json({ error: 'ext y destinatario requeridos' });
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      // Validar ANTES de crear nada: si el correo no se puede mandar, no dejamos un token
      // huerfano (valido 24 h) que nadie recibio.
      const { rows } = await pool.query('SELECT host,port,secure,username,password,from_addr,enabled FROM pbxng_email_config WHERE tenant_id=$1', [tenant_id]);
      const cfg = rows[0];
      if (!cfg || !cfg.enabled || !cfg.host) return res.status(400).json({ error: 'Configurá y activá el email de la empresa en Configuración → Email' });
      const base = await (async () => { const { rows: r2 } = await pool.query("SELECT value FROM pbxng_settings WHERE key='domain'"); return (r2[0] && r2[0].value) || NODES.domain || process.env.DOMAIN || ''; })();
      if (!base) return res.status(400).json({ error: 'Falta el dominio público de la central: sin él, el link de acceso saldría roto.' });

      await c.query('BEGIN');
      const ex = await c.query('SELECT password FROM ps_auths WHERE id=$1', [String(ext)]);
      let password;
      if (ex.rows[0] && ex.rows[0].password) { password = ex.rows[0].password; }
      else { password = 'Pbx' + crypto.randomBytes(4).toString('hex') + '#' + (10 + Math.floor(Math.random() * 89)); await createWebrtcEndpoint(c, String(ext), password, 'internal', 1, false); }
      const token = crypto.randomBytes(18).toString('hex');
      await c.query("INSERT INTO pbxng_enroll (token,ext,password,expires_at) VALUES ($1,$2,$3, now() + interval '24 hours')", [token, String(ext), password]);
      await c.query('COMMIT');
      const url = 'https://' + base + '/enroll?token=' + token;
      const png = await QRCode.toBuffer(url, { width: 320, margin: 1 });
      const tx = nodemailer.createTransport({ host: cfg.host, port: cfg.port || 587, secure: !!cfg.secure, auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined });
      const { rows: bn } = await pool.query("SELECT value FROM pbxng_settings WHERE key='brand_name'");
      const html = emails.enrollEmail({ brand: (bn[0] && bn[0].value) || 'PBX-NG', ext, url });
      await tx.sendMail({ from: cfg.from_addr || cfg.username, to, subject: 'Tu acceso al softphone PBX-NG (interno ' + ext + ')', html, attachments: [{ filename: 'acceso-qr.png', content: png, cid: 'qr' }] });
      res.json({ ok: true });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} res.status(500).json({ error: smtpHint(e) }); } finally { c.release(); }
  });

  // ---------------- Usuarios ----------------
  app.get('/api/users', async (req, res) => {
    try { const { rows } = await pool.query('SELECT id,username,name,role,ext,created_at FROM pbxng_users ORDER BY id'); res.json(rows); }
    catch (e) { errorHttp(res, e); }
  });
  /* Toda la familia /api/users es sólo admin (rbac.js: no figura en la tabla). */
  app.post('/api/users', async (req, res) => {
    /* Rol por defecto 'agente': el más chico. Antes era 'admin', así que un alta apurada
     * desde el panel (o un POST sin `role`) creaba administradores sin querer. */
    const { username, password, name, role = 'agente', ext = null } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'usuario y contraseña obligatorios' });
    if (String(password).length < 8) return res.status(400).json({ error: 'la contraseña debe tener al menos 8 caracteres' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'rol inválido (admin, supervisor o agente)' });
    try {
      await pool.query('INSERT INTO pbxng_users (username,password_hash,name,role,ext) VALUES ($1,$2,$3,$4,$5)', [String(username).trim(), await bcrypt.hash(String(password), 10), name || username, role, ext || null]);
      res.status(201).json({ created: username });
    } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'el usuario ya existe' }); errorHttp(res, e); }
  });
  app.post('/api/users/:id/password', async (req, res) => {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'la contraseña debe tener al menos 8 caracteres' });
    try {
      const r = await pool.query('UPDATE pbxng_users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(password), 10), req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'usuario inexistente' });
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });
  app.delete('/api/users/:id', async (req, res) => {
    try {
      if (String(req.user.uid) === String(req.params.id)) return res.status(400).json({ error: 'no podés borrar tu propio usuario' });
      const { rows } = await pool.query('SELECT username, role FROM pbxng_users WHERE id=$1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'usuario inexistente' });
      if (rows[0].role === 'admin') {
        /* Sin al menos un admin nadie puede volver a configurar la central: sería
         * quedarse afuera de la propia casa. */
        const { rows: n } = await pool.query("SELECT count(*)::int AS n FROM pbxng_users WHERE role='admin'");
        if (n[0].n <= 1) return res.status(400).json({ error: 'no se puede borrar el último administrador' });
      }
      await pool.query('DELETE FROM pbxng_users WHERE id=$1', [req.params.id]); res.json({ deleted: req.params.id });
    } catch (e) { errorHttp(res, e); }
  });

  return { auth, isPublicApi, PUBLIC_API, FONO_PERMITIDO, mismaExt, exigirExt, extPropia, clientIp, limiteIntentos, ROLES };
};
