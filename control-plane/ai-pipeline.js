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

const AS_PORT = 9092;                 // puerto AudioSocket (TCP)
const VOSK_MODEL = '/opt/vosk-model-es';
const RATE = 8000;                    // slin (8kHz telefonia) - el canal AudioSocket reproduce a 8k
const FRAME_BYTES = 320;              // 20ms @ 8kHz 16-bit
const BARGE_RMS = 600;                // umbral energia para barge-in
const BARGE_MS = 280;                 // ms de voz sostenida para cortar TTS
const SPEECH_RMS = 500;               // umbral de voz para VAD
const END_SILENCE_MS = 750;           // silencio que cierra una frase

let ARI = null, POOL = null, APP = 'pbxng', MEDIA_HOST = '172.26.20.185';
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
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: voice && /^(alloy|echo|fable|onyx|nova|shimmer)$/.test(voice) ? voice : 'nova', input: text, response_format: 'wav' }),
    });
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
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key }, body: form });
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
async function neuralTTS(text, vozUrl, voice) {
  try {
    const r = await fetch(vozUrl + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, rate: RATE }) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length ? buf : null;
  } catch (_) { return null; }
}
async function neuralSTT(pcm, vozUrl) {
  try {
    const r = await fetch(vozUrl + '/stt?rate=' + RATE, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm });
    if (!r.ok) return '';
    const j = await r.json(); return (j.text || '').trim();
  } catch (_) { return ''; }
}
// --- LLM OpenAI chat con tools ---
async function openaiLLM(messages, tools, model, key) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, tools, tool_choice: 'auto', temperature: 0.4 }),
  });
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
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, caller: session.callerId, agent: session.agent.name }) });
    const j = await r.json().catch(() => ({}));
    return (j.result || j.text || j.message || 'No encontré datos para esa consulta.');
  } catch (_) { return 'No pude consultar el CRM en este momento.'; }
}

// ============================================================
//  Reproducción de TTS (con barge-in)
// ============================================================
async function speak(session, text) {
  if (!text || !session.socket || session.closed) return;
  session.log('TTS> ' + text);
  let pcm = null;
  if (session.useOpenAI && session.keys.openai) pcm = await openaiTTS(text, session.agent.voice, session.keys.openai);
  if ((!pcm || !pcm.length) && session.vozUrl) pcm = await neuralTTS(text, session.vozUrl, session.agent.voice);
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
async function doTransfer(session, dest, label) {
  session.log('TRANSFER -> ' + dest + ' (' + (label || '') + ')');
  const ch = session.channel;
  // marcar cerrada ANTES de salir de Stasis: el continueInDialplan dispara StasisEnd
  // y sin esto endSession() colgaria el canal deshaciendo la transferencia.
  session.transferring = true; session.closed = true;
  try { if (session.endpointTimer) clearInterval(session.endpointTimer); } catch (_) {}
  try { if (session.sttProc) session.sttProc.kill('SIGKILL'); } catch (_) {}
  try { if (session.em) ARI.channels.hangup({ channelId: session.em.id }).catch(() => {}); } catch (_) {}
  try { if (session.bridge) session.bridge.destroy().catch(() => {}); } catch (_) {}
  try { await ch.continueInDialplan({ context: 'internal', extension: String(dest), priority: 1 }); }
  catch (e) { session.log('transfer err ' + e.message); try { await ch.hangup(); } catch (_) {} }
  if (session.socket) { try { session.socket.end(); } catch (_) {} }
  sessions.delete(session.uuid); pendingByUuid.delete(session.uuid);
}
function cleanupMedia(session) {
  try { if (session.sttProc) session.sttProc.kill('SIGKILL'); } catch (_) {}
  try { if (session.em) ARI.channels.hangup({ channelId: session.em.id }).catch(() => {}); } catch (_) {}
  try { if (session.bridge) session.bridge.destroy().catch(() => {}); } catch (_) {}
}
async function endSession(session, why) {
  if (session.closed) return;
  session.log('END (' + why + ')');
  cleanupMedia(session);
  try { await session.channel.hangup(); } catch (_) {}
  finalize(session);
}
function finalize(session) {
  session.closed = true;
  try { if (session.endpointTimer) clearInterval(session.endpointTimer); } catch (_) {}
  if (session.socket) { try { session.socket.end(); } catch (_) {} }
  sessions.delete(session.uuid); pendingByUuid.delete(session.uuid);
}

// ============================================================
//  Servidor AudioSocket
// ============================================================
function startServer() {
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
          attachStt(session);
          session.log('AudioSocket conectado');
          setTimeout(() => { if (!session.closed) speak(session, session.greetingText); }, 250);
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
  srv.listen(AS_PORT, '0.0.0.0', () => console.log('[AI] AudioSocket escuchando en :' + AS_PORT));
}

function handleInAudio(session, pcm) {
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
  if (opts.mediaHost) MEDIA_HOST = opts.mediaHost;
  POOL.query("CREATE TABLE IF NOT EXISTS pbxng_settings (key text PRIMARY KEY, value text)").catch(() => {});
  POOL.query("ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS sales_exten text").catch(() => {});
  POOL.query("ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS support_exten text").catch(() => {});
  POOL.query("ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS default_exten text").catch(() => {});
  POOL.query("ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS crm_webhook text").catch(() => {});
  POOL.query("ALTER TABLE pbxng_ai_agents ADD COLUMN IF NOT EXISTS greeting_text text").catch(() => {});
  startServer();
}

async function startAiSession(channel, agent) {
  if (!ARI) { try { await channel.hangup(); } catch (_) {} return; }
  const uuid = crypto.randomUUID();
  const keys = { openai: await getSetting('openai_api_key') };
  const vozUrl = (await getSetting('voz_url')) || 'http://172.26.20.219:8080';
  const useOpenAI = (agent.provider === 'openai') && !!keys.openai;
  const session = {
    uuid, channel, agent, keys, useOpenAI,
    callerId: (channel.caller && channel.caller.number) || '', vozUrl,
    history: [{ role: 'system', content: (agent.system_prompt || 'Sos un asistente telefónico amable y conciso. Respondé en español rioplatense, en frases cortas. Si el usuario quiere un área o persona, usá transfer_call.') }],
    greetingText: agent.greeting_text || ('Hola, gracias por comunicarte. Soy el asistente virtual' + (agent.name ? ' de ' + agent.name : '') + '. ¿En qué puedo ayudarte?'),
    uttBuf: [], speaking: false, speakToken: 0, bargeMs: 0, busy: false, closed: false, _turns: 0,
    lastPartial: '', speechActive: false, speechMs: 0, silenceMs: 0,
    log: (m) => console.log('[AI ' + uuid.slice(0, 8) + '] ' + m),
  };
  try { await channel.answer(); } catch (_) {}
  try {
    const bridge = ARI.Bridge(); await bridge.create({ type: 'mixing' });
    session.bridge = bridge;
    pendingByUuid.set(uuid, session);   // registrar ANTES de crear el externalMedia (evita carrera con el handshake AudioSocket)
    const em = await ARI.channels.externalMedia({ app: APP, external_host: MEDIA_HOST + ':' + AS_PORT, format: 'slin', encapsulation: 'audiosocket', transport: 'tcp', connection_type: 'client', data: uuid });
    session.em = em;
    await bridge.addChannel({ channel: channel.id });
    await bridge.addChannel({ channel: em.id });
    session.log('sesión iniciada (provider=' + (useOpenAI ? 'openai' : (vozUrl ? 'neural' : 'demo')) + ', agente=' + agent.name + ')');
    // watchdog: si el caller cuelga
    session.endpointTimer = setInterval(() => checkEndpoint(session), 250);
    channel.once('StasisEnd', () => endSession(session, 'caller-hangup'));
  } catch (e) {
    console.error('[AI] startAiSession error', e.message);
    cleanupMedia(session); try { await channel.hangup(); } catch (_) {}
  }
}

module.exports = { init, startAiSession };
