'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useSoftphone } from '../../useSoftphone';

const card = { width: 'min(420px, 94vw)', background: 'rgba(255,255,255,.98)', borderRadius: 24, padding: '30px 26px', boxShadow: '0 30px 80px -20px rgba(10,30,80,.45)', textAlign: 'center' };
const fmt = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const Ico = ({ d, s = 22, c = 'currentColor', w = 2, fill = 'none' }) => <svg width={s} height={s} viewBox="0 0 24 24" fill={fill} stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
const phone = <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />;

export default function CallPage() {
  const { token } = useParams();
  const sp = useSoftphone();
  const [link, setLink] = useState(null); const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState('');
  const [phase, setPhase] = useState('idle'); const [err, setErr] = useState(''); const [secs, setSecs] = useState(0);
  const dialRef = useRef(null); const startedRef = useRef(false);

  useEffect(() => { fetch('/backend/api/c2c/public/' + token).then(r => r.ok ? r.json() : Promise.reject()).then(setLink).catch(() => setNotFound(true)); }, [token]);
  useEffect(() => {
    if (sp.reg === 'registered' && dialRef.current && !startedRef.current) { startedRef.current = true; sp.placeCall(dialRef.current); }
    if (sp.reg === 'error' && phase === 'calling') { setErr('No se pudo conectar la llamada. Revisá tu conexión.'); setPhase('error'); }
  }, [sp.reg, phase]);
  useEffect(() => {
    // El otro colgó (BYE) o el watchdog cortó por RTP muerto: wire() pone call en
    // 'Terminated' e INMEDIATAMENTE en null, y React batchea ambos setState, así que el
    // widget sólo ve el null. Por eso reaccionamos a "ya no está Established" (Terminated
    // o null), no al string 'Terminated' — antes se quedaba "En llamada" para siempre.
    if (sp.call === 'Established') { setPhase('incall'); return; }
    if (phase === 'incall' && sp.call !== 'Established') setPhase('ended');
    else if (phase === 'calling' && sp.call === 'Terminated') setPhase('ended');
  }, [sp.call, phase]);
  useEffect(() => { if (phase !== 'incall') return; setSecs(0); const t = setInterval(() => setSecs(s => s + 1), 1000); return () => clearInterval(t); }, [phase]);

  async function getGeo() {
    if (!link || !link.collect_geo || !navigator.geolocation) return null;
    return new Promise((res) => { const to = setTimeout(() => res(null), 4000); navigator.geolocation.getCurrentPosition(p => { clearTimeout(to); res({ lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4), acc: Math.round(p.coords.accuracy) }); }, () => { clearTimeout(to); res(null); }, { timeout: 4000 }); });
  }
  async function startCall() {
    if (link.require_name && !name.trim()) { setErr('Por favor, ingresá tu nombre.'); return; }
    setErr(''); setPhase('calling');
    try {
      const geo = await getGeo();
      const meta = { ua: navigator.userAgent.slice(0, 120), ref: document.referrer || '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
      const r = await fetch('/backend/api/c2c/public/' + token + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), geo, meta }) }).then(x => x.json());
      if (r.error) { setErr(r.error); setPhase('error'); return; }
      dialRef.current = r.dial; startedRef.current = false;
      await sp.connect(r.ext, r.pass, !!r.video, false);
    } catch (e) { setErr('No se pudo iniciar la llamada.'); setPhase('error'); }
  }
  const end = () => { sp.hangup(); setPhase('ended'); };
  const retry = () => { startedRef.current = false; dialRef.current = null; setPhase('idle'); setErr(''); };

  const wrap = { minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 18, background: 'radial-gradient(900px 500px at 80% -10%, rgba(47,116,230,.5), transparent 60%), radial-gradient(700px 500px at -10% 110%, rgba(124,92,230,.45), transparent 55%), #0c1018' };

  if (notFound) return <div style={wrap}><div style={card}><div style={{ color: '#94a3b8', marginBottom: 8 }}><Ico s={48} d={phone} /></div><h2 style={{ margin: '8px 0' }}>Enlace no disponible</h2><p style={{ color: '#6b7691' }}>Este enlace de llamada no existe o fue desactivado.</p></div></div>;
  if (!link) return <div style={wrap}><div style={card}><p style={{ color: '#6b7691' }}>Cargando…</p></div></div>;

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ width: 72, height: 72, margin: '0 auto 14px', borderRadius: '50%', background: 'linear-gradient(140deg,#2f74e6,#1747c0)', display: 'grid', placeItems: 'center', boxShadow: '0 12px 30px -8px rgba(47,116,230,.6)', color: '#fff' }}><Ico s={32} d={phone} /></div>
        <h2 style={{ margin: '0 0 4px', color: '#1b2233' }}>{link.name}</h2>
        {link.intro && <p style={{ color: '#6b7691', margin: '0 0 18px', fontSize: 15 }}>{link.intro}</p>}

        {phase === 'idle' && <>
          {link.require_name && <input value={name} onChange={e => setName(e.target.value)} placeholder="Tu nombre" style={{ width: '100%', padding: '13px 14px', borderRadius: 12, border: '1px solid #d7deea', fontSize: 15, marginBottom: 12, boxSizing: 'border-box' }} />}
          {err && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{err}</div>}
          <button onClick={startCall} style={{ width: '100%', padding: '15px', borderRadius: 14, border: 'none', background: 'linear-gradient(140deg,#16a34a,#15803d)', color: '#fff', fontSize: 17, fontWeight: 700, cursor: 'pointer', boxShadow: '0 12px 26px -8px rgba(22,163,74,.6)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}><Ico s={20} d={phone} />Llamar ahora</button>
          <p style={{ color: '#9aa4ba', fontSize: 12, marginTop: 14 }}>Se usará tu micrófono. {link.collect_geo ? 'Se solicitará tu ubicación.' : ''} No necesitás instalar nada.</p>
        </>}

        {phase === 'calling' && <div style={{ padding: '14px 0' }}>
          <div className="c2c-pulse" style={{ width: 64, height: 64, margin: '0 auto 14px', borderRadius: '50%', background: 'rgba(47,116,230,.15)', display: 'grid', placeItems: 'center', color: '#2f74e6' }}><Ico s={26} d={phone} /></div>
          <p style={{ color: '#3c465c', fontWeight: 600 }}>Conectando la llamada…</p>
        </div>}

        {phase === 'incall' && <div style={{ padding: '6px 0' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(22,163,74,.1)', color: '#16a34a', padding: '6px 14px', borderRadius: 30, fontWeight: 700, marginBottom: 16 }}><span className="c2c-pulse" style={{ width: 9, height: 9, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />En llamada · {fmt(secs)}</div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button onClick={sp.toggleMute} title="Silenciar" style={{ width: 60, height: 60, borderRadius: '50%', border: '1px solid #d7deea', background: sp.muted ? '#fde68a' : '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', color: sp.muted ? '#a16207' : '#3c465c' }}><Ico s={24} d={sp.muted ? <><line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" /><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" /><line x1="12" y1="19" x2="12" y2="23" /></> : <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /></>} /></button>
            <button onClick={end} title="Colgar" style={{ width: 60, height: 60, borderRadius: '50%', border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', boxShadow: '0 10px 24px -6px rgba(220,38,38,.6)', transform: 'rotate(135deg)' }}><Ico s={26} d={phone} /></button>
          </div>
        </div>}

        {phase === 'ended' && <div style={{ padding: '10px 0' }}>
          <div style={{ color: '#16a34a' }}><Ico s={42} d={<><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>} /></div>
          <p style={{ color: '#3c465c', fontWeight: 600, margin: '8px 0 16px' }}>Llamada finalizada</p>
          <button onClick={retry} style={{ padding: '12px 24px', borderRadius: 12, border: '1px solid #d7deea', background: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Llamar de nuevo</button>
        </div>}

        {phase === 'error' && <div style={{ padding: '10px 0' }}>
          <div style={{ color: '#d97706' }}><Ico s={42} d={<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>} /></div>
          <p style={{ color: '#dc2626', margin: '8px 0 16px' }}>{err}</p>
          <button onClick={retry} style={{ padding: '12px 24px', borderRadius: 12, border: '1px solid #d7deea', background: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Reintentar</button>
        </div>}
      </div>
      <audio ref={sp.audioRef} autoPlay />
      <style>{`@keyframes c2cpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.12)}}.c2c-pulse{animation:c2cpulse 1.4s infinite}`}</style>
    </div>
  );
}
