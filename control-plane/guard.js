/* ============================================================================
 *  PBX-NG · Guardia de seguridad (el "SOC" de la central).
 *
 *  Es el clon funcional del centro de operaciones de SBC-NG, pero con Asterisk
 *  como fuente de verdad en vez de Kamailio. Hasta 1.5 la pantalla /seguridad
 *  mostraba jaulas de un fail2ban que ninguna imagen instalaba: el panel
 *  prometía un firewall que no existía. Desde acá:
 *
 *    - Asterisk cuenta lo que pasa por AMI (eventos de seguridad de res_security:
 *      `Event: ChallengeResponseFailed|InvalidAccountID|FailedACL|…|SuccessfulAuth`,
 *      con `Privilege: security,all`; clave mala, cuenta inexistente, ACL, pedidos no
 *      permitidos, límites de carga, y también los logins correctos). Cada evento se
 *      clasifica, entra a un buffer en vivo
 *      y se empuja al panel por socket.io (sala `security`).
 *    - Un contador por IP en ventana deslizante decide el baneo (ajustes en
 *      `pbxng_settings`, claves `sec_*`). La lista blanca (IP o CIDR) exime; las
 *      IPs privadas nunca se banean (un teléfono de la LAN con la clave vieja no
 *      puede dejar a la oficina sin central).
 *    - El bloqueo REAL lo hace nftables en el host, a través del agente HTTP de
 *      Asterisk (`/fw/ban`, `/fw/unban`, `/fw/sync`, `/fw/bans`). Acá vive la copia
 *      persistente (`pbxng_blocked`) y cada 5 min se le manda el set completo al
 *      agente: un reinicio del contenedor de Asterisk no pierde los bans.
 *    - Geo-bloqueo por país (`pbxng_geoblock`, modo bloquear/permitir): la primera
 *      señal desde un país vetado (aunque sea un login correcto) es ban permanente.
 *
 *  Todo lo que necesita de app.js llega por `deps` (patrón de callengine.js).
 * ==========================================================================*/
'use strict';

const { EventEmitter } = require('events');
const { errorHttp } = require('./errores');   // errores de pg → mensaje genérico (docs/CONTRATOS.md §3)

const MAX_BUFFER = 200;          // eventos en vivo que se guardan para `sec:hist` y GET /live
const ATAQUE_UMBRAL = 12;        // eventos de seguridad en 60 s para prender "bajo ataque" (mismo umbral que el SBC)
const REASON_GEO = 'país no permitido (geo-bloqueo)';
const REASON_BRUTE = 'fuerza bruta SIP';
const REASON_SCAN = 'escáner SIP (cuentas inexistentes)';
const REASON_FLOOD = 'límite de carga (flood)';
const REASON_MANUAL = 'baneo manual';

/* Ajustes por defecto (se pisan con `sec_<clave>` de pbxng_settings). Los tres
 * `unidentified_*` van a pjsip.conf: Asterisk corta por su cuenta a quien manda
 * pedidos que no matchean ningún endpoint. */
const DEFAULTS = {
  max_fallos: 5,             // fallos en la ventana antes de banear
  ventana_s: 60,             // ventana deslizante del contador
  ban_s: 3600,               // duración del ban temporal
  ban_permanente_tras: 3,    // baneos en 24 h que vuelven permanente el siguiente
  escaneres: true,           // banear a la primera a quien prueba cuentas inexistentes en serie
  unidentified_count: 5,
  unidentified_period: 60,
  unidentified_prune: 30,
  alertar: true,             // avisar por correo (alerts.js: security.ban / security.attack)
};
const ENTEROS = ['max_fallos', 'ventana_s', 'ban_s', 'ban_permanente_tras', 'unidentified_count', 'unidentified_period', 'unidentified_prune'];
const BOOLES = ['escaneres', 'alertar'];

/* Cómo se traduce cada SecurityEvent de Asterisk a un tipo del panel.
 *   fallo: cuenta contra la IP.   motivo: con qué texto se banea si desborda. */
const CLASES = {
  InvalidPassword:         { tipo: 'auth',    sev: 'warn', fallo: true,  motivo: REASON_BRUTE, texto: 'clave incorrecta' },
  ChallengeResponseFailed: { tipo: 'auth',    sev: 'warn', fallo: true,  motivo: REASON_BRUTE, texto: 'respuesta al desafío inválida' },
  InvalidAccountID:        { tipo: 'cuenta',  sev: 'warn', fallo: true,  motivo: REASON_BRUTE, texto: 'cuenta inexistente' },
  FailedACL:               { tipo: 'acl',     sev: 'warn', fallo: true,  motivo: REASON_BRUTE, texto: 'rechazado por ACL' },
  RequestNotAllowed:       { tipo: 'escaner', sev: 'warn', fallo: true,  motivo: REASON_SCAN,  texto: 'pedido no permitido' },
  RequestNotSupported:     { tipo: 'escaner', sev: 'warn', fallo: true,  motivo: REASON_SCAN,  texto: 'pedido no soportado' },
  RequestBadFormat:        { tipo: 'escaner', sev: 'warn', fallo: true,  motivo: REASON_SCAN,  texto: 'pedido mal formado' },
  UnexpectedAddress:       { tipo: 'escaner', sev: 'warn', fallo: true,  motivo: REASON_SCAN,  texto: 'dirección inesperada' },
  InvalidTransport:        { tipo: 'escaner', sev: 'warn', fallo: true,  motivo: REASON_SCAN,  texto: 'transporte inválido' },
  SessionLimit:            { tipo: 'flood',   sev: 'crit', fallo: true,  motivo: REASON_FLOOD, texto: 'límite de sesiones' },
  MemoryLimit:             { tipo: 'flood',   sev: 'crit', fallo: true,  motivo: REASON_FLOOD, texto: 'límite de memoria' },
  LoadAverageLimit:        { tipo: 'flood',   sev: 'crit', fallo: true,  motivo: REASON_FLOOD, texto: 'límite de carga' },
  SuccessfulAuth:          { tipo: 'ok',      sev: 'info', fallo: false, texto: 'autenticación correcta' },
  // ChallengeSent es el desafío normal de cada REGISTER: ruido puro, se ignora.
};
const TIPOS_ATAQUE = ['auth', 'cuenta', 'acl', 'escaner', 'flood', 'ban', 'geo'];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;
function esIpv4(ip) { const m = IPV4.exec(String(ip || '')); return !!m && m.slice(1).every((o) => +o <= 255); }
function esPrivada(ip) { return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip); }
function ip2n(ip) { return ip.split('.').reduce((a, o) => ((a << 8) + (+o)) >>> 0, 0); }
/* ¿`ip` está en `regla`? La regla es una IP suelta o un CIDR (lista blanca). */
function ipEn(ip, regla) {
  const r = String(regla || '').trim();
  if (!esIpv4(ip)) return false;
  if (esIpv4(r)) return ip === r;
  const m = CIDR.exec(r); if (!m || !esIpv4(m[1]) || +m[2] > 32) return false;
  const bits = +m[2]; if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip2n(ip) & mask) === (ip2n(m[1]) & mask);
}
/* "IPV4/UDP/1.2.3.4/5060" → { ip, proto, puerto }. Asterisk también manda "IPV6/..." (se ignora: nftables acá es sólo v4). */
function parseRemote(s) {
  const p = String(s || '').split('/');
  if (p.length >= 3 && p[0].toUpperCase() === 'IPV4' && esIpv4(p[2])) return { ip: p[2], proto: p[1], puerto: p[3] || '' };
  if (esIpv4(p[0])) return { ip: p[0], proto: '', puerto: '' };
  return null;
}
/* Bandera emoji desde el código de país (UY → 🇺🇾). */
function bandera(cc) {
  if (!cc || String(cc).length !== 2) return '';
  return String.fromCodePoint(...[...String(cc).toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
const limpiarCc = (v) => String(v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
const err = (status, msg) => { const e = new Error(msg); e.status = status; return e; };

module.exports = function initGuard(deps) {
  const { app, pool, ami, io, astFwd, escribir, alerts, geoLookup, amiCommand } = deps;
  const log = deps.log || require('./log')('guard');

  /* ---------- estado en memoria ---------- */
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const recientes = [];                       // buffer en vivo (últimos MAX_BUFFER)
  const porIp = new Map();                    // ip → { fallos: [t], cuentas: Map(cuenta → t), bans: [t], ultimo: t }
  const bloqueadas = new Map();               // ip → { permanent, expires } (espejo de pbxng_blocked para no consultar por evento)
  const pendientesHits = new Map();           // ip → n (golpes a IPs ya bloqueadas que siguen llegando: nft no está cortando)
  const pendientesFallos = new Map();         // ip → { n, tipos:{}, cuentas:Set, cc, pais, sev } (se vuelca a pbxng_sec_events cada 15 s)
  let settings = { ...DEFAULTS };
  let whitelist = [];                         // reglas (ip o CIDR) de pbxng_f2b_whitelist
  let geoblock = { paises: new Set(), modo: 'bloquear' };
  let enforcement = { nft: false, agente: false, motivo: 'todavía no se consultó al agente de Asterisk' };
  let ataqueAvisadoEn = 0;
  let formaLogueada = false;
  const timers = [];

  const ahora = () => Date.now();
  const podar = (arr, ventanaMs) => { const lim = ahora() - ventanaMs; while (arr.length && arr[0] < lim) arr.shift(); return arr; };
  const estadoIp = (ip) => { let s = porIp.get(ip); if (!s) { s = { fallos: [], cuentas: new Map(), bans: [], ultimo: 0 }; porIp.set(ip, s); } s.ultimo = ahora(); return s; };

  /* ---------- ajustes ---------- */
  async function cargarSettings() {
    const { rows } = await pool.query("SELECT key, value FROM pbxng_settings WHERE key LIKE 'sec\\_%'");
    const s = { ...DEFAULTS };
    for (const r of rows) {
      const k = r.key.slice(4);
      if (ENTEROS.includes(k)) { const n = parseInt(r.value, 10); if (Number.isFinite(n)) s[k] = n; }
      else if (BOOLES.includes(k)) s[k] = r.value !== '0';
    }
    settings = s;
    return s;
  }
  async function guardarSettings(b) {
    const s = { ...settings };
    for (const k of ENTEROS) if (b[k] !== undefined) {
      const n = parseInt(b[k], 10);
      if (!Number.isFinite(n) || n < 0 || n > 10000000) throw err(400, 'el valor de ' + k + ' no es válido');
      s[k] = n;
    }
    for (const k of BOOLES) if (b[k] !== undefined) s[k] = !!b[k] && b[k] !== '0' && b[k] !== 'false';
    if (s.max_fallos < 1) throw err(400, 'max_fallos tiene que ser al menos 1');
    if (s.ventana_s < 5) throw err(400, 'la ventana tiene que ser de al menos 5 segundos');
    if (s.ban_s < 0) throw err(400, 'ban_s no puede ser negativo (0 = permanente)');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const k of [...ENTEROS, ...BOOLES]) {
        const v = BOOLES.includes(k) ? (s[k] ? '1' : '0') : String(s[k]);
        await c.query('INSERT INTO pbxng_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['sec_' + k, v]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    settings = s;
    return s;
  }
  async function cargarWhitelist() {
    const { rows } = await pool.query('SELECT ip FROM pbxng_f2b_whitelist');
    whitelist = rows.map((r) => String(r.ip || '').trim()).filter(Boolean);
  }
  const enWhitelist = (ip) => whitelist.some((w) => ipEn(ip, w));
  async function cargarGeoblock() {
    const { rows } = await pool.query('SELECT cc FROM pbxng_geoblock');
    const { rows: m } = await pool.query("SELECT value FROM pbxng_settings WHERE key='sec_geoblock_modo'");
    geoblock = { paises: new Set(rows.map((r) => limpiarCc(r.cc)).filter((c) => c.length === 2)), modo: (m[0] && m[0].value) === 'permitir' ? 'permitir' : 'bloquear' };
  }
  /* ¿El país `cc` tiene prohibida la entrada según la lista vigente? Sin país
   * resuelto no se decide nada (ip-api caído no puede dejar afuera a un cliente). */
  function paisVetado(cc) {
    const c = limpiarCc(cc);
    if (!c) return false;
    if (geoblock.modo === 'permitir') return geoblock.paises.size > 0 && !geoblock.paises.has(c);
    return geoblock.paises.has(c);
  }
  async function cargarBloqueadas() {
    const { rows } = await pool.query('SELECT ip, permanent, extract(epoch from expires_at)*1000 AS exp FROM pbxng_blocked');
    bloqueadas.clear();
    for (const r of rows) bloqueadas.set(r.ip, { permanent: !!r.permanent, expires: r.exp ? +r.exp : null });
  }

  /* ---------- geo (reutiliza el cache de app.js) ---------- */
  const geoEnVuelo = new Map();               // ip → Promise (una ráfaga desde una IP nueva hace UNA consulta a ip-api, no N)
  function geo(ip) {
    if (!esIpv4(ip) || esPrivada(ip)) return Promise.resolve({ country: 'red local', cc: '', isp: '' });
    // Con el cache de app.js frío, N eventos del mismo chunk AMI disparaban N POST al batch
    // de ip-api (límite 15/min → 429 → fila sin país). Se comparte la promesa en vuelo.
    let p = geoEnVuelo.get(ip);
    if (p) return p;
    p = Promise.resolve()
      .then(() => geoLookup([ip]))
      .then((g) => (g && g[ip]) || { country: null, cc: null, isp: null }, () => ({ country: null, cc: null, isp: null }))
      .finally(() => geoEnVuelo.delete(ip));
    geoEnVuelo.set(ip, p);
    return p;
  }

  /* ---------- buffer en vivo + socket ---------- */
  function publicar(ev) {
    const e = { t: ev.t || ahora(), sev: ev.sev || 'info', tipo: ev.tipo || 'ok', ip: ev.ip || null, cuenta: ev.cuenta || null, texto: String(ev.texto || '').slice(0, 360) };
    // Los registros correctos de los teléfonos de la LAN (uno por interno cada minuto)
    // son ruido: enterrarían los 200 del buffer y harían refrescar el SOC sin parar.
    if (e.tipo === 'ok' && e.ip && esPrivada(e.ip)) return e;
    recientes.push(e); if (recientes.length > MAX_BUFFER) recientes.shift();
    bus.emit('ev', e);
    try { if (io) io.to('security').emit('sec:ev', e); } catch (_) {}
    return e;
  }
  const historial = () => recientes.slice(-MAX_BUFFER);

  async function evento(kind, severity, detail) {
    try { await pool.query('INSERT INTO pbxng_sec_events (kind, severity, detail) VALUES ($1, $2, $3)', [kind, severity, JSON.stringify(detail || {})]); }
    catch (e) { log.warn('no se pudo guardar el evento', { kind }, e); }
  }

  /* ---------- firewall (agente de Asterisk) ---------- */
  async function fw(path, body, ms) {
    const r = await astFwd(body === undefined ? 'GET' : 'POST', '/fw' + path, body, ms || 8000);
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error((j && (j.error || j.motivo)) || ('el agente respondió ' + r.status)); e.agente = r.status; throw e; }
    return j || {};
  }
  const segundosDe = (b) => (b.permanent || !b.expires) ? 0 : Math.max(1, Math.round((b.expires - ahora()) / 1000));
  /* Le manda al agente el set completo y lee cómo quedó. Es lo que mantiene coherente
   * nftables con la base tras un reinicio de Asterisk (o del host). */
  async function sincronizarFw() {
    try {
      const bans = [...bloqueadas.entries()].map(([ip, b]) => ({ ip, seconds: segundosDe(b) }));
      const s = await fw('/sync', { bans }, 15000);
      const estado = s && typeof s.enabled === 'boolean' ? s : await fw('/bans');
      const nft = !!(estado && estado.enabled);
      enforcement = { nft, agente: true, motivo: nft ? '' : String((estado && estado.error) || 'nftables no disponible en el host de Asterisk') };
    } catch (e) {
      // 503 = el agente contesta pero el host no tiene nft: distinto de "no hay agente".
      enforcement = e && e.agente === 503
        ? { nft: false, agente: true, motivo: String(e.message || 'nftables no disponible en el host de Asterisk') }
        : { nft: false, agente: false, motivo: 'sin respuesta del agente de Asterisk: ' + (e && e.message) };
      log.warn('sync con el firewall falló', { motivo: enforcement.motivo });
    }
    return enforcement;
  }

  /* ---------- bloquear / desbloquear ---------- */
  async function banear(ip, opt) {
    const o = opt || {};
    if (!esIpv4(ip)) throw err(400, 'IP inválida');
    // Nunca sobre la LAN, ni a mano: el agente lo rechaza igual (400) y un admin que se
    // bloquea la propia oficina no tiene forma de volver a entrar a sacarse el ban.
    if (esPrivada(ip)) { if (o.manual) throw err(400, 'no se bloquean direcciones privadas o de la propia red'); return null; }
    if (enWhitelist(ip)) { if (o.manual) throw err(409, 'esa IP está en la lista blanca: sacala primero'); return null; }
    // Ya bloqueada: sólo se vuelve a entrar a mano o para subirla a permanente (geo). En una
    // ráfaga (asterisk-manager emite en un bucle síncrono todos los eventos de un mismo chunk
    // TCP) los N procesar() llegan acá casi juntos: este chequeo y la marca de abajo tienen que
    // pasar ANTES del primer await, si no cada uno hace su INSERT, su /fw/ban y su correo, y la
    // IP alcanza `ban_permanente_tras` dentro de su primer bloqueo.
    if (bloqueadas.has(ip) && !o.manual && !o.permanent) return null;
    const st = estadoIp(ip);
    podar(st.bans, 24 * 3600000);
    const permanente = !!o.permanent || settings.ban_s === 0 || (settings.ban_permanente_tras > 0 && st.bans.length + 1 >= settings.ban_permanente_tras);
    const seconds = permanente ? 0 : settings.ban_s;
    const reason = o.reason || REASON_BRUTE;
    const previa = bloqueadas.get(ip) || null;   // para deshacer la marca si la base rechaza el INSERT
    bloqueadas.set(ip, { permanent: permanente, expires: permanente ? null : ahora() + seconds * 1000 });
    st.bans.push(ahora()); st.fallos = []; st.cuentas.clear();
    const g = o.geo || await geo(ip);
    let rows;
    try {
      ({ rows } = await pool.query(
      `INSERT INTO pbxng_blocked (ip, reason, country, cc, isp, hits, permanent, blocked_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, now(), CASE WHEN $7::int > 0 THEN now() + ($7::int || ' seconds')::interval ELSE NULL END)
       ON CONFLICT (ip) DO UPDATE SET
         reason = EXCLUDED.reason, hits = pbxng_blocked.hits + 1, blocked_at = now(),
         permanent = pbxng_blocked.permanent OR EXCLUDED.permanent,
         expires_at = CASE WHEN pbxng_blocked.permanent OR EXCLUDED.permanent THEN NULL ELSE EXCLUDED.expires_at END,
         country = COALESCE(pbxng_blocked.country, EXCLUDED.country), cc = COALESCE(pbxng_blocked.cc, EXCLUDED.cc), isp = COALESCE(pbxng_blocked.isp, EXCLUDED.isp)
       RETURNING ip, reason, hits, permanent, extract(epoch from expires_at)*1000 AS exp`,
      [ip, reason, g.country || null, g.cc || null, g.isp || null, permanente, seconds]));
    } catch (e) {
      if (previa) bloqueadas.set(ip, previa); else bloqueadas.delete(ip);
      st.bans.pop();
      throw e;
    }
    const fila = rows[0];
    // La base es la fuente de verdad (un ban previo permanente gana): se corrige la marca provisoria.
    bloqueadas.set(ip, { permanent: !!fila.permanent, expires: fila.exp ? +fila.exp : null });
    const detalle = { ip, pais: g.country || '?', cc: g.cc || '', isp: g.isp || '', motivo: reason, permanente: !!fila.permanent, segundos: fila.permanent ? 0 : seconds, hits: fila.hits, cuenta: o.cuenta || null, por: o.por || 'automático' };
    await evento('bloqueo', fila.permanent ? 'crit' : 'warn', detalle);
    publicar({ sev: 'crit', tipo: 'ban', ip, cuenta: o.cuenta || null, texto: (fila.permanent ? 'bloqueo permanente' : 'bloqueo ' + Math.round(seconds / 60) + ' min') + ' · ' + reason + (g.country ? ' · ' + g.country : '') });
    log.info('IP bloqueada', { ip, reason, permanente: !!fila.permanent, seconds, hits: fila.hits });
    try { await fw('/ban', { ip, seconds: fila.permanent ? 0 : seconds }); enforcement = { nft: true, agente: true, motivo: '' }; }
    catch (e) {
      // Un 400/401 del agente habla de ESTE pedido (IP rechazada, token), no del estado
      // de nftables: sólo un 503 o la falta de respuesta bajan el estado del firewall.
      if (!e || !e.agente || e.agente === 503) enforcement = { nft: false, agente: !!(e && e.agente), motivo: (e && e.agente ? '' : 'sin respuesta del agente de Asterisk: ') + (e && e.message) };
      log.warn('no se pudo aplicar el ban en nftables (queda en la base, se reintenta en el sync)', { ip }, e);
    }
    if (settings.alertar && alerts && alerts.raise) {
      alerts.raise('security.ban', {
        severity: fila.permanent ? 'crit' : 'warn',   // sin `key`: el throttle de la regla es global (bajo ataque hay decenas de bans por minuto)
        title: 'IP bloqueada: ' + ip + (fila.permanent ? ' (permanente)' : ''),
        lines: [['IP', ip], ['Motivo', reason], ['País', g.country || '—'], ['ISP', g.isp || '—'], ['Cuenta', o.cuenta || '—'], ['Duración', fila.permanent ? 'permanente' : Math.round(seconds / 60) + ' min'], ['Bloqueos de esta IP', fila.hits]],
        foot: enforcement.nft ? 'El bloqueo ya está aplicado en el firewall del host (nftables).' : 'ATENCIÓN: el firewall del host no confirmó el bloqueo (' + (enforcement.motivo || 'sin detalle') + ').',
      }).catch(() => {});
    }
    return fila;
  }
  async function desbloquear(ip, por) {
    if (!esIpv4(ip)) throw err(400, 'IP inválida');
    const { rowCount } = await pool.query('DELETE FROM pbxng_blocked WHERE ip=$1', [ip]);
    bloqueadas.delete(ip); porIp.delete(ip);
    try { await fw('/unban', { ip }); } catch (e) { log.warn('no se pudo sacar el ban de nftables (se corrige en el sync)', { ip }, e); }
    if (rowCount) {
      await evento('desbloqueo', 'info', { ip, motivo: por || 'desbloqueo manual' });
      publicar({ sev: 'info', tipo: 'ban', ip, texto: 'desbloqueada · ' + (por || 'manual') });
    }
    return rowCount > 0;
  }
  async function expirar() {
    const { rows } = await pool.query('DELETE FROM pbxng_blocked WHERE permanent = false AND expires_at IS NOT NULL AND expires_at < now() RETURNING ip');
    for (const r of rows) {
      bloqueadas.delete(r.ip);
      try { await fw('/unban', { ip: r.ip }); } catch (_) {}
      publicar({ sev: 'info', tipo: 'ban', ip: r.ip, texto: 'bloqueo vencido' });
    }
    if (rows.length) log.info('bloqueos vencidos', { n: rows.length });
    return rows.length;
  }

  /* ---------- clasificación y contador ----------
   *  `clasificar` es pura (para test): dado el SecurityEvent ya parseado y el estado
   *  de la IP, dice qué tipo es, si cuenta como fallo y si hay que banear. */
  function clasificar(nombre, ctx) {
    const c = CLASES[nombre];
    if (!c) return null;
    const st = ctx.estado; const s = ctx.settings || settings;
    const out = { tipo: c.tipo, sev: c.sev, fallo: c.fallo, texto: c.texto, banear: false, motivo: c.motivo || null };
    if (nombre === 'SuccessfulAuth') { st.fallos = []; st.cuentas.clear(); return out; }
    const t = ahora(); const ventana = s.ventana_s * 1000;
    if (nombre === 'InvalidAccountID' && ctx.cuenta) {
      for (const [k, v] of st.cuentas) if (t - v > ventana) st.cuentas.delete(k);
      st.cuentas.set(ctx.cuenta, t);
      // Tres cuentas distintas que no existen en la misma ventana no es un teléfono mal
      // configurado: es un escáner enumerando internos. Se corta a la primera si está activado.
      if (st.cuentas.size >= 3) { out.tipo = 'escaner'; out.sev = 'crit'; out.motivo = REASON_SCAN; out.texto = 'enumeración de cuentas (' + st.cuentas.size + ' distintas)'; if (s.escaneres) out.banear = true; }
    }
    if (c.fallo) {
      podar(st.fallos, ventana); st.fallos.push(t);
      if (st.fallos.length >= s.max_fallos) out.banear = true;
    }
    return out;
  }

  /* Agrega el fallo al lote que se vuelca a pbxng_sec_events (una fila por IP cada
   * 15 s, no una por intento: un ataque real son decenas por segundo). */
  function acumularFallo(ip, tipo, cuenta, sev, g) {
    let p = pendientesFallos.get(ip);
    if (!p) { p = { n: 0, tipos: {}, cuentas: new Set(), sev: 'warn', cc: g.cc || '', pais: g.country || '?' }; pendientesFallos.set(ip, p); }
    p.n++; p.tipos[tipo] = (p.tipos[tipo] || 0) + 1; if (cuenta && p.cuentas.size < 20) p.cuentas.add(cuenta); if (sev === 'crit') p.sev = 'crit';
  }
  async function volcarPendientes() {
    if (pendientesFallos.size) {
      const lote = [...pendientesFallos.entries()]; pendientesFallos.clear();
      for (const [ip, p] of lote) await evento('fallo', p.sev, { ip, n: p.n, tipos: p.tipos, cuentas: [...p.cuentas], cc: p.cc, pais: p.pais });
    }
    if (pendientesHits.size) {
      const lote = [...pendientesHits.entries()]; pendientesHits.clear();
      for (const [ip, n] of lote) await pool.query('UPDATE pbxng_blocked SET hits = hits + $2 WHERE ip=$1', [ip, n]).catch(() => {});
    }
  }

  /* Punto de entrada de cada SecurityEvent (ya normalizado). Exportado para test. */
  async function procesar(ev) {
    // `securityevent` lo pone engancharAmi(); `event` es la forma cruda de asterisk-manager
    // (el AMI real trae `Event: <NombreDelEventoDeSeguridad>`, ver engancharAmi).
    const nombre = ev.securityevent || ev.SecurityEvent || ev.event || ev.Event || '';
    if (!Object.prototype.hasOwnProperty.call(CLASES, nombre)) return null;
    const rem = parseRemote(ev.remoteaddress || ev.RemoteAddress);
    if (!rem) return null;
    const ip = rem.ip;
    const cuenta = String(ev.accountid || ev.AccountID || '').slice(0, 80) || null;
    const g = await geo(ip);
    const pais = g.country && g.country !== 'red local' ? ' · ' + g.country : '';

    // Ya bloqueada y sigue golpeando: nftables no la está cortando (o el ban es reciente).
    // Va DESPUÉS del await de geo(): en una ráfaga el primer evento banea (banear() marca
    // `bloqueadas` de forma síncrona) y los que venían detrás tienen que verlo acá.
    if (bloqueadas.has(ip)) {
      pendientesHits.set(ip, (pendientesHits.get(ip) || 0) + 1);
      publicar({ sev: 'warn', tipo: 'ban', ip, cuenta, texto: 'sigue golpeando estando bloqueada' + pais + (enforcement.nft ? '' : ' (firewall sin confirmar)') });
      return { tipo: 'ban', bloqueada: true };
    }
    if (enWhitelist(ip)) {
      const c = CLASES[nombre];
      publicar({ sev: c.fallo ? 'warn' : 'info', tipo: c.tipo, ip, cuenta, texto: c.texto + ' (lista blanca, no cuenta)' + pais });
      return { tipo: c.tipo, whitelist: true };
    }
    // Geo-bloqueo: la primera señal desde un país vetado alcanza, aunque sea un login correcto.
    if (!esPrivada(ip) && paisVetado(g.cc)) {
      publicar({ sev: 'crit', tipo: 'geo', ip, cuenta, texto: 'país vetado: ' + (g.country || g.cc) + ' (' + nombre + ')' });
      await banear(ip, { permanent: true, reason: REASON_GEO, geo: g, cuenta });
      return { tipo: 'geo', banear: true };
    }
    const st = estadoIp(ip);
    const r = clasificar(nombre, { estado: st, cuenta, settings });
    publicar({ sev: r.sev, tipo: r.tipo, ip, cuenta, texto: r.texto + (cuenta ? ' · cuenta ' + cuenta : '') + (rem.proto ? ' · ' + rem.proto : '') + pais + (esPrivada(ip) ? ' · red local' : '') });
    if (r.fallo) acumularFallo(ip, r.tipo, cuenta, r.sev, g);
    if (r.banear && !esPrivada(ip)) await banear(ip, { reason: r.motivo, geo: g, cuenta });
    return r;
  }

  /* ---------- ¿bajo ataque? (mismo criterio que soc.js) ---------- */
  function detectarAtaque() {
    const t = ahora();
    const rel = recientes.filter((e) => (t - e.t) <= 60000 && TIPOS_ATAQUE.includes(e.tipo));
    const cnt = {}; const porTipo = {};
    for (const e of rel) { if (e.ip) cnt[e.ip] = (cnt[e.ip] || 0) + 1; porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1; }
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    return { activo: rel.length >= ATAQUE_UMBRAL, golpes_min: rel.length, ips: Object.keys(cnt).length, top_ip: top ? top[0] : null, top_ip_golpes: top ? top[1] : 0, por_tipo: porTipo };
  }
  /* Cada 10 s: si el ritmo pasó el umbral, deja un evento 'ataque' en la línea de
   * tiempo y avisa por correo (una vez cada 10 min, no una por golpe). */
  async function vigilarAtaque() {
    const a = detectarAtaque();
    if (!a.activo || ahora() - ataqueAvisadoEn < 600000) return;
    ataqueAvisadoEn = ahora();
    await evento('ataque', 'crit', { golpes_min: a.golpes_min, ips: a.ips, top_ip: a.top_ip, top_ip_golpes: a.top_ip_golpes, por_tipo: a.por_tipo, motivo: a.golpes_min + ' golpes en 60 s desde ' + a.ips + ' IP(s)' });
    if (settings.alertar && alerts && alerts.raise) {
      alerts.raise('security.attack', {
        severity: 'crit', title: 'Ataque en curso: ' + a.golpes_min + ' eventos de seguridad en 60 s',
        lines: [['Golpes por minuto', a.golpes_min], ['IPs distintas', a.ips], ['IP más insistente', (a.top_ip || '—') + ' (' + a.top_ip_golpes + ')'], ['Bloqueadas en total', bloqueadas.size], ['Firewall', enforcement.nft ? 'nftables activo' : 'SIN firewall: ' + (enforcement.motivo || '')]],
        foot: 'Los bloqueos automáticos siguen corriendo. Si el volumen es alto y sostenido, conviene vetar el país de origen (Filtro por país) o cerrar el SIP al WAN.',
      }).catch(() => {});
    }
  }

  /* ---------- resumen para el panel (misma forma que soc.js + enforcement) ---------- */
  async function resumen() {
    const { rows: bloqueos } = await pool.query('SELECT ip, reason, country, cc, isp, hits, permanent, blocked_at, expires_at FROM pbxng_blocked ORDER BY blocked_at DESC LIMIT 500');
    const conBandera = bloqueos.map((b) => ({ ...b, cc: b.cc || null, flag: bandera(b.cc || '') }));
    const porPais = {};
    for (const b of conBandera) { const p = b.country || 'Desconocido'; porPais[p] = porPais[p] || { pais: p, cc: b.cc, flag: b.flag, n: 0 }; porPais[p].n++; }
    const topPaises = Object.values(porPais).sort((a, b) => b.n - a.n).slice(0, 12);
    const topAtacantes = [...conBandera].sort((a, b) => (b.hits || 0) - (a.hits || 0)).slice(0, 10);
    const { rows: eventos } = await pool.query("SELECT id, kind, severity, detail, created_at FROM pbxng_sec_events WHERE kind IN ('bloqueo','desbloqueo','ataque','geo','ajustes','motor') ORDER BY id DESC LIMIT 100");
    // Países vetados por el filtro geográfico. No son ataques: son un muro puesto a
    // propósito. El mapa los pinta distinto (sin arco, otro color) para que se
    // distinga "país que ataca ahora" de "país que decidimos no dejar entrar".
    const { rows: geoPaises } = await pool.query('SELECT cc, nombre FROM pbxng_geoblock ORDER BY nombre').catch(() => ({ rows: [] }));
    const { rows: geoModo } = await pool.query("SELECT value FROM pbxng_settings WHERE key='sec_geoblock_modo'").catch(() => ({ rows: [] }));
    const { rows: k } = await pool.query(`SELECT
        (SELECT count(*)::int FROM pbxng_sec_events WHERE kind='bloqueo' AND created_at > now() - interval '24 hours') AS ultimas_24h,
        (SELECT COALESCE(sum((detail->>'n')::int),0)::int FROM pbxng_sec_events WHERE kind='fallo' AND created_at > now() - interval '24 hours') AS fallos_24h`);
    return {
      kpis: { bloqueados: conBandera.length, permanentes: conBandera.filter((b) => b.permanent).length, ultimas_24h: (k[0] && k[0].ultimas_24h) || 0, paises: topPaises.length, fallos_24h: (k[0] && k[0].fallos_24h) || 0 },
      bloqueos: conBandera, top_paises: topPaises, top_atacantes: topAtacantes, eventos,
      ataque: detectarAtaque(),
      geoblock: { modo: (geoModo[0] && geoModo[0].value) === 'permitir' ? 'permitir' : 'bloquear', paises: geoPaises },
      enforcement: { ...enforcement },
    };
  }

  /* ---------- pjsip-security.conf ---------- */
  function renderPjsipSecurity(s) {
    return [
      '; Generado por PBX-NG (/seguridad → Ajustes). No editar a mano: se pisa al aplicar.',
      '; Asterisk corta por su cuenta a quien manda pedidos que no matchean ningún endpoint',
      '; (unidentified_request_*); el baneo por IP lo hace la API con nftables.',
      '[global](+)',
      'unidentified_request_count=' + Math.max(1, s.unidentified_count),
      'unidentified_request_period=' + Math.max(1, s.unidentified_period),
      'unidentified_request_prune_interval=' + Math.max(1, s.unidentified_prune),
      '',
    ].join('\n');
  }
  async function aplicarPjsip() {
    escribir('pjsip-security.conf', renderPjsipSecurity(settings));
    let out = '';
    try { out = await amiCommand('module reload res_pjsip.so'); } catch (e) { throw err(502, 'se escribió la configuración pero Asterisk no respondió al reload: ' + (e && e.message)); }
    return out;
  }
  /* Al arrancar: si el archivo no existe, lo crea con los defaults. pjsip.conf lo
   * incluye siempre, y un #include a un archivo inexistente es un warning en cada
   * reload que nadie quiere ver. Sin reload: app.js ya recarga res_pjsip a los 6 s. */
  function asegurarPjsip() {
    try { const fs = require('fs'); const p = require('path').join(require('./astconf').DIR, 'pjsip-security.conf'); if (!fs.existsSync(p)) escribir('pjsip-security.conf', renderPjsipSecurity(settings)); }
    catch (e) { log.warn('no se pudo escribir pjsip-security.conf', e); }
  }

  /* ---------- geo-bloqueo: aplicar sobre lo ya visto ---------- */
  async function aplicarGeoblock() {
    await cargarGeoblock();
    let desbloqueadas = 0, bloqueadasN = 0;
    // 1) las bloqueadas por geo cuyo país ya no está vetado se sueltan
    const { rows: geoRows } = await pool.query('SELECT ip, cc FROM pbxng_blocked WHERE reason=$1', [REASON_GEO]);
    for (const r of geoRows) if (!paisVetado(r.cc)) { await desbloquear(r.ip, 'el país ya no está vetado'); desbloqueadas++; }
    // 2) IPs vistas en las últimas 24 h (eventos de fallo) + bloqueadas por otro motivo: si su país está vetado, ban permanente
    const { rows: vistas } = await pool.query(`SELECT DISTINCT ip FROM (
        SELECT detail->>'ip' AS ip FROM pbxng_sec_events WHERE created_at > now() - interval '24 hours' AND detail ? 'ip'
        UNION SELECT ip FROM pbxng_blocked WHERE reason <> $1) x WHERE ip IS NOT NULL`, [REASON_GEO]);
    const ips = vistas.map((r) => r.ip).filter((ip) => esIpv4(ip) && !esPrivada(ip) && !enWhitelist(ip));
    let geos = {}; try { geos = await geoLookup(ips); } catch (_) {}
    for (const ip of ips) {
      const g = geos[ip]; if (!g || !paisVetado(g.cc)) continue;
      await banear(ip, { permanent: true, reason: REASON_GEO, geo: g, por: 'geo-bloqueo' }); bloqueadasN++;
    }
    await evento('geo', 'info', { motivo: 'geo-bloqueo aplicado (' + geoblock.modo + ', ' + geoblock.paises.size + ' países): ' + bloqueadasN + ' bloqueadas, ' + desbloqueadas + ' liberadas', paises: [...geoblock.paises], modo: geoblock.modo });
    return { ok: true, modo: geoblock.modo, paises: geoblock.paises.size, bloqueadas: bloqueadasN, desbloqueadas };
  }

  /* ---------- AMI ---------- */
  function engancharAmi() {
    if (!ami || !ami.on) return;
    ami.on('managerevent', (e) => {
      // Asterisk NO emite un evento llamado "SecurityEvent": main/security_events.c usa el
      // nombre del evento de seguridad como nombre del evento AMI (`Event: InvalidPassword`,
      // `Event: ChallengeResponseFailed`, `Event: SuccessfulAuth`…, con `Privilege: security,all`).
      // `SecurityEvent="..."` es el formato de security.log, no del AMI. asterisk-manager baja
      // las CLAVES a minúscula pero conserva los valores, así que `e.event` trae el nombre tal cual.
      const nombre = e && e.event;
      if (!nombre || !Object.prototype.hasOwnProperty.call(CLASES, nombre)) return;
      // Una vez, en debug: la forma real con la que asterisk-manager entrega el evento (claves en minúscula).
      if (!formaLogueada) { formaLogueada = true; log.debug('forma del evento de seguridad AMI', { ev: e }); }
      procesar({ ...e, securityevent: nombre }).catch((x) => log.error('procesando evento de seguridad', { nombre }, x));
    });
  }

  /* ---------- socket.io: sala 'security' ---------- */
  function unirSocket(s) {
    const u = s && s.user;
    if (!u || u.scope === 'phone' || !['admin', 'supervisor'].includes(u.role)) return false;
    s.join('security');
    s.emit('sec:hist', historial());
    return true;
  }

  /* ---------- rutas ---------- */
  if (app) {
    app.get('/api/security', async (req, res) => { try { res.json(await resumen()); } catch (e) { errorHttp(res, e); } });
    app.get('/api/security/live', (req, res) => res.json(historial()));
    app.get('/api/security/enforcement', async (req, res) => { try { res.json(await sincronizarFw()); } catch (e) { errorHttp(res, e); } });

    app.post('/api/security/block', async (req, res) => {
      const b = req.body || {}; const ip = String(b.ip || '').trim();
      try {
        if (!esIpv4(ip)) throw err(400, 'IP inválida');
        const fila = await banear(ip, { manual: true, permanent: b.permanent === undefined ? true : !!b.permanent, reason: String(b.reason || REASON_MANUAL).slice(0, 120), por: (req.user && req.user.username) || 'panel' });
        res.json({ ok: true, ip, permanent: !!(fila && fila.permanent) });
      } catch (e) { errorHttp(res, e); }
    });
    app.post('/api/security/unblock', async (req, res) => {
      const ip = String((req.body && req.body.ip) || '').trim();
      try { if (!esIpv4(ip)) throw err(400, 'IP inválida'); const habia = await desbloquear(ip, 'desbloqueo manual (' + ((req.user && req.user.username) || 'panel') + ')'); res.json({ ok: true, ip, habia }); }
      catch (e) { errorHttp(res, e); }
    });

    app.get('/api/security/settings', async (req, res) => { try { res.json(await cargarSettings()); } catch (e) { errorHttp(res, e); } });
    app.put('/api/security/settings', async (req, res) => {
      try {
        const s = await guardarSettings(req.body || {});
        await evento('ajustes', 'info', { motivo: 'ajustes de seguridad guardados', por: (req.user && req.user.username) || 'panel', ...s });
        res.json({ ...s, pendiente: 'aplicar para que Asterisk tome los límites unidentified_*' });
      } catch (e) { errorHttp(res, e); }
    });
    app.post('/api/security/apply', async (req, res) => {
      try { await cargarSettings(); const out = await aplicarPjsip(); await evento('motor', 'info', { motivo: 'pjsip-security.conf aplicado y res_pjsip recargado' }); res.json({ ok: true, output: String(out || '').slice(0, 2000) }); }
      catch (e) { errorHttp(res, e); }
    });

    // Lista blanca (IP o CIDR). Meter una IP también la desbloquea si estaba baneada.
    const validarRegla = (v) => { const r = String(v || '').trim(); if (esIpv4(r)) return r; const m = CIDR.exec(r); if (m && esIpv4(m[1]) && +m[2] <= 32) return r; throw err(400, 'tiene que ser una IP (1.2.3.4) o un rango CIDR (1.2.3.0/24)'); };
    app.get('/api/security/whitelist', async (req, res) => {
      try { const { rows } = await pool.query('SELECT ip, note, extract(epoch from created_at)::int AS created FROM pbxng_f2b_whitelist ORDER BY created_at'); res.json(rows); }
      catch (e) { errorHttp(res, e); }
    });
    app.post('/api/security/whitelist', async (req, res) => {
      const { ip, note } = req.body || {};
      try {
        const regla = validarRegla(ip);
        await pool.query('INSERT INTO pbxng_f2b_whitelist (ip, note) VALUES ($1, $2) ON CONFLICT (ip) DO UPDATE SET note = EXCLUDED.note', [regla, note ? String(note).slice(0, 200) : null]);
        await cargarWhitelist();
        if (esIpv4(regla) && bloqueadas.has(regla)) await desbloquear(regla, 'agregada a la lista blanca');
        res.json({ ok: true, ip: regla });
      } catch (e) { errorHttp(res, e); }
    });
    const quitarWl = async (req, res) => {
      const ip = String((req.body && req.body.ip) || req.query.ip || req.params.ip || '').trim();
      try { if (!ip) throw err(400, 'ip requerida'); await pool.query('DELETE FROM pbxng_f2b_whitelist WHERE ip=$1', [ip]); await cargarWhitelist(); res.json({ ok: true, ip }); }
      catch (e) { errorHttp(res, e); }
    };
    app.delete('/api/security/whitelist', quitarWl);
    app.delete('/api/security/whitelist/:ip', quitarWl);
    app.post('/api/security/whitelist/remove', quitarWl);   // compatibilidad con el panel viejo

    // Geo-bloqueo por país
    app.get('/api/security/geoblock', async (req, res) => {
      try { await cargarGeoblock(); const { rows } = await pool.query('SELECT cc, nombre, added_at FROM pbxng_geoblock ORDER BY cc'); res.json({ paises: rows, modo: geoblock.modo, geoip: true }); }
      catch (e) { errorHttp(res, e); }
    });
    app.put('/api/security/geoblock', async (req, res) => {
      const lista = Array.isArray(req.body && req.body.paises) ? req.body.paises : [];
      const modo = (req.body && req.body.modo) === 'permitir' ? 'permitir' : 'bloquear';
      const filas = lista.map((p) => ({ cc: limpiarCc(p && p.cc !== undefined ? p.cc : p), nombre: String((p && p.nombre) || '').slice(0, 80) })).filter((p) => p.cc.length === 2);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('DELETE FROM pbxng_geoblock');
        for (const p of filas) await c.query('INSERT INTO pbxng_geoblock (cc, nombre) VALUES ($1, $2) ON CONFLICT (cc) DO UPDATE SET nombre = EXCLUDED.nombre', [p.cc, p.nombre || p.cc]);
        await c.query("INSERT INTO pbxng_settings (key, value) VALUES ('sec_geoblock_modo', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [modo]);
        await c.query('COMMIT');
        await cargarGeoblock();
        res.json({ ok: true, total: filas.length, modo, pendiente: 'aplicar para revisar las IPs ya vistas' });
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); errorHttp(res, e); } finally { c.release(); }
    });
    /* "Banear país" desde el SOC: en modo bloquear se agrega; en modo permitir se
     * SACA de los permitidos (siempre significa "este país no entra"). Aplica al toque. */
    app.post('/api/security/geoblock/add', async (req, res) => {
      const cc = limpiarCc(req.body && req.body.cc); const nombre = String((req.body && req.body.nombre) || cc).slice(0, 80);
      try {
        if (cc.length !== 2) throw err(400, 'código de país inválido');
        await cargarGeoblock();
        if (geoblock.modo === 'permitir') await pool.query('DELETE FROM pbxng_geoblock WHERE cc=$1', [cc]);
        else await pool.query('INSERT INTO pbxng_geoblock (cc, nombre) VALUES ($1, $2) ON CONFLICT (cc) DO UPDATE SET nombre = EXCLUDED.nombre', [cc, nombre]);
        res.json(await aplicarGeoblock());
      } catch (e) { errorHttp(res, e); }
    });
    app.post('/api/security/geoblock/apply', async (req, res) => { try { res.json(await aplicarGeoblock()); } catch (e) { errorHttp(res, e); } });

    // Geolocalización de IPs sueltas (banderitas en otras pantallas): ?ips=1.2.3.4,5.6.7.8
    app.get('/api/ipgeo', async (req, res) => {
      try {
        const ips = String(req.query.ips || '').split(',').map((s) => s.trim()).filter(esIpv4).slice(0, 200);
        if (!ips.length) return res.json({});
        res.json(await geoLookup(ips));
      } catch (e) { errorHttp(res, e); }
    });
  }

  /* ---------- arranque ---------- */
  async function iniciar() {
    try { await cargarSettings(); await cargarWhitelist(); await cargarGeoblock(); await cargarBloqueadas(); }
    catch (e) { log.warn('no se pudo cargar el estado inicial (¿migración 0010 pendiente?)', e); }
    asegurarPjsip();
    engancharAmi();
    timers.push(setInterval(() => volcarPendientes().catch((e) => log.error('volcando eventos', e)), 15000));
    timers.push(setInterval(() => expirar().catch((e) => log.error('expirando bloqueos', e)), 60000));
    timers.push(setInterval(() => sincronizarFw().catch(() => {}), 300000));
    timers.push(setInterval(() => vigilarAtaque().catch((e) => log.error('vigilando ataque', e)), 10000));
    // la lista blanca y el geo-bloqueo se recargan cada minuto por si alguien los tocó por SQL
    timers.push(setInterval(() => Promise.all([cargarWhitelist(), cargarGeoblock()]).catch(() => {}), 60000));
    // poda: los fallos agregados se guardan 30 días; el resto de la línea de tiempo, 180
    timers.push(setInterval(() => pool.query("DELETE FROM pbxng_sec_events WHERE (kind='fallo' AND created_at < now() - interval '30 days') OR created_at < now() - interval '180 days'").catch(() => {}), 6 * 3600000));
    // memoria por IP: se olvida a quien no golpea hace 24 h
    timers.push(setInterval(() => { const lim = ahora() - 24 * 3600000; for (const [ip, s] of porIp) if (s.ultimo < lim) porIp.delete(ip); }, 600000));
    for (const t of timers) if (t.unref) t.unref();
    // el agente de Asterisk suele tardar más que la API en levantar: el primer sync espera un poco
    setTimeout(() => sincronizarFw().catch(() => {}), 8000).unref();
    log.info('guardia activa', { max_fallos: settings.max_fallos, ventana_s: settings.ventana_s, ban_s: settings.ban_s, whitelist: whitelist.length, geoblock: geoblock.paises.size, bloqueadas: bloqueadas.size });
  }
  function detener() { for (const t of timers) clearInterval(t); }

  return {
    iniciar, detener, unirSocket, resumen, detectarAtaque, procesar, clasificar, banear, desbloquear, expirar, sincronizarFw, aplicarGeoblock,
    recientes: historial, bus, bandera, esIpv4, esPrivada, ipEn, parseRemote,
    enforcement: () => ({ ...enforcement }), settings: () => ({ ...settings }),
    _cargar: { settings: cargarSettings, whitelist: cargarWhitelist, geoblock: cargarGeoblock, bloqueadas: cargarBloqueadas },
    _engancharAmi: engancharAmi,   // para test/guard.test.js (sin base no se puede llamar a iniciar())
  };
};
module.exports.CLASES = CLASES;
module.exports.DEFAULTS = DEFAULTS;
module.exports.ipEn = ipEn;
module.exports.parseRemote = parseRemote;
