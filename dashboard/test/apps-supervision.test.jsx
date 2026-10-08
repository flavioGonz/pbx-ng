/* Supervisor y Wallboard: las dos pantallas de «mirar la operación en vivo».
 *
 * Supervisor: su softphone se registra solo con las credenciales SIP del usuario, y
 * escuchar/susurrar/irrumpir NO se dispara si no hay extensión o el softphone no está en
 * línea (si no, la central llama a un teléfono que no existe y el supervisor no se entera).
 * Wallboard: los números del día vienen de la API, lo vivo del socket; las colas cruzan
 * ambas fuentes; la pantalla completa entra y sale; y cada llamada en curso se puede cortar. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderNG, fetchFalso, estado, diferido } from './helpers/apps-render.jsx';

const notify = vi.hoisted(() => ({ toast: vi.fn() }));
const sesion = vi.hoisted(() => ({ user: { name: 'Sofía', username: 'sofi', ext: '2000' }, logout: vi.fn() }));
const tel = vi.hoisted(() => ({ sp: null }));
const vivo = vi.hoisted(() => ({ snap: null, connected: true }));
vi.mock('../app/notify', () => notify);
vi.mock('../app/auth', () => ({ useAuth: () => ({ user: sesion.user }), logout: (...a) => sesion.logout(...a) }));
vi.mock('../app/useSoftphone', () => ({ useSoftphone: () => tel.sp }));
vi.mock('../app/Softphone', () => ({ default: (p) => <div data-testid="softphone">{p.directory.length} internos · {String(p.dark)}</div> }));
vi.mock('../app/ClientesLibreta', () => ({ default: (p) => (p.opened ? <div>libreta abierta <button type="button" onClick={p.onClose}>cerrar libreta</button></div> : null) }));
vi.mock('../app/useLive', () => ({ useLive: () => ({ snap: vivo.snap, connected: vivo.connected }) }));
vi.mock('../app/Slot', () => ({ default: ({ value }) => <span>{value == null ? '' : String(value)}</span> }));
vi.mock('next/link', () => ({ default: ({ href, children, ...p }) => <a href={href} {...p}>{children}</a> }));

import SupervisorPanel from '../app/supervisor/page';
import Wallboard from '../app/wallboard/page';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

const boton = (fila, icono) => fila.querySelector('.tabler-icon-' + icono).closest('button');

describe('Supervisor', () => {
  let f;
  const rutas = (extra = {}) => ({
    'GET /me/sipcreds': { ext: '2000', password: 'x' },
    'GET /directory': [{ ext: '2000', name: 'Sofía' }, { ext: '1001', name: 'Ana' }, { ext: '1002' }, { ext: '1003' }, { ext: '1004' }],
    'GET /presence': { 1001: 'inuse', 1002: 'available', 1003: 'unavailable' },
    'GET /queues': [{ name: 'ventas', strategy: 'ringall' }, { name: 'soporte' }, { name: 'rota' }],
    'GET /queues/ventas/live': { waiting: [{}, {}], agents: [{ name: 'PJSIP/1001', paused: true }, { interface: 'PJSIP/1002' }] },
    'GET /queues/soporte/live': { callers: [], members: [{ ext: '1003' }, { membername: 'Juan' }, '1004'] },
    'GET /queues/rota/live': estado(500),
    'POST /calls/spy': {},
    ...extra,
  });
  beforeEach(() => {
    notify.toast.mockReset(); sesion.logout.mockReset();
    sesion.user = { name: 'Sofía', username: 'sofi', ext: '2000' };
    tel.sp = { reg: 'registered', call: null, connect: vi.fn(() => Promise.resolve()), hangup: vi.fn() };
    f = fetchFalso(rutas());
    vi.stubGlobal('fetch', f);
  });

  it('registra el softphone con las credenciales del usuario y muestra agentes con su estado', async () => {
    renderNG(<SupervisorPanel />, { esquema: 'light' });
    await waitFor(() => expect(tel.sp.connect).toHaveBeenCalledWith('2000', 'x', false));
    expect(screen.getByText('Sofía · extensión 2000')).toBeTruthy();
    expect(screen.getByText('Softphone en línea')).toBeTruthy();
    expect(await screen.findByText('Ana')).toBeTruthy();
    // el propio supervisor no aparece en la lista de agentes
    expect(screen.queryByText('2000', { selector: 'td' })).toBeNull();
    const fila = (ext) => screen.getByText(ext, { selector: 'td' }).closest('tr');
    expect(fila('1001').textContent).toContain('en llamada');
    expect(fila('1002').textContent).toContain('libre');
    expect(fila('1003').textContent).toContain('unavailable');
    expect(fila('1004').textContent).toContain('offline');
    expect(fila('1002').textContent).toContain('—');
    expect(screen.getByTestId('softphone').textContent).toBe('5 internos · false');
    // atajos a las pantallas del supervisor
    expect(screen.getByRole('link', { name: /Reportes/ }).getAttribute('href')).toBe('/reportes');
  });

  it('las colas en vivo muestran espera, agentes y pausas; una cola sin datos no tapa al resto', async () => {
    renderNG(<SupervisorPanel />);
    expect(await screen.findByText('2 en espera')).toBeTruthy();
    expect(screen.getByText('1001 (pausa)')).toBeTruthy();
    expect(screen.getByText('1002', { selector: '.mantine-Badge-label' })).toBeTruthy();
    expect(screen.getByText('Juan')).toBeTruthy();
    expect(screen.getByText('· ringall')).toBeTruthy();
    const rota = screen.getByText('rota').closest('.mantine-Card-root');
    expect(rota.textContent).toContain('0 en espera');
    expect(rota.textContent).toContain('0 agentes');
    expect(f.de('GET', '/queues/soporte/live').length).toBe(1);
  });

  it('escuchar / susurrar / irrumpir piden el espionaje con la extensión del supervisor', async () => {
    renderNG(<SupervisorPanel />);
    await screen.findByText('Ana');
    const fila = screen.getByText('1001', { selector: 'td' }).closest('tr');
    for (const [ico, modo, txt] of [['ear', 'listen', 'Escucha'], ['microphone', 'whisper', 'Susurro'], ['urgent', 'barge', 'Irrupción']]) {
      fireEvent.click(boton(fila, ico));
      await waitFor(() => expect(notify.toast).toHaveBeenCalledWith(txt + ' → 1001. Atendé tu softphone.', 'ok'));
      expect(f.de('POST', '/calls/spy').pop().cuerpo).toEqual({ sup: '2000', target: '1001', mode: modo });
    }
  });

  it('si la central rechaza el espionaje lo dice', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'POST /calls/spy': estado(409, { error: 'el agente no está en llamada' }) })));
    renderNG(<SupervisorPanel />);
    await screen.findByText('Ana');
    fireEvent.click(boton(screen.getByText('1001', { selector: 'td' }).closest('tr'), 'ear'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No se pudo iniciar (el agente no está en llamada)', 'bad'));
  });

  it('sin softphone en línea no espía, y con una escucha activa ofrece cortarla', async () => {
    tel.sp = { ...tel.sp, reg: 'connecting', call: { id: 1 } };
    renderNG(<SupervisorPanel />);
    expect(screen.getByText('Conectando…')).toBeTruthy();
    await screen.findByText('Ana');
    fireEvent.click(boton(screen.getByText('1001', { selector: 'td' }).closest('tr'), 'ear'));
    expect(notify.toast).toHaveBeenCalledWith('Tu softphone aún no está en línea', 'bad');
    expect(f.de('POST', '/calls/spy').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /Cortar escucha/ }));
    expect(tel.sp.hangup).toHaveBeenCalled();
  });

  it('un usuario sin extensión: avisa al entrar y no puede espiar', async () => {
    sesion.user = { username: 'sofi' };
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /me/sipcreds': { ext: null } })));
    renderNG(<SupervisorPanel />);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Tu usuario no tiene extensión asignado', 'bad'));
    expect(screen.getByText('sofi · extensión —')).toBeTruthy();
    await screen.findByText('Ana');
    fireEvent.click(boton(screen.getAllByText('2000', { selector: 'td' })[0].closest('tr'), 'urgent'));
    expect(notify.toast).toHaveBeenCalledWith('Tu usuario no tiene extensión para escuchar', 'bad');
  });

  it('si no se pueden leer las credenciales SIP lo dice; si el registro falla no rompe', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /me/sipcreds': estado(403) })));
    const a = renderNG(<SupervisorPanel />);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No tenés permiso para esta acción', 'bad'));
    a.unmount();
    tel.sp.connect = vi.fn(() => Promise.reject(new Error('sin WSS')));
    vi.stubGlobal('fetch', fetchFalso(rutas()));
    renderNG(<SupervisorPanel />);
    await waitFor(() => expect(tel.sp.connect).toHaveBeenCalled());
  });

  it('libreta, salir y recargar a mano', async () => {
    renderNG(<SupervisorPanel />);
    await screen.findByText('Ana');
    fireEvent.click(screen.getByRole('button', { name: /Libreta de clientes/ }));
    expect(screen.getByText('libreta abierta')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cerrar libreta' }));
    expect(screen.queryByText('libreta abierta')).toBeNull();
    const antes = f.de('GET', '/presence').length;
    fireEvent.click(document.querySelector('.tabler-icon-refresh').closest('button'));
    await waitFor(() => expect(f.de('GET', '/presence').length).toBe(antes + 1));
    expect(f.de('GET', '/directory').length).toBe(2);
    fireEvent.click(document.querySelector('.tabler-icon-logout').closest('button'));
    expect(sesion.logout).toHaveBeenCalled();
  });

  it('sin colas lo dice; si la lista de colas se vacía, se limpia el detalle', async () => {
    let n = 0;
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /queues': () => (n++ ? [] : [{ name: 'ventas' }]), 'GET /presence': null, 'GET /directory': 'x' })));
    renderNG(<SupervisorPanel />);
    expect(await screen.findByText('2 en espera')).toBeTruthy();
    fireEvent.click(document.querySelector('.tabler-icon-refresh').closest('button'));
    expect(await screen.findByText('Sin colas configuradas')).toBeTruthy();
  });

  it('si el detalle de las colas llega después de desmontar, se descarta', async () => {
    const d = diferido();
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /queues/ventas/live': () => d.promise })));
    const { unmount } = renderNG(<SupervisorPanel />);
    await waitFor(() => expect(screen.getByText('ventas')).toBeTruthy());
    unmount();
    await act(async () => { d.resolve({ waiting: [] }); });
  });
});

describe('Wallboard', () => {
  const AHORA = new Date('2026-10-08T15:04:05').getTime();
  let f;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: AHORA });
    vivo.connected = true;
    vivo.snap = {
      ts: 1,
      extensions: [{ id: 1, status: 'online', channels: 1 }, { id: 2, status: 'online' }, { id: 3, status: 'offline' }],
      channels: [
        { id: 'c1', name: 'PJSIP/from-trunk-0001', caller: '099111', connected: '1001', state: 'Up', started: new Date(AHORA - 75000).toISOString() },
        { id: 'c2', name: 'PJSIP/1002-0002', state: 'Ringing' },
        { id: 'c3', state: 'Dialing' },
      ],
      queues: [{ name: 'ventas', label: 'Ventas', agents_online: 2, agents_total: 2, access_exten: '8001', strategy: 'ringall' }, { name: 'soporte', agents_online: 1, agents_total: 3 }, { name: 'vacia', agents_online: 0, agents_total: 0 }],
    };
    f = fetchFalso({ 'GET /wallboard': { today: { total: 40, answered: 30, missed: 10, inbound: 25, outbound: 15, avg_talk: 125 }, queues: [{ name: 'ventas', waiting: 3, holdtime: 42, completed: 20, abandoned: 2 }] } });
    vi.stubGlobal('fetch', f);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('KPIs del día (API) y del momento (socket), con la hora y la fecha', async () => {
    renderNG(<Wallboard />);
    const kpi = (l) => screen.getByText(l).closest('.mantine-Card-root').textContent;
    await waitFor(() => expect(kpi('Llamadas hoy')).toContain('40'));
    expect(kpi('Llamadas hoy')).toContain('75% atendidas');
    expect(kpi('Llamadas activas')).toContain('3');
    expect(kpi('Llamadas activas')).toContain('3 en espera');
    expect(kpi('Extensiones en línea')).toContain('de 3 · 1 en llamada');
    expect(kpi('Agentes disponibles')).toContain('de 5 en colas');
    expect(screen.getByText('02:05')).toBeTruthy();                        // conversación media
    expect(screen.getByText('En vivo')).toBeTruthy();
    expect(screen.getByText(/15:04/)).toBeTruthy();
    expect(screen.getByText(/jueves/i)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(':06')).toBeTruthy();
  });

  it('colas: cruza socket y API; llamadas: dirección, estado, duración y botón para cortar', async () => {
    renderNG(<Wallboard />);
    await waitFor(() => expect(screen.getByText('Ventas').closest('.mantine-Card-root').textContent).toContain('00:42'));
    const ventas = screen.getByText('Ventas').closest('.mantine-Card-root').textContent;
    expect(ventas).toContain('Acceso 8001 · ringall');
    expect(ventas).toContain('2/2');
    expect(ventas).toContain('20/2');
    expect(screen.getByText('soporte').closest('.mantine-Card-root').textContent).toMatch(/Acceso —.*1\/3.*En espera0/);
    const fila = (t) => screen.getByText(t).closest('tr');
    expect(fila('099111').querySelector('.tabler-icon-arrow-down-left')).toBeTruthy();
    expect(fila('099111').textContent).toContain('01:15');
    expect(fila('PJSIP/1002-0002').querySelector('.tabler-icon-arrow-up-right')).toBeTruthy();
    expect(fila('Dialing').textContent).toContain('—');
    expect(screen.getAllByRole('button', { name: 'Cortar' }).length).toBe(3);
  });

  it('sin socket todavía: guiones; sin llamadas ni colas lo dice; sin conexión lo marca', async () => {
    vivo.snap = null; vivo.connected = false;
    vi.stubGlobal('fetch', fetchFalso({ 'GET /wallboard': estado(500) }));
    renderNG(<Wallboard />);
    expect(screen.getByText('Sin conexión')).toBeTruthy();
    expect(screen.getByText('Sin colas configuradas.')).toBeTruthy();
    expect(screen.getByText('No hay llamadas en curso')).toBeTruthy();
    const kpi = (l) => screen.getByText(l).closest('.mantine-Card-root').textContent;
    expect(kpi('Llamadas activas')).toContain('—');
    expect(kpi('Llamadas activas')).toContain('sin cola de espera');
    expect(kpi('Llamadas hoy')).toContain('0% atendidas');
  });

  it('la tira de actividad suma un punto por cada snapshot nuevo', async () => {
    const { rerender, container } = renderNG(<Wallboard />);
    expect(container.querySelector('polyline')).toBeNull();
    vivo.snap = { ...vivo.snap, ts: 2, channels: [] };
    rerender(<Wallboard />);
    vivo.snap = { ...vivo.snap, ts: 3, channels: [] };
    rerender(<Wallboard />);
    expect(container.querySelector('polyline').getAttribute('points').split(' ').length).toBe(3);
  });

  it('pantalla completa: entra, sale, y sigue al evento del navegador', async () => {
    let actual = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => actual });
    document.documentElement.requestFullscreen = vi.fn(() => { actual = document.documentElement; return Promise.resolve(); });
    document.exitFullscreen = vi.fn(() => { actual = null; return Promise.resolve(); });
    const { container } = renderNG(<Wallboard />);
    await act(async () => { fireEvent.click(container.querySelector('.tabler-icon-maximize').closest('button')); });
    expect(container.querySelector('.tabler-icon-minimize')).toBeTruthy();
    await act(async () => { fireEvent.click(container.querySelector('.tabler-icon-minimize').closest('button')); });
    expect(container.querySelector('.tabler-icon-maximize')).toBeTruthy();
    actual = document.documentElement;
    act(() => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(container.querySelector('.tabler-icon-minimize')).toBeTruthy();
    // si el navegador lo niega, no rompe
    actual = null;
    document.documentElement.requestFullscreen = vi.fn(() => Promise.reject(new Error('no')));
    act(() => { document.dispatchEvent(new Event('fullscreenchange')); });
    await act(async () => { fireEvent.click(container.querySelector('.tabler-icon-maximize').closest('button')); });
    expect(container.querySelector('.tabler-icon-maximize')).toBeTruthy();
    actual = document.documentElement;
    document.exitFullscreen = vi.fn(() => Promise.reject(new Error('no')));
    await act(async () => { fireEvent.click(container.querySelector('.tabler-icon-maximize').closest('button')); });
    delete document.fullscreenElement;
  });
});
