/* ============================================================================
 *  El relay de una llamada con el backend (contrato v2, ia-externa.js · RelayLlamada) y
 *  los hechos por HTTP.
 *
 *  Contra qué se prueba: un servidor WebSocket FALSO que hace de backend, con varias
 *  conexiones (cada reapertura del relay es una conexión nueva, que en producción puede
 *  caer en otra instancia). Lo que importa fijar es lo que, si falla, corta o confunde una
 *  llamada cuando el backend cambia de instancia:
 *
 *   · el aviso va primero y cada evento y hecho va numerado, de a uno;
 *   · si el relay se corta, se reabre (enseguida y después cada tanto) durante la ventana,
 *     avisando que es una reanudación, y se reenvía desde donde el backend diga;
 *   · con «reubicar» (4001) se reabre sin esperar; vencida la ventana, respaldo;
 *   · una orden repetida por un relay reabierto no se ejecuta dos veces;
 *   · un hecho con el relay cerrado llega por HTTP, con reintentos.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer, WebSocket } = require('ws');
const iax = require('../ia-externa');

const esperar = (ms = 60) => new Promise((ok) => setTimeout(ok, ms));
const hasta = async (cond, ms = 2000) => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (cond()) return; await esperar(10); }
  throw new Error('no pasó a tiempo');
};

/* El backend falso: junta lo que llega por cada conexión del relay. */
async function backendRelay() {
  const conexiones = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((ok) => wss.once('listening', ok));
  wss.on('connection', (ws, req) => {
    const c = { ws, url: req.url, auth: req.headers.authorization, recibido: [] };
    conexiones.push(c);
    ws.on('message', (d) => { try { c.recibido.push(JSON.parse(String(d))); } catch (_) {} });
  });
  const ultima = () => conexiones[conexiones.length - 1];
  return {
    conexiones, ultima,
    url: 'ws://127.0.0.1:' + wss.address().port,
    mandar: (o) => ultima().ws.send(JSON.stringify(o)),
    cortar: (codigo) => ultima().ws.close(codigo || 1011, 'se cae'),
    cerrar: () => new Promise((ok) => { for (const c of wss.clients) { try { c.terminate(); } catch (_) {} } wss.close(ok); }),
  };
}

const AVISO = { type: 'llamada_nueva', pbxCallId: 'c1', from: '1001', to: '8000', origen: 'portero', configVersion: 'v1', dtmfApertura: '#9', destinoAgentes: '1002' };

function relayCon(srv, extra = {}) {
  const r = {
    logs: [], comandos: [], ordenes: [], confirmado: 0, rechazos: [], perdidas: [],
  };
  r.relay = new iax.RelayLlamada({
    abrir: () => new WebSocket(srv.url + '/api/pbx/llamadas/c1/relay', { headers: { Authorization: 'Bearer t0k' } }),
    aviso: AVISO,
    ventanaMs: 2000,
    reaperturaMs: 100,
    log: (m) => r.logs.push(m),
    alComando: (c) => r.comandos.push(c.type),
    alOrden: async (o) => { r.ordenes.push(o.type); if (o.type === 'enviar_dtmf' && o.digitos === 'falla') throw new Error('el portero no responde'); },
    alConfirmado: () => { r.confirmado++; },
    alRechazado: (m) => r.rechazos.push(m),
    alPerdido: (m) => r.perdidas.push(m),
    ...extra,
  });
  return r;
}

const tipos = (c) => c.recibido.map((m) => m.type);
const evento = (n) => ({ type: 'session.output_transcript.delta', delta: 'parte ' + n });

test('relay: el aviso va primero; lo de antes de abrir sale después, todo numerado de a uno', async (t) => {
  const srv = await backendRelay();
  t.after(() => srv.cerrar());
  const r = relayCon(srv);
  t.after(() => r.relay.cerrar());
  assert.equal(r.relay.mandar(evento(1)), false, 'sin relay abierto, se guarda');
  r.relay.mandar(evento(2));
  r.relay.iniciar();
  await hasta(() => srv.conexiones.length === 1 && srv.ultima().recibido.length === 3);
  const [aviso, e1, e2] = srv.ultima().recibido;
  assert.deepEqual(aviso, { ...AVISO, reanudar: false, ultimoSeq: null });
  assert.equal(srv.ultima().auth, 'Bearer t0k');
  assert.deepEqual([e1.seq, e2.seq], [1, 2]);
  assert.equal(r.relay.mandar({ type: 'dtmf', pbxCallId: 'c1', digito: '5' }), true, 'abierto, sale ya');
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1' });
  await hasta(() => r.confirmado === 1);
  assert.equal(srv.ultima().recibido.at(-1).seq, 3, 'los hechos van en la misma secuencia');
});

test('relay: guarda solo los últimos (tope) para reenviar', () => {
  const r = new iax.RelayLlamada({ abrir: () => { throw new Error('sin red'); }, aviso: AVISO, tope: 3 });
  for (let i = 1; i <= 5; i++) r.mandar(evento(i));
  assert.deepEqual(r.guardados.map((g) => g.seq), [3, 4, 5]);
});

test('relay: comandos permitidos a la sesión, órdenes con ack, repetidas sin ejecutar, ajenas y desconocidas con falla', async (t) => {
  const srv = await backendRelay();
  t.after(() => srv.cerrar());
  const r = relayCon(srv);
  t.after(() => r.relay.cerrar());
  r.relay.iniciar();
  await hasta(() => srv.conexiones.length === 1 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'session.commentary.append', content: 'Portería Orison' });
  srv.mandar({ type: 'session.update', session: {} });            // no permitido: se descarta
  srv.mandar({ type: 'transferir', id: 'o1', pbxCallId: 'c1', destino: '1002' });
  srv.mandar({ type: 'transferir', id: 'o1', pbxCallId: 'c1', destino: '1002' });
  srv.mandar({ type: 'enviar_dtmf', id: 'o2', pbxCallId: 'c1', digitos: 'falla' });
  srv.mandar({ type: 'colgar', id: 'o3', pbxCallId: 'otra' });
  srv.mandar({ type: 'abrir_todo', id: 'o4' });
  await hasta(() => srv.ultima().recibido.length === 5);
  assert.deepEqual(r.comandos, ['session.commentary.append']);
  assert.deepEqual(r.ordenes, ['transferir', 'enviar_dtmf'], 'la repetida no se ejecuta; la ajena tampoco');
  const respuestas = srv.ultima().recibido.slice(1);
  assert.deepEqual(respuestas.filter((m) => m.type === 'ack'), [{ type: 'ack', id: 'o1' }]);
  assert.ok(respuestas.some((m) => m.type === 'orden_fallida' && m.ordenId === 'o2' && m.detalle === 'el portero no responde'));
  assert.ok(respuestas.some((m) => m.type === 'orden_fallida' && m.ordenId === 'o3' && /otra llamada/.test(m.detalle)));
  assert.ok(respuestas.some((m) => m.type === 'orden_fallida' && m.ordenId === 'o4' && /orden desconocida/.test(m.detalle)));
  assert.ok(respuestas.every((m) => m.seq === undefined), 'las respuestas a órdenes no se numeran');
  assert.ok(r.logs.some((l) => /se descarta un mensaje no permitido \(session.update\)/.test(l)));
});

test('relay: se corta, se reabre enseguida como reanudación, y reenvía desde lo que pide el backend', async (t) => {
  const srv = await backendRelay();
  t.after(() => srv.cerrar());
  const r = relayCon(srv);
  t.after(() => r.relay.cerrar());
  r.relay.iniciar();
  await hasta(() => srv.conexiones.length === 1 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1' });
  for (let i = 1; i <= 3; i++) r.relay.mandar(evento(i));
  await hasta(() => srv.ultima().recibido.length === 4);
  srv.cortar();
  await hasta(() => srv.conexiones.length === 2 && srv.ultima().recibido.length === 1);
  assert.deepEqual(srv.ultima().recibido[0], { ...AVISO, reanudar: true, ultimoSeq: 3 });
  /* Lo que pasa mientras espera la confirmación se numera y se guarda. */
  assert.equal(r.relay.mandar(evento(4)), false);
  r.relay.mandar({ type: 'colgo', pbxCallId: 'c1' });
  await esperar(50);
  assert.equal(srv.ultima().recibido.length, 1, 'hasta la confirmación no sale nada más');
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1', desde: 3 });
  await hasta(() => srv.ultima().recibido.length === 4);
  assert.deepEqual(srv.ultima().recibido.slice(1).map((m) => m.seq), [3, 4, 5]);
  assert.equal(r.confirmado, 1, 'alConfirmado solo la primera vez');
  assert.ok(r.logs.some((l) => /retomó la llamada \(desde el 3\)/.test(l)));
  assert.equal(r.relay.mandar(evento(6)), true);
});

test('relay: con «reubicar» (4001) reabre sin esperar; con otro corte, reintenta cada tanto', async (t) => {
  const srv = await backendRelay();
  t.after(() => srv.cerrar());
  const r = relayCon(srv, { reaperturaMs: 300 });
  t.after(() => r.relay.cerrar());
  r.relay.iniciar();
  await hasta(() => srv.conexiones.length === 1 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1' });
  await esperar(30);
  srv.cortar(iax.CODIGO_REUBICAR);
  await hasta(() => srv.conexiones.length === 2, 200);
  /* Segundo corte sin confirmar: el primero es enseguida, el siguiente espera. */
  srv.cortar();
  const antes = Date.now();
  await hasta(() => srv.conexiones.length === 3, 1000);
  assert.ok(Date.now() - antes >= 250, 'el segundo intento espera el intervalo');
});

test('relay: si no se puede reabrir en la ventana, se pierde (respaldo)', async (t) => {
  const srv = await backendRelay();
  t.after(() => srv.cerrar());
  const r = relayCon(srv, { ventanaMs: 300, reaperturaMs: 50 });
  t.after(() => r.relay.cerrar());
  r.relay.iniciar();
  await hasta(() => srv.conexiones.length === 1 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1' });
  await esperar(30);
  /* El backend acepta el socket pero nunca confirma la reanudación. */
  srv.cortar();
  await hasta(() => r.perdidas.length === 1, 1000);
  assert.match(r.perdidas[0], /no se pudo reabrir el relay en 300 ms/);
  assert.ok(r.relay.terminado);
});

test('relay: con la ventana en 0, un corte va directo al respaldo', async (t) => {
  const srv = await backendRelay();
  t.after(() => srv.cerrar());
  const r = relayCon(srv, { ventanaMs: 0 });
  r.relay.iniciar();
  await hasta(() => srv.conexiones.length === 1 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1' });
  await esperar(30);
  srv.cortar();
  await hasta(() => r.perdidas.length === 1);
  assert.match(r.perdidas[0], /ventana 0/);
});

test('relay: si el backend pide desde más atrás de lo guardado, manda lo que hay y lo dice', async (t) => {
  const srv = await backendRelay();
  t.after(() => srv.cerrar());
  const r = relayCon(srv, { tope: 2 });
  t.after(() => r.relay.cerrar());
  r.relay.iniciar();
  await hasta(() => srv.conexiones.length === 1 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1' });
  for (let i = 1; i <= 4; i++) r.relay.mandar(evento(i));
  await hasta(() => srv.ultima().recibido.length === 5);
  srv.cortar();
  await hasta(() => srv.conexiones.length === 2 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1', desde: 1 });
  await hasta(() => srv.ultima().recibido.length === 3);
  assert.deepEqual(srv.ultima().recibido.slice(1).map((m) => m.seq), [3, 4]);
  assert.ok(r.logs.some((l) => /pide desde el 1 y lo más viejo guardado es el 3/.test(l)));
});

test('relay: un rechazo al empezar va al respaldo; al reanudar, se pierde la llamada', async (t) => {
  const srv = await backendRelay();
  t.after(() => srv.cerrar());
  const r = relayCon(srv);
  r.relay.iniciar();
  await hasta(() => srv.conexiones.length === 1 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_rechazado', pbxCallId: 'c1', motivo: 'tope de llamadas' });
  await hasta(() => r.rechazos.length === 1);
  assert.deepEqual(r.rechazos, ['tope de llamadas']);
  assert.ok(r.relay.terminado);

  const r2 = relayCon(srv);
  r2.relay.iniciar();
  await hasta(() => srv.conexiones.length === 2 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1' });
  await esperar(30);
  srv.cortar();
  await hasta(() => srv.conexiones.length === 3 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_rechazado', pbxCallId: 'c1', motivo: 'sin rastro' });
  await hasta(() => r2.perdidas.length === 1);
  assert.match(r2.perdidas[0], /rechazó la reanudación: sin rastro/);
});

test('relay: si el backend no está, reintenta abrir sin decir que es una reanudación', async (t) => {
  const srv = await backendRelay();
  const url = srv.url;
  await srv.cerrar();
  let intentos = 0;
  const r = new iax.RelayLlamada({
    abrir: () => { intentos++; return new WebSocket(url + '/api/pbx/llamadas/c1/relay'); },
    aviso: AVISO, reaperturaMs: 50, log: () => {},
  });
  t.after(() => r.cerrar());
  r.iniciar();
  await hasta(() => intentos >= 3, 2000);
  assert.equal(r.avisoMandado, false);
  /* Un `abrir` que tira también se reintenta. */
  let tiro = 0;
  const r2 = new iax.RelayLlamada({ abrir: () => { tiro++; throw new Error('URL rota'); }, aviso: AVISO, reaperturaMs: 20, log: () => {} });
  t.after(() => r2.cerrar());
  r2.iniciar();
  await hasta(() => tiro >= 2);
});

test('relay: al cerrar no se reabre, y lo último sale antes de cerrar el socket', async (t) => {
  const srv = await backendRelay();
  t.after(() => srv.cerrar());
  const r = relayCon(srv);
  r.relay.iniciar();
  await hasta(() => srv.conexiones.length === 1 && srv.ultima().recibido.length === 1);
  srv.mandar({ type: 'enganche_confirmado', pbxCallId: 'c1' });
  await esperar(30);
  r.relay.cerrar();
  r.relay.cerrar();
  assert.equal(r.relay.mandar({ type: 'colgo', pbxCallId: 'c1' }), true, 'el hecho final sale en el instante antes de cerrar');
  await esperar(400);
  assert.deepEqual(tipos(srv.ultima()), ['llamada_nueva', 'colgo']);
  assert.equal(srv.conexiones.length, 1, 'no se reabre');
  assert.equal(r.relay.mandar(evento(9)), false);
  /* Cerrar uno que nunca abrió no falla. */
  new iax.RelayLlamada({ abrir: () => null, aviso: AVISO }).cerrar();
});

/* ── Hechos por HTTP, con el relay cerrado ───────────────────────────────────── */
test('enviarHecho: POST con el token a /api/pbx/llamadas/:id/hechos; 4xx no se reintenta, 5xx y la red sí', async () => {
  const pedidos = [];
  const respuestas = (lista) => async (url, opts) => {
    pedidos.push({ url, opts });
    const r = lista.shift();
    if (r instanceof Error) throw r;
    return new Response(null, { status: r });
  };
  const hecho = { type: 'transferencia', pbxCallId: 'c 1', ok: true, detalle: null };
  assert.deepEqual(await iax.enviarHecho({ url: 'http://b/', token: 't0k', hecho, fetchImpl: respuestas([200]), esperaMs: 0 }), { ok: true, motivo: '' });
  assert.equal(pedidos[0].url, 'http://b/api/pbx/llamadas/c%201/hechos');
  assert.equal(pedidos[0].opts.method, 'POST');
  assert.equal(pedidos[0].opts.headers.Authorization, 'Bearer t0k');
  assert.deepEqual(JSON.parse(pedidos[0].opts.body), hecho);

  pedidos.length = 0;
  assert.deepEqual(await iax.enviarHecho({ url: 'http://b', token: 't', hecho, fetchImpl: respuestas([404]), esperaMs: 0 }), { ok: false, motivo: 'el backend contestó 404' });
  assert.equal(pedidos.length, 1);

  pedidos.length = 0;
  assert.deepEqual(await iax.enviarHecho({ url: 'http://b', token: 't', hecho, fetchImpl: respuestas([502, new Error('ECONNREFUSED'), 200]), esperaMs: 0 }), { ok: true, motivo: '' });
  assert.equal(pedidos.length, 3);

  pedidos.length = 0;
  const r = await iax.enviarHecho({ url: 'http://b', token: 't', hecho, fetchImpl: respuestas([503, 503, 503]), esperaMs: 0 });
  assert.deepEqual(r, { ok: false, motivo: 'el backend contestó 503' });
  assert.equal(pedidos.length, 3);
});

test('crear: abre el relay de la llamada con el token, y manda los hechos por HTTP', async () => {
  const pedidos = [];
  const abiertos = [];
  function WSFalso(url, opts) { abiertos.push({ url, opts }); }
  const m = iax.crear({
    agentes: async () => [], leerConfig: async () => null, guardarConfig: async () => {},
    WebSocketImpl: WSFalso,
    fetchImpl: async (url) => { pedidos.push(url); return new Response(null, { status: 200 }); },
  });
  const agente = { externo_url: 'https://asistente.example.com/', externo_token: 't0k' };
  m.abrirRelay(agente, 'c/1');
  assert.deepEqual(abiertos[0], { url: 'wss://asistente.example.com/api/pbx/llamadas/c%2F1/relay', opts: { headers: { Authorization: 'Bearer t0k' } } });
  assert.deepEqual(await m.enviarHecho(agente, { type: 'colgo', pbxCallId: 'c1' }), { ok: true, motivo: '' });
  assert.equal(pedidos[0], 'https://asistente.example.com/api/pbx/llamadas/c1/hechos');
});

/* ── El pipeline: por dónde sale cada hecho y qué hace el cierre ─────────────── */
function sesionExterna({ relay, logs }) {
  return {
    uuid: 'c1', modo: 'externo', agent: { id: 9, default_exten: '1001', externo_url: 'http://b', externo_token: 't' },
    channel: { id: 'canal-1', removeListener: () => {} }, relay, rt: { cerrar: () => {} }, closed: false,
    log: (m) => logs.push(m),
  };
}
function relayFalso({ vivo = true, terminado = false } = {}) {
  return { mandados: [], cerrado: null, terminado, mandar(m) { this.mandados.push(m.type); return vivo; }, cerrar(c, m) { this.cerrado = [c, m]; } };
}

test('pipeline: un hecho va por el relay; con el relay cortado queda guardado; uno final, si no sale, va por HTTP', async () => {
  const pipe = require('../ai-pipeline');
  const http = [];
  pipe._setIax({ enviarHecho: async (_a, h) => { http.push(h.type); return h.type === 'colgo' ? { ok: false, motivo: 'el backend contestó 503' } : { ok: true }; } });
  const logs = [];
  const vivo = relayFalso();
  assert.equal(pipe._avisarBackend(sesionExterna({ relay: vivo, logs }), { type: 'dtmf', pbxCallId: 'c1', digito: '5' }), true);
  const cortado = relayFalso({ vivo: false });
  assert.equal(pipe._avisarBackend(sesionExterna({ relay: cortado, logs }), { type: 'dtmf', pbxCallId: 'c1', digito: '5' }), true, 'sale al reabrir');
  assert.deepEqual(http, []);
  assert.equal(pipe._avisarBackend(sesionExterna({ relay: cortado, logs }), { type: 'transferencia', pbxCallId: 'c1', ok: true, detalle: null }, { final: true }), false);
  assert.equal(pipe._avisarBackend(sesionExterna({ relay: null, logs }), { type: 'colgo', pbxCallId: 'c1' }), false);
  await esperar(10);
  assert.deepEqual(http, ['transferencia', 'colgo']);
  assert.ok(logs.some((l) => /el hecho colgo no llegó al backend \(el backend contestó 503\)/.test(l)), logs.join(' | '));
  pipe._setIax({ enviarHecho: async () => { throw new Error('sin red'); } });
  pipe._avisarBackend(sesionExterna({ relay: relayFalso({ vivo: false, terminado: true }), logs }), { type: 'dtmf', pbxCallId: 'c1', digito: '1' });
  await esperar(10);
  assert.ok(logs.some((l) => /el hecho dtmf no llegó al backend \(sin red\)/.test(l)));
  pipe._setIax(null);
  assert.equal(pipe._avisarBackend(sesionExterna({ relay: null, logs }), { type: 'colgo', pbxCallId: 'c1' }), false, 'sin IA externa armada, no hace nada');
});

test('pipeline: al cerrar, avisa «colgó» si no fue una orden del backend, y cierra el relay sin reabrirlo', () => {
  const pipe = require('../ai-pipeline');
  pipe._setIax({ enviarHecho: async () => ({ ok: true }) });
  const logs = [];
  const relay = relayFalso();
  const sesion = sesionExterna({ relay, logs });
  pipe._cerrarExterno(sesion, 'caller-hangup');
  pipe._cerrarExterno(sesion, 'caller-hangup');
  assert.deepEqual(relay.mandados, ['colgo']);
  assert.deepEqual(relay.cerrado, [1000, 'fin de la llamada']);
  const porOrden = relayFalso();
  pipe._cerrarExterno(sesionExterna({ relay: porOrden, logs }), 'orden del backend');
  assert.deepEqual(porOrden.mandados, [], 'si lo ordenó el backend, no hace falta avisarle');
  pipe._setIax(null);
});

test('pipeline: la espera de la orden es solo por la sesión de voz cerrada, y una sola', async () => {
  const pipe = require('../ai-pipeline');
  const logs = [];
  const sesion = sesionExterna({ relay: relayFalso(), logs });
  pipe._esperarOrden(sesion, 'se cerró la sesión sin orden del backend');
  const primera = sesion.esperaOrden;
  pipe._esperarOrden(sesion, 'otra vez');
  assert.equal(sesion.esperaOrden, primera);
  clearTimeout(sesion.esperaOrden);
  sesion.closed = true;
  const cerrada = sesionExterna({ relay: relayFalso(), logs });
  cerrada.closed = true;
  pipe._esperarOrden(cerrada, 'x');
  assert.equal(cerrada.esperaOrden, undefined);
});

