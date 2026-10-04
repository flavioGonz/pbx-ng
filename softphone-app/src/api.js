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
    if (r.status >= 400) throw fallo(r.status, r.json);
    return r.json;
  }
  const r = await fetch(url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { setToken(''); throw new Error('sesión vencida'); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw fallo(r.status, j);
  return j;
}

/* Antes cualquier respuesta que no fuera 200 se devolvía tal cual, y como el cuerpo de
 * un error es `{error:"..."}` y no un array, el `Array.isArray(d) ? d : []` de la
 * pantalla lo convertía en lista vacía. Resultado: un 403 de permisos se veía
 * exactamente igual que "este cliente no tiene cámaras" — sin un solo mensaje. Un
 * permiso que falta tiene que doler, no esconderse. */
function fallo(status, cuerpo) {
  const msg = (cuerpo && (cuerpo.error || cuerpo.message))
    || (status === 403 ? 'tu usuario no tiene permiso para esto' : 'el servidor respondió ' + status);
  const e = new Error(msg);
  e.status = status;
  return e;
}

/* Entrar con el usuario del panel. Devuelve SIEMPRE un objeto —{ok} o {error}— y nunca
 * lanza: quien llama es un botón, y un error que escapa de acá deja la pantalla clavada
 * en «Conectando…» sin decir nada. El 401 de acá no es una sesión vencida como en el
 * resto de la API: es la contraseña, y hay que decirlo con esas palabras. */
export async function apiLogin(base, username, password) {
  const b = String(base || '').trim().replace(/\/$/, '');
  if (!b) return { error: 'falta la URL del sistema' };
  if (!/^https?:\/\//i.test(b)) return { error: 'la URL del sistema tiene que empezar con https://' };
  setApiBase(b);
  try {
    const r = await call('POST', '/auth/login', { username, password });
    if (r && r.token) { setToken(r.token); try { localStorage.setItem(LS_USER, username); } catch {} return { ok: true, user: r.user }; }
    return { error: (r && r.error) || 'el sistema no devolvió una sesión' };
  } catch (e) {
    const m = String((e && e.message) || 'no se pudo conectar');
    if (e && e.status === 401) return { error: 'usuario o contraseña incorrectos' };
    if (e && e.status === 404) return { error: 'esa URL responde, pero no es el panel de una central PBX-NG' };
    if (e && e.status === 429) return { error: 'demasiados intentos seguidos: la central te frenó unos minutos' };
    if (e && e.status === 403) return { error: m };
    if (/sesión vencida/i.test(m)) return { error: 'usuario o contraseña incorrectos' };
    if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(m)) return { error: 'no se encontró ese servidor: revisá la URL' };
    if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(m)) return { error: 'el servidor no acepta la conexión desde esta red' };
    if (/timeout/i.test(m)) return { error: 'el servidor no contestó a tiempo' };
    return { error: m };
  }
}

/* ICE de la central. Es PÚBLICA (no pide sesión): la central la sirve para que cualquier
 * softphone suyo sepa contra qué relay hablar, y eso incluye a uno recién instalado que
 * todavía no se conectó a la API. Por eso no se usa `call()`, que exige base+token. */
export async function iceDeLaCentral(base) {
  const b = String(base || getApiBase() || '').replace(/\/$/, '');
  if (!b) throw new Error('no sé cuál es la central: falta la URL del panel');
  const url = b + '/backend/api/ice';
  if (typeof window !== 'undefined' && window.sphone && window.sphone.api) {
    const r = await window.sphone.api({ method: 'GET', url, token: getToken() });
    if (r.error) throw new Error(r.error);
    if (r.status >= 400) throw fallo(r.status, r.json);
    return r.json;
  }
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw fallo(r.status, j);
  return j;
}

export const directory = () => call('GET', '/directory');
export const clients = () => call('GET', '/intercom/clients');
export const clientsFull = () => call('GET', '/clients');
export const clientsLookup = (number) => call('GET', '/clients/lookup?number=' + encodeURIComponent(number || ''));
export const clientDetail = (id) => call('GET', '/clients/' + encodeURIComponent(id));
/* Crear un cliente DEL SISTEMA. Solo lo acepta una sesion de panel con rol admin o
 * supervisor; con el token del aparato vuelve 403 y el softphone lo crea local. */
export const clientCreate = (c) => call('POST', '/clients', c);
export const clientStreams = (id) => call('GET', '/intercom/streams?client=' + encodeURIComponent(id));
/* Alta de una camara en la central. `rtsp_url` viaja entera una sola vez, en el POST: de
 * ahi en adelante la central la devuelve enmascarada (deviceSafe) y el aparato no la vuelve
 * a ver. La respuesta trae el `go2rtc_src` con el que despues se mira el video. */
export const clientDeviceAdd = (id, dev) => call('POST', '/clients/' + encodeURIComponent(id) + '/devices', dev);
/* «Entrada» de un solo uso para abrir el video de UNA cámara: vale un minuto y se quema
 * al usarse. Es lo que se manda en la URL del WebSocket, en vez de la sesión entera —que
 * quedaría escrita en cualquier registro por el que pase esa URL—. */
export const intercomTicket = (src) => call('GET', '/intercom/ticket?src=' + encodeURIComponent(src));
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
