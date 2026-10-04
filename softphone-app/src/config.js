const KEY = 'sp_config';
const DEFAULTS = {
  transport: 'webrtc',
  wss: '', wssBackup: '', domain: '', ext: '', pass: '', name: '',
  // Vacíos: los llena el aprovisionamiento (QR / link de enrolado) con el STUN y el TURN
  // de la propia central. Un default público hacía que un softphone recién instalado
  // buscara candidatos contra Google aun en redes sin salida a internet.
  stun: '', turn: '', turnUser: '', turnPass: '',
  sipServer: '', sipPort: '5060', sipTransport: 'udp', sipSrtp: 'none', sipDtmf: 'rfc4733', tlsVerify: false, sipSrv: false, sipMwi: false, soundsUi: true,
  codec: 'auto', codecForce: false,   // preferencia de códec de audio (para probar transcoding del SBC)
};
/* Almacen unico: { config, accounts, clientes }. En Electron va cifrado
 * (safeStorage/DPAPI); en navegador cae a localStorage.
 *
 * `clientes` son los clientes que se cargaron EN ESTE APARATO: existen con o sin central
 * conectada y no se comparten con nadie. Van en el mismo almacen cifrado que las cuentas
 * porque guardan lo mismo de delicado: una URL RTSP trae usuario y contrasena de la camara
 * adentro, y eso no puede quedar en localStorage en claro.
 *
 * Son del APARATO, no de la cuenta: cambiar de cuenta SIP o desconectarse del sistema no
 * los toca. Eso es a proposito y es la diferencia con `cls`/`clsFull` de App.jsx, que si se
 * limpian porque son prestados por la central.
 *
 * Migra dos formatos viejos al vuelo: la config plana (pre-cuentas) y el
 * `{ config, accounts }` sin clientes. */
let _store = { config: null, accounts: [], clientes: [] };
function readLocal() {
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return null; const o = JSON.parse(raw);
    if (o && (o.config || o.accounts || o.clientes)) return { config: o.config || null, accounts: o.accounts || [], clientes: o.clientes || [] };
    return { config: o, accounts: [], clientes: [] };
  } catch { return null; }
}
function persist() {
  const json = JSON.stringify({ config: _store.config, accounts: _store.accounts, clientes: _store.clientes });
  try {
    if (typeof window !== 'undefined' && window.sphone && window.sphone.secureSave) { window.sphone.secureSave(json); try { localStorage.removeItem(KEY); } catch {} }
    else localStorage.setItem(KEY, json);
  } catch {}
}
export function loadConfig() {
  let c = _store.config;
  if (!c) { const l = readLocal(); c = l && l.config; }
  return { ...DEFAULTS, ...(c || {}) };
}
export function saveConfig(c) { _store.config = c; persist(); }
export function getAccounts() {
  if (!_store.accounts || !_store.accounts.length) { const l = readLocal(); if (l && l.accounts && l.accounts.length) _store.accounts = l.accounts; }
  return (_store.accounts || []).slice();
}
export function setAccounts(list) { _store.accounts = list || []; persist(); }

/* ── Clientes y camaras de este aparato ──────────────────────────────────────
 * Forma de un cliente local:  { id: 'loc_xxxx', name, phones: [], devices: [] }
 * Forma de una camara local:  { id: 'loc_xxxx', label, type: 'camera'|'intercom', rtsp }
 *
 * El prefijo `loc_` ES el origen. No hay un campo `local: true` aparte a proposito: un
 * campo se puede perder en una copia o un `{...spread}` incompleto y entonces un cliente
 * del aparato pasaria por uno del sistema (o al revés, y se intentaria pedirle a la central
 * un id que no existe). El id viaja siempre. */
export const esLocal = (x) => !!(x && typeof x.id === 'string' && x.id.indexOf('loc_') === 0);
export function nuevoIdLocal() {
  /* Sin Date.now() solo: dos altas en el mismo milisegundo colisionaban. */
  const r = (typeof crypto !== 'undefined' && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(16).slice(2, 10);
  return 'loc_' + Date.now().toString(36) + r;
}
export function getClientesLocales() {
  if (!_store.clientes || !_store.clientes.length) { const l = readLocal(); if (l && l.clientes && l.clientes.length) _store.clientes = l.clientes; }
  return (_store.clientes || []).slice();
}
export function setClientesLocales(list) { _store.clientes = list || []; persist(); }
export async function hydrateSecure() {
  try {
    if (typeof window === 'undefined' || !window.sphone || !window.sphone.secureLoad) return;
    const v = await window.sphone.secureLoad();
    if (v) { try { const o = JSON.parse(v); if (o && (o.config || o.accounts || o.clientes)) { _store.config = o.config || null; _store.accounts = o.accounts || []; _store.clientes = o.clientes || []; } else { _store.config = o; } } catch { _store.config = null; } return; }
    const l = readLocal();
    if (l) { _store.config = l.config; _store.accounts = l.accounts || []; _store.clientes = l.clientes || []; try { await window.sphone.secureSave(JSON.stringify({ config: _store.config, accounts: _store.accounts, clientes: _store.clientes })); localStorage.removeItem(KEY); } catch {} }
  } catch {}
}
export function isComplete(c) {
  if (!c) return false;
  if (c.transport === 'sip') return !!(c.sipServer && c.domain && c.ext && c.pass);
  return !!(c.wss && c.domain && c.ext && c.pass);
}
