'use client';
import { useEffect, useState, useCallback } from 'react';

const CONF = {
  ok:   { c: '#34c759', ring: 'rgba(52,199,89,.35)' },
  bad:  { c: '#ff453a', ring: 'rgba(255,69,58,.35)' },
  info: { c: '#3a86ff', ring: 'rgba(58,134,255,.35)' },
  warn: { c: '#ff9f0a', ring: 'rgba(255,159,10,.35)' },
  action: { c: '#2f74e6', ring: 'rgba(47,116,230,.35)' },
};

function Glyph({ type, color }) {
  // SVG con animación de trazo (draw) según el tipo
  const common = { fill: 'none', stroke: color, strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' };
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2" fill="none" opacity=".28" />
      {type === 'ok' && <path className="pbx-tk-draw" d="M7 12.5l3.2 3.2L17 8.5" {...common} />}
      {type === 'bad' && <g className="pbx-tk-draw"><path d="M8.5 8.5l7 7" {...common} /><path d="M15.5 8.5l-7 7" {...common} /></g>}
      {type === 'info' && <g className="pbx-tk-draw"><path d="M12 11v5" {...common} /><circle cx="12" cy="7.6" r="1.05" fill={color} stroke="none" /></g>}
      {type === 'warn' && <g className="pbx-tk-draw"><path d="M12 7v6" {...common} /><circle cx="12" cy="16.4" r="1.05" fill={color} stroke="none" /></g>}
      {type === 'action' && <path className="pbx-tk-draw" d="M9 7l6 5-6 5" {...common} />}
    </svg>
  );
}

function Toast({ t, onClose }) {
  const k = CONF[t.type] || CONF.info;
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const dur = t.duration ?? 3200;
    const a = setTimeout(() => setLeaving(true), dur);
    const b = setTimeout(() => onClose(t.id), dur + 260);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [t, onClose]);
  return (
    <div className={'pbx-toast' + (leaving ? ' pbx-toast-out' : '')} role="status">
      <span className="pbx-toast-ico" style={{ boxShadow: `0 0 0 5px ${k.ring}` }}><Glyph type={t.type} color={k.c} /></span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 650, fontSize: 13.5, lineHeight: 1.25 }}>{t.message}</div>
        {t.desc && <div style={{ fontSize: 12, opacity: .72, marginTop: 1 }}>{t.desc}</div>}
      </div>
      <button className="pbx-toast-x" onClick={() => { setLeaving(true); setTimeout(() => onClose(t.id), 240); }} aria-label="Cerrar">×</button>
      <span className="pbx-toast-bar" style={{ background: k.c, animationDuration: ((t.duration ?? 3200)) + 'ms' }} />
    </div>
  );
}

export default function Toaster() {
  const [items, setItems] = useState([]);
  const close = useCallback((id) => setItems(l => l.filter(x => x.id !== id)), []);
  useEffect(() => {
    const onT = (e) => { const d = e.detail || {}; setItems(l => [...l.slice(-3), { id: d.id || Math.random().toString(36).slice(2), message: d.message, type: d.type || 'info', desc: d.desc, duration: d.duration }]); };
    window.addEventListener('pbx:toast', onT);
    return () => window.removeEventListener('pbx:toast', onT);
  }, []);
  return (
    <div className="pbx-toaster" aria-live="polite">
      {items.map(t => <Toast key={t.id} t={t} onClose={close} />)}
    </div>
  );
}
