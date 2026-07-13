/* ============================================================================
 *  PBX-NG · Motor de alertas por correo
 *
 *  Reglas en `pbxng_alert_rules` (una fila por evento, con umbrales y destinatarios),
 *  historial en `pbxng_alerts`, memoria en `pbxng_alert_state`.
 *
 *  Principio de diseño: NO inundar. Un ataque real genera cientos de bans; si mandamos
 *  un mail por IP, la casilla se vuelve ruido y el aviso se ignora justo cuando importa.
 *  Por eso: throttling por evento + agrupacion (una alerta "estas bajo ataque" con el
 *  resumen, no N alertas).
 * ==========================================================================*/
'use strict';
const nodemailer = require('nodemailer');

let pool, deps = {};
const nowMin = () => Math.floor(Date.now() / 60000);

function init(_pool, _deps) {
  pool = _pool; deps = _deps || {};
  setInterval(() => { tick().catch((e) => console.error('[alerts]', e.message)); }, 60000);
  setTimeout(() => { tick().catch(() => {}); }, 30000);
  console.log('[alerts] motor activo');
}

// ---------------------------------------------------------------- infra
async function rule(event) {
  const { rows } = await pool.query('SELECT * FROM pbxng_alert_rules WHERE event=$1', [event]);
  return rows[0] || null;
}
async function getState(key, def = {}) {
  const { rows } = await pool.query('SELECT value FROM pbxng_alert_state WHERE key=$1', [key]);
  return rows[0] ? rows[0].value : def;
}
async function setState(key, value) {
  await pool.query(`INSERT INTO pbxng_alert_state (key,value,updated_at) VALUES ($1,$2,now())
    ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [key, JSON.stringify(value)]);
}
async function defaultTo() {
  const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='alert_to'");
  return (rows[0] && rows[0].value) || '';
}
async function smtp() {
  const { rows } = await pool.query('SELECT host,port,secure,username,password,from_addr,enabled FROM pbxng_email_config WHERE tenant_id=1');
  const c = rows[0];
  return (c && c.enabled && c.host) ? c : null;
}
async function brand() {
  const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='brand_name'");
  return (rows[0] && rows[0].value) || 'PBX-NG';
}

const COLOR = { info: '#2f80ff', warn: '#f59e0b', crit: '#ef4444' };
const LABEL = { info: 'Informativo', warn: 'Atención', crit: 'Crítico' };
function html({ brandName, severity, title, lines, foot }) {
  const esc = (t) => String(t == null ? '' : t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const c = COLOR[severity] || COLOR.info;
  const rows = (lines || []).map(([k, v]) => `<tr><td style="color:#667089;padding:5px 0;font-size:13px">${esc(k)}</td><td style="text-align:right;font-weight:600;font-size:13px">${esc(v)}</td></tr>`).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;max-width:560px;margin:0 auto;color:#0b1220">
    <div style="background:${c};color:#fff;padding:16px 22px;border-radius:14px 14px 0 0">
      <div style="font-size:11px;letter-spacing:.8px;opacity:.85;text-transform:uppercase">${esc(brandName)} · ${esc(LABEL[severity] || '')}</div>
      <div style="font-size:18px;font-weight:700;margin-top:3px">${esc(title)}</div>
    </div>
    <div style="border:1px solid #e3e8f0;border-top:none;border-radius:0 0 14px 14px;padding:18px 22px;background:#fff">
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      ${foot ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid #eef1f7;font-size:12px;color:#667089">${foot}</div>` : ''}
    </div>
  </div>`;
}

/** Dispara una alerta (respeta enabled + throttle). key = identidad para el throttle. */
async function raise(event, { severity = 'warn', title, lines = [], foot = '', key = '', force = false } = {}) {
  try {
    const r = await rule(event);
    if (!r) return false;
    if (!r.enabled && !force) return false;                 // force = prueba manual desde el panel
    const tk = 'throttle:' + event + (key ? ':' + key : '');
    const th = force ? 0 : Number(r.throttle_min || 0);
    if (th > 0) {
      const st = await getState(tk, {});
      if (st.at && nowMin() - st.at < th) return false;   // ya avisamos hace poco
    }
    const to = (r.recipients || '').trim() || await defaultTo();
    if (!to) return false;
    const cfg = await smtp();
    if (!cfg) return false;
    const brandName = await brand();
    const tx = nodemailer.createTransport({ host: cfg.host, port: cfg.port || 587, secure: !!cfg.secure, auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined });
    const subject = `[${brandName}] ${severity === 'crit' ? '🔴 ' : severity === 'warn' ? '🟠 ' : ''}${title}`;
    await tx.sendMail({
      from: cfg.from_addr || cfg.username, to, subject,
      html: html({ brandName, severity, title, lines, foot }),
      text: title + '\n\n' + lines.map(([k, v]) => k + ': ' + v).join('\n') + (foot ? '\n\n' + foot.replace(/<[^>]+>/g, '') : ''),
    });
    if (th > 0) await setState(tk, { at: nowMin() });
    await pool.query('INSERT INTO pbxng_alerts (event,severity,title,detail,to_addr,sent) VALUES ($1,$2,$3,$4,$5,true)',
      [event, severity, title, JSON.stringify(Object.fromEntries(lines)), to]);
    console.log('[alerts]', event, '->', to);
    return true;
  } catch (e) {
    console.error('[alerts] fallo', event, e.message);
    try { await pool.query('INSERT INTO pbxng_alerts (event,severity,title,detail,sent,err) VALUES ($1,$2,$3,$4,false,$5)', [event, severity, title || event, JSON.stringify({}), String(e.message).slice(0, 300)]); } catch (_) {}
    return false;
  }
}

// ---------------------------------------------------------------- eventos en caliente
/** Login al panel (lo llama /api/auth/login). */
async function onLogin({ ok, username, ip, ua, role }) {
  try {
    if (ok) {
      const r = await rule('auth.login');
      if (!r || !r.enabled) return;
      const onlyNew = (r.params || {}).only_new_ip !== false;
      const seen = await getState('login_ips', {});
      const known = seen[username] || [];
      const isNew = !known.includes(ip);
      if (isNew) { seen[username] = [...known, ip].slice(-20); await setState('login_ips', seen); }
      if (onlyNew && !isNew) return;                       // login de siempre: no molestamos
      const g = await geo(ip);
      await raise('auth.login', {
        severity: isNew ? 'warn' : 'info',
        title: isNew ? `Inicio de sesión desde una IP nueva: ${username}` : `Inicio de sesión: ${username}`,
        lines: [['Usuario', username + (role ? ' (' + role + ')' : '')], ['IP', ip], ['Origen', g], ['Navegador', ua || '—'], ['Fecha', new Date().toLocaleString('es-UY')]],
        foot: isNew ? 'Es la primera vez que este usuario entra desde esta IP. Si no fuiste vos, cambiá la contraseña.' : '',
        key: username + '|' + ip,
      });
    } else {
      const r = await rule('auth.login_failed');
      if (!r || !r.enabled) return;
      const p = r.params || {}; const win = Number(p.window_min || 10), need = Number(p.attempts || 3);
      const st = await getState('login_fails', {});
      const k = (username || '?') + '|' + ip;
      const arr = (st[k] || []).filter((t) => nowMin() - t < win);
      arr.push(nowMin()); st[k] = arr;
      await setState('login_fails', st);
      if (arr.length < need) return;
      const g = await geo(ip);
      await raise('auth.login_failed', {
        severity: 'crit',
        title: `${arr.length} intentos fallidos de acceso al panel`,
        lines: [['Usuario probado', username || '—'], ['IP', ip], ['Origen', g], ['Intentos', `${arr.length} en ${win} min`]],
        foot: 'Podría ser un intento de fuerza bruta contra el panel de administración.',
        key: k,
      });
    }
  } catch (e) { console.error('[alerts] onLogin', e.message); }
}

async function geo(ip) {
  try {
    if (!deps.geoLookup || !ip || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip)) return 'red interna';
    const g = await deps.geoLookup([ip]);
    const v = g && g[ip];
    return v ? [v.city, v.country, v.isp].filter(Boolean).join(' · ') : '—';
  } catch (_) { return '—'; }
}

// ---------------------------------------------------------------- chequeos periodicos
async function tick() {
  await checkSecurity();
  await checkTrunks();
  await checkServices();
  await checkFraud();
  await checkQueues();
  await checkDigest();
}

/** Bans nuevos + rafaga de intentos fallidos (una sola alerta agrupada). */
async function checkSecurity() {
  const { rows } = await pool.query('SELECT jail, banned, total_failed FROM pbxng_fail2ban');
  if (!rows.length) return;
  const nowBanned = [];
  let failed = 0;
  for (const j of rows) {
    failed += Number(j.total_failed || 0);
    const list = Array.isArray(j.banned) ? j.banned : [];
    for (const b of list) { const ip = typeof b === 'string' ? b : (b && (b.ip || b.address)); if (ip) nowBanned.push(ip); }
  }
  // 1) IPs recien baneadas
  const st = await getState('sec', { banned: [], failed: 0, failed_at: nowMin() });
  const fresh = nowBanned.filter((ip) => !(st.banned || []).includes(ip));
  if (fresh.length) {
    const g = deps.geoLookup ? await deps.geoLookup(fresh.slice(0, 20)).catch(() => ({})) : {};
    const lines = fresh.slice(0, 10).map((ip) => { const v = g[ip]; return [ip, v ? [v.country, v.isp].filter(Boolean).join(' · ') : '—']; });
    await raise('security.ban', {
      severity: fresh.length > 3 ? 'crit' : 'warn',
      title: fresh.length === 1 ? `IP bloqueada: ${fresh[0]}` : `${fresh.length} IPs bloqueadas por el firewall`,
      lines: [['Bloqueadas ahora', fresh.length], ['Total bloqueadas', nowBanned.length], ...lines],
      foot: 'Bloqueos automáticos de fail2ban sobre los intentos de registro SIP.',
    });
  }
  // 2) rafaga = "estas bajo ataque" (agrupada, no una por IP)
  const r = await rule('security.attack');
  if (r && r.enabled) {
    const p = r.params || {}; const win = Number(p.window_min || 10), need = Number(p.failed || 20);
    const prev = Number(st.failed || 0), prevAt = Number(st.failed_at || nowMin());
    const delta = failed - prev;
    if (nowMin() - prevAt >= win) {
      if (delta >= need) {
        await raise('security.attack', {
          severity: 'crit',
          title: `Ataque en curso: ${delta} intentos de registro fallidos en ${win} min`,
          lines: [['Intentos fallidos', delta], ['Ventana', win + ' min'], ['IPs bloqueadas', nowBanned.length], ['Acumulado', failed]],
          foot: 'Los intentos ya están siendo bloqueados por fail2ban. Si el volumen es alto y sostenido, conviene bloquear el país de origen o cerrar el SIP al WAN.',
        });
      }
      st.failed = failed; st.failed_at = nowMin();
    }
  }
  st.banned = nowBanned;
  await setState('sec', st);
}

/** Troncal caída / recuperada. */
async function checkTrunks() {
  const r = await rule('trunk.down');
  if (!r || !r.enabled || !deps.trunkHealth) return;
  let h = {};
  try { h = await deps.trunkHealth(); } catch (_) { return; }
  const st = await getState('trunks', {});
  for (const [name, v] of Object.entries(h || {})) {
    const up = v && v.status === 'online';
    const was = st[name];
    if (was === undefined) { st[name] = up; continue; }
    if (was && !up) {
      await raise('trunk.down', { severity: 'crit', title: `Troncal caída: ${name}`,
        lines: [['Troncal', name], ['Estado', 'NO responde'], ['Detalle', (v && v.detail) || '—'], ['Desde', new Date().toLocaleString('es-UY')]],
        foot: 'Mientras esté caída no entran ni salen llamadas por esta troncal.', key: name });
    } else if (!was && up) {
      await raise('trunk.down', { severity: 'info', title: `Troncal recuperada: ${name}`,
        lines: [['Troncal', name], ['Estado', 'Operativa de nuevo']], key: name + ':up' });
    }
    st[name] = up;
  }
  await setState('trunks', st);
}

/** Servicios del núcleo caídos (DB / ARI / AMI). */
async function checkServices() {
  const r = await rule('service.down');
  if (!r || !r.enabled) return;
  const cur = {};
  try { await pool.query('SELECT 1'); cur.db = true; } catch (_) { cur.db = false; }
  cur.ari = !!(deps.state && deps.state.ari);
  cur.ami = !!(deps.state && deps.state.ami);
  const st = await getState('svc', {});
  const NAME = { db: 'Base de datos', ari: 'Asterisk (ARI)', ami: 'Asterisk (AMI)' };
  for (const k of Object.keys(cur)) {
    const was = st[k];
    if (was === undefined) { st[k] = cur[k]; continue; }
    if (was && !cur[k]) await raise('service.down', { severity: 'crit', title: `Servicio caído: ${NAME[k]}`, lines: [['Componente', NAME[k]], ['Estado', 'sin conexión']], key: k });
    else if (!was && cur[k]) await raise('service.down', { severity: 'info', title: `Servicio recuperado: ${NAME[k]}`, lines: [['Componente', NAME[k]], ['Estado', 'operativo']], key: k + ':up' });
    st[k] = cur[k];
  }
  await setState('svc', st);
}

/** Antifraude: llamada larga, pico fuera de hora, internacionales. */
async function checkFraud() {
  // llamada saliente muy larga (en curso o recien terminada)
  const rl = await rule('fraud.long_call');
  if (rl && rl.enabled) {
    const min = Number((rl.params || {}).minutes || 30);
    const { rows } = await pool.query(
      `SELECT src, dst, billsec, start FROM cdr
        WHERE start > now() - interval '1 hour' AND billsec > $1 AND dcontext <> 'from-trunk'
        ORDER BY start DESC LIMIT 5`, [min * 60]);
    for (const c of rows) {
      await raise('fraud.long_call', { severity: 'warn', title: `Llamada saliente de ${Math.round(c.billsec / 60)} minutos`,
        lines: [['Interno', c.src], ['Destino', c.dst], ['Duración', Math.round(c.billsec / 60) + ' min'], ['Inicio', new Date(c.start).toLocaleString('es-UY')]],
        foot: 'Llamadas anormalmente largas suelen ser el primer síntoma de fraude telefónico.',
        key: c.src + '|' + c.dst + '|' + new Date(c.start).getTime() });
    }
  }
  // pico de salientes fuera de horario
  const ra = await rule('fraud.after_hours');
  if (ra && ra.enabled) {
    const p = ra.params || {};
    const from = Number(p.from_hour ?? 22), to = Number(p.to_hour ?? 6), win = Number(p.window_min || 30), need = Number(p.calls || 5);
    const h = new Date().getHours();
    const fuera = from > to ? (h >= from || h < to) : (h >= from && h < to);
    if (fuera) {
      const { rows } = await pool.query(
        `SELECT count(*)::int n FROM cdr WHERE start > now() - ($1 || ' minutes')::interval AND dcontext <> 'from-trunk'`, [String(win)]);
      const n = rows[0] ? rows[0].n : 0;
      if (n >= need) {
        await raise('fraud.after_hours', { severity: 'crit', title: `${n} llamadas salientes fuera de horario`,
          lines: [['Llamadas', n], ['Ventana', win + ' min'], ['Hora', new Date().toLocaleString('es-UY')]],
          foot: 'Patrón típico de fraude: ráfaga de salientes de madrugada. Revisá el CDR y, ante la duda, deshabilitá la salida internacional.' });
      }
    }
  }
  // destinos internacionales
  const ri = await rule('fraud.international');
  if (ri && ri.enabled) {
    const p = ri.params || {};
    const pref = String(p.prefixes || '00,+').split(',').map((x) => x.trim()).filter(Boolean);
    const allow = String(p.allow || '').split(',').map((x) => x.trim()).filter(Boolean);
    const { rows } = await pool.query(
      `SELECT src, dst, billsec, start FROM cdr WHERE start > now() - interval '5 minutes' AND dcontext <> 'from-trunk' ORDER BY start DESC LIMIT 20`);
    for (const c of rows) {
      const dst = String(c.dst || '');
      if (!pref.some((x) => dst.startsWith(x))) continue;
      if (allow.some((x) => dst.startsWith(x))) continue;
      await raise('fraud.international', { severity: 'warn', title: `Llamada internacional: ${dst}`,
        lines: [['Interno', c.src], ['Destino', dst], ['Duración', (c.billsec || 0) + ' s'], ['Inicio', new Date(c.start).toLocaleString('es-UY')]],
        key: c.src + '|' + dst });
    }
  }
}

/** Cola sin agentes conectados en horario laboral. */
async function checkQueues() {
  const r = await rule('queue.no_agents');
  if (!r || !r.enabled || !deps.getQueues) return;
  const p = r.params || {}; const from = Number(p.from_hour ?? 9), to = Number(p.to_hour ?? 18);
  const h = new Date().getHours(); const d = new Date().getDay();
  if (d === 0 || d === 6 || h < from || h >= to) return;
  let qs = [];
  try { qs = await deps.getQueues(); } catch (_) { return; }
  for (const q of qs) {
    if ((q.agents_online || 0) > 0) continue;
    await raise('queue.no_agents', { severity: 'warn', title: `Cola sin agentes: ${q.label || q.name}`,
      lines: [['Cola', q.label || q.name], ['Agentes conectados', 0], ['Agentes totales', q.agents_total || 0], ['Hora', new Date().toLocaleString('es-UY')]],
      foot: 'En horario laboral no hay nadie disponible para atender esta cola.', key: q.name });
  }
}

/** Resumen diario. */
async function checkDigest() {
  const r = await rule('digest.daily');
  if (!r || !r.enabled) return;
  const hour = Number((r.params || {}).hour ?? 8);
  const now = new Date();
  if (now.getHours() !== hour) return;
  const st = await getState('digest', {});
  const today = now.toISOString().slice(0, 10);
  if (st.day === today) return;
  await setState('digest', { day: today });

  const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
  const [tot] = await q(`SELECT count(*)::int total,
      count(*) FILTER (WHERE disposition='ANSWERED')::int answered,
      count(*) FILTER (WHERE disposition IN ('NO ANSWER','BUSY','FAILED','CONGESTION'))::int missed,
      COALESCE(round(avg(billsec) FILTER (WHERE disposition='ANSWERED'))::int,0) avg_talk,
      count(*) FILTER (WHERE dcontext='from-trunk')::int inbound
    FROM cdr WHERE start >= current_date - 1 AND start < current_date`);
  const top = await q(`SELECT src, count(*)::int n FROM cdr WHERE start >= current_date - 1 AND start < current_date AND dcontext <> 'from-trunk' GROUP BY src ORDER BY n DESC LIMIT 5`);
  const bans = await q(`SELECT coalesce(sum(total_banned),0)::int b, coalesce(sum(total_failed),0)::int f FROM pbxng_fail2ban`);
  const vm = await q(`SELECT count(*)::int n FROM pbxng_vm_sent WHERE sent_at >= current_date - 1 AND sent_at < current_date`);

  const t = tot || {};
  await raise('digest.daily', {
    severity: 'info',
    title: `Resumen de ayer · ${(t.total || 0)} llamadas`,
    lines: [
      ['Llamadas totales', t.total || 0],
      ['Atendidas', t.answered || 0],
      ['Perdidas', t.missed || 0],
      ['Entrantes', t.inbound || 0],
      ['Duración media', (t.avg_talk || 0) + ' s'],
      ['Mensajes de voz enviados', (vm[0] && vm[0].n) || 0],
      ['IPs bloqueadas (acumulado)', (bans[0] && bans[0].b) || 0],
      ['Intentos fallidos (acumulado)', (bans[0] && bans[0].f) || 0],
      ...top.map((x, i) => ['Top interno ' + (i + 1), (x.src || '—') + ' · ' + x.n + ' llamadas']),
    ],
    foot: 'Resumen automático de la central.',
  });
}

module.exports = { init, raise, onLogin, tick };
