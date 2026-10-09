/* ============================================================================
 *  Pizarra compartida de la videollamada (Scratchpad).
 *
 *  Lo que se fija: que se conecte al socket con la credencial correcta (la sesión de
 *  panel si hay, si no el token del softphone —desde 1.4.0 el socket exige JWT y un
 *  flag suelto dejaba colgarse a cualquiera—), que entre y salga de SU sala, y que los
 *  trazos viajen normalizados (0..1) para que se vean igual en pantallas de distinto
 *  tamaño. El dibujo en sí es canvas: se simula el contexto 2D y se mira qué se pintó.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

const sk = { conexiones: [], handlers: {}, emitidos: [], desconectado: false };
vi.mock('socket.io-client', () => ({
  io: (url, opts) => {
    sk.conexiones.push({ url, opts });
    return {
      on: (ev, fn) => { sk.handlers[ev] = fn; },
      emit: (ev, d) => sk.emitidos.push([ev, d]),
      disconnect: () => { sk.desconectado = true; },
    };
  },
}));

import Scratchpad from '../app/Scratchpad.jsx';

// Pantallas pesadas: con cobertura y suites en paralelo, 5 s no siempre alcanzan.
vi.setConfig({ testTimeout: 20000 });

let ctx;
function contextoFalso() {
  return {
    trazos: [], borrados: 0, restaurado: 0,
    beginPath() {}, moveTo(x, y) { this._de = [x, y]; }, lineTo(x, y) { this._a = [x, y]; },
    stroke() { this.trazos.push({ de: this._de, a: this._a, color: this.strokeStyle, ancho: this.lineWidth, modo: this.globalCompositeOperation }); },
    clearRect() { this.borrados++; },
    getImageData: () => ({ datos: true }),
    putImageData() { this.restaurado++; },
  };
}
function memoria(valores = {}) {
  return { getItem: (k) => (k in valores ? valores[k] : null), setItem() {} };
}

beforeEach(() => {
  Object.assign(sk, { conexiones: [], handlers: {}, emitidos: [], desconectado: false });
  ctx = contextoFalso();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 400, height: 200 });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Scratchpad', () => {
  it('con sesión de panel se conecta con el token del panel y entra a la sala al conectar', () => {
    vi.stubGlobal('localStorage', memoria({ pbxng_jwt: 'JWT-PANEL', pbxng_phone_jwt: 'JWT-FONO' }));
    const { unmount } = render(<Scratchpad room="1001-1002" onClose={() => {}} />);
    expect(sk.conexiones[0].opts.auth).toEqual({ token: 'JWT-PANEL' });
    expect(sk.conexiones[0].opts.path).toBe('/socket.io');
    act(() => sk.handlers.connect());
    expect(sk.emitidos).toContainEqual(['scratch:join', '1001-1002']);
    unmount();
    expect(sk.emitidos).toContainEqual(['scratch:leave', '1001-1002']);
    expect(sk.desconectado).toBe(true);
  });

  it('sin sesión de panel usa el token del softphone (scope phone); sin storage, uno vacío', () => {
    vi.stubGlobal('localStorage', memoria({ pbxng_phone_jwt: 'JWT-FONO' }));
    const r = render(<Scratchpad room="a" />);
    expect(sk.conexiones[0].opts.auth).toEqual({ scratch: 'JWT-FONO' });
    r.unmount();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('bloqueado'); } });
    render(<Scratchpad room="b" />);
    expect(sk.conexiones[1].opts.auth).toEqual({ scratch: '' });
  });

  it('dibujar con el mouse pinta y manda el trazo normalizado; la goma borra', () => {
    vi.stubGlobal('localStorage', memoria({ pbxng_jwt: 'x' }));
    const { container, getByLabelText } = render(<Scratchpad room="r" />);
    const lienzo = container.querySelector('canvas');
    // Mover sin apretar no dibuja.
    fireEvent.mouseMove(lienzo, { clientX: 50, clientY: 50 });
    expect(ctx.trazos).toHaveLength(0);
    fireEvent.mouseDown(lienzo, { clientX: 110, clientY: 120 });
    fireEvent.mouseMove(lienzo, { clientX: 210, clientY: 170 });
    expect(ctx.trazos[0]).toEqual({ de: [100, 100], a: [200, 150], color: '#ff3b30', ancho: 3.5, modo: 'source-over' });
    expect(sk.emitidos).toContainEqual(['scratch:op', { room: 'r', op: { x0: 0.25, y0: 0.5, x1: 0.5, y1: 0.75, color: '#ff3b30', erase: false } }]);
    fireEvent.mouseUp(lienzo);
    fireEvent.mouseMove(lienzo, { clientX: 300, clientY: 100 });
    expect(ctx.trazos).toHaveLength(1);
    // Otro color y después la goma.
    fireEvent.click(getByLabelText('#0a84ff'));
    fireEvent.mouseDown(lienzo, { clientX: 10, clientY: 20 });
    fireEvent.mouseMove(lienzo, { clientX: 20, clientY: 20 });
    expect(ctx.trazos[1].color).toBe('#0a84ff');
    fireEvent.mouseLeave(lienzo);
    const botones = container.querySelectorAll('button');
    const goma = botones[6];
    fireEvent.click(goma);
    fireEvent.mouseDown(lienzo, { clientX: 10, clientY: 20 });
    fireEvent.mouseMove(lienzo, { clientX: 30, clientY: 20 });
    expect(ctx.trazos[2]).toMatchObject({ ancho: 26, modo: 'destination-out' });
    fireEvent.click(goma);   // apaga la goma
    fireEvent.mouseMove(lienzo, { clientX: 40, clientY: 20 });
    expect(ctx.trazos[3].modo).toBe('source-over');
  });

  it('también dibuja con el dedo (touch)', () => {
    vi.stubGlobal('localStorage', memoria({}));
    const { container } = render(<Scratchpad room="t" />);
    const lienzo = container.querySelector('canvas');
    fireEvent.touchStart(lienzo, { touches: [{ clientX: 10, clientY: 20 }] });
    fireEvent.touchMove(lienzo, { touches: [{ clientX: 50, clientY: 60 }] });
    fireEvent.touchEnd(lienzo);
    expect(ctx.trazos[0]).toMatchObject({ de: [0, 0], a: [40, 40] });
  });

  it('pinta los trazos del otro lado escalados a este lienzo, y borra cuando el otro borra', () => {
    vi.stubGlobal('localStorage', memoria({}));
    render(<Scratchpad room="r" />);
    act(() => sk.handlers['scratch:op'](null));
    act(() => sk.handlers['scratch:op']({ x0: 0, y0: 0, x1: 0.5, y1: 1, color: '#fff', erase: false, w: 6 }));
    expect(ctx.trazos[0]).toEqual({ de: [0, 0], a: [200, 200], color: '#fff', ancho: 6, modo: 'source-over' });
    act(() => sk.handlers['scratch:clear']());
    expect(ctx.borrados).toBe(1);
  });

  it('borrar todo limpia el lienzo y avisa al otro; la X cierra; al cambiar el tamaño conserva el dibujo', () => {
    vi.stubGlobal('localStorage', memoria({}));
    const cerrar = vi.fn();
    const { container } = render(<Scratchpad room="r" onClose={cerrar} />);
    const botones = container.querySelectorAll('button');
    fireEvent.click(botones[7]);
    expect(ctx.borrados).toBe(1);
    expect(sk.emitidos).toContainEqual(['scratch:clear', { room: 'r' }]);
    fireEvent.click(botones[8]);
    expect(cerrar).toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(ctx.restaurado).toBe(1);
    // Si el contexto no deja restaurar, no rompe.
    ctx.putImageData = () => { throw new Error('tainted'); };
    expect(() => act(() => { window.dispatchEvent(new Event('resize')); })).not.toThrow();
  });

  it('si el socket falla al cerrar, el desmontaje sigue igual', () => {
    vi.stubGlobal('localStorage', memoria({}));
    const { unmount } = render(<Scratchpad room="r" />);
    sk.emitidos.push = () => { throw new Error('socket muerto'); };
    expect(() => unmount()).not.toThrow();
  });
});
