/* ============================================================================
 *  Puente al modelo de voz realtime (realtime.js) — fase 0 del agente IA.
 *
 *  Contra qué se prueba: un servidor WebSocket FALSO que habla la forma del protocolo. No
 *  se le pega al proveedor de verdad —no tendría sentido: costaría plata, necesitaría una
 *  clave y fallaría los días que ellos tengan un problema—, pero sí se ejercita todo lo
 *  que es NUESTRO y es donde están los errores caros:
 *
 *   · el remuestreo 8 kHz ↔ 24 kHz. Un factor equivocado no «falla»: suena a dibujito o a
 *     cámara lenta, y eso se descubre en la primera llamada real delante del cliente;
 *   · el barge-in, que tiene que hacer DOS cosas (tirar lo que queda por reproducir y
 *     pedirle al modelo que pare) — si hace sólo una, o el llamante sigue escuchando la
 *     frase vieja, o el modelo sigue hablando solo y facturando;
 *   · la medición de latencia, que es el número que decide si el proyecto es viable.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const rt = require('../realtime');

/* Un tono de 8 kHz, para poder comprobar que después de subir y bajar sigue siendo el
 * mismo tono (y no uno tres veces más agudo o más grave). */
function tono(hz, ms, rate) {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return b;
}
/* Cruces por cero: una forma barata y robusta de estimar la frecuencia sin FFT. */
function frecuencia(buf, rate) {
  let cruces = 0;
  for (let i = 1; i < (buf.length >> 1); i++) {
    const a = buf.readInt16LE((i - 1) * 2), b = buf.readInt16LE(i * 2);
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) cruces++;
  }
  const seg = (buf.length >> 1) / rate;
  return cruces / 2 / seg;
}

test('el remuestreo conserva la voz: 8k → 24k → 8k sigue siendo el mismo tono', () => {
  const orig = tono(440, 500, 8000);
  const arriba = rt.subir(orig);
  assert.equal(arriba.length, orig.length * 3, 'subir tiene que dar exactamente el triple de muestras');
  assert.ok(Math.abs(frecuencia(arriba, 24000) - 440) < 15, 'al subir cambió la frecuencia: la voz saldría acelerada o lenta');

  const bajar = rt.creaBajador();
  const vuelta = bajar(arriba);
  assert.ok(Math.abs(vuelta.length - orig.length) <= 6, 'al bajar no volvió la misma cantidad de muestras');
  assert.ok(Math.abs(frecuencia(vuelta, 8000) - 440) < 15, 'la ida y vuelta corrió la frecuencia');
});

test('el bajador no pierde muestras entre frames (el resto se arrastra)', () => {
  /* Frames que NO caen en múltiplos de 3 muestras: es el caso real, y perder una por
   * frame cincuenta veces por segundo es un chasquido audible. */
  const bajar = rt.creaBajador();
  let total = 0;
  for (let i = 0; i < 10; i++) total += bajar(Buffer.alloc(50 * 2)).length >> 1;   // 50 muestras de 24k por vuelta
  assert.equal(total, Math.floor((10 * 50) / 3), 'se perdieron o se inventaron muestras al bajar de 24k a 8k');
});

/* ── Puente completo contra un servidor falso ──────────────────────────────── */
async function servidorFalso() {
  const recibido = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((ok) => wss.once('listening', ok));   // sin esto, address() todavía es null
  let cliente = null;
  wss.on('connection', (ws) => {
    cliente = ws;
    ws.on('message', (d) => { try { recibido.push(JSON.parse(String(d))); } catch (_) {} });
  });
  return {
    recibido,
    url: () => 'ws://127.0.0.1:' + wss.address().port,
    mandar: (o) => cliente && cliente.send(JSON.stringify(o)),
    tipos: () => recibido.map((r) => r.type),
    /* Se rompen las conexiones vivas antes de cerrar: `wss.close()` espera a que los
     * clientes se vayan solos, y con uno abierto el `after` de la prueba no vuelve nunca
     * (así se colgaba este archivo entero). */
    cerrar: () => new Promise((ok) => { for (const c of wss.clients) { try { c.terminate(); } catch (_) {} } wss.close(ok); }),
  };
}
const esperarEvento = (ev, nombre, ms = 3000) => new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error('no llegó el evento ' + nombre)), ms);
  ev.once(nombre, (x) => { clearTimeout(t); ok(x); });
});

test('el puente configura la sesión, traduce el audio y mide la latencia', async (t) => {
  const srv = await servidorFalso();
  t.after(() => srv.cerrar());
  const p = rt.abrir({ url: srv.url(), voz: 'alloy', instrucciones: 'sos el portero', model: 'x' });
  t.after(() => p.cerrar());

  await p.cuandoListo(5000);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(srv.tipos().includes('session.update'), 'no mandó la configuración de sesión al abrir');
  const cfg = srv.recibido.find((r) => r.type === 'session.update');
  assert.equal(cfg.session.voice, 'alloy');
  assert.equal(cfg.session.input_audio_format, 'pcm16');
  assert.match(String(cfg.session.instructions), /portero/);

  // El audio del canal (8k) sale al modelo en 24k y en base64.
  p.enviarAudio(tono(300, 20, 8000));
  await new Promise((r) => setTimeout(r, 50));
  const ap = srv.recibido.find((r) => r.type === 'input_audio_buffer.append');
  assert.ok(ap, 'no mandó el audio del llamante');
  assert.equal(Buffer.from(ap.audio, 'base64').length, 160 * 2 * 3, '20 ms de 8 kHz tienen que salir como 20 ms de 24 kHz');

  // Y el audio del modelo vuelve a 8k, listo para el canal.
  srv.mandar({ type: 'input_audio_buffer.speech_started' });
  await esperarEvento(p, 'corte');
  await new Promise((r) => setTimeout(r, 30));
  srv.mandar({ type: 'response.audio.delta', delta: tono(440, 60, 24000).toString('base64') });
  const pcm = await esperarEvento(p, 'audio');
  assert.equal(pcm.length, 8000 * 0.06 * 2, 'el audio del modelo no llegó a 8 kHz: el canal lo reproduciría acelerado');

  const met = p.metricas();
  assert.equal(met.turnos, 1);
  assert.ok(met.ultimo_ms >= 0 && met.ultimo_ms < 3000, 'la latencia medida no tiene sentido: ' + met.ultimo_ms);
});

test('barge-in: avisa para tirar la cola Y le pide al modelo que pare', async (t) => {
  const srv = await servidorFalso();
  t.after(() => srv.cerrar());
  const p = rt.abrir({ url: srv.url(), model: 'x' });
  t.after(() => p.cerrar());
  await p.cuandoListo(5000);

  srv.mandar({ type: 'input_audio_buffer.speech_started' });
  await esperarEvento(p, 'corte');       // 1) el que reproduce tiene que enterarse
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(srv.tipos().includes('response.cancel'),
    '2) no le pidió al modelo que deje de generar: sigue hablando solo y facturando');
});

test('las herramientas se avisan y la respuesta vuelve con su call_id', async (t) => {
  const srv = await servidorFalso();
  t.after(() => srv.cerrar());
  const p = rt.abrir({ url: srv.url(), model: 'x', herramientas: [{ type: 'function', name: 'buscar_cliente' }] });
  t.after(() => p.cerrar());
  await p.cuandoListo(5000);

  srv.mandar({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'buscar_cliente', arguments: '{"unidad":"402"}' });
  const h = await esperarEvento(p, 'herramienta');
  assert.equal(h.nombre, 'buscar_cliente');
  assert.equal(JSON.parse(h.args).unidad, '402');

  p.responderHerramienta('c1', { encontrado: true, titular: 'Pérez' });
  await new Promise((r) => setTimeout(r, 60));
  const out = srv.recibido.find((r) => r.type === 'conversation.item.create');
  assert.ok(out, 'no devolvió el resultado de la herramienta');
  assert.equal(out.item.call_id, 'c1');
  assert.match(String(out.item.output), /Pérez/);
  assert.ok(srv.tipos().includes('response.create'), 'después de contestar la herramienta hay que pedirle al modelo que siga');
});

test('un error del proveedor se avisa, no se traga', async (t) => {
  const srv = await servidorFalso();
  t.after(() => srv.cerrar());
  const p = rt.abrir({ url: srv.url(), model: 'x' });
  t.after(() => p.cerrar());
  await p.cuandoListo(5000);
  srv.mandar({ type: 'error', error: { message: 'cuota agotada' } });
  const msg = await esperarEvento(p, 'error');
  assert.match(String(msg), /cuota agotada/);
});

/* ── «¿Estamos listos para llamar?» ───────────────────────────────────────────
 * Estas dos pruebas cuidan la ruta del panel (`POST /api/ai-agents/probar`). Lo que se
 * está protegiendo no es el código: es el DIAGNÓSTICO. Sin esto, los tres motivos por los
 * que un agente atiende y no habla —la clave, el identificador del modelo y la voz— se
 * veían todos igual: silencio en la llamada y ningún error, porque el pipeline degrada a
 * propósito en vez de cortar. */
test('probar(): si el modelo habla, dice cuánto tardó en hablar', async (t) => {
  const srv = await servidorFalso();
  t.after(() => srv.cerrar());
  /* El servidor falso contesta con audio en cuanto le piden una respuesta. */
  const wsAlta = new Promise((ok) => {
    const i = setInterval(() => {
      if (srv.recibido.some((r) => r.type === 'response.create')) {
        clearInterval(i);
        srv.mandar({ type: 'response.audio_transcript.delta', delta: 'listo' });
        srv.mandar({ type: 'response.audio.delta', delta: tono(300, 60, 24000).toString('base64') });
        ok();
      }
    }, 10);
    t.after(() => clearInterval(i));
  });

  const r = await rt.probar({ url: srv.url(), model: 'x', voz: 'marin', topeAudio: 5000, colaMs: 100 });
  await wsAlta;
  assert.equal(r.ok, true, 'la prueba falló: ' + r.error);
  assert.ok(r.abrio_ms !== null && r.abrio_ms < 5000);
  assert.ok(r.primer_audio_ms !== null, 'no midió cuánto tarda en empezar a hablar: es el silencio que escucha el visitante');
  assert.ok(r.bytes_audio > 0);
  assert.match(r.texto, /listo/);
});

test('probar(): si el modelo no existe, lo dice y dice dónde se arregla', async (t) => {
  /* Un `ws` contra un endpoint que no da el 101 emite «Unexpected server response: 404» y
   * nada más — inútil para quien mira el panel. Acá se comprueba que se lee el CUERPO de
   * la respuesta, que es donde el proveedor explica qué está mal. */
  const http = require('node:http');
  const srv = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'The model `gpt-live-1` does not exist' } }));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => srv.close(ok)));

  const r = await rt.probar({ url: 'ws://127.0.0.1:' + srv.address().port, model: 'gpt-live-1', voz: 'marin', topeAbrir: 4000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /404/);
  assert.match(r.error, /gpt-live-1/, 'no nombró el modelo: el que lee el panel no sabe qué corregir');
  assert.match(r.error, /campo|agente/i, 'no dice dónde se arregla');
});

test('explicar(): una clave rechazada no se confunde con un modelo inexistente', () => {
  assert.match(rt.explicar(401, '', 'm'), /clave/i);
  assert.doesNotMatch(rt.explicar(401, '', 'm'), /no existe/i);
  assert.match(rt.explicar(404, '', 'm'), /no existe/i);
  assert.match(rt.explicar(429, '', 'm'), /cupo|saldo/i);
  assert.match(rt.explicar(503, '', 'm'), /proveedor/i);
});
