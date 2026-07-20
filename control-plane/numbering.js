'use strict';
/* ============================================================================
 *  PBX-NG · Plan de numeración
 *
 *  Crear una extensión "a ojo" es la forma más fácil de romper una central: le
 *  ponés 3001 y resulta que 3001 era el número de acceso de una cola, o cae
 *  dentro de un patrón del dialplan, o pisa un código de función. El síntoma
 *  aparece días después y es imposible de rastrear.
 *
 *  Esto le da al panel dos cosas:
 *   - plan()   : qué numeración se está usando, qué está ocupado y por quién,
 *                y cuál es el próximo número libre (correlativo).
 *   - check(n) : si ese número se puede usar, y si no, exactamente por qué.
 * ==========================================================================*/

let pool;
function init(_pool) { pool = _pool; }

// Códigos de función del dialplan de fábrica. No se pueden usar como extensión.
const RESERVADOS = [
  { ext: '*43', label: 'Prueba de eco' },
  { ext: '*44', label: 'Prueba de audio' },
  { ext: '*65', label: 'Decir mi número' },
  { ext: '*97', label: 'Mi buzón de voz' },
  { ext: '*98', label: 'Buzón de otro' },
  { ext: '600', label: 'Prueba de eco (atajo)' },
  { ext: '601', label: 'Tono de prueba' },
];

const q = async (sql, args = []) => { try { const { rows } = await pool.query(sql, args); return rows; } catch (_) { return []; } };

// Todo lo que ya ocupa un número, con quién lo ocupa.
async function ocupados() {
  const out = [];
  const push = (ext, tipo, label) => { if (ext != null && String(ext).trim()) out.push({ ext: String(ext).trim(), tipo, label }); };

  for (const r of await q("SELECT id FROM ps_endpoints WHERE COALESCE(pbxng_kind,'extension')='extension'")) push(r.id, 'extension', 'Extensión');
  for (const r of await q('SELECT access_exten, label, name FROM pbxng_queues')) push(r.access_exten, 'cola', 'Cola ' + (r.label || r.name));
  for (const r of await q('SELECT exten, name FROM pbxng_ivr')) push(r.exten, 'ivr', 'IVR ' + (r.name || ''));
  for (const r of await q('SELECT access_exten, label, name FROM pbxng_conferences')) push(r.access_exten, 'conferencia', 'Conferencia ' + (r.label || r.name));
  for (const r of await q('SELECT access_exten, label, name FROM pbxng_ringgroups')) push(r.access_exten, 'grupo', 'Grupo de timbrado ' + (r.label || r.name));
  for (const r of await q('SELECT access_exten, label, name FROM pbxng_paging')) push(r.access_exten, 'voceo', 'Voceo ' + (r.label || r.name));
  for (const r of await q('SELECT exten, name FROM pbxng_ai_agents WHERE enabled')) push(r.exten, 'ia', 'Agente IA ' + (r.name || ''));
  for (const r of RESERVADOS) push(r.ext, 'reservado', r.label);

  // Dialplan a medida: números literales cargados en la tabla extensions (sin patrones).
  for (const r of await q("SELECT DISTINCT exten, context FROM extensions WHERE exten !~ '[_A-Za-z]'")) {
    if (!out.some(o => o.ext === String(r.exten))) push(r.exten, 'dialplan', 'Dialplan (contexto ' + r.context + ')');
  }
  return out;
}

// Patrones del dialplan que "atrapan" números (ej: _[1-9]XXX = cualquier número de 4 dígitos).
// Una extensión que caiga en un patrón de otro contexto no rompe nada por sí sola, pero un
// patrón de RUTA SALIENTE sí: si marcás 0 y el número, el 0 nunca puede ser una extensión.
async function patrones() {
  const out = [];
  for (const r of await q('SELECT pattern, name FROM pbxng_outbound_routes')) {
    const p = String(r.pattern || '').replace(/^_/, '');
    const m = p.match(/^(\d+)/);            // prefijo literal con el que arranca la ruta
    if (m) out.push({ prefijo: m[1], label: 'Ruta saliente ' + (r.name || p), patron: p });
  }
  return out;
}

const esNumero = (x) => /^\d+$/.test(String(x));

// Agrupa lo que ya existe en rangos "de 1000 en 1000" para mostrar el plan real.
function rangos(exts) {
  const nums = exts.filter(esNumero).map(Number).filter(n => n >= 100);
  const grupos = new Map();
  for (const n of nums) {
    const len = String(n).length;
    const base = Math.floor(n / Math.pow(10, len - 1)) * Math.pow(10, len - 1);
    const key = base + ':' + len;
    if (!grupos.has(key)) grupos.set(key, { desde: base, hasta: base + Math.pow(10, len - 1) - 1, digitos: len, usados: 0 });
    grupos.get(key).usados++;
  }
  return [...grupos.values()].sort((a, b) => b.usados - a.usados || a.desde - b.desde);
}

async function plan() {
  const oc = await ocupados();
  const pats = await patrones();
  const usados = new Set(oc.map(o => o.ext));
  const exts = oc.filter(o => o.tipo === 'extension').map(o => o.ext);
  const rgs = rangos(oc.map(o => o.ext));

  // El próximo libre sale del rango donde ya vivís (correlativo, no un número al azar).
  const principal = rangos(exts)[0] || rgs[0] || { desde: 1000, hasta: 1999, digitos: 4 };
  let next = null;
  for (let n = principal.desde; n <= principal.hasta; n++) {
    const s = String(n);
    if (usados.has(s)) continue;
    if (pats.some(p => s.startsWith(p.prefijo))) continue;
    next = s; break;
  }

  return {
    rangos: rgs.map(r => ({
      ...r,
      etiqueta: `${r.desde}–${r.hasta}`,
      libres: (r.hasta - r.desde + 1) - r.usados,
    })),
    principal: { desde: principal.desde, hasta: principal.hasta, digitos: principal.digitos },
    next,
    total_ocupados: oc.length,
    ocupados: oc.sort((a, b) => String(a.ext).localeCompare(String(b.ext), undefined, { numeric: true })),
    patrones: pats,
  };
}

// ¿Se puede usar este número? Si no, por qué exactamente.
async function check(ext, { ignorar } = {}) {
  const n = String(ext || '').trim();
  if (!n) return { ok: false, motivo: 'vacio', mensaje: 'Escribí un número de extensión.' };
  if (!/^\d{2,6}$/.test(n)) {
    return { ok: false, motivo: 'formato', mensaje: 'La extensión tiene que ser un número de 2 a 6 dígitos (sin espacios ni símbolos).' };
  }

  const oc = await ocupados();
  const hit = oc.find(o => o.ext === n && o.ext !== String(ignorar || ''));
  if (hit) {
    return {
      ok: false, motivo: hit.tipo,
      mensaje: hit.tipo === 'extension'
        ? `El número ${n} ya es una extensión.`
        : `El número ${n} ya está ocupado: ${hit.label}. Si lo usás, la central va a tener dos destinos para el mismo número y gana el que Asterisk encuentre primero.`,
      conflicto: hit,
    };
  }

  const pats = await patrones();
  const pat = pats.find(p => n.startsWith(p.prefijo));
  if (pat) {
    return {
      ok: false, motivo: 'ruta_saliente',
      mensaje: `El número ${n} empieza con ${pat.prefijo}, que es el prefijo de una ruta saliente (${pat.label}). Marcarlo intentaría salir a la calle en vez de llamar a la extensión.`,
      conflicto: pat,
    };
  }

  // Aviso (no bloquea): la extensión queda fuera del rango que venís usando.
  const exts = oc.filter(o => o.tipo === 'extension').map(o => o.ext);
  const principal = rangos(exts)[0];
  if (principal && (Number(n) < principal.desde || Number(n) > principal.hasta)) {
    return {
      ok: true, aviso: 'fuera_de_rango',
      mensaje: `Se puede usar, pero queda fuera del rango que venís usando (${principal.desde}–${principal.hasta}). Está bien si estás abriendo una numeración nueva a propósito.`,
    };
  }
  return { ok: true, mensaje: `El número ${n} está libre.` };
}

module.exports = { init, plan, check };
