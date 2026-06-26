'use strict';
// ============================================================
//  PBX-NG · Push multi-proveedor (RFC 8599)
//  webpush (VAPID, en app.js) + FCM HTTP v1 + APNs HTTP/2 (VoIP).
//  Credenciales en pbxng_settings (gated): si no hay, no envía nada.
// ============================================================
const crypto = require('crypto');
const http2 = require('http2');

let POOL = null;
function init(pool) {
  POOL = pool;
  pool.query("CREATE TABLE IF NOT EXISTS pbxng_push_devices (id serial PRIMARY KEY, ext text, provider text, prid text, param text, topic text, ua text, updated_at timestamptz DEFAULT now(), UNIQUE(provider,prid))").catch(e => console.error('[PUSH] devices table', e.message));
}
async function getSetting(k) { try { const { rows } = await POOL.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value || ''; } catch (_) { return ''; } }
const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

// ---------------- FCM HTTP v1 ----------------
let fcmTok = null, fcmExp = 0;
async function fcmAccessToken(sa) {
  if (fcmTok && Date.now() < fcmExp - 60000) return fcmTok;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const jwt = unsigned + '.' + sig;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt });
  const j = await r.json(); if (!j.access_token) throw new Error('fcm token: ' + (j.error || 'sin token'));
  fcmTok = j.access_token; fcmExp = Date.now() + (j.expires_in || 3600) * 1000; return fcmTok;
}
async function fcmSend(devices, payload) {
  const raw = await getSetting('fcm_service_account'); if (!raw) return 0;
  let sa; try { sa = JSON.parse(raw); } catch (_) { return 0; }
  let token; try { token = await fcmAccessToken(sa); } catch (e) { console.error('[PUSH] fcm auth', e.message); return 0; }
  let sent = 0;
  for (const d of devices) {
    try {
      const r = await fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { token: d.prid, data: { type: 'call', title: String(payload.title || 'Llamada entrante'), body: String(payload.body || ''), from: String(payload.from || ''), ext: String(payload.ext || '') }, android: { priority: 'high' } } }) });
      if (r.ok) sent++; else { const t = await r.text(); if (/UNREGISTERED|NotRegistered|InvalidArgument|InvalidRegistration/i.test(t)) await POOL.query('DELETE FROM pbxng_push_devices WHERE id=$1', [d.id]).catch(() => {}); }
    } catch (_) {}
  }
  return sent;
}

// ---------------- APNs HTTP/2 (VoIP) ----------------
let apnsJwt = null, apnsJwtAt = 0;
async function apnsToken() {
  const p8 = await getSetting('apns_key_p8'), kid = await getSetting('apns_key_id'), team = await getSetting('apns_team_id');
  if (!p8 || !kid || !team) return null;
  if (apnsJwt && Date.now() - apnsJwtAt < 3000000) return apnsJwt;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url({ alg: 'ES256', kid }) + '.' + b64url({ iss: team, iat: now });
  const sig = crypto.sign('SHA256', Buffer.from(unsigned), { key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  apnsJwt = unsigned + '.' + sig; apnsJwtAt = Date.now(); return apnsJwt;
}
async function apnsSend(devices, payload) {
  const jwt = await apnsToken(); if (!jwt) return 0;
  const defTopic = await getSetting('apns_topic');
  const prod = (await getSetting('apns_prod')) === '1';
  const host = prod ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  let sent = 0;
  for (const d of devices) {
    try {
      const client = http2.connect(host);
      client.on('error', () => {});
      const body = JSON.stringify({ aps: { alert: { title: String(payload.title || 'Llamada'), body: String(payload.body || '') }, 'content-available': 1, sound: 'default' }, from: String(payload.from || ''), ext: String(payload.ext || '') });
      const req = client.request({ ':method': 'POST', ':path': '/3/device/' + d.prid, 'authorization': 'bearer ' + jwt, 'apns-topic': d.topic || defTopic || '', 'apns-push-type': 'voip', 'apns-priority': '10' });
      let status = 0; req.on('response', h => { status = h[':status']; });
      req.setEncoding('utf8'); req.on('data', () => {});
      await new Promise((res) => { let done = false; const fin = () => { if (!done) { done = true; try { client.close(); } catch (_) {} res(); } }; req.on('end', fin); req.on('error', fin); req.end(body); setTimeout(fin, 4000); });
      if (status === 200) sent++; else if (status === 410) await POOL.query('DELETE FROM pbxng_push_devices WHERE id=$1', [d.id]).catch(() => {});
    } catch (_) {}
  }
  return sent;
}

// ---------------- RFC 8599: parsear pn-* del Contact registrado ----------------
async function devicesFromContacts(ext) {
  try {
    const { rows } = await POOL.query("SELECT uri FROM ps_contacts WHERE endpoint=$1 OR id LIKE $2", [String(ext), String(ext) + ';%']);
    const out = [];
    for (const c of rows) {
      const u = c.uri || '';
      const prov = (u.match(/pn-provider=([^;>]+)/) || [])[1];
      const prid = (u.match(/pn-prid=([^;>]+)/) || [])[1];
      if (!prov || !prid) continue;
      const param = (u.match(/pn-param=([^;>]+)/) || [])[1];
      const provider = /apns/i.test(prov) ? 'apns' : /fcm|firebase|gcm/i.test(prov) ? 'fcm' : prov;
      out.push({ id: 0, provider, prid: decodeURIComponent(prid), param: param ? decodeURIComponent(param) : null, topic: param ? decodeURIComponent(param) : null });
    }
    return out;
  } catch (_) { return []; }
}

async function sendNative(ext, payload) {
  try {
    const { rows } = await POOL.query("SELECT id,provider,prid,param,topic FROM pbxng_push_devices WHERE ext=$1", [String(ext)]);
    const fromContacts = await devicesFromContacts(ext);
    const all = rows.concat(fromContacts);
    const fcm = all.filter(d => d.provider === 'fcm');
    const apns = all.filter(d => d.provider === 'apns');
    let n = 0;
    if (fcm.length) n += await fcmSend(fcm, payload);
    if (apns.length) n += await apnsSend(apns, payload);
    return n;
  } catch (e) { console.error('[PUSH] native', e.message); return 0; }
}
async function registerDevice(ext, provider, prid, param, topic, ua) {
  if (!ext || !provider || !prid) throw new Error('faltan datos');
  await POOL.query("INSERT INTO pbxng_push_devices (ext,provider,prid,param,topic,ua,updated_at) VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (provider,prid) DO UPDATE SET ext=$1,param=$4,topic=$5,ua=$6,updated_at=now()", [String(ext), provider, prid, param || null, topic || null, ua || null]);
}
async function listDevices() {
  const { rows } = await POOL.query("SELECT id,ext,provider,param,topic,ua,updated_at, substr(prid,1,14) AS prid_head FROM pbxng_push_devices ORDER BY updated_at DESC LIMIT 300");
  return rows;
}
async function providerStatus() {
  const fcm = !!(await getSetting('fcm_service_account'));
  const apns = !!(await getSetting('apns_key_p8') && await getSetting('apns_key_id') && await getSetting('apns_team_id'));
  return { fcm, apns };
}

module.exports = { init, sendNative, registerDevice, listDevices, providerStatus };
