import { useEffect, useState, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useSip, listDevices, getDevPrefs, setDevPref } from './useSip.js';
import { useSipNative } from './useSipNative.js';
import { loadConfig, saveConfig, isComplete, getAccounts as cfgGetAccounts, setAccounts as cfgSetAccounts } from './config.js';
import * as api from './api.js';
import { decodeProv } from './prov.js';
import QRCode from 'qrcode';
import { gsap } from 'gsap';
import { gEnter, gPop, gSplash, gModal, gStagger } from './anim.js';
import * as sounds from './sounds.js';
import { testIce } from './ice.js';
import QrProvision from './QrProvision.jsx';

function withVT(fn) { try { if (typeof document !== 'undefined' && document.startViewTransition) { document.startViewTransition(() => flushSync(fn)); return; } } catch {} fn(); }
const initials = (n) => (String(n || '?')).replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '#';
const APP_VERSION = 'v0.4.9';
const getPhoto = () => { try { return localStorage.getItem('sp_photo') || ''; } catch { return ''; } };

function Svg({ s = 22, c = 'currentColor', w = 2, children }) { return <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">{children}</svg>; }
const IcPhone = (p = {}) => <Svg {...p}><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 4.2 2 2 0 0 1 5.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L9.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z" /></Svg>;
const IcGrid = (p = {}) => <Svg w={3} {...p}><circle cx="5" cy="5" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="19" cy="5" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="19" r="1" /><circle cx="12" cy="19" r="1" /><circle cx="19" cy="19" r="1" /></Svg>;
const IcUser = (p = {}) => <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>;
const IcUsers = (p = {}) => <Svg {...p}><circle cx="9" cy="8" r="3.4" /><path d="M2.5 21a6.5 6.5 0 0 1 13 0" /><path d="M16 5.5a3.4 3.4 0 0 1 0 6.6M17 15a6.5 6.5 0 0 1 4.5 6" /></Svg>;
const IcCam = (p = {}) => <Svg {...p}><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></Svg>;
const IcBell = (p = {}) => <Svg {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></Svg>;
const IcMini = (p = {}) => <Svg {...p}><rect x="3" y="4" width="18" height="14" rx="2" /><rect x="12" y="11" width="7" height="5" rx="1" /></Svg>;
const IcSearch = (p = {}) => <Svg {...p}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></Svg>;
const IcAudioCloud = (p = {}) => <Svg {...p}><path d="M17.5 18a4.5 4.5 0 0 0 .3-9 6 6 0 0 0-11.5-1.6A4 4 0 0 0 6.5 18" /><path d="M9.4 13.2a2.4 2.4 0 0 1 0 3.2" /><path d="M14.2 12a4 4 0 0 1 0 5.6" /></Svg>;
const IcQr = (p = {}) => <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><line x1="14" y1="15" x2="14" y2="21" /><line x1="18" y1="14" x2="21" y2="14" /><line x1="18" y1="18" x2="21" y2="21" /></Svg>;
const IcGear = (p = {}) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8 2 2 0 1 1-2.8 2.8 1.6 1.6 0 0 0-2.8 1.2 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.8-1.2 2 2 0 1 1-2.8-2.8A1.6 1.6 0 0 0 4.6 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.2-2.8 2 2 0 1 1 2.8-2.8A1.6 1.6 0 0 0 11 4.6a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.8 1.2 2 2 0 1 1 2.8 2.8A1.6 1.6 0 0 0 19.4 11a2 2 0 1 1 0 4z" /></Svg>;
const IcBack = (p = {}) => <Svg {...p}><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" /><path d="M18 9l-6 6M12 9l6 6" /></Svg>;
const IcMic = (p = {}) => <Svg {...p}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" /></Svg>;
const IcMicOff = (p = {}) => <Svg {...p}><path d="M1 1l22 22M9 9v3a3 3 0 0 0 5 1M15 9.3V5a3 3 0 0 0-5.7-1.3M5 10a7 7 0 0 0 10.7 6M12 19v3" /></Svg>;
const IcVideo = IcCam;
const IcVideoOff = (p = {}) => <Svg {...p}><path d="M1 1l22 22M16 16v2a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2m4 0h5a2 2 0 0 1 2 2v3l4-3v9" /></Svg>;
const IcSpeaker = (p = {}) => <Svg {...p}><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></Svg>;
const IcPause = (p = {}) => <Svg {...p}><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></Svg>;
const IcSwap = (p = {}) => <Svg {...p}><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></Svg>;
const IcShield = (p = {}) => <Svg {...p}><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z" /></Svg>;
const IcX = (p = {}) => <Svg {...p}><path d="M18 6L6 18M6 6l12 12" /></Svg>;
const IcCal = (p = {}) => <Svg {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Svg>;
const IcVoicemail = (p = {}) => <Svg {...p}><circle cx="6" cy="12" r="4" /><circle cx="18" cy="12" r="4" /><line x1="6" y1="16" x2="18" y2="16" /></Svg>;
const IcPower = (p = {}) => <Svg {...p}><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><path d="M12 2v10" /></Svg>;
const IcHead = (p = {}) => <Svg {...p}><path d="M3 14v-2a9 9 0 0 1 18 0v2" /><rect x="1" y="14" width="5" height="7" rx="2" /><rect x="18" y="14" width="5" height="7" rx="2" /></Svg>;
const IcPlus = (p = {}) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
const IcRec = (p = {}) => <Svg {...p}><circle cx="12" cy="12" r="7" /></Svg>;
const IcReload = (p = {}) => <Svg {...p}><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" /></Svg>;

const C = { rail: '#0f1a30', railHi: '#18294a', accent: '#2f80ff', green: '#22c55e', red: '#ef4444', ink: '#0b1220', sub: '#667089', bg: '#eef1f7', card: '#ffffff', line: '#e3e8f0', keybg: '#f3f6fc' };
function Ava({ photo, txt, size = 44, bg = 'linear-gradient(160deg,#4c9dff,#2f6bd6)', style }) {
  const st = { width: size, height: size, borderRadius: '50%', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: size * 0.36, overflow: 'hidden', ...style };
  if (photo) return <img src={photo} alt="" style={{ ...st, objectFit: 'cover' }} />;
  return <div style={{ ...st, background: bg }}>{txt}</div>;
}
const S = {
  root: { position: 'fixed', inset: 0, display: 'flex', background: C.bg, color: C.ink, fontSize: 14 },
  rail: { width: 78, background: C.rail, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14, gap: 4 },
  navBtn: (on) => ({ width: 62, height: 56, borderRadius: 12, border: 'none', cursor: 'pointer', background: on ? C.railHi : 'transparent', color: on ? '#fff' : '#8194ba', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, fontSize: 10 }),
  content: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  header: { height: 54, borderBottom: `1px solid ${C.line}`, background: C.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', flex: 'none' },
  body: { flex: 1, position: 'relative', display: 'flex', minHeight: 0 },
  dialCol: { width: 340, borderRight: `1px solid ${C.line}`, background: C.card, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '22px 24px', flex: 'none' },
  numIn: { width: '100%', boxSizing: 'border-box', fontSize: 28, fontWeight: 500, textAlign: 'center', border: 'none', outline: 'none', padding: '10px 0', letterSpacing: 1, color: C.ink, background: 'transparent' },
  keypad: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, margin: '12px 0 16px' },
  key: { width: 80, height: 60, borderRadius: 14, background: C.keybg, border: `1px solid ${C.line}`, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: C.ink },
  cbtn: (bg) => ({ width: 58, height: 58, borderRadius: '50%', background: bg, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', boxShadow: '0 6px 16px rgba(20,40,90,.18)' }),
  listCol: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  listHdr: { padding: '16px 22px 10px', fontSize: 18, fontWeight: 700, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  scroll: { flex: 1, overflowY: 'auto', padding: '0 14px 14px' },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 10, cursor: 'pointer' },
  actBtn: (c) => ({ width: 34, height: 34, borderRadius: '50%', border: `1px solid ${C.line}`, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: c }),
  chip: (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, background: bg, color: fg, fontSize: 12, fontWeight: 600 }),
  card: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '4px 16px 8px' },
  inp: { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 9, border: `1px solid ${C.line}`, fontSize: 14, outline: 'none', background: '#fff' },
  sel: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 9, border: `1px solid ${C.line}`, fontSize: 14, background: '#fff', outline: 'none' },
  primary: { width: '100%', padding: 12, borderRadius: 10, border: 'none', background: C.accent, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  overlay: { position: 'fixed', inset: 0, background: 'linear-gradient(180deg,#132038,#0b1220)', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modalWrap: { position: 'fixed', inset: 0, background: 'rgba(10,16,30,.45)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal: { width: 440, maxWidth: '90%', background: '#fff', borderRadius: 16, boxShadow: '0 24px 60px rgba(10,20,50,.35)', overflow: 'hidden' },
  ctlGrid: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginTop: 22, width: 300 },
  ctl: (on) => ({ width: 64, height: 64, borderRadius: '50%', border: '1px solid rgba(255,255,255,.16)', background: on ? '#fff' : 'rgba(255,255,255,.12)', color: on ? '#000' : '#fff', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, justifySelf: 'center', fontSize: 10 }),
  hang: { width: 66, height: 66, borderRadius: '50%', border: 'none', background: C.red, color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 22px rgba(239,68,68,.4)' },
  fieldLbl: { fontSize: 12, color: C.sub, marginBottom: 3 },
  section: { fontSize: 12, color: C.sub, margin: '0 2px 6px', fontWeight: 700, letterSpacing: .3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
};

function Ringing({ size, active = true, children }) {
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      {active && <><span className="ringp" /><span className="ringp" style={{ animationDelay: '.6s' }} /><span className="ringp" style={{ animationDelay: '1.2s' }} /></>}
      {children}
    </div>
  );
}
const IcPhoneRing = ({ s = 20, c = '#fff' }) => <span className="ring-shake"><Svg s={s} c={c}><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 4.2 2 2 0 0 1 5.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L9.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z" /></Svg></span>;
const Eq = () => <span className="eq"><span /><span /><span /><span /><span /></span>;
function Timer({ since }) {
  const [s, setS] = useState(0);
  useEffect(() => { const t = setInterval(() => setS(since ? Math.floor((Date.now() - since) / 1000) : 0), 500); return () => clearInterval(t); }, [since]);
  if (!since) return <span>conectando…</span>;
  return <span>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}
function TurnChip({ cfg, sp, t }) {
  const configured = !!(cfg.turn && cfg.turnUser && cfg.turnPass);
  const st = (t && t.state) || 'idle';
  let bg = '#eef1f7', fg = C.sub, label = 'Sin TURN', live = false;
  if (sp.inCall && sp.usingRelay === true) { bg = 'rgba(34,197,94,.14)'; fg = '#15803d'; label = 'TURN en uso'; live = true; }
  else if (sp.inCall && sp.usingRelay === false) { bg = 'rgba(47,128,255,.12)'; fg = '#1d4ed8'; label = 'Medios directos'; }
  else if (st === 'testing') { bg = '#eef1f7'; fg = C.sub; label = 'Probando TURN…'; }
  else if (st === 'ok') { bg = 'rgba(34,197,94,.12)'; fg = '#15803d'; label = 'TURN listo'; }
  else if (st === 'turn-auth') { bg = 'rgba(239,68,68,.1)'; fg = '#b91c1c'; label = 'TURN: auth falló'; }
  else if (st === 'turn-unreachable' || st === 'error') { bg = 'rgba(239,68,68,.1)'; fg = '#b91c1c'; label = 'TURN no responde'; }
  else if (configured) { bg = 'rgba(47,128,255,.12)'; fg = '#1d4ed8'; label = 'TURN sin probar'; }
  return <span className={live ? 'turn-live' : ''} style={S.chip(bg, fg)}>{IcShield({ c: fg, s: 14 })}{label}</span>;
}
function CtlBtn({ on, onClick, icon, iconOff, label }) {
  return <button className="ph-key" style={S.ctl(on)} onClick={onClick}>{(on && iconOff ? iconOff : icon)({ c: on ? '#000' : '#fff', s: 22 })}<span>{label}</span></button>;
}
function Section({ title, icon, right, children }) {
  return <div>{(title || right) ? <div style={S.section}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>{icon}{title}</span>{right || null}</div> : null}<div style={S.card}>{children}</div></div>;
}
const fmtDate = (t) => new Date(t).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDur = (d) => d ? `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}` : '—';

// ---- Reproductor go2rtc por MSE (fMP4 sobre WebSocket, atraviesa el proxy sin UDP) ----
function MseTile({ stream }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [muted, setMuted] = useState(true);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    const base = stream && stream.base, src = stream && stream.src, video = videoRef.current;
    if (!base || !src || !video || typeof MediaSource === 'undefined') { setStatus('error'); return; }
    let stopped = false, ws = null, sb = null, queue = [], connId = null, unsub = null;
    setStatus('connecting');
    const ms = new MediaSource(); video.src = URL.createObjectURL(ms); video.muted = true;
    const wsUrl = base.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/ws?src=' + encodeURIComponent(src);
    const codecsMsg = () => { const cands = ['avc1.640029', 'avc1.64002A', 'avc1.4d002a', 'avc1.42e01e', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'opus']; const codecs = cands.filter(cc => { try { return MediaSource.isTypeSupported('video/mp4; codecs="' + cc + '"') || MediaSource.isTypeSupported('audio/mp4; codecs="' + cc + '"'); } catch { return false; } }).join(','); return JSON.stringify({ type: 'mse', value: codecs }); };
    const flush = () => { if (!sb || sb.updating || !queue.length) return; try { sb.appendBuffer(queue.shift()); } catch {} };
    const trim = () => { try { if (sb && sb.buffered.length) { const end = sb.buffered.end(sb.buffered.length - 1); if (video.currentTime < end - 2 || video.currentTime > end) video.currentTime = end - 0.4; if (sb.buffered.start(0) < end - 10 && !sb.updating) sb.remove(0, end - 8); } } catch {} };
    const onText = (txt) => { let msg; try { msg = JSON.parse(txt); } catch { return; } if (msg.type === 'mse' && msg.value) { try { sb = ms.addSourceBuffer(msg.value); sb.mode = 'segments'; sb.addEventListener('updateend', () => { trim(); flush(); }); setStatus('live'); video.play().catch(() => {}); } catch { setStatus('error'); } } else if (msg.type === 'error') setStatus('error'); };
    const onBin = (u8) => { queue.push(u8); if (queue.length > 80) queue = queue.slice(-40); flush(); };
    const bridge = typeof window !== 'undefined' && window.sphone && window.sphone.go2rtcOpen;
    ms.addEventListener('sourceopen', () => {
      if (bridge) {
        let origin = ''; try { origin = new URL(base).origin; } catch {}
        window.sphone.go2rtcOpen({ url: wsUrl, origin, token: api.getToken() }).then((r) => {
          if (stopped) return;
          if (!r || r.error) { setStatus('error'); try { console.warn('[go2rtc]', r && r.error); } catch {} return; }
          connId = r.id;
          unsub = window.sphone.onGo2rtcMsg((m) => {
            if (!m || m.id !== connId) return;
            if (m.ev === 'open') window.sphone.go2rtcSend(connId, codecsMsg());
            else if (m.ev === 'text') onText(m.data);
            else if (m.ev === 'bin') { const bin = atob(m.b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); onBin(u8); }
            else if (m.ev === 'error' || m.ev === 'close') { if (!stopped) setStatus(s => s === 'live' || s === 'connecting' ? 'error' : s); }
          });
        });
      } else {
        try { ws = new WebSocket(wsUrl); } catch { setStatus('error'); return; }
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => ws.send(codecsMsg());
        ws.onmessage = (ev) => { if (typeof ev.data === 'string') onText(ev.data); else onBin(new Uint8Array(ev.data)); };
        ws.onerror = () => { if (!stopped) setStatus('error'); };
        ws.onclose = () => { if (!stopped) setStatus(s => s === 'live' || s === 'connecting' ? 'error' : s); };
      }
    });
    return () => { stopped = true; try { ws && ws.close(); } catch {} try { if (connId && window.sphone && window.sphone.go2rtcClose) window.sphone.go2rtcClose(connId); } catch {} try { unsub && unsub(); } catch {} try { if (ms.readyState === 'open') ms.endOfStream(); } catch {} try { video.src = ''; } catch {} };
  }, [stream && stream.base, stream && stream.src, gen]);
  const Ic = stream && stream.type === 'intercom' ? IcBell : IcCam;
  function toggleMute() { const v = videoRef.current; if (v) { v.muted = !v.muted; setMuted(v.muted); if (!v.muted) v.play().catch(() => {}); } }
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 14, overflow: 'hidden', background: '#0b0f17' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: status === 'live' ? 'block' : 'none' }} />
      {status === 'connecting' && <div className="ic-skel" style={{ position: 'absolute', inset: 0 }} />}
      {status === 'error' && <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#8b95a3' }}>{IcVideoOff({ c: '#8b95a3', s: 28 })}<span style={{ fontSize: 12 }}>Sin señal</span><span style={{ fontSize: 10, color: '#5a6a8f', maxWidth: 240, textAlign: 'center', wordBreak: 'break-all' }}>{(stream && stream.base) || 'sin go2rtc_url'} · {(stream && stream.src) || '?'}</span><button onClick={() => setGen(g => g + 1)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,.08)', color: '#cdd3db', border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>{IcReload({ c: '#cdd3db', s: 13 })} Reintentar</button></div>}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', background: 'linear-gradient(180deg,rgba(0,0,0,.62),transparent)', color: '#fff' }}>
        {Ic({ c: '#fff', s: 14 })}
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,.6)' }}>{(stream && stream.label) || 'Dispositivo'}</span>
        {status === 'live' && <button onClick={toggleMute} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', padding: 0 }}>{IcSpeaker({ c: muted ? '#8b95a3' : '#fff', s: 15 })}</button>}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, color: status === 'live' ? '#69db7c' : status === 'connecting' ? '#ffd43b' : '#ff8787' }}><span className={status === 'live' ? 'ic-pulse' : ''} style={{ width: 7, height: 7, borderRadius: '50%', background: status === 'live' ? '#40c057' : status === 'connecting' ? '#fab005' : '#fa5252' }} />{status === 'live' ? 'EN VIVO' : status === 'connecting' ? 'CARGANDO' : 'OFFLINE'}</span>
      </div>
    </div>
  );
}

function loadPref(k, d) { try { const o = JSON.parse(localStorage.getItem('sp_prefs2') || '{}'); return k in o ? o[k] : d; } catch { return d; } }
function ToggleRow({ label, desc, on, onChange }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 2px', borderBottom: `1px solid ${C.line}` }}>
    <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>{label}</div>{desc && <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{desc}</div>}</div>
    <button onClick={() => onChange(!on)} aria-pressed={on} style={{ width: 46, height: 26, borderRadius: 20, border: 'none', cursor: 'pointer', background: on ? C.green : '#cbd5e1', position: 'relative', transition: 'background .18s', flex: 'none' }}><span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.3)', transition: 'left .18s' }} /></button>
  </div>;
}
function DiagRow({ k, v, good }) { return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${C.line}` }}><div style={{ fontSize: 13, color: C.sub, width: 132, flex: 'none' }}>{k}</div><div style={{ fontSize: 13, fontWeight: 600, color: good === true ? '#15803d' : C.ink, wordBreak: 'break-all' }}>{v}</div></div>; }
const qLabel = (avg) => avg == null ? { t: 'sin datos', c: '#94a3b8' } : avg >= 3.5 ? { t: 'Excelente', c: '#22c55e' } : avg >= 2.5 ? { t: 'Buena', c: '#16a34a' } : avg >= 1.5 ? { t: 'Regular', c: '#f59e0b' } : { t: 'Mala', c: '#ef4444' };
const candLabel = (ct) => ct === 'relay' ? 'TURN (relay)' : ct === 'srflx' ? 'STUN (srflx)' : ct === 'prflx' ? 'peer-reflexive' : ct === 'host' ? 'directo (host)' : '—';
const DIAG_STEPS = ['Datos verificados', 'Conectando al servidor PBX', 'Estableciendo canal seguro', 'Registrando el interno', 'Verificando red (ICE/STUN)', 'Conexión lista'];
const DIAG_TOTAL = DIAG_STEPS.length;
function WinCtl({ dark }) {
  if (!(typeof window !== 'undefined' && window.sphone && window.sphone.winClose)) return null;
  const base = { WebkitAppRegion: 'no-drag', width: 34, height: 28, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, color: dark ? '#cfe0ff' : '#5b6b8c', transition: 'background .12s' };
  const hasMini = !!(window.sphone && window.sphone.miniShow);
  return (
    <div style={{ display: 'flex', gap: 2, WebkitAppRegion: 'no-drag', marginLeft: 6 }}>
      {hasMini && <button title="Modo mini (flotante)" style={base} onClick={() => { try { window.sphone.miniShow(true); } catch (_) {} }} onMouseEnter={e => { e.currentTarget.style.background = dark ? 'rgba(255,255,255,.1)' : '#eef1f7'; }} onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2" /><rect x="12" y="11" width="7" height="5" rx="1" /></svg></button>}
      <button title="Minimizar" style={base} onClick={() => window.sphone.winMinimize()} onMouseEnter={e => { e.currentTarget.style.background = dark ? 'rgba(255,255,255,.1)' : '#eef1f7'; }} onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}><svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.4" /></svg></button>
      <button title="Cerrar" style={base} onClick={() => window.sphone.winClose()} onMouseEnter={e => { e.currentTarget.style.background = '#ef4444'; e.currentTarget.style.color = '#fff'; }} onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = dark ? '#cfe0ff' : '#5b6b8c'; }}><svg width="12" height="12" viewBox="0 0 12 12"><line x1="2.6" y1="2.6" x2="9.4" y2="9.4" stroke="currentColor" strokeWidth="1.4" /><line x1="9.4" y1="2.6" x2="2.6" y2="9.4" stroke="currentColor" strokeWidth="1.4" /></svg></button>
    </div>
  );
}
function RingBell({ size = 110 }) {
  const b = useRef(null);
  useEffect(() => { const el = b.current; if (!el) return; gsap.set(el, { transformOrigin: '50% 16%' }); const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.35 }); tl.to(el, { rotation: 16, duration: 0.1, ease: 'power1.out' }).to(el, { rotation: -16, duration: 0.2, ease: 'power1.inOut' }).to(el, { rotation: 12, duration: 0.18, ease: 'power1.inOut' }).to(el, { rotation: -9, duration: 0.16, ease: 'power1.inOut' }).to(el, { rotation: 0, duration: 0.16, ease: 'power1.inOut' }); return () => tl.kill(); }, []);
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span className="bell-ring" style={{ width: size, height: size }} />
      <span className="bell-ring" style={{ width: size, height: size, animationDelay: '.8s' }} />
      <div style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62), borderRadius: '50%', background: 'linear-gradient(160deg,#4c9dff,#2f6bd6)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px rgba(47,128,255,.5)' }}>
        <svg ref={b} width={Math.round(size * 0.34)} height={Math.round(size * 0.34)} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
      </div>
    </div>
  );
}
function LiveWave({ getStream, bars = 9, h = 28, color = '#7ee2a6' }) {
  const ref = useRef(null);
  useEffect(() => {
    let stream; try { stream = getStream && getStream(); } catch {}
    if (!stream || !ref.current) return;
    let ctx, analyser, src, data, raf = 0, alive = true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)(); try { ctx.resume(); } catch {}
      src = ctx.createMediaStreamSource(stream); analyser = ctx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser); data = new Uint8Array(analyser.frequencyBinCount);
    } catch { return; }
    const spans = Array.from(ref.current.children);
    const tick = () => { if (!alive) return; analyser.getByteFrequencyData(data); const n = spans.length; for (let i = 0; i < n; i++) { const idx = 2 + i * 3; const v = (data[idx] || 0) / 255; if (spans[i]) spans[i].style.transform = 'scaleY(' + Math.max(0.15, Math.min(1, v * 1.35)).toFixed(2) + ')'; } raf = requestAnimationFrame(tick); };
    tick();
    return () => { alive = false; cancelAnimationFrame(raf); try { src.disconnect(); } catch {} try { ctx.close(); } catch {} };
  }, [getStream]);
  return <div ref={ref} style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 3, height: h }}>{Array.from({ length: bars }).map((_, i) => <span key={i} style={{ width: 4, height: '100%', background: color, borderRadius: 3, transformOrigin: 'center bottom', transform: 'scaleY(0.2)', transition: 'transform .07s linear' }} />)}</div>;
}
export default function App() {
  const [cfg, setCfg] = useState(loadConfig);
  const spWeb = useSip();
  const spNat = useSipNative();
  const sipMode = cfg.transport === 'sip';
  const sp = sipMode ? spNat : spWeb;
  const [tab, setTab] = useState(isComplete(loadConfig()) ? 'llamadas' : 'ajustes');
  const [num, setNum] = useState(''); const numRef = useRef(null);
  const [pad, setPad] = useState(false);
  const [devs, setDevs] = useState({ mics: [], cams: [], speakers: [] });
  const [prefs, setPrefs] = useState(getDevPrefs());
  const [photo, setPhoto] = useState(getPhoto);
  const [modal, setModal] = useState(null);
  const [recUrl, setRecUrl] = useState('');
  const [recState, setRecState] = useState('idle');
  const [dir, setDir] = useState(null);
  const [cls, setCls] = useState(null);
  const [selClient, setSelClient] = useState(null);
  const [streams, setStreams] = useState(null);
  const [clsFull, setClsFull] = useState(null); const [clientDet, setClientDet] = useState(null);
  const [apiForm, setApiForm] = useState({ base: api.getApiBase(), user: api.getApiUser(), pass: '' });
  const [apiOn, setApiOn] = useState(api.apiConnected());
  const [apiMsg, setApiMsg] = useState('');
  const [sipReg, setSipReg] = useState('idle');   // registro del motor SIP nativo
  const [sipMsg, setSipMsg] = useState('');
  const [sipLogs, setSipLogs] = useState([]);
  const [showQr, setShowQr] = useState(false);
  const [recording, setRecording] = useState(false);
  const [menu, setMenu] = useState(false); const [showProfile, setShowProfile] = useState(false);
  const [vm, setVm] = useState(null); const [vmAudio, setVmAudio] = useState({}); const [vmTx, setVmTx] = useState({}); const [pres, setPres] = useState({});
  const [scdr, setScdr] = useState(null); const [xfer, setXfer] = useState(false); const [xferNum, setXferNum] = useState('');
  const [favs, setFavs] = useState(() => { try { return JSON.parse(localStorage.getItem('sp_favs') || '[]'); } catch { return []; } });
  const [showDiag, setShowDiag] = useState(false); const [callStats, setCallStats] = useState(null); const [upd, setUpd] = useState(null);
  const [popClient, setPopClient] = useState(null);
  const [splash, setSplash] = useState(true); const [splashOut, setSplashOut] = useState(false); const splashRef = useRef(null);
  useEffect(() => { if (splash && splashRef.current) return gSplash(splashRef.current); }, [splash]);
  const [accts, setAccts] = useState(() => cfgGetAccounts()); const [showAccts, setShowAccts] = useState(false);
  const [authed, setAuthed] = useState(() => isComplete(loadConfig())); const [diag, setDiag] = useState(null);
  useEffect(() => { if (window.sphone && window.sphone.winSize) window.sphone.winSize(920, authed ? 640 : 560); }, [authed]);
  useEffect(() => { const t1 = setTimeout(() => setSplashOut(true), 2700); const t2 = setTimeout(() => setSplash(false), 3150); return () => { clearTimeout(t1); clearTimeout(t2); }; }, []);
  const [turnT, setTurnT] = useState(null);
  const [showProv, setShowProv] = useState(false); const [provExt, setProvExt] = useState(''); const [provQr, setProvQr] = useState(''); const [provUrl, setProvUrl] = useState(''); const [provErr, setProvErr] = useState(''); const [provBusy, setProvBusy] = useState(false);
  const [aTab, setATab] = useState('registro');
  const [dnd, setDnd] = useState(() => loadPref('dnd', false)); const [autoAnswer, setAutoAnswer] = useState(() => loadPref('autoAnswer', false)); const [ring, setRing] = useState(() => loadPref('ring', true)); const [showIntercom, setShowIntercom] = useState(() => loadPref('showIntercom', true)); const [soundsUi, setSoundsUi] = useState(() => loadPref('soundsUi', true));
  const [spyTarget, setSpyTarget] = useState(null); const [spyMsg, setSpyMsg] = useState('');
  const [clientQ, setClientQ] = useState(''); const [contactQ, setContactQ] = useState(''); const [cliTab, setCliTab] = useState('datos');
  const started = useRef(false);
  const spRef = useRef(sp); spRef.current = sp;

  function stopEngines() {
    try { if (window.sphone && window.sphone.sipDisconnect) window.sphone.sipDisconnect(); } catch {}
    setSipReg('idle'); setSipMsg('');
    try { sp.disconnect && sp.disconnect(); } catch {}
  }
  function startEngine(c) {
    if (c.transport === 'sip') { if (window.sphone && window.sphone.sipConnect) { setSipReg('connecting'); window.sphone.sipConnect(c); } else setSipReg('failed'); }
    else sp.connect(c);
  }
  useEffect(() => {
    if (window.sphone && window.sphone.onSipEvent) window.sphone.onSipEvent((evt) => {
      if (!evt) return;
      if (evt.type === 'reg') { setSipReg(evt.state); if (evt.state === 'registered') setSipMsg(''); else if (evt.reason) setSipMsg(evt.reason); }
      else if (evt.type === 'log') { try { console.log('[sip]', evt.dir, evt.line); } catch {} setSipLogs(l => [...l, ((evt.dir === 'out' ? '→ ' : evt.dir === 'in' ? '← ' : '· ') + evt.line)].slice(-9)); }
    });
    if (!started.current && isComplete(cfg)) { started.current = true; startEngine(cfg); }
  }, []); // eslint-disable-line
  useEffect(() => {
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}
    if (!window.sphone) return;
    window.sphone.onDial((n) => { setTab('llamadas'); if (n) spRef.current.placeCall(n, false); });
    window.sphone.onHotkey((a) => { const s = spRef.current;
      if (a === 'answer') { if (s.incoming) s.accept(); } else if (a === 'hangup') { if (s.inCall) s.hangup(); else if (s.incoming) s.reject(); } else if (a === 'mute') { if (s.inCall) s.toggleMute(); } });
    if (window.sphone.onProvision) window.sphone.onProvision((url) => { const pr = decodeProv(url); if (pr && applyProvRef.current) applyProvRef.current(pr); });
  }, []);
  useEffect(() => {
    if (!sp.incoming) return;
    const from = (sp.incoming.remoteIdentity && sp.incoming.remoteIdentity.uri && sp.incoming.remoteIdentity.uri.user) || 'desconocido';
    try { if (window.Notification && Notification.permission === 'granted') new Notification(sp.incomingVideo ? 'Videollamada entrante' : 'Llamada entrante', { body: from }); } catch {}
  }, [sp.incoming, sp.incomingVideo]);
  useEffect(() => { if (tab === 'ajustes') listDevices().then(setDevs); }, [tab]);
  useEffect(() => { if (tab === 'llamadas' && !sp.inCall && !sp.incoming && !splash && authed) { const t = setTimeout(() => { try { numRef.current && numRef.current.focus(); } catch {} }, 120); return () => clearTimeout(t); } }, [tab, sp.inCall, sp.incoming, splash, authed]);
  useEffect(() => { if ((!apiOn && (tab === 'clientes' || tab === 'intercom' || tab === 'voz')) || (!showIntercom && tab === 'intercom')) setTab('llamadas'); }, [apiOn, tab, showIntercom]);
  const loadVm = () => { if (apiOn && cfg.ext) api.vmList(cfg.ext).then(d => setVm(Array.isArray(d) ? d : (d && (d.messages || d.msgs)) || [])).catch(() => setVm([])); };
  useEffect(() => { if (apiOn && cfg.ext) loadVm(); }, [apiOn, tab, cfg.ext]); // eslint-disable-line
  useEffect(() => {
    if (apiOn && cfg.ext && tab === 'llamadas') {
      const mine = String(cfg.ext);
      api.cdr(cfg.ext, 120).then(rows => setScdr((Array.isArray(rows) ? rows : []).map(r => {
        const out = String(r.src) === mine; const number = out ? r.dst : r.src; const answered = r.disposition === 'ANSWERED';
        return { number: number || '—', dir: out ? 'out' : 'in', missed: !answered && !out, dur: r.billsec || 0, t: new Date(r.start).getTime(), video: false, disp: r.disposition, server: true };
      }))).catch(() => setScdr(null));
    }
  }, [apiOn, tab, cfg.ext]); // eslint-disable-line
  useEffect(() => { if (!apiOn) return; let alive = true; const l = () => api.presence().then(d => alive && setPres(d || {})).catch(() => {}); l(); const iv = setInterval(l, 8000); return () => { alive = false; clearInterval(iv); }; }, [apiOn]);
  useEffect(() => {
    if (!apiOn || !sp.incoming) return;
    const from = (sp.incoming.remoteIdentity && sp.incoming.remoteIdentity.uri && sp.incoming.remoteIdentity.uri.user) || '';
    if (!from || /^[0-9]{2,5}$/.test(from)) return; // internos cortos no matchean CRM
    let alive = true; api.clientsLookup(from).then(c => { if (alive && c && c.id) setPopClient(c); }).catch(() => {});
    return () => { alive = false; };
  }, [sp.incoming, apiOn]);
  useEffect(() => { if (!sp.incoming && !sp.inCall) setPopClient(null); }, [sp.incoming, sp.inCall]);
  useEffect(() => {
    if (!(window.sphone && window.sphone.miniState)) return;
    const ci = sp.callInfo || {};
    const inNum = sp.incoming ? ((sp.incoming.remoteIdentity && sp.incoming.remoteIdentity.uri && sp.incoming.remoteIdentity.uri.user) || '') : '';
    window.sphone.miniState({ active: !!(sp.inCall || sp.incoming), incoming: !!sp.incoming, video: !!sp.incomingVideo, number: sp.incoming ? inNum : (ci.number || ''), name: (popClient && popClient.name) || '', since: ci.since || 0, muted: !!sp.muted, ext: cfg.ext || '', registered: !!(sp.registered || sipReg === 'registered'), volume: typeof sp.volume === 'number' ? sp.volume : 1 });
  }, [sp.inCall, sp.incoming, sp.callInfo, sp.muted, popClient, cfg.ext, sp.registered, sipReg, sp.volume]); // eslint-disable-line
  useEffect(() => {
    if (!(window.sphone && window.sphone.onMiniAction)) return;
    return window.sphone.onMiniAction((m) => {
      const s = spRef.current; if (!s) return;
      const a = (m && typeof m === 'object') ? m.a : m, v = (m && typeof m === 'object') ? m.v : undefined;
      if (a === 'mute') s.toggleMute();
      else if (a === 'hangup') s.hangup();
      else if (a === 'accept') s.accept(false);
      else if (a === 'accept-video') s.accept(true);
      else if (a === 'reject') s.reject();
      else if (a === 'volume' && typeof v === 'number') s.setVolume(v);
      else if (a === 'dial') { setTab('llamadas'); setTimeout(() => { try { numRef.current && numRef.current.focus(); } catch {} }, 200); }
      else if (a === 'devices') { setTab('ajustes'); setATab('disp'); }
    });
  }, []);
  useEffect(() => { try { localStorage.setItem('sp_prefs2', JSON.stringify({ dnd, autoAnswer, ring, showIntercom, soundsUi })); } catch {} }, [dnd, autoAnswer, ring, showIntercom, soundsUi]);
  useEffect(() => { try { localStorage.setItem('sp_favs', JSON.stringify(favs)); } catch {} }, [favs]);
  const toggleFav = (ext) => { const e = String(ext); setFavs(f => f.includes(e) ? f.filter(x => x !== e) : [...f, e]); };
  const favName = (ext) => { const d = Array.isArray(dir) ? dir.find(x => String(x.ext) === String(ext)) : null; return d ? (d.name || ext) : ext; };
  const qAcc = useRef([]), lastCI = useRef(null), lastRelay = useRef(null), lastCodec = useRef(null), answeredAt = useRef(0), prevInCall = useRef(false);
  useEffect(() => { if (sp.inCall && sp.quality) { qAcc.current.push(sp.quality.score); if (sp.quality.codec) lastCodec.current = sp.quality.codec; } }, [sp.quality, sp.inCall]);
  useEffect(() => { if (sp.callInfo) lastCI.current = sp.callInfo; }, [sp.callInfo]);
  useEffect(() => { if (sp.usingRelay != null) lastRelay.current = sp.usingRelay; }, [sp.usingRelay]);
  useEffect(() => { if (sp.inCall && sp.callInfo && sp.callInfo.since && !answeredAt.current) answeredAt.current = Date.now(); }, [sp.inCall, sp.callInfo]);
  useEffect(() => {
    if (prevInCall.current && !sp.inCall) {
      const ci = lastCI.current;
      if (answeredAt.current && ci) { const dur = Math.max(0, Math.round((Date.now() - answeredAt.current) / 1000)); const sc = qAcc.current; const avg = sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : null; setCallStats({ number: ci.number, dur, avg, relay: lastRelay.current, codec: lastCodec.current }); }
      qAcc.current = []; answeredAt.current = 0; lastCI.current = null; lastRelay.current = null;
    }
    prevInCall.current = sp.inCall;
  }, [sp.inCall]); // eslint-disable-line
  useEffect(() => { if (callStats) { const t = setTimeout(() => setCallStats(null), 9000); return () => clearTimeout(t); } }, [callStats]);
  useEffect(() => { if (!window.sphone || !window.sphone.onUpdate) return; const off = window.sphone.onUpdate(m => setUpd(m)); return off; }, []);
  useEffect(() => { if (upd && (upd.state === 'none' || upd.state === 'error')) { const t = setTimeout(() => setUpd(null), 5000); return () => clearTimeout(t); } }, [upd]);
  useEffect(() => { if (dnd && sp.incoming) { try { sp.reject(); } catch {} } }, [dnd, sp.incoming]); // eslint-disable-line
  useEffect(() => { if (!dnd && autoAnswer && sp.incoming) { const t = setTimeout(() => { try { sp.accept(false); } catch {} }, 1200); return () => clearTimeout(t); } }, [autoAnswer, dnd, sp.incoming]); // eslint-disable-line
  useEffect(() => { sounds.setUiSounds(soundsUi); sounds.setRingSounds(ring); }, [soundsUi, ring]);
  useEffect(() => {
    if (sp.incoming && ring && !dnd) { sounds.startIncomingRing(); try { window.sphone && window.sphone.winShake && window.sphone.winShake(true); } catch {} }
    return () => { sounds.stopIncomingRing(); try { window.sphone && window.sphone.winShake && window.sphone.winShake(false); } catch {} };
  }, [sp.incoming, ring, dnd]); // eslint-disable-line
  useEffect(() => {
    const calling = sp.inCall && sp.callInfo && !sp.callInfo.since && !sp.incoming;
    if (calling && ring) sounds.startRingback();
    return () => sounds.stopRingback();
  }, [sp.inCall, sp.callInfo, sp.incoming, ring]); // eslint-disable-line
  useEffect(() => { if (apiOn && dir === null) api.directory().then(d => setDir(Array.isArray(d) ? d : [])).catch(() => setDir([])); }, [tab, apiOn, dir]);
  useEffect(() => { if ((tab === 'clientes' || tab === 'intercom') && apiOn && cls === null) api.clients().then(d => setCls(Array.isArray(d) ? d : [])).catch(() => setCls([])); }, [tab, apiOn, cls]);
  useEffect(() => { if (selClient && tab === 'intercom') { setStreams(null); api.clientStreams(selClient.id).then(d => setStreams(Array.isArray(d) ? d : [])).catch(() => setStreams([])); } }, [selClient, tab]);
  useEffect(() => { if (tab === 'clientes' && apiOn && clsFull === null) api.clientsFull().then(d => setClsFull(Array.isArray(d) ? d : [])).catch(() => setClsFull([])); }, [tab, apiOn, clsFull]);
  useEffect(() => { setCliTab('datos'); }, [selClient]);
  useEffect(() => { if (tab === 'clientes' && selClient) { setClientDet(null); api.clientDetail(selClient.id).then(d => setClientDet(d || {})).catch(() => setClientDet({})); } }, [selClient, tab]);

  function connectNow() {
    saveConfig(cfg); started.current = true;
    if (cfg.transport === 'sip') { setSipLogs([]); setSipMsg(''); }
    stopEngines();                                        // el motor anterior (nativo o WebRTC) se baja siempre
    setTimeout(() => startEngine(cfgLatest.current), 250);
  }
  const cfgLatest = useRef(cfg); cfgLatest.current = cfg;
  function runTurnTest() { setTurnT({ state: 'testing' }); testIce(cfgLatest.current).then(r => setTurnT(r)).catch(e => setTurnT({ state: 'error', errors: [String(e && e.message || e)], host: 0, srflx: 0, relay: 0 })); }
  useEffect(() => { if (tab === 'ajustes' && aTab === 'red') runTurnTest(); }, [tab, aTab]); // eslint-disable-line
  useEffect(() => { if (authed && cfgLatest.current && cfgLatest.current.turn) setTimeout(runTurnTest, 1200); }, [authed]); // eslint-disable-line
  const startEngineRef = useRef(startEngine); startEngineRef.current = startEngine;
  useEffect(() => {
    const reconnect = (why) => {
      const c = cfgLatest.current;
      if (!isComplete(c) || !started.current) return;
      try { if (window.sphone && window.sphone.sipDisconnect) window.sphone.sipDisconnect(); } catch {}
      try { startEngineRef.current(c); } catch {}
    };
    let off = null;
    try { if (window.sphone && window.sphone.onSysEvent) off = window.sphone.onSysEvent((e) => { if (e === 'resume') setTimeout(() => reconnect('resume'), 1800); }); } catch {}
    const onOnline = () => setTimeout(() => reconnect('online'), 900);
    window.addEventListener('online', onOnline);
    return () => { try { off && off(); } catch {} window.removeEventListener('online', onOnline); };
  }, []);
  function applyProv(prov) {
    if (prov.apiBase) { api.applySession({ base: prov.apiBase, token: prov.apiToken }); if (prov.apiToken) { setApiOn(true); setDir(null); setCls(null); setClsFull(null); } }
    const merged = { ...cfgLatest.current, ...prov };
    delete merged.apiBase; delete merged.apiToken;
    merged.transport = prov.transport || (prov.wss ? 'webrtc' : merged.transport || 'webrtc');
    merged.name = prov.name || '';                       // el nombre viene del server: nunca heredar el del interno anterior
    setCfg(merged); saveConfig(merged); setShowQr(false);
    started.current = true; setAuthed(true); setTab('llamadas');
    stopEngines();                                        // baja SIEMPRE los dos motores antes de arrancar el que toca
    setTimeout(() => startEngine(merged), 250);
  }
  const applyProvRef = useRef(applyProv); applyProvRef.current = applyProv;
  function diagText() {
    const q = sp.quality || {}; const now = new Date().toLocaleString('es-UY');
    return ['PBX-NG Softphone ' + APP_VERSION, 'Fecha: ' + now, '', '[Registro]', 'Estado: ' + (registered ? 'registrado' : (sp.reg || 'no')), 'Transporte: ' + (sipMode ? ('SIP ' + (cfg.sipTransport || 'udp').toUpperCase()) : 'WebRTC'), 'Servidor: ' + (sipMode ? (cfg.sipServer + ':' + cfg.sipPort) : cfg.wss), 'Dominio: ' + cfg.domain, 'Interno: ' + cfg.ext, 'Nombre: ' + (cfg.name || '-'), sipMode ? ('SRTP: ' + (cfg.sipSrtp || 'none')) : '', '', '[Sistema/CRM]', 'Conectado: ' + (apiOn ? 'si' : 'no'), 'Base: ' + (api.getApiBase() || '-'), 'Usuario: ' + (api.getApiUser() || '-'), '', '[Llamada]', sp.inCall ? ('Numero: ' + ((sp.callInfo && sp.callInfo.number) || '-')) : 'sin llamada activa', sp.inCall ? ('Codec: ' + (q.codec || '-')) : '', sp.inCall ? ('Ruta: ' + candLabel(q.candType)) : '', sp.inCall ? ('RTT: ' + (q.rtt != null ? q.rtt + ' ms' : '-') + ' | Jitter: ' + (q.jitter != null ? q.jitter + ' ms' : '-') + ' | Perdida: ' + (q.loss != null ? q.loss + '%' : '-')) : '', '', '[Entorno]', 'Electron: ' + (window.sphone ? 'si' : 'no (navegador)'), 'UA: ' + navigator.userAgent].filter(x => x !== '').join('\n');
  }
  async function genProv() {
    setProvErr(''); setProvQr(''); setProvUrl(''); const e = provExt.trim(); if (!e) return; setProvBusy(true);
    try { const d = await api.provision(e); if (!d || d.error || !d.prov_url) { setProvErr((d && d.error) || 'no se pudo generar'); } else { setProvUrl(d.prov_url); const img = await QRCode.toDataURL(d.prov_url, { width: 260, margin: 1, errorCorrectionLevel: 'M' }); setProvQr(img); } } catch (err) { setProvErr(String((err && err.message) || err)); }
    setProvBusy(false);
  }
  function exportDiag() { const txt = diagText(); try { navigator.clipboard.writeText(txt); } catch {} try { const blob = new Blob([txt], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pbxng-diag-' + Date.now() + '.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } catch {} }
  function logout() { setMenu(false); try { if (window.sphone && window.sphone.sipDisconnect) window.sphone.sipDisconnect(); } catch {} try { sp.disconnect && sp.disconnect(); } catch {} const n = { ...cfgLatest.current, ext: '', pass: '' }; setCfg(n); saveConfig(n); started.current = false; setAuthed(false); setDiag(null); setTab('ajustes'); }
  function persistAccts(list) { setAccts(list); cfgSetAccounts(list); }
  const acctId = (c) => (c.ext || '') + '@' + (c.domain || c.sipServer || '');
  function saveCurrentAccount() { const c = cfgLatest.current; if (!isComplete(c)) return; const id = acctId(c); const acct = { id, label: c.name || ('Interno ' + c.ext), cfg: { ...c }, api: { base: api.getApiBase(), token: api.getToken(), user: api.getApiUser() } }; persistAccts([...accts.filter(a => a.id !== id), acct]); }
  function switchAccount(a) { setMenu(false); setShowAccts(false); stopEngines(); const c = { ...a.cfg }; setCfg(c); saveConfig(c); if (a.api && a.api.token) { api.applySession({ base: a.api.base, token: a.api.token, user: a.api.user }); setApiOn(true); } else { api.apiLogout(); setApiOn(false); } setDir(null); setCls(null); setClsFull(null); setPopClient(null); started.current = true; setAuthed(true); setTab('llamadas'); startEngine(c); }
  function removeAccount(id) { persistAccts(accts.filter(a => a.id !== id)); }
  const foTried = useRef(false);
  useEffect(() => {
    const cur = cfgLatest.current || {};
    if ((cur.transport || 'webrtc') === 'sip') return;
    if (sp.registered) { foTried.current = false; return; }
    if (sp.reg === 'failed' && cur.wssBackup && !foTried.current) { foTried.current = true; const swapped = { ...cur, wss: cur.wssBackup, wssBackup: cur.wss }; setCfg(swapped); saveConfig(swapped); startEngine(swapped); }
  }, [sp.reg, sp.registered]); // eslint-disable-line
  async function vmPlay(id, folder) { try { const url = await api.vmAudioUrl(cfg.ext, folder, id); if (url) setVmAudio(a => ({ ...a, [id]: url })); await api.vmRead(cfg.ext, folder, id); loadVm(); } catch {} }
  async function vmDelete(id, folder) { try { await api.vmDel(cfg.ext, folder, id); loadVm(); } catch {} }
  async function transcribeVm(id, folder) { setVmTx(t => ({ ...t, [id]: { loading: true } })); try { const d = await api.vmTranscribe(cfg.ext, folder, id); if (d && !d.error) setVmTx(t => ({ ...t, [id]: { text: (d.transcript || '').trim() || '(sin texto reconocido)', analysis: d.analysis } })); else setVmTx(t => ({ ...t, [id]: { error: (d && d.error) || 'no se pudo transcribir' } })); } catch (e) { setVmTx(t => ({ ...t, [id]: { error: String((e && e.message) || e) } })); } }
  const vmUnread = Array.isArray(vm) ? vm.filter(m => (m.folder || 'INBOX') === 'INBOX').length : 0;
  const rec = (apiOn && Array.isArray(scdr)) ? scdr : sp.hist;
  const dialMatches = (num && Array.isArray(dir)) ? dir.filter(d => { const n = String(d.ext || d.number || d.exten || ''); const nm = String(d.name || d.cn || d.callerid || '').toLowerCase(); return (n && n.includes(num)) || (nm && nm.includes(num.toLowerCase())); }).slice(0, 6) : [];
  const presColor = (ext) => { const st = String(pres[String(ext)] || '').toLowerCase(); if (!st) return null; if (st.includes('inuse') && !st.includes('not')) return '#f59e0b'; if (st === 'busy' || st === 'ringing' || st === 'ring' || st === 'onhold' || st === 'in_call') return '#f59e0b'; if (st === 'not_inuse' || st === 'online' || st === 'available' || st === 'idle') return C.green; return '#c2c9d6'; };
  function press(k) { sounds.uiKey(); sp.sendDtmf(k); if (!sp.inCall) setNum(n => (n + k).slice(0, 30)); }
  function callNow(n, video) { sounds.uiClick(); const t = (n || num).trim(); if (t) { setTab('llamadas'); setModal(null); sp.placeCall(t, !!video).then(() => setNum('')); } }
  function pickDev(kind, id) { setDevPref(kind, id); setPrefs(getDevPrefs()); if (kind === 'spk') sp.applySpeaker(id); }
  async function toggleRecord() { const next = !recording; try { const r = await api.recordCall(cfg.ext, next ? 'start' : 'stop'); if (!r || !r.error) setRecording(next); } catch {} }
  async function doSpy(mode) { if (!spyTarget) return; setSpyMsg('Originando…'); try { const r = await api.spyCall(cfg.ext, spyTarget.ext, mode); if (r && r.error) setSpyMsg('Error: ' + r.error); else { setSpyMsg('✓ Atendé la llamada entrante para escuchar.'); setTimeout(() => { setSpyTarget(null); setSpyMsg(''); }, 1800); } } catch (e) { setSpyMsg('Error: ' + e.message); } }
  useEffect(() => { if (!sp.inCall) setRecording(false); }, [sp.inCall]);
  function onPhoto(e) { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { localStorage.setItem('sp_photo', r.result); } catch {} setPhoto(r.result); }; r.readAsDataURL(f); }
  function clearPhoto() { try { localStorage.removeItem('sp_photo'); } catch {} setPhoto(''); }
  async function doApiLogin() {
    setApiMsg('Conectando…');
    const base = apiForm.base || api.baseFromWss(cfg.wss);
    const r = await api.apiLogin(base, apiForm.user, apiForm.pass);
    if (r.ok) { setApiOn(true); setApiMsg('Conectado al sistema ✓'); setDir(null); setCls(null); }
    else { setApiOn(false); setApiMsg('Error: ' + (r.error || 'no se pudo conectar')); }
  }
  function apiDisconnect() { api.apiLogout(); setApiOn(false); setApiMsg(''); setDir(null); setCls(null); setClsFull(null); setClientDet(null); setSelClient(null); setStreams(null); }
  async function openCall(h) {
    setModal(h); setRecUrl(''); setRecState('idle');
    if (!apiOn) return;
    setRecState('loading');
    try {
      const ts = Math.floor((h.t - (h.dur || 0) * 1000) / 1000);
      const from = h.dir === 'out' ? cfg.ext : h.number, to = h.dir === 'out' ? h.number : cfg.ext;
      const m = await api.matchRecording(from, to, ts);
      if (m && m.id) { const url = await api.recordingAudioUrl(m.id); if (url) { setRecUrl(url); setRecState('ready'); return; } }
      setRecState('none');
    } catch { setRecState('none'); }
  }

  const F = (label, key, type = 'text', ph = '') => (
    <div style={{ padding: '6px 0', borderBottom: `1px solid ${C.line}` }}>
      <div style={S.fieldLbl}>{label}</div>
      <input style={S.inp} type={type} value={cfg[key] || ''} placeholder={ph} onChange={e => setCfg(c => ({ ...c, [key]: e.target.value, ...(key === 'ext' && c.name && c.name !== e.target.value ? { name: '' } : {}) }))} autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div>
  );
  const regState = sipMode ? sipReg : sp.reg;
  const registered = sipMode ? sipReg === 'registered' : sp.registered;
  const regMsg = sipMode ? sipMsg : (sp.note || '');
  const statusTxt = registered ? 'en línea' : (regState === 'connecting' ? 'conectando…' : regState === 'failed' ? 'error de registro' : 'sin conectar');
  function loginConnect() { if (!isComplete(cfg)) { setDiag({ step: 0, error: 'Completá los datos obligatorios.' }); return; } setDiag({ step: 1, error: null }); connectNow(); }
  const loginPhase = !diag ? 'form' : (diag.step >= DIAG_TOTAL ? 'ok' : 'verify');
  useEffect(() => {
    if (!diag || diag.error) return;
    const reg = sipMode ? sipReg : sp.reg; const ok = sipMode ? (sipReg === 'registered') : sp.registered;
    if (reg === 'failed') { const why = sipMode ? sipMsg : (sp.note || ''); setDiag(d => (d && !d.error ? { ...d, error: why || 'No se pudo registrar. Revisá el servidor y las credenciales.' } : d)); return; }
    if (diag.step >= DIAG_TOTAL) return;
    if (diag.step === 4 && !ok) return; // el paso de registro espera el registro real
    const dwell = diag.step === 4 ? 500 : 800;
    const t = setTimeout(() => setDiag(d => (d && !d.error ? { ...d, step: Math.min(d.step + 1, DIAG_TOTAL) } : d)), dwell);
    return () => clearTimeout(t);
  }, [diag, sp.reg, sp.registered, sipReg, sipMode]); // eslint-disable-line
  useEffect(() => { if (diag && diag.step === 4 && !diag.error) { const ok = sipMode ? (sipReg === 'registered') : sp.registered; if (ok) return; const t = setTimeout(() => setDiag(d => (d && d.step === 4 && !d.error ? { ...d, error: 'Tardó demasiado en registrar. Verificá el servidor y la red.' } : d)), 15000); return () => clearTimeout(t); } }, [diag, sp.registered, sipReg, sipMode]); // eslint-disable-line
  useEffect(() => { if (diag && diag.step >= DIAG_TOTAL && !diag.error) { const t = setTimeout(() => { setAuthed(true); setDiag(null); setTab('llamadas'); }, 1700); return () => clearTimeout(t); } }, [diag]); // eslint-disable-line
  const LF = (icon, label, key, tip, type = 'text', ph = '') => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, minWidth: 0 }}><span style={{ fontSize: 12, fontWeight: 600, color: '#c7d4ee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>{tip && <span title={tip} style={{ cursor: 'help', width: 15, height: 15, borderRadius: '50%', border: '1px solid #5c7099', color: '#9db4e0', fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontStyle: 'italic', fontWeight: 700 }}>i</span>}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 10, padding: '0 12px' }}>
        {icon}
        <input type={type} value={cfg[key] || ''} placeholder={ph} onChange={e => setCfg(c => ({ ...c, [key]: e.target.value, ...(key === 'ext' && c.name && c.name !== e.target.value ? { name: '' } : {}) }))} autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#eaf1ff', fontSize: 14, padding: '11px 0' }} onKeyDown={e => { if (e.key === 'Enter') loginConnect(); }} />
      </div>
    </div>
  );
  const media = <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} aria-hidden><audio ref={sp.audioRef} autoPlay /></div>;
  const nav = [['llamadas', IcGrid, 'Llamadas'], ['contactos', IcUser, 'Contactos'], ...(apiOn ? [['voz', IcVoicemail, 'Voz'], ['clientes', IcUsers, 'Clientes'], ...(showIntercom ? [['intercom', IcCam, 'Intercom']] : [])] : []), ['ajustes', IcGear, 'Ajustes']];

  return (
    <div style={S.root}>
      {media}
      {splash && (
        <div ref={splashRef} style={{ position: 'fixed', inset: 0, zIndex: 400, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'radial-gradient(120% 120% at 50% 0%,#16233f 0%,#0b1220 60%,#070c16 100%)', color: '#eaf1ff', opacity: splashOut ? 0 : 1, transition: 'opacity .45s ease', pointerEvents: splashOut ? 'none' : 'auto' }}>
          <div style={{ position: 'relative', width: 104, height: 104, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="sp-ring" /><span className="sp-ring" style={{ animationDelay: '.6s' }} /><span className="sp-ring" style={{ animationDelay: '1.2s' }} />
            <div className="sp-badge" style={{ width: 76, height: 76, borderRadius: 22, background: 'linear-gradient(160deg,#22c55e,#16a34a)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px rgba(34,197,94,.45)' }}>
              <svg className="sp-handset" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 4.2 2 2 0 0 1 5.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L9.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z" /></svg>
            </div>
          </div>
          <div className="sp-title" style={{ fontSize: 22, fontWeight: 700, letterSpacing: .3, marginTop: 4 }}>PBX-NG <b style={{ color: '#4ade80' }}>Softphone</b></div>
          <div className="sp-ver" style={{ fontSize: 13, color: '#8fa6cc', marginTop: -8 }}>{APP_VERSION}</div>
          <div style={{ width: 190, height: 4, borderRadius: 4, background: 'rgba(255,255,255,.12)', overflow: 'hidden', marginTop: 6 }}><i className="sp-bar" style={{ display: 'block', height: '100%', width: '40%', borderRadius: 4, background: 'linear-gradient(90deg,#22c55e,#4c9dff)' }} /></div>
          <div style={{ position: 'absolute', bottom: 22, fontSize: 11, color: '#5c7099', letterSpacing: .4 }}>Infratec · WebRTC / SIP</div>
        </div>
      )}
      {!authed && !splash && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', flexDirection: 'column', background: 'radial-gradient(120% 120% at 50% 0%,#16233f 0%,#0b1220 60%,#070c16 100%)', color: '#eaf1ff' }}>
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }} aria-hidden>
            <svg viewBox="0 0 24 24" width="120" height="120" fill="none" stroke="#2f80ff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', top: 70, left: 40, opacity: .06 }} className="lfloat"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 4.2 2 2 0 0 1 5.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L9.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z" /></svg>
            <svg viewBox="0 0 24 24" width="80" height="80" fill="none" stroke="#22c55e" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', top: 220, right: 50, opacity: .06 }} className="lfloat2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 4.2 2 2 0 0 1 5.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L9.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z" /></svg>
            <svg className="lwave lwave1" viewBox="0 0 1440 200" preserveAspectRatio="none" style={{ position: 'absolute', bottom: 0, left: 0, width: '200%', height: 190 }}><path fill="#2f80ff" fillOpacity="0.14" d="M0,90 C240,150 480,30 720,90 C960,150 1200,30 1440,90 L1440,200 L0,200 Z" /></svg>
            <svg className="lwave lwave2" viewBox="0 0 1440 200" preserveAspectRatio="none" style={{ position: 'absolute', bottom: -12, left: 0, width: '200%', height: 210 }}><path fill="#22c55e" fillOpacity="0.10" d="M0,100 C300,40 520,160 760,100 C1000,40 1200,160 1440,100 L1440,200 L0,200 Z" /></svg>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', WebkitAppRegion: 'drag' }}>
            <div />
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, WebkitAppRegion: 'no-drag' }}>
              {accts.length > 0 && <button onClick={() => setShowAccts(true)} title="Cuentas guardadas" style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.16)', borderRadius: 9, padding: '7px 9px', cursor: 'pointer', color: '#cfe0ff', display: 'flex' }}>{IcUsers({ c: '#cfe0ff', s: 18 })}</button>}
              <WinCtl dark />
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 20px 20px' }}>
            {loginPhase === 'form' && (
              <div key="form" ref={gEnter} style={{ width: '100%', maxWidth: 380 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                  <div style={{ fontSize: 21, fontWeight: 700, flex: 1, minWidth: 0 }}>Conectar a tu central</div>
                  <button className="qr-btn" onClick={() => { sounds.uiClick(); setShowQr(true); }} title="Configurar por QR / código de aprovisionamiento"
                    style={{ flex: 'none', width: 46, height: 46, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#cfe0ff', background: 'rgba(76,157,255,.14)', border: '1px solid rgba(120,180,255,.35)', transition: 'transform .15s ease, background .15s ease' }}>
                    {IcQr({ c: '#cfe0ff', s: 26 })}
                  </button>
                </div>
                <div style={{ fontSize: 13, color: '#8fa6cc', marginBottom: 16 }}>Ingresá los datos del interno, o usá el <b style={{ color: '#cfe0ff' }}>QR</b> de aprovisionamiento (botón de la derecha).</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  {[['webrtc', 'WebRTC'], ['sip', 'SIP nativo']].map(([tv, lb]) => { const on = (cfg.transport || 'webrtc') === tv; return (
                    <button key={tv} onClick={() => { if (tv === 'sip' && !window.sphone) { alert('El modo SIP nativo solo funciona en la app de Windows.'); return; } setCfg(c => ({ ...c, transport: tv })); }} style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `1px solid ${on ? '#4c9dff' : 'rgba(255,255,255,.16)'}`, background: on ? 'rgba(76,157,255,.15)' : 'rgba(255,255,255,.04)', color: on ? '#cfe0ff' : '#8fa6cc', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>{lb}</button>); })}
                </div>
                {sipMode ? (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ flex: 2, minWidth: 0 }}>{LF(IcShield({ c: '#9db4e0', s: 17 }), 'Servidor SIP (host o IP)', 'sipServer', 'Host o IP de la central SIP, ej. 192.168.1.10', 'text', '192.168.1.10')}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>{LF(IcGrid({ c: '#9db4e0', s: 17 }), 'Puerto', 'sipPort', 'Puerto SIP (5060 UDP/TCP, 5061 TLS).', 'text', '5060')}</div>
                  </div>
                ) : (<>
                  {LF(IcShield({ c: '#9db4e0', s: 17 }), 'Servidor WebSocket (WSS)', 'wss', 'URL del WebSocket de la central, ej. wss://pbx.tu-dominio/ws', 'text', 'wss://tu-pbx/ws')}
                </>)}
                {LF(IcGrid({ c: '#9db4e0', s: 17 }), 'Dominio SIP', 'domain', 'Realm/dominio SIP; suele coincidir con el host.', 'text', 'tu-pbx.com')}
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>{LF(IcUser({ c: '#9db4e0', s: 17 }), 'Interno / usuario', 'ext', 'Tu interno o usuario SIP, ej. 2001.', 'text', '2001')}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>{LF(IcPower({ c: '#9db4e0', s: 17 }), 'Contraseña', 'pass', 'Contraseña del interno SIP.', 'password')}</div>
                </div>
                {(() => {
                  // WebRTC: lista completa (el SDP se remuxa). SIP nativo: sólo G.711 (el stack
                  // nativo encodea µ-law/A-law; Opus/G.722 no se pueden ofrecer de verdad).
                  const opts = sipMode
                    ? [['auto', 'Auto'], ['pcmu', 'G.711 µ'], ['pcma', 'G.711 A']]
                    : [['auto', 'Auto'], ['opus', 'Opus'], ['g722', 'G.722'], ['pcmu', 'G.711 µ'], ['pcma', 'G.711 A']];
                  const cur = cfg.codec || 'auto';
                  const isG711 = cur === 'pcmu' || cur === 'pcma';
                  return (
                    <div style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 12, color: '#8fa6cc', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>Códec de audio <span style={{ color: '#5c7099', fontSize: 11 }}>{sipMode ? '· G.711 (SIP nativo)' : '· para probar transcoding'}</span></div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {opts.map(([v, lb]) => { const on = sipMode ? (v === 'auto' ? !isG711 : cur === v) : (cur === v); return (
                          <button key={v} type="button" onClick={() => setCfg(c => ({ ...c, codec: v }))} style={{ padding: '7px 11px', borderRadius: 9, border: `1px solid ${on ? '#4c9dff' : 'rgba(255,255,255,.16)'}`, background: on ? 'rgba(76,157,255,.15)' : 'rgba(255,255,255,.04)', color: on ? '#cfe0ff' : '#8fa6cc', cursor: 'pointer', fontWeight: 600, fontSize: 12.5 }}>{lb}</button>); })}
                      </div>
                      {!sipMode && cur !== 'auto' && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12.5, color: '#9fb0d6', cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!cfg.codecForce} onChange={e => setCfg(c => ({ ...c, codecForce: e.target.checked }))} />
                          Forzar (ofrecer sólo este códec) — obliga al SBC a transcodificar
                        </label>
                      )}
                      {sipMode && isG711 && (
                        <div style={{ fontSize: 11.5, color: '#5c7099', marginTop: 6 }}>Se ofrece sólo {cur === 'pcmu' ? 'G.711 µ-law' : 'G.711 A-law'}; en Auto se ofrecen ambos y elige el otro extremo.</div>
                      )}
                    </div>
                  );
                })()}
                <button onClick={loginConnect} disabled={!isComplete(cfg)} style={{ width: '100%', marginTop: 8, padding: '13px 0', borderRadius: 11, border: 'none', background: isComplete(cfg) ? 'linear-gradient(90deg,#22c55e,#16a34a)' : 'rgba(255,255,255,.1)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: isComplete(cfg) ? 'pointer' : 'not-allowed', opacity: isComplete(cfg) ? 1 : .6 }}>Conectar y verificar</button>
                <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12, color: '#5c7099' }}>{APP_VERSION} · datos cifrados en este equipo</div>
              </div>
            )}
            {loginPhase === 'verify' && (() => { const cur = diag.step; const rows = DIAG_STEPS.slice(0, 5); return (
              <div key="verify" ref={gEnter} style={{ width: '100%', maxWidth: 360, textAlign: 'center' }}>
                <div style={{ position: 'relative', width: 88, height: 88, margin: '0 auto 18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {!diag.error && <><span className="sp-ring" /><span className="sp-ring" style={{ animationDelay: '.6s' }} /></>}
                  <div style={{ width: 64, height: 64, borderRadius: 18, background: diag.error ? 'linear-gradient(160deg,#ef4444,#b91c1c)' : 'linear-gradient(160deg,#22c55e,#16a34a)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{IcPhone({ c: '#fff', s: 30 })}</div>
                </div>
                <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>{diag.error ? 'No se pudo conectar' : 'Verificando conexión…'}</div>
                <div style={{ fontSize: 13, color: '#8fa6cc', marginBottom: 18 }}>{diag.error ? 'Revisá los datos e intentá de nuevo.' : 'Comprobando el registro con la central PBX-NG.'}</div>
                <div style={{ textAlign: 'left', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 14, padding: '14px 16px' }}>
                  {rows.map((lb, i) => { const n = i + 1; const state = cur > n ? 'done' : cur === n ? (diag.error ? 'error' : 'active') : 'pending'; return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
                      <span style={{ width: 23, height: 23, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', background: state === 'done' ? 'rgba(34,197,94,.2)' : state === 'error' ? 'rgba(239,68,68,.2)' : 'rgba(255,255,255,.08)' }}>
                        {state === 'done' ? <span style={{ color: '#4ade80', fontWeight: 800, fontSize: 13 }}>✓</span> : state === 'error' ? <span style={{ color: '#f87171', fontWeight: 800, fontSize: 13 }}>✕</span> : state === 'active' ? <span className="spin" style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(159,208,255,.35)', borderTopColor: '#7cc0ff', display: 'block' }} /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#5c7099' }} />}
                      </span>
                      <span style={{ fontSize: 13.5, color: state === 'pending' ? '#6b7f9f' : '#dbe6fb', fontWeight: state === 'active' ? 700 : 500 }}>{lb}</span>
                    </div>); })}
                  <div style={{ borderTop: '1px solid rgba(255,255,255,.1)', marginTop: 8, paddingTop: 10, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12 }}>
                    <span style={{ color: '#6b7f9f' }}>Transporte</span><span style={{ color: '#cfe0ff', textAlign: 'right' }}>{sipMode ? ('SIP ' + (cfg.sipTransport || 'udp').toUpperCase()) : 'WebRTC (WSS)'}</span>
                    <span style={{ color: '#6b7f9f' }}>Servidor</span><span style={{ color: '#cfe0ff', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sipMode ? (cfg.sipServer + ':' + cfg.sipPort) : cfg.wss}</span>
                    <span style={{ color: '#6b7f9f' }}>Interno</span><span style={{ color: '#cfe0ff', textAlign: 'right' }}>{cfg.ext} @ {cfg.domain}</span>
                  </div>
                </div>
                {diag.error && <button onClick={() => setDiag(null)} style={{ width: '100%', marginTop: 16, padding: '12px 0', borderRadius: 11, border: '1px solid rgba(255,255,255,.2)', background: 'rgba(255,255,255,.06)', color: '#eaf1ff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Volver a los datos</button>}
              </div>); })()}
            {loginPhase === 'ok' && (
              <div key="ok" ref={gEnter} style={{ width: '100%', maxWidth: 330, textAlign: 'center' }}>
                <div ref={gPop} style={{ width: 92, height: 92, borderRadius: '50%', margin: '0 auto 16px', background: 'linear-gradient(160deg,#22c55e,#16a34a)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 12px 34px rgba(34,197,94,.5)' }}><span style={{ color: '#fff', fontSize: 46, fontWeight: 800 }}>✓</span></div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>¡Conectado!</div>
                <div style={{ fontSize: 13, color: '#8fa6cc', marginTop: 6 }}>Interno {cfg.ext} en línea · {sipMode ? 'SIP' : 'WebRTC'}</div>
                <div style={{ fontSize: 12, color: '#5c7099', marginTop: 3 }}>Abriendo tu softphone…</div>
              </div>
            )}
          </div>
        </div>
      )}
      <div style={S.rail}>
        <div style={{ position: 'relative', marginBottom: 10, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setMenu(m => !m); }} title="Cuenta">
          <Ava photo={photo} txt={isComplete(cfg) ? initials(cfg.ext) : '·'} size={46} />
          <span style={{ position: 'absolute', right: -1, bottom: -1, width: 12, height: 12, borderRadius: '50%', background: registered ? C.green : '#9aa4bd', border: '2px solid ' + C.rail }} />
        </div>
        {isComplete(cfg) && <div style={{ color: '#9fb0d6', fontSize: 11, fontWeight: 700, marginTop: -2, marginBottom: 2 }}>{cfg.ext}</div>}
        <div style={{ flex: 1 }} />
        {nav.map(([id, Ic, lbl]) => <button key={id} style={S.navBtn(tab === id)} onClick={() => { sounds.uiClick(); withVT(() => setTab(id)); }}><div style={{ position: 'relative' }}>{Ic({ c: tab === id ? '#fff' : '#8194ba', s: 21 })}{id === 'voz' && vmUnread > 0 && <span style={{ position: 'absolute', top: -5, right: -9, background: C.red, color: '#fff', fontSize: 9, fontWeight: 700, borderRadius: 8, minWidth: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{vmUnread}</span>}</div><span>{lbl}</span></button>)}
        <div style={{ flex: 1 }} />
        <button onClick={() => { sounds.uiClick(); setShowQr(true); }} title="Configurar por QR" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8, marginBottom: 2, borderRadius: 10 }} onMouseEnter={e => { e.currentTarget.style.background = C.railHi; }} onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>{IcQr({ c: '#8194ba', s: 20 })}</button>
        <div style={{ color: '#5a6a8f', fontSize: 9, paddingBottom: 10 }}>{APP_VERSION}</div>
      </div>

      <div style={S.content}>
        <div style={{ ...S.header, WebkitAppRegion: 'drag' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.1 }}>{cfg.name || (isComplete(cfg) ? 'Interno ' + cfg.ext : 'Softphone')}</div>
              <div style={{ color: C.sub, fontSize: 12 }} title={regMsg || ''}><span style={{ color: registered ? C.green : '#c2c9d6' }}>●</span> {isComplete(cfg) ? cfg.ext + ' · ' : ''}{statusTxt}{!registered && regMsg ? <span style={{ color: C.red }}> · {regMsg.length > 46 ? regMsg.slice(0, 46) + '…' : regMsg}</span> : null}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, WebkitAppRegion: 'no-drag' }}>
            <TurnChip cfg={cfg} sp={sp} t={turnT} />
            <WinCtl />
          </div>
        </div>

        <div style={{ ...S.body, viewTransitionName: 'sp-content' }}>
          {tab === 'llamadas' && (<>
            <div style={S.dialCol}>
              <input ref={numRef} autoFocus style={S.numIn} value={num} onChange={e => setNum(e.target.value.replace(/[^\w*#+.@\s-]/g, ''))} placeholder="Número, interno o nombre" onKeyDown={e => { if (e.key === 'Enter') { if (dialMatches[0]) callNow(String(dialMatches[0].ext || dialMatches[0].number || dialMatches[0].exten || num)); else callNow(); } }} />
              <div style={{ height: 1, background: C.line, width: '100%', margin: '2px 0 14px' }} />
              {(dialMatches.length > 0 && !sp.inCall) ? (
                <div ref={gStagger} style={{ width: '100%', maxHeight: 236, overflowY: 'auto', margin: '2px 0 14px' }}>
                  {dialMatches.map((d, i) => { const n = String(d.ext || d.number || d.exten || ''); const nm = d.name || d.cn || d.callerid || n; const pc = presColor(n); return (
                    <div key={i} className="dd-row" onClick={() => { setNum(n); try { numRef.current && numRef.current.focus(); } catch {} }} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', cursor: 'pointer', borderRadius: 10, border: `1px solid ${C.line}`, background: '#fff', marginBottom: 6 }}>
                      <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}><Ava txt={initials(String(nm))} size={34} bg="linear-gradient(160deg,#7c9be0,#4f6fc9)" />{pc ? <span style={{ position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: '50%', background: pc, border: '2px solid #fff' }} /> : null}</span>
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}><div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nm}</div><div style={{ fontSize: 12, color: C.sub }}>{n}</div></div>
                      <button style={S.actBtn(C.accent)} title="Video" onClick={e => { e.stopPropagation(); callNow(n, true); }}>{IcVideo({ c: C.accent, s: 15 })}</button>
                      <button style={S.actBtn(C.green)} title="Llamar" onClick={e => { e.stopPropagation(); callNow(n); }}>{IcPhone({ c: C.green, s: 15 })}</button>
                    </div>); })}
                </div>
              ) : (
                <div style={S.keypad}>{[['1',''],['2','ABC'],['3','DEF'],['4','GHI'],['5','JKL'],['6','MNO'],['7','PQRS'],['8','TUV'],['9','WXYZ'],['*',''],['0','+'],['#','']].map(([k, sub]) => <button key={k} className="ph-key" style={S.key} onClick={() => press(k)}><span style={{ fontSize: 23, fontWeight: 500, lineHeight: 1 }}>{k}</span><span style={{ fontSize: 8.5, letterSpacing: 1, color: C.sub, height: 9 }}>{sub}</span></button>)}</div>
              )}
              <div style={{ display: 'flex', gap: 18, alignItems: 'center', justifyContent: 'center' }}>
                <button style={{ ...S.cbtn(C.accent), opacity: registered && num ? 1 : .4 }} disabled={!registered || !num} onClick={() => callNow(null, true)}>{IcVideo({ c: '#fff', s: 22 })}</button>
                <button style={{ ...S.cbtn(C.green), width: 64, height: 64, opacity: registered ? 1 : .4 }} disabled={!registered} onClick={() => callNow()}>{IcPhone({ c: '#fff', s: 26 })}</button>
                <button style={{ ...S.cbtn('#e7ebf3'), color: C.sub, boxShadow: 'none', opacity: num ? 1 : .4 }} onClick={() => setNum(n => n.slice(0, -1))}>{IcBack({ c: C.sub, s: 22 })}</button>
              </div>
            </div>
            <div style={S.listCol}>
              <div style={S.listHdr}>Recientes{(apiOn && Array.isArray(scdr)) ? <span style={{ fontSize: 11, color: C.sub, fontWeight: 400, marginLeft: 8 }}>· servidor</span> : (sp.hist.length > 0 ? <button onClick={sp.clearHist} style={{ background: 'none', border: 'none', color: C.accent, fontSize: 13, cursor: 'pointer' }}>Borrar</button> : null)}</div>
              <div style={S.scroll}>
                {rec.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: '40px 0' }}>Sin llamadas</div> :
                  rec.map((h, i) => (
                    <div key={i} className="ph-row" style={S.row} onClick={() => openCall(h)}>
                      <Ava txt={initials(h.number)} size={40} bg={h.dir === 'out' ? 'linear-gradient(160deg,#9db4e0,#6d8fd6)' : (h.missed ? C.red : C.green)} />
                      <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600, color: h.missed ? C.red : C.ink, display: 'flex', alignItems: 'center', gap: 6 }}>{presColor(h.number) ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: presColor(h.number), flex: 'none' }} title="estado en vivo" /> : null}{h.number}{h.video ? ' 📹' : ''}</div><div style={{ fontSize: 12, color: C.sub }}>{h.dir === 'out' ? '↗ saliente' : h.missed ? '↙ perdida' : '↙ entrante'}{h.dur ? ' · ' + fmtDur(h.dur) : ''}</div></div>
                      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
                        <span style={{ fontSize: 12, color: C.sub, marginRight: 4 }}>{fmtDate(h.t)}</span>
                        <button style={S.actBtn(C.accent)} onClick={() => callNow(h.number, true)}>{IcVideo({ c: C.accent, s: 16 })}</button>
                        <button style={S.actBtn(C.green)} onClick={() => callNow(h.number)}>{IcPhone({ c: C.green, s: 16 })}</button>
                      </div>
                    </div>))}
              </div>
            </div>
          </>)}

          {tab === 'voz' && (
            <div style={S.listCol}>
              <div style={S.listHdr}>Buzón de voz {vm ? <span style={{ fontSize: 12, color: C.sub, fontWeight: 400 }}>{vm.length} · {vmUnread} nuevos</span> : null}</div>
              <div style={S.scroll}>
                {!apiOn ? <EmptySystem onGo={() => setTab('ajustes')} /> :
                  vm === null ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Cargando…</div> :
                  vm.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 44 }}>No tenés mensajes de voz.</div> :
                  vm.map((m, i) => { const id = String(m.id || m.msgid || m.msg_id || i); const folder = m.folder || 'INBOX'; const from = m.callerid || m.from || m.caller || m.cid || 'desconocido'; const unread = (m.folder || 'INBOX') === 'INBOX'; const when = m.origtime ? fmtDate(m.origtime * 1000) : (m.date || m.time || ''); return (
                    <div key={i} style={{ ...S.row, flexDirection: 'column', alignItems: 'stretch', gap: 8, cursor: 'default' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Ava txt={initials(String(from))} size={38} bg={unread ? 'linear-gradient(160deg,#4c9dff,#2f6bd6)' : '#8a94a6'} />
                        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: unread ? 700 : 600 }}>{from}{unread && <span style={{ marginLeft: 8, background: C.accent, color: '#fff', fontSize: 10, borderRadius: 8, padding: '1px 7px' }}>Nuevo</span>}</div><div style={{ fontSize: 12, color: C.sub }}>{m.duration ? m.duration + 's · ' : ''}{when}</div></div>
                        <button style={S.actBtn(C.green)} title="Llamar" onClick={() => callNow(String(from).replace(/[^\d*#+]/g, ''))}>{IcPhone({ c: C.green, s: 16 })}</button>
                        <button style={S.actBtn(C.red)} title="Eliminar" onClick={() => vmDelete(id, folder)}>{IcX({ c: C.red, s: 16 })}</button>
                      </div>
                      {vmAudio[id] ? <audio controls autoPlay src={vmAudio[id]} style={{ width: '100%' }} /> :
                        <button onClick={() => vmPlay(id, folder)} style={{ ...S.chip('rgba(47,128,255,.1)', '#1d4ed8'), border: 'none', cursor: 'pointer', alignSelf: 'flex-start', padding: '6px 12px' }}>▶ Escuchar</button>}
                      {apiOn && (vmTx[id] ? (
                        vmTx[id].loading ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.sub }}><span className="spin" style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #cbd5e1', borderTopColor: C.accent, display: 'block' }} /> Transcribiendo…</div> :
                        vmTx[id].error ? <div style={{ fontSize: 12, color: C.red }}>✕ {vmTx[id].error}</div> :
                        <div style={{ background: '#f5f8ff', border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 12px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: C.sub, marginBottom: 4 }}>{IcVoicemail({ c: C.accent, s: 13 })} TRANSCRIPCIÓN{vmTx[id].analysis && vmTx[id].analysis.summary ? '' : ''}</div><div style={{ fontSize: 13, color: C.ink, lineHeight: 1.45 }}>{vmTx[id].text}</div></div>
                      ) : <button onClick={() => transcribeVm(id, folder)} style={{ ...S.chip('rgba(139,92,246,.1)', '#6d28d9'), border: 'none', cursor: 'pointer', alignSelf: 'flex-start', padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>{IcVoicemail({ c: '#6d28d9', s: 14 })} Transcribir</button>)}
                    </div>); })}
              </div>
            </div>
          )}

          {tab === 'contactos' && (
            <div style={S.listCol}>
              <div style={S.listHdr}>Contactos {dir ? <span style={{ fontSize: 12, color: C.sub, fontWeight: 400 }}>{dir.length} internos</span> : null}</div>
              {apiOn && dir && dir.length > 0 && <div style={{ padding: '0 14px 10px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${C.line}`, borderRadius: 10, padding: '0 12px', background: '#fff' }}>{IcSearch({ c: C.sub, s: 16 })}<input value={contactQ} onChange={e => setContactQ(e.target.value)} placeholder="Buscar por nombre o interno…" style={{ flex: 1, border: 'none', outline: 'none', background: 'none', fontSize: 14, padding: '9px 0' }} />{contactQ && <button onClick={() => setContactQ('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.sub, fontSize: 17 }}>×</button>}</div></div>}
              {apiOn && favs.length > 0 && (
                <div style={{ padding: '0 14px 10px' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: C.sub, letterSpacing: .5, marginBottom: 7 }}>FAVORITOS</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {favs.map(fx => { const fc = presColor(fx); const fn = favName(fx); return (
                      <button key={fx} onClick={() => callNow(fx)} title={'Llamar a ' + fn} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: 56, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        <span style={{ position: 'relative', display: 'inline-flex' }}><Ava txt={initials(String(fn))} size={46} bg="linear-gradient(160deg,#7c9be0,#4f6fc9)" /><span style={{ position: 'absolute', right: 1, bottom: 1, width: 12, height: 12, borderRadius: '50%', background: fc || '#c2c9d6', border: '2px solid #fff' }} /></span>
                        <span style={{ fontSize: 11, color: C.ink, maxWidth: 56, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fn}</span>
                      </button>); })}
                  </div>
                </div>
              )}
              <div style={S.scroll}>
                {!apiOn ? <EmptySystem onGo={() => setTab('ajustes')} /> :
                  dir === null ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Cargando…</div> :
                  dir.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin contactos</div> :
                  (() => { const fdir = dir.filter(d => !contactQ || ((d.name || '') + ' ' + String(d.ext || '')).toLowerCase().includes(contactQ.toLowerCase())); return fdir.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin resultados</div> : fdir.map((d, i) => (
                    <div key={i} className="ph-row" style={S.row} onClick={() => callNow(d.ext)}>
                      <Ava txt={initials(d.name || d.ext)} size={40} bg="linear-gradient(160deg,#7c9be0,#4f6fc9)" />
                      <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{d.name || d.ext}</div><div style={{ fontSize: 12, color: C.sub }}>{d.ext}{d.webrtc ? ' · WebRTC' : ''}</div></div>
                      <span style={{ marginLeft: 'auto', ...S.chip(d.status === 'online' ? 'rgba(34,197,94,.14)' : d.status === 'in_call' ? 'rgba(245,158,11,.15)' : '#eef1f7', d.status === 'online' ? '#15803d' : d.status === 'in_call' ? '#b45309' : C.sub) }}>{d.status === 'online' ? 'en línea' : d.status === 'in_call' ? 'en llamada' : 'offline'}</span>
                      <div style={{ display: 'flex', gap: 6, marginLeft: 8 }} onClick={e => e.stopPropagation()}>
                        <button title="Favorito" onClick={() => toggleFav(d.ext)} style={{ ...S.actBtn(favs.includes(String(d.ext)) ? '#f59e0b' : C.sub), fontSize: 15, lineHeight: 1, fontWeight: 700 }}>{favs.includes(String(d.ext)) ? '\u2605' : '\u2606'}</button>
                        <button title="Supervisar" style={S.actBtn('#8b5cf6')} onClick={() => { setSpyMsg(''); setSpyTarget(d); }}>{IcHead({ c: '#8b5cf6', s: 16 })}</button>
                        <button style={S.actBtn(C.accent)} onClick={() => callNow(d.ext, true)}>{IcVideo({ c: C.accent, s: 16 })}</button>
                        <button style={S.actBtn(C.green)} onClick={() => callNow(d.ext)}>{IcPhone({ c: C.green, s: 16 })}</button>
                      </div>
                    </div>)); })()}
              </div>
            </div>
          )}

          {tab === 'clientes' && (
            <>
              <div style={{ width: 300, borderRight: `1px solid ${C.line}`, background: C.card, display: 'flex', flexDirection: 'column' }}>
                <div style={S.listHdr}>Clientes {clsFull ? <span style={{ fontSize: 12, color: C.sub, fontWeight: 400 }}>{clsFull.length}</span> : null}</div>
                {apiOn && clsFull && clsFull.length > 0 && <div style={{ padding: '0 14px 10px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${C.line}`, borderRadius: 10, padding: '0 12px', background: '#fff' }}>{IcSearch({ c: C.sub, s: 16 })}<input value={clientQ} onChange={e => setClientQ(e.target.value)} placeholder="Buscar cliente…" style={{ flex: 1, border: 'none', outline: 'none', background: 'none', fontSize: 14, padding: '9px 0' }} />{clientQ && <button onClick={() => setClientQ('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.sub, fontSize: 17 }}>×</button>}</div></div>}
                <div style={S.scroll}>
                  {!apiOn ? <EmptySystem onGo={() => setTab('ajustes')} /> :
                    clsFull === null ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Cargando…</div> :
                    clsFull.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin clientes</div> :
                    (() => { const f = clsFull.filter(c => !clientQ || ((c.name || '') + ' ' + (c.doc || '')).toLowerCase().includes(clientQ.toLowerCase())); return f.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin resultados</div> : f.map((c, i) => (
                      <div key={i} className="ph-row" style={{ ...S.row, background: selClient && selClient.id === c.id ? '#eef4ff' : 'transparent' }} onClick={() => setSelClient(c)}>
                        <Ava txt={initials(c.name)} size={38} bg="linear-gradient(160deg,#8b5cf6,#6d28d9)" />
                        <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{c.name}</div>{c.doc && <div style={{ fontSize: 12, color: C.sub }}>{c.doc}</div>}</div>
                      </div>)); })()}
                </div>
              </div>
              <div style={{ ...S.listCol, overflowY: 'auto' }}>
                {!selClient ? <div style={{ color: C.sub, textAlign: 'center', padding: 50 }}>Elegí un cliente para ver su ficha.</div> :
                  clientDet === null ? <div style={{ color: C.sub, textAlign: 'center', padding: 40 }}>Cargando ficha…</div> :
                  <div style={{ padding: '18px 22px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                      <Ava txt={initials(clientDet.name)} size={56} bg="linear-gradient(160deg,#8b5cf6,#6d28d9)" />
                      <div style={{ minWidth: 0 }}><div style={{ fontSize: 20, fontWeight: 700 }}>{clientDet.name}</div><div style={{ fontSize: 13, color: C.sub, display: 'flex', gap: 10, flexWrap: 'wrap' }}>{clientDet.doc ? <span>Doc: {clientDet.doc}</span> : null}<span>{(clientDet.persons || []).length} personas</span><span>{(clientDet.spaces || []).length} espacios</span><span>{(clientDet.devices || []).length} disp.</span></div></div>
                    </div>
                    <div style={{ display: 'flex', gap: 2, marginBottom: 14, borderBottom: `1px solid ${C.line}` }}>
                      {[['datos', 'Datos', IcUser, null], ['personas', 'Personas', IcUsers, (clientDet.persons || []).length], ['espacios', 'Espacios', IcGrid, (clientDet.spaces || []).length], ['disp', 'Dispositivos', IcCam, (clientDet.devices || []).length]].map(([id, lbl, Ic, n]) => { const on = cliTab === id; return (
                        <button key={id} onClick={() => setCliTab(id)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', border: 'none', borderBottom: `2px solid ${on ? '#8b5cf6' : 'transparent'}`, background: 'none', color: on ? '#6d28d9' : C.sub, cursor: 'pointer', fontWeight: on ? 700 : 600, fontSize: 13, marginBottom: -1 }}>{Ic({ c: on ? '#6d28d9' : C.sub, s: 15 })}{lbl}{n ? <span style={{ fontSize: 11, background: on ? 'rgba(139,92,246,.15)' : '#eef1f7', color: on ? '#6d28d9' : C.sub, borderRadius: 8, padding: '0 6px' }}>{n}</span> : null}</button>); })}
                    </div>
                    <div key={cliTab} ref={gEnter}>
                    {cliTab === 'datos' && (<>
                      {(clientDet.address || clientDet.notes) ? <div style={S.card}>{clientDet.address && <div style={{ padding: '9px 0', display: 'flex', gap: 10 }}>{IcGrid({ c: C.sub, s: 16 })}<div><div style={S.fieldLbl}>Dirección</div>{clientDet.address}</div></div>}{clientDet.notes && <div style={{ padding: '9px 0', borderTop: clientDet.address ? `1px solid ${C.line}` : 'none' }}><div style={S.fieldLbl}>Notas</div>{clientDet.notes}</div>}</div> : null}
                      {Array.isArray(clientDet.phones) && clientDet.phones.length > 0 ? <><div style={S.section}>TELÉFONOS</div><div style={S.card}>{clientDet.phones.map((ph, i) => <div key={i} className="ph-row" style={S.row} onClick={() => callNow(String(ph))}>{IcPhone({ c: C.sub, s: 16 })}<div style={{ flex: 1 }}>{ph}</div><button style={S.actBtn(C.green)} onClick={e => { e.stopPropagation(); callNow(String(ph)); }}>{IcPhone({ c: C.green, s: 16 })}</button></div>)}</div></> : null}
                      {!clientDet.address && !clientDet.notes && !(clientDet.phones || []).length && <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin datos generales.</div>}
                    </>)}
                    {cliTab === 'personas' && (Array.isArray(clientDet.persons) && clientDet.persons.length > 0 ? <div style={S.card}>{clientDet.persons.map((pr, i) => <div key={i} className="ph-row" style={S.row}><Ava txt={initials(pr.name)} size={34} bg="#4f6fc9" /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{pr.name}</div>{(pr.phone || pr.role) && <div style={{ fontSize: 12, color: C.sub }}>{[pr.role, pr.phone].filter(Boolean).join(' · ')}</div>}</div>{pr.phone && <button style={S.actBtn(C.green)} onClick={() => callNow(String(pr.phone))}>{IcPhone({ c: C.green, s: 16 })}</button>}</div>)}</div> : <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin personas autorizadas.</div>)}
                    {cliTab === 'espacios' && (Array.isArray(clientDet.spaces) && clientDet.spaces.length > 0 ? <div style={S.card}>{clientDet.spaces.map((sx, i) => <div key={i} className="ph-row" style={S.row}>{IcGrid({ c: C.sub, s: 16 })}<div style={{ flex: 1 }}><b>{sx.name}</b>{sx.notes ? <div style={{ fontSize: 12, color: C.sub }}>{sx.notes}</div> : null}</div></div>)}</div> : <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin espacios.</div>)}
                    {cliTab === 'disp' && (Array.isArray(clientDet.devices) && clientDet.devices.length > 0 ? <div style={S.card}>{clientDet.devices.map((d, i) => <div key={i} className="ph-row" style={S.row}>{IcCam({ c: C.sub, s: 18 })}<div style={{ flex: 1 }}><div style={{ fontWeight: 600 }}>{d.label}</div><div style={{ fontSize: 12, color: C.sub }}>{d.type || 'dispositivo'}</div></div><button onClick={() => { setSelClient(clientDet); setTab('intercom'); }} style={{ ...S.chip('rgba(47,128,255,.12)', '#1d4ed8'), border: 'none', cursor: 'pointer' }}>Ver en vivo</button></div>)}</div> : <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin dispositivos.</div>)}
                    </div>
                  </div>}
              </div>
            </>
          )}

          {tab === 'intercom' && (
            <>
              <div style={{ width: 300, borderRight: `1px solid ${C.line}`, background: C.card, display: 'flex', flexDirection: 'column' }}>
                <div style={S.listHdr}>{tab === 'clientes' ? 'Clientes' : 'Intercom'}</div>
                {apiOn && cls && cls.length > 0 && <div style={{ padding: '0 14px 8px' }}><input value={clientQ} onChange={e => setClientQ(e.target.value)} placeholder="Buscar cliente…" style={{ ...S.inp, padding: '9px 12px' }} /></div>}
                <div style={S.scroll}>
                  {!apiOn ? <EmptySystem onGo={() => setTab('ajustes')} /> :
                    cls === null ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Cargando…</div> :
                    cls.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin clientes</div> :
                    (() => { const clsF = cls.filter(c => !clientQ || (c.name || '').toLowerCase().includes(clientQ.toLowerCase())); return clsF.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin resultados</div> : clsF.map((c, i) => (
                      <div key={i} className="ph-row" style={{ ...S.row, background: selClient && selClient.id === c.id ? '#eef4ff' : 'transparent' }} onClick={() => setSelClient(c)}>
                        <Ava txt={initials(c.name)} size={38} bg="linear-gradient(160deg,#8b5cf6,#6d28d9)" />
                        <div style={{ fontWeight: 600 }}>{c.name}</div>
                      </div>)); })()}
                </div>
              </div>
              <div style={S.listCol}>
                <div style={S.listHdr}>{selClient ? selClient.name : (tab === 'intercom' ? 'Cámaras y porteros' : 'Dispositivos')}{tab === 'intercom' && selClient && <button onClick={() => setSelClient({ ...selClient })} style={{ background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '5px 10px', cursor: 'pointer', color: C.sub, display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 13 }}>{IcReload({ c: C.sub, s: 14 })} Refrescar</button>}</div>
                <div style={{ ...S.scroll, padding: tab === 'intercom' ? '0 18px 18px' : S.scroll.padding }}>
                  {!apiOn ? null : !selClient ? <div style={{ color: C.sub, textAlign: 'center', padding: 40 }}>Elegí un cliente para ver sus {tab === 'intercom' ? 'cámaras/porteros en vivo' : 'dispositivos'}.</div> :
                    streams === null ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Cargando…</div> :
                    streams.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Este cliente no tiene dispositivos.</div> :
                    tab === 'intercom' ?
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px,1fr))', gap: 14 }}>{streams.map((d, i) => <MseTile key={(d.id || i) + ':' + (d.src || '')} stream={d} />)}</div> :
                      streams.map((d, i) => (
                        <div key={i} className="ph-row" style={S.row}>
                          <Ava txt="" size={38} bg="#0f1a30" />
                          <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{d.label}</div><div style={{ fontSize: 12, color: C.sub }}>{d.type || 'dispositivo'}{d.src ? ' · ' + d.src : ''}</div></div>
                          <button onClick={() => { setSelClient(selClient); setTab('intercom'); }} style={{ marginLeft: 'auto', ...S.chip('rgba(47,128,255,.12)', '#1d4ed8'), border: 'none', cursor: 'pointer' }}>{IcCam({ c: '#1d4ed8', s: 14 })} Ver en vivo</button>
                        </div>))}
                </div>
              </div>
            </>
          )}

          {tab === 'ajustes' && (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <div style={{ maxWidth: 840, margin: '0 auto', padding: '12px 24px 30px' }}>
                <div style={S.listHdr}>Ajustes</div>
                <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: `1px solid ${C.line}` }}>
                  {[['registro', 'Registro', IcPhone], ['disp', 'Dispositivos', IcSpeaker], ['red', 'Red / TURN', IcShield], ['sistema', 'Sistema', IcUsers], ['pref', 'Preferencias', IcGear]].map(([id, lbl, Ic]) => { const on = aTab === id; return <button key={id} onClick={() => withVT(() => setATab(id))} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', border: 'none', borderBottom: `2px solid ${on ? C.accent : 'transparent'}`, background: 'none', color: on ? C.accent : C.sub, cursor: 'pointer', fontWeight: on ? 700 : 600, fontSize: 13, marginBottom: -1 }}>{Ic({ c: on ? C.accent : C.sub, s: 15 })}{lbl}</button>; })}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {aTab === 'disp' && <Section title="DISPOSITIVOS" icon={IcSpeaker({ c: C.sub, s: 14 })}>
                    {[['Micrófono', IcMic, 'mic', devs.mics, 'Micrófono'], ['Cámara', IcVideo, 'cam', devs.cams, 'Cámara'], ['Altavoz / Salida', IcSpeaker, 'spk', devs.speakers, 'Salida']].map(([lbl, Ic, key, list, ph]) => (
                      <div key={key} style={{ padding: '7px 0', borderBottom: `1px solid ${C.line}` }}>
                        <div style={S.fieldLbl}>{lbl}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${C.line}`, borderRadius: 9, padding: '0 10px', background: '#fff' }}>{Ic({ c: C.accent, s: 17 })}<select style={{ flex: 1, border: 'none', outline: 'none', background: 'none', fontSize: 14, padding: '9px 0', color: C.ink, cursor: 'pointer' }} value={prefs[key]} onChange={e => pickDev(key, e.target.value)}><option value="">Predeterminado</option>{list.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || ph}</option>)}</select></div>
                      </div>))}
                    <div style={{ padding: '10px 0 4px' }}><div style={S.fieldLbl}>Volumen</div><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{IcSpeaker({ c: C.sub, s: 16 })}<input type="range" min="0" max="1" step="0.05" value={sp.volume} onChange={e => sp.setVolume(parseFloat(e.target.value))} style={{ flex: 1, accentColor: C.green }} /></div></div>
                  </Section>}

                  {aTab === 'registro' && <Section>
                    <div style={{ display: 'flex', gap: 8, padding: '8px 0' }}>
                      <button onClick={() => setCfg(c => ({ ...c, transport: 'webrtc' }))} style={{ flex: 1, padding: 8, borderRadius: 8, border: `1px solid ${!sipMode ? C.accent : C.line}`, background: !sipMode ? 'rgba(47,128,255,.1)' : '#fff', color: !sipMode ? '#1d4ed8' : C.sub, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>WebRTC (WSS/WS)</button>
                      <button onClick={() => { if (!window.sphone) { alert('El modo SIP UDP/TCP solo funciona en la app de Windows (Electron).'); return; } setCfg(c => ({ ...c, transport: 'sip' })); }} style={{ flex: 1, padding: 8, borderRadius: 8, border: `1px solid ${sipMode ? C.accent : C.line}`, background: sipMode ? 'rgba(47,128,255,.1)' : '#fff', color: sipMode ? '#1d4ed8' : C.sub, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>SIP UDP/TCP/TLS</button>
                    </div>
                    {sipMode ? (<>
                      {F('Servidor SIP (host o IP)', 'sipServer', 'text', '192.168.1.10')}
                      <div style={{ display: 'flex', gap: 10 }}>
                        <div style={{ flex: 1 }}>{F('Puerto', 'sipPort', 'text', '5060')}</div>
                        <div style={{ flex: 1, padding: '8px 0' }}><div style={S.fieldLbl}>Transporte</div><select style={S.sel} value={cfg.sipTransport || 'udp'} onChange={e => setCfg(c => ({ ...c, sipTransport: e.target.value }))}><option value="udp">UDP</option><option value="tcp">TCP</option><option value="tls">TLS</option></select></div>
                      </div>
                      <div style={{ padding: '8px 0' }}><div style={S.fieldLbl}>Cifrado de medios (SRTP)</div><select style={S.sel} value={cfg.sipSrtp || 'none'} onChange={e => setCfg(c => ({ ...c, sipSrtp: e.target.value }))}><option value="none">RTP (sin cifrar)</option><option value="sdes">SRTP · SDES (AES_CM_128_HMAC_SHA1_80)</option></select>{cfg.sipSrtp === 'sdes' && <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>Recomendado con transporte <b>TLS</b> (la llave del SRTP viaja en el SDP). En Asterisk: <code>media_encryption=sdes</code>.</div>}</div>
                      <div style={{ padding: '8px 0' }}><div style={S.fieldLbl}>DTMF</div><select style={S.sel} value={cfg.sipDtmf || 'rfc4733'} onChange={e => setCfg(c => ({ ...c, sipDtmf: e.target.value }))}><option value="rfc4733">RFC 4733 (RTP telephone-event)</option><option value="info">SIP INFO (legacy)</option><option value="both">Ambos</option></select></div>
                      {cfg.sipTransport === 'tls' && <ToggleRow label="Validar certificado TLS" desc="Rechaza certificados no confiables. Activá en producción pública." on={!!cfg.tlsVerify} onChange={v => setCfg(c => ({ ...c, tlsVerify: v }))} />}
                      <ToggleRow label="Descubrir servidor (DNS SRV)" desc="RFC 3263: resuelve _sip._transporte.dominio automáticamente." on={!!cfg.sipSrv} onChange={v => setCfg(c => ({ ...c, sipSrv: v }))} />
                      <ToggleRow label="Mensajes en espera (MWI por SIP)" desc="SUBSCRIBE message-summary; recibe aviso de voicemails por SIP." on={!!cfg.sipMwi} onChange={v => setCfg(c => ({ ...c, sipMwi: v }))} />
                    </>) : F('Servidor WebSocket (ws:// o wss://)', 'wss', 'text', 'wss://tu-pbx/ws')}
                    {!sipMode && F('WSS de respaldo (failover, opcional)', 'wssBackup', 'text', 'wss://backup/ws')}
                    {F('Dominio SIP', 'domain', 'text', 'tu-pbx.com')}{F('Interno / usuario', 'ext', 'text', '2001')}
                    <div style={{ padding: '8px 0' }}><div style={S.fieldLbl}>Contraseña</div><input style={S.inp} type="password" value={cfg.pass || ''} onChange={e => setCfg(c => ({ ...c, pass: e.target.value }))} /></div>
                    {sipMode && <div style={{ fontSize: 11, color: C.sub, margin: '2px 0 8px' }}>Modo SIP nativo (solo app Windows): registro UDP/TCP/TLS + audio <b>G.711</b> (µ-law/A-law), <b>video H.264</b> (WebCodecs, RTP RFC 6184), DTMF (RFC 4733 / INFO), SRTP-SDES, RTCP y transferencia REGISTER/REFER. El video se negocia al iniciar la llamada (botón de cámara); el audio de <b>banda ancha</b> (Opus/G.722) sigue siendo solo del modo <b>WebRTC</b>.</div>}
                    <div style={{ padding: '8px 0' }}>
                      <div style={S.fieldLbl}>Códec de audio</div>
                      <select style={S.sel} value={(sipMode && !['auto', 'pcmu', 'pcma'].includes(cfg.codec)) ? 'auto' : (cfg.codec || 'auto')} onChange={e => setCfg(c => ({ ...c, codec: e.target.value }))}>
                        <option value="auto">Auto (deja elegir a la central)</option>
                        {!sipMode && <option value="opus">Opus (banda ancha)</option>}
                        {!sipMode && <option value="g722">G.722 (banda ancha)</option>}
                        <option value="pcmu">G.711 µ-law (PCMU)</option>
                        <option value="pcma">G.711 A-law (PCMA)</option>
                      </select>
                      {sipMode
                        ? (cfg.codec === 'pcmu' || cfg.codec === 'pcma') && <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>Se ofrece sólo {cfg.codec === 'pcmu' ? 'G.711 µ-law' : 'G.711 A-law'}. En <b>Auto</b> se ofrecen ambos.</div>
                        : cfg.codec && cfg.codec !== 'auto' && <ToggleRow label="Forzar este códec" desc="Ofrece sólo este códec: obliga al SBC a transcodificar si la central usa otro." on={!!cfg.codecForce} onChange={v => setCfg(c => ({ ...c, codecForce: v }))} />}
                    </div>
                    <button style={{ ...S.primary, margin: '4px 0 6px' }} disabled={!isComplete(cfg)} onClick={connectNow}>{registered ? 'Reconectar' : 'Conectar'}</button>
                    <button onClick={() => setShowDiag(true)} style={{ width: '100%', padding: 9, borderRadius: 9, border: `1px solid ${C.line}`, background: '#fff', color: C.sub, cursor: 'pointer', fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>{IcShield({ c: C.sub, s: 15 })} Diagnóstico</button>
                    {sipMode && sipMsg && <div style={{ fontSize: 12, color: sipReg === 'registered' ? '#15803d' : C.red, marginBottom: 6 }}>{sipReg === 'registered' ? '✓ ' : '✗ '}{sipMsg}</div>}
                    {sipMode && sipLogs.length > 0 && <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, lineHeight: 1.5, background: '#0f1a30', color: '#a9c2ea', borderRadius: 8, padding: '8px 10px', marginBottom: 8, maxHeight: 150, overflowY: 'auto' }}>{sipLogs.map((l, i) => <div key={i} style={{ color: /40[0-9]|48[0-9]|50[0-9]|✗|sin respuesta|error/i.test(l) ? '#ff9a9a' : /200|registered/i.test(l) ? '#8ce6a6' : '#a9c2ea' }}>{l}</div>)}</div>}
                  </Section>}

                  {aTab === 'red' && <Section title="ICE / TURN" icon={IcShield({ c: C.sub, s: 14 })}>
                    <div style={{ display: 'flex', gap: 18 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {F('STUN', 'stun')}{F('TURN', 'turn', 'text', 'turn:host:3478')}{F('TURN usuario', 'turnUser')}
                        <div style={{ padding: '6px 0' }}><div style={S.fieldLbl}>TURN clave</div><input style={S.inp} type="password" value={cfg.turnPass || ''} onChange={e => setCfg(c => ({ ...c, turnPass: e.target.value }))} /></div>
                        <button onClick={() => { sounds.uiClick(); saveConfig(cfg); runTurnTest(); }} style={{ width: '100%', marginTop: 8, padding: 10, borderRadius: 9, border: `1px solid ${C.accent}`, background: 'rgba(47,128,255,.06)', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>Probar TURN ahora</button>
                      </div>
                      {(() => {
                        const t = turnT || { state: 'idle' };
                        const configured = !!(cfg.turn && cfg.turnUser && cfg.turnPass);
                        const inUse = sp.usingRelay === true;
                        const ok = t.state === 'ok';
                        const bad = t.state === 'turn-auth' || t.state === 'turn-unreachable' || t.state === 'error';
                        const col = ok ? C.green : bad ? C.red : configured ? '#f59e0b' : '#c2c9d6';
                        const title = t.state === 'testing' ? 'Probando…' : ok ? (inUse ? 'TURN en uso' : 'TURN operativo') : t.state === 'turn-auth' ? 'Credenciales rechazadas' : t.state === 'turn-unreachable' ? 'TURN no responde' : t.state === 'error' ? 'Error' : configured ? 'Sin probar' : 'TURN off';
                        const sub = t.state === 'testing' ? 'levantando ICE…' : ok ? (inUse ? 'la llamada pasa por relay' : 'alcanzable y autenticado') : t.state === 'turn-auth' ? 'usuario/clave inválidos (401)' : t.state === 'turn-unreachable' ? 'no llegó candidato relay' : configured ? 'tocá "Probar TURN ahora"' : 'sin configurar';
                        return (
                          <div style={{ width: 160, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderLeft: `1px solid ${C.line}`, paddingLeft: 18, textAlign: 'center' }}>
                            <div className={(ok && inUse) ? 'turn-live' : ''} style={{ width: 88, height: 88, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: ok ? 'rgba(34,197,94,.12)' : bad ? 'rgba(239,68,68,.1)' : '#f1f3f8' }}>
                              {t.state === 'testing' ? <span className="spin" style={{ width: 30, height: 30, borderRadius: '50%', border: '3px solid #dbe3ef', borderTopColor: C.accent, display: 'block' }} /> : IcAudioCloud({ c: col, s: 46 })}
                            </div>
                            <div style={{ marginTop: 10, fontWeight: 700, fontSize: 13, color: ok ? '#15803d' : bad ? C.red : C.sub }}>{title}</div>
                            <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>{sub}</div>
                          </div>); })()}
                    </div>
                    {(() => {
                      const t = turnT || { state: 'idle', host: 0, srflx: 0, relay: 0, errors: [] };
                      const row = (k, v, c) => <><span style={{ color: C.sub }}>{k}</span><span style={{ textAlign: 'right', fontWeight: 600, color: c || C.ink }}>{v}</span></>;
                      const rtp = sp.inCall ? (sp.usingRelay === true ? 'por TURN (relay)' : sp.usingRelay === false ? 'directo (P2P / STUN)' : 'negociando…') : 'sin llamada activa';
                      return (
                        <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 12, paddingTop: 12 }}>
                          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: .5, color: C.sub, marginBottom: 8 }}>DIAGNÓSTICO EN VIVO</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 12.5 }}>
                            {row('RTP de la llamada', rtp, sp.inCall ? (sp.usingRelay === true ? '#15803d' : sp.usingRelay === false ? '#1d4ed8' : C.sub) : C.sub)}
                            {row('Candidatos relay (TURN)', t.relay > 0 ? t.relay + ' ✓' : (t.state === 'testing' ? '…' : '0'), t.relay > 0 ? '#15803d' : C.sub)}
                            {row('Candidatos srflx (STUN)', t.srflx > 0 ? t.srflx + ' ✓' : (t.state === 'testing' ? '…' : '0'), t.srflx > 0 ? '#15803d' : C.sub)}
                            {row('Candidatos host (LAN)', t.host || 0)}
                            {row('IP pública (por STUN)', t.publicIp || '—')}
                            {row('IP del relay (TURN)', t.relayIp || '—')}
                            {t.ms ? row('Tiempo de sondeo', t.ms + ' ms') : null}
                          </div>
                          {t.errors && t.errors.length > 0 && <div style={{ marginTop: 10, background: 'rgba(239,68,68,.07)', border: `1px solid rgba(239,68,68,.25)`, borderRadius: 9, padding: '8px 10px', fontSize: 11.5, color: '#b91c1c' }}>{t.errors.slice(0, 3).map((e, i) => <div key={i}>✕ {e}</div>)}</div>}
                          <div style={{ fontSize: 11, color: C.sub, marginTop: 10 }}>Si aparece un candidato <b>relay</b>, el TURN está alcanzable <b>y</b> autenticado. Sin relay, las llamadas solo funcionan si hay camino directo (misma red o NAT permisiva).</div>
                        </div>); })()}
                  </Section>}

                  {aTab === 'sistema' && <Section title="INTEGRACIÓN CON EL SISTEMA" icon={IcUsers({ c: C.sub, s: 14 })} right={apiOn ? <span style={S.chip('rgba(34,197,94,.14)', '#15803d')}>conectado</span> : null}>
                    {apiOn ? (
                      <div style={{ padding: '10px 0' }}><div style={{ fontSize: 13 }}>Conectado como <b>{api.getApiUser()}</b>. Contactos, Clientes, Intercom y grabaciones activos.</div><button onClick={apiDisconnect} style={{ marginTop: 10, background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', color: C.red }}>Desconectar</button><button onClick={() => { setShowProv(true); setProvExt(''); setProvQr(''); setProvErr(''); setProvUrl(''); }} style={{ marginTop: 10, marginLeft: 8, background: 'rgba(47,128,255,.08)', border: `1px solid ${C.accent}`, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', color: '#1d4ed8', fontWeight: 600 }}>Aprovisionar teléfono (QR)</button></div>
                    ) : (<>
                      <div style={{ padding: '8px 0', borderBottom: `1px solid ${C.line}` }}><div style={S.fieldLbl}>URL del sistema</div><input style={S.inp} value={apiForm.base} onChange={e => setApiForm(f => ({ ...f, base: e.target.value }))} placeholder={api.baseFromWss(cfg.wss) || 'https://pbx01.tu-dominio'} /></div>
                      <div style={{ padding: '8px 0', borderBottom: `1px solid ${C.line}` }}><div style={S.fieldLbl}>Usuario del panel</div><input style={S.inp} value={apiForm.user} onChange={e => setApiForm(f => ({ ...f, user: e.target.value }))} autoCapitalize="off" /></div>
                      <div style={{ padding: '8px 0' }}><div style={S.fieldLbl}>Contraseña del panel</div><input style={S.inp} type="password" value={apiForm.pass} onChange={e => setApiForm(f => ({ ...f, pass: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') doApiLogin(); }} /></div>
                      <button style={{ ...S.primary, background: '#0f1a30', margin: '4px 0 8px' }} onClick={doApiLogin}>Conectar al sistema</button>
                    </>)}
                    {apiMsg && <div style={{ fontSize: 12, color: /error/i.test(apiMsg) ? C.red : C.sub, marginBottom: 8 }}>{apiMsg}</div>}
                  </Section>}

                  {aTab === 'pref' && <Section title="PREFERENCIAS" icon={IcGear({ c: C.sub, s: 14 })}>
                    <ToggleRow label="No molestar (DND)" desc="Rechaza automáticamente las llamadas entrantes." on={dnd} onChange={setDnd} />
                    <ToggleRow label="Auto-atender" desc="Contesta solo tras ~1 s (útil para hotline o portero)." on={autoAnswer} onChange={setAutoAnswer} />
                    <ToggleRow label="Timbre de llamada" desc="Tono de ring al recibir y al llamar." on={ring} onChange={setRing} />
                    <ToggleRow label="Sonidos de interfaz" desc="Clicks del teclado y de las acciones." on={soundsUi} onChange={setSoundsUi} />
                    <ToggleRow label="Mostrar Intercom" desc="Muestra u oculta cámaras/porteros en el menú." on={showIntercom} onChange={setShowIntercom} />
                    {window.sphone && <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 2px' }}><div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>Actualizaciones</div><div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>Versión actual {APP_VERSION}.</div></div><button onClick={() => { setUpd({ state: 'checking' }); try { window.sphone.updateCheck(); } catch {} }} style={{ padding: '8px 16px', borderRadius: 10, border: `1px solid ${C.accent}`, background: '#fff', color: '#1d4ed8', fontWeight: 600, cursor: 'pointer' }}>Buscar</button></div>}
                  </Section>}
                </div>
                <div style={{ textAlign: 'center', color: C.sub, fontSize: 12, marginTop: 16 }}>PBX-NG Softphone {APP_VERSION} · sirve con cualquier central con internos WebRTC.</div>
              </div>
            </div>
          )}

          {sp.incoming && (() => {
            const from = (sp.incoming.remoteIdentity && sp.incoming.remoteIdentity.uri && sp.incoming.remoteIdentity.uri.user) || 'desconocido';
            return (
              <div className="call-overlay" style={S.overlay}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 42, WebkitAppRegion: 'drag', zIndex: 5 }} />
                <div style={{ position: 'absolute', top: 8, right: 10, zIndex: 6 }}><WinCtl dark /></div>
                <div ref={gPop}><RingBell size={120} /></div>
                <div style={{ fontSize: 26, fontWeight: 700, marginTop: 16 }}>{from}</div>
                <div style={{ color: 'rgba(255,255,255,.7)', marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>{IcPhoneRing({ s: 16, c: 'rgba(255,255,255,.85)' })}{sp.incomingVideo ? 'Videollamada entrante…' : 'Llamada entrante…'}</div>
                {popClient && (
                  <div className="menu-pop" style={{ marginTop: 18, background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.22)', borderRadius: 14, padding: '14px 18px', maxWidth: 400, textAlign: 'left' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>{IcUsers({ c: '#9fd0ff', s: 16 })}<span style={{ fontWeight: 700, fontSize: 16 }}>{popClient.name}</span><span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(159,208,255,.2)', color: '#cfe6ff', borderRadius: 8, padding: '2px 8px' }}>CRM</span></div>
                    {popClient.doc && <div style={{ fontSize: 12, color: 'rgba(255,255,255,.7)' }}>Doc: {popClient.doc}</div>}
                    {popClient.address && <div style={{ fontSize: 12, color: 'rgba(255,255,255,.7)' }}>{popClient.address}</div>}
                    <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,.85)' }}><span>{(popClient.persons || []).length} personas</span><span>{(popClient.spaces || []).length} espacios</span><span>{(popClient.devices || []).length} disp.</span></div>
                    {Array.isArray(popClient.persons) && popClient.persons.length > 0 && <div style={{ marginTop: 8, fontSize: 12 }}><span style={{ color: 'rgba(255,255,255,.6)' }}>Autorizados: </span>{popClient.persons.slice(0, 3).map(p => p.name).join(', ')}{popClient.persons.length > 3 ? '…' : ''}</div>}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 40, marginTop: 40 }}>
                  <div style={{ textAlign: 'center' }}><button style={S.hang} onClick={() => { sounds.uiClick(); sp.reject(); }}>{IcPhone({ c: '#fff', s: 28 })}</button><div style={{ fontSize: 12, marginTop: 8, color: 'rgba(255,255,255,.8)' }}>Rechazar</div></div>
                  <div style={{ textAlign: 'center' }}><button style={{ ...S.hang, background: C.accent, boxShadow: '0 8px 22px rgba(47,128,255,.4)' }} onClick={() => { sounds.uiClick(); sp.accept(true); }}>{IcVideo({ c: '#fff', s: 28 })}</button><div style={{ fontSize: 12, marginTop: 8, color: 'rgba(255,255,255,.8)' }}>Video</div></div>
                  <div style={{ textAlign: 'center' }}><button style={{ ...S.hang, background: C.green, boxShadow: '0 8px 22px rgba(34,197,94,.4)' }} onClick={() => { sounds.uiClick(); sp.accept(false); }}>{IcPhone({ c: '#fff', s: 28 })}</button><div style={{ fontSize: 12, marginTop: 8, color: 'rgba(255,255,255,.8)' }}>Atender</div></div>
                </div>
              </div>
            );
          })()}

          {sp.inCall && !sp.incoming && (() => {
            const ci = sp.callInfo || {}; const q = sp.quality; const dots = q ? '▂▄▆█'.slice(0, q.score) : '';
            return (
              <div className="call-overlay" style={{ ...S.overlay, ...(sp.videoOn ? { background: '#000' } : { justifyContent: 'flex-start', paddingTop: 46 }) }}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 42, WebkitAppRegion: 'drag', zIndex: 5 }} />
                <div style={{ position: 'absolute', top: 8, right: 10, zIndex: 6 }}><WinCtl dark /></div>
                {sp.videoOn && <video autoPlay playsInline muted ref={el => { if (sp.remoteVideoRef) sp.remoteVideoRef.current = el; if (el) { const st = sp.getRemoteStream && sp.getRemoteStream(); if (st && el.srcObject !== st) { el.srcObject = st; el.play().catch(() => {}); } } }} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
                {sp.videoOn && <video autoPlay playsInline muted ref={el => { if (sp.localVideoRef) sp.localVideoRef.current = el; if (el) { const st = sp.getLocalStream && sp.getLocalStream(); if (st && el.srcObject !== st) { el.srcObject = st; el.play().catch(() => {}); } } }} style={{ position: 'absolute', top: 16, right: 16, width: 168, height: 112, objectFit: 'cover', borderRadius: 16, border: '2px solid rgba(255,255,255,.22)', boxShadow: '0 8px 24px rgba(0,0,0,.5)', transform: 'scaleX(-1)', zIndex: 3 }} />}
                {sp.videoOn && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 130, background: 'linear-gradient(180deg,rgba(0,0,0,.55),transparent)', zIndex: 1, pointerEvents: 'none' }} />}
                {sp.videoOn && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 210, background: 'linear-gradient(0deg,rgba(0,0,0,.62),transparent)', zIndex: 1, pointerEvents: 'none' }} />}
                <div style={{ position: sp.videoOn ? 'absolute' : 'static', top: sp.videoOn ? 18 : 24, left: sp.videoOn ? '50%' : undefined, transform: sp.videoOn ? 'translateX(-50%)' : undefined, zIndex: 2, textAlign: 'center', ...(sp.videoOn ? { background: 'rgba(10,16,30,.42)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', borderRadius: 16, padding: '8px 20px', border: '1px solid rgba(255,255,255,.12)', whiteSpace: 'nowrap' } : {}), textShadow: sp.videoOn ? '0 1px 6px rgba(0,0,0,.7)' : 'none' }}>
                  {!sp.videoOn && (ci.since ? <div ref={gPop} style={{ display: 'flex', justifyContent: 'center' }}><Ava txt={initials(ci.number)} size={96} bg="rgba(255,255,255,.16)" /></div> : <div style={{ display: 'flex', justifyContent: 'center' }}><RingBell size={108} /></div>)}
                  <div style={{ fontSize: 24, fontWeight: 700, marginTop: sp.videoOn ? 0 : 14 }}>{ci.number || '—'}</div>{popClient && <div style={{ fontSize: 14, color: '#9fd0ff', marginTop: 2, fontWeight: 600 }}>{popClient.name}</div>}
                  <div style={{ color: 'rgba(255,255,255,.75)', marginTop: 4 }}>{sp.held ? 'En espera' : (ci.since ? <Timer since={ci.since} /> : <span style={{ color: /rechaz|error/i.test(sp.note) ? '#ff6b6b' : 'rgba(255,255,255,.85)' }}>{sp.note || 'Llamando…'}</span>)}{q ? <span style={{ marginLeft: 10, letterSpacing: 1, color: q.score >= 3 ? C.green : q.score === 2 ? '#ffcc00' : '#ff5b52' }}>{dots}</span> : null}{ci.since && sp.usingRelay != null ? <span className={sp.usingRelay ? 'turn-live' : ''} style={{ marginLeft: 10, fontSize: 10.5, fontWeight: 700, letterSpacing: .6, padding: '2px 8px', borderRadius: 20, background: sp.usingRelay ? 'rgba(34,197,94,.22)' : 'rgba(255,255,255,.14)', color: sp.usingRelay ? '#7ee2a6' : 'rgba(255,255,255,.8)' }}>{sp.usingRelay ? 'VÍA TURN' : 'DIRECTO'}</span> : null}</div>{ci.since && !sp.held && !sp.videoOn ? <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}><LiveWave getStream={sp.getRemoteStream} bars={11} h={34} /></div> : null}
                  {sp.heldInfo && <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.2)', borderRadius: 20, padding: '5px 6px 5px 12px', fontSize: 12 }}>{IcPause({ c: '#ffd47a', s: 13 })} {sp.heldInfo.number} en espera <button onClick={sp.switchLine} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 14, padding: '4px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Cambiar</button><button onClick={sp.conference} style={{ background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: 14, padding: '4px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Unir</button></div>}
                  {sp.conf && <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(139,92,246,.22)', border: '1px solid rgba(139,92,246,.5)', borderRadius: 20, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#d9c9ff' }}>● Conferencia activa</div>}
                </div>
                {pad && !sp.videoOn && <div style={{ ...S.keypad, marginTop: 18 }}>{['1','2','3','4','5','6','7','8','9','*','0','#'].map(k => <button key={k} className="ph-key" style={{ ...S.key, width: 64, height: 48, background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.2)', color: '#fff' }} onClick={() => press(k)}><span style={{ fontSize: 20 }}>{k}</span></button>)}</div>}
                <div style={{ flex: 1 }} />
                <div className="ctl-in" style={{ zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', ...(sp.videoOn ? { position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', background: 'rgba(12,20,38,.55)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderRadius: 22, padding: '14px 18px 12px', border: '1px solid rgba(255,255,255,.1)' } : {}) }}>
                  {sp.attended && <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 320, marginBottom: 10, background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.2)', borderRadius: 12, padding: '8px 12px' }}>
                    <div style={{ flex: 1, fontSize: 13 }}>Consultando a <b>{sp.attended.number}</b> · {sp.attended.state === 'talking' ? 'en línea' : sp.attended.state === 'calling' ? 'llamando…' : sp.attended.state}</div>
                    <button onClick={sp.completeAttended} style={{ background: C.green, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>Completar</button>
                    <button onClick={sp.cancelAttended} style={{ background: 'rgba(255,255,255,.18)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>Cancelar</button>
                  </div>}
                  <div style={S.ctlGrid} ref={gStagger}>
                    {[
                      { show: true, node: <CtlBtn key="mute" on={sp.muted} onClick={sp.toggleMute} icon={IcMic} iconOff={IcMicOff} label={sp.muted ? 'Mudo' : 'Silenciar'} /> },
                      { show: true, node: <CtlBtn key="pad" on={pad} onClick={() => setPad(p => !p)} icon={IcGrid} label="Teclado" /> },
                      { show: !sipMode, node: <CtlBtn key="spk" on={sp.speaker} onClick={sp.toggleSpeaker} icon={IcSpeaker} label="Altavoz" /> },
                      { show: !sipMode, node: <CtlBtn key="vid" on={sp.videoOn} onClick={sp.toggleVideo} icon={IcVideo} iconOff={IcVideoOff} label={sp.videoOn ? 'Cortar video' : 'Video'} /> },
                      { show: !sipMode, node: <CtlBtn key="hold" on={sp.held} onClick={sp.toggleHold} icon={IcPause} label={sp.held ? 'Reanudar' : 'Retener'} /> },
                      { show: true, node: <CtlBtn key="xfer" on={!!sp.attended || xfer} onClick={() => { if (sp.attended) return; setXferNum(''); setXfer(true); }} icon={IcSwap} label="Transferir" /> },
                      { show: apiOn, node: <CtlBtn key="rec" on={recording} onClick={toggleRecord} icon={IcRec} label={recording ? 'Grabando' : 'Grabar'} /> },
                      { show: !sipMode, node: <CtlBtn key="inv" on={!!sp.attended} onClick={() => { if (sp.attended) return; const t = prompt('Invitar interno a la conferencia:'); if (t && t.trim()) sp.attendedCall(t.trim()); }} icon={IcPlus} label="Invitar" /> },
                    ].filter(c => c.show).map(c => c.node)}
                  </div>
                  <button style={{ ...S.hang, marginTop: 20 }} onClick={() => { sounds.uiClick(); sp.hangup(); }}>{IcPhone({ c: '#fff', s: 28 })}</button>
                </div>
                <div style={{ flex: 1 }} />
                {xfer && (
                  <div className="call-overlay" style={{ position: 'absolute', inset: 0, background: 'rgba(6,10,20,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }} onClick={() => setXfer(false)}>
                    <div onClick={e => e.stopPropagation()} style={{ background: '#fff', color: C.ink, borderRadius: 16, padding: 20, width: 300, boxShadow: '0 20px 50px rgba(0,0,0,.45)' }}>
                      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Transferir llamada</div>
                      <input autoFocus value={xferNum} onChange={e => setXferNum(e.target.value.replace(/[^\d*#+]/g, ''))} placeholder="Interno o número" style={{ ...S.inp, marginBottom: 14 }} onKeyDown={e => { if (e.key === 'Enter' && xferNum) { sp.transfer(xferNum); setXfer(false); } }} />
                      <div style={{ display: 'flex', gap: 10 }}>
                        <button disabled={!xferNum} onClick={() => { sp.transfer(xferNum); setXfer(false); }} style={{ flex: 1, padding: 10, borderRadius: 10, border: 'none', background: C.accent, color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: xferNum ? 1 : .5 }}>Ciega</button>
                        <button disabled={!xferNum} onClick={() => { sp.attendedCall(xferNum); setXfer(false); }} style={{ flex: 1, padding: 10, borderRadius: 10, border: `1px solid ${C.accent}`, background: '#fff', color: '#1d4ed8', fontWeight: 700, cursor: 'pointer', opacity: xferNum ? 1 : .5 }}>Atendida</button>
                      </div>
                      <div style={{ fontSize: 11, color: C.sub, marginTop: 10 }}>Ciega: transfiere de inmediato. Atendida: hablás primero y después completás.</div>
                      <button onClick={() => setXfer(false)} style={{ width: '100%', marginTop: 8, background: 'none', border: 'none', color: C.sub, cursor: 'pointer', fontSize: 13 }}>Cancelar</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {modal && (
            <div style={S.modalWrap} onClick={() => setModal(null)}>
              <div style={S.modal} onClick={e => e.stopPropagation()}>
                <div style={{ background: 'linear-gradient(160deg,#16233f,#0f1a30)', color: '#fff', padding: '22px 20px', display: 'flex', alignItems: 'center', gap: 14, position: 'relative' }}>
                  <Ava txt={initials(modal.number)} size={54} bg={modal.dir === 'out' ? 'linear-gradient(160deg,#9db4e0,#6d8fd6)' : (modal.missed ? C.red : C.green)} />
                  <div><div style={{ fontSize: 20, fontWeight: 700 }}>{modal.number}</div><div style={{ fontSize: 13, color: 'rgba(255,255,255,.75)' }}>{modal.dir === 'out' ? 'Saliente' : modal.missed ? 'Perdida' : 'Entrante'}{modal.video ? ' · Video' : ''}</div></div>
                  <button onClick={() => setModal(null)} style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(255,255,255,.15)', border: 'none', borderRadius: 8, width: 30, height: 30, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{IcX({ c: '#fff', s: 18 })}</button>
                </div>
                <div style={{ padding: 20 }}>
                  <div style={{ display: 'flex', gap: 20, marginBottom: 14 }}>
                    <div style={{ flex: 1 }}><div style={S.fieldLbl}>Fecha</div><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{IcCal({ c: C.sub, s: 16 })}{fmtDate(modal.t)}</div></div>
                    <div style={{ flex: 1 }}><div style={S.fieldLbl}>Duración</div><div>{fmtDur(modal.dur)}</div></div>
                  </div>
                  <div style={S.fieldLbl}>Grabación</div>
                  {!apiOn ? <div style={{ fontSize: 13, color: C.sub }}>Conectá el sistema (Ajustes) para escuchar grabaciones.</div> :
                    recState === 'loading' ? <div style={{ fontSize: 13, color: C.sub }}>Buscando grabación…</div> :
                    recState === 'ready' ? <audio controls src={recUrl} style={{ width: '100%' }} /> :
                    <div style={{ fontSize: 13, color: C.sub }}>Sin grabación para esta llamada.</div>}
                  <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                    <button style={{ ...S.primary, background: C.green }} onClick={() => callNow(modal.number)}>Llamar</button>
                    <button style={{ ...S.primary, background: C.accent }} onClick={() => callNow(modal.number, true)}>Video</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {showProv && (
            <div style={S.modalWrap} onClick={() => setShowProv(false)}>
              <div ref={gModal} onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 22, width: 360, boxShadow: '0 24px 60px rgba(0,0,0,.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}><div style={{ fontWeight: 700, fontSize: 17 }}>Aprovisionar teléfono</div><button onClick={() => setShowProv(false)} style={{ marginLeft: 'auto', ...S.actBtn(C.sub) }}>{IcX({ c: C.sub, s: 16 })}</button></div>
                <div style={{ fontSize: 13, color: C.sub, marginBottom: 12 }}>Genera un QR que provisiona SIP + CRM en un escaneo. Requiere permisos de admin/supervisor.</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input autoFocus value={provExt} onChange={e => setProvExt(e.target.value.replace(/[^\d]/g, ''))} placeholder="Interno (ej. 2001)" style={{ ...S.inp, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') genProv(); }} />
                  <button disabled={!provExt || provBusy} onClick={genProv} style={{ ...S.primary, margin: 0, width: 'auto', padding: '10px 16px', opacity: (!provExt || provBusy) ? .5 : 1 }}>{provBusy ? '…' : 'Generar'}</button>
                </div>
                {provErr && <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{provErr}</div>}
                {provQr && <div style={{ textAlign: 'center' }}><img src={provQr} alt="QR" style={{ width: 236, height: 236 }} /><div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>Escanealo desde el otro softphone → Ajustes → Configurar por QR.</div><button onClick={() => { try { navigator.clipboard.writeText(provUrl); } catch {} }} style={{ marginTop: 10, background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '7px 14px', cursor: 'pointer', color: C.sub, fontSize: 13 }}>Copiar enlace</button></div>}
              </div>
            </div>
          )}

          {showDiag && (
            <div style={S.modalWrap} onClick={() => setShowDiag(false)}>
              <div ref={gModal} onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 22, width: 430, maxHeight: '82vh', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>{IcShield({ c: C.accent, s: 20 })}<div style={{ fontWeight: 700, fontSize: 17 }}>Diagnóstico</div><button onClick={() => setShowDiag(false)} style={{ marginLeft: 'auto', ...S.actBtn(C.sub) }}>{IcX({ c: C.sub, s: 16 })}</button></div>
                <DiagRow k="Registro" v={registered ? 'registrado ✓' : (regState || 'no')} good={registered} />
                {!registered && regMsg ? <DiagRow k="Motivo" v={regMsg} /> : null}
                <DiagRow k="Motor" v={sipMode ? ('SIP nativo ' + String(cfg.sipTransport || 'udp').toUpperCase()) : 'WebRTC (WSS)'} />
                <DiagRow k="Servidor" v={sipMode ? (cfg.sipServer + ':' + cfg.sipPort) : (cfg.wss || '—')} />
                <DiagRow k="Transporte" v={sipMode ? ('SIP ' + (cfg.sipTransport || 'udp').toUpperCase()) : 'WebRTC'} />
                <DiagRow k="Servidor" v={sipMode ? (cfg.sipServer + ':' + cfg.sipPort) : (cfg.wss || '—')} />
                <DiagRow k="Dominio / Interno" v={(cfg.domain || '—') + ' / ' + (cfg.ext || '—')} />
                {sipMode && <DiagRow k="SRTP" v={cfg.sipSrtp || 'none'} />}
                <DiagRow k="Sistema (CRM)" v={apiOn ? ('conectado · ' + (api.getApiUser() || '')) : 'no conectado'} good={apiOn} />
                <div style={{ height: 1, background: C.line, margin: '10px 0' }} />
                {sp.inCall ? (<>
                  <DiagRow k="Llamada" v={(sp.callInfo && sp.callInfo.number) || '—'} />
                  <DiagRow k="Códec" v={(sp.quality && sp.quality.codec) || '—'} />
                  <DiagRow k="Ruta de medios" v={candLabel(sp.quality && sp.quality.candType)} good={sp.usingRelay === false} />
                  <DiagRow k="RTT / Jitter" v={((sp.quality && sp.quality.rtt != null) ? sp.quality.rtt + ' ms' : '—') + ' / ' + ((sp.quality && sp.quality.jitter != null) ? sp.quality.jitter + ' ms' : '—')} />
                  <DiagRow k="Pérdida" v={(sp.quality && sp.quality.loss != null) ? sp.quality.loss + ' %' : '—'} />
                </>) : <div style={{ fontSize: 13, color: C.sub, padding: '6px 0' }}>Sin llamada activa. Hacé una llamada para ver las métricas de red en vivo.</div>}
                <div style={{ height: 1, background: C.line, margin: '10px 0' }} />
                <DiagRow k="Entorno" v={window.sphone ? 'App Windows (Electron)' : 'Navegador'} />
                <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                  <button onClick={exportDiag} style={{ ...S.primary, flex: 1 }}>Exportar log</button>
                  <button onClick={() => setShowDiag(false)} style={{ flex: 1, padding: 10, borderRadius: 10, border: `1px solid ${C.line}`, background: '#fff', color: C.sub, cursor: 'pointer', fontWeight: 600 }}>Cerrar</button>
                </div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 8, textAlign: 'center' }}>Copia al portapapeles y descarga un .txt.</div>
              </div>
            </div>
          )}

          {callStats && (() => { const ql = qLabel(callStats.avg); return (
            <div className="menu-pop" style={{ position: 'fixed', left: '50%', bottom: 22, transform: 'translateX(-50%)', zIndex: 120, background: '#0f1a30', color: '#fff', borderRadius: 14, padding: '13px 18px', boxShadow: '0 18px 44px rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', gap: 16, minWidth: 330 }}>
              <div><div style={{ fontWeight: 700, fontSize: 15 }}>{callStats.number}</div><div style={{ fontSize: 12, color: 'rgba(255,255,255,.7)' }}>Llamada finalizada · {fmtDur(callStats.dur)}</div></div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: ql.c }} /><span style={{ fontWeight: 700, fontSize: 13 }}>{ql.t}</span></div><div style={{ fontSize: 11, color: 'rgba(255,255,255,.6)', marginTop: 2 }}>{callStats.codec || 'audio'}{callStats.relay ? ' · TURN' : ''}</div></div>
              <button onClick={() => setCallStats(null)} style={{ background: 'rgba(255,255,255,.12)', border: 'none', borderRadius: 8, width: 30, height: 30, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{IcX({ c: '#fff', s: 15 })}</button>
            </div>
          ); })()}
          {menu && <><div onClick={() => setMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 190 }} />
            <div className="menu-pop" style={{ position: 'fixed', top: 16, left: 80, zIndex: 200, background: '#fff', border: `1px solid ${C.line}`, borderRadius: 10, boxShadow: '0 14px 34px rgba(10,20,50,.22)', overflow: 'hidden', minWidth: 180 }}>
              <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.line}` }}><div style={{ fontWeight: 700, fontSize: 14 }}>{cfg.name || 'Softphone'}</div><div style={{ fontSize: 12, color: C.sub }}>{isComplete(cfg) ? 'Interno ' + cfg.ext : 'sin cuenta'}</div></div>
              <button onClick={() => { setMenu(false); setShowProfile(true); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14 }}>{IcUser({ c: C.sub, s: 16 })} Perfil</button>
              <button onClick={() => { setMenu(false); setShowAccts(true); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14 }}>{IcUsers({ c: C.sub, s: 16 })} Cuentas{accts.length ? ' (' + accts.length + ')' : ''}</button>
              <button onClick={logout} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, color: C.red }}>{IcPower({ c: C.red, s: 16 })} Cerrar sesión</button>
            </div></>}
          {showAccts && (
            <div style={S.modalWrap} onClick={() => setShowAccts(false)}>
              <div ref={gModal} onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 22, width: 390, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>{IcUsers({ c: C.accent, s: 20 })}<div style={{ fontWeight: 700, fontSize: 17 }}>Cuentas</div><button onClick={() => setShowAccts(false)} style={{ marginLeft: 'auto', ...S.actBtn(C.sub) }}>{IcX({ c: C.sub, s: 16 })}</button></div>
                {accts.length === 0 ? <div style={{ fontSize: 13, color: C.sub, padding: '6px 0 12px' }}>No hay cuentas guardadas. Guardá la actual para cambiar rápido entre internos.</div> :
                  accts.map(a => { const active = isComplete(cfg) && a.id === acctId(cfg); return (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: `1px solid ${C.line}` }}>
                      <Ava txt={initials(a.label)} size={36} bg={active ? 'linear-gradient(160deg,#22c55e,#16a34a)' : 'linear-gradient(160deg,#7c9be0,#4f6fc9)'} />
                      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{a.label}{active && <span style={{ marginLeft: 8, fontSize: 10, background: 'rgba(34,197,94,.15)', color: '#15803d', borderRadius: 8, padding: '1px 7px' }}>activa</span>}</div><div style={{ fontSize: 12, color: C.sub }}>{a.id}{a.api && a.api.token ? ' · CRM' : ''}</div></div>
                      {!active && <button onClick={() => switchAccount(a)} style={{ ...S.chip('rgba(47,128,255,.1)', '#1d4ed8'), border: 'none', cursor: 'pointer', fontWeight: 600 }}>Usar</button>}
                      <button onClick={() => removeAccount(a.id)} title="Eliminar" style={S.actBtn(C.red)}>{IcX({ c: C.red, s: 15 })}</button>
                    </div>); })}
                <button onClick={saveCurrentAccount} disabled={!isComplete(cfg)} style={{ ...S.primary, marginTop: 14, opacity: isComplete(cfg) ? 1 : .5 }}>Guardar la cuenta actual</button>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 8, textAlign: 'center' }}>Las cuentas se guardan cifradas en este equipo.</div>
              </div>
            </div>
          )}
          {showProfile && (
            <div style={S.modalWrap} onClick={() => setShowProfile(false)}>
              <div style={{ ...S.modal, width: 400 }} onClick={e => e.stopPropagation()}>
                <div style={{ background: 'linear-gradient(160deg,#16233f,#0f1a30)', color: '#fff', padding: '18px 20px', fontWeight: 700, fontSize: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span>Mi perfil</span><button onClick={() => setShowProfile(false)} style={{ background: 'rgba(255,255,255,.15)', border: 'none', color: '#fff', borderRadius: 8, width: 28, height: 28, cursor: 'pointer' }}>{IcX({ c: '#fff', s: 16 })}</button></div>
                <div style={{ padding: 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
                    <Ava photo={photo} txt={isComplete(cfg) ? initials(cfg.ext) : '·'} size={72} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <label style={{ ...S.chip('rgba(47,128,255,.12)', '#1d4ed8'), cursor: 'pointer' }}>Subir foto<input type="file" accept="image/*" style={{ display: 'none' }} onChange={onPhoto} /></label>
                      {photo && <button onClick={clearPhoto} style={{ background: 'none', border: 'none', color: C.red, fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>Quitar foto</button>}
                    </div>
                  </div>
                  <div style={S.fieldLbl}>Nombre para mostrar</div>
                  <input style={S.inp} value={cfg.name || ''} onChange={e => setCfg(c => ({ ...c, name: e.target.value }))} placeholder="Tu nombre" />
                  <button style={{ ...S.primary, marginTop: 16 }} onClick={() => { saveConfig(cfgLatest.current); setShowProfile(false); }}>Guardar</button>
                </div>
              </div>
            </div>
          )}
          {spyTarget && (
            <div style={S.modalWrap} onClick={() => setSpyTarget(null)}>
              <div style={{ ...S.modal, width: 380 }} onClick={e => e.stopPropagation()}>
                <div style={{ background: 'linear-gradient(160deg,#3b2a6b,#241546)', color: '#fff', padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>{IcHead({ c: '#fff', s: 24 })}<div><div style={{ fontWeight: 700, fontSize: 17 }}>Supervisar</div><div style={{ fontSize: 13, color: 'rgba(255,255,255,.75)' }}>{spyTarget.name || spyTarget.ext} · {spyTarget.ext}</div></div></div>
                <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button onClick={() => doSpy('listen')} style={{ ...S.primary, background: '#4f46e5', textAlign: 'left', paddingLeft: 16 }}>🎧 Escuchar <span style={{ fontWeight: 400, opacity: .8 }}>· ninguno te oye</span></button>
                  <button onClick={() => doSpy('whisper')} style={{ ...S.primary, background: '#8b5cf6', textAlign: 'left', paddingLeft: 16 }}>🤫 Susurrar <span style={{ fontWeight: 400, opacity: .8 }}>· solo te oye tu agente</span></button>
                  <button onClick={() => doSpy('barge')} style={{ ...S.primary, background: '#f59e0b', textAlign: 'left', paddingLeft: 16 }}>📢 Irrumpir <span style={{ fontWeight: 400, opacity: .8 }}>· entrás a la llamada</span></button>
                  <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>La central te va a llamar; atendé para monitorear.</div>
                  {spyMsg && <div style={{ fontSize: 12, color: /error/i.test(spyMsg) ? C.red : '#15803d' }}>{spyMsg}</div>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {showQr && <div style={{ position: 'fixed', inset: 0, zIndex: 3000 }}><QrProvision cfg={cfg} onApply={applyProv} onClose={() => { sounds.uiClick(); setShowQr(false); }} /></div>}
    </div>
  );
}

function EmptySystem({ onGo }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: C.sub }}>
      <div style={{ marginBottom: 10 }}>{IcShield({ c: '#c2c9d6', s: 40 })}</div>
      <div style={{ fontWeight: 600, color: C.ink, marginBottom: 4 }}>Conectá el sistema PBX-NG</div>
      <div style={{ fontSize: 13, marginBottom: 14 }}>Para traer contactos, clientes, intercom y grabaciones,<br />iniciá sesión con tu usuario del panel.</div>
      <button onClick={onGo} style={{ background: '#0f1a30', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', cursor: 'pointer' }}>Ir a Ajustes</button>
    </div>
  );
}