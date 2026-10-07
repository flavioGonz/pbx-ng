/* ============================================================================
 *  Puente al modelo de voz (realtime.js): los caminos que una llamada normal no recorre.
 *
 *  realtime.test.js prueba el puente contra un servidor WebSocket de verdad. Acá el socket
 *  es de mentira y lo maneja la prueba a mano, porque lo que interesa es justamente lo que
 *  un servidor sano no hace: mandar basura o un mensaje sin tipo, cerrar con un motivo
 *  binario o sin código, dejar la respuesta del handshake abierta, aceptar la sesión y
 *  cerrar el socket antes de que salgan los mensajes guardados, o tirar al mandar.
 *
 *  Por qué importa: cada uno de esos caminos termina, en una llamada, en «el agente
 *  atendió y no dijo nada» sin un error a la vista. Lo que se fija es que el puente lo
 *  AVISE (evento `error`, `cerrado` con código y motivo) en vez de tragárselo, y que las
 *  dos API (Realtime y GPT-Live) traduzcan sus eventos a las mismas clases.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const rt = require('../realtime');

/* Un WebSocket que la prueba abre, cierra y hace fallar a mano. */
function wsFalso({ tiraAlMandar = false, tiraAlCerrar = false, tiraAlCrear = false } = {}) {
  const creados = [];
  class WS extends EventEmitter {
    constructor(url, sub, opts) {
      super();
      if (tiraAlCrear) throw new Error('no se pudo crear el socket');
      this.url = url; this.opts = opts; this.readyState = 0; this.enviados = [];
      creados.push(this);
    }
    send(t) { if (tiraAlMandar) throw new Error('socket roto'); this.enviados.push(JSON.parse(t)); }
    close() { if (tiraAlCerrar) throw new Error('ya cerrado'); this.readyState = 3; }
    abrir() { this.readyState = 1; this.emit('open'); }
    llega(o) { this.emit('message', Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))); }
    tipos() { return this.enviados.map((m) => m.type); }
  }
  return { WS, creados };
}

test('subir(): un frame vacío devuelve vacío, sin leer fuera del buffer', () => {
  assert.equal(rt.subir(Buffer.alloc(0)).length, 0);
});

test('Realtime: la URL respeta una base con query propia (Azure) y la cabecera de Azure es api-key', () => {
  assert.equal(rt.REALTIME.url('m 1', 'https://x.azure.com/rt?api-version=1'),
    'https://x.azure.com/rt?api-version=1&model=m%201');
  assert.equal(rt.REALTIME.url('m', 'wss://proxy/rt/'), 'wss://proxy/rt?model=m');
  assert.deepEqual(rt.REALTIME.cabeceras('k', 'https://x.openai.azure.com'), { 'api-key': 'k' });
  assert.deepEqual(rt.REALTIME.cabeceras('k', ''), { Authorization: 'Bearer k' });
  /* La configuración sin voz ni instrucciones no manda `undefined`: el proveedor lo
   * rechazaría o lo ignoraría en silencio. */
  const cfg = rt.REALTIME.configurar({});
  assert.equal(cfg.session.instructions, '');
  assert.equal(cfg.session.audio.output.voice, 'alloy');
  assert.deepEqual(cfg.session.tools, []);
});

test('Realtime: cada evento se traduce a su clase, y lo desconocido no se pierde como error', () => {
  const R = rt.REALTIME;
  assert.deepEqual(R.leer({}), { clase: 'otro', tipo: '' });
  assert.equal(R.leer({ type: 'response.done' }).clase, 'fin_respuesta');
  assert.equal(R.leer({ type: 'response.output_audio.done' }).clase, 'fin_respuesta');
  assert.equal(R.leer({ type: 'response.output_audio_transcript.delta', delta: 'h' }).texto, 'h');
  assert.deepEqual(R.leer({ type: 'error' }), { clase: 'error', detalle: 'error del proveedor' });
  assert.deepEqual(R.leer({ type: 'error', error: { message: 'cuota' } }), { clase: 'error', detalle: 'cuota' });
});

test('Live: URL fija o la base, cabeceras por proveedor, y la sesión con sus defaults', () => {
  const L = rt.LIVE;
  assert.equal(L.url('gpt-live-1', ''), 'wss://api.openai.com/v1/live/sessions');
  assert.equal(L.url('gpt-live-1', 'wss://proxy/live///'), 'wss://proxy/live');
  assert.deepEqual(L.cabeceras('k', 'https://foo.azure.com'), { 'api-key': 'k' });
  assert.deepEqual(L.cabeceras('k'), { Authorization: 'Bearer k' });
  const s = L.configurar({}).session;
  assert.equal(s.model, 'gpt-live-1');
  assert.equal(s.instructions, '');
  assert.equal(s.audio.output.voice, 'marin');
  assert.equal(s.delegation, undefined, 'sin herramientas no se delega: modo cliente');
  /* Con herramientas y otro modelo de razonamiento: las instrucciones van también a la
   * delegación, y el `effort: none` NO se le pone (otros modelos no lo aceptan). */
  const d = L.configurar({ instrucciones: 'sos el portero', herramientas: [{ name: 'x' }], delegacionModel: 'gpt-5-nano' }).session.delegation;
  assert.equal(d.responses.model, 'gpt-5-nano');
  assert.equal(d.responses.instructions, 'sos el portero');
  assert.equal(d.responses.reasoning, undefined);
  /* Live no tiene `response.cancel`: el corte lo hace él solo cuando el visitante habla. */
  assert.equal(L.cancelar(), null);
});

test('Live: cada evento se traduce, incluso envuelto en response.event', () => {
  const L = rt.LIVE;
  assert.deepEqual(L.leer({}), { clase: 'otro', tipo: '' });
  assert.deepEqual(L.leer({ type: 'session.started' }), { clase: 'arranco', tipo: 'session.started' });
  assert.equal(L.leer({ type: 'session.closed' }).clase, 'fin_respuesta');
  assert.equal(L.leer({ type: 'response.event', event: { type: 'session.output_transcript.delta', delta: 'hola' } }).texto, 'hola');
  /* Un response.event sin evento adentro no es nada que haya que interpretar. */
  assert.equal(L.leer({ type: 'response.event' }).clase, 'otro');
  /* Sólo un item de tipo función es una herramienta; un mensaje terminado no. */
  assert.equal(L.leer({ type: 'response.output_item.done', item: { type: 'message' } }).clase, 'otro');
  assert.equal(L.leer({ type: 'response.output_item.done' }).clase, 'otro');
  assert.deepEqual(L.leer({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c', name: 'n', arguments: '{}' } }),
    { clase: 'herramienta', call_id: 'c', nombre: 'n', args: '{}' });
  assert.deepEqual(L.leer({ type: 'error' }), { clase: 'error', detalle: 'error del proveedor' });
  assert.equal(L.leer({ type: 'error', error: { message: 'x' } }).detalle, 'x');
});

test('explicar(): cada status dice qué hacer, con y sin cuerpo', () => {
  assert.match(rt.explicar(403, '  mala   clave '), /rechazó la clave.* — mala clave$/);
  assert.doesNotMatch(rt.explicar(401, ''), / — /);
  assert.match(rt.explicar(400, ''), /el modelo no existe/, 'sin nombre de modelo no queda «el modelo «»»');
  assert.match(rt.explicar(404, 'x', 'gpt-x'), /«gpt-x».* — x$/);
  assert.equal(rt.explicar(429, ''), 'HTTP 429: la cuenta no tiene cupo o saldo para sesiones realtime.');
  assert.match(rt.explicar(429, 'sin saldo'), / — sin saldo$/);
  assert.match(rt.explicar(503, ''), /el proveedor está con problemas; no es la configuración\.$/);
  assert.match(rt.explicar(502, 'gateway'), / — gateway$/);
  assert.equal(rt.explicar(418, ''), 'HTTP 418');
  assert.equal(rt.explicar(418, 'tetera'), 'HTTP 418: tetera');
  assert.equal(rt.explicar(418, null), 'HTTP 418');
});

test('abrir(): sin URL arma la del protocolo con el modelo por defecto; sin clave no manda cabeceras', () => {
  const { WS, creados } = wsFalso();
  rt.abrir({ WebSocketImpl: WS });
  assert.equal(creados[0].url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
  assert.equal(creados[0].opts.headers, undefined);
  rt.abrir({ WebSocketImpl: WS, model: 'gpt-live-1', key: 'k' });
  assert.equal(creados[1].url, 'wss://api.openai.com/v1/live/sessions');
  assert.deepEqual(creados[1].opts.headers, { Authorization: 'Bearer k' });
});

test('abrir(): lo que llega roto o sin tipo no rompe; los eventos de fin y los desconocidos se anotan', async () => {
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x' });
  const ws = creados[0];
  ws.abrir();
  let fines = 0;
  p.on('fin', () => fines++);
  ws.llega('esto no es json');
  ws.llega({ sin: 'tipo' });
  ws.llega({ type: 'response.done' });
  ws.llega({ type: 'rate_limits.updated' });
  /* Audio vacío: no hay nada que mandar al canal. */
  let audios = 0;
  p.on('audio', () => audios++);
  ws.llega({ type: 'response.audio.delta' });
  ws.llega({ type: 'response.audio_transcript.delta', delta: '' });
  ws.llega({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' });
  assert.equal(fines, 1);
  assert.equal(audios, 0);
  assert.deepEqual(p.eventos, { '?': 1, 'response.done': 1, 'rate_limits.updated': 1, 'response.audio.delta': 1,
    'response.audio_transcript.delta': 1, 'conversation.item.input_audio_transcription.completed': 1 });
});

test('abrir(): el cierre del socket informa código y motivo, también binario, vacío o roto', () => {
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x' });
  const ws = creados[0];
  const cierres = [];
  p.on('cerrado', (c) => cierres.push(c));
  ws.emit('close', 4002, Buffer.from('sin saldo'));
  ws.emit('close', undefined, undefined);
  ws.emit('close', 1011, 'x'.repeat(300));
  /* Un motivo que ni siquiera se puede pasar a texto no tira la API: queda vacío. */
  ws.emit('close', 1000, { toString() { throw new Error('ilegible'); } });
  assert.deepEqual(cierres[0], { code: 4002, motivo: 'sin saldo' });
  assert.deepEqual(cierres[1], { code: 0, motivo: '' });
  assert.equal(cierres[2].motivo.length, 200);
  assert.deepEqual(cierres[3], { code: 1000, motivo: '' });
});

test('abrir(): un error del socket sin mensaje se avisa; después de un handshake fallido no se duplica', () => {
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x', model: 'gpt-x' });
  const ws = creados[0];
  const errores = [];
  p.on('error', (e) => errores.push(e));
  ws.emit('error', 'texto suelto');
  assert.deepEqual(errores, ['texto suelto']);
  const resp = new EventEmitter();
  resp.statusCode = 401;
  ws.emit('unexpected-response', {}, resp);
  resp.emit('data', 'clave vencida');
  resp.emit('end');
  assert.match(errores[1], /HTTP 401.*clave vencida/);
  ws.emit('error', new Error('Unexpected server response: 401'));
  assert.equal(errores.length, 2, 'el error genérico de ws taparía la explicación del handshake');
});

test('abrir(): un handshake cuya respuesta queda abierta igual se explica (a los 2 s, o si la respuesta falla)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x' });
  const errores = [];
  p.on('error', (e) => errores.push(e));
  const resp = new EventEmitter();
  resp.statusCode = 500;
  creados[0].emit('unexpected-response', {}, resp);
  resp.emit('data', 'a'.repeat(1200));
  resp.emit('data', 'no entra');   // el cuerpo se corta en ~1000 caracteres
  assert.equal(errores.length, 0);
  t.mock.timers.tick(2000);
  assert.equal(errores.length, 1);
  assert.match(errores[0], /HTTP 500: el proveedor está con problemas/);
  assert.doesNotMatch(errores[0], /no entra/);
  /* Otra apertura: la respuesta se rompe en vez de terminar. */
  const p2 = rt.abrir({ WebSocketImpl: WS, url: 'ws://x' });
  const e2 = [];
  p2.on('error', (e) => e2.push(e));
  const r2 = new EventEmitter();
  r2.statusCode = 403;
  creados[1].emit('unexpected-response', {}, r2);
  r2.emit('error', new Error('reset'));
  assert.match(e2[0], /HTTP 403/);
  t.mock.timers.tick(2000);
  assert.equal(e2.length, 1, 'el reloj de los 2 s no repite el aviso si ya se dio');
});

test('cuandoListo(): con la sesión ya lista resuelve enseguida; si no abre, vence con el tope por defecto', async (t) => {
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x' });
  creados[0].abrir();
  await p.cuandoListo();   // Realtime: el socket abierto ya alcanza
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p2 = rt.abrir({ WebSocketImpl: WS, url: 'ws://x' });
  const espera = p2.cuandoListo();
  t.mock.timers.tick(10000);
  await assert.rejects(espera, /no abrió la sesión a tiempo/);
});

test('Live: un session.started repetido no reenvía; si el socket se cerró antes, los guardados se avisan como error', () => {
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x', model: 'gpt-live-1' });
  const ws = creados[0];
  const errores = [];
  let listos = 0;
  p.on('error', (e) => errores.push(e));
  p.on('listo', () => listos++);
  ws.abrir();
  p.saludar('hola');
  p.enviarCrudo({ type: 'session.commentary.append', content: 'x' });
  /* El socket se cae antes de que el proveedor confirme la sesión. */
  ws.readyState = 3;
  ws.llega({ type: 'session.started' });
  assert.equal(listos, 1);
  assert.match(errores[0], /quedó lista con el socket cerrado: 2 mensajes sin mandar/);
  ws.llega({ type: 'session.started' });
  assert.equal(listos, 1, 'una sesión no se marca lista dos veces');
});

test('Live: si mandar los guardados tira, se avisa y no se sigue intentando', () => {
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x', model: 'gpt-live-1' });
  const ws = creados[0];
  ws.abrir();
  p.saludar('hola');
  p.saludar('otra vez');
  const errores = [];
  p.on('error', (e) => errores.push(e));
  ws.send = () => { throw new Error('socket roto'); };
  ws.llega({ type: 'session.started' });
  assert.equal(errores[0], 'socket roto');
  assert.match(errores[1], /1 mensajes sin mandar/);
});

test('Live: herramientas — la respuesta y el pedido de seguir van con los nombres de Live', () => {
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x', model: 'gpt-live-1' });
  const ws = creados[0];
  ws.abrir();
  ws.llega({ type: 'session.started' });
  p.responderHerramienta('c1', { ok: true });
  assert.deepEqual(ws.tipos().slice(-2), ['response.item.create', 'response.create']);
  assert.equal(JSON.parse(ws.enviados.at(-2).item.output).ok, true);
});

test('agregarHerramientas(): una lista vacía no reconfigura; una con algo suma al catálogo y reconfigura', () => {
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x', model: 'gpt-live-1' });
  const ws = creados[0];
  ws.abrir();
  ws.llega({ type: 'session.started' });
  const antes = ws.enviados.length;
  p.agregarHerramientas([]);
  p.agregarHerramientas('no es lista');
  assert.equal(ws.enviados.length, antes);
  p.agregarHerramientas([{ type: 'function', name: 'consultar_saldo' }]);
  const cfg = ws.enviados.at(-1);
  assert.equal(cfg.type, 'session.start');
  assert.equal(cfg.session.delegation.responses.tools[0].name, 'consultar_saldo');
});

test('enviar: un mensaje nulo no sale; si el socket tira al mandar, se avisa como error', () => {
  const { WS, creados } = wsFalso({ tiraAlMandar: false });
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x' });
  const ws = creados[0];
  ws.abrir();
  const antes = ws.enviados.length;
  p.enviarCrudo(null);
  p.enviarAudio(Buffer.alloc(0));
  p.enviarAudio(null);
  assert.equal(ws.enviados.length, antes, 'ni un nulo ni un frame vacío salen al modelo');
  const errores = [];
  p.on('error', (e) => errores.push(e));
  ws.send = () => { throw 'texto'; };
  p.saludar('hola');
  assert.deepEqual(errores, ['texto']);
});

test('metricas(): sin turnos no inventa números; con varios, mediana y peor', () => {
  const { WS, creados } = wsFalso();
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x' });
  const ws = creados[0];
  ws.abrir();
  const vacio = p.metricas();
  assert.equal(vacio.mediana_ms, null);
  assert.equal(vacio.peor_ms, null);
  const audio = Buffer.alloc(60).toString('base64');
  for (let i = 0; i < 3; i++) {
    ws.llega({ type: 'input_audio_buffer.speech_started' });
    ws.llega({ type: 'response.audio.delta', delta: audio });
  }
  const m = p.metricas();
  assert.equal(m.turnos, 3);
  assert.ok(m.mediana_ms >= 0 && m.peor_ms >= m.mediana_ms);
});

test('cerrar(): un socket que tira al cerrar no rompe a quien cuelga', () => {
  const { WS } = wsFalso({ tiraAlCerrar: true });
  const p = rt.abrir({ WebSocketImpl: WS, url: 'ws://x' });
  assert.doesNotThrow(() => p.cerrar());
});

test('probar(): si ni siquiera se puede crear el socket, devuelve el error sin api ni eventos', async () => {
  const { WS } = wsFalso({ tiraAlCrear: true });
  const r = await rt.probar({ WebSocketImpl: WS, url: 'ws://x' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no se pudo crear el socket');
  assert.equal(r.model, null);
  assert.equal(r.voz, null);
  assert.equal(r.api, null);
  assert.deepEqual(r.eventos, {});
  assert.equal(r.modo, 'realtime');
});

test('probar(): un error del proveedor mientras se espera el audio corta el intento con ese error', async () => {
  const { WS, creados } = wsFalso();
  const prueba = rt.probar({ WebSocketImpl: WS, url: 'ws://x', topeAbrir: 1000, topeAudio: 1000 });
  await new Promise((ok) => setImmediate(ok));
  const ws = creados[0];
  ws.abrir();
  await new Promise((ok) => setImmediate(ok));
  ws.llega({ type: 'error', error: { message: 'insufficient_quota' } });
  const r = await prueba;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'insufficient_quota');
  assert.equal(r.api, 'realtime');
});

test('probar(): sin audio, el tope por defecto (12 s) lo dice; en Live, sin error propio, se cuentan los dos modos', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { WS, creados } = wsFalso();
  const prueba = rt.probar({ WebSocketImpl: WS, url: 'ws://x', model: 'gpt-live-1', topeAbrir: 1000 });
  for (let i = 0; i < 2; i++) {
    for (let k = 0; k < 5 && creados.length <= i; k++) await new Promise((ok) => setImmediate(ok));
    const ws = creados[i];
    ws.abrir();
    ws.llega({ type: 'session.started' });
    for (let k = 0; k < 5; k++) await new Promise((ok) => setImmediate(ok));
    t.mock.timers.tick(400);       // el saludo, después del silencio
    t.mock.timers.tick(12000);     // tope de audio por defecto
    for (let k = 0; k < 5; k++) await new Promise((ok) => setImmediate(ok));
  }
  const r = await prueba;
  assert.equal(r.ok, false);
  assert.equal(r.intentos.length, 2);
  assert.match(r.error, /no habló en ninguno de los dos modos/);
  assert.match(r.error, /no mandó audio en 12 s/);
  assert.ok(creados[0].tipos().includes('session.input_audio.append'), 'Live recibe silencio al ritmo del canal');
});

test('probar(): con audio y sin colaMs, espera la cola por defecto antes de dar el ok', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { WS, creados } = wsFalso();
  const prueba = rt.probar({ WebSocketImpl: WS, url: 'ws://x', model: 'otro', voz: 'cedar' });
  await new Promise((ok) => setImmediate(ok));
  const ws = creados[0];
  ws.abrir();
  for (let k = 0; k < 5; k++) await new Promise((ok) => setImmediate(ok));
  ws.llega({ type: 'response.audio_transcript.delta', delta: 'listo' });
  ws.llega({ type: 'response.audio.delta', delta: Buffer.alloc(60).toString('base64') });
  for (let k = 0; k < 5; k++) await new Promise((ok) => setImmediate(ok));
  t.mock.timers.tick(600);
  const r = await prueba;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.voz, 'cedar');
  assert.equal(r.texto, 'listo');
});
