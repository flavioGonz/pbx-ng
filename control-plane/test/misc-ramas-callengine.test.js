/* ============================================================================
 *  Motor de llamadas (callengine.js) en unidad, con un ARI y un AMI de mentira.
 *
 *  test/calls.test.js lo prueba por HTTP contra la API sin Asterisk (caminos «sin-ari»).
 *  Acá se fija lo que sólo se ve CON un ARI enchufado:
 *   - la caché se arma por eventos, ignora los canales internos (Snoop, Local…) y se
 *     reconcilia sola cada 20 s; si el primado falla se cae a preguntarle a ARI;
 *   - la supervisión: sin llamada del supervisado es 404; si el snoop o el originate
 *     fallan, la sesión se desarma (no quedan bridges huérfanos); cuando la llamada
 *     supervisada termina, la sesión se cierra sola;
 *   - las patas de Stasis de una sesión que ya no existe se cuelgan en vez de quedar
 *     colgadas en el limbo;
 *   - cortar una llamada: ARI primero, AMI con el NOMBRE del canal si ARI falla, y un
 *     error claro (502/503) cuando no hay ni con qué;
 *   - la transferencia a ciegas sólo encuentra al otro extremo si está puenteado.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const initCallEngine = require('../callengine');

function ariFalso({ canales = [], eps = [], romperListas = false } = {}) {
  const ari = new EventEmitter();
  const hechos = [];
  const falla = {};
  const registro = (nombre, devolver) => async (a) => { hechos.push([nombre, a]); if (falla[nombre]) throw new Error(falla[nombre]); return devolver ? devolver(a) : {}; };
  ari.channels = {
    list: async () => { if (romperListas) throw new Error('ARI lento'); return canales; },
    hangup: registro('hangup'), hold: registro('hold'), unhold: registro('unhold'),
    snoopChannel: registro('snoop', () => ({ id: 'snoop-1' })),
    originate: registro('originate', () => ({ id: 'orig-1' })),
  };
  ari.endpoints = { list: async () => { if (romperListas) throw new Error('ARI lento'); return eps; } };
  ari.bridges = { create: registro('bridgeCreate', () => ({ id: 'br-1' })), addChannel: registro('addChannel'), destroy: registro('bridgeDestroy') };
  return { ari, hechos, falla, set romper(v) { romperListas = v; } };
}

function armar(t, extra = {}) {
  try { t.mock.timers.enable({ apis: ['setInterval'] }); } catch (_) { /* ya activo (segundo motor en la misma prueba) */ }
  const rutas = {};
  const reg = (m) => (ruta, ...h) => { rutas[m + ' ' + ruta] = h[h.length - 1]; };
  const ami = [];
  let amiFalla = null;
  let concise = '';
  let avisos = 0;
  const logs = [];
  const eng = initCallEngine({
    app: { get: reg('GET'), post: reg('POST'), delete: reg('DELETE') },
    auth: () => {},
    amiAction: async (a) => { ami.push(a); if (amiFalla) throw new Error(amiFalla); return {}; },
    amiCommand: async () => concise,
    broadcastSoon: () => { avisos++; },
    log: (...a) => logs.push(a),
    appName: 'pbxng',
    ...extra,
  });
  return {
    eng, rutas, ami, logs,
    set amiFalla(v) { amiFalla = v; },
    set concise(v) { concise = v; },
    get avisos() { return avisos; },
  };
}

async function http(handler, req = {}) {
  const res = { statusCode: 200, cuerpo: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.cuerpo = b; return this; } };
  await handler({ params: {}, ...req }, res);
  return res;
}
const tic = () => new Promise((r) => setImmediate(r));

test('caché por eventos: filtra canales internos, sigue a los endpoints y se reconcilia sola', async (t) => {
  const f = ariFalso({
    canales: [
      { id: 'c1', name: 'PJSIP/2001-0001', state: 'Up', caller: { number: '2001' }, connected: { number: '2002' }, creationtime: 'ayer' },
      { id: 'c2', name: 'Snoop/c1-0002', state: 'Up' },
    ],
    eps: [{ resource: '2001', state: 'online', channel_ids: ['c1'] }, { resource: '2002', state: 'offline' }],
  });
  const x = armar(t);
  assert.deepEqual(await x.eng.getChannels(), [], 'sin ARI no hay canales');
  assert.deepEqual(await x.eng.endpointStates(), {});
  assert.equal((await http(x.rutas['GET /api/calls/live'])).cuerpo.via, 'sin-ari');

  x.eng.attach(f.ari);
  await tic();
  assert.equal((await http(x.rutas['GET /api/calls/live'])).cuerpo.via, 'eventos');
  let chs = await x.eng.getChannels();
  assert.deepEqual(chs.map((c) => c.id), ['c1']);
  assert.equal(chs[0].ext, '2001');
  assert.equal(chs[0].connected, '2002');
  assert.deepEqual(await x.eng.endpointStates(), { 2001: { state: 'online', channels: 1 }, 2002: { state: 'offline', channels: 0 } });

  f.ari.emit('ChannelCreated', {}, { id: 'c3', name: 'PJSIP/2003-0003', state: 'Ring' });
  f.ari.emit('ChannelCreated', {}, { id: 'c4', name: 'Local/x@y-0004;1', state: 'Up' });
  f.ari.emit('ChannelStateChange', {}, null);
  f.ari.emit('ChannelCallerId', {}, { id: 'c5', state: 'Up' });               // sin nombre: entra, sin interno
  f.ari.emit('ChannelDestroyed', {}, { id: 'c1' });
  f.ari.emit('ChannelDestroyed', {}, null);
  f.ari.emit('EndpointStateChange', {}, { resource: '2003', state: 'online' });
  f.ari.emit('EndpointStateChange', {}, {});
  f.ari.emit('DeviceStateChanged', {});
  chs = await x.eng.getChannels();
  assert.deepEqual(chs.map((c) => c.id).sort(), ['c3', 'c5']);
  assert.equal(chs.find((c) => c.id === 'c5').ext, null);
  assert.equal((await x.eng.endpointStates())['2003'].channels, 0);
  // c3, c5, los dos ChannelDestroyed, el endpoint 2003 y el DeviceStateChanged: el
  // Local, el canal nulo y el EndpointStateChange sin recurso no molestan al panel.
  assert.equal(x.avisos, 6);

  // El reconciliado de 20 s pisa la caché con lo que dice ARI (c1 vuelve: el evento se había «perdido»).
  t.mock.timers.tick(20000);
  await tic();
  assert.deepEqual((await x.eng.getChannels()).map((c) => c.id), ['c1']);

  // Si el reconciliado falla, se deja de confiar en la caché y se lee directo de ARI.
  f.romper = true;
  t.mock.timers.tick(20000);
  await tic();
  assert.deepEqual(x.logs.at(-1), ['prime', 'ARI lento']);
  assert.equal((await http(x.rutas['GET /api/calls/live'])).cuerpo.via, 'api');
  assert.deepEqual(await x.eng.getChannels(), [], 'ARI tampoco contesta: lista vacía, no excepción');
  assert.deepEqual(await x.eng.endpointStates(), {});
  f.romper = false;
  assert.deepEqual((await x.eng.getChannels()).map((c) => c.id), ['c1'], 'sin caché pero con ARI: lee la API');
  assert.equal((await x.eng.endpointStates())['2001'].channels, 1);

  x.eng.detach();
  t.mock.timers.tick(20000);                                                 // sin ARI el reconciliado no hace nada
  assert.deepEqual(await x.eng.getChannels(), []);
});

test('supervisión con ARI: 404 sin llamada, sesión completa, cierre solo y limpieza ante fallas', async (t) => {
  const f = ariFalso({ canales: [{ id: 'c1', name: 'PJSIP/2001-0001', state: 'Up' }, { id: 'c9', name: 'PJSIP/2009-0009', state: 'Down' }] });
  const x = armar(t);
  x.eng.attach(f.ari);
  await tic();
  const espiar = x.rutas['POST /api/calls/spy'];

  let r = await http(espiar, {});
  assert.equal(r.statusCode, 400, 'sin cuerpo falta el supervisor');
  r = await http(espiar, { body: { sup: '2005', target: '2009' } });
  assert.equal(r.statusCode, 404, 'un canal en Down no es una llamada en curso');

  r = await http(espiar, { body: { sup: '2005', target: '2001', mode: 'whisper' } });
  assert.equal(r.cuerpo.via, 'ari');
  const id = r.cuerpo.id;
  assert.equal(f.hechos.find((h) => h[0] === 'snoop')[1].whisper, 'out');
  assert.equal(f.hechos.find((h) => h[0] === 'originate')[1].appArgs, 'spyjoin,' + id);

  // Patas de Stasis: la del snoop y la del supervisor entran al bridge de la sesión.
  const pata = (cid, fallar) => ({ id: cid, answer: async () => { if (fallar) throw new Error('ya atendido'); }, hangup: async () => { throw new Error('ya colgado'); } });
  assert.equal(await x.eng.handleStasis({ args: ['otra-cosa'] }, pata('z')), false);
  assert.equal(await x.eng.handleStasis({}, pata('z')), false);
  assert.equal(await x.eng.handleStasis({ args: ['spysnoop', id] }, pata('snoop-1', true)), true);
  f.falla.addChannel = 'bridge lleno';
  assert.equal(await x.eng.handleStasis({ args: ['spyjoin', id] }, pata('sup-1')), true);
  delete f.falla.addChannel;
  assert.ok(x.logs.some((l) => l[0] === 'spy add'));
  assert.equal(x.eng.spies.get(id).supId, 'sup-1');
  // Una pata de una sesión que ya no existe se cuelga (aunque colgar falle).
  assert.equal(await x.eng.handleStasis({ args: ['spyjoin', 'spy-viejo'] }, pata('q')), true);

  // Un canal ajeno que termina no cierra la sesión; el supervisado sí.
  f.ari.emit('ChannelDestroyed', {}, { id: 'otro' });
  f.ari.emit('ChannelDestroyed', {}, null);
  assert.ok(x.eng.spies.has(id));
  f.falla.hangup = 'ya no existe';
  f.falla.bridgeDestroy = 'ya no existe';
  f.ari.emit('ChannelDestroyed', {}, { id: 'c1' });
  await tic();
  assert.equal(x.eng.spies.has(id), false, 'la sesión se cerró sola aunque los cuelgues fallen');
  delete f.falla.hangup; delete f.falla.bridgeDestroy;
  assert.deepEqual((await http(x.rutas['DELETE /api/calls/spy/:id'], { params: { id } })).cuerpo, { ok: false });

  // Falla el snoop: se desarma el bridge y el error llega al cliente.
  f.ari.emit('ChannelCreated', {}, { id: 'c1', name: 'PJSIP/2001-0001', state: 'Up' });
  f.falla.snoop = 'canal sin medios';
  r = await http(espiar, { body: { sup: '2005', target: '2001', mode: 'barge' } });
  assert.equal(r.statusCode, 500);
  assert.equal(x.eng.spies.size, 0, 'no queda una sesión huérfana');
  assert.ok(f.hechos.filter((h) => h[0] === 'bridgeDestroy').length >= 2);
  delete f.falla.snoop;

  // Falla el originate del supervisor: se cuelga el snoop que ya estaba armado.
  f.falla.originate = 'el supervisor no existe';
  const antes = f.hechos.filter((h) => h[0] === 'hangup').length;
  r = await http(espiar, { body: { sup: '2005', target: '2001' } });
  assert.equal(r.statusCode, 500);
  assert.equal(f.hechos.filter((h) => h[0] === 'hangup').length, antes + 1);
  assert.equal(f.hechos.filter((h) => h[0] === 'snoop').at(-1)[1].whisper, 'none', 'sin modo: escucha');
  delete f.falla.originate;

  // Una sesión viva se corta por DELETE.
  r = await http(espiar, { body: { sup: '2005', target: '2001', mode: 'barge' } });
  assert.equal(f.hechos.filter((h) => h[0] === 'snoop').at(-1)[1].whisper, 'both');
  assert.equal((await http(x.rutas['GET /api/calls/spy'])).cuerpo.length, 1);
  assert.deepEqual((await http(x.rutas['DELETE /api/calls/spy/:id'], { params: { id: r.cuerpo.id } })).cuerpo, { ok: true });
});

test('supervisión sin ARI: cae a ChanSpy por AMI con la opción del modo', async (t) => {
  const x = armar(t);
  for (const [mode, opt] of [['whisper', 'qw'], ['barge', 'qB'], [undefined, 'q']]) {
    const r = await http(x.rutas['POST /api/calls/spy'], { body: { sup: '2005', target: '2001', mode } });
    assert.deepEqual(r.cuerpo, { ok: true, id: null, via: 'ami' });
    assert.equal(x.ami.at(-1).Data, 'PJSIP/2001,' + opt);
  }
});

test('cortar: ARI, si no AMI por nombre, y errores claros cuando no hay con qué', async (t) => {
  const f = ariFalso({ canales: [{ id: 'c1', name: 'PJSIP/2001-0001', state: 'Up' }] });
  const x = armar(t);
  const colgar = x.rutas['POST /api/calls/:id/hangup'];
  let r = await http(colgar, { params: { id: 'c1' } });
  assert.equal(r.statusCode, 503, 'sin ARI y sin el nombre en la caché no hay cómo');

  x.eng.attach(f.ari);
  await tic();
  r = await http(colgar, { params: { id: 'c1' } });
  assert.deepEqual(r.cuerpo, { ok: true, via: 'ari' });

  f.falla.hangup = 'Channel not found';
  r = await http(colgar, { params: { id: 'desconocido' } });
  assert.equal(r.statusCode, 502);
  assert.match(r.cuerpo.error, /Channel not found/);

  const avisos = x.avisos;
  r = await http(colgar, { params: { id: 'c1' } });
  assert.deepEqual(r.cuerpo, { ok: true, via: 'ami' });
  assert.deepEqual(x.ami.at(-1), { Action: 'Hangup', Channel: 'PJSIP/2001-0001' });
  assert.equal(x.avisos, avisos + 1);
  assert.deepEqual(x.logs.at(-1), ['corte forzado por AMI', 'PJSIP/2001-0001', 'Channel not found']);

  // AMI también falla: 502 con el nombre del canal.
  f.ari.emit('ChannelCreated', {}, { id: 'c1', name: 'PJSIP/2001-0001', state: 'Up' });
  x.amiFalla = 'Permission denied';
  r = await http(colgar, { params: { id: 'c1' } });
  assert.equal(r.statusCode, 502);
  assert.match(r.cuerpo.error, /PJSIP\/2001-0001: Permission denied/);
  x.amiFalla = null;

  // ARI no corta y no hay broadcastSoon configurado: igual corta por AMI.
  const g = armar(t, { broadcastSoon: undefined });
  const f2 = ariFalso({ canales: [{ id: 'k', name: 'PJSIP/3001-1', state: 'Up' }] });
  g.eng.attach(f2.ari);
  await tic();
  f2.falla.hangup = 'x';
  r = await g.eng.colgarCanal('k');
  assert.deepEqual(r, { ok: true, via: 'ami' }, 'sin broadcastSoon no revienta');

  // Hold / unhold.
  for (const ruta of ['hold', 'unhold']) {
    assert.deepEqual((await http(x.rutas['POST /api/calls/:id/' + ruta], { params: { id: 'c1' } })).cuerpo, { ok: true });
  }
  x.eng.detach();
  for (const ruta of ['hold', 'unhold']) assert.equal((await http(x.rutas['POST /api/calls/:id/' + ruta], { params: { id: 'c1' } })).statusCode, 503);
});

test('transferir y aparcar: sólo con el otro extremo puenteado; originar valida', async (t) => {
  const x = armar(t, { mismaExt: (req, ext) => ext !== '9999' });
  const transferir = x.rutas['POST /api/calls/transfer'];
  const aparcar = x.rutas['POST /api/calls/park'];
  let r = await http(transferir, { body: { ext: '9999', to: '2002' } });
  assert.equal(r.statusCode, 403, 'no se opera la llamada de otro interno');

  x.concise = '';
  r = await http(transferir, { body: { ext: '2001', to: '2002' } });
  assert.equal(r.statusCode, 404);
  x.concise = 'PJSIP/2001-0001!internal!2002!1!Up!Dial!x!2001!!3!10!\n';
  assert.equal((await http(transferir, { body: { ext: '2001', to: '2002' } })).statusCode, 404, 'sin bridge no hay a quién mandar');
  x.concise = 'PJSIP/2001-0001!internal!2002!1!Up!Dial!x!2001!!3!10!br-9\nPJSIP/2003-0002!internal!s!1!Up!Dial!x!2003!!3!10!br-1\n';
  assert.equal((await http(transferir, { body: { ext: '2001', to: '2002' } })).statusCode, 404, 'puenteado con nadie');
  x.concise = 'PJSIP/2001-0001!internal!2002!1!Up!Dial!x!2001!!3!10!br-9\nPJSIP/trunk-0002!from!s!1!Up!Dial!x!2003!!3!10!br-9\n';
  r = await http(transferir, { body: { ext: '2001', to: 2002, context: 'ventas' } });
  assert.deepEqual(r.cuerpo, { ok: true, peer: 'PJSIP/trunk-0002', to: '2002' });
  assert.deepEqual(x.ami.at(-1), { Action: 'Redirect', Channel: 'PJSIP/trunk-0002', Context: 'ventas', Exten: '2002', Priority: 1 });
  r = await http(aparcar, { body: { ext: '2001' } });
  assert.equal(r.cuerpo.to, '700', 'sin lugar va al primero del estacionamiento');
  assert.equal((await http(aparcar, { body: { ext: '2001', slot: '705' } })).cuerpo.to, '705');
  assert.equal(x.ami.at(-1).Exten, '705');
  assert.equal((await http(aparcar, {})).statusCode, 400);

  await assert.rejects(x.eng.originar({ from: '2001' }), { status: 400 });
  await assert.rejects(x.eng.originar({ from: '2001', to: '2002' }), { status: 503 });
  const f = ariFalso();
  x.eng.attach(f.ari);
  r = await http(x.rutas['POST /api/calls/dial'], { body: { from: '2001', to: '1100' } });
  assert.deepEqual(r.cuerpo, { ok: true, channel: 'orig-1' });
  assert.equal(f.hechos.find((h) => h[0] === 'originate')[1].context, 'internal');
  assert.equal((await http(x.rutas['POST /api/calls/dial'], {})).statusCode, 400);
});

test('sin mismaExt ni log propios se usan los valores por defecto', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const rutas = {};
  const reg = (m) => (ruta, ...h) => { rutas[m + ' ' + ruta] = h[h.length - 1]; };
  const eng = initCallEngine({ app: { get: reg('GET'), post: reg('POST'), delete: reg('DELETE') }, auth: () => {}, amiAction: async () => ({}), amiCommand: async () => '' });
  const f = ariFalso();
  f.ari.endpoints.list = async () => { throw new Error('caído'); };
  eng.attach(f.ari);                   // el primado falla y loguea con el logger del repo
  await tic();
  const r = await http(rutas['POST /api/calls/transfer'], { body: { ext: '2001', to: '2' } });
  assert.equal(r.statusCode, 404, 'sin mismaExt cualquiera puede (compatibilidad): llega a buscar el puente');
});
