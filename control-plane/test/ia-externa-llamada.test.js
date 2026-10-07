/* ============================================================================
 *  Una llamada entera con IA externa (contrato v2), de punta a punta.
 *
 *  Las pruebas de ia-externa*.test.js miran las piezas sueltas. Acá corren juntas: el
 *  pipeline atiende, abre la sesión de GPT-Live con la configuración que bajó del
 *  backend, abre el relay de la llamada, el backend la toma (`enganche_confirmado`) y
 *  manda órdenes que la central ejecuta sobre el canal: DTMF, transferir, colgar. Y los
 *  caminos malos: el backend que no confirma, el que rechaza, el destino no permitido y
 *  quien cuelga en el medio.
 *
 *  El backend es un servidor local (HTTP para la configuración y los hechos, WebSocket
 *  para el canal de control y el relay de cada llamada); GPT-Live es otro WebSocket local;
 *  Asterisk es helpers/llamada-ia.js.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { WebSocketServer } = require('ws');
const { hasta, dormir, puertoLibre, asteriskFalso, canal, hablar } = require('./helpers/llamada-ia');

/* ── El backend del asistente ─────────────────────────────────────────────── */
async function backendFalso() {
  const b = { relays: [], hechos: [], modo: 'confirmar', configPedidos: 0 };
  const srv = http.createServer((req, res) => {
    let cuerpo = ''; req.on('data', (d) => { cuerpo += d; });
    req.on('end', () => {
      if (req.url === '/api/pbx/session-config') {
        b.configPedidos++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ version: 'v7', session: { model: 'gpt-live-1', instructions: 'Sos el portero' }, attachTimeoutMs: 1000, resumeWindowMs: 0 }));
      }
      const m = /^\/api\/pbx\/llamadas\/([^/]+)\/hechos$/.exec(req.url);
      if (m) { b.hechos.push(JSON.parse(cuerpo)); res.writeHead(200); return res.end('{}'); }
      res.writeHead(404); res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, sock, head) => {
    wss.handleUpgrade(req, sock, head, (ws) => {
      if (req.url === '/api/pbx/canal') { ws.on('message', () => {}); return; }
      const m = /^\/api\/pbx\/llamadas\/([^/]+)\/relay$/.exec(req.url);
      if (!m) return ws.close();
      const relay = { id: m[1], ws, recibidos: [] };
      b.relays.push(relay);
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d));
        relay.recibidos.push(msg);
        if (msg.type === 'llamada_nueva') {
          if (b.modo === 'confirmar') ws.send(JSON.stringify({ type: 'enganche_confirmado' }));
          else if (b.modo === 'rechazar') ws.send(JSON.stringify({ type: 'enganche_rechazado', motivo: 'sin cupo' }));
        }
      });
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  b.url = 'http://127.0.0.1:' + srv.address().port;
  b.ordenar = (relay, orden) => relay.ws.send(JSON.stringify(Object.assign({ pbxCallId: relay.id }, orden)));
  b.cerrar = () => new Promise((ok) => { for (const c of wss.clients) c.terminate(); srv.closeAllConnections?.(); srv.close(ok); });
  return b;
}

/* ── GPT-Live de mentira: arranca la sesión y manda un poco de audio. ─────── */
async function liveFalso() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((ok) => wss.once('listening', ok));
  const l = { recibido: [] };
  wss.on('connection', (ws) => {
    l.ws = ws;
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d));
      l.recibido.push(msg);
      if (msg.type === 'session.start') {
        ws.send(JSON.stringify({ type: 'session.started' }));
        ws.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(960, 2).toString('base64') }));
      }
    });
  });
  l.url = 'ws://127.0.0.1:' + wss.address().port;
  l.cerrar = () => new Promise((ok) => { for (const c of wss.clients) c.terminate(); wss.close(ok); });
  return l;
}

let pipe, backend, live, AGENTE;
const ajustes = new Map();
const pool = {
  async query(sql, args) {
    if (/SELECT value FROM pbxng_settings WHERE key=\$1/.test(sql)) return { rows: ajustes.has(args[0]) ? [{ value: ajustes.get(args[0]) }] : [] };
    if (/FROM pbxng_ai_agents/.test(sql)) return { rows: [AGENTE] };
    if (/FROM pbxng_ia_externa_config/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 1 };
  },
};

test.before(async () => {
  process.env.AUDIOSOCKET_PORT = String(await puertoLibre());
  pipe = require('../ai-pipeline');
  backend = await backendFalso();
  live = await liveFalso();
  AGENTE = { id: 21, name: 'Portería', provider: 'ia-externa', enabled: true, externo_url: backend.url, externo_token: 'tok', exten: '8150',
    default_exten: '2030', agentes_exten: '2040', herramientas: { abrir_porton: { on: true, modo: 'dtmf', dtmf: '#9' } } };
  ajustes.set('openai_api_key', 'sk-x');
  ajustes.set('realtime_url', live.url);
});
test.after(async () => { try { await pipe.close(); } catch (_) {} await backend.cerrar(); await live.cerrar(); });

/* Arranca el canal de control y espera a que la configuración esté bajada. El backend la
 * manda refrescar al conectarse; acá se la pide la propia recarga (agente nuevo). */
async function preparar() {
  const ari = asteriskFalso();
  pipe.init(ari, pool, { mediaHost: '127.0.0.1' });
  pipe.recargarIaExterna();
  return ari;
}
async function llamada(ari) {
  const ch = canal('099555666');
  ch.getChannelVar = async () => ({ value: 'linked-' + ch.id });
  await pipe.startAiSession(ch, Object.assign({}, AGENTE));
  const relay = await hasta(() => backend.relays.find((r) => r.recibidos.some((m) => m.type === 'llamada_nueva') && !r.usado), 6000);
  if (relay) relay.usado = true;
  return { ch, relay, m: ari.medios.at(-1) };
}

test('la llamada se atiende con la configuración bajada y el backend la toma', async () => {
  const ari = await preparar();
  /* Sin la configuración bajada la llamada va al respaldo sin abrir sesión. */
  const sin = canal();
  await pipe.startAiSession(sin, Object.assign({}, AGENTE, { id: 999 }));
  assert.deepEqual(sin.derivado && sin.derivado.extension, '2030');
  await hasta(() => backend.configPedidos > 0, 5000);
  await dormir(200);
  const { ch, relay, m } = await llamada(ari);
  assert.ok(relay, 'el relay de la llamada no se abrió');
  const aviso = relay.recibidos.find((x) => x.type === 'llamada_nueva');
  assert.equal(aviso.from, '099555666');
  assert.equal(aviso.configVersion, 'v7');
  assert.equal(aviso.dtmfApertura, '#9');
  assert.equal(aviso.destinoAgentes, '2040');
  assert.equal(live.recibido[0].type, 'session.start');
  assert.equal(live.recibido[0].session.instructions, 'Sos el portero', 'la sesión se abre tal cual la manda el backend');
  hablar(m, 5);
  assert.ok(await hasta(() => relay.recibidos.some((x) => x.type === 'session.output_audio.delta' || x.seq > 1)), 'los eventos de la sesión no llegan al backend');

  /* Órdenes: DTMF, uno inválido, una repetida, un destino no permitido, y la transferencia. */
  backend.ordenar(relay, { type: 'enviar_dtmf', id: 'o1', digitos: '#9' });
  assert.ok(await hasta(() => relay.recibidos.some((x) => x.type === 'ack' && x.id === 'o1')));
  assert.equal(ari.dtmf[0].dtmf, '#9');
  backend.ordenar(relay, { type: 'enviar_dtmf', id: 'o2', digitos: 'nope' });
  assert.ok(await hasta(() => relay.recibidos.some((x) => x.type === 'orden_fallida' && x.ordenId === 'o2')));
  backend.ordenar(relay, { type: 'enviar_dtmf', id: 'o1', digitos: '#9' });
  await dormir(150);
  assert.equal(ari.dtmf.length, 1, 'una orden repetida por id no se ejecuta dos veces');
  backend.ordenar(relay, { type: 'transferir', id: 'o3', destino: '099000000' });
  assert.ok(await hasta(() => relay.recibidos.some((x) => x.type === 'orden_fallida' && x.ordenId === 'o3' && /no permitido/.test(x.detalle))), 'transferir a cualquier número sería fraude');
  backend.ordenar(relay, { type: 'session.instructions.append', text: 'extra' });
  backend.ordenar(relay, { type: 'cosa_rara', id: 'o9' });
  backend.ordenar(relay, { type: 'transferir', id: 'o4', destino: '2040' });
  assert.ok(await hasta(() => ch.derivado, 6000), 'no transfirió');
  assert.equal(ch.derivado.extension, '2040');
  assert.equal(ch.vars.DIAL_OPCIONES, 'r');
  /* Quién atendió la derivación: le llega al backend por HTTP. */
  pipe.alAtender('linked-' + ch.id, '', '2041');
  /* Llega por el relay si todavía no terminó de cerrarse, o por HTTP: las dos vías son del contrato. */
  const atendio = (h) => h.type === 'atendio' && h.interno === '2041';
  assert.ok(await hasta(() => backend.hechos.find(atendio) || relay.recibidos.find(atendio), 5000), 'el backend no se enteró de quién atendió');
  assert.ok(relay.recibidos.some((x) => x.type === 'transferencia' && x.ok === true) || backend.hechos.some((h) => h.type === 'transferencia' && h.ok), 'el resultado de la transferencia');
});

test('si el backend rechaza o no confirma, la llamada va al respaldo', async () => {
  const ari = await preparar();
  backend.modo = 'rechazar';
  const a = await llamada(ari);
  assert.ok(await hasta(() => a.ch.derivado, 5000), 'rechazada: tiene que ir al respaldo');
  assert.equal(a.ch.derivado.extension, '2030');
  backend.modo = 'callar';
  const b = await llamada(ari);
  assert.ok(await hasta(() => b.ch.derivado, 6000), 'sin confirmación: respaldo al vencer la espera');
  backend.modo = 'confirmar';
});

test('el backend cuelga, y quien llama cuelga en el medio (se le avisa al backend)', async () => {
  const ari = await preparar();
  const a = await llamada(ari);
  await dormir(200);
  backend.ordenar(a.relay, { type: 'colgar', id: 'c1' });
  assert.ok(await hasta(() => a.ch.colgado, 6000), 'no colgó');
  const b = await llamada(ari);
  await dormir(200);
  b.ch.emit('ChannelDtmfReceived', { digit: '5' });
  assert.ok(await hasta(() => b.relay.recibidos.some((x) => x.type === 'dtmf' && x.digito === '5')), 'lo que marca el visitante le llega al backend');
  b.ch.emit('StasisEnd');
  assert.ok(await hasta(() => b.relay.recibidos.some((x) => x.type === 'colgo') || backend.hechos.some((h) => h.type === 'colgo')), 'el backend no se enteró del corte');
});

test('si la sesión de voz se cierra sin orden, se espera y después respaldo', async () => {
  const ari = await preparar();
  const a = await llamada(ari);
  await dormir(200);
  live.ws.close(1011, 'error');
  assert.ok(await hasta(() => a.relay.recibidos.some((x) => x.type === 'session.closed')), 'el backend tiene que saber que la sesión se cortó');
  assert.ok(await hasta(() => a.ch.derivado, 8000), 'sin orden del backend, respaldo');
});
