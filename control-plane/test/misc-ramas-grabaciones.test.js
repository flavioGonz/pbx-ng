/* ============================================================================
 *  Grabaciones y CDR (recordings.js) en unidad: base, AMI, ARI, voz y volumen de
 *  mentira (un directorio temporal como REC_DIR).
 *
 *  test/grabaciones.test.js recorre el camino feliz contra la API real. Acá se fijan
 *  los bordes que deciden si lo que dice el panel es VERDAD:
 *   - la marca de grabación en la AstDB: si el AMI falla, se registra y se avisa (el
 *     panel no puede decir «grabando» si la central no graba);
 *   - el permiso por interno: sin interno asignado no se escucha ni se busca nada;
 *   - el WAV: estéreo se baja a mono, 8 bits o sin bloque `data` es «no soportado»;
 *   - la transcripción: cada falla (no existe, sin audio, STT caído) con su error;
 *   - grabar en vivo: si ARI no contesta, el canal se busca por AMI, y sin ninguno de
 *     los dos se dice que Asterisk no está;
 *   - el indexador: no toca lo que todavía crece, corrige lo que creció, clasifica el
 *     origen por el nombre y sobrevive a que la base falle a mitad de camino.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// REC_DIR se lee al cargar el módulo: el directorio tiene que existir antes del require.
const REC = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-ramas-'));
process.env.REC_DIR = REC;
const initRec = require('../recordings');
const recstore = require('../recstore');
const report = require('../report');
test.after(() => fs.rmSync(REC, { recursive: true, force: true }));

function wav({ seg = 0.2, canales = 1, bits = 16, nivel = 4000, sinData = false } = {}) {
  const n = Math.round(8000 * seg), bps = bits / 8, data = Buffer.alloc(n * canales * bps);
  if (bits === 16) for (let i = 0; i < n * canales; i++) data.writeInt16LE(Math.round(Math.sin(i / 7) * nivel), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(canales, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000 * canales * bps, 28); h.writeUInt16LE(canales * bps, 32); h.writeUInt16LE(bits, 34);
  h.write(sinData ? 'LIST' : 'data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/* Base de mentira: `manejar(sql, args)` decide; lo que no maneja devuelve vacío. */
function armar(t, { manejar = () => null, amiFalla = false, ari = null, amiConectado = true, conAmi = true, emitirEvento } = {}) {
  try { t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); } catch (_) { /* ya activo en esta prueba */ }
  const consultas = [];
  const pool = {
    async query(sql, args) {
      consultas.push({ sql, args });
      const r = await manejar(sql, args);
      return r || { rows: [], rowCount: 0 };
    },
  };
  const rutas = {};
  const reg = (m) => (ruta, ...h) => { rutas[m + ' ' + ruta] = h[h.length - 1]; };
  const ami = conAmi ? new EventEmitter() : null;
  const acciones = [];
  const logs = [];
  const st = { amiFalla, ari, cli: '' };
  const m = initRec({
    app: { get: reg('GET'), post: reg('POST'), delete: reg('DELETE') },
    pool, ami,
    amiAction: async (a) => { acciones.push(a); if (st.amiFalla) throw new Error('AMI caído'); return {}; },
    amiCommand: async () => { if (st.cli instanceof Error) throw st.cli; return st.cli; },
    getAri: () => st.ari,
    state: { ami: amiConectado },
    extPropia: (req) => (req.propio === undefined ? null : req.propio),
    exigirExt: (req, res) => { if (req.ajeno) { res.status(403).json({ error: 'otra extensión' }); return false; } return true; },
    vozBase: async () => 'http://voz.local',
    errorHttp: (res, e) => res.status(e.status || 500).json({ error: e.message }),
    logger: () => ({ debug() {}, info() {}, warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) }),
    emitirEvento,
  });
  return { m, rutas, consultas, acciones, logs, st, ami };
}

function resFalsa() {
  return {
    statusCode: 200, cuerpo: undefined, headers: {}, terminado: false,
    status(c) { this.statusCode = c; return this; }, json(b) { this.cuerpo = b; this.terminado = true; return this; },
    set(k, v) { this.headers[k] = v; return this; }, type(v) { this.headers.type = v; return this; },
    send(b) { this.cuerpo = b; this.terminado = true; return this; }, end() { this.terminado = true; return this; },
  };
}
async function http(handler, req = {}) {
  const res = resFalsa();
  await handler({ params: {}, query: {}, ...req }, res);
  return res;
}
const tic = () => new Promise((r) => setImmediate(r));
function poner(nombre, contenido, haceSeg = 120) {
  const f = path.join(REC, nombre);
  fs.writeFileSync(f, contenido);
  const tt = new Date(Date.now() - haceSeg * 1000);
  fs.utimesSync(f, tt, tt);
}

test('marcas de grabación: el volcado inicial registra lo que el AMI no tomó', async (t) => {
  const x = armar(t, {
    amiFalla: true,
    manejar: (sql) => {
      if (/pbxng_record=true/.test(sql)) return { rows: [{ id: '2001' }, { id: '2002' }] };
      if (/key='record_all'/.test(sql)) return { rows: [] };
      if (/INSERT INTO pbxng_rec_config/.test(sql)) throw new Error('sin tabla');
      return null;
    },
  });
  await tic();
  assert.ok(x.logs.some((l) => l[0] === 'error' && l[1] === 'cfg'), 'la fila de config que no se pudo crear se registra');
  t.mock.timers.tick(9000);
  await tic(); await tic(); await tic();
  const aviso = x.logs.find((l) => l[0] === 'warn');
  assert.deepEqual(aviso[2], { internos: 2, fallados: 3 }, 'dos internos y el «grabar todo»');
  assert.ok(x.logs.some((l) => /no se pudo apagar la grabación de todos/.test(l[1])));
  assert.equal(await x.m.setRecFlag('2003', false), false);
  assert.ok(x.logs.some((l) => /no se pudo desmarcar la grabación de rec\/2003/.test(l[1])));
  x.st.amiFalla = false;
  assert.equal(await x.m.setRecAll(true), true);
  assert.deepEqual(x.acciones.at(-1), { Action: 'DBPut', Family: 'rec', Key: '_ALL_', Val: '1' });
});

test('marcas de grabación: si la base falla el volcado se registra; «grabar todo» encendido se vuelca', async (t) => {
  let romper = true;
  const x = armar(t, {
    manejar: (sql) => {
      if (/pbxng_record=true/.test(sql)) { if (romper) throw new Error('base caída'); return { rows: [] }; }
      if (/key='record_all'/.test(sql)) return { rows: [{ value: '1' }] };
      return null;
    },
  });
  await x.m.syncRecFlags();
  assert.ok(x.logs.some((l) => l[1] === 'syncRecFlags'));
  romper = false;
  await x.m.syncRecFlags();
  assert.deepEqual(x.acciones.at(-1), { Action: 'DBPut', Family: 'rec', Key: '_ALL_', Val: '1' });
  assert.ok(!x.logs.some((l) => l[0] === 'warn'));
});

test('«grabar todo»: el interruptor avisa si Asterisk no tomó el cambio', async (t) => {
  let valor = null;
  let romper = false;
  const x = armar(t, {
    manejar: (sql, args) => {
      if (romper) throw new Error('base caída');
      if (/^INSERT INTO pbxng_settings/.test(sql)) { valor = args[0]; return { rowCount: 1 }; }
      if (/key='record_all'/.test(sql)) return { rows: valor ? [{ value: valor }] : [] };
      return null;
    },
  });
  assert.deepEqual((await http(x.rutas['GET /api/extensions/record-all'])).cuerpo, { enabled: false });
  x.st.amiFalla = true;
  let r = await http(x.rutas['POST /api/extensions/record-all'], { body: { enabled: true } });
  assert.equal(r.cuerpo.enabled, true);
  assert.match(r.cuerpo.aviso, /Asterisk no tomó el cambio/);
  assert.deepEqual((await http(x.rutas['GET /api/extensions/record-all'])).cuerpo, { enabled: true });
  x.st.amiFalla = false;
  r = await http(x.rutas['POST /api/extensions/record-all'], {});
  assert.deepEqual(r.cuerpo, { ok: true, enabled: false });
  romper = true;
  assert.equal((await http(x.rutas['GET /api/extensions/record-all'])).statusCode, 500);
  assert.equal((await http(x.rutas['POST /api/extensions/record-all'], {})).statusCode, 500);
});

test('WAV: estéreo a mono, y 8 bits, sin «data» o basura no se aceptan', (t) => {
  const { m } = armar(t);
  const est = m.wavToPcm(wav({ canales: 2 }));
  assert.equal(est.pcm.length, Math.round(8000 * 0.2) * 2, 'dos canales se mezclan en uno');
  assert.equal(est.rate, 8000);
  assert.equal(m.wavToPcm(wav({ bits: 8 })), null);
  assert.equal(m.wavToPcm(wav({ sinData: true })), null);
  assert.equal(m.wavToPcm(Buffer.from('no es un wav')), null);
  // Un bloque desconocido con largo impar se saltea con su byte de relleno.
  const base = wav();
  const extra = Buffer.concat([Buffer.from('JUNK'), Buffer.from([3, 0, 0, 0]), Buffer.from([1, 2, 3, 0])]);
  const conJunk = Buffer.concat([base.slice(0, 36), extra, base.slice(36)]);
  assert.ok(m.wavToPcm(conJunk).pcm.length > 0);
});

test('análisis de texto: tensión, positivo, vacío y resumen recortado', (t) => {
  const { m } = armar(t);
  assert.equal(m.analyzeText('tengo un reclamo', 60).sentiment, 'tension');
  const pos = m.analyzeText('gracias, excelente atención, quedó resuelto', 30);
  assert.equal(pos.sentiment, 'positivo');
  assert.equal(pos.wpm, pos.words * 2, 'palabras por minuto sobre 30 s');
  const vacio = m.analyzeText(null, 0);
  assert.deepEqual([vacio.sentiment, vacio.words, vacio.wpm, vacio.summary], ['neutral', 0, 0, '']);
  const largo = m.analyzeText('palabra '.repeat(60), 10);
  assert.ok(largo.summary.endsWith('…'));
  assert.equal(largo.summary.length, 221);
  assert.deepEqual(largo.keywords, ['palabra']);
});

test('transcripción: cada falla con su error, y el texto vacío también se guarda', async (t) => {
  poner('pbxng-2001-1790000001.wav', wav());
  poner('roto.wav', wav({ bits: 8 }));
  const filas = { 1: { filename: 'pbxng-2001-1790000001.wav', duration: null }, 2: { filename: 'no-esta.wav' }, 3: { filename: '../roto.wav' } };
  let romper = false;
  const x = armar(t, {
    manejar: (sql, args) => {
      if (romper) throw new Error('base caída');
      if (/SELECT filename, duration/.test(sql)) return { rows: filas[args[0]] ? [filas[args[0]]] : [] };
      if (/SELECT transcript/.test(sql)) return { rows: args[0] === '9' ? [] : [{ transcript: '', analysis: null, at: null }] };
      return null;
    },
  });
  let stt = { ok: false, status: 503 };
  t.mock.method(globalThis, 'fetch', async () => stt);
  const tr = x.rutas['POST /api/recordings/:id/transcribe'];
  assert.equal((await http(tr, { params: { id: '7' } })).statusCode, 404);
  let r = await http(tr, { params: { id: '2' } });
  assert.deepEqual([r.statusCode, r.cuerpo.error], [404, 'audio no disponible']);
  r = await http(tr, { params: { id: '3' } });
  assert.match(r.cuerpo.error, /formato WAV no soportado/, 'el nombre se reduce a su base: no hay ../ que valga');
  r = await http(tr, { params: { id: '1' } });
  assert.equal(r.cuerpo.error, 'STT fallo (503)');
  stt = { ok: true, json: async () => ({}) };
  r = await http(tr, { params: { id: '1' } });
  assert.equal(r.cuerpo.transcript, '');
  assert.equal(r.cuerpo.analysis.wpm, 0);
  const upd = x.consultas.filter((c) => /UPDATE pbxng_recordings SET transcript/.test(c.sql)).at(-1);
  assert.equal(upd.args[0], '');

  const leer = x.rutas['GET /api/recordings/:id/transcript'];
  assert.equal((await http(leer, { params: { id: '9' } })).statusCode, 404);
  assert.deepEqual((await http(leer, { params: { id: '1' } })).cuerpo, { transcript: null, analysis: null, at: null });
  romper = true;
  assert.equal((await http(leer, { params: { id: '1' } })).statusCode, 500);
});

test('ondas: de la caché, sin archivo, WAV inválido, calculadas y error de base', async (t) => {
  poner('pbxng-2002-1790000002.wav', wav({ seg: 0.5, nivel: 50 }));
  poner('ocho.wav', wav({ bits: 8 }));
  const filas = { 1: { filename: 'x', peaks: { peaks: [1], silent: false } }, 2: { filename: 'falta.wav' }, 3: { filename: 'ocho.wav' }, 4: { filename: 'pbxng-2002-1790000002.wav' } };
  let romper = false;
  const x = armar(t, { manejar: (sql, args) => { if (romper) throw new Error('base caída'); if (/SELECT filename, peaks/.test(sql)) return { rows: filas[args[0]] ? [filas[args[0]]] : [] }; return null; } });
  const ondas = x.rutas['GET /api/recordings/:id/peaks'];
  assert.equal((await http(ondas, { params: { id: '0' } })).statusCode, 404);
  assert.deepEqual((await http(ondas, { params: { id: '1' } })).cuerpo, { peaks: [1], silent: false });
  assert.deepEqual((await http(ondas, { params: { id: '2' } })).cuerpo, { peaks: [], silent: true });
  assert.deepEqual((await http(ondas, { params: { id: '3' } })).cuerpo, { peaks: [], silent: true });
  const r = (await http(ondas, { params: { id: '4' } })).cuerpo;
  assert.equal(r.peaks.length, 40);
  assert.equal(r.silent, true, 'una grabación casi muda se marca silenciosa');
  romper = true;
  assert.equal((await http(ondas, { params: { id: '4' } })).statusCode, 500);
});

test('audio: sin interno no se escucha nada, otra extensión tampoco, y sin archivo es 502', async (t) => {
  poner('pbxng-2001-1790000003.wav', wav());
  const filas = { 1: { filename: 'pbxng-2001-1790000003.wav', ext: '2001', src: null, dst: '099' }, 2: { filename: 'falta.wav', ext: '2001' } };
  const x = armar(t, { manejar: (sql, args) => { if (/SELECT filename, ext, src, dst/.test(sql)) { if (args[0] === 'boom') throw new Error('x'); return { rows: filas[args[0]] ? [filas[args[0]]] : [] }; } return null; } });
  const audio = x.rutas['GET /api/recordings/:id/audio'];
  assert.equal((await http(audio, { params: { id: '0' } })).statusCode, 404);
  assert.equal((await http(audio, { params: { id: '1' }, propio: '' })).statusCode, 403);
  assert.equal((await http(audio, { params: { id: '1' }, propio: '2002' })).statusCode, 403);
  const ok = await http(audio, { params: { id: '1' }, propio: '2001' });
  assert.equal(ok.headers['Content-Type'], 'audio/wav');
  assert.ok(Buffer.isBuffer(ok.cuerpo));
  assert.equal((await http(audio, { params: { id: '2' } })).statusCode, 502);
  assert.equal((await http(audio, { params: { id: 'boom' } })).statusCode, 500);
});

test('grabar en vivo: ARI, AMI de respaldo, sin Asterisk, permisos y fallas', async (t) => {
  const ari = { channels: { list: async () => { throw new Error('ARI lento'); } } };
  const x = armar(t, { ari });
  const grabar = x.rutas['POST /api/calls/record'];
  assert.equal((await http(grabar, {})).statusCode, 400, 'sin cuerpo falta ext');
  assert.equal((await http(grabar, { body: { ext: '2001' }, ajeno: true })).statusCode, 403);
  // ARI falla, el AMI contesta con el canal.
  x.st.cli = 'PJSIP/2009-01!a\nPJSIP/2001-00000007!internal!s!1!Up\n';
  let r = await http(grabar, { body: { ext: '2001' } });
  assert.deepEqual(r.cuerpo, { ok: true });
  assert.equal(x.acciones.at(-1).Channel, 'PJSIP/2001-00000007');
  assert.match(x.acciones.at(-1).File, /^pbxng-2001-\d{10}\.wav$/, 'el sello va en segundos');
  // ARI contesta.
  x.st.ari = { channels: { list: async () => [{ name: null }, { name: 'PJSIP/2001-0000000a' }] } };
  assert.equal((await http(grabar, { body: { ext: '2001', action: 'stop' } })).statusCode, 200);
  assert.deepEqual(x.acciones.at(-1), { Action: 'StopMixMonitor', Channel: 'PJSIP/2001-0000000a' });
  // Ni ARI ni el AMI lo encuentran.
  x.st.ari = { channels: { list: async () => [] } };
  x.st.cli = new Error('AMI no contesta');
  r = await http(grabar, { body: { ext: '2001' } });
  assert.deepEqual([r.statusCode, r.cuerpo.error], [404, 'sin canal activo']);
  x.st.cli = '';
  r = await http(grabar, { body: { ext: '2001' } });
  assert.equal(r.statusCode, 404);
  // El MixMonitor falla.
  x.st.ari = { channels: { list: async () => [{ name: 'PJSIP/2001-1' }] } };
  x.st.amiFalla = true;
  assert.equal((await http(grabar, { body: { ext: '2001' } })).statusCode, 500);
});

test('grabar en vivo sin ARI ni AMI dice que Asterisk no está', async (t) => {
  const x = armar(t, { amiConectado: false });
  const r = await http(x.rutas['POST /api/calls/record'], { body: { ext: '2001' } });
  assert.deepEqual([r.statusCode, r.cuerpo.error], [404, 'Asterisk no disponible (ARI/AMI desconectados)']);
});

test('almacenamiento, informe y configuración: errores con y sin código', async (t) => {
  let romper = false;
  const x = armar(t, { manejar: () => { if (romper) throw new Error('base caída'); return null; } });
  t.mock.method(recstore, 'test', async () => { throw new Error('el bucket no existe'); });
  t.mock.method(recstore, 'nastest', async (b) => { if (b.mal) throw Object.assign(new Error('relation x'), { code: '42P01' }); return { ok: true, b }; });
  t.mock.method(recstore, 'sweep', async () => { throw new Error('sin red'); });
  t.mock.method(recstore, 'usage', async () => { throw new Error('du falló'); });
  let r = await http(x.rutas['POST /api/recordings/storage/test']);
  assert.deepEqual([r.statusCode, r.cuerpo.error], [400, 'el bucket no existe']);
  recstore.test.mock.mockImplementation(async () => { throw Object.assign(new Error('pg'), { code: '08006' }); });
  assert.equal((await http(x.rutas['POST /api/recordings/storage/test'])).statusCode, 500);
  recstore.test.mock.mockImplementation(async () => ({ ok: true }));
  assert.deepEqual((await http(x.rutas['POST /api/recordings/storage/test'])).cuerpo, { ok: true });
  assert.deepEqual((await http(x.rutas['POST /api/recordings/storage/nastest'])).cuerpo, { ok: true, b: {} });
  assert.equal((await http(x.rutas['POST /api/recordings/storage/nastest'], { body: { mal: true } })).statusCode, 500);
  recstore.nastest.mock.mockImplementation(async () => { throw new Error('mount: permiso denegado'); });
  assert.equal((await http(x.rutas['POST /api/recordings/storage/nastest'], { body: {} })).statusCode, 400);
  assert.equal((await http(x.rutas['POST /api/recordings/storage/sync'])).statusCode, 500);
  assert.equal((await http(x.rutas['GET /api/recordings/storage/usage'])).statusCode, 500);

  const pedidos = [];
  t.mock.method(report, 'build', async (o) => { pedidos.push(o); if (o.q === 'boom') throw new Error('x'); return '<html>'; });
  await http(x.rutas['GET /api/cdr/report'], { user: { name: 'Ana', username: 'ana' } });
  await http(x.rutas['GET /api/cdr/report'], { user: { username: 'ana' } });
  r = await http(x.rutas['GET /api/cdr/report'], {});
  assert.deepEqual(pedidos.map((p) => p.usuario), ['Ana', 'ana', '']);
  assert.equal(r.headers.type, 'html');
  assert.equal((await http(x.rutas['GET /api/cdr/report'], { query: { q: 'boom' } })).statusCode, 500);

  assert.deepEqual((await http(x.rutas['GET /api/recordings/config'])).cuerpo, {}, 'sin fila: objeto vacío');
  assert.deepEqual((await http(x.rutas['POST /api/recordings/config'], {})).cuerpo, { ok: true });
  romper = true;
  for (const k of ['GET /api/recordings/config', 'POST /api/recordings/config', 'GET /api/recordings', 'DELETE /api/recordings/:id', 'GET /api/recordings/match', 'GET /api/cdr']) {
    assert.equal((await http(x.rutas[k], { query: { from: '2001' }, params: { id: '1' } })).statusCode, 500, k);
  }
});

test('búsqueda por diálogo y CDR: sin interno 403, sin datos {}, alcance por interno', async (t) => {
  const x = armar(t, { manejar: (sql) => (/FROM pbxng_recordings/.test(sql) ? { rows: [] } : /FROM cdr/.test(sql) ? { rows: [{ src: '2001' }] } : null) });
  const match = x.rutas['GET /api/recordings/match'];
  assert.equal((await http(match, { propio: '' })).statusCode, 403);
  assert.deepEqual((await http(match, {})).cuerpo, {});
  assert.equal((await http(match, { propio: '2001', query: { to: '2002' } })).statusCode, 403);
  assert.deepEqual((await http(match, { propio: '2001', query: { from: '2001', ts: 'x' } })).cuerpo, {});
  const cdr = x.rutas['GET /api/cdr'];
  assert.equal((await http(cdr, { propio: '' })).statusCode, 403);
  await http(cdr, { propio: '2001', query: { ext: '2002', limit: '9999' } });
  assert.deepEqual(x.consultas.at(-1).args, [500, '2001'], 'el agente ve sólo su interno aunque pida otro, y el límite tiene techo');
  await http(cdr, { query: { ext: '2002' } });
  assert.deepEqual(x.consultas.at(-1).args, [100, '2002']);
  await http(cdr, {});
  assert.deepEqual(x.consultas.at(-1).args, [100]);
});

test('indexador: espera lo que crece, corrige lo que creció, clasifica y sobrevive a la base', async (t) => {
  for (const f of fs.readdirSync(REC)) fs.rmSync(path.join(REC, f));
  const grande = wav({ seg: 1 });
  poner('pbxng-2001-1790000100.wav', grande);                    // interno, sello en segundos
  poner('pbxng-2002-1790000100123.wav', grande);                 // sello en milisegundos (PWA vieja)
  poner('pbxng-colaVentas-1790000200.7.wav', grande);            // cola, con UNIQUEID
  poner('pbxng-q_soporte-1790000201.1.wav', grande);             // cola (prefijo q)
  poner('pbxng-sala5-1790000300.wav', grande);
  poner('pbxng-ia1-1790000301.2.wav', grande);
  poner('pbxng-ivrmenu-1790000302.wav', grande);
  poner('pbxng-2003-1790000400.wav', grande, 5);                 // todavía creciendo
  poner('pbxng-2004-1790000500.wav', Buffer.alloc(100));         // demasiado chico
  poner('otro-nombre.wav', grande);
  poner('notas.txt', 'x');
  poner('pbxng-2005-1790000600.wav', grande);                    // ya indexado, creció
  poner('pbxng-2006-1790000601.wav', grande);                    // ya indexado, igual
  poner('pbxng-2007-1790000602.wav', grande);                    // falla el CDR y el INSERT
  const eventos = [];
  const x = armar(t, {
    emitirEvento: (tipo, ev) => eventos.push({ tipo, ev }),
    manejar: (sql, args) => {
      if (/SELECT id, bytes FROM pbxng_recordings/.test(sql)) {
        if (args[0] === 'pbxng-2005-1790000600.wav') return { rows: [{ id: 5, bytes: null }] };
        if (args[0] === 'pbxng-2006-1790000601.wav') return { rows: [{ id: 6, bytes: grande.length }] };
        return { rows: [] };
      }
      if (/^UPDATE pbxng_recordings SET bytes/.test(sql)) throw new Error('bloqueo');
      if (/WHERE uniqueid=\$1/.test(sql)) return { rows: args[0] === '1790000200.7' ? [{ src: '099', dst: 'ventas', linkedid: 'L-7' }] : [] };
      if (/WHERE \(src=\$1 OR dst=\$1\)/.test(sql)) { if (args[0] === '2007') throw new Error('timeout'); return { rows: args[0] === '2001' ? [{ src: '2001', dst: '099', linkedid: null }] : [] }; }
      if (/^INSERT INTO pbxng_recordings/.test(sql)) { if (args[1] === '2007') throw new Error('disco lleno'); return { rows: args[1] === 'sala5' ? [] : [{ id: args[0].length }] }; }
      return null;
    },
  });
  await x.m.indexRecordings();
  const ins = x.consultas.filter((c) => /^INSERT INTO pbxng_recordings/.test(c.sql)).map((c) => ({ archivo: c.args[0], ext: c.args[1], epoch: c.args[4], callId: c.args[7], origen: c.args[8] }));
  const por = Object.fromEntries(ins.map((i) => [i.archivo, i]));
  assert.ok(!por['pbxng-2003-1790000400.wav'], 'lo que se tocó hace 5 s no se indexa');
  assert.ok(!por['pbxng-2004-1790000500.wav']);
  assert.ok(!por['otro-nombre.wav']);
  assert.equal(por['pbxng-2002-1790000100123.wav'].epoch, 1790000100, 'milisegundos se pasan a segundos');
  assert.equal(por['pbxng-colaVentas-1790000200.7.wav'].origen, 'cola');
  assert.equal(por['pbxng-colaVentas-1790000200.7.wav'].callId, 'L-7');
  assert.equal(por['pbxng-q_soporte-1790000201.1.wav'].origen, 'cola');
  assert.equal(por['pbxng-sala5-1790000300.wav'].origen, 'sala');
  assert.equal(por['pbxng-ia1-1790000301.2.wav'].origen, 'ia');
  assert.equal(por['pbxng-ivrmenu-1790000302.wav'].origen, 'ivr');
  assert.equal(por['pbxng-2001-1790000100.wav'].callId, null, 'emparejado sin linkedid: null, no undefined');
  assert.ok(!x.consultas.some((c) => /pbxng_recordings SET bytes/.test(c.sql) && c.args[2] === 6), 'el que no creció no se toca');
  assert.ok(x.consultas.some((c) => /pbxng_recordings SET bytes/.test(c.sql) && c.args[2] === 5));
  // El evento sale sólo cuando la fila existe (la sala no devolvió id, el 2007 falló).
  const conEvento = eventos.map((e) => e.ev.datos.interno).sort();
  assert.ok(!conEvento.includes('sala5') && !conEvento.includes('2007'));
  assert.ok(conEvento.includes('colaVentas'));
});

test('indexador: sin volumen no hace nada; el Hangup lo dispara a los 4 s; sin AMI arranca igual', async (t) => {
  const x = armar(t, { manejar: (sql) => { if (/^INSERT INTO pbxng_recordings/.test(sql)) return { rows: [{ id: 1 }] }; return null; } });
  for (const f of fs.readdirSync(REC)) fs.rmSync(path.join(REC, f));
  poner('pbxng-2001-1790000700.wav', wav({ seg: 1 }));
  x.ami.emit('managerevent', { Event: 'Newchannel' });
  x.ami.emit('managerevent', null);
  x.ami.emit('managerevent', { event: 'Hangup' });
  x.ami.emit('managerevent', { Event: 'Hangup' });                   // el segundo reprograma, no duplica
  t.mock.timers.tick(4000);
  for (let i = 0; i < 10; i++) await tic();
  assert.equal(x.consultas.filter((c) => /^INSERT INTO pbxng_recordings/.test(c.sql)).length, 1);
  fs.rmSync(REC, { recursive: true, force: true });
  await x.m.indexRecordings();                                         // volumen ausente: no tira
  fs.mkdirSync(REC, { recursive: true });
  const y = armar(t, { conAmi: false });
  assert.equal(typeof y.m.indexRecordings, 'function', 'sin AMI el módulo arranca igual');
});
