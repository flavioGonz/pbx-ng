'use strict';
/* PBX-NG - Control Plane API (Socket.io). Internos, troncales, IVR, colas,
   conferencias, ring groups, paging, buzones, CDR, dialplan, canales, sistema, WebRTC. */
const http = require('http');
const os = require('os');
const fsx = require('fs');
const express = require('express');
const logger = require('./log');   // logger con niveles y JSON (LOG_LEVEL / LOG_FORMAT, docs/CONTRATOS.md §6)
const log = logger('API');
const { errorHttp } = require('./errores');   // traduce errores (pg → mensaje genérico) a {error} con status (docs/CONTRATOS.md §3)
const acme = require('./acme');  // ACME/Let's Encrypt (certificados TLS sin proxy)
const { Server } = require('socket.io');
const { Pool } = require('pg');
const AriClient = require('ari-client');
const aiPipeline = require('./ai-pipeline');
const AsteriskManager = require('asterisk-manager');
const jwt = require('jsonwebtoken');   // sólo para el handshake del socket; las sesiones HTTP las firma/verifica auth.js
const helmet = require('helmet');
const rbac = require('./rbac');         // tabla de permisos por rol (docs/CONTRATOS.md §2)
const webpush = require('web-push');
const pushProviders = require('./push-providers');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const alerts = require('./alerts');
const emails = require('./emails');
const sysmon = require('./sysmon');
const astconf = require('./astconf');   // aparcado, captura y música en espera (config generada)

/* ── Imágenes de los manuales (editor en vivo) ────────────────────────────────
 *  Los manuales traen recuadros con el nombre del archivo que va ahí. El panel
 *  deja pegar la captura del portapapeles y la guardamos con ESE nombre exacto:
 *  el manual la toma sola, sin recompilar nada. Van a un volumen persistente,
 *  no dentro de la imagen, así sobreviven a un despliegue. */
const _fsm = require('fs'); const _pathm = require('path');
const MAN_IMG_DIR = _pathm.join(process.env.CONF_DIR || '/etc/pbxng', 'manuales-img');
// svg incluido: los diagramas que vienen con el producto son SVG.
const IMG_OK = /^[a-z0-9][a-z0-9._-]{1,80}\.(png|jpe?g|webp|gif|svg)$/i;
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const numbering = require('./numbering');
const SECRET = process.env.JWT_SECRET || '';
/* Sin secreto real la API NO arranca. Antes caía al placeholder '__SET_JWT_SECRET__'
 * y seguía andando: cualquiera que leyera el repo podía firmarse una sesión de admin.
 * Un arranque que falla con un mensaje claro es mejor que una central abierta
 * (docs/CONTRATOS.md §6: install.sh genera el valor; acá sólo se exige). */
if (!SECRET || SECRET === '__SET_JWT_SECRET__' || SECRET.length < 16) {
  log.error('JWT_SECRET vacío, placeholder o demasiado corto (mínimo 16 caracteres). Definilo en el .env (install.sh lo genera) y volvé a arrancar.');
  process.exit(1);
}

// ---------------- Web Push (VAPID) ----------------
/* El par VAPID sale del .env (VAPID_PUBLIC/VAPID_PRIVATE) si es válido; si no, de
 * pbxng_settings (vapid_public/vapid_private); y si tampoco hay nada usable la API genera
 * uno nuevo y lo guarda en pbxng_settings (asegurarVapid, al arrancar). Antes había una
 * pública hardcodeada y un placeholder de privada: web-push tiraba "should be 32 bytes" en
 * cada envío y /api/push/vapid entregaba una clave que nunca iba a poder firmar nada. La
 * pública se rellena recién cuando hay un par que firma: hasta entonces `pub` queda vacío y
 * el panel dice "Servidor sin clave VAPID" en vez de suscribir contra una clave inútil. */
const VAPID = {
  pub: '',
  priv: '',
  subject: process.env.VAPID_SUBJECT || 'mailto:soporte@example.com',
  origen: '',   // 'env' | 'db' | 'generado' — para el log y para diagnosticar
};
// Devuelve true si el par firma (web-push valida largo y formato al fijar los detalles).
function vapidValido(pub, priv) {
  if (!pub || !priv) return false;
  try { webpush.setVapidDetails(VAPID.subject, pub, priv); return true; } catch (_) { return false; }
}
async function asegurarVapid() {
  const plog = logger('PUSH');
  const envPub = process.env.VAPID_PUBLIC || '', envPriv = process.env.VAPID_PRIVATE || '';
  if (vapidValido(envPub, envPriv)) { Object.assign(VAPID, { pub: envPub, priv: envPriv, origen: 'env' }); return; }
  if (envPub || envPriv) plog.warn('VAPID_PUBLIC/VAPID_PRIVATE del .env inválidos (web-push no puede firmar con ese par); se ignoran');
  let dbPub = '', dbPriv = '';
  try {
    const { rows } = await pool.query("SELECT key, value FROM pbxng_settings WHERE key IN ('vapid_public','vapid_private')");
    for (const r of rows) { if (r.key === 'vapid_public') dbPub = r.value || ''; else dbPriv = r.value || ''; }
  } catch (e) { plog.error('leyendo VAPID de pbxng_settings', e); return; }
  if (vapidValido(dbPub, dbPriv)) { Object.assign(VAPID, { pub: dbPub, priv: dbPriv, origen: 'db' }); return; }
  // Nada usable: par nuevo. Las suscripciones viejas (hechas con otra pública) van a fallar al
  // enviar y se van a limpiar solas (410/404 en sendPushToExt); el panel vuelve a suscribir.
  const par = webpush.generateVAPIDKeys();
  try {
    await pool.query("INSERT INTO pbxng_settings(key,value) VALUES('vapid_public',$1),('vapid_private',$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [par.publicKey, par.privateKey]);
  } catch (e) { plog.error('guardando el par VAPID nuevo en pbxng_settings', e); return; }
  if (!vapidValido(par.publicKey, par.privateKey)) { plog.error('el par VAPID recién generado no valida (¿web-push roto?)'); return; }
  Object.assign(VAPID, { pub: par.publicKey, priv: par.privateKey, origen: 'generado' });
  plog.warn((dbPub || dbPriv) ? 'par VAPID guardado inválido: se generó uno nuevo y se guardó en pbxng_settings; los navegadores suscriptos tienen que volver a suscribirse'
                              : 'sin par VAPID válido (ni .env ni base): se generó uno nuevo y se guardó en pbxng_settings (vapid_public/vapid_private)');
}

async function sendPushToExt(ext, payload) {
  if (!ext) return 0;
  let sent = 0;
  try {
    const { rows } = await pool.query('SELECT endpoint, p256dh, auth FROM pbxng_push_subs WHERE ext=$1', [String(ext)]);
    for (const s of rows) {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try { await webpush.sendNotification(sub, JSON.stringify(payload)); sent++; }
      catch (err) { if (err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 403) await pool.query('DELETE FROM pbxng_push_subs WHERE endpoint=$1', [s.endpoint]); }   // 403 = suscripción firmada con otra clave VAPID (VapidPkHashMismatch): también muerta
    }
  } catch (e) { logger('PUSH').error('send', e); }
  try { sent += await pushProviders.sendNative(ext, payload); } catch (_) {}
  return sent;
}

async function createWebrtcEndpoint(c, id, password, context = 'internal', tenant_id = 1, video = false, max_contacts = 2) {
  const allow = await sipConf.defaultCodecs(video);
  await c.query("INSERT INTO ps_aors (id,max_contacts,remove_existing,remove_unavailable,support_path,qualify_frequency,tenant_id) VALUES ($1,$2,'no','yes','yes',60,$3) ON CONFLICT (id) DO UPDATE SET max_contacts=EXCLUDED.max_contacts,remove_existing='no',remove_unavailable='yes',support_path='yes'", [id, max_contacts, tenant_id]);
  await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$1,$2,$3) ON CONFLICT (id) DO UPDATE SET password=EXCLUDED.password", [id, password, tenant_id]);
  await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,webrtc,dtls_auto_generate_cert,ice_support,use_avpf,media_encryption,media_use_received_transport,rtcp_mux,direct_media,rtp_symmetric,force_rport,rewrite_contact) VALUES ($1,'transport-ws',$1,$1,$2,'all',$3,$4,'extension','yes','yes','yes','yes','dtls','yes','yes','no','yes','yes','yes') ON CONFLICT (id) DO UPDATE SET transport='transport-ws',allow=EXCLUDED.allow,webrtc='yes'", [id, context, allow, tenant_id]);
  await c.query("UPDATE ps_endpoints SET mailboxes = id || '@default' WHERE id=$1 AND (mailboxes IS NULL OR mailboxes='')", [id]);
  await sipConf.afterCreate(c, id);
  await c.query("INSERT INTO voicemail (context, mailbox, password, fullname) SELECT 'default', $1::text, $1::text, 'Interno ' || $1::text WHERE NOT EXISTS (SELECT 1 FROM voicemail v WHERE v.mailbox = $1::text AND v.context='default')", [id]);
}

// geo (ip-api.com) con cache en memoria
const geoCache = new Map();
async function geoLookup(ips) {
  const out = {}; const need = [];
  for (const ip of ips) { if (geoCache.has(ip)) out[ip] = geoCache.get(ip); else need.push(ip); }
  for (let i = 0; i < need.length; i += 90) {
    const batch = need.slice(i, i + 90).map(ip => ({ query: ip, fields: 'status,country,countryCode,city,isp,query' }));
    try {
      const r = await fetch('http://ip-api.com/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
      const arr = await r.json();
      for (const g of arr) { if (g && g.query) { const v = { country: g.country || '?', cc: g.countryCode || '', city: g.city || '', isp: g.isp || '' }; geoCache.set(g.query, v); out[g.query] = v; } }
    } catch (_) {}
  }
  return out;
}

const CFG = {
  port: process.env.PORT || 3000,
  db: {
    host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'pbxng', user: process.env.DB_USER || 'pbxng', password: process.env.DB_PASS || '__SET_DB_PASS__',
    /* Límites del pool (docs/CONTRATOS.md §6). Sin `max` el pool crece hasta 10 igual,
     * pero sin statement_timeout una consulta colgada (lock, disco lleno) retiene el
     * cliente para siempre y con diez de esas la API deja de atender sin morir. */
    max: +(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,            // un cliente ocioso se devuelve a Postgres a los 30 s
    connectionTimeoutMillis: 5000,       // sin conexión en 5 s → error (no espera infinita)
    statement_timeout: +(process.env.PG_STATEMENT_TIMEOUT_MS || 30000),   // lo cancela el servidor (SQLSTATE 57014)
    query_timeout: +(process.env.PG_STATEMENT_TIMEOUT_MS || 30000) + 5000, // lo corta el cliente si el servidor no contestó ni a la cancelación
  },
  ari: { url: process.env.ARI_URL || 'http://127.0.0.1:8088', user: process.env.ARI_USER || 'pbxng', pass: process.env.ARI_PASS || '__SET_ARI_PASS__', app: process.env.ARI_APP || 'pbxng' },
  ami: { host: process.env.AMI_HOST || '127.0.0.1', port: +(process.env.AMI_PORT || 5038), user: process.env.AMI_USER || 'pbxng-ami', pass: process.env.AMI_PASS || '__SET_AMI_PASS__' },
};

// Direcciones de los nodos del despliegue (parametrizables por env; sin hardcodear el lab viejo)
const NODES = {
  asterisk: process.env.ASTERISK_HOST || process.env.AMI_HOST || '127.0.0.1',
  db:       process.env.DB_HOST || '127.0.0.1',
  npm:      process.env.NPM_HOST || '',
  turn:     process.env.TURN_HOST || process.env.PUBLIC_IP || '',
  voz:      process.env.VOZ_HOST || '',
  media:    process.env.MEDIA_HOST || process.env.ASTERISK_HOST || '127.0.0.1',   // host que Asterisk usa para el AudioSocket de la IA (donde escucha esta API)
  domain:   process.env.DOMAIN || process.env.PUBLIC_IP || '',
  public_ip: process.env.PUBLIC_IP || process.env.DOMAIN || '',
};
// (VM_AGENT retirado: los buzones se leen del volumen compartido /voicemail, sin agente HTTP)
const pool = new Pool(CFG.db);
/* Un cliente ocioso del pool emite 'error' si PostgreSQL se reinicia o corta la
 * conexión. Sin oyente, Node lo trata como excepción no capturada y tumba TODA la
 * API (y con ella el softphone, la presencia y el IVR) por un corte de un segundo.
 * Se loguea y se sigue: el pool descarta ese cliente y abre otro en el próximo query. */
pool.on('error', (e) => logger('DB').error('cliente del pool con error (se descarta, el pool reconecta)', e));
const diagtrunk = require('./diagtrunk');
const backup = require('./backup');     // respaldo y restauracion del appliance
const salud = require('./salud');       // estado REAL de los nodos (medido, no configurado)
const app = express();
/* La API siempre está detrás del proxy (NPM / nginx del compose): la IP real del
 * cliente viene en X-Forwarded-For. Con trust proxy = 1 express confía SÓLO en el
 * primer salto, así req.ip es la del cliente y el rate limit del login no castiga
 * al proxy entero ni se deja engañar con un X-Forwarded-For inventado. */
app.set('trust proxy', 1);
/* Cabeceras defensivas (nosniff, frame-deny, referrer, sin X-Powered-By…).
 * CSP apagada: el panel (Next) y el softphone traen inline scripts y se sirven por
 * el proxy con su propia política; una CSP acá rompería ambos sin sumar nada.
 * CORP en cross-origin: /softphone/ (instalador + feed OTA) y los audios se piden
 * desde el origen del panel, que por el proxy puede ser otro host/puerto. */
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' }, crossOriginEmbedderPolicy: false }));
/* Token compartido con los agentes (Asterisk :8092, TURN, voz). Vive en el volumen `certs`
 * (/etc/pbxng), que la API monta rw y Asterisk ro: si no existe, la API lo genera acá y el
 * agente lo lee del mismo archivo. Sin él, el agente de Asterisk sólo acepta /fw/* desde
 * redes privadas, o sea cualquiera de la LAN podría vaciar el set de baneados. */
const AGENT_TOKEN = (() => {
  /* Mismo CONF_DIR que acme.js y las imágenes de los manuales: en el contenedor es
   * /etc/pbxng; fuera de él (pruebas de integración, desarrollo) apunta a un
   * directorio temporal y la API no escribe en el /etc del host. */
  const fs = require('fs'); const dir = process.env.CONF_DIR || '/etc/pbxng'; const f = _pathm.join(dir, 'agent.token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch (_) {}
  try { const t = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, t + '\n', { mode: 0o600 }); return t; }
  catch (e) { console.error('[agent] no se pudo generar ' + f + ': ' + e.message); return ''; }
})();
/* Las capturas de los manuales viajan como data URL dentro del JSON: una captura de
 * pantalla pegada del portapapeles pesa varios MB, muy por encima de los 100 kB que
 * trae express.json() por defecto. Sin esto la subida moria con un 413 que ademas
 * responde HTML (no JSON), asi que el panel mostraba un error rojo sin texto.
 * Se monta ANTES del parser global: body-parser marca req._body y no vuelve a parsear. */
app.use('/api/manuales/img', express.json({ limit: '32mb' }));
app.use(express.json({ limit: '4mb' }));
/* Un 413 (o cualquier body ilegible) tiene que salir como JSON, para que el panel
 * pueda mostrar un mensaje util en vez de un toast vacio. */
app.use((err, req, res, next) => {
  if (!err || !err.type) return next(err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El archivo es demasiado grande. Probá con una captura de menos de 32 MB.' });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'El cuerpo del pedido no es JSON válido.' });
  return next(err);
});
/* ============================================================
 *  Gate de auth + RBAC de /api, montados ANTES de cualquier ruta.
 *  Express resuelve en orden de registro: un módulo que registra sus rutas
 *  antes de estas tres líneas (pasó con callengine.js) queda
 *  fuera del gate y responde sin token ni rol. Por eso van acá, pegadas al
 *  parser del body, y no más abajo junto a los módulos. Las funciones que usan
 *  (auth, isPublicApi — vienen de auth.js, que se inicializa más abajo; rbac)
 *  se evalúan recién en tiempo de request, cuando el módulo ya cargó entero.
 * ============================================================ */
/* Nada de lo que sale de /api puede quedar guardado en un intermediario. El proxy
 * estaba cacheando el audio de las grabaciones: despues de cerrar el acceso publico,
 * seguia devolviendo 200 con una copia vieja a quien pedia SIN sesion. Un control de
 * acceso que el proxy puede saltear por cache no es un control de acceso. */
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});
app.use('/api', (req, res, next) => isPublicApi(req) ? next() : auth(req, res, next));
/* Permisos por rol (rbac.js): con sesión válida, ¿este ROL puede esta ruta?
 * Va pegado al gate de auth para que ninguna ruta lo esquive; las públicas (sin
 * req.user) y los tokens phone (ya filtrados por FONO_PERMITIDO) pasan de largo.
 * Lo que no figura en la tabla es sólo admin. */
app.use('/api', rbac.middleware);
const state = { ari: false, ami: false };
let ari = null;
const pendingConf = {};
/* ARI con reconexion. Antes se conectaba UNA vez al arrancar: si Asterisk todavia no
 * habia levantado (orden de arranque de los contenedores) o se reiniciaba, `ari`
 * quedaba en null para siempre -> presencia de internos en "offline", 0 llamadas
 * activas, y el IVR con IA muerto hasta reiniciar la API. AMI ya reconectaba solo
 * (keepConnected); ARI merece lo mismo. Backoff 2s -> 30s. */
let ariBackoff = 2000;
/* ari-client, cuando Asterisk todavía no escucha, no rechaza la promesa: el cliente
 * swagger tira la excepción en un callback suelto y eso llega como uncaughtException
 * (con el manejador de cierre de 1.5.0 el proceso salía con 1 en cada arranque hasta
 * que Asterisk levantaba). Por eso primero se sondea el HTTP de ARI con fetch y sólo
 * si responde se llama a AriClient.connect. */
async function ariDisponible() {
  try {
    const r = await fetch(CFG.ari.url.replace(/\/+$/, '') + '/ari/api-docs/resources.json', {
      headers: { Authorization: 'Basic ' + Buffer.from(CFG.ari.user + ':' + CFG.ari.pass).toString('base64') },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch (_) { return false; }
}
async function connectAri() {
  try {
    if (!(await ariDisponible())) throw new Error('ARI no responde en ' + CFG.ari.url);
    const c = await AriClient.connect(CFG.ari.url, CFG.ari.user, CFG.ari.pass);
    c.on('StasisStart', async (event, channel) => {
      const args = event.args || [];
      if (await callEngine.handleStasis(event, channel)) return;
      if (args[0] === 'ai') { handleAiAgent(channel, args[1]); return; }
      const bid = pendingConf[channel.id];
      if (!bid) return;
      delete pendingConf[channel.id];
      try { await channel.answer(); } catch (_) {}
      try { await c.bridges.addChannel({ bridgeId: bid, channel: channel.id }); } catch (e) { logger('CONF').error('add', e); }
    });
    const onDown = (why) => {
      if (ari !== c) return;                 // ya fue reemplazado por otra conexion
      ari = null; state.ari = false; callEngine.detach();
      logger('ARI').warn('desconectado: ' + why);
      setTimeout(connectAri, ariBackoff); ariBackoff = Math.min(30000, ariBackoff * 2);
    };
    c.on('WebSocketClose', () => onDown('websocket cerrado'));
    c.on('WebSocketError', (e) => onDown(e && e.message));
    c.on('APILoadError', (e) => onDown(e && e.message));
    await c.start(CFG.ari.app, true);   // true = todos los eventos de Asterisk, no solo los de Stasis
    ari = c; state.ari = true; ariBackoff = 2000;
    logger('ARI').info('ok (eventos de toda la central)');
    callEngine.attach(c);
    try { aiPipeline.init(ari, pool, { app: CFG.ari.app, mediaHost: NODES.media }); } catch (e) { logger('AI').error('init', e); }
  } catch (e) {
    logger('ARI').warn('sin conexion (' + e.message + '); reintento en ' + Math.round(ariBackoff / 1000) + 's');
    setTimeout(connectAri, ariBackoff); ariBackoff = Math.min(30000, ariBackoff * 2);
  }
}
connectAri();
// ============================================================
//  AI IVR (scaffold) - punto de integracion con una IA externa
//  El plan de marcado envia la llamada a Stasis(pbxng, ai, <agentId>).
//  Aqui se respondera, se saludara y -en el futuro- se abrira un
//  canal de medios (externalMedia/AudioSocket) hacia el pipeline
//  STT -> LLM -> TTS usando agent.system_prompt / provider / model.
// ============================================================
async function handleAiAgent(channel, agentId) {
  let agent = null;
  try { const { rows } = await pool.query('SELECT * FROM pbxng_ai_agents WHERE id=$1', [agentId]); agent = rows[0]; } catch (_) {}
  if (!agent || agent.enabled === false) { try { await channel.answer(); await channel.play({ media: 'sound:vm-goodbye' }); } catch (_) {} setTimeout(() => { channel.hangup().catch(() => {}); }, 1200); return; }
  logger('AI-IVR').info('llamada -> agente ' + agent.name, { provider: agent.provider + '/' + agent.model });
  return aiPipeline.startAiSession(channel, agent);
}

const ami = new AsteriskManager(CFG.ami.port, CFG.ami.host, CFG.ami.user, CFG.ami.pass, true);
ami.keepConnected();
ami.on('connect', () => { state.ami = true; });
ami.on('disconnect', () => { state.ami = false; });
ami.on('error', (e) => logger('AMI').error(e && e.message));

function amiAction(action) {
  return new Promise((resolve, reject) => {
    if (!state.ami) return reject(new Error('AMI no conectado'));
    ami.action(action, (err, res) => err ? reject(err) : resolve(res));
  });
}
function amiCommand(command) {
  return new Promise((resolve, reject) => {
    if (!state.ami) return resolve('');
    ami.action({ Action: 'Command', Command: command }, (err, res) => {
      if (err) return reject(err);
      const out = res && (res.output || res.content || res['$content']);
      resolve(Array.isArray(out) ? out.join('\n') : (out || ''));
    });
  });
}
/* Módulos opcionales (Configuración → Módulos): `mod_<id>` en pbxng_settings; el de SBC
 * arranca apagado (trunks.js lo enciende al conectar un SBC-NG). */
const MODULE_DEFAULT_OFF = new Set(['sbc']);
async function moduleEnabled(id) {
  try { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', ['mod_' + id]); return rows[0] ? rows[0].value !== '0' : !MODULE_DEFAULT_OFF.has(id); }
  catch (_) { return !MODULE_DEFAULT_OFF.has(id); }
}
/* Autenticación y usuarios (auth.js): auth() y la allowlist pública que usa el gate de
 * arriba (en tiempo de request), el alcance por extensión (mismaExt/exigirExt/extPropia),
 * el freno a la fuerza bruta y las rutas de sesión, usuarios, enrolado y provisión.
 * Va ANTES de callengine.js porque ese módulo recibe `auth` y `mismaExt` al inicializarse. */
const { auth, isPublicApi, mismaExt, exigirExt, extPropia } = require('./auth')({
  app, pool, SECRET, NODES, alerts,
  sbcLink: (...a) => sbcLink(...a), broadcastSoon: (...a) => broadcastSoon(...a),
  createWebrtcEndpoint: (...a) => createWebrtcEndpoint(...a), smtpHint: (...a) => smtpHint(...a),
});
/* Motor de llamadas sobre ARI (callengine.js): cache por eventos, click-to-dial,
 * colgar/retener/transferir/aparcar, supervision con snoop. */
/* Configuración SIP de la central (Configuración → SIP): NAT, RTP, timers, TLS, códecs.
 * Genera pbxng.d/{pjsip,rtp}.conf y recarga; sólo admin (rbac: no está en la tabla). */
const sipConf = require('./sipconf')({ app, pool, amiCommand, escribir: astconf.escribir, log: (...a) => logger('sipconf').info(...a) });
const callEngine = require('./callengine')({ app, auth, mismaExt, amiAction, amiCommand, broadcastSoon: (...a) => broadcastSoon(...a), appName: CFG.ari.app, log: (...a) => logger('calls').info(...a) });
async function endpointStates() { return callEngine.endpointStates(); }
setTimeout(() => { sipConf.ensure().then(() => amiCommand('module reload res_pjsip.so').catch(() => {})).catch(() => {}); }, 6000);   // pjsip.conf/rtp.conf generados antes de que el panel toque nada

async function getExtensions() {
  const { rows } = await pool.query("SELECT id, context, allow, tenant_id, transport, pbxng_record, dtmf_mode FROM ps_endpoints WHERE COALESCE(pbxng_kind,'extension')='extension' ORDER BY id");
  const st = await endpointStates();
  const names = {};
  try { const { rows: nr } = await pool.query('SELECT ext,name FROM pbxng_directory'); nr.forEach(n => names[n.ext] = n.name); } catch (_) {}
  const contacts = {};
  try {
    const out = await amiCommand('pjsip show contacts');
    for (const line of String(out).split('\n')) {
      if (!line.includes('Contact:') || !line.includes('sip:')) continue;
      const aorM = /Contact:\s*([^/]+)\//.exec(line); const ipM = /@([0-9.]+)[:;]/.exec(line);
      const toks = line.trim().split(/\s+/); const last = toks[toks.length - 1];
      const rtt = /^[0-9.]+$/.test(last) ? parseFloat(last) : null;
      if (aorM && ipM) contacts[aorM[1].trim()] = { ip: ipM[1], rtt };
    }
  } catch (_) {}
  const viaMap = {};
  try {
    const { rows: cc } = await pool.query("SELECT endpoint, uri, via_addr, via_port FROM ps_contacts");
    const _lk = await sbcLink();
    const SBC = _lk.active ? _lk.host : '__sin_sbc__', NPM = NODES.npm;
    const pmap = { '1': 'udp', '2': 'tcp', '3': 'tls', '4': 'sctp', '5': 'ws', '6': 'wss' };
    for (const c of cc) {
      const uri = c.uri || '';
      const hm = /@([^:;>]+)/.exec(uri); const host = hm ? hm[1] : null;
      const al = /alias=([0-9.]+)~([0-9]+)~([0-9]+)/.exec(uri);
      const isWS = /transport=ws/i.test(uri);
      let via = 'direct', origin = null, proto = 'udp';
      if (isWS || host === NPM) { via = 'webrtc'; proto = 'ws'; origin = host; }
      else if (host === SBC || al) { via = 'sbc'; if (al) { origin = al[1] + ':' + al[2]; proto = pmap[al[3]] || 'udp'; } else if (c.via_addr) { origin = c.via_addr + (c.via_port ? (':' + c.via_port) : ''); } }
      else { via = 'direct'; origin = c.via_addr ? (c.via_addr + (c.via_port ? (':' + c.via_port) : '')) : host; }
      viaMap[c.endpoint] = { via, origin, proto };
    }
  } catch (_) {}
  return rows.map(r => ({ id: r.id, name: names[r.id] || null, context: r.context, allow: r.allow, tenant_id: r.tenant_id, status: st[r.id] ? st[r.id].state : 'offline', channels: st[r.id] ? st[r.id].channels : 0, ip: contacts[r.id] ? contacts[r.id].ip : null, rtt: contacts[r.id] ? contacts[r.id].rtt : null, via: (viaMap[r.id]||{}).via || null, origin: (viaMap[r.id]||{}).origin || null, vproto: (viaMap[r.id]||{}).proto || null, video: /vp8|h264/i.test(r.allow || ''), dtmf_mode: r.dtmf_mode || 'rfc4733', webrtc: r.transport === 'transport-ws', record: r.pbxng_record === true || r.pbxng_record === 'yes' || r.pbxng_record === 't' }));
}
async function getChannels() { return callEngine.getChannels(); }
async function getQueues() {
  const { rows: qs } = await pool.query("SELECT pq.name, pq.label, pq.access_exten, q.strategy, q.timeout, q.musiconhold FROM pbxng_queues pq LEFT JOIN queues q ON q.name=pq.name ORDER BY pq.name");
  const { rows: mems } = await pool.query('SELECT queue_name, interface, membername FROM queue_members ORDER BY membername');
  const st = await endpointStates();
  return qs.map(q => { const members = mems.filter(m => m.queue_name === q.name).map(m => { const r = (m.interface || '').replace('PJSIP/', ''); return { ext: m.membername || r, status: st[r] ? st[r].state : 'offline' }; }); return { ...q, members, agents_online: members.filter(m => m.status === 'online').length, agents_total: members.length }; });
}
async function snapshot() {
  let db = false; try { await pool.query('SELECT 1'); db = true; } catch (_) {}
  const [extensions, channels, queues] = await Promise.all([getExtensions(), getChannels(), getQueues()]);
  return { ts: Date.now(), health: { db, ari: state.ari, ami: state.ami }, extensions, channels, queues };
}
async function setDialplan(client, context, exten, rows) {
  await client.query('DELETE FROM extensions WHERE context=$1 AND exten=$2', [context, exten]);
  for (const r of rows) await client.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', [context, exten, r[0], r[1], r[2]]);
}

/* /health: 200 si la base responde (aunque ARI/AMI estén caídos: se reportan, pero la
 * API sirve igual el panel y la config); 503 'degraded' si la DB no contesta en 2 s.
 * Es lo que mira el HEALTHCHECK del contenedor: sin DB no hay nada que atender y
 * conviene que compose lo marque unhealthy. /health/ready es el mismo chequeo con el
 * nombre que espera el healthcheck de compose. */
async function healthCheck(req, res) {
  let db = false;
  const t0 = Date.now();
  try {
    await Promise.race([pool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    db = true;
  } catch (_) {}
  // Durante el cierre el status dice 'shutting_down' (no 'degraded') y `db` sigue
  // siendo lo medido: el panel distingue así un reinicio de una base caída.
  const body = { status: cerrando ? 'shutting_down' : (db ? 'ok' : 'degraded'), db, db_ms: Date.now() - t0, ari: state.ari, ami: state.ami, shutting_down: cerrando, ts: new Date().toISOString() };
  res.status(db && !cerrando ? 200 : 503).json(body);
}
app.get('/health', healthCheck);
app.get('/health/ready', healthCheck);


/* ============================================================
 *  Softphone de escritorio: cada central sirve SU instalador y el feed OTA.
 *  El directorio viaja dentro de la imagen api (docker/fetch-softphone.sh lo
 *  llena en el release) o se monta como volumen. Formato = el de electron-builder
 *  (latest.yml + Setup.exe + .blockmap), asi el softphone actualiza contra
 *  https://<central>/descargas/softphone/ sin depender de Internet ni de GitHub.
 * ============================================================ */
const SOFTPHONE_DIR = process.env.SOFTPHONE_DIR || _pathm.join(__dirname, 'softphone');
app.use('/softphone', (req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); },
  express.static(SOFTPHONE_DIR, { index: false, dotfiles: 'deny', setHeaders: (res, fp) => { if (/\.(exe|msi|blockmap)$/i.test(fp)) res.set('Content-Type', 'application/octet-stream'); if (/\.yml$/i.test(fp)) res.set('Content-Type', 'text/yaml'); } }));
function softphoneLatest() {
  try {
    const y = _fsm.readFileSync(_pathm.join(SOFTPHONE_DIR, 'latest.yml'), 'utf8');
    const g = (k) => { const m = new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(y); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''; };
    const file = g('path'); const version = g('version');
    if (!file || !version) return { available: false };
    let size = null; try { size = _fsm.statSync(_pathm.join(SOFTPHONE_DIR, file)).size; } catch (_) { return { available: false, reason: 'falta ' + file }; }
    return { available: true, version, file, url: '/descargas/softphone/' + encodeURIComponent(file), size, date: g('releaseDate') || null, platform: 'windows' };
  } catch (_) { return { available: false }; }
}
app.get('/api/softphone/latest', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(softphoneLatest()); });
// ICE/TURN para el softphone WebRTC: se arma con el dominio y las credenciales de coturn (no hardcodear)
app.get('/api/ice', (req, res) => {
  const domain = process.env.PUBLIC_IP || process.env.DOMAIN || '';
  const tuser = process.env.TURN_USER || 'pbxng';
  const tpass = process.env.TURN_PASS || '';
  const stun = process.env.STUN_URL || 'stun:stun.l.google.com:19302';
  const ice = [{ urls: stun }];
  if (domain && tpass) {
    ice.push({ urls: 'turn:' + domain + ':3478?transport=udp', username: tuser, credential: tpass });
    ice.push({ urls: 'turn:' + domain + ':3478?transport=tcp', username: tuser, credential: tpass });
  }
  res.json({ iceServers: ice });
});

// ==================== Agente: disponibilidad / pausa en cola ====================
async function _agentQueues(ext){ const { rows } = await pool.query('SELECT queue_name, COALESCE(paused,0) AS paused FROM queue_members WHERE interface=$1',['PJSIP/'+ext]); return rows; }
app.get('/api/agent/state', auth, async (req,res)=>{ try{
  const ext = req.user.ext; if(!ext) return res.json({ ext:null, paused:false, inQueue:false, queues:[] });
  const qs = await _agentQueues(ext);
  const paused = qs.length ? qs.every(q=>Number(q.paused)===1) : false;
  res.json({ ext, paused, inQueue: qs.length>0, queues: qs.map(q=>q.queue_name) });
}catch(e){ errorHttp(res, e); } });
app.post('/api/agent/pause', auth, async (req,res)=>{ try{
  const ext = req.user.ext; if(!ext) return res.status(400).json({error:'sin interno asignado'});
  const paused = !!(req.body && req.body.paused);
  const reason = (req.body && req.body.reason) || 'Pausa';
  // Pausa por interface (todas las colas del agente); es por-agente => seguro con muchos agentes.
  try { await amiAction({ Action:'QueuePause', Interface:'PJSIP/'+ext, Paused: paused?'true':'false', Reason: reason }); } catch(_){}
  try { await pool.query('UPDATE queue_members SET paused=$2 WHERE interface=$1',['PJSIP/'+ext, paused?1:0]); } catch(_){}
  res.json({ ext, paused });
}catch(e){ errorHttp(res, e); } });


// ---------------- Web Push (rutas publicas: la PWA usa credenciales SIP, no JWT) ----------------
/* ESQUEMA: las tablas y columnas viven en migrations/ (0009_schema_runtime.sql y
 * siguientes) y las aplica `node migrate.js` desde docker-entrypoint.sh ANTES de que
 * arranque este proceso. Acá ya no hay CREATE TABLE / ADD COLUMN: si hace falta un
 * cambio de esquema se agrega 00NN_*.sql (nunca se edita una aplicada). Lo que queda
 * abajo son filas semilla (datos, no esquema), idempotentes. */
try { pushProviders.init(pool); } catch (e) { logger('PUSH').error('init', e); }

// --- Empresa (tenant) por defecto si no existe ninguna ---
pool.query('SELECT count(*)::int n FROM tenants').then(async ({ rows }) => {
  if (rows[0].n === 0) {
    const name = process.env.DEFAULT_COMPANY || 'Mi Empresa';
    await pool.query("INSERT INTO tenants (id,name,slug,context_prefix,active) VALUES (1,$1,'default','',true) ON CONFLICT (id) DO NOTHING", [name]);
    await pool.query("SELECT setval('tenants_id_seq', (SELECT GREATEST(COALESCE(MAX(id),1),1) FROM tenants))");
    logger('BOOTSTRAP').info('empresa por defecto creada: ' + name);
  }
}).catch(e => logger('BOOTSTRAP').error('tenant', e));



/* Grabaciones y CDR (recordings.js): marca de grabación en la AstDB, grabar en vivo,
 * indexador de /recordings, audio/transcripción/picos, almacenamiento remoto (recstore),
 * historial e informe. Sus rutas se registran acá, DESPUÉS del gate de auth + RBAC;
 * `setRecFlag` lo usan las rutas de internos y `wavToPcm`/`analyzeText` el buzón de voz. */
const { setRecFlag, wavToPcm, analyzeText } = require('./recordings')({
  app, pool, ami, amiAction, amiCommand, getAri: () => ari, state, extPropia, exigirExt, vozBase, errorHttp, logger,
});

app.get('/api/prompts/:id/audio', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT format, data FROM pbxng_prompts WHERE id=$1 AND deleted=false', [req.params.id]);
    if (!rows[0] || !rows[0].data) return res.status(404).end();
    res.set('Content-Type', rows[0].format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    res.send(rows[0].data);
  } catch (e) { res.status(500).end(); }
});

app.get('/api/push/vapid', (req, res) => res.json({ key: VAPID.pub }));
app.post('/api/push/subscribe', async (req, res) => {
  const { ext, subscription, ua } = req.body || {};
  if (!ext || !subscription || !subscription.endpoint) return res.status(400).json({ error: 'faltan datos' });
  try {
    await pool.query(
      `INSERT INTO pbxng_push_subs (ext, endpoint, p256dh, auth, ua) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET ext=EXCLUDED.ext, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, ua=EXCLUDED.ua`,
      [String(ext), subscription.endpoint, subscription.keys?.p256dh, subscription.keys?.auth, ua || null]);
    res.json({ ok: true });
  } catch (e) { errorHttp(res, e); }
});
app.post('/api/push/register', async (req, res) => {
  const { ext, provider, prid, param, topic, ua } = req.body || {};
  if (!ext || !provider || !prid) return res.status(400).json({ error: 'ext, provider y prid (token) requeridos' });
  if (!['fcm', 'apns'].includes(provider)) return res.status(400).json({ error: 'provider debe ser fcm o apns (webpush usa /subscribe)' });
  try { await pushProviders.registerDevice(ext, provider, prid, param, topic, ua); res.json({ ok: true }); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/push/unsubscribe', async (req, res) => {
  try { await pool.query('DELETE FROM pbxng_push_subs WHERE endpoint=$1', [req.body?.endpoint]); res.json({ ok: true }); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/push/test', auth, async (req, res) => {
  const ext = req.body?.ext;
  if (!exigirExt(req, res, ext)) return;    // sólo al propio teléfono (agente / token phone)
  const sent = await sendPushToExt(ext, { type: 'info', title: 'PBX-NG', body: 'Notificaciones activadas para el interno ' + ext, url: '/phone' });
  res.json({ ok: true, sent });
});


// Conferencia a 3: arma un bridge mixing con la llamada activa del interno + un tercero
/* /api/calls/spy vive en callengine.js (snoopChannel con sesion; AMI+ChanSpy solo sin ARI) */

app.post('/api/calls/conference', async (req, res) => {
  const { ext, third } = req.body || {};
  if (!ext || !third) return res.status(400).json({ error: 'ext y third requeridos' });
  if (!exigirExt(req, res, ext)) return;    // agente y token phone: sólo su propia llamada
  if (!ari) return res.status(503).json({ error: 'ARI no disponible' });
  try {
    const chans = await ari.channels.list();
    const me = chans.find(c => c.name && c.name.startsWith('PJSIP/' + ext + '-'));
    if (!me) return res.status(404).json({ error: 'sin llamada activa' });
    let peer = null;
    try {
      const bridges = await ari.bridges.list();
      for (const b of bridges) {
        if ((b.channels || []).includes(me.id)) {
          const other = (b.channels || []).find(id => id !== me.id);
          if (other) peer = chans.find(c => c.id === other);
        }
      }
    } catch (_) {}
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel({ bridgeId: bridge.id, channel: me.id });
    if (peer) { try { await ari.bridges.addChannel({ bridgeId: bridge.id, channel: peer.id }); } catch (_) {} }
    const ch = ari.Channel();
    pendingConf[ch.id] = bridge.id;
    await ch.originate({ endpoint: 'PJSIP/' + third, app: CFG.ari.app, appArgs: 'conf', callerId: 'Conferencia <' + ext + '>', timeout: 30 });
    res.json({ ok: true, bridge: bridge.id, third });
  } catch (e) { errorHttp(res, e); }
});

// Presencia (publica, para la PWA): mapa ext -> estado online/offline
app.get('/api/directory', async (req, res) => {
  try {
    const eps = await getExtensions();
    res.json(eps.map(e => ({ ext: e.id, name: e.name, status: e.status === 'online' ? (e.channels > 0 ? 'in_call' : 'online') : 'offline', video: e.video, webrtc: e.webrtc })));
  } catch (e) { res.json([]); }
});
app.get('/api/presence', async (req, res) => {
  try { const st = await endpointStates(); const out = {}; for (const k in st) out[k] = st[k].state; res.json(out); }
  catch (e) { res.json({}); }
});

// ---------------- Métricas de host (dashboard) ----------------
let _cpuPrev = null;
function cpuPct() {
  const cs = os.cpus(); let idle = 0, tot = 0;
  for (const c of cs) { for (const k in c.times) tot += c.times[k]; idle += c.times.idle; }
  let p = 0;
  if (_cpuPrev) { const dt = tot - _cpuPrev.tot, di = idle - _cpuPrev.idle; p = dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : 0; }
  _cpuPrev = { tot, idle }; return p;
}
function hostMetrics() {
  const tm = os.totalmem(), fm = os.freemem();
  let disk = null;
  try { const st = fsx.statfsSync('/'); disk = { total: st.blocks * st.bsize, used: (st.blocks - st.bfree) * st.bsize, free: st.bfree * st.bsize }; } catch (_) {}
  return { cpu: cpuPct(), mem: { total: tm, used: tm - fm, free: fm }, disk, load: os.loadavg(), uptime: os.uptime(), cores: os.cpus().length };
}
// Wake interno (sin auth, LAN): el dialplan lo invoca por CURL para despertar la PWA
app.get('/api/internal/wake', (req, res) => {
  try { notifyIncomingPush(String(req.query.ext || ''), String(req.query.from || ''), String(req.query.name || '')); } catch (_) {}
  res.json({ ok: true });
});
// ============================================================
//  Click-to-Call publico (WebRTC sin registro) - parte publica
// ============================================================
const c2cRate = new Map();
function c2cAllow(ip) { const now = Date.now(); const arr = (c2cRate.get(ip) || []).filter(t => now - t < 300000); arr.push(now); c2cRate.set(ip, arr); return arr.length <= 6; }
function c2cDestRoute(type, val) { if (type === 'extension') return ['internal', val]; return ['ivr', val]; }
app.get('/api/c2c/public/:token', async (req, res) => {
  try { const { rows } = await pool.query('SELECT name,intro,require_name,collect_geo,video,enabled FROM pbxng_click2call WHERE token=$1', [req.params.token]); if (!rows[0] || !rows[0].enabled) return res.status(404).json({ error: 'enlace no disponible' }); res.json(rows[0]); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/c2c/public/:token/session', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!c2cAllow(ip)) return res.status(429).json({ error: 'Demasiados intentos, probá en unos minutos.' });
  const b = req.body || {}; const c = await pool.connect();
  try {
    const { rows } = await c.query('SELECT * FROM pbxng_click2call WHERE token=$1', [req.params.token]);
    const link = rows[0]; if (!link || !link.enabled) { c.release(); return res.status(404).json({ error: 'enlace no disponible' }); }
    const sid = crypto.randomBytes(8).toString('hex');
    const guestExt = 'c2c' + crypto.randomBytes(3).toString('hex');
    const password = 'Web' + crypto.randomBytes(5).toString('hex') + '#7';
    const dialExten = '8' + (100000 + Math.floor(Math.random() * 899999));
    const vname = ((b.name || '').toString().slice(0, 40).replace(/[^\w\s.\-áéíóúñÁÉÍÓÚÑ]/g, '') || 'Visitante web');
    const [ctx, dst] = c2cDestRoute(link.dest_type, link.dest_value);
    await c.query('BEGIN');
    await createWebrtcEndpoint(c, guestExt, password, 'c2c', link.tenant_id || 1, !!link.video, 1);
    // El interno ve "Llamada Web" como identificador (CDR/historial), pero NO se pierde el
    // ID de la sesión web: queda como CALLERID(num) (el guestExt c2cXXXX) para referencia, y
    // el nombre real del visitante viaja en __C2C_VISITOR.
    const dp = [['c2c', dialExten, 1, 'NoOp', 'C2C ' + link.name], ['c2c', dialExten, 2, 'Set', 'CALLERID(name)=Llamada Web'], ['c2c', dialExten, 3, 'Set', '__C2C_LINK=' + link.name], ['c2c', dialExten, 4, 'Set', '__C2C_VISITOR=' + vname], ['c2c', dialExten, 5, 'Goto', ctx + ',' + dst + ',1']];
    await c.query("DELETE FROM extensions WHERE context='c2c' AND exten=$1", [dialExten]);
    for (const r of dp) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
    await c.query("INSERT INTO pbxng_c2c_sessions (id,link_id,guest_ext,dial_exten,visitor_name,geo,meta,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '40 minutes')", [sid, link.id, guestExt, dialExten, vname, (b.geo ? JSON.stringify(b.geo).slice(0, 400) : null), (b.meta ? JSON.stringify(b.meta).slice(0, 400) : null)]);
    await c.query('COMMIT');
    res.json({ session: sid, ext: guestExt, pass: password, dial: dialExten, video: !!link.video });
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} errorHttp(res, e); } finally { c.release(); }
});
async function c2cCleanup() {
  try { const { rows } = await pool.query("SELECT id,guest_ext,dial_exten FROM pbxng_c2c_sessions WHERE expires_at < now()");
    for (const s of rows) {
      await pool.query('DELETE FROM ps_endpoints WHERE id=$1', [s.guest_ext]).catch(() => {});
      await pool.query('DELETE FROM ps_auths WHERE id=$1', [s.guest_ext]).catch(() => {});
      await pool.query('DELETE FROM ps_aors WHERE id=$1', [s.guest_ext]).catch(() => {});
      await pool.query("DELETE FROM extensions WHERE context='c2c' AND exten=$1", [s.dial_exten]).catch(() => {});
      await pool.query('DELETE FROM pbxng_c2c_sessions WHERE id=$1', [s.id]).catch(() => {});
    } } catch (_) {}
}
setInterval(c2cCleanup, 120000);
// ============================================================
//  Auto-provisioning de telefonos fisicos (Yealink / Grandstream)
// ============================================================
async function createSipEndpoint(c, id, password, context = 'internal', tenant_id = 1) {
  await c.query("INSERT INTO ps_aors (id,max_contacts,remove_existing,remove_unavailable,support_path,qualify_frequency,tenant_id) VALUES ($1,1,'no','yes','yes',60,$2) ON CONFLICT (id) DO NOTHING", [id, tenant_id]);
  await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$1,$2,$3) ON CONFLICT (id) DO UPDATE SET password=EXCLUDED.password", [id, password, tenant_id]);
  await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,direct_media,rtp_symmetric,force_rport,rewrite_contact) VALUES ($1,'transport-udp',$1,$1,$2,'all',$4,$3,'extension','no','yes','yes','yes') ON CONFLICT (id) DO UPDATE SET transport='transport-udp'", [id, context, tenant_id, await sipConf.defaultCodecs(false)]);
  await c.query("UPDATE ps_endpoints SET mailboxes = id || '@default' WHERE id=$1 AND (mailboxes IS NULL OR mailboxes='')", [id]);
  await sipConf.afterCreate(c, id);
  await c.query("INSERT INTO voicemail (context, mailbox, password, fullname) SELECT 'default', $1::text, $1::text, 'Interno ' || $1::text WHERE NOT EXISTS (SELECT 1 FROM voicemail v WHERE v.mailbox = $1::text AND v.context='default')", [id]);
}
const normMac = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
async function getProvSetting(k, def) { try { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return (rows[0] && rows[0].value) || def; } catch (_) { return def; } }
function yealinkCfg(ph, server, port) {
  const L = ph.line_label || ph.label || ph.ext;
  return ['#!version:1.0.0.1', 'account.1.enable = 1', 'account.1.label = ' + L, 'account.1.display_name = ' + (ph.label || ph.ext), 'account.1.auth_name = ' + ph.ext, 'account.1.user_name = ' + ph.ext, 'account.1.password = ' + ph.password, 'account.1.sip_server.1.address = ' + server, 'account.1.sip_server.1.port = ' + port, 'account.1.sip_server.1.transport_type = 0', 'account.1.srtp_encryption = 0', 'account.1.codec.pcmu.enable = 1', 'account.1.codec.pcma.enable = 1', 'account.1.codec.g722.enable = 1', ''].join('\n');
}
function grandstreamXml(ph, server, port) {
  const cd = (x) => '<![CDATA[' + String(x == null ? '' : x) + ']]>';
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<gs_provision version="1">', ' <config version="1">', '  <P271>1</P271>', '  <P270>' + cd(ph.label || ph.ext) + '</P270>', '  <P47>' + cd(server) + '</P47>', '  <P35>' + cd(ph.ext) + '</P35>', '  <P36>' + cd(ph.ext) + '</P36>', '  <P34>' + cd(ph.password) + '</P34>', '  <P3>' + cd(ph.label || ph.ext) + '</P3>', ' </config>', '</gs_provision>', ''].join('\n');
}
async function serveProv(req, res, file) {
  const fl = String(file || '').toLowerCase(); let mac = null, vendor = null, m;
  if ((m = fl.match(/^([0-9a-f]{12})\.cfg$/))) { mac = m[1]; vendor = 'yealink'; }
  else if ((m = fl.match(/^cfg([0-9a-f]{12})(\.xml)?$/))) { mac = m[1]; vendor = 'grandstream'; }
  if (!mac) return res.status(404).type('text/plain').send('not found');
  try {
    const { rows } = await pool.query('SELECT * FROM pbxng_phones WHERE mac=$1', [mac]);
    const ph = rows[0]; if (!ph) return res.status(404).type('text/plain').send('not provisioned');
    pool.query('UPDATE pbxng_phones SET last_seen=now() WHERE id=$1', [ph.id]).catch(() => {});
    const server = await getProvSetting('prov_sip_server', NODES.asterisk);
    const port = await getProvSetting('prov_sip_port', '5060');
    if (vendor === 'yealink') res.type('text/plain').send(yealinkCfg(ph, server, port));
    else res.type('application/xml').send(grandstreamXml(ph, server, port));
  } catch (e) { res.status(500).type('text/plain').send('error'); }
}
app.get('/prov/:file', async (req, res) => { const tok = await getProvSetting('prov_token', ''); if (tok) return res.status(403).type('text/plain').send('token requerido'); return serveProv(req, res, req.params.file); });
app.get('/prov/:token/:file', async (req, res) => { const tok = await getProvSetting('prov_token', ''); if (tok && req.params.token !== tok) return res.status(403).type('text/plain').send('forbidden'); return serveProv(req, res, req.params.file); });
app.post('/api/geo/report', async (req, res) => {
  const b = req.body || {};
  const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ error: 'coordenadas invalidas' });
  try {
    await pool.query("INSERT INTO pbxng_call_geo (ext,number,dir,lat,lng,accuracy,ua) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [String(b.ext || '').slice(0, 32) || null, String(b.number || '').slice(0, 64) || null, b.dir === 'in' ? 'in' : 'out', lat, lng, parseFloat(b.accuracy) || null, String(req.headers['user-agent'] || '').slice(0, 200)]);
    res.json({ ok: true });
  } catch (e) { errorHttp(res, e); }
});

/* Aplicaciones de la central (apps.js): colas, grupos de timbrado, paging, IVR (clásico
 * y con IA), buzones (voicemail + buzón → correo), códigos de función, aparcado y música
 * en espera. Sus rutas se registran acá, DESPUÉS del gate de auth + RBAC. Va después de
 * auth.js (exigirExt) y de recordings.js (wavToPcm/analyzeText para transcribir el buzón);
 * astFwd/vozBase/setDialplan/smtpHint son declaraciones de función (izadas), así que
 * pueden definirse más abajo sin TDZ. */
require('./apps')({   // devuelve { aiAgentDialplan, buildIvrDialplan, vmList }; app.js hoy no usa ninguno
  app, pool, amiAction, amiCommand, astFwd, vozBase, setDialplan, astconf, exigirExt, wavToPcm, analyzeText,
  smtpHint, errorHttp, broadcastSoon: (...a) => broadcastSoon(...a), logger,
});

// ---------------------------------------------------------------------------
//  Alertas por correo (motor en alerts.js)
// ---------------------------------------------------------------------------
alerts.init(pool, {
  geoLookup,
  trunkHealth: async () => {
    const { rows } = await pool.query("SELECT id,name,provider_host,provider_port,username,do_register,tenant_id,COALESCE(kind,'asterisk') AS kind,kam_config,adv_config FROM pbxng_trunks ORDER BY id");
    return rows.length ? await trunkStatuses(rows) : {};
  },
  getQueues,
  state,
  /* Estado medido de los nodos, para que las alertas vean lo mismo que el panel.
     Antes checkServices() solo miraba la base y AMI/ARI —el estado interno del
     proceso— asi que un borde caido no generaba ninguna alerta. */
  saludNodos: async () => {
    const lk = await sbcLink();
    const { rows } = lk.active ? await pool.query('SELECT name, provider_host, provider_port, kind FROM pbxng_trunks').catch(() => ({ rows: [] })) : { rows: [] };
    const [propios, externos] = await Promise.all([salud.nodos(NODES), salud.bordesExternos(rows)]);
    return propios.concat(externos);
  },
});

sysmon.init(pool, { nodes: NODES, state, token: AGENT_TOKEN });
numbering.init(pool);

// Plan de numeracion: que rangos se usan, que esta ocupado y por quien, y cual es el proximo libre
app.get('/api/numbering/plan', async (req, res) => {
  try { res.json(await numbering.plan()); } catch (e) { errorHttp(res, e); }
});
// Validar un numero antes de crear la extension (el panel lo llama mientras escribis)
app.get('/api/numbering/check', async (req, res) => {
  try { res.json(await numbering.check(req.query.ext, { ignorar: req.query.ignorar })); } catch (e) { errorHttp(res, e); }
});

// Resumen: CPU, RAM, disco, interfaces y servicios de TODOS los nodos (no solo el core)
app.get('/api/system/overview', async (req, res) => {
  try { res.json(await sysmon.overview()); } catch (e) { errorHttp(res, e); }
});


app.get('/api/alerts/rules', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pbxng_alert_rules ORDER BY event');
    const { rows: s } = await pool.query("SELECT value FROM pbxng_settings WHERE key='alert_to'");
    res.json({ rules: rows, default_to: (s[0] && s[0].value) || '' });
  } catch (e) { errorHttp(res, e); }
});
app.post('/api/alerts/rules', async (req, res) => {
  const b = req.body || {};
  try {
    if (b.default_to !== undefined) await pool.query("INSERT INTO pbxng_settings(key,value) VALUES('alert_to',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [b.default_to || '']);
    if (b.event) {
      await pool.query(`UPDATE pbxng_alert_rules SET enabled=$2, recipients=$3, params=$4, throttle_min=$5, updated_at=now() WHERE event=$1`,
        [b.event, !!b.enabled, b.recipients || null, JSON.stringify(b.params || {}), Number(b.throttle_min || 15)]);
    }
    res.json({ ok: true });
  } catch (e) { errorHttp(res, e); }
});
app.get('/api/alerts/history', async (req, res) => {
  try { const { rows } = await pool.query('SELECT id,event,severity,title,to_addr,sent,err,created_at FROM pbxng_alerts ORDER BY created_at DESC LIMIT 50'); res.json(rows); }
  catch (e) { errorHttp(res, e); }
});
// Disparar una alerta de prueba (usa la regla real: si esta apagada o sin destinatario, avisa)
app.post('/api/alerts/test', async (req, res) => {
  const ev = (req.body && req.body.event) || 'security.ban';
  try {
    const ok = await alerts.raise(ev, { severity: 'info', title: 'Alerta de prueba · ' + ev, force: true,
      lines: [['Evento', ev], ['Origen', 'Prueba manual desde el panel'], ['Fecha', new Date().toLocaleString('es-UY')]],
      foot: 'Si recibís este correo, las alertas están funcionando. (La regla no necesita estar activa para esta prueba.)', key: 'test' + Date.now() });
    res.json(ok ? { ok: true } : { error: 'No se envió: falta destinatario (arriba) o el SMTP de la empresa no está configurado/activo.' });
  } catch (e) { errorHttp(res, e); }
});

app.get('/api/branding', async (req, res) => { try { const g = async (k) => { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value; }; res.json({ name: (await g('brand_name')) || 'PBX-NG', subtitle: (await g('brand_subtitle')) || 'Comunicaciones', tagline: (await g('brand_tagline')) || '', logo: (await g('brand_logo')) || '' , callcenter: (await g('mod_callcenter')) !== '0' }); } catch (e) { res.json({ name: 'PBX-NG', subtitle: 'Comunicaciones', logo: '' }); } });
// auth ahora se aplica via gate deny-by-default arriba (isPublicApi)
app.post('/api/branding', async (req, res) => { try { const b = req.body || {}; const setk = async (k, v) => { if (v === undefined) return; await pool.query("INSERT INTO pbxng_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [k, v || '']); }; await setk('brand_name', b.name); await setk('brand_subtitle', b.subtitle); await setk('brand_tagline', b.tagline); await setk('brand_logo', b.logo); res.json({ ok: true }); } catch (e) { errorHttp(res, e); } });
app.get('/api/geo', async (req, res) => {
  const hours = Math.min(+(req.query.hours || 168), 720);
  const limit = Math.min(+(req.query.limit || 300), 1000);
  try {
    const { rows } = await pool.query("SELECT id, ext, number, dir, lat, lng, accuracy, extract(epoch from ts)::bigint AS ts FROM pbxng_call_geo WHERE ts > now() - ($1 || ' hours')::interval ORDER BY ts DESC LIMIT $2", [String(hours), limit]);
    res.json(rows);
  } catch (e) { errorHttp(res, e); }
});
app.get('/api/metrics', async (req, res) => {
  let db_size = null; try { const r = await pool.query("SELECT pg_database_size('pbxng') AS s"); db_size = +r.rows[0].s; } catch (_) {}
  res.json({ ...hostMetrics(), db_size, ts: Date.now() });
});


/* Seguridad (/seguridad): vive en guard.js, se monta más abajo cuando ya existen
 * `astFwd` e `io` (las rutas /api/security*, /api/ipgeo, el socket 'security' y el
 * baneo por nftables salen de ahí). Las rutas viejas de fail2ban se retiraron. */

// Email por empresa (SMTP)
app.get('/api/email/config', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT t.id AS tenant_id, t.name, e.host, e.port, e.secure, e.username, COALESCE(NULLIF(e.password,''),'') <> '' AS has_password, e.from_addr, e.enabled FROM tenants t LEFT JOIN pbxng_email_config e ON e.tenant_id=t.id ORDER BY t.id");
    res.json(rows);
  } catch (e) { errorHttp(res, e); }
});
app.post('/api/email/config', async (req, res) => {
  const b = req.body || {}; if (!b.tenant_id) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    await pool.query(`INSERT INTO pbxng_email_config (tenant_id,host,port,secure,username,password,from_addr,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (tenant_id) DO UPDATE SET host=$2,port=$3,secure=$4,username=$5,password=COALESCE(NULLIF($6,''), pbxng_email_config.password),from_addr=$7,enabled=$8,updated_at=now()`,
      [b.tenant_id, b.host || null, b.port || 587, !!b.secure, b.username || null, b.password || '', b.from_addr || null, !!b.enabled]);
    res.json({ ok: true });
  } catch (e) { errorHttp(res, e); }
});
function smtpHint(e) {
  const m = (e && e.message) || String(e); const code = (e && e.code) || '';
  if (code === 'EAUTH' || /534|Application-specific password|Username and Password not accepted|BadCredentials|5\.7\.8|5\.7\.9/i.test(m))
    return 'El servidor de correo rechazó la contraseña. Si la cuenta de Gmail/Workspace tiene verificación en 2 pasos, generá una Contraseña de aplicación en https://myaccount.google.com/apppasswords y usala aquí (no tu contraseña normal).';
  if (/ETIMEDOUT|ECONNECTION|ESOCKET|ECONNREFUSED|EHOSTUNREACH|getaddrinfo|ENOTFOUND/i.test(code + ' ' + m))
    return 'No se pudo conectar al servidor SMTP. Revisá host, puerto (465 SSL / 587 STARTTLS) y que el firewall permita la salida.';
  if (code === 'EENVELOPE' || /5\.1\.|recipient|sender/i.test(m))
    return 'Dirección de remitente o destinatario rechazada por el servidor.';
  return m;
}
app.post('/api/email/test', async (req, res) => {
  const { tenant_id = 1, to } = req.body || {}; if (!to) return res.status(400).json({ error: 'destinatario requerido' });
  try {
    const { rows } = await pool.query('SELECT host,port,secure,username,password,from_addr,enabled FROM pbxng_email_config WHERE tenant_id=$1', [tenant_id]);
    const cfg = rows[0]; if (!cfg || !cfg.host) return res.status(400).json({ error: 'sin configuración SMTP' });
    const tx = nodemailer.createTransport({ host: cfg.host, port: cfg.port || 587, secure: !!cfg.secure, auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined });
    const { rows: bn } = await pool.query("SELECT value FROM pbxng_settings WHERE key='brand_name'");
    const bname = (bn[0] && bn[0].value) || 'PBX-NG';
    await tx.sendMail({ from: cfg.from_addr || cfg.username, to, subject: 'Prueba de correo · ' + bname,
      html: emails.testEmail({ brand: bname }), text: 'La configuración SMTP funciona correctamente.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: smtpHint(e) }); }
});
app.get('/api/prompts', async (req, res) => {
  try { const { rows } = await pool.query('SELECT id,name,format,bytes,updated_at,synced_at FROM pbxng_prompts WHERE deleted=false ORDER BY name'); res.json(rows); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/prompts', async (req, res) => {
  const { name, format = 'wav', data } = req.body || {};
  if (!name || !data) return res.status(400).json({ error: 'name y data requeridos' });
  const clean = String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!clean) return res.status(400).json({ error: 'nombre inválido' });
  try {
    const buf = Buffer.from(data, 'base64');
    await pool.query(`INSERT INTO pbxng_prompts (name,format,bytes,data,deleted,updated_at,synced_at) VALUES ($1,$2,$3,$4,false,now(),NULL)
      ON CONFLICT (name) DO UPDATE SET format=$2,bytes=$3,data=$4,deleted=false,updated_at=now(),synced_at=NULL`, [clean, format, buf.length, buf]);
    res.json({ ok: true, name: clean });
  } catch (e) { errorHttp(res, e); }
});
app.delete('/api/prompts/:id', async (req, res) => {
  try { await pool.query('UPDATE pbxng_prompts SET deleted=true, updated_at=now(), synced_at=NULL WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { errorHttp(res, e); }
});


// Push (admin): dispositivos nativos + estado de proveedores
app.get('/api/push/devices', async (req, res) => { try { const devices = await pushProviders.listDevices(); const { rows } = await pool.query('SELECT ext, count(*)::int AS n FROM pbxng_push_subs GROUP BY ext'); const status = await pushProviders.providerStatus(); res.json({ devices, webpush: rows, status, vapid: VAPID.pub }); } catch (e) { errorHttp(res, e); } });

// Telefonos / Auto-provisioning (admin)
app.get('/api/phones', async (req, res) => { try { const { rows } = await pool.query('SELECT id,mac,vendor,model,ext,label,line_label,last_seen,created_at FROM pbxng_phones ORDER BY id'); res.json(rows); } catch (e) { errorHttp(res, e); } });
app.post('/api/phones', async (req, res) => {
  const b = req.body || {}; const mac = normMac(b.mac);
  if (!mac || mac.length !== 12) return res.status(400).json({ error: 'MAC invalida (12 hex)' });
  if (!b.ext) return res.status(400).json({ error: 'interno requerido' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let password = b.password;
    if (!password) { const { rows } = await c.query('SELECT password FROM ps_auths WHERE id=$1', [String(b.ext)]); password = (rows[0] && rows[0].password) || ('Tel' + crypto.randomBytes(4).toString('hex') + '#' + (10 + Math.floor(Math.random() * 89))); }
    await createSipEndpoint(c, String(b.ext), password, 'internal', b.tenant_id || 1);
    const { rows } = await c.query("INSERT INTO pbxng_phones (mac,vendor,model,ext,label,line_label,password,tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (mac) DO UPDATE SET vendor=$2,model=$3,ext=$4,label=$5,line_label=$6,password=$7 RETURNING id", [mac, b.vendor || 'yealink', b.model || null, String(b.ext), b.label || null, b.line_label || null, password, b.tenant_id || 1]);
    await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ id: rows[0].id, mac, ext: String(b.ext) });
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} errorHttp(res, e); } finally { c.release(); }
});
app.put('/api/phones/:id', async (req, res) => { const b = req.body || {}; try { await pool.query('UPDATE pbxng_phones SET vendor=$1,model=$2,ext=$3,label=$4,line_label=$5 WHERE id=$6', [b.vendor || 'yealink', b.model || null, String(b.ext), b.label || null, b.line_label || null, req.params.id]); res.json({ updated: req.params.id }); } catch (e) { errorHttp(res, e); } });
app.delete('/api/phones/:id', async (req, res) => { try { await pool.query('DELETE FROM pbxng_phones WHERE id=$1', [req.params.id]); res.json({ deleted: req.params.id }); } catch (e) { errorHttp(res, e); } });

// Voz IA (servicio Piper + faster-whisper) - estado y recursos del contenedor
app.get('/api/voz', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='voz_url'");
    const url = (rows[0] && rows[0].value) || (NODES.voz ? 'http://' + NODES.voz + ':8080' : 'http://127.0.0.1:8080');
    const t = Date.now();
    const r = await fetch(url + '/health', { signal: AbortSignal.timeout(4000) });
    const h = await r.json();
    res.json({ ok: true, url, latency_ms: Date.now() - t, ...h });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
async function vozBase() { const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='voz_url'"); return (rows[0] && rows[0].value) || (NODES.voz ? 'http://' + NODES.voz + ':8080' : 'http://127.0.0.1:8080'); }
async function vozFwd(method, path, body, ms) { const u = await vozBase(); const opt = { method, signal: AbortSignal.timeout(ms || 8000) }; if (body !== undefined) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); } opt.headers = Object.assign({ 'X-PBXNG-Token': AGENT_TOKEN }, opt.headers); const r = await fetch(u + path, opt); return r; }
app.get('/api/voz/logs', async (req, res) => { try { const r = await vozFwd('GET', '/admin/logs'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/voz/restart', async (req, res) => { try { const r = await vozFwd('POST', '/admin/restart', {}); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.get('/api/voz/voices', async (req, res) => { try { const r = await vozFwd('GET', '/admin/voices'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/voz/voices/install', async (req, res) => { try { const r = await vozFwd('POST', '/admin/voices/install', req.body || {}, 240000); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.delete('/api/voz/voices/:key', async (req, res) => { try { const r = await vozFwd('DELETE', '/admin/voices/' + encodeURIComponent(req.params.key)); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.get('/api/voz/config', async (req, res) => { try { const r = await vozFwd('GET', '/admin/config'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/voz/config', async (req, res) => { try { const r = await vozFwd('POST', '/admin/config', req.body || {}); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/voz/test', async (req, res) => { try { const u = await vozBase(); const r = await fetch(u + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: (req.body && req.body.text) || 'Hola, esta es una prueba de la voz seleccionada.', voice: req.body && req.body.voice, rate: 22050, format: 'wav' }), signal: AbortSignal.timeout(20000) }); const buf = Buffer.from(await r.arrayBuffer()); res.set('Content-Type', 'audio/wav').send(buf); } catch (e) { errorHttp(res, e); } });

// --- TURN / Coturn (agente CT106) ---
const TURN_BASE = process.env.TURN_AGENT || (NODES.turn ? 'http://' + NODES.turn + ':8091' : 'http://127.0.0.1:8091');
async function turnFwd(method, path, body, ms) { const opt = { method, signal: AbortSignal.timeout(ms || 8000) }; if (body !== undefined) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); } opt.headers = Object.assign({ 'X-PBXNG-Token': AGENT_TOKEN }, opt.headers); return fetch(TURN_BASE + path, opt); }
app.get('/api/turn', async (req, res) => { try { const r = await turnFwd('GET', '/health'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.get('/api/turn/config', async (req, res) => { try { const r = await turnFwd('GET', '/config'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/turn/config', async (req, res) => { try { const r = await turnFwd('POST', '/config', req.body || {}, 15000); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/turn/restart', async (req, res) => { try { const r = await turnFwd('POST', '/restart', {}, 15000); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.get('/api/turn/logs', async (req, res) => { try { const r = await turnFwd('GET', '/logs'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/turn/test', async (req, res) => { try { const r = await turnFwd('POST', '/test', {}, 15000); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });

// --- NPM: proxy inverso + certificado TLS (gestion desde el panel) ---
let _npmCertCache = null;
// NPM entrega fechas como '2026-08-01 20:22:07' (sin T ni zona) -> parseo robusto
function parseNpmDate(s) { if (!s) return null; const d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z')); return isNaN(d.getTime()) ? null : d; }
async function npmCfg() {
  const g = async (k) => { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value; };
  const url = ((await g('npm_url')) || (NODES.npm ? 'http://' + NODES.npm + ':81' : '')).replace(/\/+$/, '');
  return { url, id: await g('npm_identity'), sec: await g('npm_secret'), dom: (await g('domain')) || NODES.domain || '' };
}
async function npmToken(cfg) {
  if (!cfg.url || !cfg.id || !cfg.sec) return null;
  const tk = await fetch(cfg.url + '/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: cfg.id, secret: cfg.sec }), signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({}));
  return tk && tk.token ? tk.token : null;
}
async function npmCertInfo() {
  if (_npmCertCache && Date.now() - _npmCertCache.t < 1800000) return _npmCertCache.d;
  const cfg = await npmCfg();
  if (!cfg.url) return { error: 'npm-not-configured' };
  if (!cfg.id || !cfg.sec) return { error: 'npm-creds-missing' };
  const token = await npmToken(cfg);
  if (!token) return { error: 'npm-auth-failed' };
  const certs = await fetch(cfg.url + '/api/nginx/certificates', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) }).then((r) => r.json());
  const c = (Array.isArray(certs) ? certs : []).find((x) => (x.domain_names || []).includes(cfg.dom)) || (Array.isArray(certs) ? certs : []).find((x) => (x.domain_names || []).some((n) => cfg.dom && cfg.dom.endsWith(n.replace(/^\*\./, '.'))));
  if (!c) return { error: 'cert-not-found', domain: cfg.dom };
  const exp = parseNpmDate(c.expires_on);
  const d = { domain: cfg.dom, provider: c.provider, expires_on: c.expires_on, expires_date: exp ? exp.toISOString() : null, days_left: exp ? Math.round((exp.getTime() - Date.now()) / 86400000) : null };
  _npmCertCache = { t: Date.now(), d };
  return d;
}
app.get('/api/npm/cert', async (req, res) => { try { res.json(await npmCertInfo()); } catch (e) { errorHttp(res, e); } });
// Probar credenciales/conexion al NPM (y bustear cache del cert)
app.post('/api/npm/test', async (req, res) => {
  try {
    _npmCertCache = null;
    const cfg = await npmCfg();
    if (!cfg.url) return res.json({ ok: false, error: 'npm-not-configured' });
    if (!cfg.id || !cfg.sec) return res.json({ ok: false, error: 'npm-creds-missing' });
    const token = await npmToken(cfg);
    if (!token) return res.json({ ok: false, error: 'npm-auth-failed', url: cfg.url });
    const hosts = await fetch(cfg.url + '/api/nginx/proxy-hosts', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => []);
    res.json({ ok: true, url: cfg.url, domain: cfg.dom, hosts: Array.isArray(hosts) ? hosts.length : 0 });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
// Detectar SOLO el proxy host del dominio de PBX-NG (no administra el resto del NPM)
app.get('/api/npm/hosts', async (req, res) => {
  try {
    const cfg = await npmCfg();
    if (!cfg.url || !cfg.id || !cfg.sec) return res.json({ error: 'npm-creds-missing', host: null });
    if (!cfg.dom) return res.json({ error: 'domain-missing', host: null });
    const token = await npmToken(cfg);
    if (!token) return res.json({ error: 'npm-auth-failed', host: null });
    const hosts = await fetch(cfg.url + '/api/nginx/proxy-hosts', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    const arr = Array.isArray(hosts) ? hosts : [];
    const h = arr.find((x) => (x.domain_names || []).includes(cfg.dom)) || arr.find((x) => (x.domain_names || []).some((n) => n && cfg.dom.endsWith(n.replace(/^\*\./, '.'))));
    if (!h) return res.json({ error: 'host-not-found', host: null, domain: cfg.dom });
    res.json({ domain: cfg.dom, host: { id: h.id, domains: h.domain_names || [], forward: (h.forward_scheme || 'http') + '://' + (h.forward_host || '') + ':' + (h.forward_port || ''), ssl: !!h.certificate_id, ssl_forced: !!h.ssl_forced, enabled: h.enabled === 1 || h.enabled === true, ws: !!h.allow_websocket_upgrade } });
  } catch (e) { errorHttp(res, e); }
});

// --- Asterisk core agent (CT103) ---
const AST_AGENT = process.env.AST_AGENT || ('http://' + NODES.asterisk + ':8092');
async function astFwd(method, path, body, ms) { const opt = { method, signal: AbortSignal.timeout(ms || 8000) }; if (body !== undefined) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); } opt.headers = Object.assign({ 'X-PBXNG-Token': AGENT_TOKEN }, opt.headers); return fetch(AST_AGENT + path, opt); }

// ===== Navaja de captura de paquetes (pcap) — SBC (agente-DB) y Asterisk (agente-HTTP) =====
const CAP_PRESETS = { sip: 'udp port 5060', siprtp: 'udp', all: '' }; // BPF seguros del lado server
async function runAsteriskCapture(id, preset, duration) {
  try {
    await pool.query("UPDATE pbxng_captures SET status='running', started_at=now() WHERE id=$1", [id]);
    const r = await astFwd('POST', '/capture', { bpf: CAP_PRESETS[preset] || CAP_PRESETS.sip, duration }, (duration + 20) * 1000);
    if (!r.ok) throw new Error('ast-agent HTTP ' + r.status);
    const j = await r.json(); if (j.error) throw new Error(j.error);
    const buf = Buffer.from(j.b64 || '', 'base64');
    await pool.query("UPDATE pbxng_captures SET status='done', size=$2, data=$3, finished_at=now() WHERE id=$1", [id, buf.length, buf]);
  } catch (e) {
    await pool.query("UPDATE pbxng_captures SET status='error', error=$2, finished_at=now() WHERE id=$1", [id, String(e.message).slice(0, 300)]).catch(() => {});
  }
}
app.post('/api/capture/start', async (req, res) => {
  try {
    const b = req.body || {};
    const node = 'asterisk';   // las capturas en el borde se hacen desde el panel de SBC-NG
    const preset = ['sip', 'siprtp', 'all'].includes(b.preset) ? b.preset : 'sip';
    const duration = Math.min(300, Math.max(3, parseInt(b.duration, 10) || 30));
    const fn = `pbxng-${node}-${preset}-${new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')}.pcap`;
    const { rows } = await pool.query("INSERT INTO pbxng_captures (node,preset,duration,status,filename) VALUES ($1,$2,$3,'pending',$4) RETURNING id", [node, preset, duration, fn]);
    const id = rows[0].id;
    runAsteriskCapture(id, preset, duration);
    res.json({ id, node, preset, duration });
  } catch (e) { errorHttp(res, e); }
});
app.get('/api/capture/list', async (req, res) => {
  try { const { rows } = await pool.query("SELECT id,node,preset,duration,status,filename,size,error,created_at,started_at,finished_at FROM pbxng_captures ORDER BY id DESC LIMIT 100"); res.json(rows); }
  catch (e) { errorHttp(res, e); }
});
app.get('/api/capture/:id/download', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT filename,data FROM pbxng_captures WHERE id=$1 AND status='done'", [req.params.id]);
    if (!rows[0] || !rows[0].data) return res.status(404).end();
    res.set('Content-Type', 'application/vnd.tcpdump.pcap');
    res.set('Content-Disposition', 'attachment; filename="' + (rows[0].filename || ('cap-' + req.params.id + '.pcap')) + '"');
    res.send(rows[0].data);
  } catch (e) { res.status(500).end(); }
});
app.post('/api/capture/:id/stop', async (req, res) => {
  try { await pool.query("UPDATE pbxng_captures SET status='stopping' WHERE id=$1 AND status IN ('pending','running')", [req.params.id]); res.json({ ok: true }); }
  catch (e) { errorHttp(res, e); }
});
app.delete('/api/capture/:id', async (req, res) => {
  try { await pool.query("DELETE FROM pbxng_captures WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { errorHttp(res, e); }
});
app.get('/api/asterisk/core', async (req, res) => { try { const r = await astFwd('GET', '/core'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.get('/api/asterisk/net', async (req, res) => { try { const r = await astFwd('GET', '/net'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/asterisk/route', async (req, res) => { try { const r = await astFwd('POST', '/route', req.body || {}, 12000); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/asterisk/diag', async (req, res) => { try { const r = await astFwd('POST', '/diag', req.body || {}, 46000); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
app.post('/api/asterisk/iface', async (req, res) => { try { const r = await astFwd('POST', '/iface', req.body || {}, 12000); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });

/* ═══════════════ Modo de red del núcleo: ROUTER o SWITCH ════════════════════
 *
 * Mismo concepto que en SBC-NG. La diferencia: acá el control-plane sólo ARMA el
 * plan (netmode.js) y quien lo ejecuta es el agente del contenedor de Asterisk,
 * que es el que tiene las placas del host y NET_ADMIN.
 *
 * Aplicar un cambio de red puede cortar la gestión (si te comés la placa por la
 * que entrás al panel). Por eso va con **commit-confirm**: se aplica, y si nadie
 * confirma antes de que venza el plazo, se vuelve solo al modo anterior.
 * ==========================================================================*/
const netmode = require('./netmode');

pool.query("INSERT INTO pbxng_net (id) VALUES (1) ON CONFLICT (id) DO NOTHING").catch(e => logger('NET').error('fila semilla', e));   // esquema en migrations/

const netCfg = async () => { const { rows } = await pool.query('SELECT * FROM pbxng_net WHERE id=1'); return rows[0] || { modo: 'router', bridge: 'br0', nat: true, forward: true }; };
// Las placas se las preguntamos al agente (son las del host, no las del contenedor de la API).
async function netIfaces() {
  try { const r = await astFwd('GET', '/net'); const j = await r.json(); return (j && j.ifaces) || []; } catch (_) { return []; }
}

app.get('/api/net/mode', async (req, res) => {
  try { res.json({ cfg: await netCfg(), interfaces: await netIfaces(), pendiente: netPend ? { vence: netPend.vence } : null }); }
  catch (e) { errorHttp(res, e); }
});

app.put('/api/net/mode', async (req, res) => {
  const b = req.body || {};
  if (b.modo && !['router', 'switch'].includes(b.modo)) return res.status(400).json({ error: 'el modo es router o switch' });
  try {
    await pool.query('UPDATE pbxng_net SET modo=COALESCE($1,modo), wan_if=$2, lan_if=$3, nat=COALESCE($4,nat), forward=COALESCE($5,forward), bridge=COALESCE($6,bridge), updated_at=now() WHERE id=1',
      [b.modo || null, b.wan_if || null, b.lan_if || null,
       b.nat === undefined ? null : !!b.nat, b.forward === undefined ? null : !!b.forward, b.bridge || null]);
    res.json({ ok: true, pendiente: 'aplicar para que tome efecto' });
  } catch (e) { errorHttp(res, e); }
});

// Ver el plan ANTES de ejecutarlo (que se pueda leer es media función).
app.post('/api/net/mode/plan', async (req, res) => {
  try {
    const cfg = { ...(await netCfg()), ...(req.body || {}) };
    res.json({ modo: cfg.modo, pasos: netmode.plan(cfg, await netIfaces(), []) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

let netPend = null;   // { anterior, timer, vence }

app.post('/api/net/mode/apply', async (req, res) => {
  if (!req.body || req.body.confirmar !== true) {
    return res.status(400).json({ error: 'hay que confirmar: cambiar el modo de red puede cortar la conexión con el panel' });
  }
  const segundos = Math.min(600, Math.max(30, parseInt((req.body || {}).rollback_seg, 10) || 120));
  try {
    const anterior = await netCfg();
    const cfg = { ...anterior, ...(req.body.cfg || {}) };
    const ifaces = await netIfaces();
    const pasos = netmode.plan(cfg, ifaces, []);           // valida y arma (tira si la config no cierra)

    const r = await astFwd('POST', '/netmode', { pasos }, 60000);
    const out = await r.json();
    if (!out || out.ok !== true) return res.status(500).json({ error: 'falló al aplicar: ' + ((out && out.fallo) || 'sin detalle'), pasos: (out && out.pasos) || [] });

    await pool.query('UPDATE pbxng_net SET modo=$1, wan_if=$2, lan_if=$3, nat=$4, forward=$5, bridge=$6, updated_at=now() WHERE id=1',
      [cfg.modo, cfg.wan_if || null, cfg.lan_if || null, !!cfg.nat, !!cfg.forward, cfg.bridge || 'br0']);

    // Commit-confirm: si nadie confirma, volvemos solos al modo anterior.
    if (netPend && netPend.timer) clearTimeout(netPend.timer);
    const vence = Date.now() + segundos * 1000;
    netPend = {
      anterior, vence,
      timer: setTimeout(async () => {
        try {
          const pasosVuelta = netmode.plan(anterior, await netIfaces(), []);
          await astFwd('POST', '/netmode', { pasos: pasosVuelta }, 60000);
          await pool.query('UPDATE pbxng_net SET modo=$1, wan_if=$2, lan_if=$3, nat=$4, forward=$5, bridge=$6, updated_at=now() WHERE id=1',
            [anterior.modo, anterior.wan_if, anterior.lan_if, anterior.nat, anterior.forward, anterior.bridge]);
          logger('NET').warn('nadie confirmó el cambio de modo: se volvió a ' + anterior.modo);
        } catch (e) { logger('NET').error('rollback falló', e); }
        netPend = null;
      }, segundos * 1000),
    };
    res.json({ ok: true, modo: cfg.modo, pasos: out.pasos, confirmar_antes_de: vence, rollback_seg: segundos });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/net/mode/confirm', (req, res) => {
  if (!netPend) return res.json({ ok: true, nota: 'no había nada pendiente de confirmar' });
  clearTimeout(netPend.timer); netPend = null;
  res.json({ ok: true, confirmado: true });
});

app.post('/api/net/mode/revert', async (req, res) => {
  if (!netPend) return res.status(400).json({ error: 'no hay ningún cambio pendiente para revertir' });
  const anterior = netPend.anterior;
  clearTimeout(netPend.timer); netPend = null;
  try {
    const pasos = netmode.plan(anterior, await netIfaces(), []);
    const r = await astFwd('POST', '/netmode', { pasos }, 60000);
    const out = await r.json();
    await pool.query('UPDATE pbxng_net SET modo=$1, wan_if=$2, lan_if=$3, nat=$4, forward=$5, bridge=$6, updated_at=now() WHERE id=1',
      [anterior.modo, anterior.wan_if, anterior.lan_if, anterior.nat, anterior.forward, anterior.bridge]);
    res.json({ ok: !!(out && out.ok), modo: anterior.modo });
  } catch (e) { errorHttp(res, e); }
});
const CLI_ALLOW = /^(pjsip (show|list)|core show|dialplan show|queue show|confbridge (list|show)|module show|database (show|get)|rtp show|http show|manager show|stir_shaken show|version|uptime)\b/i;
app.post('/api/asterisk/cli', async (req, res) => {
  const cmd = String((req.body && req.body.cmd) || '').trim();
  if (!cmd) return res.status(400).json({ error: 'comando vacio' });
  if (!CLI_ALLOW.test(cmd)) return res.status(403).json({ error: 'Comando no permitido. Solo lectura: pjsip show/list, core show, dialplan show, queue show, module show, database show/get, rtp show, etc.' });
  try { const out = await amiCommand(cmd); res.json({ cmd, output: String(out || '') }); }
  catch (e) { res.status(500).json({ error: 'No se pudo ejecutar' }); }
});
app.post('/api/asterisk/hangup', async (req, res) => {
  const channel = String((req.body && req.body.channel) || '').trim();
  if (!channel) return res.status(400).json({ error: 'canal requerido' });
  try { await amiAction({ Action: 'Hangup', Channel: channel }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'No se pudo colgar' }); }
});

/* Troncales y rutas (trunks.js): troncales de operador (pbxng_trunks + ps_*), rutas
 * salientes/entrantes, el enlace fijo al SBC-NG (`to-sbc`, módulo `sbc`) y el diagnóstico
 * de troncal. Sus rutas se registran acá, DESPUÉS del gate de auth + RBAC; `sbcLink` es lo
 * único que el resto de la PBX mira para saber si hay un SBC adelante. */
const { sbcLink, invalidarSbcLink, trunkStatuses } = require('./trunks')({
  app, pool, NODES, amiCommand, endpointStates, moduleEnabled, setDialplan, astFwd, salud, diagtrunk, errorHttp,
  broadcastSoon: (...a) => broadcastSoon(...a), logger,
});


// --- Base de datos (PostgreSQL ARA + control plane) ---
app.get('/api/db', async (req, res) => {
  try {
    const q = async (sql) => (await pool.query(sql)).rows;
    const ver = ((await q('select version() v'))[0].v || '').split(' on ')[0];
    const up = (await q("select date_trunc('second', now()-pg_postmaster_start_time())::text u, pg_postmaster_start_time()::text s"))[0];
    const sz = (await q('select pg_size_pretty(pg_database_size(current_database())) p, pg_database_size(current_database()) b'))[0];
    const conn = (await q("select count(*)::int total, count(*) filter (where state='active')::int active, count(*) filter (where state='idle')::int idle from pg_stat_activity where datname=current_database()"))[0];
    const maxc = (await q('show max_connections'))[0].max_connections;
    const tables = await q('select schemaname as schema, relname as name, n_live_tup as rows, pg_total_relation_size(relid) as bytes, pg_size_pretty(pg_total_relation_size(relid)) as size from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 100');
    res.json({ version: ver, uptime: up.u, started: up.s, size: sz.p, size_bytes: +sz.b, conn: { total: conn.total, active: conn.active, idle: conn.idle, max: +maxc }, tables });
  } catch (e) { errorHttp(res, e); }
});
app.post('/api/db/maintenance', async (req, res) => {
  try { const t = req.body && req.body.table; if (t && /^[a-zA-Z0-9_]+$/.test(t)) await pool.query('VACUUM ANALYZE ' + t); else await pool.query('VACUUM ANALYZE'); res.json({ ok: true }); }
  catch (e) { errorHttp(res, e); }
});

// --- Modulos (PBX modular: activar/desactivar) ---
/* `sbc` = "Conexion a SBC-NG" (otro producto): apagado por defecto; se enciende solo
 * en instalaciones que ya tenian la troncal to-sbc (ver seed y migracion 0007).
 * `wsbridge` se retiro: era un servicio del SBC embebido. */
const MODULE_IDS = ['sbc', 'turn', 'voz', 'clicktocall', 'push', 'autoprov', 'ai', 'callcenter', 'intercom'];
app.get('/api/modules', async (req, res) => {
  try { const out = {}; for (const id of MODULE_IDS) out[id] = await moduleEnabled(id); res.json(out); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/modules', async (req, res) => {
  const { id, enabled } = req.body || {};
  if (!MODULE_IDS.includes(id)) return res.status(400).json({ error: 'modulo invalido' });
  try {
    await pool.query("INSERT INTO pbxng_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", ['mod_' + id, enabled ? '1' : '0']);
    let svc = null;
    try {
      if (id === 'turn') { const r = await turnFwd('POST', '/service', { action: enabled ? 'start' : 'stop' }, 12000); svc = await r.json(); }
    } catch (e) { svc = { error: e.message }; }
    if (id === 'sbc') { invalidarSbcLink(); broadcastSoon(); }
    res.json({ ok: true, id, enabled: !!enabled, svc });
  } catch (e) { errorHttp(res, e); }
});



// ===== Audios del sistema (voz coherente) =====
const SYSPROMPT_CATALOG = [
  // Buzon de voz (lo que escucha quien llama y el duenio de la casilla)
  ['vm-intro','buzon','Por favor, deje su mensaje despues del tono. Cuando termine, cuelgue o presione la tecla numeral.'],
  ['vm-goodbye','buzon','Gracias por llamar. Hasta pronto.'],
  ['vm-theperson','buzon','La persona en la extension'],
  ['vm-isunavail','buzon','no se encuentra disponible.'],
  ['vm-isonphone','buzon','se encuentra en otra llamada.'],
  ['vm-extension','buzon','La extension'],
  ['vm-youhave','buzon','Usted tiene'],
  ['vm-INBOX','buzon','nuevos'],
  ['vm-Old','buzon','guardados'],
  ['vm-message','buzon','mensaje.'],
  ['vm-messages','buzon','mensajes.'],
  ['vm-no','buzon','No tiene'],
  ['vm-nomore','buzon','No tiene mas mensajes.'],
  ['vm-nobodyavail','buzon','No hay nadie disponible para tomar su llamada.'],
  ['vm-incorrect','buzon','La contrasenia es incorrecta.'],
  ['vm-incorrect-mailbox','buzon','La casilla o la contrasenia son incorrectas.'],
  ['vm-pls-try-again','buzon','Por favor, intente nuevamente.'],
  ['vm-sorry','buzon','Disculpe, no comprendi.'],
  ['vm-press','buzon','Presione'],
  ['vm-saved','buzon','Su mensaje fue guardado.'],
  ['vm-deleted','buzon','El mensaje fue borrado.'],
  // Errores y generales
  ['pbx-invalid','general','El numero que usted marco no es valido.'],
  ['invalid','general','Entrada no valida. Por favor, intente nuevamente.'],
  ['pbx-transfer','general','Transfiriendo su llamada. Aguarde un momento, por favor.'],
  ['privacy-incorrect','general','La informacion ingresada no es correcta.'],
  ['beep','general',''],
  // Saludos y demo
  ['demo-congrats','saludo','Felicitaciones. La central PBX-NG esta funcionando correctamente.'],
  ['demo-thanks','saludo','Gracias por comunicarse. Hasta luego.'],
  ['demo-echotest','saludo','Comienza la prueba de eco. Hable despues del tono y escuchara su voz.'],
  ['demo-echodone','saludo','La prueba de eco finalizo.'],
  ['hello-world','saludo','Hola, mundo.'],
  // Conferencia
  ['conf-onlyperson','conferencia','Usted es la unica persona en la conferencia.'],
  ['conf-hasjoin','conferencia','ingreso a la conferencia.'],
  ['conf-hasleft','conferencia','salio de la conferencia.'],
  ['conf-locked','conferencia','La conferencia esta bloqueada.'],
  ['conf-kicked','conferencia','Ha sido retirado de la conferencia.'],
  ['conf-placeintoconf','conferencia','Ahora esta en la conferencia.'],
  ['conf-waitforleader','conferencia','La conferencia comenzara cuando ingrese el moderador.'],
  ['conf-getpin','conferencia','Por favor, ingrese el codigo de la conferencia, seguido de la tecla numeral.'],
  ['conf-invalidpin','conferencia','El codigo ingresado no es valido.'],
  // Colas
  ['queue-thankyou','cola','Gracias por aguardar.'],
  ['queue-youarenext','cola','Usted es el proximo en ser atendido.'],
  ['queue-callswaiting','cola','Cantidad de llamadas en espera:'],
  ['queue-holdtime','cola','El tiempo estimado de espera es de'],
  ['queue-minutes','cola','minutos.'],
  ['queue-minute','cola','minuto.'],
  ['queue-seconds','cola','segundos.'],
  ['queue-periodic-announce','cola','Su llamada es importante para nosotros. Le responderemos a la brevedad.'],
  // Digitos y numeros (para que el buzon diga las extensiones con la misma voz)
  ['digits/0','digitos','cero'],['digits/1','digitos','uno'],['digits/2','digitos','dos'],['digits/3','digitos','tres'],['digits/4','digitos','cuatro'],['digits/5','digitos','cinco'],['digits/6','digitos','seis'],['digits/7','digitos','siete'],['digits/8','digitos','ocho'],['digits/9','digitos','nueve'],
  ['digits/10','digitos','diez'],['digits/11','digitos','once'],['digits/12','digitos','doce'],['digits/13','digitos','trece'],['digits/14','digitos','catorce'],['digits/15','digitos','quince'],['digits/16','digitos','dieciseis'],['digits/17','digitos','diecisiete'],['digits/18','digitos','dieciocho'],['digits/19','digitos','diecinueve'],
  ['digits/20','digitos','veinte'],['digits/21','digitos','veintiuno'],['digits/22','digitos','veintidos'],['digits/23','digitos','veintitres'],['digits/24','digitos','veinticuatro'],['digits/25','digitos','veinticinco'],['digits/26','digitos','veintiseis'],['digits/27','digitos','veintisiete'],['digits/28','digitos','veintiocho'],['digits/29','digitos','veintinueve'],
  ['digits/30','digitos','treinta'],['digits/40','digitos','cuarenta'],['digits/50','digitos','cincuenta'],['digits/60','digitos','sesenta'],['digits/70','digitos','setenta'],['digits/80','digitos','ochenta'],['digits/90','digitos','noventa'],
  ['digits/100','digitos','cien'],['digits/200','digitos','doscientos'],['digits/300','digitos','trescientos'],['digits/400','digitos','cuatrocientos'],['digits/500','digitos','quinientos'],['digits/600','digitos','seiscientos'],['digits/700','digitos','setecientos'],['digits/800','digitos','ochocientos'],['digits/900','digitos','novecientos'],
  ['digits/100-and','digitos','ciento'],['digits/20-and','digitos','veinti'],['digits/1F','digitos','una'],['digits/1M','digitos','un'],['digits/and','digitos','y'],['digits/hundred','digitos','cien'],['digits/thousand','digitos','mil'],['digits/million','digitos','millon'],['digits/millions','digitos','millones'],['digits/minus','digitos','menos'],['digits/oh','digitos','o'],
  ['digits/star','digitos','asterisco'],['digits/pound','digitos','numeral'],
];

app.get('/api/sysprompts', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT name, category, text, voice, status, updated_at, deployed_at, (audio IS NOT NULL) AS has_audio FROM pbxng_sysprompts ORDER BY category, name");
    res.json(rows);
  } catch (e) { errorHttp(res, e); }
});

app.post('/api/sysprompts/seed', async (req, res) => {
  try {
    let n = 0;
    for (const [name, category, text] of SYSPROMPT_CATALOG) {
      const r = await pool.query("INSERT INTO pbxng_sysprompts(name, category, text) VALUES($1,$2,$3) ON CONFLICT (name) DO NOTHING", [name, category, text]);
      n += r.rowCount;
    }
    res.json({ ok: true, inserted: n, total: SYSPROMPT_CATALOG.length });
  } catch (e) { errorHttp(res, e); }
});

app.put('/api/sysprompts/:name', async (req, res) => {
  try {
    const text = (req.body && req.body.text) || '';
    await pool.query("UPDATE pbxng_sysprompts SET text=$1 WHERE name=$2", [text, req.params.name]);
    res.json({ ok: true });
  } catch (e) { errorHttp(res, e); }
});

app.post('/api/sysprompts/generate', async (req, res) => {
  try {
    const voice = (req.body && req.body.voice) || 'es-UY-ValentinaNeural';
    let names = (req.body && req.body.names) || [];
    if (!names.length) { const { rows } = await pool.query("SELECT name FROM pbxng_sysprompts"); names = rows.map(r => r.name); }
    const u = await vozBase();
    const results = [];
    for (const name of names) {
      try {
        const { rows } = await pool.query("SELECT text FROM pbxng_sysprompts WHERE name=$1", [name]);
        if (!rows.length) { results.push({ name, ok: false, error: 'no existe' }); continue; }
        const text = (rows[0].text || '').trim();
        if (!text) { results.push({ name, ok: true, skipped: 'sin texto' }); continue; }
        const r = await fetch(u + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, rate: 8000, format: 'wav' }), signal: AbortSignal.timeout(30000) });
        if (!r.ok) { results.push({ name, ok: false, error: 'tts ' + r.status }); continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 100) { results.push({ name, ok: false, error: 'audio vacio' }); continue; }
        await pool.query("UPDATE pbxng_sysprompts SET audio=$1, voice=$2, fmt='wav', status='generado', updated_at=now() WHERE name=$3", [buf, voice, name]);
        results.push({ name, ok: true, bytes: buf.length });
      } catch (ex) { results.push({ name, ok: false, error: ex.message }); }
    }
    res.json({ ok: true, voice, results, generated: results.filter(x => x.ok && !x.skipped).length });
  } catch (e) { errorHttp(res, e); }
});

app.get('/api/sysprompts/test/:name', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT audio FROM pbxng_sysprompts WHERE name=$1", [req.params.name]);
    if (!rows.length || !rows[0].audio) return res.status(404).json({ error: 'sin audio' });
    res.set('Content-Type', 'audio/wav').send(rows[0].audio);
  } catch (e) { errorHttp(res, e); }
});

app.post('/api/sysprompts/revert', async (req, res) => {
  try {
    let names = (req.body && req.body.names) || [];
    let r;
    if (!names.length) r = await pool.query("UPDATE pbxng_sysprompts SET revert=true, updated_at=now() WHERE deployed_at IS NOT NULL OR audio IS NOT NULL");
    else r = await pool.query("UPDATE pbxng_sysprompts SET revert=true, updated_at=now() WHERE name = ANY($1)", [names]);
    res.json({ ok: true, count: r.rowCount });
  } catch (e) { errorHttp(res, e); }
});
// ===== fin Audios del sistema =====


// Click-to-Call (admin)
app.get('/api/c2c', async (req, res) => { try { const { rows } = await pool.query('SELECT id,token,name,dest_type,dest_value,intro,require_name,collect_geo,video,enabled,created_at FROM pbxng_click2call ORDER BY id'); res.json(rows); } catch (e) { errorHttp(res, e); } });
app.post('/api/c2c', async (req, res) => { const b = req.body || {}; if (!b.name || !b.dest_value) return res.status(400).json({ error: 'name y destino requeridos' }); try { const token = crypto.randomBytes(6).toString('hex'); const { rows } = await pool.query('INSERT INTO pbxng_click2call (token,name,dest_type,dest_value,intro,require_name,collect_geo,video,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,token', [token, b.name, b.dest_type || 'extension', b.dest_value, b.intro || '', b.require_name !== false, !!b.collect_geo, !!b.video, b.enabled !== false]); res.status(201).json(rows[0]); } catch (e) { errorHttp(res, e); } });
app.put('/api/c2c/:id', async (req, res) => { const b = req.body || {}; try { await pool.query('UPDATE pbxng_click2call SET name=$1,dest_type=$2,dest_value=$3,intro=$4,require_name=$5,collect_geo=$6,video=$7,enabled=$8 WHERE id=$9', [b.name, b.dest_type || 'extension', b.dest_value, b.intro || '', b.require_name !== false, !!b.collect_geo, !!b.video, b.enabled !== false, req.params.id]); res.json({ updated: req.params.id }); } catch (e) { errorHttp(res, e); } });
app.delete('/api/c2c/:id', async (req, res) => { try { await pool.query('DELETE FROM pbxng_click2call WHERE id=$1', [req.params.id]); res.json({ deleted: req.params.id }); } catch (e) { errorHttp(res, e); } });



/* ─────────────── ACME / Let's Encrypt ───────────────
 * Certificado TLS propio del appliance SIN proxy adelante. Sólo admin.
 * HTTP-01 (puerto 80 standalone) o DNS-01 (API del DNS). */
function soloAdminAcme(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'requiere rol administrador' });
  next();
}
app.get('/api/acme', soloAdminAcme, async (req, res) => {
  try { res.json({ config: acme.configPublica(), cert: await acme.estadoCert() }); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/acme/config', soloAdminAcme, async (req, res) => {
  const { domain, email, method, dns_provider, dns_creds } = req.body || {};
  const cfg = {};
  if (domain !== undefined) cfg.domain = String(domain || '').trim();
  if (email !== undefined) cfg.email = String(email || '').trim();
  if (method !== undefined) cfg.method = (method === 'dns' ? 'dns' : 'http');
  if (dns_provider !== undefined) cfg.dns_provider = String(dns_provider || '');
  if (dns_creds && typeof dns_creds === 'object') cfg.dns_creds = dns_creds;
  try { acme.guardarCfg(cfg); res.json({ ok: true, config: acme.configPublica() }); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/acme/issue', soloAdminAcme, async (req, res) => {
  try { const r = await acme.emitir(); res.status(r.ok ? 200 : 400).json(r); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/acme/renew', soloAdminAcme, async (req, res) => {
  try { res.json(await acme.renovar()); } catch (e) { errorHttp(res, e); }
});
// Auto-renovación diaria (acme.sh no renueva si aún falta mucho).
setInterval(() => { acme.estadoCert().then((st) => { if (st.emitido) acme.renovar().catch(() => {}); }).catch(() => {}); }, 24 * 3600 * 1000);

app.get('/api/system', async (req, res) => {
  let dbver = null, db = false;
  try { const r = await pool.query('SELECT version()'); dbver = (r.rows[0].version || '').split(',')[0]; db = true; } catch (_) {}
  let ver = '', transports = '', mods = '';
  try { ver = await amiCommand('core show version'); } catch (_) {}
  try { transports = await amiCommand('pjsip show transports'); } catch (_) {}
  try { mods = await amiCommand('module show'); } catch (_) {}
  const has = (m) => new RegExp(m).test(mods);
  const astVer = (ver.match(/Asterisk\s+([0-9.]+)/) || [])[1] || '';
  const wss = /\bws\b|wss/i.test(transports);
  const comps = [
    { group: 'Nucleo', name: 'Asterisk', detail: astVer || '-', status: state.ami ? 'ok' : 'down' },
    { group: 'Nucleo', name: 'PJSIP (chan_pjsip)', detail: 'res_pjsip', status: has('res_pjsip\\.so') ? 'ok' : 'down' },
    { group: 'Nucleo', name: 'SRTP (cifrado de medios)', detail: 'res_srtp', status: has('res_srtp\\.so') ? 'ok' : 'off' },
    { group: 'Nucleo', name: 'Dialplan realtime', detail: 'pbx_realtime', status: has('pbx_realtime\\.so') ? 'ok' : 'off' },
    { group: 'Nucleo', name: 'Colas ACD', detail: 'app_queue', status: has('app_queue\\.so') ? 'ok' : 'off' },
    { group: 'Nucleo', name: 'Buzon de voz', detail: 'app_voicemail', status: has('app_voicemail\\.so') ? 'ok' : 'off' },
    { group: 'Nucleo', name: 'Conferencias', detail: 'app_confbridge', status: has('app_confbridge\\.so') ? 'ok' : 'off' },
    { group: 'Nucleo', name: 'WebSocket', detail: 'res_http_websocket', status: has('res_http_websocket\\.so') ? 'ok' : 'off' },
    { group: 'Datos', name: 'PostgreSQL', detail: dbver || '-', status: db ? 'ok' : 'down' },
    { group: 'Datos', name: 'CDR', detail: 'cdr_pgsql', status: has('cdr_pgsql\\.so') ? 'ok' : 'off' },
    { group: 'Transporte', name: 'SIP UDP 5060', detail: 'telefonos / softphones', status: /udp/i.test(transports) ? 'ok' : 'off' },
    { group: 'Transporte', name: 'ARI / AMI', detail: 'control plane (LAN)', status: state.ari && state.ami ? 'ok' : 'down' },
    { group: 'WebRTC', name: 'Transporte WebSocket (ws)', detail: (NODES.domain + '/ws'), status: wss ? 'ok' : 'off' },
    { group: 'WebRTC', name: 'WSS + certificado (NPM/LE)', detail: NODES.domain, status: 'ok' },
    { group: 'WebRTC', name: 'STUN', detail: 'stun.l.google.com:19302', status: 'ok' },
    { group: 'WebRTC', name: 'TURN (Coturn)', detail: ('TURN ' + (NODES.turn||'-')), status: 'ok' },
    { group: 'Seguridad', name: 'Fail2Ban', detail: 'anti fuerza bruta PJSIP', status: 'ok' },
    { group: 'Seguridad', name: 'Proxy inverso (NPM + LE)', detail: ((NODES.npm||'-') + ' - TLS'), status: 'ok' },
  ];
  res.json({ asterisk: astVer, components: comps });
});

/* Topología CON estado medido.
 *
 * Antes esto devolvía sólo las IPs del archivo de configuración, y las pantallas
 * las pintaban siempre en verde: el borde estuvo caído medio día y Topología y
 * Resumen lo mostraron sano. Ahora cada nodo se prueba de verdad.
 *
 * Distingue dos cosas que estaban mezcladas y son distintas:
 *   borde propio    parte de ESTE appliance (lo que configura SBC_HOST)
 *   borde externo   otro producto (SBC-NG u otro) conectado por troncal, con su
 *                   propio panel. Antes los dos se dibujaban como una sola caja
 *                   rotulada "SBC-NG", asi que la caja podia estar verde por el
 *                   borde propio mientras el SBC-NG externo estaba apagado.
 *
 * `nodes` se mantiene con el formato viejo a proposito: hay pantallas que lo leen
 * como texto plano y no tienen por que romperse por esto. */
app.get('/api/topology', async (req, res) => {
  const base = {
    domain: NODES.domain, public_ip: NODES.public_ip,
    nodes: {
      asterisk: NODES.asterisk, db: NODES.db, sbc: '',
      npm: NODES.npm, turn: NODES.turn, voz: NODES.voz,
    },
  };
  try {
    const lk = await sbcLink();
    base.nodes.sbc = lk.active ? lk.host : '';
    base.sbc = { enabled: lk.enabled, configured: lk.configured, active: lk.active, host: lk.host, port: lk.port, panel_url: lk.panel_url };
    /* Sin el modulo "Conexion a SBC-NG" no hay borde externo que medir ni mostrar:
     * la PBX es autonoma y el diagrama no debe mencionar un producto que no esta. */
    const { rows } = lk.active ? await pool.query('SELECT name, provider_host, provider_port, kind FROM pbxng_trunks').catch(() => ({ rows: [] })) : { rows: [] };
    const [propios, externos] = await Promise.all([salud.nodos(NODES), salud.bordesExternos(rows)]);
    const todos = propios.concat(externos);
    res.json({ ...base, componentes: propios, bordes_externos: externos, salud: salud.resumir(todos), medido: new Date().toISOString() });
  } catch (e) {
    // Si la medición falla, se devuelve igual la topología: es mejor un diagrama
    // sin colores que una pantalla en blanco.
    res.json({ ...base, componentes: [], bordes_externos: [], salud: null, error_medicion: e.message });
  }
});

app.get('/api/extensions', async (req, res) => { try { res.json(await getExtensions()); } catch (e) { errorHttp(res, e); } });
app.get('/api/endpoints', async (req, res) => { try { res.json(await getExtensions()); } catch (e) { errorHttp(res, e); } });
/* Modos de DTMF válidos (Asterisk chan_pjsip). Importa de verdad en porteros/frentes de
 * calle: muchos (Dahua, Hikvision) mandan el dígito de apertura por SIP INFO (RFC 2976)
 * en vez de RTP (RFC 4733). Si el modo no coincide, la puerta NO abre.
 *   rfc4733   → DTMF por RTP (estándar, el default)
 *   info      → DTMF por SIP INFO
 *   auto_info → RFC 4733 si el otro lo ofrece; si no, INFO  ← el más compatible
 *   auto      → RFC 4733 si lo ofrece; si no, inband
 *   inband    → tonos dentro del audio (último recurso) */
const DTMF_MODES = ['rfc4733', 'info', 'auto', 'auto_info', 'inband'];
const dtmfOk = (v) => (DTMF_MODES.includes(String(v)) ? String(v) : null);

app.post('/api/endpoints', async (req, res) => {
  const { id, password, context = 'internal', tenant_id = 1, video = false, webrtc = false, max_contacts = 2 } = req.body || {};
  const dtmf = dtmfOk((req.body || {}).dtmf_mode) || 'rfc4733';
  const allow = await sipConf.defaultCodecs(video || webrtc);
  const transport = webrtc ? 'transport-ws' : 'transport-udp';
  if (!id || !password) return res.status(400).json({ error: 'id y password son obligatorios' });
  // No alcanza con validar en el panel: cualquiera puede pegarle a la API. El numero se
  // valida contra TODO el plan (colas, IVR, conferencias, grupos, voceo, agentes IA, codigos
  // de funcion y prefijos de rutas salientes) antes de tocar la base.
  const vn = await numbering.check(id).catch(() => ({ ok: true }));
  if (!vn.ok && !(req.body && req.body.force)) {
    return res.status(409).json({ error: vn.mensaje, motivo: vn.motivo, conflicto: vn.conflicto || null });
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("INSERT INTO ps_aors (id,max_contacts,remove_existing,remove_unavailable,support_path,qualify_frequency,tenant_id) VALUES ($1,$2,'no','yes','yes',60,$3)", [id, max_contacts, tenant_id]);
    await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$1,$2,$3)", [id, password, tenant_id]);
    if (webrtc) {
      await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,webrtc,dtls_auto_generate_cert,ice_support,use_avpf,media_encryption,media_use_received_transport,rtcp_mux,direct_media,rtp_symmetric,force_rport,rewrite_contact,dtmf_mode) VALUES ($1,$2,$1,$1,$3,'all',$4,$5,'extension','yes','yes','yes','yes','dtls','yes','yes','no','yes','yes','yes',$6)", [id, transport, context, allow, tenant_id, dtmf]);
  await c.query("UPDATE ps_endpoints SET mailboxes = id || '@default' WHERE id=$1 AND (mailboxes IS NULL OR mailboxes='')", [id]);
  await sipConf.afterCreate(c, id);
  await c.query("INSERT INTO voicemail (context, mailbox, password, fullname) SELECT 'default', $1::text, $1::text, 'Interno ' || $1::text WHERE NOT EXISTS (SELECT 1 FROM voicemail v WHERE v.mailbox = $1::text AND v.context='default')", [id]);
    } else {
      await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,direct_media,rtp_symmetric,force_rport,rewrite_contact,dtmf_mode) VALUES ($1,$2,$1,$1,$3,'all',$4,$5,'extension','no','yes','yes','yes',$6)", [id, transport, context, allow, tenant_id, dtmf]);
  await c.query("UPDATE ps_endpoints SET mailboxes = id || '@default' WHERE id=$1 AND (mailboxes IS NULL OR mailboxes='')", [id]);
  await sipConf.afterCreate(c, id);
  await c.query("INSERT INTO voicemail (context, mailbox, password, fullname) SELECT 'default', $1::text, $1::text, 'Interno ' || $1::text WHERE NOT EXISTS (SELECT 1 FROM voicemail v WHERE v.mailbox = $1::text AND v.context='default')", [id]);
    }
    if (req.body && req.body.name) await c.query("INSERT INTO pbxng_directory (ext,name) VALUES ($1,$2) ON CONFLICT (ext) DO UPDATE SET name=EXCLUDED.name", [id, req.body.name]);
    await c.query('COMMIT'); broadcastSoon(); const _rec = !!(req.body && req.body.record); await pool.query('UPDATE ps_endpoints SET pbxng_record=$2 WHERE id=$1', [id, _rec]).catch(() => {}); setRecFlag(id, _rec); res.status(201).json({ created: id, webrtc, video });
  } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
});
app.put('/api/endpoints/:id', async (req, res) => {
  const { id } = req.params;
  const { password, context, video = false, webrtc = false, max_contacts } = req.body || {};
  const allow = await sipConf.defaultCodecs(video || webrtc);
  const transport = webrtc ? 'transport-ws' : 'transport-udp';
  // null = el body no lo trae -> COALESCE deja el valor que ya tenia el endpoint.
  const dtmf = dtmfOk((req.body || {}).dtmf_mode);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (password) await c.query('UPDATE ps_auths SET password=$2 WHERE id=$1', [id, password]);
    if (max_contacts) await c.query('UPDATE ps_aors SET max_contacts=$2 WHERE id=$1', [id, max_contacts]);
    if (webrtc) {
      await c.query("UPDATE ps_endpoints SET transport=$2, context=COALESCE($3,context), disallow='all', allow=$4, webrtc='yes', dtls_auto_generate_cert='yes', ice_support='yes', use_avpf='yes', media_encryption='dtls', media_use_received_transport='yes', rtcp_mux='yes', direct_media='no', rtp_symmetric='yes', force_rport='yes', rewrite_contact='yes', dtmf_mode=COALESCE($5,dtmf_mode) WHERE id=$1", [id, transport, context, allow, dtmf]);
    } else {
      await c.query("UPDATE ps_endpoints SET transport=$2, context=COALESCE($3,context), disallow='all', allow=$4, webrtc='no', media_encryption='no', direct_media='no', rtp_symmetric='yes', force_rport='yes', rewrite_contact='yes', dtmf_mode=COALESCE($5,dtmf_mode) WHERE id=$1", [id, transport, context, allow, dtmf]);
    }
    if (req.body && req.body.name !== undefined) await c.query("INSERT INTO pbxng_directory (ext,name) VALUES ($1,$2) ON CONFLICT (ext) DO UPDATE SET name=EXCLUDED.name", [id, req.body.name]);
    await c.query('COMMIT'); broadcastSoon(); const _rec = !!(req.body && req.body.record); await pool.query('UPDATE ps_endpoints SET pbxng_record=$2 WHERE id=$1', [id, _rec]).catch(() => {}); setRecFlag(id, _rec); res.json({ updated: id, webrtc, video });
  } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
});
app.delete('/api/endpoints/:id', async (req, res) => {
  const { id } = req.params; const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('DELETE FROM ps_endpoints WHERE id=$1', [id]); await c.query('DELETE FROM ps_auths WHERE id=$1', [id]); await c.query('DELETE FROM ps_aors WHERE id=$1', [id]); await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: id }); }
  catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
});


// ---------------- Integraciones (Telegram / WhatsApp) ----------------
async function sendTelegram(cfg, text) {
  if (!cfg || !cfg.token || !cfg.chat_id) throw new Error('falta token o chat_id');
  const r = await fetch('https://api.telegram.org/bot' + cfg.token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error((j && j.description) || ('HTTP ' + r.status));
  return j;
}
async function sendWhatsapp(cfg, text) {
  if (!cfg || !cfg.url || !cfg.to) throw new Error('falta url o destinatario');
  const base = String(cfg.url).replace(/\/$/, '');
  const r = await fetch(base + '/sendText', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cfg.apikey ? { 'api_key': cfg.apikey } : {}) },
    body: JSON.stringify({ args: { to: cfg.to, content: text } })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('HTTP ' + r.status + (t ? ' ' + t.slice(0, 120) : '')); }
  return await r.json().catch(() => ({ ok: true }));
}
async function notifyIntegrations(text) {
  try {
    const { rows } = await pool.query('SELECT type, config FROM pbxng_integrations WHERE enabled=true');
    for (const r of rows) {
      try { if (r.type === 'telegram') await sendTelegram(r.config, text); else if (r.type === 'whatsapp') await sendWhatsapp(r.config, text); }
      catch (e) { logger('INT').error('envío ' + r.type, e); }
    }
  } catch (e) { logger('INT').error('notify', e); }
}
function publicIntegration(type, row) {
  const c = (row && row.config) || {};
  if (type === 'telegram') return { type, enabled: !!(row && row.enabled), configured: !!c.token, chat_id: c.chat_id || '' };
  return { type, enabled: !!(row && row.enabled), configured: !!c.url, url: c.url || '', to: c.to || '', has_apikey: !!c.apikey };
}
app.get('/api/integrations', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT type, enabled, config FROM pbxng_integrations");
    const map = {}; rows.forEach(r => map[r.type] = r);
    res.json([publicIntegration('telegram', map.telegram), publicIntegration('whatsapp', map.whatsapp)]);
  } catch (e) { errorHttp(res, e); }
});
app.put('/api/integrations/:type', async (req, res) => {
  const type = req.params.type; if (!['telegram', 'whatsapp'].includes(type)) return res.status(400).json({ error: 'tipo inválido' });
  const b = req.body || {};
  try {
    const { rows } = await pool.query('SELECT config FROM pbxng_integrations WHERE type=$1', [type]);
    const cfg = (rows[0] && rows[0].config) || {};
    if (type === 'telegram') { if (b.token) cfg.token = b.token; if (b.chat_id !== undefined) cfg.chat_id = b.chat_id; }
    else { if (b.url !== undefined) cfg.url = b.url; if (b.apikey) cfg.apikey = b.apikey; if (b.to !== undefined) cfg.to = b.to; }
    const enabled = b.enabled !== undefined ? !!b.enabled : (rows[0] ? undefined : false);
    await pool.query("INSERT INTO pbxng_integrations (type,enabled,config,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (type) DO UPDATE SET enabled=COALESCE($2,pbxng_integrations.enabled), config=$3, updated_at=now()", [type, enabled, cfg]);
    res.json({ ok: true });
  } catch (e) { errorHttp(res, e); }
});
app.post('/api/integrations/:type/test', async (req, res) => {
  const type = req.params.type;
  try {
    const { rows } = await pool.query('SELECT config FROM pbxng_integrations WHERE type=$1', [type]);
    const cfg = (rows[0] && rows[0].config) || {};
    const msg = '✅ <b>PBX-NG</b>: mensaje de prueba de integración (' + type + ').';
    if (type === 'telegram') await sendTelegram(cfg, msg);
    else if (type === 'whatsapp') await sendWhatsapp(cfg, 'PBX-NG: mensaje de prueba de integración (whatsapp).');
    else return res.status(400).json({ error: 'tipo inválido' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/settings', async (req, res) => {
  try { const { rows } = await pool.query('SELECT key,value FROM pbxng_settings'); const o = {}; for (const r of rows) { o[r.key] = /key|secret|token|pass|account|credential|p8|private/i.test(r.key) ? (r.value ? '__SET__' : '') : r.value; } res.json(o); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/settings', async (req, res) => {
  const b = req.body || {};
  try { for (const [k, v] of Object.entries(b)) { if (v === '__SET__') continue; await pool.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, String(v == null ? '' : v)]); } res.json({ ok: true }); }
  catch (e) { errorHttp(res, e); }
});

app.get('/api/wallboard', async (req, res) => {
  const out = { today: {}, queues: [] };
  try {
    const { rows } = await pool.query("SELECT count(*)::int total, count(*) FILTER (WHERE disposition='ANSWERED')::int answered, count(*) FILTER (WHERE disposition IN ('NO ANSWER','BUSY','FAILED','CONGESTION'))::int missed, COALESCE(round(avg(billsec) FILTER (WHERE disposition='ANSWERED'))::int,0) avg_talk, count(*) FILTER (WHERE dcontext='from-trunk')::int inbound FROM cdr WHERE start >= date_trunc('day', now())");
    out.today = rows[0] || {};
    out.today.outbound = Math.max(0, (out.today.total || 0) - (out.today.inbound || 0));
  } catch (e) { out.today = { error: e.message }; }
  try {
    const txt = await amiCommand('queue show');
    const re = /^([^\s].*?) has (\d+) calls? \(max[^)]*\) in '([^']*)' strategy \((\d+)s holdtime, (\d+)s talktime\), W:\d+, C:(\d+), A:(\d+)/gm;
    let m; while ((m = re.exec(txt)) !== null) {
      out.queues.push({ name: m[1].trim(), waiting: +m[2], strategy: m[3], holdtime: +m[4], talktime: +m[5], completed: +m[6], abandoned: +m[7] });
    }
  } catch (e) { out.queues_error = e.message; }
  res.json(out);
});


app.get('/api/conferences', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,label,access_exten,pin FROM pbxng_conferences ORDER BY id'); res.json(rows); } catch (e) { errorHttp(res, e); } });
app.post('/api/conferences', async (req, res) => {
  const { name, label, access_exten, pin } = req.body || {};
  if (!name || !access_exten) return res.status(400).json({ error: 'name y access_exten son obligatorios' });
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('INSERT INTO pbxng_conferences (name,label,access_exten,pin) VALUES ($1,$2,$3,$4)', [name, label || name, access_exten, pin || null]); const rows = [[1, 'Answer', '']]; let p = 2; if (pin) rows.push([p++, 'Authenticate', String(pin)]); rows.push([p++, 'ConfBridge', name]); rows.push([p++, 'Hangup', '']); await setDialplan(c, 'ivr', access_exten, rows); await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: name, access_exten }); }
  catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
});
app.delete('/api/conferences/:name', async (req, res) => { const { name } = req.params; const c = await pool.connect(); try { await c.query('BEGIN'); const { rows } = await c.query('SELECT access_exten FROM pbxng_conferences WHERE name=$1', [name]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].access_exten]); await c.query('DELETE FROM pbxng_conferences WHERE name=$1', [name]); await c.query('COMMIT'); res.json({ deleted: name }); } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); } });

// --- Captura de llamada: grupo por interno (ps_endpoints; el aparcado y la MOH están en apps.js) ---
app.get('/api/pickup-groups', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id AS ext, named_pickup_group, named_call_group FROM ps_endpoints ORDER BY id");
    res.json(rows);
  } catch (e) { errorHttp(res, e); }
});
app.put('/api/pickup-groups/:ext', async (req, res) => {
  const g = String((req.body || {}).grupo || '').replace(/[^\w.\-]/g, '').slice(0, 40) || null;
  try {
    // En Asterisk, para poder capturar el teléfono de alguien tenés que estar en su
    // mismo grupo: por eso se setean los dos (a quién puedo capturar / quién me captura).
    await pool.query('UPDATE ps_endpoints SET named_call_group=$1, named_pickup_group=$1 WHERE id=$2', [g, req.params.ext]);
    await amiCommand('module reload res_pjsip.so');
    res.json({ ok: true, ext: req.params.ext, grupo: g });
  } catch (e) { errorHttp(res, e); }
});

/* ── Manuales: subir/ver/borrar las capturas desde el propio panel ─────────── */
app.get('/api/manuales/img/:name', (req, res) => {
  const name = req.params.name;
  if (!IMG_OK.test(name)) return res.status(400).end();
  const f = _pathm.join(MAN_IMG_DIR, name);
  // Precedencia: lo que el operador subió por el panel gana. Si no subió nada, caemos
  // a la imagen que viene con el producto (los diagramas del repo, servidos por el
  // dashboard). Así el editor puede REEMPLAZAR un diagrama sin perder los originales.
  if (!f.startsWith(MAN_IMG_DIR) || !_fsm.existsSync(f)) {
    return res.redirect(302, '/manuales/img/' + encodeURIComponent(name));
  }
  res.set('Content-Type', IMG_MIME[_pathm.extname(name).toLowerCase()] || 'application/octet-stream');
  res.set('Cache-Control', 'no-store');   // recién subida -> se ve al recargar
  _fsm.createReadStream(f).pipe(res);
});
app.post('/api/manuales/img/:name', (req, res) => {
  const name = req.params.name;
  if (!IMG_OK.test(name)) return res.status(400).json({ error: 'nombre inválido' });
  const data = (req.body && req.body.data) || '';
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(data);
  if (!m) return res.status(400).json({ error: 'se espera un data URL de imagen' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'imagen demasiado grande (máx 15MB)' });
  try {
    _fsm.mkdirSync(MAN_IMG_DIR, { recursive: true });
    _fsm.writeFileSync(_pathm.join(MAN_IMG_DIR, name), buf);
    res.json({ ok: true, name, bytes: buf.length });
  } catch (e) { errorHttp(res, e); }
});
app.delete('/api/manuales/img/:name', (req, res) => {
  const name = req.params.name;
  if (!IMG_OK.test(name)) return res.status(400).json({ error: 'nombre inválido' });
  try { _fsm.rmSync(_pathm.join(MAN_IMG_DIR, name), { force: true }); res.json({ ok: true }); }
  catch (e) { errorHttp(res, e); }
});
// ---------------- Respaldo y restauración ----------------
// El respaldo NO lleva contraseñas: ver la explicación al principio de backup.js.
app.get('/api/backup', async (req, res) => {
  try { res.json({ respaldos: await backup.listar(), partes: backup.PARTES.map(p => ({ id: p.id, desc: p.desc, opcional: !!p.opcional })) }); }
  catch (e) { errorHttp(res, e); }
});

app.post('/api/backup', async (req, res) => {
  try {
    const r = await backup.crear({ grabaciones: !!(req.body && req.body.grabaciones), nota: (req.body && req.body.nota) || '' });
    res.status(201).json(r);
  } catch (e) { errorHttp(res, e); }
});

/* ── Respaldo programado (docs/CONTRATOS.md §3 `backup/schedule`) ──────────────
 * Planificador INTERNO de la API: un respaldo por día, sin grabaciones, a la hora
 * elegida en el panel, con retención sobre los programados. Va adentro de la API y
 * no sólo en el cron del host porque hay instalaciones donde nadie toca el host
 * (CT de Proxmox entregado llave en mano): si dependiera del cron, "activar" desde
 * el panel no haría nada. El cron (docker/backup-cron.sh → backup-cli.js) sigue
 * siendo válido y usa la misma función; los dos anotan backup_last_run al EMPEZAR,
 * y el planificador no arranca si hoy ya hay una marca, así que no se pisan.
 * La hora se compara con el reloj local del contenedor (TZ del compose). */
const BK = { enabled: 'backup_enabled', hour: 'backup_hour', keep: 'backup_keep', run: 'backup_last_run', ok: 'backup_last_ok', err: 'backup_last_error', nombre: 'backup_last_nombre' };
const BK_DEF = { enabled: '1', hour: 3, keep: +(process.env.BACKUP_KEEP || 14) || 14 };
async function bkSchedule() {
  const g = async (k, d) => { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value != null && rows[0].value !== '' ? rows[0].value : d; };
  const hour = parseInt(await g(BK.hour, BK_DEF.hour), 10), keep = parseInt(await g(BK.keep, BK_DEF.keep), 10);
  const ok = await g(BK.ok, '');
  return {
    enabled: (await g(BK.enabled, BK_DEF.enabled)) === '1',
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : BK_DEF.hour,
    keep: Number.isInteger(keep) && keep >= 1 ? keep : BK_DEF.keep,
    last_run: (await g(BK.run, '')) || null,
    last_ok: ok === '' ? null : ok === '1',
    last_error: (await g(BK.err, '')) || null,
    last_nombre: (await g(BK.nombre, '')) || null,
    running: bkCorriendo,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  };
}
app.get('/api/backup/schedule', async (req, res) => { try { res.json(await bkSchedule()); } catch (e) { errorHttp(res, e); } });
app.post('/api/backup/schedule', async (req, res) => {
  try {
    const b = req.body || {};
    const put = (k, v) => pool.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, String(v)]);
    if (b.hour !== undefined) {
      if (!Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23) return res.status(400).json({ error: 'la hora tiene que ser un entero entre 0 y 23' });
      await put(BK.hour, b.hour);
    }
    if (b.keep !== undefined) {
      if (!Number.isInteger(b.keep) || b.keep < 1 || b.keep > 3650) return res.status(400).json({ error: 'la cantidad a conservar tiene que ser un entero de 1 o más' });
      await put(BK.keep, b.keep);
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'enabled tiene que ser true o false' });
      await put(BK.enabled, b.enabled ? '1' : '0');
    }
    res.json(await bkSchedule());
  } catch (e) { errorHttp(res, e); }
});

let bkCorriendo = false;
const bkLog = logger('BACKUP');
const bkDia = (d) => { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
async function bkTick() {
  if (cerrando || bkCorriendo) return;
  let cfg;
  try { cfg = await bkSchedule(); } catch (e) { return; }   // sin DB no hay respaldo posible; el próximo minuto se reintenta
  if (!cfg.enabled) return;
  const ahora = new Date();
  if (ahora.getHours() !== cfg.hour) return;
  // "no corrió hoy": la marca se compara en el día local del contenedor, igual que la hora.
  if (cfg.last_run && bkDia(new Date(cfg.last_run)) === bkDia(ahora)) return;
  bkCorriendo = true;
  const put = (k, v) => pool.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, String(v)]).catch((e) => bkLog.warn('no pude anotar ' + k, e));
  try {
    // Marca de inicio ANTES de crear: es lo que evita que el cron del host y este
    // planificador hagan dos respaldos a la misma hora (ver backup-cli.js).
    await put(BK.run, ahora.toISOString());
    bkLog.info('respaldo programado: inicio', { hour: cfg.hour, keep: cfg.keep });
    const r = await backup.programado({ grabaciones: false, keep: cfg.keep, nota: 'programado' });
    await put(BK.ok, '1'); await put(BK.err, ''); await put(BK.nombre, r.nombre);
    bkLog.info('respaldo programado: OK', { nombre: r.nombre, bytes: r.bytes, borrados: r.retencion.borrados });
  } catch (e) {
    await put(BK.ok, '0'); await put(BK.err, String(e && e.message || e).slice(0, 300));
    bkLog.error('respaldo programado: falló', e);
  } finally { bkCorriendo = false; }
}
setInterval(() => bkTick().catch((e) => bkLog.error('planificador', e)), 60000).unref();

// Descarga por streaming: un respaldo con grabaciones puede pesar cientos de MB y no
// tiene por qué pasar por memoria.
app.get('/api/backup/:nombre/archivo', (req, res) => {
  let f; try { f = backup.seguro(req.params.nombre); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.download(f, req.params.nombre, (e) => { if (e && !res.headersSent) res.status(404).json({ error: 'no existe ese respaldo' }); });
});

// Leer el manifiesto sin restaurar: es lo que se le muestra al operador ANTES de decidir.
app.get('/api/backup/:nombre/inspeccionar', async (req, res) => {
  try { res.json(await backup.inspeccionar(req.params.nombre)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/backup/:nombre', async (req, res) => {
  try { await backup.borrar(req.params.nombre); res.json({ borrado: req.params.nombre }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Subir un respaldo traído de otra instalación. Va como stream crudo, no como JSON:
// un base64 dentro de un JSON multiplica por 1.33 y se come la memoria del proceso.
app.post('/api/backup/subir/:nombre', express.raw({ type: '*/*', limit: '2gb' }), async (req, res) => {
  try {
    const f = backup.seguro(req.params.nombre);
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'el archivo llegó vacío' });
    require('fs').writeFileSync(f, req.body);
    const m = await backup.inspeccionar(req.params.nombre).catch((e) => ({ error: e.message }));
    if (m && m.error) { try { require('fs').unlinkSync(f); } catch (_) {} return res.status(400).json({ error: m.error }); }
    res.status(201).json({ subido: req.params.nombre, manifiesto: m });
  } catch (e) { errorHttp(res, e); }
});

app.post('/api/backup/:nombre/restaurar', async (req, res) => {
  try {
    const r = await backup.restaurar(req.params.nombre, {
      partes: (req.body && Array.isArray(req.body.partes)) ? req.body.partes : null,
      confirmar: !!(req.body && req.body.confirmar),
    });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/manuales/img-list', (req, res) => {
  try {
    const files = _fsm.existsSync(MAN_IMG_DIR) ? _fsm.readdirSync(MAN_IMG_DIR).filter((f) => IMG_OK.test(f)) : [];
    res.json({ cargadas: files });
  } catch (e) { errorHttp(res, e); }
});

app.get('/api/dialplan', async (req, res) => { const ctx = req.query.context; try { res.json({ output: await amiCommand('dialplan show' + (ctx ? ' ' + ctx : '')) }); } catch (e) { errorHttp(res, e); } });
app.get('/api/channels', async (req, res) => { try { res.json(await getChannels()); } catch (e) { errorHttp(res, e); } });
app.get('/api/tenants', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,slug,context_prefix,active FROM tenants ORDER BY id'); res.json(rows); } catch (e) { errorHttp(res, e); } });

app.get('/api/sip/messages', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  try {
    const { rows } = await pool.query("SELECT id, extract(epoch from ts)*1000 AS t, host, src, dst, method, status, callid, cseq, from_uri, to_uri, ruri FROM (SELECT * FROM pbxng_sip_capture ORDER BY id DESC LIMIT $1) q ORDER BY id ASC", [limit]);
    res.json(rows);
  } catch (e) { errorHttp(res, e); }
});
app.get('/api/sip/raw/:id', async (req, res) => {
  try { const { rows } = await pool.query("SELECT raw FROM pbxng_sip_capture WHERE id=$1", [req.params.id]); res.json({ raw: rows[0] ? rows[0].raw : '' }); }
  catch (e) { errorHttp(res, e); }
});
app.get('/api/sip/state', async (req, res) => {
  try {
    const a = await pool.query("SELECT value FROM pbxng_settings WHERE key='sip_capture_on'");
    const c = await pool.query("SELECT count(*)::int n FROM pbxng_sip_capture");
    res.json({ on: !(a.rows[0] && a.rows[0].value === '0'), total: c.rows[0].n });
  } catch (e) { res.json({ on: true, total: 0 }); }
});
app.post('/api/sip/toggle', async (req, res) => {
  const on = !!(req.body && req.body.on);
  try { await pool.query("INSERT INTO pbxng_settings (key,value) VALUES ('sip_capture_on',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [on ? '1' : '0']); res.json({ ok: true, on }); }
  catch (e) { errorHttp(res, e); }
});
app.post('/api/sip/clear', async (req, res) => {
  try { await pool.query("DELETE FROM pbxng_sip_capture"); res.json({ ok: true }); }
  catch (e) { errorHttp(res, e); }
});
const server = http.createServer(app);
/* Origen del socket: antes `origin: '*'`. El panel llega SIEMPRE por el proxy
 * (dashboard/server.js), sin cabecera Origin cruzada, así que lo normal es que el
 * pedido no traiga Origin o traiga el propio host. Un Origin de otro sitio (una web
 * ajena intentando abrir el socket con un token robado del navegador) se rechaza.
 * CORS_ORIGINS (coma) suma orígenes explícitos, p. ej. el panel en desarrollo. */
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
function origenPermitido(origin, req) {
  if (!origin) return true;                       // sin Origin: proxy, curl, softphone nativo
  const o = String(origin).replace(/\/+$/, '');
  if (CORS_ORIGINS.includes(o)) return true;
  // mismo origen: el host del Origin coincide con el Host con el que nos llamaron
  // (o el que reenvió el proxy). Se compara host:puerto, sin el esquema.
  let host = ''; try { host = new URL(o).host; } catch (_) { return false; }
  const hdr = req && req.headers ? req.headers : {};
  const fwd = String(hdr['x-forwarded-host'] || '').split(',')[0].trim();
  if (!host) return false;
  if (host === hdr.host || host === fwd) return true;
  // Detrás de un proxy en puerto no estándar (https://pbx:8443) el Host que reenvía NPM
  // viene sin puerto: si el Host no trae puerto, alcanza con que coincida el hostname.
  const hn = host.split(':')[0];
  const sinPuerto = (h) => h && !h.includes(':') && h === hn;
  return sinPuerto(hdr.host) || sinPuerto(fwd);
}
const io = new Server(server, {
  cors: { origin: true, credentials: true },     // el filtro real es allowRequest (mira Host y X-Forwarded-Host)
  allowRequest: (req, cb) => {
    if (origenPermitido(req.headers.origin, req)) return cb(null, true);
    logger('SOCKET').warn('origen rechazado', { origin: req.headers.origin, host: req.headers.host });
    cb('origen no permitido', false);
  },
});
let busy = false, deb = null;
async function broadcast() { if (busy) return; busy = true; try { io.to('state').emit('snapshot', await snapshot()); } catch (e) {} finally { busy = false; } }
function broadcastSoon() { clearTimeout(deb); deb = setTimeout(broadcast, 300); }
/* Handshake: auth.token = JWT de panel (estado completo) o auth.scratch = JWT de
 * softphone (scope 'phone', sólo pizarra). Antes `scratch` era un flag cualquiera y
 * entraba sin verificar nada: cualquiera en internet podía sumarse a la pizarra de
 * una videollamada ajena y garabatearla. Un token phone también sirve como auth.token
 * pero queda igual de acotado (scratchOnly): el estado de la central es del panel. */
io.use((socket, next) => {
  const a = (socket.handshake && socket.handshake.auth) || {};
  const verificar = (t) => { try { return t ? jwt.verify(String(t), SECRET) : null; } catch (_) { return null; } };
  const u = verificar(a.token) || verificar(a.scratch);
  if (!u) return next(new Error('unauthorized'));
  socket.user = u;
  socket.scratchOnly = u.scope === 'phone';
  next();
});
io.on('connection', async (s) => {
  if (!s.scratchOnly) { s.join('state'); try { s.emit('snapshot', await snapshot()); } catch (_) {} }
  // Pizarra compartida en videollamada (relay por sala = par de internos)
  s.on('scratch:join', (room) => { if (room) s.join('scratch:' + room); });
  s.on('scratch:leave', (room) => { if (room) s.leave('scratch:' + room); });
  s.on('scratch:op', (m) => { if (m && m.room) s.to('scratch:' + m.room).emit('scratch:op', m.op); });
  s.on('scratch:clear', (m) => { if (m && m.room) s.to('scratch:' + m.room).emit('scratch:clear'); });
  // Registro en vivo de seguridad: sólo panel admin/supervisor (docs/CONTRATOS.md §4).
  s.on('sec:join', () => { if (!s.scratchOnly) guard.unirSocket(s); });
  s.on('sec:leave', () => s.leave('security'));
});
/* Guardia de seguridad (guard.js): eventos de seguridad por AMI (ChallengeResponseFailed,
 * InvalidAccountID, FailedACL…) → contador por IP → ban en
 * nftables vía el agente de Asterisk; rutas /api/security*, /api/ipgeo y sala 'security'. */
const guard = require('./guard')({ app, pool, ami, io, astFwd, escribir: astconf.escribir, alerts, geoLookup, amiCommand, log: logger('guard') });
guard.iniciar().catch((e) => logger('guard').error('arranque', e));
setInterval(broadcast, 15000);   // reconciliado: el refresco real llega por eventos ARI/AMI (broadcastSoon)
ami.on('managerevent', (e) => { const t = e && e.event; if (['Newchannel', 'Hangup', 'Newstate', 'DeviceStateChange', 'ContactStatus', 'QueueMemberStatus', 'QueueCallerJoin', 'QueueCallerLeave', 'PeerStatus'].includes(t)) broadcastSoon(); });
// Push de llamada entrante con dedupe por interno (lo usan el wake del dialplan y AMI)
const incomingPushDedup = new Map();
function notifyIncomingPush(ext, from, name) {
  if (!ext) return;
  const now = Date.now();
  const last = incomingPushDedup.get(ext);
  if (last && now - last < 6000) return;
  incomingPushDedup.set(ext, now);
  if (incomingPushDedup.size > 300) incomingPushDedup.clear();
  sendPushToExt(ext, { type: 'call', title: 'Llamada entrante', from: from || 'desconocido', body: 'Llamada de ' + (name ? name + ' (' + (from || '') + ')' : (from || 'desconocido')), url: '/phone', tag: 'pbxng-call-' + ext });
}

// Disparo de Web Push al sonar un interno (despierta la PWA en background)
const pushDedup = new Map();
ami.on('managerevent', (e) => {
  if (!e || e.event !== 'DialBegin') return;
  const dest = e.destchannel || e.DestChannel || '';
  const m = /PJSIP\/([^-]+)-/.exec(dest);
  if (!m) return;
  const ext = m[1];
  const from = e.calleridnum || e.CallerIDNum || e.connectedlinenum || 'desconocido';
  const name = e.calleridname || e.CallerIDName || '';
  const key = ext + ':' + (e.linkedid || e.Linkedid || dest);
  const now = Date.now();
  if (pushDedup.get(key) && now - pushDedup.get(key) < 8000) return;
  pushDedup.set(key, now);
  if (pushDedup.size > 200) pushDedup.clear();
  notifyIncomingPush(ext, from, name);
});

// Notificación de llamada perdida a las integraciones (Telegram/WhatsApp)
const missedDedup = new Map();
ami.on('managerevent', (e) => {
  if (!e || e.event !== 'DialEnd') return;
  const status = (e.dialstatus || e.DialStatus || '').toUpperCase();
  if (!['NOANSWER', 'BUSY', 'CANCEL', 'CONGESTION'].includes(status)) return;
  const dest = e.destchannel || e.DestChannel || '';
  const m = /PJSIP\/([^-]+)-/.exec(dest); if (!m) return;
  const ext = m[1];
  const from = e.calleridnum || e.CallerIDNum || e.connectedlinenum || 'desconocido';
  const key = ext + ':' + (e.linkedid || e.Linkedid || dest);
  const now = Date.now();
  if (missedDedup.get(key) && now - missedDedup.get(key) < 10000) return;
  missedDedup.set(key, now); if (missedDedup.size > 200) missedDedup.clear();
  const sLabel = status === 'BUSY' ? 'ocupado' : status === 'CANCEL' ? 'cancelada' : 'sin respuesta';
  notifyIntegrations('📞 Llamada perdida al interno <b>' + ext + '</b> desde <b>' + from + '</b> (' + sLabel + ').');
});


// ==================== CRM / Intercom / Encuestas ====================
// Esquema en migrations/0009_schema_runtime.sql; acá sólo los campos de encuesta por defecto.
(async () => {
  try {
    const { rows: sf } = await pool.query('SELECT count(*)::int AS n FROM pbxng_survey_fields');
    if (sf[0].n === 0) {
      await pool.query(`INSERT INTO pbxng_survey_fields (ord,label,ftype,options,required) VALUES
        (1,'Motivo','select','["Consulta","Reclamo","Soporte","Emergencia","Otro"]',true),
        (2,'Resultado','select','["Resuelto","Derivado","Pendiente"]',true),
        (3,'Satisfaccion','rating','[]',false),
        (4,'Requiere seguimiento','bool','[]',false),
        (5,'Nota','text','[]',false)`);
      logger('CRM').info('campos de encuesta por defecto creados');
    }
  } catch (e) { logger('CRM').error('semilla de encuesta', e); }
})();
// Par VAPID usable antes del primer push (ver el bloque Web Push de arriba).
asegurarVapid().catch(e => logger('PUSH').error('asegurarVapid', e));

let CRMGO2RTC = process.env.GO2RTC_URL || '';
const GO2RTC_MGMT = process.env.GO2RTC_MGMT || 'http://pbxng-go2rtc:1984';
async function _g2refresh(){ try{ const q=await pool.query("SELECT value FROM pbxng_settings WHERE key='go2rtc_url'"); if(q.rows[0]&&q.rows[0].value!=null) CRMGO2RTC=q.rows[0].value; }catch(e){} }
_g2refresh(); setInterval(_g2refresh, 30000);
async function syncGo2rtc(){ try{ const q=await pool.query("SELECT go2rtc_src, rtsp_url FROM pbxng_client_devices WHERE enabled AND rtsp_url IS NOT NULL AND rtsp_url<>''"); for(const d of q.rows){ try{ await fetch(GO2RTC_MGMT+'/api/streams?name='+encodeURIComponent(d.go2rtc_src)+'&src='+encodeURIComponent(d.rtsp_url),{method:'PUT'}); }catch(e){} } }catch(e){} }
setTimeout(syncGo2rtc, 10000); setInterval(syncGo2rtc, 60000);
app.get('/api/intercom/config', async (req,res)=>{ try{ const q=await pool.query("SELECT value FROM pbxng_settings WHERE key='go2rtc_url'"); res.json({ go2rtc_url: (q.rows[0]&&q.rows[0].value)||'', mgmt: GO2RTC_MGMT }); }catch(e){ errorHttp(res, e); } });
app.post('/api/intercom/config', async (req,res)=>{ const u=(req.body&&req.body.go2rtc_url)||''; try{ const up=await pool.query("UPDATE pbxng_settings SET value=$1 WHERE key='go2rtc_url'",[u]); if(up.rowCount===0) await pool.query("INSERT INTO pbxng_settings(key,value) VALUES('go2rtc_url',$1)",[u]); CRMGO2RTC=u; syncGo2rtc(); res.json({ok:true}); }catch(e){ errorHttp(res, e); } });
app.post('/api/intercom/sync', async (req,res)=>{ try{ await syncGo2rtc(); res.json({ok:true}); }catch(e){ errorHttp(res, e); } });
function crmNormNum(s){ return String(s||'').replace(/[^0-9]/g,''); }

// Escribir en el CRM (clientes, personas autorizadas, espacios, dispositivos) queda reservado a
// admin y supervisor. Los agentes LEEN la ficha del cliente que los llama —para eso existe el
// screen-pop— pero no deben poder editar ni borrar la libreta desde su softphone.
function crmWrite(req, res, next) {
  if (!['admin', 'supervisor'].includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'solo un administrador o supervisor puede modificar el CRM' });
  }
  next();
}
app.get('/api/clients', async (req,res)=>{ try{
  const { rows } = await pool.query(`SELECT c.*,
    (SELECT count(*)::int FROM pbxng_client_persons p WHERE p.client_id=c.id) AS persons,
    (SELECT count(*)::int FROM pbxng_client_spaces s WHERE s.client_id=c.id) AS spaces,
    (SELECT count(*)::int FROM pbxng_client_devices d WHERE d.client_id=c.id) AS devices,
    (SELECT count(*)::int FROM pbxng_client_devices d WHERE d.client_id=c.id AND d.type='intercom') AS intercoms,
    (SELECT count(*)::int FROM pbxng_client_devices d WHERE d.client_id=c.id AND d.type='camera') AS cameras
    FROM pbxng_clients c ORDER BY c.name`); res.json(rows);
}catch(e){errorHttp(res, e);} });

app.get('/api/clients/lookup', async (req,res)=>{ try{
  const num = crmNormNum(req.query.number);
  if(!num) return res.json({});
  const { rows } = await pool.query(`SELECT * FROM pbxng_clients WHERE EXISTS (
     SELECT 1 FROM unnest(phones) ph WHERE regexp_replace(ph,'[^0-9]','','g') = $1
       OR (length($1)>=8 AND right(regexp_replace(ph,'[^0-9]','','g'), 8) = right($1,8))) LIMIT 1`,[num]);
  if(!rows[0]) return res.json({});
  const c = rows[0];
  c.persons = (await pool.query('SELECT * FROM pbxng_client_persons WHERE client_id=$1 ORDER BY name',[c.id])).rows;
  c.spaces = (await pool.query('SELECT * FROM pbxng_client_spaces WHERE client_id=$1 ORDER BY name',[c.id])).rows;
  c.devices = (await pool.query('SELECT id,label,type,go2rtc_src FROM pbxng_client_devices WHERE client_id=$1 AND enabled ORDER BY label',[c.id])).rows
    .map(d=>({ id:d.id, label:d.label, type:d.type, base:CRMGO2RTC, src:d.go2rtc_src }));
  res.json(c);
}catch(e){errorHttp(res, e);} });

app.get('/api/clients/:id', async (req,res)=>{ try{
  const { rows } = await pool.query('SELECT * FROM pbxng_clients WHERE id=$1',[req.params.id]);
  if(!rows[0]) return res.status(404).json({error:'no existe'});
  const c = rows[0];
  c.persons = (await pool.query('SELECT * FROM pbxng_client_persons WHERE client_id=$1 ORDER BY name',[c.id])).rows;
  c.spaces = (await pool.query('SELECT * FROM pbxng_client_spaces WHERE client_id=$1 ORDER BY name',[c.id])).rows;
  c.devices = (await pool.query('SELECT * FROM pbxng_client_devices WHERE client_id=$1 ORDER BY label',[c.id])).rows;
  res.json(c);
}catch(e){errorHttp(res, e);} });

// --- Ficha del cliente: llamadas, intervenciones y ubicacion -------------------

// Todas las llamadas del cliente: se cruzan sus telefonos contra el CDR (origen o destino).
app.get('/api/clients/:id/calls', async (req,res)=>{ try{
  const { rows:cr } = await pool.query('SELECT phones FROM pbxng_clients WHERE id=$1',[req.params.id]);
  if(!cr[0]) return res.status(404).json({error:'no existe'});
  const phones = (cr[0].phones||[]).map(p=>String(p).replace(/[^0-9]/g,'')).filter(Boolean);
  if(!phones.length) return res.json([]);
  const { rows } = await pool.query(
    `SELECT start, clid, src, dst, duration, billsec, disposition
       FROM cdr
      WHERE regexp_replace(src,'[^0-9]','','g') = ANY($1)
         OR regexp_replace(dst,'[^0-9]','','g') = ANY($1)
      ORDER BY start DESC LIMIT 200`, [phones]);
  res.json(rows);
}catch(e){ errorHttp(res, e); } });

// Intervenciones: la encuesta que completa el agente al cortar (motivo, resultado, notas).
app.get('/api/clients/:id/interventions', async (req,res)=>{ try{
  const { rows } = await pool.query(
    'SELECT id, ext, caller, uniqueid, answers, created_at FROM pbxng_call_surveys WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100',
    [req.params.id]);
  const { rows: fields } = await pool.query('SELECT id,label,ftype,ord FROM pbxng_survey_fields WHERE active ORDER BY ord, id');
  res.json({ items: rows, fields });
}catch(e){ errorHttp(res, e); } });

// Ubicacion: geocodifica la direccion con Nominatim (OSM) y la deja guardada.
app.post('/api/clients/:id/geocode', crmWrite, async (req,res)=>{ try{
  const { rows } = await pool.query('SELECT address FROM pbxng_clients WHERE id=$1',[req.params.id]);
  const addr = rows[0] && rows[0].address;
  if(!addr) return res.status(400).json({error:'el cliente no tiene direccion cargada'});
  const q = encodeURIComponent(addr + (/uruguay/i.test(addr) ? '' : ', Uruguay'));
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + q,
    { headers:{ 'User-Agent':'PBX-NG/1.0 (panel)' }, signal: AbortSignal.timeout(8000) });
  const d = await r.json();
  if(!Array.isArray(d) || !d.length) return res.status(404).json({error:'no se encontro la direccion'});
  const lat = parseFloat(d[0].lat), lon = parseFloat(d[0].lon);
  await pool.query('UPDATE pbxng_clients SET lat=$2, lon=$3 WHERE id=$1',[req.params.id, lat, lon]);
  res.json({ lat, lon, display: d[0].display_name });
}catch(e){ errorHttp(res, e); } });

app.post('/api/clients', crmWrite, async (req,res)=>{ const b=req.body||{}; try{
  const phones = Array.isArray(b.phones)? b.phones : (b.phones? String(b.phones).split(',').map(x=>x.trim()).filter(Boolean):[]);
  const { rows } = await pool.query('INSERT INTO pbxng_clients (name,doc,address,notes,phones) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [b.name, b.doc||null, b.address||null, b.notes||null, phones]);
  res.status(201).json(rows[0]);
}catch(e){errorHttp(res, e);} });

app.put('/api/clients/:id', crmWrite, async (req,res)=>{ const b=req.body||{}; try{
  const phones = Array.isArray(b.phones)? b.phones : (b.phones!==undefined && b.phones!==null ? String(b.phones).split(',').map(x=>x.trim()).filter(Boolean): null);
  const { rows } = await pool.query(`UPDATE pbxng_clients SET name=COALESCE($2,name), doc=$3, address=$4, notes=$5,
    phones=COALESCE($6,phones), updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.name||null, b.doc||null, b.address||null, b.notes||null, phones]);
  res.json(rows[0]||{});
}catch(e){errorHttp(res, e);} });

app.delete('/api/clients/:id', crmWrite, async (req,res)=>{ try{ await pool.query('DELETE FROM pbxng_clients WHERE id=$1',[req.params.id]); res.json({ok:true}); }catch(e){errorHttp(res, e);} });

app.post('/api/clients/:id/persons', crmWrite, async (req,res)=>{ const b=req.body||{}; try{
  const { rows } = await pool.query('INSERT INTO pbxng_client_persons (client_id,name,doc,relation,valid_until,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.params.id,b.name,b.doc||null,b.relation||null,b.valid_until||null,b.notes||null]); res.status(201).json(rows[0]);
}catch(e){errorHttp(res, e);} });
app.delete('/api/persons/:pid', crmWrite, async (req,res)=>{ try{ await pool.query('DELETE FROM pbxng_client_persons WHERE id=$1',[req.params.pid]); res.json({ok:true}); }catch(e){errorHttp(res, e);} });

app.post('/api/clients/:id/spaces', crmWrite, async (req,res)=>{ const b=req.body||{}; try{
  const { rows } = await pool.query('INSERT INTO pbxng_client_spaces (client_id,name,kind,notes) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.params.id,b.name,b.kind||null,b.notes||null]); res.status(201).json(rows[0]);
}catch(e){errorHttp(res, e);} });
app.delete('/api/spaces/:sid', crmWrite, async (req,res)=>{ try{ await pool.query('DELETE FROM pbxng_client_spaces WHERE id=$1',[req.params.sid]); res.json({ok:true}); }catch(e){errorHttp(res, e);} });

app.post('/api/clients/:id/devices', crmWrite, async (req,res)=>{ const b=req.body||{}; try{
  const src = b.go2rtc_src || ('cli'+req.params.id+'_'+Date.now().toString(36));
  const { rows } = await pool.query('INSERT INTO pbxng_client_devices (client_id,label,type,rtsp_url,go2rtc_src,enabled) VALUES ($1,$2,$3,$4,$5,COALESCE($6,true)) RETURNING *',
    [req.params.id,b.label,b.type||'camera',b.rtsp_url||null,src,b.enabled]); res.status(201).json(rows[0]);
}catch(e){errorHttp(res, e);} });
app.delete('/api/devices/:did', crmWrite, async (req,res)=>{ try{ await pool.query('DELETE FROM pbxng_client_devices WHERE id=$1',[req.params.did]); res.json({ok:true}); }catch(e){errorHttp(res, e);} });

app.get('/api/intercom/clients', async (req,res)=>{ try{
  const { rows } = await pool.query(`SELECT DISTINCT c.id, c.name FROM pbxng_clients c JOIN pbxng_client_devices d ON d.client_id=c.id WHERE d.enabled ORDER BY c.name`); res.json(rows);
}catch(e){errorHttp(res, e);} });
app.get('/api/intercom/streams', async (req,res)=>{ try{
  const cid = req.query.client;
  const { rows } = await pool.query('SELECT id,label,type,go2rtc_src FROM pbxng_client_devices WHERE client_id=$1 AND enabled ORDER BY label',[cid]);
  res.json(rows.map(d=>({ id:d.id, label:d.label, type:d.type, base:CRMGO2RTC, src:d.go2rtc_src })));
}catch(e){errorHttp(res, e);} });

app.get('/api/survey/fields', async (req,res)=>{ try{ const { rows } = await pool.query('SELECT * FROM pbxng_survey_fields WHERE active ORDER BY ord, id'); res.json(rows); }catch(e){errorHttp(res, e);} });
app.put('/api/survey/fields', crmWrite, async (req,res)=>{ const arr=Array.isArray(req.body)?req.body:((req.body&&req.body.fields)||[]); try{
  await pool.query('UPDATE pbxng_survey_fields SET active=false');
  for(let i=0;i<arr.length;i++){ const f=arr[i];
    if(f.id){ await pool.query('UPDATE pbxng_survey_fields SET ord=$2,label=$3,ftype=$4,options=$5,required=$6,active=true WHERE id=$1',[f.id,i,f.label,f.ftype||'text',JSON.stringify(f.options||[]),!!f.required]); }
    else { await pool.query('INSERT INTO pbxng_survey_fields (ord,label,ftype,options,required,active) VALUES ($1,$2,$3,$4,$5,true)',[i,f.label,f.ftype||'text',JSON.stringify(f.options||[]),!!f.required]); }
  }
  res.json({ok:true});
}catch(e){errorHttp(res, e);} });
app.post('/api/survey', async (req,res)=>{ const b=req.body||{}; try{
  await pool.query('INSERT INTO pbxng_call_surveys (ext,client_id,caller,uniqueid,answers) VALUES ($1,$2,$3,$4,$5)',
    [b.ext||null,b.client_id||null,b.caller||null,b.uniqueid||null,JSON.stringify(b.answers||{})]); res.status(201).json({ok:true});
}catch(e){errorHttp(res, e);} });
app.get('/api/survey', async (req,res)=>{ try{ const { rows } = await pool.query('SELECT * FROM pbxng_call_surveys ORDER BY created_at DESC LIMIT 200'); res.json(rows); }catch(e){errorHttp(res, e);} });
// ==================== fin CRM ====================

/* ── Cierre de la cadena de Express: 404 JSON de /api y manejador de errores final ──
 * Van al final a propósito: Express resuelve en orden de registro y estos dos tienen
 * que quedar detrás de TODAS las rutas (incluidas las que registran los módulos). */
app.use('/api', (req, res) => res.status(404).json({ error: 'ruta inexistente' }));
app.use(require('./errores').middlewareFinal);

/* ── Cierre ordenado (SIGTERM de compose / SIGINT en consola) ─────────────────────
 * Sin esto, `docker stop` mataba el proceso con lo que hubiera a medias: consultas
 * en vuelo, supervisiones (snoop) colgadas en Asterisk, sesiones de IA con el
 * AudioSocket abierto. Orden: dejar de aceptar → avisar a los sockets → cortar
 * espías → ARI/AMI → AudioSocket → esperar la DB (hasta 10 s) → salir 0.
 * Si algo se traba, a los 15 s se sale con 1: mejor un reinicio sucio que un
 * contenedor que no termina nunca. */
let cerrando = false;
async function cerrarOrdenado(senal) {
  if (cerrando) return;
  cerrando = true;
  const t0 = Date.now();
  const paso = (m, extra) => log.info('cierre: ' + m, Object.assign({ ms: Date.now() - t0 }, extra || {}));
  const duro = setTimeout(() => { log.error('cierre: no terminó en 15 s, salida forzada'); process.exit(1); }, 15000);
  duro.unref();
  paso('señal ' + senal + ', dejo de aceptar conexiones');
  try { server.close(() => paso('servidor HTTP cerrado')); } catch (e) { log.warn('cierre: server.close', e); }
  try { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); } catch (_) {}
  try { io.close(); paso('socket.io cerrado'); } catch (e) { log.warn('cierre: socket.io', e); }
  try {
    const ids = Array.from(callEngine.spies.keys());
    for (const id of ids) await callEngine.stopSpy(id).catch(() => {});
    paso('supervisiones cortadas', { spies: ids.length });
  } catch (e) { log.warn('cierre: supervisiones', e); }
  try { if (ari) { const c = ari; ari = null; state.ari = false; callEngine.detach(); await Promise.resolve(c.stop && c.stop()).catch(() => {}); } paso('ARI cerrado'); } catch (e) { log.warn('cierre: ARI', e); }
  try { ami.disconnect && ami.disconnect(); paso('AMI cerrado'); } catch (e) { log.warn('cierre: AMI', e); }
  try { await Promise.race([aiPipeline.close(), new Promise((ok) => setTimeout(ok, 2000))]); paso('AudioSocket cerrado'); } catch (e) { log.warn('cierre: AudioSocket', e); }
  try {
    await Promise.race([pool.end(), new Promise((_, rej) => setTimeout(() => rej(new Error('la DB no soltó las consultas en 10 s')), 10000))]);
    paso('pool de PostgreSQL cerrado');
  } catch (e) { log.warn('cierre: pool', e); }
  paso('listo, salgo con 0');
  clearTimeout(duro);
  process.exit(0);
}
process.on('SIGTERM', () => cerrarOrdenado('SIGTERM'));
process.on('SIGINT', () => cerrarOrdenado('SIGINT'));
/* Una promesa rechazada sin catch tumbaría el proceso entero (Node ≥15) por un error
 * de un módulo secundario. Se loguea con stack y se sigue; las excepciones sincrónicas
 * sin atrapar sí terminan el proceso (el estado ya no es confiable), pero logueadas. */
process.on('unhandledRejection', (e) => log.error('promesa rechazada sin catch', e));
process.on('uncaughtException', (e) => { log.error('excepción no atrapada, salgo con 1', e); setTimeout(() => process.exit(1), 200); });

server.listen(CFG.port, '0.0.0.0', () => log.info('PBX-NG (socket.io) escuchando', { port: +CFG.port }));
