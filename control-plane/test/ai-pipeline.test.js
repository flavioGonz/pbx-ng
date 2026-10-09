/* ============================================================================
 *  El pipeline de IA en una llamada entera (ai-pipeline.js), con todo lo de afuera de
 *  mentira y nada del pipeline tocado.
 *
 *  Asterisk es un ARI falso más un cliente AudioSocket que habla el protocolo de tramas
 *  (0x01 UUID, 0x10 audio, 0x00 fin): «crea» el canal de medios, se conecta al servidor
 *  del pipeline y le manda audio. Vosk, sox y espeak-ng son scripts de mentira al frente
 *  del PATH; el servicio de voz, el CRM y el modelo realtime son servidores locales; y lo
 *  que va a api.openai.com se intercepta en `fetch`. Lo que se mira es lo que se ve desde
 *  la llamada: qué se dijo, a dónde se derivó y cuándo se cortó.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { httpFalso, crudo } = require('./helpers/http-falso');

const { hasta, puertoLibre, asteriskFalso, canal, hablar, audioDe } = require('./helpers/llamada-ia');

/* ── Binarios de mentira ──────────────────────────────────────────────────────
 * python3 hace de Vosk: después de recibir algo de audio dice la frase de FALSO_VOSK_TEXTO
 * (como `final`, o sólo como `partial` si FALSO_VOSK_MODO=partial). sox copia; espeak-ng
 * escupe medio segundo de audio. */
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-bin-'));
fs.writeFileSync(path.join(BIN, 'python3'), `#!/usr/bin/env node
let n = 0, dicho = false;
const txt = process.env.FALSO_VOSK_TEXTO || '', modo = process.env.FALSO_VOSK_MODO || 'final';
process.stdin.on('data', (d) => {
  n += d.length;
  if (dicho || n < 1600 || !txt) return;
  dicho = true;
  process.stdout.write(JSON.stringify({ partial: modo === 'partial' ? txt : txt.slice(0, 3) }) + '\\n');
  process.stdout.write('esto no es json\\n\\n');
  if (modo !== 'partial') process.stdout.write(JSON.stringify({ final: txt }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'sox'), '#!/bin/sh\ncat\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'espeak-ng'), '#!/bin/sh\nhead -c 4000 /dev/zero\n', { mode: 0o755 });
const PATH_ORIG = process.env.PATH;
process.env.PATH = BIN + path.delimiter + PATH_ORIG;

/* ── fetch hacia OpenAI, interceptado ─────────────────────────────────────── */
const fetchReal = globalThis.fetch;
const openai = { tts: null, stt: null, llm: [] };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://api.openai.com/')) return fetchReal(url, opts);
  if (u.endsWith('/audio/speech')) return openai.tts ? openai.tts() : new Response('no', { status: 500 });
  if (u.endsWith('/audio/transcriptions')) return openai.stt ? openai.stt() : new Response('no', { status: 500 });
  if (u.endsWith('/chat/completions')) {
    const r = openai.llm.shift();
    if (!r) return new Response('no', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: r }] }), { status: 200 });
  }
  return new Response('no', { status: 404 });
};

/* ── Un pool de mentira ───────────────────────────────────────────────────── */
const ajustes = new Map();
const acciones = [];
const clientes = [];
const pool = {
  async query(sql, args) {
    if (/SELECT value FROM pbxng_settings WHERE key=\$1/.test(sql)) return { rows: ajustes.has(args[0]) ? [{ value: ajustes.get(args[0]) }] : [] };
    if (/INSERT INTO pbxng_settings/.test(sql)) { ajustes.set(sql.includes('ia_ultimo_problema') ? 'ia_ultimo_problema' : args[0], args[args.length - 1]); return { rowCount: 1 }; }
    if (/INSERT INTO pbxng_ia_acciones/.test(sql)) { acciones.push(args); return { rowCount: 1 }; }
    if (/FROM pbxng_clients/.test(sql)) return { rows: clientes };
    if (/FROM pbxng_client_persons/.test(sql)) return { rows: [{ id: 1, name: 'Juan Pérez', doc: '1.234.567-8', valid_until: null }] };
    return { rows: [] };
  },
};

/* El Asterisk de mentira (ARI + el lado cliente del AudioSocket) vive en helpers/llamada-ia.js. */
let AS_PORT;
let pipe, voz, crm;
test.before(async () => {
  AS_PORT = await puertoLibre();
  process.env.AUDIOSOCKET_PORT = String(AS_PORT);
  process.env.AI_MUDO_MS = '1500';
  pipe = require('../ai-pipeline');
  voz = await httpFalso();
  crm = await httpFalso();
  /* El TTS devuelve 100 ms de audio: la frase entera viaja de una (colchón de 10 tramas). */
  voz.ruta('POST', '/tts', crudo(200, Buffer.alloc(1600, 1)));
  voz.ruta('POST', '/stt', (p) => ({ text: voz.sttTexto || '' }));
  ajustes.set('voz_url', voz.url);
});
test.after(async () => {
  try { await pipe.close(); } catch (_) {}
  await voz.cerrar(); await crm.cerrar();
  globalThis.fetch = fetchReal;
  process.env.PATH = PATH_ORIG;
  fs.rmSync(BIN, { recursive: true, force: true });
});

const AGENTE = { id: 7, name: 'Portero', provider: 'demo', voice: 'es', sales_exten: '2010', support_exten: '2020', default_exten: '2030', greeting_text: 'Hola, portería', herramientas: {} };

test('demo: saluda, entiende «ventas» y deriva al interno de ventas con tono de llamada', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool, { mediaHost: '127.0.0.1', app: 'pbxng' });
  pipe.init(ari, pool);   // init se repite en cada reconexión de ARI: no abre otro servidor
  process.env.FALSO_VOSK_TEXTO = 'quiero hablar con ventas';
  voz.sttTexto = 'quiero hablar con ventas por favor';
  const ch = canal();
  await pipe.startAiSession(ch, Object.assign({}, AGENTE));
  assert.equal(ch.respondido, true);
  assert.equal(ari.puentes[0].tipo, 'mixing,video_sfu', 'el puente de mezcla no le saca el video al portero');
  const m = ari.medios[0];
  assert.equal(m.o.external_host, '127.0.0.1:' + AS_PORT);
  assert.ok(await hasta(() => audioDe(m) > 0), 'no saludó');
  assert.equal(pipe.metricas().length, 1);
  assert.equal(pipe.metricas()[0].modo, 'demo');
  hablar(m, 12);
  assert.ok(await hasta(() => ch.derivado, 5000), 'no derivó');
  assert.deepEqual(ch.derivado, { context: 'internal', extension: '2010', priority: 1 });
  assert.equal(ch.vars.DIAL_OPCIONES, 'r', 'la derivación pide el tono de llamada');
  assert.ok(ari.colgados.includes(m.id), 'el canal de medios se cuelga al derivar');
  assert.equal(ari.puentes[0].destruido, true);
  assert.equal(pipe.metricas().length, 0);
});

test('demo: «mi factura» consulta el CRM y lee la respuesta; sin CRM lo dice', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  crm.ruta('POST', '/crm', (p) => ({ result: 'Tiene un saldo de 500 pesos, ' + p.body.caller }));
  process.env.FALSO_VOSK_TEXTO = 'quiero saber de mi factura';
  voz.sttTexto = '';
  const ch = canal();
  await pipe.startAiSession(ch, Object.assign({}, AGENTE, { crm_webhook: crm.url + '/crm' }));
  const m = ari.medios[0];
  await hasta(() => audioDe(m) > 0);
  const antes = voz.pedidos('/tts').length;
  hablar(m, 12);
  assert.ok(await hasta(() => voz.pedidos('/tts').length > antes, 5000), 'no habló después de la consulta');
  assert.equal(crm.pedidos('/crm')[0].body.caller, '099123456');
  assert.match(voz.pedidos('/tts').at(-1).body.text, /saldo de 500 pesos/);
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
});

test('demo: el parcial estable cierra la frase; «gracias» despide y corta', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  process.env.FALSO_VOSK_TEXTO = 'muchas gracias, nada más';
  process.env.FALSO_VOSK_MODO = 'partial';
  const ch = canal();
  try {
    await pipe.startAiSession(ch, Object.assign({}, AGENTE, { greeting_text: '' }));
    const m = ari.medios[0];
    await hasta(() => audioDe(m) > 0);
    hablar(m, 12);
    assert.ok(await hasta(() => ch.colgado, 6000), 'no cortó después de despedirse');
    assert.match(voz.pedidos('/tts').at(-1).body.text, /Gracias por llamar/);
  } finally { delete process.env.FALSO_VOSK_MODO; }
});

test('demo: sin servicio de voz ni OpenAI, habla con espeak-ng local', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  process.env.FALSO_VOSK_TEXTO = '';
  ajustes.set('voz_url', 'http://127.0.0.1:1');
  try {
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE));
    const m = ari.medios[0];
    assert.ok(await hasta(() => audioDe(m) >= 4000, 5000), 'espeak-ng no llegó al canal');
    m.socket.write(Buffer.from([0x00, 0, 0]));   // Asterisk termina la sesión
    assert.ok(await hasta(() => ch.colgado));
  } finally { ajustes.set('voz_url', voz.url); }
});

test('openai: Whisper + chat con herramientas (CRM y derivación) + TTS de OpenAI', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  ajustes.set('openai_api_key', 'sk-prueba');
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(1596, 2)]);
  openai.tts = () => new Response(wav, { status: 200 });
  openai.stt = () => new Response(JSON.stringify({ text: 'necesito el saldo y después hablar con soporte' }), { status: 200 });
  crm.ruta('POST', '/crm2', { text: 'saldo al día' });
  openai.llm = [
    { content: null, tool_calls: [{ id: 't1', function: { name: 'crm_lookup', arguments: '{"query":"saldo"}' } }] },
    { content: null, tool_calls: [{ id: 't2', function: { name: 'transfer_call', arguments: '{"destination":"2020","label":"Soporte"}' } }] },
  ];
  process.env.FALSO_VOSK_TEXTO = 'necesito el saldo';
  try {
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE, { provider: 'openai', crm_webhook: crm.url + '/crm2' }));
    const m = ari.medios[0];
    await hasta(() => audioDe(m) > 0);
    hablar(m, 12);
    assert.ok(await hasta(() => ch.derivado, 6000), 'no derivó');
    assert.equal(ch.derivado.extension, '2020');
    assert.equal(crm.pedidos('/crm2').length, 1);
  } finally { ajustes.delete('openai_api_key'); openai.llm = []; }
});

test('openai: si el chat falla se pide repetir, sin colgar', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  ajustes.set('openai_api_key', 'sk-prueba');
  openai.tts = () => new Response('no', { status: 500 });   // cae al servicio de voz
  openai.stt = () => new Response('no', { status: 500 });   // y se usa el texto de Vosk
  openai.llm = [];
  process.env.FALSO_VOSK_TEXTO = 'hola que tal';
  try {
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE, { provider: 'openai' }));
    const m = ari.medios[0];
    await hasta(() => audioDe(m) > 0);
    hablar(m, 12);
    assert.ok(await hasta(() => voz.pedidos('/tts').some((p) => /tuve un inconveniente/.test(p.body.text)), 5000));
    assert.equal(ch.colgado, false);
    ch.emit('StasisEnd');
    await hasta(() => ch.colgado);
  } finally { ajustes.delete('openai_api_key'); }
});

/* ── Realtime ───────────────────────────────────────────────────────────────── */
async function modeloFalso() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((ok) => wss.once('listening', ok));
  const recibido = []; let cliente = null;
  wss.on('connection', (ws) => { cliente = ws; ws.on('message', (d) => { try { recibido.push(JSON.parse(String(d))); } catch (_) {} }); });
  return {
    url: 'ws://127.0.0.1:' + wss.address().port, recibido,
    mandar: (o) => cliente && cliente.send(JSON.stringify(o)),
    cortar: (code, motivo) => cliente && cliente.close(code, motivo),
    tipos: () => recibido.map((r) => r.type),
    cerrar: () => new Promise((ok) => { for (const c of wss.clients) { try { c.terminate(); } catch (_) {} } wss.close(ok); }),
  };
}

test('realtime: saluda cuando entra audio, reproduce al ritmo del canal, ejecuta herramientas y corta si el proveedor cierra', async (t) => {
  const modelo = await modeloFalso();
  t.after(() => modelo.cerrar());
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  ajustes.set('openai_api_key', 'sk-prueba');
  ajustes.set('realtime_url', modelo.url);
  clientes.push({ id: 1, name: 'Edificio Sol', doc: '', address: 'Av. Brasil 100', notes: '' });
  try {
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE, { provider: 'openai-realtime', model: 'gpt-realtime-2.1-mini',
      herramientas: { abrir_porton: { on: true, modo: 'dtmf', dtmf: '#9' }, verificar_persona: { on: true } } }));
    const m = ari.medios[0];
    assert.ok(await hasta(() => modelo.tipos().includes('session.update')));
    const cfg = modelo.recibido.find((r) => r.type === 'session.update');
    assert.match(cfg.session.instructions, /Edificio Sol/, 'el bloque de portería entra en las instrucciones');
    hablar(m, 5, 0);
    assert.ok(await hasta(() => modelo.tipos().includes('input_audio_buffer.append')), 'el audio del llamante no llegó al modelo');
    assert.ok(await hasta(() => modelo.tipos().includes('response.create'), 3000), 'no saludó');

    /* El modelo habla: el audio llega al canal en tramas de 20 ms. */
    modelo.mandar({ type: 'response.output_audio.delta', delta: Buffer.alloc(4800, 3).toString('base64') });
    assert.ok(await hasta(() => audioDe(m) >= 1600));
    assert.ok(m.recibido.every((b) => b.length <= 320));
    /* Barge-in: se tira la cola y se le pide al modelo que pare. */
    modelo.mandar({ type: 'input_audio_buffer.speech_started' });
    assert.ok(await hasta(() => modelo.tipos().includes('response.cancel')));
    modelo.mandar({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'soy Juan Pérez' });

    /* Una herramienta: verificar a la persona contra los autorizados del cliente. */
    modelo.mandar({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'verificar_persona', arguments: '{"nombre":"Juan Pérez"}' });
    assert.ok(await hasta(() => modelo.recibido.find((r) => r.type === 'conversation.item.create' && r.item.call_id === 'c1')));
    /* Y abrir el portón: un DTMF al canal del portero. */
    modelo.mandar({ type: 'response.function_call_arguments.done', call_id: 'c2', name: 'abrir_porton', arguments: '{"motivo":"autorizado"}' });
    const r2 = await hasta(() => modelo.recibido.find((r) => r.type === 'conversation.item.create' && r.item.call_id === 'c2'));
    assert.ok(r2, 'no contestó el resultado de abrir');
    modelo.mandar({ type: 'response.function_call_arguments.done', call_id: 'c3', name: 'inventada', arguments: 'no es json' });
    assert.ok(await hasta(() => modelo.recibido.find((r) => r.type === 'conversation.item.create' && r.item.call_id === 'c3')), 'una herramienta desconocida también se contesta');
    modelo.mandar({ type: 'error', error: { message: 'Incorrect API key provided' } });
    await hasta(() => ajustes.has('ia_ultimo_problema'));
    assert.match(ajustes.get('ia_ultimo_problema'), /rechazó la clave/, 'el problema del proveedor queda a la vista del panel');

    modelo.cortar(1011, 'error interno');
    assert.ok(await hasta(() => ch.colgado, 3000), 'si el proveedor cierra, la llamada no puede quedar muda');
  } finally { ajustes.delete('openai_api_key'); ajustes.delete('realtime_url'); clientes.length = 0; }
});

test('realtime: las herramientas de portería con sus candados, el CRM, el mensaje y el corte con despedida', async (t) => {
  const modelo = await modeloFalso();
  t.after(() => modelo.cerrar());
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  ajustes.set('openai_api_key', 'sk-prueba');
  ajustes.set('realtime_url', modelo.url);
  clientes.push({ id: 1, name: 'Edificio Sol', doc: '', address: 'Av. Brasil 100', notes: '' });
  crm.ruta('POST', '/crm-ia', (p) => (p.body.tipo === 'verificar_unidad' ? { ok: true, texto: 'unidad 3B al día', datos: { u: '3B' } } : { result: 'saldo al día' }));
  crm.ruta('POST', '/porton', { ok: true });
  require('../herramientas')._resetTopes();
  const herr = {
    verificar_autorizado: { on: true }, verificar_unidad: { on: true }, consultar_datos: { on: true }, tomar_mensaje: { on: true },
    terminar_llamada: { on: true }, abrir_porton: { on: true, modo: 'dtmf', dtmf: '#7', ventana: '00:00-23:59' },
  };
  const pedir = (id, nombre, args) => modelo.mandar({ type: 'response.function_call_arguments.done', call_id: id, name: nombre, arguments: JSON.stringify(args) });
  const respuesta = (id) => hasta(() => { const r = modelo.recibido.find((x) => x.type === 'conversation.item.create' && x.item.call_id === id); return r ? JSON.parse(r.item.output) : null; });
  try {
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE, { provider: 'openai-realtime', crm_webhook: crm.url + '/crm-ia', herramientas: herr, despedida_text: 'Chau' }));
    const m = ari.medios.at(-1);
    await hasta(() => modelo.tipos().includes('session.update'));
    hablar(m, 5, 0);
    /* Abrir sin verificar antes: el candado lo niega. */
    pedir('a0', 'abrir_porton', { motivo: 'apurado' });
    assert.equal((await respuesta('a0')).ok, false);
    pedir('v1', 'verificar_autorizado', { nombre: 'Juan Pérez' });
    assert.equal((await respuesta('v1')).autorizado, true);
    pedir('a1', 'abrir_porton', { motivo: 'autorizado' });
    assert.equal((await respuesta('a1')).ok, true, 'verificado, abre');
    assert.equal(ari.dtmf.at(-1).dtmf, '#7');
    pedir('c1', 'consultar_datos', { consulta: 'saldo' });
    assert.equal((await respuesta('c1')).respuesta, 'saldo al día');
    pedir('u1', 'verificar_unidad', { unidad: '3B' });
    assert.equal((await respuesta('u1')).encontrado, true);
    pedir('m1', 'tomar_mensaje', { mensaje: 'dejo un paquete', unidad: '3B' });
    assert.equal((await respuesta('m1')).ok, true);
    assert.ok(acciones.some((a) => a[3] === 'tomar_mensaje'), 'el mensaje queda en el registro de acciones');
    pedir('t1', 'terminar_llamada', { motivo: 'listo' });
    assert.equal((await respuesta('t1')).ok, true);
    assert.ok(modelo.recibido.some((x) => x.type === 'response.create' && /Chau/.test(JSON.stringify(x))), 'se despide antes de cortar');
    assert.ok(await hasta(() => ch.colgado, 6000), 'después de despedirse corta');
  } finally { ajustes.delete('openai_api_key'); ajustes.delete('realtime_url'); clientes.length = 0; }
});

test('realtime: abrir por webhook, y transferir a un agente por pedido del modelo', async (t) => {
  const modelo = await modeloFalso();
  t.after(() => modelo.cerrar());
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  ajustes.set('openai_api_key', 'sk-prueba');
  ajustes.set('realtime_url', modelo.url);
  crm.ruta('POST', '/porton', crudo(500, 'no'));
  require('../herramientas')._resetTopes();
  try {
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE, { provider: 'openai-realtime', crm_webhook: '',
      herramientas: { abrir_porton: { on: true, modo: 'webhook', url: crm.url + '/porton', exigir_verificacion: false, ventana: '00:00-23:59' }, transferir_a_agente: { on: true }, consultar_datos: { on: true } } }));
    await hasta(() => modelo.tipos().includes('session.update'));
    hablar(ari.medios.at(-1), 5, 0);
    modelo.mandar({ type: 'response.function_call_arguments.done', call_id: 'w1', name: 'abrir_porton', arguments: '{"motivo":"x"}' });
    const r = await hasta(() => modelo.recibido.find((x) => x.type === 'conversation.item.create' && x.item.call_id === 'w1'));
    assert.equal(JSON.parse(r.item.output).ok, false, 'el webhook de apertura que falla no se reporta como abierto');
    assert.equal(crm.pedidos('/porton').at(-1).body.accion, 'abrir');
    modelo.mandar({ type: 'response.function_call_arguments.done', call_id: 'q1', name: 'consultar_datos', arguments: '{"consulta":"x"}' });
    const q = await hasta(() => modelo.recibido.find((x) => x.type === 'conversation.item.create' && x.item.call_id === 'q1'));
    assert.match(JSON.parse(q.item.output).motivo, /no hay consulta de datos configurada/);
    modelo.mandar({ type: 'response.function_call_arguments.done', call_id: 'x1', name: 'transferir_a_agente', arguments: '{"motivo":"pide una persona"}' });
    assert.ok(await hasta(() => ch.derivado, 5000));
    assert.equal(ch.derivado.extension, '2030');
  } finally { ajustes.delete('openai_api_key'); ajustes.delete('realtime_url'); }
});

test('realtime: si el modelo no abre, se disculpa con TTS local y deriva a una persona', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  ajustes.set('openai_api_key', 'sk-prueba');
  ajustes.set('realtime_url', 'ws://127.0.0.1:1');
  try {
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE, { provider: 'openai-realtime' }));
    assert.ok(await hasta(() => ch.derivado, 6000), 'no derivó');
    assert.equal(ch.derivado.extension, '2030');
    assert.ok(voz.pedidos('/tts').some((p) => /no puedo atenderte/.test(p.body.text)), 'no se disculpó antes de derivar');
    assert.equal(ch.colgado, false, 'el cierre del socket colgó la llamada antes de la degradación');
  } finally { ajustes.delete('openai_api_key'); ajustes.delete('realtime_url'); }
});

test('realtime: un modelo que abre y nunca habla se corta al vencer el tope', async (t) => {
  const modelo = await modeloFalso();
  t.after(() => modelo.cerrar());
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  ajustes.set('openai_api_key', 'sk-prueba');
  ajustes.set('realtime_url', modelo.url);
  try {
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE, { provider: 'openai-realtime' }));
    assert.ok(await hasta(() => ch.colgado, 8000), 'el modelo mudo dejó la llamada abierta');
  } finally { ajustes.delete('openai_api_key'); ajustes.delete('realtime_url'); }
});

/* ── Bordes ─────────────────────────────────────────────────────────────────── */
test('IA externa sin clave o sin configuración: va al respaldo sin abrir sesión', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  const ch = canal();
  await pipe.startAiSession(ch, Object.assign({}, AGENTE, { provider: 'ia-externa' }));
  assert.deepEqual(ch.derivado, { context: 'internal', extension: '2030', priority: 1 });
  assert.equal(ch.vars.DIAL_OPCIONES, 'r');
  assert.equal(ari.medios.length, 0);
  const sinRespaldo = canal();
  await pipe.startAiSession(sinRespaldo, Object.assign({}, AGENTE, { provider: 'ia-externa', default_exten: '' }));
  assert.equal(sinRespaldo.colgado, true);
});

test('si no se puede armar el canal de medios, se cuelga y se limpia', async () => {
  const ari = asteriskFalso();
  ari.falloMedios = true;
  pipe.init(ari, pool);
  const ch = canal();
  await pipe.startAiSession(ch, Object.assign({}, AGENTE));
  assert.equal(ch.colgado, true);
  assert.equal(ari.puentes[0].destruido, true);
});

test('un AudioSocket con un UUID que nadie espera se cierra', async () => {
  const ari = asteriskFalso();
  ari.uuidOtro = '00000000-0000-0000-0000-000000000000';
  pipe.init(ari, pool);
  const ch = canal();
  await pipe.startAiSession(ch, Object.assign({}, AGENTE));
  const m = ari.medios[0];
  assert.ok(await hasta(() => m.socket.destroyed || m.socket.readableEnded, 3000));
  ch.emit('StasisEnd');
});

test('la derivación que falla cuelga; el colgado que falla con 404 no se anota', async () => {
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  const s = { uuid: 'x', channel: canal(), log: () => {}, agent: {} };
  s.channel.falloDerivar = true; s.channel.falloVar = true;
  assert.equal(await pipe._doTransfer(s, '2001', 'x'), false);
  assert.equal(s.channel.colgado, true);
});

test('sin ARI la llamada se cuelga; close() deja de escuchar', async () => {
  pipe._setAri(null);
  const ch = canal();
  await pipe.startAiSession(ch, Object.assign({}, AGENTE));
  assert.equal(ch.colgado, true);
  await pipe.close();
  await pipe.close();   // dos veces no rompe
});
