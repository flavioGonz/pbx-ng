/* ============================================================================
 *  Pipeline de IA con el modelo de voz por socket (ai-pipeline.js, modos realtime e
 *  IA externa): las herramientas y los cierres cuando algo de afuera falla.
 *
 *  ai-pipeline.test.js e ia-externa-llamada.test.js recorren las llamadas que salen
 *  bien. Acá se fija lo que pasa cuando el mundo real no coopera, porque cada una de
 *  estas cosas termina, si sale mal, en un visitante parado frente al portero:
 *
 *   · el CRM del cliente que contesta cualquier cosa (status de error, JSON roto, «no
 *     encontrado», sólo datos, nada) — al modelo le llega un motivo, nunca un texto raro
 *     para leer en voz alta;
 *   · la apertura por webhook sin URL, la auditoría con la base caída, el problema del
 *     proveedor que no se puede guardar, la caja del backoffice que suma herramientas o
 *     contesta que no;
 *   · el pedido de cortar (se despide y corta cuando termina de hablar), la escalera de
 *     inactividad que pregunta y después corta, y el proveedor que cierra limpio o se
 *     corta sin aviso;
 *   · IA externa con la configuración mínima que puede haber en la base, el portero
 *     identificado, lo que marca el visitante, un error del modelo, el relay que se
 *     pierde y la sesión de voz que no abre: todo va al respaldo, nunca a una llamada muda.
 *
 *  El modelo es un WebSocket local, el backend del asistente otro; el CRM, el portón y el
 *  backoffice se interceptan en `fetch`. Asterisk es helpers/llamada-ia.js.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { WebSocketServer } = require('ws');
const { hasta, dormir, puertoLibre, asteriskFalso, canal, hablar, audioDe } = require('./helpers/llamada-ia');

/* ── fetch: CRM, portón y backoffice, interceptados ───────────────────────── */
const fetchReal = globalThis.fetch;
const afuera = { crm: [], bo: [], catalogo: null, ejecutar: [] };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://crm.test')) {
    const r = afuera.crm.shift();
    return typeof r === 'function' ? r() : r;
  }
  if (u === 'http://bo.test/herramientas') return afuera.catalogo ? afuera.catalogo() : new Response('no', { status: 500 });
  if (u === 'http://bo.test/ejecutar') { afuera.bo.push(JSON.parse(opts.body)); return afuera.ejecutar.shift()(); }
  return fetchReal(url, opts);
};

/* ── La base de mentira ───────────────────────────────────────────────────── */
const ajustes = new Map([['openai_api_key', 'sk-x'], ['voz_url', 'http://127.0.0.1:1']]);
const acciones = [];
const estado = { agentes: [], configs: new Map(), clientes: [], auditoriaCaida: false, ajustesCaidos: false };
const pool = {
  async query(sql, args) {
    if (/SELECT value FROM pbxng_settings WHERE key=\$1/.test(sql)) return { rows: ajustes.has(args[0]) ? [{ value: ajustes.get(args[0]) }] : [] };
    if (/INSERT INTO pbxng_settings/.test(sql)) { if (estado.ajustesCaidos) throw new Error('base caída'); ajustes.set('ia_ultimo_problema', args[0]); return { rowCount: 1 }; }
    if (/INSERT INTO pbxng_ia_acciones/.test(sql)) { if (estado.auditoriaCaida) throw new Error('base caída'); acciones.push(args); return { rowCount: 1 }; }
    if (/FROM pbxng_ai_agents/.test(sql)) return { rows: estado.agentes };
    if (/FROM pbxng_ia_externa_config/.test(sql)) return { rows: estado.configs.has(args[0]) ? [estado.configs.get(args[0])] : [] };
    if (/FROM pbxng_clients/.test(sql)) return { rows: estado.clientes };
    return { rows: [], rowCount: 1 };
  },
};

/* ── El modelo de voz: Realtime o GPT-Live según lo que le pidan ──────────── */
async function modeloFalso({ live = false, contesta = false } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((ok) => wss.once('listening', ok));
  const m = { recibido: [], ws: null };
  const audio = (n = 4800) => ({ type: live ? 'session.output_audio.delta' : 'response.output_audio.delta', delta: Buffer.alloc(n, 3).toString('base64') });
  wss.on('connection', (ws) => {
    m.ws = ws;
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d));
      m.recibido.push(msg);
      if (live && msg.type === 'session.start') ws.send(JSON.stringify({ type: 'session.started' }));
      /* Si contesta, cada pedido de hablar devuelve un poco de audio. */
      if (m.contesta && (msg.type === 'response.create' || msg.type === 'session.commentary.append')) ws.send(JSON.stringify(audio(1200)));
    });
  });
  m.contesta = contesta;
  m.url = 'ws://127.0.0.1:' + wss.address().port;
  m.mandar = (o) => m.ws && m.ws.send(JSON.stringify(o));
  m.audio = (n) => m.mandar(audio(n));
  m.tipos = () => m.recibido.map((x) => x.type);
  m.cerrar = () => new Promise((ok) => { for (const c of wss.clients) c.terminate(); wss.close(ok); });
  return m;
}

/* ── El backend del asistente: el canal de control y el relay de cada llamada ── */
async function backendFalso() {
  const b = { relays: [], modo: 'confirmar' };
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, sock, head) => {
    wss.handleUpgrade(req, sock, head, (ws) => {
      if (req.url === '/api/pbx/canal') return;
      const mm = /^\/api\/pbx\/llamadas\/([^/]+)\/relay$/.exec(req.url);
      if (!mm) return ws.close();
      const relay = { id: mm[1], ws, recibidos: [] };
      b.relays.push(relay);
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d));
        relay.recibidos.push(msg);
        if (msg.type === 'llamada_nueva' && b.modo === 'confirmar') ws.send(JSON.stringify({ type: 'enganche_confirmado' }));
      });
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  b.url = 'http://127.0.0.1:' + srv.address().port;
  b.ordenar = (relay, orden) => relay.ws.send(JSON.stringify(Object.assign({ pbxCallId: relay.id }, orden)));
  b.cerrar = () => new Promise((ok) => { for (const c of wss.clients) c.terminate(); srv.closeAllConnections?.(); srv.close(ok); });
  return b;
}

let pipe, modelo, backend;
test.before(async () => {
  process.env.AUDIOSOCKET_PORT = String(await puertoLibre());
  process.env.AI_MUDO_MS = '10000';
  pipe = require('../ai-pipeline');
  modelo = await modeloFalso();
  backend = await backendFalso();
  ajustes.set('realtime_url', modelo.url);
});
test.after(async () => {
  try { await pipe.close(); } catch (_) {}
  await modelo.cerrar(); await backend.cerrar();
  globalThis.fetch = fetchReal;
});

const AGENTE = { id: 5, name: 'Portería', provider: 'openai-realtime', greeting_text: 'Hola', herramientas: {} };
/* Desde dónde mirar lo que recibió el modelo: los call_id se repiten entre pruebas. */
let marca = 0;
async function llamar(agente, ch = canal()) {
  marca = modelo.recibido.length;
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  const antes = modelo.recibido.length;
  await pipe.startAiSession(ch, Object.assign({}, AGENTE, agente));
  const m = ari.medios.at(-1);
  assert.ok(await hasta(() => modelo.recibido.slice(antes).some((x) => x.type === 'session.update')), 'la sesión del modelo no se configuró');
  hablar(m, 5, 0);
  return { ari, ch, m };
}
const pedir = (id, nombre, args) => modelo.mandar({ type: 'response.function_call_arguments.done', call_id: id, name: nombre, arguments: args === undefined ? undefined : JSON.stringify(args) });
const respuesta = (id) => hasta(() => {
  const r = modelo.recibido.slice(marca).find((x) => x.type === 'conversation.item.create' && x.item.call_id === id);
  return r ? JSON.parse(r.item.output) : null;
});

test('realtime: lo que conteste el CRM se normaliza; sin identificar al portero no se verifica a nadie; sin URL no se abre', async () => {
  require('../herramientas')._resetTopes();
  const herr = {
    consultar_datos: { on: true }, verificar_unidad: { on: true }, verificar_autorizado: { on: true }, tomar_mensaje: { on: true },
    abrir_porton: { on: true, modo: 'webhook', url: '', exigir_verificacion: false, ventana: '00:00-23:59' },
    delegacion: { model: 'gpt-5-nano' },
  };
  afuera.crm = [
    new Response('no', { status: 502 }),
    new Response('esto no es json'),
    Response.json({ result: 'saldo al día' }),
    Response.json({ ok: false, motivo: 'cliente dado de baja' }),
    Response.json({ encontrado: false }),
    Response.json({ datos: { deuda: 0 } }),
    Response.json({}),
    () => { throw new Error('ECONNREFUSED'); },
    Response.json({ detalle: 'unidad 4C' }),
  ];
  const { ch } = await llamar({ crm_webhook: 'http://crm.test/q', herramientas: herr });
  const esperado = [
    { ok: false, motivo: 'HTTP 502' },
    { ok: false, motivo: 'respuesta ilegible' },
    { ok: true, respuesta: 'saldo al día' },
    { ok: false, motivo: 'cliente dado de baja' },
    { ok: false, motivo: 'sin datos' },
    { ok: true, respuesta: '' },
    { ok: false, motivo: 'sin datos' },
    { ok: false, motivo: 'ECONNREFUSED' },
  ];
  for (let i = 0; i < esperado.length; i++) {
    pedir('c' + i, 'consultar_datos', { consulta: 'saldo' });
    assert.deepEqual(await respuesta('c' + i), esperado[i], 'respuesta ' + i + ' del CRM');
  }
  pedir('u1', 'verificar_unidad', { unidad: '4C' });
  assert.equal((await respuesta('u1')).detalle, 'unidad 4C', 'el CRM también puede contestar con `detalle`');
  pedir('p1', 'verificar_autorizado', { nombre: 'Juan' });
  const p1 = await respuesta('p1');
  assert.equal(p1.autorizado, false);
  assert.match(p1.motivo, /no reconozco esta dirección/, 'sin portero identificado no hay contra qué verificar');
  pedir('a1', 'abrir_porton', { motivo: 'x' });
  assert.equal((await respuesta('a1')).ok, false);
  assert.ok(acciones.some((a) => a[3] === 'abrir_porton' && /sin URL de apertura configurada/.test(a[5])), 'la apertura sin URL queda auditada con el motivo');
  /* Un pedido sin argumentos se trata como argumentos vacíos. */
  pedir('m0', 'tomar_mensaje');
  assert.equal((await respuesta('m0')).ok, false);
  pedir('m1', 'tomar_mensaje', { mensaje: 'dejo un paquete' });
  assert.equal((await respuesta('m1')).ok, true);
  const msj = acciones.find((a) => a[3] === 'tomar_mensaje' && a[4] === 'mensaje guardado');
  assert.equal(msj[6], '', 'un mensaje sin unidad se audita con la unidad vacía');
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
});

test('realtime: la auditoría y el problema del proveedor con la base caída no cortan la conversación', async (t) => {
  require('../herramientas')._resetTopes();
  estado.auditoriaCaida = true; estado.ajustesCaidos = true;
  t.after(() => { estado.auditoriaCaida = false; estado.ajustesCaidos = false; });
  ajustes.delete('ia_ultimo_problema');
  const { ch, ari } = await llamar({ herramientas: { abrir_porton: { on: true, exigir_verificacion: false, ventana: '00:00-23:59' } } });
  pedir('a1', 'abrir_porton', { motivo: 'autorizado' });
  assert.equal((await respuesta('a1')).ok, true, 'sin `modo` ni `dtmf`, abre por DTMF con #');
  assert.equal(ari.dtmf.at(-1).dtmf, '#');
  modelo.mandar({ type: 'error', error: { message: 'insufficient_quota' } });
  modelo.mandar({ type: 'error', error: { message: 'algo que no es del proveedor' } });
  await dormir(100);
  assert.equal(ajustes.has('ia_ultimo_problema'), false);
  assert.equal(ch.colgado, false);
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
});

test('realtime: el DTMF de apertura que el canal no acepta se informa como no abierto', async () => {
  require('../herramientas')._resetTopes();
  const { ch, ari } = await llamar({ herramientas: { abrir_porton: { on: true, dtmf: '*1', exigir_verificacion: false, ventana: '00:00-23:59' } } });
  ari.channels.sendDTMF = async () => { throw new Error('canal sin DTMF'); };
  pedir('a1', 'abrir_porton', {});
  assert.equal((await respuesta('a1')).ok, false);
  assert.ok(acciones.some((a) => a[3] === 'abrir_porton' && /canal sin DTMF/.test(a[5])));
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
});

test('realtime: la caja del backoffice suma sus herramientas en caliente, y lo que contesta queda auditado', async () => {
  afuera.catalogo = () => Response.json({ herramientas: [{ nombre: 'saldo', descripcion: 'Consulta el saldo de la unidad' }] });
  afuera.ejecutar = [() => Response.json({ ok: true, texto: 'saldo 0' }), () => Response.json({ ok: false, motivo: 'unidad inexistente' })];
  const antes = modelo.recibido.length;
  const { ch } = await llamar({ voice: '', herramientas: { remoto: { on: true, url: 'http://bo.test', token: 's' } } });
  const reconf = await hasta(() => modelo.recibido.slice(antes).filter((x) => x.type === 'session.update').find((x) => (x.session.tools || []).some((h) => h.name === 'bo_saldo')));
  assert.ok(reconf, 'las herramientas del backoffice no se sumaron a la sesión');
  assert.equal(reconf.session.audio.output.voice, 'alloy', 'sin voz elegida se usa alloy');
  pedir('b1', 'bo_saldo', { unidad: '4C' });
  assert.equal((await respuesta('b1')).respuesta, 'saldo 0');
  pedir('b2', 'bo_saldo', { unidad: '9Z' });
  assert.equal((await respuesta('b2')).ok, false);
  assert.equal(afuera.bo[0].contexto.llamante, '099123456');
  assert.ok(acciones.some((a) => a[3] === 'bo_saldo' && a[4] === 'consulta al backoffice'));
  assert.ok(acciones.some((a) => a[3] === 'bo_saldo' && a[4] === 'backoffice sin respuesta' && a[5] === 'unidad inexistente'));
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
});

test('realtime: un backoffice que no publica nada no reconfigura la sesión', async () => {
  afuera.catalogo = () => Response.json({ herramientas: [] });
  const antes = modelo.recibido.length;
  const { ch } = await llamar({ herramientas: { remoto: { on: true, url: 'http://bo.test', token: 's' } } });
  await dormir(200);
  assert.equal(modelo.recibido.slice(antes).filter((x) => x.type === 'session.update').length, 1);
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
});

test('realtime: pedir cortar despide una sola vez, espera que termine de hablar y corta', async () => {
  require('../herramientas')._resetTopes();
  const antes = modelo.recibido.length;
  const { ch } = await llamar({ herramientas: { terminar_llamada: { on: true } } });
  pedir('t1', 'terminar_llamada', { motivo: 'listo' });
  assert.equal((await respuesta('t1')).ok, true);
  pedir('t2', 'terminar_llamada', { motivo: 'otra vez' });
  await respuesta('t2');
  const despedidas = () => modelo.recibido.slice(antes).filter((x) => x.type === 'response.create' && /Gracias por comunicarse/.test(JSON.stringify(x)));
  assert.equal(despedidas().length, 1, 'la despedida por defecto se dice una sola vez');
  /* Mientras habla no se corta. */
  modelo.audio(16000);
  await dormir(500);
  assert.equal(ch.colgado, false, 'cortó en medio de la despedida');
  assert.ok(await hasta(() => ch.colgado, 6000), 'después de despedirse no cortó');
});

test('realtime: la escalera de inactividad pregunta dos veces, se despide y corta', async () => {
  modelo.contesta = true;
  try {
    const antes = modelo.recibido.length;
    const { ch } = await llamar({ inact1_s: 1, inact2_s: 1, cierre_s: 1, inact1_text: '¿Sigue ahí?', inact2_text: '¿Me escucha?', despedida_text: 'Hasta luego' });
    assert.ok(await hasta(() => ch.colgado, 12000), 'la escalera no cortó la llamada');
    const dicho = JSON.stringify(modelo.recibido.slice(antes));
    assert.match(dicho, /Sigue ahí/);
    assert.match(dicho, /Me escucha/);
    assert.match(dicho, /Hasta luego/);
  } finally { modelo.contesta = false; }
});

test('realtime: un cierre limpio del proveedor corta sin anotar un problema; uno sin aviso también corta', async () => {
  ajustes.delete('ia_ultimo_problema');
  const a = await llamar({});
  modelo.audio(960);
  await hasta(() => audioDe(a.m) > 0);
  modelo.ws.close(1000, '');
  assert.ok(await hasta(() => a.ch.colgado), 'el cierre limpio igual corta: no hay con quién hablar');
  assert.equal(ajustes.has('ia_ultimo_problema'), false);
  const b = await llamar({});
  modelo.ws.terminate();
  assert.ok(await hasta(() => b.ch.colgado));
});

test('realtime: quien cuelga antes del saludo no deja nada corriendo', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  const ch = canal();
  const antes = modelo.recibido.length;
  await pipe.startAiSession(ch, Object.assign({}, AGENTE));
  await hasta(() => modelo.recibido.slice(antes).some((x) => x.type === 'session.update'));
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
  await dormir(400);
  assert.ok(!modelo.recibido.slice(antes).some((x) => x.type === 'response.create'), 'saludó a una llamada que ya no estaba');
});

test('realtime: si el modelo no abre y el agente no tiene destino, se disculpa y suelta la llamada igual', async () => {
  ajustes.set('realtime_url', 'ws://127.0.0.1:1');
  try {
    const ari = asteriskFalso();
    pipe.init(ari, pool);
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE));
    assert.ok(await hasta(() => ch.derivado, 6000));
    assert.equal(ch.derivado.extension, '');
  } finally { ajustes.set('realtime_url', modelo.url); }
});

/* ── IA externa ─────────────────────────────────────────────────────────────── */
const EXTERNO = { id: 40, name: 'Portería ext', provider: 'ia-externa', enabled: true, default_exten: '2030', herramientas: {} };
/* Cada prueba con su agente: la configuración queda en memoria y la base no la pisa. */
async function preparoExterno(id, config) {
  EXTERNO.id = id; EXTERNO.externo_url = backend.url; EXTERNO.externo_token = 'tok';
  estado.agentes = [EXTERNO];
  estado.configs.set(EXTERNO.id, Object.assign({ version: 'v1', session: {}, attach_timeout_ms: null, resume_window_ms: null }, config));
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  pipe.recargarIaExterna();
  await dormir(150);
  return ari;
}
async function llamadaExterna(ari, ch) {
  const antes = backend.relays.length;
  await pipe.startAiSession(ch, Object.assign({}, EXTERNO));
  const relay = await hasta(() => backend.relays.slice(antes).find((r) => r.recibidos.some((x) => x.type === 'llamada_nueva')), 6000);
  return { relay, m: ari.medios.at(-1) };
}

test('IA externa: con la configuración mínima de la base, portero identificado, DTMF del visitante y órdenes del backend', async () => {
  const live = await modeloFalso({ live: true });
  ajustes.set('realtime_url', live.url);
  estado.clientes = [{ id: 1, name: 'Edificio Sol', doc: '', address: '', notes: '' }];
  try {
    const ari = await preparoExterno(40, {});
    const ch = canal('099777888');
    const { relay, m } = await llamadaExterna(ari, ch);
    assert.ok(relay, 'no se abrió el relay');
    const aviso = relay.recibidos.find((x) => x.type === 'llamada_nueva');
    assert.equal(aviso.origen, 'portero', 'el portero identificado en el CRM se le avisa al backend');
    assert.equal(aviso.to, null);
    assert.equal(aviso.destinoAgentes, '2030', 'sin internos de agentes, el destino es el respaldo');
    assert.equal(live.recibido[0].session.model, undefined, 'la sesión va tal cual la guardó el backend');
    hablar(m, 3);
    ch.emit('ChannelDtmfReceived', { digit: '5' });
    ch.emit('ChannelDtmfReceived', null);
    assert.ok(await hasta(() => relay.recibidos.filter((x) => x.type === 'dtmf').length === 2));
    assert.deepEqual(relay.recibidos.filter((x) => x.type === 'dtmf').map((x) => x.digito), ['5', '']);
    live.mandar({ type: 'error', error: { message: 'rate limit reached' } });
    assert.ok(await hasta(() => /limitando/.test(ajustes.get('ia_ultimo_problema') || '')), 'el error del modelo no quedó a la vista del panel');
    backend.ordenar(relay, { type: 'enviar_dtmf', id: 'd1', digitos: '#9' });
    assert.ok(await hasta(() => relay.recibidos.some((x) => x.type === 'ack' && x.id === 'd1')));
    assert.equal(ari.dtmf.at(-1).dtmf, '#9');
    /* La sesión de voz se despide sola (session.closed del modelo) y el backend cuelga. */
    live.mandar({ type: 'session.closed' });
    live.ws.close(1000);
    await dormir(100);
    assert.ok(!relay.recibidos.some((x) => x.type === 'session.closed' && x.reason === 'cortada_en_la_central'), 'si el modelo ya avisó, la central no inventa otro cierre');
    backend.ordenar(relay, { type: 'colgar', id: 'k1' });
    assert.ok(await hasta(() => ch.colgado, 6000));
  } finally { estado.clientes = []; ajustes.set('realtime_url', modelo.url); await live.cerrar(); }
});

test('IA externa: si el relay se pierde (ventana 0), la llamada va al respaldo', async () => {
  const live = await modeloFalso({ live: true });
  ajustes.set('realtime_url', live.url);
  try {
    const ari = await preparoExterno(41, { session: { model: 'gpt-live-1' }, resume_window_ms: 0, attach_timeout_ms: 3000 });
    const ch = canal();
    const { relay } = await llamadaExterna(ari, ch);
    assert.ok(relay);
    await dormir(100);
    relay.ws.close(1011, 'se cae');
    assert.ok(await hasta(() => ch.derivado, 5000), 'sin relay y sin ventana, respaldo');
    assert.equal(ch.derivado.extension, '2030');
  } finally { ajustes.set('realtime_url', modelo.url); await live.cerrar(); }
});

test('IA externa: si la sesión de voz no abre, la llamada va al respaldo', async () => {
  ajustes.set('realtime_url', 'ws://127.0.0.1:1');
  try {
    await preparoExterno(42, { session: { model: 'gpt-live-1' } });
    const ari = asteriskFalso();
    pipe.init(ari, pool);
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, EXTERNO));
    assert.ok(await hasta(() => ch.derivado, 6000), 'la sesión que no abre tiene que ir al respaldo');
    assert.equal(ch.derivado.extension, '2030');
  } finally {
    ajustes.set('realtime_url', modelo.url);
    estado.agentes = [];
    pipe.recargarIaExterna();
  }
});
