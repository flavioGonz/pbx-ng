/* La vista de prueba de la pantalla de llamada (`?demo=call`) y el arranque de la app
 * (main.jsx): qué se monta, y qué se ve si algo explota.
 *
 * La vista de prueba existe para mirar los estados y sus transiciones sin levantar una
 * llamada: tiene que recorrerlos sola, dejar elegir uno a mano y no pelearse con las
 * pistas falsas de video y voz. El arranque tiene que esperar a la config cifrada antes de
 * montar, y si un componente explota mostrar el error con el stack (para soporte) en vez
 * de una ventana en blanco. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { instalarAudio, quitarAudio, esponja, RELOJES } from './helpers/pantallas-medios.js';
import './helpers/pantallas-app.jsx';
import DemoLlamada from '../src/DemoLlamada.jsx';

const getContextOriginal = HTMLCanvasElement.prototype.getContext;
let lienzos;
beforeEach(() => {
  vi.useFakeTimers({ toFake: RELOJES });
  lienzos = [];
  HTMLCanvasElement.prototype.getContext = function (t) { if (t !== '2d') return null; const c = esponja(); lienzos.push(c); return c; };
  HTMLCanvasElement.prototype.captureStream = function () { return { id: 'falso', getVideoTracks: () => [{ readyState: 'live', muted: false }] }; };
});
afterEach(() => { vi.useRealTimers(); quitarAudio(); HTMLCanvasElement.prototype.getContext = getContextOriginal; delete HTMLCanvasElement.prototype.captureStream; });
const pasar = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const chip = (t) => screen.getByText(t, { selector: '.dm-chip' });

describe('vista de prueba de la llamada', () => {
  it('recorre los estados sola, con las pistas falsas dibujándose', async () => {
    const audios = instalarAudio();
    const { container } = render(<DemoLlamada />);
    expect(screen.getByText('Llamada entrante')).toBeTruthy();
    expect(chip('Entra').className).toContain('dm-on');
    await pasar(2600);
    expect(chip('Entra+cam').className).toContain('dm-on');
    expect(screen.getAllByText('Casa Pérez').length).toBeGreaterThan(0);
    expect(container.querySelector('.cs-video-entrante')).toBeTruthy();
    await pasar(2600);
    expect(screen.getByText('Timbrando')).toBeTruthy();
    // los lienzos falsos se pintan y la voz falsa sube y baja
    expect(lienzos.some((c) => c.llamadas.some((x) => x[0] === 'fillText' && x[1] === 'EL OTRO LADO'))).toBe(true);
    expect(audios.length).toBe(1);
    // del último vuelve al primero
    fireEvent.click(chip('Cámaras'));
    fireEvent.click(screen.getByText('▶'));
    await pasar(2600);
    expect(chip('Entra').className).toContain('dm-on');
  });

  it('elegir un estado a mano frena el recorrido; ▶ lo retoma', async () => {
    instalarAudio();
    render(<DemoLlamada />);
    fireEvent.click(chip('Espera'));
    expect(screen.getAllByText('En espera').length).toBeGreaterThan(0);
    await pasar(2700);
    expect(chip('Espera').className).toContain('dm-on');
    expect(screen.getByText('▶')).toBeTruthy();
    fireEvent.click(screen.getByText('▶'));
    await pasar(2600);
    expect(chip('Fin').className).toContain('dm-on');
    expect(screen.getByText('Llamada finalizada')).toBeTruthy();
  });

  it('en una llamada hablando el teclado y «Más» funcionan, desde la barra o desde el mando', async () => {
    instalarAudio();
    const { container } = render(<DemoLlamada />);
    fireEvent.click(chip('Habla'));
    fireEvent.click(screen.getByTitle('Abrir o cerrar el teclado'));
    expect(container.querySelector('.cs-pad-in')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Teclado'));
    expect(container.querySelector('.cs-pad-out')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Más'));
    fireEvent.click(screen.getByText('Grabar la llamada'));
    expect(screen.queryByText('Grabar la llamada')).toBeNull();
    // los botones de la barra de la demo no hacen nada pero existen
    for (const t of ['Micrófono', 'Cámara web', 'Altavoz', 'En espera', 'Transferir', 'Terminar la llamada', 'Elegir micrófono', 'Elegir cámara web']) fireEvent.click(container.querySelector(`.cs-barra [title="${t}"]`));
    fireEvent.click(screen.getByTitle('Teclado'));
    fireEvent.click(container.querySelectorAll('.cs-tecla')[0]);
    expect(container.querySelector('.cs-pad-in')).toBeTruthy();
  });

  it('las cámaras del cliente se intercambian con un clic, y el video de la llamada también', async () => {
    instalarAudio();
    const { container } = render(<DemoLlamada />);
    fireEvent.click(chip('Cámaras'));
    await pasar(20);
    expect(container.querySelector('.cs-fuente-main').textContent).toBe('');
    fireEvent.click(screen.getByTitle('Ver «Garaje» en grande'));
    expect(screen.getByTitle('Ver «Frente» en grande')).toBeTruthy();
    fireEvent.click(chip('Video'));
    await pasar(20);
    const v = container.querySelector('.cs-fuente-main video');
    expect(v.srcObject).toBeTruthy();
    fireEvent.click(chip('Entra'));
    fireEvent.click(screen.getByTitle('Atender'));
    fireEvent.click(screen.getByTitle('Rechazar'));
    fireEvent.click(screen.getByTitle('Atender con video'));
    fireEvent.click(chip('Marca'));
    fireEvent.click(screen.getByTitle('Cortar'));
    expect(screen.getByText('Timbrando')).toBeTruthy();
  });

  it('sin audio en el equipo la voz falsa no existe y la vista anda igual', async () => {
    instalarAudio({ romper: true });
    render(<DemoLlamada />);
    fireEvent.click(chip('Habla'));
    await pasar(200);
    expect(screen.getByTitle('Terminar la llamada')).toBeTruthy();
  });

  it('si el navegador no deja programar la ganancia la voz sigue', async () => {
    instalarAudio();
    const ganancias = [];
    window.AudioContext.prototype.createGain = function () { const g = { gain: { value: 0, setTargetAtTime: vi.fn(() => { throw new Error('x'); }) }, connect: vi.fn() }; ganancias.push(g); return g; };
    render(<DemoLlamada />);
    await pasar(1000);
    expect(ganancias[0].gain.setTargetAtTime).toHaveBeenCalled();
    expect(screen.getByText('Llamada entrante')).toBeTruthy();
  });
});

describe('arranque (main.jsx)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
  });
  afterEach(() => { vi.doUnmock('../src/App.jsx'); vi.doUnmock('../src/DemoLlamada.jsx'); vi.doUnmock('../src/config.js'); window.history.replaceState(null, '', '/'); });

  function preparar({ app = () => <div>APP</div>, hidratar = () => Promise.resolve() } = {}) {
    vi.doMock('../src/App.jsx', () => ({ default: app }));
    vi.doMock('../src/DemoLlamada.jsx', () => ({ default: () => <div>DEMO</div> }));
    const hydrateSecure = vi.fn(hidratar);
    vi.doMock('../src/config.js', () => ({ hydrateSecure }));
    return hydrateSecure;
  }

  it('espera la config cifrada y monta la app', async () => {
    const h = preparar();
    await import('../src/main.jsx');
    expect(h).toHaveBeenCalled();
    await vi.waitFor(() => expect(document.body.textContent).toBe('APP'));
  });

  it('con ?demo=call monta la vista de prueba en vez de la app', async () => {
    window.history.replaceState(null, '', '/?demo=call');
    preparar();
    await import('../src/main.jsx');
    await vi.waitFor(() => expect(document.body.textContent).toBe('DEMO'));
  });

  it('si la app explota muestra el error con el stack y un botón para reiniciar', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    preparar({ app: () => { throw new Error('se rompió el render'); } });
    await import('../src/main.jsx');
    await vi.waitFor(() => expect(screen.getByText('Ocurrió un error en la app')).toBeTruthy());
    expect(document.querySelector('pre').textContent).toMatch(/se rompió el render/);
    expect(err).toHaveBeenCalledWith('[app] crash', expect.any(Error), expect.anything());
    fireEvent.click(screen.getByText('Reiniciar'));
    expect(screen.getByText('Ocurrió un error en la app')).toBeTruthy();
  });

  it('un error sin stack se muestra por su mensaje o tal cual', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // eslint-disable-next-line no-throw-literal
    preparar({ app: () => { throw { message: 'sin stack' }; } });
    await import('../src/main.jsx');
    await vi.waitFor(() => expect(document.querySelector('pre').textContent).toBe('sin stack'));
  });

  it('si lo que explota ni siquiera es un Error, se muestra como texto', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // eslint-disable-next-line no-throw-literal
    preparar({ app: () => { throw 'texto plano'; } });
    await import('../src/main.jsx');
    await vi.waitFor(() => expect(document.querySelector('pre').textContent).toBe('texto plano'));
  });

  it('un error de la ventana con su objeto se registra completo', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    preparar();
    await import('../src/main.jsx');
    const e = new Error('con objeto');
    window.dispatchEvent(new ErrorEvent('error', { error: e, message: 'x' }));
    expect(err).toHaveBeenCalledWith('[app] window.error', e);
  });

  it('aunque la consola misma falle, la pantalla de error aparece y la ventana sigue', async () => {
    // sólo fallan los registros propios de la app; los de React siguen andando
    vi.spyOn(console, 'error').mockImplementation((m) => { if (String(m).startsWith('[app]')) throw new Error('consola rota'); });
    preparar({ app: () => { throw new Error('render'); } });
    await import('../src/main.jsx');
    await vi.waitFor(() => expect(screen.getByText('Ocurrió un error en la app')).toBeTruthy());
    expect(() => window.dispatchEvent(new ErrorEvent('error', { message: 'x' }))).not.toThrow();
    const ev = new Event('unhandledrejection'); ev.reason = 'y';
    expect(() => window.dispatchEvent(ev)).not.toThrow();
  });

  it('si no se pueden instalar los avisos de error, la app arranca igual', async () => {
    const orig = window.addEventListener;
    window.addEventListener = () => { throw new Error('bloqueado'); };
    try {
      preparar();
      await import('../src/main.jsx');
    } finally { window.addEventListener = orig; }
    await vi.waitFor(() => expect(document.body.textContent).toBe('APP'));
  });

  it('los errores sueltos de la ventana quedan en la consola', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    preparar();
    await import('../src/main.jsx');
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }));
    expect(err).toHaveBeenCalledWith('[app] window.error', 'boom');
    const ev = new Event('unhandledrejection');
    ev.reason = 'promesa';
    window.dispatchEvent(ev);
    expect(err).toHaveBeenCalledWith('[app] unhandledrejection', 'promesa');
  });
});
