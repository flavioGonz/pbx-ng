import React, { useEffect, useRef } from 'react';

/* ============================================================================
 *  Softphone-NG · El orbe de la pantalla de llamada.
 *
 *  Reemplaza al círculo con iniciales. La razón no es decorativa: el avatar de un
 *  softphone casi nunca tiene foto —del otro lado hay un interno, un portero, un
 *  número— y dos letras sobre un círculo plano no dicen NADA del estado de la
 *  llamada. El orbe sí: su color es el estado (verde entra, azul hablando, ámbar en
 *  espera, gris terminada) y su movimiento dice que la llamada está viva.
 *
 *  Está dibujado en canvas 2D y no en WebGL a propósito: son cuatro manchas de color
 *  que derivan y se mezclan, el costo es despreciable, y un softphone que corre ocho
 *  horas en la máquina de alguien que además trabaja no puede pagar un contexto WebGL
 *  por una animación de adorno. Si el equipo pide menos movimiento
 *  (`prefers-reduced-motion`), se dibuja UN cuadro y se detiene: el color —que es lo
 *  que informa— queda igual.
 *
 *  El dibujo: un disco con degradé de arriba (blanco) a abajo (el color), y encima
 *  manchas del mismo color desenfocadas que se mueven en órbitas lentas de períodos
 *  primos entre sí, para que el conjunto no repita un patrón reconocible. Arriba, un
 *  brillo especular fijo que le da volumen; el borde, un aro apenas más claro.
 * ==========================================================================*/

/* Los colores del estado. Son los mismos que usa la barra de abajo: si el orbe dijera
 * una cosa y el botón otra, el orbe sería un adorno. */
export const COLOR_ESTADO = {
  entrante: '#2bd95a',
  marcando: '#4c9aff',
  hablando: '#1a73f2',
  espera: '#f0b429',
  terminada: '#7c8794',
};

function aRgb(hex) {
  const h = String(hex || '#1a73f2').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
/* Aclarar hacia el blanco: la banda de arriba del orbe es el color lavado, no otro color. */
const lavar = (c, k) => [0, 1, 2].map(i => Math.round(c[i] + (255 - c[i]) * k));
/* Y el otro lado: hundir hacia el negro. Sin una mancha oscura el orbe se lee como una
 * bola brillante y no como algo que se mueve por dentro. */
const hundir = (c, k) => [0, 1, 2].map(i => Math.round(c[i] * (1 - k)));

/* Las manchas. Cada una gira en su propia órbita, con períodos que no son múltiplos
 * entre sí para que el conjunto tarde mucho en repetirse. */
const MANCHAS = [
  { r: 0.46, orbita: 0.46, per: 13.0, fase: 0.0, luz: -0.34, alfa: 1 },    // la sombra
  { r: 0.44, orbita: 0.50, per: 17.0, fase: 2.1, luz: 0.00, alfa: 1 },    // el color puro
  { r: 0.40, orbita: 0.44, per: 23.0, fase: 4.0, luz: 0.95, alfa: 1 },    // el blanco
  { r: 0.38, orbita: 0.52, per: 29.0, fase: 5.5, luz: 0.58, alfa: 1 },    // el color lavado
];

export default function Orbe({ size = 132, color = '#1a73f2', quieto = false, getStream = null, className = '', style }) {
  const ref = useRef(null);
  /* El nivel del audio del OTRO lado, entre 0 y 1. Vive en un ref y no en el estado de
   * React a propósito: cambia sesenta veces por segundo y no tiene que repintar nada más
   * que el canvas. */
  const nivel = useRef(0);

  /* Escuchar el audio para que el orbe REACCIONE. Es la diferencia entre una animación
   * que adorna y una que informa: si el otro habla y el orbe no se mueve, el audio no
   * está llegando, y eso se ve sin abrir ningún diagnóstico. */
  useEffect(() => {
    if (!getStream || quieto) { nivel.current = 0; return undefined; }
    let ctx = null, raf = 0, parado = false;
    try {
      const st = getStream(); if (!st) return undefined;
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const anal = ctx.createAnalyser(); anal.fftSize = 512; anal.smoothingTimeConstant = 0.8;
      ctx.createMediaStreamSource(st).connect(anal);
      const buf = new Uint8Array(anal.fftSize);
      const medir = () => {
        if (parado) return;
        anal.getByteTimeDomainData(buf);
        let suma = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; suma += v * v; }
        const rms = Math.sqrt(suma / buf.length);
        /* Subir rápido y bajar despacio: el orbe acompaña la voz en vez de temblar con
         * cada sílaba. */
        const v = Math.min(1, rms * 6);
        nivel.current = v > nivel.current ? v : nivel.current * 0.90 + v * 0.10;
        raf = requestAnimationFrame(medir);
      };
      medir();
    } catch (_) { /* sin audio: el orbe se mueve solo, como antes */ }
    return () => { parado = true; cancelAnimationFrame(raf); try { ctx && ctx.close(); } catch (_) {} };
  }, [getStream, quieto]);
  useEffect(() => {
    const cv = ref.current; if (!cv) return undefined;
    const dpr = Math.min(2, (window.devicePixelRatio || 1));
    cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr);
    const ctx = cv.getContext('2d'); if (!ctx) return undefined;
    const base = aRgb(color);
    const R = size / 2;
    let raf = 0, parado = false;
    const menos = quieto || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    const pintar = (t) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      /* Y el disco entero crece apenas: 4 % con la voz al máximo. Más que eso se lee como
       * un globo que se infla y distrae. */
      const esc = 1 + nivel.current * 0.04;
      ctx.translate(R * (1 - esc), R * (1 - esc)); ctx.scale(esc, esc);
      ctx.save();
      ctx.beginPath(); ctx.arc(R, R, R, 0, Math.PI * 2); ctx.clip();

      /* Fondo: blanco arriba, color abajo. */
      const fondo = ctx.createLinearGradient(0, 0, 0, size);
      fondo.addColorStop(0, rgba(lavar(base, 0.96), 1));
      fondo.addColorStop(0.42, rgba(lavar(base, 0.42), 1));
      fondo.addColorStop(1, rgba(hundir(base, 0.18), 1));
      ctx.fillStyle = fondo; ctx.fillRect(0, 0, size, size);

      /* Las manchas, desenfocadas y mezcladas. Cuanto más fuerte habla el otro, más
       * lejos del centro viajan y más grandes se ven: el orbe «respira» con la voz. */
      const voz = nivel.current;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'blur(' + (size * 0.075).toFixed(1) + 'px)';
      for (const m of MANCHAS) {
        const a = (t / m.per) * Math.PI * 2 + m.fase;
        const orb = m.orbita * (1 + voz * 0.55);
        const x = R + Math.cos(a) * R * orb;
        const y = R + Math.sin(a * 0.73 + m.fase) * R * orb + R * 0.22;
        const col = m.luz < 0 ? hundir(base, -m.luz) : lavar(base, m.luz);
        const rr = R * m.r * (1 + voz * 0.30);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
        g.addColorStop(0, rgba(col, m.alfa));
        g.addColorStop(0.55, rgba(col, m.alfa * 0.75));
        g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
      }
      ctx.filter = 'none';

      /* El velo blanco de arriba. Es lo que hace que se lea como un orbe con luz propia y
       * no como manchas sueltas: las manchas viven abajo y la mitad de arriba se aclara. */
      const velo = ctx.createLinearGradient(0, 0, 0, size);
      velo.addColorStop(0, 'rgba(255,255,255,.88)');
      velo.addColorStop(0.34, 'rgba(255,255,255,.34)');
      velo.addColorStop(0.62, 'rgba(255,255,255,0)');
      ctx.fillStyle = velo; ctx.fillRect(0, 0, size, size);

      /* Brillo especular: un solo reflejo arriba a la izquierda, fijo. Da volumen sin
       * competir con el movimiento de abajo. */
      const br = ctx.createRadialGradient(R * 0.72, R * 0.52, 0, R * 0.72, R * 0.52, R * 0.95);
      br.addColorStop(0, 'rgba(255,255,255,.42)');
      br.addColorStop(0.4, 'rgba(255,255,255,.06)');
      br.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = br; ctx.fillRect(0, 0, size, size);
      ctx.restore();

      /* El aro del borde: sin esto el orbe se funde con el fondo oscuro. */
      ctx.beginPath(); ctx.arc(R, R, R - 0.75, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(lavar(base, 0.6), 0.35); ctx.lineWidth = 1.5; ctx.stroke();
    };

    if (menos) { pintar(3.2); return () => {}; }
    const t0 = performance.now();
    const lazo = (ahora) => {
      if (parado) return;
      pintar((ahora - t0) / 1000);
      raf = requestAnimationFrame(lazo);
    };
    raf = requestAnimationFrame(lazo);
    return () => { parado = true; cancelAnimationFrame(raf); };
  }, [size, color, quieto]);

  return <canvas ref={ref} className={className} aria-hidden
    style={{ width: size, height: size, borderRadius: '50%', display: 'block', flex: 'none', ...style }} />;
}
