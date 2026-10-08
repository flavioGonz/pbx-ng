/* Panel de Agente (/agente): la pantalla con la que trabaja el que atiende.
 *
 * Se fija lo que le cambia el día al agente: el softphone se registra solo; la ficha del
 * cliente aparece al sonar/atender (y «no identificado» si no hay ficha, sin romper la
 * llamada); la pausa de colas refleja lo que contestó la central; al cortar se abre la
 * encuesta y valida los obligatorios; el historial filtra, cuenta repetidos del día y
 * reproduce la grabación bajándola CON token; y el cambio de clave exige la actual. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderNG, fetchFalso, estado, diferido } from './helpers/apps-render.jsx';

const notify = vi.hoisted(() => ({ toast: vi.fn() }));
const sesion = vi.hoisted(() => ({ user: { name: 'Ana Pérez', username: 'ana', ext: '1001' }, logout: vi.fn() }));
const tel = vi.hoisted(() => ({ sp: null }));
vi.mock('../app/notify', () => notify);
vi.mock('../app/auth', () => ({ useAuth: () => ({ user: sesion.user }), logout: (...a) => sesion.logout(...a) }));
vi.mock('../app/useSoftphone', () => ({ useSoftphone: () => tel.sp }));
vi.mock('../app/Softphone', () => ({ default: (p) => <div data-testid="softphone">{p.directory.length}|{String(p.dark)}<div data-testid="tarjeta">{p.onIncomingCard('099555')}</div></div> }));
vi.mock('../app/Intercom', () => ({ default: (p) => <div data-testid="intercom">{p.streams.length}|{p.emptyHint}</div> }));
vi.mock('../app/DesviosPanel', () => ({ default: (p) => <div data-testid="desvios">{p.ext}|{String(p.propio)}</div> }));

import AgentePanel from '../app/agente/page';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

const HOY = new Date();
const hace = (min) => new Date(HOY.getTime() - min * 60000).toISOString();
const CDR = [
  { src: '099111', dst: '1001', start: hace(5), billsec: 65, disposition: 'ANSWERED' },
  { src: '099111', dst: '1001', start: hace(15), billsec: 0, disposition: 'NO ANSWER' },
  { src: '099111', dst: '1001', start: hace(25), billsec: 0, disposition: 'BUSY' },
  { src: '1001', dst: '1002', start: hace(35), billsec: 30, disposition: 'ANSWERED' },
  { src: '099222', dst: '1001', start: '2020-01-01T10:00:00', billsec: 10, disposition: 'ANSWERED' },
  { src: '099333', dst: '1001', billsec: 0, disposition: 'NO ANSWER' },
];
const CLIENTE = {
  id: 7, name: 'Consorcio Rambla', doc: '21-123', address: 'Rambla 1234', notes: 'Portero en planta baja',
  persons: [{ id: 1, name: 'Juan', relation: 'encargado', doc: '1.234.567-8' }, { id: 2, name: 'Rosa' }],
  spaces: [{ id: 1, name: 'Hall', kind: 'acceso' }, { id: 2, name: 'Garaje' }],
  devices: [{ id: 'cam1' }, { id: 'cam2' }],
};

const rutas = (extra = {}) => ({
  'GET /me/sipcreds': { ext: '1001', password: 'p' },
  'GET /survey/fields': [],
  'GET /agent/state': { paused: false },
  'GET /cdr?ext=1001&limit=80': CDR,
  'GET /directory': [{ ext: '1002', name: 'Bruno' }],
  'GET /clients/lookup?number=099111': { id: 7, name: 'Consorcio Rambla' },
  'GET /clients/lookup?number=1002': null,
  'GET /clients/lookup?number=099222': estado(500),
  'GET /clients/lookup?number=099333': {},
  'GET /clients/lookup?number=099555': CLIENTE,
  'GET /clients/lookup?number=099666': {},
  ...extra,
});

let f; let pistas;
beforeEach(() => {
  notify.toast.mockReset(); sesion.logout.mockReset();
  sesion.user = { name: 'Ana Pérez', username: 'ana', ext: '1001' };
  tel.sp = { reg: 'registered', call: null, callInfo: null, incoming: null, connect: vi.fn(() => Promise.resolve()), placeCall: vi.fn() };
  f = fetchFalso(rutas());
  vi.stubGlobal('fetch', f);
  pistas = [{ stop: vi.fn() }];
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => pistas })) } });
  window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  window.HTMLMediaElement.prototype.pause = vi.fn();
  URL.createObjectURL = vi.fn(() => 'blob:grab');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.useRealTimers(); });

const fila = (txt) => screen.getAllByText(txt).map((e) => e.closest('tr')).find(Boolean);

describe('arranque y estado', () => {
  it('registra el softphone, muestra la cámara propia y el estado «En línea»', async () => {
    const { container } = renderNG(<AgentePanel />);
    await waitFor(() => expect(tel.sp.connect).toHaveBeenCalledWith('1001', 'p', false));
    expect(screen.getByText('En línea')).toBeTruthy();
    expect(screen.getByText('Ana Pérez')).toBeTruthy();
    expect(screen.getByText('Extensión 1001')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Disponible')).toBeTruthy());
    expect(container.querySelector('video').srcObject).toBeTruthy();
    expect(screen.getByTestId('desvios').textContent).toBe('1001|true');
    expect(screen.getByTestId('intercom').textContent).toMatch(/^0\|Al iniciar o recibir una llamada/);
    expect(screen.getByText('En espera')).toBeTruthy();
    // apagar y volver a encender la cámara
    fireEvent.click(container.querySelector('.tabler-icon-video-off').closest('button'));
    expect(pistas[0].stop).toHaveBeenCalled();
    expect(screen.getByText('Cámara apagada')).toBeTruthy();
    expect(screen.getByText('AP')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Encender cámara/ }));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
  });

  it('la cámara elegida en el dispositivo se respeta; cada error de cámara se explica', async () => {
    // Node trae su propio localStorage (vacío y sin archivo) que tapa al de jsdom: se simula.
    const almacen = { pbxng_dev_cam: 'cam-xyz' };
    vi.stubGlobal('localStorage', { getItem: (k) => almacen[k] ?? null, setItem() {}, removeItem: (k) => { delete almacen[k]; } });
    const a = renderNG(<AgentePanel />);
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { ideal: 'cam-xyz' } }, audio: false }));
    a.unmount();
    localStorage.removeItem('pbxng_dev_cam');
    for (const [nombre, txt] of [['NotAllowedError', 'Permiso denegado'], ['NotReadableError', 'Cámara en uso'], ['NotFoundError', 'Sin cámara'], ['Otro', 'No disponible']]) {
      navigator.mediaDevices.getUserMedia = vi.fn(() => Promise.reject(Object.assign(new Error('x'), { name: nombre })));
      const r = renderNG(<AgentePanel />);
      expect(await screen.findByText('Cámara: ' + txt)).toBeTruthy();
      r.unmount();
    }
    navigator.mediaDevices.getUserMedia = vi.fn(() => Promise.reject(null));
    const r = renderNG(<AgentePanel />);
    expect(await screen.findByText('Cámara: No disponible')).toBeTruthy();
    r.unmount();
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
    renderNG(<AgentePanel />);
    expect(await screen.findByText('Cámara: No soportado')).toBeTruthy();
  });

  it('sin extensión asignada lo avisa; si las credenciales fallan, también', async () => {
    sesion.user = { username: 'ana' };
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /me/sipcreds': {} })));
    const a = renderNG(<AgentePanel />);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Tu usuario no tiene extensión asignado', 'bad'));
    expect(screen.getByText('Extensión —')).toBeTruthy();
    expect(screen.getByText('Interno —')).toBeTruthy();
    expect(screen.getByText('Sin llamadas')).toBeTruthy();
    a.unmount();
    tel.sp.reg = 'connecting';
    tel.sp.connect = vi.fn(() => Promise.reject(new Error('x')));
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /me/sipcreds': estado(401) })));
    renderNG(<AgentePanel />);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Sesión vencida', 'bad'));
    expect(screen.getByText('Conectando…')).toBeTruthy();
  });

  it('la pausa refleja lo que contestó la central, y un error lo dice', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'GET /agent/state': { paused: true }, 'POST /agent/pause': (b) => (n++ === 2 ? estado(503, { error: 'AMI caído' }) : { paused: b.paused }) }));
    vi.stubGlobal('fetch', f);
    renderNG(<AgentePanel />);
    expect(await screen.findByRole('button', { name: /Reanudar/ })).toBeTruthy();
    expect(screen.getAllByText('En pausa').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: /Reanudar/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Disponible de nuevo', 'ok'));
    expect(f.de('POST', '/agent/pause')[0].cuerpo).toEqual({ paused: false });
    fireEvent.click(screen.getByRole('button', { name: /Tomar pausa/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('En pausa — no recibirás llamadas de cola', 'ok'));
    fireEvent.click(screen.getByRole('button', { name: /Reanudar/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No se pudo cambiar el estado', 'bad', { description: 'AMI caído' }));
    expect(screen.getByRole('button', { name: /Reanudar/ })).toBeTruthy();
  });

  it('salir cierra la sesión', () => {
    renderNG(<AgentePanel />);
    fireEvent.click(document.querySelector('.tabler-icon-logout').closest('button'));
    expect(sesion.logout).toHaveBeenCalled();
  });
});

describe('historial de llamadas', () => {
  it('muestra contacto, cliente, repetidos de hoy y estado; filtra contestadas y perdidas', async () => {
    renderNG(<AgentePanel />);
    await waitFor(() => expect(screen.getAllByText('Consorcio Rambla').length).toBe(3));
    expect(f.de('GET', '/clients/lookup?number=099111').length).toBe(1);   // cacheado: una vez por número
    const f1 = screen.getAllByText('Consorcio Rambla')[0].closest('tr');
    expect(f1.textContent).toContain('3×');
    expect(f1.textContent).toContain('01:05');
    expect(f1.textContent).toContain('Contestada');
    expect(fila('Bruno').textContent).toContain('Saliente');
    expect(fila('Bruno').textContent).toMatch(/—1/);                        // sin cliente, 1 hoy
    expect(fila('099222').textContent).toMatch(/—/);                         // de otro día
    expect(fila('099333').textContent).toContain('Perdida');
    fireEvent.click(screen.getByText('Contestadas'));
    expect(document.querySelectorAll('tbody tr').length).toBe(3);
    fireEvent.click(screen.getByText('Perdidas'));
    expect(document.querySelectorAll('tbody tr').length).toBe(3);
    expect(screen.queryByText('Bruno')).toBeNull();
    fireEvent.click(screen.getByText('Todas'));
    expect(document.querySelectorAll('tbody tr').length).toBe(6);
    // recargar a mano
    fireEvent.click(document.querySelector('.tabler-icon-refresh').closest('button'));
    await waitFor(() => expect(f.de('GET', '/cdr').length).toBe(2));
  });

  it('rellamar marca el número; deshabilitado en llamada', async () => {
    renderNG(<AgentePanel />);
    await waitFor(() => expect(fila('Bruno')).toBeTruthy());
    fireEvent.click(fila('Bruno').querySelector('.tabler-icon-phone').closest('button'));
    expect(tel.sp.placeCall).toHaveBeenCalledWith('1002');
  });

  it('la grabación se busca, se baja con token y se reproduce; después pausa/reanuda', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    f = fetchFalso(rutas({ 'GET /recordings/match': { id: 44 }, 'GET /recordings/44/audio': () => new Response(new Blob(['RIFF']), { status: 200 }) }));
    vi.stubGlobal('fetch', f);
    const { container, unmount } = renderNG(<AgentePanel />);
    await waitFor(() => expect(fila('Bruno')).toBeTruthy());
    fireEvent.click(fila('Bruno').querySelector('.tabler-icon-player-play').closest('button'));
    await waitFor(() => expect(container.querySelector('audio')).toBeTruthy());
    const pedido = f.de('GET', '/recordings/match')[0].ruta;
    expect(pedido).toBe(`/recordings/match?from=1001&to=1002&ts=${Date.parse(CDR[3].start)}`);
    expect(container.querySelector('audio').getAttribute('src')).toBe('blob:grab');
    act(() => { vi.advanceTimersByTime(100); });
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:grab');
  });

  it('sin grabación (o con error) el botón queda apagado y avisa', async () => {
    let n = 0;
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /recordings/match': () => (n++ ? estado(500, { error: 'Base caída' }) : {}) })));
    renderNG(<AgentePanel />);
    await waitFor(() => expect(fila('Bruno')).toBeTruthy());
    const b1 = fila('Bruno').querySelector('.tabler-icon-player-play').closest('button');
    fireEvent.click(b1);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Sin grabación para esta llamada', 'bad'));
    expect(b1.disabled).toBe(true);
    const b2 = fila('099222').querySelector('.tabler-icon-player-play').closest('button');
    fireEvent.click(b2);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Base caída', 'bad'));
  });
});

describe('llamada en curso', () => {
  it('al sonar busca la ficha del cliente y la muestra con personas, espacios, notas y video', async () => {
    tel.sp.incoming = { remoteIdentity: { uri: { user: '099555' } } };
    renderNG(<AgentePanel />);
    expect(await screen.findByText('Ficha del cliente en llamada')).toBeTruthy();
    expect((await screen.findAllByText('Consorcio Rambla')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Juan').length).toBe(2);                     // en la ficha y en la tarjeta del softphone
    expect(screen.getAllByText('encargado').length).toBe(2);
    expect(screen.getAllByText('Hall · acceso').length).toBe(2);
    expect(screen.getAllByText('Garaje').length).toBe(2);
    expect(screen.getAllByText('Portero en planta baja').length).toBe(2);
    expect(screen.getAllByText('CR').length).toBeGreaterThan(0);
    expect(screen.getByText('2 canal(es)')).toBeTruthy();
    expect(screen.getByTestId('intercom').textContent).toMatch(/^2\|/);
  });

  it('número sin ficha: «no identificado» y el video dice qué cargar', async () => {
    tel.sp.callInfo = { number: '099666' };
    tel.sp.call = { id: 1 };
    renderNG(<AgentePanel />);
    expect(await screen.findByText('Cliente no identificado para 099666')).toBeTruthy();
    expect(screen.getByTestId('intercom').textContent).toContain('Sin dispositivos de video para 099666');
    expect(screen.getByText('0 canal(es)')).toBeTruthy();
    // la tarjeta del softphone, sin cliente
    expect(screen.getByTestId('tarjeta').textContent).toBe('Cliente no identificado para 099555');
  });

  it('si la búsqueda de ficha falla se sigue atendiendo; si la llamada cambia antes de la respuesta, se descarta', async () => {
    const d = diferido();
    tel.sp.callInfo = { number: '099777' };
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /clients/lookup?number=099777': () => d.promise, 'GET /clients/lookup?number=099888': estado(500) })));
    const { rerender } = renderNG(<AgentePanel />);
    tel.sp = { ...tel.sp, callInfo: { number: '099888' } };
    rerender(<AgentePanel />);
    await act(async () => { d.resolve(CLIENTE); });
    expect(await screen.findByText('Cliente no identificado para 099888')).toBeTruthy();
    tel.sp = { ...tel.sp, callInfo: null };
    rerender(<AgentePanel />);
    expect(screen.queryByText('Ficha del cliente en llamada')).toBeNull();
  });

  it('al cortar abre la encuesta, valida obligatorios y guarda las respuestas con su etiqueta', async () => {
    const campos = [
      { id: 1, label: 'Motivo', ftype: 'select', options: ['Reclamo', 'Consulta'], required: true },
      { id: 2, label: 'Comentario', ftype: 'text' },
      { id: 3, label: 'Atención', ftype: 'rating' },
      { id: 4, label: 'Resuelto', ftype: 'bool' },
    ];
    let n = 0;
    f = fetchFalso(rutas({ 'GET /survey/fields': campos, 'POST /survey': () => (n++ ? {} : estado(500, { error: 'Base caída' })) }));
    vi.stubGlobal('fetch', f);
    tel.sp.call = { id: 1 }; tel.sp.callInfo = { number: '099555' };
    const { rerender } = renderNG(<AgentePanel />);
    await screen.findByText('Ficha del cliente en llamada');
    await waitFor(() => expect(f.de('GET', '/survey/fields').length).toBe(1));
    tel.sp = { ...tel.sp, call: null, callInfo: null };
    rerender(<AgentePanel />);
    expect(await screen.findByText('Encuesta de la llamada')).toBeTruthy();
    expect(screen.getByText('Llamada con 099555')).toBeTruthy();
    expect(screen.getByText('Motivo *')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(notify.toast).toHaveBeenCalledWith('Completá: Motivo', 'bad');
    fireEvent.click(screen.getByPlaceholderText('Elegí…'));
    fireEvent.click(await screen.findByRole('option', { name: 'Reclamo' }));
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Se rompió el portero' } });
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByText('Sí')).toBeTruthy();
    fireEvent.keyDown(document.querySelector('input[type="radio"][value="4"]'), { key: ' ' });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No se pudo guardar la encuesta', 'bad', { description: 'Base caída' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Encuesta registrada', 'ok'));
    expect(f.de('POST', '/survey')[1].cuerpo).toEqual({ ext: '1001', client_id: 7, caller: '099555', answers: { Motivo: 'Reclamo', Comentario: 'Se rompió el portero', Atención: 4, Resuelto: true } });
    await waitFor(() => expect(screen.queryByText('Encuesta de la llamada')).toBeNull());
  });

  it('la encuesta se puede omitir; sin campos configurados no aparece', async () => {
    f = fetchFalso(rutas({ 'GET /survey/fields': [{ id: 1, label: 'Nota', ftype: 'text' }] }));
    vi.stubGlobal('fetch', f);
    tel.sp.call = { id: 1 }; tel.sp.callInfo = { number: '099666' };
    const { rerender, unmount } = renderNG(<AgentePanel />);
    await waitFor(() => expect(f.de('GET', '/survey/fields').length).toBe(1));
    await screen.findByText('Cliente no identificado para 099666');
    tel.sp = { ...tel.sp, call: null, callInfo: null };
    rerender(<AgentePanel />);
    expect(await screen.findByText('Encuesta de la llamada')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Omitir' }));
    await waitFor(() => expect(screen.queryByText('Encuesta de la llamada')).toBeNull());
    unmount();
    // sin campos: cortar no abre nada
    vi.stubGlobal('fetch', fetchFalso(rutas()));
    tel.sp = { ...tel.sp, call: { id: 2 }, callInfo: { number: '099666' } };
    const b = renderNG(<AgentePanel />);
    tel.sp = { ...tel.sp, call: null, callInfo: null };
    b.rerender(<AgentePanel />);
    expect(screen.queryByText('Encuesta de la llamada')).toBeNull();
  });
});

describe('cambio de contraseña', () => {
  const abrir = () => fireEvent.click(document.querySelector('.tabler-icon-key').closest('button'));
  const llenar = (actual, nueva, rep) => {
    fireEvent.change(screen.getByLabelText('Contraseña actual'), { target: { value: actual } });
    fireEvent.change(screen.getByLabelText(/Nueva contraseña/), { target: { value: nueva } });
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: rep } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Guardar' }).pop());
  };

  it('valida actual, largo y coincidencia antes de mandar', async () => {
    renderNG(<AgentePanel />);
    abrir();
    expect(await screen.findByText('Cambiar mi contraseña')).toBeTruthy();
    llenar('', '', '');
    expect(notify.toast).toHaveBeenCalledWith('Indicá tu contraseña actual', 'bad');
    llenar('vieja-clave', 'corta', 'corta');
    expect(notify.toast).toHaveBeenCalledWith('Mínimo 8 caracteres', 'bad');
    llenar('vieja-clave', 'nueva-clave-1', 'nueva-clave-2');
    expect(notify.toast).toHaveBeenCalledWith('No coinciden', 'bad');
    expect(f.de('POST', '/auth/password').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Cambiar mi contraseña')).toBeNull());
  });

  it('manda la actual y la nueva; si la actual está mal lo dice y no cierra', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'POST /auth/password': () => (n++ ? {} : estado(403, { error: 'La contraseña actual no es correcta' })) }));
    vi.stubGlobal('fetch', f);
    renderNG(<AgentePanel />);
    abrir();
    await screen.findByText('Cambiar mi contraseña');
    llenar('mala-clave', 'nueva-clave-1', 'nueva-clave-1');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('La contraseña actual no es correcta', 'bad'));
    expect(screen.getByText('Cambiar mi contraseña')).toBeTruthy();
    llenar('vieja-clave', 'nueva-clave-1', 'nueva-clave-1');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Contraseña actualizada', 'ok'));
    expect(f.de('POST', '/auth/password')[1].cuerpo).toEqual({ current: 'vieja-clave', password: 'nueva-clave-1' });
    await waitFor(() => expect(screen.queryByText('Cambiar mi contraseña')).toBeNull());
  });
});
