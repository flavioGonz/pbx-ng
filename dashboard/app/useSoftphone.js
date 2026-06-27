'use client';
import { useEffect, useRef, useState, useCallback } from 'react';

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:pbx.ies.com.uy:3478?transport=udp', username: 'pbxng', credential: '__SET_TURN_SECRET__' },
  { urls: 'turn:pbx.ies.com.uy:3478?transport=tcp', username: 'pbxng', credential: '__SET_TURN_SECRET__' },
];
const LS = 'pbxng_softphone';
const HIST = 'pbxng_softphone_hist';

const DTMF = { '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], '*': [941, 1209], '0': [941, 1336], '#': [941, 1477] };
let actx;
export function playTone(key) {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const f = DTMF[key]; if (!f) return;
    const g = actx.createGain(); g.connect(actx.destination);
    const now = actx.currentTime;
    g.gain.setValueAtTime(0.18, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    f.forEach(freq => { const o = actx.createOscillator(); o.type = 'sine'; o.frequency.value = freq; o.connect(g); o.start(now); o.stop(now + 0.16); });
  } catch (_) {}
}

// ---- Ringtone / ringback + vibracion ----
let ractx, ringInt = null;
function ringTone(loud) {
  try {
    if (!ractx) ractx = new (window.AudioContext || window.webkitAudioContext)();
    if (ractx.state === 'suspended') ractx.resume();
    const t = ractx.currentTime;
    const g = ractx.createGain(); g.connect(ractx.destination);
    const vol = loud ? 0.3 : 0.12;
    const dur = loud ? 1.1 : 1.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.05);
    g.gain.setValueAtTime(vol, t + dur - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const freqs = loud ? [440, 480] : [425];
    freqs.forEach(f => { const o = ractx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + dur); });
  } catch (_) {}
}
function buzz() { if (navigator.vibrate) { try { navigator.vibrate([500, 300, 500]); } catch (_) {} } }
export function startRinging(loud) {
  stopRinging();
  ringTone(loud); if (loud) buzz();
  ringInt = setInterval(() => { ringTone(loud); if (loud) buzz(); }, loud ? 3000 : 3500);
}
export function stopRinging() {
  if (ringInt) { clearInterval(ringInt); ringInt = null; }
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch (_) {} }
}

// Libera micrófono/cámara (apaga el indicador rojo de iOS) al terminar la llamada.
export function releaseMedia(s) {
  try {
    const sdh = s && s.sessionDescriptionHandler;
    if (sdh) {
      const pc = sdh.peerConnection;
      if (pc) {
        pc.getSenders().forEach(se => { try { se.track && se.track.stop(); } catch (_) {} });
        pc.getReceivers().forEach(re => { try { re.track && re.track.stop(); } catch (_) {} });
      }
      if (sdh.localMediaStream) { try { sdh.localMediaStream.getTracks().forEach(t => t.stop()); } catch (_) {} }
      try { typeof sdh.close === 'function' && sdh.close(); } catch (_) {}
    }
  } catch (_) {}
}

// Pide permiso de micrófono (y cámara si video) UNA vez y libera de inmediato.
let primed = false;
export async function primeMedia(video) {
  if (primed) return;
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
    st.getTracks().forEach(t => t.stop());
    primed = true;
  } catch (_) {}
}

function reportGeo(ext, number, dir) {
  try {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    if (localStorage.getItem('pbxng_geo') !== '1') return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const c = pos.coords;
      fetch('/backend/api/geo/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext, number, dir, lat: c.latitude, lng: c.longitude, accuracy: c.accuracy }) }).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  } catch (_) {}
}
function loadHist() { try { return JSON.parse(localStorage.getItem(HIST) || '[]'); } catch (_) { return []; } }
function pushHist(entry) { try { const h = loadHist(); h.unshift(entry); localStorage.setItem(HIST, JSON.stringify(h.slice(0, 50))); } catch (_) {} }

export function useSoftphone() {
  const [reg, setReg] = useState('idle');
  const [call, setCall] = useState(null);
  const [incoming, setIncoming] = useState(null);
  const [incomingVideo, setIncomingVideo] = useState(false);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [recording, setRecording] = useState(false);
  const [attended, setAttended] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [filePlaying, setFilePlaying] = useState(null);
  const [creds, setCreds] = useState(null);
  const [hist, setHist] = useState([]);
  const [callInfo, setCallInfo] = useState(null); // { dir, number, since }
  const ua = useRef(null), registerer = useRef(null), session = useRef(null), wantConnected = useRef(false);
  const consult = useRef(null), screenStream = useRef(null), fileEl = useRef(null);
  const audioRef = useRef(null), remoteVideoRef = useRef(null), localVideoRef = useRef(null);

  const refreshHist = useCallback(() => setHist(loadHist()), []);

  const attachMedia = useCallback((s) => {
    const pc = s.sessionDescriptionHandler.peerConnection;
    const remote = new MediaStream();
    pc.getReceivers().forEach(r => r.track && remote.addTrack(r.track));
    if (audioRef.current) { audioRef.current.srcObject = remote; audioRef.current.play().catch(() => {}); }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remote;
    const local = new MediaStream();
    pc.getSenders().forEach(se => se.track && se.track.kind === 'video' && local.addTrack(se.track));
    if (localVideoRef.current) localVideoRef.current.srcObject = local;
  }, []);

  const wire = useCallback((s, info) => {
    session.current = s;
    setCallInfo(info);
    s.stateChange.addListener((st) => {
      setCall(st);
      if (st === 'Established') { attachMedia(s); setCallInfo(i => i ? { ...i, since: Date.now() } : i); stopRinging(); }
      if (st === 'Terminated') {
        if (info) pushHist({ ...info, ended: Date.now() });
        refreshHist(); stopRinging(); releaseMedia(s);
        if (audioRef.current) audioRef.current.srcObject = null;
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        if (localVideoRef.current) localVideoRef.current.srcObject = null;
        session.current = null; setCall(null); setIncoming(null); setMuted(false); setHeld(false); setRecording(false); setCallInfo(null);
        consult.current = null; setAttended(null); setSharing(false); setFilePlaying(null); if (fileEl.current) { try { fileEl.current.pause(); } catch (_) {} fileEl.current = null; } if (screenStream.current) { try { screenStream.current.getTracks().forEach(t => t.stop()); } catch (_) {} screenStream.current = null; }
        if (typeof window !== 'undefined' && window.__pbxReloadPending) setTimeout(() => { try { location.reload(); } catch (_) {} }, 700);
      }
    });
  }, [attachMedia, refreshHist]);

  const connect = useCallback(async (ext, pass, video = false, remember = true) => {
    if (!ext || !pass) return;
    wantConnected.current = true;
    setReg('connecting');
    try {
      const SIP = await import('sip.js');
      const { UserAgent, Registerer } = SIP;
      const uri = UserAgent.makeURI(`sip:${ext}@${location.hostname}`);
      const agent = new UserAgent({
        uri,
        transportOptions: { server: `wss://${location.host}/ws`, traceSip: false },
        authorizationUsername: ext, authorizationPassword: pass,
        sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: { iceServers: ICE, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }, iceGatheringTimeout: 1500 },
        delegate: {
          onInvite: (inv) => { setIncoming(inv); try { const sdp = (inv.request && inv.request.body) || inv.body || ''; setIncomingVideo(/m=video/i.test(typeof sdp === 'string' ? sdp : '')); } catch (_) { setIncomingVideo(false); } },
          onConnect: () => { if (registerer.current) registerer.current.register().catch(() => {}); },
          onDisconnect: (err) => {
            setReg('connecting');
            if (err && wantConnected.current && ua.current) { setTimeout(() => { ua.current && ua.current.reconnect().catch(() => {}); }, 2500); }
          },
        },
      });
      ua.current = agent;
      await agent.start();
      const r = new Registerer(agent, { expires: 120 });
      registerer.current = r;
      r.stateChange.addListener((s) => setReg(s === 'Registered' ? 'registered' : s === 'Unregistered' ? 'connecting' : 'connecting'));
      await r.register();
      setCreds({ ext, pass, video });
      if (remember) localStorage.setItem(LS, JSON.stringify({ ext, pass, video }));
      primeMedia(video);
    } catch (e) { setReg('error'); throw e; }
  }, []);

  const disconnect = useCallback(async () => {
    wantConnected.current = false;
    try { if (registerer.current) await registerer.current.unregister(); if (ua.current) await ua.current.stop(); } catch (_) {}
    ua.current = null; setReg('idle'); setCall(null); setCreds(null);
    localStorage.removeItem(LS);
  }, []);

  const placeCall = useCallback(async (num, video) => {
    const target = String(num || '').trim(); if (!target || !ua.current) return;
    const useVid = video === undefined ? !!(creds && creds.video) : !!video;
    if (useVid) await primeMedia(true);
    const SIP = await import('sip.js');
    const uri = SIP.UserAgent.makeURI(`sip:${target}@${location.hostname}`);
    const inviter = new SIP.Inviter(ua.current, uri, { sessionDescriptionHandlerOptions: { constraints: { audio: true, video: useVid }, iceGatheringTimeout: 1500 }, earlyMedia: true });
    wire(inviter, { dir: 'out', number: target, start: Date.now(), video: useVid });
    reportGeo(creds && creds.ext, target, 'out');
    await inviter.invite();
  }, [creds, wire]);

  const acceptIncoming = useCallback(async (video) => {
    const inv = incoming; if (!inv) return; const useVid = video === undefined ? incomingVideo : !!video; setIncoming(null); stopRinging();
    if (useVid) await primeMedia(true);
    const from = (inv.remoteIdentity && inv.remoteIdentity.uri && inv.remoteIdentity.uri.user) || 'desconocido';
    wire(inv, { dir: 'in', number: from, start: Date.now(), video: useVid });
    reportGeo(creds && creds.ext, from, 'in');
    await inv.accept({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: useVid }, iceGatheringTimeout: 1500 } });
  }, [incoming, incomingVideo, creds, wire]);

  const rejectIncoming = useCallback(() => {
    stopRinging();
    if (incoming) { const from = (incoming.remoteIdentity && incoming.remoteIdentity.uri && incoming.remoteIdentity.uri.user) || '?'; pushHist({ dir: 'in', number: from, start: Date.now(), missed: true }); refreshHist(); incoming.reject(); }
    setIncoming(null); setIncomingVideo(false);
  }, [incoming, refreshHist]);

  const hangup = useCallback(async () => {
    stopRinging();
    const s = session.current; if (!s) return;
    try { if (s.state === 'Established') await s.bye(); else if (s.cancel) await s.cancel(); else if (s.reject) await s.reject(); } catch (_) {}
    releaseMedia(s);
    session.current = null; setCall(null);
  }, []);

  const toggleMute = useCallback(() => {
    const s = session.current; if (!s || !s.sessionDescriptionHandler) return;
    const pc = s.sessionDescriptionHandler.peerConnection;
    pc.getSenders().forEach(se => { if (se.track && se.track.kind === 'audio') se.track.enabled = muted; });
    setMuted(m => !m);
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
    } catch (_) {}
  }, [held]);

  const transfer = useCallback(async (target) => {
    const s = session.current; const t = String(target || '').trim(); if (!s || !t) return false;
    try { const SIP = await import('sip.js'); const uri = SIP.UserAgent.makeURI(`sip:${t}@${location.hostname}`); await s.refer(uri); return true; } catch (_) { return false; }
  }, []);

  // Transferencia atendida: consulto a un tercero antes de pasar la llamada
  const attendedCall = useCallback(async (target) => {
    const s = session.current; const t = String(target || '').trim(); if (!s || !t || !ua.current) return false;
    try { s.sessionDescriptionHandlerOptionsReInvite = { hold: true }; await s.invite(); setHeld(true); } catch (_) {}
    try {
      const SIP = await import('sip.js');
      const uri = SIP.UserAgent.makeURI(`sip:${t}@${location.hostname}`);
      const inv = new SIP.Inviter(ua.current, uri, { sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
      consult.current = inv;
      setAttended({ number: t, state: 'calling' });
      inv.stateChange.addListener((st) => {
        setAttended((a) => a ? { ...a, state: st === 'Established' ? 'talking' : st.toLowerCase() } : a);
        if (st === 'Established') {
          const pc = inv.sessionDescriptionHandler.peerConnection; const rs = new MediaStream();
          pc.getReceivers().forEach((r) => r.track && rs.addTrack(r.track));
          if (audioRef.current) { audioRef.current.srcObject = rs; audioRef.current.play().catch(() => {}); }
        }
        if (st === 'Terminated') { consult.current = null; setAttended(null); }
      });
      await inv.invite();
      return true;
    } catch (_) { setAttended(null); return false; }
  }, []);

  const completeAttended = useCallback(async () => {
    const s = session.current, c = consult.current; if (!s || !c) return;
    try { await s.refer(c); } catch (_) {}
  }, []);

  const cancelAttended = useCallback(async () => {
    const c = consult.current;
    if (c) { try { if (c.state === 'Established') await c.bye(); else if (c.cancel) await c.cancel(); } catch (_) {} }
    consult.current = null; setAttended(null);
    const s = session.current;
    if (s) { try { s.sessionDescriptionHandlerOptionsReInvite = { hold: false }; await s.invite(); setHeld(false); const pc = s.sessionDescriptionHandler.peerConnection; const rs = new MediaStream(); pc.getReceivers().forEach((r) => r.track && rs.addTrack(r.track)); if (audioRef.current) { audioRef.current.srcObject = rs; audioRef.current.play().catch(() => {}); } } catch (_) {} }
  }, []);

  // Compartir pantalla durante videollamada (reemplaza el track de video)
  const stopScreen = useCallback(async () => {
    const s = session.current; if (!s) return;
    try {
      const pc = s.sessionDescriptionHandler.peerConnection;
      const sender = pc.getSenders().find((se) => se.track && se.track.kind === 'video');
      const cam = await navigator.mediaDevices.getUserMedia({ video: true });
      const t = cam.getVideoTracks()[0];
      if (sender) await sender.replaceTrack(t);
      if (localVideoRef.current) localVideoRef.current.srcObject = new MediaStream([t]);
    } catch (_) {}
    if (screenStream.current) { try { screenStream.current.getTracks().forEach((t) => t.stop()); } catch (_) {} screenStream.current = null; }
    setSharing(false);
  }, []);

  const shareScreen = useCallback(async () => {
    const s = session.current; if (!s) return { error: 'sin llamada' };
    const pc = s.sessionDescriptionHandler.peerConnection;
    const sender = pc.getSenders().find((se) => se.track && se.track.kind === 'video');
    if (!sender) return { error: 'la llamada no tiene video' };
    if (sharing) { await stopScreen(); return { ok: true }; }
    try {
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStream.current = disp;
      const t = disp.getVideoTracks()[0];
      await sender.replaceTrack(t);
      if (localVideoRef.current) localVideoRef.current.srcObject = new MediaStream([t]);
      t.onended = () => { stopScreen(); };
      setSharing(true);
      return { ok: true };
    } catch (e) { return { error: 'cancelado' }; }
  }, [sharing, stopScreen]);

  // Compartir un archivo de audio/video durante la llamada (inyecta sus tracks)
  const stopFile = useCallback(async () => {
    const s = session.current;
    if (s) {
      try {
        const pc = s.sessionDescriptionHandler.peerConnection;
        const aSender = pc.getSenders().find((se) => se.track && se.track.kind === 'audio');
        const vSender = pc.getSenders().find((se) => se.track && se.track.kind === 'video');
        const cam = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!vSender });
        if (aSender && cam.getAudioTracks()[0]) await aSender.replaceTrack(cam.getAudioTracks()[0]);
        if (vSender && cam.getVideoTracks()[0]) { await vSender.replaceTrack(cam.getVideoTracks()[0]); if (localVideoRef.current) localVideoRef.current.srcObject = new MediaStream([cam.getVideoTracks()[0]]); }
      } catch (_) {}
    }
    if (fileEl.current) { try { fileEl.current.pause(); URL.revokeObjectURL(fileEl.current.src); } catch (_) {} fileEl.current = null; }
    setFilePlaying(null);
  }, []);

  const shareFile = useCallback(async (file) => {
    const s = session.current; if (!s || !file) return { error: 'sin llamada' };
    const pc = s.sessionDescriptionHandler.peerConnection;
    const isVideo = (file.type || '').startsWith('video');
    const el = document.createElement(isVideo ? 'video' : 'audio');
    el.src = URL.createObjectURL(file); el.playsInline = true;
    fileEl.current = el;
    try { await el.play(); } catch (_) {}
    const stream = el.captureStream ? el.captureStream() : (el.mozCaptureStream ? el.mozCaptureStream() : null);
    if (!stream) { setFilePlaying(null); return { error: 'este navegador no permite compartir archivos' }; }
    await new Promise((r) => setTimeout(r, 250));
    const aTrack = stream.getAudioTracks()[0], vTrack = stream.getVideoTracks()[0];
    const aSender = pc.getSenders().find((se) => se.track && se.track.kind === 'audio');
    const vSender = pc.getSenders().find((se) => se.track && se.track.kind === 'video');
    try {
      if (aTrack && aSender) await aSender.replaceTrack(aTrack);
      if (vTrack && vSender) { await vSender.replaceTrack(vTrack); if (localVideoRef.current) localVideoRef.current.srcObject = new MediaStream([vTrack]); }
    } catch (_) {}
    el.onended = () => { stopFile(); };
    setFilePlaying({ name: file.name, video: isVideo });
    return { ok: true };
  }, [stopFile]);

  const toggleRecord = useCallback(async () => {
    const ext = creds && creds.ext; if (!ext) return { error: 'sin interno' };
    const next = !recording;
    try {
      const r = await fetch('/backend/api/calls/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext, action: next ? 'start' : 'stop' }) }).then(x => x.json());
      if (!r.error) setRecording(next);
      return r;
    } catch (e) { return { error: e.message }; }
  }, [creds, recording]);

  // tono + (si hay llamada) enviar DTMF
  const tone = useCallback((key) => {
    playTone(key);
    const s = session.current;
    if (s && s.state === 'Established') { try { s.sessionDescriptionHandler.sendDtmf(key); } catch (_) {} }
  }, []);

  // Ringtone llamada entrante + vibracion
  useEffect(() => { if (incoming) startRinging(true); else stopRinging(); return () => stopRinging(); }, [incoming]);
  // Ringback al llamar (saliente, antes de establecer)
  useEffect(() => {
    if (callInfo && callInfo.dir === 'out' && call && call !== 'Established' && call !== 'Terminated') startRinging(false);
    else if ((call === 'Established' || call === 'Terminated' || !call) && !incoming) stopRinging();
  }, [call, callInfo, incoming]);

  useEffect(() => {
    refreshHist();
    const raw = typeof window !== 'undefined' ? localStorage.getItem(LS) : null;
    if (raw) { try { const c = JSON.parse(raw); connect(c.ext, c.pass, c.video, true).catch(() => {}); } catch (_) {} }
    return () => { try { if (ua.current) ua.current.stop(); } catch (_) {} stopRinging(); };
    // eslint-disable-next-line
  }, []);

  useEffect(() => { if (typeof window !== 'undefined') window.__pbxInCall = !!(call || callInfo || incoming); }, [call, callInfo, incoming]);

  return { reg, call, incoming, incomingVideo, muted, held, recording, creds, hist, callInfo, connect, disconnect, placeCall, acceptIncoming, rejectIncoming, hangup, toggleMute, toggleHold, transfer, attendedCall, completeAttended, cancelAttended, attended, shareScreen, sharing, shareFile, stopFile, filePlaying, toggleRecord, tone, audioRef, remoteVideoRef, localVideoRef };
}
