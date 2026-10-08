/* El reproductor del buzón de voz (ReproductorAudio, 0.21): onda dibujada con WebAudio,
 * velocidad, volumen, descarga y la transcripción adentro de la tarjeta.
 *
 * La regla que importa: decodificar es APARTE de reproducir. Si el navegador no abre el
 * códec, o no hay AudioContext, se ve una barra lisa y el mensaje se escucha igual; y el
 * contexto de audio se cierra siempre, porque Chromium tiene un tope por página y uno que
 * quede abierto en cada mensaje fallido termina dejando sin audio a la llamada. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import './helpers/pantallas-app.jsx';
import { esponja, quitarAudio } from './helpers/pantallas-medios.js';
import ReproductorAudio from '../src/ReproductorAudio.jsx';

const C = { line: '#333', accent: '#1a73f2', card: '#222', sub: '#888', soft: '#2b2f37', red: '#eb4c46', ink: '#eee' };
const ICONOS = {
  IcPlay: () => <i>play</i>, IcPause: () => <i>pausa</i>, IcDown: () => <i>bajar</i>,
  IcVol: () => <i>vol</i>, IcTexto: () => <i>txt</i>,
};
const getContextOriginal = HTMLCanvasElement.prototype.getContext;
let lienzo, contextos, decodificar, fetchFalso;

function instalarDecodificador() {
  contextos = [];
  decodificar = vi.fn(() => Promise.resolve({ duration: 12, getChannelData: () => Float32Array.from({ length: 640 }, (_, i) => (i % 2 ? -1 : 0.5) * (i / 640)) }));
  window.AudioContext = class { constructor() { this.close = vi.fn(); contextos.push(this); } decodeAudioData(b) { return decodificar(b); } };
}
beforeEach(() => {
  lienzo = esponja({ roundRect: vi.fn() });
  HTMLCanvasElement.prototype.getContext = () => lienzo;
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 320 });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 44 });
  fetchFalso = vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }));
  vi.stubGlobal('fetch', fetchFalso);
  instalarDecodificador();
});
afterEach(() => {
  vi.unstubAllGlobals();
  quitarAudio();
  HTMLCanvasElement.prototype.getContext = getContextOriginal;
  delete HTMLCanvasElement.prototype.clientWidth;
  delete HTMLCanvasElement.prototype.clientHeight;
});
const esperar = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const montar = (p = {}) => render(<ReproductorAudio src="blob:msg" nombre="buzon-2002" C={C} S={{}} iconos={ICONOS} {...p} />);
const llamadas = (k) => lienzo.llamadas.filter((x) => x[0] === k);

describe('onda', () => {
  it('decodifica, dibuja una barra por tramo y cierra el contexto', async () => {
    montar();
    await esperar();
    expect(fetchFalso).toHaveBeenCalledWith('blob:msg');
    expect(lienzo.roundRect).toHaveBeenCalledTimes(160);
    expect(screen.getByText('0:12')).toBeTruthy();
    expect(contextos[0].close).toHaveBeenCalled();
  });

  it('sin roundRect dibuja rectángulos', async () => {
    lienzo.roundRect = undefined;
    montar();
    await esperar();
    expect(llamadas('rect').length).toBe(160);
  });

  it('si el códec no se puede decodificar queda la barra lisa, y el contexto igual se cierra', async () => {
    decodificar.mockRejectedValueOnce(new Error('EncodingError'));
    montar();
    await esperar();
    expect(lienzo.roundRect).not.toHaveBeenCalled();
    expect(llamadas('fillRect').length).toBe(2);
    expect(contextos[0].close).toHaveBeenCalled();
    expect(screen.getAllByText('0:00').length).toBe(2);
  });

  it('sin AudioContext tampoco hay onda, y sin src no se pide nada', async () => {
    quitarAudio();
    const { unmount } = montar();
    await esperar();
    expect(llamadas('fillRect').length).toBe(2);
    unmount();
    fetchFalso.mockClear();
    montar({ src: '' });
    await esperar();
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it('con el prefijo webkit también decodifica', async () => {
    window.webkitAudioContext = window.AudioContext;
    delete window.AudioContext;
    montar();
    await esperar();
    expect(lienzo.roundRect).toHaveBeenCalled();
  });

  it('un mensaje en silencio no divide por cero', async () => {
    decodificar.mockResolvedValueOnce({ duration: 3, getChannelData: () => new Float32Array(10) });
    montar();
    await esperar();
    expect(lienzo.roundRect).toHaveBeenCalledTimes(160);
    expect(lienzo.roundRect.mock.calls.every((c) => c[3] === 2)).toBe(true);   // altura mínima
  });

  it('si se cierra antes de decodificar, no pinta tarde pero cierra el contexto', async () => {
    let soltar;
    decodificar.mockImplementationOnce(() => new Promise((r) => { soltar = r; }));
    const { unmount } = montar();
    await esperar();
    unmount();
    soltar({ duration: 1, getChannelData: () => new Float32Array(4) });
    await esperar();
    expect(lienzo.roundRect).not.toHaveBeenCalled();
    expect(contextos[0].close).toHaveBeenCalled();
  });

  it('si el canvas no tiene tamaño no dibuja; con densidad 0 usa 1', async () => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 0 });
    const r = montar();
    await esperar();
    expect(llamadas('clearRect').length).toBe(0);
    r.unmount();
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 100 });
    window.devicePixelRatio = 0;
    const { container } = montar();
    await esperar();
    expect(container.querySelector('canvas').width).toBe(100);
    window.devicePixelRatio = 1;
  });

  it('un cierre que explota no rompe nada', async () => {
    window.AudioContext = class { constructor() { this.close = () => { throw new Error('x'); }; } decodeAudioData() { return Promise.resolve({ duration: 1, getChannelData: () => new Float32Array(4) }); } };
    montar();
    await esperar();
    expect(lienzo.roundRect).toHaveBeenCalled();
  });
});

describe('reproducción', () => {
  it('play/pausa, avance, fin y duración del <audio>', async () => {
    const { container } = montar({ autoPlay: true });
    await esperar();
    const audio = container.querySelector('audio');
    expect(audio.autoplay).toBe(true);
    const play = vi.spyOn(audio, 'play');
    fireEvent.click(screen.getByText('play').closest('button'));
    expect(play).toHaveBeenCalled();
    fireEvent.play(audio);
    expect(screen.getByText('pausa')).toBeTruthy();
    Object.defineProperty(audio, 'paused', { configurable: true, value: false });
    const pausa = vi.spyOn(audio, 'pause').mockImplementation(() => {});
    fireEvent.click(screen.getByText('pausa').closest('button'));
    expect(pausa).toHaveBeenCalled();
    fireEvent.pause(audio);
    expect(screen.getByText('play')).toBeTruthy();
    fireEvent.play(audio);
    fireEvent.ended(audio);
    expect(screen.getByText('play')).toBeTruthy();
    Object.defineProperty(audio, 'duration', { configurable: true, value: 65 });
    fireEvent.loadedMetadata(audio);
    expect(screen.getByText('1:05')).toBeTruthy();
    Object.defineProperty(audio, 'duration', { configurable: true, value: Infinity });
    fireEvent.loadedMetadata(audio);
    expect(screen.getByText('1:05')).toBeTruthy();
    Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 5.7 });
    fireEvent.timeUpdate(audio);
    expect(screen.getByText('0:05')).toBeTruthy();
  });

  it('clic en la onda salta a ese punto; sin duración no hace nada', async () => {
    decodificar.mockRejectedValueOnce(new Error('x'));
    const { container } = montar();
    await esperar();
    const cv = container.querySelector('canvas');
    const audio = container.querySelector('audio');
    cv.getBoundingClientRect = () => ({ left: 10, width: 200 });
    fireEvent.click(cv, { clientX: 110 });
    expect(audio.currentTime).toBe(0);
    Object.defineProperty(audio, 'duration', { configurable: true, value: 40 });
    fireEvent.loadedMetadata(audio);
    let t = 0;
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => t, set: (v) => { t = v; } });
    fireEvent.click(cv, { clientX: 110 });
    expect(t).toBe(20);
    fireEvent.click(cv, { clientX: 500 });
    expect(t).toBe(40);
    expect(screen.getAllByText('0:40').length).toBe(2);
  });

  it('velocidad y volumen se aplican al audio', async () => {
    const { container } = montar();
    await esperar();
    const audio = container.querySelector('audio');
    fireEvent.click(screen.getByText('1.5x'));
    expect(audio.playbackRate).toBe(1.5);
    expect(screen.getByText('1.5x').style.color).toBe('rgb(255, 255, 255)');
    fireEvent.change(container.querySelector('input[type=range]'), { target: { value: '0.3' } });
    expect(audio.volume).toBeCloseTo(0.3);
  });

  it('si el audio no abre lo dice y apaga el botón', async () => {
    const { container } = montar();
    await esperar();
    fireEvent.error(container.querySelector('audio'));
    expect(screen.getByText('No se pudo abrir el audio.')).toBeTruthy();
    expect(screen.getByText('play').closest('button').disabled).toBe(true);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('la descarga lleva el nombre; sin íconos usa texto', async () => {
    const { container } = render(<ReproductorAudio src="blob:x" C={C} S={{}} />);
    await esperar();
    expect(container.querySelector('a').getAttribute('download')).toBe('mensaje.wav');
    expect(screen.getByText('▶')).toBeTruthy();
    expect(screen.getByText('↓')).toBeTruthy();
    fireEvent.play(container.querySelector('audio'));
    expect(screen.getByText('❚❚')).toBeTruthy();
    // sin íconos ni transcripción la tarjeta no ofrece transcribir
    expect(screen.queryByText(/Transcribir/)).toBeNull();
  });
});

describe('transcripción', () => {
  it('ofrece transcribir, muestra el progreso, el error y el texto con sus palabras clave', () => {
    const onT = vi.fn();
    const { rerender } = montar({ onTranscribir: onT });
    fireEvent.click(screen.getByText('Transcribir'));
    expect(onT).toHaveBeenCalledTimes(1);
    rerender(<ReproductorAudio src="blob:msg" C={C} S={{}} iconos={ICONOS} onTranscribir={onT} tx={{ loading: true }} />);
    expect(screen.getByText('Transcribiendo…')).toBeTruthy();
    rerender(<ReproductorAudio src="blob:msg" C={C} S={{}} iconos={ICONOS} onTranscribir={onT} tx={{ error: 'sin IA' }} />);
    expect(screen.getByText('✕ sin IA')).toBeTruthy();
    rerender(<ReproductorAudio src="blob:msg" C={C} S={{}} iconos={ICONOS} onTranscribir={onT} tx={{ text: 'Hola', analysis: { words: 1, keywords: ['puerta', 'mañana'] } }} />);
    expect(screen.getByText('Hola')).toBeTruthy();
    expect(screen.getByText('1 palabras')).toBeTruthy();
    expect(screen.getByText('mañana')).toBeTruthy();
    fireEvent.click(screen.getByText('Rehacer'));
    expect(onT).toHaveBeenCalledTimes(2);
    rerender(<ReproductorAudio src="blob:msg" C={C} S={{}} iconos={ICONOS} onTranscribir={onT} tx={{ text: 'Sin análisis' }} />);
    expect(screen.queryByText(/palabras/)).toBeNull();
    expect(screen.getByText('Rehacer').style.marginLeft).toBe('auto');
    rerender(<ReproductorAudio src="blob:msg" C={C} S={{}} iconos={ICONOS} onTranscribir={onT} tx={{ text: 'x', analysis: { keywords: [] } }} />);
    expect(screen.queryByText('puerta')).toBeNull();
  });
});
