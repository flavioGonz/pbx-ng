'use strict';
// ============================================================
//  PBX-NG · Pipeline IVR conversacional (STT -> LLM -> TTS)
//  Transporte: ARI externalMedia con encapsulation=audiosocket (TCP).
//  Modo demo (sin API keys): Vosk (STT offline ES) + reglas (LLM) + espeak-ng (TTS).
//  Modo real: OpenAI Whisper + chat/completions(tools) + TTS, si hay key.
// ============================================================
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const log = require('./log')('AI');
const realtime = require('./realtime');
const iaExterna = require('./ia-externa');   // IA externa: el backend del asistente conduce la llamada
/* Los canales con el backend, la configuración bajada y las llamadas en curso de la IA
 * externa. Se arma en `init` (hace falta la base). */
let IAX = null;   // puente al modelo de voz realtime (audio in / audio out)
const momento = require('./momento');     // la hora del cliente: el modelo no tiene reloj
const inactividad = require('./inactividad');   // qué hacer cuando el visitante deja de hablar
const herramientas = require('./herramientas'); // lo que el agente puede PEDIR (la central decide)
const remotas = require('./herramientas-remotas');   // la caja que pone el backoffice del cliente
const porteria = require('./porteria');         // quién llama y quién está autorizado (CRM de la central)

const AS_PORT = 9092;                 // puerto AudioSocket (TCP)
const VOSK_MODEL = '/opt/vosk-model-es';
const RATE = 8000;                    // slin (8kHz telefonia) - el canal AudioSocket reproduce a 8k
const FRAME_BYTES = 320;              // 20ms @ 8kHz 16-bit
const BARGE_RMS = 600;                // umbral energia para barge-in
const BARGE_MS = 280;                 // ms de voz sostenida para cortar TTS
const SPEECH_RMS = 500;               // umbral de voz para VAD
const END_SILENCE_MS = 750;           // silencio que cierra una frase

/* ---------------------------------------------------------------------------
 *  TOPES DE RED, Y POR QUE EXISTEN
 *  ------------------------------
 *  Todo lo que hay en este archivo corre CON LA LLAMADA ABIERTA y con la persona
 *  esperando del otro lado. Un `fetch` sin tope no falla: se queda. Medido contra un
 *  servidor que acepta la conexion y no contesta nunca, `crmLookup()` tardaba 90 s en
 *  volver —el tope por defecto de undici— y en ese tiempo el llamante escucha silencio,
 *  cuelga, y el CDR anota una llamada atendida que nadie atendio.
 *
 *  El codigo YA TENIA escrita la frase de degradacion («No pude consultar el CRM en este
 *  momento»): lo unico que faltaba era llegar a ella. Por eso los topes son cortos y
 *  distintos segun lo que pasa si vencen:
 *    · CRM (2,5 s)  el asistente sigue hablando sin el dato. Es el mas corto: el dato es
 *                   un lujo, la llamada no.
 *    · STT (6 s)    sin transcripcion no hay turno; se pide repetir.
 *    · LLM (8 s)    idem, y encima es el unico que a veces tarda de verdad.
 *    · TTS (8 s)    si vence, abajo hay espeak-ng local que no depende de la red.
 *  `AbortSignal.timeout()` corta la conexion de verdad (no deja el socket colgado) y el
 *  `catch` de cada funcion ya devuelve el camino degradado que corresponde.
 * ------------------------------------------------------------------------ */
const TOPE_CRM_MS = 2500;
const TOPE_STT_MS = 6000;
const TOPE_LLM_MS = 8000;
const TOPE_TTS_MS = 8000;
/* Cuánto se le aguanta al modelo estar mudo después del saludo antes de cortar. No es un
 * capricho de diseño: con GPT-Live pasa que la sesión abre, acepta el saludo y no emite
 * una sola muestra —ningún error en ningún lado—, y del otro lado hay alguien parado
 * frente a un portero escuchando nada. Cortar es feo; dejarlo ahí es peor. */
const MUDO_MS = Number(process.env.AI_MUDO_MS || 25000);
/* `fetch` con tope. Se agrega `signal` sin pisar uno que venga del llamador. */
function fetchTope(url, opts, ms) {
  return fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(ms) }));
}

let ARI = null, POOL = null, APP = 'pbxng', MEDIA_HOST = process.env.MEDIA_HOST || '127.0.0.1';
const sessions = new Map();           // uuid -> session
const pendingByUuid = new Map();      // uuid -> session (antes de conectar AudioSocket)

// ---------- settings (API keys) ----------
async function getSetting(key) {
  try { const { rows } = await POOL.query('SELECT value FROM pbxng_settings WHERE key=$1', [key]); return rows[0] && rows[0].value || ''; }
  catch (_) { return ''; }
}

// ---------- util audio ----------
function rms(buf) {
  let sum = 0, n = buf.length >> 1;
  for (let i = 0; i < buf.length - 1; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
}
function uuidToBytes(u) { return Buffer.from(u.replace(/-/g, ''), 'hex'); }
function bytesToUuid(b) { const h = b.toString('hex'); return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-'); }

// ============================================================
//  Proveedores STT / LLM / TTS
// ============================================================
// --- TTS offline (espeak-ng -> sox -> slin16) ---
function espeakTTS(text, voice) {
  return new Promise((resolve) => {
    const v = (voice && /^es/i.test(voice)) ? 'es-419' : 'es-419';
    const esp = spawn('espeak-ng', ['-v', v, '-s', '150', '-p', '40', '--stdout', text]);
    const sox = spawn('sox', ['-t', 'wav', '-', '-t', 'raw', '-r', String(RATE), '-e', 'signed', '-b', '16', '-c', '1', '-']);
    const chunks = [];
    esp.stdout.pipe(sox.stdin);
    sox.stdout.on('data', d => chunks.push(d));
    sox.on('close', () => resolve(Buffer.concat(chunks)));
    esp.on('error', () => resolve(Buffer.alloc(0)));
    sox.on('error', () => resolve(Buffer.alloc(0)));
  });
}
// --- TTS OpenAI (24k -> sox -> slin16) ---
async function openaiTTS(text, voice, key) {
  try {
    const r = await fetchTope('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: voice && /^(alloy|echo|fable|onyx|nova|shimmer)$/.test(voice) ? voice : 'nova', input: text, response_format: 'wav' }),
    }, TOPE_TTS_MS);
    if (!r.ok) return null;
    const wav = Buffer.from(await r.arrayBuffer());
    return await new Promise((resolve) => {
      const sox = spawn('sox', ['-t', 'wav', '-', '-t', 'raw', '-r', String(RATE), '-e', 'signed', '-b', '16', '-c', '1', '-']);
      const out = []; sox.stdout.on('data', d => out.push(d)); sox.on('close', () => resolve(Buffer.concat(out))); sox.on('error', () => resolve(null));
      sox.stdin.end(wav);
    });
  } catch (_) { return null; }
}
// --- STT OpenAI Whisper (slin16 PCM -> wav -> texto) ---
async function whisperSTT(pcm, key) {
  try {
    const wav = pcmToWav(pcm, RATE);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
    form.append('model', 'whisper-1'); form.append('language', 'es');
    const r = await fetchTope('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key }, body: form }, TOPE_STT_MS);
    if (!r.ok) return '';
    const j = await r.json(); return (j.text || '').trim();
  } catch (_) { return ''; }
}
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]);
}
// --- Voz neural self-hosted (Piper TTS + faster-whisper STT) ---
async function neuralTTS(text, vozUrl, voice, speed) {
  try {
    const r = await fetchTope(vozUrl + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, rate: RATE, length_scale: parseFloat(speed) || 1.0 }) }, TOPE_TTS_MS);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length ? buf : null;
  } catch (_) { return null; }
}
async function neuralSTT(pcm, vozUrl) {
  try {
    const r = await fetchTope(vozUrl + '/stt?rate=' + RATE, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm }, TOPE_STT_MS);
    if (!r.ok) return '';
    const j = await r.json(); return (j.text || '').trim();
  } catch (_) { return ''; }
}
// --- LLM OpenAI chat con tools ---
async function openaiLLM(messages, tools, model, key) {
  const r = await fetchTope('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, tools, tool_choice: 'auto', temperature: 0.4 }),
  }, TOPE_LLM_MS);
  if (!r.ok) throw new Error('llm ' + r.status);
  const j = await r.json(); return j.choices[0].message;
}

// --- LLM modo demo (reglas) ---
function ruleLLM(text, session) {
  const t = (text || '').toLowerCase();
  const has = (...ws) => ws.some(w => t.includes(w));
  if (has('ventas', 'comercial', 'comprar', 'cotiz', 'precio')) return { text: 'Te comunico con el área comercial. Un momento por favor.', tool: { name: 'transfer_call', args: { destination: session.agent.sales_exten || '1001', label: 'Ventas' } } };
  if (has('soporte', 'técnico', 'tecnico', 'no funciona', 'problema', 'falla')) return { text: 'Te transfiero con soporte técnico. Aguardá un momento.', tool: { name: 'transfer_call', args: { destination: session.agent.support_exten || '1002', label: 'Soporte' } } };
  if (has('humano', 'persona', 'operador', 'ejecutivo', 'alguien', 'recepción', 'recepcion')) return { text: 'Claro, te paso con una persona.', tool: { name: 'transfer_call', args: { destination: session.agent.default_exten || '1001', label: 'Operador' } } };
  if (has('estado de cuenta', 'mi cuenta', 'factura', 'saldo', 'deuda')) return { text: '', tool: { name: 'crm_lookup', args: { query: text } } };
  if (has('hola', 'buenas', 'buenos días', 'buenas tardes')) return { text: '¡Hola! Soy el asistente virtual. Puedo ayudarte con ventas, soporte, o pasarte con una persona. ¿Qué necesitás?' };
  if (has('gracias', 'nada más', 'nada mas', 'chau', 'adiós', 'adios')) return { text: '¡Gracias por llamar! Que tengas un buen día.', end: true };
  if (session._turns >= 1) return { text: 'Entiendo. Puedo derivarte a ventas o soporte, o pasarte con una persona. ¿Qué preferís?' };
  return { text: 'Disculpá, no te entendí bien. ¿Querés hablar con ventas, con soporte, o con una persona?' };
}

// --- CRM webhook ---
async function crmLookup(query, session) {
  const url = session.agent.crm_webhook;
  if (!url) return 'No tengo el CRM configurado todavía, pero puedo pasarte con una persona si querés.';
  /* Dos cinturones a proposito. `AbortSignal` corta la conexion, que es lo correcto; la
   * carrera es el piso duro: cubre el caso en que el backoffice contesta los headers al
   * instante y despues gotea el cuerpo, donde el abort llega pero no manda nadie a
   * devolver una respuesta a tiempo. Vence el tope -> se sigue hablando sin el dato. */
  const degradado = 'No pude consultar el CRM en este momento.';
  const pedido = (async () => {
    const r = await fetchTope(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, caller: session.callerId, agent: session.agent.name }) }, TOPE_CRM_MS);
    const j = await r.json().catch(() => ({}));
    return (j.result || j.text || j.message || 'No encontré datos para esa consulta.');
  })();
  const reloj = new Promise((ok) => setTimeout(() => ok(degradado), TOPE_CRM_MS + 250).unref());
  try {
    return await Promise.race([pedido, reloj]);
  } catch (_) { return degradado; }
}

// ============================================================
//  Reproducción de TTS (con barge-in)
// ============================================================
async function speak(session, text) {
  if (!text || !session.socket || session.closed) return;
  session.log('TTS> ' + text);
  let pcm = null;
  if (session.useOpenAI && session.keys.openai) pcm = await openaiTTS(text, session.agent.voice, session.keys.openai);
  if ((!pcm || !pcm.length) && session.vozUrl) pcm = await neuralTTS(text, session.vozUrl, session.agent.voice, session.vozSpeed);
  if (!pcm || !pcm.length) pcm = await espeakTTS(text, session.agent.voice);
  if (!pcm || !pcm.length || session.closed) return;
  // enviar en frames de 20ms; cancelable por barge-in
  const token = ++session.speakToken;
  session.speaking = true;
  const PREBUF = 10;            // ~200ms de colchon inicial para absorber jitter
  let startT = 0; let idx = 0;
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    if (session.closed || token !== session.speakToken) break;   // barge-in / fin
    const slice = pcm.slice(off, off + FRAME_BYTES);
    const frame = Buffer.alloc(3 + slice.length);
    frame[0] = 0x10; frame.writeUInt16BE(slice.length, 1); slice.copy(frame, 3);
    try { session.socket.write(frame); } catch (_) { break; }
    idx++;
    if (idx === PREBUF) startT = Date.now();        // marca el reloj tras enviar el colchon
    if (idx <= PREBUF) continue;                    // las primeras van de corrido (cushion)
    const wait = (startT + (idx - PREBUF) * 20) - Date.now();   // pacing 20ms con correccion de deriva
    if (wait > 1) await new Promise(r => setTimeout(r, wait));
  }
  if (token === session.speakToken) session.speaking = false;
}

// ============================================================
//  Lógica conversacional por utterance
// ============================================================
async function onUtterance(session, rawText) {
  if (session.closed || session.busy) return;
  let text = rawText;
  if (session.uttBuf.length) {
    const utt = Buffer.concat(session.uttBuf); let w = '';
    if (session.useOpenAI && session.keys.openai) w = await whisperSTT(utt, session.keys.openai);
    else if (session.vozUrl) w = await neuralSTT(utt, session.vozUrl);
    if (w) text = w;
  }
  session.uttBuf = [];
  if (!text || text.length < 2) return;
  session.busy = true; session._turns = (session._turns || 0) + 1;
  session.log('USER> ' + text);
  try {
    if (session.useOpenAI && session.keys.openai) {
      session.history.push({ role: 'user', content: text });
      let msg = await openaiLLM(session.history, TOOLS, session.agent.model, session.keys.openai);
      let guard = 0;
      while (msg.tool_calls && msg.tool_calls.length && guard++ < 3) {
        session.history.push(msg);
        for (const tc of msg.tool_calls) {
          const args = JSON.parse(tc.function.arguments || '{}');
          if (tc.function.name === 'transfer_call') {
            await speak(session, msg.content || ('Te transfiero a ' + (args.label || args.destination) + '.'));
            return doTransfer(session, args.destination, args.label);
          }
          let result = 'ok';
          if (tc.function.name === 'crm_lookup') result = await crmLookup(args.query || text, session);
          session.history.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        msg = await openaiLLM(session.history, TOOLS, session.agent.model, session.keys.openai);
      }
      session.history.push({ role: 'assistant', content: msg.content || '' });
      await speak(session, msg.content || 'Disculpá, no te entendí.');
    } else {
      const out = ruleLLM(text, session);
      if (out.tool && out.tool.name === 'transfer_call') { await speak(session, out.text); return doTransfer(session, out.tool.args.destination, out.tool.args.label); }
      if (out.tool && out.tool.name === 'crm_lookup') { const res = await crmLookup(out.tool.args.query, session); await speak(session, res); }
      else { await speak(session, out.text); if (out.end) setTimeout(() => endSession(session, 'bot-bye'), 800); }
    }
  } catch (e) { session.log('ERR llm ' + e.message); await speak(session, 'Disculpá, tuve un inconveniente. ¿Podés repetir?'); }
  finally { session.busy = false; }
}

const TOOLS = [
  { type: 'function', function: { name: 'transfer_call', description: 'Transferir la llamada a un interno o cola cuando el usuario quiere hablar con un área o persona.', parameters: { type: 'object', properties: { destination: { type: 'string', description: 'Número de interno o cola destino' }, label: { type: 'string', description: 'Nombre del área (Ventas, Soporte, etc.)' } }, required: ['destination'] } } },
  { type: 'function', function: { name: 'crm_lookup', description: 'Consultar el CRM/sistema externo por datos del cliente (estado de cuenta, factura, pedido).', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Consulta en lenguaje natural' } }, required: ['query'] } } },
];

// ============================================================
//  Transferencia y cierre
// ============================================================
/* TONO DE LLAMADA EN LA TRANSFERENCIA. La llamada que sale de la IA ya está atendida (el
 * Answer() del ivr), así que no hay 180: el tono lo genera la central por audio, con la zona
 * de indications.conf. Sin zonas (la imagen no las traía) no sonaba nada, quien llama creía
 * que se había cortado y el softphone del panel cortaba solo a los ~8 s (29/09). Con las
 * zonas ya suena el aviso de ringing del interno; DIAL_OPCIONES=r además lo asegura en los
 * destinos que nunca avisan y enciende el Ringing() del despertar (extensions.conf) y el `r`
 * de los grupos de timbre (apps.js). Va por variable del canal y no como `r` fijo en el
 * dialplan para no tocar las llamadas comunes entre internos. Si no se puede poner, se
 * transfiere igual: una derivación muda es mejor que no derivar. */
async function pedirTonoDeLlamada(ch, anotar) {
  try { await ch.setChannelVar({ variable: 'DIAL_OPCIONES', value: 'r' }); }
  catch (e) { anotar('no se pudo pedir el tono de llamada (DIAL_OPCIONES): ' + (e && e.message) + '; se transfiere igual'); }
}
async function doTransfer(session, dest, label) {
  session.log('TRANSFER -> ' + dest + ' (' + (label || '') + ')');
  const ch = session.channel;
  // marcar cerrada ANTES de salir de Stasis: el continueInDialplan dispara StasisEnd
  // y sin esto endSession() colgaria el canal deshaciendo la transferencia.
  session.transferring = true; session.closed = true;
  try { if (session.endpointTimer) clearInterval(session.endpointTimer); } catch (_) {}
  /* El reloj del audio (20 ms) y la sesión con el modelo, que se paga por minuto: una
   * llamada transferida no los necesita más, y quedaban vivos hasta reiniciar la API. */
  try { if (session.rtReloj) clearInterval(session.rtReloj); } catch (_) {}
  try { if (session.rt) session.rt.cerrar(); } catch (_) {}
  try { if (session.sttProc) session.sttProc.kill('SIGKILL'); } catch (_) {}
  try { if (session.em) ARI.channels.hangup({ channelId: session.em.id }).catch(() => {}); } catch (_) {}
  try { if (session.bridge) session.bridge.destroy().catch(() => {}); } catch (_) {}
  let ok = true;
  await pedirTonoDeLlamada(ch, (m) => session.log(m));
  try { await ch.continueInDialplan({ context: 'internal', extension: String(dest), priority: 1 }); }
  catch (e) { ok = false; session.log('transfer err ' + e.message); try { await ch.hangup(); } catch (_) {} }
  if (session.socket) { try { session.socket.destroy(); } catch (_) {} }
  sessions.delete(session.uuid); pendingByUuid.delete(session.uuid);
  /* La IA externa se lo cuenta al backend (resultado de la transferencia). */
  return ok;
}
function cleanupMedia(session) {
  /* EL ORDEN IMPORTA, y se pagó caro descubrirlo: el canal AudioSocket de Asterisk está
   * bloqueado LEYENDO nuestro socket TCP. Si se intenta colgar el canal antes de soltar el
   * socket, el `hangup` no llega a ejecutarse y el canal queda «Up» para siempre — ni
   * siquiera `channel request hangup` desde el CLI lo mata. Cada llamada dejaba dos
   * canales zombis y, con ellos, la llamada siguiente al agente no se atendía.
   *
   * Y es `destroy()`, no `end()`: `end()` manda un FIN y espera al otro lado; el canal
   * trabado no lo procesa nunca. `destroy()` corta y libera al lector. */
  try { if (session.vigilante) session.vigilante.cerrar(); } catch (_) {}
  try { if (session.socket) { session.socket.destroy(); session.socket = null; } } catch (_) {}
  try { if (session.rtReloj) clearInterval(session.rtReloj); } catch (_) {}
  try { if (session.rt) session.rt.cerrar(); } catch (_) {}
  try { if (session.sttProc) session.sttProc.kill('SIGKILL'); } catch (_) {}
  /* Los errores de ARI NO se tragan: un hangup que falla en silencio es exactamente cómo
   * se acumularon los canales zombis sin que nadie se enterara. */
  try {
    if (session.em) ARI.channels.hangup({ channelId: session.em.id })
      .catch((e) => session.log('no se pudo colgar el canal de medios: ' + (e && e.message)));
  } catch (e) { session.log('no se pudo colgar el canal de medios: ' + e.message); }
  try {
    if (session.bridge) session.bridge.destroy()
      .catch((e) => session.log('no se pudo destruir el bridge: ' + (e && e.message)));
  } catch (e) { session.log('no se pudo destruir el bridge: ' + e.message); }
}
async function endSession(session, why) {
  if (session.closed) return;
  session.log('END (' + why + ')');
  if (session.modo === 'externo') cerrarExterno(session, why);
  cleanupMedia(session);
  try { await session.channel.hangup(); }
  catch (e) {
    /* Un 404 es lo normal cuando el llamante ya colgó. Cualquier otra cosa es un canal que
     * quedó vivo, y eso hay que verlo en el log y no adivinarlo. */
    const m = String((e && e.message) || e);
    if (!/404|not found|Channel not found/i.test(m)) session.log('no se pudo colgar el canal del llamante: ' + m);
  }
  finalize(session);
}
function finalize(session) {
  session.closed = true;
  try { if (session.endpointTimer) clearInterval(session.endpointTimer); } catch (_) {}
  if (session.socket) { try { session.socket.end(); } catch (_) {} }
  sessions.delete(session.uuid); pendingByUuid.delete(session.uuid);
}

/* ── Herramientas: el puente entre «el modelo pidió» y «la central hizo» ───────
 * Todo lo que toca el mundo real (el CRM, un relé, la transferencia, el corte) se
 * implementa acá y se le pasa a `herramientas.ejecutar` como funciones. Ese archivo no
 * sabe de ARI ni de HTTP: sólo decide SI corresponde. La separación es a propósito — los
 * candados se prueban sin levantar una central. */

/* Consulta al CRM del cliente. Un webhook, con tope, y con la respuesta normalizada:
 * `{ok, texto, datos}`. Lo que devuelva se le lee al visitante, así que si el CRM
 * contesta cualquier cosa, mejor que sea un `ok:false` que un texto raro en voz alta. */
async function leerCrmAgente(session, tipo, datos) {
  const url = (session.agent && session.agent.crm_webhook) || '';
  if (!url) return { ok: false, motivo: 'no hay consulta de datos configurada' };
  try {
    const r = await fetchTope(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ tipo, caller: session.callerId, agente: session.agent.name }, datos)),
    }, TOPE_CRM_MS);
    if (!r.ok) return { ok: false, motivo: 'HTTP ' + r.status };
    const j = await r.json().catch(() => null);
    if (!j) return { ok: false, motivo: 'respuesta ilegible' };
    /* Se aceptan las dos formas: la nuestra y la que ya usaba el pipeline viejo. */
    const texto = String(j.texto || j.result || j.detalle || '').slice(0, 500);
    const hallado = j.ok !== false && (j.encontrado !== false) && (texto || j.datos);
    return hallado ? { ok: true, texto, datos: j.datos || null } : { ok: false, motivo: String(j.motivo || 'sin datos') };
  } catch (e) {
    return { ok: false, motivo: String((e && e.message) || e) };
  }
}

/* Abrir. Dos modos porque hay dos mundos: el portero SIP que abre con un DTMF en la misma
 * llamada (lo más común, y lo que no necesita nada más), y el relé con una URL. */
async function abrirPuerta(session, cfg) {
  const modo = (cfg && cfg.modo) || 'dtmf';
  if (modo === 'webhook') {
    const url = (cfg && cfg.url) || '';
    if (!url) return { ok: false, detalle: 'sin URL de apertura configurada' };
    try {
      const r = await fetchTope(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: 'abrir', agente: session.agent.name, llamante: session.callerId, sesion: session.uuid }),
      }, 5000);
      return r.ok ? { ok: true, detalle: 'webhook ' + r.status } : { ok: false, detalle: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, detalle: String((e && e.message) || e) }; }
  }
  /* DTMF hacia el que llamó: el portero abre cuando recibe el tono. */
  const digitos = String((cfg && cfg.dtmf) || '#').slice(0, 8);
  try {
    await ARI.channels.sendDTMF({ channelId: session.channel.id, dtmf: digitos, duration: 250, between: 100 });
    return { ok: true, detalle: 'DTMF ' + digitos };
  } catch (e) { return { ok: false, detalle: String((e && e.message) || e) }; }
}

/* La despedida con corte: la misma que usa la escalera de inactividad, para que cortar por
 * pedido y cortar por silencio se escuchen igual. */
function despedirYCortar(session, texto) {
  if (session.closed || session.despidiendo) return;
  session.despidiendo = true;
  const frase = momento.conSaludo(texto || (session.agent && session.agent.despedida_text) || inactividad.FRASES.despedida, new Date(), session.zona);
  try { if (session.vigilante) session.vigilante.cerrar(); } catch (_) {}
  try { if (session.rt) session.rt.saludar(frase); } catch (_) {}
  /* Se espera a que TERMINE de decirla (un segundo de silencio real) y se corta; y hay un
   * tope duro por si el audio nunca llega, porque la llamada no puede quedar abierta. */
  let vacio = 0;
  const reloj = setInterval(() => {
    if (session.closed) { clearInterval(reloj); return; }
    if (session.speaking) { vacio = 0; return; }
    if (++vacio >= 12) { clearInterval(reloj); endSession(session, 'despedida'); }   // 12 × 250 ms
  }, 250);
  if (reloj.unref) reloj.unref();
  const duro = setTimeout(() => { clearInterval(reloj); if (!session.closed) endSession(session, 'despedida-tope'); }, 12000);
  if (duro.unref) duro.unref();
}

/* Guarda una fila en el registro de acciones. Es la respuesta a «¿quién abrió el portón a
 * las 3 de la mañana?», así que va a la base y no al log del contenedor. */
function auditarAccion(session, reg) {
  if (!POOL) return;
  POOL.query(
    'INSERT INTO pbxng_ia_acciones (agente_id,sesion,llamante,herramienta,resultado,razon,motivo,args)'
    + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [session.agent && session.agent.id, session.uuid, session.callerId || '', reg.herramienta,
      reg.resultado || '', reg.razon || '', reg.motivo || '', JSON.stringify(reg.args || {})],
  ).catch((e) => session.log('no se pudo auditar la acción: ' + e.message));
}

/* ── El último problema del proveedor, a la vista ─────────────────────────────
 * Se quedó sin créditos y la única forma de enterarse fue llamando al agente y escuchar
 * «no puedo atenderte». El error estaba en el log del contenedor, donde nadie mira hasta
 * que algo ya falló. Queda guardado como ajuste y el panel lo muestra: un agente que no
 * puede atender tiene que verse en la pantalla de agentes, no en una llamada.
 *
 * Sólo se guardan los problemas del PROVEEDOR (clave, saldo, modelo), que son los que se
 * arreglan en otro lado; un corte de red puntual se recupera solo y no vale la alarma. */
const PROBLEMAS = [
  { re: /no credits|insufficient[_ ]quota|billing/i, que: 'La cuenta de OpenAI se quedó sin créditos.', arreglo: 'Cargá saldo en platform.openai.com; mientras tanto los agentes no pueden atender.' },
  { re: /invalid[_ ]api[_ ]key|incorrect api key|401|403/i, que: 'El proveedor rechazó la clave.', arreglo: 'Revisá la clave en IA & Voz → Nube. Si la rotaste, hay que volver a cargarla.' },
  { re: /does not exist|404|model/i, que: 'El modelo configurado no existe para esta cuenta.', arreglo: 'Elegí uno de la lista en el agente (pestaña Cerebro).' },
  { re: /rate limit|429/i, que: 'El proveedor está limitando las llamadas.', arreglo: 'Es temporal; si se repite, revisá el plan de la cuenta.' },
];

function anotarProblemaProveedor(texto) {
  const t = String(texto || '');
  const m = PROBLEMAS.find((x) => x.re.test(t));
  if (!m || !POOL) return;
  POOL.query(
    "INSERT INTO pbxng_settings (key,value) VALUES ('ia_ultimo_problema',$1)"
    + ' ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
    [JSON.stringify({ que: m.que, arreglo: m.arreglo, detalle: t.slice(0, 300), ts: new Date().toISOString() })],
  ).catch(() => {});
}

function ctxHerramientas(session, cfg) {
  return {
    cfg, agenteId: (session.agent && session.agent.id) || 0,
    ahora: new Date(),
    hhmm: new Intl.DateTimeFormat('es-UY', { timeZone: session.zona || momento.ZONA_DEF, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()),
    sesion: session.estadoIA || (session.estadoIA = { verificada: false }),
    leerCrm: (tipo, datos) => leerCrmAgente(session, tipo, datos),
    /* La verificación real: contra las personas autorizadas del cliente que llama, que son
     * las mismas que ve el operario en su panel. */
    verificarPersona: async (datos) => {
      if (!session.identificacion) return { ok: false, razon: 'no se pudo identificar el portero', alModelo: 'no reconozco esta dirección; te paso con una persona' };
      return porteria.verificarAutorizado(session.identificacion.personas, datos, new Date());
    },
    transferir: async (motivo) => {
      session.log('transferencia pedida por el agente: ' + motivo);
      await doTransfer(session, session.agent.default_exten || session.agent.support_exten || '', 'Operador');
    },
    mensaje: async (datos) => { auditarAccion(session, { herramienta: 'tomar_mensaje', resultado: 'mensaje guardado', motivo: datos.unidad || '', args: datos }); },
    terminar: async (motivo) => { session.log('corte pedido por el visitante: ' + motivo); despedirYCortar(session); },
    abrir: (motivo) => abrirPuerta(session, (cfg || {}).abrir_porton).then((r) => { session.log('apertura (' + motivo + '): ' + JSON.stringify(r)); return r; }),
    auditar: (reg) => auditarAccion(session, reg),
    log: (m) => session.log(m),
  };
}

/* ── Barrido de canales huérfanos ──────────────────────────────────────────────
 * Una red de seguridad, no el arreglo: el arreglo es soltar el socket antes de colgar (ver
 * `cleanupMedia`). Pero un canal zombi no se nota hasta la llamada siguiente —que no se
 * atiende— y para entonces ya hay dos. Así que cada 30 s se mira qué canales están dentro
 * de NUESTRA aplicación Stasis sin una sesión viva detrás, y se cuelgan.
 *
 * Se compara contra `sessions` y `pendingByUuid`: un canal recién creado que todavía no
 * completó el handshake de AudioSocket está en `pendingByUuid`, y colgarlo sería cortar una
 * llamada que estaba por empezar. Por eso además se le da un minuto de gracia. */
const GRACIA_HUERFANO_MS = 60000;
/* Tope duro de una llamada con la IA. Estaba en una hora, que como red de seguridad no
 * sirve de mucho: un canal colgado se veía vivo en el panel media tarde. Un agente de
 * portería que lleva un cuarto de hora hablando ya está roto por otra razón. */
const MAX_SESION_MS = Number(process.env.AI_MAX_SESION_MS || 900000);   // 15 min
let barridoTimer = null;

async function barrerHuerfanos() {
  if (!ARI) return;
  try {
    const canales = await ARI.channels.list();
    const ahora = Date.now();
    for (const ch of canales) {
      const dialplan = ch.dialplan || {};
      const app = String(dialplan.app_data || '');
      /* Sólo los canales de medios de la IA: su app_data es `pbxng,<uuid de la sesión>`. */
      const m = /^pbxng,([0-9a-f-]{36})$/i.exec(app);
      /* El OTRO huérfano, el que se veía en el panel como una llamada eterna: el canal
       * del que LLAMÓ, parado dentro de la aplicación Stasis `pbxng,ai,...`. Cuando la
       * api se reinicia —y se reinicia en cada despliegue— Asterisk deja ese canal ahí
       * esperando órdenes de una aplicación que ya no existe: no lo cuelga nadie, sigue
       * ocupando el interno y el panel lo muestra hablando para siempre. */
      const enIa = /^pbxng,ai(,|$)/i.test(app);
      if (!m && !enIa) continue;
      const nacido = Date.parse(ch.creationtime || '') || 0;
      if (nacido && ahora - nacido < GRACIA_HUERFANO_MS) continue;

      if (enIa) {
        /* Sólo si NINGUNA sesión viva lo reclama: mientras la llamada existe de verdad,
         * su canal está en sessions y no se toca. */
        let duenio = false;
        for (const ses of sessions.values()) if (ses.channel && ses.channel.id === ch.id) { duenio = true; break; }
        if (!duenio) for (const ses of pendingByUuid.values()) if (ses.channel && ses.channel.id === ch.id) { duenio = true; break; }
        if (duenio) continue;
        log.warn('llamada colgada en la aplicación de IA sin sesión: se cuelga', { canal: ch.name });
        try { await ARI.channels.hangup({ channelId: ch.id }); }
        catch (e) { log.warn('no se pudo colgar la llamada huérfana', { canal: ch.name, err: (e && e.message) }); }
        continue;
      }

      const uuid = m[1];
      if (sessions.has(uuid) || pendingByUuid.has(uuid)) continue;
      log.warn('canal de medios sin sesión: se cuelga', { canal: ch.name, session: uuid.slice(0, 8) });
      try { await ARI.channels.hangup({ channelId: ch.id }); }
      catch (e) { log.warn('no se pudo colgar el canal huérfano', { canal: ch.name, err: (e && e.message) }); }
    }
    /* Y el tope duro: una sesión de voz se paga por minuto, así que ninguna puede quedar
     * viva porque el llamante se fue sin colgar y el proveedor no avisó. */
    for (const ses of Array.from(sessions.values())) {
      if (ses.closed || !ses.nacida) continue;
      if (ahora - ses.nacida > MAX_SESION_MS) {
        ses.log('tope de duración de sesión alcanzado: se corta');
        endSession(ses, 'tope-duracion');
      }
    }
  } catch (e) { log.warn('barrido de canales', { err: (e && e.message) }); }
}

// ============================================================
//  Servidor AudioSocket
// ============================================================
let SRV = null;   // servidor AudioSocket (uno solo: init() se vuelve a llamar en cada reconexión ARI)
function startServer() {
  if (SRV) return;
  const srv = net.createServer((socket) => {
    try { socket.setNoDelay(true); } catch (_) {}   // sin Nagle: audio en tiempo real, sin tirones
    let buf = Buffer.alloc(0); let session = null;
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 3) {
        const type = buf[0]; const len = buf.readUInt16BE(1);
        if (buf.length < 3 + len) break;
        const payload = buf.slice(3, 3 + len); buf = buf.slice(3 + len);
        if (type === 0x01) {            // UUID -> identificar sesión
          const uuid = bytesToUuid(payload);
          session = pendingByUuid.get(uuid);
          if (!session) { try { socket.end(); } catch (_) {} return; }
          pendingByUuid.delete(uuid);
          session.socket = socket; sessions.set(uuid, session);
          session.log('AudioSocket conectado');
          if (session.modo === 'realtime') {
            arrancarRealtime(session);
          } else if (session.modo === 'externo') {
            arrancarExterno(session);
          } else {
            attachStt(session);
            setTimeout(() => { if (!session.closed) speak(session, session.greetingText); }, 250);
          }
        } else if ((type === 0x10 || type === 0x12) && session) {   // audio entrante (caller, slin16=0x12)
          handleInAudio(session, payload);
        } else if (type === 0x00) {              // terminar
          if (session) endSession(session, 'audiosocket-term');
        }
      }
    });
    socket.on('close', () => { if (session && !session.closed) endSession(session, 'socket-close'); });
    socket.on('error', () => {});
  });
  srv.on('error', (e) => { log.error('AudioSocket', e); if (SRV === srv) SRV = null; });
  srv.listen(AS_PORT, '0.0.0.0', () => log.info('AudioSocket escuchando', { port: AS_PORT }));
  SRV = srv;
  if (!barridoTimer) { barridoTimer = setInterval(barrerHuerfanos, 30000); if (barridoTimer.unref) barridoTimer.unref(); }
}

/* Cierre ordenado (SIGTERM en app.js): corta las sesiones de IA en curso y deja de
 * escuchar. Devuelve una promesa que resuelve cuando el socket de escucha se cerró. */
function close() {
  for (const s of Array.from(sessions.values())) { try { endSession(s, 'shutdown'); } catch (_) {} }
  for (const s of Array.from(pendingByUuid.values())) { try { finalize(s); } catch (_) {} }
  return new Promise((ok) => { const srv = SRV; SRV = null; if (!srv) return ok(); srv.close(() => ok()); });
}

/* ============================================================
 *  Modo REALTIME (un socket con el modelo, sin STT/LLM/TTS separados)
 * ============================================================
 *  El pipeline de tres pasos sigue intacto y es el default. Esto es el otro camino,
 *  detrás de la misma interfaz: `pbxng_ai_agents.provider = 'openai-realtime'`.
 *
 *  Lo único que este archivo agrega al puente (`realtime.js`) es EL RITMO. El modelo
 *  manda audio a ráfagas y el canal consume 20 ms cada 20 ms: si se escribe todo lo que
 *  llega, se desborda y se escucha picado; si se espera a tenerlo entero, se pierde la
 *  latencia que se vino a ganar. Así que llega a una cola y un reloj la vacía a ritmo de
 *  canal. Es el mismo problema que ya resuelve `speak()` para el TTS, con una diferencia
 *  importante: acá el audio sigue llegando mientras se reproduce.
 */
/* El audio del modelo hacia el canal, a su ritmo, y el barge-in. Es lo mismo para el modo
 * realtime y para la IA externa: en los dos el modelo manda audio a ráfagas por el mismo
 * puente (`realtime.js`) y el canal consume 20 ms cada 20 ms. La escalera de inactividad
 * (`session.vigilante`) solo existe en realtime; acá se la avisa si está. */
function conectarAudio(session, puente) {
  /* El reloj del canal: 20 ms. Sale UN frame por vuelta, ni más ni menos, y si no hay
   * nada en la cola no se escribe silencio —el canal ya reproduce silencio solo—. */
  /* Cuántas vueltas seguidas sin audio se necesitan para dar por TERMINADA la frase. El
   * modelo manda el audio a ráfagas y la cola se vacía por un instante entre dos deltas de
   * la misma oración; sin esta ventana, «terminó de hablar» se dispararía a mitad de
   * frase y el agente preguntaría «¿sigue ahí?» encima de sí mismo. */
  const VUELTAS_FIN = 20;   // 20 × 20 ms = 400 ms de silencio real
  session.rtVacio = 0;
  session.rtReloj = setInterval(() => {
    if (session.closed || !session.socket) return;
    const f = session.rtCola.shift();
    if (!f) {
      if (session.speaking) {
        session.rtVacio++;
        if (session.rtVacio >= VUELTAS_FIN) {
          session.speaking = false; session.rtVacio = 0;
          if (session.vigilante) session.vigilante.callado();
        }
      }
      return;
    }
    session.rtVacio = 0;
    if (!session.speaking && session.vigilante) session.vigilante.hablando();
    session.speaking = true;
    const frame = Buffer.alloc(3 + f.length);
    frame[0] = 0x10; frame.writeUInt16BE(f.length, 1); f.copy(frame, 3);
    try { session.socket.write(frame); } catch (_) {}
  }, 20);

  puente.on('audio', (pcm8) => {
    /* Se corta en frames de 20 ms exactos: el canal los quiere así, y partir a mano evita
     * que un delta grande entre de una y se escuche adelantado. */
    let off = 0;
    while (off < pcm8.length) { session.rtCola.push(pcm8.slice(off, off + FRAME_BYTES)); off += FRAME_BYTES; }
    /* Techo de cola: 5 s de audio. Si el modelo se desbocó o el canal se trabó, mejor
     * perder el final de una frase que acumular minutos de audio que ya no viene al caso. */
    if (session.rtCola.length > 250) session.rtCola.splice(0, session.rtCola.length - 250);
  });
  /* Barge-in: lo que queda por reproducir se TIRA. El puente ya le pidió al modelo que
   * pare; sin esto el visitante seguiría escuchando la frase vieja unos segundos. */
  puente.on('corte', () => {
    session.rtCola.length = 0; session.speaking = false; session.rtVacio = 0;
    session.log('barge-in (realtime)');
    /* El visitante habló: se cancela la escalera de inactividad, incluido un corte ya
     * agendado. Quien vuelve a hablar mientras el agente se despide no pierde la llamada. */
    if (session.vigilante) session.vigilante.visitanteHabla();
  });
}

/* ============================================================
 *  Modo IA EXTERNA (la conversación la conduce el backend del asistente)
 * ============================================================
 *  La central abre la sesión de GPT-Live con la configuración que bajó del backend, TAL
 *  CUAL, y le hace de relay: cada evento de la sesión va al backend y cada comando del
 *  backend va a la sesión. Todo lo de la llamada viaja por su relay (contrato v2). No hay prompt, saludo, herramientas ni escalera de inactividad
 *  nuestros: todo eso lo hace el backend. Lo que sí queda acá es lo de siempre: el ritmo
 *  del audio, el barge-in y la ejecución de las órdenes (colgar, transferir, DTMF).
 *  Contrato: docs/CONTRATOS.md §11 e ia-externa.js.
 */
/* Cuánto se espera la orden del backend cuando se cerró la sesión de voz. Existe porque
 * el backend primero cierra la sesión (se despide o anuncia la derivación) y recién
 * después manda «colgar» o «transferir»: colgar al toque cortaría la derivación. Un corte
 * del relay no la usa: el relay se reabre (contrato v2, RelayLlamada). */
const ESPERA_ORDEN_MS = 5000;
/* Tope para esperar que termine de sonar lo que quedaba en la cola antes de colgar o
 * transferir: el backend decide el final con los eventos, que llegan al ritmo en que el
 * modelo GENERA, no al de reproducción; sin esperar, la despedida se cortaba. */
const TOPE_COLA_MS = 5000;

function esperarColaVacia(session) {
  return new Promise((ok) => {
    const desde = Date.now();
    const mirar = () => {
      if (session.closed || !session.rtCola || !session.rtCola.length || Date.now() - desde > TOPE_COLA_MS) return ok();
      setTimeout(mirar, 50);
    };
    mirar();
  });
}

function arrancarExterno(session) {
  const agente = session.agent;
  const cfg = IAX.configDe(agente.id);
  const pbxCallId = session.uuid;
  const puente = realtime.abrir({
    key: session.keys.openai,
    base: session.realtimeBase || '',
    model: (cfg.session && cfg.session.model) || 'gpt-live-1',
    sessionCruda: cfg.session,
  });
  session.rt = puente;
  session.rtCola = [];
  conectarAudio(session, puente);

  const ordenes = ordenesExternas(session);

  /* El relay de la llamada (contrato v2): el aviso va primero, cada evento y cada hecho
   * van numerados, y si se corta se reabre durante la ventana que publica el backend
   * (otra instancia la retoma). */
  const relay = new iaExterna.RelayLlamada({
    abrir: () => IAX.abrirRelay(agente, pbxCallId),
    aviso: {
      type: 'llamada_nueva', pbxCallId,
      from: session.callerId || null,
      to: agente.exten || null,
      origen: session.identificacion ? 'portero' : 'telefono',
      configVersion: cfg.version,
      dtmfApertura: iaExterna.dtmfApertura(agente),
      destinoAgentes: agente.agentes_exten || agente.default_exten || '',
    },
    ventanaMs: cfg.resumeWindowMs === undefined || cfg.resumeWindowMs === null ? iaExterna.VENTANA_DEF_MS : cfg.resumeWindowMs,
    log: session.log,
    alComando: (cmd) => puente.enviarCrudo(cmd),
    alOrden: (o) => (o.type === 'colgar' ? ordenes.colgar() : o.type === 'transferir' ? ordenes.transferir(String(o.destino || '')) : ordenes.enviar_dtmf(String(o.digitos || ''))),
    alConfirmado: () => { clearTimeout(session.esperaEnganche); session.log('el backend tomó el control de la llamada'); },
    alRechazado: (motivo) => respaldoExterno(session, 'el backend rechazó la llamada: ' + motivo),
    alPerdido: (motivo) => respaldoExterno(session, motivo),
  });
  session.relay = relay;
  puente.on('crudo', (msg) => {
    if (msg && msg.type === 'session.closed') session.sesionCerrada = true;
    relay.mandar(msg);
  });
  puente.on('audio-salida', (msg) => relay.mandar(msg));
  puente.on('error', (e) => { session.log('realtime: ' + e); anotarProblemaProveedor(e); });
  puente.on('cerrado', (info) => {
    /* El cierre que hace `cerrarExterno` al terminar la llamada no es un corte. */
    if (session.closed || session.externoCerrado) return;
    session.log('realtime: sesión cerrada (' + ((info && info.code) || 'sin código') + '), se espera la orden del backend');
    /* Sin `session.closed` de OpenAI (un corte de red) el backend no se enteraría: con el
     * contrato v2 el cierre del relay ya no lo dice (significa «reabrir»). Se le avisa con
     * un `session.closed` de la central, y el relay queda abierto para la orden. */
    if (!session.sesionCerrada) relay.mandar({ type: 'session.closed', reason: 'cortada_en_la_central' });
    esperarOrden(session, 'se cerró la sesión sin orden del backend');
  });

  /* Con la sesión abierta, se abre el relay (el aviso es su primer mensaje) y se espera que
   * el backend tome el control. */
  puente.cuandoListo(10000).then(() => {
    if (session.closed || session.externoCerrado) return;
    relay.iniciar();
    session.esperaEnganche = setTimeout(() => {
      if (!relay.confirmada) respaldoExterno(session, 'el backend no confirmó a tiempo');
    }, cfg.attachTimeoutMs || 5000);
    if (session.esperaEnganche.unref) session.esperaEnganche.unref();
  }).catch((e) => respaldoExterno(session, 'la sesión no abrió: ' + e.message));
}

/* Las órdenes del backend para una llamada de IA externa, que llegan por su relay. */
function ordenesExternas(session) {
  const agente = session.agent;
  const pbxCallId = session.uuid;
  /* Con la llamada ya terminada o en el respaldo, ninguna orden se ejecuta: un
   * `transferir` tardío sobre un canal que ya salió de Stasis lo colgaba (revisor, 01/10). */
  const enCurso = () => { if (session.closed || session.externoCerrado) throw new Error('la llamada ya no está en curso'); };
  /* Una orden válida cancela la espera de orden; una inválida no, así el respaldo sigue
   * armado si la sesión de voz ya se cerró. */
  const cancelarEspera = () => { clearTimeout(session.esperaOrden); session.esperaOrden = null; };
  return {
    colgar: async () => {
      enCurso();
      cancelarEspera();
      await esperarColaVacia(session);
      await endSession(session, 'orden del backend');
    },
    transferir: async (destino) => {
      enCurso();
      if (!iaExterna.destinoPermitido(agente, destino)) throw new Error('destino no permitido para este agente: ' + destino);
      cancelarEspera();
      await esperarColaVacia(session);
      const ok = await doTransfer(session, destino, 'derivación del backend');
      avisarBackend(session, { type: 'transferencia', pbxCallId, ok, detalle: ok ? null : 'no se pudo transferir a ' + destino }, { final: true });
      cerrarExterno(session, 'transferida');
      if (!ok) throw new Error('no se pudo transferir a ' + destino);
    },
    enviar_dtmf: async (digitos) => {
      enCurso();
      if (!iaExterna.DTMF.test(digitos)) throw new Error('DTMF inválido');
      await ARI.channels.sendDTMF({ channelId: session.channel.id, dtmf: digitos, duration: 250, between: 100 });
      /* La apertura la decide el backend, pero la respuesta a «¿quién abrió el portón?»
       * sigue estando acá. */
      auditarAccion(session, { herramienta: 'abrir_porton', resultado: 'DTMF ' + digitos + ' (orden del backend)', razon: 'ia-externa' });
    },
  };
}

/* Un hecho de la llamada para el backend. Va por el relay, numerado: si está cortado, sale
 * al reabrirlo. Uno final (colgó, el resultado de la transferencia) no puede esperar: si no
 * sale ya, va por HTTP a cualquier instancia. */
function avisarBackend(session, hecho, { final = false } = {}) {
  const relay = session.relay;
  /* Sin relay (todavía no hay sesión de voz) el backend no sabe de la llamada: no hay a
   * quién avisarle. */
  if (!relay) return false;
  if (relay.mandar(hecho)) return true;
  if (!final && !relay.terminado) return true;
  /* Tampoco si el aviso nunca llegó a salir (quien llama cortó antes de abrir el relay). */
  if (!relay.avisoMandado || !IAX) return false;
  IAX.enviarHecho(session.agent, hecho)
    .then((r) => { if (!r.ok) session.log('IA externa: el hecho ' + hecho.type + ' no llegó al backend (' + r.motivo + ')'); })
    .catch((e) => session.log('IA externa: el hecho ' + hecho.type + ' no llegó al backend (' + e.message + ')'));
  return false;
}

/* Se cerró la sesión de voz: se espera la orden del backend y, si no llega, respaldo. */
function esperarOrden(session, motivo) {
  if (session.closed || session.esperaOrden) return;
  session.esperaOrden = setTimeout(() => { if (!session.closed) respaldoExterno(session, motivo); }, ESPERA_ORDEN_MS);
  if (session.esperaOrden.unref) session.esperaOrden.unref();
}

/* Sin el backend, el visitante no se queda mudo: va al destino de respaldo del agente. */
async function respaldoExterno(session, motivo) {
  if (session.closed || session.externoCerrado) return;
  session.log('IA externa: respaldo (' + motivo + ')');
  cerrarExterno(session, 'respaldo');
  const destino = session.agent && session.agent.default_exten;
  if (destino) await doTransfer(session, destino, 'respaldo IA externa');
  else await endSession(session, 'sin respaldo configurado');
}

/* Suelta todo lo de la IA externa de una llamada. Si colgó quien llama, se lo avisa. */
function cerrarExterno(session, why) {
  if (session.externoCerrado) return;
  session.externoCerrado = true;
  clearTimeout(session.esperaOrden);
  clearTimeout(session.esperaEnganche);
  /* Cualquier fin que no ordenó el backend (colgó quien llama, se cortó el audio, un tope,
   * un apagado) se le avisa: si no, se quedaba esperando que la central reabra el relay. */
  if (!['orden del backend', 'transferida', 'respaldo'].includes(why)) avisarBackend(session, { type: 'colgo', pbxCallId: session.uuid }, { final: true });
  /* `ari-client` guarda los listeners de instancia hasta que se sacan: sin esto, cada
   * llamada dejaba retenida la sesión entera. */
  try { if (session.alDtmf && session.channel.removeListener) session.channel.removeListener('ChannelDtmfReceived', session.alDtmf); } catch (_) {}
  try { if (session.relay) session.relay.cerrar(1000, 'fin de la llamada'); } catch (_) {}
  try { if (session.rt) session.rt.cerrar(); } catch (_) {}
}

function arrancarRealtime(session) {
  /* Las herramientas ENCENDIDAS de este agente. Si no hay ninguna, la sesión se abre en
   * modo cliente —el modelo conversa solo— y nada cambia respecto de antes. Con al menos
   * una, el puente pasa a delegar en el backend de Responses, que es el único modo en que
   * este proveedor ejecuta funciones. Se enciende por agente, no global: prender
   * delegación cambia cómo razona el modelo y hay que volver a escuchar el tono. */
  const cfgHerr = (session.agent && session.agent.herramientas) || {};
  const declaradas = herramientas.declarar(cfgHerr);
  if (declaradas.length) session.log('herramientas: ' + declaradas.map((d) => d.name).join(', '));

  /* La caja del backoffice se pide DESPUÉS de abrir: el catálogo remoto se suma en caliente
   * a la sesión. Se hace así y no antes para que un sistema de gestión lento no demore el
   * saludo — el portero atiende igual, con menos herramientas. */
  const puente = realtime.abrir({
    key: session.keys.openai,
    base: session.realtimeBase || '',
    model: session.agent.model || 'gpt-realtime-2.1-mini',
    voz: session.agent.voice || 'alloy',
    instrucciones: session.history[0].content,
    herramientas: declaradas,
    delegacionModel: (cfgHerr.delegacion && cfgHerr.delegacion.model) || '',
  });

  /* El modelo pidió algo. Se ejecuta (o se rechaza) y se le devuelve el resultado con su
   * `call_id`: sin eso el modelo queda esperando y la conversación se traba. */
  puente.on('herramienta', async (h) => {
    if (session.closed) return;
    let args;
    try { args = JSON.parse(h.args || '{}'); } catch (_) { args = {}; }
    session.log('el agente pidió: ' + h.nombre + ' ' + JSON.stringify(args).slice(0, 200));
    let res;
    try {
      res = remotas.esRemota(h.nombre)
        /* Una herramienta del backoffice: la ejecuta ÉL. La central sigue poniendo el tope
         * de tiempo, el saneo de la respuesta y la auditoría — delegar la caja no es
         * delegar el control. */
        ? await (async () => {
          const rr = await remotas.ejecutarRemota(h.nombre, args, cfgHerr.remoto || {}, {
            llamante: session.callerId || '', sesion: session.uuid, agente: (session.agent && session.agent.name) || '',
            log: (m) => session.log(m),
          });
          auditarAccion(session, { herramienta: h.nombre, resultado: rr.ok ? 'consulta al backoffice' : 'backoffice sin respuesta', razon: rr.motivo || '', args });
          return rr;
        })()
        : await herramientas.ejecutar(h.nombre, args, ctxHerramientas(session, cfgHerr));
    }
    catch (e) { res = { ok: false, motivo: 'no se pudo completar esa acción' }; session.log('herramienta ' + h.nombre + ': ' + e.message); }
    try { puente.responderHerramienta(h.call_id, res); } catch (_) {}
  });
  session.rt = puente;
  session.rtCola = [];

  /* La escalera de inactividad. Vive del lado nuestro a propósito: el modelo no tiene
   * reloj, no sabe cuánto silencio pasó y no puede colgar. Apagada (0 s) por defecto. */
  const ag = session.agent || {};
  session.vigilante = inactividad.crearVigilante({
    esperas: { consulta1: ag.inact1_s, consulta2: ag.inact2_s, cierre: ag.cierre_s },
    frases: {
      consulta1: momento.conSaludo(ag.inact1_text || inactividad.FRASES.consulta1, new Date(), session.zona),
      consulta2: momento.conSaludo(ag.inact2_text || inactividad.FRASES.consulta2, new Date(), session.zona),
      despedida: momento.conSaludo(ag.despedida_text || inactividad.FRASES.despedida, new Date(), session.zona),
    },
    decir: (texto) => { if (!session.closed) puente.saludar(texto); },
    cortar: () => { session.log('inactividad: se corta la llamada'); endSession(session, 'inactividad'); },
    log: (m) => session.log(m),
  });

  conectarAudio(session, puente);
  puente.on('texto', (t) => {
    session.transcripcion = session.transcripcion || [];
    session.transcripcion.push(t);
    if (t && t.quien === 'visitante' && session.vigilante) session.vigilante.visitanteHabla();
  });
  puente.on('error', (e) => { session.log('realtime: ' + e); anotarProblemaProveedor(e); });
  /* El proveedor cerró la sesión. Antes esto SÓLO se anotaba en el log, y la llamada
   * quedaba viva: el visitante se quedaba escuchando silencio hasta que a alguien se le
   * ocurriera colgar del otro lado —se vio un canal arriba 15 minutos así—. Si el modelo
   * ya no está, la llamada no tiene con quién hablar: se corta. (`endSession` no hace nada
   * si la sesión ya estaba cerrada, que es el caso normal del cierre ordenado.) */
  puente.on('cerrado', (info) => {
    /* Se deja escrito el código y el motivo: es la diferencia entre «se cayó» y saber si
     * fue cuota, un corte de red o un cierre limpio del modelo. */
    const c = (info && info.code) || 0;
    const porQue = (info && info.motivo) ? ' · ' + info.motivo
      : c === 1006 ? ' · se cortó la conexión sin aviso (red o corte del otro lado)'
        : c === 1000 ? ' · cierre limpio' : '';
    const detalle = 'cierre ' + (c || 'sin código') + porQue;
    if (session.closed) { session.log('realtime: ' + detalle + ' (la llamada ya había terminado)'); return; }
    session.log('realtime: sesión cerrada por el proveedor (' + detalle + ') — se corta la llamada');
    if (c && c !== 1000) anotarProblemaProveedor(detalle);
    endSession(session, 'proveedor-cerro');
  });

  /* Instrumental mínimo del arranque. Sin esto, «el agente atendió y no habló» era
   * indistinguible de «el modelo nunca abrió» y de «el audio no llegó al canal»: tres
   * causas distintas, tres lugares distintos donde se arreglan, y cero pistas en el log. */
  puente.on('audio', () => {
    if (!session.rtPrimerAudio) { session.rtPrimerAudio = Date.now(); session.log('primer audio del modelo'); }
  });
  /* EL SALUDO VA DESPUÉS DE QUE EMPIEZA A ENTRAR AUDIO, y esto costó una tarde entenderlo.
   * GPT-Live es una conversación continua: toma turno cuando ESCUCHA. Si se le manda el
   * saludo con el canal todavía sin audio, lo acepta y no emite nada — la sesión queda
   * abierta y el visitante escucha silencio, sin un solo error en ningún lado. Es
   * exactamente lo que le pasaba a la prueba de conexión hasta que empezó a mandar
   * silencio al ritmo del canal antes de saludar.
   *
   * Así que se espera al primer frame del llamante (Asterisk los manda de entrada, aunque
   * nadie hable), un respiro más, y recién ahí el saludo. Si el audio no aparece en 3 s se
   * saluda igual: mejor intentarlo que quedarse mudo esperando. */
  function saludarCuandoEscuche(intento) {
    if (session.closed) return;
    const listo = !!session.rtAudioEntra;
    if (!listo && (intento || 0) < 30) { setTimeout(() => saludarCuandoEscuche((intento || 0) + 1), 100); return; }
    setTimeout(() => {
      if (session.closed) return;
      session.log('saludo' + (listo ? '' : ' (sin audio del llamante todavía)'));
      puente.saludar(session.greetingText);
      /* Reintento único: si a los 4 s no dijo una palabra, se lo pide otra vez. Un agente
       * que atiende mudo es peor que uno que saluda dos veces. */
      setTimeout(() => {
        if (session.closed || session.rtPrimerAudio) return;
        session.log('el modelo no habló: se reintenta el saludo');
        puente.saludar(session.greetingText);
      }, 4000);
      setTimeout(() => {
        if (!session.closed && !session.rtPrimerAudio) session.log('el modelo sigue sin mandar audio: el visitante está escuchando silencio');
      }, 9000);
      /* Y si a los MUDO_MS del saludo el modelo no dijo una sola palabra, se corta. La
       * escalera de inactividad no sirve acá: esa recién arranca cuando el agente terminó
       * de hablar por primera vez, así que con un modelo que nunca abre la boca no llega a
       * armarse nunca. Colgar es peor que atender bien, pero es mucho mejor que dejar a
       * alguien pegado al portero escuchando nada. */
      setTimeout(() => {
        if (session.closed || session.rtPrimerAudio) return;
        session.log('el modelo no habló en ' + Math.round(MUDO_MS / 1000) + ' s: se corta la llamada');
        endSession(session, 'modelo-mudo');
      }, MUDO_MS);
    }, listo ? 400 : 0);
  }

  puente.cuandoListo(10000)
    .then(() => {
      if (session.closed) return;
      session.log('sesión del modelo lista (' + puente.api + ')');
      saludarCuandoEscuche(0);
      /* Y en paralelo, la caja del backoffice. Si contesta, se le suman al modelo; si no
       * contesta, la llamada sigue igual con las herramientas de la central. */
      if (cfgHerr.remoto && cfgHerr.remoto.on) {
        remotas.traerCatalogo(cfgHerr.remoto, herramientas.CATALOGO, { log: (m) => session.log(m) })
          .then((lista) => {
            if (session.closed || !lista.length) return;
            puente.agregarHerramientas(lista);
          })
          .catch(() => {});
      }
    })
    .catch((e) => {
      /* Si el modelo no abre, la llamada NO se queda muda: se dice la frase de siempre con
       * el camino de toda la vida y se corta. Un agente que atiende y no habla es peor que
       * uno que no atiende. */
      session.log('realtime no abrió (' + e.message + '): se degrada a TTS local');
      anotarProblemaProveedor(e.message);
      session.rtCaido = true;
      speak(session, 'Disculpá, en este momento no puedo atenderte. Te paso con una persona.')
        .then(() => doTransfer(session, session.agent.default_exten || '', 'Operador'))
        .catch(() => {});
    });
}

function handleInAudio(session, pcm) {
  /* En realtime el audio va derecho al modelo: la detección de fin de frase y el
   * barge-in los hace él, así que ni Vosk ni el VAD de acá tienen nada que decidir. */
  if (session.rt && !session.rtCaido) {
    /* Primer frame del llamante: recién con el audio ENTRANDO el modelo toma turno (ver
     * el saludo, más abajo). Se anota para no tener que adivinarlo. */
    if (!session.rtAudioEntra) { session.rtAudioEntra = Date.now(); session.log('entra audio del llamante'); }
    session.rt.enviarAudio(pcm);
    return;
  }
  const energy = rms(pcm);
  // barge-in: si el bot habla y el usuario sostiene voz, cortar TTS
  if (session.speaking) {
    if (energy > BARGE_RMS) { session.bargeMs += 20; if (session.bargeMs >= BARGE_MS) { session.speakToken++; session.speaking = false; session.log('barge-in'); } }
    else session.bargeMs = Math.max(0, session.bargeMs - 20);
  }
  // acumular para Whisper (modo openai) y alimentar Vosk (parciales)
  session.uttBuf.push(Buffer.from(pcm)); if (session.uttBuf.length > 1500) session.uttBuf.shift();
  if (session.sttProc && session.sttProc.stdin.writable) { try { session.sttProc.stdin.write(Buffer.from(pcm)); } catch (_) {} }
}

function attachStt(session) {
  const p = spawn('python3', ['/opt/pbxng-api/ai/vosk_stt.py'], { env: { ...process.env, VOSK_MODEL, VOSK_RATE: String(RATE) } });
  session.sttProc = p; let line = '';
  p.stdout.on('data', (d) => {
    line += d.toString();
    let i;
    while ((i = line.indexOf('\n')) >= 0) {
      const ln = line.slice(0, i); line = line.slice(i + 1);
      if (!ln.trim()) continue;
      let obj; try { obj = JSON.parse(ln); } catch (_) { continue; }
      if (obj.partial) { session.lastPartial = obj.partial; session.lastPartialAt = Date.now(); }   // endpoint = parcial estable
      if (obj.final && obj.final.trim() && !session.busy) { session.lastPartial = ''; onUtterance(session, obj.final.trim()); }
    }
  });
  p.stderr.on('data', () => {});
  p.on('close', () => {});
}
// reinicia el reconocedor Vosk (nueva frase) sin recargar modelo es costoso: respawn rápido
function checkEndpoint(session) {
  if (session.closed || session.busy || session.speaking) return;
  const p = (session.lastPartial || '').trim();
  if (p && Date.now() - (session.lastPartialAt || 0) > 1100) {   // parcial estable 1.1s => fin de frase
    session.lastPartial = '';
    resetStt(session);
    onUtterance(session, p);
  }
}
function resetStt(session) {
  if (session.closed) return;
  try { if (session.sttProc) session.sttProc.kill('SIGKILL'); } catch (_) {}
  session.lastPartial = '';
  attachStt(session);
}

// ============================================================
//  API pública
// ============================================================
function init(ari, pool, opts = {}) {
  ARI = ari; POOL = pool;
  if (opts.app) APP = opts.app;
  /* La IA externa se arma una sola vez: `init` se vuelve a llamar en cada reconexión de
   * ARI y los canales con el backend no dependen de ARI. */
  if (!IAX) {
    IAX = iaExterna.crear({
      agentes: async () => (await POOL.query('SELECT id,provider,enabled,externo_url,externo_token FROM pbxng_ai_agents')).rows,
      leerConfig: async (id) => {
        const { rows } = await POOL.query('SELECT version,session,attach_timeout_ms,resume_window_ms FROM pbxng_ia_externa_config WHERE agente_id=$1', [id]);
        return rows[0] ? { version: rows[0].version, session: rows[0].session, attachTimeoutMs: rows[0].attach_timeout_ms, resumeWindowMs: rows[0].resume_window_ms } : null;
      },
      guardarConfig: (id, cfg) => POOL.query(
        'INSERT INTO pbxng_ia_externa_config (agente_id,version,session,attach_timeout_ms,resume_window_ms,bajada_at) VALUES ($1,$2,$3,$4,$5,now())'
        + ' ON CONFLICT (agente_id) DO UPDATE SET version=$2,session=$3,attach_timeout_ms=$4,resume_window_ms=$5,bajada_at=now()',
        [id, cfg.version, JSON.stringify(cfg.session), cfg.attachTimeoutMs, cfg.resumeWindowMs === undefined ? iaExterna.VENTANA_DEF_MS : cfg.resumeWindowMs]),
      log: (m) => log.info(m),
    });
    IAX.recargar().catch((e) => log.warn('IA externa: no se pudieron abrir los canales', { err: e.message }));
  }
  if (opts.mediaHost) MEDIA_HOST = opts.mediaHost;
  // Esquema (pbxng_settings, columnas de pbxng_ai_agents): migrations/0009_schema_runtime.sql
  startServer();
}

async function startAiSession(channel, agent) {
  if (!ARI) { try { await channel.hangup(); } catch (_) {} return; }
  const uuid = crypto.randomUUID();
  const keys = { openai: await getSetting('openai_api_key') };
  /* Endpoint alternativo del modelo realtime (Azure, un proxy propio). Vacío = OpenAI. */
  const realtimeBase = await getSetting('realtime_url');
  const vozUrl = (await getSetting('voz_url')) || (process.env.VOZ_HOST ? 'http://' + process.env.VOZ_HOST + ':8080' : 'http://127.0.0.1:8080');
  const vozSpeed = (await getSetting('voz_length_scale')) || '1.0';
  const useOpenAI = (agent.provider === 'openai') && !!keys.openai;
  /* Tres caminos, y el agente elige: `realtime` (un socket con el modelo), `openai` (STT →
   * LLM → TTS) y el demo local. Sin clave, `realtime` no se intenta: la llamada iría a un
   * socket que va a fallar y el visitante escucharía silencio. */
  const modo = (agent.provider === 'openai-realtime' && keys.openai) ? 'realtime'
    : (agent.provider === 'ia-externa' && keys.openai) ? 'externo'
      : (useOpenAI ? 'openai' : 'demo');
  /* IA externa sin configuración o sin el backend: la llamada va al respaldo SIN abrir una
   * sesión. Atender sin nadie que conduzca la conversación es dejar al visitante mudo. */
  if (agent.provider === 'ia-externa') {
    const d = modo === 'externo' && IAX
      ? iaExterna.decidirArranque({ config: IAX.configDe(agent.id) })
      : { atender: false, motivo: keys.openai ? 'la IA externa no está inicializada' : 'no hay clave de OpenAI cargada' };
    if (!d.atender) {
      log.warn('IA externa: la llamada va al respaldo sin abrir sesión', { agente: agent.id, motivo: d.motivo });
      try {
        /* Ya pasó por el Answer() del ivr: sin el tono, el respaldo también sonaba mudo. */
        if (agent.default_exten) {
          await pedirTonoDeLlamada(channel, (m) => log.warn('IA externa: ' + m, { agente: agent.id }));
          await channel.continueInDialplan({ context: 'internal', extension: String(agent.default_exten), priority: 1 });
        } else await channel.hangup();
      } catch (e) { log.warn('IA externa: no se pudo mandar al respaldo', { err: e.message }); }
      return;
    }
  }
  /* La zona del cliente, no la del servidor: la central puede correr en UTC y el edificio
   * está en Montevideo. */
  const zona = (await getSetting('zona_horaria')) || momento.ZONA_DEF;
  /* El bloque de contexto va ANTES de lo que escribió el usuario y dice explícitamente que
   * manda sobre el saludo: si no, el modelo repite el «buenos días» que quedó escrito en el
   * texto del saludo y la hora que le pasamos no sirve de nada. */
  /* ¿Desde dónde entra la llamada? El portero es un interno o un número: se lo busca en el
   * CRM igual que hace la ficha del agente. Es el único dato de la llamada que el visitante
   * NO puede falsear, y es lo que convierte «un bot que atiende» en «la portería de este
   * edificio». Si no está cargado, la llamada sigue igual: el agente atiende sin saber de
   * dónde viene y no puede verificar a nadie. */
  let identificacion = null;
  try { identificacion = await porteria.identificarLlamante(POOL, channel.caller && channel.caller.number); }
  catch (e) { log.warn('no se pudo identificar el portero', { err: e.message }); }
  const ctxPorteria = porteria.bloqueContexto(identificacion);

  /* Lo que el agente PUEDE y lo que NO. Se arma solo desde las herramientas encendidas, y
   * va SIEMPRE: sin esto el modelo improvisa acciones que no existen — pasó en una llamada
   * real, contestó «ya le avisé» sin tener con qué avisar a nadie. */
  const capacidades = herramientas.resumenCapacidades((agent && agent.herramientas) || {});

  const instrucciones = momento.bloqueHora(new Date(), zona) + '\n\n'
    + capacidades + '\n\n'
    + (ctxPorteria ? ctxPorteria + '\n\n' : '')
    + (agent.system_prompt || 'Sos un asistente telefónico amable y conciso. Respondé en español rioplatense, en frases cortas. Si el usuario quiere un área o persona, usá transfer_call.');
  const session = {
    uuid, channel, agent, keys, useOpenAI, modo, realtimeBase, zona, identificacion,
    callerId: (channel.caller && channel.caller.number) || '', vozUrl, vozSpeed,
    history: [{ role: 'system', content: instrucciones }],
    greetingText: momento.conSaludo(
      agent.greeting_text || ('Hola, gracias por comunicarte. Soy el asistente virtual' + (agent.name ? ' de ' + agent.name : '') + '. ¿En qué puedo ayudarte?'),
      new Date(), zona),
    nacida: Date.now(),
    uttBuf: [], speaking: false, speakToken: 0, bargeMs: 0, busy: false, closed: false, _turns: 0,
    lastPartial: '', speechActive: false, speechMs: 0, silenceMs: 0,
    log: (m) => log.info(m, { session: uuid.slice(0, 8) }),
  };
  try { await channel.answer(); } catch (_) {}
  try {
    /* `video_sfu` fuerza el puente de mezcla (softmix). Con `mixing` solo, Asterisk usa el
     * puente simple de dos canales, que iguala las negociaciones: el canal de audio de la IA
     * no tiene video, así que le sacaba el video al portero con un re-INVITE (m=video 0), y la
     * derivación al agente salía sin video. El softmix no toca la negociación del portero. */
    const bridge = ARI.Bridge(); await bridge.create({ type: 'mixing,video_sfu' });
    session.bridge = bridge;
    pendingByUuid.set(uuid, session);   // registrar ANTES de crear el externalMedia (evita carrera con el handshake AudioSocket)
    const em = await ARI.channels.externalMedia({ app: APP, external_host: MEDIA_HOST + ':' + AS_PORT, format: 'slin', encapsulation: 'audiosocket', transport: 'tcp', connection_type: 'client', data: uuid });
    session.em = em;
    await bridge.addChannel({ channel: channel.id });
    await bridge.addChannel({ channel: em.id });
    session.log('sesión iniciada (modo=' + modo + ', agente=' + agent.name + ')'
      + (identificacion ? ' · portero de ' + identificacion.cliente.name + ' (' + identificacion.personas.length + ' autorizados)' : ' · llamante no identificado en el CRM'));
    // watchdog: si el caller cuelga
    session.endpointTimer = setInterval(() => checkEndpoint(session), 250);
    channel.once('StasisEnd', () => endSession(session, 'caller-hangup'));
    /* Lo que marca el visitante le llega al backend: la central no lo interpreta. */
    if (modo === 'externo') {
      session.alDtmf = (e) => avisarBackend(session, { type: 'dtmf', pbxCallId: uuid, digito: String((e && e.digit) || '') });
      channel.on('ChannelDtmfReceived', session.alDtmf);
    }
  } catch (e) {
    log.error('startAiSession', e);
    cleanupMedia(session); try { await channel.hangup(); } catch (_) {}
  }
}

/* Métricas de las sesiones de IA en curso. Lo que importa medir de un agente de voz no es
 * el uso de CPU: es cuánto silencio escucha la persona antes de que el agente conteste. */
function metricas() {
  const out = [];
  for (const s of sessions.values()) {
    out.push({ sesion: s.uuid.slice(0, 8), agente: (s.agent && s.agent.name) || '', modo: s.modo || 'demo',
      llamante: s.callerId || '', latencia: s.rt ? s.rt.metricas() : null, en_cola: s.rtCola ? s.rtCola.length : 0 });
  }
  return out;
}

/* Al guardar o borrar un agente (apps.js): abre o cierra sus canales con el backend. */
function recargarIaExterna() {
  if (!IAX) return;
  IAX.recargar().catch((e) => log.warn('IA externa: no se pudieron recargar los canales', { err: e.message }));
}

module.exports = { init, startAiSession, close, metricas, recargarIaExterna };
/* Sólo para la prueba del ORDEN de cierre (test/inactividad.test.js): lo que hay que fijar
 * es que el socket se suelte antes de tocar el canal, y eso no se ve desde afuera. */
module.exports._sesiones = () => sessions;
/* Se exportan SOLO para la prueba del tope (test/ia-topes.test.js): el camino de la
 * llamada no tolera un `fetch` sin corte, y esa prueba es la que lo deja clavado. */
/* Y para la prueba del barrido de canales colgados (test/ia-huerfanos.test.js): hace falta
 * poder ponerle un ARI de mentira y mirar a quién cuelga. */
module.exports._barrer = barrerHuerfanos;
module.exports._setAri = (x) => { ARI = x; };
module.exports._crmLookup = crmLookup;
module.exports._TOPE_CRM_MS = TOPE_CRM_MS;
/* Para la prueba del tono de llamada en la transferencia (test/ia-externa.test.js): que el
 * DIAL_OPCIONES se ponga ANTES de salir de Stasis no se ve desde afuera, y armar una sesión
 * entera con su AudioSocket para llegar a la orden de derivar es probar otra cosa. */
module.exports._doTransfer = doTransfer;
module.exports._respaldoExterno = respaldoExterno;
/* Y para las pruebas del contrato v2 (test/ia-externa-relay.test.js): por dónde sale un
 * hecho y qué hace el cierre, sin armar una llamada entera. */
module.exports._avisarBackend = avisarBackend;
module.exports._ordenesExternas = ordenesExternas;
module.exports._cerrarExterno = cerrarExterno;
module.exports._esperarOrden = esperarOrden;
module.exports._setIax = (x) => { IAX = x; };
