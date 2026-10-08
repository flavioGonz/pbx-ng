/* Dobles de lo que jsdom no tiene y las pantallas de llamada usan para dibujar: el
 * contexto 2D de un canvas, WebGL, AudioContext y requestAnimationFrame.
 *
 * Los contextos son «esponjas»: cualquier método existe y queda registrado, para que la
 * prueba pueda preguntar si se dibujó sin tener que escribir los cien métodos del canvas. */
import { vi } from 'vitest';

export function esponja(base = {}) {
  const llamadas = [];
  const p = new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'llamadas') return llamadas;
      if (typeof k !== 'string') return undefined;
      t[k] = vi.fn((...a) => { llamadas.push([k, ...a]); return k.startsWith('create') && k.endsWith('Gradient') ? { addColorStop: vi.fn() } : undefined; });
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return p;
}

/* Un AudioContext que entrega siempre la misma señal: «alguien hablando». */
export function instalarAudio({ nivel = 200, romper = false } = {}) {
  const creados = [];
  class FakeAudio {
    constructor() {
      if (romper) throw new Error('sin audio');
      this.close = vi.fn(); this.resume = vi.fn(); this.currentTime = 0;
      creados.push(this);
    }
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createAnalyser() {
      return {
        fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128,
        getByteFrequencyData: (b) => b.fill(nivel),
        getByteTimeDomainData: (b) => { for (let i = 0; i < b.length; i++) b[i] = i % 2 ? 255 : 0; },
      };
    }
    createMediaStreamDestination() { return { stream: { id: 'voz' } }; }
    createOscillator() { return { type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn() }; }
    createGain() { return { gain: { value: 0, setTargetAtTime: vi.fn() }, connect: vi.fn() }; }
  }
  window.AudioContext = FakeAudio;
  globalThis.AudioContext = FakeAudio;
  return creados;
}
export function quitarAudio() { delete window.AudioContext; delete globalThis.AudioContext; delete window.webkitAudioContext; }

/* matchMedia con «menos movimiento» encendido o apagado. */
export function movimiento(reducido) {
  window.matchMedia = vi.fn(() => ({ matches: !!reducido, addEventListener() {}, removeEventListener() {} }));
}

export const RELOJES = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'];

/* jsdom no trae PointerEvent: sin esto los eventos de puntero llegan sin coordenadas. */
if (typeof window !== 'undefined' && !window.PointerEvent) {
  window.PointerEvent = class extends MouseEvent { constructor(t, i = {}) { super(t, i); this.pointerId = i.pointerId; } };
}
