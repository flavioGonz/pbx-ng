'use client';
// Softphone reutilizable (estética PWA). Llamada activa inline (no tapa la página);
// entrante como popup animado. Buscador de directorio: al hacer hover/foco despliega
// los agentes en línea; al escribir, busca y filtra.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconPhone, IconPhoneOff, IconBackspace, IconMicrophone, IconMicrophoneOff,
  IconGridDots, IconPlayerPause, IconPlayerPlay, IconTransfer, IconVideo,
  IconPhoneIncoming, IconVolume, IconVolume3, IconCircleFilled, IconSearch, IconX, IconUsers, IconSettings,
} from '@tabler/icons-react';

function Timer({ since }) {
  const [t, setT] = useState(0);
  useEffect(() => { if (!since) { setT(0); return; } const i = setInterval(() => setT(Math.floor((Date.now() - since) / 1000)), 500); return () => clearInterval(i); }, [since]);
  return <span>{String(Math.floor(t / 60)).padStart(2, '0')}:{String(t % 60).padStart(2, '0')}</span>;
}
const initials = (name) => (name || '?').split(/[\s.]+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
function CallAvatar({ name, state, size = 96 }) {
  const ringing = state === 'ringing', talking = state === 'talking';
  const isNum = /^[\d*#+]+$/.test(name || '');
  return (
    <div style={{ position: 'relative', width: size + 56, height: size + 56, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>
      {ringing && [0, 1, 2].map(i => (
        <span key={i} style={{ position: 'absolute', width: size, height: size, borderRadius: '50%', border: '2px solid rgba(120,170,255,.55)', animation: 'sfRipple 2.2s cubic-bezier(.2,.6,.3,1) ' + (i * 0.7) + 's infinite' }} />
      ))}
      <div className={ringing ? 'sf-breathe' : (talking ? 'sf-glow' : '')} style={{ width: size, height: size, borderRadius: '50%', background: 'linear-gradient(135deg,#9db4e0,#6d8fd6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size * 0.34, boxShadow: '0 10px 30px rgba(0,0,0,.35)', zIndex: 1 }}>{isNum ? <IconPhone size={size * 0.4} fill="#fff" /> : initials(name)}</div>
    </div>
  );
}
function Ctl({ icon, label, active, activeColor, onClick, disabled }) {
  const bg = active ? (activeColor || '#fff') : 'var(--mantine-color-default)';
  const fg = active ? (activeColor ? '#fff' : '#111') : 'var(--mantine-color-text)';
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled} className="sf-key" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1 }}>
      <span style={{ width: 50, height: 50, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: bg, color: fg, border: '1px solid var(--mantine-color-default-border)', boxShadow: active ? '0 4px 14px rgba(0,0,0,.18)' : 'none', transition: 'all .15s' }}>{icon}</span>
      <span style={{ fontSize: 11, color: 'var(--mantine-color-dimmed)' }}>{label}</span>
    </button>
  );
}
function Equalizer({ color = '#2f9e44' }) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center', height: 20 }}>
      {[0, 1, 2, 3, 4, 5, 6].map(i => (
        <span key={i} style={{ width: 4, height: 20, borderRadius: 3, background: 'linear-gradient(180deg,#5ac8fa,' + color + ')', transformOrigin: 'center', animation: 'sfEq ' + (0.7 + (i % 3) * 0.18) + 's ease-in-out ' + (i * 0.09) + 's infinite' }} />
      ))}
    </div>
  );
}
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
const ONLINE = ['online', 'available', 'not_inuse', 'in_call', 'inuse', 'busy'];
const presDot = (s) => s === 'online' || s === 'available' || s === 'not_inuse' ? '#40c057' : s === 'in_call' || s === 'inuse' || s === 'busy' ? '#fab005' : '#adb5bd';

function DeviceSettings({ sp, opened, onClose }) {
  const [mics, setMics] = useState([]); const [spks, setSpks] = useState([]); const [cams, setCams] = useState([]);
  const [mic, setMic] = useState(''); const [spk, setSpk] = useState(''); const [cam, setCam] = useState('');
  const [err, setErr] = useState(''); const [preview, setPreview] = useState(false);
  const prev = useRef(null);
  useEffect(() => {
    if (!opened) return;
    try { setMic(localStorage.getItem('pbxng_dev_mic') || ''); setSpk(localStorage.getItem('pbxng_dev_spk') || ''); setCam(localStorage.getItem('pbxng_dev_cam') || ''); } catch (e) {}
    (async () => {
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); s.getTracks().forEach(t => t.stop()); setErr(''); }
      catch (e) { setErr('Permití el acceso a micrófono y cámara para poder elegirlos.'); }
      try { const ds = await navigator.mediaDevices.enumerateDevices(); setMics(ds.filter(d => d.kind === 'audioinput')); setSpks(ds.filter(d => d.kind === 'audiooutput')); setCams(ds.filter(d => d.kind === 'videoinput')); } catch (e) {}
    })();
  }, [opened]);
  useEffect(() => {
    if (!preview || !opened) return; let stream;
    (async () => { try { stream = await navigator.mediaDevices.getUserMedia({ video: cam ? { deviceId: { ideal: cam } } : true }); if (prev.current) { prev.current.srcObject = stream; prev.current.play().catch(() => {}); } } catch (e) {} })();
    return () => { try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {} };
  }, [preview, cam, opened]);
  function applySpk(v) { setSpk(v); try { const a = sp.audioRef && sp.audioRef.current; if (a && a.setSinkId && v) a.setSinkId(v).catch(() => {}); } catch (e) {} }
  function save() {
    try { localStorage.setItem('pbxng_dev_mic', mic); localStorage.setItem('pbxng_dev_spk', spk); localStorage.setItem('pbxng_dev_cam', cam); } catch (e) {}
    try { const a = sp.audioRef && sp.audioRef.current; if (a && a.setSinkId && spk) a.setSinkId(spk).catch(() => {}); } catch (e) {}
    onClose();
  }
  if (!opened) return null;
  const inp = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 10, border: '1px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default)', color: 'var(--mantine-color-text)', fontSize: 14, marginTop: 4 };
  const lbl = { fontSize: 12.5, fontWeight: 700, color: 'var(--mantine-color-dimmed)' };
  const setSel = (arr, v, on, kind) => (<select value={v} onChange={e => on(e.target.value)} style={inp}><option value="">Predeterminado del sistema</option>{arr.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || (kind + ' ' + (i + 1))}</option>)}</select>);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3200, padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(420px,94vw)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--mantine-color-body)', color: 'var(--mantine-color-text)', borderRadius: 16, padding: 20, boxShadow: '0 20px 60px rgba(0,0,0,.45)', border: '1px solid var(--mantine-color-default-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}><IconSettings size={20} /><div style={{ fontWeight: 800, fontSize: 18 }}>Dispositivos de audio y video</div></div>
        {err && <div style={{ fontSize: 12.5, color: '#e8590c', background: 'rgba(232,89,12,.1)', padding: '8px 10px', borderRadius: 8, marginBottom: 10 }}>{err}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div><div style={lbl}>Micrófono</div>{setSel(mics, mic, setMic, 'Micrófono')}</div>
          <div><div style={lbl}>Altavoz / auricular</div>{setSel(spks, spk, applySpk, 'Salida')}{spks.length === 0 && <div style={{ fontSize: 11, color: 'var(--mantine-color-dimmed)', marginTop: 3 }}>Tu navegador no permite elegir la salida (usa la del sistema).</div>}</div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div style={lbl}>Cámara (videollamadas)</div><button onClick={() => setPreview(p => !p)} style={{ fontSize: 12, background: 'none', border: 'none', color: '#1971c2', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconVideo size={14} /> {preview ? 'Ocultar' : 'Probar'}</button></div>
            {setSel(cams, cam, setCam, 'Cámara')}
            {preview && <video ref={prev} autoPlay playsInline muted style={{ width: '100%', borderRadius: 10, marginTop: 8, background: '#000', aspectRatio: '16/9', objectFit: 'cover' }} />}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 11, borderRadius: 10, border: '1px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default)', color: 'var(--mantine-color-text)', fontWeight: 600, cursor: 'pointer' }}>Cancelar</button>
          <button onClick={save} style={{ flex: 1, padding: 11, borderRadius: 10, border: 'none', background: '#2f9e44', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Guardar</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--mantine-color-dimmed)', marginTop: 10 }}>El micrófono y la cámara elegidos se usan en las próximas llamadas. La cámara es la fuente de tus videollamadas.</div>
      </div>
    </div>
  );
}

export default function Softphone({ sp, dark = false, directory = [], height = 470, onIncomingCard }) {
  const [dial, setDial] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [kp, setKp] = useState(false);
  const [xfer, setXfer] = useState(false); const [xnum, setXnum] = useState('');
  const blurT = useRef(null);
  const [devOpen, setDevOpen] = useState(false);
  const registered = sp.reg === 'registered';
  const inCall = !!(sp.call || sp.callInfo);
  const established = sp.call === 'Established';
  const callState = sp.held ? 'hold' : established ? 'talking' : 'ringing';

  const keyBg = dark ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.65)';
  const keyBorder = dark ? '1px solid rgba(255,255,255,.10)' : '1px solid rgba(0,0,0,.06)';
  const keyShadow = dark ? '0 2px 8px rgba(0,0,0,.3)' : '0 3px 10px rgba(60,80,160,.10)';

  function press(k) { sp.tone(k); if (!inCall) setDial(d => (d + k).slice(0, 28)); }
  function doXfer() { const t = xnum.trim(); if (!t) return; sp.transfer(t); setXfer(false); setXnum(''); }
  function callTo(n, video) { if (!registered || !n) return; setQ(''); setOpen(false); sp.placeCall(String(n), !!video); }
  function show() { clearTimeout(blurT.current); setOpen(true); }
  function hideSoon() { clearTimeout(blurT.current); blurT.current = setTimeout(() => setOpen(false), 160); }

  const others = useMemo(() => directory.filter(d => String(d.ext) !== String(sp.creds?.ext)), [directory, sp.creds]);
  const online = useMemo(() => others.filter(d => ONLINE.includes(d.status)), [others]);
  const sortedOthers = useMemo(() => [...others].sort((a, b) => (ONLINE.includes(b.status) - ONLINE.includes(a.status)) || String(a.name || a.ext).localeCompare(String(b.name || b.ext))), [others]);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return sortedOthers.slice(0, 12);
    return others.filter(d => String(d.ext).includes(s) || (d.name || '').toLowerCase().includes(s)).slice(0, 12);
  }, [q, others, sortedOthers]);
  const showList = open && !inCall && results.length > 0;

  const numTitle = sp.callInfo?.number || dial;
  const dirName = (num) => { const d = directory.find(x => String(x.ext) === String(num)); return d?.name || null; };

  return (
    <div style={{ position: 'relative' }}>
      <style>{`
        @keyframes sfRipple{0%{transform:scale(.6);opacity:.9}100%{transform:scale(1.5);opacity:0}}
        @keyframes sfEq{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}
        @keyframes sfBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
        @keyframes sfPop{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
        @keyframes sfSlideDown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes sfInPop{0%{opacity:0;transform:scale(.85)}60%{transform:scale(1.02)}100%{opacity:1;transform:scale(1)}}
        .sf-breathe{animation:sfBreathe 2.4s ease-in-out infinite}
        .sf-glow{box-shadow:0 0 0 5px rgba(47,158,68,.16),0 10px 30px rgba(0,0,0,.35)!important}
        .sf-key{transition:transform .08s}
        .sf-key:active{transform:scale(.9)}
        .sf-ring{animation:sfBreathe 1.1s ease-in-out infinite}
        .sf-res:hover{background:var(--mantine-color-default-hover)}
      `}</style>
      <audio ref={sp.audioRef} autoPlay />
      <button onClick={() => setDevOpen(true)} title="Ajustes de audio y video" className="sf-key" style={{ position: 'absolute', top: -4, right: 0, zIndex: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--mantine-color-dimmed)', display: 'flex', padding: 4 }}><IconSettings size={18} /></button>
      <DeviceSettings sp={sp} opened={devOpen} onClose={() => setDevOpen(false)} />

      {!inCall && (
        <div style={{ position: 'relative', marginBottom: 10 }} onMouseEnter={show} onMouseLeave={hideSoon}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--mantine-color-default)', border: '1px solid var(--mantine-color-default-border)', borderRadius: 12, padding: '9px 12px' }}>
            <IconSearch size={17} style={{ opacity: .55 }} />
            <input value={q} onChange={e => setQ(e.target.value)} onFocus={show} onBlur={hideSoon} placeholder="Buscar o ver contactos…" style={{ flex: 1, border: 'none', background: 'none', outline: 'none', fontSize: 15, color: 'var(--mantine-color-text)' }} />
            {q ? <button onClick={() => setQ('')} className="sf-key" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--mantine-color-dimmed)', display: 'flex' }}><IconX size={16} /></button>
               : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--mantine-color-dimmed)' }}><IconUsers size={13} /> {online.length}</span>}
          </div>
          {showList && (
            <div style={{ position: 'absolute', top: 46, left: 0, right: 0, zIndex: 20, background: 'var(--mantine-color-body)', border: '1px solid var(--mantine-color-default-border)', borderRadius: 12, boxShadow: '0 12px 30px rgba(0,0,0,.18)', overflow: 'hidden', animation: 'sfSlideDown .16s ease' }}>
              {!q.trim() && <div style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, letterSpacing: .4, color: 'var(--mantine-color-dimmed)', borderBottom: '1px solid var(--mantine-color-default-border)' }}>CONTACTOS</div>}
              {results.map(d => (
                <div key={d.ext} className="sf-res" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer' }} onClick={() => callTo(d.ext)}>
                  <div style={{ position: 'relative' }}>
                    <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'linear-gradient(135deg,#9db4e0,#6d8fd6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 }}>{initials(d.name || d.ext)}</div>
                    <span style={{ position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: '50%', background: presDot(d.status), border: '2px solid var(--mantine-color-body)' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name || ('Extensión ' + d.ext)}</div><div style={{ fontSize: 12, color: 'var(--mantine-color-dimmed)' }}>{d.ext}</div></div>
                  <button className="sf-key" onClick={e => { e.stopPropagation(); callTo(d.ext, true); }} style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1971c2' }}><IconVideo size={16} /></button>
                  <button className="sf-key" onClick={e => { e.stopPropagation(); callTo(d.ext); }} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: '#2f9e44', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><IconPhone size={15} fill="#fff" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {inCall ? (
        <div style={{ minHeight: height - 60, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, animation: 'sfPop .2s ease', padding: '10px 0' }}>
          <CallAvatar name={dirName(numTitle) || numTitle} state={callState} size={92} />
          <div style={{ fontSize: 22, fontWeight: 700, textAlign: 'center' }}>{dirName(numTitle) || numTitle}</div>
          {dirName(numTitle) && <div style={{ fontSize: 13, color: 'var(--mantine-color-dimmed)', marginTop: -6 }}>{numTitle}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--mantine-color-dimmed)', fontSize: 14 }}>
            {sp.held ? 'En espera' : established ? <Timer since={sp.callInfo?.since} /> : (sp.callInfo?.dir === 'in' ? 'Entrante…' : 'Llamando…')}
            {sp.recording && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#fa5252' }}><IconCircleFilled size={9} /> REC</span>}
            {established && sp.usingRelay != null && (
              <span title={sp.usingRelay ? 'El RTP de esta llamada está pasando por el servidor TURN (relay)' : 'El RTP va directo entre los extremos (host/STUN), sin pasar por TURN'}
                style={{ fontSize: 10, fontWeight: 800, letterSpacing: .6, padding: '2px 8px', borderRadius: 20, border: '1px solid', borderColor: sp.usingRelay ? 'rgba(18,184,134,.45)' : 'rgba(120,140,180,.35)', background: sp.usingRelay ? 'rgba(18,184,134,.12)' : 'transparent', color: sp.usingRelay ? '#0ca678' : 'var(--mantine-color-dimmed)' }}>
                {sp.usingRelay ? 'VÍA TURN' : 'DIRECTO'}
              </span>)}
          </div>
          {established && !sp.held && <Equalizer />}
          {kp ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 6, width: 'min(240px,90%)' }}>
              {KEYS.map(([k]) => <button key={k} className="sf-key" onClick={() => sp.tone(k)} style={{ height: 46, borderRadius: 12, border: '1px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default)', color: 'var(--mantine-color-text)', fontSize: 19, cursor: 'pointer' }}>{k}</button>)}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <Ctl icon={sp.muted ? <IconMicrophoneOff size={22} /> : <IconMicrophone size={22} />} label="Silenciar" active={sp.muted} activeColor="#fa5252" onClick={sp.toggleMute} disabled={!established} />
              <Ctl icon={sp.held ? <IconPlayerPlay size={22} /> : <IconPlayerPause size={22} />} label={sp.held ? 'Reanudar' : 'Espera'} active={sp.held} activeColor="#f59f00" onClick={sp.toggleHold} disabled={!established} />
              <Ctl icon={<IconTransfer size={22} />} label="Transferir" onClick={() => setXfer(true)} disabled={!established} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 14, marginTop: 12, alignItems: 'center' }}>
            <Ctl icon={<IconGridDots size={22} />} label="Teclado" active={kp} onClick={() => setKp(v => !v)} disabled={!established} />
            <button className="sf-key" onClick={sp.hangup} style={{ width: 66, height: 66, borderRadius: '50%', border: 'none', background: '#fa5252', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 22px rgba(250,82,82,.4)' }}><IconPhoneOff size={26} /></button>
            {sp.toggleSpeaker && <Ctl icon={sp.speaker ? <IconVolume size={22} /> : <IconVolume3 size={22} />} label="Altavoz" active={sp.speaker} onClick={sp.toggleSpeaker} />}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: height - 60, justifyContent: 'center' }}>
          <div style={{ fontSize: 34, fontWeight: 300, minHeight: 44, letterSpacing: 1, textAlign: 'center', color: 'var(--mantine-color-text)' }}>{dial || <span style={{ opacity: 0 }}>0</span>}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, margin: '10px 0', width: 'min(270px,80%)' }}>
            {KEYS.map(([k, s]) => (
              <button key={k} className="sf-key" onClick={() => press(k)} style={{ width: 64, height: 64, borderRadius: '50%', background: keyBg, backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', border: keyBorder, boxShadow: keyShadow, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--mantine-color-text)', justifySelf: 'center' }}>
                <span style={{ fontSize: 27, fontWeight: 400, lineHeight: 1 }}>{k}</span>
                <span style={{ fontSize: 8, letterSpacing: 1.5, color: 'var(--mantine-color-dimmed)', marginTop: 2, height: 8 }}>{s}</span>
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24, marginTop: 2 }}>
            <button style={{ width: 50, height: 50, borderRadius: '50%', background: 'linear-gradient(160deg,#3a9bff,#0a66d6)', border: 'none', cursor: dial ? 'pointer' : 'default', opacity: dial ? 1 : 0.35, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 16px rgba(10,102,214,.35)' }} onClick={() => callTo(dial, true)}><IconVideo size={21} color="#fff" /></button>
            <button style={{ width: 66, height: 66, borderRadius: '50%', background: 'linear-gradient(160deg,#3ddc6a,#28b14d)', border: 'none', cursor: 'pointer', opacity: registered ? 1 : 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 20px rgba(40,177,77,.4)' }} onClick={() => callTo(dial)}><IconPhone size={28} color="#fff" fill="#fff" /></button>
            <button style={{ width: 50, height: 50, border: 'none', background: 'none', cursor: dial ? 'pointer' : 'default', color: dial ? 'var(--mantine-color-text)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDial(d => d.slice(0, -1))}><IconBackspace size={23} /></button>
          </div>
        </div>
      )}

      {sp.incoming && !inCall &&
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(8,12,22,.55)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000, padding: 16 }}>
          <div style={{ width: 'min(560px,94vw)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--mantine-color-body)', color: 'var(--mantine-color-text)', borderRadius: 20, boxShadow: '0 30px 80px rgba(0,0,0,.5)', animation: 'sfInPop .28s cubic-bezier(.2,.7,.3,1)', border: '1px solid var(--mantine-color-default-border)' }}>
            <div style={{ background: 'linear-gradient(135deg,#1971c2,#0c4a8f)', color: '#fff', padding: '18px 22px', borderRadius: '20px 20px 0 0', display: 'flex', alignItems: 'center', gap: 14 }}>
              <CallAvatar name={sp.incoming?.remoteIdentity?.uri?.user || '?'} state="ringing" size={64} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, background: 'rgba(255,255,255,.18)', padding: '3px 10px', borderRadius: 20, marginBottom: 6 }}>
                  {sp.incomingVideo ? <><IconVideo size={13} /> VIDEOLLAMADA</> : <><IconPhoneIncoming size={13} /> LLAMADA ENTRANTE</>}
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>{dirName(sp.incoming?.remoteIdentity?.uri?.user) || (sp.incoming?.remoteIdentity?.uri?.user || 'Desconocido')}</div>
                <div style={{ fontSize: 13, opacity: .85 }}>{sp.incoming?.remoteIdentity?.uri?.user}</div>
              </div>
            </div>
            {onIncomingCard && <div style={{ padding: '4px 4px 0' }}>{onIncomingCard(sp.incoming?.remoteIdentity?.uri?.user)}</div>}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 40, padding: '20px 22px 24px' }}>
              <div style={{ textAlign: 'center' }}>
                <button className="sf-key" onClick={sp.rejectIncoming} style={{ width: 64, height: 64, borderRadius: '50%', border: 'none', background: '#fa5252', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 22px rgba(250,82,82,.4)' }}><IconPhoneOff size={26} /></button>
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--mantine-color-dimmed)' }}>Rechazar</div>
              </div>
              {sp.incomingVideo &&
                <div style={{ textAlign: 'center' }}>
                  <button className="sf-key" onClick={() => sp.acceptIncoming(true)} style={{ width: 64, height: 64, borderRadius: '50%', border: 'none', background: '#1971c2', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IconVideo size={24} /></button>
                  <div style={{ marginTop: 8, fontSize: 13, color: 'var(--mantine-color-dimmed)' }}>Video</div>
                </div>}
              <div style={{ textAlign: 'center' }}>
                <button className="sf-key sf-ring" onClick={() => sp.acceptIncoming(false)} style={{ width: 64, height: 64, borderRadius: '50%', border: 'none', background: '#2f9e44', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 22px rgba(47,158,68,.45)' }}><IconPhone size={26} fill="#fff" /></button>
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--mantine-color-dimmed)' }}>{sp.incomingVideo ? 'Audio' : 'Atender'}</div>
              </div>
            </div>
          </div>
        </div>}

      {xfer &&
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3100 }} onClick={() => setXfer(false)}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(340px,88vw)', background: 'var(--mantine-color-body)', color: 'var(--mantine-color-text)', borderRadius: 16, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.4)', border: '1px solid var(--mantine-color-default-border)' }}>
            <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Transferir llamada</div>
            <div style={{ opacity: .6, fontSize: 13, marginBottom: 12 }}>Extensión o número de destino.</div>
            <input autoFocus value={xnum} onChange={e => setXnum(e.target.value.replace(/[^0-9*#+]/g, ''))} onKeyDown={e => e.key === 'Enter' && doXfer()} placeholder="Ej 1001" style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 10, border: '1px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default)', color: 'var(--mantine-color-text)', fontSize: 16, marginBottom: 12, outline: 'none' }} />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setXfer(false)} style={{ flex: 1, padding: 12, borderRadius: 10, border: '1px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default)', color: 'var(--mantine-color-text)', fontWeight: 600, cursor: 'pointer' }}>Cancelar</button>
              <button onClick={doXfer} disabled={!xnum} style={{ flex: 1, padding: 12, borderRadius: 10, border: 'none', background: '#2f9e44', color: '#fff', fontWeight: 600, cursor: xnum ? 'pointer' : 'default', opacity: xnum ? 1 : .5 }}>Transferir</button>
            </div>
          </div>
        </div>}
    </div>
  );
}
