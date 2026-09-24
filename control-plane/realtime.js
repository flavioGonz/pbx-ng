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
const REALTIME = {
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
    /* SIN `OpenAI-Beta: realtime=v1`: esa cabecera es la que enrutaba a la API beta, que
     * OpenAI retiró. El handshake contestaba «The Realtime Beta API is no longer
     * supported. Please use /v1/realtime for the GA API» y la sesión nunca abría. La URL
     * ya era la correcta; lo que sobraba era la cabecera. */
    : { Authorization: 'Bearer ' + key }),
  /* Configuración de la sesión: voz, instrucciones, formato de audio y herramientas. */
  configurar: (o) => ({
    type: 'session.update',
    session: {
      /* Forma GA. La beta ponía `voice`, `input_audio_format: 'pcm16'` y `turn_detection`
       * sueltos en la raíz de `session`; en la GA todo eso vive bajo `audio.input` y
       * `audio.output`, el formato es un objeto con su frecuencia, y `type: 'realtime'` es
       * obligatorio. Mandar la forma vieja contra el endpoint nuevo NO falla al conectar:
       * abre la sesión, ignora la configuración, y el agente habla con otra voz o no
       * habla — el tipo de error que no se ve hasta la llamada. */
      type: 'realtime',
      instructions: o.instrucciones || '',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: RATE_MODELO },
          turn_detection: { type: 'server_vad', silence_duration_ms: 600 },
        },
        output: {
          format: { type: 'audio/pcm', rate: RATE_MODELO },
          voice: o.voz || 'alloy',
        },
      },
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


/* ── El OTRO protocolo: GPT-Live ───────────────────────────────────────────────
 * `gpt-live-1` NO es un modelo más de la Realtime API: es otra API, con otro endpoint,
 * otros nombres de evento y otra forma de arrancar la sesión. Como los dos son «un socket
 * con el modelo», el resto del archivo —el remuestreo, la cola, las métricas— sirve igual;
 * lo único que cambia es este objeto, que es exactamente para lo que estaba separado.
 *
 * Las tres diferencias que importan de verdad:
 *
 *  1. **El modelo va en el mensaje, no en la URL.** La Realtime lo lleva como `?model=`;
 *     acá la URL es fija y el modelo viaja dentro de `session.start`.
 *  2. **No hay evento de fin de respuesta ni de «empezó a hablar el usuario».** Live decide
 *     los turnos solo, mientras escucha. Para el barge-in usamos la transcripción del
 *     visitante como señal: si llega texto suyo, está hablando, y hay que tirar lo que
 *     quede por reproducir. No hace falta pedirle que pare: eso lo hace él.
 *  3. **`delegation` omitido = modo cliente**, que es lo que queremos en fase 0: el modelo
 *     conversa solo. Las herramientas (abrir portón, verificar datos) van a necesitar
 *     `delegation: 'responses'`, y por eso se arma acá abajo sólo si hay herramientas.
 */
const LIVE = {
  url: (model, base) => (base ? String(base).replace(/\/+$/, '') : 'wss://api.openai.com/v1/live/sessions'),
  cabeceras: (key, base) => (base && /azure/i.test(String(base)) ? { 'api-key': key } : { Authorization: 'Bearer ' + key }),
  configurar: (o) => {
    const session = {
      model: o.model || 'gpt-live-1',
      instructions: o.instrucciones || '',
      audio: { output: { voice: o.voz || 'marin' } },
    };
    /* Sin herramientas no se manda `delegation`: omitirlo es el modo cliente, y el modelo
     * conversa por su cuenta. Con herramientas hay que delegar en el backend de Responses,
     * que es quien las ejecuta. */
    if (o.herramientas && o.herramientas.length) {
      session.delegation = { type: 'responses', responses: { tools: o.herramientas, tool_choice: 'auto', parallel_tool_calls: false } };
    } else if (o.delegacion === 'responses') {
      /* Sin herramientas, pero delegando igual: es el segundo escalón de la prueba de
       * conexión. Sirve para distinguir «la cuenta no puede hablar» de «en modo cliente
       * este modelo espera otra cosa», que desde afuera se ven idénticos. */
      session.delegation = { type: 'responses', responses: {} };
    }
    return { type: 'session.start', session };
  },
  audioEntra: (b64) => ({ type: 'session.input_audio.append', audio: b64 }),
  /* Live corta solo cuando el visitante habla: no hay nada que mandarle. */
  cancelar: () => null,
  /* No hay `response.create` en modo cliente. Lo que hace hablar primero al agente es
   * inyectarle texto para decir. */
  saludar: (texto) => ({ type: 'session.commentary.append', content: texto, delegation_id: null }),
  respuestaHerramienta: (callId, salida) => ({
    type: 'response.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(salida) },
  }),
  pedirRespuesta: () => ({ type: 'response.create' }),
  leer(m) {
    const t = String(m.type || '');
    if (t === 'session.output_audio.delta') return { clase: 'audio', b64: m.delta };
    if (t === 'session.output_transcript.delta') return { clase: 'texto_bot', texto: m.delta };
    /* Texto del visitante = el visitante está hablando. Es la única señal de barge-in que
     * da esta API, así que hace las dos cosas: caption y corte. */
    if (t === 'session.input_transcript.delta') return { clase: 'texto_usuario', texto: m.delta, corta: true };
    if (t === 'session.started') return { clase: 'arranco', tipo: t };
    if (t === 'session.closed') return { clase: 'fin_respuesta' };
    if (t === 'response.event' && m.event) return LIVE.leer(m.event);
    if (t === 'response.output_item.done' && m.item && m.item.type === 'function_call') {
      return { clase: 'herramienta', call_id: m.item.call_id, nombre: m.item.name, args: m.item.arguments };
    }
    if (t === 'error') return { clase: 'error', detalle: (m.error && m.error.message) || 'error del proveedor' };
    return { clase: 'otro', tipo: t };
  },
};

/* Qué API habla cada modelo. Se decide por el identificador porque es el único dato que
 * hay antes de conectar, y porque es lo que el usuario escribe en el panel. */
function elegirProtocolo(model) {
  return /^gpt-live/i.test(String(model || '')) ? LIVE : REALTIME;
}
/* Compatibilidad: el resto del código (y las pruebas) piden `PROTOCOLO` por la Realtime. */
const PROTOCOLO = REALTIME;

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
  const P = o.protocolo || elegirProtocolo(o.model);
  ev.api = P === LIVE ? 'live' : 'realtime';
  const url = o.url || P.url(o.model || 'gpt-realtime-2.1-mini', o.base);
  const ws = new WS(url, o.subprotocolos || undefined, { headers: o.key ? P.cabeceras(o.key, o.base) : undefined });

  /* Métricas: el número que decide si esto es viable no es el costo, es cuánto tarda en
   * empezar a hablar. Se mide desde que el usuario deja de hablar hasta el primer byte de
   * audio del modelo, que es exactamente el silencio que escucha la persona. */
  const m = { turnos: 0, primer_audio_ms: [], ultimo_ms: null, abierto_at: Date.now() };
  let esperandoDesde = null;

  /* `listo` es un ESTADO, no sólo un evento: el socket puede abrir antes de que quien
   * llamó a `abrir()` alcance a suscribirse, y entonces el que espera el evento espera
   * para siempre. Con la bandera y `cuandoListo()` no hay carrera posible. */
  ev.listo = false;
  /* Diario de lo que mandó el proveedor. No es para depurar de a ratos: cuando una sesión
   * abre y NO habla —el peor síntoma, porque no hay error en ningún lado— lo único que
   * contesta la pregunta es qué eventos llegaron. La prueba del panel lo muestra. */
  ev.eventos = {};
  const anotar = (t) => { ev.eventos[t] = (ev.eventos[t] || 0) + 1; };

  /* Lo que se manda ANTES de que la sesión esté configurada se guarda. En la Realtime el
   * socket abierto ya alcanza; en Live hay que esperar `session.started`, y un saludo
   * mandado un milisegundo antes se descarta en silencio: el agente atiende y no habla. */
  const pendientes = [];
  const marcarListo = () => {
    if (ev.listo) return;
    ev.listo = true;
    while (pendientes.length) { try { ws.send(JSON.stringify(pendientes.shift())); } catch (_) {} }
    ev.emit('listo');
  };
  ws.on('open', () => {
    ws.send(JSON.stringify(P.configurar(o)));
    if (P !== LIVE) return marcarListo();
    /* Red de seguridad: si el proveedor no manda `session.started` (o le cambia el nombre),
     * igual se sigue — mejor intentar hablar que quedarse esperando para siempre. */
    setTimeout(marcarListo, o.topeArranque || 3000).unref?.();
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
    anotar(String(msg.type || '?'));
    const r = P.leer(msg);
    switch (r.clase) {
      case 'arranco': marcarListo(); break;
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
      case 'texto_usuario':
        if (r.texto) ev.emit('texto', { quien: 'visitante', texto: r.texto });
        /* En Live no hay evento de «empezó a hablar»: su transcripción ES la señal. Se
         * tira lo que quede por reproducir; pedirle que pare no hace falta, corta solo. */
        if (r.corta) { ev.emit('corte'); esperandoDesde = Date.now(); }
        break;
      case 'habla_usuario':
        /* El usuario arrancó a hablar: se avisa para tirar la cola de reproducción y se le
         * pide al modelo que deje de generar. Las dos cosas, siempre. */
        ev.emit('corte');
        try { const c = P.cancelar(); if (c) ws.send(JSON.stringify(c)); } catch (_) {}
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

  const enviar = (obj) => {
    if (!obj) return;
    if (!ev.listo) { pendientes.push(obj); return; }
    try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {}
  };

  ev.enviarAudio = (pcm8) => { if (pcm8 && pcm8.length) enviar(P.audioEntra(subir(pcm8).toString('base64'))); };
  ev.saludar = (texto) => { esperandoDesde = Date.now(); enviar(P.saludar(texto)); };
  ev.responderHerramienta = (callId, salida) => { enviar(P.respuestaHerramienta(callId, salida)); enviar(P.pedirRespuesta()); };
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
  const live = /^gpt-live/i.test(String(o.model || ''));
  /* Escalones. En la Realtime alcanza con pedirle que hable. En Live el modelo contesta al
   * AUDIO del visitante —es una conversación continua, no un pedido-respuesta—, así que:
   *   1. se le manda silencio continuo, como en una llamada de verdad, y el saludo;
   *   2. si no habla, se reintenta delegando en el backend de Responses.
   * Los dos casos se ven idénticos desde afuera (sesión abierta, cero audio) y se arreglan
   * en lugares distintos, así que la prueba los separa sola en vez de hacerte adivinar. */
  const escalones = live
    ? [{ nombre: 'modo cliente', delegacion: null }, { nombre: 'delegando en Responses', delegacion: 'responses' }]
    : [{ nombre: 'realtime', delegacion: null }];

  let ultimo = null;
  const historia = [];
  for (const esc of escalones) {
    const r = await unIntento(o, esc, live);
    historia.push({ intento: esc.nombre, ok: r.ok, error: r.error, eventos: r.eventos });
    ultimo = r;
    if (r.ok) break;
  }
  ultimo.intentos = historia;
  if (!ultimo.ok && historia.length > 1) {
    ultimo.error = 'El modelo abrió la sesión pero no habló en ninguno de los dos modos. '
      + 'Probado: ' + historia.map((h) => h.intento).join(' y ') + '. ' + (ultimo.error || '');
  }
  return ultimo;
}

/* Un escalón: abre, saluda como corresponda, y espera audio. */
async function unIntento(o, esc, live) {
  const t0 = Date.now();
  const r = { ok: false, model: o.model || null, voz: o.voz || null, modo: esc.nombre,
    abrio_ms: null, primer_audio_ms: null, bytes_audio: 0, texto: '', error: null };
  let ev = null, reloj = null;
  try {
    ev = abrir({ url: o.url, base: o.base, key: o.key, model: o.model, voz: o.voz,
      delegacion: esc.delegacion, WebSocketImpl: o.WebSocketImpl,
      instrucciones: 'Sos una prueba de conexión. Respondé con una sola frase corta en español.' });
    await ev.cuandoListo(o.topeAbrir || 10000);
    r.abrio_ms = Date.now() - t0;

    const t1 = Date.now();
    await new Promise((ok, fail) => {
      const tope = setTimeout(() => fail(new Error('la sesión abrió (' + esc.nombre + ') pero el modelo no mandó audio en '
        + Math.round((o.topeAudio || 12000) / 1000) + ' s')), o.topeAudio || 12000);
      const terminar = (fn, arg) => { clearTimeout(tope); if (reloj) clearInterval(reloj); fn(arg); };
      ev.on('audio', (pcm) => {
        r.bytes_audio += pcm.length;
        if (r.primer_audio_ms === null) { r.primer_audio_ms = Date.now() - t1; terminar(ok); }
      });
      ev.on('texto', (t) => { if (t && t.quien === 'agente' && t.texto) r.texto += t.texto; });
      ev.once('error', (e) => terminar(fail, new Error(String(e))));

      /* Live espera una llamada, no una consulta: si no le entra audio, no hay turno que
       * tomar. Se le manda silencio al ritmo del canal —20 ms cada 20 ms— igual que haría
       * Asterisk, y recién entonces el saludo. */
      if (live) {
        const silencio = Buffer.alloc(160 * 2);
        reloj = setInterval(() => { try { ev.enviarAudio(silencio); } catch (_) {} }, 20);
        if (reloj.unref) reloj.unref();
        setTimeout(() => ev.saludar('Decí, en español: listo, la conexión funciona.'), 400);
      } else {
        ev.saludar('Decí, en español: listo, la conexión funciona.');
      }
    });
    await new Promise((ok) => setTimeout(ok, o.colaMs === undefined ? 600 : o.colaMs));
    r.ok = true;
  } catch (e) {
    r.error = String((e && e.message) || e);
  } finally {
    if (reloj) clearInterval(reloj);
    try { if (ev) ev.cerrar(); } catch (_) {}
  }
  r.total_ms = Date.now() - t0;
  r.api = ev && ev.api;
  r.eventos = (ev && ev.eventos) || {};
  return r;
}

module.exports = { abrir, probar, elegirProtocolo, REALTIME, LIVE, subir, creaBajador, explicar, PROTOCOLO, RATE_TEL, RATE_MODELO };
