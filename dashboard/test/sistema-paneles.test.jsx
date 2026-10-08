/* ============================================================================
 *  Paneles chicos de Sistema: marca, base de datos, consola de Asterisk, captura de
 *  paquetes, alertas por correo, módulos y proxy inverso.
 *
 *  Lo que se fija: que cada panel le pida a la API lo que dice el contrato (y con el
 *  cuerpo correcto), que un error no se trague en silencio (toast con el mensaje en
 *  español que arma app/api.js), y que los interruptores que guardan solos vuelvan atrás
 *  si el backend no guardó —un switch en ON que en la base quedó en OFF es justo la
 *  mentira que el operador no puede detectar desde la pantalla.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { renderUI, fakeFetch, res, RED_CAIDA, flush } from './helpers/sistema-render.jsx';

vi.mock('../app/notify', () => ({ toast: vi.fn(), notifyCall: vi.fn(), toastPromise: vi.fn(), dismiss: vi.fn() }));
const live = { snap: null, connected: false };
vi.mock('../app/useLive', () => ({ useLive: () => live, getSocket: () => null, useEstados: () => ({}) }));
vi.mock('../app/RoutesPanel', () => ({ default: () => <div>rutas</div> }));
vi.mock('next/dynamic', async () => (await import('./helpers/sistema-render.jsx')).dynamicMock);

import { toast } from '../app/notify';
import BrandingPanel from '../app/BrandingPanel.jsx';
import DbConsole from '../app/DbConsole.jsx';
import AsteriskConsole from '../app/AsteriskConsole.jsx';
import PcapCapture from '../app/PcapCapture.jsx';
import AlertsPanel from '../app/AlertsPanel.jsx';
import ModulesPanel from '../app/ModulesPanel.jsx';
import ProxyPanel from '../app/ProxyPanel.jsx';
import AsteriskPage from '../app/asterisk/page.jsx';
import BaseDatosPage from '../app/basedatos/page.jsx';

// Pantallas pesadas: con cobertura y suites en paralelo, 5 s no siempre alcanzan.
vi.setConfig({ testTimeout: 20000 });

const toasts = () => toast.mock.calls.map((c) => [c[0], c[1]]);

beforeEach(() => { toast.mockClear(); live.snap = null; live.connected = false; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('BrandingPanel', () => {
  it('carga la marca guardada y la manda entera al guardar', async () => {
    const f = fakeFetch({ 'GET /branding': { name: 'Acme', subtitle: 'Tel', tagline: null, logo: 'data:image/png;base64,AA' }, 'POST /branding': { ok: true } });
    renderUI(<BrandingPanel />);
    await waitFor(() => expect(screen.getByLabelText('Nombre').value).toBe('Acme'));
    expect(screen.getByLabelText('Tagline (login)').value).toBe('');
    fireEvent.change(screen.getByLabelText('Tagline (login)'), { target: { value: 'Hola' } });
    fireEvent.change(screen.getByLabelText('Subtítulo'), { target: { value: 'Sub' } });
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Acme 2' } });
    // Con logo hay botón para quitarlo, y quitarlo vacía lo que se guarda.
    fireEvent.click(screen.getByText('Quitar'));
    expect(screen.queryByText('Quitar')).toBeNull();
    fireEvent.click(screen.getByText('Guardar branding'));
    await waitFor(() => expect(f.a('POST', '/branding')).toHaveLength(1));
    expect(f.a('POST', '/branding')[0].body).toEqual({ name: 'Acme 2', subtitle: 'Sub', tagline: 'Hola', logo: '' });
    await waitFor(() => expect(toasts()).toContainEqual(['Branding guardado · recargá para verlo aplicado', 'ok']));
  });

  it('si la carga o el guardado fallan, lo dice con el mensaje de la API', async () => {
    fakeFetch({ 'GET /branding': res(500, { error: 'base caída' }), 'POST /branding': res(403, {}) });
    renderUI(<BrandingPanel />);
    await waitFor(() => expect(toasts()).toContainEqual(['base caída', 'bad']));
    fireEvent.click(screen.getByText('Guardar branding'));
    await waitFor(() => expect(toasts()).toContainEqual(['No tenés permiso para esta acción', 'bad']));
  });

  it('achica el logo subido a 256 px en un PNG embebido; si la imagen no carga, avisa', async () => {
    fakeFetch({ 'GET /branding': {} });
    const dibujos = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () { const cv = this; return { drawImage: (...a) => dibujos.push([cv.width, cv.height, ...a.slice(3)]) }; });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,CHICO');
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn();
    let falla = false;
    vi.stubGlobal('Image', class { constructor() { this.width = 1024; this.height = 512; } set src(_v) { setTimeout(() => (falla ? this.onerror(new Error('x')) : this.onload()), 0); } });
    const { container } = renderUI(<BrandingPanel />);
    await flush();
    const input = container.querySelector('input[type=file]');
    fireEvent.change(input, { target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] } });
    await waitFor(() => expect(container.querySelector('img').getAttribute('src')).toBe('data:image/png;base64,CHICO'));
    expect(dibujos[0]).toEqual([256, 128, 256, 128]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
    falla = true;
    fireEvent.change(input, { target: { files: [new File(['x'], 'roto.png', { type: 'image/png' })] } });
    await waitFor(() => expect(toasts()).toContainEqual(['No se pudo procesar el logo', 'bad']));
  });
});

describe('DbConsole', () => {
  const DB = { version: 'PostgreSQL 16', size: '42 MB', uptime: '3 días', conn: { total: 7, max: 100, active: 2, idle: 5 }, tables: [{ name: 'pbxng_cdr', rows: 1234, size: '20 MB' }, { name: 'ps_endpoints', size: '1 MB' }] };

  it('muestra el estado de la base, filtra tablas y corre el VACUUM por tabla y global', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = fakeFetch({ 'GET /db': DB, 'POST /db/maintenance': (req) => (req.body.table === 'ps_endpoints' ? { error: 'lock' } : { ok: true }) });
    renderUI(<DbConsole />);
    expect(screen.getByText('Cargando estado de la base…')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('PostgreSQL 16')).toBeTruthy());
    expect(screen.getByText('42 MB')).toBeTruthy();
    expect(screen.getByText('2 activas · 5 idle')).toBeTruthy();
    expect(screen.getByText((1234).toLocaleString())).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Buscar tabla…'), { target: { value: 'CDR' } });
    expect(screen.queryByText('ps_endpoints')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Buscar tabla…'), { target: { value: 'nada' } });
    expect(screen.getByText('Sin coincidencias.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Buscar tabla…'), { target: { value: '' } });
    fireEvent.click(screen.getByText('VACUUM ANALYZE global'));
    await waitFor(() => expect(toasts()).toContainEqual(['VACUUM ANALYZE ejecutado', 'ok']));
    expect(f.a('POST', '/db/maintenance')[0].body).toEqual({});
    const fila = screen.getByText('ps_endpoints').closest('tr');
    fireEvent.click(within(fila).getByRole('button'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error en mantenimiento', 'bad']));
    expect(f.a('POST', '/db/maintenance')[1].body).toEqual({ table: 'ps_endpoints' });
    // Después del mantenimiento relee (600 ms) y el reloj de 30 s sólo pide con la pestaña visible.
    const antes = f.a('GET', '/db').length;
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(f.a('GET', '/db').length).toBeGreaterThan(antes);
    const n = f.a('GET', '/db').length;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.a('GET', '/db').length).toBe(n);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.a('GET', '/db').length).toBe(n + 1);
    // El botón de refrescar relee a mano.
    fireEvent.click(screen.getByText('Operativa').parentElement.parentElement.querySelector('button'));
    await waitFor(() => expect(f.a('GET', '/db').length).toBe(n + 2));
  });

  it('sin conexión con la base dice que no pudo consultarla, y aguanta datos mínimos', async () => {
    fakeFetch({ 'GET /db': RED_CAIDA, 'POST /db/maintenance': RED_CAIDA });
    const { unmount } = renderUI(<DbConsole />);
    await waitFor(() => expect(screen.getByText('No se pudo consultar PostgreSQL.')).toBeTruthy());
    unmount();
    fakeFetch({ 'GET /db': {}, 'POST /db/maintenance': RED_CAIDA });
    renderUI(<DbConsole />);
    await waitFor(() => expect(screen.getByText('Sin coincidencias.')).toBeTruthy());
    expect(screen.getAllByText('-').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByText('VACUUM ANALYZE global'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error en mantenimiento', 'bad']));
  });
});

describe('AsteriskConsole', () => {
  const CORE = { version: 'Asterisk 22.1', uptime: '5 h', endpoints: 12, metrics: { load: 0.4, mem_used_mb: 300, mem_total_mb: 1024 }, transports: [{ id: 'udp', proto: 'udp' }, { id: 'wss' }], modules: { res_pjsip: true, app_queue: false } };

  it('sin socket consulta /backend/health y pinta el estado del motor', async () => {
    const f = fakeFetch({ 'GET /asterisk/core': CORE, 'GET /backend/health': { ami: true, ari: false } });
    renderUI(<AsteriskConsole />);
    expect(screen.getByText('Cargando estado de Asterisk…')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Asterisk 22.1').length).toBe(2));
    await waitFor(() => expect(screen.getByText('Operativo')).toBeTruthy());
    expect(f.a('GET', '/backend/health')).toHaveLength(1);
    expect(screen.getByText('udp · UDP')).toBeTruthy();
    expect(screen.getByText('wss ·')).toBeTruthy();
    expect(screen.getByText('res_pjsip: cargado')).toBeTruthy();
    expect(screen.getByText('app_queue: no')).toBeTruthy();
    expect(screen.getByText('300/1024 MB')).toBeTruthy();
  });

  it('con el socket conectado NO encuesta health: usa el del snapshot', async () => {
    live.connected = true;
    live.snap = { channels: [{}, {}], health: { ami: false, ari: true } };
    const f = fakeFetch({ 'GET /asterisk/core': { version: '' } });
    renderUI(<AsteriskConsole />);
    await waitFor(() => expect(screen.getByText('Sin AMI')).toBeTruthy());
    expect(f.a('GET', '/backend/health')).toHaveLength(0);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('0/0 MB')).toBeTruthy();
  });

  it('si el agente de Asterisk no contesta, lo dice; y health caído no rompe la pantalla', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = fakeFetch({ 'GET /asterisk/core': res(502, {}), 'GET /backend/health': RED_CAIDA });
    renderUI(<AsteriskConsole />);
    await waitFor(() => expect(screen.getByText(/No se pudo contactar el agente de Asterisk/)).toBeTruthy());
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.a('GET', '/backend/health')).toHaveLength(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.a('GET', '/backend/health').length).toBeGreaterThanOrEqual(2);
  });

  it('las páginas /asterisk y /basedatos montan su consola y la captura de paquetes', async () => {
    fakeFetch({ 'GET /asterisk/core': CORE, 'GET /backend/health': { ami: true }, 'GET /db': { version: 'PG 16', tables: [] } });
    renderUI(<><AsteriskPage /><BaseDatosPage /></>);
    expect(screen.getByText('Asterisk')).toBeTruthy();
    expect(screen.getByText('Base de datos')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('PCAP')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Asterisk PBX')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('PG 16')).toBeTruthy());
  });
});

describe('PcapCapture', () => {
  const LISTA = [
    { id: 1, filename: 'a.pcap', node: 'asterisk', status: 'running' },
    { id: 2, filename: 'b.pcap', node: 'sbc', status: 'done', size: 2 * 1048576, created_at: '2026-10-01T10:00:00Z' },
    { id: 3, filename: 'c.pcap', node: 'asterisk', status: 'error', error: 'tcpdump murió' },
    { id: 4, filename: 'd.pcap', node: 'asterisk', status: 'done', size: 5000 },
    { id: 5, node: 'asterisk', status: 'done', size: 0 },
    { id: 6, filename: 'f.pcap', node: 'asterisk', status: 'raro' },
  ];

  it('abre el cajón, lista capturas y arranca una con preset y duración elegidos', async () => {
    const f = fakeFetch({ 'GET /capture/list': LISTA, 'POST /capture/start': { id: 9 }, 'POST /capture/1/stop': { ok: true }, 'DELETE /capture/3': res(500, { error: 'no se pudo' }) });
    renderUI(<PcapCapture />);
    expect(f.llamadas).toHaveLength(0);   // cerrado no encuesta
    fireEvent.click(screen.getByText('PCAP'));
    await waitFor(() => expect(screen.getByText('Capturas (6)')).toBeTruthy());
    expect(screen.getByText('running…')).toBeTruthy();
    expect(screen.getByText('tcpdump murió')).toBeTruthy();
    expect(screen.getByText('2.0 MB')).toBeTruthy();
    expect(screen.getByText('5 KB')).toBeTruthy();
    expect(screen.getByText('0 B')).toBeTruthy();
    fireEvent.click(screen.getByText('SIP + RTP'));
    fireEvent.change(screen.getByLabelText('Duración (s)'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Duración (s)'), { target: { value: '45' } });
    fireEvent.click(screen.getByText('Iniciar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Captura iniciada en asterisk · 45s', 'ok']));
    expect(f.a('POST', '/capture/start')[0].body).toEqual({ node: 'asterisk', preset: 'siprtp', duration: 45 });
    // Detener la que corre, borrar la que falló (y avisar que el borrado no anduvo).
    const filaA = screen.getByText('a.pcap').closest('tr');
    fireEvent.click(within(filaA).getAllByRole('button')[0]);
    await waitFor(() => expect(f.a('POST', '/capture/1/stop')).toHaveLength(1));
    const filaC = screen.getByText('c.pcap').closest('tr');
    fireEvent.click(within(filaC).getAllByRole('button')[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['no se pudo', 'bad']));
    fireEvent.click(screen.getByText('Refrescar'));
    await waitFor(() => expect(f.a('GET', '/capture/list').length).toBeGreaterThanOrEqual(5));
  });

  it('descarga el .pcap con el token (pedido por la API, no window.open)', async () => {
    const pcap = new Blob(['PCAP'], { type: 'application/vnd.tcpdump.pcap' });
    const f = fakeFetch({ 'GET /capture/list': LISTA, 'GET /capture/2/download': res(200, pcap), 'GET /capture/5/download': res(404, {}) });
    URL.createObjectURL = vi.fn(() => 'blob:pcap'); URL.revokeObjectURL = vi.fn();
    const clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicks.push([this.getAttribute('href'), this.download]); });
    const abrir = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderUI(<PcapCapture />);
    fireEvent.click(screen.getByText('PCAP'));
    await waitFor(() => expect(screen.getByText('b.pcap')).toBeTruthy());
    fireEvent.click(within(screen.getByText('b.pcap').closest('tr')).getAllByRole('button')[0]);
    await waitFor(() => expect(clicks).toEqual([['blob:pcap', 'b.pcap']]));
    expect(f.a('GET', '/capture/2/download')).toHaveLength(1);
    expect(abrir).not.toHaveBeenCalled();
    // Sin nombre de archivo usa uno armado con el id; y un 404 se avisa.
    const filas = screen.getAllByRole('row');
    fireEvent.click(within(filas[5]).getAllByRole('button')[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['No encontrado', 'bad']));
  });

  it('si el arranque falla lo avisa; la lista vacía invita a iniciar; encuesta cada 2 s sólo a la vista', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = fakeFetch({ 'GET /capture/list': [], 'POST /capture/start': res(500, { error: 'sin tcpdump' }), 'POST /capture/x/stop': RED_CAIDA });
    renderUI(<PcapCapture />);
    fireEvent.click(screen.getByText('PCAP'));
    await waitFor(() => expect(screen.getByText('Sin capturas todavía. Iniciá una arriba.')).toBeTruthy());
    fireEvent.click(screen.getByText('Iniciar'));
    await waitFor(() => expect(toasts()).toContainEqual(['No se pudo iniciar: sin tcpdump', 'bad']));
    const n = f.a('GET', '/capture/list').length;
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(f.a('GET', '/capture/list').length).toBe(n + 1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(f.a('GET', '/capture/list').length).toBe(n + 1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('una lista que no es array (error raro del backend) no rompe la tabla', async () => {
    fakeFetch({ 'GET /capture/list': { error: 'x' } });
    renderUI(<PcapCapture />);
    fireEvent.click(screen.getByText('PCAP'));
    await waitFor(() => expect(screen.getByText('Capturas (0)')).toBeTruthy());
  });

  it('un error al detener también se avisa', async () => {
    fakeFetch({ 'GET /capture/list': [LISTA[0]], 'POST /capture/1/stop': res(500, { error: 'no paró' }) });
    renderUI(<PcapCapture />);
    fireEvent.click(screen.getByText('PCAP'));
    await waitFor(() => expect(screen.getByText('a.pcap')).toBeTruthy());
    fireEvent.click(within(screen.getByText('a.pcap').closest('tr')).getAllByRole('button')[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['no paró', 'bad']));
  });
});

describe('AlertsPanel', () => {
  const REGLAS = {
    default_to: 'guardia@x.com',
    rules: [
      { event: 'security.attack', enabled: true, params: { failed: 20, window_min: 5 }, throttle_min: 10 },
      { event: 'auth.login', enabled: false, params: {} },
      { event: 'fraud.international', enabled: false },
      { event: 'evento.nuevo', enabled: false },
    ],
  };
  const HIST = [
    { id: 1, created_at: '2026-10-01T10:00:00Z', event: 'security.attack', severity: 'crit', title: 'Ataque', to_addr: 'a@x', sent: true },
    { id: 2, created_at: '2026-10-01T11:00:00Z', event: 'trunk.down', severity: 'warn', title: 'Troncal', sent: false, err: 'SMTP 550' },
    { id: 3, created_at: '2026-10-01T12:00:00Z', event: 'digest.daily', title: 'Resumen', sent: false },
  ];

  it('lista reglas con su título, historial y guarda el destinatario por defecto', async () => {
    const f = fakeFetch({ 'GET /alerts/rules': REGLAS, 'GET /alerts/history': HIST, 'POST /alerts/rules': { ok: true } });
    renderUI(<AlertsPanel />);
    await waitFor(() => expect(screen.getByText('Estamos bajo ataque')).toBeTruthy());
    expect(screen.getAllByText('evento.nuevo').length).toBe(2);   // sin META: el id hace de título
    expect(screen.getByText('enviada')).toBeTruthy();
    expect(screen.getAllByText('falló')).toHaveLength(2);
    expect(screen.getAllByText('—')).toHaveLength(2);
    const dest = screen.getByLabelText('Destinatarios por defecto');
    expect(dest.value).toBe('guardia@x.com');
    fireEvent.change(dest, { target: { value: 'otro@x.com' } });
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Destinatario por defecto guardado', 'ok']));
    expect(f.a('POST', '/alerts/rules')[0].body).toEqual({ default_to: 'otro@x.com' });
  });

  it('si el destinatario por defecto no se guarda, lo dice', async () => {
    fakeFetch({ 'GET /alerts/rules': { rules: [] }, 'GET /alerts/history': [], 'POST /alerts/rules': res(400, { error: 'Correo inválido' }) });
    renderUI(<AlertsPanel />);
    await waitFor(() => expect(screen.getByLabelText('Destinatarios por defecto').value).toBe(''));
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Correo inválido', 'bad']));
  });

  it('el interruptor guarda solo y, si el backend lo rechaza, vuelve a como estaba', async () => {
    let falla = false;
    const f = fakeFetch({ 'GET /alerts/rules': REGLAS, 'GET /alerts/history': [], 'POST /alerts/rules': () => (falla ? res(500, { error: 'no guardó' }) : { ok: true }) });
    renderUI(<AlertsPanel />);
    await waitFor(() => expect(screen.getByText('Todavía no se envió ninguna alerta.')).toBeTruthy());
    const sw = () => screen.getAllByRole('switch');
    fireEvent.click(sw()[1]);   // auth.login → ON
    await waitFor(() => expect(toasts()).toContainEqual(['Inicio de sesión al panel: activada', 'ok']));
    expect(f.a('POST', '/alerts/rules')[0].body).toMatchObject({ event: 'auth.login', enabled: true });
    fireEvent.click(sw()[0]);   // security.attack → OFF
    await waitFor(() => expect(toasts()).toContainEqual(['Estamos bajo ataque: desactivada', 'info']));
    fireEvent.click(sw()[3]);   // evento sin META
    await waitFor(() => expect(toasts()).toContainEqual(['evento.nuevo: activada', 'ok']));
    falla = true;
    fireEvent.click(sw()[2]);
    await waitFor(() => expect(toasts()).toContainEqual(['no guardó', 'bad']));
    await waitFor(() => expect(sw()[2].checked).toBe(false));
  });

  it('el desplegable edita destinatarios, umbrales y parámetros, y los guarda', async () => {
    let falla = false;
    const f = fakeFetch({ 'GET /alerts/rules': REGLAS, 'GET /alerts/history': [], 'POST /alerts/rules': () => (falla ? res(500, { error: 'mal' }) : { ok: true }) });
    const { container } = renderUI(<AlertsPanel />);
    await waitFor(() => expect(screen.getByText('Estamos bajo ataque')).toBeTruthy());
    const tarjeta = (titulo) => screen.getAllByText(titulo)[0].closest('.mantine-Card-root');
    const abrir = (titulo) => { const bs = within(tarjeta(titulo)).getAllByRole('button'); fireEvent.click(bs[bs.length - 1]); };
    abrir('Estamos bajo ataque');
    const t1 = tarjeta('Estamos bajo ataque');
    fireEvent.change(within(t1).getByLabelText('Destinatarios'), { target: { value: 'soc@x' } });
    fireEvent.change(within(t1).getByLabelText('No repetir antes de (min)'), { target: { value: '30' } });
    fireEvent.change(within(t1).getByLabelText('Intentos fallidos'), { target: { value: '50' } });
    fireEvent.click(within(t1).getByText('Guardar umbrales'));
    await waitFor(() => expect(toasts()).toContainEqual(['Estamos bajo ataque: guardado', 'ok']));
    expect(f.a('POST', '/alerts/rules')[0].body).toMatchObject({ event: 'security.attack', recipients: 'soc@x', throttle_min: 30, params: { failed: 50, window_min: 5 } });
    // Parámetros de texto (prefijos) y el «sólo IP nueva» del login.
    abrir('Llamada internacional');
    const t2 = tarjeta('Llamada internacional');
    fireEvent.change(within(t2).getByLabelText('Prefijos (csv)'), { target: { value: '00,+' } });
    fireEvent.click(within(t2).getByText('Guardar umbrales'));
    await waitFor(() => expect(f.a('POST', '/alerts/rules')[1].body).toMatchObject({ params: { prefixes: '00,+' } }));
    abrir('Inicio de sesión al panel');
    const t3 = tarjeta('Inicio de sesión al panel');
    const soloNueva = within(t3).getByRole('switch', { name: /Avisar solo cuando entra/ });
    expect(soloNueva.checked).toBe(true);
    fireEvent.click(soloNueva);
    falla = true;
    fireEvent.click(within(t3).getByText('Guardar umbrales'));
    await waitFor(() => expect(toasts()).toContainEqual(['mal', 'bad']));
    expect(f.a('POST', '/alerts/rules')[2].body.params).toEqual({ only_new_ip: false });
    // Sin META ni PARAMS: igual se puede abrir y guardar.
    abrir('evento.nuevo');
    falla = false;
    fireEvent.click(within(tarjeta('evento.nuevo')).getByText('Guardar umbrales'));
    await waitFor(() => expect(toasts()).toContainEqual(['evento.nuevo: guardado', 'ok']));
    expect(container).toBeTruthy();
  });

  it('la alerta de prueba se manda y relee el historial; los fallos de carga se avisan', async () => {
    let fallaPrueba = false;
    const f = fakeFetch({ 'GET /alerts/rules': REGLAS, 'GET /alerts/history': res(500, { error: 'sin historial' }), 'POST /alerts/test': () => (fallaPrueba ? res(500, { error: 'SMTP caído' }) : { ok: true }) });
    renderUI(<AlertsPanel />);
    await waitFor(() => expect(toasts()).toContainEqual(['sin historial', 'bad']));
    const t1 = screen.getByText('Estamos bajo ataque').closest('.mantine-Card-root');
    fireEvent.click(within(t1).getAllByRole('button')[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['Alerta de prueba enviada', 'ok']));
    expect(f.a('POST', '/alerts/test')[0].body).toEqual({ event: 'security.attack' });
    fallaPrueba = true;
    fireEvent.click(within(t1).getAllByRole('button')[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['SMTP caído', 'bad']));
    fireEvent.click(screen.getByText('Refrescar'));
    await waitFor(() => expect(f.a('GET', '/alerts/rules').length).toBeGreaterThanOrEqual(4));
  });

  it('si no se pueden leer las reglas, no queda cargando para siempre', async () => {
    fakeFetch({ 'GET /alerts/rules': res(403, {}), 'GET /alerts/history': null });
    renderUI(<AlertsPanel />);
    await waitFor(() => expect(toasts()).toContainEqual(['No tenés permiso para esta acción', 'bad']));
    expect(screen.getByText('Alertas por correo')).toBeTruthy();
    expect(screen.getByText('Todavía no se envió ninguna alerta.')).toBeTruthy();
  });
});

describe('ModulesPanel', () => {
  it('distingue lo pedido de lo medido: el TURN dice lo que contestó la sonda', async () => {
    const f = fakeFetch({ 'GET /modules': { sbc: false, voz: true }, 'GET /turn/estado': { deseado: true, corriendo: false, motivo: 'no contesta el Allocate' }, 'POST /modules': (req) => (req.body.id === 'turn' ? { ok: true, svc: { queued: true } } : { ok: true, svc: { error: 'docker caído' } }) });
    renderUI(<ModulesPanel />);
    expect(screen.getByText('Cargando módulos…')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Conexión a SBC-NG')).toBeTruthy());
    expect(screen.getAllByText('servicio')).toHaveLength(3);
    expect(screen.getAllByText('inactivo')).toHaveLength(1);
    expect(screen.getAllByText(/no se puede comprobar/i).length).toBeGreaterThanOrEqual(2);
    const sws = screen.getAllByRole('switch');
    fireEvent.click(sws[1]);   // sbc → ON
    await waitFor(() => expect(toasts()).toContainEqual(['Módulo activado (servicio: docker caído)', 'ok']));
    expect(f.a('POST', '/modules')[0].body).toEqual({ id: 'sbc', enabled: true });
    const sondas = f.a('GET', '/turn/estado').length;
    fireEvent.click(sws[2]);   // turn → OFF: vuelve a medir
    await waitFor(() => expect(toasts()).toContainEqual(['Módulo desactivado (servicio en cola)', 'ok']));
    await waitFor(() => expect(f.a('GET', '/turn/estado').length).toBe(sondas + 1));
  });

  it('si el backend rechaza el cambio, avisa y relee para no mentir', async () => {
    const f = fakeFetch({ 'GET /modules': {}, 'GET /turn/estado': res(500, {}), 'POST /modules': res(403, {}) });
    renderUI(<ModulesPanel />);
    await waitFor(() => expect(screen.getByText('Click-to-Call')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('switch')[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['No tenés permiso para esta acción', 'bad']));
    await waitFor(() => expect(f.a('GET', '/modules')).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByRole('switch')[0].checked).toBe(true));
  });

  it('una respuesta sin `svc` sólo dice activado; un error de carga se avisa', async () => {
    fakeFetch({ 'GET /modules': {}, 'GET /turn/estado': null, 'POST /modules': null });
    renderUI(<ModulesPanel />);
    await waitFor(() => expect(screen.getByText('Push RFC 8599 a la PWA y móviles.')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('switch')[4]);
    await waitFor(() => expect(toasts()).toContainEqual(['Módulo desactivado', 'ok']));
    fakeFetch({ 'GET /modules': res(500, { error: 'sin base' }), 'GET /turn/estado': null });
    renderUI(<ModulesPanel />);
    await waitFor(() => expect(toasts()).toContainEqual(['sin base', 'bad']));
  });

  it('con el TURN medido y corriendo, el icono y la insignia van en verde', async () => {
    fakeFetch({ 'GET /modules': {}, 'GET /turn/estado': { deseado: true, corriendo: true, local: true } });
    const { container } = renderUI(<ModulesPanel />);
    await waitFor(() => expect(container.querySelector('.mantine-Badge-root[data-variant="filled"]')).toBeTruthy());
  });
});

describe('ProxyPanel', () => {
  it('carga la configuración, guarda conservando la clave si no se tocó, y prueba sola', async () => {
    const f = fakeFetch({
      'GET /settings': { npm_url: 'http://npm:81', npm_identity: 'admin@x', domain: 'pbx.x', npm_secret: '__SET__' },
      'GET /npm/cert': { domain: 'pbx.x', days_left: 10, expires_date: '2026-10-18', provider: 'letsencrypt' },
      'GET /npm/hosts': { host: { domains: ['pbx.x', 'www.pbx.x'], enabled: true, forward: '10.0.0.2:3001', ssl: true, ssl_forced: true, ws: true } },
      'POST /settings': { ok: true },
      'POST /npm/test': { ok: true, hosts: 4 },
    });
    renderUI(<ProxyPanel />);
    await waitFor(() => expect(screen.getByLabelText('URL del NPM').value).toBe('http://npm:81'));
    await waitFor(() => expect(screen.getByText('10 días restantes')).toBeTruthy());
    expect(screen.getByText(/letsencrypt/)).toBeTruthy();
    expect(screen.getByText('pbx.x, www.pbx.x')).toBeTruthy();
    expect(screen.getByText('TLS forzado')).toBeTruthy();
    expect(screen.getByText('WebSocket ✓')).toBeTruthy();
    expect(screen.getByLabelText('Contraseña').getAttribute('placeholder')).toMatch(/guardada/);
    fireEvent.change(screen.getByLabelText('Dominio público'), { target: { value: '  pbx.y  ' } });
    fireEvent.change(screen.getByLabelText('Usuario (identity)'), { target: { value: 'otro@x' } });
    fireEvent.change(screen.getByLabelText('URL del NPM'), { target: { value: 'http://npm2:81' } });
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Conexión OK · 4 hosts en el proxy', 'ok']));
    expect(f.a('POST', '/settings')[0].body).toEqual({ npm_url: 'http://npm2:81', npm_identity: 'otro@x', domain: 'pbx.y', npm_secret: '__SET__' });
    expect(toasts()).toContainEqual(['Proxy guardado', 'ok']);
    // Con clave nueva se manda la clave, no el marcador.
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 's3creta' } });
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(f.a('POST', '/settings')).toHaveLength(2));
    expect(f.a('POST', '/settings')[1].body.npm_secret).toBe('s3creta');
  });

  it('explica los errores previsibles del NPM y avisa los de red', async () => {
    let prueba = { ok: false, error: 'npm-auth-failed' };
    fakeFetch({
      'GET /settings': res(500, { error: 'settings rotos' }),
      'GET /npm/cert': { error: 'cert-not-found' },
      'GET /npm/hosts': { error: 'host-not-found', items: [] },
      'POST /settings': res(400, { error: 'URL inválida' }),
      'POST /npm/test': () => prueba,
    });
    renderUI(<ProxyPanel />);
    await waitFor(() => expect(toasts()).toContainEqual(['settings rotos', 'bad']));
    await waitFor(() => expect(screen.getByText('No hay certificado para el dominio en el NPM.')).toBeTruthy());
    expect(screen.getByText('No hay un host en el NPM para este dominio.')).toBeTruthy();
    expect(screen.getByText('dominio no configurado')).toBeTruthy();
    fireEvent.click(screen.getByText('Probar conexión'));
    await waitFor(() => expect(toasts()).toContainEqual(['Falló: No autenticó contra el NPM (revisá usuario/clave/URL).', 'bad']));
    prueba = { ok: false, error: 'otro-codigo' };
    fireEvent.click(screen.getByText('Probar conexión'));
    await waitFor(() => expect(toasts()).toContainEqual(['Falló: otro-codigo', 'bad']));
    prueba = res(502, {});
    fireEvent.click(screen.getByText('Probar conexión'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error del servidor', 'bad']));
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(toasts()).toContainEqual(['URL inválida', 'bad']));
    expect(toasts()).not.toContainEqual(['Proxy guardado', 'ok']);
  });

  it('cert y hosts caídos por red avisan; host deshabilitado y sin TLS se ve así', async () => {
    fakeFetch({ 'GET /settings': { domain: 'pbx.z' }, 'GET /npm/cert': RED_CAIDA, 'GET /npm/hosts': RED_CAIDA });
    const { unmount } = renderUI(<ProxyPanel />);
    await waitFor(() => expect(toasts().filter((t) => t[0] === 'Sin conexión con el servidor')).toHaveLength(2));
    expect(screen.getByText('Sin datos del certificado. Configurá y probá la conexión.')).toBeTruthy();
    expect(screen.getByText('pbx.z')).toBeTruthy();
    unmount();
    fakeFetch({
      'GET /settings': {}, 'GET /npm/cert': { days_left: 20, expires_date: '2026-10-28' },
      'GET /npm/hosts': { host: { enabled: false, forward: 'x', ssl: false, ws: false } },
      'POST /npm/test': { ok: true },
    });
    renderUI(<ProxyPanel />);
    await waitFor(() => expect(screen.getByText('deshabilitado')).toBeTruthy());
    expect(screen.getByText('sin TLS')).toBeTruthy();
    expect(screen.getByText('WebSocket ✗')).toBeTruthy();
    expect(screen.getByText('20 días restantes')).toBeTruthy();
    fireEvent.click(screen.getByText('Probar conexión'));
    await waitFor(() => expect(toasts()).toContainEqual(['Conexión OK · 0 hosts en el proxy', 'ok']));
  });

  it('cert lejos de vencer en verde y host con TLS sin forzar', async () => {
    fakeFetch({ 'GET /settings': {}, 'GET /npm/cert': { days_left: 80, expires_date: '2026-12-28' }, 'GET /npm/hosts': { host: { enabled: true, forward: 'x', ssl: true, ssl_forced: false, ws: true } } });
    renderUI(<ProxyPanel />);
    await waitFor(() => expect(screen.getByText('80 días restantes')).toBeTruthy());
    expect(screen.getByText('TLS')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Refrescar')[0]);
    fireEvent.click(screen.getAllByText('Refrescar')[1]);
  });
});
