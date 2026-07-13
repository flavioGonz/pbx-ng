import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { encodeProv, decodeProv, parseEnroll, resolveEnroll } from './prov.js';

const C = { accent: '#2f80ff', ink: '#0b1220', sub: '#667089', line: '#e3e8f0', red: '#ef4444', green: '#22c55e' };
const inp = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 9, border: `1px solid ${C.line}`, fontSize: 13, outline: 'none', fontFamily: 'ui-monospace, Consolas, monospace' };
const tabBtn = (on) => ({ flex: 1, padding: '9px', border: 'none', borderBottom: `2px solid ${on ? C.accent : 'transparent'}`, background: 'none', cursor: 'pointer', fontWeight: 600, color: on ? C.accent : C.sub });
const prim = { width: '100%', padding: 11, borderRadius: 10, border: 'none', background: C.accent, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' };

export default function QrProvision({ cfg, onApply, onClose }) {
  const [tab, setTab] = useState('scan');
  const [paste, setPaste] = useState('');
  const [err, setErr] = useState('');
  const [qrImg, setQrImg] = useState('');
  const [noCam, setNoCam] = useState(false);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef(null), canvasRef = useRef(null), streamRef = useRef(null), rafRef = useRef(0);

  // Sin camara (tipico en un PC de escritorio) -> arrancamos en "Pegar codigo"
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) throw new Error('sin API de medios');
        const devs = await navigator.mediaDevices.enumerateDevices();
        const cams = devs.filter(d => d.kind === 'videoinput');
        if (dead) return;
        if (!cams.length) { setNoCam(true); setTab('paste'); }
      } catch { if (!dead) { setNoCam(true); setTab('paste'); } }
    })();
    return () => { dead = true; };
  }, []);

  // Mi QR
  useEffect(() => { if (tab === 'mine') { QRCode.toDataURL(encodeProv(cfg), { width: 260, margin: 1, errorCorrectionLevel: 'M' }).then(setQrImg).catch(() => setQrImg('')); } }, [tab, cfg]);

  // Escanear con la webcam
  useEffect(() => {
    if (tab !== 'scan' || noCam) return;
    let stop = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = s; if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play().catch(() => {}); }
        const tick = () => {
          if (stop) return;
          const v = videoRef.current, cv = canvasRef.current;
          if (v && cv && v.videoWidth) {
            cv.width = v.videoWidth; cv.height = v.videoHeight;
            const ctx = cv.getContext('2d'); ctx.drawImage(v, 0, 0, cv.width, cv.height);
            const img = ctx.getImageData(0, 0, cv.width, cv.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code && code.data) {
              const p = decodeProv(code.data);
              if (p) { cleanup(); onApply(p); return; }
              if (parseEnroll(code.data)) { cleanup(); setBusy(true); setErr('Canjeando el link de enrolamiento…');
                resolveEnroll(code.data).then(c => { setBusy(false); if (c) onApply(c); else setErr('El link no es válido.'); })
                  .catch(e2 => { setBusy(false); setErr(String(e2.message || e2)); });
                return; }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) { setNoCam(true); setErr('No se pudo abrir la cámara: ' + (e && e.message ? e.message : e) + ' — usá "Pegar código".'); }
    })();
    const cleanup = () => { stop = true; cancelAnimationFrame(rafRef.current); try { streamRef.current && streamRef.current.getTracks().forEach(t => t.stop()); } catch {} streamRef.current = null; };
    return cleanup;
  }, [tab, noCam]); // eslint-disable-line

  async function applyPaste() {
    const txt = (paste || '').trim();
    const p = decodeProv(txt);
    if (p) { onApply(p); return; }
    if (parseEnroll(txt)) {
      setErr(''); setBusy(true);
      try { const c = await resolveEnroll(txt); setBusy(false); if (c) { onApply(c); return; } setErr('El link no devolvió una configuración válida.'); }
      catch (e) { setBusy(false); setErr(String(e.message || e)); }
      return;
    }
    setErr('Código inválido. Pegá el link https://tu-pbx/enroll?token=… , el texto pbxng://prov#… o el JSON del interno.');
  }
  function copyMine() { try { navigator.clipboard.writeText(encodeProv(cfg)); setErr('Copiado ✓'); } catch {} }

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(10,16,30,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40 }} onClick={onClose}>
      <div style={{ width: 420, maxWidth: '92%', background: '#fff', borderRadius: 16, overflow: 'hidden', boxShadow: '0 24px 60px rgba(10,20,50,.35)' }} onClick={e => e.stopPropagation()}>
        <div style={{ background: 'linear-gradient(160deg,#16233f,#0f1a30)', color: '#fff', padding: '16px 18px', fontWeight: 700, fontSize: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Configurar por QR</span>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,.15)', border: 'none', color: '#fff', borderRadius: 8, width: 28, height: 28, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ display: 'flex', borderBottom: `1px solid ${C.line}` }}>
          <button style={tabBtn(tab === 'scan')} onClick={() => { setErr(''); setTab('scan'); }}>Escanear</button>
          <button style={tabBtn(tab === 'paste')} onClick={() => { setErr(''); setTab('paste'); }}>Pegar código</button>
          <button style={tabBtn(tab === 'mine')} onClick={() => { setErr(''); setTab('mine'); }}>Mi QR</button>
        </div>
        <div style={{ padding: 18 }}>
          {tab === 'scan' && noCam && (<div style={{ textAlign: 'center', padding: '26px 10px' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>📷</div>
            <div style={{ fontWeight: 700, color: C.ink, marginBottom: 4 }}>No hay cámara disponible</div>
            <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 14 }}>En una PC sin webcam, configurá el interno pegando el código<br />de aprovisionamiento que genera el panel (Extensiones → QR).</div>
            <button style={prim} onClick={() => { setErr(''); setTab('paste'); }}>Pegar código</button>
          </div>)}
          {tab === 'scan' && !noCam && (<div>
            <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', background: '#0b0f17', borderRadius: 12, overflow: 'hidden' }}>
              <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <div style={{ position: 'absolute', inset: '18%', border: '3px solid rgba(47,128,255,.9)', borderRadius: 12, boxShadow: '0 0 0 9999px rgba(0,0,0,.25)' }} />
              <canvas ref={canvasRef} style={{ display: 'none' }} />
            </div>
            <div style={{ fontSize: 12, color: C.sub, textAlign: 'center', marginTop: 10 }}>Apuntá la cámara al QR del interno o al del link de enrolamiento.</div>
          </div>)}
          {tab === 'paste' && (<div>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>Pegá el <b>link de enrolamiento</b> que te dio el panel (<b>https://tu-pbx/enroll?token=…</b>) o el código <b>pbxng://prov#…</b>:</div>
            <textarea value={paste} onChange={e => setPaste(e.target.value)} rows={4} style={{ ...inp, resize: 'vertical' }} placeholder="https://pbx.tu-dominio.com/enroll?token=..." />
            <button style={{ ...prim, marginTop: 10, opacity: busy ? .6 : 1, cursor: busy ? 'wait' : 'pointer' }} disabled={busy} onClick={applyPaste}>{busy ? 'Configurando…' : 'Configurar'}</button>
          </div>)}
          {tab === 'mine' && (<div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 10 }}>Escaneá este QR desde otro equipo para configurarlo con este interno.</div>
            {qrImg ? <img src={qrImg} alt="QR" style={{ width: 240, height: 240 }} /> : <div style={{ color: C.sub, padding: 40 }}>Generando…</div>}
            <div style={{ fontSize: 11, color: C.red, margin: '10px 0' }}>⚠ Incluye la contraseña del interno. Compartilo solo con quien corresponda.</div>
            <button style={{ ...prim, background: '#0f1a30' }} onClick={copyMine}>Copiar código</button>
          </div>)}
          {err && <div style={{ fontSize: 12, color: /✓|copiado/i.test(err) ? C.green : C.red, marginTop: 10, textAlign: 'center' }}>{err}</div>}
        </div>
      </div>
    </div>
  );
}
