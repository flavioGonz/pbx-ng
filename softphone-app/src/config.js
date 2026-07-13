const KEY = 'sp_config';
const DEFAULTS = {
  transport: 'webrtc',
  wss: '', wssBackup: '', domain: '', ext: '', pass: '', name: '',
  stun: 'stun:stun.l.google.com:19302', turn: '', turnUser: '', turnPass: '',
  sipServer: '', sipPort: '5060', sipTransport: 'udp', sipSrtp: 'none', sipDtmf: 'rfc4733', tlsVerify: false, sipSrv: false, sipMwi: false, soundsUi: true,
};
// Almacen unico: { config, accounts }. En Electron va cifrado (safeStorage/DPAPI);
// en navegador cae a localStorage. Migra el formato viejo (config plana) al vuelo.
let _store = { config: null, accounts: [] };
function readLocal() {
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return null; const o = JSON.parse(raw);
    if (o && (o.config || o.accounts)) return { config: o.config || null, accounts: o.accounts || [] };
    return { config: o, accounts: [] };
  } catch { return null; }
}
function persist() {
  const json = JSON.stringify({ config: _store.config, accounts: _store.accounts });
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
export async function hydrateSecure() {
  try {
    if (typeof window === 'undefined' || !window.sphone || !window.sphone.secureLoad) return;
    const v = await window.sphone.secureLoad();
    if (v) { try { const o = JSON.parse(v); if (o && (o.config || o.accounts)) { _store.config = o.config || null; _store.accounts = o.accounts || []; } else { _store.config = o; } } catch { _store.config = null; } return; }
    const l = readLocal();
    if (l) { _store.config = l.config; _store.accounts = l.accounts || []; try { await window.sphone.secureSave(JSON.stringify({ config: _store.config, accounts: _store.accounts })); localStorage.removeItem(KEY); } catch {} }
  } catch {}
}
export function isComplete(c) {
  if (!c) return false;
  if (c.transport === 'sip') return !!(c.sipServer && c.domain && c.ext && c.pass);
  return !!(c.wss && c.domain && c.ext && c.pass);
}
