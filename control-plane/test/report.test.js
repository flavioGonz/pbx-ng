/* ============================================================================
 *  Informe ejecutivo del historial (report.js): que cuente igual que el panel.
 *
 *  Va contra un pool de mentira en memoria: lo que importa acá es la cuenta —qué es
 *  entrante, saliente, interna, IVR o IA; cuántas se atendieron; cuáles tienen audio—
 *  y que el HTML diga esos números, no la consulta SQL.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const report = require('../report');

const HOY = new Date();
const hace = (min) => new Date(HOY.getTime() - min * 60000);
const CDR = [
  { start: hace(60), clid: '"Juan Pérez" <099123456>', src: '099123456', dst: '2001', dcontext: 'from-trunk', duration: 70, billsec: 60, disposition: 'ANSWERED', channel: 'PJSIP/antel-1', dstchannel: 'PJSIP/2001-1', lastapp: 'Dial' },
  { start: hace(120), clid: '<099123456>', src: '099123456', dst: '2001', dcontext: 'from-trunk', duration: 20, billsec: 0, disposition: 'NO ANSWER', channel: 'x', dstchannel: 'y', lastapp: 'Dial' },
  { start: hace(180), clid: '"2001" <2001>', src: '2001', dst: '099888777', dcontext: 'internal', duration: 130, billsec: 120, disposition: 'ANSWERED', channel: 'PJSIP/2001', dstchannel: 'PJSIP/antel', lastapp: 'Dial' },
  { start: hace(240), clid: '', src: '2001', dst: '2002', dcontext: 'internal', duration: 15, billsec: 10, disposition: 'ANSWERED', channel: '', dstchannel: '', lastapp: 'Dial' },
  { start: hace(300), clid: '', src: '099', dst: '7001', dcontext: 'from-trunk', duration: 30, billsec: 30, disposition: 'ANSWERED', channel: '', dstchannel: '', lastapp: 'Playback' },
  { start: hace(360), clid: '', src: '2002', dst: '8100', dcontext: 'internal', duration: 40, billsec: 40, disposition: 'ANSWERED', channel: '', dstchannel: '', lastapp: 'Stasis' },
  { start: hace(420), clid: '', src: 'x', dst: 'y', dcontext: 'otro', duration: 5, billsec: 0, disposition: 'BUSY', channel: '', dstchannel: '', lastapp: '' },
  { start: hace(480), clid: '', src: '2002', dst: '099111', dcontext: 'internal', duration: 5, billsec: 0, disposition: 'FAILED', channel: '', dstchannel: '', lastapp: '' },
  { start: hace(540), clid: '', src: '2002', dst: '099222', dcontext: 'internal', duration: 5, billsec: 0, disposition: 'CONGESTION', channel: '', dstchannel: '', lastapp: '' },
  { start: null, clid: '', src: '', dst: '', dcontext: '', duration: 0, billsec: 0, disposition: 'RARA', channel: '', dstchannel: '', lastapp: '' },
];

function poolFalso({ marca = {}, cdr = CDR, grab = [], fallaInternos = false, fallaGrab = false, fallaMarca = false } = {}) {
  return {
    async query(sql) {
      if (/pbxng_settings/.test(sql)) { if (fallaMarca) throw new Error('x'); return { rows: Object.entries(marca).map(([k, v]) => ({ key: 'brand_' + k, value: v })) }; }
      if (/FROM ps_endpoints/.test(sql)) { if (fallaInternos) throw new Error('x'); return { rows: [{ id: '2001' }, { id: '2002' }] }; }
      if (/FROM cdr/.test(sql)) return { rows: cdr };
      if (/pbxng_recordings/.test(sql)) { if (fallaGrab) throw new Error('x'); return { rows: grab }; }
      throw new Error('consulta inesperada: ' + sql);
    },
  };
}
const desde = () => { const d = new Date(HOY.getTime() - 3 * 864e5); return d.toISOString().slice(0, 10); };
const hasta = () => HOY.toISOString().slice(0, 10);

test('cuenta y clasifica cada llamada como el panel, y lo dice en la tapa y en el resumen', async () => {
  report.init(poolFalso({ marca: { name: 'Portería Sur', subtitle: 'Central', logo: 'https://x/logo.png' }, grab: [{ id: 1, ext: '2001', started_at: hace(60), duration: 60 }] }));
  const html = await report.build({ from: desde(), to: hasta(), usuario: 'ana <admin>' });
  assert.match(html, /<title>Informe ejecutivo de llamadas · Portería Sur<\/title>/);
  assert.match(html, /<img src="https:\/\/x\/logo.png"/);
  assert.match(html, /generado por ana &lt;admin&gt;/, 'lo que viene de afuera se escapa');
  assert.match(html, /<b>10<\/b>llamadas analizadas/);
  assert.match(html, /<td class="mono">—<\/td>/, 'una fila sin fecha se muestra con guión, no rompe el informe');
  for (const tipo of ['Entrante', 'Saliente', 'Interna', 'IVR', 'Agente IA', 'Otra']) assert.match(html, new RegExp('>' + tipo + '<'), tipo);
  for (const r of ['Atendida', 'Sin respuesta', 'Ocupado', 'Fallida', 'Congestión']) assert.match(html, new RegExp(r), r);
  assert.match(html, /Juan Pérez/, 'el nombre del clid aparece en el ranking');
  assert.match(html, /<span class="chip rec-si">Sí<\/span>/, 'la llamada con grabación lo dice');
  assert.match(html, /Hay audio guardado de <b>1<\/b> llamadas/);
  assert.match(html, /Destinos salientes más llamados/);
  assert.match(html, /Quedaron <b>5<\/b> llamadas sin atender/);
});

test('filtros: sólo perdidas, por tipo y por texto', async () => {
  report.init(poolFalso());
  const perdidas = await report.build({ from: desde(), to: hasta(), tipo: 'missed' });
  assert.match(perdidas, /Sólo llamadas sin atender/);
  assert.match(perdidas, /<b>5<\/b>llamadas analizadas/);
  const salientes = await report.build({ from: desde(), to: hasta(), tipo: 'outbound' });
  assert.match(salientes, /Sólo llamadas de tipo Saliente/);
  const raro = await report.build({ from: desde(), to: hasta(), tipo: 'inventado' });
  assert.match(raro, /tipo inventado/);
  const texto = await report.build({ from: desde(), to: hasta(), q: 'juan' });
  assert.match(texto, /filtradas por “juan”/);
  assert.match(texto, /<b>1<\/b>llamadas analizadas/);
});

test('un período vacío dice que no hay datos, sin dividir por cero ni dejar huecos', async () => {
  report.init(poolFalso({ cdr: [], fallaInternos: true, fallaGrab: true, fallaMarca: true }));
  const html = await report.build({});
  assert.match(html, /<b>0<\/b>llamadas analizadas/);
  assert.match(html, /<b>0%<\/b>tasa de atención/);
  assert.match(html, /Sin llamadas en el período seleccionado/);
  assert.match(html, /<div class="mono-logo">PB<\/div>/, 'sin logo, las iniciales: nunca un hueco en la tapa');
  assert.match(html, /<td colspan="4" class="vacio">Sin datos<\/td>/);
  assert.doesNotMatch(html, /Destinos salientes más llamados/);
});

test('más de 400 llamadas: el detalle muestra las 400 más recientes y lo avisa', async () => {
  const muchas = Array.from({ length: 405 }, (_, i) => ({ ...CDR[3], start: hace(i % 600) }));
  report.init(poolFalso({ cdr: muchas }));
  const html = await report.build({ from: desde(), to: hasta() });
  assert.match(html, /se muestran las 400 más recientes de 405/);
  assert.equal((html.match(/<tr>\s*<td class="mono">/g) || []).length >= 400, true);
});

test('las piezas sueltas: duración, porcentaje, gráficos y la marca', async () => {
  assert.equal(report.dur(0), '0s');
  assert.equal(report.dur(65), '1m 5s');
  assert.equal(report.dur(3725), '1h 2m');
  assert.equal(report.pct(1, 0), 0);
  assert.equal(report.pct(1, 3), 33);
  assert.equal(report.esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.match(report.barras([]), /Sin datos en el período/);
  const muchas = report.barras(Array.from({ length: 40 }, (_, i) => ({ l: String(i), v: i })), { sufijo: '%' });
  assert.match(muchas, /<svg/);
  assert.doesNotMatch(muchas, /class="val"/, 'con muchas barras no se escriben los valores encima');
  assert.match(report.barras([{ l: 'a', v: 3 }], { sufijo: ' s' }), /3 s</);
  const d = report.dona([{ l: 'A', v: 1, c: '#000' }, { l: 'B', v: 0, c: '#fff' }]);
  assert.equal((d.match(/<circle/g) || []).length, 1, 'una parte en cero no dibuja segmento');
  assert.match(report.dona([]), /<text[^>]*class="dn">1</, 'sin datos no divide por cero');
  assert.equal(report.logoHtml(null), '<div class="mono-logo">PB</div>');
  assert.equal(report.logoHtml({ name: 'sur', logo: 'javascript:alert(1)' }), '<div class="mono-logo">SU</div>', 'un logo que no es http ni data no entra al HTML');
  assert.match(report.logoHtml({ logo: 'data:image/png;base64,xx' }), /^<img/);
  const b = await report.branding({ query: async () => ({ rows: [{ key: 'brand_name', value: 'X' }, { key: 'brand_tagline', value: 'T' }] }) });
  assert.deepEqual(b, { name: 'X', tagline: 'T', subtitle: 'Comunicaciones unificadas' });
  assert.equal(report.fLargo(new Date(2026, 0, 5)), '5 de enero de 2026');
  assert.equal(report.fCorto(new Date(2026, 0, 5)), '05/01');
  assert.equal(report.fHora(new Date(2026, 0, 5, 9, 7)), '05/01/2026 09:07');
});
