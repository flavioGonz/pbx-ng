'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { IconX, IconTrash, IconPencil, IconEraser } from '@tabler/icons-react';

const COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffd60a', '#ffffff', '#1c1c1e'];

// Pizarra compartida durante la videollamada. room = par de internos ordenado.
export default function Scratchpad({ room, onClose }) {
  const cvs = useRef(null); const ctx = useRef(null); const sock = useRef(null);
  const drawing = useRef(false); const last = useRef(null);
  const [color, setColor] = useState('#ff3b30'); const [erase, setErase] = useState(false);
  const stateRef = useRef({ color, erase }); stateRef.current = { color, erase };

  const sizeCanvas = useCallback(() => {
    const c = cvs.current; if (!c) return;
    const r = c.getBoundingClientRect();
    const snap = c.width ? ctx.current.getImageData(0, 0, c.width, c.height) : null;
    c.width = r.width; c.height = r.height;
    ctx.current = c.getContext('2d'); ctx.current.lineCap = 'round'; ctx.current.lineJoin = 'round';
    if (snap) try { ctx.current.putImageData(snap, 0, 0); } catch (_) {}
  }, []);

  const stroke = useCallback((x0, y0, x1, y1, col, er, w) => {
    const c = ctx.current; if (!c) return;
    c.globalCompositeOperation = er ? 'destination-out' : 'source-over';
    c.strokeStyle = col; c.lineWidth = er ? 26 : (w || 3.5);
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }, []);

  useEffect(() => {
    sizeCanvas();
    const onR = () => sizeCanvas(); window.addEventListener('resize', onR);
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    let tok = ''; try { tok = localStorage.getItem('pbxng_jwt') || ''; } catch (_) {}
    const sk = io(origin, { path: '/socket.io', transports: ['polling'], upgrade: false, auth: { scratch: true, token: tok } });
    sock.current = sk;
    sk.on('connect', () => sk.emit('scratch:join', room));
    sk.on('scratch:op', (op) => {
      const c = cvs.current; if (!c || !op) return;
      stroke(op.x0 * c.width, op.y0 * c.height, op.x1 * c.width, op.y1 * c.height, op.color, op.erase, op.w);
    });
    sk.on('scratch:clear', () => { const c = cvs.current; if (c) ctx.current.clearRect(0, 0, c.width, c.height); });
    return () => { try { sk.emit('scratch:leave', room); sk.disconnect(); } catch (_) {} window.removeEventListener('resize', onR); };
  }, [room, sizeCanvas, stroke]);

  function pt(e) {
    const c = cvs.current; const r = c.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  function down(e) { e.preventDefault(); drawing.current = true; last.current = pt(e); }
  function move(e) {
    if (!drawing.current) return; e.preventDefault();
    const p = pt(e); const l = last.current; const c = cvs.current; const { color, erase } = stateRef.current;
    stroke(l.x, l.y, p.x, p.y, color, erase);
    sock.current && sock.current.emit('scratch:op', { room, op: { x0: l.x / c.width, y0: l.y / c.height, x1: p.x / c.width, y1: p.y / c.height, color, erase } });
    last.current = p;
  }
  function up() { drawing.current = false; }
  function clearAll() { const c = cvs.current; ctx.current.clearRect(0, 0, c.width, c.height); sock.current && sock.current.emit('scratch:clear', { room }); }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, maxWidth: 480, margin: '0 auto' }}>
      <canvas ref={cvs}
        onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={up}
        onTouchStart={down} onTouchMove={move} onTouchEnd={up}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', cursor: 'crosshair' }} />
      {/* toolbar */}
      <div style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 12px) + 8px)', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(28,28,30,.78)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', padding: '8px 12px', borderRadius: 999, boxShadow: '0 6px 22px rgba(0,0,0,.4)' }}>
        {COLORS.map(c => (
          <button key={c} onClick={() => { setColor(c); setErase(false); }} aria-label={c}
            style={{ width: 24, height: 24, borderRadius: '50%', background: c, border: (color === c && !erase) ? '3px solid #fff' : '2px solid rgba(255,255,255,.4)', cursor: 'pointer' }} />
        ))}
        <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,.25)' }} />
        <button onClick={() => setErase(e => !e)} style={tb(erase)}><IconEraser size={18} color="#fff" /></button>
        <button onClick={clearAll} style={tb(false)}><IconTrash size={18} color="#fff" /></button>
        <button onClick={onClose} style={tb(false)}><IconX size={18} color="#fff" /></button>
      </div>
    </div>
  );
}
const tb = (active) => ({ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: active ? 'rgba(10,132,255,.85)' : 'rgba(255,255,255,.12)', border: 'none', cursor: 'pointer' });
