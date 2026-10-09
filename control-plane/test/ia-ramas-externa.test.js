/* ============================================================================
 *  IA externa (ia-externa.js): lo que el backend o la red mandan MAL.
 *
 *  ia-externa.test.js e ia-externa-relay.test.js fijan el contrato con un backend que se
 *  porta bien. Acá el socket es de mentira y lo maneja la prueba, para recorrer lo que en
 *  producción aparece de a uno y un día cualquiera: un mensaje que no es JSON o no tiene
 *  tipo, una orden sin id (no se confirma, pero se ejecuta), un error sin mensaje, un
 *  socket que tira al mandar, al cerrar o al hacer ping, una configuración que viene
 *  vacía o sin modelo, el mismo 5xx repetido, y más órdenes de las que se recuerdan.
 *
 *  Por qué importa: el canal de control y el relay son los que abren el portón y derivan
 *  la llamada. Ninguno de esos bordes puede tirar el proceso ni dejar una orden sin
 *  respuesta (el backend la reenviaría para siempre), y una orden repetida nunca se
 *  ejecuta dos veces.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const iax = require('../ia-externa');

/* Un WebSocket que la prueba abre, cierra y hace fallar a mano. */
function wsFalso() {
  const creados = [];
  class WS extends EventEmitter {
    constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 0; this.enviados = []; creados.push(this); }
    send(t) { if (this.rotoAlMandar) throw new Error('roto'); this.enviados.push(JSON.parse(t)); }
    close() { if (this.rotoAlCerrar) throw new Error('roto'); this.readyState = 3; this.emit('close'); }
    terminate() { if (this.rotoAlCerrar) throw new Error('roto'); this.readyState = 3; this.emit('close'); }
    ping() { if (this.rotoAlPing) throw new Error('roto'); this.pings = (this.pings || 0) + 1; }
    abrir() { this.readyState = 1; this.emit('open'); }
  }
  return { WS, creados };
}
const tanda = () => new Promise((ok) => setImmediate(ok));

test('dtmfApertura y destinoPermitido: sin agente o sin herramientas no hay apertura ni destino', () => {
  assert.equal(iax.dtmfApertura(null), null);
  assert.equal(iax.dtmfApertura({}), null);
  assert.equal(iax.dtmfApertura({ herramientas: { abrir_porton: { on: true } } }), '#', 'sin tono configurado abre con #');
  assert.equal(iax.destinoPermitido(null, ''), false, 'un destino vacío nunca es válido');
  assert.equal(iax.urlPermitida(undefined).ok, false);
});

test('bajarConfig: vacía, sin versión o sin modelo se rechaza con un motivo que se entiende', async () => {
  const urls = [];
  const con = (cuerpo) => async (u) => { urls.push(u); return Response.json(cuerpo); };
  await assert.rejects(iax.bajarConfig({ url: undefined, token: 't', fetchImpl: con(null) }), /vino incompleta/);
  assert.equal(urls[0], '/api/pbx/session-config', 'sin URL no se inventa un host');
  await assert.rejects(iax.bajarConfig({ url: 'http://b', token: 't', fetchImpl: con({ session: { model: 'gpt-live-1' } }) }), /incompleta/);
  await assert.rejects(iax.bajarConfig({ url: 'http://b', token: 't', fetchImpl: con({ version: 'v1', session: {} }) }), /no es GPT-Live: sin modelo/);
});

test('enviarHecho: sin fetch propio usa el global; un fallo sin mensaje queda como texto; reintenta con la espera por defecto', async (t) => {
  const pedidos = [];
  t.mock.method(globalThis, 'fetch', async (u) => { pedidos.push(u); return new Response('', { status: 200 }); });
  const ok = await iax.enviarHecho({ url: 'http://b/', token: 't', hecho: { type: 'colgo', pbxCallId: 'a b' } });
  assert.deepEqual(ok, { ok: true, motivo: '' });
  assert.equal(pedidos[0], 'http://b/api/pbx/llamadas/a%20b/hechos');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  const f = async () => { n++; throw 'red caída'; };
  const p = iax.enviarHecho({ url: 'http://b', token: 't', hecho: { type: 'colgo', pbxCallId: 'c' }, fetchImpl: f, intentos: 2 });
  for (let i = 0; i < 5; i++) await tanda();
  assert.equal(n, 1);
  t.mock.timers.tick(1000);   // 1000 ms × intento 1
  const r = await p;
  assert.equal(n, 2);
  assert.deepEqual(r, { ok: false, motivo: 'red caída' });
});

test('canal de control: mensajes rotos, sin tipo o de error no ejecutan nada; el error se anota con o sin detalle', async () => {
  const { WS, creados } = wsFalso();
  const logs = [];
  const ordenes = [];
  const canal = new iax.CanalControl({ url: 'http://b', token: 't', WebSocketImpl: WS, log: (m) => logs.push(m), alOrden: async (o) => { ordenes.push(o); } });
  canal.iniciar();
  const ws = creados[0];
  ws.abrir();
  await canal.recibir('no es json');
  await canal.recibir('null');
  await canal.recibir(JSON.stringify({ type: 3 }));
  await canal.recibir(JSON.stringify({ type: 'error', detalle: 'firma inválida' }));
  await canal.recibir(JSON.stringify({ type: 'error' }));
  assert.equal(ordenes.length, 0);
  assert.ok(logs.some((l) => /rechazó un mensaje \(firma inválida\)/.test(l)));
  assert.ok(logs.some((l) => /rechazó un mensaje \(\)/.test(l)));
  /* Una orden sin id se ejecuta pero no hay a qué confirmarle. */
  await canal.recibir(JSON.stringify({ type: 'refrescar_config' }));
  assert.equal(ordenes.length, 1);
  assert.equal(ws.enviados.length, 0);
  /* Una que falla sin mensaje, sin id ni llamada: igual sale la falla. */
  canal.alOrden = async () => { throw 'sin detalle'; };
  await canal.recibir(JSON.stringify({ type: 'x' }));
  assert.deepEqual(ws.enviados[0], { type: 'orden_fallida', pbxCallId: null, ordenId: '', detalle: 'sin detalle' });
  /* Un socket que tira al mandar: la respuesta se pierde, no el proceso. */
  ws.rotoAlMandar = true;
  assert.equal(canal.enviar({ type: 'ack' }), false);
  canal.parar();
});

test('canal de control: recuerda hasta 500 órdenes; la más vieja se olvida', async () => {
  const { WS, creados } = wsFalso();
  let n = 0;
  const canal = new iax.CanalControl({ url: 'http://b', token: 't', WebSocketImpl: WS, alOrden: async () => { n++; } });
  canal.iniciar();
  creados[0].abrir();
  for (let i = 0; i <= 500; i++) await canal.recibir(JSON.stringify({ type: 'refrescar_config', id: 'o' + i }));
  assert.equal(canal.vistas.size, 500);
  assert.equal(canal.vistas.has('o0'), false);
  await canal.recibir(JSON.stringify({ type: 'refrescar_config', id: 'o500' }));
  assert.equal(n, 501, 'una recordada no se ejecuta otra vez');
  await canal.recibir(JSON.stringify({ type: 'refrescar_config', id: 'o0' }));
  assert.equal(n, 502, 'la olvidada sí');
  canal.parar();
});

test('canal de control: el mismo status no se repite en el log; un 5xx no sugiere el token; sin respuesta no rompe', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { WS, creados } = wsFalso();
  const logs = [];
  const canal = new iax.CanalControl({ url: 'http://b', token: 't', WebSocketImpl: WS, log: (m) => logs.push(m) });
  canal.iniciar();
  creados[0].rotoAlCerrar = true;
  creados[0].emit('unexpected-response', {}, { statusCode: 502 });
  creados[0].emit('unexpected-response', {}, { statusCode: 502 });
  creados[0].emit('unexpected-response', {}, undefined);
  const del502 = logs.filter((l) => /contestó 502/.test(l));
  assert.equal(del502.length, 1);
  assert.doesNotMatch(del502[0], /token/);
  assert.ok(logs.some((l) => /contestó undefined/.test(l)));
  creados[0].emit('error', 'texto');
  assert.ok(logs.includes('canal de control: texto'));
  canal.parar();
  /* Parado, un reintento que ya estaba agendado no reabre nada. */
  canal.conectar();
  assert.equal(creados.length, 1);
});

test('canal de control: si el latido vence y cortar el socket tira, el canal no se cae', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { WS, creados } = wsFalso();
  const logs = [];
  const canal = new iax.CanalControl({ url: 'http://b', token: 't', WebSocketImpl: WS, log: (m) => logs.push(m) });
  canal.iniciar();
  creados[0].abrir();
  creados[0].rotoAlCerrar = true;
  assert.doesNotThrow(() => t.mock.timers.tick(15000));
  assert.ok(logs.some((l) => /no manda latido/.test(l)));
  canal.parado = true;
});

const AVISO = { type: 'llamada_nueva', pbxCallId: 'c1' };
function relayFalso(extra = {}) {
  const { WS, creados } = wsFalso();
  const r = { logs: [], ordenes: [], rechazos: [], perdidas: [], creados };
  r.relay = new iax.RelayLlamada(Object.assign({
    abrir: () => new WS('ws://b/relay'),
    aviso: AVISO, ventanaMs: 1000, reaperturaMs: 50,
    log: (m) => r.logs.push(m),
    alOrden: async (o) => { r.ordenes.push(o); if (o.falla) throw o.falla; },
    alRechazado: (m) => r.rechazos.push(m),
    alPerdido: (m) => r.perdidas.push(m),
  }, extra));
  return r;
}

test('relay: lo roto o sin tipo se ignora, un rechazo sin motivo se anota «rechazado», un error sin mensaje se loguea', () => {
  const r = relayFalso();
  r.relay.iniciar();
  const ws = r.creados[0];
  ws.abrir();
  ws.emit('message', 'no es json');
  ws.emit('message', 'null');
  ws.emit('message', JSON.stringify({ type: 5 }));
  ws.emit('error', 'texto');
  assert.ok(r.logs.includes('relay: texto'));
  ws.emit('message', JSON.stringify({ type: 'enganche_rechazado' }));
  assert.deepEqual(r.rechazos, ['rechazado']);
});

test('relay: órdenes sin id se ejecutan sin ack; una que falla sin mensaje sale como falla con ordenId vacío', async () => {
  const r = relayFalso();
  r.relay.iniciar();
  const ws = r.creados[0];
  ws.abrir();
  ws.enviados.length = 0;
  await r.relay.ordenar({ type: 'colgar', pbxCallId: 'c1' });
  assert.equal(r.ordenes.length, 1);
  assert.equal(ws.enviados.length, 0, 'sin id no hay a qué confirmar');
  await r.relay.ordenar({ type: 'enviar_dtmf', pbxCallId: 'c1', falla: 'portero mudo' });
  assert.deepEqual(ws.enviados[0], { type: 'orden_fallida', pbxCallId: 'c1', ordenId: '', detalle: 'portero mudo' });
  /* Una ajena sin id: la falla tampoco lleva id. */
  await r.relay.ordenar({ type: 'colgar', pbxCallId: 'otra' });
  assert.equal(ws.enviados[1].ordenId, '');
});

test('relay: recuerda hasta 500 órdenes; la más vieja se olvida', async () => {
  const r = relayFalso();
  r.relay.iniciar();
  r.creados[0].abrir();
  for (let i = 0; i <= 500; i++) await r.relay.ordenar({ type: 'enviar_dtmf', id: 'o' + i, pbxCallId: 'c1' });
  assert.equal(r.relay.vistas.size, 500);
  assert.equal(r.relay.vistas.has('o0'), false);
});

test('relay: un socket que tira al mandar o al cerrar no rompe; sin `on` también se suelta', () => {
  const r = relayFalso();
  r.relay.iniciar();
  const ws = r.creados[0];
  ws.abrir();
  ws.rotoAlMandar = true;
  assert.equal(r.relay.mandar({ type: 'x' }), false);
  ws.rotoAlCerrar = true;
  assert.doesNotThrow(() => r.relay.soltar(ws));
  assert.doesNotThrow(() => r.relay.soltar({ readyState: 3, terminate() {} }));
  assert.doesNotThrow(() => r.relay.soltar({ readyState: 3, on() { throw new Error('x'); }, terminate() {} }));
});

test('relay: terminado no reabre; un open o un latido de un socket viejo no tocan el actual', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const r = relayFalso({ latidoMs: 100, mudoMs: 1000 });
  r.relay.iniciar();
  const viejo = r.creados[0];
  viejo.abrir();
  /* El viejo se da por cortado y se reabre; el open tardío del viejo no cuenta. */
  viejo.emit('close', undefined);
  assert.ok(r.logs.some((l) => /se cortó \(sin código\)/.test(l)));
  t.mock.timers.tick(0);
  const nuevo = r.creados[1];
  assert.ok(nuevo);
  viejo.emit('open');
  assert.equal(r.relay.estado, 'abriendo');
  /* El latido del viejo, todavía agendado, se apaga solo al ver que ya no es el actual. */
  r.relay.vigilar(viejo);
  t.mock.timers.tick(100);
  assert.equal(r.relay.latido, null);
  /* Un socket sin ping, o con un ping que tira, no corta el latido. */
  nuevo.abrir();
  nuevo.rotoAlPing = true;
  assert.doesNotThrow(() => t.mock.timers.tick(100));
  nuevo.ping = undefined;
  assert.doesNotThrow(() => t.mock.timers.tick(100));
  r.relay.cerrar();
  r.relay.abrirAhora();
  assert.equal(r.creados.length, 2, 'terminado, no se abre otro socket');
});

test('relay: si la llamada termina cuando el socket recién abre, se suelta sin avisar', () => {
  const r = relayFalso();
  r.relay.iniciar();
  const ws = r.creados[0];
  r.relay.estado = 'terminado';   // terminó en el mismo instante en que abría
  ws.readyState = 1;
  ws.emit('open');
  assert.equal(ws.enviados.length, 0, 'el backend no se entera de una llamada que ya terminó');
  assert.equal(ws.readyState, 3);
});

test('crear: sin configuración guardada y con 304, no inventa una ni pide condicional', async () => {
  const { WS, creados } = wsFalso();
  const pedidos = [];
  const m = iax.crear({
    agentes: async () => [{ id: 2, provider: 'ia-externa', externo_url: 'http://b', externo_token: 't' }],
    leerConfig: async () => null,
    guardarConfig: async () => { throw new Error('con 304 no hay nada que guardar'); },
    WebSocketImpl: WS,
    fetchImpl: async (u, o) => { pedidos.push(o.headers); return new Response(null, { status: 304 }); },
  });
  await m.recargar();
  creados[0].abrir();
  creados[0].emit('message', JSON.stringify({ type: 'refrescar_config', id: 'r1' }));
  for (let i = 0; i < 10; i++) await tanda();
  assert.deepEqual(creados[0].enviados.at(-1), { type: 'ack', id: 'r1' });
  assert.equal(m.configDe(2), null);
  assert.equal(pedidos.at(-1)['If-None-Match'], undefined, 'sin versión guardada no se pide condicional');
  m.parar();
});

test('crear: con la configuración guardada, el 304 la conserva y una recarga no la pisa', async () => {
  const { WS, creados } = wsFalso();
  const pedidos = [];
  const guardada = { version: 'v7', session: { model: 'gpt-live-1' }, attachTimeoutMs: 5000, resumeWindowMs: 20000 };
  let leidas = 0;
  const m = iax.crear({
    agentes: async () => [{ id: 3, provider: 'ia-externa', externo_url: 'http://b', externo_token: 't' }],
    leerConfig: async () => { leidas++; return leidas === 1 ? guardada : Object.assign({}, guardada, { version: 'vieja' }); },
    guardarConfig: async () => { throw new Error('con 304 no hay nada que guardar'); },
    WebSocketImpl: WS,
    fetchImpl: async (u, o) => { pedidos.push(o.headers); return new Response(null, { status: 304 }); },
  });
  await m.recargar();
  await m.recargar();   // la base devuelve otra cosa: la que ya está en memoria manda
  assert.equal(m.configDe(3).version, 'v7');
  creados[0].abrir();
  creados[0].emit('message', JSON.stringify({ type: 'refrescar_config', id: 'r1' }));
  for (let i = 0; i < 10; i++) await tanda();
  assert.deepEqual(creados[0].enviados.at(-1), { type: 'ack', id: 'r1' });
  assert.equal(pedidos.at(-1)['If-None-Match'], '"v7"');
  assert.equal(m.configDe(3).version, 'v7');
  m.parar();
});
