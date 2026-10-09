/* El motor del softphone web (`app/useSoftphone.js`): registro SIP por WSS, llamadas
 * salientes y entrantes, espera, transferencia (ciega y atendida), compartir pantalla o un
 * archivo, grabación, DTMF, calidad de la llamada y el vigilante que corta una llamada
 * muerta. Es lo que usa la PWA /phone, el click-to-call público y el panel de agente.
 *
 * Lo que se fija: a qué servidor y con qué ICE se registra (una entrada de TURN mal formada
 * NO puede tumbar el softphone), qué queda en el historial (las perdidas también), que al
 * colgar se libere el micrófono, que la reconexión sólo ocurra si el usuario quiere estar
 * conectado, y que el vigilante corte una llamada sin audio pero NO una en espera ni
 * durante una consulta de transferencia. Todo con un sip.js falso: no hay red ni medios. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { instalarStorage } from './helpers/nucleo-render.jsx';
import { crearSipFalso, SesionFalsa, instalarMedios, pista } from './helpers/nucleo-sip.js';

let sip, st, medios, fetchMock, rutas, mod;

async function cargar({ guardado } = {}) {
  vi.resetModules();
  st = instalarStorage(guardado ? { pbxng_softphone: guardado } : {});
  medios = instalarMedios();
  sip = crearSipFalso();
  vi.doMock('sip.js', () => sip.modulo);
  rutas = {
    '/backend/api/ice': async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: 'stun:stun.central:3478' }] }) }),
    '/backend/api/phone/token': async () => ({ ok: true, json: async () => ({ token: 'tok-tel' }) }),
    '/backend/api/calls/record': async () => ({ json: async () => ({ ok: true }) }),
    '/backend/api/geo/report': async () => ({ ok: true }),
  };
  fetchMock = vi.fn((u, o) => (rutas[u] ? rutas[u](o) : Promise.resolve({ ok: false, json: async () => ({}) })));
  vi.stubGlobal('fetch', fetchMock);
  mod = await import('../app/useSoftphone.js');
  return mod;
}

async function montar(opts) {
  await cargar(opts);
  const h = renderHook(() => mod.useSoftphone());
  await act(async () => {});
  return h;
}
async function conectado(opts) {
  const h = await montar(opts);
  await act(async () => { await h.result.current.connect('101', 'clave'); });
  return h;
}
async function enLlamada(h, num = '200') {
  await act(async () => { await h.result.current.placeCall(num); });
  const s = sip.estado.inviters.at(-1);
  await act(async () => { s.cambiar('Established'); });
  return s;
}

beforeEach(() => { delete window.__pbxReloadPending; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.doUnmock('sip.js'); delete navigator.mediaDevices; delete navigator.geolocation; delete navigator.mediaSession; delete navigator.wakeLock; delete navigator.vibrate; });

describe('registro', () => {
  it('sin extensión o clave no hace nada', async () => {
    const h = await montar();
    await act(async () => { await h.result.current.connect('', 'x'); await h.result.current.connect('101', ''); });
    expect(h.result.current.reg).toBe('idle');
    expect(sip.estado.agentes).toHaveLength(0);
  });

  it('se registra por wss del mismo host, con el ICE de la central, y guarda token y credenciales', async () => {
    const h = await conectado();
    const ua = sip.estado.agentes[0];
    expect(ua.opts.uri.s).toBe('sip:101@localhost');
    expect(ua.opts.transportOptions.server).toBe('wss://localhost:3000/ws');
    expect(ua.opts.authorizationUsername).toBe('101');
    expect(ua.opts.sessionDescriptionHandlerFactoryOptions.peerConnectionConfiguration.iceServers).toEqual([{ urls: 'stun:stun.central:3478' }]);
    expect(sip.estado.registerers[0].opts).toEqual({ expires: 120 });
    expect(h.result.current.reg).toBe('registered');
    expect(h.result.current.creds).toEqual({ ext: '101', pass: 'clave', video: false });
    expect(st.local.getItem('pbxng_phone_jwt')).toBe('tok-tel');
    expect(JSON.parse(st.local.getItem('pbxng_softphone'))).toEqual({ ext: '101', pass: 'clave', video: false });
    expect(JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/backend/api/phone/token')[1].body)).toEqual({ ext: '101', password: 'clave' });
    expect(medios.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it('descarta las entradas de ICE que el navegador no sabe parsear y se queda con el resto', async () => {
    await cargar();
    rutas['/backend/api/ice'] = async () => ({ ok: true, json: async () => ({ iceServers: [
      { urls: 'turn:' }, { urls: ['stun:a.b:3478', 'http://x'] }, { urls: ['turn:t1:3478', 'turns:t2?transport=tcp'], username: 'u' },
      { urls: 'turn:[2001:db8::1]:3478' }, null, { urls: 'turn: con espacio' },
    ] }) });
    const h = renderHook(() => mod.useSoftphone());
    await act(async () => { await h.result.current.connect('101', 'c'); });
    expect(sip.estado.agentes[0].opts.sessionDescriptionHandlerFactoryOptions.peerConnectionConfiguration.iceServers).toEqual([
      { urls: 'stun:a.b:3478' }, { urls: ['turn:t1:3478', 'turns:t2?transport=tcp'], username: 'u' }, { urls: 'turn:[2001:db8::1]:3478' },
    ]);
  });

  it('ICE caído, vacío o inválido: llama igual; sin token de teléfono igual se registra; remember=false no guarda', async () => {
    await cargar();
    rutas['/backend/api/ice'] = async () => ({ ok: true, json: async () => ({ iceServers: 'nada' }) });
    rutas['/backend/api/phone/token'] = async () => ({ ok: true, json: async () => ({}) });
    const h = renderHook(() => mod.useSoftphone());
    await act(async () => { await h.result.current.connect('101', 'c', true, false); });
    expect(sip.estado.agentes[0].opts.sessionDescriptionHandlerFactoryOptions.peerConnectionConfiguration.iceServers).toEqual([]);
    expect(st.local.getItem('pbxng_softphone')).toBeNull();
    expect(st.local.getItem('pbxng_phone_jwt')).toBeNull();
    expect(medios.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    rutas['/backend/api/ice'] = async () => ({ ok: false });
    rutas['/backend/api/phone/token'] = async () => { throw new Error('red'); };
    await act(async () => { await h.result.current.connect('102', 'c'); });
    expect(h.result.current.reg).toBe('registered');
    rutas['/backend/api/ice'] = async () => { throw new Error('red'); };
    rutas['/backend/api/phone/token'] = async () => ({ ok: false });
    await act(async () => { await h.result.current.connect('103', 'c'); });
    expect(h.result.current.creds.ext).toBe('103');
  });

  it('si el registro falla queda en error y el error sube a quien llamó', async () => {
    await cargar();
    sip.estado.fallarRegister = true;
    const h = renderHook(() => mod.useSoftphone());
    let err;
    await act(async () => { await h.result.current.connect('101', 'mal').catch((e) => { err = e; }); });
    expect(err.message).toBe('401 no autorizado');
    expect(h.result.current.reg).toBe('error');
  });

  it('estados del registrador: desregistrado o cualquier otro es «conectando»', async () => {
    const h = await conectado();
    const r = sip.estado.registerers[0];
    act(() => r.stateChange.emit('Unregistered'));
    expect(h.result.current.reg).toBe('connecting');
    act(() => r.stateChange.emit('Terminated'));
    expect(h.result.current.reg).toBe('connecting');
    act(() => r.stateChange.emit('Registered'));
    expect(h.result.current.reg).toBe('registered');
  });

  it('se cae el WebSocket: reconecta a los 2,5 s si el usuario quiere estar conectado; al reconectar se vuelve a registrar', async () => {
    const h = await conectado();
    vi.useFakeTimers();
    const ua = sip.estado.agentes[0];
    act(() => ua.delegate.onDisconnect(new Error('cerrado')));
    expect(h.result.current.reg).toBe('connecting');
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(ua.reconnect).toHaveBeenCalledTimes(1);
    act(() => ua.delegate.onDisconnect());
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(ua.reconnect).toHaveBeenCalledTimes(1);
    sip.estado.registerers[0].register.mockClear();
    ua.delegate.onConnect();
    expect(sip.estado.registerers[0].register).toHaveBeenCalled();
    sip.estado.registerers[0].register.mockRejectedValueOnce(new Error('x'));
    ua.delegate.onConnect();
    ua.reconnect.mockRejectedValueOnce(new Error('x'));
    act(() => ua.delegate.onDisconnect(new Error('otra')));
    await act(async () => { await h.result.current.disconnect(); });
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(ua.reconnect).toHaveBeenCalledTimes(1);
  });

  it('onConnect antes de tener registrador no hace nada', async () => {
    await cargar();
    const h = renderHook(() => mod.useSoftphone());
    let ua;
    sip.estado.fallarStart = true;
    await act(async () => { await h.result.current.connect('101', 'c').catch(() => {}); });
    ua = sip.estado.agentes[0];
    expect(() => ua.delegate.onConnect()).not.toThrow();
    expect(h.result.current.reg).toBe('error');
  });

  it('se reconecta solo al montar con las credenciales guardadas; un JSON roto se ignora', async () => {
    const h = await montar({ guardado: JSON.stringify({ ext: '105', pass: 'p', video: false }) });
    await act(async () => {});
    expect(h.result.current.creds && h.result.current.creds.ext).toBe('105');
    const h2 = await montar({ guardado: '{roto' });
    expect(h2.result.current.reg).toBe('idle');
  });

  it('desconectar desregistra, para el agente y borra token y credenciales', async () => {
    const h = await conectado();
    await act(async () => { await h.result.current.disconnect(); });
    expect(sip.estado.registerers[0].unregister).toHaveBeenCalled();
    expect(sip.estado.agentes[0].stop).toHaveBeenCalled();
    expect(h.result.current.reg).toBe('idle');
    expect(h.result.current.creds).toBeNull();
    expect(st.local.getItem('pbxng_phone_jwt')).toBeNull();
    expect(st.local.getItem('pbxng_softphone')).toBeNull();
    sip.estado.registerers[0].unregister.mockRejectedValue(new Error('x'));
    st.local.removeItem = vi.fn((k) => { if (k === 'pbxng_phone_jwt') throw new Error('x'); });
    await act(async () => { await h.result.current.disconnect(); });
    expect(st.local.removeItem).toHaveBeenCalledWith('pbxng_softphone');
  });

  it('desmontar para el agente y el timbre', async () => {
    const h = await conectado();
    h.unmount();
    expect(sip.estado.agentes[0].stop).toHaveBeenCalled();
    const h2 = await conectado();
    sip.estado.agentes[0].stop.mockImplementation(() => { throw new Error('x'); });
    expect(() => h2.unmount()).not.toThrow();
  });
});

describe('llamadas', () => {
  it('saliente: arma el INVITE al número, timbra de vuelta, y al atender conecta el audio remoto', async () => {
    const h = await conectado();
    const audio = { play: vi.fn(async () => {}), srcObject: null };
    const rv = { srcObject: null }, lv = { srcObject: null };
    h.result.current.audioRef.current = audio; h.result.current.remoteVideoRef.current = rv; h.result.current.localVideoRef.current = lv;
    await act(async () => { await h.result.current.placeCall(' 200 '); });
    const s = sip.estado.inviters[0];
    expect(s.uri.s).toBe('sip:200@localhost');
    expect(s.opts.earlyMedia).toBe(true);
    expect(s.opts.sessionDescriptionHandlerOptions.constraints).toEqual({ audio: true, video: false });
    expect(s.invite).toHaveBeenCalled();
    expect(h.result.current.callInfo).toMatchObject({ dir: 'out', number: '200', video: false });
    act(() => s.cambiar('Establishing'));
    expect(h.result.current.call).toBe('Establishing');
    expect(window.__pbxInCall).toBe(true);
    s.sessionDescriptionHandler.peerConnection.senders.push({ track: pista('video') });
    await act(async () => { s.cambiar('Established'); });
    expect(h.result.current.call).toBe('Established');
    expect(audio.srcObject.getTracks()).toHaveLength(1);
    expect(audio.play).toHaveBeenCalled();
    expect(rv.srcObject).toBe(audio.srcObject);
    expect(lv.srcObject.getTracks()[0].kind).toBe('video');
    expect(typeof h.result.current.callInfo.since).toBe('number');
  });

  it('al terminar: historial, micrófono liberado, todo a cero, y la recarga pendiente se hace', async () => {
    const h = await conectado();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, hostname: 'localhost', host: 'localhost:3000', reload });
    const s = await enLlamada(h);
    h.result.current.audioRef.current = { srcObject: 1 };
    h.result.current.remoteVideoRef.current = { srcObject: 1 };
    h.result.current.localVideoRef.current = { srcObject: 1 };
    window.__pbxReloadPending = true;
    await act(async () => { s.cambiar('Terminated'); });
    expect(h.result.current.call).toBeNull();
    expect(h.result.current.callInfo).toBeNull();
    expect(h.result.current.hist[0]).toMatchObject({ dir: 'out', number: '200' });
    expect(typeof h.result.current.hist[0].ended).toBe('number');
    expect(s.sessionDescriptionHandler.peerConnection.senders[0].track.stop).toHaveBeenCalled();
    expect(s.sessionDescriptionHandler.close).toHaveBeenCalled();
    expect(h.result.current.audioRef.current.srcObject).toBeNull();
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(reload).toHaveBeenCalled();
    expect(window.__pbxInCall).toBe(false);
  });

  it('no llama sin número o sin registro; con video pide cámara; con geo informa la ubicación', async () => {
    const h = await montar();
    await act(async () => { await h.result.current.placeCall('200'); });
    expect(sip.estado.inviters).toHaveLength(0);
    await act(async () => { await h.result.current.connect('101', 'c', true); });
    await act(async () => { await h.result.current.placeCall('  '); });
    expect(sip.estado.inviters).toHaveLength(0);
    navigator.geolocation = { getCurrentPosition: vi.fn((ok) => ok({ coords: { latitude: -34.9, longitude: -56.1, accuracy: 10 } })) };
    await act(async () => { await h.result.current.placeCall('300'); });
    expect(sip.estado.inviters[0].opts.sessionDescriptionHandlerOptions.constraints).toEqual({ audio: true, video: true });
    const geo = fetchMock.mock.calls.find((c) => c[0] === '/backend/api/geo/report');
    expect(JSON.parse(geo[1].body)).toEqual({ ext: '101', number: '300', dir: 'out', lat: -34.9, lng: -56.1, accuracy: 10 });
    st.local.setItem('pbxng_geo', '0');
    fetchMock.mockClear();
    await act(async () => { await h.result.current.placeCall('301', false); });
    expect(fetchMock.mock.calls.some((c) => c[0] === '/backend/api/geo/report')).toBe(false);
    st.local.getItem = () => { throw new Error('x'); };
    await act(async () => { await h.result.current.placeCall('302', false); });
    expect(sip.estado.inviters).toHaveLength(3);
  });

  it('usa el micrófono y la cámara elegidos en Dispositivos', async () => {
    const h = await conectado();
    st.local.setItem('pbxng_dev_mic', 'mic-2');
    st.local.setItem('pbxng_dev_cam', 'cam-3');
    await act(async () => { await h.result.current.placeCall('200', true); });
    expect(sip.estado.inviters[0].opts.sessionDescriptionHandlerOptions.constraints).toEqual({ audio: { deviceId: { ideal: 'mic-2' } }, video: { deviceId: { ideal: 'cam-3' } } });
  });

  it('entrante: suena, detecta video por el SDP, se atiende con el número de quien llama', async () => {
    const h = await conectado();
    const ua = sip.estado.agentes[0];
    const inv = new SesionFalsa({ desde: '2001', body: 'v=0\r\nm=audio 1\r\nm=video 2' });
    act(() => ua.delegate.onInvite(inv));
    expect(h.result.current.incoming).toBe(inv);
    expect(h.result.current.incomingVideo).toBe(true);
    expect(medios.AudioContext.creados).toBeGreaterThan(0);
    await act(async () => { await h.result.current.acceptIncoming(); });
    expect(h.result.current.incoming).toBeNull();
    expect(inv.accept.mock.calls[0][0].sessionDescriptionHandlerOptions.constraints).toEqual({ audio: true, video: true });
    expect(h.result.current.callInfo).toMatchObject({ dir: 'in', number: '2001', video: true });
    await act(async () => { await h.result.current.acceptIncoming(); });
    expect(inv.accept).toHaveBeenCalledTimes(1);
  });

  it('entrante sin identidad ni SDP legible: «desconocido», sin video; y atender forzando audio', async () => {
    const h = await conectado();
    const ua = sip.estado.agentes[0];
    const inv = new SesionFalsa(); inv.remoteIdentity = null; inv.request = null; inv.body = { no: 'string' };
    act(() => ua.delegate.onInvite(inv));
    expect(h.result.current.incomingVideo).toBe(false);
    const raro = new SesionFalsa(); Object.defineProperty(raro, 'request', { get() { throw new Error('x'); } });
    act(() => ua.delegate.onInvite(raro));
    expect(h.result.current.incomingVideo).toBe(false);
    act(() => ua.delegate.onInvite(inv));
    await act(async () => { await h.result.current.acceptIncoming(false); });
    expect(h.result.current.callInfo.number).toBe('desconocido');
  });

  it('rechazar deja la llamada como perdida en el historial', async () => {
    const h = await conectado();
    const inv = new SesionFalsa({ desde: '099' });
    act(() => sip.estado.agentes[0].delegate.onInvite(inv));
    act(() => h.result.current.rejectIncoming());
    expect(inv.reject).toHaveBeenCalled();
    expect(h.result.current.hist[0]).toMatchObject({ dir: 'in', number: '099', missed: true });
    expect(h.result.current.incoming).toBeNull();
    const anon = new SesionFalsa(); anon.remoteIdentity = {};
    act(() => sip.estado.agentes[0].delegate.onInvite(anon));
    act(() => h.result.current.rejectIncoming());
    expect(h.result.current.hist[0].number).toBe('?');
    act(() => h.result.current.rejectIncoming());
    expect(h.result.current.hist).toHaveLength(2);
  });

  it('colgar: BYE si estaba hablando, CANCEL si estaba sonando, REJECT si no hay otra', async () => {
    const h = await conectado();
    await act(async () => { await h.result.current.hangup(); });
    const s = await enLlamada(h);
    await act(async () => { await h.result.current.hangup(); });
    expect(s.bye).toHaveBeenCalled();
    expect(h.result.current.call).toBeNull();
    await act(async () => { await h.result.current.placeCall('201'); });
    const s2 = sip.estado.inviters[1];
    await act(async () => { await h.result.current.hangup(); });
    expect(s2.cancel).toHaveBeenCalled();
    await act(async () => { await h.result.current.placeCall('202'); });
    const s3 = sip.estado.inviters[2]; s3.cancel = null;
    s3.bye.mockRejectedValue(new Error('x'));
    await act(async () => { await h.result.current.hangup(); });
    expect(s3.reject).toHaveBeenCalled();
    await act(async () => { await h.result.current.placeCall('203'); });
    const s4 = sip.estado.inviters[3]; s4.cancel = null; s4.reject = null;
    await act(async () => { await h.result.current.hangup(); });
    expect(h.result.current.call).toBeNull();
  });
});

describe('controles en llamada', () => {
  it('silenciar apaga el audio que se envía y vuelve a prenderlo', async () => {
    const h = await conectado();
    act(() => h.result.current.toggleMute());
    const s = await enLlamada(h);
    const tr = s.sessionDescriptionHandler.peerConnection.senders[0].track;
    act(() => h.result.current.toggleMute());
    expect(tr.enabled).toBe(false);
    expect(h.result.current.muted).toBe(true);
    act(() => h.result.current.toggleMute());
    expect(tr.enabled).toBe(true);
  });

  it('espera: re-INVITE con hold, corta el audio propio; si falla no cambia', async () => {
    const h = await conectado();
    await act(async () => { await h.result.current.toggleHold(); });
    const s = await enLlamada(h);
    await act(async () => { await h.result.current.toggleHold(); });
    expect(s.sessionDescriptionHandlerOptionsReInvite).toEqual({ hold: true });
    expect(h.result.current.held).toBe(true);
    expect(s.sessionDescriptionHandler.peerConnection.senders[0].track.enabled).toBe(false);
    s.invite.mockRejectedValueOnce(new Error('488'));
    await act(async () => { await h.result.current.toggleHold(); });
    expect(h.result.current.held).toBe(true);
  });

  it('transferencia ciega: REFER al destino; sin llamada, sin destino o con error devuelve false', async () => {
    const h = await conectado();
    expect(await h.result.current.transfer('300')).toBe(false);
    const s = await enLlamada(h);
    expect(await h.result.current.transfer('')).toBe(false);
    expect(await h.result.current.transfer(' 300 ')).toBe(true);
    expect(s.refer.mock.calls[0][0].s).toBe('sip:300@localhost');
    s.refer.mockRejectedValueOnce(new Error('x'));
    expect(await h.result.current.transfer('300')).toBe(false);
  });

  it('transferencia atendida: pone en espera, consulta, y completa con REFER a la consulta', async () => {
    const h = await conectado();
    expect(await h.result.current.attendedCall('400')).toBe(false);
    const s = await enLlamada(h);
    const audio = { play: vi.fn(async () => {}), srcObject: null };
    h.result.current.audioRef.current = audio;
    let ok;
    await act(async () => { ok = await h.result.current.attendedCall('400'); });
    expect(ok).toBe(true);
    expect(h.result.current.held).toBe(true);
    const c = sip.estado.inviters[1];
    expect(h.result.current.attended).toEqual({ number: '400', state: 'calling' });
    act(() => c.cambiar('Establishing'));
    expect(h.result.current.attended.state).toBe('establishing');
    await act(async () => { c.cambiar('Established'); });
    expect(h.result.current.attended.state).toBe('talking');
    expect(audio.srcObject.getTracks()).toHaveLength(1);
    await act(async () => { await h.result.current.completeAttended(); });
    expect(s.refer).toHaveBeenCalledWith(c);
    s.refer.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.completeAttended(); });
    act(() => c.cambiar('Terminated'));
    expect(h.result.current.attended).toBeNull();
    await act(async () => { await h.result.current.completeAttended(); });
    expect(s.refer).toHaveBeenCalledTimes(2);
  });

  it('cancelar la atendida: corta la consulta (BYE o CANCEL), saca de espera y vuelve el audio', async () => {
    const h = await conectado();
    const s = await enLlamada(h);
    h.result.current.audioRef.current = { play: vi.fn(async () => {}), srcObject: null };
    await act(async () => { await h.result.current.attendedCall('400'); });
    const c = sip.estado.inviters[1];
    await act(async () => { c.cambiar('Established'); });
    await act(async () => { await h.result.current.cancelAttended(); });
    expect(c.bye).toHaveBeenCalled();
    expect(h.result.current.attended).toBeNull();
    expect(h.result.current.held).toBe(false);
    expect(s.sessionDescriptionHandlerOptionsReInvite).toEqual({ hold: false });
    s.invite.mockRejectedValueOnce(new Error('no hold'));
    await act(async () => { await h.result.current.attendedCall('401'); });
    const c2 = sip.estado.inviters[2];
    c2.cancel.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.cancelAttended(); });
    expect(c2.cancel).toHaveBeenCalled();
    await act(async () => { await h.result.current.attendedCall('402'); });
    sip.estado.inviters[3].cancel = null;
    await act(async () => { await h.result.current.cancelAttended(); });
    expect(h.result.current.attended).toBeNull();
  });

  it('atendida que no se puede armar, y cancelar sin llamada', async () => {
    const h = await conectado();
    await act(async () => { await h.result.current.cancelAttended(); });
    const s = await enLlamada(h);
    vi.doMock('sip.js', () => ({ UserAgent: { makeURI: () => { throw new Error('uri'); } } }));
    let ok;
    await act(async () => { ok = await h.result.current.attendedCall('500'); });
    expect(ok).toBe(false);
    expect(h.result.current.attended).toBeNull();
    expect(s.invite).toHaveBeenCalled();
  });

  it('DTMF: tono local siempre, y por la sesión sólo si la llamada está establecida', async () => {
    const h = await conectado();
    act(() => h.result.current.tone('5'));
    const s = await enLlamada(h);
    act(() => h.result.current.tone('#'));
    expect(s.sessionDescriptionHandler.sendDtmf).toHaveBeenCalledWith('#');
    s.sessionDescriptionHandler.sendDtmf.mockImplementation(() => { throw new Error('x'); });
    expect(() => act(() => h.result.current.tone('1'))).not.toThrow();
    expect(medios.osciladores.length).toBeGreaterThanOrEqual(4);
  });

  it('grabar: pide a la central empezar y parar; error de la API o de red no cambia el estado', async () => {
    const h = await montar();
    expect(await h.result.current.toggleRecord()).toEqual({ error: 'sin interno' });
    await act(async () => { await h.result.current.connect('101', 'c'); });
    await act(async () => { await h.result.current.toggleRecord(); });
    expect(h.result.current.recording).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/backend/api/calls/record')[1].body)).toEqual({ ext: '101', action: 'start' });
    rutas['/backend/api/calls/record'] = async () => ({ json: async () => ({ error: 'no hay canal' }) });
    let r;
    await act(async () => { r = await h.result.current.toggleRecord(); });
    expect(r).toEqual({ error: 'no hay canal' });
    expect(h.result.current.recording).toBe(true);
    rutas['/backend/api/calls/record'] = async () => { throw new Error('red'); };
    await act(async () => { r = await h.result.current.toggleRecord(); });
    expect(r).toEqual({ error: 'red' });
  });

  it('altavoz: elige la salida «speaker» o la primera no-default, y vuelve al auricular', async () => {
    const h = await conectado();
    const el = { setSinkId: vi.fn(async () => {}), play: vi.fn(async () => {}), volume: 0, muted: true };
    h.result.current.audioRef.current = el;
    medios.mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: 'audiooutput', deviceId: 'default', label: 'Default' },
      { kind: 'audiooutput', deviceId: 'spk', label: 'Speakerphone' },
      { kind: 'audiooutput', deviceId: 'ear', label: 'Earpiece' },
      { kind: 'audioinput', deviceId: 'mic' },
    ]);
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('spk');
    expect([el.volume, el.muted, h.result.current.speaker]).toEqual([1, false, true]);
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('ear');
    medios.mediaDevices.enumerateDevices.mockResolvedValue([{ kind: 'audiooutput', deviceId: 'default' }, { kind: 'audiooutput', deviceId: 'usb', label: '' }]);
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('usb');
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('default');
    medios.mediaDevices.enumerateDevices.mockResolvedValue([{ kind: 'audiooutput', deviceId: 'default' }]);
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('');
    el.setSinkId.mockRejectedValue(new Error('x'));
    await act(async () => { await h.result.current.toggleSpeaker(); });
    h.result.current.audioRef.current = null;
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(typeof h.result.current.speaker).toBe('boolean');
  });
});

describe('compartir pantalla y archivos', () => {
  it('pantalla: sin llamada o sin video avisa; con video reemplaza la cámara y al volver la repone', async () => {
    const h = await conectado();
    expect(await h.result.current.shareScreen()).toEqual({ error: 'sin llamada' });
    await enLlamada(h);
    expect(await h.result.current.shareScreen()).toEqual({ error: 'la llamada no tiene video' });
    await act(async () => { await h.result.current.placeCall('201', true); });
    const s = sip.estado.inviters.at(-1);
    await act(async () => { s.cambiar('Established'); });
    const lv = { srcObject: null };
    h.result.current.localVideoRef.current = lv;
    let r;
    await act(async () => { r = await h.result.current.shareScreen(); });
    expect(r).toEqual({ ok: true });
    expect(h.result.current.sharing).toBe(true);
    const vSender = s.sessionDescriptionHandler.peerConnection.senders[1];
    expect(vSender.replaceTrack).toHaveBeenCalledTimes(1);
    const pantalla = vSender.replaceTrack.mock.calls[0][0];
    await act(async () => { await h.result.current.shareScreen(); });
    expect(h.result.current.sharing).toBe(false);
    expect(pantalla.stop).toHaveBeenCalled();
    expect(vSender.replaceTrack).toHaveBeenCalledTimes(2);
    expect(lv.srcObject.getTracks()[0].kind).toBe('video');
  });

  it('pantalla: cancelar el selector, o que el usuario corte desde el navegador', async () => {
    const h = await conectado();
    await act(async () => { await h.result.current.placeCall('201', true); });
    const s = sip.estado.inviters.at(-1);
    await act(async () => { s.cambiar('Established'); });
    medios.mediaDevices.getDisplayMedia.mockRejectedValueOnce(new Error('NotAllowed'));
    expect(await h.result.current.shareScreen()).toEqual({ error: 'cancelado' });
    await act(async () => { await h.result.current.shareScreen(); });
    const t = s.sessionDescriptionHandler.peerConnection.senders[1].replaceTrack.mock.calls[0][0];
    medios.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('sin cámara'));
    await act(async () => { await t.onended(); });
    expect(h.result.current.sharing).toBe(false);
  });

  it('dejar de compartir sin llamada, o con pistas que no se dejan parar', async () => {
    const h = await conectado();
    await act(async () => { await h.result.current.placeCall('201', true); });
    const s = sip.estado.inviters.at(-1);
    await act(async () => { s.cambiar('Established'); });
    medios.mediaDevices.getDisplayMedia.mockResolvedValueOnce({ getVideoTracks: () => [pista('video')], getTracks: () => { throw new Error('x'); } });
    await act(async () => { await h.result.current.shareScreen(); });
    s.sessionDescriptionHandler.peerConnection.senders[1].track = null;
    await act(async () => { try { await h.result.current.shareScreen(); } catch (_) { /* sin pista de video */ } });
    await act(async () => { s.cambiar('Terminated'); });
    expect(h.result.current.sharing).toBe(false);
  });

  it('archivo: lo reproduce, inyecta audio y video en la llamada y al terminar vuelve al micrófono', async () => {
    const h = await conectado();
    expect(await h.result.current.shareFile({ name: 'x' })).toEqual({ error: 'sin llamada' });
    await act(async () => { await h.result.current.placeCall('201', true); });
    const s = sip.estado.inviters.at(-1);
    await act(async () => { s.cambiar('Established'); });
    const lv = { srcObject: null };
    h.result.current.localVideoRef.current = lv;
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:1'), revokeObjectURL: vi.fn() });
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const MS = medios.MediaStream;
    window.HTMLMediaElement.prototype.captureStream = function () { return new MS([pista('audio'), pista('video')]); };
    let r;
    await act(async () => { r = await h.result.current.shareFile({ name: 'video.mp4', type: 'video/mp4' }); });
    expect(r).toEqual({ ok: true });
    expect(play).toHaveBeenCalled();
    expect(h.result.current.filePlaying).toEqual({ name: 'video.mp4', video: true });
    const [aS, vS] = s.sessionDescriptionHandler.peerConnection.senders;
    expect(aS.replaceTrack).toHaveBeenCalledTimes(1);
    expect(vS.replaceTrack).toHaveBeenCalledTimes(1);
    await act(async () => { await h.result.current.stopFile(); });
    expect(aS.replaceTrack).toHaveBeenCalledTimes(2);
    expect(vS.replaceTrack).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    expect(h.result.current.filePlaying).toBeNull();
    delete window.HTMLMediaElement.prototype.captureStream;
  });

  it('archivo: navegador sin captureStream avisa; mozCaptureStream sirve; errores de reemplazo no rompen', async () => {
    const h = await conectado();
    const s = await enLlamada(h);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:2'), revokeObjectURL: vi.fn(() => { throw new Error('x'); }) });
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => { throw new Error('autoplay'); });
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    let r;
    await act(async () => { r = await h.result.current.shareFile({ name: 'a.mp3' }); });
    expect(r).toEqual({ error: 'este navegador no permite compartir archivos' });
    const MS = medios.MediaStream;
    window.HTMLMediaElement.prototype.mozCaptureStream = function () { return new MS([pista('audio')]); };
    s.sessionDescriptionHandler.peerConnection.senders[0].replaceTrack.mockRejectedValue(new Error('x'));
    await act(async () => { r = await h.result.current.shareFile({ name: 'a.mp3', type: 'audio/mpeg' }); });
    expect(r).toEqual({ ok: true });
    medios.mediaDevices.getUserMedia.mockResolvedValueOnce(new MS([]));
    await act(async () => { await h.result.current.stopFile(); });
    expect(h.result.current.filePlaying).toBeNull();
    delete window.HTMLMediaElement.prototype.mozCaptureStream;
    await act(async () => { await h.result.current.stopFile(); });
  });

  it('archivo: cuando termina solo, vuelve al micrófono; colgar con un archivo sonando lo para', async () => {
    const h = await conectado();
    const s = await enLlamada(h);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:3'), revokeObjectURL: vi.fn() });
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const MS = medios.MediaStream;
    let el;
    window.HTMLMediaElement.prototype.captureStream = function () { el = this; return new MS([pista('audio')]); };
    await act(async () => { await h.result.current.shareFile({ name: 'b.mp3', type: 'audio/mpeg' }); });
    await act(async () => { await el.onended(); });
    expect(h.result.current.filePlaying).toBeNull();
    await act(async () => { await h.result.current.shareFile({ name: 'c.mp3', type: 'audio/mpeg' }); });
    pause.mockImplementation(() => { throw new Error('x'); });
    await act(async () => { s.cambiar('Terminated'); });
    expect(h.result.current.filePlaying).toBeNull();
    delete window.HTMLMediaElement.prototype.captureStream;
  });
});

describe('calidad y vigilante', () => {
  const statsDe = (o) => new Map(Object.entries(o).map(([id, v]) => [id, { id, ...v }]));

  it('calcula pérdida, RTT, jitter, códec y si el audio va por TURN', async () => {
    const h = await conectado();
    vi.useFakeTimers();
    const s = await enLlamada(h);
    const pc = s.sessionDescriptionHandler.peerConnection;
    pc.stats = statsDe({
      in: { type: 'inbound-rtp', kind: 'audio', packetsLost: 0, packetsReceived: 100, jitter: 0.012, codecId: 'c1' },
      c1: { type: 'codec', mimeType: 'audio/opus' },
      p1: { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.05, localCandidateId: 'l1', remoteCandidateId: 'r1' },
      l1: { type: 'local-candidate', candidateType: 'relay' }, r1: { type: 'remote-candidate', candidateType: 'host' },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(h.result.current.quality).toEqual({ score: 4, loss: 0, rtt: 50, jitter: 12, codec: 'opus', candType: 'relay' });
    expect(h.result.current.usingRelay).toBe(true);
    pc.stats = statsDe({
      in: { type: 'inbound-rtp', mediaType: 'audio', packetsLost: 10, packetsReceived: 190 },
      p1: { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'l1' },
      l1: { type: 'local-candidate', candidateType: 'host' },
      ri: { type: 'remote-inbound-rtp', roundTripTime: 0.2 },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(h.result.current.quality).toMatchObject({ score: 1, loss: 10, rtt: 200, jitter: null, codec: null, candType: 'host' });
    expect(h.result.current.usingRelay).toBe(false);
  });

  it('puntaje por umbrales de pérdida y RTT', async () => {
    const h = await conectado();
    vi.useFakeTimers();
    const s = await enLlamada(h);
    const pc = s.sessionDescriptionHandler.peerConnection;
    let rec = 0, lost = 0;
    const paso = async (dRecv, dLost, rtt) => {
      rec += dRecv; lost += dLost;
      pc.stats = statsDe({ in: { type: 'inbound-rtp', kind: 'audio', packetsLost: lost, packetsReceived: rec }, p: { type: 'candidate-pair', nominated: true, currentRoundTripTime: rtt } });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      return h.result.current.quality.score;
    };
    expect(await paso(100, 0, 0.6)).toBe(1);
    expect(await paso(100, 0, 0.35)).toBe(2);
    expect(await paso(96, 4, 0.01)).toBe(2);
    expect(await paso(100, 0, 0.2)).toBe(3);
    expect(await paso(98, 2, 0.01)).toBe(3);
    expect(await paso(100, 0, null)).toBe(4);
  });

  it('sin paquetes durante 4 muestras corta la llamada; en espera o en consulta no', async () => {
    const h = await conectado();
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await enLlamada(h);
    const pc = s.sessionDescriptionHandler.peerConnection;
    pc.stats = statsDe({ in: { type: 'inbound-rtp', kind: 'audio', packetsLost: 0, packetsReceived: 50 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { await h.result.current.toggleHold(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(s.bye).not.toHaveBeenCalled();
    await act(async () => { await h.result.current.toggleHold(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    pc.stats = statsDe({ in: { type: 'inbound-rtp', kind: 'audio', packetsLost: 0, packetsReceived: 60 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(s.bye).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(s.bye).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[softphone] llamada finalizada por', 'rtp-timeout');
  });

  it('ICE o la conexión caídos cortan la llamada una sola vez; stats que fallan no rompen', async () => {
    const h = await conectado();
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('consola'); });
    const s = await enLlamada(h);
    const pc = s.sessionDescriptionHandler.peerConnection;
    pc.getStats.mockRejectedValue(new Error('x'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    pc.iceConnectionState = 'checking'; pc.disparar('iceconnectionstatechange');
    pc.connectionState = 'connecting'; pc.disparar('connectionstatechange');
    expect(s.bye).not.toHaveBeenCalled();
    pc.connectionState = 'failed';
    await act(async () => { pc.disparar('connectionstatechange'); });
    pc.iceConnectionState = 'closed';
    await act(async () => { pc.disparar('iceconnectionstatechange'); });
    expect(s.bye).toHaveBeenCalledTimes(1);
  });

  it('stats con forma rara (sin par nominado, códec inexistente) y pc que no deja escuchar eventos', async () => {
    const h = await conectado();
    vi.useFakeTimers();
    await act(async () => { await h.result.current.placeCall('200'); });
    const s = sip.estado.inviters.at(-1);
    const pc = s.sessionDescriptionHandler.peerConnection;
    pc.addEventListener = () => { throw new Error('x'); };
    pc.removeEventListener = () => { throw new Error('x'); };
    await act(async () => { s.cambiar('Established'); });
    pc.stats = statsDe({ in: { type: 'inbound-rtp', kind: 'audio', codecId: 'nada' }, p: { type: 'candidate-pair', nominated: false, state: 'failed' }, v: { type: 'inbound-rtp', kind: 'video' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(h.result.current.quality).toMatchObject({ score: 4, codec: null, candType: null, rtt: null });
    expect(h.result.current.usingRelay).toBeNull();
    const m = new Map([['x', { id: 'x', type: 'candidate-pair', nominated: true, localCandidateId: 'l' }]]);
    Object.defineProperty(m, 'get', { value: () => { throw new Error('mapa roto'); } });
    pc.stats = m;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(h.result.current.quality.codec).toBeNull();
    await act(async () => { s.cambiar('Terminated'); });
    expect(h.result.current.quality).toBeNull();
  });

  it('una sesión establecida sin peerConnection no arma el medidor', async () => {
    const h = await conectado();
    await act(async () => { await h.result.current.placeCall('200'); });
    const s = sip.estado.inviters.at(-1);
    s.sessionDescriptionHandler.peerConnection.getReceivers = () => [];
    const pc = s.sessionDescriptionHandler.peerConnection;
    await act(async () => { s.cambiar('Established'); });
    s.sessionDescriptionHandler.peerConnection = null;
    await act(async () => { await h.result.current.toggleHold(); });
    expect(pc).toBeTruthy();
  });
});

describe('integración con el sistema', () => {
  it('Media Session: título con quien llama y controles de headset (colgar, espera, mute)', async () => {
    const handlers = {};
    navigator.mediaSession = { setActionHandler: vi.fn((a, f) => { handlers[a] = f; if (a === 'play' && f === null) throw new Error('no soportado'); }), playbackState: 'none', metadata: null };
    vi.stubGlobal('MediaMetadata', function (o) { Object.assign(this, o); });
    const h = await conectado();
    const s = await enLlamada(h);
    expect(navigator.mediaSession.metadata.title).toBe('200');
    expect(navigator.mediaSession.playbackState).toBe('playing');
    await act(async () => { await handlers.pause(); });
    expect(h.result.current.held).toBe(true);
    await act(async () => { await handlers.play(); });
    act(() => handlers.togglemicrophone());
    expect(h.result.current.muted).toBe(true);
    await act(async () => { await handlers.hangup(); });
    expect(s.bye).toHaveBeenCalled();
    await act(async () => { s.cambiar('Terminated'); });
    expect(navigator.mediaSession.playbackState).toBe('none');
    const inv = new SesionFalsa({ desde: '777' });
    act(() => sip.estado.agentes[0].delegate.onInvite(inv));
    expect(navigator.mediaSession.metadata.title).toBe('777');
    act(() => handlers.stop());
    expect(inv.reject).toHaveBeenCalled();
    const anon = new SesionFalsa(); anon.remoteIdentity = null;
    act(() => sip.estado.agentes[0].delegate.onInvite(anon));
    expect(navigator.mediaSession.metadata.title).toBe('Llamada');
    act(() => handlers.hangup());
    await act(async () => { await h.result.current.placeCall('9'); });
    await act(async () => { await handlers.stop(); });
    expect(sip.estado.inviters.at(-1).cancel).toHaveBeenCalled();
  });

  it('Media Session sin MediaMetadata ni playbackState escribible no rompe', async () => {
    navigator.mediaSession = { setActionHandler: vi.fn() };
    Object.defineProperty(navigator.mediaSession, 'playbackState', { set() { throw new Error('ro'); } });
    const h = await conectado();
    await enLlamada(h);
    expect(navigator.mediaSession.setActionHandler).toHaveBeenCalledWith('hangup', expect.any(Function));
  });

  it('Wake Lock: mantiene la pantalla prendida en llamada, la suelta al terminar y la re-pide al volver', async () => {
    let lock;
    navigator.wakeLock = { request: vi.fn(async () => { lock = { release: vi.fn(async () => {}), h: {}, addEventListener(ev, f) { this.h[ev] = f; } }; return lock; }) };
    const h = await conectado();
    const s = await enLlamada(h);
    expect(navigator.wakeLock.request).toHaveBeenCalledWith('screen');
    lock.h.release();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
    const segundo = lock;
    await act(async () => { s.cambiar('Terminated'); });
    expect(segundo.release).toHaveBeenCalled();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
    navigator.wakeLock.request.mockRejectedValue(new Error('denegado'));
    await act(async () => { await h.result.current.placeCall('5'); });
    lock = null;
    delete document.visibilityState;
  });

  it('Wake Lock que no se deja soltar, o sin addEventListener', async () => {
    navigator.wakeLock = { request: vi.fn(async () => ({ release: vi.fn(async () => { throw new Error('x'); }) })) };
    const h = await conectado();
    const s = await enLlamada(h);
    await act(async () => { s.cambiar('Terminated'); });
    expect(navigator.wakeLock.request).toHaveBeenCalled();
  });
});

describe('funciones sueltas', () => {
  it('playTone: dos frecuencias por tecla, nada para una tecla desconocida, y sobrevive sin audio', async () => {
    await cargar();
    mod.playTone('1');
    expect(medios.osciladores.map((o) => o.frequency.value)).toEqual([697, 1209]);
    mod.playTone('x');
    expect(medios.osciladores).toHaveLength(2);
    vi.resetModules();
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const m2 = await import('../app/useSoftphone.js');
    expect(() => m2.playTone('1')).not.toThrow();
  });

  it('timbre: fuerte con vibración (sólo después de un gesto) y repetición; stopRinging lo corta', async () => {
    vi.useFakeTimers();
    await cargar();
    navigator.vibrate = vi.fn();
    mod.startRinging(true);
    expect(navigator.vibrate).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(3000);
    expect(navigator.vibrate).toHaveBeenCalledWith([500, 300, 500]);
    const n = medios.osciladores.length;
    mod.startRinging(false);
    vi.advanceTimersByTime(3500);
    expect(medios.osciladores.length).toBe(n + 2);
    mod.stopRinging();
    expect(navigator.vibrate).toHaveBeenLastCalledWith(0);
    vi.advanceTimersByTime(10000);
    expect(medios.osciladores.length).toBe(n + 2);
    navigator.vibrate = vi.fn(() => { throw new Error('bloqueado'); });
    expect(() => { mod.startRinging(true); mod.stopRinging(); }).not.toThrow();
    vi.stubGlobal('AudioContext', undefined);
    vi.resetModules();
    const m2 = await import('../app/useSoftphone.js');
    expect(() => m2.startRinging(false)).not.toThrow();
    m2.stopRinging();
  });

  it('releaseMedia: para todo lo que encuentre y tolera sesiones a medio armar', async () => {
    await cargar();
    expect(() => mod.releaseMedia(null)).not.toThrow();
    expect(() => mod.releaseMedia({ sessionDescriptionHandler: {} })).not.toThrow();
    const t = pista();
    const malo = { stop: () => { throw new Error('x'); } };
    mod.releaseMedia({ sessionDescriptionHandler: {
      peerConnection: { getSenders: () => [{ track: t }, { track: malo }, {}], getReceivers: () => [{ track: malo }, {}] },
      localMediaStream: { getTracks: () => { throw new Error('x'); } },
      close: () => { throw new Error('x'); },
    } });
    expect(t.stop).toHaveBeenCalled();
    expect(() => mod.releaseMedia({ get sessionDescriptionHandler() { throw new Error('x'); } })).not.toThrow();
  });

  it('primeMedia: pide el permiso una sola vez; si lo niegan, lo vuelve a intentar la próxima', async () => {
    await cargar();
    medios.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('denegado'));
    await mod.primeMedia(false);
    await mod.primeMedia(true);
    await mod.primeMedia(true);
    expect(medios.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('historial corrupto en localStorage arranca vacío', async () => {
    const h = await montar();
    st.local.setItem('pbxng_softphone_hist', '{x');
    await act(async () => { await h.result.current.connect('101', 'c'); });
    const s = await enLlamada(h);
    st.local.setItem = () => { throw new Error('lleno'); };
    await act(async () => { s.cambiar('Terminated'); });
    expect(h.result.current.hist).toEqual([]);
  });
});
