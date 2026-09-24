'use strict';
/* ============================================================================
 *  PBX-NG · Puente a un modelo de voz REALTIME (audio entra / audio sale).
 *
 *  QUÉ CAMBIA RESPECTO DEL PIPELINE DE TRES PASOS
 *  ----------------------------------------------
 *  `ai-pipeline.js` hace STT → LLM → TTS: tres llamadas de red por turno, y la latencia
 *  se suma. En una conversación de portería —el visitante dice tres palabras y espera— eso
 *  se nota. Un modelo realtime reemplaza los tres por UN socket: se le manda el audio del
 *  llamante y devuelve el audio de la respuesta, con la detección de fin de frase de su
 *  lado.
 *
 *  Este archivo es SÓLO el puente. No decide nada de producto: no sabe de porteros, ni de
 *  colas, ni de abrir puertas. Recibe audio de 8 kHz, devuelve audio de 8 kHz, y avisa
 *  cuando el modelo quiere usar una herramienta. Quien decide si esa herramienta se puede
 *  usar es el que lo instancia.
 *
 *  LOS TRES PROBLEMAS REALES, Y CÓMO SE RESUELVEN ACÁ
 *  ---------------------------------------------------
 *  1. **Las tasas de muestreo no coinciden.** La telefonía es 8 kHz (slin); estos modelos
 *     hablan PCM16 a 24 kHz. Es exactamente 1:3, así que el remuestreo es barato y sin
 *     bibliotecas: al subir, interpolación lineal; al bajar, promedio de a tres muestras
 *     —que además hace de filtro y evita el aliasing que suena a metálico—. Hacerlo mal se
 *     escucha enseguida: un factor equivocado da la voz de dibujito o en cámara lenta.
 *  2. **El modelo manda audio a ráfagas y el canal consume 20 ms cada 20 ms.** Si se
 *     escribe todo lo que llega, se desborda; si se espera a tenerlo entero, se pierde la
 *     latencia que se vino a ganar. Por eso acá hay una COLA y quien la vacía es el que
 *     tiene el socket con Asterisk, al ritmo del canal. Este módulo no escribe en el canal.
 *  3. **Barge-in.** Cuando el visitante interrumpe, hay que tirar lo que quedaba por
 *     reproducir Y avisarle al modelo que deje de generar. Las dos cosas: si sólo se tira
 *     la cola, el modelo sigue hablando solo y la factura corre; si sólo se cancela, el
 *     llamante sigue escuchando la frase vieja unos segundos.
 *
 *  LO QUE HAY QUE MIRAR CONTRA LA DOCUMENTACIÓN DEL PROVEEDOR
 *  -----------------------------------------------------------
 *  Los nombres de los eventos del protocolo y el identificador del modelo CAMBIAN. Están
 *  todos juntos en `PROTOCOLO`, abajo, y en ningún otro lado: cuando el proveedor mueva
 *  algo, se toca ese objeto y nada más. El identificador del modelo NO se escribe acá: es
 *  un ajuste por agente (`pbxng_ai_agents.model`), porque el día que retiren el que
 *  estamos usando tiene que ser un cambio en el panel y no un release.
 * ==========================================================================*/
const EventEmitter = require('events');

const RATE_TEL = 8000;          // slin de Asterisk
const RATE_MODELO = 24000;      // PCM16 del modelo
const FACTOR = RATE_MODELO / RATE_TEL;   // 3, exacto

/* ── Remuestreo ────────────────────────────────────────────────────────────────
 * Int16 LE en los dos sentidos. Se mantiene el resto entre llamadas (`sobra`) porque los
 * frames no caen siempre en múltiplos de 3 muestras y perder una por frame, 50 veces por
 * segundo, es un chasquido audible. */
function subir(buf) {
  const n = buf.length >> 1;
  const out = Buffer.alloc(n * FACTOR * 2);
  let prev = n ? buf.readInt16LE(0) : 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    for (let k = 0; k < FACTOR; k++) {
      /* Interpolación lineal entre la muestra anterior y esta: un `repeat` simple mete
       * escalones que en voz se escuchan como aspereza. */
      const m = Math.round(prev + ((v - prev) * (k + 1)) / FACTOR);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, m)), (i * FACTOR + k) * 2);
    }
    prev = v;
  }
  return out;
}

function creaBajador() {
  let sobra = Buffer.alloc(0);
  return function bajar(buf) {
    const d = sobra.length ? Buffer.concat([sobra, buf]) : buf;
    const muestras = d.length >> 1;
    const salen = Math.floor(muestras / FACTOR);
    const out = Buffer.alloc(salen * 2);
    for (let i = 0; i < salen; i++) {
      let s = 0;
      for (let k = 0; k < FACTOR; k++) s += d.readInt16LE((i * FACTOR + k) * 2);
      out.writeInt16LE(Math.round(s / FACTOR), i * 2);
    }
    sobra = d.slice(salen * FACTOR * 2);
    return out;
  };
}

/* ── Protocolo del proveedor, en un solo lugar ─────────────────────────────────
 * Todo lo que puede cambiar cuando el proveedor publique una versión nueva está acá. */
const PROTOCOLO = {
  /* `base` sale de un ajuste del panel (`realtime_url`), vacío por defecto. Existe por dos
   * motivos concretos: el mismo modelo se sirve desde Azure —donde están los créditos de
   * Microsoft for Startups, que es la forma realista de probar esto sin poner plata— y
   * porque una central on-prem puede tener que salir por un proxy propio. Cambiar de
   * endpoint NO puede ser un release. */
  url: (model, base) => (base
    ? String(base).replace(/\/+$/, '') + (String(base).includes('?') ? '&' : '?') + 'model=' + encodeURIComponent(model)
    : 'wss://api.openai.com/v1/realtime?model=' + encodeURIComponent(model)),
  cabeceras: (key, base) => (base && /azure/i.test(String(base))
    /* Azure autentica con `api-key`, no con Bearer. Es la única diferencia de handshake. */
    ? { 'api-key': key }
    : { Authorization: 'Bearer ' + key, 'OpenAI-Beta': 'realtime=v1' }),
  /* Configuración de la sesión: voz, instrucciones, formato de audio y herramientas. */
  configurar: (o) => ({
    type: 'session.update',
    session: {
      modalities: ['audio', 'text'],
      voice: o.voz || 'alloy',
      instructions: o.instrucciones || '',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      turn_detection: { type: 'server_vad', silence_duration_ms: 600 },
      tools: o.herramientas || [],
    },
  }),
  audioEntra: (b64) => ({ type: 'input_audio_buffer.append', audio: b64 }),
  cancelar: () => ({ type: 'response.cancel' }),
  saludar: (texto) => ({ type: 'response.create', response: { instructions: texto } }),
  respuestaHerramienta: (callId, salida) => ({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(salida) },
  }),
  pedirRespuesta: () => ({ type: 'response.create' }),
  /* Clasificación de lo que llega. Devuelve { clase, ... } y el resto del archivo no sabe
   * nada de los nombres de eventos. */
  leer(m) {
    const t = String(m.type || '');
    if (t === 'response.audio.delta' || t === 'response.output_audio.delta') return { clase: 'audio', b64: m.delta };
    if (t === 'response.audio_transcript.delta' || t === 'response.output_audio_transcript.delta') return { clase: 'texto_bot', texto: m.delta };
    if (t === 'conversation.item.input_audio_transcription.completed') return { clase: 'texto_usuario', texto: m.transcript };
    if (t === 'input_audio_buffer.speech_started') return { clase: 'habla_usuario' };
    if (t === 'response.done' || t === 'response.output_audio.done') return { clase: 'fin_respuesta' };
    if (t === 'response.function_call_arguments.done') return { clase: 'herramienta', call_id: m.call_id, nombre: m.name, args: m.arguments };
    if (t === 'error') return { clase: 'error', detalle: (m.error && m.error.message) || 'error del proveedor' };
    return { clase: 'otro', tipo: t };
  },
};

/* ── Por qué NO abrió ──────────────────────────────────────────────────────────
 * Un `ws` que no logra el 101 emite `Unexpected server response: 401` y nada más. Ese
 * texto es inútil para quien mira el panel: las dos causas más frecuentes —la clave no
 * sirve y el identificador del modelo no existe para esa cuenta— se arreglan en lugares
 * distintos, y el cuerpo de la respuesta HTTP, que sí lo dice, se descartaba. Acá se lee
 * ese cuerpo y se traduce el status a la acción concreta que hay que hacer.
 *
 * Importa especialmente para el identificador del modelo: cada vez que el proveedor
 * renombra o retira uno, el síntoma es este 404 y no un error de audio. */
function explicar(status, cuerpo, model) {
  const detalle = String(cuerpo || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const m = model ? ' «' + model + '»' : '';
  if (status === 401 || status === 403) {
    return 'HTTP ' + status + ': el proveedor rechazó la clave. Revisá la clave de OpenAI en el panel '
      + '(Agentes IA → Proveedor de IA); si la rotaste, hay que volver a cargarla.'
      + (detalle ? ' — ' + detalle : '');
  }
  if (status === 404 || status === 400) {
    return 'HTTP ' + status + ': el modelo' + m + ' no existe para esta cuenta, o el nombre cambió. '
      + 'El identificador del modelo es un campo del agente: corregilo ahí, no hace falta actualizar la central.'
      + (detalle ? ' — ' + detalle : '');
  }
  if (status === 429) return 'HTTP 429: la cuenta no tiene cupo o saldo para sesiones realtime.' + (detalle ? ' — ' + detalle : '');
  if (status >= 500) return 'HTTP ' + status + ': el proveedor está con problemas; no es la configuración.' + (detalle ? ' — ' + detalle : '');
  return 'HTTP ' + status + (detalle ? ': ' + detalle : '');
}

/**
 * Abre el puente. Devuelve un EventEmitter con:
 *   'audio'   (pcm8)   audio del modelo, YA a 8 kHz, listo para el canal
 *   'texto'   ({quien, texto})   transcripción, para la evidencia
 *   'herramienta' ({call_id, nombre, args})
 *   'corte'   ()       el usuario interrumpió: hay que tirar lo que quede por reproducir
 *   'listo'   ()       sesión configurada
 *   'error'   (msg)
 * Métodos: enviarAudio(pcm8), responderHerramienta(call_id, salida), saludar(texto),
 *          metricas(), cerrar().
 */
function abrir(opts) {
  const o = opts || {};
  const ev = new EventEmitter();
  const bajar = creaBajador();
  const WS = o.WebSocketImpl || require('ws');
  const url = o.url || PROTOCOLO.url(o.model || 'gpt-realtime-2.1-mini', o.base);
  const ws = new WS(url, o.subprotocolos || undefined, { headers: o.key ? PROTOCOLO.cabeceras(o.key, o.base) : undefined });

  /* Métricas: el número que decide si esto es viable no es el costo, es cuánto tarda en
   * empezar a hablar. Se mide desde que el usuario deja de hablar hasta el primer byte de
   * audio del modelo, que es exactamente el silencio que escucha la persona. */
  const m = { turnos: 0, primer_audio_ms: [], ultimo_ms: null, abierto_at: Date.now() };
  let esperandoDesde = null;

  /* `listo` es un ESTADO, no sólo un evento: el socket puede abrir antes de que quien
   * llamó a `abrir()` alcance a suscribirse, y entonces el que espera el evento espera
   * para siempre. Con la bandera y `cuandoListo()` no hay carrera posible. */
  ev.listo = false;
  ws.on('open', () => {
    ws.send(JSON.stringify(PROTOCOLO.configurar(o)));
    ev.listo = true;
    ev.emit('listo');
  });
  ev.cuandoListo = (ms) => new Promise((ok, fail) => {
    if (ev.listo) return ok();
    const t = setTimeout(() => fail(new Error('el modelo no abrió la sesión a tiempo')), ms || 10000);
    ev.once('listo', () => { clearTimeout(t); ok(); });
    ev.once('error', (e) => { clearTimeout(t); fail(new Error(String(e))); });
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (_) { return; }
    const r = PROTOCOLO.leer(msg);
    switch (r.clase) {
      case 'audio': {
        if (esperandoDesde) {
          const ms = Date.now() - esperandoDesde;
          m.primer_audio_ms.push(ms); m.ultimo_ms = ms; m.turnos++;
          if (m.primer_audio_ms.length > 50) m.primer_audio_ms.shift();
          esperandoDesde = null;
        }
        const pcm24 = Buffer.from(r.b64 || '', 'base64');
        if (pcm24.length) ev.emit('audio', bajar(pcm24));
        break;
      }
      case 'texto_bot': if (r.texto) ev.emit('texto', { quien: 'agente', texto: r.texto }); break;
      case 'texto_usuario': if (r.texto) ev.emit('texto', { quien: 'visitante', texto: r.texto }); break;
      case 'habla_usuario':
        /* El usuario arrancó a hablar: se avisa para tirar la cola de reproducción y se le
         * pide al modelo que deje de generar. Las dos cosas, siempre. */
        ev.emit('corte');
        try { ws.send(JSON.stringify(PROTOCOLO.cancelar())); } catch (_) {}
        esperandoDesde = Date.now();
        break;
      case 'fin_respuesta': ev.emit('fin'); break;
      case 'herramienta': ev.emit('herramienta', { call_id: r.call_id, nombre: r.nombre, args: r.args }); break;
      case 'error': ev.emit('error', r.detalle); break;
      default: break;
    }
  });

  /* Handshake fallido: `ws` avisa por acá ANTES de emitir 'error', y es la única
   * oportunidad de leer el cuerpo de la respuesta, que es donde el proveedor dice qué
   * está mal. Sin esto, un modelo mal escrito y una clave vencida se ven igual. */
  ws.on('unexpected-response', (_req, resp) => {
    let cuerpo = '';
    resp.on('data', (c) => { if (cuerpo.length < 1000) cuerpo += String(c); });
    const avisar = () => { ev.handshake = { status: resp.statusCode }; ev.emit('error', explicar(resp.statusCode, cuerpo, o.model)); };
    resp.on('end', avisar);
    resp.on('error', avisar);
    /* Si el proveedor deja la respuesta abierta, igual hay que contestar. */
    setTimeout(() => { if (!ev.handshake) avisar(); }, 2000).unref?.();
  });
  ws.on('error', (e) => { if (!ev.handshake) ev.emit('error', String((e && e.message) || e)); });
  ws.on('close', () => ev.emit('cerrado'));

  const enviar = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} };

  ev.enviarAudio = (pcm8) => { if (pcm8 && pcm8.length) enviar(PROTOCOLO.audioEntra(subir(pcm8).toString('base64'))); };
  ev.saludar = (texto) => { esperandoDesde = Date.now(); enviar(PROTOCOLO.saludar(texto)); };
  ev.responderHerramienta = (callId, salida) => { enviar(PROTOCOLO.respuestaHerramienta(callId, salida)); enviar(PROTOCOLO.pedirRespuesta()); };
  ev.metricas = () => {
    const a = m.primer_audio_ms;
    const orden = [...a].sort((x, y) => x - y);
    return {
      turnos: m.turnos,
      ultimo_ms: m.ultimo_ms,
      mediana_ms: orden.length ? orden[Math.floor(orden.length / 2)] : null,
      peor_ms: orden.length ? orden[orden.length - 1] : null,
      segundos_abierto: Math.round((Date.now() - m.abierto_at) / 1000),
    };
  };
  ev.cerrar = () => { try { ws.close(); } catch (_) {} };
  return ev;
}


/* ── Prueba de conexión de punta a punta ───────────────────────────────────────
 * Lo que responde esta función es la única pregunta que importa antes de la primera
 * llamada de verdad: **con esta clave, este identificador de modelo y esta voz, el
 * proveedor abre la sesión y devuelve audio.** Tres cosas que hoy sólo se descubrían
 * marcando el interno y escuchando silencio.
 *
 * Se pide que HABLE, no sólo que abra el socket: un modelo puede aceptar la conexión y
 * rechazar la voz, y eso, en una llamada, es un agente que atiende y no dice nada. El
 * costo es de un par de segundos de sesión.
 *
 * La clave NO se guarda ni se escribe en el log: entra por parámetro desde el ajuste del
 * panel y se va con la función.
 */
async function probar(opts) {
  const o = opts || {};
  const t0 = Date.now();
  const r = { ok: false, model: o.model || null, voz: o.voz || null, abrio_ms: null, primer_audio_ms: null, bytes_audio: 0, texto: '', error: null };
  let ev = null;
  try {
    ev = abrir({ url: o.url, base: o.base, key: o.key, model: o.model, voz: o.voz, WebSocketImpl: o.WebSocketImpl,
      instrucciones: 'Sos una prueba de conexión. Respondé con una sola frase corta en español.' });
    await ev.cuandoListo(o.topeAbrir || 10000);
    r.abrio_ms = Date.now() - t0;

    const t1 = Date.now();
    await new Promise((ok, fail) => {
      const tope = setTimeout(() => fail(new Error('la sesión abrió pero el modelo no mandó audio en '
        + Math.round((o.topeAudio || 15000) / 1000) + ' s: revisá que la voz «' + (o.voz || 'alloy') + '» exista para este modelo')), o.topeAudio || 15000);
      ev.on('audio', (pcm) => {
        r.bytes_audio += pcm.length;
        if (r.primer_audio_ms === null) { r.primer_audio_ms = Date.now() - t1; clearTimeout(tope); ok(); }
      });
      ev.on('texto', (t) => { if (t && t.quien === 'agente' && t.texto) r.texto += t.texto; });
      ev.once('error', (e) => { clearTimeout(tope); fail(new Error(String(e))); });
      ev.saludar('Decí, en español: listo, la conexión funciona.');
    });
    /* Un ratito más para juntar algo de transcripción y poder mostrar qué dijo. */
    await new Promise((ok) => setTimeout(ok, o.colaMs === undefined ? 600 : o.colaMs));
    r.ok = true;
  } catch (e) {
    r.error = String((e && e.message) || e);
  } finally {
    try { if (ev) ev.cerrar(); } catch (_) {}
  }
  r.total_ms = Date.now() - t0;
  return r;
}

module.exports = { abrir, probar, subir, creaBajador, explicar, PROTOCOLO, RATE_TEL, RATE_MODELO };
