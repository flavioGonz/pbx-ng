// Hook para el modo SIP nativo (UDP/TCP/TLS): estado de llamada + puente de audio.
// Señalización/RTP viven en el proceso main (electron/sip-udp.cjs). Acá capturamos
// el micrófono (→ PCM 8k → main) y reproducimos el audio entrante (main → PCM 8k → parlante).
// Devuelve la MISMA forma que useSip para poder intercambiarlo en App.jsx.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDevPrefs } from './useSip.js';
import { createNativeVideo } from './video-native.js';

const HIST = 'sp_hist';
const loadHist = () => { try { return JSON.parse(localStorage.getItem(HIST) || '[]'); } catch { return []; } };
const saveHist = (h) => { try { localStorage.setItem(HIST, JSON.stringify(h.slice(0, 100))); } catch {} };

function downsample(buf, inRate, outRate) {
  if (outRate === inRate) return Float32Array.from(buf);
  const ratio = inRate / outRate, out = new Float32Array(Math.floor(buf.length / ratio));
  let o = 0, i = 0; while (o < out.length) { const idx = Math.floor(i); out[o++] = buf[idx] || 0; i += ratio; } return out;
}
function upsample(buf, inRate, outRate) {
  if (outRate === inRate) return Float32Array.from(buf);
  const ratio = outRate / inRate, out = new Float32Array(Math.floor(buf.length * ratio));
  for (let o = 0; o < out.length; o++) { const src = o / ratio; const i = Math.floor(src), f = src - i; out[o] = (buf[i] || 0) * (1 - f) + (buf[i + 1] || buf[i] || 0) * f; } return out;
}
function f32ToI16b64(f) { const i16 = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { let s = Math.max(-1, Math.min(1, f[i])); i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } let bin = ''; const b = new Uint8Array(i16.buffer); for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]); return btoa(bin); }
function b64ToI16(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Int16Array(u.buffer); }

const DTMF_F = { '1':[697,1209],'2':[697,1336],'3':[697,1477],'4':[770,1209],'5':[770,1336],'6':[770,1477],'7':[852,1209],'8':[852,1336],'9':[852,1477],'*':[941,1209],'0':[941,1336],'#':[941,1477] };
let _tctx;
function playLocalTone(k) { try { if (!_tctx) _tctx = new (window.AudioContext || window.webkitAudioContext)(); if (_tctx.state === 'suspended') _tctx.resume(); const f = DTMF_F[k]; if (!f) return; const g = _tctx.createGain(); g.connect(_tctx.destination); const now = _tctx.currentTime; g.gain.setValueAtTime(0.18, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.16); f.forEach(fr => { const o = _tctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr; o.connect(g); o.start(now); o.stop(now + 0.16); }); } catch {} }
const dummyRef = { current: null };

export function useSipNative() {
  const [reg, setReg] = useState('idle');
  const [call, setCall] = useState(null);
  const [incoming, setIncoming] = useState(null);
  const [muted, setMuted] = useState(false);
  const [callInfo, setCallInfo] = useState(null);
  const [note, setNote] = useState('');
  const [quality, setQuality] = useState(null);
  const [hist, setHist] = useState(loadHist);
  const [volume, setVol] = useState(() => { const v = parseFloat(localStorage.getItem('sp_volume')); return isNaN(v) ? 1 : v; });
  const audio = useRef({ ctx: null, mic: null, cap: null, play: null, ring: [], vol: 1 });
  const infoRef = useRef(null);

  // --- video (Etapa 2, WebCodecs) ---
  const [videoOn, setVideoOn] = useState(false);
  const [incomingVideo, setIncomingVideo] = useState(false);
  const veng = useRef(null);
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);

  const stopVideo = useCallback(() => { try { veng.current && veng.current.stop(); } catch {} veng.current = null; setVideoOn(false); }, []);
  const startVideoEngine = useCallback(async () => {
    if (veng.current) return;
    try {
      const p = getDevPrefs();
      const eng = createNativeVideo({
        sendFrame: (b64, ts) => { try { window.sphone && window.sphone.sipVideoOut && window.sphone.sipVideoOut(b64, ts); } catch {} },
        requestKeyframe: () => { try { window.sphone && window.sphone.sipVideoKeyframe && window.sphone.sipVideoKeyframe(); } catch {} },
      });
      veng.current = eng;
      eng.startRemote();
      await eng.startLocal(p && p.cam);
      setVideoOn(true);
    } catch (e) { try { console.error('[sipnat] video', e); } catch {} }
  }, []);

  const pushHist = useCallback((e) => { const h = loadHist(); h.unshift({ ...e, t: Date.now() }); saveHist(h); setHist(h.slice(0, 100)); }, []);

  const stopAudio = useCallback(() => {
    const a = audio.current;
    try { a.cap && (a.cap.onaudioprocess = null, a.cap.disconnect()); } catch {}
    try { a.play && (a.play.onaudioprocess = null, a.play.disconnect()); } catch {}
    try { a.mic && a.mic.getTracks().forEach(t => t.stop()); } catch {}
    try { a.ctx && a.ctx.close(); } catch {}
    audio.current = { ctx: null, mic: null, cap: null, play: null, ring: [], vol: a.vol };
  }, []);

  const startAudio = useCallback(async () => {
    stopAudio();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') await ctx.resume();
      const p = getDevPrefs();
      const mic = await navigator.mediaDevices.getUserMedia({ audio: p.mic ? { deviceId: { ideal: p.mic } } : true });
      const src = ctx.createMediaStreamSource(mic);
      const cap = ctx.createScriptProcessor(1024, 1, 1);
      cap.onaudioprocess = (e) => { try { const inp = e.inputBuffer.getChannelData(0); const ds = downsample(inp, ctx.sampleRate, 8000); if (window.sphone && window.sphone.sipAudioOut) window.sphone.sipAudioOut(f32ToI16b64(ds)); } catch {} };
      const zero = ctx.createGain(); zero.gain.value = 0; src.connect(cap); cap.connect(zero); zero.connect(ctx.destination); // corre sin eco
      const play = ctx.createScriptProcessor(1024, 1, 1);
      play.onaudioprocess = (e) => { const out = e.outputBuffer.getChannelData(0); const r = audio.current.ring; for (let i = 0; i < out.length; i++) out[i] = r.length ? r.shift() : 0; };
      play.connect(ctx.destination);
      audio.current = { ctx, mic, cap, play, ring: [], vol: volume };
    } catch (e) { try { console.error('[sipnat] audio', e); } catch {} }
  }, [stopAudio, volume]);

  useEffect(() => {
    if (!window.sphone || !window.sphone.onSipEvent) return;
    window.sphone.onSipEvent((evt) => {
      if (!evt) return;
      if (evt.type === 'stats') { setQuality({ score: evt.score, loss: evt.loss, jitter: evt.jitter, rtt: evt.rtt || null, codec: evt.codec || null, candType: evt.candType || null }); return; }
      if (evt.type === 'reg') { setReg(evt.state); }
      else if (evt.type === 'video') { if (evt.state === 'on') startVideoEngine(); }
      else if (evt.type === 'video-keyframe') { try { veng.current && veng.current.forceKeyframe(); } catch {} }
      else if (evt.type === 'call') {
        if (evt.state === 'calling') { const ci = { dir: 'out', number: evt.number, since: 0 }; infoRef.current = ci; setCallInfo(ci); setCall('calling'); setNote('Llamando…'); setIncoming(null); }
        else if (evt.state === 'ringing') setNote('Timbrando…');
        else if (evt.state === 'incoming') { setIncoming({ number: evt.number, remoteIdentity: { uri: { user: evt.number } } }); setIncomingVideo(!!evt.video); infoRef.current = { dir: 'in', number: evt.number, since: 0 }; }
        else if (evt.state === 'answered') { const ci = { ...(infoRef.current || { dir: 'out', number: evt.number }), since: Date.now() }; infoRef.current = ci; setCallInfo(ci); setCall('answered'); setNote(''); setIncoming(null); setMuted(false); startAudio(); }
        else if (evt.state === 'ended') { setQuality(null);
          stopAudio(); stopVideo(); setIncomingVideo(false);
          const ci = infoRef.current;
          if (ci) { const dur = ci.since ? Math.round((Date.now() - ci.since) / 1000) : 0; pushHist({ dir: ci.dir, number: ci.number, dur, missed: ci.dir === 'in' && !ci.since }); }
          infoRef.current = null; setCall(null); setCallInfo(null); setIncoming(null); setNote(evt.reason || ''); setMuted(false);
        }
      }
    });
  }, [startAudio, stopAudio, pushHist, startVideoEngine, stopVideo]);

  // NALs de video entrantes desde el main → decoder
  useEffect(() => {
    if (!window.sphone || !window.sphone.onSipVideo) return;
    window.sphone.onSipVideo((b64) => { try { veng.current && veng.current.onNal(b64); } catch {} });
  }, []);

  // audio entrante desde el main (PCM Int16 @8k) → parlante
  useEffect(() => {
    if (!window.sphone || !window.sphone.onSipAudio) return;
    window.sphone.onSipAudio((b64) => {
      try {
        const a = audio.current; if (!a.ctx) return;
        const i16 = b64ToI16(b64); const f = new Float32Array(i16.length);
        const g = a.vol != null ? a.vol : 1; for (let i = 0; i < i16.length; i++) f[i] = (i16[i] / 32768) * g;
        const up = upsample(f, 8000, a.ctx.sampleRate);
        if (a.ring.length > a.ctx.sampleRate) a.ring.splice(0, a.ring.length - Math.floor(a.ctx.sampleRate / 2)); // cap latencia
        for (let i = 0; i < up.length; i++) a.ring.push(up[i]);
      } catch {}
    });
  }, []);

  const connect = useCallback((cfg) => { setReg('connecting'); if (window.sphone && window.sphone.sipConnect) window.sphone.sipConnect(cfg); else setReg('failed'); }, []);
  const disconnect = useCallback(() => { try { window.sphone && window.sphone.sipDisconnect(); } catch {} setReg('idle'); }, []);
  const placeCall = useCallback((number, video) => { try { window.sphone && window.sphone.sipCall(String(number), !!video); } catch {} return Promise.resolve({ ok: true }); }, []);
  const accept = useCallback((video) => { try { window.sphone && window.sphone.sipAccept(!!video); } catch {} }, []);
  const reject = useCallback(() => { try { window.sphone && window.sphone.sipReject(); } catch {} setIncoming(null); }, []);
  const hangup = useCallback(() => { try { window.sphone && window.sphone.sipHangup(); } catch {} }, []);
  const toggleMute = useCallback(() => { setMuted(m => { const n = !m; try { window.sphone && window.sphone.sipMute(n); } catch {} return n; }); }, []);
  const setVolume = useCallback((v) => { const val = Math.max(0, Math.min(1, v)); setVol(val); audio.current.vol = val; try { localStorage.setItem('sp_volume', String(val)); } catch {} }, []);
  const sendDtmf = useCallback((k) => { playLocalTone(String(k)); try { window.sphone && window.sphone.sipDtmf && window.sphone.sipDtmf(String(k)); } catch {} }, []);
  const clearHist = useCallback(() => { saveHist([]); setHist([]); }, []);
  const noop = useCallback(() => {}, []);

  const inCall = !!callInfo;
  const registered = reg === 'registered';
  return {
    reg, registered, call, inCall, incoming, incomingVideo, muted, held: false, speaker: false, videoOn,
    callInfo, quality, hist, volume, note, usingRelay: null,
    connect, disconnect, placeCall, accept, reject, hangup, toggleMute,
    toggleHold: noop, toggleVideo: noop, toggleSpeaker: noop, applySpeaker: noop, setVolume, transfer: (t) => { try { window.sphone && window.sphone.sipTransfer && window.sphone.sipTransfer(t); } catch {} }, sendDtmf, clearHist,
    attended: null, attendedCall: noop, completeAttended: noop, cancelAttended: noop,
    heldInfo: null, switchLine: noop, conf: false, conference: noop,
    audioRef: dummyRef, remoteVideoRef, localVideoRef,
    getRemoteStream: () => (veng.current ? veng.current.getRemoteStream() : null),
    getLocalStream: () => (veng.current ? veng.current.getLocalStream() : null),
  };
}
