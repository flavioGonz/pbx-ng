/* Banco de pruebas de las pantallas del softphone (App.jsx y compañía).
 *
 * La ventana grande depende de casi todo lo que la rodea: el motor SIP (WebRTC o nativo),
 * la configuración cifrada, la API de la central, el ICE, los sonidos, las animaciones y
 * el puente de Electron (`window.sphone`). Acá están los dobles de todo eso, con estado
 * propio, para que cada prueba pueda decir «estoy registrado», «entra una llamada» o «la
 * central contestó 403» sin levantar nada real.
 *
 * Se usa desde cada archivo de prueba así (vi.mock tiene que estar escrito en el archivo):
 *   vi.mock('../src/useSip.js', async () => (await import('./helpers/pantallas-app.jsx')).mUseSip);
 */
import { useEffect, useState } from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

/* ── localStorage ──────────────────────────────────────────────────────────
 * Node 26 trae un `localStorage` global vacío que tapa al de jsdom: el código lo ve
 * `undefined`. Se instala uno en memoria, igual de completo que el del navegador. */
const datosLs = new Map();
const ls = {
  getItem: (k) => (datosLs.has(String(k)) ? datosLs.get(String(k)) : null),
  setItem: (k, v) => { datosLs.set(String(k), String(v)); },
  removeItem: (k) => { datosLs.delete(String(k)); },
  clear: () => datosLs.clear(),
  key: (i) => Array.from(datosLs.keys())[i] ?? null,
  get length() { return datosLs.size; },
};
Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
if (typeof window !== 'undefined' && window !== globalThis) Object.defineProperty(window, 'localStorage', { value: ls, configurable: true, writable: true });
/* jsdom no tiene canvas: sin esto escribe «Not implemented» en la consola en cada render
 * del login. Las pruebas del shader y del orbe ponen su propio contexto falso. */
if (typeof HTMLCanvasElement !== 'undefined') HTMLCanvasElement.prototype.getContext = function () { return null; };
/* Ni video ni audio de verdad: play() resuelve y listo, como un navegador con autoplay. */
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function () {};
}
/* Una pista de video «en vivo» o muda, para las pruebas que miran si llega imagen. */
export const streamCon = (estadoPista = 'live', muda = false) => ({ getVideoTracks: () => [{ readyState: estadoPista, muted: muda }], getTracks: () => [] });

/* ── El motor SIP ────────────────────────────────────────────────────────── */
export function crearSp(parche = {}) {
  return {
    reg: 'idle', registered: false, call: null, inCall: false, incoming: null, incomingVideo: false,
    muted: false, held: false, speaker: false, videoOn: false, callInfo: null, quality: null, hist: [],
    volume: 1, note: '', usingRelay: null,
    connect: vi.fn(), disconnect: vi.fn(), placeCall: vi.fn(() => Promise.resolve({ ok: true })),
    accept: vi.fn(), reject: vi.fn(), hangup: vi.fn(), toggleMute: vi.fn(), toggleHold: vi.fn(),
    toggleVideo: vi.fn(), toggleSpeaker: vi.fn(), applySpeaker: vi.fn(), setVolume: vi.fn(),
    transfer: vi.fn(), sendDtmf: vi.fn(), clearHist: vi.fn(),
    attended: null, attendedCall: vi.fn(), completeAttended: vi.fn(), cancelAttended: vi.fn(),
    heldInfo: null, switchLine: vi.fn(), conf: false, conference: vi.fn(),
    audioRef: { current: null }, remoteVideoRef: { current: null }, localVideoRef: { current: null },
    getRemoteStream: () => null, getLocalStream: () => null, getRemoteAudioStream: () => null,
    ...parche,
  };
}
export const estado = { web: crearSp(), nat: crearSp() };
const subs = new Set();
function usarSp(k) {
  const [, f] = useState(0);
  useEffect(() => { const fn = () => f((x) => x + 1); subs.add(fn); return () => { subs.delete(fn); }; }, []);
  return estado[k];
}
/* Cambia lo que devuelve el motor y fuerza el render, como haría el hook de verdad. */
export async function ponerSp(parche, k = 'web') {
  await act(async () => { estado[k] = { ...estado[k], ...parche }; subs.forEach((fn) => fn()); });
  return estado[k];
}
/* Una llamada entrante tal como la arma sip.js. */
export const entrante = (num) => ({ remoteIdentity: { uri: { user: num } } });

let prefs = { mic: '', cam: '', spk: '' };
export const mUseSip = {
  useSip: () => usarSp('web'),
  listDevices: vi.fn(async () => ({
    mics: [{ deviceId: 'm1', label: 'Micrófono (2- DM30 RGB USB Microphone) (352f:0106)' }, { deviceId: 'm2', label: '' }],
    cams: [{ deviceId: 'c1', label: 'Cámara integrada' }],
    speakers: [{ deviceId: 's1', label: 'Parlantes' }],
    permiso: true,
  })),
  getDevPrefs: vi.fn(() => ({ ...prefs })),
  setDevPref: vi.fn((k, v) => { prefs = { ...prefs, [k]: v }; }),
};
export const mUseSipNative = { useSipNative: () => usarSp('nat') };

/* ── La configuración cifrada ───────────────────────────────────────────── */
export const DEF = {
  transport: 'webrtc', wss: '', wssBackup: '', domain: '', ext: '', pass: '', name: '',
  stun: '', turn: '', turnUser: '', turnPass: '', sipServer: '', sipPort: '5060', sipTransport: 'udp',
  sipSrtp: 'none', sipDtmf: 'rfc4733', tlsVerify: false, sipSrv: false, sipMwi: false, codec: 'auto', codecForce: false,
};
export const CFG_OK = { ...DEF, wss: 'wss://pbx.ejemplo.test/ws', domain: 'pbx.ejemplo.test', ext: '2001', pass: 'clave-de-prueba' };
export const CFG_SIP = { ...DEF, transport: 'sip', sipServer: '10.0.0.5', domain: 'pbx.ejemplo.test', ext: '2001', pass: 'clave-de-prueba' };
export const store = { config: null, accounts: [], clientes: [] };
let nId = 0;
const isComplete = (c) => {
  if (!c) return false;
  if (c.transport === 'sip') return !!(c.sipServer && c.domain && c.ext && c.pass);
  return !!(c.wss && c.domain && c.ext && c.pass);
};
export const mConfig = {
  loadConfig: vi.fn(() => ({ ...DEF, ...(store.config || {}) })),
  saveConfig: vi.fn((c) => { store.config = c; }),
  isComplete,
  getAccounts: vi.fn(() => store.accounts.slice()),
  setAccounts: vi.fn((l) => { store.accounts = l || []; }),
  getClientesLocales: vi.fn(() => store.clientes.slice()),
  setClientesLocales: vi.fn((l) => { store.clientes = l || []; }),
  esLocal: (x) => !!(x && typeof x.id === 'string' && x.id.indexOf('loc_') === 0),
  nuevoIdLocal: vi.fn(() => 'loc_' + (++nId)),
  hydrateSecure: vi.fn(() => Promise.resolve()),
};

/* ── La API de la central ───────────────────────────────────────────────── */
export const sesion = { base: '', token: '', user: '' };
const ok = (v) => vi.fn(() => Promise.resolve(v));
export const mApi = {
  getApiBase: vi.fn(() => sesion.base),
  getToken: vi.fn(() => sesion.token),
  getApiUser: vi.fn(() => sesion.user),
  apiConnected: vi.fn(() => !!(sesion.base && sesion.token)),
  apiLogout: vi.fn(() => { sesion.token = ''; }),
  applySession: vi.fn(({ base, token, user }) => { if (base) sesion.base = base; if (token) sesion.token = token; if (user) sesion.user = user; }),
  baseFromWss: vi.fn((w) => (w ? String(w).replace(/^ws/, 'http').replace(/\/ws$/, '') : '')),
  apiLogin: ok({ ok: true }),
  iceDeLaCentral: ok({}),
  directory: ok([]),
  clients: ok([]),
  clientsFull: ok([]),
  clientsLookup: ok(null),
  clientDetail: ok({}),
  clientCreate: ok({ id: 'c-nuevo', name: 'Nuevo' }),
  clientStreams: ok([]),
  clientDeviceAdd: ok({ ok: true }),
  abrirRele: ok({ nombre: 'Puerta' }),
  intercomTicket: ok({ ticket: 'tk1' }),
  recordings: ok([]),
  recordCall: ok({}),
  spyCall: ok({}),
  matchRecording: ok(null),
  recordingAudioUrl: ok('blob:grabacion'),
  vmList: ok([]),
  vmDel: ok({}),
  vmRead: ok({}),
  vmTranscribe: ok({ transcript: 'hola' }),
  presence: ok({}),
  provision: ok({ prov_url: 'pbxng://prov#x' }),
  cdr: ok([]),
  vmAudioUrl: ok('blob:vm'),
};

/* ── El resto de los vecinos ────────────────────────────────────────────── */
export const mIce = {
  testIce: vi.fn(() => Promise.resolve({ state: 'ok', host: 2, srflx: 1, relay: 1, publicIp: '200.1.1.1', relayIp: '200.2.2.2', ms: 340, errors: [] })),
  refrescarIce: vi.fn(() => Promise.resolve({ ok: true })),
  iceEfectivos: vi.fn(() => ({ lista: [], fuente: 'ninguna' })),
};
export const mProv = {
  encodeProv: vi.fn((c) => 'pbxng://prov#' + JSON.stringify(c)),
  decodeProv: vi.fn((t) => { const s = String(t || ''); if (!s.startsWith('pbxng://prov#')) return null; try { return JSON.parse(s.slice(13)); } catch { return null; } }),
  parseEnroll: vi.fn((t) => /enroll\?token=/.test(String(t || ''))),
  resolveEnroll: vi.fn(() => Promise.resolve(null)),
};
export const mSounds = {
  setUiSounds: vi.fn(), setRingSounds: vi.fn(), uiClick: vi.fn(), uiKey: vi.fn(), uiToggle: vi.fn(),
  startRingback: vi.fn(), stopRingback: vi.fn(), startIncomingRing: vi.fn(), stopIncomingRing: vi.fn(),
};
export const mAnim = { gEnter: vi.fn(), gPop: vi.fn(), gSplash: vi.fn(), gModal: vi.fn(), gStagger: vi.fn() };
export const mQrcode = { default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,QR')) } };
export const mJsqr = { default: vi.fn(() => null) };

/* ── El puente de Electron ──────────────────────────────────────────────────
 * Los `on*` guardan el callback para que la prueba pueda «mandar» el evento desde main. */
export function crearSphone(extra = {}) {
  const h = {};
  const on = (k) => vi.fn((cb) => { h[k] = cb; return () => { delete h[k]; }; });
  const s = {
    isElectron: true,
    onDial: on('dial'), onHotkey: on('hotkey'), onProvision: on('provision'), onSipEvent: on('sip'),
    onUpdate: on('update'), onMiniAction: on('mini'), onSysEvent: on('sys'), onGo2rtcMsg: on('go2rtc'),
    sipConnect: vi.fn(), sipDisconnect: vi.fn(),
    updateSetFeed: vi.fn(), updateCheck: vi.fn(), updateInstall: vi.fn(),
    winMinimize: vi.fn(), winClose: vi.fn(), winSize: vi.fn(), winShake: vi.fn(),
    miniShow: vi.fn(), miniState: vi.fn(), miniData: vi.fn(),
    g2localAsegurar: vi.fn(() => Promise.resolve({ ok: true, base: 'http://127.0.0.1:1984' })),
    ...extra,
  };
  s.handlers = h;
  s.emitir = async (k, v) => { await act(async () => { if (h[k]) h[k](v); }); };
  window.sphone = s;
  return s;
}

/* ── Montar la app ──────────────────────────────────────────────────────── */
export function reiniciar() {
  ls.clear();
  delete window.sphone;
  store.config = null; store.accounts = []; store.clientes = [];
  sesion.base = ''; sesion.token = ''; sesion.user = '';
  prefs = { mic: '', cam: '', spk: '' };
  estado.web = crearSp(); estado.nat = crearSp();
}
export async function avanzar(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
/* Deja la app como la ve el usuario después del splash. `sesion` = conectado a la central. */
export async function montar({ cfg = null, sphone = null, central = false, web, nat, clientes, cuentas, prefs: pr, prefsCrudas, foto, favs, favsCrudos, saltarSplash = true } = {}) {
  reiniciar();
  if (favs) ls.setItem('sp_favs', JSON.stringify(favs));
  if (favsCrudos) ls.setItem('sp_favs', favsCrudos);
  if (pr) ls.setItem('sp_prefs2', JSON.stringify(pr));
  if (prefsCrudas) ls.setItem('sp_prefs2', prefsCrudas);
  if (foto) ls.setItem('sp_photo', foto);
  if (cfg) store.config = { ...cfg };
  if (clientes) store.clientes = clientes;
  if (cuentas) store.accounts = cuentas;
  if (central) { sesion.base = 'https://pbx.ejemplo.test'; sesion.token = 'tok'; sesion.user = 'operador'; }
  if (web) estado.web = crearSp(web);
  if (nat) estado.nat = crearSp(nat);
  const sph = sphone === true ? crearSphone() : sphone && typeof sphone === 'object' ? crearSphone(sphone) : null;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-08T12:00:00'));
  const { default: App } = await import('../../src/App.jsx');
  const r = render(<App />);
  if (saltarSplash) await avanzar(3200);
  return { ...r, sphone: sph };
}
/* Las cadenas de timers (un efecto que programa otro al cambiar el estado) no avanzan
 * dentro de un mismo act: React aplica el estado recién al salir. Se avanza de a tramos. */
export async function avanzarDe(ms, veces) {
  for (let i = 0; i < veces; i++) await avanzar(ms);
}
/* El botón del menú lateral (el texto aparece también como título de la sección). */
export function irA(label) {
  const el = screen.getAllByText(label).find((e) => e.tagName === 'SPAN' && e.parentElement && e.parentElement.tagName === 'BUTTON');
  if (!el) throw new Error('no hay botón de menú «' + label + '»');
  fireEvent.click(el.parentElement);
}
