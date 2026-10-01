/* ============================================================================
 *  IA EXTERNA: el agente lo conduce otro sistema (el backend del asistente de voz).
 *
 *  La central NO sabe de negocio en este perfil: atiende, pone el audio y ejecuta
 *  órdenes de telefonía. Todo lo demás —qué decir, cuándo verificar, abrir, derivar o
 *  cortar— lo decide el backend. Por eso este módulo tiene tres piezas y ninguna lógica
 *  de conversación (contrato v2):
 *
 *   · la CONFIGURACIÓN de la sesión, que el backend publica y acá se baja y se guarda.
 *     Se usa tal cual en el `session.start`: sin prompt, saludo ni herramientas nuestras;
 *   · el CANAL DE CONTROL, un WebSocket por backend: solo el latido y la orden de volver a
 *     bajar la configuración (`refrescar_config`);
 *   · el RELAY de cada llamada, y todo lo de esa llamada va por ahí: el aviso de la llamada
 *     (primer mensaje), los eventos de la sesión de GPT-Live tal cual, los hechos (colgó,
 *     DTMF, resultado de una transferencia), las órdenes del backend (colgar, transferir,
 *     mandar un DTMF) y los comandos del backend hacia la sesión. Existe porque a una sesión
 *     abierta por WebSocket el backend no se puede enganchar por el sideband de OpenAI (da
 *     404): la central le hace de sideband.
 *
 *  El backend corre en varias instancias detrás de un balanceador. La que recibe el relay
 *  conduce la llamada. Si el relay se corta (esa instancia se cayó o se apaga), la central
 *  lo reabre —cae en otra instancia— y le reenvía lo que se perdió, numerado (`seq`).
 *
 *  Contrato completo: docs/CONTRATOS.md §11 y, del lado del backend, la spec
 *  `integracion-pbx` del repo del asistente.
 * ==========================================================================*/
'use strict';

/* Lo único que el backend puede mandarle a la sesión. Cualquier otro tipo se descarta:
 * así, pase lo que pase del otro lado, nadie cambia la sesión por el relay. */
const COMANDOS_RELAY = new Set(['session.instructions.append', 'session.commentary.append', 'session.close']);
/* Las órdenes del backend sobre la llamada, por su relay. */
const ORDENES_LLAMADA = new Set(['colgar', 'transferir', 'enviar_dtmf']);

/* El canal se da por caído si pasan estos ms sin el ping del backend (que manda cada 5 s). */
const CANAL_MUDO_MS = 15000;
/* Reconexión del canal: de a poco, sin martillar a un backend caído. */
const RECONEXION_MS = [1000, 2000, 5000, 10000];
/* Órdenes ya ejecutadas que se recuerdan para descartar las repetidas (el backend las
 * reenvía si no vio el ack, también por un relay reabierto). */
const ORDENES_RECORDADAS = 500;

/* El relay: lo que se guarda para reenviar (unos 20 s de eventos), cada cuánto se
 * reintenta reabrirlo, y el código con que el backend pide reabrirlo ya (se apaga una
 * instancia: «reubicar»). */
const TOPE_RELAY = 2000;
const REAPERTURA_MS = 1000;
const CODIGO_REUBICAR = 4001;
/* El latido del relay: un ping cada LATIDO_RELAY_MS, y sin respuesta en MUDO_RELAY_MS se
 * da por cortado (y se reabre). */
const LATIDO_RELAY_MS = 2000;
const MUDO_RELAY_MS = 6000;
/* Cuánto espera el cierre a las órdenes en curso: un `transferir` espera la cola de audio
 * (hasta 5 s) y la transferencia. */
const TOPE_CIERRE_MS = 10000;
/* Tope para abrir el relay o el canal: un balanceador que manda la conexión a una
 * instancia apagada puede dejarla colgada (no la rechaza); sin tope, la reapertura
 * del relay se comía la ventana entera (prueba con la central, 01/10). */
const HANDSHAKE_MS = 3000;

const base = (url) => String(url || '').trim().replace(/\/+$/, '');
const aWs = (url) => base(url).replace(/^http/i, 'ws');

/* El tiempo que el backend dice que hay que esperar su confirmación, acotado: viene de
 * afuera, y un valor absurdo dejaría a un visitante minutos en silencio. */
const ESPERA_MIN_MS = 1000;
const ESPERA_MAX_MS = 30000;
/* Cuánto se intenta reabrir el relay, también acotado: más de un minuto con el visitante
 * hablándole a nadie no tiene sentido; 0 es «no reabrir, al respaldo». */
const VENTANA_DEF_MS = 20000;
const VENTANA_MAX_MS = 60000;
/* El DTMF que se le manda al portero: lo que un teclado puede marcar, y corto. */
const DTMF = /^[0-9*#A-D]{1,16}$/;

/**
 * ¿Sirve esta URL para hablar con el backend? http o https, en la red de la central o por
 * internet: https es lo recomendable (por ahí viajan el token, el audio del visitante y las
 * órdenes que abren el portón), pero la instalación decide. Lo que no se acepta es una URL
 * que no se pueda abrir, porque cada llamada iría al respaldo sin que nadie entienda por qué.
 */
function urlPermitida(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch (_) { return { ok: false, motivo: 'la URL del backend no es válida' }; }
  if (u.protocol === 'https:' || u.protocol === 'http:') return { ok: true, motivo: '' };
  return { ok: false, motivo: 'la URL del backend tiene que ser http o https' };
}

/** ¿A dónde puede transferir el backend? Solo a los destinos del agente: en el contexto
 * `internal` también están las salidas por troncal y la DISA, y una orden con cualquier
 * número sería fraude telefónico. */
function destinoPermitido(agente, destino) {
  const permitidos = [agente && agente.agentes_exten, agente && agente.default_exten].map((d) => String(d || '').trim()).filter(Boolean);
  return permitidos.includes(String(destino || '').trim());
}

/** El DTMF de apertura del agente, si está configurado y es válido; si no, null (el
 * backend deriva en vez de prometer una apertura que no puede pasar). */
function dtmfApertura(agente) {
  const porton = ((agente && agente.herramientas) || {}).abrir_porton || {};
  if (!porton.on || (porton.modo || 'dtmf') !== 'dtmf') return null;
  const d = String(porton.dtmf || '#').trim();
  return DTMF.test(d) ? d : null;
}

/** ¿Se puede atender con IA externa, o va al respaldo sin abrir sesión? Con el contrato v2
 * el canal de control no hace falta para atender: la llamada va entera por su relay. */
function decidirArranque({ config }) {
  if (!config || !config.session) return { atender: false, motivo: 'no hay configuración bajada del backend' };
  return { atender: true, motivo: '' };
}

/** El comando del backend, si es uno de los permitidos; null si hay que descartarlo. */
function comandoPermitido(msg) {
  return msg && typeof msg === 'object' && COMANDOS_RELAY.has(msg.type) ? msg : null;
}

const acotar = (valor, min, max, def) => {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

/** Baja la configuración de la sesión. Con la versión que ya se tiene, el backend
 * contesta 304 y no cambia nada. */
async function bajarConfig({ url, token, version, fetchImpl, topeMs }) {
  const f = fetchImpl || fetch;
  const headers = { Authorization: 'Bearer ' + token };
  if (version) headers['If-None-Match'] = '"' + version + '"';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), topeMs || 5000);
  try {
    const r = await f(base(url) + '/api/pbx/session-config', { headers, signal: ctl.signal });
    if (r.status === 304) return { cambio: false };
    if (!r.ok) throw new Error('el backend contestó ' + r.status + ' al pedir la configuración');
    const cfg = await r.json();
    if (!cfg || !cfg.session || !cfg.version) throw new Error('la configuración del backend vino incompleta');
    /* El relay existe para GPT-Live: con otro modelo la sesión abriría con otro protocolo,
     * ignorando la configuración, y los comandos del backend no existirían. */
    if (!/^gpt-live/i.test(String(cfg.session.model || ''))) throw new Error('el modelo de la configuración no es GPT-Live: ' + String(cfg.session.model || 'sin modelo'));
    const espera = acotar(cfg.attachTimeoutMs, ESPERA_MIN_MS, ESPERA_MAX_MS, 5000);
    const ventana = cfg.resumeWindowMs === undefined || cfg.resumeWindowMs === null ? VENTANA_DEF_MS : acotar(cfg.resumeWindowMs, 0, VENTANA_MAX_MS, VENTANA_DEF_MS);
    return { cambio: true, config: { version: String(cfg.version), session: cfg.session, attachTimeoutMs: espera, resumeWindowMs: ventana } };
  } finally { clearTimeout(t); }
}

/**
 * Un hecho de una llamada cuyo relay ya se cerró (el resultado de una transferencia, el
 * corte de quien llama): va por HTTP a cualquier instancia del backend, que lo anota en la
 * llamada. Tres intentos; un 4xx no se reintenta (la llamada no existe o el hecho es malo).
 */
async function enviarHecho({ url, token, hecho, fetchImpl, intentos, esperaMs, topeMs }) {
  const f = fetchImpl || fetch;
  const total = intentos || 3;
  let motivo = '';
  for (let i = 1; i <= total; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), topeMs || 5000);
    try {
      const r = await f(base(url) + '/api/pbx/llamadas/' + encodeURIComponent(hecho.pbxCallId) + '/hechos', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(hecho),
        signal: ctl.signal,
      });
      if (r.ok) return { ok: true, motivo: '' };
      motivo = 'el backend contestó ' + r.status;
      if (r.status < 500) return { ok: false, motivo };
    } catch (e) {
      motivo = (e && e.message) || String(e);
    } finally { clearTimeout(t); }
    if (i < total) await new Promise((ok) => setTimeout(ok, (esperaMs === undefined ? 1000 : esperaMs) * i));
  }
  return { ok: false, motivo };
}

/**
 * El canal de control con UN backend: el latido y `refrescar_config`. Reconecta solo;
 * confirma cada orden con un ack DESPUÉS de ejecutarla (o avisa `orden_fallida`), y
 * descarta las repetidas por su id.
 */
class CanalControl {
  constructor({ url, token, WebSocketImpl, log, alOrden }) {
    this.url = aWs(url) + '/api/pbx/canal';
    this.token = token;
    this.WS = WebSocketImpl || require('ws');
    this.log = log || (() => {});
    this.alOrden = alOrden || (async () => {});
    this.ws = null;
    this.intento = 0;
    this.parado = false;
    /* id de orden → la respuesta que se dio (null mientras se ejecuta). */
    this.vistas = new Map();
    this.mudo = null;
  }

  get conectado() { return !!(this.ws && this.ws.readyState === 1); }

  iniciar() { this.parado = false; this.conectar(); }

  parar() {
    this.parado = true;
    clearTimeout(this.mudo);
    try { if (this.ws) this.ws.close(1000, 'central apagándose'); } catch (_) {}
  }

  conectar() {
    if (this.parado) return;
    let ws;
    try { ws = new this.WS(this.url, { headers: { Authorization: 'Bearer ' + this.token }, handshakeTimeout: HANDSHAKE_MS }); }
    catch (e) { this.log('canal de control: no se puede abrir (' + e.message + ')'); this.reintentar(); return; }
    this.ws = ws;
    /* Un 401/403 no se arregla reintentando: el token está mal. Se sigue probando, pero
     * espaciado y avisando una sola vez, para no llenar el log. */
    ws.on('unexpected-response', (_req, res) => {
      const status = res && res.statusCode;
      if (status !== this.ultimoStatus) this.log('canal de control: el backend contestó ' + status + (status === 401 || status === 403 ? ' (¿el token es el PBX_TOKEN del backend?)' : ''));
      this.ultimoStatus = status;
      try { ws.terminate(); } catch (_) {}
    });
    ws.on('open', () => { this.intento = 0; this.ultimoStatus = null; this.log('canal de control con el backend: conectado'); this.vigilar(); });
    ws.on('ping', () => this.vigilar());
    ws.on('message', (data) => this.recibir(data));
    ws.on('error', (e) => this.log('canal de control: ' + ((e && e.message) || e)));
    ws.on('close', () => {
      clearTimeout(this.mudo);
      if (this.ws === ws) this.ws = null;
      this.reintentar();
    });
  }

  reintentar() {
    if (this.parado) return;
    const rechazado = this.ultimoStatus === 401 || this.ultimoStatus === 403;
    const espera = rechazado ? 60000 : RECONEXION_MS[Math.min(this.intento++, RECONEXION_MS.length - 1)];
    if (!rechazado) this.log('canal de control: desconectado, se reintenta en ' + espera + ' ms');
    const t = setTimeout(() => this.conectar(), espera);
    if (t.unref) t.unref();
  }

  /* Sin ping del backend en CANAL_MUDO_MS, el canal está muerto aunque el socket no se
   * haya enterado: se corta y se reconecta. */
  vigilar() {
    clearTimeout(this.mudo);
    this.mudo = setTimeout(() => { this.log('canal de control: el backend no manda latido, se reconecta'); try { this.ws.terminate(); } catch (_) {} }, CANAL_MUDO_MS);
    if (this.mudo.unref) this.mudo.unref();
  }

  async recibir(data) {
    let orden;
    try { orden = JSON.parse(String(data)); } catch (_) { return; }
    if (!orden || typeof orden.type !== 'string') return;
    if (orden.type === 'error') { this.log('canal de control: el backend rechazó un mensaje (' + (orden.detalle || '') + ')'); return; }
    /* Repetida (el backend la reenvió porque no vio el ack): no se ejecuta otra vez. Si la
     * primera todavía corre, su respuesta sale cuando termine; si ya terminó, se repite. */
    if (orden.id && this.vistas.has(orden.id)) {
      const dada = this.vistas.get(orden.id);
      if (dada) this.enviar(dada);
      return;
    }
    if (orden.id) {
      this.vistas.set(orden.id, null);
      if (this.vistas.size > ORDENES_RECORDADAS) this.vistas.delete(this.vistas.keys().next().value);
    }
    let respuesta;
    try {
      await this.alOrden(orden);
      respuesta = orden.id ? { type: 'ack', id: orden.id } : null;
    } catch (e) {
      respuesta = { type: 'orden_fallida', pbxCallId: orden.pbxCallId || null, ordenId: orden.id || '', detalle: String((e && e.message) || e).slice(0, 300) };
    }
    if (orden.id) this.vistas.set(orden.id, respuesta);
    if (respuesta) this.enviar(respuesta);
  }

  enviar(msg) {
    if (!this.conectado) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; } catch (_) { return false; }
  }
}

/**
 * El relay de UNA llamada (contrato v2). Vive lo que la llamada, no lo que el socket:
 * numera cada evento y cada hecho (`seq`, de a uno), guarda los últimos TOPE_RELAY, y si
 * el socket se corta lo reabre durante la ventana y le reenvía al backend desde donde él
 * diga. Las órdenes recordadas también son de la llamada: una repetida por un relay
 * reabierto no se ejecuta dos veces.
 *
 * opciones: { abrir(): WebSocket, aviso (llamada_nueva, sin reanudar ni ultimoSeq),
 *   ventanaMs, log, alComando(cmd), alOrden(orden) (async; si falla, orden_fallida),
 *   alConfirmado(), alRechazado(motivo), alPerdido(motivo), reaperturaMs?, tope? }
 */
class RelayLlamada {
  constructor(o) {
    this.abrir = o.abrir;
    this.aviso = o.aviso;
    this.ventanaMs = Number.isFinite(o.ventanaMs) ? o.ventanaMs : VENTANA_DEF_MS;
    this.log = o.log || (() => {});
    this.alComando = o.alComando || (() => {});
    this.alOrden = o.alOrden || (async () => {});
    this.alConfirmado = o.alConfirmado || (() => {});
    this.alRechazado = o.alRechazado || (() => {});
    this.alPerdido = o.alPerdido || (() => {});
    this.reaperturaMs = o.reaperturaMs === undefined ? REAPERTURA_MS : o.reaperturaMs;
    this.latidoMs = o.latidoMs || LATIDO_RELAY_MS;
    this.mudoMs = o.mudoMs || MUDO_RELAY_MS;
    this.topeCierreMs = o.topeCierreMs || TOPE_CIERRE_MS;
    this.tope = o.tope || TOPE_RELAY;
    this.seq = 0;
    this.guardados = [];          // [{ seq, texto }], los últimos `tope`
    this.ws = null;
    /* 'cerrado' | 'abriendo' | 'esperando' (aviso de reanudar mandado, falta la
     * confirmación) | 'vivo' | 'terminado' */
    this.estado = 'cerrado';
    this.avisoMandado = false;    // el backend ya supo de la llamada por algún socket
    this.confirmada = false;      // el backend la confirmó alguna vez
    this.vistas = new Map();      // id de orden → respuesta (null mientras corre)
    this.enCurso = new Set();     // órdenes ejecutándose: el cierre espera su respuesta
    this.reintento = null;
    this.ventana = null;          // el tope para reabrir, mientras está cortado
    this.intentosVentana = 0;
    this.latido = null;
    this.ultimoSonido = 0;
  }

  get terminado() { return this.estado === 'terminado'; }

  iniciar() { this.abrirAhora(); }

  /** Un evento de la sesión o un hecho de la llamada: se numera y se guarda; sale ya si el
   * relay está vivo, o al reabrirlo. Devuelve si salió ahora. */
  mandar(msg) {
    const seq = ++this.seq;
    const texto = JSON.stringify(Object.assign({}, msg, { seq }));
    this.guardados.push({ seq, texto });
    if (this.guardados.length > this.tope) this.guardados.shift();
    /* Terminada, todavía sale en el instante antes de cerrar el socket (el hecho final). */
    return this.estado === 'vivo' || this.terminado ? this.escribir(texto) : false;
  }

  /** Fin de la llamada: no se reabre más y no se ejecutan más órdenes. El socket se cierra
   * cuando terminan las órdenes en curso (su respuesta tiene que salir: el ack del `colgar`
   * que terminó la llamada) y un instante después, para que salga el hecho final. Un
   * socket que todavía se estaba abriendo se corta ya: el backend no tiene nada que saber. */
  cerrar(codigo, motivo) {
    if (this.terminado) return;
    this.estado = 'terminado';
    clearTimeout(this.reintento);
    clearTimeout(this.ventana);
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState !== 1) { this.soltar(ws); return; }
    const tope = new Promise((ok) => { const t = setTimeout(ok, this.topeCierreMs); if (t.unref) t.unref(); });
    Promise.race([Promise.allSettled([...this.enCurso]), tope]).then(() => {
      const t = setTimeout(() => this.soltar(ws, codigo || 1000, motivo || 'fin de la llamada'), 200);
      if (t.unref) t.unref();
    });
  }

  soltar(ws, codigo, motivo) {
    this.pararLatido();
    /* Cortar un socket que todavía se conecta emite un `error`: sin quien lo escuche,
     * tiraría abajo el proceso. */
    try { if (typeof ws.on === 'function') ws.on('error', () => {}); } catch (_) {}
    try {
      if (ws.readyState === 1 && codigo) ws.close(codigo, motivo);
      else ws.terminate();
    } catch (_) {}
  }

  abrirAhora() {
    clearTimeout(this.reintento);
    this.reintento = null;
    if (this.terminado) return;
    let ws;
    try { ws = this.abrir(); } catch (e) { this.log('relay: no se puede abrir (' + e.message + ')'); this.cortado(); return; }
    /* La llamada terminó mientras se creaba el socket: no se pisa «terminado». */
    if (this.terminado) { this.soltar(ws); return; }
    this.ws = ws;
    this.estado = 'abriendo';
    ws.on('open', () => {
      if (this.ws !== ws) return;
      /* La llamada terminó mientras se abría: no se avisa nada ni se reabre. */
      if (this.terminado) { this.soltar(ws, 1000, 'fin de la llamada'); return; }
      this.abierto(ws);
    });
    ws.on('message', (data) => { if (this.ws === ws) { this.ultimoSonido = Date.now(); this.recibir(data); } });
    ws.on('pong', () => { if (this.ws === ws) this.ultimoSonido = Date.now(); });
    ws.on('error', (e) => this.log('relay: ' + ((e && e.message) || e)));
    ws.on('close', (codigo) => { if (this.ws === ws) this.cortado(codigo); });
  }

  abierto(ws) {
    this.vigilar(ws);
    /* Si el backend ya supo de la llamada (por este relay o uno anterior), es una
     * reanudación: lo nuevo espera la confirmación con `desde`. */
    const reanudar = this.avisoMandado;
    this.avisoMandado = true;
    this.escribirEn(ws, JSON.stringify(Object.assign({}, this.aviso, { reanudar, ultimoSeq: reanudar ? this.seq : null })));
    if (reanudar) { this.estado = 'esperando'; return; }
    /* La primera vez sale todo lo numerado hasta ahora: el backend lo guarda hasta que la
     * llamada arranca. */
    this.estado = 'vivo';
    for (const g of this.guardados) this.escribirEn(ws, g.texto);
  }

  /* El latido: una instancia del backend congelada, o una red cortada sin aviso, dejan el
   * socket «abierto» sin nadie del otro lado. Sin respuesta en `mudoMs`, se corta y se
   * reabre como cualquier corte. (`ws` contesta los ping solo, del lado del backend.) */
  vigilar(ws) {
    this.pararLatido();
    this.ultimoSonido = Date.now();
    this.latido = setInterval(() => {
      if (this.ws !== ws) { this.pararLatido(); return; }
      if (Date.now() - this.ultimoSonido > this.mudoMs) {
        this.log('relay: el backend no contesta el latido en ' + this.mudoMs + ' ms, se corta y se reabre');
        try { ws.terminate(); } catch (_) {}
        return;
      }
      try { if (typeof ws.ping === 'function') ws.ping(); } catch (_) {}
    }, this.latidoMs);
    if (this.latido.unref) this.latido.unref();
  }

  pararLatido() {
    clearInterval(this.latido);
    this.latido = null;
  }

  cortado(codigo) {
    this.ws = null;
    this.pararLatido();
    if (this.terminado) return;
    this.estado = 'cerrado';
    /* El backend todavía no supo de la llamada (no se pudo conectar): se reintenta; el
     * tope lo pone quien espera la confirmación (attachTimeoutMs). */
    if (!this.avisoMandado) {
      this.reintento = setTimeout(() => this.abrirAhora(), this.reaperturaMs);
      if (this.reintento.unref) this.reintento.unref();
      return;
    }
    if (!this.ventana) {
      if (this.ventanaMs <= 0) { this.perder('el relay con el backend se cortó y no se reabre (ventana 0)'); return; }
      this.log('relay: se cortó (' + (codigo || 'sin código') + '), se reabre durante ' + this.ventanaMs + ' ms');
      this.intentosVentana = 0;
      this.ventana = setTimeout(() => { this.ventana = null; if (this.estado !== 'vivo') this.perder('no se pudo reabrir el relay en ' + this.ventanaMs + ' ms'); }, this.ventanaMs);
      if (this.ventana.unref) this.ventana.unref();
    }
    /* El primer intento de cada corte sale enseguida (también con 4001, «reubicar»); los
     * siguientes, cada REAPERTURA_MS. Si no, una instancia que se drena y sigue recibiendo
     * conexiones y contestando 4001 armaba un bucle sin pausa (revisor, 01/10). */
    const espera = this.intentosVentana === 0 ? 0 : this.reaperturaMs;
    if (codigo === CODIGO_REUBICAR && this.intentosVentana === 0) this.log('relay: el backend pide reubicar la llamada');
    this.intentosVentana++;
    this.reintento = setTimeout(() => this.abrirAhora(), espera);
    if (this.reintento.unref) this.reintento.unref();
  }

  perder(motivo) {
    const ws = this.ws;
    this.estado = 'terminado';
    clearTimeout(this.reintento);
    clearTimeout(this.ventana);
    if (ws) this.soltar(ws);
    this.alPerdido(motivo);
  }

  recibir(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (ORDENES_LLAMADA.has(msg.type)) { this.ordenar(msg); return; }
    /* Terminada, lo único que se contesta son las órdenes (con falla, o la respuesta que ya
     * se dio): ni confirmaciones ni comandos a una sesión que ya no está. */
    if (this.terminado) return;
    if (msg.type === 'enganche_confirmado') return this.confirmar(msg);
    if (msg.type === 'enganche_rechazado') return this.rechazar(String(msg.motivo || 'rechazado'));
    const cmd = comandoPermitido(msg);
    if (cmd) { this.alComando(cmd); return; }
    if (msg.id) this.responder({ type: 'orden_fallida', pbxCallId: this.aviso.pbxCallId, ordenId: String(msg.id), detalle: 'orden desconocida: ' + msg.type });
    else this.log('relay: se descarta un mensaje no permitido (' + msg.type + ')');
  }

  confirmar(msg) {
    const primera = !this.confirmada;
    this.confirmada = true;
    clearTimeout(this.ventana);
    this.ventana = null;
    if (this.estado === 'esperando') {
      const desde = Number.isInteger(msg.desde) ? msg.desde : this.seq + 1;
      const primero = this.guardados.length ? this.guardados[0].seq : this.seq + 1;
      if (desde < primero) this.log('relay: el backend pide desde el ' + desde + ' y lo más viejo guardado es el ' + primero + ': ese hueco se pierde');
      this.estado = 'vivo';
      for (const g of this.guardados) if (g.seq >= desde) this.escribir(g.texto);
      this.log('relay: el backend retomó la llamada (desde el ' + desde + ')');
    }
    if (primera) this.alConfirmado(msg);
  }

  rechazar(motivo) {
    if (this.confirmada) { this.perder('el backend rechazó la reanudación: ' + motivo); return; }
    this.cerrar(1000, 'rechazada');
    this.alRechazado(motivo);
  }

  async ordenar(orden) {
    const falla = (detalle) => ({ type: 'orden_fallida', pbxCallId: this.aviso.pbxCallId, ordenId: orden.id || '', detalle: String(detalle).slice(0, 300) });
    /* Una orden de otra llamada se rechaza sin recordar su id: si no, la buena con ese id
     * recibiría la falla sin ejecutarse. */
    if (orden.pbxCallId !== this.aviso.pbxCallId) { this.responder(falla('la orden es de otra llamada (' + orden.pbxCallId + ')')); return; }
    /* Repetida: no se ejecuta otra vez. Si la primera todavía corre, su respuesta sale
     * cuando termine; si ya terminó, se repite (también con la llamada terminada). */
    if (orden.id && this.vistas.has(orden.id)) {
      const dada = this.vistas.get(orden.id);
      if (dada) this.responder(dada);
      return;
    }
    if (this.terminado) { this.responder(falla('la llamada ya no está en curso')); return; }
    if (orden.id) {
      this.vistas.set(orden.id, null);
      if (this.vistas.size > ORDENES_RECORDADAS) this.vistas.delete(this.vistas.keys().next().value);
    }
    let fin;
    const enCurso = new Promise((ok) => { fin = ok; });
    this.enCurso.add(enCurso);
    let respuesta;
    try {
      await this.alOrden(orden);
      respuesta = orden.id ? { type: 'ack', id: orden.id } : null;
    } catch (e) {
      respuesta = falla((e && e.message) || e);
    }
    if (orden.id) this.vistas.set(orden.id, respuesta);
    if (respuesta) this.responder(respuesta);
    this.enCurso.delete(enCurso);
    fin();
  }

  /* Las respuestas a una orden no se numeran: si se pierden, el backend reenvía la orden y
   * la respuesta sale de las recordadas. */
  responder(msg) { this.escribir(JSON.stringify(msg)); }

  escribir(texto) { return this.escribirEn(this.ws, texto); }

  escribirEn(ws, texto) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(texto); return true; } catch (_) { return false; }
  }
}

/**
 * Lo que usa el pipeline: canales por backend, configuración por agente, relays y hechos
 * por HTTP.
 *
 * deps: { agentes(): Promise<agente[]>, leerConfig(id), guardarConfig(id, cfg), log,
 *         WebSocketImpl?, fetchImpl? }
 */
function crear(deps) {
  const log = deps.log || (() => {});
  const canales = new Map();          // clave de backend → CanalControl
  const configs = new Map();          // agente_id → { version, session, attachTimeoutMs, resumeWindowMs }

  const clave = (a) => base(a.externo_url) + '|' + (a.externo_token || '');

  async function refrescar(agentesDelBackend) {
    const fallas = [];
    for (const a of agentesDelBackend) {
      const actual = configs.get(a.id) || await deps.leerConfig(a.id).catch(() => null);
      try {
        const r = await bajarConfig({ url: a.externo_url, token: a.externo_token, version: actual && actual.version, fetchImpl: deps.fetchImpl });
        if (r.cambio) {
          configs.set(a.id, r.config);
          await deps.guardarConfig(a.id, r.config);
          log('ia externa: configuración ' + r.config.version + ' bajada para el agente ' + a.id);
        } else if (actual) configs.set(a.id, actual);
      } catch (e) {
        log('ia externa: no se pudo bajar la configuración del agente ' + a.id + ': ' + e.message);
        if (actual) configs.set(a.id, actual);
        fallas.push('agente ' + a.id + ': ' + e.message);
      }
    }
    /* Que el backend se entere: si no, cree que la configuración bajó. */
    if (fallas.length) throw new Error('no se pudo bajar la configuración (' + fallas.join('; ') + ')');
  }

  /* Por el canal solo llega `refrescar_config` (contrato v2): lo de cada llamada va por su
   * relay. */
  async function ordenar(orden, agentesDelBackend) {
    if (orden.type === 'refrescar_config') return refrescar(agentesDelBackend);
    throw new Error('orden desconocida en el canal de control: ' + orden.type);
  }

  /** Abre (o cierra) los canales según los agentes de IA externa que haya. */
  async function recargar() {
    const agentes = (await deps.agentes()).filter((a) => a.enabled !== false && a.provider === 'ia-externa' && a.externo_url && a.externo_token);
    const porBackend = new Map();
    for (const a of agentes) {
      if (!porBackend.has(clave(a))) porBackend.set(clave(a), []);
      porBackend.get(clave(a)).push(a);
      const guardada = await deps.leerConfig(a.id).catch(() => null);
      if (guardada && !configs.has(a.id)) configs.set(a.id, guardada);
    }
    for (const [k, canal] of canales) if (!porBackend.has(k)) { canal.parar(); canales.delete(k); }
    for (const [k, lista] of porBackend) {
      if (canales.has(k)) {
        const canal = canales.get(k);
        const nuevos = lista.filter((a) => !canal.agentes.some((b) => b.id === a.id) || !configs.has(a.id));
        canal.agentes = lista;
        /* El backend manda `refrescar_config` solo al conectarse: un agente que se suma a
         * un canal que ya estaba arriba tiene que bajar su configuración ahora. */
        if (nuevos.length) refrescar(nuevos).catch((e) => log('ia externa: ' + e.message));
        continue;
      }
      const canal = new CanalControl({ url: lista[0].externo_url, token: lista[0].externo_token, WebSocketImpl: deps.WebSocketImpl, log, alOrden: (o) => ordenar(o, canal.agentes) });
      canal.agentes = lista;
      canales.set(k, canal);
      canal.iniciar();
    }
  }

  return {
    recargar,
    configDe: (agenteId) => configs.get(agenteId) || null,
    /** Abre un socket del relay de una llamada (el balanceador lo manda a cualquier
     * instancia del backend). */
    abrirRelay: (agente, pbxCallId) => {
      const WS = deps.WebSocketImpl || require('ws');
      return new WS(aWs(agente.externo_url) + '/api/pbx/llamadas/' + encodeURIComponent(pbxCallId) + '/relay', { headers: { Authorization: 'Bearer ' + agente.externo_token }, handshakeTimeout: HANDSHAKE_MS });
    },
    /** Un hecho de una llamada con el relay ya cerrado, por HTTP. */
    enviarHecho: (agente, hecho) => enviarHecho({ url: agente.externo_url, token: agente.externo_token, hecho, fetchImpl: deps.fetchImpl }),
    parar: () => { for (const c of canales.values()) c.parar(); canales.clear(); },
  };
}

module.exports = {
  crear, decidirArranque, comandoPermitido, bajarConfig, enviarHecho, CanalControl, RelayLlamada,
  COMANDOS_RELAY, ORDENES_LLAMADA, CODIGO_REUBICAR, TOPE_RELAY, VENTANA_DEF_MS, VENTANA_MAX_MS, HANDSHAKE_MS,
  urlPermitida, destinoPermitido, dtmfApertura, DTMF,
};
