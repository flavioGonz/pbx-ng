import { useEffect, useState, useRef } from 'react';
import CallScreen, { colorAvatar } from './CallScreen';
import EscenaMedios, { useVideoRemoto } from './MediosLlamada';
import ShaderPuntos from './ShaderPuntos';
import { flushSync } from 'react-dom';
import { useSip, listDevices, getDevPrefs, setDevPref } from './useSip.js';
import { useSipNative } from './useSipNative.js';
import { loadConfig, saveConfig, isComplete, getAccounts as cfgGetAccounts, setAccounts as cfgSetAccounts,
  getClientesLocales, setClientesLocales, esLocal, nuevoIdLocal } from './config.js';
import * as api from './api.js';
import { decodeProv } from './prov.js';
import QRCode from 'qrcode';
import { gsap } from 'gsap';
import { gEnter, gPop, gSplash, gModal, gStagger } from './anim.js';
import * as sounds from './sounds.js';
import { testIce, refrescarIce, iceEfectivos } from './ice.js';
import QrProvision from './QrProvision.jsx';

function withVT(fn) { try { if (typeof document !== 'undefined' && document.startViewTransition) { document.startViewTransition(() => flushSync(fn)); return; } } catch {} fn(); }
const initials = (n) => (String(n || '?')).replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '#';
/* Inyectada por vite desde package.json (ver vite.config.js). Escrita a mano se olvida:
 * asi la aplicacion no puede mentir sobre que version esta corriendo. */
const APP_VERSION = 'v' + (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0');
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

/* Una sola paleta para toda la aplicación. Antes convivían dos: el azul marino del menú
 * lateral y los verdes/rojos de los botones por un lado, y los de la pantalla de llamada
 * por otro —parecido pero distinto, que es peor que distinto—. Ahora el gris oscuro del
 * menú es EL MISMO de la pantalla de llamada, y los colores de estado (verde = en línea o
 * atender, ámbar = en espera, rojo = cortar o error, azul = acción) son los mismos en la
 * ventana grande, en la pantalla de llamada y en el widget flotante. */
const C = { rail: '#1a1d23', railHi: '#2b2f37', accent: '#1a73f2', green: '#2bd95a', amber: '#f0b429', red: '#eb4c46', ink: '#e9ebee', sub: '#8d929a', bg: '#1f2229', card: '#262a31', line: '#33373e', keybg: 'transparent', field: '#1f2229', sel: 'rgba(76,154,255,.15)', soft: '#2b2f37' };
/* Circulo pastel con las iniciales en oscuro. El color sale del propio nombre, asi el
 * mismo contacto es siempre del mismo color y se reconoce antes de leerlo. */
function Ava({ photo, txt, size = 44, bg, style }) {
  const st = { width: size, height: size, borderRadius: '50%', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 500, fontSize: size * 0.34, overflow: 'hidden', ...style };
  if (photo) return <img src={photo} alt="" style={{ ...st, objectFit: 'cover' }} />;
  return <div style={{ ...st, background: bg || colorAvatar(String(txt || '')), color: bg ? '#fff' : '#33404f' }}>{txt}</div>;
}
const S = {
  root: { position: 'fixed', inset: 0, display: 'flex', background: C.bg, color: C.ink, fontSize: 14 },
  rail: { width: 68, background: C.rail, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 2, flex: 'none' },
  navBtn: (on) => ({ width: 58, height: 54, borderRadius: 10, border: 'none', cursor: 'pointer', background: on ? C.railHi : 'transparent', color: on ? '#4c9aff' : '#8d929a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, fontSize: 10 }),
  content: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  header: { height: 40, borderBottom: `1px solid ${C.line}`, background: C.rail, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px 0 14px', flex: 'none' },
  body: { flex: 1, position: 'relative', display: 'flex', minHeight: 0 },
  dialCol: { width: 266, borderRight: `1px solid ${C.line}`, background: C.card, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '14px 16px 16px', flex: 'none' },
  /* El buscador: una caja con borde, no un numero gigante. Es lo primero de la columna
     y sirve para dos cosas a la vez —marcar y buscar por nombre—, como en el telefono
     del cliente. */
  numIn: { width: '100%', boxSizing: 'border-box', fontSize: 13.5, textAlign: 'left', outline: 'none', padding: '9px 11px', borderRadius: 7, color: C.ink, background: '#1f2229', border: `1px solid ${C.line}` },
  keypad: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 2, margin: '14px 0 16px', width: '100%' },
  /* Teclas planas: sin caja ni borde, el numero grande y las letras debajo. */
  key: { height: 50, borderRadius: 10, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, color: C.ink },
  /* Los dos botones de abajo son pastillas anchas, no redondos: video a la izquierda,
     llamar a la derecha. */
  cbtn: (bg) => ({ width: 78, height: 34, borderRadius: 18, background: bg, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }),
  listCol: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  listHdr: { padding: '14px 20px 8px', fontSize: 15, fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: C.ink },
  scroll: { flex: 1, overflowY: 'auto', padding: '0 14px 14px' },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 10, cursor: 'pointer' },
  actBtn: (c) => ({ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.07)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: c }),
  chip: (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, background: bg, color: fg, fontSize: 12, fontWeight: 600 }),
  card: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '4px 16px 8px', color: C.ink },
  inp: { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 9, border: `1px solid ${C.line}`, fontSize: 14, outline: 'none', background: '#1f2229', color: C.ink },
  sel: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 9, border: `1px solid ${C.line}`, fontSize: 14, background: '#1f2229', color: C.ink, outline: 'none' },
  primary: { width: '100%', padding: 12, borderRadius: 10, border: 'none', background: C.accent, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  overlay: { position: 'fixed', inset: 0, background: 'linear-gradient(180deg,#132038,#0b1220)', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modalWrap: { position: 'fixed', inset: 0, background: 'rgba(10,16,30,.45)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal: { width: 440, maxWidth: '90%', background: C.card, color: C.ink, borderRadius: 16, border: `1px solid ${C.line}`, boxShadow: '0 24px 60px rgba(0,0,0,.5)', overflow: 'hidden' },
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
/* El estado del TURN, en la barra de título.
 *
 * Era una pastilla de color con fondo, borde de 20 px y texto en negrita: al lado del
 * nombre del interno y de los botones de ventana parecía una etiqueta pegada de otra
 * aplicación —es información de fondo, no una alerta—. Ahora es lo que es: un punto del
 * color del estado y una palabra en el gris del resto de la barra. Cuando el TURN está
 * EN USO durante una llamada el punto late; eso sí merece que el ojo vaya.
 */
function TurnChip({ cfg, sp, t }) {
  const configured = !!(cfg.turn && cfg.turnUser && cfg.turnPass);
  const st = (t && t.state) || 'idle';
  let col = C.sub, label = 'Sin TURN', live = false;
  if (sp.inCall && sp.usingRelay === true) { col = '#4ade80'; label = 'TURN en uso'; live = true; }
  else if (sp.inCall && sp.usingRelay === false) { col = '#7cb0ff'; label = 'Medios directos'; }
  else if (st === 'testing') { col = C.sub; label = 'Probando TURN…'; }
  else if (st === 'ok') { col = '#4ade80'; label = 'TURN listo'; }
  else if (st === 'turn-auth') { col = '#f87171'; label = 'TURN: auth falló'; }
  else if (st === 'turn-unreachable' || st === 'error') { col = '#f87171'; label = 'TURN no responde'; }
  else if (configured) { col = '#7cb0ff'; label = 'TURN sin probar'; }
  return (
    <span title={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5,
      color: C.sub, letterSpacing: .1, whiteSpace: 'nowrap', paddingRight: 2 }}>
      <i className={live ? 'turn-live' : ''} style={{ width: 7, height: 7, borderRadius: '50%', background: col, flex: 'none' }} />
      {label}
    </span>
  );
}
function CtlBtn({ on, onClick, icon, iconOff, label }) {
  return <button className="ph-key" style={S.ctl(on)} onClick={onClick}>{(on && iconOff ? iconOff : icon)({ c: on ? '#000' : '#fff', s: 22 })}<span>{label}</span></button>;
}
function Section({ title, icon, right, children }) {
  return <div>{(title || right) ? <div style={S.section}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>{icon}{title}</span>{right || null}</div> : null}<div style={S.card}>{children}</div></div>;
}
/* La hora sola si fue hoy, y dia/mes + hora si fue antes. La fecha completa con año
 * ocupaba media fila para decir algo que casi nunca importa: lo de hoy es lo que se
 * mira, y para lo viejo alcanza con «24/9 15:12». */
const fmtDate = (t) => {
  const d = new Date(t), h = new Date();
  const hoy = d.getDate() === h.getDate() && d.getMonth() === h.getMonth() && d.getFullYear() === h.getFullYear();
  const hora = d.toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit', hour12: false });
  return hoy ? hora : (d.getDate() + '/' + (d.getMonth() + 1) + ' ' + hora);
};
const fmtDur = (d) => d ? `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}` : '—';

// ---- Reproductor go2rtc por MSE (fMP4 sobre WebSocket, atraviesa el proxy sin UDP) ----
/* ── El go2rtc propio de la app, visto desde el renderer ─────────────────────
 * Recibe las camaras locales que hay que mostrar y devuelve dónde mirarlas. Decide una
 * vez por lista: la firma es `id=rtsp` ordenado, así que volver a entrar a la misma
 * pantalla no reinicia el proceso.
 *
 * Fuera de Electron —la PWA en un navegador— no hay proceso hijo que levantar y no hay
 * nada que inventar: se devuelve el motivo y el visor lo muestra. Esa es la diferencia
 * real entre el softphone de escritorio y la PWA, y conviene que se lea en la pantalla en
 * vez de quedar en un reproductor que no arranca nunca. */
function useGo2rtcLocal(camsLocales) {
  const [res, setRes] = useState({ base: '', motivo: '' });
  const firma = (camsLocales || []).map((c) => c.id + '=' + c.rtsp).sort().join('|');
  useEffect(() => {
    if (!firma) { setRes({ base: '', motivo: '' }); return undefined; }
    const sp = typeof window !== 'undefined' ? window.sphone : null;
    if (!sp || !sp.g2localAsegurar) {
      setRes({ base: '', motivo: 'Para verla acá hace falta el softphone de escritorio. Desde el navegador, subila a la central.' });
      return undefined;
    }
    let vivo = true;
    sp.g2localAsegurar(firma.split('|').map((x) => ({ id: x.slice(0, x.indexOf('=')), rtsp: x.slice(x.indexOf('=') + 1) })))
      .then((r) => { if (!vivo) return; setRes(r && r.ok ? { base: r.base, motivo: '' } : { base: '', motivo: (r && r.motivo) || 'no se pudo abrir el video' }); })
      .catch((e) => { if (vivo) setRes({ base: '', motivo: (e && e.message) || 'no se pudo abrir el video' }); });
    return () => { vivo = false; };
  }, [firma]);
  return res;
}

/* Una camara —de la central o de este aparato— lista para el visor. La de la central ya
 * viene con `base` y `src`; la local los recibe del go2rtc propio, y si no hay con que
 * levantarlo se queda con el motivo a la vista en vez de un reproductor vacio. */
function fuenteDeCamara(d, g2l) {
  if (!d || !d.rtsp) return d;                             // de la central: tal cual
  if (g2l && g2l.base) return { ...d, base: g2l.base, src: d.id, local: true };
  return { ...d, motivo: (g2l && g2l.motivo) || '' };
}
/* Una camara guardada SOLO en este aparato no tiene go2rtc donde mirarse: Chromium no
 * reproduce rtsp://. El requisito es explicito en que eso se DICE, con la accion para
 * resolverlo, en vez de mostrar un reproductor vacio o un «sin senal» generico que manda a
 * revisar la red de una camara que nunca se intento abrir. */
function MseTile({ stream, fit = false, onSubir }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [muted, setMuted] = useState(true);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    const base = stream && stream.base, src = stream && stream.src, video = videoRef.current;
    if (stream && stream.rtsp && !src) { setStatus('local'); return; }
    if (!base || !src || !video || typeof MediaSource === 'undefined') { setStatus('error'); return; }
    let stopped = false, ws = null, sb = null, queue = [], connId = null, unsub = null;
    setStatus('connecting');
    const ms = new MediaSource(); video.src = URL.createObjectURL(ms); video.muted = true;
    /* La URL del WebSocket se arma con una «entrada» de un solo uso: un WebSocket del
     * navegador no puede mandar cabeceras, y meter la sesión entera en la query la deja
     * escrita en todos los registros del camino. La entrada vale un minuto, sólo para
     * esta cámara, y se quema al abrirla. */
    const armarUrl = async () => {
      const b = base.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/ws?src=' + encodeURIComponent(src);
      /* Una camara del go2rtc PROPIO de la app no necesita entrada: el go2rtc escucha en
       * 127.0.0.1 y no hay sesion de central de por medio. Pedirle un ticket a la central
       * ademas fallaria —o peor, funcionaria y mandaria el nombre de una camara local a un
       * servidor que no la conoce—. */
      if (stream && stream.local) return b;
      try { const r = await api.intercomTicket(src); if (r && r.ticket) return b + '&t=' + encodeURIComponent(r.ticket); } catch (_) {}
      return b;
    };
    const codecsMsg = () => { const cands = ['avc1.640029', 'avc1.64002A', 'avc1.4d002a', 'avc1.42e01e', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'opus']; const codecs = cands.filter(cc => { try { return MediaSource.isTypeSupported('video/mp4; codecs="' + cc + '"') || MediaSource.isTypeSupported('audio/mp4; codecs="' + cc + '"'); } catch { return false; } }).join(','); return JSON.stringify({ type: 'mse', value: codecs }); };
    const flush = () => { if (!sb || sb.updating || !queue.length) return; try { sb.appendBuffer(queue.shift()); } catch {} };
    const trim = () => { try { if (sb && sb.buffered.length) { const end = sb.buffered.end(sb.buffered.length - 1); if (video.currentTime < end - 2 || video.currentTime > end) video.currentTime = end - 0.4; if (sb.buffered.start(0) < end - 10 && !sb.updating) sb.remove(0, end - 8); } } catch {} };
    const onText = (txt) => { let msg; try { msg = JSON.parse(txt); } catch { return; } if (msg.type === 'mse' && msg.value) { try { sb = ms.addSourceBuffer(msg.value); sb.mode = 'segments'; sb.addEventListener('updateend', () => { trim(); flush(); }); setStatus('live'); video.play().catch(() => {}); } catch { setStatus('error'); } } else if (msg.type === 'error') setStatus('error'); };
    const onBin = (u8) => { queue.push(u8); if (queue.length > 80) queue = queue.slice(-40); flush(); };
    const bridge = typeof window !== 'undefined' && window.sphone && window.sphone.go2rtcOpen;
    ms.addEventListener('sourceopen', () => {
      if (bridge) {
        let origin = ''; try { origin = new URL(base).origin; } catch {}
        armarUrl().then((wsUrl) => window.sphone.go2rtcOpen({ url: wsUrl, origin, token: api.getToken() })).then((r) => {
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
        armarUrl().then((wsUrl) => {
          if (stopped) return;
          try { ws = new WebSocket(wsUrl); } catch { setStatus('error'); return; }
          ws.binaryType = 'arraybuffer';
          ws.onopen = () => ws.send(codecsMsg());
          ws.onmessage = (ev) => { if (typeof ev.data === 'string') onText(ev.data); else onBin(new Uint8Array(ev.data)); };
          ws.onerror = () => { if (!stopped) setStatus('error'); };
          ws.onclose = () => { if (!stopped) setStatus(s => s === 'live' || s === 'connecting' ? 'error' : s); };
        });
      }
    });
    return () => { stopped = true; try { ws && ws.close(); } catch {} try { if (connId && window.sphone && window.sphone.go2rtcClose) window.sphone.go2rtcClose(connId); } catch {} try { unsub && unsub(); } catch {} try { if (ms.readyState === 'open') ms.endOfStream(); } catch {} try { video.src = ''; } catch {} };
  }, [stream && stream.base, stream && stream.src, gen]);
  const Ic = stream && stream.type === 'intercom' ? IcBell : IcCam;
  function toggleMute() { const v = videoRef.current; if (v) { v.muted = !v.muted; setMuted(v.muted); if (!v.muted) v.play().catch(() => {}); } }
  return (
    <div style={fit
      ? { position: 'absolute', inset: 0, background: '#000', overflow: 'hidden' }
      : { position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 14, overflow: 'hidden', background: '#0b0f17' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: status === 'live' ? 'block' : 'none' }} />
      {status === 'connecting' && <div className="ic-skel" style={{ position: 'absolute', inset: 0 }} />}
      {status === 'local' && <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 9, color: '#8b95a3', padding: 16, textAlign: 'center' }}>{IcCam({ c: '#67c7f5', s: 26 })}<span style={{ fontSize: 12.5, color: '#cdd3db', fontWeight: 600 }}>Guardada en este teléfono</span><span style={{ fontSize: 11, maxWidth: 270, lineHeight: 1.45 }}>{(stream && stream.motivo) || 'Este aparato no puede abrir un RTSP por sí solo. Subila a la central y la vas a ver acá y en el panel, como cualquier otra.'}</span><span style={{ fontSize: 10, color: '#5a6a8f', maxWidth: 270, wordBreak: 'break-all' }}>{String((stream && stream.rtsp) || '').replace(/\/\/[^@/]*@/, '//···@')}</span>{onSubir && <button onClick={onSubir} style={{ background: 'rgba(14,165,233,.16)', color: '#67c7f5', border: '1px solid rgba(14,165,233,.3)', borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>Subir a la central</button>}</div>}
      {status === 'error' && <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#8b95a3' }}>{IcVideoOff({ c: '#8b95a3', s: 28 })}<span style={{ fontSize: 12 }}>Sin señal</span><span style={{ fontSize: 10, color: '#5a6a8f', maxWidth: 240, textAlign: 'center', wordBreak: 'break-all' }}>{(stream && stream.base) || 'sin go2rtc_url'} · {(stream && stream.src) || '?'}</span><button onClick={() => setGen(g => g + 1)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,.08)', color: '#cdd3db', border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>{IcReload({ c: '#cdd3db', s: 13 })} Reintentar</button></div>}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', background: 'linear-gradient(180deg,rgba(0,0,0,.62),transparent)', color: '#fff' }}>
        {Ic({ c: '#fff', s: 14 })}
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,.6)' }}>{(stream && stream.label) || 'Dispositivo'}</span>
        {status === 'live' && <button onClick={toggleMute} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', padding: 0 }}>{IcSpeaker({ c: muted ? '#8b95a3' : '#fff', s: 15 })}</button>}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, color: status === 'live' ? '#69db7c' : status === 'connecting' ? '#ffd43b' : status === 'local' ? '#67c7f5' : '#ff8787' }}><span className={status === 'live' ? 'ic-pulse' : ''} style={{ width: 7, height: 7, borderRadius: '50%', background: status === 'live' ? '#40c057' : status === 'connecting' ? '#fab005' : status === 'local' ? '#0ea5e9' : '#fa5252' }} />{status === 'live' ? 'EN VIVO' : status === 'connecting' ? 'CARGANDO' : status === 'local' ? 'LOCAL' : 'OFFLINE'}</span>
      </div>
    </div>
  );
}

function loadPref(k, d) { try { const o = JSON.parse(localStorage.getItem('sp_prefs2') || '{}'); return k in o ? o[k] : d; } catch { return d; } }
function ToggleRow({ label, desc, on, onChange }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 2px', borderBottom: `1px solid ${C.line}` }}>
    <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>{label}</div>{desc && <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{desc}</div>}</div>
    <button onClick={() => onChange(!on)} aria-pressed={on} style={{ width: 46, height: 26, borderRadius: 20, border: 'none', cursor: 'pointer', background: on ? C.green : '#3f444d', position: 'relative', transition: 'background .18s', flex: 'none' }}><span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%', background: C.card, boxShadow: '0 1px 3px rgba(0,0,0,.3)', transition: 'left .18s' }} /></button>
  </div>;
}
function DiagRow({ k, v, good }) { return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${C.line}` }}><div style={{ fontSize: 13, color: C.sub, width: 132, flex: 'none' }}>{k}</div><div style={{ fontSize: 13, fontWeight: 600, color: good === true ? '#4ade80' : C.ink, wordBreak: 'break-all' }}>{v}</div></div>; }
const qLabel = (avg) => avg == null ? { t: 'sin datos', c: '#94a3b8' } : avg >= 3.5 ? { t: 'Excelente', c: '#2bd95a' } : avg >= 2.5 ? { t: 'Buena', c: '#1fa945' } : avg >= 1.5 ? { t: 'Regular', c: '#f0b429' } : { t: 'Mala', c: '#eb4c46' };
const candLabel = (ct) => ct === 'relay' ? 'TURN (relay)' : ct === 'srflx' ? 'STUN (srflx)' : ct === 'prflx' ? 'peer-reflexive' : ct === 'host' ? 'directo (host)' : '—';
const mpRow = { display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '10px 15px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13.5, color: 'inherit', textAlign: 'left' };
const DIAG_STEPS = ['Datos verificados', 'Conectando al servidor PBX', 'Estableciendo canal seguro', 'Registrando el interno', 'Verificando red (ICE/STUN)', 'Conexión lista'];
const DIAG_TOTAL = DIAG_STEPS.length;
function WinCtl({ dark }) {
  if (!(typeof window !== 'undefined' && window.sphone && window.sphone.winClose)) return null;
  const base = { WebkitAppRegion: 'no-drag', width: 34, height: 28, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, color: dark ? '#cfe0ff' : '#5b6b8c', transition: 'background .12s' };
  const hasMini = !!(window.sphone && window.sphone.miniShow);
  return (
    <div style={{ display: 'flex', gap: 2, WebkitAppRegion: 'no-drag', marginLeft: 6 }}>
      {hasMini && <button title="Modo mini (flotante)" style={base} onClick={() => { try { window.sphone.miniShow(true); } catch (_) {} }} onMouseEnter={e => { e.currentTarget.style.background = dark ? 'rgba(255,255,255,.1)' : C.soft; }} onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2" /><rect x="12" y="11" width="7" height="5" rx="1" /></svg></button>}
      <button title="Minimizar" style={base} onClick={() => window.sphone.winMinimize()} onMouseEnter={e => { e.currentTarget.style.background = dark ? 'rgba(255,255,255,.1)' : C.soft; }} onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}><svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.4" /></svg></button>
      <button title="Cerrar" style={base} onClick={() => window.sphone.winClose()} onMouseEnter={e => { e.currentTarget.style.background = '#eb4c46'; e.currentTarget.style.color = '#fff'; }} onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = dark ? '#cfe0ff' : '#5b6b8c'; }}><svg width="12" height="12" viewBox="0 0 12 12"><line x1="2.6" y1="2.6" x2="9.4" y2="9.4" stroke="currentColor" strokeWidth="1.4" /><line x1="9.4" y1="2.6" x2="2.6" y2="9.4" stroke="currentColor" strokeWidth="1.4" /></svg></button>
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
      <div style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62), borderRadius: '50%', background: 'linear-gradient(160deg,#4c9dff,#2f6bd6)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px rgba(26,115,242,.5)' }}>
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
  /* El menú «Más» de la barra de llamada: lo secundario no puede ocupar un botón fijo o la
   * barra se convierte en una botonera y se pierde lo importante. */
  const [mas, setMas] = useState(false);
  /* La llamada terminada se muestra un instante ANTES de volver al marcador: cortar y que
   * la pantalla salte de golpe deja la duda de si se cortó o se colgó solo. */
  const [finCall, setFinCall] = useState(null);
  /* La pantalla de llamada no desaparece de golpe: pasa 190 ms con la clase de salida.
   * Sin esto el marcador aparecia de un cuadro al otro y se sentia un corte de video. */
  const [cerrandoLlamada, setCerrandoLlamada] = useState(false);
  const finTimers = useRef([]);
  const [devs, setDevs] = useState({ mics: [], cams: [], speakers: [] });
  const [prefs, setPrefs] = useState(getDevPrefs());
  const [photo, setPhoto] = useState(getPhoto);
  const [modal, setModal] = useState(null);
  const [recUrl, setRecUrl] = useState('');
  const [recState, setRecState] = useState('idle');
  const [dir, setDir] = useState(null);
  const [cls, setCls] = useState(null);
  const [errCls, setErrCls] = useState('');        // por qué la lista de clientes vino vacía
  const [errStreams, setErrStreams] = useState('');// por qué no hay cámaras para este cliente
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
  /* ── Clientes de este aparato ───────────────────────────────────────────────
   * Existen con o sin central. Se guardan cifrados en el mismo almacén que las cuentas
   * (ver config.js) y NO se limpian al cambiar de cuenta ni al desconectarse del sistema:
   * son del aparato. Esa es justo la diferencia con `cls`/`clsFull`, que son prestados. */
  const [locales, setLocales] = useState(() => getClientesLocales());
  function guardarLocales(lista) { const l = (lista || []).slice(); setLocales(l); setClientesLocales(l); }
  function upsertLocal(c) {
    const l = locales.slice(); const i = l.findIndex((x) => x.id === c.id);
    if (i >= 0) l[i] = c; else l.push(c);
    guardarLocales(l);
    return c;
  }
  /* El alta: `null` = cerrado; `{ tipo:'cliente' }` o `{ tipo:'camara', cliente }`. */
  const [alta, setAlta] = useState(null);
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
  /* El directorio y los dispositivos, en refs: el puente con el widget flotante se
   * suscribe UNA vez y si leyera las variables de estado se quedaría con las de ese
   * primer render —el clásico «la lista siempre vuelve vacía»—. */
  const dirRef = useRef(null);
  const devsRef = useRef({ mics: [], cams: [], speakers: [] });
  const prefsRef = useRef({});

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
  /* Los dispositivos se leían SÓLO al abrir Ajustes. Quien nunca entró a esa pantalla
   * —que es casi todo el mundo— tenía la lista vacía, y el widget flotante mostraba «Sin
   * dispositivos» aunque el micrófono estuviera ahí funcionando. Ahora se leen al
   * arrancar, al volver a Ajustes, y cada vez que el sistema avisa que se enchufó o se
   * desenchufó algo (`devicechange`), que es justo cuando la lista vieja miente. */
  useEffect(() => { listDevices(false).then(setDevs); }, []);
  useEffect(() => { if (tab === 'ajustes') listDevices().then(setDevs); }, [tab]);
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md || !md.addEventListener) return undefined;
    const alCambiar = () => { listDevices(false).then(setDevs); };
    md.addEventListener('devicechange', alCambiar);
    return () => md.removeEventListener('devicechange', alCambiar);
  }, []);
  useEffect(() => { if (tab === 'llamadas' && !sp.inCall && !sp.incoming && !splash && authed) { const t = setTimeout(() => { try { numRef.current && numRef.current.focus(); } catch {} }, 120); return () => clearTimeout(t); } }, [tab, sp.inCall, sp.incoming, splash, authed]);
  /* Clientes e Intercom YA NO dependen de la central: el aparato puede tener los suyos.
   * Sólo Voz (buzón) necesita sistema de verdad. */
  useEffect(() => { if ((!apiOn && tab === 'voz') || (!showIntercom && tab === 'intercom')) setTab('llamadas'); }, [apiOn, tab, showIntercom]);
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
  /* ── La ficha del cliente durante la llamada ──────────────────────────────
   * Se busca SIEMPRE que hay una llamada: entrante o saliente, y también cuando el número
   * es un interno corto. Antes se buscaba sólo en las entrantes y se descartaban los
   * internos «porque no matchean el CRM» — y justamente los porteros están cargados como
   * internos en la ficha (`phones`), así que la ficha nunca aparecía en el caso que más
   * importa: uno llama al portero y quiere ver la entrada. */
  const numFicha = sp.incoming
    ? ((sp.incoming.remoteIdentity && sp.incoming.remoteIdentity.uri && sp.incoming.remoteIdentity.uri.user) || '')
    : ((sp.callInfo && sp.callInfo.number) || '');
  /* Se busca en los dos lados. Si el número está en los dos gana el del sistema: es el dato
   * que mantiene quien administra la central, y el local es una anotación personal. Pero las
   * cámaras se juntan, porque una cámara que uno se cargó a mano sirve igual. */
  useEffect(() => {
    if (!numFicha) return undefined;
    const loc = locales.find((c) => (c.phones || []).some((ph) => String(ph) === String(numFicha)));
    if (!apiOn) { setPopClient(loc || null); return undefined; }
    let alive = true;
    api.clientsLookup(numFicha)
      .then(c => {
        if (!alive) return;
        if (c && c.id) setPopClient(loc ? { ...c, devices: (c.devices || []).concat(loc.devices || []) } : c);
        else if (loc) setPopClient(loc);
      })
      .catch(() => { if (alive && loc) setPopClient(loc); });
    return () => { alive = false; };
  }, [numFicha, apiOn, locales]);
  useEffect(() => { if (!sp.incoming && !sp.inCall) setPopClient(null); }, [sp.incoming, sp.inCall]);

  /* ── Una sola lista de clientes ────────────────────────────────────────────
   * Los del sistema (prestados por la central) y los del aparato, juntos y ordenados por
   * nombre. El origen de cada uno lo dice su id (`loc_…`), no un campo aparte: ver la nota
   * de `esLocal` en config.js. Un cliente local NUNCA se sube solo. */
  const clientesU = (() => {
    const sis = Array.isArray(clsFull) ? clsFull : [];
    return sis.concat(locales).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es'));
  })();
  /* Para Intercom alcanza con los que tienen algo que mirar. */
  const clientesConCam = (() => {
    const sis = Array.isArray(cls) ? cls : [];
    return sis.concat(locales.filter((c) => (c.devices || []).length)).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es'));
  })();
  /* La ficha que se muestra: si el cliente es local ya la tenemos en la mano y no hay nada
   * que pedirle a nadie — esto es lo que hace que la solapa funcione sin central. */
  const fichaLocal = selClient && esLocal(selClient) ? (locales.find((c) => c.id === selClient.id) || selClient) : null;
  const ficha = fichaLocal || clientDet;

  /* Las cámaras del cliente que está del otro lado de esta llamada. Las del sistema son
   * canales de go2rtc ya publicados (`src`); las locales son una URL RTSP guardada acá
   * (`rtsp`). Se muestran las dos, las del sistema primero, porque al que atiende le da
   * igual de dónde salió la cámara: quiere ver la puerta. */
  const camaras = (popClient && Array.isArray(popClient.devices) ? popClient.devices : [])
    .filter(d => d && (d.src || d.rtsp));
  const [principal, setPrincipal] = useState('llamada');
  const [principalManual, setPrincipalManual] = useState(false);
  const remotoVivo = useVideoRemoto(!!sp.inCall, sp.getRemoteStream);
  /* Un solo go2rtc propio para todo lo que puede estar a la vista: las camaras locales del
   * cliente abierto en Intercom y las de la llamada en curso. Si se levantara uno por
   * pantalla, pasar de Intercom a una llamada reiniciaria el proceso y cortaria el video
   * justo en el momento en que se lo quiere mirar. */
  const camsLocalesVivas = (() => {
    const m = new Map();
    for (const d of (Array.isArray(streams) ? streams : [])) if (d && d.rtsp) m.set(d.id, d);
    for (const d of camaras) if (d && d.rtsp) m.set(d.id, d);
    return Array.from(m.values());
  })();
  const g2l = useGo2rtcLocal(camsLocalesVivas);
  useEffect(() => { if (!sp.inCall && !sp.incoming) { setPrincipal('llamada'); setPrincipalManual(false); } }, [sp.inCall, sp.incoming]);
  /* La regla: manda el video de la llamada mientras exista. Si el otro lado no manda imagen
   * —un portero de audio, o el interno con la cámara apagada— la pantalla grande se la
   * queda la primera cámara del cliente en vez de quedar en negro. Si el usuario eligió
   * una a mano, no se le cambia por debajo: su elección gana hasta que corte. */
  useEffect(() => {
    if (principalManual) return;
    if (remotoVivo) { setPrincipal('llamada'); return; }
    if (camaras.length) setPrincipal('cam:' + camaras[0].id);
  }, [principalManual, remotoVivo, camaras.length]); // eslint-disable-line
  useEffect(() => {
    if (!(window.sphone && window.sphone.miniState)) return;
    const ci = sp.callInfo || {};
    const inNum = sp.incoming ? ((sp.incoming.remoteIdentity && sp.incoming.remoteIdentity.uri && sp.incoming.remoteIdentity.uri.user) || '') : '';
    window.sphone.miniState({ active: !!(sp.inCall || sp.incoming), incoming: !!sp.incoming, video: !!sp.incomingVideo, number: sp.incoming ? inNum : (ci.number || ''), name: (popClient && popClient.name) || '', since: ci.since || 0, muted: !!sp.muted, held: !!sp.held, ext: cfg.ext || '', registered: !!(sp.registered || sipReg === 'registered'), volume: typeof sp.volume === 'number' ? sp.volume : 1 });
  }, [sp.inCall, sp.incoming, sp.callInfo, sp.muted, sp.held, popClient, cfg.ext, sp.registered, sipReg, sp.volume]); // eslint-disable-line
  useEffect(() => {
    if (!(window.sphone && window.sphone.onMiniAction)) return;
    return window.sphone.onMiniAction((m) => {
      const s = spRef.current; if (!s) return;
      const a = (m && typeof m === 'object') ? m.a : m, v = (m && typeof m === 'object') ? m.v : undefined;
      if (a === 'mute') s.toggleMute();
      else if (a === 'hold') { if (s.toggleHold) s.toggleHold(); }
      else if (a === 'hangup') s.hangup();
      else if (a === 'accept') s.accept(false);
      else if (a === 'accept-video') s.accept(true);
      else if (a === 'reject') s.reject();
      else if (a === 'volume' && typeof v === 'number') s.setVolume(v);
      else if (a === 'dial') { setTab('llamadas'); setTimeout(() => { try { numRef.current && numRef.current.focus(); } catch {} }, 200); }
      else if (a === 'devices') { setTab('ajustes'); setATab('disp'); }
      /* ── Lo que el widget flotante resuelve sin abrir la ventana grande ──
         Buscar un contacto, marcarlo, y cambiar micrófono o altavoz. El widget no tiene
         sesión con la central ni permiso sobre los dispositivos: los pide acá, que es
         donde ya están, y se los devolvemos por el mismo puente. */
      else if (a === 'buscar') {
        const q = String(v || '').trim();
        const lista = (q && Array.isArray(dirRef.current) ? dirRef.current : []).filter(d => {
          const n = String(d.ext || d.number || d.exten || '');
          const nm = String(d.name || d.cn || d.callerid || '').toLowerCase();
          return (n && n.includes(q)) || (nm && nm.includes(q.toLowerCase()));
        }).slice(0, 4).map(d => ({ n: String(d.ext || d.number || d.exten || ''), nm: String(d.name || d.cn || d.callerid || d.ext || '') }));
        try { window.sphone.miniData({ tipo: 'sug', items: lista }); } catch {}
      }
      else if (a === 'marcar') { const t = String(v || '').trim(); if (t) s.placeCall(t, false); }
      else if (a === 'medios') { mandarMedios(); }
      else if (a === 'set-mic') { pickDev('mic', v); setTimeout(mandarMedios, 60); }
      else if (a === 'set-spk') { pickDev('spk', v); setTimeout(mandarMedios, 60); }
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
      /* Pantalla de «llamada finalizada» por un instante. Cortar y que la vista salte de
       * golpe al marcador deja la duda de si se cortó o se colgó solo; un segundo y medio
       * alcanza para cerrar la acción sin hacer esperar a nadie. */
      if (ci) {
        const dur = answeredAt.current ? Math.max(0, Math.round((Date.now() - answeredAt.current) / 1000)) : 0;
        setFinCall({ number: ci.number, dur });
        setCerrandoLlamada(false);
        finTimers.current.forEach(clearTimeout);
        finTimers.current = [
          setTimeout(() => setCerrandoLlamada(true), 1600),
          setTimeout(() => { setFinCall(null); setCerrandoLlamada(false); }, 1800),
        ];
      }
      setPad(false); setMas(false);
      qAcc.current = []; answeredAt.current = 0; lastCI.current = null; lastRelay.current = null;
    }
    prevInCall.current = sp.inCall;
  }, [sp.inCall]); // eslint-disable-line
  useEffect(() => { if (sp.incoming || sp.inCall) { finTimers.current.forEach(clearTimeout); finTimers.current = []; setCerrandoLlamada(false); } }, [sp.incoming, sp.inCall]);
  useEffect(() => () => finTimers.current.forEach(clearTimeout), []);
  useEffect(() => { if (callStats) { const t = setTimeout(() => setCallStats(null), 9000); return () => clearTimeout(t); } }, [callStats]);
  useEffect(() => { if (!window.sphone || !window.sphone.onUpdate) return; const off = window.sphone.onUpdate(m => setUpd(m)); return off; }, []);
  useEffect(() => { if (upd && (upd.state === 'none' || upd.state === 'error')) { const t = setTimeout(() => setUpd(null), 5000); return () => clearTimeout(t); } }, [upd]);
  useEffect(() => { if (dnd && sp.incoming) { try { sp.reject(); } catch {} } }, [dnd, sp.incoming]); // eslint-disable-line
  useEffect(() => { if (!dnd && autoAnswer && sp.incoming) { const t = setTimeout(() => { try { sp.accept(false); } catch {} }, 1200); return () => clearTimeout(t); } }, [autoAnswer, dnd, sp.incoming]); // eslint-disable-line
  useEffect(() => { sounds.setUiSounds(soundsUi); sounds.setRingSounds(ring); }, [soundsUi, ring]);
  /* El temblor de la ventana avisa una llamada ENTRANTE y nada más. La condición incluye
   * `!ci.since` a propósito: si la llamada ya está establecida —lo normal cuando uno
   * atiende con video, que reinvita— no hay nada que anunciar, y una ventana que vibra
   * con la llamada en curso se siente como si alguien más estuviera llamando. */
  useEffect(() => {
    const anunciar = !!sp.incoming && !(sp.callInfo && sp.callInfo.since) && ring && !dnd;
    if (anunciar) { sounds.startIncomingRing(); try { window.sphone && window.sphone.winShake && window.sphone.winShake(true); } catch {} }
    return () => { sounds.stopIncomingRing(); try { window.sphone && window.sphone.winShake && window.sphone.winShake(false); } catch {} };
  }, [sp.incoming, sp.callInfo, ring, dnd]); // eslint-disable-line
  /* Red de seguridad: con una llamada ya hablando, el temblor y el tono se apagan sí o
   * sí. Es barato y evita la clase de error que sólo aparece en la máquina del cliente. */
  useEffect(() => {
    if (sp.callInfo && sp.callInfo.since) { sounds.stopIncomingRing(); try { window.sphone && window.sphone.winShake && window.sphone.winShake(false); } catch {} }
  }, [sp.callInfo]);
  useEffect(() => {
    const calling = sp.inCall && sp.callInfo && !sp.callInfo.since && !sp.incoming;
    if (calling && ring) sounds.startRingback();
    return () => sounds.stopRingback();
  }, [sp.inCall, sp.callInfo, sp.incoming, ring]); // eslint-disable-line
  useEffect(() => { if (apiOn && dir === null) api.directory().then(d => setDir(Array.isArray(d) ? d : [])).catch(() => setDir([])); }, [tab, apiOn, dir]);
  /* El `.catch(() => set…([]))` de antes hacía que un error del servidor (típicamente
   * un 403 de permisos) se viera como "no hay nada". Ahora el motivo se guarda y se
   * muestra: si la lista está vacía porque el usuario no tiene permiso, que lo diga. */
  useEffect(() => { if ((tab === 'clientes' || tab === 'intercom') && apiOn && cls === null) api.clients().then(d => { setCls(Array.isArray(d) ? d : []); setErrCls(''); }).catch(e => { setCls([]); setErrCls(e.message || 'no se pudo leer la lista'); }); }, [tab, apiOn, cls]);
  useEffect(() => {
    if (!(selClient && tab === 'intercom')) return;
    setErrStreams('');
    if (esLocal(selClient)) { const c = locales.find((x) => x.id === selClient.id); setStreams((c && c.devices) || []); return; }
    setStreams(null);
    api.clientStreams(selClient.id).then(d => setStreams(Array.isArray(d) ? d : [])).catch(e => { setStreams([]); setErrStreams(e.message || 'no se pudieron leer las cámaras'); });
  }, [selClient, tab, locales]);
  useEffect(() => { if (tab === 'clientes' && apiOn && clsFull === null) api.clientsFull().then(d => setClsFull(Array.isArray(d) ? d : [])).catch(() => setClsFull([])); }, [tab, apiOn, clsFull]);
  useEffect(() => { setCliTab('datos'); }, [selClient]);
  useEffect(() => { if (tab === 'clientes' && selClient && !esLocal(selClient)) { setClientDet(null); api.clientDetail(selClient.id).then(d => setClientDet(d || {})).catch(() => setClientDet({})); } }, [selClient, tab]);

  function connectNow() {
    saveConfig(cfg); started.current = true;
    if (cfg.transport === 'sip') { setSipLogs([]); setSipMsg(''); }
    stopEngines();                                        // el motor anterior (nativo o WebRTC) se baja siempre
    setTimeout(() => startEngine(cfgLatest.current), 250);
  }
  const cfgLatest = useRef(cfg); cfgLatest.current = cfg;
  const [iceInfo, setIceInfo] = useState(() => iceEfectivos(cfg));
  /* Traer el ICE de la central ANTES de probar: si no, el probador mide contra lo que
   * quedó guardado en este aparato, que es justo lo que puede estar viejo. */
  async function refrescarYProbar(silencioso) {
    if (!silencioso) setTurnT({ state: 'testing' });
    const r = await refrescarIce(cfgLatest.current);
    setIceInfo(iceEfectivos(cfgLatest.current));
    if (!r.ok) setIceErr(r.error || ''); else setIceErr('');
    return r;
  }
  const [iceErr, setIceErr] = useState('');
  function runTurnTest() {
    setTurnT({ state: 'testing' });
    refrescarYProbar(true)
      .then(() => testIce(cfgLatest.current))
      .then(r => setTurnT(r))
      .catch(e => setTurnT({ state: 'error', errors: [String(e && e.message || e)], host: 0, srflx: 0, relay: 0 }));
  }
  /* El test de TURN NO se dispara solo al entrar a la pestania. Levanta un
   * RTCPeerConnection y se queda esperando candidatos: con la central lejos eso son unos
   * segundos de ruedita cada vez que alguien pasa por Ajustes a mirar otra cosa. Lo
   * dispara el boton, que es cuando alguien de verdad quiere saber. */
  /* Al registrarse: es el momento en que se sabe cuál es la central y que está viva. Se
   * refresca el ICE aunque no haya nada cargado a mano —antes esto sólo corría si había
   * un TURN guardado, o sea nunca en el aparato que más lo necesita—.
   *
   * Se TRAEN los servidores, pero no se prueban: traerlos es lo que hace falta para que la
   * proxima llamada tenga relay, y probar es una pregunta que se hace cuando alguien la
   * quiere hacer. Antes esto dejaba un RTCPeerConnection levantandose en cada arranque. */
  useEffect(() => { if (authed) setTimeout(() => { refrescarYProbar(true).catch(() => {}); }, 1200); }, [authed]); // eslint-disable-line
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
  /* La central aprovisionada publica el instalador y el feed OTA del softphone en
   * /descargas/softphone/. Se lo pasamos al proceso main (electron-updater). */
  function setUpdateFeed(base) {
    try {
      /* De donde sale la central: primero el sistema aprovisionado (CRM/API), y si no hay,
       * del propio WSS con el que el telefono se registra. Antes solo miraba el primero, y
       * un telefono aprovisionado sin API se quedaba con el respaldo de GitHub —que tiene
       * la version vieja—: el boton «Buscar» decia «estas al dia» aunque la central ya
       * tuviera una nueva. */
      const b = String(base || api.getApiBase() || api.baseFromWss(cfgLatest.current && cfgLatest.current.wss) || '').replace(/\/$/, '');
      if (b && window.sphone && window.sphone.updateSetFeed) window.sphone.updateSetFeed(b + '/descargas/softphone/');
    } catch {}
  }
  useEffect(() => { setUpdateFeed(); }, []);
  function applyProv(prov) {
    if (prov.apiBase) { api.applySession({ base: prov.apiBase, token: prov.apiToken }); if (prov.apiToken) { setApiOn(true); setDir(null); setCls(null); setClsFull(null); } setUpdateFeed(prov.apiBase); }
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
  dirRef.current = dir; devsRef.current = devs; prefsRef.current = prefs;
  const dialMatches = (num && Array.isArray(dir)) ? dir.filter(d => { const n = String(d.ext || d.number || d.exten || ''); const nm = String(d.name || d.cn || d.callerid || '').toLowerCase(); return (n && n.includes(num)) || (nm && nm.includes(num.toLowerCase())); }).slice(0, 6) : [];
  const presColor = (ext) => { const st = String(pres[String(ext)] || '').toLowerCase(); if (!st) return null; if (st.includes('inuse') && !st.includes('not')) return '#f0b429'; if (st === 'busy' || st === 'ringing' || st === 'ring' || st === 'onhold' || st === 'in_call') return '#f0b429'; if (st === 'not_inuse' || st === 'online' || st === 'available' || st === 'idle') return C.green; return '#c2c9d6'; };
  function press(k) { sounds.uiKey(); sp.sendDtmf(k); if (!sp.inCall) setNum(n => (n + k).slice(0, 30)); }
  function callNow(n, video) { sounds.uiClick(); const t = (n || num).trim(); if (t) { setTab('llamadas'); setModal(null); sp.placeCall(t, !!video).then(() => setNum('')); } }
  /* La foto de los dispositivos tal como la ve el widget: nombre corto y cuál está
   * elegido. El nombre largo de Windows («Micrófono (2- DM30 RGB USB Microphone)
   * (352f:0106)») no entra en una ventanita de 300 px, así que se recorta acá. */
  async function mandarMedios() {
    const corto = (l) => String(l || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').slice(0, 42);
    /* Se vuelve a leer la lista ACÁ, no se usa la que había: entre que se abrió el
     * softphone y que alguien abre el panel del widget puede haberse enchufado un
     * headset, y una lista vieja es peor que ninguna. */
    let d = devsRef.current || {};
    try { d = await listDevices(); setDevs(d); } catch {}
    try {
      window.sphone.miniData({
        tipo: 'medios',
        mics: (d.mics || []).map(x => ({ id: x.deviceId, l: corto(x.label || 'Micrófono') })),
        spks: (d.speakers || []).map(x => ({ id: x.deviceId, l: corto(x.label || 'Altavoz') })),
        mic: (prefsRef.current || {}).mic || '', spk: (prefsRef.current || {}).spk || '',
        permiso: d.permiso !== false,
      });
    } catch {}
  }
  function pickDev(kind, id) { setDevPref(kind, id); setPrefs(getDevPrefs()); if (kind === 'spk') sp.applySpeaker(id); }
  async function toggleRecord() { const next = !recording; try { const r = await api.recordCall(cfg.ext, next ? 'start' : 'stop'); if (!r || !r.error) setRecording(next); } catch {} }
  async function doSpy(mode) { if (!spyTarget) return; setSpyMsg('Originando…'); try { const r = await api.spyCall(cfg.ext, spyTarget.ext, mode); if (r && r.error) setSpyMsg('Error: ' + r.error); else { setSpyMsg('✓ Atendé la llamada entrante para escuchar.'); setTimeout(() => { setSpyTarget(null); setSpyMsg(''); }, 1800); } } catch (e) { setSpyMsg('Error: ' + e.message); } }
  useEffect(() => { if (!sp.inCall) setRecording(false); }, [sp.inCall]);
  function onPhoto(e) { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { localStorage.setItem('sp_photo', r.result); } catch {} setPhoto(r.result); }; r.readAsDataURL(f); }
  function clearPhoto() { try { localStorage.removeItem('sp_photo'); } catch {} setPhoto(''); }
  /* Conectar con el sistema de la central (contactos, clientes, porteros, grabaciones).
   * El try/catch no es decorativo: sin él, cualquier respuesta que no fuera 200 —una
   * contraseña mal escrita, sin ir más lejos— escapaba de esta función y la pantalla se
   * quedaba en «Conectando…» para siempre, sin un solo mensaje. */
  async function doApiLogin() {
    setApiMsg('Conectando…');
    const base = String(apiForm.base || api.baseFromWss(cfg.wss) || '').trim();
    try {
      const r = await api.apiLogin(base, String(apiForm.user || '').trim(), apiForm.pass);
      if (r.ok) {
        setApiOn(true); setApiMsg('Conectado al sistema ✓'); setDir(null); setCls(null);
        /* Ya que sabemos cuál es la central, que el buscador de actualizaciones apunte ahí. */
        setUpdateFeed(base);
      } else {
        setApiOn(false);
        /* Distinguir «no llego a la central» de «la central me rechazó» importa: son dos
         * problemas de dos personas distintas. Para saberlo se pide /ice, que es pública y
         * no necesita sesión: si eso contesta, la red está bien y el problema es el usuario
         * o la contraseña; si no contesta, el teléfono no está llegando a la central
         * (DNS, el nombre público que no vuelve desde adentro de la LAN, un firewall). */
        let msg = r.error;
        if (!/incorrect|permiso|intentos/i.test(msg)) {
          try { await api.iceDeLaCentral(base); msg = r.error + ' (la central responde, así que es el usuario o la contraseña)'; }
          catch { msg = 'no se llega a la central desde esta red: ' + r.error; }
        }
        setApiMsg('No se pudo conectar: ' + msg);
      }
    } catch (e) {
      setApiOn(false); setApiMsg('No se pudo conectar: ' + ((e && e.message) || 'error inesperado'));
    }
  }
  /* ── Alta de cliente y de camara ───────────────────────────────────────────
   * El destino se elige una vez y se elige EXPLICITAMENTE. No hay sincronizacion
   * automatica entre el aparato y la central, y eso es a proposito: una URL RTSP trae
   * usuario y contrasena de la camara adentro, y subirla sin que nadie lo pida la hace
   * visible a todos los que atienden en esa central. */
  const [altaMsg, setAltaMsg] = useState('');
  /* Que una URL sirva no se puede saber sin probarla, pero que NO sirva si: es lo unico
   * que se chequea acá, para no rechazar camaras raras que igual andan. */
  function urlCamaraMal(u) {
    const v = String(u || '').trim();
    if (!v) return 'Falta la URL de la cámara.';
    if (!/^(rtsp|rtsps|http|https):\/\/[^\s/]+/i.test(v)) return 'Tiene que empezar con rtsp:// (o http:// si la cámara da MJPEG).';
    return '';
  }
  async function altaGuardar(datos) {
    setAltaMsg('');
    if (alta && alta.tipo === 'cliente') {
      const name = String(datos.name || '').trim();
      if (!name) { setAltaMsg('Falta el nombre.'); return; }
      const phones = String(datos.phones || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      if (datos.destino === 'central' && apiOn) {
        try { const c = await api.clientCreate({ name, phones }); setClsFull(null); setSelClient(c); setAlta(null); return; }
        catch (e) { setAltaMsg('La central no lo aceptó: ' + (e.message || 'error') + '. Podés guardarlo en este teléfono.'); return; }
      }
      const c = upsertLocal({ id: nuevoIdLocal(), name, phones, devices: [] });
      setSelClient(c); setAlta(null); return;
    }
    /* Camara */
    const cli = alta && alta.cliente; if (!cli) return;
    const label = String(datos.label || '').trim() || 'Cámara';
    const mal = urlCamaraMal(datos.rtsp); if (mal) { setAltaMsg(mal); return; }
    const rtsp = String(datos.rtsp).trim();
    const tipo = datos.type === 'intercom' ? 'intercom' : 'camera';
    /* Un cliente local no tiene a quién colgarle la cámara en la central: va local y punto. */
    if (datos.destino === 'central' && apiOn && !esLocal(cli)) {
      try {
        await api.clientDeviceAdd(cli.id, { label, type: tipo, rtsp_url: rtsp });
        setClientDet(null); setStreams(null); setClsFull(null);
        if (selClient && selClient.id === cli.id) setSelClient({ ...cli });
        setAlta(null); return;
      } catch (e) { setAltaMsg('La central no la aceptó: ' + (e.message || 'error') + '. Podés guardarla en este teléfono.'); return; }
    }
    const base = esLocal(cli) ? (locales.find((x) => x.id === cli.id) || cli)
      : { id: cli.id, name: cli.name, phones: cli.phones || [], devices: [] };
    /* Una cámara local sobre un cliente DEL SISTEMA necesita una copia local de ese cliente
     * para colgarla; se le deja el mismo nombre y teléfonos, y la ficha de la llamada junta
     * las cámaras de los dos (ver el efecto del lookup). */
    const dev = { id: nuevoIdLocal(), label, type: tipo, rtsp };
    upsertLocal({ ...base, id: esLocal(cli) ? base.id : nuevoIdLocal(), devices: (base.devices || []).concat([dev]) });
    setAlta(null);
  }
  /* Subir a la central una cámara que estaba sólo en el aparato. */
  async function subirCamara(cli, dev) {
    if (!apiOn || esLocal(cli) || !dev || !dev.rtsp) return;
    try {
      await api.clientDeviceAdd(cli.id, { label: dev.label, type: dev.type, rtsp_url: dev.rtsp });
      /* Recién cuando la central la aceptó se saca de acá: al revés, un error de red la
       * perdía de los dos lados. */
      const l = locales.map((c) => ({ ...c, devices: (c.devices || []).filter((x) => x.id !== dev.id) }));
      guardarLocales(l.filter((c) => (c.devices || []).length || (c.phones || []).length));
      setStreams(null); setClientDet(null); setClsFull(null); setSelClient({ ...cli });
    } catch (e) { setAltaMsg('No se pudo subir: ' + (e.message || 'error')); }
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
  const nav = [['llamadas', IcGrid, 'Llamadas'], ['contactos', IcUser, 'Contactos'], ...(apiOn ? [['voz', IcVoicemail, 'Voz']] : []), ['clientes', IcUsers, 'Clientes'], ...(showIntercom ? [['intercom', IcCam, 'Intercom']] : []), ['ajustes', IcGear, 'Ajustes']];

  return (
    <div style={S.root}>
      {media}
      {splash && (
        <div ref={splashRef} style={{ position: 'fixed', inset: 0, zIndex: 400, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'radial-gradient(120% 120% at 50% 0%,#16233f 0%,#0b1220 60%,#070c16 100%)', color: '#eaf1ff', opacity: splashOut ? 0 : 1, transition: 'opacity .45s ease', pointerEvents: splashOut ? 'none' : 'auto' }}>
          <div style={{ position: 'relative', width: 104, height: 104, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="sp-ring" /><span className="sp-ring" style={{ animationDelay: '.6s' }} /><span className="sp-ring" style={{ animationDelay: '1.2s' }} />
            <div className="sp-badge" style={{ width: 76, height: 76, borderRadius: 22, background: 'linear-gradient(160deg,#2bd95a,#1fa945)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px rgba(43,217,90,.45)' }}>
              <svg className="sp-handset" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 4.2 2 2 0 0 1 5.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L9.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z" /></svg>
            </div>
          </div>
          <div className="sp-title" style={{ fontSize: 22, fontWeight: 700, letterSpacing: .3, marginTop: 4 }}>PBX-NG <b style={{ color: '#4ade80' }}>Softphone</b></div>
          <div className="sp-ver" style={{ fontSize: 13, color: '#8fa6cc', marginTop: -8 }}>{APP_VERSION}</div>
          <div style={{ width: 190, height: 4, borderRadius: 4, background: 'rgba(255,255,255,.12)', overflow: 'hidden', marginTop: 6 }}><i className="sp-bar" style={{ display: 'block', height: '100%', width: '40%', borderRadius: 4, background: 'linear-gradient(90deg,#2bd95a,#4c9dff)' }} /></div>
          <div style={{ position: 'absolute', bottom: 22, fontSize: 11, color: '#5c7099', letterSpacing: .4 }}>Infratec · WebRTC / SIP</div>
        </div>
      )}
      {!authed && !splash && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', flexDirection: 'column', background: 'radial-gradient(120% 120% at 50% 0%,#16233f 0%,#0b1220 60%,#070c16 100%)', color: '#eaf1ff' }}>
          {/* El fondo del login: una grilla de puntos que se deforma sola y se abre donde
              pasa el puntero. Reemplaza las ondas y los telefonos flotando —que eran
              tres SVG animados por CSS— por un unico shader que se dibuja a la
              resolucion real de la pantalla; es el MISMO fondo que el login del panel,
              para que las dos puertas de entrada al producto sean la misma puerta. */}
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }} aria-hidden>
            <ShaderPuntos fondo="transparent" colorA="#16305e" colorB="#9fb6ff" fuerza={1.7} />
          </div>
          <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', padding: '14px 20px', WebkitAppRegion: 'drag' }}>
            <div />
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, WebkitAppRegion: 'no-drag' }}>
              {accts.length > 0 && <button onClick={() => setShowAccts(true)} title="Cuentas guardadas" style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.16)', borderRadius: 9, padding: '7px 9px', cursor: 'pointer', color: '#cfe0ff', display: 'flex' }}>{IcUsers({ c: '#cfe0ff', s: 18 })}</button>}
              <WinCtl dark />
            </div>
          </div>
          <div style={{ position: 'relative', zIndex: 1, flex: 1, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 20px 20px' }}>
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
                <button onClick={loginConnect} disabled={!isComplete(cfg)} style={{ width: '100%', marginTop: 8, padding: '13px 0', borderRadius: 11, border: 'none', background: isComplete(cfg) ? 'linear-gradient(90deg,#2bd95a,#1fa945)' : 'rgba(255,255,255,.1)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: isComplete(cfg) ? 'pointer' : 'not-allowed', opacity: isComplete(cfg) ? 1 : .6 }}>Conectar y verificar</button>
                <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12, color: '#5c7099' }}>{APP_VERSION} · datos cifrados en este equipo</div>
              </div>
            )}
            {loginPhase === 'verify' && (() => { const cur = diag.step; const rows = DIAG_STEPS.slice(0, 5); return (
              <div key="verify" ref={gEnter} style={{ width: '100%', maxWidth: 360, textAlign: 'center' }}>
                <div style={{ position: 'relative', width: 88, height: 88, margin: '0 auto 18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {!diag.error && <><span className="sp-ring" /><span className="sp-ring" style={{ animationDelay: '.6s' }} /></>}
                  <div style={{ width: 64, height: 64, borderRadius: 18, background: diag.error ? 'linear-gradient(160deg,#eb4c46,#b91c1c)' : 'linear-gradient(160deg,#2bd95a,#1fa945)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{IcPhone({ c: '#fff', s: 30 })}</div>
                </div>
                <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>{diag.error ? 'No se pudo conectar' : 'Verificando conexión…'}</div>
                <div style={{ fontSize: 13, color: '#8fa6cc', marginBottom: 18 }}>{diag.error ? 'Revisá los datos e intentá de nuevo.' : 'Comprobando el registro con la central PBX-NG.'}</div>
                <div style={{ textAlign: 'left', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 14, padding: '14px 16px' }}>
                  {rows.map((lb, i) => { const n = i + 1; const state = cur > n ? 'done' : cur === n ? (diag.error ? 'error' : 'active') : 'pending'; return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
                      <span style={{ width: 23, height: 23, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', background: state === 'done' ? 'rgba(43,217,90,.2)' : state === 'error' ? 'rgba(239,68,68,.2)' : 'rgba(255,255,255,.08)' }}>
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
                <div ref={gPop} style={{ width: 92, height: 92, borderRadius: '50%', margin: '0 auto 16px', background: 'linear-gradient(160deg,#2bd95a,#1fa945)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 12px 34px rgba(43,217,90,.5)' }}><span style={{ color: '#fff', fontSize: 46, fontWeight: 800 }}>✓</span></div>
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
              {/* Las dos secciones de arriba. El teclado va ABAJO de todo, como en el
                  telefono que ya usa el cliente: lo que uno mira al abrir la aplicacion es
                  la lista, y marcar es lo que hace despues. */}
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 6 }}>
                {[['recientes', IcPhone, 'Llamadas recientes', C.accent],
                  ...(apiOn ? [['voz', IcVoicemail, 'Mensajes de voz', '#a78bfa']] : [])].map(([id, Ic, lbl, col]) => {
                  const on = (id === 'voz' ? tab === 'voz' : tab === 'llamadas');
                  return (
                    <button key={id} onClick={() => { sounds.uiClick(); withVT(() => setTab(id === 'voz' ? 'voz' : 'llamadas')); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, border: 'none', cursor: 'pointer', textAlign: 'left',
                        background: on ? 'rgba(26,115,242,.16)' : 'transparent', color: on ? '#dbe7ff' : C.ink, fontSize: 13.5, fontWeight: on ? 600 : 500 }}>
                      <span style={{ width: 28, height: 28, borderRadius: '50%', background: col, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{Ic({ c: '#fff', s: 15 })}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>{lbl}</span>
                      {id === 'voz' && vmUnread > 0 ? <span style={{ background: C.red, color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 9, padding: '1px 6px' }}>{vmUnread}</span> : null}
                    </button>
                  );
                })}
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ height: 1, background: C.line, width: '100%', margin: '0 0 12px' }} />
              <input ref={numRef} autoFocus style={S.numIn} value={num} onChange={e => setNum(e.target.value.replace(/[^\w*#+.@\s-]/g, ''))} placeholder="Ingresá nombre o número" onKeyDown={e => { if (e.key === 'Enter') { if (dialMatches[0]) callNow(String(dialMatches[0].ext || dialMatches[0].number || dialMatches[0].exten || num)); else callNow(); } }} />

              {(dialMatches.length > 0 && !sp.inCall) ? (
                <div ref={gStagger} style={{ width: '100%', maxHeight: 236, overflowY: 'auto', margin: '2px 0 14px' }}>
                  {dialMatches.map((d, i) => { const n = String(d.ext || d.number || d.exten || ''); const nm = d.name || d.cn || d.callerid || n; const pc = presColor(n); return (
                    <div key={i} className="dd-row" onClick={() => { setNum(n); try { numRef.current && numRef.current.focus(); } catch {} }} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', cursor: 'pointer', borderRadius: 10, border: `1px solid ${C.line}`, background: C.card, marginBottom: 6 }}>
                      <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}><Ava txt={initials(String(nm))} size={34} bg="linear-gradient(160deg,#7c9be0,#4f6fc9)" />{pc ? <span style={{ position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: '50%', background: pc, border: `2px solid ${C.card}` }} /> : null}</span>
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}><div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nm}</div><div style={{ fontSize: 12, color: C.sub }}>{n}</div></div>
                      <button style={S.actBtn(C.accent)} title="Video" onClick={e => { e.stopPropagation(); callNow(n, true); }}>{IcVideo({ c: C.accent, s: 15 })}</button>
                      <button style={S.actBtn(C.green)} title="Llamar" onClick={e => { e.stopPropagation(); callNow(n); }}>{IcPhone({ c: C.green, s: 15 })}</button>
                    </div>); })}
                </div>
              ) : (
                <div style={S.keypad}>{[['1',''],['2','ABC'],['3','DEF'],['4','GHI'],['5','JKL'],['6','MNO'],['7','PQRS'],['8','TUV'],['9','WXYZ'],['*',''],['0','+'],['#','']].map(([k, sub]) => <button key={k} className="ph-key" style={S.key} onClick={() => press(k)}><span style={{ fontSize: 20, fontWeight: 500, lineHeight: 1 }}>{k}</span><span style={{ fontSize: 8.5, letterSpacing: 1.2, color: C.sub, height: 9 }}>{sub}</span></button>)}</div>
              )}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center', width: '100%' }}>
                <button title="Videollamada" style={{ ...S.cbtn(C.accent), opacity: registered && num ? 1 : .4 }} disabled={!registered || !num} onClick={() => callNow(null, true)}>{IcVideo({ c: '#fff', s: 19 })}</button>
                <button title="Llamar" style={{ ...S.cbtn(C.green), opacity: registered ? 1 : .4 }} disabled={!registered} onClick={() => callNow()}>{IcPhone({ c: '#fff', s: 19 })}</button>
                {/* El borrar aparece solo cuando hay algo escrito: si esta siempre, compite
                    con los dos botones que importan. */}
                {num ? <button title="Borrar" style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.07)', cursor: 'pointer', color: C.sub, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setNum(n => n.slice(0, -1))}>{IcBack({ c: C.sub, s: 18 })}</button> : null}
              </div>
            </div>
            <div style={S.listCol}>
              <div style={S.listHdr}>Recientes{(apiOn && Array.isArray(scdr)) ? <span style={{ fontSize: 11, color: C.sub, fontWeight: 400, marginLeft: 8 }}>· servidor</span> : (sp.hist.length > 0 ? <button onClick={sp.clearHist} style={{ background: 'none', border: 'none', color: C.accent, fontSize: 13, cursor: 'pointer' }}>Borrar</button> : null)}</div>
              <div style={S.scroll}>
                {rec.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: '40px 0' }}>Sin llamadas</div> :
                  rec.map((h, i) => (
                    <div key={i} className="ph-row" style={S.row} onClick={() => openCall(h)}>
                      <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
                        <Ava txt={initials(h.name || h.number)} size={38} />
                        {presColor(h.number) ? <span style={{ position: 'absolute', right: -1, bottom: -1, width: 11, height: 11, borderRadius: '50%', background: presColor(h.number), border: '2px solid ' + C.bg }} title="estado en vivo" /> : null}
                      </span>
                      <div style={{ minWidth: 0, width: 150 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5, color: h.missed ? C.red : C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name || h.number}</div>
                        <div style={{ fontSize: 12, color: C.sub }}>{h.number}</div>
                      </div>
                      {/* En el medio, que paso con la llamada: el sentido (y si se perdio) mas
                          la duracion. «No establecido» es una llamada que nadie atendio. */}
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, color: h.missed ? C.red : C.sub, fontSize: 12.5 }}>
                        <span style={{ flex: 'none', opacity: .85 }}>{h.dir === 'out' ? '↗' : '↙'}</span>
                        <span style={{ whiteSpace: 'nowrap' }}>{h.dur ? fmtDur(h.dur) : 'No establecido'}</span>
                        {h.video ? <span title="con video" style={{ opacity: .7 }}>▣</span> : null}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={e => e.stopPropagation()}>
                        <span style={{ fontSize: 12, color: C.sub, marginRight: 2 }}>{fmtDate(h.t)}</span>
                        <button className="ph-acc" style={S.actBtn('#9fb6d8')} title="Videollamada" onClick={() => callNow(h.number, true)}>{IcVideo({ c: '#9fb6d8', s: 15 })}</button>
                        <button className="ph-acc" style={S.actBtn(C.green)} title="Llamar" onClick={() => callNow(h.number)}>{IcPhone({ c: C.green, s: 15 })}</button>
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
                        <button onClick={() => vmPlay(id, folder)} style={{ ...S.chip('rgba(26,115,242,.1)', '#7cb0ff'), border: 'none', cursor: 'pointer', alignSelf: 'flex-start', padding: '6px 12px' }}>▶ Escuchar</button>}
                      {apiOn && (vmTx[id] ? (
                        vmTx[id].loading ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.sub }}><span className="spin" style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #cbd5e1', borderTopColor: C.accent, display: 'block' }} /> Transcribiendo…</div> :
                        vmTx[id].error ? <div style={{ fontSize: 12, color: C.red }}>✕ {vmTx[id].error}</div> :
                        <div style={{ background: C.soft, border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 12px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: C.sub, marginBottom: 4 }}>{IcVoicemail({ c: C.accent, s: 13 })} TRANSCRIPCIÓN{vmTx[id].analysis && vmTx[id].analysis.summary ? '' : ''}</div><div style={{ fontSize: 13, color: C.ink, lineHeight: 1.45 }}>{vmTx[id].text}</div></div>
                      ) : <button onClick={() => transcribeVm(id, folder)} style={{ ...S.chip('rgba(139,92,246,.1)', '#b794f6'), border: 'none', cursor: 'pointer', alignSelf: 'flex-start', padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>{IcVoicemail({ c: '#b794f6', s: 14 })} Transcribir</button>)}
                    </div>); })}
              </div>
            </div>
          )}

          {tab === 'contactos' && (
            <div style={S.listCol}>
              <div style={S.listHdr}>Contactos {dir ? <span style={{ fontSize: 12, color: C.sub, fontWeight: 400 }}>{dir.length} internos</span> : null}</div>
              {apiOn && dir && dir.length > 0 && <div style={{ padding: '0 14px 10px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${C.line}`, borderRadius: 10, padding: '0 12px', background: C.card }}>{IcSearch({ c: C.sub, s: 16 })}<input value={contactQ} onChange={e => setContactQ(e.target.value)} placeholder="Buscar por nombre o interno…" style={{ flex: 1, border: 'none', outline: 'none', background: 'none', fontSize: 14, padding: '9px 0' }} />{contactQ && <button onClick={() => setContactQ('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.sub, fontSize: 17 }}>×</button>}</div></div>}
              {apiOn && favs.length > 0 && (
                <div style={{ padding: '0 14px 10px' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: C.sub, letterSpacing: .5, marginBottom: 7 }}>FAVORITOS</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {favs.map(fx => { const fc = presColor(fx); const fn = favName(fx); return (
                      <button key={fx} onClick={() => callNow(fx)} title={'Llamar a ' + fn} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: 56, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        <span style={{ position: 'relative', display: 'inline-flex' }}><Ava txt={initials(String(fn))} size={46} bg="linear-gradient(160deg,#7c9be0,#4f6fc9)" /><span style={{ position: 'absolute', right: 1, bottom: 1, width: 12, height: 12, borderRadius: '50%', background: fc || '#c2c9d6', border: `2px solid ${C.card}` }} /></span>
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
                      <span style={{ marginLeft: 'auto', ...S.chip(d.status === 'online' ? 'rgba(43,217,90,.14)' : d.status === 'in_call' ? 'rgba(245,158,11,.15)' : C.soft, d.status === 'online' ? '#4ade80' : d.status === 'in_call' ? '#f0b429' : C.sub) }}>{d.status === 'online' ? 'en línea' : d.status === 'in_call' ? 'en llamada' : 'offline'}</span>
                      <div style={{ display: 'flex', gap: 6, marginLeft: 8 }} onClick={e => e.stopPropagation()}>
                        <button title="Favorito" onClick={() => toggleFav(d.ext)} style={{ ...S.actBtn(favs.includes(String(d.ext)) ? '#f0b429' : C.sub), fontSize: 15, lineHeight: 1, fontWeight: 700 }}>{favs.includes(String(d.ext)) ? '\u2605' : '\u2606'}</button>
                        <button title="Supervisar" style={S.actBtn('#a78bfa')} onClick={() => { setSpyMsg(''); setSpyTarget(d); }}>{IcHead({ c: '#a78bfa', s: 16 })}</button>
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
                <div style={S.listHdr}>Clientes <span style={{ fontSize: 12, color: C.sub, fontWeight: 400 }}>{clientesU.length || ''}</span>
                  <button onClick={() => setAlta({ tipo: 'cliente' })} title="Agregar cliente"
                    style={{ marginLeft: 'auto', border: `1px solid ${C.line}`, background: 'none', borderRadius: 8, padding: '4px 9px', cursor: 'pointer', color: C.sub, fontSize: 18, lineHeight: 1 }}>+</button>
                </div>
                {clientesU.length > 0 && <div style={{ padding: '0 14px 10px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${C.line}`, borderRadius: 10, padding: '0 12px', background: C.card }}>{IcSearch({ c: C.sub, s: 16 })}<input value={clientQ} onChange={e => setClientQ(e.target.value)} placeholder="Buscar cliente…" style={{ flex: 1, border: 'none', outline: 'none', background: 'none', fontSize: 14, padding: '9px 0' }} />{clientQ && <button onClick={() => setClientQ('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.sub, fontSize: 17 }}>×</button>}</div></div>}
                <div style={S.scroll}>
                  {apiOn && clsFull === null && !clientesU.length ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Cargando…</div> :
                    clientesU.length === 0 ? <SinClientes apiOn={apiOn} onAlta={() => setAlta({ tipo: 'cliente' })} onSistema={() => setTab('ajustes')} /> :
                    (() => { const f = clientesU.filter(c => !clientQ || ((c.name || '') + ' ' + (c.doc || '')).toLowerCase().includes(clientQ.toLowerCase())); return f.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin resultados</div> : f.map((c) => (
                      <div key={c.id} className="ph-row" style={{ ...S.row, background: selClient && selClient.id === c.id ? C.sel : 'transparent' }} onClick={() => setSelClient(c)}>
                        <Ava txt={initials(c.name)} size={38} bg={esLocal(c) ? 'linear-gradient(160deg,#0ea5e9,#0369a1)' : 'linear-gradient(160deg,#8b5cf6,#6d28d9)'} />
                        <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{c.name}</div><div style={{ fontSize: 12, color: C.sub }}>{esLocal(c) ? 'de este teléfono' : (c.doc || 'del sistema')}</div></div>
                      </div>)); })()}
                </div>
              </div>
              <div style={{ ...S.listCol, overflowY: 'auto' }}>
                {!selClient ? <div style={{ color: C.sub, textAlign: 'center', padding: 50 }}>Elegí un cliente para ver su ficha.</div> :
                  ficha === null ? <div style={{ color: C.sub, textAlign: 'center', padding: 40 }}>Cargando ficha…</div> :
                  <div style={{ padding: '18px 22px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                      <Ava txt={initials(ficha.name)} size={56} bg="linear-gradient(160deg,#8b5cf6,#6d28d9)" />
                      <div style={{ minWidth: 0 }}><div style={{ fontSize: 20, fontWeight: 700 }}>{ficha.name}</div><div style={{ fontSize: 13, color: C.sub, display: 'flex', gap: 10, flexWrap: 'wrap' }}>{ficha.doc ? <span>Doc: {ficha.doc}</span> : null}<span>{(ficha.persons || []).length} personas</span><span>{(ficha.spaces || []).length} espacios</span><span>{(ficha.devices || []).length} disp.</span></div></div>
                    </div>
                    <div style={{ display: 'flex', gap: 2, marginBottom: 14, borderBottom: `1px solid ${C.line}` }}>
                      {[['datos', 'Datos', IcUser, null], ['personas', 'Personas', IcUsers, (ficha.persons || []).length], ['espacios', 'Espacios', IcGrid, (ficha.spaces || []).length], ['disp', 'Dispositivos', IcCam, (ficha.devices || []).length]].map(([id, lbl, Ic, n]) => { const on = cliTab === id; return (
                        <button key={id} onClick={() => setCliTab(id)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', border: 'none', borderBottom: `2px solid ${on ? '#a78bfa' : 'transparent'}`, background: 'none', color: on ? '#b794f6' : C.sub, cursor: 'pointer', fontWeight: on ? 700 : 600, fontSize: 13, marginBottom: -1 }}>{Ic({ c: on ? '#b794f6' : C.sub, s: 15 })}{lbl}{n ? <span style={{ fontSize: 11, background: on ? 'rgba(139,92,246,.15)' : C.soft, color: on ? '#b794f6' : C.sub, borderRadius: 8, padding: '0 6px' }}>{n}</span> : null}</button>); })}
                    </div>
                    <div key={cliTab} ref={gEnter}>
                    {cliTab === 'datos' && (<>
                      {(ficha.address || ficha.notes) ? <div style={S.card}>{ficha.address && <div style={{ padding: '9px 0', display: 'flex', gap: 10 }}>{IcGrid({ c: C.sub, s: 16 })}<div><div style={S.fieldLbl}>Dirección</div>{ficha.address}</div></div>}{ficha.notes && <div style={{ padding: '9px 0', borderTop: ficha.address ? `1px solid ${C.line}` : 'none' }}><div style={S.fieldLbl}>Notas</div>{ficha.notes}</div>}</div> : null}
                      {Array.isArray(ficha.phones) && ficha.phones.length > 0 ? <><div style={S.section}>TELÉFONOS</div><div style={S.card}>{ficha.phones.map((ph, i) => <div key={i} className="ph-row" style={S.row} onClick={() => callNow(String(ph))}>{IcPhone({ c: C.sub, s: 16 })}<div style={{ flex: 1 }}>{ph}</div><button style={S.actBtn(C.green)} onClick={e => { e.stopPropagation(); callNow(String(ph)); }}>{IcPhone({ c: C.green, s: 16 })}</button></div>)}</div></> : null}
                      {!ficha.address && !ficha.notes && !(ficha.phones || []).length && <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin datos generales.</div>}
                    </>)}
                    {cliTab === 'personas' && (Array.isArray(ficha.persons) && ficha.persons.length > 0 ? <div style={S.card}>{ficha.persons.map((pr, i) => <div key={i} className="ph-row" style={S.row}><Ava txt={initials(pr.name)} size={34} bg="#4f6fc9" /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{pr.name}</div>{(pr.phone || pr.role) && <div style={{ fontSize: 12, color: C.sub }}>{[pr.role, pr.phone].filter(Boolean).join(' · ')}</div>}</div>{pr.phone && <button style={S.actBtn(C.green)} onClick={() => callNow(String(pr.phone))}>{IcPhone({ c: C.green, s: 16 })}</button>}</div>)}</div> : <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin personas autorizadas.</div>)}
                    {cliTab === 'espacios' && (Array.isArray(ficha.spaces) && ficha.spaces.length > 0 ? <div style={S.card}>{ficha.spaces.map((sx, i) => <div key={i} className="ph-row" style={S.row}>{IcGrid({ c: C.sub, s: 16 })}<div style={{ flex: 1 }}><b>{sx.name}</b>{sx.notes ? <div style={{ fontSize: 12, color: C.sub }}>{sx.notes}</div> : null}</div></div>)}</div> : <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin espacios.</div>)}
                    {cliTab === 'disp' && (<>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
                        <button onClick={() => setAlta({ tipo: 'camara', cliente: ficha })} style={{ ...S.chip('rgba(14,165,233,.12)', '#67c7f5'), border: 'none', cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center' }}>{IcCam({ c: '#67c7f5', s: 14 })} Agregar cámara</button>
                      </div>
                      {Array.isArray(ficha.devices) && ficha.devices.length > 0 ? <div style={S.card}>{ficha.devices.map((d, i) => <div key={d.id || i} className="ph-row" style={S.row}>{IcCam({ c: C.sub, s: 18 })}<div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{d.label}</div><div style={{ fontSize: 12, color: C.sub }}>{(d.type || 'dispositivo') + ' · ' + (esLocal(d) ? 'de este teléfono' : 'del sistema')}</div></div>
                        {esLocal(d) && <button title="Quitar de este teléfono" onClick={() => { const c = { ...ficha, devices: (ficha.devices || []).filter((x) => x.id !== d.id) }; upsertLocal(c); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.sub, fontSize: 17, padding: '0 6px' }}>×</button>}
                        <button onClick={() => { setSelClient(ficha); setTab('intercom'); }} style={{ ...S.chip('rgba(26,115,242,.12)', '#7cb0ff'), border: 'none', cursor: 'pointer' }}>Ver en vivo</button></div>)}</div>
                        : <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin dispositivos.</div>}
                    </>)}
                    </div>
                  </div>}
              </div>
            </>
          )}

          {tab === 'intercom' && (
            <>
              <div style={{ width: 300, borderRight: `1px solid ${C.line}`, background: C.card, display: 'flex', flexDirection: 'column' }}>
                <div style={S.listHdr}>{tab === 'clientes' ? 'Clientes' : 'Intercom'}</div>
                {clientesConCam.length > 0 && <div style={{ padding: '0 14px 8px' }}><input value={clientQ} onChange={e => setClientQ(e.target.value)} placeholder="Buscar cliente…" style={{ ...S.inp, padding: '9px 12px' }} /></div>}
                <div style={S.scroll}>
                  {apiOn && cls === null && !clientesConCam.length ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Cargando…</div> :
                    clientesConCam.length === 0 ? <div style={{ textAlign: 'center', padding: 30, color: errCls ? '#b91c1c' : C.sub, fontSize: 13.5, lineHeight: 1.5 }}>{errCls ? 'No se pudo leer la lista: ' + errCls : 'Ningún cliente tiene cámaras todavía. Cargalas desde la ficha del cliente.'}</div> :
                    (() => { const clsF = clientesConCam.filter(c => !clientQ || (c.name || '').toLowerCase().includes(clientQ.toLowerCase())); return clsF.length === 0 ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Sin resultados</div> : clsF.map((c) => (
                      <div key={c.id} className="ph-row" style={{ ...S.row, background: selClient && selClient.id === c.id ? C.sel : 'transparent' }} onClick={() => setSelClient(c)}>
                        <Ava txt={initials(c.name)} size={38} bg={esLocal(c) ? 'linear-gradient(160deg,#0ea5e9,#0369a1)' : 'linear-gradient(160deg,#8b5cf6,#6d28d9)'} />
                        <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{c.name}</div>{esLocal(c) && <div style={{ fontSize: 11.5, color: C.sub }}>de este teléfono</div>}</div>
                      </div>)); })()}
                </div>
              </div>
              <div style={S.listCol}>
                <div style={S.listHdr}>{selClient ? selClient.name : (tab === 'intercom' ? 'Cámaras y porteros' : 'Dispositivos')}{tab === 'intercom' && selClient && <button onClick={() => setSelClient({ ...selClient })} style={{ background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '5px 10px', cursor: 'pointer', color: C.sub, display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 13 }}>{IcReload({ c: C.sub, s: 14 })} Refrescar</button>}</div>
                <div style={{ ...S.scroll, padding: tab === 'intercom' ? '0 18px 18px' : S.scroll.padding }}>
                  {!selClient ? <div style={{ color: C.sub, textAlign: 'center', padding: 40 }}>Elegí un cliente para ver sus {tab === 'intercom' ? 'cámaras/porteros en vivo' : 'dispositivos'}.</div> :
                    streams === null ? <div style={{ color: C.sub, textAlign: 'center', padding: 30 }}>Cargando…</div> :
                    streams.length === 0 ? <div style={{ textAlign: 'center', padding: 30, color: errStreams ? '#b91c1c' : C.sub }}>{errStreams ? 'No se pudieron leer las cámaras: ' + errStreams : 'Este cliente no tiene dispositivos.'}</div> :
                    tab === 'intercom' ?
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px,1fr))', gap: 14 }}>{streams.map((d, i) => <MseTile key={(d.id || i) + ':' + (d.src || d.rtsp || '')} stream={fuenteDeCamara(d, g2l)} onSubir={esLocal(d) && apiOn && !esLocal(selClient) ? () => subirCamara(selClient, d) : undefined} />)}</div> :
                      streams.map((d, i) => (
                        <div key={i} className="ph-row" style={S.row}>
                          <Ava txt="" size={38} bg="#0f1a30" />
                          <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{d.label}</div><div style={{ fontSize: 12, color: C.sub }}>{d.type || 'dispositivo'}{d.src ? ' · ' + d.src : ''}</div></div>
                          <button onClick={() => { setSelClient(selClient); setTab('intercom'); }} style={{ marginLeft: 'auto', ...S.chip('rgba(26,115,242,.12)', '#7cb0ff'), border: 'none', cursor: 'pointer' }}>{IcCam({ c: '#7cb0ff', s: 14 })} Ver en vivo</button>
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${C.line}`, borderRadius: 9, padding: '0 10px', background: C.card }}>{Ic({ c: C.accent, s: 17 })}<select style={{ flex: 1, border: 'none', outline: 'none', background: 'none', fontSize: 14, padding: '9px 0', color: C.ink, cursor: 'pointer' }} value={prefs[key]} onChange={e => pickDev(key, e.target.value)}><option value="">Predeterminado</option>{list.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || ph}</option>)}</select></div>
                      </div>))}
                    <div style={{ padding: '10px 0 4px' }}><div style={S.fieldLbl}>Volumen</div><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{IcSpeaker({ c: C.sub, s: 16 })}<input type="range" min="0" max="1" step="0.05" value={sp.volume} onChange={e => sp.setVolume(parseFloat(e.target.value))} style={{ flex: 1, accentColor: C.green }} /></div></div>
                  </Section>}

                  {aTab === 'registro' && <Section>
                    <div style={{ display: 'flex', gap: 8, padding: '8px 0' }}>
                      <button onClick={() => setCfg(c => ({ ...c, transport: 'webrtc' }))} style={{ flex: 1, padding: 8, borderRadius: 8, border: `1px solid ${!sipMode ? C.accent : C.line}`, background: !sipMode ? 'rgba(26,115,242,.1)' : '#fff', color: !sipMode ? '#7cb0ff' : C.sub, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>WebRTC (WSS/WS)</button>
                      <button onClick={() => { if (!window.sphone) { alert('El modo SIP UDP/TCP solo funciona en la app de Windows (Electron).'); return; } setCfg(c => ({ ...c, transport: 'sip' })); }} style={{ flex: 1, padding: 8, borderRadius: 8, border: `1px solid ${sipMode ? C.accent : C.line}`, background: sipMode ? 'rgba(26,115,242,.1)' : '#fff', color: sipMode ? '#7cb0ff' : C.sub, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>SIP UDP/TCP/TLS</button>
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
                    <button onClick={() => setShowDiag(true)} style={{ width: '100%', padding: 9, borderRadius: 9, border: `1px solid ${C.line}`, background: C.card, color: C.sub, cursor: 'pointer', fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>{IcShield({ c: C.sub, s: 15 })} Diagnóstico</button>
                    {sipMode && sipMsg && <div style={{ fontSize: 12, color: sipReg === 'registered' ? '#4ade80' : C.red, marginBottom: 6 }}>{sipReg === 'registered' ? '✓ ' : '✗ '}{sipMsg}</div>}
                    {sipMode && sipLogs.length > 0 && <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, lineHeight: 1.5, background: '#0f1a30', color: '#a9c2ea', borderRadius: 8, padding: '8px 10px', marginBottom: 8, maxHeight: 150, overflowY: 'auto' }}>{sipLogs.map((l, i) => <div key={i} style={{ color: /40[0-9]|48[0-9]|50[0-9]|✗|sin respuesta|error/i.test(l) ? '#ff9a9a' : /200|registered/i.test(l) ? '#8ce6a6' : '#a9c2ea' }}>{l}</div>)}</div>}
                  </Section>}

                  {aTab === 'red' && <Section title="ICE / TURN" icon={IcShield({ c: C.sub, s: 14 })}>
                    <div style={{ display: 'flex', gap: 18 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {/* El origen del ICE ya no se anuncia con un cartel propio: lo que
                            el usuario viene a mirar es si el TURN sirve, y eso lo dice el
                            estado de la derecha. Lo unico que sobrevive del cartel es el
                            ERROR, porque esconder una falla para ganar prolijidad es
                            justamente lo que deja a alguien una hora sin saber por que no
                            tiene audio. */}
                        {iceErr ? <div style={{ fontSize: 11.5, color: C.red, marginBottom: 8 }}>{iceErr}</div> : null}
                        <div style={{ fontSize: 11.5, color: C.sub, margin: '2px 0 6px' }}>Respaldo manual (sólo se usa si la central no contesta):</div>
                        {F('STUN', 'stun')}{F('TURN', 'turn', 'text', 'turn:host:3478')}{F('TURN usuario', 'turnUser')}
                        <div style={{ padding: '6px 0' }}><div style={S.fieldLbl}>TURN clave</div><input style={S.inp} type="password" value={cfg.turnPass || ''} onChange={e => setCfg(c => ({ ...c, turnPass: e.target.value }))} /></div>
                        <button onClick={() => { sounds.uiClick(); saveConfig(cfg); runTurnTest(); }} style={{ width: '100%', marginTop: 8, padding: 10, borderRadius: 9, border: `1px solid ${C.accent}`, background: 'rgba(26,115,242,.06)', color: '#7cb0ff', cursor: 'pointer', fontWeight: 600 }}>Probar TURN ahora</button>
                      </div>
                      {(() => {
                        const t = turnT || { state: 'idle' };
                        const configured = iceInfo.lista.some((x) => String(Array.isArray(x.urls) ? x.urls[0] : x.urls || '').startsWith('turn'));
                        const inUse = sp.usingRelay === true;
                        const ok = t.state === 'ok';
                        const bad = t.state === 'turn-auth' || t.state === 'turn-unreachable' || t.state === 'error';
                        const col = ok ? C.green : bad ? C.red : configured ? '#f0b429' : '#c2c9d6';
                        const title = t.state === 'testing' ? 'Probando…' : ok ? (inUse ? 'TURN en uso' : 'TURN operativo') : t.state === 'turn-auth' ? 'Credenciales rechazadas' : t.state === 'turn-unreachable' ? 'TURN no responde' : t.state === 'error' ? 'Error' : configured ? 'Sin probar' : 'TURN off';
                        const sub = t.state === 'testing' ? 'levantando ICE…' : ok ? (inUse ? 'la llamada pasa por relay' : 'alcanzable y autenticado') : t.state === 'turn-auth' ? (iceInfo.fuente === 'central' ? 'la central dio esta credencial y el relay la rechazó (401)' : 'usuario/clave inválidos (401): probá actualizar desde la central') : t.state === 'turn-unreachable' ? 'no llegó candidato relay' : configured ? 'tocá "Probar TURN ahora"' : 'sin configurar';
                        return (
                          <div style={{ width: 160, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderLeft: `1px solid ${C.line}`, paddingLeft: 18, textAlign: 'center' }}>
                            <div className={(ok && inUse) ? 'turn-live' : ''} style={{ width: 88, height: 88, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: ok ? 'rgba(43,217,90,.12)' : bad ? 'rgba(239,68,68,.1)' : C.soft }}>
                              {t.state === 'testing' ? <span className="spin" style={{ width: 30, height: 30, borderRadius: '50%', border: '3px solid #3f444d', borderTopColor: C.accent, display: 'block' }} /> : IcAudioCloud({ c: col, s: 46 })}
                            </div>
                            <div style={{ marginTop: 10, fontWeight: 700, fontSize: 13, color: ok ? '#4ade80' : bad ? C.red : C.sub }}>{title}</div>
                            <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>{sub}</div>
                            {/* Debajo del veredicto, que es donde se mira. Trae los servidores
                                de la central y prueba con ellos, en ese orden. */}
                            <button onClick={() => { sounds.uiClick(); runTurnTest(); }}
                              style={{ marginTop: 12, padding: '7px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, color: C.sub, cursor: 'pointer', fontWeight: 600, fontSize: 11.5 }}>
                              Actualizar desde la central
                            </button>
                            {iceInfo.fuente === 'manual' && <div style={{ fontSize: 10.5, color: '#f0b429', marginTop: 6, lineHeight: 1.35 }}>Usando el respaldo manual: la central no contestó.</div>}
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
                            {row('RTP de la llamada', rtp, sp.inCall ? (sp.usingRelay === true ? '#4ade80' : sp.usingRelay === false ? '#7cb0ff' : C.sub) : C.sub)}
                            {row('Candidatos relay (TURN)', t.relay > 0 ? t.relay + ' ✓' : (t.state === 'testing' ? '…' : '0'), t.relay > 0 ? '#4ade80' : C.sub)}
                            {row('Candidatos srflx (STUN)', t.srflx > 0 ? t.srflx + ' ✓' : (t.state === 'testing' ? '…' : '0'), t.srflx > 0 ? '#4ade80' : C.sub)}
                            {row('Candidatos host (LAN)', t.host || 0)}
                            {row('IP pública (por STUN)', t.publicIp || '—')}
                            {row('IP del relay (TURN)', t.relayIp || '—')}
                            {t.ms ? row('Tiempo de sondeo', t.ms + ' ms') : null}
                          </div>
                          {t.errors && t.errors.length > 0 && <div style={{ marginTop: 10, background: 'rgba(239,68,68,.07)', border: `1px solid rgba(239,68,68,.25)`, borderRadius: 9, padding: '8px 10px', fontSize: 11.5, color: '#b91c1c' }}>{t.errors.slice(0, 3).map((e, i) => <div key={i}>✕ {e}</div>)}</div>}
                          <div style={{ fontSize: 11, color: C.sub, marginTop: 10 }}>Si aparece un candidato <b>relay</b>, el TURN está alcanzable <b>y</b> autenticado. Sin relay, las llamadas solo funcionan si hay camino directo (misma red o NAT permisiva).</div>
                        </div>); })()}
                  </Section>}

                  {aTab === 'sistema' && <Section title="INTEGRACIÓN CON EL SISTEMA" icon={IcUsers({ c: C.sub, s: 14 })} right={apiOn ? <span style={S.chip('rgba(43,217,90,.14)', '#4ade80')}>conectado</span> : null}>
                    {apiOn ? (
                      <div style={{ padding: '10px 0' }}><div style={{ fontSize: 13 }}>Conectado como <b>{api.getApiUser()}</b>. Contactos, Clientes, Intercom y grabaciones activos.</div><button onClick={apiDisconnect} style={{ marginTop: 10, background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', color: C.red }}>Desconectar</button><button onClick={() => { setShowProv(true); setProvExt(''); setProvQr(''); setProvErr(''); setProvUrl(''); }} style={{ marginTop: 10, marginLeft: 8, background: 'rgba(26,115,242,.08)', border: `1px solid ${C.accent}`, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', color: '#7cb0ff', fontWeight: 600 }}>Aprovisionar teléfono (QR)</button></div>
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
                    {window.sphone && (() => {
                      /* El estado del chequeo se ve ACA, no en un aviso que se va solo: el que
                         aprieta «Buscar» esta mirando esta fila y espera una respuesta. */
                      const e = upd && upd.state;
                      const txt = e === 'checking' ? 'Buscando…'
                        : e === 'available' ? 'Hay una version nueva: v' + (upd.version || '?') + ' · bajando…'
                          : e === 'downloading' ? 'Bajando… ' + (upd.percent || 0) + '%'
                            : e === 'downloaded' ? 'v' + (upd.version || '') + ' lista: se instala al cerrar'
                              : e === 'none' ? 'Estas al dia.'
                                : e === 'error' ? ('No se pudo consultar: ' + (upd.msg || 'error')) : '';
                      const col = e === 'error' ? C.red : e === 'downloaded' || e === 'available' ? '#7cb0ff' : C.sub;
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 2px' }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>Actualizaciones</div>
                            <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>Version actual {APP_VERSION}.{' '}
                              <span style={{ color: col }}>{txt}</span>
                            </div>
                          </div>
                          {e === 'downloaded'
                            ? <button onClick={() => { try { window.sphone.updateInstall(); } catch {} }} style={{ padding: '8px 16px', borderRadius: 10, border: 'none', background: C.green, color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Instalar y reiniciar</button>
                            : <button disabled={e === 'checking' || e === 'downloading'} onClick={() => { setUpd({ state: 'checking' }); setUpdateFeed(); try { window.sphone.updateCheck(); } catch {} }}
                              style={{ padding: '8px 16px', borderRadius: 10, border: `1px solid ${C.accent}`, background: C.card, color: '#7cb0ff', fontWeight: 600, cursor: e === 'checking' ? 'default' : 'pointer', opacity: e === 'checking' || e === 'downloading' ? .6 : 1 }}>Buscar</button>}
                        </div>
                      );
                    })()}
                  </Section>}
                </div>
                <div style={{ textAlign: 'center', color: C.sub, fontSize: 12, marginTop: 16 }}>PBX-NG Softphone {APP_VERSION} · sirve con cualquier central con internos WebRTC.</div>
              </div>
            </div>
          )}

          {/* ── Pantalla de llamada ──────────────────────────────────────────
              Un solo componente para los cinco estados (entrante, marcando, hablando, en
              espera, terminada): el avatar, el nombre y la barra de abajo son los MISMOS
              elementos y sólo cambia su contenido. Antes cada estado era un bloque que
              aparecía de golpe, y el cambio —sobre todo el instante en que el otro
              atiende— no se notaba. */}
          {/* La pantalla de llamada tapa TODA la ventana: el menu lateral y la barra de
              titulo clara quedan afuera. Antes convivian —franja clara arriba, menu azul a
              la izquierda, llamada oscura en el medio, y dos juegos de botones de ventana
              uno encima del otro—: parecian dos aplicaciones pegadas. Durante una llamada
              no hay nada que navegar. */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: (sp.incoming || sp.inCall || finCall) ? 'block' : 'none' }}>
          {(sp.incoming || sp.inCall || finCall) && (() => {
            const ci = sp.callInfo || {};
            const entrante = !!sp.incoming;
            const from = entrante ? ((sp.incoming.remoteIdentity && sp.incoming.remoteIdentity.uri && sp.incoming.remoteIdentity.uri.user) || 'desconocido') : '';
            const numero = entrante ? from : (finCall ? finCall.number : (ci.number || '—'));
            const nombre = (popClient && popClient.name) || '';
            const estado = finCall ? 'terminada'
              : entrante ? 'entrante'
                : sp.held ? 'espera'
                  : ci.since ? 'hablando' : 'marcando';
            /* Hay escena de video si la llamada trae imagen O si el cliente del otro lado
               tiene cámaras: el portero sin video se suplanta con la cámara de la entrada,
               que es lo que uno quería mirar desde el principio. */
            const videoLlamada = !!sp.videoOn && !entrante;
            /* Las camaras del cliente se ven TAMBIEN mientras timbra una entrante: atender
               es la decision que uno quiere tomar despues de mirar quien esta en la puerta,
               no antes. Antes esta linea decia `!entrante && !finCall`, y por eso una
               entrante del portero mostraba el orbe hasta que se atendia, mientras que la
               misma llamada marcada al reves mostraba la entrada desde el primer timbre.

               La excepcion: si la entrante ANUNCIA video, no se encienden. La imagen que
               importa es la que va a traer la llamada, y encender las camaras para taparlas
               un segundo despues es peor que esperar. En una saliente no existe esa
               excepcion porque no se sabe de antemano si el otro lado manda imagen. */
            const anunciaVideo = entrante && !!sp.incomingVideo;
            const camsEnLlamada = (!finCall && !anunciaVideo) ? camaras : [];
            const videoVivo = videoLlamada || camsEnLlamada.length > 0;

            /* Los dos videos se entregan SUELTOS (no una escena ya armada): la pantalla de
               llamada decide dónde va cada uno, porque es la que sabe si los controles están
               a la vista, si la cámara propia está encendida y si el otro lado ya mandó
               imagen. Antes venían con la posición escrita acá y la miniatura terminaba
               debajo de la barra en una ventana angosta. */
            const nodoRemoto = videoLlamada
              ? <video autoPlay playsInline muted className="cs-video-remoto" ref={el => { if (sp.remoteVideoRef) sp.remoteVideoRef.current = el; if (el) { const st = sp.getRemoteStream && sp.getRemoteStream(); if (st && el.srcObject !== st) { el.srcObject = st; el.play().catch(() => {}); } } }} />
              : null;
            const fuentes = [];
            if (nodoRemoto) fuentes.push({ id: 'llamada', label: nombre || numero, nodo: nodoRemoto });
            camsEnLlamada.forEach(c => fuentes.push({ id: 'cam:' + c.id, label: c.label || 'Cámara', nodo: <MseTile fit stream={fuenteDeCamara(c, g2l)} /> }));
            const principalReal = fuentes.some(f => f.id === principal) ? principal : ((fuentes[0] && fuentes[0].id) || 'llamada');
            const nodosVideo = videoVivo ? {
              remoto: nodoRemoto,
              medios: <EscenaMedios fuentes={fuentes} principal={principalReal}
                onPrincipal={(id) => { setPrincipal(id); setPrincipalManual(true); }} />,
              yo: <video autoPlay playsInline muted className="cs-video-yo" ref={el => { if (sp.localVideoRef) sp.localVideoRef.current = el; if (el) { const st = sp.getLocalStream && sp.getLocalStream(); if (st && el.srcObject !== st) { el.srcObject = st; el.play().catch(() => {}); } } }} />,
            } : null;

            /* Lo que no entra en la fila de botones: se agrupa en «Más», como en un
               teléfono de escritorio. Meterlo todo abajo convierte la barra en una
               botonera y se pierde lo importante. */
            /* Sólo el CONTENIDO del menú: dónde se dibuja y con qué caja lo decide la
               pantalla de llamada, que es la que sabe dónde está el botón «Más». */
            const masMenu = mas && !entrante ? (
              <>
                {[
                  { ok: apiOn, lbl: recording ? 'Grabando…' : 'Grabar la llamada', ic: IcRec, on: recording, fn: () => { setMas(false); toggleRecord(); } },
                  { ok: !sipMode, lbl: 'Invitar a la llamada', ic: IcUsers, on: !!sp.attended, fn: () => { setMas(false); if (sp.attended) return; const t = prompt('Invitar interno a la conferencia:'); if (t && t.trim()) sp.attendedCall(t.trim()); } },
                ].filter(x => x.ok).map(x => (
                  <button key={x.lbl} onClick={x.fn} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, background: 'none', border: 'none', color: x.on ? '#3b82f6' : '#e8ebf0', padding: '9px 10px', borderRadius: 10, cursor: 'pointer', fontSize: 13.5, textAlign: 'left' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,.08)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>{x.ic ? x.ic({ s: 17, c: x.on ? '#3b82f6' : '#9fb0cc' }) : null}{x.lbl}</button>
                ))}
              </>
            ) : null;

            /* Las barras de contexto: la ficha del CRM cuando entra una llamada conocida,
               la consulta en curso de una transferencia atendida, la otra línea en espera
               y la conferencia. Van juntas bajo el nombre. */
            const contexto = (
              <>
                {entrante && popClient && (
                  <div className="menu-pop" style={{ marginTop: 18, background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 14, padding: '12px 16px', maxWidth: 420, textAlign: 'left' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontWeight: 700, fontSize: 15 }}>{popClient.name}</span><span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(159,208,255,.18)', color: '#cfe6ff', borderRadius: 8, padding: '2px 8px' }}>CRM</span></div>
                    {popClient.address && <div style={{ fontSize: 12, color: 'rgba(255,255,255,.62)', marginTop: 2 }}>{popClient.address}</div>}
                    {Array.isArray(popClient.persons) && popClient.persons.length > 0 && <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,.8)' }}><span style={{ color: 'rgba(255,255,255,.5)' }}>Autorizados: </span>{popClient.persons.slice(0, 3).map(x => x.name).join(', ')}{popClient.persons.length > 3 ? '…' : ''}</div>}
                  </div>
                )}
                {sp.attended && (
                  <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.16)', borderRadius: 12, padding: '8px 12px' }}>
                    <span style={{ fontSize: 13 }}>Consultando a <b>{sp.attended.number}</b> · {sp.attended.state === 'talking' ? 'en línea' : sp.attended.state === 'calling' ? 'llamando…' : sp.attended.state}</span>
                    <button onClick={sp.completeAttended} style={{ background: '#2fbf6e', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>Completar</button>
                    <button onClick={sp.cancelAttended} style={{ background: 'rgba(255,255,255,.16)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>Cancelar</button>
                  </div>
                )}
                {sp.heldInfo && (
                  <div style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.16)', borderRadius: 20, padding: '5px 6px 5px 12px', fontSize: 12.5 }}>
                    {sp.heldInfo.number} en espera
                    <button onClick={sp.switchLine} style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 14, padding: '4px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Cambiar</button>
                    <button onClick={sp.conference} style={{ background: '#a78bfa', color: '#fff', border: 'none', borderRadius: 14, padding: '4px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Unir</button>
                  </div>
                )}
                {sp.conf && <div style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(139,92,246,.2)', border: '1px solid rgba(139,92,246,.45)', borderRadius: 20, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#d9c9ff' }}>● Conferencia activa</div>}
              </>
            );

            return (
              <CallScreen
                estado={estado}
                saliendo={cerrandoLlamada}
                titulo={nombre || numero}
                subtitulo={nombre ? numero : (finCall ? 'Duración ' + fmtDur(finCall.dur) : '')}
                iniciales={initials(numero)}
                nota={/rechaz|error|ocupad/i.test(sp.note || '') ? sp.note : (sp.note || '')}
                desde={ci.since || (finCall ? 0 : 0)}
                calidad={sp.quality ? sp.quality.score : 0}
                viaTurn={sp.usingRelay}
                video={videoVivo}
                videoNodes={nodosVideo}
                principalEsCamara={String(principalReal || '').startsWith('cam:')}
                getRemoteStream={sp.getRemoteStream}
                getAudioStream={sp.getRemoteAudioStream || sp.getRemoteStream}
                ventana={<WinCtl dark />}
                flags={{ muted: sp.muted, held: sp.held, videoOn: sp.videoOn, pad, masAbierto: mas, altavoz: !!sp.speaker, transfiriendo: !!sp.attended || xfer, grabando: recording }}
                extra={contexto}
                menuMas={masMenu}
                acciones={{
                  colgar: () => { sounds.uiClick(); sp.hangup(); },
                  rechazar: () => { sounds.uiClick(); sp.reject(); },
                  atender: () => { sounds.uiClick(); sp.accept(false); },
                  atenderVideo: sipMode ? null : () => { sounds.uiClick(); sp.accept(true); },
                  mute: sp.toggleMute,
                  /* En espera y altavoz YA funcionan en modo SIP nativo: la espera es un
                     re-INVITE de verdad a la central (la que pone la música), y el altavoz
                     elige la salida del audio. Antes estaban apagados en nativo y por eso
                     faltaban dos botones en la barra. */
                  hold: sp.toggleHold,
                  video: sp.toggleVideo,
                  altavoz: sp.toggleSpeaker,
                  transferir: () => { setMas(false); if (sp.attended) return; setXferNum(''); setXfer(true); },
                  teclado: () => { setMas(false); setPad(v => !v); },
                  mas: () => { setPad(false); setMas(v => !v); },
                  tecla: press,
                }}
              />
            );
          })()}
          </div>

          {xfer && (
            <div className="call-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(6,10,20,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }} onClick={() => setXfer(false)}>
              <div onClick={e => e.stopPropagation()} style={{ background: C.card, color: C.ink, borderRadius: 16, padding: 20, width: 300, boxShadow: '0 20px 50px rgba(0,0,0,.45)' }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Transferir llamada</div>
                <input autoFocus value={xferNum} onChange={e => setXferNum(e.target.value.replace(/[^\d*#+]/g, ''))} placeholder="Interno o número" style={{ ...S.inp, marginBottom: 14 }} onKeyDown={e => { if (e.key === 'Enter' && xferNum) { sp.transfer(xferNum); setXfer(false); } }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <button disabled={!xferNum} onClick={() => { sp.transfer(xferNum); setXfer(false); }} style={{ flex: 1, padding: 10, borderRadius: 10, border: 'none', background: C.accent, color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: xferNum ? 1 : .5 }}>Ciega</button>
                  <button disabled={!xferNum} onClick={() => { sp.attendedCall(xferNum); setXfer(false); }} style={{ flex: 1, padding: 10, borderRadius: 10, border: `1px solid ${C.accent}`, background: C.card, color: '#7cb0ff', fontWeight: 700, cursor: 'pointer', opacity: xferNum ? 1 : .5 }}>Atendida</button>
                </div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 10 }}>Ciega: transfiere de inmediato. Atendida: hablás primero y después completás.</div>
                <button onClick={() => setXfer(false)} style={{ width: '100%', marginTop: 8, background: 'none', border: 'none', color: C.sub, cursor: 'pointer', fontSize: 13 }}>Cancelar</button>
              </div>
            </div>
          )}

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

          {alta && <PanelAlta alta={alta} apiOn={apiOn} msg={altaMsg}
            onCerrar={() => { setAlta(null); setAltaMsg(''); }} onGuardar={altaGuardar} />}

          {showProv && (
            <div style={S.modalWrap} onClick={() => setShowProv(false)}>
              <div ref={gModal} onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 16, padding: 22, width: 360, boxShadow: '0 24px 60px rgba(0,0,0,.3)' }}>
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
              <div ref={gModal} onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 16, padding: 22, width: 430, maxHeight: '82vh', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,.3)' }}>
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
                  <button onClick={() => setShowDiag(false)} style={{ flex: 1, padding: 10, borderRadius: 10, border: `1px solid ${C.line}`, background: C.card, color: C.sub, cursor: 'pointer', fontWeight: 600 }}>Cerrar</button>
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
          {/* ── Menú de la cuenta ──────────────────────────────────────────────
              Calcado del teléfono que usa el cliente: arriba la ficha (avatar, nombre,
              interno, estado en línea y el QR a la derecha), abajo la lista de acciones
              separada en tres grupos. Las opciones son las de PBX-NG, no las de aquel:
              lo que se copia es la FORMA, porque es la que el usuario ya conoce. */}
          {menu && <><div onClick={() => setMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 190 }} />
            <div className="menu-pop" style={{ position: 'fixed', top: 44, left: 74, zIndex: 200, background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, boxShadow: '0 22px 54px rgba(0,0,0,.55)', overflow: 'hidden', width: 286, color: C.ink }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 14px 12px' }}>
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  <Ava photo={photo} txt={isComplete(cfg) ? initials(cfg.ext) : '·'} size={46} />
                  <span style={{ position: 'absolute', right: -1, bottom: -1, width: 12, height: 12, borderRadius: '50%', background: registered ? C.green : '#7c8794', border: '2px solid ' + C.card }} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cfg.name || (isComplete(cfg) ? 'Interno ' + cfg.ext : 'Sin cuenta')}</div>
                  <div style={{ fontSize: 12.5, color: C.sub }}>{cfg.ext || '—'}</div>
                  <div style={{ fontSize: 12.5, color: registered ? C.green : C.sub, marginTop: 1 }}>{registered ? 'En línea' : (statusTxt || 'Sin conexión')}</div>
                </div>
                <button title="Aprovisionar este teléfono por QR" onClick={() => { setMenu(false); setShowQr(true); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.sub, padding: 4, borderRadius: 8 }}>{IcQr({ c: C.sub, s: 19 })}</button>
              </div>
              <div style={{ height: 1, background: C.line }} />
              {[
                { ic: IcGear, lbl: 'Ajustes', fn: () => { setTab('ajustes'); setATab('registro'); } },
                { ic: IcUser, lbl: 'Perfil y foto', fn: () => setShowProfile(true) },
                { ic: IcSpeaker, lbl: 'Micrófono y auricular', fn: () => { setTab('ajustes'); setATab('disp'); } },
                { ic: IcShield, lbl: 'Red y TURN', fn: () => { setTab('ajustes'); setATab('red'); } },
              ].map(x => (
                <button key={x.lbl} className="mp-row" onClick={() => { setMenu(false); x.fn(); }} style={mpRow}>
                  {x.ic({ c: C.sub, s: 17 })}<span>{x.lbl}</span>
                </button>
              ))}
              <div style={{ height: 1, background: C.line, margin: '4px 0' }} />
              {[
                { ic: IcGrid, lbl: 'Diagnóstico de la llamada', fn: () => setShowDiag(true) },
                { ic: IcUser, lbl: 'Integración con el sistema', fn: () => { setTab('ajustes'); setATab('sistema'); } },
              ].map(x => (
                <button key={x.lbl} className="mp-row" onClick={() => { setMenu(false); x.fn(); }} style={mpRow}>
                  {x.ic({ c: C.sub, s: 17 })}<span>{x.lbl}</span>
                </button>
              ))}
              <div style={{ height: 1, background: C.line, margin: '4px 0' }} />
              <button className="mp-row" onClick={() => { setMenu(false); setShowAccts(true); }} style={mpRow}>
                {IcUsers({ c: C.sub, s: 17 })}<span>Cambiar de cuenta{accts.length ? ' (' + accts.length + ')' : ''}</span>
              </button>
              <button className="mp-row mp-row-salir" onClick={logout} style={{ ...mpRow, color: C.red }}>
                {IcPower({ c: C.red, s: 17 })}<span>Cerrar sesión</span>
              </button>
              <div style={{ padding: '8px 16px 11px', fontSize: 11, color: C.sub, borderTop: `1px solid ${C.line}` }}>PBX-NG Softphone {APP_VERSION}</div>
            </div></>}
          {showAccts && (
            <div style={S.modalWrap} onClick={() => setShowAccts(false)}>
              <div ref={gModal} onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 16, padding: 22, width: 390, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>{IcUsers({ c: C.accent, s: 20 })}<div style={{ fontWeight: 700, fontSize: 17 }}>Cuentas</div><button onClick={() => setShowAccts(false)} style={{ marginLeft: 'auto', ...S.actBtn(C.sub) }}>{IcX({ c: C.sub, s: 16 })}</button></div>
                {accts.length === 0 ? <div style={{ fontSize: 13, color: C.sub, padding: '6px 0 12px' }}>No hay cuentas guardadas. Guardá la actual para cambiar rápido entre internos.</div> :
                  accts.map(a => { const active = isComplete(cfg) && a.id === acctId(cfg); return (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: `1px solid ${C.line}` }}>
                      <Ava txt={initials(a.label)} size={36} bg={active ? 'linear-gradient(160deg,#2bd95a,#1fa945)' : 'linear-gradient(160deg,#7c9be0,#4f6fc9)'} />
                      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{a.label}{active && <span style={{ marginLeft: 8, fontSize: 10, background: 'rgba(43,217,90,.15)', color: '#4ade80', borderRadius: 8, padding: '1px 7px' }}>activa</span>}</div><div style={{ fontSize: 12, color: C.sub }}>{a.id}{a.api && a.api.token ? ' · CRM' : ''}</div></div>
                      {!active && <button onClick={() => switchAccount(a)} style={{ ...S.chip('rgba(26,115,242,.1)', '#7cb0ff'), border: 'none', cursor: 'pointer', fontWeight: 600 }}>Usar</button>}
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
                      <label style={{ ...S.chip('rgba(26,115,242,.12)', '#7cb0ff'), cursor: 'pointer' }}>Subir foto<input type="file" accept="image/*" style={{ display: 'none' }} onChange={onPhoto} /></label>
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
                  <button onClick={() => doSpy('whisper')} style={{ ...S.primary, background: '#a78bfa', textAlign: 'left', paddingLeft: 16 }}>🤫 Susurrar <span style={{ fontWeight: 400, opacity: .8 }}>· solo te oye tu agente</span></button>
                  <button onClick={() => doSpy('barge')} style={{ ...S.primary, background: '#f0b429', textAlign: 'left', paddingLeft: 16 }}>📢 Irrumpir <span style={{ fontWeight: 400, opacity: .8 }}>· entrás a la llamada</span></button>
                  <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>La central te va a llamar; atendé para monitorear.</div>
                  {spyMsg && <div style={{ fontSize: 12, color: /error/i.test(spyMsg) ? C.red : '#4ade80' }}>{spyMsg}</div>}
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

/* La lista de clientes vacia. Dos salidas distintas segun donde este parado el usuario, y
 * ninguna de las dos es un cartel que no lleva a nada: sin central, cargar uno acá es LA
 * salida; con central, puede ser que todavia no haya ninguno cargado en el sistema. */
function SinClientes({ apiOn, onAlta, onSistema }) {
  return (
    <div style={{ textAlign: 'center', padding: '38px 22px', color: C.sub }}>
      {IcUsers({ c: C.sub, s: 30 })}
      <div style={{ marginTop: 10, fontSize: 14, color: C.txt, fontWeight: 600 }}>Todavía no hay clientes</div>
      <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.5 }}>
        {apiOn
          ? 'La central no tiene ninguno cargado. Podés agregar uno acá: queda en este teléfono.'
          : 'Podés cargarlos en este teléfono y quedan guardados, o conectarte al sistema para traer los de la central.'}
      </div>
      <button onClick={onAlta} style={{ marginTop: 14, background: 'rgba(14,165,233,.14)', color: '#0ea5e9', border: '1px solid rgba(14,165,233,.3)', borderRadius: 10, padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>Agregar un cliente</button>
      {!apiOn && <div><button onClick={onSistema} style={{ marginTop: 9, background: 'none', border: 'none', color: C.sub, cursor: 'pointer', fontSize: 12.5, textDecoration: 'underline' }}>Conectarme al sistema</button></div>}
    </div>
  );
}

/* ── Buscar la cámara en la red, en vez de escribir su URL a mano ────────────
 * Tres pasos y en este orden porque es el orden en que el técnico tiene la información:
 * primero qué hay en la red (no sabe la IP de memoria), después la clave (la tiene
 * anotada), y recién entonces elige el canal viendo la resolución de cada uno — que es lo
 * que de verdad decide: el principal para mirar, el secundario para que no sature.
 *
 * Si el descubrimiento no encuentra nada, se puede escribir la IP y seguir igual: muchas
 * cámaras traen el descubrimiento ONVIF apagado de fábrica, y en una red con wifi de por
 * medio el multicast se pierde sin avisar. Que no aparezca NO significa que no hable ONVIF.
 */
function Onvif({ onElegir }) {
  const [abierto, setAbierto] = useState(false);
  const [paso, setPaso] = useState('buscar');     // buscar | credenciales | perfiles
  const [equipos, setEquipos] = useState(null);
  const [sel, setSel] = useState(null);
  const [manual, setManual] = useState('');
  const [cred, setCred] = useState({ user: 'admin', pass: '' });
  const [perfiles, setPerfiles] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [err, setErr] = useState('');
  const sp = typeof window !== 'undefined' ? window.sphone : null;

  if (!sp || !sp.onvifDescubrir) return null;   // en la PWA no hay red que recorrer

  async function buscar() {
    setCargando(true); setErr(''); setEquipos(null);
    try {
      const r = await sp.onvifDescubrir(4500);
      if (!r.ok) { setErr(r.motivo || 'no se pudo buscar'); setEquipos([]); }
      else setEquipos(r.equipos || []);
    } catch (e) { setErr((e && e.message) || 'error'); setEquipos([]); }
    finally { setCargando(false); }
  }
  function elegirEquipo(eq) { setSel(eq); setPaso('credenciales'); setErr(''); setPerfiles(null); }
  async function traerPerfiles() {
    const xaddr = sel ? sel.xaddr : ('http://' + String(manual).trim() + '/onvif/device_service');
    setCargando(true); setErr(''); setPerfiles(null);
    try {
      const r = await sp.onvifPerfiles({ xaddr, user: cred.user, pass: cred.pass });
      if (!r.ok) { setErr(r.motivo || 'no se pudieron leer los perfiles'); }
      else { setPerfiles(r.perfiles || []); setPaso('perfiles'); }
    } catch (e) { setErr((e && e.message) || 'error'); }
    finally { setCargando(false); }
  }
  function usar(pf) {
    onElegir(pf.rtsp, (sel && sel.nombre ? sel.nombre + ' · ' : '') + pf.nombre);
    setAbierto(false); setPaso('buscar'); setSel(null); setPerfiles(null); setCred({ user: 'admin', pass: '' });
  }

  const caja = { border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginTop: 8, background: C.soft };
  const fila = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${C.line}`, background: C.card, marginBottom: 6 };

  if (!abierto) {
    return (
      <button onClick={() => { setAbierto(true); buscar(); }}
        style={{ marginTop: 8, width: '100%', padding: '9px 12px', borderRadius: 9, border: `1px dashed ${C.line}`, background: 'none', color: '#67c7f5', cursor: 'pointer', fontWeight: 600, fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
        {IcSearch({ c: '#67c7f5', s: 15 })} Buscar la cámara en la red (ONVIF)
      </button>
    );
  }

  return (
    <div style={caja}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 12.5 }}>
          {paso === 'buscar' ? 'Cámaras en esta red' : paso === 'credenciales' ? 'Usuario de la cámara' : 'Elegí el canal'}
        </div>
        <button onClick={() => setAbierto(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', color: C.sub, cursor: 'pointer', fontSize: 17, lineHeight: 1 }}>×</button>
      </div>

      {paso === 'buscar' && <>
        {cargando && <div style={{ fontSize: 12, color: C.sub, padding: '8px 0' }}>Buscando… (unos segundos)</div>}
        {!cargando && equipos && equipos.map((eq) => (
          <div key={eq.xaddr} onClick={() => elegirEquipo(eq)} style={fila}>
            {IcCam({ c: '#67c7f5', s: 17 })}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{eq.nombre || eq.host}</div>
              <div style={{ fontSize: 11, color: C.sub }}>{eq.host}{eq.modelo ? ' · ' + eq.modelo : ''}</div>
            </div>
          </div>
        ))}
        {!cargando && equipos && equipos.length === 0 && (
          <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.45, marginBottom: 8 }}>
            No contestó ninguna. Muchas cámaras traen el descubrimiento apagado de fábrica, y por wifi el
            multicast se pierde: que no aparezca no quiere decir que no hable ONVIF. Poné su IP acá abajo.
          </div>
        )}
        {!cargando && <div style={{ display: 'flex', gap: 7, marginTop: 4 }}>
          <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="IP de la cámara"
            style={{ ...S.inp, flex: 1, padding: '8px 10px', fontSize: 12.5 }} autoCapitalize="off" spellCheck={false} />
          <button onClick={() => { if (String(manual).trim()) { setSel(null); setPaso('credenciales'); } }}
            style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, color: C.sub, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Usar</button>
          <button onClick={buscar} title="Buscar de nuevo"
            style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, color: C.sub, cursor: 'pointer', fontSize: 12 }}>↻</button>
        </div>}
      </>}

      {paso === 'credenciales' && <>
        <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 8 }}>
          {sel ? (sel.nombre || sel.host) + ' · ' + sel.host : String(manual).trim()}
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          <input value={cred.user} onChange={(e) => setCred((c) => ({ ...c, user: e.target.value }))} placeholder="usuario"
            style={{ ...S.inp, flex: 1, padding: '8px 10px', fontSize: 12.5 }} autoCapitalize="off" spellCheck={false} />
          <input value={cred.pass} onChange={(e) => setCred((c) => ({ ...c, pass: e.target.value }))} placeholder="clave" type="password"
            style={{ ...S.inp, flex: 1, padding: '8px 10px', fontSize: 12.5 }}
            onKeyDown={(e) => { if (e.key === 'Enter') traerPerfiles(); }} />
        </div>
        <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
          <button onClick={() => { setPaso('buscar'); setErr(''); }}
            style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: 'none', color: C.sub, cursor: 'pointer', fontSize: 12 }}>Atrás</button>
          <button onClick={traerPerfiles} disabled={cargando}
            style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: `1px solid ${C.accent}`, background: 'rgba(26,115,242,.06)', color: '#7cb0ff', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
            {cargando ? 'Consultando…' : 'Ver los canales'}
          </button>
        </div>
      </>}

      {paso === 'perfiles' && <>
        {(perfiles || []).map((pf, i) => (
          <div key={i} onClick={() => usar(pf)} style={fila}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{pf.nombre}</div>
              <div style={{ fontSize: 11, color: C.sub }}>{[pf.resolucion, pf.codec, pf.fps ? pf.fps + ' fps' : ''].filter(Boolean).join(' · ')}</div>
            </div>
            <span style={{ fontSize: 11, color: '#67c7f5', fontWeight: 600 }}>Usar</span>
          </div>
        ))}
        <button onClick={() => { setPaso('credenciales'); setErr(''); }}
          style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: 'none', color: C.sub, cursor: 'pointer', fontSize: 12, marginTop: 2 }}>Atrás</button>
      </>}

      {err && <div style={{ fontSize: 11.5, color: C.red, marginTop: 8, lineHeight: 1.4 }}>{err}</div>}
    </div>
  );
}

/* El alta de un cliente o de una camara. El DESTINO es la decision del formulario: se
 * muestra sólo cuando hay a dónde elegir —con central conectada y sobre un cliente del
 * sistema—; en cualquier otro caso va local y se dice por qué, en vez de ofrecer una opción
 * que despues falla. */
function PanelAlta({ alta, apiOn, msg, onCerrar, onGuardar }) {
  const esCam = alta.tipo === 'camara';
  const cli = alta.cliente;
  const cliLocal = !!(cli && typeof cli.id === 'string' && cli.id.indexOf('loc_') === 0);
  const puedeCentral = apiOn && (esCam ? !cliLocal : true);
  const [f, setF] = useState({ name: '', phones: '', label: '', rtsp: '', type: 'camera', destino: puedeCentral ? 'central' : 'local' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const enviar = () => onGuardar(f);
  /* La prueba se borra cada vez que cambia la URL: un tilde verde al lado de una URL que
   * ya no es la que se probó es peor que no tener prueba. */
  const [prueba, setPrueba] = useState(null);
  const [probando, setProbando] = useState(false);
  async function probar() {
    const sp = typeof window !== 'undefined' ? window.sphone : null;
    if (!sp || !sp.camaraProbar) { setPrueba({ ok: false, motivo: 'Probar necesita el softphone de escritorio.' }); return; }
    setProbando(true); setPrueba(null);
    try { setPrueba(await sp.camaraProbar(f.rtsp)); }
    catch (e) { setPrueba({ ok: false, motivo: (e && e.message) || 'error' }); }
    finally { setProbando(false); }
  }
  return (
    <div style={S.modalWrap} onClick={onCerrar}>
      <div ref={gModal} onClick={(e) => e.stopPropagation()} style={{ background: C.card, borderRadius: 16, padding: 22, width: 400, maxHeight: '84vh', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>{esCam ? 'Agregar cámara' : 'Agregar cliente'}</div>
          <button onClick={onCerrar} style={{ marginLeft: 'auto', ...S.actBtn(C.sub) }}>{IcX({ c: C.sub, s: 16 })}</button>
        </div>
        {esCam && <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 12 }}>Para <b style={{ color: C.txt }}>{(cli && cli.name) || 'el cliente'}</b>.</div>}

        {!esCam && <>
          <div style={{ padding: '6px 0' }}><div style={S.fieldLbl}>Nombre</div><input autoFocus style={S.inp} value={f.name} onChange={set('name')} placeholder="Ej. Edificio Rambla 1200" onKeyDown={(e) => { if (e.key === 'Enter') enviar(); }} /></div>
          <div style={{ padding: '6px 0' }}><div style={S.fieldLbl}>Teléfonos o internos</div><input style={S.inp} value={f.phones} onChange={set('phones')} placeholder="2001, 099123456" autoCapitalize="off" /><div style={{ fontSize: 11, color: C.sub, marginTop: 5 }}>Separados por coma. Son los números con los que se reconoce al cliente cuando llama.</div></div>
        </>}

        {esCam && <>
          <div style={{ padding: '6px 0' }}><div style={S.fieldLbl}>Etiqueta</div><input autoFocus style={S.inp} value={f.label} onChange={set('label')} placeholder="Ej. Portero frente" /></div>
          <div style={{ padding: '6px 0' }}><div style={S.fieldLbl}>Tipo</div><select style={S.sel} value={f.type} onChange={set('type')}><option value="camera">Cámara</option><option value="intercom">Portero</option></select></div>

          {/* Buscar en la red antes que escribir a mano. El path del canal
              (`/Streaming/Channels/101`, `/cam/realmonitor?channel=1`, `/live/0/MAIN`…)
              cambia por fabricante y por modelo: no se adivina, se pregunta. ONVIF es el
              estándar que contesta exactamente eso. */}
          <Onvif onElegir={(rtsp, etiqueta) => setF((x) => ({ ...x, rtsp, label: x.label || etiqueta }))} />

          <div style={{ padding: '6px 0' }}>
            <div style={S.fieldLbl}>URL de la cámara</div>
            <input style={S.inp} value={f.rtsp} onChange={(e) => { setF((x) => ({ ...x, rtsp: e.target.value })); setPrueba(null); }}
              placeholder="rtsp://usuario:clave@192.168.1.50:554/Streaming/Channels/101" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 7 }}>
              <button onClick={probar} disabled={!f.rtsp || probando}
                style={{ padding: '6px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, color: probando ? C.sub : '#7cb0ff', cursor: f.rtsp && !probando ? 'pointer' : 'default', fontWeight: 600, fontSize: 12, opacity: f.rtsp ? 1 : .5 }}>
                {probando ? 'Probando…' : 'Probar'}
              </button>
              {prueba && (prueba.ok
                ? <span style={{ fontSize: 11.5, color: '#4ade80', fontWeight: 600 }}>✓ Da video{prueba.codec ? ' · ' + String(prueba.codec).replace(/^video\/mp4; codecs="?|"?$/g, '') : ''}</span>
                : <span style={{ fontSize: 11.5, color: C.red, lineHeight: 1.35 }}>{prueba.motivo}</span>)}
            </div>
            <div style={{ fontSize: 11, color: C.sub, marginTop: 6, lineHeight: 1.4 }}>La URL lleva el usuario y la clave de la cámara adentro. Si la subís a la central, la central es la única que la ve entera: al teléfono vuelve enmascarada.</div>
          </div>
        </>}

        <div style={{ padding: '10px 0 2px' }}>
          <div style={S.fieldLbl}>Dónde queda</div>
          {puedeCentral ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              {[['central', 'En la central', 'La ven todos los que atienden, y el video sale por la central.'],
                ['local', 'Sólo en este teléfono', 'No se comparte con nadie ni sale del aparato.']].map(([v, t, d]) => {
                const on = f.destino === v;
                return (
                  <button key={v} onClick={() => setF((x) => ({ ...x, destino: v }))}
                    style={{ textAlign: 'left', border: `1px solid ${on ? '#0ea5e9' : C.line}`, background: on ? 'rgba(14,165,233,.08)' : 'none', borderRadius: 10, padding: '9px 12px', cursor: 'pointer' }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: on ? '#0ea5e9' : C.txt }}>{t}</div>
                    <div style={{ fontSize: 11.5, color: C.sub, marginTop: 2 }}>{d}</div>
                  </button>);
              })}
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: C.sub, marginTop: 4, border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 12px' }}>
              Queda <b style={{ color: C.txt }}>sólo en este teléfono</b>. {esCam && cliLocal
                ? 'Este cliente también es de este teléfono, así que no hay a quién colgarla en la central.'
                : 'No hay sesión con el sistema; conectate en Ajustes si la querés en la central.'}
            </div>
          )}
        </div>

        {msg && <div style={{ color: C.red, fontSize: 12, marginTop: 10, lineHeight: 1.45 }}>{msg}</div>}
        <button onClick={enviar} style={{ ...S.primary, marginTop: 14 }}>Guardar</button>
      </div>
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