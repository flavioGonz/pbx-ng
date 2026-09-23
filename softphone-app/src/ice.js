// Probador ICE/TURN real: levanta una RTCPeerConnection y observa qué candidatos junta.
// relay > 0  => el TURN respondió Y autenticó (si las credenciales fueran malas, da 401 y no hay relay).
// srflx > 0  => el STUN funciona (y nos da la IP pública).
//
// ── DE DÓNDE SALEN LOS SERVIDORES ICE ───────────────────────────────────────────────
// De la CENTRAL, no de lo que quedó guardado acá.
//
// El softphone guardaba el TURN en su configuración local, escrito una vez por el QR de
// aprovisionamiento o a mano, y no lo volvía a mirar nunca. Eso funciona hasta el día en
// que la central cambia de relay —o le rotan la clave, o se pasa del TURN del SBC al
// coturn propio—: ahí el aparato sigue hablándole al servidor viejo con la credencial
// vieja. Visto en producción: un interno con `turn:sbc.infratec.com.uy:3478` y usuario
// `sbcng` guardados, contra una central que hace rato entrega su propio coturn. El
// síntoma es «TURN: auth falló (401)» y cero candidatos relay, o sea sin audio detrás de
// un NAT simétrico, mientras la central está perfecta.
//
// `GET /api/ice` de la central ya devuelve la lista armada —origen elegido en el panel,
// usuario y clave vigentes— y es pública justamente para esto. Así que:
//   1. se pide a la central y se usa eso;
//   2. si la central no contesta, se usa la última respuesta suya que guardamos (con su
//      fecha, para poder decir «esto es de hace tres días»);
//   3. y sólo si nunca hubo ninguna, se cae a lo que haya cargado a mano.
// Lo escrito a mano deja de ser la fuente y pasa a ser la red de emergencia, que es el
// orden correcto: la central sabe cuál es su relay, el aparato no.
import { iceDeLaCentral, getApiBase, baseFromWss } from './api.js';

const LS_ICE = 'sp_ice_central';
let _cache = null;            // { iceServers, origen, at }

function leerCache() {
  if (_cache) return _cache;
  try { const raw = localStorage.getItem(LS_ICE); if (raw) _cache = JSON.parse(raw); } catch { _cache = null; }
  return _cache;
}
function guardarCache(v) {
  _cache = v;
  try { localStorage.setItem(LS_ICE, JSON.stringify(v)); } catch {}
}

/* Dónde vive la central, mirando lo que haya: la sesión de API, el WSS del registro
 * WebRTC o, en última instancia, el dominio configurado. */
export function baseDeLaCentral(cfg) {
  const c = cfg || {};
  return getApiBase() || baseFromWss(c.wss || '') || (c.domain ? 'https://' + String(c.domain).replace(/^https?:\/\//, '') : '');
}

/* Pide la lista a la central y la guarda. Devuelve { ok, origen, n, error }. */
export async function refrescarIce(cfg) {
  const base = baseDeLaCentral(cfg);
  if (!base) return { ok: false, error: 'todavía no sé cuál es la central' };
  try {
    const j = await iceDeLaCentral(base);
    const lista = (j && Array.isArray(j.iceServers)) ? j.iceServers : [];
    /* Una respuesta sin un solo servidor NO se guarda: sería pisar una lista buena con
     * nada, y el aparato quedaría peor que antes de preguntar. */
    if (!lista.length) return { ok: false, error: (j && j.motivo) || 'la central no tiene relay configurado' };
    guardarCache({ iceServers: lista, origen: (j && j.origen) || '', at: Date.now() });
    return { ok: true, origen: (j && j.origen) || '', n: lista.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* Lo que hay cargado a mano, que ahora es sólo el plan C. */
function manual(cfg) {
  const list = [];
  const c = cfg || {};
  String(c.stun || '').split(',').map((s) => s.trim()).filter(Boolean)
    .forEach((u) => list.push({ urls: u.startsWith('stun:') ? u : 'stun:' + u }));
  if (c.turn && c.turnUser && c.turnPass) {
    const urls = String(c.turn).split(',').map((s) => s.trim()).filter(Boolean)
      .map((u) => (u.startsWith('turn:') || u.startsWith('turns:')) ? u : 'turn:' + u);
    if (!/transport=/i.test(String(c.turn))) urls.push(urls[0] + '?transport=tcp');
    list.push({ urls, username: c.turnUser, credential: c.turnPass });
  }
  return list;
}

/* La lista EFECTIVA, con su procedencia, para que la pantalla pueda decirlo. */
export function iceEfectivos(cfg) {
  const c = leerCache();
  if (c && Array.isArray(c.iceServers) && c.iceServers.length) {
    return { lista: c.iceServers, fuente: 'central', origen: c.origen || '', at: c.at || 0 };
  }
  const m = manual(cfg);
  return { lista: m, fuente: m.length ? 'manual' : 'ninguna', origen: '', at: 0 };
}

export function iceServersFrom(cfg) { return iceEfectivos(cfg).lista; }

export function testIce(cfg, timeoutMs = 7000) {
  const ef = iceEfectivos(cfg);
  const hayTurn = ef.lista.some((s) => String(Array.isArray(s.urls) ? s.urls[0] : s.urls || '').startsWith('turn'));
  const res = { state: 'testing', host: 0, srflx: 0, relay: 0, publicIp: '', relayIp: '', errors: [],
    turnConfigured: hayTurn, stunConfigured: ef.lista.some((s) => String(Array.isArray(s.urls) ? s.urls[0] : s.urls || '').startsWith('stun')),
    fuente: ef.fuente, origen: ef.origen, ms: 0 };
  const t0 = Date.now();
  return new Promise((resolve) => {
    let pc = null, finished = false;
    const finish = (state) => {
      if (finished) return; finished = true;
      res.state = state; res.ms = Date.now() - t0;
      try { pc && pc.close(); } catch (_) {}
      resolve(res);
    };
    try { pc = new RTCPeerConnection({ iceServers: ef.lista, iceTransportPolicy: 'all' }); }
    catch (e) { res.errors.push(String(e && e.message || e)); return finish('error'); }

    const tmr = setTimeout(() => finish(res.relay > 0 ? 'ok' : (res.turnConfigured ? 'turn-unreachable' : 'no-turn')), timeoutMs);

    pc.onicecandidate = (e) => {
      if (!e.candidate) { clearTimeout(tmr); return finish(res.relay > 0 ? 'ok' : (res.turnConfigured ? (res.errors.some(x => /401|403|unauthor/i.test(x)) ? 'turn-auth' : 'turn-unreachable') : 'no-turn')); }
      const c = e.candidate;
      const parts = String(c.candidate || '').split(' ');
      const typ = c.type || (String(c.candidate || '').match(/ typ (\w+)/) || [])[1];
      const addr = c.address || parts[4] || '';
      if (typ === 'host') res.host++;
      else if (typ === 'srflx') { res.srflx++; if (!res.publicIp) res.publicIp = addr; }
      else if (typ === 'relay') { res.relay++; if (!res.relayIp) res.relayIp = addr; }
    };
    pc.onicecandidateerror = (e) => {
      const code = e && (e.errorCode || e.errorcode);
      const txt = (e && (e.errorText || e.errortext)) || '';
      const url = (e && e.url) || '';
      if (code || txt) res.errors.push((code ? code + ' ' : '') + txt + (url ? ' (' + url + ')' : ''));
      if (code === 401 || code === 403) { clearTimeout(tmr); finish('turn-auth'); }
    };
    try {
      pc.createDataChannel('probe');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => { res.errors.push(String(e && e.message || e)); clearTimeout(tmr); finish('error'); });
    } catch (e) { res.errors.push(String(e && e.message || e)); clearTimeout(tmr); finish('error'); }
  });
}
