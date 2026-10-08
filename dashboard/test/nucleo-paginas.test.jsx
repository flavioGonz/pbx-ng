/* Pantallas chicas del núcleo: /softphone (softphone del panel + qué instalador reparte la
 * central), /enroll (alta del teléfono con un token de un solo uso) y /call/[token] (el
 * click-to-call público, el que usa un ciudadano desde la web de un cliente).
 *
 * Lo que se fija es lo que ve quien las usa: el error explicado en vez de una pantalla
 * muda (token vencido, enlace desactivado, sin conexión), que la llamada pública pida el
 * nombre cuando corresponde y no se quede «En llamada» para siempre cuando el otro corta,
 * y que «Buscar ahora» diga si la central quedó repartiendo la versión nueva o por qué no. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { renderConMantine, apiMock, notifyMock, resetNucleo, instalarStorage } from './helpers/nucleo-render.jsx';
import { crearSpFalso } from './helpers/nucleo-sip.js';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());
const spRef = vi.hoisted(() => ({ sp: null }));
vi.mock('../app/useSoftphone.js', () => ({ useSoftphone: () => spRef.sp }));
const params = vi.hoisted(() => ({ token: 'tk1' }));
vi.mock('next/navigation', () => ({ useParams: () => params }));

import SoftphonePage from '../app/softphone/page.jsx';
import DistribucionSoftphone from '../app/softphone/DistribucionSoftphone.jsx';
import Enroll from '../app/enroll/page.jsx';
import CallPage from '../app/call/[token]/page.jsx';

let st;
beforeEach(() => { resetNucleo(); st = instalarStorage(); spRef.sp = crearSpFalso({ reg: 'idle', creds: null }); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('/softphone', () => {
  it('desconectado: pide extensión y clave y conecta con video si se pidió', async () => {
    renderConMantine(<SoftphonePage />);
    expect(screen.getByText('Desconectado')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Extensión WebRTC'), { target: { value: '9100' } });
    fireEvent.change(screen.getByLabelText('Contraseña SIP'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByLabelText('Habilitar video'));
    await act(async () => { fireEvent.click(screen.getByText('Conectar')); });
    expect(spRef.sp.connect).toHaveBeenCalledWith('9100', 'pw', true);
    expect(notifyMock.toast).toHaveBeenCalledWith('Conectado como 9100', 'ok');
  });

  it('si el registro falla lo dice con el motivo', async () => {
    spRef.sp.connect.mockRejectedValue(new Error('401'));
    renderConMantine(<SoftphonePage />);
    await act(async () => { fireEvent.click(screen.getByText('Conectar')); });
    expect(notifyMock.toast).toHaveBeenCalledWith('Error: 401', 'bad');
  });

  it('conectando muestra el estado', () => {
    spRef.sp = crearSpFalso({ reg: 'connecting', creds: null });
    renderConMantine(<SoftphonePage />);
    expect(screen.getByText('Conectando…')).toBeTruthy();
  });

  it('registrado: marca, borra, llama con Enter o botón, y desconecta', () => {
    spRef.sp = crearSpFalso();
    renderConMantine(<SoftphonePage />);
    expect(screen.getByText('Registrado')).toBeTruthy();
    expect(screen.getByText('101')).toBeTruthy();
    expect(screen.getByText('Llamar').closest('button').disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    fireEvent.click(screen.getByRole('button', { name: '0' }));
    expect(spRef.sp.tone).toHaveBeenCalledWith('2');
    const num = screen.getByPlaceholderText('Número a marcar');
    expect(num.value).toBe('20');
    fireEvent.click(document.querySelector('.mantine-ActionIcon-root'));
    expect(num.value).toBe('2');
    fireEvent.change(num, { target: { value: '300' } });
    fireEvent.keyDown(num, { key: 'a' });
    fireEvent.keyDown(num, { key: 'Enter' });
    expect(spRef.sp.placeCall).toHaveBeenCalledWith('300');
    fireEvent.click(screen.getByText('Llamar'));
    expect(spRef.sp.placeCall).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('Desconectar'));
    expect(spRef.sp.disconnect).toHaveBeenCalled();
  });

  it('en llamada: colgar y silenciar; el estado de la llamada a la vista', () => {
    spRef.sp = crearSpFalso({ call: 'Establishing' });
    const { rerender } = renderConMantine(<SoftphonePage />);
    expect(screen.getByText('Establishing')).toBeTruthy();
    fireEvent.click(screen.getByText('Colgar'));
    expect(spRef.sp.hangup).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Silenciar'));
    expect(spRef.sp.toggleMute).toHaveBeenCalled();
    spRef.sp = { ...spRef.sp, call: 'Established', muted: true };
    rerender(<SoftphonePage />);
    expect(screen.getByText('En llamada')).toBeTruthy();
    expect(screen.getByText('Silenciado')).toBeTruthy();
  });

  it('entrante: atender o rechazar', () => {
    spRef.sp = crearSpFalso({ incoming: {} });
    renderConMantine(<SoftphonePage />);
    expect(screen.getByText('Llamada entrante')).toBeTruthy();
    fireEvent.click(screen.getByText('Atender'));
    fireEvent.click(screen.getByText('Rechazar'));
    expect(spRef.sp.acceptIncoming).toHaveBeenCalled();
    expect(spRef.sp.rejectIncoming).toHaveBeenCalled();
  });
});

describe('DistribucionSoftphone', () => {
  const OTA = { auto: true, repo: 'ies/pbx', cada_h: 6, resultado: 'al_dia', sirviendo: { version: '0.17.0', size: 85 * 1048576, date: '2026-09-30T12:00:00Z' }, android: { version: '1.2', size: 20 * 1048576 }, ultimo_intento: '2026-10-01T10:00:00Z', detalle: 'ok 200', bajando: '0.18.0' };
  const montar = async () => { const r = renderConMantine(<DistribucionSoftphone />); await waitFor(() => expect(apiMock.llamadasA('GET /softphone/ota').length).toBeGreaterThan(0)); await act(async () => {}); return r; };

  it('sin permiso (403) o sin datos no muestra nada', async () => {
    apiMock.fallar('GET /softphone/ota', 403);
    const { container } = await montar();
    expect(container.querySelector('.mantine-Card-root')).toBeNull();
    expect(screen.queryByText('Instalador que reparte esta central')).toBeNull();
  });

  it('muestra versión, tamaño, Android, estado y la última revisión', async () => {
    apiMock.responder('GET /softphone/ota', OTA);
    await montar();
    expect(screen.getByText('0.17.0')).toBeTruthy();
    expect(screen.getByText(/85 MB · publicada/)).toBeTruthy();
    expect(screen.getByText('1.2')).toBeTruthy();
    expect(screen.getByText('20 MB')).toBeTruthy();
    expect(screen.getByText('Al día')).toBeTruthy();
    expect(screen.getByText('ok 200')).toBeTruthy();
    expect(screen.getByText(/bajando 0\.18\.0…/)).toBeTruthy();
    expect(screen.getByLabelText('Repositorio').value).toBe('ies/pbx');
  });

  it('sin instalador ni APK, sin revisión: lo explica', async () => {
    apiMock.responder('GET /softphone/ota', { auto: false, resultado: 'raro', android: { size: 'x' } });
    await montar();
    expect(screen.getByText('Ninguno. El botón de descarga no aparece en el login.')).toBeTruthy();
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('Todavía no se revisó')).toBeTruthy();
    expect(screen.getByText(/Última revisión: nunca/)).toBeTruthy();
    expect(screen.queryByLabelText('Repositorio')).toBeNull();
  });

  it('cambiar la configuración la guarda; si falla avisa y recarga', async () => {
    apiMock.responder('GET /softphone/ota', { ...OTA, android: null, sirviendo: { version: '1', size: 1, date: 'no-fecha' } });
    apiMock.responder('POST /softphone/ota/config', ({ body }) => ({ ...OTA, ...body }));
    await montar();
    expect(screen.getByText('Sin APK. Se sube a mano: no lo compila CI.')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('switch')); });
    expect(apiMock.llamadasA('POST /softphone/ota/config')[0].body).toEqual({ auto: false });
    await act(async () => { fireEvent.click(screen.getByRole('switch')); });
    const repo = screen.getByLabelText('Repositorio');
    fireEvent.change(repo, { target: { value: 'otro/repo' } });
    await act(async () => { fireEvent.blur(repo); });
    expect(apiMock.llamadasA('POST /softphone/ota/config').at(-1).body).toEqual({ repo: 'otro/repo' });
    const cada = screen.getByLabelText('Revisar cada');
    fireEvent.change(cada, { target: { value: '12' } });
    await act(async () => { fireEvent.blur(cada); });
    expect(apiMock.llamadasA('POST /softphone/ota/config').at(-1).body).toEqual({ cada_h: 12 });
    apiMock.fallar('POST /softphone/ota/config', 500, 'disco lleno');
    await act(async () => { fireEvent.blur(repo); });
    expect(notifyMock.toast).toHaveBeenCalledWith('No se pudo guardar: disco lleno', 'bad');
  });

  it('Buscar ahora / volver a bajar: dice si actualizó, si estaba al día, o por qué no', async () => {
    apiMock.responder('GET /softphone/ota', OTA);
    await montar();
    apiMock.responder('POST /softphone/ota/revisar', { actualizado: true, version: '0.18.0' });
    await act(async () => { fireEvent.click(screen.getByText('Buscar ahora')); });
    expect(notifyMock.toast).toHaveBeenLastCalledWith('Ahora esta central reparte la 0.18.0', 'ok');
    expect(apiMock.llamadasA('POST /softphone/ota/revisar')[0].body).toEqual({ forzar: false });
    apiMock.responder('POST /softphone/ota/revisar', { al_dia: true, version: '0.17.0' });
    await act(async () => { fireEvent.click(screen.getByText('Volver a bajar la actual')); });
    expect(notifyMock.toast).toHaveBeenLastCalledWith('Ya estaba al día (0.17.0)', 'ok');
    expect(apiMock.llamadasA('POST /softphone/ota/revisar')[1].body).toEqual({ forzar: true });
    apiMock.responder('POST /softphone/ota/revisar', { motivo: 'sin salida a internet' });
    await act(async () => { fireEvent.click(screen.getByText('Buscar ahora')); });
    expect(notifyMock.toast).toHaveBeenLastCalledWith('No se pudo: sin salida a internet', 'bad');
    apiMock.responder('POST /softphone/ota/revisar', {});
    await act(async () => { fireEvent.click(screen.getByText('Buscar ahora')); });
    expect(notifyMock.toast).toHaveBeenLastCalledWith('No se pudo: error', 'bad');
    apiMock.fallar('POST /softphone/ota/revisar', 502, 'la API no responde');
    await act(async () => { fireEvent.click(screen.getByText('Buscar ahora')); });
    expect(notifyMock.toast).toHaveBeenLastCalledWith('No se pudo: la API no responde', 'bad');
  });

  it('subir a mano: exige el latest.yml (o un APK), lee los archivos y los manda juntos', async () => {
    apiMock.responder('GET /softphone/ota', OTA);
    await montar();
    const input = document.querySelector('input[type=file]');
    const archivo = (n) => new File(['hola'], n, { type: 'application/octet-stream' });
    await act(async () => { fireEvent.change(input, { target: { files: [archivo('PBX.exe')] } }); });
    expect(notifyMock.toast).toHaveBeenLastCalledWith('Falta el latest.yml: sin él el actualizador no se entera de la versión nueva', 'bad');
    expect(apiMock.llamadasA('POST /softphone/ota/subir')).toHaveLength(0);
    apiMock.responder('POST /softphone/ota/subir', { version: '0.19.0', sirviendo: { version: '0.19.0', size: 1, date: null }, android: { available: true, version: '2.0', size: 1 } });
    await act(async () => { fireEvent.change(input, { target: { files: [archivo('PBX.exe'), archivo('latest.yml')] } }); });
    await waitFor(() => expect(apiMock.llamadasA('POST /softphone/ota/subir')).toHaveLength(1));
    expect(apiMock.llamadasA('POST /softphone/ota/subir')[0].body.archivos).toEqual([{ name: 'PBX.exe', data: btoa('hola') }, { name: 'latest.yml', data: btoa('hola') }]);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenLastCalledWith('Instalador subido: 0.19.0', 'ok'));
    apiMock.responder('POST /softphone/ota/subir', {});
    await act(async () => { fireEvent.change(input, { target: { files: [archivo('app.apk')] } }); });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenLastCalledWith('Instalador subido', 'ok'));
    apiMock.fallar('POST /softphone/ota/subir', 413, 'archivo demasiado grande');
    await act(async () => { fireEvent.change(input, { target: { files: [archivo('latest.yml')] } }); });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenLastCalledWith('No se pudo subir: archivo demasiado grande', 'bad'));
    await act(async () => { fireEvent.change(input, { target: { files: [] } }); });
  });

  it('un archivo que no se puede leer avisa', async () => {
    apiMock.responder('GET /softphone/ota', OTA);
    await montar();
    vi.stubGlobal('FileReader', class { readAsDataURL() { setTimeout(() => this.onerror(), 0); } });
    await act(async () => { fireEvent.change(document.querySelector('input[type=file]'), { target: { files: [new File(['x'], 'latest.yml')] } }); });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenLastCalledWith('No se pudo subir: no se pudo leer latest.yml', 'bad'));
  });
});

describe('/enroll', () => {
  const ir = (search) => vi.stubGlobal('location', { search, href: '' });

  it('sin token: «Falta el token de acceso.»', async () => {
    ir('');
    render(<Enroll />);
    await waitFor(() => expect(screen.getByText('Falta el token de acceso.')).toBeTruthy());
  });

  it('token bueno: guarda la extensión para el teléfono y lo abre', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    ir('?token=abc');
    const loc = window.location;
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ext: '101', password: 's3' }) })));
    render(<Enroll />);
    expect(screen.getByText('Configurando tu extensión…')).toBeTruthy();
    await act(async () => {});
    expect(fetch).toHaveBeenCalledWith('/backend/api/enroll/abc');
    expect(screen.getByText('Extensión 101 listo')).toBeTruthy();
    expect(JSON.parse(st.local.getItem('pbxng_softphone'))).toEqual({ ext: '101', pass: 's3', video: false });
    act(() => { vi.advanceTimersByTime(1600); });
    expect(location.href).toBe('/phone');
    expect(loc).toBeTruthy();
  });

  it('token vencido, inválido o servidor caído: cada uno con su mensaje', async () => {
    ir('?token=x');
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ error: 'token expirado' }) })));
    const a = render(<Enroll />);
    await waitFor(() => expect(screen.getByText('El acceso expiró. Pedí uno nuevo.')).toBeTruthy());
    a.unmount();
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ error: 'no existe' }) })));
    const b = render(<Enroll />);
    await waitFor(() => expect(screen.getByText('Token inválido.')).toBeTruthy());
    b.unmount();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('red'); }));
    render(<Enroll />);
    await waitFor(() => expect(screen.getByText('No se pudo conectar con el servidor.')).toBeTruthy());
    expect(document.getElementById('enr-kf')).toBeTruthy();
  });
});

describe('/call/[token] (click-to-call público)', () => {
  let rutas;
  beforeEach(() => {
    params.token = 'tk1';
    rutas = {
      '/backend/api/c2c/public/tk1': async () => ({ ok: true, json: async () => ({ name: 'Mesa de ayuda', intro: 'Te atendemos', require_name: true, collect_geo: true }) }),
      '/backend/api/c2c/public/tk1/session': async () => ({ json: async () => ({ ext: 'c2c1', pass: 'p', dial: '600', video: false }) }),
    };
    vi.stubGlobal('fetch', vi.fn((u, o) => (rutas[u] ? rutas[u](o) : Promise.resolve({ ok: false }))));
  });
  afterEach(() => { delete navigator.geolocation; });
  const montar = async () => { const r = render(<CallPage />); await act(async () => {}); return r; };

  it('enlace inexistente o desactivado', async () => {
    rutas['/backend/api/c2c/public/tk1'] = async () => ({ ok: false });
    await montar();
    expect(screen.getByText('Enlace no disponible')).toBeTruthy();
  });

  it('mientras carga dice «Cargando…»', () => {
    rutas['/backend/api/c2c/public/tk1'] = () => new Promise(() => {});
    render(<CallPage />);
    expect(screen.getByText('Cargando…')).toBeTruthy();
  });

  it('pide el nombre si el enlace lo exige', async () => {
    await montar();
    expect(screen.getByText('Mesa de ayuda')).toBeTruthy();
    expect(screen.getByText('Te atendemos')).toBeTruthy();
    expect(screen.getByText(/Se solicitará tu ubicación\./)).toBeTruthy();
    fireEvent.click(screen.getByText('Llamar ahora'));
    expect(screen.getByText('Por favor, ingresá tu nombre.')).toBeTruthy();
    expect(spRef.sp.connect).not.toHaveBeenCalled();
  });

  it('llamada completa: sesión con nombre y ubicación, conecta sin recordar credenciales y marca al registrarse', async () => {
    navigator.geolocation = { getCurrentPosition: vi.fn((ok) => ok({ coords: { latitude: -34.90123, longitude: -56.16456, accuracy: 12.4 } })) };
    const { rerender } = await montar();
    fireEvent.change(screen.getByPlaceholderText('Tu nombre'), { target: { value: '  Juana ' } });
    await act(async () => { fireEvent.click(screen.getByText('Llamar ahora')); });
    const [, init] = fetch.mock.calls.find((c) => c[0] === '/backend/api/c2c/public/tk1/session');
    const body = JSON.parse(init.body);
    expect(body.name).toBe('Juana');
    expect(body.geo).toEqual({ lat: -34.9012, lon: -56.1646, acc: 12 });
    expect(Object.keys(body.meta)).toEqual(['ua', 'ref', 'tz']);
    expect(spRef.sp.connect).toHaveBeenCalledWith('c2c1', 'p', false, false);
    expect(screen.getByText('Conectando la llamada…')).toBeTruthy();
    spRef.sp = { ...spRef.sp, reg: 'registered' };
    rerender(<CallPage />);
    expect(spRef.sp.placeCall).toHaveBeenCalledWith('600');
    rerender(<CallPage />);
    expect(spRef.sp.placeCall).toHaveBeenCalledTimes(1);
  });

  it('en llamada: reloj, silenciar y colgar; si el otro corta pasa a «Llamada finalizada» y se puede volver a llamar', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    rutas['/backend/api/c2c/public/tk1'] = async () => ({ ok: true, json: async () => ({ name: 'Ventas' }) });
    const { rerender } = await montar();
    await act(async () => { fireEvent.click(screen.getByText('Llamar ahora')); });
    spRef.sp = { ...spRef.sp, reg: 'registered', call: 'Established' };
    rerender(<CallPage />);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText(/En llamada · 0:03/)).toBeTruthy();
    fireEvent.click(screen.getByTitle('Silenciar'));
    expect(spRef.sp.toggleMute).toHaveBeenCalled();
    spRef.sp = { ...spRef.sp, muted: true };
    rerender(<CallPage />);
    spRef.sp = { ...spRef.sp, call: null };
    rerender(<CallPage />);
    expect(screen.getByText('Llamada finalizada')).toBeTruthy();
    fireEvent.click(screen.getByText('Llamar de nuevo'));
    expect(screen.getByText('Llamar ahora')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Llamar ahora')); });
    spRef.sp = { ...spRef.sp, call: 'Established' };
    rerender(<CallPage />);
    fireEvent.click(screen.getByTitle('Colgar'));
    expect(spRef.sp.hangup).toHaveBeenCalled();
    spRef.sp = { ...spRef.sp, call: null };
    rerender(<CallPage />);
    expect(screen.getByText('Llamada finalizada')).toBeTruthy();
  });

  it('cortada antes de atender (Terminated) también termina', async () => {
    rutas['/backend/api/c2c/public/tk1'] = async () => ({ ok: true, json: async () => ({ name: 'Ventas' }) });
    const { rerender } = await montar();
    await act(async () => { fireEvent.click(screen.getByText('Llamar ahora')); });
    spRef.sp = { ...spRef.sp, call: 'Terminated' };
    rerender(<CallPage />);
    expect(screen.getByText('Llamada finalizada')).toBeTruthy();
  });

  it('errores: la API rechaza la sesión, no se pudo registrar, o algo explota', async () => {
    rutas['/backend/api/c2c/public/tk1'] = async () => ({ ok: true, json: async () => ({ name: 'Ventas' }) });
    rutas['/backend/api/c2c/public/tk1/session'] = async () => ({ json: async () => ({ error: 'Fuera de horario' }) });
    const { rerender } = await montar();
    await act(async () => { fireEvent.click(screen.getByText('Llamar ahora')); });
    expect(screen.getByText('Fuera de horario')).toBeTruthy();
    fireEvent.click(screen.getByText('Reintentar'));
    rutas['/backend/api/c2c/public/tk1/session'] = async () => ({ json: async () => ({ ext: 'e', pass: 'p', dial: '1', video: true }) });
    await act(async () => { fireEvent.click(screen.getByText('Llamar ahora')); });
    expect(spRef.sp.connect).toHaveBeenLastCalledWith('e', 'p', true, false);
    spRef.sp = { ...spRef.sp, reg: 'error' };
    rerender(<CallPage />);
    expect(screen.getByText('No se pudo conectar la llamada. Revisá tu conexión.')).toBeTruthy();
    fireEvent.click(screen.getByText('Reintentar'));
    rutas['/backend/api/c2c/public/tk1/session'] = async () => { throw new Error('red'); };
    await act(async () => { fireEvent.click(screen.getByText('Llamar ahora')); });
    expect(screen.getByText('No se pudo iniciar la llamada.')).toBeTruthy();
  });

  it('ubicación: negada o sin respuesta en 4 s sigue sin ella', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rutas['/backend/api/c2c/public/tk1'] = async () => ({ ok: true, json: async () => ({ name: 'V', collect_geo: true }) });
    navigator.geolocation = { getCurrentPosition: vi.fn((_ok, ko) => ko(new Error('denegada'))) };
    await montar();
    await act(async () => { fireEvent.click(screen.getByText('Llamar ahora')); });
    let body = JSON.parse(fetch.mock.calls.find((c) => c[0].endsWith('/session'))[1].body);
    expect(body.geo).toBeNull();
  });

  it('ubicación que nunca contesta: a los 4 s se llama igual', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rutas['/backend/api/c2c/public/tk1'] = async () => ({ ok: true, json: async () => ({ name: 'V', collect_geo: true }) });
    navigator.geolocation = { getCurrentPosition: vi.fn() };
    await montar();
    expect(screen.getByText(/Se solicitará tu ubicación/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Llamar ahora')); });
    expect(fetch.mock.calls.some((c) => c[0].endsWith('/session'))).toBe(false);
    await act(async () => { vi.advanceTimersByTime(4000); });
    const body = JSON.parse(fetch.mock.calls.find((c) => c[0].endsWith('/session'))[1].body);
    expect(body.geo).toBeNull();
  });
});
