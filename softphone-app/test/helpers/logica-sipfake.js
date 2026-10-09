/* sip.js falso para probar useSip sin red: cada UserAgent/Registerer/Inviter creado queda
 * registrado en `fake` para que la prueba lo maneje (cambiar estados, mirar opciones). */
import { vi } from 'vitest';

export class Emisor {
  constructor() { this.l = []; }
  addListener(f) { this.l.push(f); }
  removeListener(f) { this.l = this.l.filter((x) => x !== f); }
  emit(v) { this.l.slice().forEach((f) => f(v)); }
}

export const SessionState = { Initial: 'Initial', Establishing: 'Establishing', Established: 'Established', Terminating: 'Terminating', Terminated: 'Terminated' };
export const RegistererState = { Initial: 'Initial', Registered: 'Registered', Unregistered: 'Unregistered', Terminated: 'Terminated' };

export const fake = { agents: [], registerers: [], inviters: [], makeURIFalla: false, startFalla: null };
export function resetFake() { fake.agents = []; fake.registerers = []; fake.inviters = []; fake.makeURIFalla = false; fake.startFalla = null; }

export function track(kind) { return { kind, enabled: true, stop: vi.fn() }; }

/* PeerConnection mínima: senders/receivers con pistas, getStats programable y listeners. */
export function fakePC({ audio = true, video = false } = {}) {
  const senders = [];
  if (audio) senders.push({ track: track('audio'), replaceTrack: vi.fn(async function (t) { this.track = t; }) });
  if (video) senders.push({ track: track('video'), replaceTrack: vi.fn(async function (t) { this.track = t; }) });
  const receivers = [{ track: track('audio') }, { track: null }];
  if (video) receivers.push({ track: track('video') });
  const handlers = {};
  return {
    senders, receivers, handlers,
    iceConnectionState: 'connected', connectionState: 'connected',
    getSenders: () => senders,
    getReceivers: () => receivers,
    addTrack: vi.fn((t) => senders.push({ track: t, replaceTrack: vi.fn() })),
    statsQueue: [],
    getStats: vi.fn(async function () { return this.statsQueue.length > 1 ? this.statsQueue.shift() : (this.statsQueue[0] || new Map()); }),
    addEventListener: vi.fn((ev, f) => { handlers[ev] = f; }),
    removeEventListener: vi.fn((ev) => { delete handlers[ev]; }),
  };
}

export function fakeSdh(pc) {
  return { peerConnection: pc, sendDtmf: vi.fn(), close: vi.fn(), localMediaStream: { getTracks: () => [track('audio')] } };
}

class SesionBase {
  constructor() {
    this.stateChange = new Emisor();
    this.state = SessionState.Initial;
    this.sessionDescriptionHandler = fakeSdh(fakePC());
    this.invite = vi.fn(async () => {});
    this.bye = vi.fn(async () => {});
    this.cancel = vi.fn(async () => {});
    this.refer = vi.fn(async () => {});
    this.dispose = vi.fn(async () => {});
  }
  /* Mueve el estado como lo haría sip.js y avisa a los listeners. */
  set(st) { this.state = st; this.stateChange.emit(st); }
}

export class Inviter extends SesionBase {
  constructor(ua, target, opts) { super(); this.ua = ua; this.target = target; this.opts = opts; fake.inviters.push(this); }
}

/* Una INVITE entrante, como la entrega delegate.onInvite. */
export function invitacion({ user = '200', sdp = 'v=0\r\nm=audio 1 RTP/AVP 0', enRequest = true } = {}) {
  const s = new SesionBase();
  s.remoteIdentity = user == null ? undefined : { uri: { user } };
  if (enRequest) s.request = { body: sdp }; else s.body = sdp;
  s.accept = vi.fn(async () => {});
  s.reject = vi.fn(async () => {});
  return s;
}

export class UserAgent {
  static makeURI(s) { if (fake.makeURIFalla) return undefined; const m = /^sip:([^@]*)@(.*)$/.exec(s); return { s, user: m && m[1], host: m && m[2] }; }
  constructor(opts) {
    this.opts = opts;
    this.start = vi.fn(async () => { if (fake.startFalla) throw fake.startFalla; });
    this.stop = vi.fn(async () => {});
    this.reconnect = vi.fn(async () => {});
    fake.agents.push(this);
  }
}

export class Registerer {
  constructor(agent, opts) {
    this.agent = agent; this.opts = opts;
    this.stateChange = new Emisor();
    this.register = vi.fn(async (o) => { this.regOpts = o; });
    this.unregister = vi.fn(async () => {});
    this.dispose = vi.fn();
    fake.registerers.push(this);
  }
}
