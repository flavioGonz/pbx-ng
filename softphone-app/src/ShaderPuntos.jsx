/* ============================================================================
 *  PBX-NG · Fondo de puntos con distorsión (WebGL, sin dependencias)
 *
 *  Reemplaza el video del login. Un video son megabytes que hay que servir, que
 *  tardan en arrancar y que en una central sin salida a Internet igual hay que
 *  empaquetar; esto son dos triángulos y un shader de 40 líneas, pesa nada y
 *  nunca se ve pixelado porque se dibuja a la resolución real de la pantalla.
 *
 *  Qué hace: una grilla de puntos a la que se le DEFORMA la posición antes de
 *  dibujarla —un campo de ruido lento, más un empujón radial donde está el
 *  puntero—. Los puntos no se mueven de a uno: se mueve el espacio donde viven,
 *  que es lo que da la sensación de tela.
 *
 *  Reglas: si el navegador no tiene WebGL queda el fondo liso (no hay error ni
 *  hueco), y con `prefers-reduced-motion` se dibuja UN cuadro y se corta el
 *  bucle —el fondo sigue estando, simplemente no se mueve—.
 * ==========================================================================*/
import { useEffect, useRef } from 'react';

const VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a,0.0,1.0); }`;

const FRAG = `precision highp float;
uniform vec2  uRes;
uniform float uT;
uniform vec2  uMouse;   // en pixeles; x < -0.5 = sin puntero
uniform float uPix;     // densidad de pixeles de la pantalla
uniform vec3  uColA;    // color del punto apagado
uniform vec3  uColB;    // color del punto encendido
uniform float uPaso;    // separacion de la grilla, en px CSS
uniform float uFuerza;  // cuanto se deforma

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
float ruido(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), u.x),
             mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), u.x), u.y);
}

void main(){
  vec2 p = gl_FragCoord.xy;
  float S = uPaso * uPix;
  float t = uT * 0.055;

  /* El campo que deforma: dos octavas de ruido, lentas y desfasadas. */
  vec2 n = vec2(
    ruido(p/(S*9.0) + vec2(t, 0.0)) + 0.5*ruido(p/(S*4.0) - vec2(0.0, t*1.7)),
    ruido(p/(S*9.0) + vec2(0.0, t) + 13.0) + 0.5*ruido(p/(S*4.0) + vec2(t*1.3, 0.0))
  ) - 0.75;
  vec2 q = p + n * S * uFuerza;

  /* El puntero empuja los puntos hacia afuera, y el efecto se apaga con la
     distancia: es la parte que hace que uno quiera mover el mouse. */
  if (uMouse.x > -0.5) {
    vec2 d = p - uMouse;
    float r = length(d) + 1e-4;
    q += (d/r) * exp(-r/(S*7.0)) * S * 2.8;
  }

  vec2 celda = floor(q / S);
  float dist = length(q - (celda + 0.5) * S);

  /* Cuanto brilla cada punto: otra onda, mas lenta todavia. */
  float f = ruido(celda*0.11 + vec2(t*1.4, -t*0.9));
  f = smoothstep(0.10, 0.92, f);

  float radio = (1.0 + 1.15*f) * uPix;
  float a = smoothstep(radio, radio - 1.25*uPix, dist);

  /* Viñeta: los bordes se apagan para que el texto de encima se lea. */
  vec2 c = (p / uRes) - 0.5;
  float vin = 1.0 - 0.75*smoothstep(0.42, 1.05, length(c));

  vec3 col = mix(uColA, uColB, f);
  gl_FragColor = vec4(col, a * (0.20 + 0.72*f) * vin);
}`;

function compilar(gl, tipo, src) {
  const s = gl.createShader(tipo);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
  return s;
}

const hexARgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

export default function ShaderPuntos({
  className, style,
  colorA = '#16305e',      // punto apagado
  colorB = '#9fb6ff',      // punto encendido
  fondo = '#05070c',
  paso = 21,
  fuerza = 1.8,
}) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return undefined;
    let gl = null;
    try { gl = cv.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false }); } catch (_) { gl = null; }
    if (!gl) return undefined;                 // sin WebGL: queda el fondo liso

    const prog = gl.createProgram();
    const vs = compilar(gl, gl.VERTEX_SHADER, VERT);
    const fs = compilar(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return undefined;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return undefined;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = (n) => gl.getUniformLocation(prog, n);
    const uRes = u('uRes'), uT = u('uT'), uMouse = u('uMouse'), uPix = u('uPix');
    gl.uniform3fv(u('uColA'), hexARgb(colorA) || [0.09, 0.19, 0.37]);
    gl.uniform3fv(u('uColB'), hexARgb(colorB) || [0.62, 0.71, 1.0]);
    gl.uniform1f(u('uPaso'), paso);
    gl.uniform1f(u('uFuerza'), fuerza);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const raton = { x: -1, y: -1 };
    let dpr = 1;
    const medir = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(cv.clientWidth * dpr));
      const h = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, cv.width, cv.height);
      gl.uniform2f(uRes, cv.width, cv.height);
      gl.uniform1f(uPix, dpr);
    };
    medir();

    const mover = (e) => {
      const r = cv.getBoundingClientRect();
      raton.x = (e.clientX - r.left) * dpr;
      raton.y = (r.height - (e.clientY - r.top)) * dpr;   // WebGL mide desde abajo
    };
    const salir = () => { raton.x = -1; raton.y = -1; };

    const quieto = (() => {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
    })();

    const pintar = (ms) => {
      gl.uniform1f(uT, ms / 1000);
      gl.uniform2f(uMouse, raton.x, raton.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    let raf = 0, vivo = true;
    const bucle = (ms) => { if (!vivo) return; pintar(ms); raf = requestAnimationFrame(bucle); };
    /* Con la pestaña escondida no se dibuja: un fondo animado en segundo plano es
       puro consumo de batería y de GPU para nadie. */
    const visibilidad = () => {
      if (document.hidden) { vivo = false; cancelAnimationFrame(raf); }
      else if (!quieto && !vivo) { vivo = true; raf = requestAnimationFrame(bucle); }
    };

    if (quieto) pintar(0);
    else raf = requestAnimationFrame(bucle);

    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => { medir(); if (quieto) pintar(0); }) : null;
    if (ro) ro.observe(cv); else window.addEventListener('resize', medir);
    window.addEventListener('pointermove', mover, { passive: true });
    window.addEventListener('pointerleave', salir, { passive: true });
    document.addEventListener('visibilitychange', visibilidad);

    return () => {
      vivo = false; cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', medir);
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerleave', salir);
      document.removeEventListener('visibilitychange', visibilidad);
      try { gl.getExtension('WEBGL_lose_context') && gl.getExtension('WEBGL_lose_context').loseContext(); } catch (_) {}
    };
  }, [colorA, colorB, paso, fuerza]);

  return <canvas ref={ref} aria-hidden className={className}
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', background: fondo, ...style }} />;
}
