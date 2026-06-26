'use client';
import { useEffect, useState, useRef, useCallback } from 'react';

// OTA: detecta nueva versión publicada (version.json) y la aplica sin reinstalar.
// Muestra un aviso; si no hay llamada en curso, se auto-aplica tras una cuenta corta.
export default function UpdateBanner() {
  const [avail, setAvail] = useState(false);
  const [applying, setApplying] = useState(false);
  const [secs, setSecs] = useState(8);
  const cur = useRef(null);
  const tick = useRef(null);

  const apply = useCallback(async () => {
    if (applying) return;
    setApplying(true);
    try { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } catch (_) {}
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => (r.waiting ? r.waiting.postMessage({ type: 'skipWaiting' }) : null)));
      }
    } catch (_) {}
    try { location.reload(); } catch (_) {}
  }, [applying]);

  // Cuenta regresiva + auto-aplicado (pausada si hay llamada en curso)
  useEffect(() => {
    if (!avail) return;
    tick.current = setInterval(() => {
      if (typeof window !== 'undefined' && window.__pbxInCall) { setSecs(8); return; } // espera a que termine la llamada
      setSecs((s) => { if (s <= 1) { clearInterval(tick.current); apply(); return 0; } return s - 1; });
    }, 1000);
    return () => clearInterval(tick.current);
  }, [avail, apply]);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const v = await fetch('/version.json?ts=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()).then((d) => d.version);
        if (!alive || v == null) return;
        if (cur.current == null) { cur.current = v; return; }
        if (v !== cur.current) { cur.current = v; setAvail(true); }
      } catch (_) {}
    };
    check();
    const iv = setInterval(check, 30000);
    const onVis = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  if (!avail) return null;
  return (
    <div style={wrap}>
      <div style={card}>
        <span style={dot} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Nueva versión disponible</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>{applying ? 'Actualizando…' : 'Se aplicará en ' + secs + 's'}</div>
        </div>
        <button onClick={apply} disabled={applying} style={btn}>{applying ? '…' : 'Actualizar'}</button>
      </div>
    </div>
  );
}
const wrap = { position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 12px)', left: 0, right: 0, zIndex: 9999, display: 'flex', justifyContent: 'center', pointerEvents: 'none', padding: '0 12px' };
const card = { pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 12, width: 'min(420px,94vw)', padding: '11px 12px 11px 16px', borderRadius: 16, background: 'rgba(20,28,52,.92)', color: '#fff', backdropFilter: 'blur(18px) saturate(160%)', WebkitBackdropFilter: 'blur(18px) saturate(160%)', boxShadow: '0 12px 36px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.12)', animation: 'phUp .3s cubic-bezier(.22,.61,.36,1) both' };
const dot = { width: 9, height: 9, borderRadius: '50%', background: '#34c759', flex: 'none', boxShadow: '0 0 0 4px rgba(52,199,89,.25)' };
const btn = { flex: 'none', border: 'none', borderRadius: 10, padding: '8px 16px', background: '#0a84ff', color: '#fff', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' };
