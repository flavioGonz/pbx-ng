/* useSip (src/useSip.js): el hook WebRTC del softphone sobre SIP.js. Fija lo que el
 * operador vive en cada llamada: que registre y diga POR QUÉ no registra (401 => clave),
 * que reconecte solo si el WebSocket se cae (y no si él se desconectó), que una llamada
 * saliente/entrante quede en el historial con su duración, las dos líneas (espera +
 * activa), transferencias ciega y atendida, conferencia de 3, mute/espera/cámara/altavoz,
 * y el vigía que cuelga una llamada muerta (ICE caído o RTP cortado) en vez de dejarla
 * colgada en pantalla para siempre. sip.js se reemplaza por un falso (helpers). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import './helpers/logica-storage.js';
import { fake, resetFake, invitacion, SessionState, RegistererState, fakePC, fakeSdh, track } from './helpers/logica-sipfake.js';

vi.mock('sip.js', async () => await import('./helpers/logica-sipfake.js'));

let useSip, getDevPrefs, setDevPref, listDevices;

class FakeMS {
  constructor(t = []) { this.t = [...t]; }
  addTrack(x) { this.t.push(x); }
  getTracks() { return this.t; }
  getAudioTracks() { return this.t.filter((x) => x.kind === 'audio'); }
  getVideoTracks() { return this.t.filter((x) => x.kind === 'video'); }
}
function fakeAudioCtx() {
  return {
    state: 'suspended', currentTime: 0, destination: {},
    resume: vi.fn(async () => {}), close: vi.fn(),
    createGain: () => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() }),
    createOscillator: () => ({ frequency: {}, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createMediaStreamDestination: vi.fn(() => ({ stream: new FakeMS([track('audio')]) })),
  };
}
const audioEl = () => ({ srcObject: null, volume: 1, muted: true, play: vi.fn(() => Promise.resolve()), setSinkId: vi.fn(async () => {}) });

/* Un único AudioContext para todo el archivo: el módulo guarda el suyo (ring y DTMF) la
 * primera vez y no lo vuelve a crear. */
const actx = fakeAudioCtx();
actx.createOscillator = vi.fn(actx.createOscillator);
let gum, enumerate;
beforeEach(async () => {
  resetFake();
  localStorage.clear();
  vi.stubGlobal('MediaStream', FakeMS);
  gum = vi.fn(async () => new FakeMS([track('audio'), track('video')]));
  enumerate = vi.fn(async () => []);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum, enumerateDevices: enumerate } });
  Object.defineProperty(navigator, 'vibrate', { configurable: true, writable: true, value: vi.fn() });
  actx.createOscillator.mockClear(); actx.close.mockClear(); actx.state = 'suspended';
  window.AudioContext = vi.fn(() => actx);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ useSip, getDevPrefs, setDevPref, listDevices } = await import('../src/useSip.js'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const CFG = { wss: 'wss://pbx/ws', domain: 'pbx', ext: '101', pass: 'pw', name: 'Recepción', stun: 'pbx:3478' };

async function montarRegistrado(cfg = CFG) {
  const h = renderHook(() => useSip());
  h.result.current.audioRef.current = audioEl();
  h.result.current.remoteVideoRef.current = audioEl();
  h.result.current.localVideoRef.current = audioEl();
  await act(async () => { await h.result.current.connect(cfg); });
  act(() => fake.registerers[0].stateChange.emit(RegistererState.Registered));
  return h;
}
async function llamar(h, num = '102', video = false) {
  let r;
  await act(async () => { r = await h.result.current.placeCall(num, video); });
  return r;
}
const ultimo = () => fake.inviters[fake.inviters.length - 1];

describe('dispositivos', () => {
  it('guarda y borra las preferencias de micrófono, cámara y parlante', () => {
    setDevPref('mic', 'm1'); setDevPref('cam', 'c1'); setDevPref('spk', 's1');
    expect(getDevPrefs()).toEqual({ mic: 'm1', cam: 'c1', spk: 's1' });
    setDevPref('mic', '');
    expect(getDevPrefs().mic).toBe('');
  });

  it('listDevices pide permiso (y apaga el micrófono enseguida) y separa por tipo', async () => {
    const t = track('audio');
    gum.mockResolvedValueOnce(new FakeMS([t]));
    enumerate.mockResolvedValueOnce([{ kind: 'audioinput' }, { kind: 'videoinput' }, { kind: 'audiooutput' }]);
    const r = await listDevices();
    expect(r.permiso).toBe(true);
    expect(t.stop).toHaveBeenCalled();
    expect([r.mics.length, r.cams.length, r.speakers.length]).toEqual([1, 1, 1]);
  });

  it('sin permiso lo dice; sin pedir permiso consulta permissions', async () => {
    gum.mockRejectedValueOnce(new Error('denegado'));
    expect((await listDevices()).permiso).toBe(false);
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'granted' }) } });
    expect((await listDevices(false)).permiso).toBe(true);
    expect(gum).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => { throw new Error('x'); } } });
    expect((await listDevices(false)).permiso).toBe(true);
    enumerate.mockRejectedValueOnce(new Error('x'));
    expect(await listDevices(false)).toEqual({ mics: [], cams: [], speakers: [], permiso: true });
  });
});

describe('registro', () => {
  it('config incompleta dice qué falta', async () => {
    const { result } = renderHook(() => useSip());
    let r;
    await act(async () => { r = await result.current.connect({ wss: '', domain: '', ext: '' }); });
    expect(r.error).toBe('config incompleta: servidor WSS, dominio, interno');
    expect(result.current.reg).toBe('failed');
    expect(result.current.note).toBe('Falta: servidor WSS, dominio, interno');
    await act(async () => { r = await result.current.connect(null); });
    expect(result.current.note).toBe('Falta: config');
  });

  it('arma el UserAgent con las credenciales y el ICE, y sigue el estado del registro', async () => {
    const h = await montarRegistrado();
    const ua = fake.agents[0];
    expect(ua.opts.uri.s).toBe('sip:101@pbx');
    expect(ua.opts.displayName).toBe('Recepción');
    expect(ua.opts.authorizationUsername).toBe('101');
    expect(ua.opts.authorizationPassword).toBe('pw');
    expect(ua.opts.transportOptions.server).toBe('wss://pbx/ws');
    expect(ua.opts.sessionDescriptionHandlerFactoryOptions.peerConnectionConfiguration.iceServers).toEqual([{ urls: 'stun:pbx:3478' }]);
    expect(fake.registerers[0].opts.expires).toBe(120);
    expect(h.result.current.registered).toBe(true);
    act(() => fake.registerers[0].stateChange.emit(RegistererState.Unregistered));
    expect(h.result.current.reg).toBe('unregistered');
    act(() => fake.registerers[0].stateChange.emit(RegistererState.Initial));
    expect(h.result.current.reg).toBe('connecting');
  });

  it('sin nombre usa el interno como displayName', async () => {
    await montarRegistrado({ ...CFG, name: '' });
    expect(fake.agents[0].opts.displayName).toBe('101');
  });

  it('un rechazo 401 dice que se revise la clave; otros códigos sólo el motivo', async () => {
    const h = await montarRegistrado();
    const d = fake.registerers[0].regOpts.requestDelegate;
    act(() => d.onReject({ message: { statusCode: 401, reasonPhrase: 'Unauthorized' } }));
    expect(h.result.current.reg).toBe('failed');
    expect(h.result.current.note).toBe('Registro rechazado (401 Unauthorized) — revisá interno/contraseña');
    act(() => d.onReject({ message: { statusCode: 503 } }));
    expect(h.result.current.note).toBe('Registro rechazado (503)');
    act(() => d.onReject(null));
    expect(h.result.current.note).toBe('Registro rechazado');
    act(() => d.onAccept());
    expect(h.result.current.note).toBe('');
  });

  it('reconectar da de baja el agente anterior y sus avisos viejos se ignoran', async () => {
    const h = await montarRegistrado();
    const [ua1, r1] = [fake.agents[0], fake.registerers[0]];
    await act(async () => { await h.result.current.connect(CFG); });
    expect(r1.unregister).toHaveBeenCalled();
    expect(r1.dispose).toHaveBeenCalled();
    expect(ua1.stop).toHaveBeenCalled();
    expect(ua1.__dead).toBe(true);
    act(() => r1.stateChange.emit(RegistererState.Unregistered));
    expect(h.result.current.reg).toBe('connecting');   // el viejo no pisa
  });

  it('URI inválida o fallo al arrancar: failed con mensaje', async () => {
    const { result } = renderHook(() => useSip());
    fake.makeURIFalla = true;
    let r;
    await act(async () => { r = await result.current.connect(CFG); });
    expect(r.error).toMatch(/URI inválida/);
    expect(result.current.note).toBe('No se pudo conectar a wss://pbx/ws: URI inválida (revisá dominio/interno)');
    fake.makeURIFalla = false;
    fake.startFalla = 'crudo';
    await act(async () => { r = await result.current.connect(CFG); });
    expect(result.current.reg).toBe('failed');
    expect(result.current.note).toBe('No se pudo conectar a wss://pbx/ws: crudo');
  });

  it('el WebSocket caído reintenta a los 2,5 s; al reconectar vuelve a registrar', async () => {
    const h = await montarRegistrado();
    const ua = fake.agents[0];
    vi.useFakeTimers();
    act(() => ua.opts.delegate.onDisconnect(new Error('1006')));
    expect(h.result.current.reg).toBe('connecting');
    expect(h.result.current.note).toBe('WebSocket caído: 1006 — reintentando…');
    act(() => { vi.advanceTimersByTime(2500); });
    expect(ua.reconnect).toHaveBeenCalledTimes(1);
    act(() => ua.opts.delegate.onDisconnect('texto'));
    expect(h.result.current.note).toBe('WebSocket caído: texto — reintentando…');
    act(() => ua.opts.delegate.onDisconnect());     // cierre limpio: no reintenta
    act(() => { vi.advanceTimersByTime(5000); });
    expect(ua.reconnect).toHaveBeenCalledTimes(2);
    ua.opts.delegate.onConnect();
    expect(fake.registerers[0].register).toHaveBeenCalledTimes(2);
  });

  it('desconectarse a propósito no reintenta, y el reintento pendiente de un agente muerto no corre', async () => {
    const h = await montarRegistrado();
    const ua = fake.agents[0];
    vi.useFakeTimers();
    act(() => ua.opts.delegate.onDisconnect(new Error('x')));
    await act(async () => { await h.result.current.disconnect(); });
    expect(h.result.current.reg).toBe('idle');
    act(() => { vi.advanceTimersByTime(3000); });
    expect(ua.reconnect).not.toHaveBeenCalled();
    act(() => ua.opts.delegate.onDisconnect(new Error('x')));
    expect(h.result.current.reg).toBe('idle');
    ua.opts.delegate.onConnect();   // sin registerer: no hace nada
  });
});

describe('llamada saliente', () => {
  it('sin registro o con número vacío no llama', async () => {
    const { result } = renderHook(() => useSip());
    let r;
    await act(async () => { r = await result.current.placeCall('1'); });
    expect(r).toEqual({ error: 'no registrado' });
    const h = await montarRegistrado();
    expect(await llamar(h, '---')).toEqual({ error: 'número vacío' });
  });

  it('micrófono denegado avisa sin llamar', async () => {
    const h = await montarRegistrado();
    gum.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
    expect(await llamar(h)).toEqual({ error: 'Micrófono/cámara denegado' });
    gum.mockRejectedValueOnce(new Error('no hay'));
    expect(await llamar(h)).toEqual({ error: 'Sin micrófono/cámara: no hay' });
    expect(h.result.current.note).toBe('Sin micrófono/cámara: no hay');
    expect(fake.inviters).toHaveLength(0);
  });

  it('llama limpiando el número, timbra, atiende, y al cortar queda en el historial con duración', async () => {
    setDevPref('mic', 'mic1');
    const h = await montarRegistrado();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    expect(await llamar(h, '(099) 123-45')).toEqual({ ok: true });
    const inv = ultimo();
    expect(inv.target.s).toBe('sip:09912345@pbx');
    expect(inv.opts.sessionDescriptionHandlerOptions.constraints).toEqual({ audio: { deviceId: { ideal: 'mic1' } }, video: false });
    expect(h.result.current.callInfo).toMatchObject({ dir: 'out', number: '09912345', video: false });
    expect(h.result.current.note).toBe('Llamando…');
    const d = inv.invite.mock.calls[0][0].requestDelegate;
    d.onTrying();
    act(() => d.onProgress({ message: { statusCode: 180, reasonPhrase: 'Ringing' } }));
    expect(h.result.current.note).toBe('Timbrando…');
    act(() => inv.set(SessionState.Establishing));
    expect(h.result.current.call).toBe('Establishing');
    expect(h.result.current.inCall).toBe(true);
    act(() => d.onAccept({ message: { statusCode: 200 } }));
    act(() => inv.set(SessionState.Established));
    expect(h.result.current.call).toBe('Established');
    expect(h.result.current.callInfo.since).toBe(1_000_000);
    const audio = h.result.current.audioRef.current;
    expect(audio.srcObject.getTracks().map((t) => t.kind)).toEqual(['audio']);
    expect(audio.play).toHaveBeenCalled();
    expect(h.result.current.getRemoteStream()).toBe(audio.srcObject);
    expect(h.result.current.getRemoteAudioStream()).toBe(audio.srcObject);
    expect(h.result.current.getLocalStream().getTracks()).toEqual([]);
    const pc = inv.sessionDescriptionHandler.peerConnection;
    pc.oniceconnectionstatechange(); pc.onconnectionstatechange();
    vi.setSystemTime(1_042_000);
    act(() => inv.set(SessionState.Terminated));
    expect(h.result.current.call).toBeNull();
    expect(h.result.current.callInfo).toBeNull();
    expect(audio.srcObject).toBeNull();
    expect(pc.senders[0].track.stop).toHaveBeenCalled();
    expect(inv.sessionDescriptionHandler.close).toHaveBeenCalled();
    expect(h.result.current.hist[0]).toMatchObject({ dir: 'out', number: '09912345', dur: 42 });
    expect(JSON.parse(localStorage.getItem('sp_hist'))[0].number).toBe('09912345');
  });

  it('el rechazo de la otra punta se muestra con código y motivo', async () => {
    const h = await montarRegistrado();
    await llamar(h);
    const d = ultimo().invite.mock.calls[0][0].requestDelegate;
    act(() => d.onReject({ message: { statusCode: 486, reasonPhrase: 'Busy Here' } }));
    expect(h.result.current.note).toBe('Rechazada: 486 Busy Here');
    act(() => d.onReject({ message: { statusCode: 603 } }));
    expect(h.result.current.note).toBe('Rechazada: 603 ');
  });

  it('si el INVITE tira, avisa el error', async () => {
    const h = await montarRegistrado();
    // forzamos el fallo haciendo que la sesión falsa rechace el invite al construirse
    const origPush = fake.inviters.push.bind(fake.inviters);
    fake.inviters.push = (s) => { s.invite = vi.fn(async () => { throw new Error('488 no acceptable'); }); return origPush(s); };
    const r = await llamar(h);
    expect(r).toEqual({ error: '488 no acceptable' });
    expect(h.result.current.note).toBe('Error: 488 no acceptable');
  });

  it('el ringback (425 Hz, sin vibrar) suena mientras timbra y se apaga al atender', async () => {
    const h = await montarRegistrado();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await llamar(h);
    actx.createOscillator.mockClear();
    act(() => ultimo().set(SessionState.Establishing));
    expect(actx.createOscillator.mock.results.length).toBe(1);
    expect(actx.createOscillator.mock.results[0].value.frequency.value).toBe(425);
    act(() => { vi.advanceTimersByTime(3500); });
    expect(actx.createOscillator).toHaveBeenCalledTimes(2);
    expect(navigator.vibrate).not.toHaveBeenCalledWith([500, 300, 500]);
    act(() => ultimo().set(SessionState.Established));
    act(() => { vi.advanceTimersByTime(10000); });
    expect(actx.createOscillator).toHaveBeenCalledTimes(2);
  });
});

describe('preferencia de códec (para probar el transcoding del SBC)', () => {
  const SDP = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 9 0 101', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10', 'a=rtpmap:9 G722/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtcp-fb:111 transport-cc', 'a=rtpmap:101 telephone-event/8000', 'm=video 9 X 96'].join('\r\n');

  async function modificador(codec, force) {
    const h = await montarRegistrado({ ...CFG, codec, codecForce: force });
    await llamar(h);
    return ultimo().opts.sessionDescriptionHandlerOptions.modifiers[0];
  }

  it('auto, sin SDP o sin m=audio no toca nada', async () => {
    const m = await modificador('auto');
    const d = { sdp: SDP };
    expect(await m(d)).toBe(d);
    expect(d.sdp).toBe(SDP);
    expect(await m(null)).toBeNull();
    const m2 = await modificador('pcmu');
    expect((await m2({ sdp: 'v=0\r\nm=video 1 X 96' })).sdp).toBe('v=0\r\nm=video 1 X 96');
    expect((await m2({ sdp: SDP.replace('a=rtpmap:0 PCMU/8000', '') })).sdp).toBe(SDP.replace('a=rtpmap:0 PCMU/8000', ''));
  });

  it('preferir pone el códec primero y deja los demás', async () => {
    const m = await modificador('G722', false);
    const out = (await m({ sdp: SDP })).sdp.split('\r\n');
    expect(out[1]).toBe('m=audio 9 UDP/TLS/RTP/SAVPF 9 111 0 101');
    expect(out).toContain('a=rtpmap:111 opus/48000/2');
  });

  it('forzar deja sólo ese códec y el DTMF, y saca sus atributos', async () => {
    const m = await modificador('pcmu', true);
    const out = (await m({ sdp: SDP })).sdp.split('\r\n');
    expect(out[1]).toBe('m=audio 9 UDP/TLS/RTP/SAVPF 0 101');
    expect(out.some((l) => l.includes(':111'))).toBe(false);
    expect(out).toContain('a=rtpmap:101 telephone-event/8000');
    expect(out).toContain('m=video 9 X 96');
  });

  it('un SDP raro no rompe la llamada', async () => {
    const m = await modificador('pcmu', true);
    const d = { get sdp() { return { split: () => { throw new Error('x'); } }; } };
    expect(await m(d)).toBe(d);
  });
});

describe('llamada entrante', () => {
  it('suena, detecta video en el SDP y atender con el video ofrecido', async () => {
    const h = await montarRegistrado();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const inv = invitacion({ user: '300', sdp: 'm=audio 1 X 0\r\nm=video 2 X 96' });
    act(() => fake.agents[0].opts.delegate.onInvite(inv));
    expect(h.result.current.incoming).toBe(inv);
    expect(h.result.current.incomingVideo).toBe(true);
    expect(navigator.vibrate).toHaveBeenCalledWith([500, 300, 500]);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(navigator.vibrate.mock.calls.filter((c) => Array.isArray(c[0])).length).toBe(2);
    vi.useRealTimers();
    await act(async () => { await h.result.current.accept(); });
    expect(h.result.current.incoming).toBeNull();
    expect(inv.accept.mock.calls[0][0].sessionDescriptionHandlerOptions.constraints.video).toBe(true);
    expect(h.result.current.callInfo).toMatchObject({ dir: 'in', number: '300', video: true });
    expect(h.result.current.videoOn).toBe(true);
    expect(h.result.current.note).toBe('');
  });

  it('el SDP en body y sin identidad: atiende como desconocido y sin video si se pide', async () => {
    const h = await montarRegistrado();
    const inv = invitacion({ user: null, enRequest: false, sdp: 'm=video 1' });
    act(() => fake.agents[0].opts.delegate.onInvite(inv));
    expect(h.result.current.incomingVideo).toBe(true);
    gum.mockRejectedValueOnce(new Error('sin mic'));   // igual atiende
    await act(async () => { await h.result.current.accept(false); });
    expect(h.result.current.callInfo).toMatchObject({ number: 'desconocido', video: false });
  });

  it('un SDP no textual cuenta como sin video; un INVITE roto también', async () => {
    const h = await montarRegistrado();
    act(() => fake.agents[0].opts.delegate.onInvite(invitacion({ sdp: { raro: 1 } })));
    expect(h.result.current.incomingVideo).toBe(false);
    const roto = invitacion();
    Object.defineProperty(roto, 'request', { get() { throw new Error('x'); } });
    act(() => fake.agents[0].opts.delegate.onInvite(roto));
    expect(h.result.current.incomingVideo).toBe(false);
  });

  it('si la otra punta corta antes de atender, desaparece el aviso (sólo el suyo)', async () => {
    const h = await montarRegistrado();
    const a = invitacion(), b = invitacion();
    act(() => fake.agents[0].opts.delegate.onInvite(a));
    act(() => fake.agents[0].opts.delegate.onInvite(b));
    act(() => a.set(SessionState.Terminated));
    expect(h.result.current.incoming).toBe(b);
    act(() => b.set(SessionState.Established));
    act(() => b.set(SessionState.Terminated));
    expect(h.result.current.incoming).toBeNull();
  });

  it('error al atender se muestra', async () => {
    const h = await montarRegistrado();
    const inv = invitacion();
    inv.accept.mockRejectedValueOnce(new Error('sdp'));
    act(() => fake.agents[0].opts.delegate.onInvite(inv));
    await act(async () => { await h.result.current.accept(false); });
    expect(h.result.current.note).toBe('Error al atender: sdp');
  });

  it('rechazar la deja como perdida en el historial', async () => {
    const h = await montarRegistrado();
    const inv = invitacion({ user: '555' });
    act(() => fake.agents[0].opts.delegate.onInvite(inv));
    await act(async () => { await h.result.current.reject(); });
    expect(inv.reject).toHaveBeenCalled();
    expect(h.result.current.incoming).toBeNull();
    expect(h.result.current.hist[0]).toMatchObject({ dir: 'in', number: '555', missed: true });
    const inv2 = invitacion({ user: null });
    inv2.reject.mockRejectedValueOnce(new Error('x'));
    act(() => fake.agents[0].opts.delegate.onInvite(inv2));
    await act(async () => { await h.result.current.reject(); });
    expect(h.result.current.hist[0].number).toBe('?');
  });

  it('accept/reject sin entrante no hacen nada', async () => {
    const h = await montarRegistrado();
    await act(async () => { await h.result.current.accept(); await h.result.current.reject(); });
    expect(h.result.current.callInfo).toBeNull();
  });
});

describe('dos líneas, conferencia y transferencias', () => {
  async function dosLineas() {
    const h = await montarRegistrado();
    await llamar(h, '201');
    const a = ultimo();
    act(() => a.set(SessionState.Established));
    await llamar(h, '202');
    const b = ultimo();
    act(() => b.set(SessionState.Established));
    return { h, a, b };
  }

  it('llamar con una activa la pone en espera; una tercera no entra', async () => {
    const { h, a, b } = await dosLineas();
    expect(a.sessionDescriptionHandlerOptionsReInvite).toEqual({ hold: true });
    expect(a.invite).toHaveBeenCalledTimes(2);
    expect(a.sessionDescriptionHandler.peerConnection.senders[0].track.enabled).toBe(false);
    expect(h.result.current.heldInfo).toMatchObject({ number: '201' });
    expect(h.result.current.callInfo.number).toBe('202');
    expect(await llamar(h, '203')).toEqual({ error: 'ya hay 2 líneas activas' });
    // una entrante con dos líneas se rechaza al atender
    const inv = invitacion();
    act(() => fake.agents[0].opts.delegate.onInvite(inv));
    await act(async () => { await h.result.current.accept(false); });
    expect(inv.reject).toHaveBeenCalled();
    inv.reject.mockRejectedValueOnce(new Error('x'));
    act(() => fake.agents[0].opts.delegate.onInvite(inv));
    await act(async () => { await h.result.current.accept(false); });
    expect(b.state).toBe('Established');
  });

  it('cambiar de línea intercambia activa y en espera', async () => {
    const { h, a, b } = await dosLineas();
    await act(async () => { await h.result.current.switchLine(); });
    expect(h.result.current.callInfo.number).toBe('201');
    expect(h.result.current.heldInfo.number).toBe('202');
    expect(b.sessionDescriptionHandlerOptionsReInvite).toEqual({ hold: true });
    expect(a.sessionDescriptionHandlerOptionsReInvite).toEqual({ hold: false });
    expect(h.result.current.call).toBe('Established');
  });

  it('si corta la activa, vuelve sola la que estaba en espera; si corta la de espera, se borra', async () => {
    const { h, a, b } = await dosLineas();
    await act(async () => { b.set(SessionState.Terminated); await Promise.resolve(); });
    expect(h.result.current.heldInfo).toBeNull();
    expect(h.result.current.callInfo.number).toBe('201');
    expect(a.sessionDescriptionHandlerOptionsReInvite).toEqual({ hold: false });
    // de nuevo dos líneas, y ahora corta la de espera
    await llamar(h, '204');
    act(() => ultimo().set(SessionState.Established));
    act(() => a.set(SessionState.Terminated));
    expect(h.result.current.heldInfo).toBeNull();
    expect(h.result.current.callInfo.number).toBe('204');
    // cambios de estado de una sesión que no es la activa no pisan el estado
    act(() => a.set(SessionState.Established));
    expect(h.result.current.callInfo.number).toBe('204');
  });

  it('switchLine sin línea en espera no hace nada; con la activa ya cortada sólo retoma', async () => {
    const h = await montarRegistrado();
    await act(async () => { await h.result.current.switchLine(); });
    const { h: h2, b } = await dosLineas();
    await act(async () => { await h2.result.current.hangup(); });
    expect(b.bye).toHaveBeenCalled();
  });

  it('conferencia de tres mezcla los audios y une los números', async () => {
    setDevPref('mic', 'm9');
    const { h, a, b } = await dosLineas();
    await act(async () => { await h.result.current.conference(); });
    expect(h.result.current.conf).toBe(true);
    expect(h.result.current.heldInfo).toBeNull();
    expect(h.result.current.callInfo.number).toBe('202 + 201');
    expect(a.sessionDescriptionHandler.peerConnection.senders[0].replaceTrack).toHaveBeenCalled();
    expect(b.sessionDescriptionHandler.peerConnection.senders[0].replaceTrack).toHaveBeenCalled();
    expect(gum).toHaveBeenLastCalledWith({ audio: { deviceId: { ideal: 'm9' } } });
    // una segunda vez no hace nada
    await act(async () => { await h.result.current.conference(); });
    // al cortar se cierra la mezcla
    act(() => b.set(SessionState.Terminated));
    expect(h.result.current.conf).toBe(false);
    expect(actx.close).toHaveBeenCalled();
  });

  it('conferencia sin dos líneas no hace nada; si falla el micrófono lo registra', async () => {
    const h = await montarRegistrado();
    await act(async () => { await h.result.current.conference(); });
    expect(h.result.current.conf).toBe(false);
    const { h: h2, a, b } = await dosLineas();
    a.sessionDescriptionHandler.peerConnection.senders.length = 0;
    b.sessionDescriptionHandler.peerConnection.senders.length = 0;
    actx.state = 'running';
    await act(async () => { await h2.result.current.conference(); });
    expect(h2.result.current.conf).toBe(true);
    const { h: h3 } = await dosLineas();
    gum.mockRejectedValueOnce(new Error('mic'));
    await act(async () => { await h3.result.current.conference(); });
    expect(h3.result.current.conf).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it('transferencia ciega con REFER', async () => {
    const h = await montarRegistrado();
    let r;
    await act(async () => { r = await h.result.current.transfer('300'); });
    expect(r).toBe(false);
    await llamar(h);
    await act(async () => { r = await h.result.current.transfer(' 300 '); });
    expect(r).toBe(true);
    expect(ultimo().refer.mock.calls[0][0].s).toBe('sip:300@pbx');
    await act(async () => { r = await h.result.current.transfer(''); });
    expect(r).toBe(false);
    ultimo().refer.mockRejectedValueOnce(new Error('x'));
    await act(async () => { r = await h.result.current.transfer('1'); });
    expect(r).toBe(false);
  });

  it('transferencia atendida: consulta, habla, completa o cancela', async () => {
    const h = await montarRegistrado();
    let r;
    await act(async () => { r = await h.result.current.attendedCall('400'); });
    expect(r).toBe(false);
    await llamar(h);
    const principal = ultimo();
    act(() => principal.set(SessionState.Established));
    await act(async () => { r = await h.result.current.attendedCall('400'); });
    expect(r).toBe(true);
    expect(h.result.current.held).toBe(true);
    const consulta = ultimo();
    expect(consulta.target.s).toBe('sip:400@pbx');
    expect(h.result.current.attended).toEqual({ number: '400', state: 'calling' });
    act(() => consulta.set(SessionState.Establishing));
    expect(h.result.current.attended.state).toBe('establishing');
    act(() => consulta.set(SessionState.Established));
    expect(h.result.current.attended.state).toBe('talking');
    await act(async () => { await h.result.current.completeAttended(); });
    expect(principal.refer).toHaveBeenCalledWith(consulta);
    // cancelar con la consulta hablando: BYE y retoma la principal
    await act(async () => { await h.result.current.cancelAttended(); });
    expect(consulta.bye).toHaveBeenCalled();
    expect(h.result.current.attended).toBeNull();
    expect(h.result.current.held).toBe(false);
    // otra consulta que todavía no atendió: CANCEL; y si termina sola se limpia
    await act(async () => { await h.result.current.attendedCall('401'); });
    await act(async () => { await h.result.current.cancelAttended(); });
    expect(ultimo().cancel).toHaveBeenCalled();
    await act(async () => { await h.result.current.attendedCall('402'); });
    act(() => ultimo().set(SessionState.Terminated));
    expect(h.result.current.attended).toBeNull();
    await act(async () => { await h.result.current.completeAttended(); });
  });

  it('atendida: si el INVITE de consulta falla, limpia; cancelar sin nada no rompe', async () => {
    const h = await montarRegistrado();
    await act(async () => { await h.result.current.cancelAttended(); });
    await llamar(h);
    ultimo().invite.mockRejectedValueOnce(new Error('hold'));
    const origPush = fake.inviters.push.bind(fake.inviters);
    fake.inviters.push = (s) => { s.invite = vi.fn(async () => { throw new Error('x'); }); return origPush(s); };
    let r;
    await act(async () => { r = await h.result.current.attendedCall('500'); });
    expect(r).toBe(false);
    expect(h.result.current.attended).toBeNull();
  });
});

describe('controles en llamada', () => {
  async function enLlamada(video = false) {
    const h = await montarRegistrado();
    await llamar(h, '102', video);
    const s = ultimo();
    act(() => s.set(SessionState.Established));
    return { h, s, pc: s.sessionDescriptionHandler.peerConnection };
  }

  it('colgar según el estado: CANCEL antes de atender, BYE después, dispose si ya terminaba', async () => {
    const h = await montarRegistrado();
    await act(async () => { await h.result.current.hangup(); });   // sin sesión: sólo limpia
    await llamar(h);
    await act(async () => { await h.result.current.hangup(); });
    expect(fake.inviters[0].cancel).toHaveBeenCalled();
    expect(h.result.current.callInfo).toBeNull();
    await llamar(h);
    const s2 = ultimo(); s2.cancel = undefined; s2.reject = vi.fn(() => Promise.reject(new Error('x')));
    await act(async () => { await h.result.current.hangup(); });
    expect(s2.reject).toHaveBeenCalled();
    await llamar(h);
    const s3 = ultimo(); s3.state = SessionState.Terminating; s3.dispose.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.hangup(); });
    expect(s3.dispose).toHaveBeenCalled();
    await llamar(h);
    const s4 = ultimo(); s4.state = SessionState.Terminating; s4.dispose = undefined;
    await act(async () => { await h.result.current.hangup(); });
    await llamar(h);
    const s5 = ultimo(); s5.state = SessionState.Established; s5.bye.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.hangup(); });
    expect(s5.bye).toHaveBeenCalled();
    expect(h.result.current.call).toBeNull();
  });

  it('mute deshabilita el audio que sale', async () => {
    const { h, pc } = await enLlamada();
    act(() => h.result.current.toggleMute());
    expect(h.result.current.muted).toBe(true);
    expect(pc.senders[0].track.enabled).toBe(false);
    act(() => h.result.current.toggleMute());
    expect(pc.senders[0].track.enabled).toBe(true);
  });

  it('mute/espera/cámara sin llamada o sin peerConnection no hacen nada', async () => {
    const { h, s } = await enLlamada();
    s.sessionDescriptionHandler = { peerConnection: null };
    act(() => h.result.current.toggleMute());
    await act(async () => { await h.result.current.toggleVideo(); });
    s.sessionDescriptionHandler = null;
    act(() => h.result.current.toggleMute());
    await act(async () => { await h.result.current.toggleVideo(); });
    expect(h.result.current.muted).toBe(false);
    const h2 = renderHook(() => useSip());
    act(() => h2.result.current.toggleMute());
    await act(async () => { await h2.result.current.toggleHold(); await h2.result.current.toggleVideo(); });
    expect(h2.result.current.held).toBe(false);
  });

  it('espera manda re-INVITE con hold y sólo cambia si la central aceptó', async () => {
    const { h, s, pc } = await enLlamada();
    await act(async () => { await h.result.current.toggleHold(); });
    expect(s.sessionDescriptionHandlerOptionsReInvite).toEqual({ hold: true });
    expect(h.result.current.held).toBe(true);
    expect(pc.senders[0].track.enabled).toBe(false);
    s.invite.mockRejectedValueOnce(new Error('491'));
    await act(async () => { await h.result.current.toggleHold(); });
    expect(h.result.current.held).toBe(true);
  });

  it('cámara: prende reemplazando o agregando pista y apaga soltando la cámara', async () => {
    setDevPref('cam', 'cam7');
    const { h, s, pc } = await enLlamada();
    await act(async () => { await h.result.current.toggleVideo(); });
    expect(gum).toHaveBeenLastCalledWith({ audio: true, video: { deviceId: { ideal: 'cam7' } } });
    expect(pc.addTrack).toHaveBeenCalled();
    expect(h.result.current.videoOn).toBe(true);
    expect(h.result.current.callInfo.video).toBe(true);
    expect(h.result.current.localVideoRef.current.srcObject.getTracks()[0].kind).toBe('video');
    const vs = pc.senders.find((x) => x.track && x.track.kind === 'video');
    vs.replaceTrack = vi.fn(async function (t) { this.track = t; });
    const vt = vs.track;
    s.invite.mockRejectedValueOnce(new Error('re-invite')); // igual cambia
    await act(async () => { await h.result.current.toggleVideo(); });
    expect(vt.stop).toHaveBeenCalled();
    expect(h.result.current.videoOn).toBe(false);
    expect(h.result.current.localVideoRef.current.srcObject).toBeNull();
    await act(async () => { await h.result.current.toggleVideo(); });
    expect(pc.addTrack).toHaveBeenCalledTimes(2);   // el sender quedó sin pista: se agrega otra
    gum.mockRejectedValueOnce(new Error('sin cámara'));
    h.result.current.localVideoRef.current = null;
    await act(async () => { await h.result.current.toggleVideo(); });   // apagar sin elemento
    gum.mockRejectedValueOnce(new Error('sin cámara'));
    await act(async () => { await h.result.current.toggleVideo(); });
    expect(h.result.current.videoOn).toBe(false);
  });

  it('si ya hay un sender de video, prender la cámara reemplaza su pista', async () => {
    const h = await montarRegistrado();
    await llamar(h);
    const s = ultimo();
    s.sessionDescriptionHandler = fakeSdh(fakePC({ video: true }));
    act(() => s.set(SessionState.Established));
    const pc = s.sessionDescriptionHandler.peerConnection;
    await act(async () => { await h.result.current.toggleVideo(); });
    expect(pc.senders[1].replaceTrack).toHaveBeenCalled();
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it('una llamada con video muestra la cámara local', async () => {
    const h = await montarRegistrado();
    await llamar(h, '9', true);
    const s = ultimo();
    s.sessionDescriptionHandler = fakeSdh(fakePC({ video: true }));
    act(() => s.set(SessionState.Established));
    expect(h.result.current.getLocalStream().getTracks()[0].kind).toBe('video');
    expect(h.result.current.remoteVideoRef.current.srcObject).toBe(h.result.current.getRemoteStream());
  });

  it('DTMF: suena local siempre, y por la llamada sólo si está establecida', async () => {
    const h = await montarRegistrado();
    act(() => h.result.current.sendDtmf('5'));
    act(() => h.result.current.sendDtmf('x'));    // tecla sin tono
    await llamar(h);
    const s = ultimo();
    act(() => h.result.current.sendDtmf(1));
    expect(s.sessionDescriptionHandler.sendDtmf).not.toHaveBeenCalled();
    act(() => s.set(SessionState.Established));
    act(() => h.result.current.sendDtmf(1));
    expect(s.sessionDescriptionHandler.sendDtmf).toHaveBeenCalledWith('1');
    s.sessionDescriptionHandler.sendDtmf.mockImplementation(() => { throw new Error('x'); });
    expect(() => act(() => h.result.current.sendDtmf('#'))).not.toThrow();
  });

  it('volumen: se acota a 0..1, se guarda y se aplica al audio', async () => {
    localStorage.setItem('sp_volume', '0.4');
    const h = await montarRegistrado();
    expect(h.result.current.volume).toBe(0.4);
    act(() => h.result.current.setVolume(3));
    expect(h.result.current.volume).toBe(1);
    act(() => h.result.current.setVolume(-1));
    expect(h.result.current.audioRef.current.volume).toBe(0);
    expect(localStorage.getItem('sp_volume')).toBe('0');
    h.result.current.audioRef.current = null;
    act(() => h.result.current.setVolume(0.5));
  });

  it('historial: carga lo guardado, tolera basura y se borra', async () => {
    localStorage.setItem('sp_hist', '[{"number":"1"}]');
    const { result } = renderHook(() => useSip());
    expect(result.current.hist).toEqual([{ number: '1' }]);
    act(() => result.current.clearHist());
    expect(result.current.hist).toEqual([]);
    localStorage.setItem('sp_hist', '{x');
    expect(renderHook(() => useSip()).result.current.hist).toEqual([]);
  });
});

describe('altavoz', () => {
  const outs = [
    { kind: 'audiooutput', deviceId: 'default', label: 'Default' },
    { kind: 'audiooutput', deviceId: 'communications', label: 'Communications' },
    { kind: 'audiooutput', deviceId: 'hp', label: 'Headphones' },
    { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
  ];

  it('prender busca el parlante por nombre; apagar vuelve al auricular', async () => {
    enumerate.mockResolvedValue([...outs, { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers (Realtek)' }]);
    const h = await montarRegistrado();
    const el = h.result.current.audioRef.current;
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('spk');
    expect(el.muted).toBe(false);
    expect(h.result.current.speaker).toBe(true);
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('communications');
    expect(h.result.current.speaker).toBe(false);
  });

  it('sin parlante con nombre usa el primero que no sea el default; sin auricular, default', async () => {
    enumerate.mockResolvedValue([{ kind: 'audiooutput', deviceId: 'default', label: '' }, { kind: 'audiooutput', deviceId: 'hp', label: '' }]);
    const h = await montarRegistrado();
    const el = h.result.current.audioRef.current;
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('hp');
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('default');
    enumerate.mockResolvedValue([{ kind: 'audiooutput', deviceId: 'default' }]);
    el.setSinkId.mockClear();
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).not.toHaveBeenCalled();
  });

  it('respeta el parlante elegido en Ajustes; sin setSinkId sólo cambia el estado', async () => {
    setDevPref('spk', 'elegido');
    const h = await montarRegistrado();
    const el = h.result.current.audioRef.current;
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenCalledWith('elegido');
    await act(async () => { await h.result.current.applySpeaker('otro'); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('otro');
    await act(async () => { await h.result.current.applySpeaker(''); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('default');
    el.setSinkId.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.applySpeaker('x'); });
    h.result.current.audioRef.current = { muted: true, play: () => Promise.reject(new Error('x')) };
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(h.result.current.speaker).toBe(false);
    h.result.current.audioRef.current = null;
    await act(async () => { await h.result.current.toggleSpeaker(); await h.result.current.applySpeaker('x'); });
    expect(h.result.current.speaker).toBe(true);
    enumerate.mockRejectedValueOnce(new Error('x'));
    h.result.current.audioRef.current = audioEl();
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(h.result.current.speaker).toBe(false);
  });
});

describe('vigía de calidad', () => {
  function stats(entries) { const m = new Map(entries.map((e) => [e.id, e])); return m; }

  async function establecida() {
    const h = await montarRegistrado();
    await llamar(h);
    const s = ultimo();
    const pc = s.sessionDescriptionHandler.peerConnection;
    vi.useFakeTimers();
    act(() => s.set(SessionState.Established));
    return { h, s, pc };
  }
  const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); };

  it('calcula la nota con pérdida, RTT y jitter, el códec y si va por relay', async () => {
    const { h, pc } = await establecida();
    pc.statsQueue = [
      stats([
        { id: 'in', type: 'inbound-rtp', kind: 'audio', packetsLost: 0, packetsReceived: 100, jitter: 0.012, codecId: 'c1' },
        { id: 'c1', mimeType: 'audio/opus' },
        { id: 'cp', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.05, localCandidateId: 'lc' },
        { id: 'lc', candidateType: 'relay' },
      ]),
      stats([
        { id: 'in', type: 'inbound-rtp', mediaType: 'audio', packetsLost: 10, packetsReceived: 190 },
        { id: 'r', type: 'remote-inbound-rtp', roundTripTime: 0.2 },
      ]),
      stats([{ id: 'in', type: 'inbound-rtp', kind: 'audio', packetsLost: 12, packetsReceived: 290 }, { id: 'cp', type: 'candidate-pair', selected: true, currentRoundTripTime: 0.35, nominated: true, localCandidateId: 'nada' }]),
      stats([{ id: 'in', type: 'inbound-rtp', kind: 'audio', packetsLost: 13, packetsReceived: 390 }, { id: 'cp', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.6 }]),
      stats([{ id: 'in', type: 'inbound-rtp', kind: 'audio', packetsLost: 13, packetsReceived: 490 }, { id: 'cp', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.2 }]),
    ];
    await tick();
    expect(h.result.current.quality).toEqual({ score: 4, loss: 0, rtt: 50, jitter: 12, codec: 'opus', candType: 'relay' });
    expect(h.result.current.usingRelay).toBe(true);
    await tick();
    expect(h.result.current.quality).toMatchObject({ score: 1, loss: 10, rtt: 200, jitter: null, codec: null });
    await tick();
    expect(h.result.current.quality.score).toBe(2);    // 2 % de pérdida + 350 ms
    await tick();
    expect(h.result.current.quality.score).toBe(1);    // 600 ms
    await tick();
    expect(h.result.current.quality.score).toBe(3);    // 200 ms
  });

  it('pérdida moderada baja la nota a 2 y a 3', async () => {
    const { h, pc } = await establecida();
    pc.statsQueue = [
      stats([{ id: 'in', type: 'inbound-rtp', kind: 'audio', packetsLost: 0, packetsReceived: 100 }]),
      stats([{ id: 'in', type: 'inbound-rtp', kind: 'audio', packetsLost: 5, packetsReceived: 200 }]),
      stats([{ id: 'in', type: 'inbound-rtp', kind: 'audio', packetsLost: 7, packetsReceived: 300 }]),
    ];
    await tick(); await tick();
    expect(h.result.current.quality.score).toBe(2);
    await tick();
    expect(h.result.current.quality.score).toBe(3);
  });

  it('RTP cortado 4 veces seguidas cuelga la llamada; en espera no', async () => {
    const { h, s, pc } = await establecida();
    pc.statsQueue = [stats([{ id: 'in', type: 'inbound-rtp', kind: 'audio', packetsReceived: 10 }])];
    await tick();
    await act(async () => { await h.result.current.toggleHold(); });
    await tick(); await tick(); await tick(); await tick();
    expect(s.bye).not.toHaveBeenCalled();
    await act(async () => { await h.result.current.toggleHold(); });
    pc.statsQueue = [stats([{ id: 'in', type: 'inbound-rtp', kind: 'audio', packetsReceived: 20 }]), stats([{ id: 'in', type: 'inbound-rtp', kind: 'audio', packetsReceived: 20 }])];
    await tick();
    await tick(); await tick(); await tick(); await tick();
    expect(s.bye).toHaveBeenCalledTimes(1);
  });

  it('ICE fallido o conexión cerrada cuelga una sola vez', async () => {
    const { s, pc } = await establecida();
    pc.handlers.connectionstatechange();
    pc.iceConnectionState = 'failed';
    await act(async () => { pc.handlers.iceconnectionstatechange(); });
    pc.connectionState = 'closed';
    await act(async () => { pc.handlers.connectionstatechange && pc.handlers.connectionstatechange(); });
    expect(s.bye).toHaveBeenCalledTimes(1);
  });

  it('el ICE "closed" también cuelga; getStats que explota no rompe', async () => {
    const { s, pc } = await establecida();
    pc.getStats.mockRejectedValueOnce(new Error('x'));
    await tick();
    pc.statsQueue = [{ forEach: (f) => f({ type: 'inbound-rtp', kind: 'audio', codecId: 'c' }), get: () => { throw new Error('x'); } }];
    await tick();
    pc.iceConnectionState = 'closed';
    await act(async () => { pc.handlers.iceconnectionstatechange(); });
    expect(s.bye).toHaveBeenCalled();
  });

  it('una sesión establecida sin peerConnection no arranca el vigía', async () => {
    const h = await montarRegistrado();
    await llamar(h);
    const s = ultimo();
    s.sessionDescriptionHandler = { peerConnection: null };
    act(() => s.set(SessionState.Established));
    expect(h.result.current.quality).toBeNull();
    s.sessionDescriptionHandler = null;
    act(() => s.set(SessionState.Established));
    expect(h.result.current.call).toBe('Established');
  });
});

/* Bordes: lo que en la vida real falla de costado (almacenamiento bloqueado, consola que
 * explota, vibrador que tira, sesiones a medio armar). Ninguno puede dejar una llamada
 * trabada en pantalla o tirar abajo el hook. */
describe('robustez ante fallas de costado', () => {
  it('con localStorage bloqueado: preferencias vacías, sin historial guardado, pero todo anda', async () => {
    const orig = globalThis.localStorage;
    const roto = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    Object.defineProperty(globalThis, 'localStorage', { value: roto, configurable: true, writable: true });
    try {
      expect(getDevPrefs()).toEqual({ mic: '', cam: '', spk: '' });
      expect(() => { setDevPref('cam', 'x'); setDevPref('spk', ''); }).not.toThrow();
      const h = await montarRegistrado();
      expect(h.result.current.hist).toEqual([]);
      expect(h.result.current.volume).toBe(1);
      act(() => h.result.current.setVolume(0.3));
      expect(h.result.current.volume).toBe(0.3);
      const inv = invitacion();
      act(() => fake.agents[0].opts.delegate.onInvite(inv));
      await act(async () => { await h.result.current.reject(); });
      expect(h.result.current.hist[0].missed).toBe(true);   // en memoria igual
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true, writable: true });
    }
  });

  it('aunque la consola y el vibrador exploten, la llamada sigue su curso', async () => {
    for (const m of ['log', 'warn', 'error']) console[m].mockImplementation(() => { throw new Error('consola'); });
    navigator.vibrate.mockImplementation(() => { throw new Error('vibra'); });
    const h = await montarRegistrado({ ...CFG, codec: 'pcmu', codecForce: true });
    await llamar(h);
    const s = ultimo();
    const d = s.invite.mock.calls[0][0].requestDelegate;
    act(() => { d.onTrying(); d.onProgress({ message: { statusCode: 183 } }); d.onAccept({ message: {} }); d.onReject({ message: { statusCode: 480 } }); });
    expect(h.result.current.note).toBe('Rechazada: 480 ');
    const m = s.opts.sessionDescriptionHandlerOptions.modifiers[0];
    const raro = { get sdp() { return { split: () => { throw new Error('x'); } }; } };
    expect(await m(raro)).toBe(raro);
    act(() => s.set(SessionState.Established));
    const pc = s.sessionDescriptionHandler.peerConnection;
    pc.oniceconnectionstatechange(); pc.onconnectionstatechange();
    s.bye.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.hangup(); });
    expect(h.result.current.call).toBeNull();
    // entrante con vibrador roto, atender con error y conferencia fallida
    const inv = invitacion();
    act(() => fake.agents[0].opts.delegate.onInvite(inv));
    gum.mockRejectedValueOnce(new Error('mic'));
    inv.accept.mockRejectedValueOnce(new Error('sdp'));
    await act(async () => { await h.result.current.accept(false); });
    expect(h.result.current.note).toBe('Error al atender: sdp');
    gum.mockRejectedValueOnce(new Error('mic'));
    expect(await llamar(h, '5')).toEqual({ error: 'Sin micrófono/cámara: mic' });
    const fallaInvite = fake.inviters.push.bind(fake.inviters);
    fake.inviters.push = (x) => { x.invite = vi.fn(async () => { throw new Error('t'); }); return fallaInvite(x); };
    expect(await llamar(h, '6')).toEqual({ error: 't' });
  });

  it('sin AudioContext estándar usa webkitAudioContext; si el constructor falla, no hay tono pero sí DTMF', async () => {
    vi.resetModules();
    delete window.AudioContext;
    window.webkitAudioContext = vi.fn(() => ({ ...actx, state: 'running' }));
    const mod = await import('../src/useSip.js');
    const h = renderHook(() => mod.useSip());
    act(() => h.result.current.sendDtmf('1'));
    expect(window.webkitAudioContext).toHaveBeenCalled();
    vi.resetModules();
    window.webkitAudioContext = vi.fn(() => { throw new Error('sin audio'); });
    const mod2 = await import('../src/useSip.js');
    const h2 = renderHook(() => mod2.useSip());
    expect(() => act(() => h2.result.current.sendDtmf('1'))).not.toThrow();
    await act(async () => { await h2.result.current.connect(CFG); });
    act(() => fake.agents[fake.agents.length - 1].opts.delegate.onInvite(invitacion()));   // ring sin audio: no rompe
    delete window.webkitAudioContext;
  });

  it('soltar la media de una sesión rota no rompe (pistas que tiran, sin SDH)', async () => {
    const h = await montarRegistrado();
    await llamar(h);
    const s = ultimo();
    act(() => s.set(SessionState.Established));
    s.sessionDescriptionHandler.peerConnection.senders[0].track.stop.mockImplementation(() => { throw new Error('x'); });
    s.sessionDescriptionHandler.peerConnection.receivers[0].track.stop.mockImplementation(() => { throw new Error('x'); });
    s.sessionDescriptionHandler.localMediaStream = { getTracks: () => { throw new Error('x'); } };
    s.sessionDescriptionHandler.close = () => { throw new Error('x'); };
    act(() => s.set(SessionState.Terminated));
    expect(h.result.current.call).toBeNull();
    await llamar(h);
    const s2 = ultimo();
    s2.sessionDescriptionHandler = null;
    act(() => s2.set(SessionState.Terminated));
    await llamar(h);
    const s3 = ultimo();
    s3.sessionDescriptionHandler = { peerConnection: null, localMediaStream: null };
    act(() => s3.set(SessionState.Terminated));
    await llamar(h);
    Object.defineProperty(ultimo(), 'sessionDescriptionHandler', { get() { throw new Error('x'); } });
    act(() => ultimo().set(SessionState.Terminated));
    expect(h.result.current.callInfo).toBeNull();
  });

  it('reconectar/desconectar con un agente que falla al bajarse', async () => {
    const h = await montarRegistrado();
    fake.registerers[0].unregister = () => { throw new Error('x'); };
    fake.agents[0].stop.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.connect(CFG); });
    expect(h.result.current.reg).toBe('connecting');
    fake.registerers[1].dispose = undefined;
    fake.registerers[1].unregister = () => { throw new Error('x'); };
    fake.agents[1].stop.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.connect(CFG); });
    fake.registerers[2].unregister = vi.fn(() => Promise.reject(new Error('x')));
    await act(async () => { await h.result.current.disconnect(); });
    expect(h.result.current.reg).toBe('idle');
    fake.agents[2].stop.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.disconnect(); });
  });

  it('si el micrófono falla después de poner la primera en espera, cambiar de línea la retoma', async () => {
    const h = await montarRegistrado();
    await llamar(h, '201');
    const a = ultimo();
    act(() => a.set(SessionState.Established));
    gum.mockRejectedValueOnce(new Error('mic'));
    await llamar(h, '202');
    expect(h.result.current.callInfo).toBeNull();
    expect(h.result.current.heldInfo.number).toBe('201');
    await act(async () => { await h.result.current.switchLine(); });
    expect(h.result.current.callInfo.number).toBe('201');
    expect(h.result.current.heldInfo).toBeNull();
  });

  it('espera de línea con re-INVITE que falla igual mueve las líneas', async () => {
    const h = await montarRegistrado();
    await llamar(h, '201');
    const a = ultimo();
    act(() => a.set(SessionState.Established));
    a.invite.mockRejectedValue(new Error('491'));
    a.sessionDescriptionHandler = null;
    await llamar(h, '202');
    expect(h.result.current.heldInfo.number).toBe('201');
  });

  it('conferencia con webkitAudioContext y contexto ya activo; sin audioRef', async () => {
    const h = await montarRegistrado();
    await llamar(h, '201');
    act(() => ultimo().set(SessionState.Established));
    await llamar(h, '202');
    act(() => ultimo().set(SessionState.Established));
    delete window.AudioContext;
    window.webkitAudioContext = vi.fn(() => ({ ...actx, state: 'running', createMediaStreamSource: () => ({ connect: vi.fn() }), createMediaStreamDestination: () => ({ stream: new FakeMS([track('audio')]) }) }));
    h.result.current.audioRef.current = null;
    await act(async () => { await h.result.current.conference(); });
    expect(h.result.current.conf).toBe(true);
    delete window.webkitAudioContext;
    // al cortar, la mezcla sin mic/ctx no rompe
    act(() => ultimo().set(SessionState.Terminated));
    expect(h.result.current.conf).toBe(false);
  });

  it('atendida: consulta que termina tras cancelar, sin audioRef y con errores al cortar', async () => {
    const h = await montarRegistrado();
    await llamar(h);
    const p = ultimo();
    act(() => p.set(SessionState.Established));
    await act(async () => { await h.result.current.attendedCall(); });   // sin destino
    await act(async () => { await h.result.current.attendedCall('400'); });
    const c = ultimo();
    h.result.current.audioRef.current = null;
    c.sessionDescriptionHandler = null;
    act(() => c.set(SessionState.Established));          // sin SDH: no rompe
    expect(h.result.current.attended.state).toBe('talking');
    c.bye.mockRejectedValueOnce(new Error('x'));
    p.refer.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.completeAttended(); });
    p.invite.mockRejectedValueOnce(new Error('x'));
    await act(async () => { await h.result.current.cancelAttended(); });
    expect(h.result.current.attended).toBeNull();
    act(() => c.set(SessionState.Establishing));         // ya cancelada: el estado no revive
    expect(h.result.current.attended).toBeNull();
    await act(async () => { await h.result.current.attendedCall('401'); });
    const c2 = ultimo(); c2.cancel = undefined;
    await act(async () => { await h.result.current.cancelAttended(); });
    expect(h.result.current.held).toBe(false);
  });

  it('vigía: sin stats.get, sin listeners y con desconexión que no es falla', async () => {
    const h = await montarRegistrado();
    await llamar(h);
    const s = ultimo();
    const pc = s.sessionDescriptionHandler.peerConnection;
    pc.addEventListener = () => { throw new Error('x'); };
    pc.removeEventListener = () => { throw new Error('x'); };
    vi.useFakeTimers();
    act(() => s.set(SessionState.Established));
    const lista = [{ type: 'inbound-rtp', kind: 'audio', packetsReceived: 5, codecId: 'c' }, { type: 'candidate-pair', selected: true, localCandidateId: 'l' }];
    pc.statsQueue = [{ forEach: (f) => lista.forEach(f) }];
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(h.result.current.quality).toMatchObject({ codec: null, candType: null });
    pc.statsQueue = [new Map([['c', { id: 'c' }], ['i', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 50, codecId: 'c' }], ['p', { type: 'candidate-pair', selected: true, localCandidateId: 'zz' }]])];
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(h.result.current.quality.codec).toBeNull();
    await act(async () => { await h.result.current.hangup(); });   // limpia el vigía aunque remove tire
  });
});
