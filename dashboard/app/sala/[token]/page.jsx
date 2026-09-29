'use client';
/* ============================================================================
 *  La sala de reunión, abierta desde un enlace.
 *
 *  A QUIÉN LE SIRVE: al que NO es interno de la central. Hasta acá, entrar a una reunión
 *  era marcar un número de cuatro dígitos con un PIN, cosa que sólo puede hacer alguien
 *  que ya tiene un teléfono de la central configurado. El cliente, el proveedor o el que
 *  está en la calle con el celular no tenían puerta. Esta es la puerta.
 *
 *  NO SE PIDE PIN, y no es un olvido: el enlace ES la credencial. Se revoca de un clic
 *  desde el panel, no se adivina, y sólo sirve para entrar como participante — abrir la
 *  sala, silenciar y expulsar siguen pidiendo el PIN de moderador, que no viaja acá.
 *
 *  El video se enciende sólo si la sala lo tiene. Con video se ve al que habla (ConfBridge
 *  reparte en modo SFU); sin video, la misma pantalla con el audio y nada más.
 * ==========================================================================*/
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useSoftphone } from '../../useSoftphone';

const fmt = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const Ico = ({ d, s = 22, c = 'currentColor', w = 2, fill = 'none' }) => <svg width={s} height={s} viewBox="0 0 24 24" fill={fill} stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
const icoTel = <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />;
const icoGente = <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>;
const icoCam = <><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></>;
const icoMicOff = <><line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" /><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" /><line x1="12" y1="19" x2="12" y2="23" /></>;
const icoMic = <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /></>;

const fondo = { minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 18, background: 'radial-gradient(900px 500px at 80% -10%, rgba(47,116,230,.5), transparent 60%), radial-gradient(700px 500px at -10% 110%, rgba(124,92,230,.45), transparent 55%), #0c1018' };
const tarjeta = { width: 'min(440px, 94vw)', background: 'rgba(255,255,255,.98)', borderRadius: 24, padding: '30px 26px', boxShadow: '0 30px 80px -20px rgba(10,30,80,.45)', textAlign: 'center' };

export default function SalaWeb() {
  const { token } = useParams();
  /* `?e=<id>` es una ENTRADA de un solo uso que abrió el panel para moderar la reunión:
   * entra como moderador (abre la sala, silencia y expulsa) y no pide nombre, porque ya
   * sabe quién es. El id se quema en el servidor al levantarlo. */
  const entrada = (useSearchParams() || new URLSearchParams()).get('e') || '';
  const sp = useSoftphone();
  const [sala, setSala] = useState(null); const [noHay, setNoHay] = useState(false);
  const [nombre, setNombre] = useState('');
  const [fase, setFase] = useState('idle'); const [err, setErr] = useState(''); const [segs, setSegs] = useState(0);
  const [conVideo, setConVideo] = useState(true);
  const marcarRef = useRef(null); const arrancadoRef = useRef(false);

  useEffect(() => { fetch('/backend/api/salas/web/' + token).then(r => r.ok ? r.json() : Promise.reject()).then(setSala).catch(() => setNoHay(true)); }, [token]);
  useEffect(() => {
    if (sp.reg === 'registered' && marcarRef.current && !arrancadoRef.current) { arrancadoRef.current = true; sp.placeCall(marcarRef.current); }
    if (sp.reg === 'error' && fase === 'entrando') { setErr('No se pudo entrar a la reunión. Revisá tu conexión.'); setFase('error'); }
  }, [sp.reg, fase]); // eslint-disable-line
  useEffect(() => {
    if (sp.call === 'Established') { setFase('adentro'); return; }
    if (fase === 'adentro' && sp.call !== 'Established') setFase('afuera');
    else if (fase === 'entrando' && sp.call === 'Terminated') setFase('afuera');
  }, [sp.call, fase]);
  useEffect(() => { if (fase !== 'adentro') return; setSegs(0); const t = setInterval(() => setSegs(s => s + 1), 1000); return () => clearInterval(t); }, [fase]);

  async function entrar() {
    if (!entrada && !nombre.trim()) { setErr('Poné tu nombre: es el que ven los demás al entrar.'); return; }
    setErr(''); setFase('entrando');
    try {
      const r = await (entrada
        ? fetch('/backend/api/salas/entrada/' + entrada, { method: 'POST' }).then(x => x.json())
        : fetch('/backend/api/salas/web/' + token + '/session', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nombre.trim() }),
        }).then(x => x.json()));
      if (r.error) { setErr(r.error); setFase('error'); return; }
      marcarRef.current = r.dial; arrancadoRef.current = false;
      await sp.connect(r.ext, r.pass, !!(r.video && conVideo), false);
    } catch (e) { setErr('No se pudo entrar a la reunión.'); setFase('error'); }
  }
  /* Con entrada de moderador no hay nada que preguntar: se entra al abrir la página. El
   * que la abre ya decidió entrar cuando apretó el botón en el panel. */
  const autoRef = useRef(false);
  useEffect(() => {
    if (!entrada || !sala || autoRef.current || fase !== 'idle') return;
    autoRef.current = true; entrar();
  }, [entrada, sala, fase]); // eslint-disable-line

  const salir = () => { sp.hangup(); setFase('afuera'); };
  const volver = () => { arrancadoRef.current = false; marcarRef.current = null; setFase('idle'); setErr(''); };

  if (noHay) return <div style={fondo}><div style={tarjeta}><div style={{ color: '#94a3b8', marginBottom: 8 }}><Ico s={48} d={icoGente} /></div><h2 style={{ margin: '8px 0' }}>Enlace no disponible</h2><p style={{ color: '#6b7691' }}>Este enlace de reunión no existe o fue revocado.</p></div></div>;
  if (!sala) return <div style={fondo}><div style={tarjeta}><p style={{ color: '#6b7691' }}>Cargando…</p></div></div>;

  /* Adentro y con video: la reunión ocupa la pantalla. Sin video, la misma tarjeta. */
  if (fase === 'adentro' && sala.video && conVideo) {
    return (
      <div style={{ minHeight: '100dvh', background: '#0c1018', position: 'relative', display: 'grid', placeItems: 'center' }}>
        <video ref={sp.remoteVideoRef} autoPlay playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
        <video ref={sp.localVideoRef} autoPlay playsInline muted style={{ position: 'absolute', top: 16, right: 16, width: 168, height: 96, objectFit: 'cover', borderRadius: 12, border: '1px solid rgba(255,255,255,.18)', boxShadow: '0 10px 26px rgba(0,0,0,.45)', transform: 'scaleX(-1)' }} />
        <div style={{ position: 'absolute', top: 16, left: 18, color: '#fff', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 700 }}>{sala.sala}</span>
          <span style={{ fontSize: 13, opacity: .8 }}>{fmt(segs)}</span>
        </div>
        <div style={{ position: 'absolute', bottom: 26, left: 0, right: 0, display: 'flex', gap: 14, justifyContent: 'center' }}>
          <button onClick={sp.toggleMute} title="Silenciar" style={{ width: 60, height: 60, borderRadius: '50%', border: '1px solid rgba(255,255,255,.2)', background: sp.muted ? '#fde68a' : 'rgba(255,255,255,.12)', cursor: 'pointer', display: 'grid', placeItems: 'center', color: sp.muted ? '#a16207' : '#fff' }}><Ico s={24} d={sp.muted ? icoMicOff : icoMic} /></button>
          <button onClick={salir} title="Salir" style={{ width: 60, height: 60, borderRadius: '50%', border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', transform: 'rotate(135deg)' }}><Ico s={26} d={icoTel} /></button>
        </div>
        <audio ref={sp.audioRef} autoPlay />
      </div>
    );
  }

  return (
    <div style={fondo}>
      <div style={tarjeta}>
        <div style={{ width: 72, height: 72, margin: '0 auto 14px', borderRadius: '50%', background: 'linear-gradient(140deg,#2f74e6,#1747c0)', display: 'grid', placeItems: 'center', boxShadow: '0 12px 30px -8px rgba(47,116,230,.6)', color: '#fff' }}><Ico s={32} d={icoGente} /></div>
        <h2 style={{ margin: '0 0 4px', color: '#1b2233' }}>{sala.sala}</h2>
        <p style={{ color: '#6b7691', margin: '0 0 18px', fontSize: 15 }}>
          {entrada ? 'Entrás como moderador' : (sala.video ? 'Reunión con video' : 'Reunión de audio')}{sala.abierta ? '' : ' · todavía no abrió'}
        </p>

        {fase === 'idle' && !entrada && <>
          <input value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Tu nombre"
            style={{ width: '100%', padding: '13px 14px', borderRadius: 12, border: '1px solid #d7deea', fontSize: 15, marginBottom: 12, boxSizing: 'border-box', background: '#fff', color: '#1b2233' }} />
          {sala.video && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', color: '#3c465c', fontSize: 14, marginBottom: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={conVideo} onChange={e => setConVideo(e.target.checked)} />
              <Ico s={16} d={icoCam} c="#3c465c" /> Entrar con cámara
            </label>
          )}
          {err && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{err}</div>}
          <button onClick={entrar} disabled={!sala.abierta}
            style={{ width: '100%', padding: '15px', borderRadius: 14, border: 'none', background: sala.abierta ? 'linear-gradient(140deg,#16a34a,#15803d)' : '#cbd5e1', color: '#fff', fontSize: 17, fontWeight: 700, cursor: sala.abierta ? 'pointer' : 'not-allowed', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <Ico s={20} d={icoGente} />{sala.abierta ? 'Entrar a la reunión' : 'La sala todavía no abrió'}
          </button>
          <p style={{ color: '#9aa4ba', fontSize: 12, marginTop: 14 }}>Se usará tu micrófono{sala.video && conVideo ? ' y tu cámara' : ''}. No necesitás instalar nada ni marcar ningún PIN.</p>
        </>}

        {fase === 'entrando' && <div style={{ padding: '14px 0' }}>
          <div className="c2c-pulse" style={{ width: 64, height: 64, margin: '0 auto 14px', borderRadius: '50%', background: 'rgba(47,116,230,.15)', display: 'grid', placeItems: 'center', color: '#2f74e6' }}><Ico s={26} d={icoGente} /></div>
          <p style={{ color: '#3c465c', fontWeight: 600 }}>Entrando a la reunión…</p>
        </div>}

        {fase === 'adentro' && <div style={{ padding: '6px 0' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(22,163,74,.1)', color: '#16a34a', padding: '6px 14px', borderRadius: 30, fontWeight: 700, marginBottom: 16 }}>
            <span className="c2c-pulse" style={{ width: 9, height: 9, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />En la reunión · {fmt(segs)}
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button onClick={sp.toggleMute} title="Silenciar" style={{ width: 60, height: 60, borderRadius: '50%', border: '1px solid #d7deea', background: sp.muted ? '#fde68a' : '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', color: sp.muted ? '#a16207' : '#3c465c' }}><Ico s={24} d={sp.muted ? icoMicOff : icoMic} /></button>
            <button onClick={salir} title="Salir" style={{ width: 60, height: 60, borderRadius: '50%', border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', transform: 'rotate(135deg)' }}><Ico s={26} d={icoTel} /></button>
          </div>
        </div>}

        {fase === 'afuera' && <div style={{ padding: '10px 0' }}>
          <div style={{ color: '#16a34a' }}><Ico s={42} d={<><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>} /></div>
          <p style={{ color: '#3c465c', fontWeight: 600, margin: '8px 0 16px' }}>Saliste de la reunión</p>
          <button onClick={volver} style={{ padding: '12px 24px', borderRadius: 12, border: '1px solid #d7deea', background: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Volver a entrar</button>
        </div>}

        {fase === 'error' && <div style={{ padding: '10px 0' }}>
          <div style={{ color: '#d97706' }}><Ico s={42} d={<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>} /></div>
          <p style={{ color: '#dc2626', margin: '8px 0 16px' }}>{err}</p>
          <button onClick={volver} style={{ padding: '12px 24px', borderRadius: 12, border: '1px solid #d7deea', background: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Reintentar</button>
        </div>}
      </div>
      <audio ref={sp.audioRef} autoPlay />
      <style>{`@keyframes c2cpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.12)}}.c2c-pulse{animation:c2cpulse 1.4s infinite}`}</style>
    </div>
  );
}
