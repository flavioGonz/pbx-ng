import { useEffect, useRef, useState } from 'react';

/* ── Reproductor de audio con onda, para el buzón de voz ─────────────────────
 *
 * El panel usa wavesurfer servido por la central (`/vendor/wavesurfer/`). Acá NO: el
 * softphone es una app de escritorio que tiene que andar con la central lejos o caída, y
 * bajarse un script de terceros en tiempo de ejecución para dibujar una onda es una
 * dependencia de red y una superficie más adentro del renderer. La onda se calcula con
 * WebAudio y se dibuja en un canvas: son unas decenas de líneas, no pesan nada y andan sin
 * red.
 *
 * El audio lo reproduce un <audio> normal. El canvas es sólo la pintura y el click para
 * saltar: separar las dos cosas es lo que hace que la reproducción no dependa de que la
 * onda se haya podido calcular. Si decodificar falla —un códec que el navegador no abre—
 * se muestra una barra de progreso lisa y se puede escuchar igual.
 */

const fmt = (s) => { s = Math.floor(s || 0); const m = Math.floor(s / 60), ss = s % 60; return m + ':' + (ss < 10 ? '0' : '') + ss; };
const VELOCIDADES = [0.75, 1, 1.25, 1.5, 2];

/* Picos del audio: un valor por barra, el máximo absoluto de su tramo. El máximo y no el
 * promedio porque el promedio aplana la voz hasta que la onda no dice nada. */
function picosDe(buffer, n) {
  const datos = buffer.getChannelData(0);
  const porBarra = Math.floor(datos.length / n) || 1;
  const out = new Float32Array(n);
  let techo = 0;
  for (let i = 0; i < n; i++) {
    let max = 0;
    const desde = i * porBarra, hasta = Math.min(desde + porBarra, datos.length);
    for (let j = desde; j < hasta; j++) { const v = datos[j] < 0 ? -datos[j] : datos[j]; if (v > max) max = v; }
    out[i] = max; if (max > techo) techo = max;
  }
  /* Normalizado: un mensaje grabado bajito tiene que verse igual que uno fuerte. */
  if (techo > 0) for (let i = 0; i < n; i++) out[i] /= techo;
  return out;
}

export default function ReproductorAudio({ src, nombre, C, S, autoPlay, onTranscribir, tx, iconos }) {
  const { IcPlay, IcPause, IcDown, IcVol, IcTexto } = iconos || {};
  const audioRef = useRef(null);
  const canvasRef = useRef(null);
  const [picos, setPicos] = useState(null);
  const [listo, setListo] = useState(false);
  const [sonando, setSonando] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [vel, setVel] = useState(1);
  const [vol, setVol] = useState(1);
  const [err, setErr] = useState('');

  /* Decodificar es aparte de reproducir: si falla, el audio se escucha igual. */
  useEffect(() => {
    if (!src) return undefined;
    let vivo = true;
    setPicos(null); setErr('');
    (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer();
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buf.slice(0));
        if (!vivo) { try { ctx.close(); } catch (_) {} return; }
        setPicos(picosDe(audio, 160));
        setDur((d) => d || audio.duration);
        try { ctx.close(); } catch (_) {}
      } catch (_) { /* sin onda, pero con audio */ }
    })();
    return () => { vivo = false; };
  }, [src]);

  /* Pintar. Se redibuja con el avance porque el progreso es parte del dibujo. */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const ancho = cv.clientWidth, alto = cv.clientHeight;
    if (!ancho || !alto) return;
    cv.width = ancho * dpr; cv.height = alto * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, ancho, alto);
    const avance = dur > 0 ? cur / dur : 0;

    if (!picos) {
      /* Sin onda: una barra de progreso lisa, que es honesta y no finge una forma. */
      const h = 4, y = (alto - h) / 2;
      g.fillStyle = C.line; g.fillRect(0, y, ancho, h);
      g.fillStyle = C.accent; g.fillRect(0, y, ancho * avance, h);
      return;
    }
    const n = picos.length;
    const paso = ancho / n;
    const grosor = Math.max(1.5, paso * 0.62);
    for (let i = 0; i < n; i++) {
      const h = Math.max(2, picos[i] * (alto - 4));
      const x = i * paso + (paso - grosor) / 2;
      const y = (alto - h) / 2;
      g.fillStyle = (i / n) <= avance ? C.accent : C.line;
      const r = Math.min(grosor / 2, 2);
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, grosor, h, r); else g.rect(x, y, grosor, h);
      g.fill();
    }
  }, [picos, cur, dur, C.accent, C.line]);

  const saltar = (e) => {
    const cv = canvasRef.current, a = audioRef.current;
    if (!cv || !a || !dur) return;
    const r = cv.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    a.currentTime = p * dur;
    setCur(a.currentTime);
  };
  const alternar = () => { const a = audioRef.current; if (!a) return; if (a.paused) a.play().catch(() => {}); else a.pause(); };
  const velocidad = (v) => { setVel(v); const a = audioRef.current; if (a) a.playbackRate = v; };
  const volumen = (v) => { setVol(v); const a = audioRef.current; if (a) a.volume = v; };

  const chip = (activo) => ({
    cursor: 'pointer', padding: '3px 8px', borderRadius: 8, fontSize: 11.5, fontWeight: 700, lineHeight: 1,
    background: activo ? C.accent : 'transparent', color: activo ? '#fff' : C.sub, border: 'none', transition: 'all .15s',
  });

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 11, background: C.card }}>
      <audio
        ref={audioRef} src={src} autoPlay={!!autoPlay} preload="auto"
        onLoadedMetadata={(e) => { setListo(true); if (Number.isFinite(e.target.duration)) setDur(e.target.duration); }}
        onTimeUpdate={(e) => setCur(e.target.currentTime)}
        onPlay={() => setSonando(true)} onPause={() => setSonando(false)}
        onEnded={() => setSonando(false)}
        onError={() => setErr('No se pudo abrir el audio.')}
        style={{ display: 'none' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={alternar} disabled={!!err}
          style={{ width: 42, height: 42, flex: 'none', borderRadius: '50%', border: 'none', cursor: err ? 'default' : 'pointer', background: err ? C.soft : C.accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {sonando ? (IcPause ? IcPause({ c: '#fff', s: 18 }) : '❚❚') : (IcPlay ? IcPlay({ c: '#fff', s: 18 }) : '▶')}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          {err
            ? <div style={{ fontSize: 12.5, color: C.red }}>{err}</div>
            : <canvas ref={canvasRef} onClick={saltar} style={{ width: '100%', height: 44, display: 'block', cursor: 'pointer' }} />}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, fontSize: 11, color: C.sub, fontFamily: 'ui-monospace, monospace' }}>
            <span>{fmt(cur)}</span><span>{fmt(dur)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, flex: 'none' }}>
          {VELOCIDADES.map((v) => <button key={v} onClick={() => velocidad(v)} style={chip(vel === v)}>{v}x</button>)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 86, flex: 'none' }}>
          {IcVol ? IcVol({ c: C.sub, s: 15 }) : null}
          <input type="range" min="0" max="1" step="0.05" value={vol} onChange={(e) => volumen(parseFloat(e.target.value))}
            style={{ flex: 1, accentColor: C.accent }} />
        </div>
        <a href={src} download={(nombre || 'mensaje') + '.wav'} title="Descargar"
          style={{ flex: 'none', width: 34, height: 34, borderRadius: 9, border: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.sub, textDecoration: 'none' }}>
          {IcDown ? IcDown({ c: C.sub, s: 16 }) : '↓'}
        </a>
      </div>

      {onTranscribir && (
        <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 10, paddingTop: 10 }}>
          {!tx ? (
            <button onClick={onTranscribir}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: 'none', background: 'rgba(139,92,246,.12)', color: '#b794f6', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>
              {IcTexto ? IcTexto({ c: '#b794f6', s: 14 }) : null} Transcribir
            </button>
          ) : tx.loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.sub }}>
              <span className="spin" style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #3f444d', borderTopColor: '#b794f6', display: 'block' }} /> Transcribiendo…
            </div>
          ) : tx.error ? (
            <div style={{ fontSize: 12, color: C.red }}>✕ {tx.error}</div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: C.sub }}>TRANSCRIPCIÓN</span>
                {tx.analysis && tx.analysis.words ? <span style={{ fontSize: 10.5, color: C.sub, marginLeft: 'auto' }}>{tx.analysis.words} palabras</span> : null}
                <button onClick={onTranscribir} style={{ border: 'none', background: 'none', color: C.sub, cursor: 'pointer', fontSize: 11, textDecoration: 'underline', marginLeft: tx.analysis && tx.analysis.words ? 8 : 'auto' }}>Rehacer</button>
              </div>
              <div style={{ background: C.soft, borderRadius: 9, padding: '9px 12px', fontSize: 13, color: C.ink, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 190, overflow: 'auto' }}>{tx.text}</div>
              {tx.analysis && Array.isArray(tx.analysis.keywords) && tx.analysis.keywords.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {tx.analysis.keywords.map((k) => (
                    <span key={k} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 7, background: 'rgba(26,115,242,.1)', color: '#7cb0ff', fontWeight: 600 }}>{k}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
