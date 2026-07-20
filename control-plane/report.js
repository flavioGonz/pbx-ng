'use strict';
// Informe ejecutivo de historial de llamadas (CDR) -> HTML A4 listo para imprimir/guardar como PDF.
// No usa librerias externas: los graficos son SVG generados a mano.

let pool = null;
function init(p) { pool = p; }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const fLargo = (d) => `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
const fCorto = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
const fHora = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return h ? `${h}h ${m}m` : m ? `${m}m ${ss}s` : `${ss}s`; };
const pct = (a, b) => (b ? Math.round((a * 100) / b) : 0);

const DISP = { ANSWERED: 'Atendida', 'NO ANSWER': 'Sin respuesta', BUSY: 'Ocupado', FAILED: 'Fallida', CONGESTION: 'Congestión' };
const TIPOS = { inbound: 'Entrante', outbound: 'Saliente', internal: 'Interna', ivr: 'IVR', ia: 'Agente IA', other: 'Otra' };
const COL = { inbound: '#2f80ff', outbound: '#a855f7', internal: '#64748b', ivr: '#f59e0b', ia: '#ec4899', other: '#94a3b8' };

// Misma clasificacion que usa el panel de Historial, para que los numeros coincidan.
function clasificar(r, internos) {
  const la = (r.lastapp || '').toLowerCase();
  const chans = ((r.channel || '') + ' ' + (r.dstchannel || '')).toLowerCase();
  const dc = (r.dcontext || '').toLowerCase();
  const src = String(r.src || ''), dst = String(r.dst || '');
  if (la === 'stasis' || chans.includes('audiosocket') || dc.includes('ai') || dc.includes('c2c')) return 'ia';
  if (dc.includes('ivr') || /^7[0-9]{3}$/.test(dst)) return 'ivr';
  const sInt = internos.has(src), dInt = internos.has(dst);
  const dstLong = dst.replace(/[^0-9]/g, '').length >= 6, srcLong = src.replace(/[^0-9]/g, '').length >= 6;
  if (dc.includes('trunk') || (!sInt && dInt) || (!sInt && srcLong && dInt)) return 'inbound';
  if (sInt && !dInt && dstLong) return 'outbound';
  if (sInt || dInt) return 'internal';
  return 'other';
}
const nombreClid = (clid) => { const m = (clid || '').match(/"?([^"<]*)"?\s*</); const n = (m && m[1] || '').trim(); return n && !/^\d+$/.test(n) ? n : ''; };

/* ─────────────── graficos (SVG a mano) ─────────────── */
function barras(datos, { w = 700, h = 190, color = '#2f80ff', sufijo = '' } = {}) {
  if (!datos.length) return '<p class="vacio">Sin datos en el período.</p>';
  const max = Math.max(1, ...datos.map(d => d.v));
  const pl = 34, pb = 22, pt = 14;
  const bw = (w - pl) / datos.length;
  const gr = [0, 0.5, 1].map(f => { const y = pt + (h - pt - pb) * (1 - f); return `<line x1="${pl}" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}" class="grid"/><text x="${pl - 6}" y="${(y + 3).toFixed(1)}" class="ax" text-anchor="end">${Math.round(max * f)}</text>`; }).join('');
  const bs = datos.map((d, i) => {
    const bh = ((h - pt - pb) * d.v) / max;
    const x = pl + i * bw + bw * 0.18, y = h - pb - bh, ww = bw * 0.64;
    const et = datos.length <= 26 || i % Math.ceil(datos.length / 16) === 0
      ? `<text x="${(x + ww / 2).toFixed(1)}" y="${h - 7}" class="ax" text-anchor="middle">${esc(d.l)}</text>` : '';
    const vt = d.v > 0 && datos.length <= 20 ? `<text x="${(x + ww / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" class="val" text-anchor="middle">${d.v}${sufijo}</text>` : '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${ww.toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" rx="3" fill="${color}"/>${vt}${et}`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="chart">${gr}${bs}</svg>`;
}

function dona(partes, { size = 168 } = {}) {
  const tot = partes.reduce((a, p) => a + p.v, 0) || 1;
  const r = 62, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  let off = 0;
  const segs = partes.filter(p => p.v > 0).map(p => {
    const len = (p.v / tot) * C;
    const s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.c}" stroke-width="22" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += len; return s;
  }).join('');
  const leg = partes.map(p => `<div class="lg"><i style="background:${p.c}"></i><span>${esc(p.l)}</span><b>${p.v}</b><em>${pct(p.v, tot)}%</em></div>`).join('');
  return `<div class="donut"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${segs}<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="dn">${tot}</text><text x="${cx}" y="${cy + 14}" text-anchor="middle" class="ds">llamadas</text></svg><div class="legend">${leg}</div></div>`;
}

/* ─────────────── informe ─────────────── */
async function build({ from, to, tipo, q, usuario }) {
  const desde = from ? new Date(from + 'T00:00:00') : new Date(Date.now() - 29 * 864e5);
  const hasta = to ? new Date(to + 'T23:59:59') : new Date();

  const brand = {};
  try {
    const { rows } = await pool.query("SELECT key,value FROM pbxng_settings WHERE key IN ('brand_name','brand_subtitle','brand_tagline','brand_logo')");
    for (const r of rows) brand[r.key.replace('brand_', '')] = r.value;
  } catch (_) {}
  const marca = brand.name || 'PBX-NG';
  const sub = brand.subtitle || 'Comunicaciones unificadas';

  let internos = new Set();
  try { const { rows } = await pool.query('SELECT id FROM ps_endpoints'); internos = new Set(rows.map(r => String(r.id))); } catch (_) {}

  const { rows } = await pool.query(
    'SELECT start, clid, src, dst, dcontext, duration, billsec, disposition, channel, dstchannel, lastapp FROM cdr WHERE start >= $1 AND start <= $2 ORDER BY start DESC',
    [desde, hasta]);

  // Grabaciones del periodo: se cruzan con cada llamada por extension y proximidad de tiempo,
  // igual que en el panel de Historial, para poder decir si tenemos el audio o no.
  let recs = [];
  try {
    const qr = await pool.query(
      'SELECT id, ext, started_at, duration FROM pbxng_recordings WHERE deleted=false AND started_at >= $1 AND started_at <= $2',
      [new Date(desde.getTime() - 3600e3), new Date(hasta.getTime() + 3600e3)]);
    recs = qr.rows.map(r => ({ ...r, t: new Date(r.started_at).getTime() }));
  } catch (_) {}
  const tieneRec = (r) => {
    const ini = r.start ? new Date(r.start).getTime() : 0;
    if (!ini) return false;
    const fin = ini + ((r.duration || 0) + 15) * 1000;
    return recs.some(x => x.t >= ini - 5000 && x.t <= fin &&
      (String(x.ext) === String(r.src) || String(x.ext) === String(r.dst)));
  };

  let datos = rows.map(r => ({ ...r, _t: clasificar(r, internos), _rec: false }));
  datos.forEach(r => { r._rec = tieneRec(r); });
  if (tipo && tipo !== 'all') datos = tipo === 'missed' ? datos.filter(r => r.disposition !== 'ANSWERED') : datos.filter(r => r._t === tipo);
  if (q) { const s = String(q).toLowerCase(); datos = datos.filter(r => String(r.src || '').includes(s) || String(r.dst || '').includes(s) || (r.clid || '').toLowerCase().includes(s)); }

  const total = datos.length;
  const at = datos.filter(r => r.disposition === 'ANSWERED');
  const seg = datos.reduce((a, r) => a + (r.billsec || 0), 0);
  const acd = at.length ? Math.round(seg / at.length) : 0;
  const espera = datos.reduce((a, r) => a + Math.max(0, (r.duration || 0) - (r.billsec || 0)), 0);
  const asa = total ? Math.round(espera / total) : 0;

  // series
  const dias = [];
  for (let d = new Date(desde); d <= hasta; d = new Date(d.getTime() + 864e5)) dias.push(new Date(d));
  const porDia = dias.map(d => ({ l: fCorto(d), v: datos.filter(r => r.start && new Date(r.start).toDateString() === d.toDateString()).length })).slice(-31);
  const porHora = Array.from({ length: 24 }, (_, h) => ({ l: pad(h), v: datos.filter(r => r.start && new Date(r.start).getHours() === h).length }));
  const pico = porHora.reduce((a, b) => (b.v > a.v ? b : a), { l: '—', v: 0 });
  const porDiaSem = Array.from({ length: 7 }, (_, i) => ({ l: DIAS[i], v: datos.filter(r => r.start && new Date(r.start).getDay() === i).length }));

  const tipos = Object.keys(TIPOS).map(k => ({ l: TIPOS[k], v: datos.filter(r => r._t === k).length, c: COL[k] })).filter(x => x.v > 0);
  const disp = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED', 'CONGESTION'].map(k => ({ l: DISP[k], v: datos.filter(r => r.disposition === k).length, c: { ANSWERED: '#10b981', 'NO ANSWER': '#f59e0b', BUSY: '#f97316', FAILED: '#ef4444', CONGESTION: '#94a3b8' }[k] })).filter(x => x.v > 0);

  const rank = (key, filtro) => {
    const m = new Map();
    for (const r of datos.filter(filtro)) {
      const k = String(r[key] || '—'); if (k === '—') continue;
      const e = m.get(k) || { n: 0, s: 0, at: 0, nom: '' };
      e.n++; e.s += r.billsec || 0; if (r.disposition === 'ANSWERED') e.at++;
      if (!e.nom) e.nom = nombreClid(r.clid);
      m.set(k, e);
    }
    return [...m.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.n - a.n).slice(0, 10);
  };
  const topInt = rank('src', r => internos.has(String(r.src)));
  const topExt = rank('src', r => !internos.has(String(r.src)) && r._t === 'inbound');
  const topDest = rank('dst', r => r._t === 'outbound');

  const filtroTxt = (tipo && tipo !== 'all' ? (tipo === 'missed' ? 'Sólo llamadas sin atender' : 'Sólo llamadas de tipo ' + (TIPOS[tipo] || tipo)) : 'Todas las llamadas') + (q ? ` · filtradas por “${esc(q)}”` : '');

  const conRec = datos.filter(r => r._rec).length;
  const kpi = (v, l, s, c) => `<div class="kpi"><div class="kv" style="color:${c}">${v}</div><div class="kl">${l}</div>${s ? `<div class="ks">${s}</div>` : ''}</div>`;

  const filas = datos.slice(0, 400).map(r => {
    const d = r.start ? new Date(r.start) : null;
    const ok = r.disposition === 'ANSWERED';
    return `<tr>
      <td class="mono">${d ? fHora(d) : '—'}</td>
      <td><span class="tag" style="--c:${COL[r._t]}">${TIPOS[r._t]}</span></td>
      <td class="mono">${esc(r.src || '—')}${nombreClid(r.clid) ? `<span class="sm">${esc(nombreClid(r.clid))}</span>` : ''}</td>
      <td class="mono">${esc(r.dst || '—')}</td>
      <td class="mono">${dur(r.billsec)}</td>
      <td><span class="chip ${ok ? 'ok' : 'no'}">${DISP[r.disposition] || esc(r.disposition || '—')}</span></td>
      <td class="rec">${r._rec ? '<span class="chip rec-si">Sí</span>' : '<span class="chip rec-no">No</span>'}</td>
    </tr>`;
  }).join('');

  const conclusiones = [];
  conclusiones.push(`Se registraron <b>${total}</b> llamadas en el período, de las cuales <b>${at.length}</b> fueron atendidas (<b>${pct(at.length, total)}%</b> de atención).`);
  if (pico.v) conclusiones.push(`La franja de mayor tráfico es <b>${pico.l}:00 h</b>, con <b>${pico.v}</b> llamadas: es la hora crítica para el dimensionamiento de agentes.`);
  if (acd) conclusiones.push(`La duración media de conversación (ACD) es de <b>${dur(acd)}</b> y el tiempo medio hasta la atención (ASA) de <b>${dur(asa)}</b>.`);
  const perd = total - at.length;
  if (perd) conclusiones.push(`Quedaron <b>${perd}</b> llamadas sin atender (<b>${pct(perd, total)}%</b>). Revisar la cobertura horaria y los desbordes de cola en las franjas con más pérdidas.`);
  if (tipos.length) { const t0 = tipos.slice().sort((a, b) => b.v - a.v)[0]; conclusiones.push(`El tráfico está dominado por llamadas de tipo <b>${t0.l}</b> (${pct(t0.v, total)}% del total).`); }

  if (total) conclusiones.push(`Hay audio guardado de <b>${conRec}</b> llamadas (<b>${pct(conRec, total)}%</b>): el resto no se grabó o la grabación ya se eliminó.`);

  const logo = brand.logo && /^(https?:|data:)/.test(brand.logo) ? `<img src="${esc(brand.logo)}" alt="">` : `<div class="mono-logo">${esc(marca.slice(0, 2).toUpperCase())}</div>`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Informe ejecutivo de llamadas · ${esc(marca)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  :root { --ink:#0f172a; --sub:#64748b; --line:#e2e8f0; --brand:#0f2f5c; --acc:#2f80ff; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:#f1f5f9; font-size:11.5px; line-height:1.5; }
  .page { width:210mm; min-height:297mm; margin:0 auto 10mm; background:#fff; padding:16mm 14mm; box-shadow:0 8px 30px rgba(15,23,42,.13); }
  .barra { position:sticky; top:0; z-index:9; background:var(--brand); color:#fff; padding:10px 16px; display:flex; justify-content:space-between; align-items:center; }
  .barra button { background:var(--acc); color:#fff; border:0; border-radius:8px; padding:9px 16px; font-weight:700; font-size:13px; cursor:pointer; }
  /* tapa */
  .tapa { display:flex; flex-direction:column; justify-content:space-between; min-height:265mm; background:linear-gradient(155deg,#0b1f3f 0%,#12356b 55%,#1c4f9c 100%); color:#fff; margin:-16mm -14mm; padding:22mm 18mm; }
  .tapa .hd { display:flex; align-items:center; gap:14px; }
  .tapa img { max-height:52px; max-width:190px; filter:brightness(0) invert(1); }
  .mono-logo { width:52px; height:52px; border-radius:12px; background:rgba(255,255,255,.16); display:flex; align-items:center; justify-content:center; font-weight:800; font-size:20px; letter-spacing:1px; }
  .tapa .marca { font-size:19px; font-weight:800; letter-spacing:.3px; }
  .tapa .sub { font-size:12px; opacity:.72; }
  .tapa h1 { font-size:42px; line-height:1.08; margin:0 0 10px; font-weight:800; letter-spacing:-.6px; }
  .tapa .rule { width:78px; height:5px; background:#4d9dff; border-radius:3px; margin-bottom:20px; }
  .tapa .peri { font-size:16px; opacity:.9; }
  .tapa .meta { border-top:1px solid rgba(255,255,255,.22); padding-top:14px; display:flex; gap:32px; font-size:11px; opacity:.85; }
  .tapa .meta b { display:block; font-size:12.5px; opacity:1; font-weight:600; }
  h2 { font-size:17px; margin:0 0 3px; color:var(--brand); letter-spacing:-.2px; }
  h2 .n { color:var(--acc); font-weight:800; margin-right:7px; }
  .dsc { color:var(--sub); font-size:11px; margin:0 0 12px; }
  section { margin-bottom:20px; page-break-inside:avoid; }
  .kpis { display:grid; grid-template-columns:repeat(6,1fr); gap:8px; margin-bottom:16px; }
  .kpi { border:1px solid var(--line); border-radius:10px; padding:11px 10px; background:#f8fafc; }
  .kv { font-size:23px; font-weight:800; line-height:1.1; letter-spacing:-.5px; }
  .kl { font-size:10px; color:var(--sub); text-transform:uppercase; letter-spacing:.4px; margin-top:2px; }
  .ks { font-size:10px; color:#94a3b8; margin-top:2px; }
  .chart { width:100%; height:auto; }
  .grid { stroke:#eef2f7; stroke-width:1; }
  .ax { font-size:8.5px; fill:#94a3b8; font-family:inherit; }
  .val { font-size:8.5px; fill:#64748b; font-weight:700; font-family:inherit; }
  .dn { font-size:22px; font-weight:800; fill:var(--ink); }
  .ds { font-size:9px; fill:#94a3b8; }
  .donut { display:flex; gap:20px; align-items:center; }
  .legend { flex:1; }
  .lg { display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px dashed var(--line); font-size:11px; }
  .lg i { width:10px; height:10px; border-radius:3px; }
  .lg span { flex:1; }
  .lg b { font-weight:700; }
  .lg em { font-style:normal; color:var(--sub); width:38px; text-align:right; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:22px; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:9.5px; text-transform:uppercase; letter-spacing:.5px; color:var(--sub); border-bottom:2px solid var(--line); padding:6px 5px; }
  td { padding:5px; border-bottom:1px solid #f1f5f9; font-size:10.5px; vertical-align:middle; }
  tbody tr:nth-child(even) { background:#fafbfc; }
  .mono { font-family:'JetBrains Mono',Consolas,monospace; }
  .sm { display:block; font-size:9px; color:#94a3b8; }
  .tag { border:1px solid var(--c); color:var(--c); border-radius:20px; padding:1px 7px; font-size:9px; font-weight:600; white-space:nowrap; }
  .chip { border-radius:20px; padding:1px 8px; font-size:9px; font-weight:600; }
  .chip.ok { background:#dcfce7; color:#166534; }
  .chip.no { background:#fee2e2; color:#991b1b; }
  .chip.rec-si { background:#ede9fe; color:#5b21b6; }
  .chip.rec-no { background:#f1f5f9; color:#94a3b8; }
  td.rec { text-align:center; }
  .box { border-left:3px solid var(--acc); background:#f6f9ff; padding:11px 14px; border-radius:0 8px 8px 0; }
  .box li { margin-bottom:5px; }
  .box ul { margin:0; padding-left:16px; }
  .vacio { color:#94a3b8; text-align:center; padding:24px; font-style:italic; }
  .pie { border-top:1px solid var(--line); margin-top:18px; padding-top:8px; color:#94a3b8; font-size:9.5px; display:flex; justify-content:space-between; }
  @media print { body { background:#fff; } .barra { display:none; } .page { box-shadow:none; margin:0; width:auto; min-height:0; padding:0; } .tapa { margin:0; page-break-after:always; min-height:250mm; } .pbreak { page-break-before:always; } }
</style></head><body>
<div class="barra"><span>Informe listo · usá <b>Imprimir → Guardar como PDF</b> (tamaño A4, márgenes por defecto)</span><button onclick="window.print()">Imprimir / Guardar PDF</button></div>

<div class="page">
  <div class="tapa">
    <div class="hd">${logo}<div><div class="marca">${esc(marca)}</div><div class="sub">${esc(sub)}</div></div></div>
    <div>
      <div class="rule"></div>
      <h1>Informe ejecutivo<br>de llamadas</h1>
      <div class="peri">${fLargo(desde)} — ${fLargo(hasta)}</div>
      <div class="peri" style="font-size:12px;opacity:.7;margin-top:6px">${filtroTxt}</div>
    </div>
    <div class="meta">
      <div><b>${total}</b>llamadas analizadas</div>
      <div><b>${pct(at.length, total)}%</b>tasa de atención</div>
      <div><b>${dur(seg)}</b>tiempo conversado</div>
      <div><b>${fHora(new Date())}</b>generado${usuario ? ' por ' + esc(usuario) : ''}</div>
    </div>
  </div>
</div>

<div class="page">
  <section>
    <h2><span class="n">1</span>Resumen ejecutivo</h2>
    <p class="dsc">Indicadores clave del período analizado. Los valores surgen de los registros CDR de la central.</p>
    <div class="kpis">
      ${kpi(total, 'Llamadas', '', '#0f172a')}
      ${kpi(at.length, 'Atendidas', pct(at.length, total) + '% del total', '#10b981')}
      ${kpi(total - at.length, 'Sin atender', pct(total - at.length, total) + '% del total', '#ef4444')}
      ${kpi(dur(seg), 'Tiempo conversado', '', '#7c3aed')}
      ${kpi(dur(acd), 'Duración media (ACD)', 'ASA ' + dur(asa), '#2f80ff')}
      ${kpi(conRec, 'Con grabación', pct(conRec, total) + '% del total', '#7c3aed')}
    </div>
    <div class="box"><ul>${conclusiones.map(c => `<li>${c}</li>`).join('')}</ul></div>
  </section>

  <section>
    <h2><span class="n">2</span>Volumen por día</h2>
    <p class="dsc">Llamadas registradas por jornada. Permite detectar picos, caídas de tráfico y días atípicos.</p>
    ${barras(porDia, { color: '#2f80ff' })}
  </section>

  <section>
    <h2><span class="n">3</span>Distribución horaria</h2>
    <p class="dsc">Concentración del tráfico a lo largo del día. La franja pico es <b>${pico.l}:00 h</b> con ${pico.v} llamadas.</p>
    ${barras(porHora, { color: '#7c3aed', h: 170 })}
  </section>
</div>

<div class="page">
  <section>
    <h2><span class="n">4</span>Composición del tráfico</h2>
    <p class="dsc">Cómo se reparten las llamadas por tipo y cuál fue su resultado final.</p>
    <div class="cols">
      <div><h3 style="font-size:12px;margin:0 0 8px;color:#334155">Por tipo</h3>${tipos.length ? dona(tipos) : '<p class="vacio">Sin datos.</p>'}</div>
      <div><h3 style="font-size:12px;margin:0 0 8px;color:#334155">Por resultado</h3>${disp.length ? dona(disp) : '<p class="vacio">Sin datos.</p>'}</div>
    </div>
  </section>

  <section>
    <h2><span class="n">5</span>Actividad por día de la semana</h2>
    <p class="dsc">Útil para planificar turnos y guardias.</p>
    ${barras(porDiaSem, { color: '#0ea5e9', h: 150 })}
  </section>

  <section>
    <h2><span class="n">6</span>Rankings</h2>
    <p class="dsc">Los diez primeros de cada categoría, ordenados por cantidad de llamadas.</p>
    <div class="cols">
      <div>
        <h3 style="font-size:12px;margin:0 0 6px;color:#334155">Internos más activos</h3>
        <table><thead><tr><th>Interno</th><th>Llam.</th><th>Atend.</th><th>Tiempo</th></tr></thead><tbody>
        ${topInt.map(t => `<tr><td class="mono">${esc(t.k)}</td><td>${t.n}</td><td>${pct(t.at, t.n)}%</td><td class="mono">${dur(t.s)}</td></tr>`).join('') || '<tr><td colspan="4" class="vacio">Sin datos</td></tr>'}
        </tbody></table>
      </div>
      <div>
        <h3 style="font-size:12px;margin:0 0 6px;color:#334155">Números entrantes más frecuentes</h3>
        <table><thead><tr><th>Origen</th><th>Llam.</th><th>Atend.</th></tr></thead><tbody>
        ${topExt.map(t => `<tr><td class="mono">${esc(t.k)}${t.nom ? `<span class="sm">${esc(t.nom)}</span>` : ''}</td><td>${t.n}</td><td>${pct(t.at, t.n)}%</td></tr>`).join('') || '<tr><td colspan="3" class="vacio">Sin datos</td></tr>'}
        </tbody></table>
      </div>
    </div>
    ${topDest.length ? `<div style="margin-top:14px"><h3 style="font-size:12px;margin:0 0 6px;color:#334155">Destinos salientes más llamados</h3>
      <table><thead><tr><th>Destino</th><th>Llamadas</th><th>Contestadas</th><th>Tiempo conversado</th></tr></thead><tbody>
      ${topDest.map(t => `<tr><td class="mono">${esc(t.k)}</td><td>${t.n}</td><td>${pct(t.at, t.n)}%</td><td class="mono">${dur(t.s)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
  </section>
</div>

<div class="page">
  <section>
    <h2><span class="n">7</span>Detalle de llamadas</h2>
    <p class="dsc">Registro cronológico. La columna <b>Grabación</b> dice si el audio de esa llamada está guardado y se puede escuchar desde el panel${total > 400 ? ` (se muestran las 400 más recientes de ${total}; el detalle completo está disponible en la exportación CSV)` : ''}.</p>
    <table><thead><tr><th>Fecha y hora</th><th>Tipo</th><th>Origen</th><th>Destino</th><th>Conversado</th><th>Resultado</th><th>Grabación</th></tr></thead>
    <tbody>${filas || '<tr><td colspan="7" class="vacio">Sin llamadas en el período seleccionado.</td></tr>'}</tbody></table>
  </section>
  <div class="pie"><span>${esc(marca)} · Informe ejecutivo de llamadas</span><span>Generado por PBX-NG el ${fHora(new Date())}</span></div>
</div>
</body></html>`;
}

module.exports = { init, build };
