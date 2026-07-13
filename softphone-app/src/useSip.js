// Hook SIP genérico (SIP.js) — registra contra CUALQUIER PBX con internos WebRTC.
// Config: { wss, domain, ext, pass, name, stun, turn, turnUser, turnPass }
// Porta el manejo de media/estado probado del PWA de producción (useSoftphone.js),
// pero agnóstico de PBX (todo sale de cfg, no de location.host).
import { useCallback, useEffect, useRef, useState } from 'react';
import { UserAgent, Registerer, Inviter, RegistererState, SessionState } from 'sip.js';

const HIST = 'sp_hist';

// ---------- selección de dispositivos (persistente) ----------
function dev(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
export function getDevPrefs() { return { mic: dev('sp_dev_mic'), cam: dev('sp_dev_cam'), spk: dev('sp_dev_speaker') }; }
export function setDevPref(kind, id) {
  const k = kind === 'mic' ? 'sp_dev_mic' : kind === 'cam' ? 'sp_dev_cam' : 'sp_dev_speaker';
  try { id ? localStorage.setItem(k, id) : localStorage.removeItem(k); } catch {}
}
export async function listDevices() {
  try {
    // Pedimos permiso una vez para poder leer las etiquetas
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); } catch {}
    const d = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: d.filter(x => x.kind === 'audioinput'),
      cams: d.filter(x => x.kind === 'videoinput'),
      speakers: d.filter(x => x.kind === 'audiooutput'),
    };
  } catch { return { mics: [], cams: [], speakers: [] }; }
}
async function primeMedia(video) {
  const st = await navigator.mediaDevices.getUserMedia(constraints(video));
  st.getTracks().forEach(t => t.stop());
}
function constraints(video) {
  const p = getDevPrefs();
  return {
    audio: p.mic ? { deviceId: { ideal: p.mic } } : true,
    video: video ? (p.cam ? { deviceId: { ideal: p.cam } } : true) : false,
  };
}

// ---------- ICE ----------
function iceServersFrom(cfg) {
  const list = [];
  (cfg.stun || 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean)
    .forEach(u => list.push({ urls: u.startsWith('stun:') ? u : 'stun:' + u }));
  // TURN solo si trae usuario y clave; un credential vacío puede romper el RTCPeerConnection/ICE
  if (cfg.turn && cfg.turnUser && cfg.turnPass) {
    const urls = cfg.turn.split(',').map(s => s.trim()).filter(Boolean)
      .map(u => (u.startsWith('turn:') || u.startsWith('turns:')) ? u : 'turn:' + u);
    list.push({ urls, username: cfg.turnUser, credential: cfg.turnPass });
  }
  return list;
}

// ---------- tonos DTMF locales (se oyen al marcar) ----------
const DTMF = { '1':[697,1209],'2':[697,1336],'3':[697,1477],'4':[770,1209],'5':[770,1336],'6':[770,1477],'7':[852,1209],'8':[852,1336],'9':[852,1477],'*':[941,1209],'0':[941,1336],'#':[941,1477] };
let dctx;
function playTone(key) {
  try {
    if (!dctx) dctx = new (window.AudioContext || window.webkitAudioContext)();
    if (dctx.state === 'suspended') dctx.resume();
    const f = DTMF[key]; if (!f) return;
    const g = dctx.createGain(); g.connect(dctx.destination);
    const now = dctx.currentTime;
    g.gain.setValueAtTime(0.2, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    f.forEach(freq => { const o = dctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq; o.connect(g); o.start(now); o.stop(now + 0.16); });
  } catch {}
}

// ---------- ringtone / ringback sintetizados ----------
let ractx, ringInt = null;
function ringTone(loud) {
  try {
    if (!ractx) ractx = new (window.AudioContext || window.webkitAudioContext)();
    if (ractx.state === 'suspended') ractx.resume();
    const t = ractx.currentTime, g = ractx.createGain(); g.connect(ractx.destination);
    const vol = loud ? 0.3 : 0.12, durc = loud ? 1.1 : 1.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.05);
    g.gain.setValueAtTime(vol, t + durc - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durc);
    (loud ? [440, 480] : [425]).forEach(f => { const o = ractx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + durc); });
  } catch {}
}
function buzz() { if (navigator.vibrate) { try { navigator.vibrate([500, 300, 500]); } catch {} } }
function startRinging(loud) { stopRinging(); ringTone(loud); if (loud) buzz(); ringInt = setInterval(() => { ringTone(loud); if (loud) buzz(); }, loud ? 3000 : 3500); }
function stopRinging() { if (ringInt) { clearInterval(ringInt); ringInt = null; } if (navigator.vibrate) { try { navigator.vibrate(0); } catch {} } }

// libera micrófono/cámara al terminar (apaga el indicador de captura)
function releaseMedia(s) {
  try {
    const sdh = s && s.sessionDescriptionHandler; if (!sdh) return;
    const pc = sdh.peerConnection;
    if (pc) { pc.getSenders().forEach(se => { try { se.track && se.track.stop(); } catch {} }); pc.getReceivers().forEach(re => { try { re.track && re.track.stop(); } catch {} }); }
    if (sdh.localMediaStream) { try { sdh.localMediaStream.getTracks().forEach(t => t.stop()); } catch {} }
    try { typeof sdh.close === 'function' && sdh.close(); } catch {}
  } catch {}
}

function loadHist() { try { return JSON.parse(localStorage.getItem(HIST) || '[]'); } catch { return []; } }
function saveHist(h) { try { localStorage.setItem(HIST, JSON.stringify(h.slice(0, 100))); } catch {} }

export function useSip() {
  const [reg, setReg] = useState('idle');            // idle|connecting|registered|failed|unregistered
  const [call, setCall] = useState(null);            // estado de la sesión (string) o null
  const [incoming, setIncoming] = useState(null);    // Invitation entrante
  const [incomingVideo, setIncomingVideo] = useState(false);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [videoOn, setVideoOn] = useState(false);     // la llamada actual tiene video
  const [callInfo, setCallInfo] = useState(null);    // { number, dir, since, video }
  const [quality, setQuality] = useState(null);
  const [note, setNote] = useState('');  // estado legible / motivo de fin de llamada
  const [usingRelay, setUsingRelay] = useState(null); // ¿la llamada actual pasa por TURN (relay)?
  const [hist, setHist] = useState(loadHist);
  const [volume, setVol] = useState(() => { const v = parseFloat(dev('sp_volume')); return isNaN(v) ? 1 : v; });

  const ua = useRef(null), registerer = useRef(null), session = useRef(null), cfgRef = useRef(null), wantConn = useRef(false), heldRef = useRef(false), consult = useRef(null), heldLine = useRef(null), callInfoRef = useRef(null);
  const [attended, setAttended] = useState(null); // { number, state } transferencia atendida
  const [heldInfo, setHeldInfo] = useState(null); // 2da línea en espera { number, dir, video }
  const [conf, setConf] = useState(false); const confRef = useRef(null); // conferencia 3 vías (mezcla local)
  const audioRef = useRef(null), remoteVideoRef = useRef(null), localVideoRef = useRef(null);
  const remoteStreamRef = useRef(null), localStreamRef = useRef(null);

  const refreshHist = useCallback(() => setHist(loadHist()), []);
  const pushHist = useCallback((e) => { const h = loadHist(); h.unshift({ ...e, t: e.t || Date.now() }); saveHist(h); setHist(h.slice(0, 100)); }, []);

  const attachMedia = useCallback((s) => {
    const pc = s.sessionDescriptionHandler && s.sessionDescriptionHandler.peerConnection; if (!pc) return;
    try {
      pc.oniceconnectionstatechange = () => { try { console.log('[sip] ICE', pc.iceConnectionState); } catch {} };
      pc.onconnectionstatechange = () => { try { console.log('[sip] PC', pc.connectionState); } catch {} };
      console.log('[sip] media: senders', pc.getSenders().filter(x => x.track).map(x => x.track.kind), '| receivers', pc.getReceivers().filter(x => x.track).map(x => x.track.kind));
    } catch {}
    const remote = new MediaStream();
    pc.getReceivers().forEach(r => r.track && remote.addTrack(r.track));
    remoteStreamRef.current = remote;
    if (audioRef.current) { audioRef.current.srcObject = remote; audioRef.current.volume = volume; audioRef.current.play().catch(() => {}); }
    if (remoteVideoRef.current) { remoteVideoRef.current.srcObject = remote; remoteVideoRef.current.play().catch(() => {}); }
    const local = new MediaStream();
    pc.getSenders().forEach(se => se.track && se.track.kind === 'video' && local.addTrack(se.track));
    localStreamRef.current = local;
    if (localVideoRef.current) { localVideoRef.current.srcObject = local; localVideoRef.current.play().catch(() => {}); }
  }, [volume]);

  // multi-línea (2): activa + 1 en espera
  function activateLine(s, info) { session.current = s; setCall(SessionState.Established); setCallInfo(info); callInfoRef.current = info; setVideoOn(!!(info && info.video)); setMuted(false); setHeld(false); attachMedia(s); }
  async function holdSession(s, hold) { if (!s) return; try { s.sessionDescriptionHandlerOptionsReInvite = { hold }; await s.invite(); } catch {} try { const pc = s.sessionDescriptionHandler.peerConnection; pc.getSenders().forEach(se => { if (se.track && se.track.kind === 'audio') se.track.enabled = !hold; }); } catch {} }
  async function parkCurrent() { const act = session.current; if (!act || heldLine.current) return false; await holdSession(act, true); heldLine.current = { s: act, info: callInfoRef.current }; setHeldInfo({ ...(callInfoRef.current || {}) }); session.current = null; setCall(null); setCallInfo(null); callInfoRef.current = null; setVideoOn(false); setMuted(false); setHeld(false); return true; }
  const switchLine = useCallback(async () => {
    const held = heldLine.current; if (!held) return;
    const act = session.current, actInfo = callInfoRef.current;
    if (act) await holdSession(act, true);
    await holdSession(held.s, false);
    heldLine.current = act ? { s: act, info: actInfo } : null; setHeldInfo(act ? { ...(actInfo || {}) } : null);
    activateLine(held.s, held.info);
  }, []);

  // Conferencia 3 vías: mezcla local (vos + activa + retenida). Cada leg escucha tu mic + el otro.
  const conference = useCallback(async () => {
    const a = session.current, held = heldLine.current; if (!a || !held || confRef.current) return;
    const b = held.s;
    try {
      await holdSession(b, false); await holdSession(a, false);
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') await ctx.resume();
      const p = getDevPrefs();
      const mic = await navigator.mediaDevices.getUserMedia({ audio: p.mic ? { deviceId: { ideal: p.mic } } : true });
      const micSrc = ctx.createMediaStreamSource(mic);
      const pcA = a.sessionDescriptionHandler.peerConnection, pcB = b.sessionDescriptionHandler.peerConnection;
      const remA = new MediaStream(); pcA.getReceivers().forEach(r => r.track && r.track.kind === 'audio' && remA.addTrack(r.track));
      const remB = new MediaStream(); pcB.getReceivers().forEach(r => r.track && r.track.kind === 'audio' && remB.addTrack(r.track));
      const srcA = ctx.createMediaStreamSource(remA), srcB = ctx.createMediaStreamSource(remB);
      const destA = ctx.createMediaStreamDestination(); micSrc.connect(destA); srcB.connect(destA);
      const sndA = pcA.getSenders().find(se => se.track && se.track.kind === 'audio'); if (sndA) await sndA.replaceTrack(destA.stream.getAudioTracks()[0]);
      const destB = ctx.createMediaStreamDestination(); micSrc.connect(destB); srcA.connect(destB);
      const sndB = pcB.getSenders().find(se => se.track && se.track.kind === 'audio'); if (sndB) await sndB.replaceTrack(destB.stream.getAudioTracks()[0]);
      const destMe = ctx.createMediaStreamDestination(); srcA.connect(destMe); srcB.connect(destMe);
      if (audioRef.current) { audioRef.current.srcObject = destMe.stream; audioRef.current.volume = volume; audioRef.current.play().catch(() => {}); }
      confRef.current = { ctx, mic, legB: b };
      heldLine.current = null; setHeldInfo(null); setConf(true); setHeld(false);
      setCallInfo(i => i ? { ...i, number: (i.number || '') + ' + ' + held.info.number } : i);
    } catch (e) { try { console.error('[sip] conferencia', e); } catch {} }
  }, [volume]);

  const wire = useCallback((s, info) => {
    session.current = s; setCallInfo(info); callInfoRef.current = info; setVideoOn(!!(info && info.video)); setMuted(false); setHeld(false);
    s.stateChange.addListener((st) => {
      const isActive = session.current === s;
      if (isActive) setCall(st);
      try { console.log('[sip] session', st, isActive ? '(activa)' : '(espera)'); } catch {}
      if (st === SessionState.Established && session.current === s) { attachMedia(s); setCallInfo(i => i ? { ...i, since: Date.now() } : i); callInfoRef.current = callInfoRef.current ? { ...callInfoRef.current, since: Date.now() } : callInfoRef.current; stopRinging(); setNote(''); }
      if (st === SessionState.Terminated) {
        if (info) { const dur = info.since ? Math.round((Date.now() - info.since) / 1000) : 0; pushHist({ ...info, dur, ended: Date.now() }); }
        stopRinging(); releaseMedia(s);
        if (heldLine.current && heldLine.current.s === s) { heldLine.current = null; setHeldInfo(null); return; }
        if (session.current === s) {
          remoteStreamRef.current = null; localStreamRef.current = null;
          if (audioRef.current) audioRef.current.srcObject = null;
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          if (localVideoRef.current) localVideoRef.current.srcObject = null;
          session.current = null; setCall(null); setCallInfo(null); callInfoRef.current = null; setMuted(false); setHeld(false); setSpeaker(false); setVideoOn(false); setQuality(null); setUsingRelay(null); setAttended(null); consult.current = null; if (confRef.current) { try { confRef.current.ctx && confRef.current.ctx.close(); confRef.current.mic && confRef.current.mic.getTracks().forEach(t => t.stop()); } catch {} confRef.current = null; setConf(false); }
          if (heldLine.current) { const h = heldLine.current; heldLine.current = null; setHeldInfo(null); holdSession(h.s, false).then(() => activateLine(h.s, h.info)); }
        }
      }
    });
  }, [attachMedia, pushHist]);

  const connect = useCallback(async (cfg) => {
    if (!cfg || !cfg.wss || !cfg.domain || !cfg.ext) {
      const falta = !cfg ? 'config' : [!cfg.wss && 'servidor WSS', !cfg.domain && 'dominio', !cfg.ext && 'interno'].filter(Boolean).join(', ');
      setReg('failed'); setNote('Falta: ' + falta);
      return { error: 'config incompleta: ' + falta };
    }
    cfgRef.current = cfg; wantConn.current = true; setReg('connecting');
    // teardown total del agente anterior (evita reconexiones fantasma)
    try { if (registerer.current) { await registerer.current.unregister().catch(() => {}); registerer.current.dispose && registerer.current.dispose(); } } catch {}
    try { if (ua.current) { ua.current.__dead = true; await ua.current.stop(); } } catch {}
    ua.current = null; registerer.current = null;
    try {
      const uri = UserAgent.makeURI(`sip:${cfg.ext}@${cfg.domain}`);
      if (!uri) throw new Error('URI inválida (revisá dominio/interno)');
      let agent;
      agent = new UserAgent({
        uri,
        displayName: cfg.name || String(cfg.ext),
        authorizationUsername: cfg.ext,
        authorizationPassword: cfg.pass,
        transportOptions: { server: cfg.wss },
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: { iceServers: iceServersFrom(cfg), bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' },
          iceGatheringTimeout: 1500,
        },
        delegate: {
          onInvite: (inv) => {
            setIncoming(inv);
            try { const sdp = (inv.request && inv.request.body) || inv.body || ''; setIncomingVideo(/m=video/i.test(typeof sdp === 'string' ? sdp : '')); } catch { setIncomingVideo(false); }
            inv.stateChange.addListener((st) => { if (st === SessionState.Terminated) setIncoming((cur) => cur === inv ? null : cur); });
          },
          onConnect: () => { if (registerer.current) registerer.current.register().catch(() => {}); },
          onDisconnect: (err) => {
            // solo reconectar si sigue siendo el agente vigente y no fue un stop intencional
            if (agent.__dead || ua.current !== agent || !wantConn.current) return;
            if (err) setNote('WebSocket caído: ' + ((err && err.message) || err) + ' — reintentando…');
            setReg('connecting');
            if (err) setTimeout(() => { if (!agent.__dead && ua.current === agent) agent.reconnect().catch(() => {}); }, 2500);
          },
        },
      });
      ua.current = agent;
      await agent.start();
      const r = new Registerer(agent, { expires: 120 });
      registerer.current = r;
      r.stateChange.addListener((st) => {
        if (ua.current !== agent) return; // ignorar callbacks de un agente viejo
        setReg(st === RegistererState.Registered ? 'registered' : st === RegistererState.Unregistered ? 'unregistered' : 'connecting');
      });
      await r.register({
        requestDelegate: {
          onReject: (res) => {
            const st = (res && res.message && res.message.statusCode) || '';
            const rp = (res && res.message && res.message.reasonPhrase) || '';
            setReg('failed');
            setNote('Registro rechazado' + (st ? ' (' + st + (rp ? ' ' + rp : '') + ')' : '') + (st === 401 || st === 403 ? ' — revisá interno/contraseña' : ''));
          },
          onAccept: () => setNote(''),
        },
      });
      return { ok: true };
    } catch (e) {
      setReg('failed');
      setNote('No se pudo conectar a ' + cfg.wss + ': ' + (e && e.message ? e.message : e));
      return { error: e && e.message };
    }
  }, []);

  const disconnect = useCallback(async () => {
    wantConn.current = false;
    try { if (registerer.current) await registerer.current.unregister().catch(() => {}); } catch {}
    try { if (ua.current) { ua.current.__dead = true; await ua.current.stop(); } } catch {}
    ua.current = null; registerer.current = null; setReg('idle');
  }, []);

  const placeCall = useCallback(async (number, video) => {
    const cfg = cfgRef.current; if (!ua.current || !cfg) return { error: 'no registrado' };
    const n = String(number).replace(/[^\d*#+a-zA-Z]/g, ''); if (!n) return { error: 'número vacío' };
    const useVid = !!video;
    if (session.current && heldLine.current) return { error: 'ya hay 2 líneas activas' };
    try { if (session.current) await parkCurrent(); } catch {}
    try {
      try { await primeMedia(useVid); } catch (e) { const msg = e && e.name === 'NotAllowedError' ? 'Micrófono/cámara denegado' : 'Sin micrófono/cámara: ' + (e && e.message || e); setNote(msg); try { console.error('[sip] getUserMedia', e); } catch {} return { error: msg }; }
      const target = UserAgent.makeURI(`sip:${n}@${cfg.domain}`);
      const inviter = new Inviter(ua.current, target, {
        sessionDescriptionHandlerOptions: { constraints: constraints(useVid), iceGatheringTimeout: 1500 },
        earlyMedia: true,
      });
      wire(inviter, { dir: 'out', number: n, since: 0, video: useVid });
      setNote('Llamando…');
      await inviter.invite({ requestDelegate: {
        onTrying: () => { try { console.log('[sip] 100 trying'); } catch {} },
        onProgress: (r) => { try { console.log('[sip] progress', r.message.statusCode, r.message.reasonPhrase); } catch {} setNote('Timbrando…'); },
        onAccept: (r) => { try { console.log('[sip] 200 accept', r.message.statusCode); } catch {} setNote(''); },
        onReject: (r) => { const c = r.message.statusCode, ph = r.message.reasonPhrase || ''; try { console.warn('[sip] rechazo', c, ph); } catch {} setNote('Rechazada: ' + c + ' ' + ph); },
      } });
      return { ok: true };
    } catch (e) { setNote('Error: ' + e.message); try { console.error('[sip] placeCall', e); } catch {} return { error: e.message }; }
  }, [wire]);

  const accept = useCallback(async (video) => {
    const inv = incoming; if (!inv) return;
    const useVid = video === undefined ? incomingVideo : !!video;
    const from = (inv.remoteIdentity && inv.remoteIdentity.uri && inv.remoteIdentity.uri.user) || 'desconocido';
    setIncoming(null); stopRinging();
    if (session.current && heldLine.current) { try { await inv.reject(); } catch {} return; }
    try { if (session.current) await parkCurrent(); } catch {}
    try { await primeMedia(useVid); } catch (e) { try { console.error('[sip] getUserMedia accept', e); } catch {} }
    wire(inv, { dir: 'in', number: from, since: 0, video: useVid });
    setNote('Conectando…');
    try { await inv.accept({ sessionDescriptionHandlerOptions: { constraints: constraints(useVid), iceGatheringTimeout: 1500 } }); setNote(''); }
    catch (e) { setNote('Error al atender: ' + e.message); try { console.error('[sip] accept', e); } catch {} }
  }, [incoming, incomingVideo, wire]);

  const reject = useCallback(async () => {
    const inv = incoming; if (!inv) return; stopRinging();
    const from = (inv.remoteIdentity && inv.remoteIdentity.uri && inv.remoteIdentity.uri.user) || '?';
    try { await inv.reject(); } catch {} setIncoming(null); setIncomingVideo(false);
    pushHist({ dir: 'in', number: from, missed: true });
  }, [incoming, pushHist]);

  const hangup = useCallback(async () => {
    stopRinging();
    const s = session.current; if (!s) { setCall(null); setCallInfo(null); return; }
    try {
      const st = s.state;
      if (st === SessionState.Initial || st === SessionState.Establishing) { if (s.cancel) await s.cancel(); else if (s.reject) await s.reject().catch(() => {}); }
      else if (st === SessionState.Established) { await s.bye(); }
      else if (s.dispose) { try { await s.dispose(); } catch {} }
    } catch (e) { try { console.warn('[sip] hangup', e); } catch {} }
    releaseMedia(s);
    // fallback: forzar limpieza de UI aunque el BYE/CANCEL tarde
    if (session.current === s) { session.current = null; setCall(null); setCallInfo(null); setMuted(false); setHeld(false); setVideoOn(false); }
  }, []);

  const toggleMute = useCallback(() => {
    const s = session.current; if (!s || !s.sessionDescriptionHandler) return;
    const pc = s.sessionDescriptionHandler.peerConnection; if (!pc) return;
    const next = !muted;
    pc.getSenders().forEach(se => { if (se.track && se.track.kind === 'audio') se.track.enabled = !next; });
    setMuted(next);
  }, [muted]);

  const toggleHold = useCallback(async () => {
    const s = session.current; if (!s) return;
    const next = !held;
    try {
      s.sessionDescriptionHandlerOptionsReInvite = { hold: next };
      await s.invite();
      const pc = s.sessionDescriptionHandler.peerConnection;
      pc.getSenders().forEach(se => { if (se.track && se.track.kind === 'audio') se.track.enabled = !next; });
      setHeld(next);
    } catch {}
  }, [held]);

  // enciende/apaga la cámara en la llamada en curso (renegocia)
  const toggleVideo = useCallback(async () => {
    const s = session.current; if (!s || !s.sessionDescriptionHandler) return;
    const pc = s.sessionDescriptionHandler.peerConnection; if (!pc) return;
    const next = !videoOn;
    try {
      if (next) {
        const cam = await navigator.mediaDevices.getUserMedia(constraints(true));
        const vt = cam.getVideoTracks()[0];
        const sender = pc.getSenders().find(se => se.track && se.track.kind === 'video');
        if (sender) await sender.replaceTrack(vt); else pc.addTrack(vt, cam);
        const ls = new MediaStream([vt]); localStreamRef.current = ls; if (localVideoRef.current) { localVideoRef.current.srcObject = ls; localVideoRef.current.play().catch(() => {}); }
      } else {
        const sender = pc.getSenders().find(se => se.track && se.track.kind === 'video');
        if (sender && sender.track) { sender.track.stop(); await sender.replaceTrack(null); }
        localStreamRef.current = null; if (localVideoRef.current) localVideoRef.current.srcObject = null;
      }
      s.sessionDescriptionHandlerOptionsReInvite = { constraints: constraints(next) };
      try { await s.invite(); } catch {}
      setVideoOn(next);
      setCallInfo(i => i ? { ...i, video: next } : i);
    } catch {}
  }, [videoOn]);

  const toggleSpeaker = useCallback(async () => {
    const el = audioRef.current; const next = !speaker;
    try {
      if (el && typeof el.setSinkId === 'function') {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const outs = devs.filter(d => d.kind === 'audiooutput');
        const pref = getDevPrefs().spk;
        let target = '';
        if (pref) target = pref;
        else if (next) { const sp = outs.find(d => /speaker|altavoz|speakerphone/i.test(d.label || '')); target = sp ? sp.deviceId : ((outs.find(d => d.deviceId !== 'default' && d.deviceId !== 'communications') || {}).deviceId || ''); }
        else { const ear = outs.find(d => /communications|earpiece|receiver|auricular/i.test(d.label || '')); target = ear ? ear.deviceId : 'default'; }
        if (target) await el.setSinkId(target);
      }
      if (el) { el.muted = false; await el.play().catch(() => {}); }
    } catch {}
    setSpeaker(next);
  }, [speaker]);

  // aplica el altavoz elegido en Ajustes al elemento de audio
  const applySpeaker = useCallback(async (id) => {
    const el = audioRef.current;
    try { if (el && typeof el.setSinkId === 'function') await el.setSinkId(id || 'default'); } catch {}
  }, []);

  const setVolume = useCallback((v) => {
    const val = Math.max(0, Math.min(1, v));
    setVol(val); try { localStorage.setItem('sp_volume', String(val)); } catch {}
    if (audioRef.current) audioRef.current.volume = val;
  }, []);

  const transfer = useCallback(async (target) => {
    const s = session.current; const cfg = cfgRef.current; const t = String(target || '').trim();
    if (!s || !t || !cfg) return false;
    try { const uri = UserAgent.makeURI(`sip:${t}@${cfg.domain}`); await s.refer(uri); return true; } catch { return false; }
  }, []);

  // Transferencia ATENDIDA: consulto a un tercero con la principal en espera
  const attendedCall = useCallback(async (target) => {
    const s = session.current, cfg = cfgRef.current, t = String(target || '').trim();
    if (!s || !t || !ua.current || !cfg) return false;
    try { s.sessionDescriptionHandlerOptionsReInvite = { hold: true }; await s.invite(); setHeld(true); } catch {}
    try {
      const uri = UserAgent.makeURI(`sip:${t}@${cfg.domain}`);
      const inv = new Inviter(ua.current, uri, { sessionDescriptionHandlerOptions: { constraints: constraints(false), iceGatheringTimeout: 1500 } });
      consult.current = inv; setAttended({ number: t, state: 'calling' });
      inv.stateChange.addListener((st) => {
        setAttended((a) => a ? { ...a, state: st === SessionState.Established ? 'talking' : String(st).toLowerCase() } : a);
        if (st === SessionState.Established) { try { const pc = inv.sessionDescriptionHandler.peerConnection; const rs = new MediaStream(); pc.getReceivers().forEach(r => r.track && rs.addTrack(r.track)); if (audioRef.current) { audioRef.current.srcObject = rs; audioRef.current.play().catch(() => {}); } } catch {} }
        if (st === SessionState.Terminated) { consult.current = null; setAttended(null); }
      });
      await inv.invite();
      return true;
    } catch { setAttended(null); return false; }
  }, []);
  const completeAttended = useCallback(async () => { const s = session.current, c = consult.current; if (!s || !c) return; try { await s.refer(c); } catch {} }, []);
  const cancelAttended = useCallback(async () => {
    const c = consult.current;
    if (c) { try { if (c.state === SessionState.Established) await c.bye(); else if (c.cancel) await c.cancel(); } catch {} }
    consult.current = null; setAttended(null);
    const s = session.current;
    if (s) { try { s.sessionDescriptionHandlerOptionsReInvite = { hold: false }; await s.invite(); setHeld(false); const pc = s.sessionDescriptionHandler.peerConnection; const rs = new MediaStream(); pc.getReceivers().forEach(r => r.track && rs.addTrack(r.track)); if (audioRef.current) { audioRef.current.srcObject = rs; audioRef.current.play().catch(() => {}); } } catch {} }
  }, []);

  const sendDtmf = useCallback((key) => {
    playTone(key);
    const s = session.current;
    if (s && s.state === SessionState.Established && s.sessionDescriptionHandler) {
      try { s.sessionDescriptionHandler.sendDtmf(String(key)); } catch {}
    }
  }, []);

  const clearHist = useCallback(() => { saveHist([]); setHist([]); }, []);

  // ring entrante
  useEffect(() => { if (incoming) startRinging(true); else stopRinging(); return () => stopRinging(); }, [incoming]);
  // ringback saliente antes de establecer
  useEffect(() => {
    if (callInfo && callInfo.dir === 'out' && call && call !== SessionState.Established && call !== SessionState.Terminated) startRinging(false);
    else if ((call === SessionState.Established || call === SessionState.Terminated || !call) && !incoming) stopRinging();
  }, [call, callInfo, incoming]);
  useEffect(() => { heldRef.current = held; }, [held]);
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);
  useEffect(() => { callInfoRef.current = callInfo; }, [callInfo]);

  // watchdog de calidad (WebRTC stats) + cuelga si se cae ICE / se corta el RTP
  useEffect(() => {
    if (call !== SessionState.Established) { setQuality(null); return; }
    const s = session.current; if (!s || !s.sessionDescriptionHandler) return;
    const pc = s.sessionDescriptionHandler.peerConnection; if (!pc) return;
    let lastLost = 0, lastRecv = 0, started = false, stall = 0, dead = false;
    const die = (why) => { if (dead) return; dead = true; try { hangup(); } catch {} };
    const onIce = () => { const st = pc.iceConnectionState; if (st === 'failed' || st === 'closed') die('ice-' + st); };
    const onConn = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') die('conn'); };
    try { pc.addEventListener('iceconnectionstatechange', onIce); pc.addEventListener('connectionstatechange', onConn); } catch {}
    const iv = setInterval(async () => {
      try {
        const stats = await pc.getStats(); let rtt = null, jitter = null, lost = 0, recv = 0, codecId = null;
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) { lost = r.packetsLost || 0; recv = r.packetsReceived || 0; jitter = r.jitter; if (r.codecId) codecId = r.codecId; }
          if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
          if (r.type === 'remote-inbound-rtp' && r.roundTripTime != null && rtt == null) rtt = r.roundTripTime;
        });
        let codec = null, candType = null;
        try { if (codecId) { const c = stats.get ? stats.get(codecId) : null; if (c && c.mimeType) codec = String(c.mimeType).replace(/^audio\//i, ''); } } catch {}
        try {
          let sel = null; stats.forEach(r => { if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) sel = r; });
          if (sel && sel.localCandidateId) { const lc = stats.get ? stats.get(sel.localCandidateId) : null; if (lc) { setUsingRelay(lc.candidateType === 'relay'); candType = lc.candidateType; } }
        } catch {}
        const dRecv = Math.max(0, recv - lastRecv), dLost = Math.max(0, lost - lastLost); lastLost = lost; lastRecv = recv;
        if (recv > 0) started = true;
        if (started && !heldRef.current) { if (dRecv === 0) { stall += 1; if (stall >= 4) return die('rtp-timeout'); } else stall = 0; }
        const lossPct = (dRecv + dLost) > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
        const rttMs = rtt != null ? Math.round(rtt * 1000) : null;
        let score = 4;
        if (lossPct > 8 || (rttMs != null && rttMs > 500)) score = 1;
        else if (lossPct > 3 || (rttMs != null && rttMs > 300)) score = 2;
        else if (lossPct > 1 || (rttMs != null && rttMs > 180)) score = 3;
        setQuality({ score, loss: Math.round(lossPct * 10) / 10, rtt: rttMs, jitter: jitter != null ? Math.round(jitter * 1000) : null, codec, candType });
      } catch {}
    }, 2000);
    return () => { clearInterval(iv); try { pc.removeEventListener('iceconnectionstatechange', onIce); pc.removeEventListener('connectionstatechange', onConn); } catch {} };
  }, [call, hangup]);

  const inCall = !!(call || (callInfo && call !== SessionState.Terminated));
  const registered = reg === 'registered';
  return {
    reg, registered, call, inCall, incoming, incomingVideo, muted, held, speaker, videoOn, callInfo, quality, hist, volume, note, usingRelay,
    connect, disconnect, placeCall, accept, reject, hangup, toggleMute, toggleHold, toggleVideo, toggleSpeaker, applySpeaker, setVolume, transfer, sendDtmf, clearHist,
    attended, attendedCall, completeAttended, cancelAttended,
    heldInfo, switchLine, conf, conference,
    audioRef, remoteVideoRef, localVideoRef,
    getRemoteStream: () => remoteStreamRef.current, getLocalStream: () => localStreamRef.current,
  };
}
