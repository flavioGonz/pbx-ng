/* La sala de reunión abierta desde un enlace (app/sala/[token]/page.jsx).
 *
 * Es la puerta del que NO es interno (el cliente, el proveedor, el que está en la calle):
 *  - Un enlace revocado o inexistente lo dice, en vez de quedarse en «Cargando…».
 *  - Sin nombre no se entra (es lo que ven los demás); con nombre se pide una sesión y se
 *    registra el softphone con la cámara sólo si la sala tiene video Y el invitado la dejó.
 *  - Con `?e=` (entrada de moderador abierta desde el panel) se entra solo, sin preguntar,
 *    y si después sale, se le explica que la entrada es de un solo uso (antes quedaba una
 *    tarjeta vacía sin nada que tocar).
 *  - Adentro: reloj, silenciar y salir; si la llamada se corta, «Saliste de la reunión».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderP, rutasFalsas, estado } from './helpers/porteria-render';

let busqueda = new URLSearchParams();
vi.mock('next/navigation', () => ({ useParams: () => ({ token: 'tok9' }), useSearchParams: () => busqueda }));
let sp;
vi.mock('../app/useSoftphone', () => ({ useSoftphone: () => sp }));
import SalaWeb from '../app/sala/[token]/page';

function nuevoSp(extra = {}) {
  return {
    reg: 'idle', call: null, muted: false,
    connect: vi.fn(async () => {}), placeCall: vi.fn(), hangup: vi.fn(), toggleMute: vi.fn(),
    audioRef: { current: null }, remoteVideoRef: { current: null }, localVideoRef: { current: null },
    ...extra,
  };
}

const SALA = { sala: 'Directorio', video: true, abierta: true };

beforeEach(() => { sp = nuevoSp(); busqueda = new URLSearchParams(); });
afterEach(() => { vi.useRealTimers(); });

/* Cambia lo que devuelve el softphone y vuelve a dibujar, como cuando SIP.js avisa algo. */
function softphone(r, cambios) { sp = { ...sp, ...cambios }; r.rerender(<SalaWeb />); }

describe('Sala web · antes de entrar', () => {
  it('mientras busca la sala dice Cargando; un enlace revocado lo explica', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas/web/tok9': estado(404) }));
    renderP(<SalaWeb />);
    expect(screen.getByText('Cargando…')).toBeTruthy();
    expect(await screen.findByText('Enlace no disponible')).toBeTruthy();
  });

  it('sala cerrada: el botón no deja entrar y lo dice', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas/web/tok9': { sala: 'Directorio', video: false, abierta: false } }));
    renderP(<SalaWeb />);
    expect(await screen.findByText('Reunión de audio · todavía no abrió')).toBeTruthy();
    expect(screen.getByText('La sala todavía no abrió').closest('button').disabled).toBe(true);
    expect(screen.queryByText('Entrar con cámara')).toBeNull();
    expect(screen.getByText(/Se usará tu micrófono\. No necesitás/)).toBeTruthy();
  });

  it('sin nombre no entra: pide que lo ponga', async () => {
    const f = rutasFalsas({ 'GET /salas/web/tok9': SALA });
    vi.stubGlobal('fetch', f);
    renderP(<SalaWeb />);
    fireEvent.click(await screen.findByText('Entrar a la reunión'));
    expect(screen.getByText(/Poné tu nombre/)).toBeTruthy();
    expect(f.de('POST', '/salas').length).toBe(0);
  });
});

describe('Sala web · invitado con nombre', () => {
  it('pide la sesión con el nombre, registra con cámara y marca al registrarse', async () => {
    const f = rutasFalsas({ 'GET /salas/web/tok9': SALA, 'POST /salas/web/tok9/session': { ext: 'w100', pass: 'x', dial: '9001', video: true } });
    vi.stubGlobal('fetch', f);
    const r = renderP(<SalaWeb />);
    expect(await screen.findByText('Reunión con video')).toBeTruthy();
    expect(screen.getByText(/y tu cámara/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Tu nombre'), { target: { value: '  Ana  ' } });
    fireEvent.click(screen.getByText('Entrar a la reunión'));
    expect(screen.getByText('Entrando a la reunión…')).toBeTruthy();
    await waitFor(() => expect(sp.connect).toHaveBeenCalledWith('w100', 'x', true, false));
    expect(f.de('POST', '/salas/web/tok9/session')[0].cuerpo).toEqual({ name: 'Ana' });
    softphone(r, { reg: 'registered' });
    expect(sp.placeCall).toHaveBeenCalledWith('9001');
    // Un segundo aviso de «registrado» no vuelve a marcar.
    softphone(r, { reg: 'registered', muted: false });
    expect(sp.placeCall).toHaveBeenCalledTimes(1);
  });

  it('sin cámara (el invitado la apagó) registra sólo audio y la reunión se ve en la tarjeta', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas/web/tok9': SALA, 'POST /salas/web/tok9/session': { ext: 'w1', pass: 'p', dial: '9001', video: true } }));
    const r = renderP(<SalaWeb />);
    fireEvent.change(await screen.findByPlaceholderText('Tu nombre'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByLabelText(/Entrar con cámara/));
    expect(screen.queryByText(/y tu cámara/)).toBeNull();
    fireEvent.click(screen.getByText('Entrar a la reunión'));
    await waitFor(() => expect(sp.connect).toHaveBeenCalledWith('w1', 'p', false, false));
    softphone(r, { call: 'Established' });
    expect(screen.getByText(/En la reunión · 0:00/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(65000); });
    expect(screen.getByText(/En la reunión · 1:05/)).toBeTruthy();
    fireEvent.click(screen.getByTitle('Silenciar'));
    expect(sp.toggleMute).toHaveBeenCalled();
    softphone(r, { muted: true });
    fireEvent.click(screen.getByTitle('Salir'));
    expect(sp.hangup).toHaveBeenCalled();
    softphone(r, { call: 'Terminated' });        // SIP.js confirma el corte
    expect(screen.getByText('Saliste de la reunión')).toBeTruthy();
    // Volver a entrar deja la tarjeta lista otra vez.
    fireEvent.click(screen.getByText('Volver a entrar'));
    expect(screen.getByText('Entrar a la reunión')).toBeTruthy();
  });

  it('con video ocupa la pantalla: reloj, silenciar y salir; si se corta, queda afuera', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas/web/tok9': SALA, 'POST /salas/web/tok9/session': { ext: 'w1', pass: 'p', dial: '9001', video: true } }));
    const r = renderP(<SalaWeb />);
    fireEvent.change(await screen.findByPlaceholderText('Tu nombre'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByText('Entrar a la reunión'));
    await waitFor(() => expect(sp.connect).toHaveBeenCalled());
    softphone(r, { call: 'Established', muted: true });
    expect(document.querySelectorAll('video').length).toBe(2);
    expect(screen.getByText('Directorio')).toBeTruthy();
    expect(screen.getByText('0:00')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Silenciar'));
    expect(sp.toggleMute).toHaveBeenCalled();
    softphone(r, { call: 'Terminated' });
    expect(screen.getByText('Saliste de la reunión')).toBeTruthy();
  });

  it('si la llamada se cae mientras entra, queda afuera', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas/web/tok9': SALA, 'POST /salas/web/tok9/session': { ext: 'w1', pass: 'p', dial: '9001' } }));
    const r = renderP(<SalaWeb />);
    fireEvent.change(await screen.findByPlaceholderText('Tu nombre'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByText('Entrar a la reunión'));
    await waitFor(() => expect(sp.connect).toHaveBeenCalledWith('w1', 'p', false, false));
    softphone(r, { call: 'Terminated' });
    expect(screen.getByText('Saliste de la reunión')).toBeTruthy();
  });

  it('si el registro falla mientras entra, avisa y deja reintentar', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas/web/tok9': SALA, 'POST /salas/web/tok9/session': { ext: 'w1', pass: 'p', dial: '9001' } }));
    const r = renderP(<SalaWeb />);
    fireEvent.change(await screen.findByPlaceholderText('Tu nombre'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByText('Entrar a la reunión'));
    await waitFor(() => expect(sp.connect).toHaveBeenCalled());
    softphone(r, { reg: 'error' });
    expect(screen.getByText(/Revisá tu conexión/)).toBeTruthy();
    fireEvent.click(screen.getByText('Reintentar'));
    expect(screen.getByPlaceholderText('Tu nombre')).toBeTruthy();
    expect(screen.queryByText(/Revisá tu conexión/)).toBeNull();
  });

  it('un error de la API o de red al pedir la sesión se muestra', async () => {
    let resp = { error: 'la sala está llena' };
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas/web/tok9': SALA, 'POST /salas/web/tok9/session': () => resp }));
    renderP(<SalaWeb />);
    fireEvent.change(await screen.findByPlaceholderText('Tu nombre'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByText('Entrar a la reunión'));
    expect(await screen.findByText('la sala está llena')).toBeTruthy();
    fireEvent.click(screen.getByText('Reintentar'));
    resp = new Error('red');
    fireEvent.click(screen.getByText('Entrar a la reunión'));
    expect(await screen.findByText('No se pudo entrar a la reunión.')).toBeTruthy();
    expect(sp.connect).not.toHaveBeenCalled();
  });
});

describe('Sala web · moderador desde el panel', () => {
  it('con entrada entra solo, sin pedir nombre, y al salir explica que la entrada se usó', async () => {
    busqueda = new URLSearchParams('e=ent1');
    const f = rutasFalsas({ 'GET /salas/web/tok9': SALA, 'POST /salas/entrada/ent1': { ext: 'm1', pass: 'q', dial: '9001', video: false } });
    vi.stubGlobal('fetch', f);
    const r = renderP(<SalaWeb />);
    expect(await screen.findByText('Entrás como moderador')).toBeTruthy();
    await waitFor(() => expect(sp.connect).toHaveBeenCalledWith('m1', 'q', false, false));
    expect(f.de('POST', '/salas/entrada/ent1').length).toBe(1);
    expect(screen.queryByPlaceholderText('Tu nombre')).toBeNull();
    softphone(r, { call: 'Established' });
    fireEvent.click(screen.getByTitle('Salir'));
    softphone(r, { call: 'Terminated' });
    fireEvent.click(screen.getByText('Volver a entrar'));
    // No vuelve a entrar sola (la entrada ya se quemó) y no queda una tarjeta muda.
    expect(screen.getByText(/La entrada de moderador sirve una sola vez/)).toBeTruthy();
    expect(f.de('POST', '/salas/entrada/ent1').length).toBe(1);
  });

  it('sin `useSearchParams` (prerender) se comporta como invitado', async () => {
    busqueda = null;
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas/web/tok9': SALA }));
    renderP(<SalaWeb />);
    expect(await screen.findByPlaceholderText('Tu nombre')).toBeTruthy();
  });
});
