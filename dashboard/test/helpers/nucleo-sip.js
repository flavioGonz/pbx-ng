/* Dobles de telefonía para las pruebas (dueño: agente panel / núcleo).
 *
 * - `crearSipFalso()`: un `sip.js` de mentira (UserAgent, Registerer, Inviter) que no abre
 *   ningún WebSocket y deja manejar a mano el estado de cada sesión.
 * - `SesionFalsa` / `crearPcFalso()`: una sesión SIP con su RTCPeerConnection falsa
 *   (senders, receivers, getStats, eventos de ICE).
 * - `crearSpFalso(over)`: el objeto que devuelve `useSoftphone()`, con todas las acciones
 *   como `vi.fn()`, para probar pantallas que reciben `sp` (Softphone.jsx, /phone, /call…).
 * - `instalarMedios()`: MediaStream, AudioContext y navigator.mediaDevices falsos.
 *
 * Uso típico:
 *   const sip = crearSipFalso();
 *   vi.doMock('sip.js', () => sip.modulo);
 *   ...
 *   sip.estado.inviters[0].cambiar('Established');
 *
 * API estable: sólo se agregan cosas. */
import { vi } from 'vitest';

export class Emisor {
  constructor() { this.l = []; }
  addListener(f) { this.l.push(f); }
  removeListener(f) { this.l = this.l.filter((x) => x !== f); }
  emit(v) { this.l.slice().forEach((f) => f(v)); }
}

export function pista(kind = 'audio') {
  return { kind, enabled: true, stop: vi.fn(), onended: null };
}

export function crearPcFalso({ conVideo = false } = {}) {
  const h = {};
  const pc = {
    senders: [{ track: pista('audio'), replaceTrack: vi.fn(async () => {}) }, ...(conVideo ? [{ track: pista('video'), replaceTrack: vi.fn(async () => {}) }] : []), { track: null }],
    receivers: [{ track: pista('audio') }, { track: null }],
    iceConnectionState: 'connected', connectionState: 'connected',
    stats: new Map(),
    getSenders() { return this.senders; },
    getReceivers() { return this.receivers; },
    getStats: vi.fn(async () => pc.stats),
    addEventListener: vi.fn((ev, f) => { (h[ev] ||= []).push(f); }),
    removeEventListener: vi.fn((ev, f) => { h[ev] = (h[ev] || []).filter((x) => x !== f); }),
    disparar(ev) { (h[ev] || []).slice().forEach((f) => f()); },
    handlers: h,
  };
  return pc;
}

export class SesionFalsa {
  constructor({ conVideo = false, desde = '2001', body } = {}) {
    this.state = 'Initial';
    this.stateChange = new Emisor();
    this.sessionDescriptionHandler = { peerConnection: crearPcFalso({ conVideo }), sendDtmf: vi.fn(), close: vi.fn(), localMediaStream: { getTracks: () => [pista()] } };
    this.remoteIdentity = { uri: { user: desde } };
    this.request = { body: body || '' };
    this.invite = vi.fn(async () => {});
    this.bye = vi.fn(async () => {});
    this.cancel = vi.fn(async () => {});
    this.reject = vi.fn(async () => {});
    this.accept = vi.fn(async () => {});
    this.refer = vi.fn(async () => {});
  }
  cambiar(st) { this.state = st; this.stateChange.emit(st); }
}

export function crearSipFalso() {
  const estado = { agentes: [], registerers: [], inviters: [], fallarStart: false, fallarRegister: false };
  class UserAgent {
    static makeURI(s) { return { s, user: String(s).slice(4).split('@')[0] }; }
    constructor(o) {
      this.opts = o; this.delegate = o.delegate;
      this.start = vi.fn(async () => { if (estado.fallarStart) throw new Error('wss caído'); });
      this.stop = vi.fn(async () => {});
      this.reconnect = vi.fn(async () => {});
      estado.agentes.push(this);
    }
  }
  class Registerer {
    constructor(ua, o) {
      this.ua = ua; this.opts = o; this.stateChange = new Emisor();
      this.register = vi.fn(async () => { if (estado.fallarRegister) throw new Error('401 no autorizado'); this.stateChange.emit('Registered'); });
      this.unregister = vi.fn(async () => {});
      estado.registerers.push(this);
    }
  }
  class Inviter extends SesionFalsa {
    constructor(ua, uri, o) { super({ conVideo: !!(o && o.sessionDescriptionHandlerOptions && o.sessionDescriptionHandlerOptions.constraints && o.sessionDescriptionHandlerOptions.constraints.video) }); this.ua = ua; this.uri = uri; this.opts = o; estado.inviters.push(this); }
  }
  return { modulo: { UserAgent, Registerer, Inviter }, estado };
}

/** El objeto de `useSoftphone()` con acciones espía. `over` pisa lo que haga falta. */
export function crearSpFalso(over = {}) {
  return {
    reg: 'registered', call: null, incoming: null, incomingVideo: false, muted: false, held: false, recording: false,
    creds: { ext: '101', pass: 'x', video: false }, hist: [], callInfo: null, attended: null, sharing: false, filePlaying: null,
    speaker: false, quality: null, usingRelay: null,
    audioRef: { current: null }, remoteVideoRef: { current: null }, localVideoRef: { current: null },
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), placeCall: vi.fn(async () => {}),
    acceptIncoming: vi.fn(async () => {}), rejectIncoming: vi.fn(), hangup: vi.fn(async () => {}),
    toggleMute: vi.fn(), toggleHold: vi.fn(async () => {}), transfer: vi.fn(async () => true),
    attendedCall: vi.fn(async () => true), completeAttended: vi.fn(async () => {}), cancelAttended: vi.fn(async () => {}),
    shareScreen: vi.fn(async () => ({ ok: true })), shareFile: vi.fn(async () => ({ ok: true })), stopFile: vi.fn(async () => {}),
    toggleRecord: vi.fn(async () => ({})), tone: vi.fn(), toggleSpeaker: vi.fn(async () => {}),
    ...over,
  };
}

/** MediaStream, AudioContext y mediaDevices de mentira (con vi.stubGlobal). */
export function instalarMedios() {
  class MediaStreamFalso {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    addTrack(t) { this.tracks.push(t); }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  }
  const osc = [];
  class AudioContextFalso {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; AudioContextFalso.creados++; }
    resume() { this.state = 'running'; }
    createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
    createOscillator() { const o = { connect() {}, start: vi.fn(), stop: vi.fn(), frequency: {} }; osc.push(o); return o; }
  }
  AudioContextFalso.creados = 0;
  const mediaDevices = {
    getUserMedia: vi.fn(async (c) => new MediaStreamFalso([...(c && c.audio ? [pista('audio')] : []), ...(c && c.video ? [pista('video')] : [])])),
    getDisplayMedia: vi.fn(async () => new MediaStreamFalso([pista('video')])),
    enumerateDevices: vi.fn(async () => []),
  };
  vi.stubGlobal('MediaStream', MediaStreamFalso);
  vi.stubGlobal('AudioContext', AudioContextFalso);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
  return { MediaStream: MediaStreamFalso, AudioContext: AudioContextFalso, osciladores: osc, mediaDevices };
}
