/* ============================================================================
 *  Integración · grabaciones (recordings.js): el indexador que convierte los WAV del
 *  volumen en filas, su emparejado con el CDR, el audio, las ondas, la transcripción y
 *  el permiso de cada uno.
 *
 *  La API corre con TZ=America/Montevideo, que es como corre en una central: Asterisk
 *  escribe el CDR en hora LOCAL (cdr_pgsql sin `timezone`) y la base está en UTC. Con
 *  la CI en UTC las dos horas coinciden y un emparejado mal hecho no se nota nunca.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { httpFalso } = require('./helpers/http-falso');

function wav(seg = 1, nivel = 4000) {
  const n = 8000 * seg, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / 7) * nivel), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 15000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(200); } return fn(); }
/* La hora de pared de Montevideo para un epoch: es lo que Asterisk escribe en cdr.start. */
const paredMvd = (epoch) => new Date(epoch * 1000).toLocaleString('sv-SE', { timeZone: 'America/Montevideo' }).replace(' ', 'T');

test('grabaciones: indexador, emparejado con el CDR en hora local, audio, ondas, transcripción y permisos', async (t) => {
  const ami = await amiFalso();
  const voz = await httpFalso();
  t.after(async () => { await ami.cerrar(); await voz.cerrar(); });
  const ctx = await entorno(t, Object.assign({}, ami.env, { TZ: 'America/Montevideo' }));
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login, base } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  const REC = path.join(ctx.api.confDir, 'rec');
  fs.mkdirSync(REC, { recursive: true });
  const poner = (nombre, contenido, haceSeg = 60) => { const f = path.join(REC, nombre); fs.writeFileSync(f, contenido); const t2 = new Date(Date.now() - haceSeg * 1000); fs.utimesSync(f, t2, t2); };
  const indexar = async () => { ami.emitir({ Event: 'Hangup', Uniqueid: 'x', Linkedid: 'y' }); await dormir(4500); };

  /* Una llamada de un interno, grabada por el dialplan con ${EPOCH} en el nombre. */
  const epoch = Math.floor(Date.now() / 1000) - 600;
  await ctx.db.query("INSERT INTO cdr (start, clid, src, dst, dcontext, duration, billsec, disposition, uniqueid, linkedid) VALUES ($1::timestamp, '\"Ana\" <2001>', '2001', '099123456', 'internal', 40, 35, 'ANSWERED', 'u-1', 'L-1')", [paredMvd(epoch)]);
  /* Una de cola, que se empareja por UNIQUEID; y una de sala, de IA y de IVR. */
  await ctx.db.query("INSERT INTO cdr (start, src, dst, dcontext, duration, billsec, disposition, uniqueid, linkedid) VALUES ($1::timestamp, '099777', '8200', 'ivr', 20, 15, 'ANSWERED', '1790000000.7', 'L-2')", [paredMvd(epoch)]);
  poner('pbxng-2001-' + epoch + '.wav', wav(2));
  poner('pbxng-colaventas-1790000000.7.wav', wav(1));
  poner('pbxng-sala9001-1790000001.1.wav', wav(1));
  poner('pbxng-ia7-1790000002.2.wav', wav(1, 0));
  poner('pbxng-ivr8000-1790000003.3.wav', wav(1));
  poner('pbxng-2002-' + (epoch * 1000) + '.wav', wav(1));   // el viejo nombre en milisegundos
  poner('pbxng-2003-' + epoch + '.wav', wav(1), 2);          // todavía creciendo: no se indexa
  poner('pbxng-chica-1790000004.wav', Buffer.alloc(500));     // demasiado chica
  poner('otra-cosa.wav', wav(1));                             // no es de la central

  let grab;
  await t.test('el indexador toma lo que corresponde y empareja con el CDR', async () => {
    await indexar();
    grab = await hasta(async () => { const r = (await api('GET', '/api/recordings', { token: admin })).json; return Array.isArray(r) && r.length >= 6 ? r : null; });
    assert.ok(grab, 'no indexó');
    const por = (f) => grab.find((g) => g.filename === f);
    const interno = por('pbxng-2001-' + epoch + '.wav');
    assert.equal(interno.src, '2001');
    assert.equal(interno.dst, '099123456', 'la grabación del interno no encontró su llamada: el CDR está en hora local');
    assert.equal(por('pbxng-colaventas-1790000000.7.wav').dst, '8200', 'la de cola se empareja por UNIQUEID');
    assert.deepEqual(['sala', 'cola', 'ia', 'ivr'].map((o) => grab.some((g) => g.origen === o)), [true, true, true, true]);
    const ms = por('pbxng-2002-' + (epoch * 1000) + '.wav');
    assert.equal(new Date(ms.started_at).getFullYear() < 3000, true, 'un nombre en milisegundos no puede quedar en el año 58707');
    assert.equal(grab.some((g) => /2003|chica|otra-cosa/.test(g.filename)), false);
  });

  await t.test('audio, ondas (y su caché), y una que creció después de indexarse', async () => {
    const g = grab.find((x) => x.filename === 'pbxng-2001-' + epoch + '.wav');
    const a = await fetch(base + '/api/recordings/' + g.id + '/audio', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('content-type'), 'audio/wav');
    const p = (await api('GET', '/api/recordings/' + g.id + '/peaks', { token: admin })).json;
    assert.equal(p.peaks.length, 40);
    assert.equal(p.silent, false);
    assert.deepEqual((await api('GET', '/api/recordings/' + g.id + '/peaks', { token: admin })).json, p, 'la segunda vez sale del caché');
    const muda = grab.find((x) => x.origen === 'ia');
    assert.equal((await api('GET', '/api/recordings/' + muda.id + '/peaks', { token: admin })).json.silent, true);
    assert.equal((await api('GET', '/api/recordings/999999/peaks', { token: admin })).status, 404);
    poner('pbxng-2001-' + epoch + '.wav', wav(5));
    await indexar();
    const d = await hasta(async () => { const r = (await api('GET', '/api/recordings', { token: admin })).json.find((x) => x.id === g.id); return r && r.duration >= 5 ? r : null; });
    assert.ok(d, 'la duración no se corrigió');
    fs.rmSync(path.join(REC, g.filename));
    assert.equal((await fetch(base + '/api/recordings/' + g.id + '/audio', { headers: { Authorization: 'Bearer ' + admin } })).status, 502, 'sin archivo no hay audio');
    assert.deepEqual((await api('GET', '/api/recordings/' + g.id + '/peaks', { token: admin })).json.silent !== undefined, true);
  });

  await t.test('transcripción contra el servicio de voz, y la que no existe', async () => {
    await ctx.db.query("INSERT INTO pbxng_settings (key,value) VALUES ('voz_url',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [voz.url]);
    voz.ruta('POST', '/stt', { text: 'Buenas, quiero hacer un reclamo urgente porque no funciona' });
    const g = grab.find((x) => x.origen === 'cola');
    const tr = await api('POST', '/api/recordings/' + g.id + '/transcribe', { token: admin });
    assert.equal(tr.status, 200, JSON.stringify(tr.json));
    assert.match(tr.json.transcript, /reclamo/);
    const leida = await api('GET', '/api/recordings/' + g.id + '/transcript', { token: admin });
    assert.match(leida.json.transcript, /reclamo/);
    assert.ok(leida.json.analysis);
    assert.equal((await api('POST', '/api/recordings/999999/transcribe', { token: admin })).status, 404);
    assert.equal((await api('GET', '/api/recordings/999999/transcript', { token: admin })).status, 404);
  });

  await t.test('un agente escucha sólo sus llamadas; sin interno, ninguna', async () => {
    await api('POST', '/api/users', { token: admin, body: { username: 'ana', password: 'Clave-ana-1234', role: 'agente', ext: '2002' } });
    await api('POST', '/api/users', { token: admin, body: { username: 'sin', password: 'Clave-sin-1234', role: 'agente' } });
    const ana = (await login('ana', 'Clave-ana-1234')).token, sin = (await login('sin', 'Clave-sin-1234')).token;
    const suya = grab.find((x) => x.ext === '2002'), ajena = grab.find((x) => x.origen === 'cola');
    assert.equal((await fetch(base + '/api/recordings/' + suya.id + '/audio', { headers: { Authorization: 'Bearer ' + ana } })).status, 200);
    assert.equal((await api('GET', '/api/recordings/' + ajena.id + '/audio', { token: ana })).status, 403);
    assert.equal((await api('GET', '/api/recordings/' + suya.id + '/audio', { token: sin })).status, 403);
    assert.equal((await api('GET', '/api/recordings/999999/audio', { token: admin })).status, 404);
    assert.deepEqual((await api('GET', '/api/recordings/match', { token: ana })).json, {});
    assert.equal((await api('GET', '/api/recordings/match?from=2001&to=2005', { token: ana })).status, 403);
    assert.equal((await api('GET', '/api/recordings/match?from=2001', { token: sin })).status, 403);
    const m = await api('GET', '/api/recordings/match?from=2002&ts=' + (epoch * 1000), { token: ana });
    assert.equal(m.status, 200);
    assert.equal((await api('GET', '/api/cdr', { token: sin })).status, 403);
    const cdr = (await api('GET', '/api/cdr?limit=9999', { token: ana })).json;
    assert.ok(cdr.every((c) => c.src === '2002' || c.dst === '2002'));
    assert.ok((await api('GET', '/api/cdr?ext=2001', { token: admin })).json.length >= 1);
  });

  await t.test('grabar en vivo: por ARI no hay, por AMI se encuentra el canal y se pide MixMonitor', async () => {
    assert.equal((await api('POST', '/api/calls/record', { token: admin, body: {} })).status, 400);
    ami.comando(/^core show channels concise/, '');
    assert.equal((await api('POST', '/api/calls/record', { token: admin, body: { ext: '2001' } })).status, 404);
    ami.comando(/^core show channels concise/, 'PJSIP/2001-00000009!internal!2001!1!Up!Dial!x!2001!!!3!br');
    ami.olvidar();
    assert.equal((await api('POST', '/api/calls/record', { token: admin, body: { ext: '2001' } })).json.ok, true);
    const mm = ami.pedidos('MixMonitor')[0];
    assert.equal(mm.channel, 'PJSIP/2001-00000009');
    assert.match(mm.file, /^pbxng-2001-\d{10}\.wav$/, 'el sello va en segundos, no en milisegundos');
    assert.equal((await api('POST', '/api/calls/record', { token: admin, body: { ext: '2001', action: 'stop' } })).json.ok, true);
    assert.equal(ami.pedidos('StopMixMonitor').length, 1);
  });

  await t.test('almacenamiento: probar, sincronizar y uso', async () => {
    assert.equal((await api('POST', '/api/recordings/storage/test', { token: admin })).json.ok, true);
    assert.equal((await api('POST', '/api/recordings/storage/sync', { token: admin })).json.ok, true);
    assert.equal((await api('GET', '/api/recordings/storage/usage', { token: admin })).json.backend, 'local');
    assert.equal((await api('POST', '/api/recordings/storage/nastest', { token: admin, body: { nas_type: 'nfs' } })).json.ok, false);
  });
});
