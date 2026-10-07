/* ============================================================================
 *  IA externa (ia-externa.js): los bordes que no pasan en una llamada normal.
 *
 *  Un backend que no contesta (el tope corta el pedido en vez de colgar la llamada), un
 *  canal de control que se queda sin latido o se cae (se reconecta solo), la base que no
 *  puede leer la configuración guardada (se baja igual), y un agente que se suma a un
 *  backend caído (se avisa en el log, no rompe la recarga).
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const iax = require('../ia-externa');

/* Un fetch que no contesta nunca: sólo se entera del tope por la señal. */
const colgado = async (_url, { signal }) => new Promise((_ok, mal) => signal.addEventListener('abort', () => mal(new Error('abortado por el tope'))));

test('bajarConfig y enviarHecho: un backend que no contesta se corta por el tope', async () => {
  await assert.rejects(iax.bajarConfig({ url: 'http://b', token: 't', fetchImpl: colgado, topeMs: 20 }), /tope/);
  const r = await iax.enviarHecho({ url: 'http://b', token: 't', hecho: { type: 'colgo', pbxCallId: 'c' }, fetchImpl: colgado, intentos: 1, topeMs: 20 });
  assert.deepEqual(r, { ok: false, motivo: 'abortado por el tope' });
});

/* Un WebSocket de mentira que el test maneja a mano. */
function wsFalso() {
  const creados = [];
  class WS extends EventEmitter {
    constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 0; this.enviados = []; creados.push(this); }
    send(t) { this.enviados.push(JSON.parse(t)); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  return { WS, creados };
}

test('canal de control: sin latido se corta y se reconecta; las órdenes sin manejador se confirman igual', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { WS, creados } = wsFalso();
  const canal = new iax.CanalControl({ url: 'http://b', token: 't', WebSocketImpl: WS });
  canal.iniciar();
  const ws = creados[0];
  ws.readyState = 1;
  ws.emit('open');
  ws.emit('ping');
  await canal.recibir(JSON.stringify({ type: 'refrescar_config', id: 'o1' }));
  assert.deepEqual(ws.enviados, [{ type: 'ack', id: 'o1' }]);
  /* El backend deja de mandar ping: pasado el tope el canal se corta solo… */
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(ws.readyState, 3);
  /* …y se vuelve a abrir. */
  t.mock.timers.tick(60 * 1000);
  assert.ok(creados.length >= 2, 'no se reconectó');
  canal.parar();
});

test('relay: sin manejadores, los avisos por defecto no rompen', async () => {
  const r = new iax.RelayLlamada({ abrir: () => { throw new Error('sin red'); }, aviso: { type: 'llamada_nueva' }, reaperturaMs: 0 });
  r.log('x'); r.alComando({}); r.alRechazado('m'); r.alPerdido('m');
  await r.alOrden({});
  r.cerrar();
});

test('crear: la base no lee la configuración guardada y se baja igual; un agente nuevo con el backend caído se avisa', async () => {
  const logs = [];
  const { WS, creados } = wsFalso();
  let caido = false;
  const guardadas = [];
  const cfg = { version: 'v1', session: { model: 'gpt-live-1' } };
  const agentes = [{ id: 1, provider: 'ia-externa', externo_url: 'http://b', externo_token: 't' }];
  const m = iax.crear({
    agentes: async () => agentes,
    leerConfig: async () => { throw new Error('base caída'); },
    guardarConfig: async (id, c) => { guardadas.push([id, c.version]); },
    WebSocketImpl: WS,
    log: (s) => logs.push(s),
    fetchImpl: async () => (caido ? new Response('', { status: 503 }) : Response.json(cfg)),
  });
  await m.recargar();
  const canal = creados[0];
  canal.readyState = 1;
  await new Promise((ok) => { canal.send = (t) => { canal.enviados.push(JSON.parse(t)); ok(); }; canal.emit('message', JSON.stringify({ type: 'refrescar_config', id: 'r1' })); });
  assert.deepEqual(canal.enviados, [{ type: 'ack', id: 'r1' }]);
  assert.deepEqual(guardadas, [[1, 'v1']]);
  caido = true;
  agentes.push({ id: 2, provider: 'ia-externa', externo_url: 'http://b', externo_token: 't' });
  await m.recargar();
  for (let i = 0; i < 50 && !logs.some((l) => /agente 2/.test(l)); i++) await new Promise((ok) => setImmediate(ok));
  assert.ok(logs.some((l) => /no se pudo bajar la configuración \(agente 2: el backend contestó 503/.test(l)), logs.join('\n'));
  m.parar();
});
