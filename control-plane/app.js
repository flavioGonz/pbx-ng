'use strict';
/* PBX-NG - Control Plane API (Socket.io). Internos, troncales, IVR, colas,
   conferencias, ring groups, paging, buzones, CDR, dialplan, canales, sistema, WebRTC. */
const http = require('http');
const os = require('os');
const fsx = require('fs');
const express = require('express');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const AriClient = require('ari-client');
const aiPipeline = require('./ai-pipeline');
const AsteriskManager = require('asterisk-manager');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const pushProviders = require('./push-providers');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const SECRET = process.env.JWT_SECRET || '__SET_JWT_SECRET__';

// ---------------- Web Push (VAPID) ----------------
const VAPID = {
  pub: process.env.VAPID_PUBLIC || 'BBtIRLI74nPUZiMAgghpMSb7iraI89_sH_PhpEOIz5gZDmEtiIFzXuZNFKNhkkl3-wOX3mx9k59NgCWijYleNXA',
  priv: process.env.VAPID_PRIVATE || '__SET_VAPID_PRIVATE__',
  subject: process.env.VAPID_SUBJECT || 'mailto:soporte@ies.com.uy',
};
try { webpush.setVapidDetails(VAPID.subject, VAPID.pub, VAPID.priv); } catch (e) { console.error('[PUSH] VAPID', e.message); }

async function sendPushToExt(ext, payload) {
  if (!ext) return 0;
  let sent = 0;
  try {
    const { rows } = await pool.query('SELECT endpoint, p256dh, auth FROM pbxng_push_subs WHERE ext=$1', [String(ext)]);
    for (const s of rows) {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try { await webpush.sendNotification(sub, JSON.stringify(payload)); sent++; }
      catch (err) { if (err.statusCode === 404 || err.statusCode === 410) await pool.query('DELETE FROM pbxng_push_subs WHERE endpoint=$1', [s.endpoint]); }
    }
  } catch (e) { console.error('[PUSH] send', e.message); }
  try { sent += await pushProviders.sendNative(ext, payload); } catch (_) {}
  return sent;
}

async function createWebrtcEndpoint(c, id, password, context = 'internal', tenant_id = 1, video = false, max_contacts = 2) {
  const allow = video ? 'ulaw,alaw,g722,vp8,h264' : 'ulaw,alaw,g722';
  await c.query("INSERT INTO ps_aors (id,max_contacts,remove_existing,qualify_frequency,tenant_id) VALUES ($1,$2,'yes',60,$3) ON CONFLICT (id) DO UPDATE SET max_contacts=EXCLUDED.max_contacts", [id, max_contacts, tenant_id]);
  await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$1,$2,$3) ON CONFLICT (id) DO UPDATE SET password=EXCLUDED.password", [id, password, tenant_id]);
  await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,webrtc,dtls_auto_generate_cert,ice_support,use_avpf,media_encryption,media_use_received_transport,rtcp_mux,direct_media,rtp_symmetric,force_rport,rewrite_contact) VALUES ($1,'transport-ws',$1,$1,$2,'all',$3,$4,'extension','yes','yes','yes','yes','dtls','yes','yes','no','yes','yes','yes') ON CONFLICT (id) DO UPDATE SET transport='transport-ws',allow=EXCLUDED.allow,webrtc='yes'", [id, context, allow, tenant_id]);
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
  db: { host: process.env.DB_HOST || '172.26.20.184', port: +(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'pbxng', user: process.env.DB_USER || 'pbxng', password: process.env.DB_PASS || '__SET_DB_PASS__' },
  ari: { url: process.env.ARI_URL || 'http://172.26.20.183:8088', user: process.env.ARI_USER || 'pbxng', pass: process.env.ARI_PASS || '__SET_ARI_PASS__', app: process.env.ARI_APP || 'pbxng' },
  ami: { host: process.env.AMI_HOST || '172.26.20.183', port: +(process.env.AMI_PORT || 5038), user: process.env.AMI_USER || 'pbxng-ami', pass: process.env.AMI_PASS || '__SET_AMI_PASS__' },
};
const pool = new Pool(CFG.db);
const app = express();
app.use(express.json());
const state = { ari: false, ami: false };
let ari = null;
(async () => { try { ari = await AriClient.connect(CFG.ari.url, CFG.ari.user, CFG.ari.pass); await ari.start(CFG.ari.app); state.ari = true; console.log('[ARI] ok'); try { aiPipeline.init(ari, pool, { app: CFG.ari.app, mediaHost: '172.26.20.185' }); } catch (e) { console.error('[AI] init', e.message); } } catch (e) { console.error('[ARI]', e.message); } })();
const pendingConf = {};
(function wireStasis() {
  const tryWire = () => {
    if (!ari) return setTimeout(tryWire, 1000);
    ari.on('StasisStart', async (event, channel) => {
      const args = event.args || [];
      if (args[0] === 'ai') { handleAiAgent(channel, args[1]); return; }
      const bid = pendingConf[channel.id];
      if (!bid) return;
      delete pendingConf[channel.id];
      try { await channel.answer(); } catch (_) {}
      try { await ari.bridges.addChannel({ bridgeId: bid, channel: channel.id }); } catch (e) { console.error('[CONF] add', e.message); }
    });
  };
  tryWire();
})();
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
  console.log('[AI-IVR] llamada -> agente', agent.name, '| provider', agent.provider + '/' + agent.model);
  return aiPipeline.startAiSession(channel, agent);
}

const ami = new AsteriskManager(CFG.ami.port, CFG.ami.host, CFG.ami.user, CFG.ami.pass, true);
ami.keepConnected();
ami.on('connect', () => { state.ami = true; });
ami.on('disconnect', () => { state.ami = false; });
ami.on('error', (e) => console.error('[AMI]', e && e.message));

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
async function endpointStates() {
  const map = {};
  if (!ari) return map;
  try { const eps = await ari.endpoints.list(); for (const e of eps) map[e.resource] = { state: e.state, channels: (e.channel_ids || []).length }; } catch (_) {}
  return map;
}
// Estado real de troncales: registro saliente (pjsip show registrations) + alcanzabilidad
async function trunkStatuses(trunks) {
  let reg = '';
  try { reg = await amiCommand('pjsip show registrations'); } catch (_) {}
  const eps = await endpointStates();
  const lines = String(reg).split('\n');
  const out = {};
  const rttMap = {};
  try { const co = await amiCommand('pjsip show contacts'); for (const line of String(co).split('\n')) { if (!line.includes('Contact:') || !line.includes('sip:')) continue; const aorM = /Contact:\s*([^/]+)\//.exec(line); const toks = line.trim().split(/\s+/); const last = toks[toks.length - 1]; const rtt = /^[0-9.]+$/.test(last) ? parseFloat(last) : null; if (aorM) rttMap[aorM[1].trim()] = rtt; } } catch (_) {}
  for (const t of trunks) {
    if (t.kind === 'kamailio') { out[t.name] = { status: 'sbc', detail: 'Gestionada por el SBC' }; continue; }
    const ep = eps[t.name]; const reachable = ep && ep.state === 'online';
    if (t.do_register) {
      const rx = new RegExp('^\\s*' + t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/');
      const line = lines.find(l => rx.test(l)) || '';
      if (/Registered/i.test(line)) out[t.name] = { status: 'online', detail: 'Registrada' + ((line.match(/exp\.?\s*(\d+)/i) || [])[1] ? ' (exp ' + line.match(/exp\.?\s*(\d+)/i)[1] + 's)' : '') };
      else if (/Rejected/i.test(line)) out[t.name] = { status: 'offline', detail: 'Rechazada por el proveedor' };
      else if (/Auth/i.test(line)) out[t.name] = { status: 'offline', detail: 'Autenticando…' };
      else if (line) out[t.name] = { status: 'offline', detail: 'Sin registrar' };
      else out[t.name] = { status: reachable ? 'online' : 'offline', detail: reachable ? 'Alcanzable' : 'Sin registro' };
    } else {
      out[t.name] = { status: reachable ? 'online' : 'offline', detail: reachable ? 'Alcanzable (qualify)' : 'No responde' };
    }
  }
  for (const t of trunks) { if (out[t.name] && rttMap[t.name] != null) out[t.name].rtt = rttMap[t.name]; }
  return out;
}
async function setRecFlag(ext, on) { try { await amiAction(on ? { Action: 'DBPut', Family: 'rec', Key: String(ext), Val: '1' } : { Action: 'DBDel', Family: 'rec', Key: String(ext) }); } catch (_) {} }
async function setRecAll(on) { try { await amiAction(on ? { Action: 'DBPut', Family: 'rec', Key: '_ALL_', Val: '1' } : { Action: 'DBDel', Family: 'rec', Key: '_ALL_' }); } catch (_) {} }
async function syncRecFlags() { try { const { rows } = await pool.query("SELECT id FROM ps_endpoints WHERE pbxng_record=true"); for (const r of rows) await setRecFlag(r.id, true); const { rows: s } = await pool.query("SELECT value FROM pbxng_settings WHERE key='record_all'"); await setRecAll(!!(s[0] && s[0].value === '1')); } catch (_) {} }
setTimeout(() => { syncRecFlags().catch(() => {}); }, 9000);

async function getExtensions() {
  const { rows } = await pool.query("SELECT id, context, allow, tenant_id, transport, pbxng_record FROM ps_endpoints WHERE COALESCE(pbxng_kind,'extension')='extension' ORDER BY id");
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
    const SBC = '172.26.20.205', NPM = '172.26.20.17';
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
  return rows.map(r => ({ id: r.id, name: names[r.id] || null, context: r.context, allow: r.allow, tenant_id: r.tenant_id, status: st[r.id] ? st[r.id].state : 'offline', channels: st[r.id] ? st[r.id].channels : 0, ip: contacts[r.id] ? contacts[r.id].ip : null, rtt: contacts[r.id] ? contacts[r.id].rtt : null, via: (viaMap[r.id]||{}).via || null, origin: (viaMap[r.id]||{}).origin || null, vproto: (viaMap[r.id]||{}).proto || null, video: /vp8|h264/i.test(r.allow || ''), webrtc: r.transport === 'transport-ws', record: r.pbxng_record === true || r.pbxng_record === 'yes' || r.pbxng_record === 't' }));
}
async function getChannels() {
  if (!ari) return [];
  try { const ch = await ari.channels.list(); return ch.map(c => ({ id: c.id, name: c.name, state: c.state, caller: c.caller && c.caller.number, connected: c.connected && c.connected.number, started: c.creationtime || null })); } catch (_) { return []; }
}
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

app.get('/health', async (req, res) => { let db = false; try { await pool.query('SELECT 1'); db = true; } catch (_) {} res.json({ status: 'ok', db, ari: state.ari, ami: state.ami, ts: new Date().toISOString() }); });

// ---------------- Autenticación ----------------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'no autenticado' });
  try { req.user = jwt.verify(t, SECRET); next(); } catch (e) { res.status(401).json({ error: 'sesión inválida' }); }
}
// --- Gate de autenticacion deny-by-default: TODA /api requiere JWT salvo la allowlist publica explicita ---
const PUBLIC_API = [
  ['POST', /^\/api\/auth\/login$/],
  ['GET',  /^\/api\/branding$/],
  ['GET',  /^\/api\/enroll\/[^/]+$/],
  ['GET',  /^\/api\/recordings\/[^/]+\/(audio|peaks|transcript)$/],
  ['POST', /^\/api\/recordings\/[^/]+\/transcribe$/],
  ['GET',  /^\/api\/prompts\/[^/]+\/audio$/],
  ['GET',  /^\/api\/push\/vapid$/],
  ['POST', /^\/api\/push\/(subscribe|register|unsubscribe)$/],
  ['POST', /^\/api\/calls\/(record|conference)$/],
  ['GET',  /^\/api\/directory$/],
  ['GET',  /^\/api\/presence$/],
  ['GET',  /^\/api\/internal\/wake$/],
  ['GET',  /^\/api\/c2c\/public\/[^/]+$/],
  ['POST', /^\/api\/c2c\/public\/[^/]+\/session$/],
  ['POST', /^\/api\/geo\/report$/],
  ['GET',  /^\/api\/vm$/],
  ['GET',  /^\/api\/vm\/audio$/],
  ['POST', /^\/api\/vm\/(del|read)$/],
];
function isPublicApi(req) { const full = (req.baseUrl || '') + req.path; return PUBLIC_API.some(([m, re]) => m === req.method && re.test(full)); }
app.use('/api', (req, res, next) => isPublicApi(req) ? next() : auth(req, res, next));

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const { rows } = await pool.query('SELECT id,username,name,role,password_hash FROM pbxng_users WHERE username=$1', [username]);
    const u = rows[0];
    if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const token = jwt.sign({ uid: u.id, username: u.username, role: u.role, name: u.name }, SECRET, { expiresIn: '12h' });
    res.json({ token, user: { username: u.username, name: u.name, role: u.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: { username: req.user.username, name: req.user.name, role: req.user.role } }));

// ---------------- Web Push (rutas publicas: la PWA usa credenciales SIP, no JWT) ----------------
pool.query(`CREATE TABLE IF NOT EXISTS pbxng_push_subs (
  id serial PRIMARY KEY, ext text NOT NULL, endpoint text UNIQUE NOT NULL,
  p256dh text NOT NULL, auth text NOT NULL, ua text, created_at timestamptz DEFAULT now())`).catch(e => console.error('[PUSH] table', e.message));
try { pushProviders.init(pool); } catch (e) { console.error('[PUSH] init', e.message); }

pool.query("CREATE TABLE IF NOT EXISTS pbxng_enroll (token text PRIMARY KEY, ext text, password text, label text, created_at timestamptz DEFAULT now(), expires_at timestamptz, used_at timestamptz)").catch(e => console.error('[ENROLL] table', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_fail2ban (jail text PRIMARY KEY, banned jsonb DEFAULT '[]', total_failed int DEFAULT 0, total_banned int DEFAULT 0, updated_at timestamptz DEFAULT now())").catch(e => console.error('[F2B] table', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_fail2ban_cmd (id serial PRIMARY KEY, cmd text, ip text, jail text, created_at timestamptz DEFAULT now(), done_at timestamptz)").catch(e => console.error('[F2B] cmd', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_recordings (id serial PRIMARY KEY, filename text UNIQUE NOT NULL, ext text, src text, dst text, started_at timestamptz, bytes bigint DEFAULT 0, duration int DEFAULT 0, storage text DEFAULT 'local', remote_url text, linkedid text, deleted boolean DEFAULT false, created_at timestamptz DEFAULT now())").catch(e => console.error('[REC] table', e.message));
pool.query("ALTER TABLE pbxng_recordings ADD COLUMN IF NOT EXISTS transcript text").catch(()=>{});
pool.query("ALTER TABLE pbxng_recordings ADD COLUMN IF NOT EXISTS analysis jsonb").catch(()=>{});
pool.query("ALTER TABLE pbxng_recordings ADD COLUMN IF NOT EXISTS transcribed_at timestamptz").catch(()=>{});
pool.query("ALTER TABLE pbxng_recordings ADD COLUMN IF NOT EXISTS peaks jsonb").catch(()=>{});
pool.query("CREATE TABLE IF NOT EXISTS pbxng_prompts (id serial PRIMARY KEY, name text UNIQUE NOT NULL, format text DEFAULT 'wav', bytes int DEFAULT 0, data bytea, deleted boolean DEFAULT false, updated_at timestamptz DEFAULT now(), synced_at timestamptz)").catch(e => console.error('[PROMPT] table', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_email_config (tenant_id int PRIMARY KEY, host text, port int DEFAULT 587, secure boolean DEFAULT false, username text, password text, from_addr text, enabled boolean DEFAULT false, updated_at timestamptz DEFAULT now())").catch(e => console.error('[MAIL] table', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_integrations (type text PRIMARY KEY, enabled boolean DEFAULT false, config jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now())").catch(e => console.error('[INT] table', e.message));
  pool.query("CREATE TABLE IF NOT EXISTS pbxng_ai_agents (id serial PRIMARY KEY, name text, exten text, greeting text DEFAULT 'demo-congrats', system_prompt text DEFAULT '', voice text DEFAULT 'es-ES', provider text DEFAULT 'openai', model text DEFAULT 'gpt-4o-mini', enabled boolean DEFAULT true, created_at timestamptz DEFAULT now())").catch(e => console.error('[AI] table', e.message));
  pool.query("ALTER TABLE pbxng_ivr ADD COLUMN IF NOT EXISTS flow jsonb").catch(e => console.error('[IVR] flow col', e.message));
pool.query("ALTER TABLE pbxng_trunks ADD COLUMN IF NOT EXISTS kind text DEFAULT 'asterisk'").catch(e => console.error('[TRK] kind', e.message));
  pool.query("ALTER TABLE pbxng_trunks ADD COLUMN IF NOT EXISTS kam_config jsonb").catch(e => console.error('[TRK] kamcfg', e.message));
  pool.query("CREATE TABLE IF NOT EXISTS pbxng_outbound_routes (id serial PRIMARY KEY, name text, pattern text, trunk text, strip int DEFAULT 0, prepend text, callerid text, created_at timestamptz DEFAULT now())").catch(e => console.error('[ROUT] out', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_ivr_audios (id serial PRIMARY KEY, name text UNIQUE, text text, voice text, ref text, created_at timestamptz DEFAULT now())").catch(e => console.error('[IVRA] table', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_inbound_routes (id serial PRIMARY KEY, did text, name text, dest_type text, dest_value text, created_at timestamptz DEFAULT now())").catch(e => console.error('[ROUT] in', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_directory (ext text PRIMARY KEY, name text, updated_at timestamptz DEFAULT now())").catch(e => console.error('[DIR] table', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_rec_config (id int PRIMARY KEY DEFAULT 1, backend text DEFAULT 'local', nas_path text, s3_endpoint text, s3_region text, s3_bucket text, s3_key text, s3_secret text, s3_prefix text DEFAULT 'recordings/', auto_upload boolean DEFAULT false, retain_local boolean DEFAULT true, updated_at timestamptz DEFAULT now())").then(() => pool.query("INSERT INTO pbxng_rec_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING")).catch(e => console.error('[REC] cfg', e.message));

// Enrollment: canje publico del token (la PWA lo usa sin JWT)
app.get('/api/enroll/:token', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT token,ext,password,expires_at FROM pbxng_enroll WHERE token=$1', [req.params.token]);
    const e = rows[0];
    if (!e) return res.status(404).json({ error: 'token invalido' });
    if (e.expires_at && new Date(e.expires_at) < new Date()) return res.status(410).json({ error: 'token expirado' });
    await pool.query('UPDATE pbxng_enroll SET used_at=COALESCE(used_at, now()) WHERE token=$1', [req.params.token]);
    res.json({ ext: e.ext, password: e.password, server: 'pbx.ies.com.uy' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recordings/:id/audio', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT filename FROM pbxng_recordings WHERE id=$1 AND deleted=false', [req.params.id]);
    if (!rows[0]) return res.status(404).end();
    const r = await fetch('http://172.26.20.183:8089/' + encodeURIComponent(rows[0].filename));
    if (!r.ok) return res.status(502).end();
    res.set('Content-Type', 'audio/wav');
    res.set('Content-Disposition', 'inline; filename="' + rows[0].filename + '"');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) { res.status(500).end(); }
});

// ---------- Transcripcion + analisis de grabaciones ----------
function wavToPcm(buf) {
  if (buf.length < 44 || buf.slice(0, 4).toString() !== 'RIFF') return null;
  let pos = 12, rate = 8000, ch = 1, bits = 16, dataOff = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const cid = buf.slice(pos, pos + 4).toString('latin1'); const sz = buf.readUInt32LE(pos + 4);
    if (cid === 'fmt ') { ch = buf.readUInt16LE(pos + 10); rate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
    else if (cid === 'data') { dataOff = pos + 8; dataLen = Math.min(sz, buf.length - pos - 8); break; }
    pos += 8 + sz + (sz & 1);
  }
  if (dataOff < 0 || bits !== 16) return null;
  let pcm = buf.slice(dataOff, dataOff + dataLen);
  if (ch === 2) {
    const n = Math.floor(pcm.length / 4); const mono = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) { const l = pcm.readInt16LE(i * 4), rr = pcm.readInt16LE(i * 4 + 2); mono.writeInt16LE(Math.max(-32768, Math.min(32767, (l + rr) >> 1)), i * 2); }
    pcm = mono;
  }
  return { pcm, rate };
}
const STOP_ES = new Set('de la que el en y a los las un una por con no se su para es al lo como mas pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tu te ti tu tus ellas nosotras vosostros vosostras os mio mia mios mias tuyo tuya suyo suya nuestro nuestra vuestro vuestra esos esas estoy esta soy son fue ser hola si claro bueno ok dale gracias buenas buenos dias tardes noches'.split(' '));
const NEG_W = ['molesto','enojado','enojada','reclamo','queja','quejar','cancelar','cancelacion','pesimo','pesima','horrible','terrible','inaceptable','gerente','supervisor','demanda','furioso','indignado','estafa','robo','mentira','nunca','jamas','harto','cansado','problema','problemas','mal','mala','peor','no funciona','no sirve','desastre','verguenza','urgente','grosero'];
const POS_W = ['gracias','excelente','perfecto','genial','resuelto','solucionado','amable','satisfecho','contento','contenta','buenisimo','barbaro','joya','agradezco','felicito','rapido','eficiente'];
function analyzeText(text, durSec) {
  const t = (text || '').toLowerCase();
  const words = t.replace(/[^a-zaeiouunu0-9\s]/gi, ' ').split(/\s+/).filter(Boolean);
  let neg = 0, pos = 0; const flags = [];
  for (const w of NEG_W) { if (t.includes(w)) { neg++; flags.push(w); } }
  for (const w of POS_W) { if (t.includes(w)) pos++; }
  let sentiment = 'neutral';
  if (neg >= 2 && neg > pos) sentiment = 'negativo';
  else if (neg > pos) sentiment = 'tension';
  else if (pos >= 2 && pos > neg) sentiment = 'positivo';
  const conflict = neg >= 2;
  const freq = {};
  for (const w of words) { if (w.length > 3 && !STOP_ES.has(w) && !/^[0-9]+$/.test(w)) freq[w] = (freq[w] || 0) + 1; }
  const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  const wc = words.length;
  const wpm = durSec ? Math.round(wc / (durSec / 60)) : 0;
  const summary = (text || '').trim().slice(0, 220) + ((text || '').length > 220 ? '…' : '');
  return { sentiment, conflict, neg, pos, flags: [...new Set(flags)].slice(0, 10), keywords, words: wc, wpm, summary };
}
async function doTranscribe(id) {
  const { rows } = await pool.query('SELECT filename, duration FROM pbxng_recordings WHERE id=$1 AND deleted=false', [id]);
  if (!rows[0]) throw new Error('grabacion no existe');
  const r = await fetch('http://172.26.20.183:8089/' + encodeURIComponent(rows[0].filename));
  if (!r.ok) throw new Error('audio no disponible');
  const wav = Buffer.from(await r.arrayBuffer());
  const pc = wavToPcm(wav);
  if (!pc) throw new Error('formato WAV no soportado (se requiere PCM 16-bit)');
  const base = await vozBase();
  const sr = await fetch(base + '/stt?rate=' + pc.rate, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pc.pcm, signal: AbortSignal.timeout(180000) });
  if (!sr.ok) throw new Error('STT fallo (' + sr.status + ')');
  const sd = await sr.json();
  const text = (sd.text || '').trim();
  const analysis = analyzeText(text, rows[0].duration || 0);
  await pool.query('UPDATE pbxng_recordings SET transcript=$1, analysis=$2, transcribed_at=now() WHERE id=$3', [text, JSON.stringify(analysis), id]);
  return { transcript: text, analysis };
}
app.get('/api/recordings/:id/transcript', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT transcript, analysis, extract(epoch from transcribed_at)*1000 AS at FROM pbxng_recordings WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'no existe' });
    res.json({ transcript: rows[0].transcript || null, analysis: rows[0].analysis || null, at: rows[0].at || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/recordings/:id/transcribe', async (req, res) => {
  try { const out = await doTranscribe(req.params.id); res.json(out); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
function pcmPeaks(pcm, bars) {
  bars = bars || 40; const n = Math.floor(pcm.length / 2); const per = Math.max(1, Math.floor(n / bars)); const out = []; let max = 1, rawmax = 0;
  for (let b = 0; b < bars; b++) { let sum = 0, cnt = 0; for (let i = b * per; i < (b + 1) * per && i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; cnt++; if (Math.abs(v) > rawmax) rawmax = Math.abs(v); } const rms = cnt ? Math.sqrt(sum / cnt) : 0; out.push(rms); if (rms > max) max = rms; }
  return { peaks: out.map((v) => Math.round((v / max) * 100)), silent: rawmax < 180 };
}
app.get('/api/recordings/:id/peaks', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT filename, peaks FROM pbxng_recordings WHERE id=$1 AND deleted=false', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'no existe' });
    if (rows[0].peaks) return res.json(rows[0].peaks);
    const r = await fetch('http://172.26.20.183:8089/' + encodeURIComponent(rows[0].filename));
    if (!r.ok) return res.json({ peaks: [], silent: true });
    const pc = wavToPcm(Buffer.from(await r.arrayBuffer()));
    if (!pc) return res.json({ peaks: [], silent: true });
    const out = pcmPeaks(pc.pcm, 40);
    await pool.query('UPDATE pbxng_recordings SET peaks=$1 WHERE id=$2', [JSON.stringify(out), req.params.id]);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/push/register', async (req, res) => {
  const { ext, provider, prid, param, topic, ua } = req.body || {};
  if (!ext || !provider || !prid) return res.status(400).json({ error: 'ext, provider y prid (token) requeridos' });
  if (!['fcm', 'apns'].includes(provider)) return res.status(400).json({ error: 'provider debe ser fcm o apns (webpush usa /subscribe)' });
  try { await pushProviders.registerDevice(ext, provider, prid, param, topic, ua); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/push/unsubscribe', async (req, res) => {
  try { await pool.query('DELETE FROM pbxng_push_subs WHERE endpoint=$1', [req.body?.endpoint]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/push/test', auth, async (req, res) => {
  const ext = req.body?.ext;
  const sent = await sendPushToExt(ext, { type: 'info', title: 'PBX-NG', body: 'Notificaciones activadas para el interno ' + ext, url: '/phone' });
  res.json({ ok: true, sent });
});

// Control de llamada en vivo: grabacion (MixMonitor) - publica para la PWA
app.post('/api/calls/record', async (req, res) => {
  const { ext, action } = req.body || {};
  if (!ext) return res.status(400).json({ error: 'ext requerido' });
  try {
    let name = null;
    if (ari) { const chans = await ari.channels.list(); const ch = chans.find(c => c.name && c.name.startsWith('PJSIP/' + ext + '-')); name = ch && ch.name; }
    if (!name) return res.status(404).json({ error: 'sin canal activo' });
    if (action === 'stop') { await amiAction({ Action: 'StopMixMonitor', Channel: name }); }
    else { const file = 'pbxng-' + ext + '-' + Date.now() + '.wav'; await amiAction({ Action: 'MixMonitor', Channel: name, File: file }); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Conferencia a 3: arma un bridge mixing con la llamada activa del interno + un tercero
app.post('/api/calls/spy', auth, async (req, res) => {
  const { sup, target, mode } = req.body || {};
  if (!sup || !target) return res.status(400).json({ error: 'supervisor y destino requeridos' });
  let opt = 'q';
  if (mode === 'whisper') opt = 'qw';
  else if (mode === 'barge') opt = 'qB';
  try {
    await amiAction({ Action: 'Originate', Channel: 'PJSIP/' + sup, Application: 'ChanSpy', Data: 'PJSIP/' + target + ',' + opt, CallerID: 'Monitor <' + sup + '>', Async: 'true', Timeout: 30000 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/calls/conference', async (req, res) => {
  const { ext, third } = req.body || {};
  if (!ext || !third) return res.status(400).json({ error: 'ext y third requeridos' });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
pool.query("CREATE TABLE IF NOT EXISTS pbxng_click2call (id serial PRIMARY KEY, token text UNIQUE, name text, dest_type text DEFAULT 'extension', dest_value text, intro text, require_name boolean DEFAULT true, collect_geo boolean DEFAULT false, video boolean DEFAULT false, enabled boolean DEFAULT true, tenant_id int DEFAULT 1, created_at timestamptz DEFAULT now())").catch(e => console.error('[C2C] table', e.message));
pool.query("CREATE TABLE IF NOT EXISTS pbxng_c2c_sessions (id text PRIMARY KEY, link_id int, guest_ext text, dial_exten text, visitor_name text, geo text, meta text, created_at timestamptz DEFAULT now(), expires_at timestamptz)").catch(e => console.error('[C2C] sess table', e.message));
const c2cRate = new Map();
function c2cAllow(ip) { const now = Date.now(); const arr = (c2cRate.get(ip) || []).filter(t => now - t < 300000); arr.push(now); c2cRate.set(ip, arr); return arr.length <= 6; }
function c2cDestRoute(type, val) { if (type === 'extension') return ['internal', val]; return ['ivr', val]; }
app.get('/api/c2c/public/:token', async (req, res) => {
  try { const { rows } = await pool.query('SELECT name,intro,require_name,collect_geo,video,enabled FROM pbxng_click2call WHERE token=$1', [req.params.token]); if (!rows[0] || !rows[0].enabled) return res.status(404).json({ error: 'enlace no disponible' }); res.json(rows[0]); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
    const dp = [['c2c', dialExten, 1, 'NoOp', 'C2C ' + link.name], ['c2c', dialExten, 2, 'Set', 'CALLERID(name)=' + vname], ['c2c', dialExten, 3, 'Set', '__C2C_LINK=' + link.name], ['c2c', dialExten, 4, 'Goto', ctx + ',' + dst + ',1']];
    await c.query("DELETE FROM extensions WHERE context='c2c' AND exten=$1", [dialExten]);
    for (const r of dp) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
    await c.query("INSERT INTO pbxng_c2c_sessions (id,link_id,guest_ext,dial_exten,visitor_name,geo,meta,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '40 minutes')", [sid, link.id, guestExt, dialExten, vname, (b.geo ? JSON.stringify(b.geo).slice(0, 400) : null), (b.meta ? JSON.stringify(b.meta).slice(0, 400) : null)]);
    await c.query('COMMIT');
    res.json({ session: sid, ext: guestExt, pass: password, dial: dialExten, video: !!link.video });
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} res.status(500).json({ error: e.message }); } finally { c.release(); }
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
pool.query("CREATE TABLE IF NOT EXISTS pbxng_phones (id serial PRIMARY KEY, mac text UNIQUE, vendor text, model text, ext text, label text, line_label text, password text, tenant_id int DEFAULT 1, last_seen timestamptz, created_at timestamptz DEFAULT now())").catch(e => console.error('[PROV] table', e.message));
async function createSipEndpoint(c, id, password, context = 'internal', tenant_id = 1) {
  await c.query("INSERT INTO ps_aors (id,max_contacts,remove_existing,qualify_frequency,tenant_id) VALUES ($1,1,'yes',60,$2) ON CONFLICT (id) DO NOTHING", [id, tenant_id]);
  await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$1,$2,$3) ON CONFLICT (id) DO UPDATE SET password=EXCLUDED.password", [id, password, tenant_id]);
  await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,direct_media,rtp_symmetric,force_rport,rewrite_contact) VALUES ($1,'transport-udp',$1,$1,$2,'all','ulaw,alaw,g722',$3,'extension','no','yes','yes','yes') ON CONFLICT (id) DO UPDATE SET transport='transport-udp'", [id, context, tenant_id]);
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
    const server = await getProvSetting('prov_sip_server', '172.26.20.183');
    const port = await getProvSetting('prov_sip_port', '5060');
    if (vendor === 'yealink') res.type('text/plain').send(yealinkCfg(ph, server, port));
    else res.type('application/xml').send(grandstreamXml(ph, server, port));
  } catch (e) { res.status(500).type('text/plain').send('error'); }
}
app.get('/prov/:file', async (req, res) => { const tok = await getProvSetting('prov_token', ''); if (tok) return res.status(403).type('text/plain').send('token requerido'); return serveProv(req, res, req.params.file); });
app.get('/prov/:token/:file', async (req, res) => { const tok = await getProvSetting('prov_token', ''); if (tok && req.params.token !== tok) return res.status(403).type('text/plain').send('forbidden'); return serveProv(req, res, req.params.file); });
pool.query("CREATE TABLE IF NOT EXISTS pbxng_call_geo (id serial PRIMARY KEY, ext text, number text, dir text, lat double precision, lng double precision, accuracy real, ua text, ts timestamptz DEFAULT now())").catch(e => console.error('[GEO] table', e.message));
app.post('/api/geo/report', async (req, res) => {
  const b = req.body || {};
  const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ error: 'coordenadas invalidas' });
  try {
    await pool.query("INSERT INTO pbxng_call_geo (ext,number,dir,lat,lng,accuracy,ua) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [String(b.ext || '').slice(0, 32) || null, String(b.number || '').slice(0, 64) || null, b.dir === 'in' ? 'in' : 'out', lat, lng, parseFloat(b.accuracy) || null, String(req.headers['user-agent'] || '').slice(0, 200)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const VM_AGENT = 'http://172.26.20.183:8089';
app.get('/api/vm', async (req, res) => {
  try { const r = await fetch(VM_AGENT + '/vm/list?ext=' + encodeURIComponent(req.query.ext || '')); res.json(await r.json()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/vm/audio', async (req, res) => {
  try { const r = await fetch(VM_AGENT + '/vm/audio?ext=' + encodeURIComponent(req.query.ext || '') + '&folder=' + encodeURIComponent(req.query.folder || 'INBOX') + '&id=' + encodeURIComponent(req.query.id || '')); if (!r.ok) return res.status(404).end(); const buf = Buffer.from(await r.arrayBuffer()); res.set('Content-Type', 'audio/wav').send(buf); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/vm/del', async (req, res) => {
  try { const r = await fetch(VM_AGENT + '/vm/del', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}) }); res.json(await r.json()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/vm/read', async (req, res) => {
  try { const r = await fetch(VM_AGENT + '/vm/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}) }); res.json(await r.json()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/branding', async (req, res) => { try { const g = async (k) => { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value; }; res.json({ name: (await g('brand_name')) || 'PBX-NG', subtitle: (await g('brand_subtitle')) || 'Comunicaciones', tagline: (await g('brand_tagline')) || '', logo: (await g('brand_logo')) || '' }); } catch (e) { res.json({ name: 'PBX-NG', subtitle: 'Comunicaciones', logo: '' }); } });
// auth ahora se aplica via gate deny-by-default arriba (isPublicApi)
app.post('/api/branding', async (req, res) => { try { const b = req.body || {}; const setk = async (k, v) => { if (v === undefined) return; await pool.query("INSERT INTO pbxng_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [k, v || '']); }; await setk('brand_name', b.name); await setk('brand_subtitle', b.subtitle); await setk('brand_tagline', b.tagline); await setk('brand_logo', b.logo); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/geo', async (req, res) => {
  const hours = Math.min(+(req.query.hours || 168), 720);
  const limit = Math.min(+(req.query.limit || 300), 1000);
  try {
    const { rows } = await pool.query("SELECT id, ext, number, dir, lat, lng, accuracy, extract(epoch from ts)::bigint AS ts FROM pbxng_call_geo WHERE ts > now() - ($1 || ' hours')::interval ORDER BY ts DESC LIMIT $2", [String(hours), limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/metrics', async (req, res) => {
  let db_size = null; try { const r = await pool.query("SELECT pg_database_size('pbxng') AS s"); db_size = +r.rows[0].s; } catch (_) {}
  res.json({ ...hostMetrics(), db_size, ts: Date.now() });
});

// Enrollment: generar acceso (crea interno WebRTC + token) -> QR
app.post('/api/enroll', async (req, res) => {
  const { ext, label, video = false } = req.body || {};
  if (!ext) return res.status(400).json({ error: 'ext requerido' });
  const token = crypto.randomBytes(18).toString('hex');
  const c = await pool.connect();
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
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

// Seguridad: estado de Fail2Ban + geolocalizacion
app.get('/api/security', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT jail, banned, bans, config, total_failed, total_banned, extract(epoch from (now()-updated_at))::int AS age_s FROM pbxng_fail2ban ORDER BY jail");
    const ips = [...new Set(rows.flatMap(r => r.banned || []))];
    const geo = await geoLookup(ips);
    const { rows: wl } = await pool.query("SELECT ip, note, extract(epoch from created_at)::int AS created FROM pbxng_f2b_whitelist ORDER BY created_at");
    res.json({ jails: rows, geo, whitelist: wl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/security/unban', async (req, res) => {
  const { ip, jail } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip requerida' });
  try { await pool.query("INSERT INTO pbxng_fail2ban_cmd (cmd, ip, jail) VALUES ('unban',$1,$2)", [ip, jail || null]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/security/ban', async (req, res) => {
  const { ip, jail } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip requerida' });
  try { await pool.query("INSERT INTO pbxng_fail2ban_cmd (cmd, ip, jail) VALUES ('ban',$1,$2)", [ip, jail || null]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/security/whitelist', async (req, res) => {
  try { const { rows } = await pool.query("SELECT ip, note, extract(epoch from created_at)::int AS created FROM pbxng_f2b_whitelist ORDER BY created_at"); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/security/whitelist', async (req, res) => {
  const { ip, note } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip requerida' });
  try { await pool.query("INSERT INTO pbxng_f2b_whitelist (ip,note) VALUES ($1,$2) ON CONFLICT (ip) DO UPDATE SET note=EXCLUDED.note", [ip.trim(), note || null]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/security/whitelist/remove', async (req, res) => {
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip requerida' });
  try { await pool.query("DELETE FROM pbxng_f2b_whitelist WHERE ip=$1", [ip]); await pool.query("INSERT INTO pbxng_fail2ban_cmd (cmd, ip) VALUES ('wl_del',$1)", [ip]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Email por empresa (SMTP)
app.get('/api/email/config', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT t.id AS tenant_id, t.name, e.host, e.port, e.secure, e.username, COALESCE(NULLIF(e.password,''),'') <> '' AS has_password, e.from_addr, e.enabled FROM tenants t LEFT JOIN pbxng_email_config e ON e.tenant_id=t.id ORDER BY t.id");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/email/config', async (req, res) => {
  const b = req.body || {}; if (!b.tenant_id) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    await pool.query(`INSERT INTO pbxng_email_config (tenant_id,host,port,secure,username,password,from_addr,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (tenant_id) DO UPDATE SET host=$2,port=$3,secure=$4,username=$5,password=COALESCE(NULLIF($6,''), pbxng_email_config.password),from_addr=$7,enabled=$8,updated_at=now()`,
      [b.tenant_id, b.host || null, b.port || 587, !!b.secure, b.username || null, b.password || '', b.from_addr || null, !!b.enabled]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    await tx.sendMail({ from: cfg.from_addr || cfg.username, to, subject: 'Prueba de email · PBX-NG', text: 'Configuración SMTP funcionando correctamente.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: smtpHint(e) }); }
});
app.get('/api/prompts', async (req, res) => {
  try { const { rows } = await pool.query('SELECT id,name,format,bytes,updated_at,synced_at FROM pbxng_prompts WHERE deleted=false ORDER BY name'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/prompts/:id', async (req, res) => {
  try { await pool.query('UPDATE pbxng_prompts SET deleted=true, updated_at=now(), synced_at=NULL WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/enroll/email', async (req, res) => {
  const { ext, to, tenant_id = 1 } = req.body || {};
  if (!ext || !to) return res.status(400).json({ error: 'ext y destinatario requeridos' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ex = await c.query('SELECT password FROM ps_auths WHERE id=$1', [String(ext)]);
    let password;
    if (ex.rows[0] && ex.rows[0].password) { password = ex.rows[0].password; }
    else { password = 'Pbx' + crypto.randomBytes(4).toString('hex') + '#' + (10 + Math.floor(Math.random() * 89)); await createWebrtcEndpoint(c, String(ext), password, 'internal', 1, false); }
    const token = crypto.randomBytes(18).toString('hex');
    await c.query("INSERT INTO pbxng_enroll (token,ext,password,expires_at) VALUES ($1,$2,$3, now() + interval '24 hours')", [token, String(ext), password]);
    await c.query('COMMIT');
    const url = 'https://pbx.ies.com.uy/enroll?token=' + token;
    const { rows } = await pool.query('SELECT host,port,secure,username,password,from_addr,enabled FROM pbxng_email_config WHERE tenant_id=$1', [tenant_id]);
    const cfg = rows[0];
    if (!cfg || !cfg.enabled || !cfg.host) return res.status(400).json({ error: 'Configurá y activá el email de la empresa en Configuración' });
    const png = await QRCode.toBuffer(url, { width: 320, margin: 1 });
    const tx = nodemailer.createTransport({ host: cfg.host, port: cfg.port || 587, secure: !!cfg.secure, auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined });
    const html = '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1f2733">' +
      '<h2 style="color:#1d4ed8">Tu acceso al softphone</h2>' +
      '<p>Interno <b>' + ext + '</b>. Escaneá este código QR desde el celular para configurar tu teléfono automáticamente:</p>' +
      '<p style="text-align:center"><img src="cid:qr" width="240" height="240" alt="QR" /></p>' +
      '<p>O abrí este enlace en el navegador del celular:</p>' +
      '<p><a href="' + url + '">' + url + '</a></p>' +
      '<p style="color:#8a93a3;font-size:12px">El acceso vence en 24 horas. Luego, agregá la app a tu pantalla de inicio.</p></div>';
    await tx.sendMail({ from: cfg.from_addr || cfg.username, to, subject: 'Tu acceso al softphone PBX-NG (interno ' + ext + ')', html, attachments: [{ filename: 'acceso-qr.png', content: png, cid: 'qr' }] });
    res.json({ ok: true });
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} res.status(500).json({ error: smtpHint(e) }); } finally { c.release(); }
});

// Push (admin): dispositivos nativos + estado de proveedores
app.get('/api/push/devices', async (req, res) => { try { const devices = await pushProviders.listDevices(); const { rows } = await pool.query('SELECT ext, count(*)::int AS n FROM pbxng_push_subs GROUP BY ext'); const status = await pushProviders.providerStatus(); res.json({ devices, webpush: rows, status, vapid: VAPID.pub }); } catch (e) { res.status(500).json({ error: e.message }); } });

// Telefonos / Auto-provisioning (admin)
app.get('/api/phones', async (req, res) => { try { const { rows } = await pool.query('SELECT id,mac,vendor,model,ext,label,line_label,last_seen,created_at FROM pbxng_phones ORDER BY id'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
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
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.put('/api/phones/:id', async (req, res) => { const b = req.body || {}; try { await pool.query('UPDATE pbxng_phones SET vendor=$1,model=$2,ext=$3,label=$4,line_label=$5 WHERE id=$6', [b.vendor || 'yealink', b.model || null, String(b.ext), b.label || null, b.line_label || null, req.params.id]); res.json({ updated: req.params.id }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/phones/:id', async (req, res) => { try { await pool.query('DELETE FROM pbxng_phones WHERE id=$1', [req.params.id]); res.json({ deleted: req.params.id }); } catch (e) { res.status(500).json({ error: e.message }); } });

// Voz IA (servicio Piper + faster-whisper) - estado y recursos del contenedor
app.get('/api/voz', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='voz_url'");
    const url = (rows[0] && rows[0].value) || 'http://172.26.20.219:8080';
    const t = Date.now();
    const r = await fetch(url + '/health', { signal: AbortSignal.timeout(4000) });
    const h = await r.json();
    res.json({ ok: true, url, latency_ms: Date.now() - t, ...h });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
async function vozBase() { const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='voz_url'"); return (rows[0] && rows[0].value) || 'http://172.26.20.219:8080'; }
async function vozFwd(method, path, body, ms) { const u = await vozBase(); const opt = { method, signal: AbortSignal.timeout(ms || 8000) }; if (body !== undefined) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); } const r = await fetch(u + path, opt); return r; }
app.get('/api/voz/logs', async (req, res) => { try { const r = await vozFwd('GET', '/admin/logs'); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/voz/restart', async (req, res) => { try { const r = await vozFwd('POST', '/admin/restart', {}); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/voz/voices', async (req, res) => { try { const r = await vozFwd('GET', '/admin/voices'); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/voz/voices/install', async (req, res) => { try { const r = await vozFwd('POST', '/admin/voices/install', req.body || {}, 240000); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/voz/voices/:key', async (req, res) => { try { const r = await vozFwd('DELETE', '/admin/voices/' + encodeURIComponent(req.params.key)); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/voz/config', async (req, res) => { try { const r = await vozFwd('GET', '/admin/config'); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/voz/config', async (req, res) => { try { const r = await vozFwd('POST', '/admin/config', req.body || {}); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/voz/test', async (req, res) => { try { const u = await vozBase(); const r = await fetch(u + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: (req.body && req.body.text) || 'Hola, esta es una prueba de la voz seleccionada.', voice: req.body && req.body.voice, rate: 22050, format: 'wav' }), signal: AbortSignal.timeout(20000) }); const buf = Buffer.from(await r.arrayBuffer()); res.set('Content-Type', 'audio/wav').send(buf); } catch (e) { res.status(500).json({ error: e.message }); } });

// --- TURN / Coturn (agente CT106) ---
const TURN_BASE = process.env.TURN_AGENT || 'http://172.26.20.204:8091';
async function turnFwd(method, path, body, ms) { const opt = { method, signal: AbortSignal.timeout(ms || 8000) }; if (body !== undefined) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); } return fetch(TURN_BASE + path, opt); }
app.get('/api/turn', async (req, res) => { try { const r = await turnFwd('GET', '/health'); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/turn/config', async (req, res) => { try { const r = await turnFwd('GET', '/config'); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/turn/config', async (req, res) => { try { const r = await turnFwd('POST', '/config', req.body || {}, 15000); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/turn/restart', async (req, res) => { try { const r = await turnFwd('POST', '/restart', {}, 15000); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/turn/logs', async (req, res) => { try { const r = await turnFwd('GET', '/logs'); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/turn/test', async (req, res) => { try { const r = await turnFwd('POST', '/test', {}, 15000); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });

// --- NPM cert expiry (para avisar vencimiento SSL del WebRTC) ---
let _npmCertCache = null;
async function npmCertInfo() {
  if (_npmCertCache && Date.now() - _npmCertCache.t < 1800000) return _npmCertCache.d;
  const g = async (k) => { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value; };
  const url = (await g('npm_url')) || 'http://172.26.20.17:81';
  const id = await g('npm_identity'); const sec = await g('npm_secret');
  if (!id || !sec) return { error: 'npm-creds-missing' };
  const tk = await fetch(url + '/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: id, secret: sec }), signal: AbortSignal.timeout(8000) }).then((r) => r.json());
  if (!tk.token) return { error: 'npm-auth-failed' };
  const certs = await fetch(url + '/api/nginx/certificates', { headers: { Authorization: 'Bearer ' + tk.token }, signal: AbortSignal.timeout(8000) }).then((r) => r.json());
  const dom = 'pbx.ies.com.uy';
  const c = (Array.isArray(certs) ? certs : []).find((x) => (x.domain_names || []).includes(dom));
  const d = c ? { domain: dom, expires_on: c.expires_on, days_left: Math.round((new Date(c.expires_on).getTime() - Date.now()) / 86400000) } : { error: 'cert-not-found' };
  _npmCertCache = { t: Date.now(), d };
  return d;
}
app.get('/api/npm/cert', async (req, res) => { try { res.json(await npmCertInfo()); } catch (e) { res.status(500).json({ error: e.message }); } });

// --- Asterisk core agent (CT103) ---
const AST_AGENT = process.env.AST_AGENT || 'http://172.26.20.183:8092';
async function astFwd(method, path, body, ms) { const opt = { method, signal: AbortSignal.timeout(ms || 8000) }; if (body !== undefined) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); } return fetch(AST_AGENT + path, opt); }
app.get('/api/asterisk/core', async (req, res) => { try { const r = await astFwd('GET', '/core'); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/asterisk/net', async (req, res) => { try { const r = await astFwd('GET', '/net'); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/asterisk/route', async (req, res) => { try { const r = await astFwd('POST', '/route', req.body || {}, 12000); res.json(await r.json()); } catch (e) { res.status(500).json({ error: e.message }); } });

// --- Troncal interna Asterisk <-> SBC (modelo borde) ---
app.get('/api/asterisk/sbc-trunk', async (req, res) => {
  try {
    const ep = (await pool.query("SELECT id,transport,aors,context,allow FROM ps_endpoints WHERE id='to-sbc'")).rows;
    const aor = (await pool.query("SELECT contact,qualify_frequency FROM ps_aors WHERE id='to-sbc'")).rows;
    const idp = (await pool.query("SELECT match FROM ps_endpoint_id_ips WHERE id='to-sbc'")).rows;
    res.json({ exists: ep.length > 0, endpoint: ep[0] || null, aor: aor[0] || null, identify: idp[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/asterisk/sbc-trunk', async (req, res) => {
  try {
    const b = req.body || {};
    const ip = (b.sbc_ip || '172.26.20.205').trim();
    const port = +b.sbc_port || 5060;
    const ctx = (b.context || 'from-trunk').trim();
    const codecs = (Array.isArray(b.codecs) && b.codecs.length ? b.codecs : ['ulaw', 'alaw', 'g722']).join(',');
    const contact = 'sip:' + ip + ':' + port;
    await pool.query("INSERT INTO ps_aors(id,contact,qualify_frequency) VALUES('to-sbc',$1,30) ON CONFLICT(id) DO UPDATE SET contact=$1,qualify_frequency=30", [contact]);
    await pool.query("INSERT INTO ps_endpoints(id,transport,aors,context,disallow,allow,direct_media,rtp_symmetric,force_rport,rewrite_contact,identify_by,tenant_id,pbxng_kind) VALUES('to-sbc','transport-udp','to-sbc',$1,'all',$2,'no','yes','yes','yes','ip',1,'trunk') ON CONFLICT(id) DO UPDATE SET context=$1,allow=$2,transport='transport-udp',aors='to-sbc',identify_by='ip',direct_media='no'", [ctx, codecs]);
    await pool.query("INSERT INTO ps_endpoint_id_ips(id,endpoint,match) VALUES('to-sbc','to-sbc',$1) ON CONFLICT(id) DO UPDATE SET match=$1,endpoint='to-sbc'", [ip]);
    try { await astFwd('POST', '/reload', {}, 12000); } catch (_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/asterisk/sbc-trunk', async (req, res) => {
  try { await pool.query("DELETE FROM ps_endpoint_id_ips WHERE id='to-sbc'"); await pool.query("DELETE FROM ps_endpoints WHERE id='to-sbc'"); await pool.query("DELETE FROM ps_aors WHERE id='to-sbc'"); try { await astFwd('POST', '/reload', {}, 12000); } catch (_) {} res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/db/maintenance', async (req, res) => {
  try { const t = req.body && req.body.table; if (t && /^[a-zA-Z0-9_]+$/.test(t)) await pool.query('VACUUM ANALYZE ' + t); else await pool.query('VACUUM ANALYZE'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- IVR: generar audio por TTS y desplegarlo a Asterisk ---
app.get('/api/ivr/audios', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,text,voice,ref,created_at FROM pbxng_ivr_audios ORDER BY created_at DESC'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/ivr/gen-audio', async (req, res) => {
  try {
    const b = req.body || {}; const text = (b.text || '').trim();
    if (!text) return res.status(400).json({ error: 'texto requerido' });
    let name = (b.name || ('ivr_' + Date.now())).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || ('ivr_' + Date.now());
    const u = await vozBase();
    const r = await fetch(u + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: b.voice, rate: 8000, format: 'wav' }), signal: AbortSignal.timeout(25000) });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return res.status(500).json({ error: 'TTS devolvió vacío' });
    const sr = await astFwd('POST', '/sound', { name, b64: buf.toString('base64') }, 15000).then((x) => x.json());
    if (!sr.ok) return res.status(500).json({ error: 'deploy: ' + (sr.error || '?') });
    await pool.query("INSERT INTO pbxng_ivr_audios(name,text,voice,ref) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO UPDATE SET text=$2,voice=$3,ref=$4,created_at=now()", [name, text, b.voice || '', sr.ref]);
    res.json({ ok: true, ref: sr.ref, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/ivr/audios/:id', async (req, res) => { try { await pool.query('DELETE FROM pbxng_ivr_audios WHERE id=$1', [req.params.id]); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// --- Modulos (PBX modular: activar/desactivar) ---
const MODULE_IDS = ['sbc', 'turn', 'voz', 'clicktocall', 'push', 'autoprov', 'ai'];
app.get('/api/modules', async (req, res) => {
  try { const out = {}; for (const id of MODULE_IDS) { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', ['mod_' + id]); out[id] = rows[0] ? rows[0].value !== '0' : true; } res.json(out); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/modules', async (req, res) => {
  const { id, enabled } = req.body || {};
  if (!MODULE_IDS.includes(id)) return res.status(400).json({ error: 'modulo invalido' });
  try {
    await pool.query("INSERT INTO pbxng_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", ['mod_' + id, enabled ? '1' : '0']);
    let svc = null;
    try {
      if (id === 'turn') { const r = await turnFwd('POST', '/service', { action: enabled ? 'start' : 'stop' }, 12000); svc = await r.json(); }
      else if (id === 'sbc') { await pool.query('INSERT INTO pbxng_sbc_cmd(cmd,arg) VALUES($1,$2)', [enabled ? 'svc_start' : 'svc_stop', 'kamailio']); svc = { queued: true }; }
    } catch (e) { svc = { error: e.message }; }
    res.json({ ok: true, id, enabled: !!enabled, svc });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sysprompts/seed', async (req, res) => {
  try {
    let n = 0;
    for (const [name, category, text] of SYSPROMPT_CATALOG) {
      const r = await pool.query("INSERT INTO pbxng_sysprompts(name, category, text) VALUES($1,$2,$3) ON CONFLICT (name) DO NOTHING", [name, category, text]);
      n += r.rowCount;
    }
    res.json({ ok: true, inserted: n, total: SYSPROMPT_CATALOG.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sysprompts/:name', async (req, res) => {
  try {
    const text = (req.body && req.body.text) || '';
    await pool.query("UPDATE pbxng_sysprompts SET text=$1 WHERE name=$2", [text, req.params.name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sysprompts/test/:name', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT audio FROM pbxng_sysprompts WHERE name=$1", [req.params.name]);
    if (!rows.length || !rows[0].audio) return res.status(404).json({ error: 'sin audio' });
    res.set('Content-Type', 'audio/wav').send(rows[0].audio);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sysprompts/revert', async (req, res) => {
  try {
    let names = (req.body && req.body.names) || [];
    let r;
    if (!names.length) r = await pool.query("UPDATE pbxng_sysprompts SET revert=true, updated_at=now() WHERE deployed_at IS NOT NULL OR audio IS NOT NULL");
    else r = await pool.query("UPDATE pbxng_sysprompts SET revert=true, updated_at=now() WHERE name = ANY($1)", [names]);
    res.json({ ok: true, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ===== fin Audios del sistema =====


// Click-to-Call (admin)
app.get('/api/c2c', async (req, res) => { try { const { rows } = await pool.query('SELECT id,token,name,dest_type,dest_value,intro,require_name,collect_geo,video,enabled,created_at FROM pbxng_click2call ORDER BY id'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/c2c', async (req, res) => { const b = req.body || {}; if (!b.name || !b.dest_value) return res.status(400).json({ error: 'name y destino requeridos' }); try { const token = crypto.randomBytes(6).toString('hex'); const { rows } = await pool.query('INSERT INTO pbxng_click2call (token,name,dest_type,dest_value,intro,require_name,collect_geo,video,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,token', [token, b.name, b.dest_type || 'extension', b.dest_value, b.intro || '', b.require_name !== false, !!b.collect_geo, !!b.video, b.enabled !== false]); res.status(201).json(rows[0]); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/c2c/:id', async (req, res) => { const b = req.body || {}; try { await pool.query('UPDATE pbxng_click2call SET name=$1,dest_type=$2,dest_value=$3,intro=$4,require_name=$5,collect_geo=$6,video=$7,enabled=$8 WHERE id=$9', [b.name, b.dest_type || 'extension', b.dest_value, b.intro || '', b.require_name !== false, !!b.collect_geo, !!b.video, b.enabled !== false, req.params.id]); res.json({ updated: req.params.id }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/c2c/:id', async (req, res) => { try { await pool.query('DELETE FROM pbxng_click2call WHERE id=$1', [req.params.id]); res.json({ deleted: req.params.id }); } catch (e) { res.status(500).json({ error: e.message }); } });

// Grabaciones (admin)
app.get('/api/recordings', async (req, res) => {
  try { const { rows } = await pool.query('SELECT id, filename, ext, src, dst, started_at, bytes, duration, storage, remote_url FROM pbxng_recordings WHERE deleted=false ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 500'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/recordings/:id', async (req, res) => {
  try { await pool.query('UPDATE pbxng_recordings SET deleted=true WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/recordings/config', async (req, res) => {
  try { const { rows } = await pool.query("SELECT id, backend, nas_path, s3_endpoint, s3_region, s3_bucket, s3_key, COALESCE(NULLIF(s3_secret,''),'') <> '' AS has_secret, s3_prefix, auto_upload, retain_local FROM pbxng_rec_config WHERE id=1"); res.json(rows[0] || {}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/recordings/config', async (req, res) => {
  const b = req.body || {};
  try {
    await pool.query(`UPDATE pbxng_rec_config SET backend=COALESCE($1,backend), nas_path=$2, s3_endpoint=$3, s3_region=$4, s3_bucket=$5, s3_key=$6, s3_secret=COALESCE(NULLIF($7,''), s3_secret), s3_prefix=COALESCE($8,s3_prefix), auto_upload=COALESCE($9,auto_upload), retain_local=COALESCE($10,retain_local), updated_at=now() WHERE id=1`,
      [b.backend || null, b.nas_path || null, b.s3_endpoint || null, b.s3_region || null, b.s3_bucket || null, b.s3_key || null, b.s3_secret || '', b.s3_prefix || null, b.auto_upload, b.retain_local]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Usuarios ----------------
app.get('/api/users', async (req, res) => {
  try { const { rows } = await pool.query('SELECT id,username,name,role,created_at FROM pbxng_users ORDER BY id'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/users', async (req, res) => {
  const { username, password, name, role = 'admin' } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'usuario y contraseña obligatorios' });
  try {
    await pool.query('INSERT INTO pbxng_users (username,password_hash,name,role) VALUES ($1,$2,$3,$4)', [username, bcrypt.hashSync(password, 10), name || username, role]);
    res.status(201).json({ created: username });
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'el usuario ya existe' : e.message }); }
});
app.post('/api/users/:id/password', async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'falta contraseña' });
  try { await pool.query('UPDATE pbxng_users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(password, 10), req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT username FROM pbxng_users WHERE id=$1', [req.params.id]);
    if (rows[0] && rows[0].username === 'admin') return res.status(400).json({ error: 'no se puede borrar admin' });
    await pool.query('DELETE FROM pbxng_users WHERE id=$1', [req.params.id]); res.json({ deleted: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    { group: 'Datos', name: 'Redis', detail: 'cache / sesiones', status: 'ok' },
    { group: 'Datos', name: 'CDR', detail: 'cdr_pgsql', status: has('cdr_pgsql\\.so') ? 'ok' : 'off' },
    { group: 'Transporte', name: 'SIP UDP 5060', detail: 'telefonos / softphones', status: /udp/i.test(transports) ? 'ok' : 'off' },
    { group: 'Transporte', name: 'ARI / AMI', detail: 'control plane (LAN)', status: state.ari && state.ami ? 'ok' : 'down' },
    { group: 'WebRTC', name: 'Transporte WebSocket (ws)', detail: 'pbx.ies.com.uy/ws', status: wss ? 'ok' : 'off' },
    { group: 'WebRTC', name: 'WSS + certificado (NPM/LE)', detail: 'pbx.ies.com.uy', status: 'ok' },
    { group: 'WebRTC', name: 'STUN', detail: 'stun.l.google.com:19302', status: 'ok' },
    { group: 'WebRTC', name: 'TURN (Coturn)', detail: 'CT 172.26.20.204 - forward publico activo', status: 'ok' },
    { group: 'Escalado', name: 'SBC de borde (Kamailio)', detail: 'CT 172.26.20.205 - dispatcher a Asterisk', status: 'ok' },
    { group: 'Escalado', name: 'Relay de medios (rtpengine)', detail: 'userspace · ancla RTP en el borde', status: state.ami ? 'ok' : 'ok' },
    { group: 'Seguridad', name: 'Fail2Ban', detail: 'anti fuerza bruta PJSIP', status: 'ok' },
    { group: 'Seguridad', name: 'Proxy inverso (NPM + LE)', detail: '172.26.20.17 - TLS', status: 'ok' },
  ];
  res.json({ asterisk: astVer, components: comps });
});

app.get('/api/extensions', async (req, res) => { try { res.json(await getExtensions()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/extensions/record-all', async (req, res) => { try { const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='record_all'"); res.json({ enabled: !!(rows[0] && rows[0].value === '1') }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/extensions/record-all', async (req, res) => { try { const on = !!(req.body && req.body.enabled); await pool.query("INSERT INTO pbxng_settings (key,value) VALUES ('record_all',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [on ? '1' : '0']); await setRecAll(on); res.json({ ok: true, enabled: on }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/endpoints', async (req, res) => { try { res.json(await getExtensions()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/endpoints', async (req, res) => {
  const { id, password, context = 'internal', tenant_id = 1, video = false, webrtc = false, max_contacts = 2 } = req.body || {};
  const allow = (video || webrtc) ? 'ulaw,alaw,g722,vp8,h264' : 'ulaw,alaw,g722';
  const transport = webrtc ? 'transport-ws' : 'transport-udp';
  if (!id || !password) return res.status(400).json({ error: 'id y password son obligatorios' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("INSERT INTO ps_aors (id,max_contacts,remove_existing,qualify_frequency,tenant_id) VALUES ($1,$2,'yes',60,$3)", [id, max_contacts, tenant_id]);
    await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$1,$2,$3)", [id, password, tenant_id]);
    if (webrtc) {
      await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,webrtc,dtls_auto_generate_cert,ice_support,use_avpf,media_encryption,media_use_received_transport,rtcp_mux,direct_media,rtp_symmetric,force_rport,rewrite_contact) VALUES ($1,$2,$1,$1,$3,'all',$4,$5,'extension','yes','yes','yes','yes','dtls','yes','yes','no','yes','yes','yes')", [id, transport, context, allow, tenant_id]);
    } else {
      await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,direct_media,rtp_symmetric,force_rport,rewrite_contact) VALUES ($1,$2,$1,$1,$3,'all',$4,$5,'extension','no','yes','yes','yes')", [id, transport, context, allow, tenant_id]);
    }
    if (req.body && req.body.name) await c.query("INSERT INTO pbxng_directory (ext,name) VALUES ($1,$2) ON CONFLICT (ext) DO UPDATE SET name=EXCLUDED.name", [id, req.body.name]);
    await c.query('COMMIT'); broadcastSoon(); const _rec = !!(req.body && req.body.record); await pool.query('UPDATE ps_endpoints SET pbxng_record=$2 WHERE id=$1', [id, _rec]).catch(() => {}); setRecFlag(id, _rec); res.status(201).json({ created: id, webrtc, video });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.put('/api/endpoints/:id', async (req, res) => {
  const { id } = req.params;
  const { password, context, video = false, webrtc = false, max_contacts } = req.body || {};
  const allow = (video || webrtc) ? 'ulaw,alaw,g722,vp8,h264' : 'ulaw,alaw,g722';
  const transport = webrtc ? 'transport-ws' : 'transport-udp';
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (password) await c.query('UPDATE ps_auths SET password=$2 WHERE id=$1', [id, password]);
    if (max_contacts) await c.query('UPDATE ps_aors SET max_contacts=$2 WHERE id=$1', [id, max_contacts]);
    if (webrtc) {
      await c.query("UPDATE ps_endpoints SET transport=$2, context=COALESCE($3,context), disallow='all', allow=$4, webrtc='yes', dtls_auto_generate_cert='yes', ice_support='yes', use_avpf='yes', media_encryption='dtls', media_use_received_transport='yes', rtcp_mux='yes', direct_media='no', rtp_symmetric='yes', force_rport='yes', rewrite_contact='yes' WHERE id=$1", [id, transport, context, allow]);
    } else {
      await c.query("UPDATE ps_endpoints SET transport=$2, context=COALESCE($3,context), disallow='all', allow=$4, webrtc='no', media_encryption='no', direct_media='no', rtp_symmetric='yes', force_rport='yes', rewrite_contact='yes' WHERE id=$1", [id, transport, context, allow]);
    }
    if (req.body && req.body.name !== undefined) await c.query("INSERT INTO pbxng_directory (ext,name) VALUES ($1,$2) ON CONFLICT (ext) DO UPDATE SET name=EXCLUDED.name", [id, req.body.name]);
    await c.query('COMMIT'); broadcastSoon(); const _rec = !!(req.body && req.body.record); await pool.query('UPDATE ps_endpoints SET pbxng_record=$2 WHERE id=$1', [id, _rec]).catch(() => {}); setRecFlag(id, _rec); res.json({ updated: id, webrtc, video });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.delete('/api/endpoints/:id', async (req, res) => {
  const { id } = req.params; const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('DELETE FROM ps_endpoints WHERE id=$1', [id]); await c.query('DELETE FROM ps_auths WHERE id=$1', [id]); await c.query('DELETE FROM ps_aors WHERE id=$1', [id]); await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: id }); }
  catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

// ---------------- Rutas SALIENTES ----------------
function outExten(p) { return p && p[0] === '_' ? p : '_' + p; }
app.get('/api/routes/outbound', async (req, res) => {
  try { const { rows } = await pool.query('SELECT id,name,pattern,trunk,strip,prepend,callerid FROM pbxng_outbound_routes ORDER BY id'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/routes/outbound', async (req, res) => {
  const { name, pattern, trunk, strip = 0, prepend = '', callerid = '' } = req.body || {};
  if (!pattern) return res.status(400).json({ error: 'patrón requerido' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('INSERT INTO pbxng_outbound_routes (name,pattern,trunk,strip,prepend,callerid) VALUES ($1,$2,$3,$4,$5,$6)', [name || pattern, pattern, 'to-sbc', +strip || 0, prepend || null, callerid || null]);
    const rows = []; let p = 1;
    if (callerid) rows.push([p++, 'Set', 'CALLERID(num)=' + callerid]);
    rows.push([p++, 'Dial', 'PJSIP/' + (prepend || '') + '${EXTEN:' + (+strip || 0) + '}@to-sbc,60']);
    rows.push([p++, 'Hangup', '']);
    await setDialplan(c, 'internal', outExten(pattern), rows);
    await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: pattern });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.delete('/api/routes/outbound/:id', async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT pattern FROM pbxng_outbound_routes WHERE id=$1', [req.params.id]);
    if (rows[0]) await c.query("DELETE FROM extensions WHERE context='internal' AND exten=$1", [outExten(rows[0].pattern)]);
    await c.query('DELETE FROM pbxng_outbound_routes WHERE id=$1', [req.params.id]);
    await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: req.params.id });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

// ---------------- Rutas ENTRANTES (DID) ----------------
function inboundRows(dest_type, v) {
  if (dest_type === 'ivr') return [[1, 'Goto', 'ivr,' + v + ',1']];
  if (dest_type === 'cola') return [[1, 'Answer', ''], [2, 'Queue', v], [3, 'Hangup', '']];
  if (dest_type === 'app') return [[1, 'Goto', 'internal,' + v + ',1']];
  return [[1, 'Dial', 'PJSIP/' + v + ',30'], [2, 'Voicemail', v + '@default,u'], [3, 'Hangup', '']];
}
app.get('/api/routes/inbound', async (req, res) => {
  try { const { rows } = await pool.query('SELECT id,did,name,dest_type,dest_value FROM pbxng_inbound_routes ORDER BY id'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/routes/inbound', async (req, res) => {
  const { did, name, dest_type = 'interno', dest_value } = req.body || {};
  if (!did || !dest_value) return res.status(400).json({ error: 'DID y destino requeridos' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('INSERT INTO pbxng_inbound_routes (did,name,dest_type,dest_value) VALUES ($1,$2,$3,$4)', [did, name || did, dest_type, dest_value]);
    await setDialplan(c, 'from-trunk', did, inboundRows(dest_type, dest_value));
    await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: did });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.delete('/api/routes/inbound/:id', async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT did FROM pbxng_inbound_routes WHERE id=$1', [req.params.id]);
    if (rows[0]) await c.query("DELETE FROM extensions WHERE context='from-trunk' AND exten=$1", [rows[0].did]);
    await c.query('DELETE FROM pbxng_inbound_routes WHERE id=$1', [req.params.id]);
    await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: req.params.id });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

// ---------------- Troncales SIP (avanzado) ----------------
const TRUNK_TRANSPORT = { udp: 'transport-udp', tcp: 'transport-tcp', tls: 'transport-tls' };
function trunkDefaults(o = {}) {
  return {
    provider_host: o.provider_host || '', provider_port: +o.provider_port || 5060,
    transport: ['udp', 'tcp', 'tls'].includes(o.transport) ? o.transport : 'udp',
    mode: o.mode === 'ip' ? 'ip' : 'register',
    username: o.username || '', from_user: o.from_user || o.username || '',
    from_domain: o.from_domain || o.provider_host || '', callerid: o.callerid || '',
    codecs: Array.isArray(o.codecs) && o.codecs.length ? o.codecs : ['ulaw', 'alaw'],
    dtmf_mode: ['rfc4733', 'inband', 'info', 'auto'].includes(o.dtmf_mode) ? o.dtmf_mode : 'rfc4733',
    nat: o.nat !== false, direct_media: !!o.direct_media,
    qualify_frequency: +o.qualify_frequency || 60, expiration: +o.expiration || 3600,
    retry_interval: +o.retry_interval || 60, context: o.context || 'from-trunk',
    outbound_enabled: o.outbound_enabled !== false, outbound_prefix: o.outbound_prefix != null ? String(o.outbound_prefix) : '0',
    outbound_strip: +o.outbound_strip || 0, logo: o.logo || (o.adv_config && o.adv_config.logo) || '',
    dids: Array.isArray(o.dids) ? o.dids.filter(Boolean) : (o.dids ? String(o.dids).split(/[\s,]+/).filter(Boolean) : ((o.adv_config && o.adv_config.dids) || [])),
    channels: +o.channels || (o.adv_config && +o.adv_config.channels) || 0,
    gateway: o.gateway || (o.adv_config && o.adv_config.gateway) || '',
  };
}
async function writeAsteriskTrunk(c, name, a, password, tenant_id) {
  for (const t of ['ps_registrations', 'ps_endpoint_id_ips', 'ps_endpoints', 'ps_auths', 'ps_aors']) await c.query(`DELETE FROM ${t} WHERE id=$1`, [name]);
  const tr = TRUNK_TRANSPORT[a.transport] || 'transport-udp';
  const tsuf = a.transport === 'tcp' ? ';transport=tcp' : a.transport === 'tls' ? ';transport=tls' : '';
  const allow = a.codecs.join(',');
  const nat = a.nat ? 'yes' : 'no';
  await c.query("INSERT INTO ps_aors (id,contact,qualify_frequency,max_contacts,tenant_id) VALUES ($1,$2,$3,1,$4)", [name, `sip:${a.provider_host}:${a.provider_port}${tsuf}`, a.qualify_frequency, tenant_id]);
  const hasAuth = !!(a.username && password);
  if (hasAuth) await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$2,$3,$4)", [name, a.username, password, tenant_id]);
  await c.query(
    "INSERT INTO ps_endpoints (id,transport,aors,outbound_auth,context,disallow,allow,from_user,from_domain,callerid,dtmf_mode,direct_media,rtp_symmetric,force_rport,rewrite_contact,identify_by,tenant_id,pbxng_kind) " +
    "VALUES ($1,$2,$1,$3,$4,'all',$5,$6,$7,$8,$9,$10,$11,$11,$11,'username,ip',$12,'trunk')",
    [name, tr, hasAuth ? name : null, a.context, allow, a.from_user || null, a.from_domain || null, a.callerid || null, a.dtmf_mode, a.direct_media ? 'yes' : 'no', nat, tenant_id]
  );
  await c.query("INSERT INTO ps_endpoint_id_ips (id,endpoint,match) VALUES ($1,$1,$2)", [name, a.provider_host]);
  if (a.mode === 'register') {
    const cli = a.username ? `sip:${a.username}@${a.provider_host}:${a.provider_port}${tsuf}` : `sip:${a.provider_host}:${a.provider_port}${tsuf}`;
    await c.query("INSERT INTO ps_registrations (id,server_uri,client_uri,outbound_auth,retry_interval,expiration,transport) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [name, `sip:${a.provider_host}:${a.provider_port}${tsuf}`, cli, hasAuth ? name : null, a.retry_interval, a.expiration, tr]);
  }
  if (a.outbound_enabled) {
    const pre = a.outbound_prefix || '';
    const exten = '_' + (pre ? pre : 'X') + '.';
    const dialNum = a.outbound_strip ? `${'${EXTEN:' + a.outbound_strip + '}'}` : '${EXTEN}';
    await setDialplan(c, 'internal', exten, [[1, 'NoOp', 'Salida ' + name], [2, 'Dial', 'PJSIP/' + dialNum + '@' + name + ',60'], [3, 'Hangup', '']]);
  }
}

app.get('/api/trunks', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id,name,provider_host,provider_port,username,do_register,tenant_id,COALESCE(kind,'asterisk') AS kind,kam_config,adv_config FROM pbxng_trunks ORDER BY id");
    const st = await trunkStatuses(rows);
    res.json(rows.map(({ kam_config, adv_config, ...t }) => ({ ...t, status: (st[t.name] || {}).status || 'unknown', detail: (st[t.name] || {}).detail || '', register_provider: !!(kam_config && kam_config.register), adv: adv_config || ((kam_config && kam_config.logo) ? { logo: kam_config.logo } : null), logo: (adv_config && adv_config.logo) || (kam_config && kam_config.logo) || null, rtt: (st[t.name] || {}).rtt != null ? (st[t.name] || {}).rtt : null, dids: (adv_config && adv_config.dids) || (kam_config && kam_config.dids) || [], channels: (adv_config && adv_config.channels) || (kam_config && kam_config.channels) || 0, gateway: (adv_config && adv_config.gateway) || (kam_config && kam_config.gateway) || '', mode: (adv_config && adv_config.mode) || (t.do_register ? 'register' : 'ip'), transport: (adv_config && adv_config.transport) || 'udp' })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trunks/:name/detail', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT name,provider_host,provider_port,username,COALESCE(kind,'asterisk') AS kind,adv_config,kam_config FROM pbxng_trunks WHERE name=$1", [req.params.name]);
    if (!rows[0]) return res.status(404).json({ error: 'no existe' });
    const t = rows[0];
    const { rows: au } = await pool.query("SELECT 1 FROM ps_auths WHERE id=$1", [req.params.name]);
    res.json({ name: t.name, kind: t.kind, has_password: !!au[0], adv: trunkDefaults(t.adv_config || t.kam_config || { provider_host: t.provider_host, provider_port: t.provider_port, username: t.username, mode: t.do_register ? 'register' : 'ip' }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trunks', async (req, res) => {
  const b = req.body || {};
  const { name, password, tenant_id = 1, kind = 'asterisk' } = b;
  if (!name || !b.provider_host) return res.status(400).json({ error: 'name y provider_host son obligatorios' });
  if (kind === 'kamailio') {
    try {
      const kam = Object.assign(trunkDefaults(b), { host: b.provider_host, port: +b.provider_port || 5060, register: b.mode !== 'ip', password: password || null });
      await pool.query("INSERT INTO pbxng_trunks (name,provider_host,provider_port,username,do_register,tenant_id,kind,kam_config) VALUES ($1,$2,$3,$4,$5,$6,'kamailio',$7)", [name, b.provider_host, +b.provider_port || 5060, b.username || null, kam.register, tenant_id, JSON.stringify(kam)]);
      return res.status(201).json({ created: name, kind: 'kamailio' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  const a = trunkDefaults(b);
  if (a.mode === 'register' && !(a.username && password)) return res.status(400).json({ error: 'usuario y contraseña son obligatorios en modo Registro' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("INSERT INTO pbxng_trunks (name,provider_host,provider_port,username,do_register,tenant_id,kind,adv_config) VALUES ($1,$2,$3,$4,$5,$6,'asterisk',$7)", [name, a.provider_host, a.provider_port, a.username || null, a.mode === 'register', tenant_id, JSON.stringify(a)]);
    await writeAsteriskTrunk(c, name, a, password, tenant_id);
    await c.query('COMMIT'); res.status(201).json({ created: name, mode: a.mode });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

app.put('/api/trunks/:name', async (req, res) => {
  const name = req.params.name; const b = req.body || {};
  const { password, tenant_id = 1, kind = 'asterisk' } = b;
  if (!b.provider_host) return res.status(400).json({ error: 'provider_host es obligatorio' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: ex } = await c.query("SELECT COALESCE(kind,'asterisk') AS kind FROM pbxng_trunks WHERE name=$1", [name]);
    if (!ex[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'troncal no existe' }); }
    const { rows: oldAuth } = await c.query('SELECT password FROM ps_auths WHERE id=$1', [name]);
    const oldPass = oldAuth[0] ? oldAuth[0].password : null;
    for (const t of ['ps_registrations', 'ps_endpoint_id_ips', 'ps_endpoints', 'ps_auths', 'ps_aors']) await c.query(`DELETE FROM ${t} WHERE id=$1`, [name]);
    if (kind === 'kamailio') {
      const { rows: old } = await c.query('SELECT kam_config FROM pbxng_trunks WHERE name=$1', [name]);
      const prev = (old[0] && old[0].kam_config) || {};
      const kam = Object.assign(trunkDefaults(b), { host: b.provider_host, port: +b.provider_port || 5060, register: b.mode !== 'ip', password: password || prev.password || null });
      await c.query("UPDATE pbxng_trunks SET provider_host=$1, provider_port=$2, username=$3, do_register=$4, kind='kamailio', kam_config=$5, adv_config=NULL WHERE name=$6", [b.provider_host, kam.port, b.username || null, kam.register, JSON.stringify(kam), name]);
      await c.query('COMMIT'); return res.json({ updated: name, kind: 'kamailio' });
    }
    const a = trunkDefaults(b);
    const pass = password || oldPass;
    if (a.mode === 'register' && !(a.username && pass)) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'usuario y contraseña requeridos en modo Registro' }); }
    await c.query("UPDATE pbxng_trunks SET provider_host=$1, provider_port=$2, username=$3, do_register=$4, kind='asterisk', kam_config=NULL, adv_config=$5 WHERE name=$6", [a.provider_host, a.provider_port, a.username || null, a.mode === 'register', JSON.stringify(a), name]);
    await writeAsteriskTrunk(c, name, a, pass, tenant_id);
    await c.query('COMMIT'); res.json({ updated: name, mode: a.mode });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

app.delete('/api/trunks/:name', async (req, res) => {
  const { name } = req.params; const c = await pool.connect();
  try { await c.query('BEGIN'); for (const t of ['ps_registrations', 'ps_endpoint_id_ips', 'ps_endpoints', 'ps_auths', 'ps_aors']) await c.query(`DELETE FROM ${t} WHERE id=$1`, [name]); await c.query('DELETE FROM pbxng_trunks WHERE name=$1', [name]); await c.query('COMMIT'); res.json({ deleted: name }); }
  catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

app.get('/api/registrations', async (req, res) => { try { res.json({ output: await amiCommand('pjsip show registrations') }); } catch (e) { res.status(500).json({ error: e.message }); } });

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
      catch (e) { console.error('[INT] envío ' + r.type, e.message); }
    }
  } catch (e) { console.error('[INT] notify', e.message); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ---------------- AI IVR (agentes) ----------------
function aiAgentDialplan(exten, id) {
  return [['ivr', exten, 1, 'NoOp', 'AI IVR agente ' + id], ['ivr', exten, 2, 'Answer', ''], ['ivr', exten, 3, 'Stasis', 'pbxng,ai,' + id], ['ivr', exten, 4, 'Hangup', '']];
}
app.get('/api/settings', async (req, res) => {
  try { const { rows } = await pool.query('SELECT key,value FROM pbxng_settings'); const o = {}; for (const r of rows) { o[r.key] = /key|secret|token|pass|account|credential|p8|private/i.test(r.key) ? (r.value ? '__SET__' : '') : r.value; } res.json(o); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings', async (req, res) => {
  const b = req.body || {};
  try { for (const [k, v] of Object.entries(b)) { if (v === '__SET__') continue; await pool.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, String(v == null ? '' : v)]); } res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ai-agents', async (req, res) => {
  try { const { rows } = await pool.query('SELECT id,name,exten,greeting,system_prompt,voice,provider,model,enabled,sales_exten,support_exten,default_exten,crm_webhook,greeting_text FROM pbxng_ai_agents ORDER BY id'); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ai-agents', async (req, res) => {
  const { name, exten, greeting = 'demo-congrats', system_prompt = '', voice = 'es-ES', provider = 'openai', model = 'gpt-4o-mini', enabled = true, sales_exten = '', support_exten = '', default_exten = '', crm_webhook = '', greeting_text = '' } = req.body || {};
  if (!name || !exten) return res.status(400).json({ error: 'name y exten son obligatorios' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('INSERT INTO pbxng_ai_agents (name,exten,greeting,system_prompt,voice,provider,model,enabled,sales_exten,support_exten,default_exten,crm_webhook,greeting_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id', [name, exten, greeting, system_prompt, voice, provider, model, enabled, sales_exten, support_exten, default_exten, crm_webhook, greeting_text]);
    await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [exten]);
    for (const r of aiAgentDialplan(exten, rows[0].id)) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
    await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: rows[0].id, exten });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.put('/api/ai-agents/:id', async (req, res) => {
  const { id } = req.params;
  const { name, exten, greeting = 'demo-congrats', system_prompt = '', voice = 'es-ES', provider = 'openai', model = 'gpt-4o-mini', enabled = true, sales_exten = '', support_exten = '', default_exten = '', crm_webhook = '', greeting_text = '' } = req.body || {};
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: old } = await c.query('SELECT exten FROM pbxng_ai_agents WHERE id=$1', [id]);
    if (!old[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'agente no existe' }); }
    await c.query('UPDATE pbxng_ai_agents SET name=$1,exten=$2,greeting=$3,system_prompt=$4,voice=$5,provider=$6,model=$7,enabled=$8,sales_exten=$10,support_exten=$11,default_exten=$12,crm_webhook=$13,greeting_text=$14 WHERE id=$9', [name, exten, greeting, system_prompt, voice, provider, model, enabled, id, sales_exten, support_exten, default_exten, crm_webhook, greeting_text]);
    await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [old[0].exten]);
    if (exten !== old[0].exten) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [exten]);
    for (const r of aiAgentDialplan(exten, id)) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
    await c.query('COMMIT'); broadcastSoon(); res.json({ updated: id, exten });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.delete('/api/ai-agents/:id', async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT exten FROM pbxng_ai_agents WHERE id=$1', [req.params.id]);
    if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].exten]);
    await c.query('DELETE FROM pbxng_ai_agents WHERE id=$1', [req.params.id]);
    await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: req.params.id });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

app.get('/api/ivr', async (req, res) => {
  try { const { rows: ivrs } = await pool.query('SELECT id,name,exten,greeting,timeout,tenant_id,flow FROM pbxng_ivr ORDER BY id'); for (const iv of ivrs) { const { rows: o } = await pool.query('SELECT digit,dest_type,dest_value FROM pbxng_ivr_options WHERE ivr_id=$1 ORDER BY digit', [iv.id]); iv.options = o; } res.json(ivrs); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
function buildIvrDialplan(exten, greeting, timeout, options) {
  const rows = [['ivr', exten, 1, 'Answer', ''], ['ivr', exten, 2, 'Read', `SEL,${greeting},1,,1,${timeout}`]];
  options.forEach((o, i) => rows.push(['ivr', exten, 3 + i, 'GotoIf', `$["\${SEL}"="${o.digit}"]?${100 + i * 10}`]));
  rows.push(['ivr', exten, 3 + options.length, 'Goto', `${exten},2`]);
  options.forEach((o, i) => {
    const b = 100 + i * 10; const v = o.dest_value;
    rows.push(['ivr', exten, b, 'NoOp', `Opcion ${o.digit} -> ${o.dest_type}:${v || ''}`]);
    if (o.dest_type === 'extension') { rows.push(['ivr', exten, b + 1, 'Dial', `PJSIP/${v},30`]); rows.push(['ivr', exten, b + 2, 'Hangup', '']); }
    else if (o.dest_type === 'ringgroup') rows.push(['ivr', exten, b + 1, 'Goto', `internal,${v},1`]);
    else if (o.dest_type === 'queue') { rows.push(['ivr', exten, b + 1, 'Queue', v]); rows.push(['ivr', exten, b + 2, 'Hangup', '']); }
    else if (o.dest_type === 'voicemail') { rows.push(['ivr', exten, b + 1, 'VoiceMail', `${v}@default,u`]); rows.push(['ivr', exten, b + 2, 'Hangup', '']); }
    else if (o.dest_type === 'ivr' || o.dest_type === 'ai') rows.push(['ivr', exten, b + 1, 'Goto', `ivr,${v},1`]);
    else rows.push(['ivr', exten, b + 1, 'Hangup', '']);
  });
  return rows;
}
app.post('/api/ivr', async (req, res) => {
  const { name, exten, greeting = 'demo-congrats', timeout = 10, options = [], tenant_id = 1, flow = null } = req.body || {};
  if (!name || !exten) return res.status(400).json({ error: 'name y exten son obligatorios' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('INSERT INTO pbxng_ivr (name,exten,greeting,timeout,tenant_id,flow) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [name, exten, greeting, timeout, tenant_id, flow]);
    const id = rows[0].id;
    for (const o of options) await c.query('INSERT INTO pbxng_ivr_options (ivr_id,digit,dest_type,dest_value) VALUES ($1,$2,$3,$4)', [id, o.digit, o.dest_type, o.dest_value]);
    await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [exten]);
    for (const r of buildIvrDialplan(exten, greeting, timeout, options)) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
    await c.query('COMMIT'); res.status(201).json({ created: id, exten });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.put('/api/ivr/:id', async (req, res) => {
  const { id } = req.params;
  const { name, exten, greeting = 'demo-congrats', timeout = 10, options = [], flow = null } = req.body || {};
  if (!name || !exten) return res.status(400).json({ error: 'name y exten son obligatorios' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: old } = await c.query('SELECT exten FROM pbxng_ivr WHERE id=$1', [id]);
    if (!old[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'IVR no existe' }); }
    await c.query('UPDATE pbxng_ivr SET name=$1,exten=$2,greeting=$3,timeout=$4,flow=$5 WHERE id=$6', [name, exten, greeting, timeout, flow, id]);
    await c.query('DELETE FROM pbxng_ivr_options WHERE ivr_id=$1', [id]);
    for (const o of options) await c.query('INSERT INTO pbxng_ivr_options (ivr_id,digit,dest_type,dest_value) VALUES ($1,$2,$3,$4)', [id, o.digit, o.dest_type, o.dest_value]);
    await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [old[0].exten]);
    if (exten !== old[0].exten) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [exten]);
    for (const r of buildIvrDialplan(exten, greeting, timeout, options)) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
    await c.query('COMMIT'); broadcastSoon(); res.json({ updated: id, exten });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

app.delete('/api/ivr/:id', async (req, res) => {
  const { id } = req.params; const c = await pool.connect();
  try { await c.query('BEGIN'); const { rows } = await c.query('SELECT exten FROM pbxng_ivr WHERE id=$1', [id]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].exten]); await c.query('DELETE FROM pbxng_ivr WHERE id=$1', [id]); await c.query('COMMIT'); res.json({ deleted: id }); }
  catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});

app.get('/api/queues', async (req, res) => { try { res.json(await getQueues()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/queues', async (req, res) => {
  const { name, label, access_exten, strategy = 'ringall', timeout = 15, musiconhold = 'default', tenant_id = 1 } = req.body || {};
  if (!name || !access_exten) return res.status(400).json({ error: 'name y access_exten son obligatorios' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('INSERT INTO queues (name,strategy,timeout,musiconhold,maxlen,retry) VALUES ($1,$2,$3,$4,0,5)', [name, strategy, timeout, musiconhold]);
    await c.query('INSERT INTO pbxng_queues (name,label,access_exten,tenant_id) VALUES ($1,$2,$3,$4)', [name, label || name, access_exten, tenant_id]);
    await setDialplan(c, 'ivr', access_exten, [[1, 'Answer', ''], [2, 'Queue', name], [3, 'Hangup', '']]);
    await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: name, access_exten });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.delete('/api/queues/:name', async (req, res) => {
  const { name } = req.params; const c = await pool.connect();
  try { await c.query('BEGIN'); const { rows } = await c.query('SELECT access_exten FROM pbxng_queues WHERE name=$1', [name]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].access_exten]); await c.query('DELETE FROM queue_members WHERE queue_name=$1', [name]); await c.query('DELETE FROM queues WHERE name=$1', [name]); await c.query('DELETE FROM pbxng_queues WHERE name=$1', [name]); await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: name }); }
  catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.post('/api/queues/:name/members', async (req, res) => {
  const { name } = req.params; const { ext } = req.body || {};
  if (!ext) return res.status(400).json({ error: 'ext es obligatorio' });
  try { await pool.query(`INSERT INTO queue_members (queue_name,interface,membername,state_interface,penalty,paused,uniqueid) VALUES ($1,$2,$3,$2,0,0,(SELECT COALESCE(MAX(uniqueid),0)+1 FROM queue_members)) ON CONFLICT (queue_name,interface) DO NOTHING`, [name, 'PJSIP/' + ext, ext]); broadcastSoon(); res.status(201).json({ added: ext }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/queues/:name/members/:ext', async (req, res) => { const { name, ext } = req.params; try { await pool.query('DELETE FROM queue_members WHERE queue_name=$1 AND interface=$2', [name, 'PJSIP/' + ext]); broadcastSoon(); res.json({ removed: ext }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/queues/:name/live', async (req, res) => { try { res.json({ output: await amiCommand('queue show ' + req.params.name) }); } catch (e) { res.status(500).json({ error: e.message }); } });

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

app.get('/api/cdr', async (req, res) => { const limit = Math.min(+(req.query.limit || 100), 500); try { const { rows } = await pool.query("SELECT start, clid, src, dst, dcontext, duration, billsec, disposition, channel, dstchannel, lastapp, lastdata FROM cdr ORDER BY start DESC LIMIT $1", [limit]); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/conferences', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,label,access_exten,pin FROM pbxng_conferences ORDER BY id'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/conferences', async (req, res) => {
  const { name, label, access_exten, pin } = req.body || {};
  if (!name || !access_exten) return res.status(400).json({ error: 'name y access_exten son obligatorios' });
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('INSERT INTO pbxng_conferences (name,label,access_exten,pin) VALUES ($1,$2,$3,$4)', [name, label || name, access_exten, pin || null]); const rows = [[1, 'Answer', '']]; let p = 2; if (pin) rows.push([p++, 'Authenticate', String(pin)]); rows.push([p++, 'ConfBridge', name]); rows.push([p++, 'Hangup', '']); await setDialplan(c, 'ivr', access_exten, rows); await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: name, access_exten }); }
  catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.delete('/api/conferences/:name', async (req, res) => { const { name } = req.params; const c = await pool.connect(); try { await c.query('BEGIN'); const { rows } = await c.query('SELECT access_exten FROM pbxng_conferences WHERE name=$1', [name]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].access_exten]); await c.query('DELETE FROM pbxng_conferences WHERE name=$1', [name]); await c.query('COMMIT'); res.json({ deleted: name }); } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); } });

app.get('/api/ringgroups', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,label,access_exten,members,strategy,ring_time FROM pbxng_ringgroups ORDER BY id'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/ringgroups', async (req, res) => {
  const { name, label, access_exten, members, strategy = 'ringall', ring_time = 25 } = req.body || {};
  if (!name || !access_exten || !members) return res.status(400).json({ error: 'name, access_exten y members son obligatorios' });
  const list = String(members).split(',').map(s => s.trim()).filter(Boolean); const dialStr = list.map(e => 'PJSIP/' + e).join('&');
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('INSERT INTO pbxng_ringgroups (name,label,access_exten,members,strategy,ring_time) VALUES ($1,$2,$3,$4,$5,$6)', [name, label || name, access_exten, list.join(','), strategy, ring_time]); await setDialplan(c, 'ivr', access_exten, [[1, 'NoOp', 'Ring group ' + name], [2, 'Dial', dialStr + ',' + ring_time], [3, 'Hangup', '']]); await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: name }); }
  catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.delete('/api/ringgroups/:name', async (req, res) => { const { name } = req.params; const c = await pool.connect(); try { await c.query('BEGIN'); const { rows } = await c.query('SELECT access_exten FROM pbxng_ringgroups WHERE name=$1', [name]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].access_exten]); await c.query('DELETE FROM pbxng_ringgroups WHERE name=$1', [name]); await c.query('COMMIT'); res.json({ deleted: name }); } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); } });

app.get('/api/paging', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,label,access_exten,members FROM pbxng_paging ORDER BY id'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/paging', async (req, res) => {
  const { name, label, access_exten, members } = req.body || {};
  if (!name || !access_exten || !members) return res.status(400).json({ error: 'name, access_exten y members son obligatorios' });
  const list = String(members).split(',').map(s => s.trim()).filter(Boolean); const pageStr = list.map(e => 'PJSIP/' + e).join('&');
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('INSERT INTO pbxng_paging (name,label,access_exten,members) VALUES ($1,$2,$3,$4)', [name, label || name, access_exten, list.join(',')]); await setDialplan(c, 'ivr', access_exten, [[1, 'NoOp', 'Paging ' + name], [2, 'Page', pageStr + ',i'], [3, 'Hangup', '']]); await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: name }); }
  catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.delete('/api/paging/:name', async (req, res) => { const { name } = req.params; const c = await pool.connect(); try { await c.query('BEGIN'); const { rows } = await c.query('SELECT access_exten FROM pbxng_paging WHERE name=$1', [name]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].access_exten]); await c.query('DELETE FROM pbxng_paging WHERE name=$1', [name]); await c.query('COMMIT'); res.json({ deleted: name }); } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); } });

app.get('/api/mailboxes', async (req, res) => { try { const { rows } = await pool.query("SELECT mailbox,fullname,email FROM pbxng_mailboxes ORDER BY mailbox"); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/mailboxes', async (req, res) => {
  const { mailbox, password, fullname, email, context = 'default' } = req.body || {};
  if (!mailbox || !password) return res.status(400).json({ error: 'mailbox y password son obligatorios' });
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query("INSERT INTO voicemail (mailbox,context,password,fullname,email) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [mailbox, context, String(password), fullname || mailbox, email || null]); await c.query("INSERT INTO pbxng_mailboxes (mailbox,fullname,email) VALUES ($1,$2,$3) ON CONFLICT (mailbox) DO UPDATE SET fullname=EXCLUDED.fullname,email=EXCLUDED.email", [mailbox, fullname || mailbox, email || null]); await c.query('COMMIT'); res.status(201).json({ created: mailbox }); }
  catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.delete('/api/mailboxes/:mailbox', async (req, res) => { const { mailbox } = req.params; const c = await pool.connect(); try { await c.query('BEGIN'); await c.query('DELETE FROM voicemail WHERE mailbox=$1', [mailbox]); await c.query('DELETE FROM pbxng_mailboxes WHERE mailbox=$1', [mailbox]); await c.query('COMMIT'); res.json({ deleted: mailbox }); } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); } });

const FEATURE_CODES = [
  { code: '*43', name: 'Prueba de eco', desc: 'Repite tu voz para probar audio', rows: [[1, 'Answer', ''], [2, 'Echo', ''], [3, 'Hangup', '']] },
  { code: '*65', name: 'Decir mi número', desc: 'Locuta el número del interno', rows: [[1, 'Answer', ''], [2, 'SayDigits', '${CALLERID(num)}'], [3, 'Hangup', '']] },
  { code: '*97', name: 'Mi buzón de voz', desc: 'Entra al buzón del interno que llama', rows: [[1, 'Answer', ''], [2, 'VoiceMailMain', '${CALLERID(num)}@default'], [3, 'Hangup', '']] },
  { code: '*98', name: 'Buzón (otro)', desc: 'Pide número de buzón y PIN', rows: [[1, 'Answer', ''], [2, 'VoiceMailMain', ''], [3, 'Hangup', '']] },
];
app.get('/api/featurecodes', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT exten FROM extensions WHERE context='internal' AND exten = ANY($1)", [FEATURE_CODES.map(f => f.code)]);
    const installed = new Set(rows.map(r => r.exten));
    res.json(FEATURE_CODES.map(f => ({ code: f.code, name: f.name, desc: f.desc, installed: installed.has(f.code) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/featurecodes/install', async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const f of FEATURE_CODES) await setDialplan(c, 'internal', f.code, f.rows);
    await c.query('COMMIT'); broadcastSoon(); res.json({ ok: true, count: FEATURE_CODES.length });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ error: e.message }); } finally { c.release(); }
});
app.post('/api/featurecodes/uninstall', async (req, res) => {
  try { await pool.query("DELETE FROM extensions WHERE context='internal' AND exten = ANY($1)", [FEATURE_CODES.map(f => f.code)]); broadcastSoon(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/dialplan', async (req, res) => { const ctx = req.query.context; try { res.json({ output: await amiCommand('dialplan show' + (ctx ? ' ' + ctx : '')) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/channels', async (req, res) => { try { res.json(await getChannels()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/tenants', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,slug,context_prefix,active FROM tenants ORDER BY id'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });

// ---------------- SBC (Kamailio) ----------------
app.get('/api/sbc', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT version, uptime, dispatcher, banned, rtpengine, stats, extract(epoch from (now()-updated_at))::int AS age_s FROM pbxng_sbc WHERE id=1");
    res.json(rows[0] || { error: 'sin datos' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/sbc/cfg', async (req, res) => {
  try { const { rows } = await pool.query("SELECT cfg_content FROM pbxng_sbc WHERE id=1"); res.json({ cfg: (rows[0] && rows[0].cfg_content) || '' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Comando genérico al SBC (lo aplica el agente). cmd + arg opcional.
const SBC_CMDS = ['reload', 'unban_all', 'unban', 'ban', 'debug', 'disable_target', 'enable_target', 'add_target', 'del_target', 'restart', 'cfg_save', 'route_add', 'route_del'];
app.post('/api/sbc/cmd', async (req, res) => {
  const { cmd, arg } = req.body || {};
  if (!SBC_CMDS.includes(cmd)) return res.status(400).json({ error: 'comando inválido' });
  try { const { rows } = await pool.query("INSERT INTO pbxng_sbc_cmd (cmd, arg) VALUES ($1,$2) RETURNING id", [cmd, arg != null ? String(arg) : null]); res.json({ id: rows[0].id }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/sbc/cmd/:id', async (req, res) => {
  try { const { rows } = await pool.query("SELECT id, cmd, done, result FROM pbxng_sbc_cmd WHERE id=$1", [req.params.id]); res.json(rows[0] || { error: 'no existe' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// --- SBC rutas estaticas / multi-WAN ---
app.get('/api/sbc/routes', async (req, res) => {
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS pbxng_sbc_routes (id serial PRIMARY KEY, dest text, gw text, dev text, note text, created_at timestamptz DEFAULT now())");
    const { rows } = await pool.query("SELECT id, dest, gw, dev, note, created_at FROM pbxng_sbc_routes ORDER BY id");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sbc/routes', async (req, res) => {
  const { dest, gw, dev, note } = req.body || {};
  if (!dest || !String(dest).trim()) return res.status(400).json({ error: 'destino requerido' });
  if (!String(gw).trim() && !String(dev).trim()) return res.status(400).json({ error: 'indique gateway o interfaz' });
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS pbxng_sbc_routes (id serial PRIMARY KEY, dest text, gw text, dev text, note text, created_at timestamptz DEFAULT now())");
    const { rows } = await pool.query("INSERT INTO pbxng_sbc_routes (dest, gw, dev, note) VALUES ($1,$2,$3,$4) RETURNING id", [String(dest).trim(), String(gw || '').trim() || null, String(dev || '').trim() || null, String(note || '').trim() || null]);
    const arg = [String(dest).trim(), String(gw || '').trim(), String(dev || '').trim()].join('|');
    await pool.query("INSERT INTO pbxng_sbc_cmd (cmd, arg) VALUES ('route_add', $1)", [arg]);
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sbc/routes/remove', async (req, res) => {
  const { id } = req.body || {};
  if (id == null) return res.status(400).json({ error: 'id requerido' });
  try {
    const { rows } = await pool.query("SELECT dest FROM pbxng_sbc_routes WHERE id=$1", [id]);
    if (rows[0]) {
      await pool.query("DELETE FROM pbxng_sbc_routes WHERE id=$1", [id]);
      await pool.query("INSERT INTO pbxng_sbc_cmd (cmd, arg) VALUES ('route_del', $1)", [rows[0].dest]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- SIP capture (debug tipo sngrep) ---
app.get('/api/sip/messages', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS pbxng_sip_capture (id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), host text, src text, dst text, method text, status int, callid text, cseq text, from_uri text, to_uri text, ruri text, raw text)");
    const { rows } = await pool.query("SELECT id, extract(epoch from ts)*1000 AS t, host, src, dst, method, status, callid, cseq, from_uri, to_uri, ruri FROM (SELECT * FROM pbxng_sip_capture ORDER BY id DESC LIMIT $1) q ORDER BY id ASC", [limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/sip/raw/:id', async (req, res) => {
  try { const { rows } = await pool.query("SELECT raw FROM pbxng_sip_capture WHERE id=$1", [req.params.id]); res.json({ raw: rows[0] ? rows[0].raw : '' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sip/clear', async (req, res) => {
  try { await pool.query("DELETE FROM pbxng_sip_capture"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/sbc/secfilter', async (req, res) => { try { const { rows } = await pool.query('SELECT id, action, type, data FROM secfilter ORDER BY action, type, data'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/sbc/secfilter', async (req, res) => { const b = req.body || {}; if (!b.data) return res.status(400).json({ error: 'falta data' }); try { await pool.query('INSERT INTO secfilter(action,type,data) VALUES($1,$2,$3) ON CONFLICT (action,type,data) DO NOTHING', [(+b.action ? 1 : 0), (+b.type || 0), String(b.data).trim()]); await pool.query("INSERT INTO pbxng_sbc_cmd (cmd) VALUES ('secf_reload')"); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/sbc/secfilter/:id', async (req, res) => { try { await pool.query('DELETE FROM secfilter WHERE id=$1', [+req.params.id]); await pool.query("INSERT INTO pbxng_sbc_cmd (cmd) VALUES ('secf_reload')"); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
// --- LCR / drouting (operadores + reglas de ruteo) ---
app.get('/api/sbc/lcr/gateways', async (req, res) => { try { const { rows } = await pool.query('SELECT gwid, type, address, strip, pri_prefix, description FROM dr_gateways ORDER BY gwid'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/sbc/lcr/gateways', async (req, res) => { const b = req.body || {}; if (!b.address) return res.status(400).json({ error: 'falta address' }); try { const { rows } = await pool.query('INSERT INTO dr_gateways(type,address,strip,pri_prefix,description) VALUES($1,$2,$3,$4,$5) RETURNING gwid', [(+b.type||0), String(b.address).trim(), (+b.strip||0), (b.pri_prefix?String(b.pri_prefix).trim():null), String(b.description||'')]); await pool.query("INSERT INTO pbxng_sbc_cmd (cmd) VALUES ('dr_reload')"); res.json({ ok: true, gwid: rows[0].gwid }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/sbc/lcr/gateways/:gwid', async (req, res) => { try { await pool.query('DELETE FROM dr_gateways WHERE gwid=$1', [+req.params.gwid]); await pool.query("INSERT INTO pbxng_sbc_cmd (cmd) VALUES ('dr_reload')"); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/sbc/lcr/rules', async (req, res) => { try { const { rows } = await pool.query('SELECT ruleid, groupid, prefix, gwlist, priority, description FROM dr_rules ORDER BY priority, ruleid'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/sbc/lcr/rules', async (req, res) => { const b = req.body || {}; if (!b.gwlist) return res.status(400).json({ error: 'falta gwlist' }); try { const { rows } = await pool.query("INSERT INTO dr_rules(groupid,prefix,timerec,priority,routeid,gwlist,description) VALUES($1,$2,'',$3,'',$4,$5) RETURNING ruleid", [String(b.groupid||'0'), String(b.prefix||''), (+b.priority||0), String(b.gwlist).trim(), String(b.description||'')]); await pool.query("INSERT INTO pbxng_sbc_cmd (cmd) VALUES ('dr_reload')"); res.json({ ok: true, ruleid: rows[0].ruleid }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/sbc/lcr/rules/:ruleid', async (req, res) => { try { await pool.query('DELETE FROM dr_rules WHERE ruleid=$1', [+req.params.ruleid]); await pool.query("INSERT INTO pbxng_sbc_cmd (cmd) VALUES ('dr_reload')"); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/sbc/reload', async (req, res) => {
  try { await pool.query("INSERT INTO pbxng_sbc_cmd (cmd) VALUES ('reload')"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sbc/unban', async (req, res) => {
  try { await pool.query("INSERT INTO pbxng_sbc_cmd (cmd) VALUES ('unban')"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
let busy = false, deb = null;
async function broadcast() { if (busy) return; busy = true; try { io.to('state').emit('snapshot', await snapshot()); } catch (e) {} finally { busy = false; } }
function broadcastSoon() { clearTimeout(deb); deb = setTimeout(broadcast, 300); }
io.use((socket, next) => {
  try { const t = socket.handshake.auth && socket.handshake.auth.token; socket.user = jwt.verify(t, SECRET); next(); }
  catch (e) {
    // Conexión limitada a la pizarra (PWA softphone sin JWT de dashboard): sin acceso al estado.
    if (socket.handshake.auth && socket.handshake.auth.scratch) { socket.scratchOnly = true; next(); }
    else next(new Error('unauthorized'));
  }
});
io.on('connection', async (s) => {
  if (!s.scratchOnly) { s.join('state'); try { s.emit('snapshot', await snapshot()); } catch (_) {} }
  // Pizarra compartida en videollamada (relay por sala = par de internos)
  s.on('scratch:join', (room) => { if (room) s.join('scratch:' + room); });
  s.on('scratch:leave', (room) => { if (room) s.leave('scratch:' + room); });
  s.on('scratch:op', (m) => { if (m && m.room) s.to('scratch:' + m.room).emit('scratch:op', m.op); });
  s.on('scratch:clear', (m) => { if (m && m.room) s.to('scratch:' + m.room).emit('scratch:clear'); });
});
setInterval(broadcast, 3000);
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

server.listen(CFG.port, '0.0.0.0', () => console.log('[API] PBX-NG (socket.io) en :%d', CFG.port));
