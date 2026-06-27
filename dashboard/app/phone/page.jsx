'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { IconRefresh } from '@tabler/icons-react';
import { useSoftphone } from '../useSoftphone';
import Scratchpad from '../Scratchpad';
import { pushSupported, pushStatus, enablePush, disablePush, testPush } from '../push';
import {
  IconPhone, IconPhoneOff, IconBackspace, IconMicrophone, IconMicrophoneOff,
  IconGridDots, IconUser, IconSettings, IconSearch, IconPlus,
  IconPhoneIncoming, IconPhoneOutgoing, IconLogout, IconX, IconClockHour4, IconBell,
  IconPlayerPause, IconPlayerPlay, IconTransfer, IconCircleDot, IconCircleFilled, IconScreenShare, IconPencil, IconScreenShareOff, IconArrowForwardUp, IconUsersGroup, IconFileMusic, IconQrcode, IconCamera, IconVideo, IconVideoOff, IconLock, IconMapPin, IconVolume, IconVolume3, IconDeviceMobileVibration, IconVoicemail, IconMoonStars, IconPictureInPicture,
} from '@tabler/icons-react';

const CK = 'pbxng_contacts';
const loadC = () => { try { return JSON.parse(localStorage.getItem(CK) || '[]'); } catch (_) { return []; } };
const saveC = (c) => localStorage.setItem(CK, JSON.stringify(c));

function Timer({ since }) {
  const [t, setT] = useState(0);
  useEffect(() => { if (!since) { setT(0); return; } const i = setInterval(() => setT(Math.floor((Date.now() - since) / 1000)), 500); return () => clearInterval(i); }, [since]);
  return <span>{String(Math.floor(t / 60)).padStart(2, '0')}:{String(t % 60).padStart(2, '0')}</span>;
}
function Avatar({ name, size = 44, online }) {
  const ini = (name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <div style={{ width: size, height: size, borderRadius: '50%', background: 'linear-gradient(135deg,#9db4e0,#6d8fd6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: size * 0.36 }}>{ini}</div>
      {online !== undefined && <span style={{ position: 'absolute', right: -1, bottom: -1, width: size * 0.28, height: size * 0.28, borderRadius: '50%', background: online ? '#34c759' : '#c7c7cc', border: '2px solid #fff' }} />}
    </div>
  );
}

export default function Phone() {
  const wantAccept = useRef(false);
  const sp = useSoftphone();
  const [ext, setExt] = useState(''); const [pass, setPass] = useState(''); const [video, setVideo] = useState(false); const [scratch, setScratch] = useState(false); const [appVer, setAppVer] = useState(''); const [pendIn, setPendIn] = useState(null);
  const [tab, setTab] = useState('teclado'); const [dial, setDial] = useState(''); const [kp, setKp] = useState(false);
  const [contacts, setContacts] = useState([]); const [q, setQ] = useState('');
  const [addOpen, setAddOpen] = useState(false); const [nc, setNc] = useState({ name: '', number: '' });
  const [push, setPush] = useState('off'); const [pushBusy, setPushBusy] = useState(false);
  const [geoOn, setGeoOn] = useState(false);
  useEffect(() => { try { setGeoOn(localStorage.getItem('pbxng_geo') !== '0'); } catch (_) {} }, []);
  function toggleGeo() { if (geoOn) { localStorage.setItem('pbxng_geo', '0'); setGeoOn(false); notify('Ubicación desactivada'); } else { localStorage.setItem('pbxng_geo', '1'); setGeoOn(true); if (navigator.geolocation) navigator.geolocation.getCurrentPosition(() => notify('Ubicación activada'), () => notify('Permití la ubicación en el navegador'), { enableHighAccuracy: true, timeout: 8000 }); } }
  const [presence, setPresence] = useState({}); const [directory, setDirectory] = useState([]); const [cTab, setCTab] = useState('dir');
  const [xfer, setXfer] = useState(false); const [xferNum, setXferNum] = useState('');
  const [flash, setFlash] = useState(null); const fileInput = useRef(null);
  const [scan, setScan] = useState(''); const scanV = useRef(null); const scanRaf = useRef(null); const scanStream = useRef(null);
  const registered = sp.reg === 'registered'; const inCall = !!(sp.call || sp.callInfo);
  const established = sp.call === 'Established';
  const vid = !!sp.callInfo?.video;
  const callState = sp.held ? 'hold' : established ? 'talking' : 'ringing';
  const videoView = vid && established;
  const [ctl, setCtl] = useState(true); const ctlTimer = useRef(null);
  const showCtl = () => { setCtl(true); clearTimeout(ctlTimer.current); if (vid) ctlTimer.current = setTimeout(() => setCtl(false), 4500); };
  useEffect(() => { if (inCall) showCtl(); else { setCtl(true); clearTimeout(ctlTimer.current); } return () => clearTimeout(ctlTimer.current); }, [inCall, vid]);

  const notify = useCallback((text) => { setFlash(text); setTimeout(() => setFlash(null), 2600); }, []);
  const [gest, setGest] = useState(false);
  useEffect(() => { try { setGest(localStorage.getItem('pbxng_gest') !== '0'); } catch (_) {} }, []);
  async function toggleGest() {
    if (gest) { localStorage.setItem('pbxng_gest', '0'); setGest(false); notify('Gestos desactivados'); return; }
    try { if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') { const r = await DeviceMotionEvent.requestPermission(); if (r !== 'granted') { notify('Permiso de movimiento denegado'); return; } } } catch (_) {}
    localStorage.setItem('pbxng_gest', '1'); setGest(true); notify('Gestos activados');
  }
  // Gesto: boca abajo -> silencia (en llamada) o rechaza (entrante)
  const faceRef = useRef({ down: false, t: 0 });
  useEffect(() => {
    if (!gest) return;
    const onMotion = (e) => {
      const g = e.accelerationIncludingGravity; if (!g || g.z == null) return;
      const faceDown = g.z < -7.5; const now = Date.now();
      if (faceDown && !faceRef.current.down) { faceRef.current.down = true; faceRef.current.t = now; }
      else if (!faceDown && faceRef.current.down) { faceRef.current.down = false; }
      if (faceDown && faceRef.current.down && faceRef.current.t && now - faceRef.current.t > 700) {
        faceRef.current.t = 0; // disparar una vez por giro
        if (sp.incoming || pendIn) { wantAccept.current = false; sp.rejectIncoming?.(); setPendIn(null); try { navigator.vibrate && navigator.vibrate(120); } catch (_) {} notify('Llamada rechazada (boca abajo)'); }
        else if (established && !sp.muted) { sp.toggleMute(); try { navigator.vibrate && navigator.vibrate(60); } catch (_) {} notify('Micrófono silenciado (boca abajo)'); }
      }
    };
    window.addEventListener('devicemotion', onMotion);
    return () => window.removeEventListener('devicemotion', onMotion);
    // eslint-disable-next-line
  }, [gest, sp.incoming, pendIn, established, sp.muted]);
  const [vm, setVm] = useState([]); const [vmOpen, setVmOpen] = useState(false);
  const [dnd, setDnd] = useState(false);
  useEffect(() => { try { setDnd(localStorage.getItem('pbxng_dnd') === '1'); } catch (_) {} }, []);
  function toggleDnd() { const n = !dnd; setDnd(n); localStorage.setItem('pbxng_dnd', n ? '1' : '0'); notify(n ? 'No molestar activado' : 'No molestar desactivado'); }
  async function loadVm() { try { const d = await fetch('/backend/api/vm?ext=' + (sp.creds?.ext || '')).then(r => r.json()); setVm(Array.isArray(d) ? d : []); } catch (_) {} }
  useEffect(() => { if (!registered) return; loadVm(); const t = setInterval(loadVm, 20000); return () => clearInterval(t); }, [registered, sp.creds]);
  async function vmDel(m) { try { await fetch('/backend/api/vm/del', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext: sp.creds?.ext, folder: m.folder, id: m.id }) }); } catch (_) {} setVm(v => v.filter(x => x.id !== m.id)); }
  async function doPip() { try { const v = sp.remoteVideoRef.current; if (!v) return; if (document.pictureInPictureElement) await document.exitPictureInPicture(); else if (document.pictureInPictureEnabled) await v.requestPictureInPicture(); } catch (_) {} }
  const vmNew = vm.filter(m => m.new).length;
  useEffect(() => { if (dnd && sp.incoming) sp.rejectIncoming?.(); }, [dnd, sp.incoming]);
  useEffect(() => { if (dnd && pendIn && !pendIn.missed) { wantAccept.current = false; sp.rejectIncoming?.(); setPendIn(null); } }, [dnd, pendIn]);
  useEffect(() => { setContacts(loadC()); }, []);
  useEffect(() => { if (registered && localStorage.getItem('pbxng_geo') !== '0' && navigator.geolocation) { navigator.geolocation.getCurrentPosition(() => {}, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 }); } }, [registered]);
  useEffect(() => { fetch('/version.json?ts=' + Date.now(), { cache: 'no-store' }).then(r => r.json()).then(d => setAppVer(d.version || '')).catch(() => {}); }, []);
  // Llamada entrante abierta desde la notificación push (?incall=) -> pantalla full-screen
  useEffect(() => {
    try { const q = new URLSearchParams(location.search); if (q.has('incall')) { setPendIn({ from: q.get('incall') || 'Llamada' }); history.replaceState(null, '', location.pathname); } } catch (_) {}
  }, []);
  // Cuando llega el INVITE real, la pantalla real toma el control; auto-acepta si el usuario ya tocó Atender
  useEffect(() => { if (sp.incoming) { setPendIn(null); if (wantAccept.current) { wantAccept.current = false; setTimeout(() => sp.acceptIncoming?.(), 120); } } }, [sp.incoming]);
  // Cuando se establece o termina, limpia el pendiente
  useEffect(() => { if (inCall) setPendIn(null); }, [inCall]);
  // Tono + vibración mientras suena el pendiente (sin INVITE todavía)
  useEffect(() => {
    if (!pendIn || pendIn.missed || sp.incoming) return;
    let stop = false; let ac = null;
    const vib = () => { if (!stop) { try { navigator.vibrate && navigator.vibrate([500, 250, 500, 250, 700]); } catch (_) {} } };
    const beep = () => { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(); const g = ac.createGain(); o.frequency.value = 480; o.connect(g); g.connect(ac.destination); g.gain.setValueAtTime(0.0001, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.9); o.start(); o.stop(ac.currentTime + 1); } catch (_) {} };
    vib(); beep();
    const iv = setInterval(() => { vib(); beep(); }, 2600);
    const to = setTimeout(() => setPendIn(p => p ? { ...p, missed: true } : p), 35000);
    return () => { stop = true; clearInterval(iv); clearTimeout(to); try { navigator.vibrate && navigator.vibrate(0); } catch (_) {} try { ac && ac.close(); } catch (_) {} };
  }, [pendIn, sp.incoming]);
  async function buscarUpdate() { try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (_) {} try { const r = await navigator.serviceWorker?.getRegistration(); await r?.update(); } catch (_) {} notify('Buscando actualización…'); setTimeout(() => { try { location.reload(); } catch (_) {} }, 600); }

  // Presencia: estado online de los internos (para los contactos)
  useEffect(() => {
    if (!registered) return;
    let live = true;
    const load = () => fetch('/backend/api/directory').then(r => r.json()).then(d => { if (!live) return; const arr = Array.isArray(d) ? d : []; setDirectory(arr); const m = {}; arr.forEach(x => m[x.ext] = x.status); setPresence(m); }).catch(() => {});
    load(); const t = setInterval(load, 10000);
    return () => { live = false; clearInterval(t); };
  }, [registered]);

  // Push + acciones del service worker
  useEffect(() => { pushStatus().then(setPush); }, []);
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    const onMsg = (ev) => {
      const d = ev.data || {};
      if (d.kind === 'incoming') {
        if (d.decline) { wantAccept.current = false; sp.rejectIncoming?.(); setPendIn(null); return; }
        if (d.autoAccept) wantAccept.current = true;
        setPendIn({ from: d.from || 'Llamada' });
        return;
      }
      if (d.kind !== 'push-action') return;
      if (d.action === 'answer') { wantAccept.current = true; sp.acceptIncoming?.(); }
      else if (d.action === 'reject') sp.rejectIncoming?.();
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [sp]);
  useEffect(() => {
    if (registered && sp.creds?.ext && pushSupported() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      enablePush(sp.creds.ext).then(() => setPush('on')).catch(() => {});
    }
  }, [registered, sp.creds]);

  async function togglePush() {
    if (pushBusy) return; setPushBusy(true);
    try {
      if (push === 'on') { await disablePush(); setPush('off'); notify('Notificaciones desactivadas'); }
      else { await enablePush(sp.creds?.ext); setPush('on'); notify('Notificaciones activadas'); }
    } catch (e) { notify('No se pudo activar'); }
    finally { setPushBusy(false); }
  }
  async function probarPush() { try { await testPush(sp.creds?.ext); notify('Notificación de prueba enviada'); } catch (_) {} }

  async function doRecord() { const r = await sp.toggleRecord(); notify(r && r.error ? 'No se pudo grabar' : (sp.recording ? 'Grabación detenida' : 'Grabando llamada')); }
  async function doTransfer() { const n = xferNum; const ok = await sp.transfer(n); setXfer(false); setXferNum(''); notify(ok ? 'Transferida a ' + n : 'No se pudo transferir'); }
  async function doAttended() { const n = xferNum; setXfer(false); setXferNum(''); const ok = await sp.attendedCall(n); notify(ok ? 'Consultando a ' + n + '…' : 'No se pudo consultar'); }
  async function doConf() { const n = xferNum; setXfer(false); setXferNum(''); const r = await fetch('/backend/api/calls/conference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ext: sp.creds?.ext, third: n }) }).then(x => x.json()).catch(() => ({ error: 1 })); notify(r.error ? 'No se pudo conferenciar' : 'Sumando a ' + n + ' a la conferencia'); }
  async function doShare() { const r = await sp.shareScreen(); if (r && r.error && r.error !== 'cancelado') notify(r.error); }
  async function onFile(e) { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return; const r = await sp.shareFile(f); notify(r && r.error ? r.error : 'Compartiendo ' + f.name); }

  async function handleScan(data) {
    let token = data;
    try { const u = new URL(data); token = u.searchParams.get('token') || data; } catch (_) {}
    setScan('');
    try {
      const d = await fetch('/backend/api/enroll/' + token).then(r => r.json());
      if (!d || d.error) { notify('QR inválido o expirado'); return; }
      sp.connect(d.ext, d.password, false).catch(() => {});
    } catch (_) { notify('No se pudo leer el QR'); }
  }
  useEffect(() => {
    if (scan !== 'on') return;
    let active = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        scanStream.current = stream;
        const v = scanV.current; if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
        const jsQR = (await import('jsqr')).default;
        const cv = document.createElement('canvas'); const ctx = cv.getContext('2d', { willReadFrequently: true });
        const tick = () => {
          if (!active) return;
          const v2 = scanV.current;
          if (v2 && v2.readyState >= 2 && v2.videoWidth) {
            cv.width = v2.videoWidth; cv.height = v2.videoHeight;
            ctx.drawImage(v2, 0, 0, cv.width, cv.height);
            const img = ctx.getImageData(0, 0, cv.width, cv.height);
            const code = jsQR(img.data, img.width, img.height);
            if (code && code.data) { handleScan(code.data); return; }
          }
          scanRaf.current = requestAnimationFrame(tick);
        };
        scanRaf.current = requestAnimationFrame(tick);
      } catch (e) { notify('No se pudo abrir la cámara'); setScan(''); }
    })();
    return () => { active = false; if (scanRaf.current) cancelAnimationFrame(scanRaf.current); if (scanStream.current) { scanStream.current.getTracks().forEach(t => t.stop()); scanStream.current = null; } };
  }, [scan]);

  function press(k) { sp.tone(k); if (!inCall) setDial(d => d + k); }
  function addContact() { if (!nc.name || !nc.number) return; const c = [...contacts, { id: Date.now(), ...nc }].sort((a, b) => a.name.localeCompare(b.name)); setContacts(c); saveC(c); setNc({ name: '', number: '' }); setAddOpen(false); }
  function delContact(id) { const c = contacts.filter(x => x.id !== id); setContacts(c); saveC(c); }
  function callNum(n, video) { setTab('teclado'); sp.placeCall(n, video); }
  const isOnline = (num) => { const st = presence[String(num)]; return st === 'online' || st === 'in_call'; };
  const statusOf = (num) => presence[String(num)] || 'offline';
  const stLabel = { online: 'En línea', in_call: 'En llamada', offline: 'Desconectado' };
  const stColor = { online: '#34c759', in_call: '#f59e0b', offline: '#c7c7cc' };

  if (!registered) {
    return (
      <div style={S.loginWrap}>
        <div style={S.loginCard}>
          <svg width="56" height="56" viewBox="0 0 48 48"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5b8fd6" /><stop offset="1" stopColor="#1e40af" /></linearGradient></defs><path d="M24 2 L42 9 V25 C42 36 34 43 24 46 C14 43 6 36 6 25 V9 Z" fill="url(#lg)" /><text x="24" y="30" textAnchor="middle" fontWeight="800" fontSize="15" fill="#fff">IES</text></svg>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 14 }}>PBX-NG Phone</div>
          <div style={{ color: '#8e8e93', marginBottom: 22, fontSize: 14 }}>{sp.reg === 'connecting' ? 'Conectando…' : 'Iniciá sesión con tu interno'}</div>
          <input placeholder="Interno (ej 9100)" value={ext} onChange={e => setExt(e.target.value)} style={S.linp} />
          <input placeholder="Contraseña SIP" type="password" value={pass} onChange={e => setPass(e.target.value)} style={S.linp} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#3c3c43', fontSize: 14, alignSelf: 'flex-start', margin: '4px 0 14px' }}><input type="checkbox" checked={video} onChange={e => setVideo(e.target.checked)} /> Habilitar video</label>
          <button onClick={() => sp.connect(ext, pass, video).catch(() => {})} style={S.lbtn}>{sp.reg === 'connecting' ? 'Conectando…' : 'Conectar'}</button>
          <button onClick={() => setScan('on')} style={S.lbtn2}><IconQrcode size={18} /> Escanear QR</button>
        </div>
        {scan === 'on' &&
          <div style={S.scanWrap}>
            <video ref={scanV} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
            <div style={S.scanFrame} />
            <div style={{ position: 'absolute', top: 40, left: 0, right: 0, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: 600, textShadow: '0 1px 4px rgba(0,0,0,.6)' }}>Apuntá al código QR</div>
            <button onClick={() => setScan('')} style={S.scanClose}><IconX size={22} color="#fff" /></button>
          </div>}
      </div>
    );
  }

  const fc = contacts.filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.number.includes(q))
    .sort((a, b) => (isOnline(b.number) - isOnline(a.number)) || a.name.localeCompare(b.name));
  const onlineCount = contacts.filter(c => isOnline(c.number)).length;
  const fd = directory.filter(d => d.ext !== sp.creds?.ext && (!q || d.ext.includes(q) || (d.name || '').toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => ((b.status !== 'offline') - (a.status !== 'offline')) || (a.name || a.ext).localeCompare(b.name || b.ext));

  return (
    <div style={S.app}>
      <div style={S.statusbar}><span style={{ color: registered ? '#34c759' : '#8e8e93', fontWeight: 600 }}>●</span> Interno {sp.creds?.ext} · {registered ? 'en línea' : sp.reg}{dnd && <span style={{ marginLeft: 8, color: '#ff9500', fontWeight: 600 }}>· No molestar</span>}</div>
      {flash && <div style={S.flash}>{flash}</div>}
      <div className="ph-view" key={tab} style={S.body}>
        {tab === 'teclado' && (
          <div style={S.dialWrap}>
            <div style={S.numDisplay}>{dial || <span style={{ color: '#c7c7cc' }}>&nbsp;</span>}</div>
            <div style={S.keypad}>
              {[['1', ''], ['2', 'A B C'], ['3', 'D E F'], ['4', 'G H I'], ['5', 'J K L'], ['6', 'M N O'], ['7', 'P Q R S'], ['8', 'T U V'], ['9', 'W X Y Z'], ['*', ''], ['0', '+'], ['#', '']].map(([k, s]) => (
                <button key={k} className="ph-key" style={S.ioskey} onClick={() => press(k)}><span style={{ fontSize: 32, fontWeight: 400, lineHeight: 1 }}>{k}</span><span style={{ fontSize: 9, letterSpacing: 1, color: '#3c3c43', marginTop: 2, height: 9 }}>{s}</span></button>
              ))}
            </div>
            <div style={S.dialRow}>
              <button style={{ ...S.callSec, opacity: dial ? 1 : 0.35 }} onClick={() => dial && sp.placeCall(dial, true)}><IconVideo size={24} color="#fff" /></button>
              <button style={S.callGreen} onClick={() => sp.placeCall(dial, false)}><IconPhone size={32} color="#fff" fill="#fff" /></button>
              <button style={{ width: 56, height: 56, border: 'none', background: 'none', cursor: dial ? 'pointer' : 'default', color: dial ? '#000' : 'transparent' }} onClick={() => setDial(d => d.slice(0, -1))}><IconBackspace size={26} /></button>
            </div>
          </div>
        )}
        {tab === 'llamadas' && <>
          <div style={{ ...S.crow, marginTop: 4 }} onClick={() => setVmOpen(true)}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: vmNew ? '#ff3b30' : '#8e8e93', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><IconVoicemail size={22} color="#fff" /></div>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 16 }}>Buzon de voz</div><div style={{ fontSize: 13, color: vmNew ? '#ff3b30' : '#8e8e93' }}>{vm.length ? (vmNew ? vmNew + ' nuevo(s) - ' : '') + vm.length + ' mensaje(s)' : 'Sin mensajes'}</div></div>
            <span style={{ color: '#c7c7cc', fontSize: 20 }}>&rsaquo;</span>
          </div>
          <Recents hist={sp.hist} onCall={callNum} contacts={contacts} />
        </>}
        {tab === 'contactos' && (
          <div style={{ padding: '0 0 8px' }}>
            <div style={S.head}><div style={S.title}>Contactos</div>{cTab === 'mis' && <button style={S.addBtn} onClick={() => setAddOpen(true)}><IconPlus size={22} color="#007aff" /></button>}</div>
            <div style={S.seg}>
              <button style={{ ...S.segBtn, ...(cTab === 'dir' ? S.segOn : {}) }} onClick={() => setCTab('dir')}>Directorio</button>
              <button style={{ ...S.segBtn, ...(cTab === 'mis' ? S.segOn : {}) }} onClick={() => setCTab('mis')}>Mis contactos</button>
            </div>
            <div style={S.searchBox}><IconSearch size={16} color="#8e8e93" /><input placeholder="Buscar" value={q} onChange={e => setQ(e.target.value)} style={S.searchInp} /></div>
            {cTab === 'dir' ? (
              fd.length === 0 ? <div style={S.empty}>Sin internos en el directorio.</div> :
                fd.map(d => (
                  <div key={d.ext} style={S.crow} onClick={() => callNum(d.ext)}>
                    <Avatar name={d.name || d.ext} online={d.status === 'online' || d.status === 'in_call'} />
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 16 }}>{d.name || ('Interno ' + d.ext)}</div><div style={{ fontSize: 13, color: stColor[d.status] === '#c7c7cc' ? '#8e8e93' : stColor[d.status] }}>{(stLabel[d.status] || 'Desconectado') + ' · ' + d.ext}</div></div>
                    <button style={S.iconBtn} onClick={(e) => { e.stopPropagation(); callNum(d.ext, true); }}><IconVideo size={18} color="#007aff" /></button>
                    <button style={S.iconBtn} onClick={(e) => { e.stopPropagation(); callNum(d.ext); }}><IconPhone size={20} color="#34c759" /></button>
                  </div>
                ))
            ) : (
              fc.length === 0 ? <div style={S.empty}>{contacts.length ? 'Sin resultados.' : 'Agregá tu primer contacto con +'}</div> :
                fc.map(c => (
                  <div key={c.id} style={S.crow}>
                    <Avatar name={c.name} online={isOnline(c.number)} />
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 16 }}>{c.name}</div><div style={{ color: isOnline(c.number) ? stColor[statusOf(c.number)] : '#8e8e93', fontSize: 13 }}>{isOnline(c.number) ? stLabel[statusOf(c.number)] + ' · ' + c.number : c.number}</div></div>
                    <button style={S.iconBtn} onClick={() => callNum(c.number, true)}><IconVideo size={18} color="#007aff" /></button>
                    <button style={S.iconBtn} onClick={() => callNum(c.number)}><IconPhone size={20} color="#34c759" /></button>
                    <button style={S.iconBtn} onClick={() => delContact(c.id)}><IconX size={18} color="#ff3b30" /></button>
                  </div>
                ))
            )}
          </div>
        )}
        {tab === 'ajustes' && (
          <div style={{ padding: '8px 0' }}>
            <div style={S.title}>Ajustes</div>
            <div style={S.aSection}>
              <div style={S.aRow}><span>Interno</span><b>{sp.creds?.ext}</b></div>
              <div style={S.aRow}><span>Estado</span><b style={{ color: '#34c759' }}>{registered ? 'En línea' : sp.reg}</b></div>
              <div style={S.aRow}><span>Video</span><b>{sp.creds?.video ? 'Sí' : 'No'}</b></div>
              <div style={S.aRow}><span>Servidor</span><b style={{ fontSize: 12 }}>pbx.ies.com.uy</b></div>
              <div style={{ ...S.aRow, borderBottom: 'none' }}><span>Versión</span><b style={{ fontSize: 12, color: '#8e8e93' }}>{appVer || '—'}</b></div>
            </div>
            <button style={{ ...S.logout, color: '#007aff', marginBottom: 10 }} onClick={buscarUpdate}><IconRefresh size={18} /> Buscar actualizaciones</button>
            <div style={S.aSection}>
              <div style={{ ...S.aRow, borderBottom: push === 'on' ? '1px solid #e5e5ea' : 'none' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><IconBell size={18} color="#007aff" /> Notificaciones push</span>
                {push === 'unsupported' ? <b style={{ color: '#8e8e93' }}>No disponible</b> :
                  push === 'denied' ? <b style={{ color: '#ff3b30' }}>Bloqueadas</b> :
                    <button onClick={togglePush} disabled={pushBusy} style={{ ...S.toggle, background: push === 'on' ? '#34c759' : '#e5e5ea' }}><span style={{ ...S.knob, transform: push === 'on' ? 'translateX(20px)' : 'translateX(0)' }} /></button>}
              </div>
              {push === 'on' && <div style={{ ...S.aRow, cursor: 'pointer', borderBottom: 'none' }} onClick={probarPush}><span>Probar notificación</span><b style={{ color: '#007aff' }}>Enviar</b></div>}
            </div>
            <div style={S.aSection}>
              <div style={{ ...S.aRow, cursor: 'pointer', borderBottom: 'none' }} onClick={() => sp.tone('5')}><span>Probar tono</span><b style={{ color: '#007aff' }}>Sonar</b></div>
            </div>
            <div style={S.aSection}>
              <div style={{ ...S.aRow, borderBottom: '1px solid #e5e5ea' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><IconMapPin size={18} color="#34c759" /> Compartir ubicación en llamadas</span>
                <button onClick={toggleGeo} style={{ ...S.toggle, background: geoOn ? '#34c759' : '#e5e5ea' }}><span style={{ ...S.knob, transform: geoOn ? 'translateX(20px)' : 'translateX(0)' }} /></button>
              </div>
              <div style={{ ...S.aRow, borderBottom: '1px solid #e5e5ea' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><IconDeviceMobileVibration size={18} color="#007aff" /> Gestos (boca abajo: silenciar / rechazar)</span>
                <button onClick={toggleGest} style={{ ...S.toggle, background: gest ? '#34c759' : '#e5e5ea' }}><span style={{ ...S.knob, transform: gest ? 'translateX(20px)' : 'translateX(0)' }} /></button>
              </div>
              <div style={{ ...S.aRow, borderBottom: 'none' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><IconMoonStars size={18} color="#ff9500" /> No molestar (rechaza entrantes)</span>
                <button onClick={toggleDnd} style={{ ...S.toggle, background: dnd ? '#ff9500' : '#e5e5ea' }}><span style={{ ...S.knob, transform: dnd ? 'translateX(20px)' : 'translateX(0)' }} /></button>
              </div>
            </div>
            <button style={S.logout} onClick={sp.disconnect}><IconLogout size={18} /> Cerrar sesión</button>
          </div>
        )}
      </div>

      <div style={S.tabbar}>
        {[['llamadas', IconClockHour4, 'Llamadas'], ['contactos', IconUser, 'Contactos'], ['teclado', IconGridDots, 'Teclado'], ['ajustes', IconSettings, 'Ajustes']].map(([id, Ic, lbl]) => (
          <button key={id} className="ph-tab" style={{ ...S.tabBtn, color: tab === id ? '#007aff' : '#8e8e93', position: 'relative' }} onClick={() => setTab(id)}><Ic size={24} />{id === 'llamadas' && vmNew > 0 && <span style={{ position: 'absolute', top: 4, left: 'calc(50% + 6px)', minWidth: 16, height: 16, borderRadius: 8, background: '#ff3b30', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{vmNew}</span>}<span style={{ fontSize: 10.5, marginTop: 2 }}>{lbl}</span></button>
        ))}
      </div>

      {addOpen &&
        <div style={S.modalWrap} onClick={() => setAddOpen(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 14 }}>Nuevo contacto</div>
            <input placeholder="Nombre" value={nc.name} onChange={e => setNc(s => ({ ...s, name: e.target.value }))} style={S.minp} />
            <input placeholder="Número / interno" value={nc.number} onChange={e => setNc(s => ({ ...s, number: e.target.value }))} style={S.minp} />
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button style={{ ...S.mbtn, background: '#e5e5ea', color: '#000' }} onClick={() => setAddOpen(false)}>Cancelar</button>
              <button style={{ ...S.mbtn, background: '#007aff', color: '#fff' }} onClick={addContact}>Guardar</button>
            </div>
          </div>
        </div>}

      {inCall &&
        <div className="ph-overlay" style={videoView ? S.callScreenV : S.callScreen}>
          {vid &&
            <div onClick={videoView ? () => (ctl ? setCtl(false) : showCtl()) : undefined} style={{ position: 'absolute', inset: 0, background: '#000', zIndex: 0, opacity: videoView ? 1 : 0, pointerEvents: videoView ? 'auto' : 'none' }}>
              <video ref={sp.remoteVideoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <video ref={sp.localVideoRef} autoPlay playsInline muted style={{ position: 'absolute', right: 12, top: 'calc(env(safe-area-inset-top, 12px) + 8px)', width: 96, borderRadius: 14, border: '2px solid rgba(255,255,255,.65)', boxShadow: '0 4px 16px rgba(0,0,0,.4)', display: videoView ? 'block' : 'none' }} />
            </div>}

          {(!videoView || ctl) &&
            <div style={videoView ? S.vTop : { position: 'relative', textAlign: 'center', marginTop: '6vh', zIndex: 2 }}>
              {!videoView && <CallAvatar name={sp.callInfo?.number} state={callState} />}
              <div style={{ fontSize: videoView ? 19 : 28, fontWeight: 600, marginTop: videoView ? 0 : 18 }}>{sp.callInfo?.number}</div>
              <div style={{ color: 'rgba(255,255,255,.85)', marginTop: videoView ? 2 : 6, display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', fontSize: videoView ? 13 : 15 }}>
                {sp.held ? 'En espera' : established ? <Timer since={sp.callInfo?.since} /> : (sp.callInfo?.dir === 'in' ? (vid ? 'Videollamada entrante…' : 'Entrante…') : 'Llamando…')}
                {established && sp.quality && <SignalBars q={sp.quality} />}
                {sp.recording && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#ff453a' }}><IconCircleFilled size={9} className="pbx-pulse" /> REC</span>}
                {sp.filePlaying && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconFileMusic size={12} /> {sp.filePlaying.name}</span>}
              </div>
              {!videoView && established && !sp.held && <Equalizer />}
            </div>}

          {kp && <div style={{ ...S.keypad, position: 'relative', zIndex: 3, maxWidth: 280, margin: '18px auto 0' }}>{['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(k => <button key={k} className="ph-key" style={{ ...S.ioskey, background: 'rgba(255,255,255,.18)', color: '#fff', width: 62, height: 62 }} onClick={() => sp.tone(k)}><span style={{ fontSize: 24 }}>{k}</span></button>)}</div>}

          {(!videoView || ctl) && !kp &&
            <div style={videoView ? S.vCtl : S.ctlGrid}>
              <Ctl icon={sp.muted ? <IconMicrophoneOff size={26} /> : <IconMicrophone size={26} />} label="Silenciar" active={sp.muted} onClick={sp.toggleMute} />
              <Ctl icon={sp.speaker ? <IconVolume size={26} /> : <IconVolume3 size={26} />} label="Altavoz" active={sp.speaker} onClick={sp.toggleSpeaker} />
              <Ctl icon={sp.held ? <IconPlayerPlay size={26} /> : <IconPlayerPause size={26} />} label={sp.held ? 'Reanudar' : 'En espera'} active={sp.held} onClick={sp.toggleHold} disabled={!established} />
              <Ctl icon={<IconCircleDot size={26} />} label="Grabar" active={sp.recording} activeColor="#ff453a" onClick={doRecord} disabled={!established} />
              <Ctl icon={<IconGridDots size={26} />} label="Teclado" active={kp} onClick={() => setKp(v => !v)} disabled={!established} />
              <Ctl icon={<IconTransfer size={26} />} label="Transferir" onClick={() => setXfer(true)} disabled={!established} />
              {vid &&
                <Ctl icon={<IconPictureInPicture size={26} />} label="Mini" onClick={doPip} disabled={!established} />}
              {vid &&
                <Ctl icon={sp.sharing ? <IconScreenShareOff size={26} /> : <IconScreenShare size={26} />} label={sp.sharing ? 'Dejar pantalla' : 'Pantalla'} active={sp.sharing} onClick={doShare} disabled={!established} />}
              {vid &&
                <Ctl icon={<IconPencil size={26} />} label="Pizarra" active={scratch} onClick={() => setScratch(v => !v)} disabled={!established} />}
              <Ctl icon={<IconFileMusic size={26} />} label={sp.filePlaying ? 'Detener' : 'Archivo'} active={!!sp.filePlaying} onClick={() => sp.filePlaying ? sp.stopFile() : fileInput.current && fileInput.current.click()} disabled={!established} />
            </div>}

          {(!videoView || ctl) &&
            <div style={videoView ? S.vHang : { position: 'relative', display: 'flex', justifyContent: 'center', gap: 26, marginTop: 'auto', marginBottom: 46 }}>
              {kp && <CScreenBtn bg="rgba(255,255,255,.2)" fg="#fff" onClick={() => setKp(false)}><IconGridDots size={26} /></CScreenBtn>}
              <CScreenBtn bg="#ff3b30" fg="#fff" big onClick={sp.hangup}><IconPhoneOff size={30} /></CScreenBtn>
            </div>}

          {sp.attended &&
            <div style={S.attBanner}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, opacity: .7 }}>Consulta</div>
                <div style={{ fontWeight: 700 }}>{sp.attended.number}</div>
                <div style={{ fontSize: 12, opacity: .8 }}>{sp.attended.state === 'talking' ? 'En línea — listo para transferir' : 'Llamando…'}</div>
              </div>
              <button style={{ ...S.attBtn, background: '#34c759' }} onClick={sp.completeAttended} disabled={sp.attended.state !== 'talking'}><IconArrowForwardUp size={20} color="#fff" /></button>
              <button style={{ ...S.attBtn, background: '#ff3b30' }} onClick={sp.cancelAttended}><IconX size={20} color="#fff" /></button>
            </div>}

          {scratch && established && vid &&
            <Scratchpad room={[sp.creds?.ext, sp.callInfo?.number].filter(Boolean).sort().join('-')} onClose={() => setScratch(false)} />}

          {xfer &&
            <div style={S.modalWrap} onClick={() => setXfer(false)}>
              <div style={S.modal} onClick={e => e.stopPropagation()}>
                <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6, color: '#000' }}>Transferir o conferenciar</div>
                <div style={{ color: '#8e8e93', fontSize: 13, marginBottom: 12 }}>Ingresá el interno o número de destino.</div>
                <input autoFocus placeholder="Destino (ej 9102)" value={xferNum} onChange={e => setXferNum(e.target.value)} style={S.minp} />
                <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                  <button style={{ ...S.mbtn, background: '#eef1f7', color: '#1f2733' }} onClick={doTransfer} disabled={!xferNum}>Ciega</button>
                  <button style={{ ...S.mbtn, background: '#007aff', color: '#fff' }} onClick={doAttended} disabled={!xferNum}>Atendida</button>
                </div>
                <button style={{ ...S.mbtn, width: '100%', marginTop: 10, background: '#34c759', color: '#fff' }} onClick={doConf} disabled={!xferNum}>Conferencia a 3</button>
                <div style={{ fontSize: 11.5, color: '#8e8e93', marginTop: 8 }}>Ciega: pasa al instante. Atendida: hablás antes de confirmar. Conferencia: suma al tercero a la llamada actual.</div>
              </div>
            </div>}
        </div>}

      {sp.incoming && !inCall &&
        <div className="ph-overlay" style={{ ...S.callScreen, justifyContent: 'space-between' }}>
          <div style={{ textAlign: 'center', marginTop: 'calc(env(safe-area-inset-top, 20px) + 60px)' }}>
            <div style={S.inLabel}>{sp.incomingVideo ? <><IconVideo size={14} /> Videollamada entrante</> : <><IconPhoneIncoming size={14} /> Llamada entrante</>}</div>
            <CallAvatar name={(sp.incoming.remoteIdentity?.uri?.user) || '?'} state="ringing" />
            <div style={{ fontSize: 30, fontWeight: 600, marginTop: 18 }}>{sp.incoming.remoteIdentity?.uri?.user || 'Llamada'}</div>
            <div style={{ color: 'rgba(255,255,255,.6)', marginTop: 6, fontSize: 14 }}>PBX-NG · IES</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-around', width: '100%', maxWidth: 360, marginBottom: 'calc(env(safe-area-inset-bottom, 20px) + 36px)' }}>
            <div style={{ textAlign: 'center' }}><CScreenBtn bg="#ff3b30" fg="#fff" big onClick={sp.rejectIncoming}><IconPhoneOff size={30} /></CScreenBtn><div style={{ marginTop: 8, fontSize: 13 }}>Rechazar</div></div>
            {sp.incomingVideo &&
              <div style={{ textAlign: 'center' }}><CScreenBtn bg="#007aff" fg="#fff" big onClick={() => sp.acceptIncoming(true)}><IconVideo size={28} /></CScreenBtn><div style={{ marginTop: 8, fontSize: 13 }}>Video</div></div>}
            <div style={{ textAlign: 'center' }}><CScreenBtn bg="#34c759" fg="#fff" big onClick={() => sp.acceptIncoming(false)} className="ph-ring"><IconPhone size={30} fill="#fff" /></CScreenBtn><div style={{ marginTop: 8, fontSize: 13 }}>{sp.incomingVideo ? 'Audio' : 'Aceptar'}</div></div>
          </div>
        </div>}
      {pendIn && !sp.incoming && !inCall &&
        <div className="ph-overlay" style={{ ...S.callScreen, justifyContent: 'space-between' }}>
          {pendIn.missed ?
            <>
              <div style={{ textAlign: 'center', marginTop: 90 }}><CallAvatar name={pendIn.from} state="hold" /><div style={{ fontSize: 28, fontWeight: 600, marginTop: 18 }}>{pendIn.from}</div><div style={{ color: '#ff6b6b', marginTop: 6 }}>Llamada perdida</div></div>
              <div style={{ marginBottom: 60 }}><CScreenBtn bg="rgba(255,255,255,.2)" fg="#fff" big onClick={() => setPendIn(null)}><IconX size={28} /></CScreenBtn></div>
            </>
            :
            <>
              <div style={{ textAlign: 'center', marginTop: 70 }}><CallAvatar name={pendIn.from} state="ringing" /><div style={{ fontSize: 28, fontWeight: 600, marginTop: 18 }}>{pendIn.from}</div><div style={{ color: 'rgba(255,255,255,.7)', marginTop: 6 }}>Llamada entrante…</div>{pendIn.connecting && <div style={{ color: 'rgba(255,255,255,.5)', marginTop: 4, fontSize: 12 }}>Conectando…</div>}</div>
              <div style={{ display: 'flex', justifyContent: 'space-around', width: '100%', marginBottom: 50 }}>
                <div style={{ textAlign: 'center' }}><CScreenBtn bg="#ff3b30" fg="#fff" big onClick={() => { wantAccept.current = false; sp.rejectIncoming?.(); setPendIn(null); }}><IconPhoneOff size={30} /></CScreenBtn><div style={{ marginTop: 8, fontSize: 13 }}>Rechazar</div></div>
                <div style={{ textAlign: 'center' }}><CScreenBtn bg="#34c759" fg="#fff" big onClick={() => { if (sp.incoming) { sp.acceptIncoming(); setPendIn(null); } else { wantAccept.current = true; setPendIn(p => p ? { ...p, connecting: true } : p); } }}><IconPhone size={30} fill="#fff" /></CScreenBtn><div style={{ marginTop: 8, fontSize: 13 }}>Aceptar</div></div>
              </div>
            </>}
        </div>}

      {vmOpen &&
        <div className="ph-overlay" style={S.vmWrap}>
          <div style={S.vmHead}><button style={S.vmBack} onClick={() => setVmOpen(false)}>&lsaquo; Volver</button><div style={{ fontWeight: 700, fontSize: 17 }}>Buzon de voz</div><div style={{ width: 64 }} /></div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 14px' }}>
            {vm.length === 0 ? <div style={S.empty}>No tenes mensajes de voz.</div> :
              vm.map(m => (
                <div key={m.folder + m.id} style={S.vmRow}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: m.new ? '#ff3b30' : '#c7c7cc', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><IconVoicemail size={18} color="#fff" /></div>
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{m.callerid || 'Desconocido'}{m.new && <span style={{ color: '#ff3b30', marginLeft: 6, fontSize: 12 }}>nuevo</span>}</div><div style={{ fontSize: 12, color: '#8e8e93' }}>{m.origtime ? new Date(m.origtime * 1000).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''} - {m.duration}s</div></div>
                    <button style={S.iconBtn} onClick={() => vmDel(m)}><IconTrash size={16} color="#ff3b30" /></button>
                  </div>
                  <audio controls preload="none" style={{ width: '100%', height: 34, marginTop: 8 }} src={'/backend/api/vm/audio?ext=' + (sp.creds?.ext || '') + '&folder=' + m.folder + '&id=' + m.id} />
                </div>
              ))}
          </div>
        </div>}
      <audio ref={sp.audioRef} autoPlay />
      <input ref={fileInput} type="file" accept="audio/*,video/*" style={{ display: 'none' }} onChange={onFile} />
    </div>
  );
}

function Ctl({ icon, label, active, activeColor, onClick, disabled }) {
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled} className="ph-key" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', color: '#fff', opacity: disabled ? 0.38 : 1, transition: 'opacity .2s' }}>
      <span style={{ width: 64, height: 64, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: active ? (activeColor || '#fff') : 'rgba(255,255,255,.18)', color: active ? (activeColor ? '#fff' : '#000') : '#fff', backdropFilter: 'blur(8px)', transition: 'all .15s' }}>{icon}</span>
      <span style={{ fontSize: 12 }}>{label}</span>
    </button>
  );
}
function SignalBars({ q }) {
  const colors = { 1: '#ff3b30', 2: '#ff9500', 3: '#ffcc00', 4: '#34c759' };
  const c = colors[q.score] || '#8e8e93';
  const txt = { 1: 'Mala', 2: 'Regular', 3: 'Buena', 4: 'Excelente' }[q.score] || '';
  return (
    <span title={'Calidad: ' + txt + (q.rtt != null ? ' · ' + q.rtt + ' ms' : '') + (q.loss ? ' · ' + q.loss + '% pérdida' : '')} style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14 }}>
      {[1, 2, 3, 4].map(i => <span key={i} style={{ width: 3.5, height: 4 + i * 2.6, borderRadius: 1, background: i <= q.score ? c : 'rgba(255,255,255,.3)' }} />)}
    </span>
  );
}
function Equalizer({ color = '#34c759' }) {
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center', justifyContent: 'center', height: 30, marginTop: 14 }}>
      {[0, 1, 2, 3, 4, 5, 6].map(i => (
        <span key={i} style={{ width: 5, height: 30, borderRadius: 3, background: 'linear-gradient(180deg,#5ac8fa,' + color + ')', transformOrigin: 'center', animation: 'phEq ' + (0.7 + (i % 3) * 0.18) + 's ease-in-out ' + (i * 0.09) + 's infinite' }} />
      ))}
    </div>
  );
}
function CallAvatar({ name, state, size = 116 }) {
  const ini = (name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const ringing = state === 'ringing';
  const talking = state === 'talking';
  return (
    <div style={{ position: 'relative', width: size + 70, height: size + 70, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>
      {ringing && [0, 1, 2].map(i => (
        <span key={i} style={{ position: 'absolute', width: size, height: size, borderRadius: '50%', border: '2px solid rgba(120,170,255,.55)', animation: 'phRipple 2.2s cubic-bezier(.2,.6,.3,1) ' + (i * 0.7) + 's infinite' }} />
      ))}
      <div className={ringing ? 'ph-breathe' : (talking ? 'ph-glow' : '')} style={{ width: size, height: size, borderRadius: '50%', background: 'linear-gradient(135deg,#9db4e0,#6d8fd6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: size * 0.34, boxShadow: '0 10px 30px rgba(0,0,0,.45)', zIndex: 1 }}>{/^\d+$/.test(name || '') ? <IconPhone size={size * 0.4} fill="#fff" /> : ini}</div>
    </div>
  );
}
function CScreenBtn({ bg, fg, big, onClick, children }) {
  const sz = big ? 72 : 64;
  return <button onClick={onClick} className="ph-key" style={{ width: sz, height: sz, borderRadius: '50%', border: 'none', background: bg, color: fg, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{children}</button>;
}
function Recents({ hist, onCall, contacts }) {
  const nameOf = (n) => { const c = contacts.find(x => x.number === n); return c ? c.name : n; };
  return (
    <div>
      <div style={{ ...S.title, padding: '4px 4px 10px' }}>Recientes</div>
      {!hist.length ? <div style={S.empty}>Sin llamadas todavía.</div> :
        hist.map((h, i) => (
          <div key={i} style={S.crow} onClick={() => onCall(h.number)}>
            {h.missed ? <IconPhoneIncoming size={20} color="#ff3b30" /> : h.dir === 'in' ? <IconPhoneIncoming size={20} color="#8e8e93" /> : <IconPhoneOutgoing size={20} color="#8e8e93" />}
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 16, color: h.missed ? '#ff3b30' : '#000' }}>{nameOf(h.number)}</div>
              <div style={{ color: '#8e8e93', fontSize: 13 }}>{h.missed ? 'Perdida' : h.dir === 'in' ? 'Entrante' : 'Saliente'}</div></div>
            <div style={{ color: '#8e8e93', fontSize: 13 }}>{new Date(h.start).toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' })}</div>
            <button style={S.iconBtn} onClick={(e) => { e.stopPropagation(); onCall(h.number); }}><IconPhone size={18} color="#007aff" /></button>
          </div>
        ))}
    </div>
  );
}

const S = {
  app: { position: 'fixed', inset: 0, background: 'linear-gradient(165deg,#eaf0fb 0%,#f4f0fb 45%,#e8f1fc 100%)', color: '#0b0f1a', display: 'flex', flexDirection: 'column', fontFamily: '-apple-system, Inter, system-ui, sans-serif', maxWidth: 480, margin: '0 auto', boxShadow: '0 0 80px rgba(80,110,200,.12)' },
  statusbar: { textAlign: 'center', fontSize: 13, color: '#3c3c43', padding: '10px 0 4px' },
  flash: { position: 'absolute', top: 36, left: '50%', transform: 'translateX(-50%)', background: 'rgba(20,24,40,.92)', color: '#fff', padding: '9px 16px', borderRadius: 20, fontSize: 13.5, fontWeight: 500, zIndex: 90, boxShadow: '0 8px 24px rgba(0,0,0,.25)', whiteSpace: 'nowrap', animation: 'phflash .3s ease' },
  body: { flex: 1, overflowY: 'auto', padding: '0 16px', WebkitOverflowScrolling: 'touch' },
  dialWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'center', paddingBottom: 8 },
  numDisplay: { fontSize: 40, fontWeight: 300, minHeight: 50, letterSpacing: 1, textAlign: 'center' },
  keypad: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18, margin: '14px 0', width: 'min(300px,80vw)' },
  ioskey: { width: 72, height: 72, borderRadius: '50%', background: 'rgba(255,255,255,.5)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,.7)', boxShadow: '0 4px 16px rgba(60,80,160,.12), inset 0 1px 1px rgba(255,255,255,.9)', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#0b0f1a', justifySelf: 'center' },
  dialRow: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28, marginTop: 6 },
  callSec: { width: 56, height: 56, borderRadius: '50%', background: 'linear-gradient(160deg,#3a9bff,#0a66d6)', border: '1px solid rgba(255,255,255,.5)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 18px rgba(10,102,214,.4)' },
  inLabel: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,.85)', background: 'rgba(255,255,255,.14)', padding: '5px 12px', borderRadius: 20, marginBottom: 26 },
  callGreen: { width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(160deg,#3ddc6a,#28b14d)', border: '1px solid rgba(255,255,255,.5)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 22px rgba(40,177,77,.4), inset 0 1px 2px rgba(255,255,255,.5)' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 4px' },
  title: { fontSize: 28, fontWeight: 700 },
  addBtn: { background: 'none', border: 'none', cursor: 'pointer', padding: 6 },
  searchBox: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,.55)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,.7)', borderRadius: 12, padding: '9px 12px', margin: '6px 0 12px' },
  searchInp: { border: 'none', background: 'none', outline: 'none', fontSize: 16, flex: 1, color: '#000' },
  crow: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 8px', marginBottom: 4, borderRadius: 12, background: 'rgba(255,255,255,.4)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.5)', cursor: 'pointer' },
  iconBtn: { width: 36, height: 36, borderRadius: '50%', border: '1px solid rgba(255,255,255,.7)', background: 'rgba(255,255,255,.55)', backdropFilter: 'blur(8px)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' },
  empty: { color: '#8e8e93', textAlign: 'center', padding: '40px 0' },
  aSection: { background: 'rgba(255,255,255,.55)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,.6)', borderRadius: 14, padding: '4px 14px', margin: '14px 0' },
  aRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #e5e5ea', color: '#3c3c43' },
  logout: { width: '100%', padding: 14, borderRadius: 12, border: 'none', background: '#fff', color: '#ff3b30', fontWeight: 600, fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, boxShadow: '0 0 0 1px #ececec' },
  seg: { display: 'flex', gap: 4, background: 'rgba(118,118,128,.12)', borderRadius: 9, padding: 3, margin: '4px 0 6px' },
  segBtn: { flex: 1, border: 'none', background: 'none', padding: '7px 0', borderRadius: 7, fontSize: 13.5, fontWeight: 600, color: '#3c3c43', cursor: 'pointer' },
  segOn: { background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.12)', color: '#000' },
  toggle: { width: 46, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', padding: 3, display: 'flex', alignItems: 'center', transition: 'background .2s' },
  knob: { width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.3)', transition: 'transform .2s' },
  tabbar: { display: 'flex', borderTop: '1px solid rgba(255,255,255,.6)', background: 'rgba(255,255,255,.55)', backdropFilter: 'blur(22px) saturate(180%)', WebkitBackdropFilter: 'blur(22px) saturate(180%)', paddingBottom: 4, boxShadow: '0 -4px 24px rgba(60,80,160,.08)' },
  tabBtn: { flex: 1, background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0' },
  callScreenV: { position: 'fixed', inset: 0, maxWidth: 480, margin: '0 auto', background: '#000', color: '#fff', zIndex: 60, overflow: 'hidden' },
  vTop: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2, textAlign: 'center', padding: 'calc(env(safe-area-inset-top, 14px) + 10px) 16px 24px', background: 'linear-gradient(180deg,rgba(0,0,0,.6),transparent)', animation: 'phflash .25s ease' },
  vCtl: { position: 'absolute', left: 0, right: 0, bottom: 104, zIndex: 2, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, width: 'min(330px,86vw)', margin: '0 auto', padding: '14px 0 10px' },
  vHang: { position: 'absolute', left: 0, right: 0, bottom: 'calc(env(safe-area-inset-bottom, 16px) + 22px)', zIndex: 2, display: 'flex', justifyContent: 'center', gap: 26 },
  callScreen: { position: 'fixed', inset: 0, maxWidth: 480, margin: '0 auto', background: 'linear-gradient(180deg,rgba(30,40,80,.92),rgba(12,16,30,.96))', backdropFilter: 'blur(30px)', WebkitBackdropFilter: 'blur(30px)', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', zIndex: 60, padding: 20 },
  attBanner: { position: 'relative', display: 'flex', alignItems: 'center', gap: 10, width: 'min(320px,86vw)', marginTop: 18, padding: '10px 12px', borderRadius: 14, background: 'rgba(255,255,255,.16)', backdropFilter: 'blur(10px)', color: '#fff' },
  attBtn: { width: 42, height: 42, borderRadius: '50%', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' },
  ctlGrid: { position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18, marginTop: 34, width: 'min(300px,82vw)' },
  loginWrap: { position: 'fixed', inset: 0, background: 'linear-gradient(165deg,#dfe8fb,#eee6fb,#ddeefc)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, Inter, sans-serif' },
  loginCard: { width: 'min(360px,90vw)', background: 'rgba(255,255,255,.65)', backdropFilter: 'blur(30px) saturate(180%)', WebkitBackdropFilter: 'blur(30px) saturate(180%)', border: '1px solid rgba(255,255,255,.7)', borderRadius: 24, padding: '34px 26px', display: 'flex', flexDirection: 'column', alignItems: 'center', boxShadow: '0 20px 60px rgba(60,80,160,.18)' },
  linp: { width: '100%', boxSizing: 'border-box', padding: '13px 14px', borderRadius: 11, border: '1px solid #d1d1d6', fontSize: 16, marginBottom: 10, outline: 'none' },
  lbtn: { width: '100%', padding: 14, borderRadius: 11, border: 'none', background: '#007aff', color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer' },
  lbtn2: { width: '100%', padding: 12, borderRadius: 11, border: '1px solid #d1d1d6', background: 'rgba(255,255,255,.6)', color: '#1f2733', fontSize: 15, fontWeight: 600, cursor: 'pointer', marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 },
  scanWrap: { position: 'fixed', inset: 0, background: '#000', zIndex: 80 },
  scanFrame: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 'min(64vw,260px)', height: 'min(64vw,260px)', border: '3px solid rgba(255,255,255,.9)', borderRadius: 22, boxShadow: '0 0 0 9999px rgba(0,0,0,.45)' },
  scanClose: { position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)', width: 56, height: 56, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modalWrap: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 70 },
  vmWrap: { position: 'fixed', inset: 0, maxWidth: 480, margin: '0 auto', background: 'linear-gradient(165deg,#eaf0fb,#f4f0fb,#e8f1fc)', zIndex: 75, display: 'flex', flexDirection: 'column', color: '#0b0f1a' },
  vmHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(env(safe-area-inset-top,12px) + 10px) 14px 12px', borderBottom: '1px solid rgba(0,0,0,.06)' },
  vmBack: { background: 'none', border: 'none', color: '#007aff', fontSize: 16, cursor: 'pointer', width: 64, textAlign: 'left' },
  vmRow: { background: 'rgba(255,255,255,.6)', border: '1px solid rgba(255,255,255,.7)', borderRadius: 12, padding: 10, marginBottom: 8 },
  modal: { width: 'min(340px,88vw)', background: '#fff', borderRadius: 16, padding: 22, color: '#000' },
  minp: { width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 10, border: '1px solid #d1d1d6', fontSize: 16, marginBottom: 10, outline: 'none' },
  mbtn: { flex: 1, padding: 12, borderRadius: 10, border: 'none', fontWeight: 600, fontSize: 15, cursor: 'pointer' },
};
