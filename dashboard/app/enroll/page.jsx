'use client';
import { useEffect, useState } from 'react';

export default function Enroll() {
  const [state, setState] = useState('loading'); const [err, setErr] = useState(''); const [ext, setExt] = useState('');
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('token');
    if (!token) { setErr('Falta el token de acceso.'); setState('error'); return; }
    fetch('/backend/api/enroll/' + token).then(r => r.json()).then(d => {
      if (d.error) { setErr(d.error === 'token expirado' ? 'El acceso expiró. Pedí uno nuevo.' : 'Token inválido.'); setState('error'); return; }
      localStorage.setItem('pbxng_softphone', JSON.stringify({ ext: d.ext, pass: d.password, video: false }));
      setExt(d.ext); setState('ok');
      setTimeout(() => { location.href = '/phone'; }, 1600);
    }).catch(() => { setErr('No se pudo conectar con el servidor.'); setState('error'); });
  }, []);
  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <svg width="60" height="60" viewBox="0 0 48 48"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5b8fd6" /><stop offset="1" stopColor="#1e40af" /></linearGradient></defs><path d="M24 2 L42 9 V25 C42 36 34 43 24 46 C14 43 6 36 6 25 V9 Z" fill="url(#lg)" /><text x="24" y="30" textAnchor="middle" fontWeight="800" fontSize="15" fill="#fff">IES</text></svg>
        <div style={{ fontSize: 23, fontWeight: 700, marginTop: 16 }}>PBX-NG Phone</div>
        {state === 'loading' && <><div style={{ color: '#8e8e93', marginTop: 8 }}>Configurando tu interno…</div><div style={S.spinner} /></>}
        {state === 'ok' && <>
          <div style={{ ...S.spinner, borderTopColor: '#34c759' }} />
          <div style={{ fontSize: 17, fontWeight: 600, marginTop: 16 }}>Interno {ext} listo</div>
          <div style={{ color: '#8e8e93', marginTop: 6, textAlign: 'center' }}>Abriendo tu teléfono… Para instalarlo, usá “Agregar a inicio” en el menú del navegador.</div>
        </>}
        {state === 'error' && <>
          <div style={{ fontSize: 40, marginTop: 14, color: '#ff3b30', fontWeight: 800 }}>!</div>
          <div style={{ color: '#ff3b30', marginTop: 6, fontWeight: 600, textAlign: 'center' }}>{err}</div>
        </>}
      </div>
    </div>
  );
}
const S = {
  wrap: { position: 'fixed', inset: 0, background: 'linear-gradient(165deg,#dfe8fb,#eee6fb,#ddeefc)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, Inter, sans-serif' },
  card: { width: 'min(360px,90vw)', background: 'rgba(255,255,255,.7)', backdropFilter: 'blur(30px)', border: '1px solid rgba(255,255,255,.7)', borderRadius: 24, padding: '36px 28px', display: 'flex', flexDirection: 'column', alignItems: 'center', boxShadow: '0 20px 60px rgba(60,80,160,.18)' },
  spinner: { width: 30, height: 30, borderRadius: '50%', border: '3px solid #d8e0f0', borderTopColor: '#1d4ed8', marginTop: 18, animation: 'enr-spin 0.9s linear infinite' },
};
if (typeof document !== 'undefined' && !document.getElementById('enr-kf')) { const st = document.createElement('style'); st.id = 'enr-kf'; st.textContent = '@keyframes enr-spin{to{transform:rotate(360deg)}}'; document.head.appendChild(st); }
