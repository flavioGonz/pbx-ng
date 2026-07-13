// Motor SIP NATIVO (UDP/TCP/TLS) — registro + llamadas + audio RTP.
// Estándares: RFC 3261 (SIP), RFC 3550 (RTP), RFC 4733 (DTMF telephone-event),
// G.711 PCMU/PCMA (RFC 3551), NAT por rport/received (RFC 3581) + RTP simétrico.
const os = require('os');
const dgram = require('dgram');
let srtp = null; try { srtp = require('./srtp.cjs'); } catch (_) {}
let sip = null, digest = null, LIBERR = '';
try { sip = require('sip'); } catch (e) { LIBERR = 'require(sip): ' + e.message; }
try { digest = require('sip/digest'); } catch (e) { LIBERR = LIBERR || ('require(sip/digest): ' + e.message); }

function localIPv4() { const ifs = os.networkInterfaces(); for (const n of Object.keys(ifs)) for (const a of ifs[n]) if (a.family === 'IPv4' && !a.internal) return a.address; return '127.0.0.1'; }
const rstr = () => Math.floor(Math.random() * 1e9).toString(36);

// ---- G.711 μ-law (PCMU) ----
function muEnc(s) { const BIAS = 0x84, CLIP = 32635; let sign = s < 0 ? 0x80 : 0; if (sign) s = -s; if (s > CLIP) s = CLIP; s += BIAS; let e = 7; for (let m = 0x4000; (s & m) === 0 && e > 0; m >>= 1) e--; const man = (s >> (e + 3)) & 0x0F; return (~(sign | (e << 4) | man)) & 0xFF; }
function muDec(u) { u = ~u & 0xFF; const sign = u & 0x80, e = (u >> 4) & 0x07, man = u & 0x0F; let s = ((man << 3) + 0x84) << e; s -= 0x84; return sign ? -s : s; }
// ---- G.711 A-law (PCMA) — ITU reference ----
const SEG_END = [0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF, 0x3FFF, 0x7FFF];
function aEnc(pcm) { let mask, seg = 8, aval; if (pcm >= 0) mask = 0xD5; else { mask = 0x55; pcm = -pcm - 1; if (pcm < 0) pcm = 0; } for (let i = 0; i < 8; i++) { if (pcm <= SEG_END[i]) { seg = i; break; } } if (seg >= 8) return (0x7F ^ mask) & 0xFF; aval = seg << 4; aval |= seg < 2 ? (pcm >> 1) & 0x0F : (pcm >> seg) & 0x0F; return (aval ^ mask) & 0xFF; }
function aDec(a) { a ^= 0x55; let t = (a & 0x0F) << 4; const seg = (a & 0x70) >> 4; if (seg === 0) t += 8; else if (seg === 1) t += 0x108; else { t += 0x108; t <<= seg - 1; } return (a & 0x80) ? t : -t; }
function encOf(pt) { return pt === 8 ? aEnc : muEnc; }
function decOf(pt) { return pt === 8 ? aDec : muDec; }

let engine = null;
function stop() { if (!engine) return; try { engine.timer && clearTimeout(engine.timer); } catch (_) {} try { engine.regTimer && clearTimeout(engine.regTimer); } catch (_) {} stopRtp(); try { sip && sip.stop && sip.stop(); } catch (_) {} engine = null; }
function stopRtp() { if (!engine || !engine.rtp) return; try { engine.rtp.statsInt && clearInterval(engine.rtp.statsInt); } catch (_) {} try { engine.rtp.sendInt && clearInterval(engine.rtp.sendInt); } catch (_) {} try { engine.rtp.rtcpInt && clearInterval(engine.rtp.rtcpInt); } catch (_) {} try { engine.rtp.rtcpSock && engine.rtp.rtcpSock.close(); } catch (_) {} try { engine.rtp.sock && engine.rtp.sock.close(); } catch (_) {} engine.rtp = null; }

function start(cfg, onEvent) {
  const emit = (e) => { try { onEvent && onEvent(e); } catch (_) {} };
  const log = (dir, line) => emit({ type: 'log', dir, line });
  const failReg = (reason) => emit({ type: 'reg', state: 'failed', reason });
  if (!sip || !digest) { failReg('librería SIP no disponible (' + (LIBERR || '?') + '). Corré npm install y reconstruí.'); return { error: 'no-sip-lib' }; }
  if (!cfg || !cfg.sipServer || !cfg.ext || !cfg.pass || !cfg.domain) { failReg('faltan datos: servidor, dominio, interno o clave'); return { error: 'cfg' }; }
  stop();

  const ip = localIPv4();
  const localPort = 5062;
  const transport = (cfg.sipTransport || 'udp').toLowerCase();
  let server = String(cfg.sipServer).trim();
  let port = parseInt(cfg.sipPort || '5060', 10) || 5060;
  const tparam = transport !== 'udp' ? ';transport=' + transport : '';
  const creds = { user: cfg.ext, password: cfg.pass };
  const secure = (cfg.sipSrtp || 'none') === 'sdes' && !!srtp;
  const dtmfMode = (cfg.sipDtmf || 'rfc4733'); // rfc4733 | info | both
  const tlsVerify = !!cfg.tlsVerify;
  const wantSrv = !!cfg.sipSrv;
  const wantMwi = !!cfg.sipMwi;

  engine = { cseq: Math.floor(Math.random() * 1e4), fromTag: rstr(), callId: rstr() + '@' + ip, timer: null, regTimer: null, done: false, call: null, rtp: null, natIp: null, natPort: null };
  const advIp = () => (engine && engine.natIp) ? engine.natIp : ip;
  const advPort = () => (engine && engine.natPort) ? engine.natPort : localPort;
  const mkContact = () => 'sip:' + cfg.ext + '@' + advIp() + ':' + advPort() + tparam;
  function learnNat(rs) { try { const v = rs && rs.headers && rs.headers.via && rs.headers.via[0]; if (v && v.params) { const got = v.params.received, rp = v.params.rport; if (got && got !== engine.natIp) { engine.natIp = got; engine.natPort = rp ? parseInt(rp, 10) : engine.natPort; log('info', 'NAT: IP pública ' + engine.natIp + (engine.natPort ? ':' + engine.natPort : '')); } else if (rp && !engine.natPort) engine.natPort = parseInt(rp, 10); } } catch (_) {} }

  emit({ type: 'reg', state: 'connecting' });
  log('info', `IP local ${ip}:${localPort} · destino ${server}:${port}/${transport.toUpperCase()} · ${cfg.ext}@${cfg.domain}`);

  const startOpts = {
    address: '0.0.0.0', port: localPort, publicAddress: ip,
    udp: transport === 'udp', tcp: transport === 'tcp',
    tls: transport === 'tls' ? { rejectUnauthorized: tlsVerify } : undefined,
    tls_port: transport === 'tls' ? localPort : undefined,
    logger: { send: (m) => log('out', m.method ? (m.method + ' ' + (m.uri || '')) : ('SIP/2.0 ' + m.status + ' ' + (m.reason || ''))), recv: (m) => log('in', m.method ? (m.method + ' ' + (m.uri || '')) : ('SIP/2.0 ' + m.status + ' ' + (m.reason || ''))) },
  };
  try { sip.start(startOpts, (rq) => onRequest(rq)); }
  catch (e) { failReg('no se pudo abrir el puerto local ' + localPort + ' (' + transport + '): ' + e.message); return { error: e.message }; }
  engine.timer = setTimeout(() => { if (engine && !engine.done) { engine.done = true; failReg('sin respuesta del servidor en 9s — revisá host/puerto/transporte y firewall (' + transport.toUpperCase() + ' ' + port + ')'); } }, 9000);

  // ---------- SDP ----------
  // offer: ambos G.711 (0=PCMU, 8=PCMA) + telephone-event (RFC 4733). answer: solo el códec elegido.
  function buildSdp(rtpPort, only, cryptoB64) {
    const aip = advIp();
    const m = only ? [only.pt, only.dtmf] : [0, 8, 101];
    const proto = cryptoB64 ? 'RTP/SAVP' : 'RTP/AVP';
    const lines = ['v=0', 'o=- ' + Date.now() + ' ' + Date.now() + ' IN IP4 ' + aip, 's=PBX-NG', 'c=IN IP4 ' + aip, 't=0 0', 'm=audio ' + rtpPort + ' ' + proto + ' ' + m.join(' ')];
    if (cryptoB64) lines.push(srtp.cryptoLine(cryptoB64, 1));
    if (m.indexOf(0) >= 0) lines.push('a=rtpmap:0 PCMU/8000');
    if (m.indexOf(8) >= 0) lines.push('a=rtpmap:8 PCMA/8000');
    const dtmfPt = only ? only.dtmf : 101;
    lines.push('a=rtpmap:' + dtmfPt + ' telephone-event/8000', 'a=fmtp:' + dtmfPt + ' 0-15', 'a=ptime:20', 'a=sendrecv', '');
    return lines.join('\r\n');
  }
  function parseSdp(body) {
    let rip = null, rport = null, audioPts = [], rtpmap = {};
    String(body || '').split(/\r?\n/).forEach(l => {
      if (l.indexOf('c=') === 0) { const m = l.match(/IN IP4 ([\d.]+)/); if (m) rip = m[1]; }
      if (l.indexOf('m=audio') === 0) { const m = l.match(/m=audio (\d+) RTP\/AVP (.+)/); if (m) { rport = parseInt(m[1], 10); audioPts = m[2].trim().split(/\s+/).map(Number); } }
      const rm = l.match(/a=rtpmap:(\d+) ([^\/]+)\/(\d+)/); if (rm) rtpmap[rm[1]] = rm[2].toUpperCase();
    });
    return { ip: rip, port: rport, audioPts, rtpmap };
  }
  function pickAudioPt(sdp) { for (const pt of sdp.audioPts) { if (pt === 0 || pt === 8) return pt; const nm = sdp.rtpmap[pt]; if (nm === 'PCMU' || nm === 'PCMA') return pt; } return 0; }
  function findDtmfPt(sdp) { for (const pt in sdp.rtpmap) if (sdp.rtpmap[pt] === 'TELEPHONE-EVENT') return parseInt(pt, 10); return 101; }

  // ---------- RTCP (RFC 3550) ----------
  function buildSR(st) {
    const buf = Buffer.alloc(28); buf[0] = 0x80; buf[1] = 200; buf.writeUInt16BE(6, 2); buf.writeUInt32BE(st.ssrc >>> 0, 4);
    const now = Date.now(); const ntpSec = (Math.floor(now / 1000) + 2208988800) >>> 0; const ntpFrac = Math.floor((now % 1000) / 1000 * 0x100000000) >>> 0;
    buf.writeUInt32BE(ntpSec, 8); buf.writeUInt32BE(ntpFrac, 12); buf.writeUInt32BE(st.ts >>> 0, 16); buf.writeUInt32BE(st.pktCount >>> 0, 20); buf.writeUInt32BE(st.octetCount >>> 0, 24);
    return buf;
  }
  // ---------- RTP ----------
  function startRtp(remoteIp, remotePort, rtpPort, txPt, dtmfPt, srtpCtx) {
    stopRtp();
    const sock = dgram.createSocket('udp4');
    const st = { sock, remoteIp, remotePort, rtpPort, seq: Math.floor(Math.random() * 0xffff), ts: Math.floor(Math.random() * 0xffffffff), ssrc: Math.floor(Math.random() * 0xffffffff), outBuf: [], sendInt: null, rtcpSock: null, rtcpInt: null, pktCount: 0, octetCount: 0, rxPkts: 0, rxLost: 0, lastSeq: -1, jitter: 0, lastTransit: null, statsInt: null, muted: false, txPt: txPt || 0, dtmfPt: dtmfPt == null ? 101 : dtmfPt, enc: encOf(txPt || 0), srtp: srtpCtx || null };
    engine.rtp = st;
    if (!st.srtp) { try { st.rtcpSock = dgram.createSocket('udp4'); st.rtcpSock.on('error', () => {}); st.rtcpSock.on('message', () => {}); st.rtcpSock.bind(rtpPort + 1); } catch (_) {} st.rtcpInt = setInterval(() => { try { if (st.rtcpSock && st.remotePort) st.rtcpSock.send(buildSR(st), st.remotePort + 1, st.remoteIp); } catch (_) {} }, 5000); }
    st.send = (pkt) => { try { const out = st.srtp ? srtp.protect(pkt, st.srtp.tx.keys, st.srtp.tx.ctx) : pkt; sock.send(out, st.remotePort, st.remoteIp); } catch (_) {} };
    sock.on('message', (msg) => { try {
      let m = msg; if (st.srtp) { m = srtp.unprotect(msg, st.srtp.rx.keys, st.srtp.rx.ctx); if (!m) return; }
      if (m.length < 12) return; const pt = m[1] & 0x7f;
      try {
        const seq = m.readUInt16BE(2), rts = m.readUInt32BE(4);
        if (st.lastSeq >= 0) { const d = (seq - st.lastSeq) & 0xffff; if (d > 1 && d < 3000) st.rxLost += (d - 1); }
        st.lastSeq = seq; st.rxPkts++;
        const arrival = Math.floor(Date.now() * 8); // unidades RTP a 8kHz
        const transit = arrival - rts;
        if (st.lastTransit != null) { const dv = Math.abs(transit - st.lastTransit); st.jitter += (dv - st.jitter) / 16; }
        st.lastTransit = transit;
      } catch (_) {}
      if (pt === st.dtmfPt) return; const dec = decOf(pt); const pl = m.slice(12); const pcm = new Int16Array(pl.length); for (let i = 0; i < pl.length; i++) pcm[i] = dec(pl[i]); emit({ type: 'audio', pcm: Buffer.from(pcm.buffer).toString('base64') });
    } catch (_) {} });
    try { sock.bind(rtpPort); } catch (_) {}
    st.sendInt = setInterval(() => {
      try {
        if (st.outBuf.length > 3200) st.outBuf.splice(0, st.outBuf.length - 1600);
        const pkt = Buffer.alloc(12 + 160); pkt[0] = 0x80; pkt[1] = st.txPt & 0x7f;
        pkt.writeUInt16BE(st.seq & 0xffff, 2); pkt.writeUInt32BE(st.ts >>> 0, 4); pkt.writeUInt32BE(st.ssrc >>> 0, 8);
        for (let i = 0; i < 160; i++) pkt[12 + i] = st.enc((st.outBuf.length && !st.muted) ? st.outBuf.shift() : 0);
        st.seq = (st.seq + 1) & 0xffff; st.ts = (st.ts + 160) >>> 0;
        st.pktCount = (st.pktCount + 1) >>> 0; st.octetCount = (st.octetCount + 160) >>> 0;
        st.send(pkt);
      } catch (_) {}
    }, 20);
    st.statsInt = setInterval(() => {
      try {
        const tot = st.rxPkts + st.rxLost; const loss = tot > 0 ? (st.rxLost / tot) * 100 : 0;
        const jms = Math.round(st.jitter / 8); // RTP units (8kHz) -> ms
        let score = 4;
        if (loss > 8 || jms > 60) score = 1; else if (loss > 3 || jms > 40) score = 2; else if (loss > 1 || jms > 25) score = 3;
        emit({ type: 'stats', score, loss: Math.round(loss * 10) / 10, jitter: jms, rtt: null, codec: (st.txPt === 8 ? 'PCMA' : 'PCMU'), candType: null });
      } catch (_) {}
    }, 2000);
    log('info', 'RTP ' + (st.txPt === 8 ? 'PCMA' : 'PCMU') + (st.srtp ? ' + SRTP' : '') + ' → ' + remoteIp + ':' + remotePort + ' (dtmf pt ' + st.dtmfPt + ')');
  }
  function pushOut(pcm) { if (engine && engine.rtp) { const a = engine.rtp.outBuf; for (let i = 0; i < pcm.length; i++) a.push(pcm[i]); } }
  function freeRtpPort() { return 40000 + (Math.floor(Math.random() * 4000) * 2); }

  // ---------- DTMF (RFC 4733) ----------
  const DTMF_CODES = { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '*': 10, '#': 11, 'A': 12, 'B': 13, 'C': 14, 'D': 15 };
  function sendInfoDtmf(digit) {
    const c = engine && engine.call; if (!c || !c.dialog || !c.established) return; const d = c.dialog;
    try { sip.send({ method: 'INFO', uri: d.remoteTarget, headers: { to: { uri: d.remoteUri, params: { tag: d.remoteTag } }, from: { uri: d.localUri, params: { tag: d.localTag } }, 'call-id': d.callId, cseq: { method: 'INFO', seq: (d.cseq = (d.cseq || 1) + 1) }, 'content-type': 'application/dtmf-relay', 'user-agent': 'PBX-NG Softphone', via: [] }, content: 'Signal=' + digit + '\r\nDuration=250\r\n' }, (rs) => log('in', 'INFO(dtmf) → ' + rs.status)); } catch (_) {}
  }
  function sendDtmf(digit) {
    if (dtmfMode === 'info') { sendInfoDtmf(digit); return; }
    if (dtmfMode === 'both') sendInfoDtmf(digit);
    const st = engine && engine.rtp; if (!st) return;
    const ev = DTMF_CODES[String(digit).toUpperCase()]; if (ev == null) return;
    const ts = st.ts >>> 0; let dur = 160, n = 0; const total = 6;
    const one = (marker, end) => { const p = Buffer.alloc(16); p[0] = 0x80; p[1] = (st.dtmfPt & 0x7f) | (marker ? 0x80 : 0); p.writeUInt16BE(st.seq & 0xffff, 2); p.writeUInt32BE(ts, 4); p.writeUInt32BE(st.ssrc >>> 0, 8); p[12] = ev; p[13] = (end ? 0x80 : 0) | 0x0A; p.writeUInt16BE(dur & 0xffff, 14); st.seq = (st.seq + 1) & 0xffff; st.send(p); };
    one(true, false);
    const iv = setInterval(() => { n++; dur += 160; if (n >= total) { one(false, true); one(false, true); one(false, true); clearInterval(iv); } else one(false, false); }, 20);
  }

  // ---------- REGISTER ----------
  function baseRegister(seq) { return { method: 'REGISTER', uri: 'sip:' + server + ':' + port + tparam, headers: { to: { uri: 'sip:' + cfg.ext + '@' + cfg.domain }, from: { uri: 'sip:' + cfg.ext + '@' + cfg.domain, params: { tag: engine.fromTag } }, 'call-id': engine.callId, cseq: { method: 'REGISTER', seq }, contact: [{ uri: mkContact() }], expires: 300, 'user-agent': 'PBX-NG Softphone', via: [] } }; }
  function regExpires(rs) { try { if (rs.headers.contact && rs.headers.contact[0] && rs.headers.contact[0].params && rs.headers.contact[0].params.expires) return parseInt(rs.headers.contact[0].params.expires, 10); } catch (_) {} try { if (rs.headers.expires) return parseInt(rs.headers.expires, 10); } catch (_) {} return 300; }
  function onRegFinal(rs) { if (!engine || engine.done) return; if (rs.status === 200) { engine.done = true; clearTimeout(engine.timer); emit({ type: 'reg', state: 'registered' }); if (wantMwi) { try { subscribeMwi(false); } catch (_) {} } const exp = regExpires(rs); engine.regTimer = setTimeout(() => { if (engine) { engine.done = false; doRegister(); } }, Math.max(30, exp * 0.9) * 1000); } else { engine.done = true; clearTimeout(engine.timer); failReg(rs.status + ' ' + (rs.reason || '') + (rs.status === 403 ? ' (interno/clave o IP no permitida)' : '')); } }
  function doRegister() {
    if (!engine) return; const rq = baseRegister(++engine.cseq);
    sip.send(rq, (rs) => { if (!engine) return; learnNat(rs); log('in', 'REGISTER → ' + rs.status + ' ' + (rs.reason || ''));
      if (rs.status === 401 || rs.status === 407) { try { const ses = {}; digest.signRequest(ses, rq, rs, creds); rq.headers.cseq.seq = ++engine.cseq; rq.headers.via = []; sip.send(rq, (rs2) => { if (!engine) return; log('in', 'REGISTER(auth) → ' + rs2.status); onRegFinal(rs2); }); } catch (e) { engine.done = true; clearTimeout(engine.timer); failReg('auth: ' + e.message); } }
      else onRegFinal(rs); });
  }

  // ---------- SALIENTE ----------
  function placeCall(number) {
    const n = String(number).replace(/[^\d*#+a-zA-Z]/g, ''); if (!n) return; stopRtp();
    const rtpPort = freeRtpPort(), callId = rstr() + '@' + ip, fromTag = rstr();
    const localMaster = secure ? srtp.newMasterB64() : null;
    const rq = { method: 'INVITE', uri: 'sip:' + n + '@' + server + ':' + port + tparam, headers: { to: { uri: 'sip:' + n + '@' + cfg.domain }, from: { uri: 'sip:' + cfg.ext + '@' + cfg.domain, params: { tag: fromTag } }, 'call-id': callId, cseq: { method: 'INVITE', seq: ++engine.cseq }, contact: [{ uri: mkContact() }], 'content-type': 'application/sdp', 'user-agent': 'PBX-NG Softphone', via: [] }, content: buildSdp(rtpPort, null, localMaster) };
    engine.call = { dir: 'out', number: n, callId, fromTag, toTag: null, rtpPort, remoteTarget: null, established: false, inviteRq: rq };
    emit({ type: 'call', state: 'calling', number: n });
    let authed = false;
    const cb = (rs) => {
      if (!engine || !engine.call || engine.call.callId !== callId) return; learnNat(rs);
      if (rs.status === 401 || rs.status === 407) { if (authed) return; authed = true; try { const ses = {}; digest.signRequest(ses, rq, rs, creds); rq.headers.cseq.seq = ++engine.cseq; rq.headers.via = []; sip.send(rq, cb); } catch (e) { emit({ type: 'call', state: 'ended', reason: 'auth: ' + e.message }); engine.call = null; } return; }
      if (rs.status >= 100 && rs.status < 200) { if (rs.status === 180 || rs.status === 183) emit({ type: 'call', state: 'ringing' }); return; }
      if (rs.status >= 200 && rs.status < 300) {
        const to = rs.headers.to; engine.call.toTag = to && to.params && to.params.tag;
        engine.call.remoteTarget = (rs.headers.contact && rs.headers.contact[0] && rs.headers.contact[0].uri) || rq.uri;
        engine.call.dialog = { callId, localUri: 'sip:' + cfg.ext + '@' + cfg.domain, localTag: fromTag, remoteUri: 'sip:' + n + '@' + cfg.domain, remoteTag: engine.call.toTag, remoteTarget: engine.call.remoteTarget, cseq: rq.headers.cseq.seq };
        try { sip.send({ method: 'ACK', uri: engine.call.remoteTarget, headers: { to: rs.headers.to, from: rs.headers.from, 'call-id': callId, cseq: { method: 'ACK', seq: rs.headers.cseq.seq }, via: [] } }); } catch (_) {}
        const rem = parseSdp(rs.content);
        let sctx = null; if (secure) { const rc = srtp.parseCrypto(rs.content); const txk = srtp.keysFromB64(localMaster), rxk = rc && srtp.keysFromB64(rc); if (txk && rxk) sctx = { tx: { keys: txk, ctx: { roc: 0 } }, rx: { keys: rxk, ctx: { roc: 0 } } }; else log('info', 'SRTP: el remoto no devolvió a=crypto — media podría fallar'); }
        if (rem.ip && rem.port) { startRtp(rem.ip, rem.port, rtpPort, pickAudioPt(rem), findDtmfPt(rem), sctx); engine.call.established = true; emit({ type: 'call', state: 'answered', number: n }); }
        else emit({ type: 'call', state: 'ended', reason: 'sin SDP remoto' });
      } else if (rs.status >= 300) { emit({ type: 'call', state: 'ended', reason: rs.status + ' ' + (rs.reason || '') }); engine.call = null; }
    };
    sip.send(rq, cb);
  }

  // ---------- ENTRANTE / control ----------
  function onRequest(rq) {
    try {
      if (rq.method === 'OPTIONS') { sip.send(sip.makeResponse(rq, 200, 'OK')); return; }
      if (rq.method === 'INVITE') {
        const from = (rq.headers.from && rq.headers.from.uri && sip.parseUri(rq.headers.from.uri).user) || 'desconocido';
        engine.call = { dir: 'in', number: from, callId: rq.headers['call-id'], rtpPort: freeRtpPort(), inviteRq: rq, established: false, remote: parseSdp(rq.content) };
        sip.send(sip.makeResponse(rq, 180, 'Ringing')); emit({ type: 'call', state: 'incoming', number: from }); return;
      }
      if (rq.method === 'ACK') return;
      if (rq.method === 'BYE' || rq.method === 'CANCEL') { sip.send(sip.makeResponse(rq, 200, 'OK')); stopRtp(); if (engine) engine.call = null; emit({ type: 'call', state: 'ended', reason: rq.method === 'CANCEL' ? 'cancelada' : 'colgó el otro lado' }); return; }
      if (rq.method === 'NOTIFY') { try { sip.send(sip.makeResponse(rq, 200, 'OK')); const b = String(rq.content || ''); const mm = b.match(/Voice-Message:\s*(\d+)\/(\d+)/i); const wm = b.match(/Messages-Waiting:\s*(yes|no)/i); const count = mm ? parseInt(mm[1], 10) : (wm && /yes/i.test(wm[1]) ? 1 : 0); emit({ type: 'mwi', count }); } catch (_) {} return; }
      sip.send(sip.makeResponse(rq, 405, 'Method Not Allowed'));
    } catch (_) {}
  }
  function accept() {
    if (!engine || !engine.call || engine.call.dir !== 'in') return;
    const c = engine.call, rq = c.inviteRq, rem = c.remote || {};
    const txPt = pickAudioPt(rem), dtmfPt = findDtmfPt(rem);
    const rc = secure ? srtp.parseCrypto((rq && rq.content) || '') : null;
    const ourMaster = (secure && rc) ? srtp.newMasterB64() : null;
    const rs = sip.makeResponse(rq, 200, 'OK');
    rs.headers.contact = [{ uri: mkContact() }]; rs.headers['content-type'] = 'application/sdp';
    rs.content = buildSdp(c.rtpPort, { pt: txPt, dtmf: dtmfPt }, ourMaster);
    const localTag = rs.headers.to && rs.headers.to.params && rs.headers.to.params.tag;
    const fromH = rq.headers.from || {};
    c.dialog = { callId: rq.headers['call-id'], localUri: 'sip:' + cfg.ext + '@' + cfg.domain, localTag, remoteUri: fromH.uri || '', remoteTag: fromH.params && fromH.params.tag, remoteTarget: (rq.headers.contact && rq.headers.contact[0] && rq.headers.contact[0].uri) || fromH.uri, cseq: (rq.headers.cseq && rq.headers.cseq.seq) || 1 };
    sip.send(rs);
    let sctx = null; if (ourMaster && rc) { const txk = srtp.keysFromB64(ourMaster), rxk = srtp.keysFromB64(rc); if (txk && rxk) sctx = { tx: { keys: txk, ctx: { roc: 0 } }, rx: { keys: rxk, ctx: { roc: 0 } } }; }
    if (rem.ip && rem.port) { startRtp(rem.ip, rem.port, c.rtpPort, txPt, dtmfPt, sctx); c.established = true; emit({ type: 'call', state: 'answered', number: c.number }); }
    else emit({ type: 'call', state: 'ended', reason: 'sin SDP remoto' });
  }
  function reject() { if (engine && engine.call && engine.call.dir === 'in') { try { sip.send(sip.makeResponse(engine.call.inviteRq, 486, 'Busy Here')); } catch (_) {} engine.call = null; emit({ type: 'call', state: 'ended', reason: 'rechazada' }); } }
  function hangup() {
    if (!engine || !engine.call) { stopRtp(); return; }
    const c = engine.call;
    try {
      if (c.dir === 'out' && !c.established) { const iv = c.inviteRq; const via = (iv.headers.via && iv.headers.via.length) ? [iv.headers.via[0]] : []; sip.send({ method: 'CANCEL', uri: iv.uri, headers: { to: iv.headers.to, from: iv.headers.from, 'call-id': c.callId, cseq: { method: 'CANCEL', seq: iv.headers.cseq.seq }, via } }); }
      else if (c.established && c.dialog) { const d = c.dialog; sip.send({ method: 'BYE', uri: d.remoteTarget, headers: { to: { uri: d.remoteUri, params: { tag: d.remoteTag } }, from: { uri: d.localUri, params: { tag: d.localTag } }, 'call-id': d.callId, cseq: { method: 'BYE', seq: (d.cseq || 1) + 1 }, 'user-agent': 'PBX-NG Softphone', via: [] } }, (rs) => log('in', 'BYE → ' + rs.status)); }
      else if (c.dir === 'in') sip.send(sip.makeResponse(c.inviteRq, 486, 'Busy Here'));
    } catch (e) { log('info', 'hangup err: ' + e.message); }
    stopRtp(); engine.call = null; emit({ type: 'call', state: 'ended', reason: 'colgaste' });
  }

  // ---------- REFER (RFC 3515, transferencia ciega) ----------
  function transfer(target) {
    const t = String(target || '').replace(/[^\d*#+a-zA-Z]/g, ''); if (!t) return;
    const c = engine && engine.call; if (!c || !c.dialog || !c.established) return; const d = c.dialog;
    try { sip.send({ method: 'REFER', uri: d.remoteTarget, headers: { to: { uri: d.remoteUri, params: { tag: d.remoteTag } }, from: { uri: d.localUri, params: { tag: d.localTag } }, 'call-id': d.callId, cseq: { method: 'REFER', seq: (d.cseq = (d.cseq || 1) + 1) }, 'refer-to': 'sip:' + t + '@' + cfg.domain, 'referred-by': '<' + d.localUri + '>', contact: [{ uri: mkContact() }], 'user-agent': 'PBX-NG Softphone', via: [] }, content: '' }, (rs) => { log('in', 'REFER → ' + rs.status); if (rs.status >= 200 && rs.status < 300) { emit({ type: 'call', state: 'transferred', number: t }); setTimeout(() => { try { hangup(); } catch (_) {} }, 600); } }); } catch (e) { log('info', 'REFER err: ' + e.message); }
  }
  // ---------- SUBSCRIBE/NOTIFY MWI (RFC 6665 + message-summary) ----------
  function subscribeMwi(auth) {
    if (!engine) return; const cid = rstr() + '@' + ip;
    const rq = { method: 'SUBSCRIBE', uri: 'sip:' + cfg.ext + '@' + server + ':' + port + tparam, headers: { to: { uri: 'sip:' + cfg.ext + '@' + cfg.domain }, from: { uri: 'sip:' + cfg.ext + '@' + cfg.domain, params: { tag: rstr() } }, 'call-id': cid, cseq: { method: 'SUBSCRIBE', seq: ++engine.cseq }, contact: [{ uri: mkContact() }], event: 'message-summary', accept: 'application/simple-message-summary', expires: 3600, 'user-agent': 'PBX-NG Softphone', via: [] }, content: '' };
    try { sip.send(rq, (rs) => { if (!engine) return; if ((rs.status === 401 || rs.status === 407) && !auth) { try { const ses = {}; digest.signRequest(ses, rq, rs, creds); rq.headers.cseq.seq = ++engine.cseq; rq.headers.via = []; sip.send(rq, () => {}); } catch (_) {} } log('in', 'SUBSCRIBE(mwi) → ' + rs.status); }); } catch (_) {}
  }
  engine.transfer = transfer; engine.placeCall = placeCall; engine.accept = accept; engine.reject = reject; engine.hangup = hangup; engine.pushOut = pushOut; engine.setMuted = (m) => { if (engine && engine.rtp) engine.rtp.muted = !!m; }; engine.dtmf = sendDtmf;
  function kick() { setTimeout(doRegister, 120); }
  if (wantSrv && !/^[0-9.]+$/.test(server)) {
    try { require('dns').resolveSrv('_sip._' + transport + '.' + server, (err, recs) => { if (!err && recs && recs.length) { recs.sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight)); server = recs[0].name; port = recs[0].port; log('info', 'SRV → ' + server + ':' + port); } kick(); }); }
    catch (_) { kick(); }
  } else kick();
  return { ok: true };
}

function call(n) { engine && engine.placeCall && engine.placeCall(n); }
function accept() { engine && engine.accept && engine.accept(); }
function reject() { engine && engine.reject && engine.reject(); }
function hangup() { engine && engine.hangup && engine.hangup(); }
function audioOut(pcm) { engine && engine.pushOut && engine.pushOut(pcm); }
function setMuted(m) { engine && engine.setMuted && engine.setMuted(m); }
function dtmf(d) { engine && engine.dtmf && engine.dtmf(d); }
function transfer(t) { engine && engine.transfer && engine.transfer(t); }
module.exports = { start, stop, call, accept, reject, hangup, audioOut, setMuted, dtmf, transfer };
