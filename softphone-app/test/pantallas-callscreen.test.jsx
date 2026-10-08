/* La pantalla de llamada por sí sola: los cinco estados, la barra, el teclado, la onda del
 * audio real, la escena de video y la miniatura propia que se arrastra a una esquina.
 *
 * Quien atiende un portero mira esta pantalla todo el día. Cada estado tiene que decirse
 * con una palabra (no sólo con movimiento), los botones tienen que existir sólo cuando
 * tienen sentido (no se pone en espera algo que nadie atendió), y en video los controles
 * se esconden solos pero vuelven con cualquier movimiento. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { streamCon } from './helpers/pantallas-app.jsx';
import { instalarAudio, quitarAudio, RELOJES } from './helpers/pantallas-medios.js';
import CallScreen, { Reloj, colorAvatar, T } from '../src/CallScreen.jsx';

beforeEach(() => { vi.useFakeTimers({ toFake: RELOJES }); vi.setSystemTime(new Date('2026-10-08T12:00:00')); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); quitarAudio(); });
const pasar = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/* El gesto se pone en el cuadro siguiente (requestAnimationFrame). En el runner del CI,
 * más lento, a veces React necesita otra vuelta para aplicarlo: se avanza de a un cuadro,
 * dejando correr una vuelta real entre medio, hasta que aparece (o se agota el tope). */
async function hastaGesto(container, clase) {
  for (let i = 0; i < 30 && !container.querySelector(clase); i++) {
    await pasar(16);
    await act(() => new Promise((r) => setImmediate(r)));
  }
  return container.querySelector(clase);
}

function acciones() {
  return {
    colgar: vi.fn(), rechazar: vi.fn(), atender: vi.fn(), atenderVideo: vi.fn(), mute: vi.fn(), hold: vi.fn(),
    video: vi.fn(), altavoz: vi.fn(), transferir: vi.fn(), teclado: vi.fn(), mas: vi.fn(), tecla: vi.fn(),
    elegirMic: vi.fn(), elegirCam: vi.fn(),
  };
}
const base = (p = {}) => ({ estado: 'hablando', titulo: 'Carlos', subtitulo: '1008', iniciales: 'CA', desde: 0, calidad: 0, viaTurn: null, acciones: acciones(), flags: {}, ...p });

describe('colores y reloj', () => {
  it('el color del avatar sale del nombre y es estable', () => {
    expect(colorAvatar('Carlos')).toBe(colorAvatar('Carlos'));
    expect(colorAvatar('')).toBe(colorAvatar(null));
    expect(T.rojo).toBe('#eb4c46');
  });

  it('el reloj cuenta desde el inicio en hh:mm:ss y sin inicio queda en cero', async () => {
    const { container, rerender } = render(<Reloj desde={Date.now() - 3661000} className="x" />);
    expect(container.textContent).toBe('01:01:01');
    await pasar(1000);
    expect(container.textContent).toBe('01:01:02');
    rerender(<Reloj desde={0} />);
    expect(container.textContent).toBe('01:01:02');
    const { container: c2 } = render(<Reloj desde={Date.now() + 5000} />);
    expect(c2.textContent).toBe('00:00:00');
  });
});

describe('estados', () => {
  it('entrante: palabra, nombre con interno, atender/rechazar y sin barra', () => {
    const p = base({ estado: 'entrante' });
    const { container } = render(<CallScreen {...p} />);
    expect(screen.getByText('Llamada entrante')).toBeTruthy();
    expect(screen.getByText('Carlos (1008)')).toBeTruthy();
    expect(container.querySelector('.cs-sin-barra')).toBeTruthy();
    expect(container.querySelectorAll('.cs-reposo').length).toBe(4);
    fireEvent.click(screen.getByTitle('Atender'));
    fireEvent.click(screen.getByTitle('Atender con video'));
    fireEvent.click(screen.getByTitle('Rechazar'));
    expect(p.acciones.atender).toHaveBeenCalled();
    expect(p.acciones.atenderVideo).toHaveBeenCalled();
    expect(p.acciones.rechazar).toHaveBeenCalled();
    expect(screen.queryByTitle('Terminar la llamada')).toBeNull();
  });

  it('entrante sin video posible no ofrece atender con video', () => {
    const p = base({ estado: 'entrante', acciones: { ...acciones(), atenderVideo: null } });
    render(<CallScreen {...p} />);
    expect(screen.queryByTitle('Atender con video')).toBeNull();
  });

  it('marcando: la nota de la central reemplaza «Timbrando» y se puede cortar', () => {
    const p = base({ estado: 'marcando', subtitulo: '' });
    const { rerender, container } = render(<CallScreen {...p} />);
    expect(screen.getByText('Timbrando')).toBeTruthy();
    expect(screen.getByText('Carlos')).toBeTruthy();
    expect(container.querySelector('.cs-puntos')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Cortar'));
    expect(p.acciones.colgar).toHaveBeenCalled();
    rerender(<CallScreen {...p} nota="Ocupado" />);
    expect(screen.getByText('Ocupado')).toBeTruthy();
  });

  it('en espera y terminada dicen lo que pasa; la duración va abajo, no al lado del nombre', () => {
    const { rerender, container } = render(<CallScreen {...base({ estado: 'espera', flags: { held: true } })} />);
    expect(screen.getAllByText('En espera').length).toBeGreaterThan(0);
    expect(screen.getByTitle('Reanudar')).toBeTruthy();
    rerender(<CallScreen {...base({ estado: 'terminada', subtitulo: 'Duración 0:42', saliendo: true })} />);
    expect(screen.getByText('Llamada finalizada')).toBeTruthy();
    expect(screen.getByText('Carlos')).toBeTruthy();
    expect(container.querySelector('.cs-dur').textContent).toBe('Duración 0:42');
    expect(container.querySelector('.cs-sale')).toBeTruthy();
  });

  it('cada cambio de estado entra con su gesto', async () => {
    const { rerender, container } = render(<CallScreen {...base({ estado: 'entrante' })} />);
    expect(container.querySelector('.cs-entra')).toBeTruthy();
    rerender(<CallScreen {...base({ estado: 'hablando' })} />);
    expect(await hastaGesto(container, '.cs-asienta')).toBeTruthy();
    rerender(<CallScreen {...base({ estado: 'terminada' })} />);
    expect(await hastaGesto(container, '.cs-apaga')).toBeTruthy();
    rerender(<CallScreen {...base({ estado: 'marcando' })} />);
    expect(await hastaGesto(container, '.cs-entra')).toBeTruthy();
    // un estado desconocido usa el color de «hablando» y no rompe
    rerender(<CallScreen {...base({ estado: 'transfiriendo' })} />);
    expect(container.querySelector('.cs-centro')).toBeTruthy();
  });
});

describe('barra de la llamada', () => {
  it('la señal y el reloj dicen la calidad y el tiempo; TURN o directo sólo con la llamada andando', async () => {
    const { rerender, container } = render(<CallScreen {...base({ calidad: 3, desde: Date.now() - 5000, viaTurn: true })} />);
    expect(screen.getByTitle('Audio estable')).toBeTruthy();
    expect(screen.getByText('TURN')).toBeTruthy();
    expect(container.querySelector('.cs-barra').textContent).toContain('00:00:05');
    rerender(<CallScreen {...base({ calidad: 2, desde: Date.now(), viaTurn: false })} />);
    expect(screen.getByTitle('Audio con pérdidas')).toBeTruthy();
    expect(screen.getByText('directo')).toBeTruthy();
    expect(container.querySelector('rect[fill="#f0b429"]')).toBeTruthy();
    rerender(<CallScreen {...base({ calidad: 1 })} />);
    expect(container.querySelector('rect[fill="#eb4c46"]')).toBeTruthy();
    rerender(<CallScreen {...base({ calidad: 0, viaTurn: true })} />);
    expect(screen.getByTitle('Sin datos de calidad')).toBeTruthy();
    expect(screen.getByText('00:00:00')).toBeTruthy();
    expect(screen.queryByText('TURN')).toBeNull();
    rerender(<CallScreen {...base({ calidad: undefined })} />);
    expect(screen.getByTitle('Sin datos de calidad')).toBeTruthy();
  });

  it('cada botón llama a su acción, y los selectores de micrófono y cámara aparecen si hay', () => {
    const p = base({ flags: { muted: true, videoOn: false, altavoz: true, transfiriendo: true, pad: false } });
    const { container } = render(<CallScreen {...p} />);
    for (const t of ['Micrófono', 'Cámara web', 'Altavoz', 'En espera', 'Transferir', 'Teclado', 'Más', 'Terminar la llamada']) fireEvent.click(screen.getByTitle(t));
    expect(p.acciones.mute).toHaveBeenCalled();
    expect(p.acciones.video).toHaveBeenCalled();
    expect(p.acciones.altavoz).toHaveBeenCalled();
    expect(p.acciones.hold).toHaveBeenCalled();
    expect(p.acciones.transferir).toHaveBeenCalled();
    expect(p.acciones.teclado).toHaveBeenCalled();
    expect(p.acciones.mas).toHaveBeenCalled();
    expect(p.acciones.colgar).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Elegir micrófono'));
    fireEvent.click(screen.getByTitle('Elegir cámara web'));
    expect(p.acciones.elegirMic).toHaveBeenCalled();
    expect(p.acciones.elegirCam).toHaveBeenCalled();
    // micrófono y cámara apagados llevan la raya roja
    expect(container.querySelectorAll('line[style*="stroke: #eb4c46"], line[style*="stroke: rgb(235, 76, 70)"]').length).toBe(2);
  });

  it('sin cámara posible el botón queda apagado y explica por qué; los opcionales no aparecen', () => {
    const p = base({ acciones: { colgar: vi.fn(), mute: vi.fn() }, notaVideo: 'En SIP nativo el video se negocia al llamar' });
    const { rerender } = render(<CallScreen {...p} />);
    const cam = screen.getByTitle('En SIP nativo el video se negocia al llamar');
    expect(cam.disabled).toBe(true);
    expect(screen.queryByTitle('Altavoz')).toBeNull();
    expect(screen.queryByTitle('En espera')).toBeNull();
    expect(screen.queryByTitle('Transferir')).toBeNull();
    expect(screen.queryByTitle('Elegir micrófono')).toBeNull();
    rerender(<CallScreen {...p} notaVideo={undefined} />);
    expect(screen.getByTitle('La cámara no está disponible en esta llamada')).toBeTruthy();
  });

  it('«Más» abre su menú pegado al botón y se cierra tocando afuera', () => {
    const p = base({ flags: { masAbierto: true }, menuMas: <button>Grabar</button> });
    const { container, rerender } = render(<CallScreen {...p} />);
    expect(container.querySelector('.cs-mas-menu').textContent).toBe('Grabar');
    fireEvent.click(container.querySelector('.cs-mas-fuera'));
    expect(p.acciones.mas).toHaveBeenCalled();
    rerender(<CallScreen {...p} menuMas={null} />);
    expect(container.querySelector('.cs-mas-menu')).toBeNull();
  });

  it('el teclado entra, manda las teclas, y sale con animación antes de desmontarse', async () => {
    const p = base({ flags: { pad: true } });
    const { container, rerender } = render(<CallScreen {...p} />);
    expect(container.querySelector('.cs-pad-in')).toBeTruthy();
    expect(container.querySelector('.cs-con-pad')).toBeTruthy();
    fireEvent.click(screen.getByText('#').closest('button'));
    expect(p.acciones.tecla).toHaveBeenCalledWith('#');
    expect(screen.getByText('PQRS')).toBeTruthy();
    rerender(<CallScreen {...p} flags={{ pad: false }} />);
    expect(container.querySelector('.cs-pad-out')).toBeTruthy();
    await pasar(220);
    expect(container.querySelector('.cs-pad')).toBeNull();
    // sin acción de tecla no explota
    rerender(<CallScreen {...p} acciones={{}} flags={{ pad: true }} />);
    fireEvent.click(screen.getByText('5').closest('button'));
    expect(container.querySelector('.cs-pad')).toBeTruthy();
  });

  it('la ventana del sistema y las barras extra se dibujan donde van', () => {
    render(<CallScreen {...base({ ventana: <span>ventana</span>, extra: <span>ficha CRM</span> })} />);
    expect(screen.getByText('ventana')).toBeTruthy();
    expect(screen.getByText('ficha CRM')).toBeTruthy();
  });
});

describe('onda del audio real', () => {
  it('dibuja la forma con lo que llega del otro lado y la libera al cortar', async () => {
    const ctxs = instalarAudio({ nivel: 190 });
    const st = { id: 'audio' };
    const { container, unmount } = render(<CallScreen {...base({ getRemoteStream: () => st, getAudioStream: () => st })} />);
    const path = container.querySelector('.cs-onda-viva path');
    await pasar(50);
    expect(path.getAttribute('d')).not.toMatch(/^M0,36 L600,36 Z$/);
    expect(path.getAttribute('d')).toMatch(/Z$/);
    unmount();
    expect(ctxs.every((c) => c.close.mock.calls.length > 0)).toBe(true);
  });

  it('sin AudioContext o sin stream queda la línea quieta', async () => {
    instalarAudio({ romper: true });
    const { container, rerender } = render(<CallScreen {...base({ getRemoteStream: () => ({}) })} />);
    await pasar(50);
    expect(container.querySelector('.cs-onda-viva path').getAttribute('d')).toBe('M0,36 L600,36 Z');
    quitarAudio();
    instalarAudio();
    rerender(<CallScreen {...base({ getRemoteStream: () => null })} />);
    await pasar(50);
    expect(container.querySelector('.cs-onda-viva path').getAttribute('d')).toBe('M0,36 L600,36 Z');
  });
});

describe('escena de video', () => {
  const nodos = { medios: <div className="medios">MEDIOS</div>, yo: <video className="yo" /> };

  it('mientras no llega imagen se ve el orbe y se dice qué pasa; con imagen se va', async () => {
    let st = streamCon('live', true);
    const p = base({ video: true, videoNodes: nodos, getRemoteStream: () => st, desde: Date.now() });
    const { container } = render(<CallScreen {...p} />);
    expect(screen.getByText('MEDIOS')).toBeTruthy();
    expect(screen.getByText('Esperando el video del otro lado…')).toBeTruthy();
    expect(container.querySelector('.cs-video-top').textContent).toContain('Carlos (1008)');
    expect(container.querySelector('.cs-video-reloj')).toBeTruthy();
    expect(container.querySelector('.cs-centro').style.display).toBe('none');
    st = streamCon('live', false);
    await pasar(700);
    expect(screen.queryByText('Esperando el video del otro lado…')).toBeNull();
  });

  it('con una cámara del cliente en grande no se tapa con el orbe; sin medios usa el remoto', () => {
    const { rerender } = render(<CallScreen {...base({ video: true, videoNodes: nodos, principalEsCamara: true })} />);
    expect(screen.queryByText('Esperando el video del otro lado…')).toBeNull();
    rerender(<CallScreen {...base({ estado: 'espera', video: true, videoNodes: { remoto: <div>REMOTO</div>, yo: null } })} />);
    expect(screen.getByText('REMOTO')).toBeTruthy();
    expect(screen.getAllByText('En espera').length).toBeGreaterThan(0);
  });

  it('una entrante con imagen deja atender encima del video, sin la tarjeta propia', () => {
    const p = base({ estado: 'entrante', video: true, videoNodes: nodos, extra: <span>CRM</span> });
    const { container } = render(<CallScreen {...p} />);
    const caja = container.querySelector('.cs-video-entrante');
    expect(caja.textContent).toContain('Videollamada entrante');
    fireEvent.click(caja.querySelector('[title=Atender]'));
    fireEvent.click(caja.querySelector('[title="Atender con video"]'));
    fireEvent.click(caja.querySelector('[title=Rechazar]'));
    expect(p.acciones.atender).toHaveBeenCalled();
    expect(p.acciones.atenderVideo).toHaveBeenCalled();
    expect(p.acciones.rechazar).toHaveBeenCalled();
    expect(container.querySelector('.cs-yo')).toBeNull();
    const { container: c2 } = render(<CallScreen {...p} acciones={{ ...acciones(), atenderVideo: null }} />);
    expect(c2.querySelector('.cs-video-entrante [title="Atender con video"]')).toBeNull();
  });

  it('el rótulo de la entrante depende de si la llamada trae video, no de la escena', () => {
    const p = base({ estado: 'entrante', video: true, videoNodes: nodos });
    const { container, rerender } = render(<CallScreen {...p} anunciaVideo={false} />);
    expect(container.querySelector('.cs-video-entrante').textContent).toContain('Llamada entrante');
    expect(container.querySelector('.cs-video-entrante').textContent).not.toContain('Videollamada');
    rerender(<CallScreen {...base({ estado: 'entrante' })} anunciaVideo />);
    expect(screen.getByText('Videollamada entrante')).toBeTruthy();
  });

  it('los controles se esconden a los 3 s hablando y vuelven con el mouse o el teclado', async () => {
    const { container } = render(<CallScreen {...base({ video: true, videoNodes: nodos })} />);
    expect(container.querySelector('.cs-ocultos')).toBeNull();
    await pasar(3000);
    expect(container.querySelector('.cs-ocultos')).toBeTruthy();
    fireEvent.mouseMove(window);
    expect(container.querySelector('.cs-ocultos')).toBeNull();
    await pasar(3000);
    fireEvent.keyDown(window, { key: 'a' });
    expect(container.querySelector('.cs-ocultos')).toBeNull();
  });

  it('con la cámara apagada la miniatura dice «Cámara apagada» en vez de un negro', () => {
    const { rerender } = render(<CallScreen {...base({ video: true, videoNodes: nodos, flags: { videoOn: false } })} />);
    expect(screen.getByText('Cámara apagada')).toBeTruthy();
    rerender(<CallScreen {...base({ video: true, videoNodes: nodos, flags: { videoOn: true } })} />);
    expect(document.querySelector('.cs-yo .yo')).toBeTruthy();
  });

  it('la miniatura propia se arrastra y se acomoda a la esquina más cercana, y lo recuerda', () => {
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn(() => { throw new Error('ya liberado'); });
    localStorage.setItem('sp_video_esquina', 'inf-izq');
    const { container } = render(<div style={{ position: 'relative' }}><CallScreen {...base({ video: true, videoNodes: nodos, flags: { videoOn: true } })} /></div>);
    const yo = container.querySelector('.cs-yo');
    expect(yo.className).toContain('cs-yo-inf-izq');
    const caja = (l, t) => ({ left: l, top: t, width: 160, height: 90, right: l + 160, bottom: t + 90 });
    yo.getBoundingClientRect = () => caja(10, 10);
    yo.parentElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 });
    // un clic sin mover no cambia la esquina
    fireEvent.pointerDown(yo, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(yo, { pointerId: 1 });
    expect(yo.className).toContain('cs-yo-inf-izq');
    // moverse sin haber apretado no hace nada
    fireEvent.pointerMove(yo, { clientX: 500, clientY: 500 });
    expect(yo.style.left).toBe('');
    fireEvent.pointerDown(yo, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(yo, { clientX: 900, clientY: 40 });
    expect(yo.style.left).toBe('890px');
    yo.getBoundingClientRect = () => caja(890, 30);
    fireEvent.pointerUp(yo, { pointerId: 1 });
    expect(yo.className).toContain('cs-yo-sup-der');
    expect(localStorage.getItem('sp_video_esquina')).toBe('sup-der');
    expect(yo.style.left).toBe('');
    fireEvent.pointerDown(yo, { clientX: 900, clientY: 40, pointerId: 2 });
    fireEvent.pointerMove(yo, { clientX: 30, clientY: 560 });
    yo.getBoundingClientRect = () => caja(10, 500);
    fireEvent.pointerCancel(yo, { pointerId: 2 });
    expect(yo.className).toContain('cs-yo-inf-izq');
  });

  it('si el almacenamiento no anda, la miniatura arranca arriba a la derecha', () => {
    const orig = localStorage.getItem;
    localStorage.getItem = () => { throw new Error('bloqueado'); };
    try {
      const { container } = render(<CallScreen {...base({ video: true, videoNodes: nodos, flags: { videoOn: true } })} />);
      expect(container.querySelector('.cs-yo').className).toContain('cs-yo-sup-der');
    } finally { localStorage.getItem = orig; }
  });
});
