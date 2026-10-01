/* ============================================================================
 *  IA externa (ia-externa.js + lo que suma realtime.js): el backend del asistente conduce
 *  la llamada y la central le hace de relay.
 *
 *  Contra qué se prueba: un servidor WebSocket FALSO que hace de backend (canal de
 *  control) o de GPT-Live, y un `fetch` de mentira para la configuración. Lo que importa
 *  fijar acá es lo que, si falla, deja a un visitante mudo o cortado:
 *
 *   · sin configuración la llamada va al respaldo, sin abrir sesión;
 *   · cada orden se confirma DESPUÉS de ejecutarse, y una repetida no se ejecuta dos veces
 *     (el backend reenvía las que no vio confirmadas), también por un relay reabierto;
 *   · por el relay solo pasan los tres comandos permitidos;
 *   · el relay numera cada evento y hecho, y si se corta se reabre y reenvía desde donde
 *     el backend diga (contrato v2: otra instancia retoma la llamada);
 *   · la sesión se abre con la configuración del backend TAL CUAL, sin nada nuestro.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const iax = require('../ia-externa');
const rt = require('../realtime');

const esperar = (ms = 60) => new Promise((ok) => setTimeout(ok, ms));

/* Un backend falso: acepta el canal de control y junta lo que le manda la central. */
async function backendFalso() {
  const recibido = [];
  const headers = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((ok) => wss.once('listening', ok));
  let cliente = null;
  wss.on('connection', (ws, req) => {
    cliente = ws;
    headers.push({ url: req.url, auth: req.headers.authorization });
    ws.on('message', (d) => { try { recibido.push(JSON.parse(String(d))); } catch (_) {} });
  });
  return {
    recibido, headers,
    url: () => 'http://127.0.0.1:' + wss.address().port,
    mandar: (o) => cliente && cliente.send(JSON.stringify(o)),
    conexiones: () => wss.clients.size,
    cerrar: () => new Promise((ok) => { for (const c of wss.clients) { try { c.terminate(); } catch (_) {} } wss.close(ok); }),
  };
}

test('decidirArranque: sin configuración, respaldo; con ella se atiende, aunque el canal de control esté caído (v2)', () => {
  assert.deepEqual(iax.decidirArranque({ config: null }), { atender: false, motivo: 'no hay configuración bajada del backend' });
  assert.deepEqual(iax.decidirArranque({ config: { session: {} } }), { atender: true, motivo: '' });
});

test('por el relay solo pasan instructions, commentary y close', () => {
  for (const type of ['session.instructions.append', 'session.commentary.append', 'session.close']) assert.ok(iax.comandoPermitido({ type }));
  for (const type of ['session.update', 'response.create', 'session.start', undefined]) assert.equal(iax.comandoPermitido({ type }), null);
  assert.equal(iax.comandoPermitido(null), null);
});

test('bajarConfig: pide con el token y la versión que tiene; 304 no cambia nada', async () => {
  const pedidos = [];
  const fetchFalso = (respuesta) => async (url, opts) => { pedidos.push({ url, headers: opts.headers }); return respuesta; };
  const cfg = { version: 'abc123', session: { model: 'gpt-live-1', instructions: 'Sos el portero' }, attachTimeoutMs: 4000 };
  const nueva = await iax.bajarConfig({ url: 'http://backend:3100/', token: 't0k', version: null, fetchImpl: fetchFalso(new Response(JSON.stringify(cfg), { status: 200 })) });
  assert.deepEqual(nueva, { cambio: true, config: { version: 'abc123', session: cfg.session, attachTimeoutMs: 4000, resumeWindowMs: 20000 } });
  assert.equal(pedidos[0].url, 'http://backend:3100/api/pbx/session-config');
  assert.equal(pedidos[0].headers.Authorization, 'Bearer t0k');

  const igual = await iax.bajarConfig({ url: 'http://backend:3100', token: 't0k', version: 'abc123', fetchImpl: fetchFalso(new Response(null, { status: 304 })) });
  assert.deepEqual(igual, { cambio: false });
  assert.equal(pedidos[1].headers['If-None-Match'], '"abc123"');

  await assert.rejects(iax.bajarConfig({ url: 'http://backend', token: 'x', fetchImpl: fetchFalso(new Response('no', { status: 401 })) }), /contestó 401/);
});

test('canal de control: ejecuta la orden, la confirma, y una repetida no se ejecuta dos veces', async (t) => {
  const srv = await backendFalso();
  t.after(() => srv.cerrar());
  const ejecutadas = [];
  let falla = false;
  const canal = new iax.CanalControl({
    url: srv.url(), token: 't0k',
    alOrden: async (o) => { ejecutadas.push(o.id); if (falla) throw new Error('el backend no contesta'); },
  });
  t.after(() => canal.parar());
  canal.iniciar();
  await esperar(100);
  assert.equal(srv.headers[0].url, '/api/pbx/canal');
  assert.equal(srv.headers[0].auth, 'Bearer t0k');
  assert.ok(canal.conectado);

  srv.mandar({ id: 'r1', type: 'refrescar_config' });
  srv.mandar({ id: 'r1', type: 'refrescar_config' });
  await esperar(60);
  falla = true;
  srv.mandar({ id: 'r2', type: 'refrescar_config' });
  await esperar(100);
  assert.deepEqual(ejecutadas, ['r1', 'r2']);
  assert.deepEqual(srv.recibido, [
    { type: 'ack', id: 'r1' },
    { type: 'orden_fallida', pbxCallId: null, ordenId: 'r2', detalle: 'el backend no contesta' },
  ]);
  /* Repetida después de terminar: se contesta lo mismo, sin volver a ejecutarla. */
  srv.mandar({ id: 'r2', type: 'refrescar_config' });
  await esperar(60);
  assert.deepEqual(ejecutadas, ['r1', 'r2']);
  assert.deepEqual(srv.recibido.at(-1), { type: 'orden_fallida', pbxCallId: null, ordenId: 'r2', detalle: 'el backend no contesta' });
  canal.parar();
  await esperar(50);
  assert.equal(canal.enviar({ type: 'ack', id: 'x' }), false, 'con el canal caído no sale nada');
});

test('crear: un canal por backend de IA externa; refrescar baja la configuración; nada más va por el canal (v2)', async (t) => {
  const srv = await backendFalso();
  t.after(() => srv.cerrar());
  const guardadas = [];
  const cfg = { version: 'v1', session: { model: 'gpt-live-1' }, attachTimeoutMs: 3000, resumeWindowMs: 15000 };
  const m = iax.crear({
    agentes: async () => [
      { id: 1, provider: 'ia-externa', enabled: true, externo_url: srv.url(), externo_token: 't0k' },
      { id: 2, provider: 'ia-externa', enabled: true, externo_url: srv.url(), externo_token: 't0k' },
      { id: 3, provider: 'openai-realtime', enabled: true, externo_url: srv.url(), externo_token: 't0k' },
      { id: 4, provider: 'ia-externa', enabled: false, externo_url: srv.url(), externo_token: 't0k' },
    ],
    leerConfig: async () => null,
    guardarConfig: async (id, c) => { guardadas.push([id, c.version, c.resumeWindowMs]); },
    fetchImpl: async () => new Response(JSON.stringify(cfg), { status: 200 }),
  });
  t.after(() => m.parar());
  await m.recargar();
  await esperar(100);
  assert.equal(srv.conexiones(), 1, 'los dos agentes del mismo backend comparten el canal');
  assert.equal(m.configDe(1), null);

  srv.mandar({ id: 'r1', type: 'refrescar_config' });
  await esperar(100);
  assert.deepEqual(guardadas, [[1, 'v1', 15000], [2, 'v1', 15000]]);
  assert.equal(m.configDe(1).version, 'v1');

  /* Las órdenes de una llamada ya no van por el canal: van por su relay. */
  srv.mandar({ id: 'o1', type: 'colgar', pbxCallId: 'c1' });
  await esperar(80);
  assert.deepEqual(srv.recibido.at(-1), { type: 'orden_fallida', pbxCallId: 'c1', ordenId: 'o1', detalle: 'orden desconocida en el canal de control: colgar' });
});

/* ── Lo que suma realtime.js ─────────────────────────────────────────────────── */
async function liveFalso() {
  const recibido = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((ok) => wss.once('listening', ok));
  let cliente = null;
  wss.on('connection', (ws) => {
    cliente = ws;
    ws.on('message', (d) => { try { recibido.push(JSON.parse(String(d))); } catch (_) {} });
    ws.send(JSON.stringify({ type: 'session.started', session: { id: 'live_1' } }));
  });
  return {
    recibido,
    url: () => 'ws://127.0.0.1:' + wss.address().port,
    mandar: (o) => cliente && cliente.send(JSON.stringify(o)),
    cerrar: () => new Promise((ok) => { for (const c of wss.clients) { try { c.terminate(); } catch (_) {} } wss.close(ok); }),
  };
}

test('realtime: con sessionCruda la sesión se abre con la configuración del backend tal cual', async (t) => {
  const srv = await liveFalso();
  t.after(() => srv.cerrar());
  const session = { model: 'gpt-live-1', instructions: 'Sos el portero virtual…', audio: { output: { voice: 'marin' } }, delegation: { type: 'responses', responses: { model: 'gpt-5.1' } } };
  const p = rt.abrir({ url: srv.url(), model: 'gpt-live-1', sessionCruda: session });
  t.after(() => p.cerrar());
  await p.cuandoListo(3000);
  await esperar(50);
  assert.deepEqual(srv.recibido[0], { type: 'session.start', session });
});

test('realtime: emite cada evento crudo y el audio que manda, y manda comandos crudos', async (t) => {
  const srv = await liveFalso();
  t.after(() => srv.cerrar());
  const p = rt.abrir({ url: srv.url(), model: 'gpt-live-1', sessionCruda: { model: 'gpt-live-1' } });
  t.after(() => p.cerrar());
  const crudos = [];
  const salida = [];
  p.on('crudo', (m) => crudos.push(m));
  p.on('audio-salida', (m) => salida.push(m));
  await p.cuandoListo(3000);
  srv.mandar({ type: 'session.output_transcript.delta', delta: 'Portería', start_ms: 800, end_ms: 1000 });
  p.enviarAudio(Buffer.alloc(320));
  p.enviarCrudo({ type: 'session.commentary.append', content: 'Portería Orison, ¿en qué lo puedo ayudar?', delegation_id: null });
  await esperar(80);
  assert.deepEqual(crudos.map((m) => m.type), ['session.started', 'session.output_transcript.delta']);
  assert.equal(crudos[1].start_ms, 800, 'el evento va tal cual, con sus marcas');
  assert.equal(salida.length, 1);
  assert.equal(salida[0].type, 'session.input_audio.append');
  assert.equal(Buffer.from(salida[0].audio, 'base64').length, 320 * 3, 'el audio que sale es el de 24 kHz, el mismo que recibe el modelo');
  assert.ok(srv.recibido.some((r) => r.type === 'session.commentary.append'));
});

/* ── El pipeline: sin backend listo, respaldo SIN atender ─────────────────────── */
test('pipeline: una llamada a la IA externa sin backend listo va al respaldo sin atenderse', async () => {
  const pipe = require('../ai-pipeline');
  pipe._setAri({ channels: {} });
  const hecho = [];
  const canal = {
    caller: { number: '2002' },
    answer: async () => hecho.push('atendida'),
    hangup: async () => hecho.push('colgada'),
    continueInDialplan: async (d) => hecho.push('respaldo ' + d.extension),
  };
  await pipe.startAiSession(canal, { id: 9, name: 'Portería', exten: '9750', provider: 'ia-externa', default_exten: '1001' });
  assert.deepEqual(hecho, ['respaldo 1001'], 'sin backend no se atiende: se manda al destino de respaldo');

  hecho.length = 0;
  await pipe.startAiSession(canal, { id: 9, name: 'Portería', exten: '9750', provider: 'ia-externa', default_exten: '' });
  assert.deepEqual(hecho, ['colgada'], 'sin respaldo configurado, se cuelga en vez de quedar mudo');
});

/* ── El tono de llamada en la transferencia ───────────────────────────────────
 * La llamada que sale de la IA ya está atendida: sin DIAL_OPCIONES=r, el Dial del interno
 * no genera el tono y quien llama escucha silencio hasta que atienden (el softphone del
 * panel cortaba a los ~8 s, 29/09). Lo que se fija: la variable va ANTES del
 * continueInDialplan, en todos los caminos, y si no se puede poner se transfiere igual. */
function canalQueAnota(hecho, { falla } = {}) {
  return {
    id: 'canal-1',
    caller: { number: '2002' },
    answer: async () => hecho.push('atendida'),
    hangup: async () => hecho.push('colgada'),
    setChannelVar: async (v) => {
      if (falla) throw new Error('Channel not in Stasis application');
      hecho.push('var ' + v.variable + '=' + v.value);
    },
    continueInDialplan: async (d) => hecho.push('dialplan ' + d.context + ',' + d.extension + ',' + d.priority),
  };
}
function sesionFalsa(canal, modo, logs) {
  return {
    uuid: 'sesion-' + modo, modo, channel: canal, agent: { id: 9, default_exten: '1001' },
    rt: { cerrar: () => {} }, closed: false, log: (m) => logs.push(m),
  };
}

test('transferencia de la IA: DIAL_OPCIONES=r antes de salir de Stasis, en modo externo y en realtime', async () => {
  const pipe = require('../ai-pipeline');
  pipe._setAri({ channels: { hangup: async () => {} } });
  for (const modo of ['externo', 'realtime']) {
    const hecho = []; const logs = [];
    const ok = await pipe._doTransfer(sesionFalsa(canalQueAnota(hecho), modo, logs), '1002', 'derivación del backend');
    assert.equal(ok, true, modo);
    assert.deepEqual(hecho, ['var DIAL_OPCIONES=r', 'dialplan internal,1002,1'],
      modo + ': la variable tiene que estar puesta cuando el canal llega al Dial del interno');
  }
});

test('transferencia de la IA: el respaldo también pide el tono, con sesión y sin sesión', async () => {
  const pipe = require('../ai-pipeline');
  pipe._setAri({ channels: { hangup: async () => {} } });
  /* Con la sesión ya abierta (se cayó el backend o no llegó la orden). */
  const hecho = []; const logs = [];
  await pipe._respaldoExterno(sesionFalsa(canalQueAnota(hecho), 'externo', logs), 'no llegó la orden');
  assert.deepEqual(hecho, ['var DIAL_OPCIONES=r', 'dialplan internal,1001,1']);

  /* Sin abrir sesión: la IA externa no está lista y la llamada va derecho al respaldo. */
  hecho.length = 0;
  await pipe.startAiSession(canalQueAnota(hecho), { id: 9, name: 'Portería', exten: '9750', provider: 'ia-externa', default_exten: '1001' });
  assert.deepEqual(hecho, ['var DIAL_OPCIONES=r', 'dialplan internal,1001,1']);
});

test('transferencia de la IA: si no se puede poner DIAL_OPCIONES, se transfiere igual y queda en el log', async () => {
  const pipe = require('../ai-pipeline');
  pipe._setAri({ channels: { hangup: async () => {} } });
  const hecho = []; const logs = [];
  const ok = await pipe._doTransfer(sesionFalsa(canalQueAnota(hecho, { falla: true }), 'externo', logs), '1002', 'derivación del backend');
  assert.equal(ok, true, 'una derivación sin tono es mejor que no derivar');
  assert.deepEqual(hecho, ['dialplan internal,1002,1'], 'no se colgó: se transfirió igual');
  assert.ok(logs.some((l) => /no se pudo pedir el tono de llamada \(DIAL_OPCIONES\).*Channel not in Stasis/.test(l)), logs.join(' | '));

  /* Lo mismo en el respaldo sin sesión. */
  hecho.length = 0;
  await pipe.startAiSession(canalQueAnota(hecho, { falla: true }), { id: 9, name: 'Portería', exten: '9750', provider: 'ia-externa', default_exten: '1001' });
  assert.deepEqual(hecho, ['dialplan internal,1001,1']);
});

/* ── Lo que agregó la revisión ────────────────────────────────────────────────── */
test('urlPermitida: http o https, en la red de la central o por internet', () => {
  for (const u of ['https://asistente.example.com', 'http://asistente.example.com', 'http://8.8.8.8:3100', 'http://127.0.0.1:3100', 'http://localhost:3100', 'http://asistente.local:3100', 'http://192.168.1.20:3100'])
    assert.equal(iax.urlPermitida(u).ok, true, u);
  for (const u of ['ftp://asistente.local', 'ws://asistente.local', 'asistente', 'http://[x', ''])
    assert.equal(iax.urlPermitida(u).ok, false, u);
});

test('destinoPermitido: solo los destinos del agente (en internal también están las troncales)', () => {
  const agente = { agentes_exten: '600', default_exten: '1001' };
  assert.equal(iax.destinoPermitido(agente, '600'), true);
  assert.equal(iax.destinoPermitido(agente, '1001'), true);
  for (const d of ['0099123456', '*98', '', '6000']) assert.equal(iax.destinoPermitido(agente, d), false, d);
  assert.equal(iax.destinoPermitido({ agentes_exten: '', default_exten: '' }, ''), false);
});

test('dtmfApertura: solo con abrir_porton encendido en modo DTMF y un tono válido', () => {
  assert.equal(iax.dtmfApertura({ herramientas: { abrir_porton: { on: true, modo: 'dtmf', dtmf: '#9' } } }), '#9');
  assert.equal(iax.dtmfApertura({ herramientas: { abrir_porton: { on: true } } }), '#', 'sin tono, el de fábrica');
  assert.equal(iax.dtmfApertura({ herramientas: { abrir_porton: { on: true, dtmf: '1w' } } }), null);
  assert.equal(iax.dtmfApertura({ herramientas: { abrir_porton: { on: true, modo: 'webhook', url: 'http://rele' } } }), null);
  assert.equal(iax.dtmfApertura({ herramientas: {} }), null);
});

test('bajarConfig: rechaza un modelo que no es GPT-Live y acota la espera del backend', async () => {
  const conCfg = (cfg) => async () => new Response(JSON.stringify(cfg), { status: 200 });
  await assert.rejects(iax.bajarConfig({ url: 'http://b', token: 't', fetchImpl: conCfg({ version: 'v', session: { model: 'gpt-realtime-2.1' } }) }), /no es GPT-Live/);
  const lenta = await iax.bajarConfig({ url: 'http://b', token: 't', fetchImpl: conCfg({ version: 'v', session: { model: 'gpt-live-1' }, attachTimeoutMs: 600000 }) });
  assert.equal(lenta.config.attachTimeoutMs, 30000);
  const apurada = await iax.bajarConfig({ url: 'http://b', token: 't', fetchImpl: conCfg({ version: 'v', session: { model: 'gpt-live-1' }, attachTimeoutMs: 1 }) });
  assert.equal(apurada.config.attachTimeoutMs, 1000);
});

test('bajarConfig: la ventana para reabrir el relay se acota de 0 a 60 s, con 20 s por defecto (v2)', async () => {
  const ventana = async (resumeWindowMs) => (await iax.bajarConfig({ url: 'http://b', token: 't', fetchImpl: async () => new Response(JSON.stringify({ version: 'v', session: { model: 'gpt-live-1' }, resumeWindowMs }), { status: 200 }) })).config.resumeWindowMs;
  assert.equal(await ventana(undefined), 20000);
  assert.equal(await ventana(null), 20000);
  assert.equal(await ventana(25000), 25000);
  assert.equal(await ventana(0), 0);
  assert.equal(await ventana(-5), 0);
  assert.equal(await ventana(600000), 60000);
  assert.equal(await ventana('mucho'), 20000);
});

test('crear: si la configuración no baja, refrescar falla (el backend se entera)', async (t) => {
  const srv = await backendFalso();
  t.after(() => srv.cerrar());
  const m = iax.crear({
    agentes: async () => [{ id: 1, provider: 'ia-externa', enabled: true, externo_url: srv.url(), externo_token: 't0k' }],
    leerConfig: async () => null, guardarConfig: async () => {},
    fetchImpl: async () => new Response('no', { status: 500 }),
  });
  t.after(() => m.parar());
  await m.recargar();
  await esperar(100);
  srv.mandar({ id: 'r1', type: 'refrescar_config' });
  await esperar(100);
  assert.equal(srv.recibido.at(-1).type, 'orden_fallida');
  assert.match(srv.recibido.at(-1).detalle, /no se pudo bajar la configuración/);
});

test('crear: un agente que se suma a un canal ya conectado baja su configuración', async (t) => {
  const srv = await backendFalso();
  t.after(() => srv.cerrar());
  let agentes = [{ id: 1, provider: 'ia-externa', enabled: true, externo_url: srv.url(), externo_token: 't0k' }];
  const cfg = { version: 'v1', session: { model: 'gpt-live-1' }, attachTimeoutMs: 3000 };
  const m = iax.crear({ agentes: async () => agentes, leerConfig: async () => null, guardarConfig: async () => {}, fetchImpl: async () => new Response(JSON.stringify(cfg), { status: 200 }) });
  t.after(() => m.parar());
  await m.recargar();
  await esperar(100);
  agentes = [...agentes, { id: 2, provider: 'ia-externa', enabled: true, externo_url: srv.url(), externo_token: 't0k' }];
  await m.recargar();
  await esperar(100);
  assert.equal(srv.conexiones(), 1);
  assert.equal(m.configDe(2).version, 'v1', 'sin esto, cada llamada al agente nuevo iba al respaldo');
});

test('canal de control: con el token rechazado lo avisa y espacia los reintentos', async (t) => {
  const { createServer } = require('node:http');
  const server = createServer();
  server.on('upgrade', (_req, socket) => { socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const logs = [];
  const canal = new iax.CanalControl({ url: 'http://127.0.0.1:' + server.address().port, token: 'malo', log: (m) => logs.push(m) });
  t.after(() => canal.parar());
  canal.iniciar();
  await esperar(150);
  assert.ok(logs.some((l) => /contestó 401 \(¿el token es el PBX_TOKEN del backend\?\)/.test(l)), logs.join(' | '));
  assert.equal(canal.ultimoStatus, 401);
});

test('canal de control: una URL imposible no traba el canal', () => {
  const logs = [];
  const canal = new iax.CanalControl({ url: 'http://[x', token: 't', log: (m) => logs.push(m) });
  canal.iniciar();
  canal.parar();
  assert.ok(logs.some((l) => /no se puede abrir/.test(l)));
});
