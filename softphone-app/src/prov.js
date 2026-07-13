// Aprovisionamiento por QR / deep-link. Payload = JSON base64url en pbxng://prov#<...>
const FIELDS = ['transport', 'name', 'domain', 'ext', 'pass', 'wss', 'sipServer', 'sipPort', 'sipTransport', 'sipSrtp', 'stun', 'turn', 'turnUser', 'turnPass', 'apiBase', 'apiToken'];
function b64urlEnc(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDec(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }

export function encodeProv(cfg) {
  const o = {}; FIELDS.forEach(f => { if (cfg && cfg[f] != null && cfg[f] !== '') o[f] = cfg[f]; });
  return 'pbxng://prov#' + b64urlEnc(JSON.stringify(o));
}
export function decodeProv(text) {
  try {
    let t = String(text || '').trim();
    const h = t.indexOf('#');
    if (t.indexOf('pbxng://') === 0 && h >= 0) t = t.slice(h + 1);
    else if (t.indexOf('pbxng://prov') === 0) t = t.replace('pbxng://prov', '').replace(/^#/, '');
    const json = t[0] === '{' ? t : b64urlDec(t);
    const o = JSON.parse(json); const out = {};
    FIELDS.forEach(f => { if (o[f] != null) out[f] = String(o[f]); });
    if (!out.ext || !out.domain) return null;
    if (!out.transport) out.transport = out.wss ? 'webrtc' : (out.sipServer ? 'sip' : 'webrtc');
    return out;
  } catch (e) { return null; }
}

// ---- Enrolamiento por link del panel:  https://pbx.cliente.com/enroll?token=XXXX ----
// El admin genera ese link (o su QR) al crear el interno. Canjeamos el token contra la
// API publica (/api/enroll/<token>) y armamos la config del softphone.
export function parseEnroll(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(https?:\/\/[^/\s]+)\/enroll\?(?:[^#\s]*&)?token=([A-Za-z0-9._~-]+)/i);
  return m ? { base: m[1], token: m[2] } : null;
}
async function httpJson(url) {
  if (typeof window !== 'undefined' && window.sphone && window.sphone.api) {
    const r = await window.sphone.api({ method: 'GET', url });   // por el main: evita CORS/TLS self-signed
    if (r && r.error) throw new Error(r.error);
    if (!r || r.status >= 400) throw new Error('HTTP ' + ((r && r.status) || '?'));
    return r.json;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
export async function resolveEnroll(text) {
  const e = parseEnroll(text);
  if (!e) return null;
  let last = null;
  for (const path of ['/backend/api/enroll/', '/api/enroll/']) {   // dashboard proxy o API directa
    try {
      const d = await httpJson(e.base + path + e.token);
      if (!d) continue;
      if (d.error) throw new Error(d.error === 'token expirado' ? 'El link de enrolamiento expiró. Pedí uno nuevo.' : d.error);
      if (d.prov_url) { const p = decodeProv(d.prov_url); if (p) return p; }
      if (d.ext) {                                                  // central vieja: armamos la config a mano
        const host = (d.server || e.base.replace(/^https?:\/\//, ''));
        return { transport: 'webrtc', domain: host, ext: String(d.ext), pass: String(d.password || ''),
                 wss: 'wss://' + host + '/ws', stun: 'stun:stun.l.google.com:19302' };
      }
    } catch (err) { last = err; }
  }
  throw last || new Error('No se pudo canjear el token de enrolamiento.');
}
