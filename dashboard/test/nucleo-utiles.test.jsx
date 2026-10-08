/* Utilidades del núcleo sin pantalla propia: los toasts (`notify.js`), el Web Push de la
 * PWA (`push.js`), la sonda ICE/TURN (`iceProbe.js`) y el socket en vivo (`useLive.js`).
 * Lo que se fija es lo que el operador termina viendo: que un error salga en rojo y dure
 * más, que «activar notificaciones» explique por qué no pudo, que la sonda diga
 * «credenciales del TURN mal» y no «no hay TURN», y que el estado de los internos no se
 * quede viejo después de una reconexión. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { instalarStorage } from './helpers/nucleo-render.jsx';

const sileo = vi.hoisted(() => {
  const s = {};
  for (const k of ['success', 'error', 'warning', 'info', 'action', 'loading', 'promise', 'dismiss']) s[k] = vi.fn(() => k + '-id');
  return s;
});
vi.mock('sileo', () => ({ sileo }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); document.documentElement.removeAttribute('data-mantine-color-scheme'); });

describe('notify: toasts', () => {
  let n;
  beforeEach(async () => { n = await import('../app/notify.js'); Object.values(sileo).forEach((f) => f.mockClear()); });

  it('mapea los tipos viejos a sileo, con duración más larga para errores', () => {
    n.toast('Guardado');
    expect(sileo.success.mock.calls[0][0]).toMatchObject({ title: 'Guardado', type: 'success', duration: 3400, position: 'top-center', roundness: 14 });
    n.toast('Falló', 'bad', { description: 'detalle' });
    expect(sileo.error.mock.calls[0][0]).toMatchObject({ type: 'error', duration: 5200, description: 'detalle' });
    n.toast('x', 'warn', { desc: 'd2', duration: 0, position: 'bottom-right', button: { title: 'b' } });
    expect(sileo.warning.mock.calls[0][0]).toMatchObject({ description: 'd2', duration: 0, position: 'bottom-right', button: { title: 'b' } });
    n.toast('y', 'loading');
    expect(sileo.loading.mock.calls[0][0].type).toBe('loading');
    n.toast('z', 'raro');
    expect(sileo.info).toHaveBeenCalledTimes(1);
    expect(n.toast('w', 'error', { icon: 'security' })).toBe('error-id');
  });

  it('si sileo no tiene el estado, cae a info', () => {
    const viejo = sileo.action; delete sileo.action;
    n.toast('a', 'action');
    expect(sileo.info).toHaveBeenCalledTimes(1);
    sileo.action = viejo;
  });

  it('el fondo sigue al tema; si no se puede leer, oscuro', () => {
    expect(n.toastFill()).toBe('#161d2c');
    document.documentElement.setAttribute('data-mantine-color-scheme', 'light');
    expect(n.toastFill()).toBe('#ffffff');
    const spy = vi.spyOn(document.documentElement, 'getAttribute').mockImplementation(() => { throw new Error('x'); });
    expect(n.toastFill()).toBe('#161d2c');
    spy.mockRestore();
  });

  it('del lado del servidor no hace nada', () => {
    vi.stubGlobal('window', undefined);
    expect(n.toast('x')).toBeUndefined();
    vi.unstubAllGlobals();
    expect(sileo.success).not.toHaveBeenCalled();
  });

  it('notifyCall: título y detalle por estado de la llamada', () => {
    n.notifyCall({ from: '2001', to: '1001' });
    expect(sileo.info.mock.calls[0][0]).toMatchObject({ title: 'Llamada entrante', description: '2001 → 1001', duration: 4200 });
    n.notifyCall({ state: 'talking' });
    expect(sileo.success.mock.calls[0][0].description).toBe('? ↔ ?');
    n.notifyCall({ state: 'waiting', from: '099' });
    expect(sileo.warning.mock.calls[0][0].description).toBe('099 esperando en cola');
    n.notifyCall({ state: 'hangup', duration: 1 });
    expect(sileo.info.mock.calls[1][0]).toMatchObject({ title: 'Llamada finalizada', duration: 1 });
    n.notifyCall({ state: 'agent' });
    n.notifyCall({ state: 'security', detail: 'IP baneada' });
    expect(sileo.error.mock.calls[0][0]).toMatchObject({ title: 'Seguridad', description: 'IP baneada' });
    n.notifyCall({ state: 'otro' });
    expect(sileo.info.mock.calls.at(-1)[0].title).toBe('Evento');
  });

  it('toastPromise arma los tres estados, con texto fijo o calculado', () => {
    const p = Promise.resolve(1);
    n.toastPromise(p, { loading: 'Subiendo', success: (d) => 'Listo ' + d, error: (e) => 'Falló: ' + e.message });
    const [prom, o] = sileo.promise.mock.calls[0];
    expect(prom).toBe(p);
    expect(o.loading.title).toBe('Subiendo');
    expect(o.success(3).title).toBe('Listo 3');
    expect(o.error(new Error('x'))).toMatchObject({ title: 'Falló: x', description: 'x' });
    n.toastPromise(p, { loading: 'L', success: 'S', error: 'E' });
    const o2 = sileo.promise.mock.calls[1][1];
    expect(o2.success().title).toBe('S');
    expect(o2.error(null)).toMatchObject({ title: 'E', description: '' });
    n.dismiss('id1');
    expect(sileo.dismiss).toHaveBeenCalledWith('id1');
  });
});

describe('push: notificaciones de la PWA', () => {
  let push, reg, sub;
  const instalar = ({ perm = 'default', pedir = 'granted', sub: s = null } = {}) => {
    sub = s;
    reg = { pushManager: { getSubscription: vi.fn(async () => sub), subscribe: vi.fn(async () => ({ endpoint: 'nuevo' })) } };
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'UA', serviceWorker: { ready: Promise.resolve(reg) } });
    vi.stubGlobal('PushManager', function () {});
    vi.stubGlobal('Notification', { permission: perm, requestPermission: vi.fn(async () => pedir) });
  };
  beforeEach(async () => { push = await import('../app/push.js'); });

  it('sin service worker no hay soporte, y lo dice al intentar activarlo', async () => {
    expect(push.pushSupported()).toBe(false);
    expect(await push.pushStatus()).toBe('unsupported');
    await expect(push.enablePush('101')).rejects.toThrow('Este dispositivo no soporta notificaciones push.');
    expect(await push.disablePush()).toBeUndefined();
  });

  it('estado: denegado, activo, apagado, y apagado si el SW falla', async () => {
    instalar({ perm: 'denied' });
    expect(await push.pushStatus()).toBe('denied');
    instalar({ sub: { endpoint: 'e' } });
    expect(await push.pushStatus()).toBe('on');
    instalar();
    expect(await push.pushStatus()).toBe('off');
    reg.pushManager.getSubscription.mockRejectedValue(new Error('x'));
    expect(await push.pushStatus()).toBe('off');
  });

  it('activar: pide permiso, se suscribe con la clave VAPID y registra la extensión', async () => {
    instalar();
    const fetchMock = vi.fn(async (u) => ({ json: async () => (u.includes('vapid') ? { key: 'BAc-_w' } : {}) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await push.enablePush('101')).toBe(true);
    const clave = reg.pushManager.subscribe.mock.calls[0][0].applicationServerKey;
    expect(Array.from(clave)).toEqual([...Buffer.from('BAc+/w==', 'base64')]);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/backend/api/push/subscribe');
    expect(JSON.parse(init.body)).toEqual({ ext: '101', subscription: { endpoint: 'nuevo' }, ua: 'UA' });
  });

  it('activar reutiliza la suscripción existente', async () => {
    instalar({ sub: { endpoint: 'viejo' } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ key: 'AAAA' }) })));
    await push.enablePush('7');
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('activar falla con mensaje claro si niegan el permiso o el servidor no tiene clave', async () => {
    instalar({ pedir: 'denied' });
    await expect(push.enablePush('1')).rejects.toThrow('Permiso de notificaciones denegado.');
    instalar();
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({}) })));
    await expect(push.enablePush('1')).rejects.toThrow('Servidor sin clave VAPID.');
  });

  it('desactivar avisa al servidor y se desuscribe, aunque una de las dos cosas falle', async () => {
    const unsubscribe = vi.fn(async () => { throw new Error('x'); });
    instalar({ sub: { endpoint: 'e1', unsubscribe } });
    const fetchMock = vi.fn(async () => { throw new Error('red'); });
    vi.stubGlobal('fetch', fetchMock);
    await push.disablePush();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ endpoint: 'e1' });
    expect(unsubscribe).toHaveBeenCalled();
    instalar();
    fetchMock.mockClear();
    await push.disablePush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probar manda la extensión', async () => {
    const fetchMock = vi.fn(async () => ({}));
    vi.stubGlobal('fetch', fetchMock);
    await push.testPush('101');
    expect(fetchMock).toHaveBeenCalledWith('/backend/api/push/test', expect.objectContaining({ method: 'POST', body: '{"ext":"101"}' }));
  });
});

describe('iceProbe: sonda STUN/TURN', () => {
  let ice, pc;
  class FakePC {
    constructor(cfg) { this.cfg = cfg; pc = this; this.closed = false; }
    createDataChannel() {}
    createOffer() { return FakePC.oferta(); }
    setLocalDescription() { return Promise.resolve(); }
    close() { this.closed = true; }
  }
  FakePC.oferta = () => Promise.resolve({ sdp: 'x' });
  beforeEach(async () => { ice = await import('../app/iceProbe.js'); vi.stubGlobal('RTCPeerConnection', FakePC); FakePC.oferta = () => Promise.resolve({ sdp: 'x' }); });

  it('fetchIceServers: la lista de la API, o vacía ante cualquier problema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: 'stun:x' }] }) })));
    expect(await ice.fetchIceServers()).toEqual([{ urls: 'stun:x' }]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ iceServers: 'no' }) })));
    expect(await ice.fetchIceServers()).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await ice.fetchIceServers()).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('red'); }));
    expect(await ice.fetchIceServers()).toEqual([]);
  });

  it('cuenta candidatos y con un relay da ok, con la IP pública y la del relay', async () => {
    const p = ice.probeIce([{ urls: 'turn:t', username: 'u' }]);
    pc.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host' } });
    pc.onicecandidate({ candidate: { type: 'srflx', address: '200.1.1.1', candidate: '' } });
    pc.onicecandidate({ candidate: { candidate: 'candidate:2 1 udp 1 200.1.1.2 5001 typ srflx' } });
    pc.onicecandidate({ candidate: { candidate: 'candidate:3 1 udp 1 190.0.0.9 5002 typ relay' } });
    pc.onicecandidate({ candidate: { type: 'relay', address: '190.0.0.10' } });
    pc.onicecandidate({ candidate: { candidate: 'raro' } });
    pc.onicecandidate({ candidate: null });
    const r = await p;
    expect(r).toMatchObject({ state: 'ok', host: 1, srflx: 2, relay: 2, publicIp: '200.1.1.1', relayIp: '190.0.0.9', turnConfigured: true });
    expect(pc.closed).toBe(true);
    expect(pc.cfg).toEqual({ iceServers: [{ urls: 'turn:t', username: 'u' }], iceTransportPolicy: 'all' });
  });

  it('sin TURN configurado el veredicto es no-turn (aunque haya STUN)', async () => {
    const p = ice.probeIce([{ url: 'stun:s' }, { urls: 'turn:x' }]);
    pc.onicecandidate({});
    expect((await p).state).toBe('no-turn');
    const p2 = ice.probeIce();
    pc.onicecandidate({});
    expect(await p2).toMatchObject({ state: 'no-turn', turnConfigured: false });
  });

  it('TURN con 401/403 corta enseguida como credenciales malas', async () => {
    const p = ice.probeIce([{ urls: 'turns:t', username: 'u' }]);
    pc.onicecandidateerror({ errorCode: 701, errorText: 'timeout', url: 'turns:t' });
    pc.onicecandidateerror({});
    pc.onicecandidateerror({ errorcode: 401, errortext: 'Unauthorized' });
    pc.onicecandidateerror({ errorCode: 403 });
    pc.onicecandidateerror(null);
    const r = await p;
    expect(r.state).toBe('turn-auth');
    expect(r.errors.slice(0, 2)).toEqual(['701 timeout (turns:t)', '401 Unauthorized']);
  });

  it('al vencer el tiempo distingue TURN con error de autorización de TURN inalcanzable', async () => {
    vi.useFakeTimers();
    const p = ice.probeIce([{ urls: 'turn:t', username: 'u' }], 1000);
    pc.onicecandidateerror({ errorText: 'Unauthorized' });
    vi.advanceTimersByTime(1000);
    expect((await p).state).toBe('turn-auth');
    const p2 = ice.probeIce([{ urls: 'turn:t', username: 'u' }], 1000);
    vi.advanceTimersByTime(1000);
    expect((await p2).state).toBe('turn-unreachable');
  });

  it('errores de WebRTC: no se pudo crear la conexión, la oferta o el canal', async () => {
    vi.stubGlobal('RTCPeerConnection', function () { throw new Error('sin WebRTC'); });
    expect(await ice.probeIce([])).toMatchObject({ state: 'error', errors: ['sin WebRTC'] });
    vi.stubGlobal('RTCPeerConnection', FakePC);
    FakePC.oferta = () => Promise.reject(new Error('oferta'));
    expect(await ice.probeIce([])).toMatchObject({ state: 'error', errors: ['oferta'] });
    FakePC.oferta = () => Promise.reject(null);
    expect((await ice.probeIce([])).errors).toEqual(['null']);
    FakePC.oferta = () => { throw 'sin canal'; };
    expect(await ice.probeIce([])).toMatchObject({ state: 'error', errors: ['sin canal'] });
    FakePC.oferta = () => Promise.resolve({});
    vi.stubGlobal('RTCPeerConnection', class extends FakePC { close() { throw new Error('x'); } });
    const p = ice.probeIce([]);
    pc.onicecandidate({});
    expect((await p).state).toBe('no-turn');
  });
});

describe('useLive / useEstados: el socket compartido', () => {
  let io, sock;
  function crearSocket(connected) {
    const h = {};
    return {
      connected, h,
      on: vi.fn((ev, fn) => { (h[ev] ||= []).push(fn); }),
      once: vi.fn((ev, fn) => { (h[ev] ||= []).push(fn); }),
      off: vi.fn((ev, fn) => { h[ev] = (h[ev] || []).filter((x) => x !== fn); }),
      emit: vi.fn(),
      fire(ev, d) { (h[ev] || []).slice().forEach((f) => f(d)); },
    };
  }
  async function cargar({ token = 'jwt', connected = true } = {}) {
    vi.resetModules();
    instalarStorage(token ? { pbxng_jwt: token } : {});
    sock = crearSocket(connected);
    io = vi.fn(() => sock);
    vi.doMock('socket.io-client', () => ({ io }));
    return import('../app/useLive.js');
  }
  afterEach(() => vi.doUnmock('socket.io-client'));

  it('sin sesión no abre socket y los hooks quedan quietos', async () => {
    const m = await cargar({ token: null });
    expect(m.getSocket()).toBeNull();
    const a = renderHook(() => m.useLive());
    const b = renderHook(() => m.useEstados());
    expect(a.result.current).toEqual({ snap: null, connected: false });
    expect(b.result.current).toEqual({});
    expect(io).not.toHaveBeenCalled();
  });

  it('con sesión abre UNA conexión con el JWT en el handshake, WebSocket con polling de piso', async () => {
    const m = await cargar();
    expect(m.getSocket()).toBe(m.getSocket());
    expect(io).toHaveBeenCalledTimes(1);
    expect(io.mock.calls[0][0]).toEqual({ path: '/socket.io', transports: ['polling', 'websocket'], upgrade: true, auth: { token: 'jwt' } });
  });

  it('useLive pide un snapshot fresco al montar y recuerda el último para la próxima pantalla', async () => {
    const m = await cargar();
    const a = renderHook(() => m.useLive());
    expect(sock.emit).toHaveBeenCalledWith('snapshot:pedir');
    expect(a.result.current.connected).toBe(true);
    act(() => sock.fire('snapshot', { calls: [1] }));
    expect(a.result.current.snap).toEqual({ calls: [1] });
    act(() => sock.fire('disconnect'));
    expect(a.result.current.connected).toBe(false);
    act(() => sock.fire('connect'));
    expect(a.result.current.connected).toBe(true);
    const b = renderHook(() => m.useLive());
    expect(b.result.current.snap).toEqual({ calls: [1] });
    a.unmount();
    expect(sock.off).toHaveBeenCalledWith('snapshot', expect.any(Function));
  });

  it('useLive desconectado espera al connect para pedir el snapshot', async () => {
    const m = await cargar({ connected: false });
    renderHook(() => m.useLive());
    expect(sock.emit).not.toHaveBeenCalled();
    act(() => sock.fire('connect'));
    expect(sock.emit).toHaveBeenCalledWith('snapshot:pedir');
  });

  it('useEstados: el completo reemplaza, las diferencias se funden, y reconectar pide uno completo', async () => {
    const m = await cargar();
    const { result, unmount } = renderHook(() => m.useEstados());
    expect(sock.emit).toHaveBeenCalledWith('estados:pedir');
    act(() => sock.fire('estados', { completo: true, internos: { 101: 'libre', 102: 'libre' } }));
    act(() => sock.fire('estados', { internos: { 102: 'timbrando' } }));
    expect(result.current).toEqual({ 101: 'libre', 102: 'timbrando' });
    act(() => sock.fire('estados', null));
    act(() => sock.fire('estados', {}));
    expect(result.current).toEqual({ 101: 'libre', 102: 'timbrando' });
    act(() => sock.fire('estados', { completo: true, internos: { 103: 'libre' } }));
    expect(result.current).toEqual({ 103: 'libre' });
    sock.emit.mockClear();
    act(() => sock.fire('connect'));
    expect(sock.emit).toHaveBeenCalledWith('estados:pedir');
    unmount();
    expect(sock.h.estados).toEqual([]);
  });

  it('useEstados desconectado no pide hasta conectar', async () => {
    const m = await cargar({ connected: false });
    renderHook(() => m.useEstados());
    expect(sock.emit).not.toHaveBeenCalled();
  });
});
