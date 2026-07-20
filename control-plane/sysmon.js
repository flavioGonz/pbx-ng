'use strict';
/* ============================================================================
 *  PBX-NG · Estado del sistema (Resumen)
 *
 *  El panel mostraba solo los recursos del nodo donde corre la API. Pero una
 *  PBX-NG son varios nodos: el core (Asterisk + API + base), el borde (Kamailio,
 *  rtpengine, coturn) y —si esta encendido— el motor de voz. Esto los junta a
 *  todos en una sola foto: CPU, RAM, disco, uptime e interfaces de red de cada
 *  uno, mas el estado de cada servicio.
 *
 *  Cada nodo se consulta en paralelo y con timeout corto: si un agente no
 *  responde, el nodo sale marcado como caido y el resto igual se muestra.
 * ==========================================================================*/
const os = require('os');
const fsx = require('fs');

let pool, NODES = {}, state = {}, AGENT_TOKEN = '';

function init(_pool, opts = {}) {
  pool = _pool;
  NODES = opts.nodes || {};
  state = opts.state || {};
  AGENT_TOKEN = opts.token || '';
}

// Placas reales: fuera los bridges de docker, los veth y los pseudo-dispositivos.
const REAL_IF = (i) => i && i.name && !/^(docker|br-|veth|virbr|lxcbr|tap|bonding)/.test(i.name);

async function get(url, ms = 3500) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'X-PBXNG-Token': AGENT_TOKEN } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// --- CPU del proceso local (delta entre llamadas, como hace top) ---
let prev = null;
function cpuLocal() {
  const cs = os.cpus();
  let idle = 0, tot = 0;
  for (const c of cs) { for (const k in c.times) tot += c.times[k]; idle += c.times.idle; }
  let p = 0;
  if (prev) { const dt = tot - prev.tot, di = idle - prev.idle; p = dt > 0 ? Math.round((1 - di / dt) * 100) : 0; }
  prev = { tot, idle };
  return Math.max(0, Math.min(100, p));
}

function diskOf(path) {
  try {
    const st = fsx.statfsSync(path);
    const total = st.blocks * st.bsize, free = st.bfree * st.bsize;
    return { total, free, used: total - free, pct: total ? Math.round(((total - free) * 100) / total) : 0 };
  } catch (_) { return null; }
}

// Tamaño ocupado por un directorio (grabaciones, buzón): recorrido plano, sin recursión profunda.
function sizeOf(dir) {
  try {
    let bytes = 0, files = 0;
    const walk = (d, depth) => {
      if (depth > 3) return;
      for (const e of fsx.readdirSync(d, { withFileTypes: true })) {
        const p = d + '/' + e.name;
        if (e.isDirectory()) walk(p, depth + 1);
        else { try { bytes += fsx.statSync(p).size; files++; } catch (_) {} }
      }
    };
    walk(dir, 0);
    return { bytes, files };
  } catch (_) { return null; }
}

function nodeLocal() {
  const tm = os.totalmem(), fm = os.freemem();
  const ifaces = [];
  const nis = os.networkInterfaces();
  for (const name of Object.keys(nis)) {
    if (name === 'lo') continue;
    const addrs = (nis[name] || []).filter((a) => a.family === 'IPv4').map((a) => a.address + '/' + (a.cidr || '').split('/')[1]);
    if (addrs.length) ifaces.push({ name, state: 'UP', addrs, mac: (nis[name][0] || {}).mac });
  }
  return {
    ok: true,
    cpu_pct: cpuLocal(),
    ncpu: os.cpus().length,
    load: os.loadavg()[0],
    mem_total_mb: Math.round(tm / 1048576),
    mem_used_mb: Math.round((tm - fm) / 1048576),
    mem_pct: Math.round(((tm - fm) * 100) / tm),
    uptime_s: Math.round(os.uptime()),
    disk: diskOf('/'),
    ifaces: ifaces.filter(REAL_IF),
  };
}

function fromAgent(core, net) {
  const m = (core && core.metrics) || {};
  const disk = m.disk_total
    ? { total: m.disk_total, used: m.disk_used, free: m.disk_free, pct: m.disk_pct }
    : null;
  return {
    ok: true,
    cpu_pct: m.cpu_pct != null ? m.cpu_pct : (m.load != null && m.ncpu ? Math.round((m.load * 100) / m.ncpu) : null),
    ncpu: m.ncpu || null,
    load: m.load != null ? m.load : null,
    mem_total_mb: m.mem_total_mb || null,
    mem_used_mb: m.mem_used_mb || null,
    mem_pct: m.mem_pct != null ? m.mem_pct : null,
    uptime_s: m.uptime_s || null,
    disk,
    ifaces: ((net && net.ifaces) || []).filter(REAL_IF),
  };
}

async function overview() {
  const astUrl = process.env.AST_AGENT || (NODES.asterisk ? 'http://' + NODES.asterisk + ':8092' : null);
  const turnUrl = process.env.TURN_AGENT || (NODES.turn || NODES.sbc ? 'http://' + (NODES.turn || NODES.sbc) + ':8091' : null);
  const vozUrl = NODES.voz ? 'http://' + NODES.voz + ':8080' : null;

  const [ast, astNet, edge, edgeNet, voz] = await Promise.all([
    astUrl ? get(astUrl + '/core').catch(() => null) : null,
    astUrl ? get(astUrl + '/net').catch(() => null) : null,
    turnUrl ? get(turnUrl + '/core').catch(() => null) : null,
    turnUrl ? get(turnUrl + '/net').catch(() => null) : null,
    vozUrl ? get(vozUrl + '/health').catch(() => null) : null,
  ]);

  // Base de datos: tamaño y conexiones
  let db = { ok: false };
  try {
    const { rows } = await pool.query(
      "SELECT pg_database_size(current_database()) AS bytes, (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()) AS conns, (SELECT count(*) FROM cdr) AS cdr");
    db = { ok: true, bytes: Number(rows[0].bytes), conns: Number(rows[0].conns), cdr: Number(rows[0].cdr) };
  } catch (e) { db = { ok: false, error: e.message }; }

  const nodes = [
    {
      id: 'core', name: 'Núcleo · API y base', role: 'core',
      host: NODES.asterisk || os.hostname(),
      services: ['api', 'postgres', 'redis', 'dashboard'],
      ...nodeLocal(),
    },
  ];

  if (astUrl) {
    nodes.push({
      id: 'asterisk', name: 'Asterisk', role: 'core', host: NODES.asterisk,
      services: ['asterisk'],
      version: (ast && ast.version) || null,
      channels: (ast && ast.channels) != null ? ast.channels : null,
      ...(ast ? fromAgent(ast, astNet) : { ok: false, ifaces: [] }),
    });
  }
  // Nodo "borde" (SBC + rtpengine + coturn incrustados): SOLO se muestra si su
  // agente responde. Desde que el SBC es un producto aparte (SBC-NG, nodo externo),
  // el borde incrustado ya no existe en la mayoría de las instalaciones — y un host
  // muerto no debe ensuciar el Resumen con un "sin respuesta" permanente. Si algún
  // día vuelve a haber un borde local con su agente, reaparece solo.
  if (turnUrl && edge) {
    nodes.push({
      id: 'edge', name: 'Borde · SBC, rtpengine y TURN', role: 'edge',
      host: NODES.turn || NODES.sbc,
      services: ['kamailio', 'rtpengine', 'coturn'],
      ...fromAgent(edge, edgeNet),
    });
  }
  if (vozUrl && voz) {
    const m = (voz && voz.metrics) || {};
    nodes.push({
      id: 'voz', name: 'Motor de voz (IA)', role: 'ai', host: NODES.voz,
      services: ['tts', 'whisper'],
      ok: true, cpu_pct: m.cpu_pct != null ? m.cpu_pct : null, ncpu: m.ncpu || null, load: m.load || null,
      mem_total_mb: m.mem_total_mb || null, mem_used_mb: m.mem_used_mb || null, mem_pct: m.mem_pct != null ? m.mem_pct : null,
      uptime_s: m.uptime_s || null, disk: null, ifaces: [],
    });
  }

  const storage = {
    disk: diskOf('/'),
    recordings: sizeOf(process.env.REC_DIR || '/recordings'),
    voicemail: sizeOf(process.env.VM_DIR || '/voicemail'),
    db,
  };

  const services = [
    { id: 'api', label: 'API (control-plane)', ok: true, node: 'core' },
    { id: 'postgres', label: 'PostgreSQL', ok: db.ok, node: 'core' },
    { id: 'asterisk', label: 'Asterisk', ok: !!(state.ami || state.ari) || !!ast, node: 'asterisk', detail: state.ami ? 'AMI y ARI conectados' : 'sin AMI' },
    // Los servicios del borde solo se listan si hay un borde local respondiendo (SBC-NG es externo).
    ...(edge ? [
      { id: 'kamailio', label: 'SBC · Kamailio', ok: true, node: 'edge' },
      { id: 'rtpengine', label: 'rtpengine', ok: true, node: 'edge' },
      { id: 'coturn', label: 'TURN · coturn', ok: true, node: 'edge' },
    ] : []),
    { id: 'voz', label: 'Motor de voz (IA)', ok: !!voz, node: 'voz', optional: true },
  ];

  return { ts: Date.now(), nodes, storage, services };
}

module.exports = { init, overview };
