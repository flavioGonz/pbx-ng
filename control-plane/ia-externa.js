/* ============================================================================
 *  IA EXTERNA: el agente lo conduce otro sistema (el backend del asistente de voz).
 *
 *  La central NO sabe de negocio en este perfil: atiende, pone el audio y ejecuta
 *  órdenes de telefonía. Todo lo demás —qué decir, cuándo verificar, abrir, derivar o
 *  cortar— lo decide el backend. Por eso este módulo tiene tres piezas y ninguna lógica
 *  de conversación:
 *
 *   · la CONFIGURACIÓN de la sesión, que el backend publica y acá se baja y se guarda.
 *     Se usa tal cual en el `session.start`: sin prompt, saludo ni herramientas nuestras;
 *   · el CANAL DE CONTROL, un WebSocket por backend: por ahí van los hechos de la llamada
 *     (llamada nueva, colgó, DTMF, resultado de una transferencia) y vuelven las órdenes
 *     (colgar, transferir, mandar un DTMF, refrescar la configuración);
 *   · el RELAY de cada llamada: los eventos de la sesión de GPT-Live, tal cual, hacia el
 *     backend, y los comandos del backend, tal cual, hacia la sesión. Existe porque a una
 *     sesión abierta por WebSocket el backend no se puede enganchar por el sideband de
 *     OpenAI (da 404): la central le hace de sideband.
 *
 *  Contrato completo: docs/CONTRATOS.md §11 y, del lado del backend, la spec
 *  `integracion-pbx` del repo del asistente.
 * ==========================================================================*/
'use strict';

/* Lo único que el backend puede mandarle a la sesión. Cualquier otro tipo se descarta:
 * así, pase lo que pase del otro lado, nadie cambia la sesión por el relay. */
const COMANDOS_RELAY = new Set(['session.instructions.append', 'session.commentary.append', 'session.close']);

/* El canal se da por caído si pasan estos ms sin el ping del backend (que manda cada 5 s). */
const CANAL_MUDO_MS = 15000;
/* Reconexión: de a poco, sin martillar a un backend caído. */
const RECONEXION_MS = [1000, 2000, 5000, 10000];
/* Órdenes ya ejecutadas que se recuerdan para descartar las repetidas (se reenvían al
 * reconectar si el ack no llegó). */
const ORDENES_RECORDADAS = 500;

const base = (url) => String(url || '').trim().replace(/\/+$/, '');
const aWs = (url) => base(url).replace(/^http/i, 'ws');

/* El tiempo que el backend dice que hay que esperar su confirmación, acotado: viene de
 * afuera, y un valor absurdo dejaría a un visitante minutos en silencio. */
const ESPERA_MIN_MS = 1000;
const ESPERA_MAX_MS = 30000;
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

/** ¿Se puede atender con IA externa, o va al respaldo sin abrir sesión? */
function decidirArranque({ config, canalArriba }) {
  if (!config || !config.session) return { atender: false, motivo: 'no hay configuración bajada del backend' };
  if (!canalArriba) return { atender: false, motivo: 'el canal de control con el backend está caído' };
  return { atender: true, motivo: '' };
}

/** El comando del backend, si es uno de los permitidos; null si hay que descartarlo. */
function comandoPermitido(msg) {
  return msg && typeof msg === 'object' && COMANDOS_RELAY.has(msg.type) ? msg : null;
}

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
    const espera = Math.min(ESPERA_MAX_MS, Math.max(ESPERA_MIN_MS, Math.round(Number(cfg.attachTimeoutMs) || 5000)));
    return { cambio: true, config: { version: String(cfg.version), session: cfg.session, attachTimeoutMs: espera } };
  } finally { clearTimeout(t); }
}

/**
 * El canal de control con UN backend. Reconecta solo; confirma cada orden con un ack
 * DESPUÉS de ejecutarla (o avisa `orden_fallida`), y descarta las repetidas por su id.
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
    try { ws = new this.WS(this.url, { headers: { Authorization: 'Bearer ' + this.token } }); }
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

  /** Un hecho para el backend. Con el canal caído se pierde: la llamada ya se mandó al
   * respaldo, que es lo que protege al visitante. */
  enviar(msg) {
    if (!this.conectado) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; } catch (_) { return false; }
  }
}

/**
 * Lo que usa el pipeline: canales por backend, configuración por agente, llamadas en
 * curso y la espera de la confirmación del backend.
 *
 * deps: { agentes(): Promise<agente[]>, leerConfig(id), guardarConfig(id, cfg), log,
 *         WebSocketImpl?, fetchImpl? }
 */
function crear(deps) {
  const log = deps.log || (() => {});
  const canales = new Map();          // clave de backend → CanalControl
  const configs = new Map();          // agente_id → { version, session, attachTimeoutMs }
  const llamadas = new Map();         // pbxCallId → { colgar, transferir, dtmf }
  const esperas = new Map();          // pbxCallId → (resultado) => void

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

  async function ordenar(orden, agentesDelBackend) {
    switch (orden.type) {
      case 'refrescar_config': return refrescar(agentesDelBackend);
      case 'enganche_confirmado':
      case 'enganche_rechazado': {
        const avisar = esperas.get(orden.pbxCallId);
        if (avisar) { esperas.delete(orden.pbxCallId); avisar(orden.type === 'enganche_confirmado' ? { ok: true } : { ok: false, motivo: orden.motivo || 'rechazado' }); }
        return undefined;
      }
      case 'colgar':
      case 'transferir':
      case 'enviar_dtmf': {
        const llamada = llamadas.get(orden.pbxCallId);
        if (!llamada) throw new Error('la llamada ' + orden.pbxCallId + ' ya no está en curso');
        /* Cada backend manda solo sobre las llamadas de SUS agentes. */
        if (!agentesDelBackend.some((a) => a.id === llamada.agenteId)) throw new Error('la llamada ' + orden.pbxCallId + ' no es de un agente de este backend');
        if (orden.type === 'colgar') return llamada.colgar();
        if (orden.type === 'transferir') return llamada.transferir(String(orden.destino || ''));
        return llamada.dtmf(String(orden.digitos || ''));
      }
      default:
        throw new Error('orden desconocida: ' + orden.type);
    }
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
    canalDe: (agente) => canales.get(clave(agente)) || null,
    /** Registra cómo se ejecutan las órdenes de una llamada en curso. */
    registrar: (pbxCallId, acciones, agenteId) => llamadas.set(pbxCallId, { ...acciones, agenteId }),
    soltar: (pbxCallId) => { llamadas.delete(pbxCallId); esperas.delete(pbxCallId); },
    /** Espera la confirmación del backend; si no llega a tiempo, `{ ok: false }`. */
    esperarEnganche: (pbxCallId, ms) => new Promise((ok) => {
      const t = setTimeout(() => { esperas.delete(pbxCallId); ok({ ok: false, motivo: 'el backend no confirmó a tiempo' }); }, ms);
      esperas.set(pbxCallId, (r) => { clearTimeout(t); ok(r); });
    }),
    abrirRelay: (agente, pbxCallId) => {
      const WS = deps.WebSocketImpl || require('ws');
      return new WS(aWs(agente.externo_url) + '/api/pbx/llamadas/' + encodeURIComponent(pbxCallId) + '/relay', { headers: { Authorization: 'Bearer ' + agente.externo_token } });
    },
    parar: () => { for (const c of canales.values()) c.parar(); canales.clear(); },
  };
}

module.exports = { crear, decidirArranque, comandoPermitido, bajarConfig, CanalControl, COMANDOS_RELAY, urlPermitida, destinoPermitido, dtmfApertura, DTMF };
