/* ============================================================================
 *  PBX-NG · Configuración SIP de la central (Configuración → SIP).
 *
 *  Lo que un operador espera tocar en una central "de marca" (Grandstream y cía.):
 *  NAT (IP externa, redes locales), rango RTP, STUN/ICE, temporizadores de sesión,
 *  User-Agent, keep-alive, TLS, códecs por defecto y la grabación global. En
 *  PBX-NG casi nada de eso vive en la base: pjsip.conf y rtp.conf están horneados en
 *  la imagen de Asterisk. Reconstruir la imagen para cambiar la IP pública no es
 *  aceptable, así que hacemos lo mismo que con el aparcado y la música en espera:
 *  los .conf base terminan con `#include "pbxng.d/{pjsip,rtp}.conf"` y ACÁ se
 *  generan esos archivos con secciones `(+)` (agregan opciones a las secciones ya
 *  definidas sin duplicarlas).
 *
 *  Todo se guarda en pbxng_settings bajo la clave `sipconf` (JSON), se regenera al
 *  arrancar la API (por si el volumen es nuevo) y se recarga por AMI. Los cambios de
 *  transporte (NAT, TLS) NO se aplican con reload — PJSIP no recarga transportes —
 *  así que el endpoint avisa y ofrece `core restart when convenient`.
 *
 *  Acceso: las rutas se registran DESPUÉS del gate de auth + RBAC de app.js; como
 *  `/api/sipconf` no figura en la tabla de rbac.js, es sólo admin (deny-by-default).
 * ==========================================================================*/
'use strict';

const KEY = 'sipconf';

/* Defaults = lo que hoy trae la imagen, para que activar el módulo no cambie nada. */
const DEFAULTS = {
  general: { user_agent: 'PBX-NG', keep_alive_interval: 30, max_forwards: 70, default_realm: '', timer_t1: 500, timer_b: 32000, contact_expiration_check_interval: 30 },
  nat: { external_media_address: '', external_signaling_address: '', local_net: [], tos_sip: 'cs3', tos_audio: 'ef' },
  rtp: { rtpstart: 10000, rtpend: 20000, strictrtp: 'yes', icesupport: 'yes', stunaddr: 'stun.l.google.com:19302', dtmftimeout: 3000, rtpchecksums: 'no' },
  timers: { timers: 'yes', timers_min_se: 90, timers_sess_expires: 1800 },
  tls: { method: 'tlsv1_2', cipher: '' },
  codecs: { audio: ['ulaw', 'alaw', 'g722'], video: ['vp8', 'h264'] },
};
const AUDIO_CODECS = ['ulaw', 'alaw', 'g722', 'opus', 'g729', 'gsm', 'g726', 'ilbc', 'speex', 'slin', 'slin16'];
const VIDEO_CODECS = ['vp8', 'vp9', 'h264', 'h263', 'h265'];

const clampInt = (v, min, max, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const yesno = (v, def) => (v === 'yes' || v === 'no' ? v : def);
const hostish = (v) => String(v || '').trim().replace(/[^\w.:\-]/g, '').slice(0, 120);
const cidr = (v) => { const s = String(v || '').trim(); return /^\d{1,3}(\.\d{1,3}){3}(\/(\d{1,2}|\d{1,3}(\.\d{1,3}){3}))?$/.test(s) ? s : null; };

module.exports = function initSipConf(deps) {
  const { app, pool, amiCommand, escribir, log } = deps;
  const L = log || ((...a) => console.log('[sipconf]', ...a));

  /* ---------- persistencia ---------- */
  async function load() {
    let saved = {};
    try { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [KEY]); if (rows[0] && rows[0].value) saved = JSON.parse(rows[0].value); } catch (_) {}
    const out = {};
    for (const sec of Object.keys(DEFAULTS)) out[sec] = { ...DEFAULTS[sec], ...(saved[sec] || {}) };
    return out;
  }
  async function save(cfg) {
    await pool.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [KEY, JSON.stringify(cfg)]);
  }
  /* Validación: nada llega a un .conf sin pasar por acá. Un `\n` en el user_agent
   * sería una línea nueva de configuración. */
  function sanitize(b, cur) {
    const g = b.general || {}, n = b.nat || {}, r = b.rtp || {}, t = b.timers || {}, s = b.tls || {}, c = b.codecs || {};
    const out = {
      general: {
        user_agent: String(g.user_agent ?? cur.general.user_agent).replace(/[\r\n;\[\]]/g, '').trim().slice(0, 80) || 'PBX-NG',
        keep_alive_interval: clampInt(g.keep_alive_interval ?? cur.general.keep_alive_interval, 0, 600, 30),
        max_forwards: clampInt(g.max_forwards ?? cur.general.max_forwards, 1, 255, 70),
        default_realm: hostish(g.default_realm ?? cur.general.default_realm),
        timer_t1: clampInt(g.timer_t1 ?? cur.general.timer_t1, 100, 5000, 500),
        timer_b: clampInt(g.timer_b ?? cur.general.timer_b, 1000, 120000, 32000),
        contact_expiration_check_interval: clampInt(g.contact_expiration_check_interval ?? cur.general.contact_expiration_check_interval, 5, 600, 30),
      },
      nat: {
        external_media_address: hostish(n.external_media_address ?? cur.nat.external_media_address),
        external_signaling_address: hostish(n.external_signaling_address ?? cur.nat.external_signaling_address),
        local_net: (Array.isArray(n.local_net) ? n.local_net : cur.nat.local_net).map(cidr).filter(Boolean).slice(0, 16),
        tos_sip: String(n.tos_sip ?? cur.nat.tos_sip).replace(/[^\w]/g, '').slice(0, 8),
        tos_audio: String(n.tos_audio ?? cur.nat.tos_audio).replace(/[^\w]/g, '').slice(0, 8),
      },
      rtp: {
        rtpstart: clampInt(r.rtpstart ?? cur.rtp.rtpstart, 1024, 65000, 10000),
        rtpend: clampInt(r.rtpend ?? cur.rtp.rtpend, 1025, 65535, 20000),
        strictrtp: ['yes', 'no', 'seqno'].includes(r.strictrtp) ? r.strictrtp : cur.rtp.strictrtp,
        icesupport: yesno(r.icesupport, cur.rtp.icesupport),
        stunaddr: hostish(r.stunaddr ?? cur.rtp.stunaddr),
        dtmftimeout: clampInt(r.dtmftimeout ?? cur.rtp.dtmftimeout, 100, 60000, 3000),
        rtpchecksums: yesno(r.rtpchecksums, cur.rtp.rtpchecksums),
      },
      timers: {
        timers: ['yes', 'no', 'required', 'always', 'forced'].includes(t.timers) ? t.timers : cur.timers.timers,
        timers_min_se: clampInt(t.timers_min_se ?? cur.timers.timers_min_se, 90, 86400, 90),
        timers_sess_expires: clampInt(t.timers_sess_expires ?? cur.timers.timers_sess_expires, 90, 86400, 1800),
      },
      tls: {
        method: ['tlsv1_2', 'tlsv1_3', 'sslv23', 'default'].includes(s.method) ? s.method : cur.tls.method,
        cipher: String(s.cipher ?? cur.tls.cipher).replace(/[^\w:!+\-@=]/g, '').slice(0, 200),
      },
      codecs: {
        audio: (Array.isArray(c.audio) ? c.audio : cur.codecs.audio).filter((x) => AUDIO_CODECS.includes(x)),
        video: (Array.isArray(c.video) ? c.video : cur.codecs.video).filter((x) => VIDEO_CODECS.includes(x)),
      },
    };
    if (out.rtp.rtpend <= out.rtp.rtpstart) throw Object.assign(new Error('el fin del rango RTP tiene que ser mayor que el inicio'), { status: 400 });
    if (out.timers.timers_sess_expires < out.timers.timers_min_se) throw Object.assign(new Error('Session-Expires no puede ser menor que Min-SE'), { status: 400 });
    if (!out.codecs.audio.length) out.codecs.audio = ['ulaw'];
    return out;
  }

  /* ---------- generación de los .conf ---------- */
  function renderPjsip(cfg) {
    const g = cfg.general, n = cfg.nat, t = cfg.tls;
    const out = ['; Generado por PBX-NG (Configuración → SIP). No editar a mano: se pisa.', '',
      '[global](+)',
      'user_agent=' + g.user_agent,
      'keep_alive_interval=' + g.keep_alive_interval,
      'max_forwards=' + g.max_forwards,
      'contact_expiration_check_interval=' + g.contact_expiration_check_interval,
    ];
    if (g.default_realm) out.push('default_realm=' + g.default_realm);
    out.push('', '[system](+)', 'timer_t1=' + g.timer_t1, 'timer_b=' + g.timer_b, '');
    // NAT: la misma IP pública y las mismas redes locales en todos los transportes.
    const natLines = [];
    if (n.external_media_address) natLines.push('external_media_address=' + n.external_media_address);
    if (n.external_signaling_address) natLines.push('external_signaling_address=' + n.external_signaling_address);
    for (const ln of n.local_net) natLines.push('local_net=' + ln);
    natLines.push('tos=' + n.tos_sip);
    for (const tr of ['transport-udp', 'transport-tcp', 'transport-tls', 'transport-ws']) out.push('[' + tr + '](+)', ...natLines, '');
    out.push('[transport-tls](+)', 'method=' + t.method);
    if (t.cipher) out.push('cipher=' + t.cipher);
    out.push('');
    return out.join('\n');
  }
  function renderRtp(cfg) {
    const r = cfg.rtp;
    return ['; Generado por PBX-NG (Configuración → SIP). No editar a mano: se pisa.', '', '[general](+)',
      'rtpstart=' + r.rtpstart, 'rtpend=' + r.rtpend, 'strictrtp=' + r.strictrtp, 'icesupport=' + r.icesupport,
      r.stunaddr ? 'stunaddr=' + r.stunaddr : '; stunaddr= (sin STUN)', 'dtmftimeout=' + r.dtmftimeout, 'rtpchecksums=' + r.rtpchecksums, ''].join('\n');
  }
  function write(cfg) {
    escribir('pjsip.conf', renderPjsip(cfg));
    escribir('rtp.conf', renderRtp(cfg));
  }
  async function reload() {
    // Lo que sí se recarga en caliente. Transportes (NAT/TLS) quedan para el reinicio.
    await amiCommand('module reload res_pjsip.so').catch(() => {});
    await amiCommand('module reload res_rtp_asterisk.so').catch(() => {});
  }
  /* ¿Qué cambió que sólo entra con reinicio? Se compara lo guardado antes y después. */
  function needsRestart(a, b) {
    const k = (c) => JSON.stringify([c.nat.external_media_address, c.nat.external_signaling_address, c.nat.local_net, c.nat.tos_sip, c.tls, c.rtp.rtpstart, c.rtp.rtpend]);
    return k(a) !== k(b);
  }

  /* Session timers y ToS de audio viven en cada endpoint (ps_endpoints), no en global:
   * se aplican a todos los internos y troncales de una vez, y los nuevos los heredan. */
  async function applyTimersToAll(cfg) {
    const t = cfg.timers;
    const { rowCount } = await pool.query('UPDATE ps_endpoints SET timers=$1, timers_min_se=$2, timers_sess_expires=$3', [t.timers, String(t.timers_min_se), String(t.timers_sess_expires)]);
    return rowCount;
  }
  async function applyTosToAll(cfg) {
    const { rowCount } = await pool.query('UPDATE ps_endpoints SET tos_audio=$1', [cfg.nat.tos_audio]);
    return rowCount;
  }
  /* Un endpoint recién creado hereda los temporizadores de sesión y el ToS de audio. */
  async function afterCreate(client, id) {
    try {
      const cfg = await load();
      await client.query('UPDATE ps_endpoints SET timers=$2, timers_min_se=$3, timers_sess_expires=$4, tos_audio=$5 WHERE id=$1', [String(id), cfg.timers.timers, String(cfg.timers.timers_min_se), String(cfg.timers.timers_sess_expires), cfg.nat.tos_audio]);
    } catch (e) { L('afterCreate', id, e.message); }
  }

  /* Transportes reales según Asterisk, para mostrar qué está escuchando. */
  async function transports() {
    const out = String((await amiCommand('pjsip show transports').catch(() => '')) || '');
    const rows = [];
    for (const line of out.split('\n')) {
      const m = /^\s*Transport:\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      if (m) rows.push({ id: m[1], protocol: m[2], bind: m[5] });
    }
    return rows;
  }

  /* ---------- rutas (sólo admin por rbac.js) ---------- */
  const wrap = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };

  app.get('/api/sipconf', wrap(async () => {
    const cfg = await load();
    let record_all = false;
    try { const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='record_all'"); record_all = !!(rows[0] && rows[0].value === '1'); } catch (_) {}
    return { ...cfg, record_all, transports: await transports(), options: { audio: AUDIO_CODECS, video: VIDEO_CODECS } };
  }));

  app.post('/api/sipconf', wrap(async (req) => {
    const cur = await load();
    const cfg = sanitize(req.body || {}, cur);
    await save(cfg);
    write(cfg);
    await reload();
    const restart = needsRestart(cur, cfg);
    let timers_applied = null;
    if (req.body && req.body.apply_timers) timers_applied = await applyTimersToAll(cfg);
    if (req.body && req.body.apply_tos) await applyTosToAll(cfg);
    L('guardado', restart ? '(requiere reinicio de Asterisk)' : '(recargado)');
    return { ok: true, restart_required: restart, timers_applied };
  }));

  /* Reinicio "cuando convenga": Asterisk espera a que no haya llamadas y se re-ejecuta.
   * En el contenedor el entrypoint hace exec, así que vuelve con la misma config. */
  app.post('/api/sipconf/restart', wrap(async (req) => {
    const now = !!(req.body && req.body.now);
    const out = await amiCommand(now ? 'core restart now' : 'core restart when convenient');
    return { ok: true, mode: now ? 'now' : 'when-convenient', out: String(out || '').trim().slice(0, 300) };
  }));

  /* Al arrancar: dejar los archivos como dice la base (volumen nuevo, restore, etc.). */
  async function ensure() {
    try { write(await load()); } catch (e) { L('no se pudo generar la config SIP:', e.message); }
  }

  /* Códecs por defecto para internos y troncales nuevos (los usa app.js). */
  async function defaultCodecs(video) {
    const cfg = await load();
    return (video ? cfg.codecs.audio.concat(cfg.codecs.video) : cfg.codecs.audio).join(',');
  }

  return { load, ensure, defaultCodecs, afterCreate, DEFAULTS };
};
