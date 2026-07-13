// Integración opcional con el backend PBX-NG (/backend/api/**, auth JWT).
// En Electron los requests van por el proceso main (window.sphone.api) para saltear CORS.
// En navegador/PWA (mismo origen que la central) van por fetch directo.

const LS_BASE = 'sp_api_base', LS_TOKEN = 'sp_api_token', LS_USER = 'sp_api_user';

export function getApiBase() { try { return localStorage.getItem(LS_BASE) || ''; } catch { return ''; } }
export function setApiBase(v) { try { v ? localStorage.setItem(LS_BASE, v) : localStorage.removeItem(LS_BASE); } catch {} }
export function getToken() { try { return localStorage.getItem(LS_TOKEN) || ''; } catch { return ''; } }
function setToken(v) { try { v ? localStorage.setItem(LS_TOKEN, v) : localStorage.removeItem(LS_TOKEN); } catch {} }
export function getApiUser() { try { return localStorage.getItem(LS_USER) || ''; } catch { return ''; } }
export function apiConnected() { return !!(getApiBase() && getToken()); }
export function apiLogout() { setToken(''); }
export function applySession({ base, token, user }) { try { if (base) setApiBase(base); if (token) localStorage.setItem(LS_TOKEN, token); if (user) localStorage.setItem(LS_USER, user); } catch {} }

// deriva https://host desde una URL wss://host/ws
export function baseFromWss(wss) {
  try { const u = new URL(wss); return (u.protocol === 'ws:' ? 'http:' : 'https:') + '//' + u.host; } catch { return ''; }
}

function fullUrl(path) {
  const base = getApiBase().replace(/\/$/, '');
  return base + '/backend/api' + path;
}

async function call(method, path, body) {
  const token = getToken();
  const url = fullUrl(path);
  if (typeof window !== 'undefined' && window.sphone && window.sphone.api) {
    const r = await window.sphone.api({ method, url, body, token });
    if (r.error) throw new Error(r.error);
    if (r.status === 401) { setToken(''); throw new Error('sesión vencida'); }
    return r.json;
  }
  const r = await fetch(url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { setToken(''); throw new Error('sesión vencida'); }
  return r.json().catch(() => null);
}

export async function apiLogin(base, username, password) {
  setApiBase(base);
  const r = await call('POST', '/auth/login', { username, password });
  if (r && r.token) { setToken(r.token); try { localStorage.setItem(LS_USER, username); } catch {} return { ok: true, user: r.user }; }
  return { error: (r && r.error) || 'login falló' };
}

export const directory = () => call('GET', '/directory');
export const clients = () => call('GET', '/intercom/clients');
export const clientsFull = () => call('GET', '/clients');
export const clientsLookup = (number) => call('GET', '/clients/lookup?number=' + encodeURIComponent(number || ''));
export const clientDetail = (id) => call('GET', '/clients/' + encodeURIComponent(id));
export const clientStreams = (id) => call('GET', '/intercom/streams?client=' + encodeURIComponent(id));
export const recordings = () => call('GET', '/recordings');
export const recordCall = (ext, action) => call('POST', '/calls/record', { ext, action });
export const spyCall = (sup, target, mode) => call('POST', '/calls/spy', { sup, target, mode });
export const matchRecording = (from, to, ts) => call('GET', `/recordings/match?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}&ts=${ts || ''}`);

// descarga el audio de una grabación como blob URL (con auth), vía main o fetch
export async function recordingAudioUrl(id) {
  const token = getToken(); const url = fullUrl('/recordings/' + id + '/audio');
  if (typeof window !== 'undefined' && window.sphone && window.sphone.apiBlob) {
    const r = await window.sphone.apiBlob({ method: 'GET', url, token });
    if (r.error || !r.b64) return '';
    const bin = atob(r.b64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: r.type || 'audio/wav' }));
  }
  const r = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  if (!r.ok) return '';
  return URL.createObjectURL(await r.blob());
}

export const vmList = (ext) => call('GET', '/vm?ext=' + encodeURIComponent(ext));
export const vmDel = (ext, folder, id) => call('POST', '/vm/del', { ext, folder, id });
export const vmRead = (ext, folder, id) => call('POST', '/vm/read', { ext, folder, id });
export const vmTranscribe = (ext, folder, id) => call('POST', '/vm/transcribe', { ext, folder, id });
export const presence = () => call('GET', '/presence');
export const provision = (ext) => call('GET', '/provision?ext=' + encodeURIComponent(ext || ''));
export const cdr = (ext, limit) => call('GET', '/cdr?ext=' + encodeURIComponent(ext || '') + '&limit=' + (limit || 100));
export async function vmAudioUrl(ext, folder, id) {
  const token = getToken(); const url = fullUrl('/vm/audio?ext=' + encodeURIComponent(ext) + '&folder=' + encodeURIComponent(folder || 'INBOX') + '&id=' + encodeURIComponent(id));
  if (typeof window !== 'undefined' && window.sphone && window.sphone.apiBlob) {
    const r = await window.sphone.apiBlob({ method: 'GET', url, token }); if (r.error || !r.b64) return '';
    const bin = atob(r.b64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: r.type || 'audio/wav' }));
  }
  const r = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); if (!r.ok) return ''; return URL.createObjectURL(await r.blob());
}
