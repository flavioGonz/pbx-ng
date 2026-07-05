'use strict';
/*
 * PBX-NG wsbridge — cliente SIP-over-WSS (RFC 7118) hacia troncales WebRTC remotas.
 *   Iter.1: conecta WSS + REGISTER (digest) + reporta estado.
 *   Iter.2: B2BUA — relay de INVITE/ACK/BYE entre el remoto (WSS, DTLS-SRTP) y Asterisk
 *           (UDP, RTP), con media anclada por rtpengine (ng-protocol 127.0.0.1:2223).
 *   Gateado por pbxng_settings.mod_wsbridge. Troncales pbxng_trunks kind='webrtc-client'.
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const dgram = require('dgram');
const { Client } = require('pg');

const DB = {
  host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'pbxng', user: process.env.DB_USER || 'pbxng', password: process.env.DB_PASS || '',
};
const AST_HOST = process.env.ASTERISK_HOST || process.env.KAM_HOST || '192.168.99.10';
const AST_PORT = +(process.env.AST_PORT || 5060);
const RTPE_HOST = process.env.RTPE_HOST || '127.0.0.1';
const RTPE_PORT = +(process.env.RTPE_PORT || 2223);
const LOCAL_SIP_PORT = +(process.env.LOCAL_SIP_PORT || 5090); // puerto propio del bridge (NO 5060, lo usa Kamailio)
let LOCAL_IP = process.env.LOCAL_IP || '127.0.0.1';
const POLL_MS = 6000;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const rnd = (n = 8) => crypto.randomBytes(n).toString('hex').slice(0, n);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- bencode (rtpengine ng) ----------
function bencode(o) {
  if (typeof o === 'number') return 'i' + o + 'e';
  if (typeof o === 'string') return Buffer.byteLength(o) + ':' + o;
  if (Array.isArray(o)) return 'l' + o.map(bencode).join('') + 'e';
  if (o && typeof o === 'object') { let s = 'd'; for (const k of Object.keys(o).sort()) s += bencode(k) + bencode(o[k]); return s + 'e'; }
  return '0:';
}
function bdecode(s) {
  let i = 0;
  function val() {
    const c = s[i];
    if (c === 'i') { const e = s.indexOf('e', i); const n = parseInt(s.slice(i + 1, e), 10); i = e + 1; return n; }
    if (c === 'l') { i++; const a = []; while (s[i] !== 'e') a.push(val()); i++; return a; }
    if (c === 'd') { i++; const d = {}; while (s[i] !== 'e') { const k = val(); d[k] = val(); } i++; return d; }
    const col = s.indexOf(':', i); const len = parseInt(s.slice(i, col), 10); const str = s.slice(col + 1, col + 1 + len); i = col + 1 + len; return str;
  }
  return val();
}
// cliente ng: 1 socket, cookie por request
const rtpeSock = dgram.createSocket('udp4');
const rtpePending = new Map();
rtpeSock.on('message', (msg) => {
  const str = msg.toString('binary'); const sp = str.indexOf(' ');
  const cookie = str.slice(0, sp); const body = str.slice(sp + 1);
  const p = rtpePending.get(cookie);
  if (p) { rtpePending.delete(cookie); try { p.resolve(bdecode(body)); } catch (e) { p.resolve({ result: 'error', 'error-reason': e.message }); } }
});
function rtpe(cmd) {
  return new Promise((resolve) => {
    const cookie = rnd(10);
    const payload = cookie + ' ' + bencode(cmd);
    const timer = setTimeout(() => { rtpePending.delete(cookie); resolve({ result: 'timeout' }); }, 3000);
    rtpePending.set(cookie, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
    rtpeSock.send(Buffer.from(payload, 'binary'), RTPE_PORT, RTPE_HOST);
  });
}

// ---------- SIP mínimo ----------
function parseSip(msg) {
  const idx = msg.indexOf('\r\n\r\n');
  const head = idx >= 0 ? msg.slice(0, idx) : msg;
  const body = idx >= 0 ? msg.slice(idx + 4) : '';
  const lines = head.split('\r\n');
  const start = lines[0]; const headers = {};
  for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i < 0) continue; const k = l.slice(0, i).trim().toLowerCase(); const v = l.slice(i + 1).trim(); headers[k] = headers[k] !== undefined ? headers[k] + ',' + v : v; }
  let status = null, method = null, ruri = null;
  if (/^SIP\/2\.0/.test(start)) status = parseInt(start.split(' ')[1], 10);
  else { const pr = start.split(' '); method = pr[0]; ruri = pr[1]; }
  return { start, method, status, ruri, headers, body };
}
function parseAuth(h) { const out = {}; for (const m of h.replace(/^\w+\s+/, '').matchAll(/(\w+)=("([^"]*)"|[^,]*)/g)) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2]; return out; }
const userOf = (h) => { const m = String(h || '').match(/sips?:([^@>;\s]+)/i); return m ? m[1] : ''; };

// socket UDP hacia Asterisk (pata B del B2BUA)
const astSock = dgram.createSocket('udp4');
let astBound = false;
const b2b = new Map(); // callId remoto -> { legB info } (relay de dialogos)
astSock.on('message', (buf, rinfo) => {
  const msg = buf.toString(); const p = parseSip(msg);
  // respuestas de Asterisk (pata B) -> reenviar al remoto (pata A)
  const bctx = [...b2b.values()].find((x) => x.bCallId === (p.headers['call-id'] || ''));
  if (bctx) bctx.onAstMessage(p, msg);
});

class TrunkClient {
  constructor(t) {
    this.name = t.name; this.url = t.remote_url; this.user = t.username; this.pass = t.password;
    this.host = (this.url.match(/wss?:\/\/([^/:]+)/) || [])[1] || 'remote';
    this.ws = null; this.state = 'init'; this.detail = '';
    this.cseq = 1; this.callId = rnd(16) + '@wsbridge'; this.fromTag = rnd(8);
    this.localVia = rnd(12) + '.invalid'; this.regTimer = null; this.stop = false;
  }
  setState(s, d) { this.state = s; this.detail = d || ''; log(`[${this.name}] ${s} ${d || ''}`); }
  connect() {
    if (this.stop) return;
    try { this.ws = new WebSocket(this.url, ['sip'], { rejectUnauthorized: false, handshakeTimeout: 8000 }); }
    catch (e) { this.setState('error', 'ws ' + e.message); return this.retry(); }
    this.ws.on('open', () => { this.setState('connected', 'WSS abierto'); this.register(); });
    this.ws.on('message', (d) => this.onMessage(d.toString()));
    this.ws.on('close', () => { this.setState('offline', 'WSS cerrado'); this.retry(); });
    this.ws.on('error', (e) => this.setState('error', e.message));
  }
  retry() { if (this.stop) return; clearTimeout(this.regTimer); if (this.ws) { try { this.ws.removeAllListeners(); this.ws.terminate(); } catch (_) {} this.ws = null; } setTimeout(() => this.connect(), 5000); }
  send(m) { try { this.ws && this.ws.readyState === 1 && this.ws.send(m); } catch (_) {} }
  register(auth) {
    const uri = 'sip:' + this.host; const branch = 'z9hG4bK' + rnd(10);
    const L = [`REGISTER ${uri} SIP/2.0`, `Via: SIP/2.0/WSS ${this.localVia};branch=${branch};rport`, `Max-Forwards: 70`,
      `From: <sip:${this.user}@${this.host}>;tag=${this.fromTag}`, `To: <sip:${this.user}@${this.host}>`, `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} REGISTER`, `Contact: <sip:${this.user}@${this.localVia};transport=ws>;expires=600`, `Expires: 600`, `User-Agent: PBX-NG-wsbridge`];
    if (auth) L.push(auth);
    L.push('Content-Length: 0', '', ''); this.send(L.join('\r\n'));
  }
  onMessage(msg) {
    const p = parseSip(msg);
    if (p.method === 'OPTIONS') { return this.reply(p, 200, 'OK'); }
    if (p.status && /REGISTER/.test(p.headers['cseq'] || '')) return this.onRegisterResp(p);
    if (p.method === 'INVITE' && !(p.headers['to'] || '').includes('tag=')) return this.onInboundInvite(p, msg);
    if (p.method === 'ACK') { const ctx = b2b.get(p.headers['call-id']); if (ctx) ctx.onRemoteAck(p); return; }
    if (p.method === 'BYE') { const ctx = b2b.get(p.headers['call-id']); if (ctx) ctx.onRemoteBye(p); this.reply(p, 200, 'OK'); return; }
    if (p.method === 'CANCEL') { const ctx = b2b.get(p.headers['call-id']); if (ctx) ctx.onRemoteCancel(p); this.reply(p, 200, 'OK'); return; }
    if (p.status) { const ctx = [...b2b.values()].find((x) => x.aCallId === p.headers['call-id']); if (ctx) ctx.onRemoteResp(p); return; }
  }
  onRegisterResp(p) {
    if (p.status === 401 || p.status === 407) {
      const a = parseAuth(p.headers['www-authenticate'] || p.headers['proxy-authenticate'] || '');
      const uri = 'sip:' + this.host; const ha1 = md5(`${this.user}:${a.realm}:${this.pass}`); const ha2 = md5(`REGISTER:${uri}`);
      let resp, extra = '';
      if (a.qop) { const nc = '00000001', cn = rnd(8); resp = md5(`${ha1}:${a.nonce}:${nc}:${cn}:${a.qop}:${ha2}`); extra = `,qop=${a.qop},nc=${nc},cnonce="${cn}"`; }
      else resp = md5(`${ha1}:${a.nonce}:${ha2}`);
      const h = (p.status === 407 ? 'Proxy-Authorization' : 'Authorization') + `: Digest username="${this.user}",realm="${a.realm}",nonce="${a.nonce}",uri="${uri}",response="${resp}"${a.opaque ? `,opaque="${a.opaque}"` : ''}${extra}`;
      this.cseq++; this.register(h); this.setState('auth', 'autenticando'); return;
    }
    if (p.status >= 200 && p.status < 300) { this.setState('online', 'Registrada (WSS)'); this.cseq++; clearTimeout(this.regTimer); this.regTimer = setTimeout(() => this.register(), 270000); return; }
    this.setState('offline', 'Registro rechazado ' + p.status);
  }
  reply(p, code, reason, extra) {
    const L = [`SIP/2.0 ${code} ${reason}`, `Via: ${p.headers['via']}`, `From: ${p.headers['from']}`, `To: ${p.headers['to']}${(p.headers['to'] || '').includes('tag=') ? '' : ';tag=' + rnd(6)}`, `Call-ID: ${p.headers['call-id']}`, `CSeq: ${p.headers['cseq']}`];
    if (extra) for (const e of extra) L.push(e);
    L.push('Content-Length: 0', '', ''); this.send(L.join('\r\n'));
  }
  // ---- B2BUA: INVITE entrante del remoto -> rtpengine -> Asterisk ----
  async onInboundInvite(p, msg) {
    const callId = p.headers['call-id'];
    const target = userOf(p.ruri) || p.ruri; // número/DID que marca el remoto
    const fromTag = (p.headers['from'].match(/tag=([^;>\s]+)/) || [])[1] || rnd(8);
    log(`[${this.name}] INVITE entrante -> ${target} (call ${callId.slice(0, 12)})`);
    // 100 Trying al remoto
    this.reply(p, 100, 'Trying');
    // rtpengine offer: remoto WebRTC (DTLS/SRTP/ICE) -> RTP plano para Asterisk
    const off = await rtpe({ command: 'offer', 'call-id': callId, 'from-tag': fromTag, sdp: p.body,
      ICE: 'remove', 'transport-protocol': 'RTP/AVP', 'rtcp-mux': ['demux'], 'DTLS': 'off', 'SDES': ['off'],
      flags: ['trust-address'], replace: ['origin', 'session-connection'] });
    if (!off || off.result !== 'ok' || !off.sdp) { log(`[${this.name}] rtpengine offer fallo`, off && off.result); return this.reply(p, 488, 'Not Acceptable Here'); }
    // pata B hacia Asterisk (UDP). Asterisk identifica 192.168.99.17 como to-sbc -> from-trunk
    const bCallId = rnd(16) + '@wsbridge'; const bBranch = 'z9hG4bK' + rnd(10); const bFromTag = rnd(8);
    const ctx = {
      aCallId: callId, bCallId, a: this, p, fromTag, bFromTag, bBranch, target,
      bToTag: null, remoteSdpAnswered: false,
      onAstMessage: (bp, bmsg) => this._astToRemote(ctx, bp, bmsg),
      onRemoteAck: () => { /* ACK ya intercambiado por transacción */ },
      onRemoteBye: async () => { this._sendAstBye(ctx); await rtpe({ command: 'delete', 'call-id': callId, 'from-tag': fromTag }); b2b.delete(callId); },
      onRemoteCancel: () => { this._sendAstCancel(ctx); },
      onRemoteResp: () => {},
    };
    b2b.set(callId, ctx);
    const inv = [`INVITE sip:${target}@${AST_HOST} SIP/2.0`, `Via: SIP/2.0/UDP ${LOCAL_IP}:${LOCAL_SIP_PORT};branch=${bBranch};rport`, `Max-Forwards: 70`,
      `From: <sip:${userOf(p.headers['from']) || this.user}@${LOCAL_IP}>;tag=${bFromTag}`, `To: <sip:${target}@${AST_HOST}>`, `Call-ID: ${bCallId}`,
      `CSeq: 1 INVITE`, `Contact: <sip:${this.user}@${LOCAL_IP}:${LOCAL_SIP_PORT}>`, `Content-Type: application/sdp`, `User-Agent: PBX-NG-wsbridge`,
      `Content-Length: ${Buffer.byteLength(off.sdp)}`, '', off.sdp].join('\r\n');
    this._astSend(inv);
  }
  async _astToRemote(ctx, bp, bmsg) {
    if (!bp.status) return;
    if (bp.status >= 100 && bp.status < 200) { if (bp.status !== 100) this.reply(ctx.p, bp.status, bp.start.split(' ').slice(2).join(' ') || 'Ringing'); return; }
    if (bp.status >= 200 && bp.status < 300) {
      ctx.bToTag = (bp.headers['to'].match(/tag=([^;>\s]+)/) || [])[1];
      // rtpengine answer: SDP de Asterisk (RTP) -> DTLS-SRTP para el remoto
      const ans = await rtpe({ command: 'answer', 'call-id': ctx.aCallId, 'from-tag': ctx.fromTag, 'to-tag': ctx.bToTag, sdp: bp.body,
        ICE: 'force', 'transport-protocol': 'UDP/TLS/RTP/SAVPF', 'rtcp-mux': ['offer'], flags: ['trust-address', 'generate-mid'], replace: ['origin', 'session-connection'] });
      const sdp = (ans && ans.sdp) ? ans.sdp : bp.body;
      // 200 OK al remoto con el SDP DTLS-SRTP
      const L = [`SIP/2.0 200 OK`, `Via: ${ctx.p.headers['via']}`, `From: ${ctx.p.headers['from']}`, `To: ${ctx.p.headers['to']};tag=${ctx.bFromTag}`,
        `Call-ID: ${ctx.aCallId}`, `CSeq: ${ctx.p.headers['cseq']}`, `Contact: <sip:${this.user}@${this.localVia};transport=ws>`, `Content-Type: application/sdp`,
        `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp];
      this.send(L.join('\r\n'));
      // ACK a Asterisk
      this._astSend([`ACK sip:${ctx.target}@${AST_HOST} SIP/2.0`, `Via: SIP/2.0/UDP ${LOCAL_IP}:${LOCAL_SIP_PORT};branch=z9hG4bK${rnd(10)}`, `Max-Forwards: 70`,
        `From: <sip:${this.user}@${LOCAL_IP}>;tag=${ctx.bFromTag}`, `To: <sip:${ctx.target}@${AST_HOST}>;tag=${ctx.bToTag}`, `Call-ID: ${ctx.bCallId}`, `CSeq: 1 ACK`, 'Content-Length: 0', '', ''].join('\r\n'));
      return;
    }
    if (bp.status >= 300) { this.reply(ctx.p, bp.status, bp.start.split(' ').slice(2).join(' ') || 'Error'); await rtpe({ command: 'delete', 'call-id': ctx.aCallId, 'from-tag': ctx.fromTag }); b2b.delete(ctx.aCallId); }
  }
  _sendAstBye(ctx) { this._astSend([`BYE sip:${ctx.target}@${AST_HOST} SIP/2.0`, `Via: SIP/2.0/UDP ${LOCAL_IP}:${LOCAL_SIP_PORT};branch=z9hG4bK${rnd(10)}`, `Max-Forwards: 70`, `From: <sip:${this.user}@${LOCAL_IP}>;tag=${ctx.bFromTag}`, `To: <sip:${ctx.target}@${AST_HOST}>;tag=${ctx.bToTag || ''}`, `Call-ID: ${ctx.bCallId}`, `CSeq: 2 BYE`, 'Content-Length: 0', '', ''].join('\r\n')); }
  _sendAstCancel(ctx) { this._astSend([`CANCEL sip:${ctx.target}@${AST_HOST} SIP/2.0`, `Via: SIP/2.0/UDP ${LOCAL_IP}:${LOCAL_SIP_PORT};branch=${ctx.bBranch}`, `Max-Forwards: 70`, `From: <sip:${this.user}@${LOCAL_IP}>;tag=${ctx.bFromTag}`, `To: <sip:${ctx.target}@${AST_HOST}>`, `Call-ID: ${ctx.bCallId}`, `CSeq: 1 CANCEL`, 'Content-Length: 0', '', ''].join('\r\n')); }
  _astSend(m) { try { astSock.send(Buffer.from(m), AST_PORT, AST_HOST); } catch (e) { log('astSend err', e.message); } }
  shutdown() { this.stop = true; clearTimeout(this.regTimer); if (this.ws) { try { this.ws.terminate(); } catch (_) {} } }
}

const clients = new Map();
async function reconcile(db) {
  let modOn = true, trunks = [];
  try {
    const m = await db.query("SELECT value FROM pbxng_settings WHERE key='mod_wsbridge'"); modOn = m.rows[0] ? m.rows[0].value !== '0' : true;
    const r = await db.query("SELECT name, kam_config FROM pbxng_trunks WHERE kind='webrtc-client'");
    trunks = r.rows.map((x) => ({ name: x.name, ...(x.kam_config || {}) })).filter((x) => x.remote_url && x.username);
  } catch (e) { log('db error', e.message); return; }
  const want = new Map(modOn ? trunks.map((t) => [t.name, t]) : []);
  for (const [name, c] of clients) { const w = want.get(name); if (!w || w.remote_url !== c.url || w.username !== c.user || w.password !== c.pass) { c.shutdown(); clients.delete(name); } }
  for (const [name, t] of want) if (!clients.has(name)) { const c = new TrunkClient(t); clients.set(name, c); c.connect(); }
  try {
    await db.query("CREATE TABLE IF NOT EXISTS pbxng_wsbridge_status (name text PRIMARY KEY, state text, detail text, updated_at timestamptz DEFAULT now())");
    for (const [name, c] of clients) await db.query("INSERT INTO pbxng_wsbridge_status (name,state,detail,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (name) DO UPDATE SET state=$2,detail=$3,updated_at=now()", [name, c.state, c.detail]);
    if (!modOn) await db.query("UPDATE pbxng_wsbridge_status SET state='disabled', detail='módulo apagado', updated_at=now()");
  } catch (_) {}
}

async function main() {
  const db = new Client(DB); let ok = false;
  while (!ok) { try { await db.connect(); ok = true; } catch (e) { log('esperando DB...', e.message); await new Promise((r) => setTimeout(r, 3000)); } }
  // detectar IP local usada para alcanzar Asterisk (para Via/Contact)
  try { const s = dgram.createSocket('udp4'); await new Promise((res) => { s.connect(AST_PORT, AST_HOST, () => { try { LOCAL_IP = s.address().address; } catch (_) {} s.close(); res(); }); }); } catch (_) {}
  await new Promise((res) => { astSock.bind(LOCAL_SIP_PORT, () => { astBound = true; res(); }); astSock.on('error', (e) => { log('astSock bind err', e.message); res(); }); });
  log('wsbridge arrancado. DB', DB.host, '| Asterisk', AST_HOST + ':' + AST_PORT, '| local', LOCAL_IP + ':' + LOCAL_SIP_PORT, '| rtpengine', RTPE_HOST + ':' + RTPE_PORT);
  await db.query("CREATE TABLE IF NOT EXISTS pbxng_wsbridge_status (name text PRIMARY KEY, state text, detail text, updated_at timestamptz DEFAULT now())").catch(() => {});
  const loop = async () => { try { await reconcile(db); } catch (e) { log('loop err', e.message); } setTimeout(loop, POLL_MS); };
  loop();
}
main();
