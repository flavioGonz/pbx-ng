/* Lo que se dibuja: el orbe de la llamada (canvas 2D), el fondo de puntos del login
 * (WebGL) y la escena con las cámaras del cliente.
 *
 * Son adornos con una obligación: no romper nada. Sin canvas, sin WebGL o sin audio tienen
 * que quedarse quietos sin errores; con «menos movimiento» pedido por el sistema dibujan un
 * cuadro y paran; al desmontarse liberan el contexto (un softphone corre ocho horas). Y la
 * escena de medios tiene que cambiar de cámara SIN desmontar el video, que es lo que evita
 * esperar de nuevo a que cargue justo cuando se quiere mirar. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import { streamCon } from './helpers/pantallas-app.jsx';
import { esponja, instalarAudio, quitarAudio, movimiento, RELOJES } from './helpers/pantallas-medios.js';
import Orbe, { COLOR_ESTADO } from '../src/Orbe.jsx';
import ShaderPuntos from '../src/ShaderPuntos.jsx';
import EscenaMedios, { useVideoRemoto } from '../src/MediosLlamada.jsx';

const getContextOriginal = HTMLCanvasElement.prototype.getContext;
let ctx2d, gl;
beforeEach(() => {
  vi.useFakeTimers({ toFake: RELOJES });
  movimiento(false);
  ctx2d = esponja();
  HTMLCanvasElement.prototype.getContext = function (tipo) { return tipo === '2d' ? ctx2d : null; };
});
afterEach(() => {
  vi.useRealTimers();
  quitarAudio();
  HTMLCanvasElement.prototype.getContext = getContextOriginal;
  delete window.matchMedia;
  delete globalThis.ResizeObserver;
});
const pasar = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const cuantas = (c, k) => c.llamadas.filter((x) => x[0] === k).length;

describe('orbe', () => {
  it('los colores son los de la barra de la llamada', () => {
    expect(COLOR_ESTADO).toEqual({ entrante: '#2bd95a', marcando: '#4c9aff', hablando: '#1a73f2', espera: '#f0b429', terminada: '#7c8794' });
  });

  it('dibuja en bucle al tamaño real de la pantalla y para al desmontarse', async () => {
    window.devicePixelRatio = 3;
    const { container, unmount } = render(<Orbe size={100} color="#abc" className="o" style={{ margin: 2 }} />);
    const cv = container.querySelector('canvas');
    expect(cv.width).toBe(200);                 // la densidad se limita a 2
    expect(cv.className).toBe('o');
    expect(cv.style.margin).toBe('2px');
    await pasar(50);
    const n = cuantas(ctx2d, 'clearRect');
    expect(n).toBeGreaterThan(1);
    expect(cuantas(ctx2d, 'createRadialGradient')).toBeGreaterThan(4);
    unmount();
    await pasar(50);
    expect(cuantas(ctx2d, 'clearRect')).toBe(n);
    window.devicePixelRatio = 1;
  });

  it('quieto o con «menos movimiento» dibuja un solo cuadro', async () => {
    render(<Orbe quieto color={undefined} />);
    await pasar(100);
    expect(cuantas(ctx2d, 'clearRect')).toBe(1);
    movimiento(true);
    ctx2d = esponja();
    render(<Orbe />);
    await pasar(100);
    expect(cuantas(ctx2d, 'clearRect')).toBe(1);
  });

  it('tolera un color nulo, densidad 0, sin matchMedia y el AudioContext con prefijo webkit', async () => {
    window.devicePixelRatio = 0;
    delete window.matchMedia;
    const ctxs = instalarAudio();
    window.webkitAudioContext = window.AudioContext;
    delete window.AudioContext;
    const { container, unmount } = render(<Orbe size={50} color={null} getStream={() => ({})} />);
    await pasar(100);
    expect(container.querySelector('canvas').width).toBe(50);
    expect(cuantas(ctx2d, 'clearRect')).toBeGreaterThan(1);
    expect(ctxs.length).toBe(1);
    unmount();
    window.devicePixelRatio = 1;
  });

  it('sin canvas 2D no hace nada', async () => {
    HTMLCanvasElement.prototype.getContext = () => null;
    const { container } = render(<Orbe />);
    await pasar(50);
    expect(container.querySelector('canvas')).toBeTruthy();
    expect(cuantas(ctx2d, 'clearRect')).toBe(0);
  });

  it('reacciona a la voz del otro lado: el disco crece con el audio', async () => {
    const ctxs = instalarAudio();
    const st = { id: 'a' };
    const { unmount } = render(<Orbe getStream={() => st} />);
    await pasar(50);
    const escalas = ctx2d.llamadas.filter((x) => x[0] === 'scale').map((x) => x[1]);
    expect(Math.max(...escalas)).toBeGreaterThan(1);
    unmount();
    expect(ctxs[0].close).toHaveBeenCalled();
  });

  it('sin audio o sin stream se mueve solo, y un cierre fallido no rompe', async () => {
    instalarAudio({ romper: true });
    const { unmount } = render(<Orbe getStream={() => ({})} />);
    await pasar(20);
    unmount();
    quitarAudio();
    const ctxs = instalarAudio();
    const r2 = render(<Orbe getStream={() => null} />);
    await pasar(20);
    expect(ctxs.length).toBe(0);
    r2.unmount();
    const ctxs2 = instalarAudio();
    const r3 = render(<Orbe getStream={() => ({})} />);
    ctxs2[0].close.mockImplementation(() => { throw new Error('ya cerrado'); });
    expect(() => r3.unmount()).not.toThrow();
    // quieto no escucha aunque haya stream
    const ctxs3 = instalarAudio();
    render(<Orbe quieto getStream={() => ({})} />);
    expect(ctxs3.length).toBe(0);
  });
});

describe('fondo de puntos (WebGL)', () => {
  function webgl({ compila = true, enlaza = true } = {}) {
    gl = esponja({
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, BLEND: 8, SRC_ALPHA: 9, ONE_MINUS_SRC_ALPHA: 10, TRIANGLES: 11,
      createShader: vi.fn((t) => ({ t })), createProgram: vi.fn(() => ({})),
      getShaderParameter: vi.fn(() => compila), getProgramParameter: vi.fn(() => enlaza),
      getUniformLocation: vi.fn((p, n) => n), getAttribLocation: vi.fn(() => 0),
      getExtension: vi.fn(() => ({ loseContext: vi.fn() })),
    });
    HTMLCanvasElement.prototype.getContext = function (t) { return t === 'webgl' ? gl : null; };
    return gl;
  }
  const uniformes = (k) => gl.llamadas.filter((x) => x[0] === 'uniform2f' && x[1] === k).map((x) => x.slice(2));

  it('con densidad 0 mide igual que con 1', async () => {
    window.devicePixelRatio = 0;
    webgl();
    render(<ShaderPuntos />);
    expect(gl.uniform1f).toHaveBeenCalledWith('uPix', 1);
    window.devicePixelRatio = 1;
  });

  it('sin WebGL queda el fondo liso, sin errores', () => {
    HTMLCanvasElement.prototype.getContext = () => { throw new Error('bloqueado'); };
    const { container } = render(<ShaderPuntos fondo="#123456" />);
    expect(container.querySelector('canvas').style.background).toBe('rgb(18, 52, 86)');
  });

  it('si el shader no compila o no enlaza, no dibuja', async () => {
    webgl({ compila: false });
    render(<ShaderPuntos />);
    await pasar(50);
    expect(gl.deleteShader).toHaveBeenCalled();
    expect(gl.drawArrays).not.toHaveBeenCalled();
    webgl({ enlaza: false });
    render(<ShaderPuntos />);
    await pasar(50);
    expect(gl.useProgram).not.toHaveBeenCalled();
  });

  it('dibuja en bucle, sigue al puntero y para con la pestaña escondida', async () => {
    webgl();
    const { container, unmount } = render(<ShaderPuntos colorA="#ff0000" colorB="nada" paso={10} fuerza={2} />);
    const cv = container.querySelector('canvas');
    expect(gl.uniform3fv).toHaveBeenCalledWith('uColA', [1, 0, 0]);
    expect(gl.uniform3fv).toHaveBeenCalledWith('uColB', [0.62, 0.71, 1.0]);
    expect(gl.uniform1f).toHaveBeenCalledWith('uPaso', 10);
    await pasar(50);
    expect(gl.drawArrays).toHaveBeenCalled();
    cv.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 100 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 40 });
    await pasar(20);
    expect(uniformes('uMouse').some(([x, y]) => x === 20 && y === 80)).toBe(true);
    fireEvent.pointerLeave(window);
    await pasar(20);
    expect(uniformes('uMouse').pop()).toEqual([-1, -1]);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const n = gl.drawArrays.mock.calls.length;
    await pasar(100);
    expect(gl.drawArrays.mock.calls.length).toBe(n);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    await pasar(50);
    expect(gl.drawArrays.mock.calls.length).toBeGreaterThan(n);
    // sin ResizeObserver se escucha el resize de la ventana
    window.dispatchEvent(new Event('resize'));
    unmount();
    expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    delete document.hidden;
  });

  it('con «menos movimiento» dibuja un cuadro y lo repite sólo al cambiar de tamaño', async () => {
    let alCambiar;
    globalThis.ResizeObserver = class { constructor(f) { alCambiar = f; } observe() {} disconnect() { this.cortado = true; } };
    movimiento(true);
    webgl();
    const { unmount, container } = render(<ShaderPuntos />);
    await pasar(100);
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    const cv = container.querySelector('canvas');
    Object.defineProperty(cv, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(cv, 'clientHeight', { configurable: true, value: 200 });
    alCambiar();
    expect(cv.width).toBe(300);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    // con la pestaña visible otra vez no arranca el bucle: el pedido de quietud se respeta
    document.dispatchEvent(new Event('visibilitychange'));
    await pasar(100);
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    gl.getExtension.mockImplementation(() => { throw new Error('perdido'); });
    expect(() => unmount()).not.toThrow();
  });

  it('si matchMedia explota se anima igual, y redimensionar sin quietud no redibuja de más', async () => {
    let alCambiar;
    globalThis.ResizeObserver = class { constructor(f) { alCambiar = f; } observe() {} disconnect() {} };
    window.matchMedia = () => { throw new Error('no'); };
    webgl();
    render(<ShaderPuntos />);
    await pasar(50);
    const n = gl.drawArrays.mock.calls.length;
    expect(n).toBeGreaterThan(1);
    alCambiar();
    expect(gl.drawArrays.mock.calls.length).toBe(n);
  });
});

describe('escena de medios', () => {
  const fuentes = [
    { id: 'llamada', label: 'Carlos', nodo: <video data-x="remoto" /> },
    { id: 'cam:1', label: 'Frente', nodo: <video data-x="frente" /> },
    { id: 'cam:2', label: 'Garaje', nodo: <video data-x="garaje" /> },
  ];

  it('una fuente en grande y el resto en miniaturas que se apilan bajo la cámara propia', () => {
    const elegir = vi.fn();
    const { container } = render(<EscenaMedios fuentes={fuentes} principal="cam:1" onPrincipal={elegir} />);
    expect(container.querySelector('.cs-fuente-main [data-x=frente]')).toBeTruthy();
    const minis = container.querySelectorAll('.cs-fuente-mini');
    expect(Array.from(minis).map((m) => m.style.top)).toEqual(['186px', '294px']);
    expect(screen.getByText('Carlos')).toBeTruthy();
    expect(screen.queryByText('Frente')).toBeNull();
    fireEvent.click(screen.getByTitle('Ver «Garaje» en grande'));
    expect(elegir).toHaveBeenCalledWith('cam:2');
    fireEvent.click(container.querySelector('.cs-fuente-main'));
    expect(elegir).toHaveBeenCalledTimes(1);
  });

  it('cambiar la principal no desmonta los videos', () => {
    const { container, rerender } = render(<EscenaMedios fuentes={fuentes} principal="llamada" onPrincipal={() => {}} />);
    const frente = container.querySelector('[data-x=frente]');
    rerender(<EscenaMedios fuentes={fuentes} principal="cam:1" onPrincipal={() => {}} />);
    expect(container.querySelector('[data-x=frente]')).toBe(frente);
  });

  it('si la cámara propia se movió de esquina, las miniaturas arrancan arriba', () => {
    localStorage.setItem('sp_video_esquina', 'inf-izq');
    const { container } = render(<EscenaMedios fuentes={fuentes} principal="llamada" onPrincipal={() => {}} />);
    expect(container.querySelector('.cs-fuente-mini').style.top).toBe('58px');
    const orig = localStorage.getItem;
    localStorage.getItem = () => { throw new Error('x'); };
    try {
      const r = render(<EscenaMedios fuentes={fuentes} principal="llamada" onPrincipal={() => {}} />);
      expect(r.container.querySelector('.cs-fuente-mini').style.top).toBe('186px');
    } finally { localStorage.getItem = orig; localStorage.clear(); }
  });

  it('useVideoRemoto: sólo una pista viva y con imagen cuenta como video', async () => {
    let st = streamCon('live', true);
    const { result, rerender, unmount } = renderHook(({ a, g }) => useVideoRemoto(a, g), { initialProps: { a: true, g: () => st } });
    expect(result.current).toBe(false);
    st = streamCon('live', false);
    await pasar(700);
    expect(result.current).toBe(true);
    st = streamCon('ended', false);
    await pasar(700);
    expect(result.current).toBe(false);
    st = {};
    await pasar(700);
    expect(result.current).toBe(false);
    st = streamCon('live', false);
    await pasar(700);
    rerender({ a: false, g: () => st });
    expect(result.current).toBe(false);
    rerender({ a: true, g: null });
    expect(result.current).toBe(false);
    unmount();
  });
});
