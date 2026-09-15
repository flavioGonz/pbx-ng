/* ==========================================================================
 *  PBX-NG · Medio: ICE / STUN / TURN   (dueño: agente `medios`)
 *
 *  POR QUÉ ESTE ARCHIVO EXISTE
 *  El medio estaba repartido: `/api/ice` en app.js, las credenciales TURN
 *  copiadas y pegadas en `/api/provision` de auth.js, el contenedor coturn en
 *  `docker/` y el interruptor en Configuración → Módulos. Resultado medido en
 *  una central real: la API repartía `turn:<dominio>:3478` —la dirección de un
 *  coturn que NADIE estaba corriendo—, el `.env` tenía `TURN_HOST` apuntando al
 *  SBC (que sí tenía un coturn, escuchando sólo en el bridge de Docker, o sea
 *  inalcanzable) y el panel mostraba el módulo encendido. Siete softphones
 *  WebRTC configurados contra eso.
 *
 *  LA REGLA DEL PRODUCTO: sin TURN, un softphone detrás de un NAT simétrico se
 *  queda sin audio. Eso es *roto*, no *mejorable*, así que el coturn propio es
 *  parte de PBX-NG y viene ENCENDIDO DE FÁBRICA (migración 0019 + el default
 *  del reconciliador). Esta central no es la versión degradada de nada.
 *
 *  LA IDEA: la central no corre TURN, la central DICE qué TURN usar. El encastre
 *  es el ORIGEN, uno solo a la vez (dos TURN sin dueño es exactamente cómo se
 *  llegó al panel que miente):
 *    · `propio`  · el coturn del appliance (DEFAULT). Enciende `mod_turn`.
 *    · `sbc`     · el coturn del SBC-NG: el host lo toma del enlace
 *                  (`sbc-link`, dueño `api`) para no tener la IP en dos lados;
 *                  las credenciales se cargan acá. APAGA el coturn local.
 *    · `externo` · URL y credenciales a mano (un TURN de un tercero).
 *
 *  NADA DE SERVICIOS PÚBLICOS POR DEFECTO: el STUN por defecto es el propio
 *  appliance. Un `stun:stun.l.google.com` hardcodeado hace que una central sin
 *  salida a internet —lo normal en un organismo público— arranque el WebRTC
 *  pidiéndole permiso a Google y falle.
 *
 *  PROBAR DE VERDAD: que el puerto conteste no alcanza. `sondear()` hace lo
 *  mismo que un navegador juntando candidatos: STUN Binding → Allocate sin
 *  credenciales (tiene que dar 401+realm) → Allocate firmado (200 + candidato
 *  relay). Y si el relay que devuelve es una dirección que ningún cliente puede
 *  usar (loopback, link-local o el bridge de Docker), eso es FALLA, no OK:
 *  es exactamente el estado en el que estaba el coturn del SBC.
 *
 *  ORDEN: se registra en app.js DESPUÉS del gate de auth + RBAC. `GET /api/ice`
 *  es público por la allowlist de auth.js (lo pide el softphone antes de tener
 *  sesión); el resto de `/api/turn/**` cae al default `admin` del RBAC.
 * ========================================================================== */
'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const dns = require('dns').promises;
const logger = require('./log');
const { errorHttp } = require('./errores');

const log = logger('TURN');

const ORIGENES = ['propio', 'sbc', 'externo'];
const PUERTO_TURN = 3478;

/* Claves en pbxng_settings. Todas con prefijo `turn_`/`stun_` para que se vean juntas
 * en Configuración → Base y para que un respaldo se lea. Las contraseñas se guardan en
 * claro porque coturn necesita el secreto tal cual (lt-cred-mech): el que puede leer
 * esta tabla ya es admin de la central. Lo que NO se hace es devolverlas por la API ni
 * escribirlas en el log ni meterlas en una URL. */
const K = {
  origen: 'turn_origen',
  host: 'turn_host',              // host público del coturn PROPIO (vacío = PUBLIC_IP || DOMAIN)
  puerto: 'turn_puerto',          // puerto del coturn PROPIO (vacío = 3478)
  sbcUser: 'turn_sbc_user',
  sbcPass: 'turn_sbc_pass',
  sbcPuerto: 'turn_sbc_puerto',
  extUrls: 'turn_ext_urls',       // csv: turn:host:3478?transport=udp,turns:host:5349
  extUser: 'turn_ext_user',
  extPass: 'turn_ext_pass',
  stun: 'stun_url',               // csv; vacío = el propio appliance
};

/* ---------------------------------------------------------------------------
 *  Direcciones que un cliente NO puede usar como relay.
 *  El coturn del SBC anunciaba 172.17.0.1 (el bridge de Docker de esa máquina):
 *  el servicio "estaba arriba", contestaba, autenticaba... y el candidato relay
 *  que repartía no lo alcanzaba nadie. Un relay así tiene que salir como FALLA.
 * ------------------------------------------------------------------------- */
function relayInservible(ip) {
  const s = String(ip || '');
  const o = s.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'la dirección del relay no es una IPv4 válida';
  if (o[0] === 0) return 'el relay anuncia 0.0.0.0: coturn no sabe qué dirección publicar (falta external-ip)';
  if (o[0] === 127) return 'el relay anuncia loopback (127.x): sólo sirve desde adentro del propio contenedor';
  if (o[0] === 169 && o[1] === 254) return 'el relay anuncia link-local (169.254.x): ningún cliente puede llegar ahí';
  /* 172.17.0.0/16 y 172.18-31 son los bridges que arma Docker. Una LAN puede usar
   * 172.16/12 legítimamente, así que esto NO es un error por sí solo: lo es cuando el
   * TURN se anuncia en una dirección pública y el relay cae en una privada, porque
   * entonces el cliente de afuera nunca va a llegar. Eso lo decide `sondear()`. */
  return null;
}
function esPrivada(ip) {
  const o = String(ip || '').split('.').map(Number);
  if (o.length !== 4) return false;
  return o[0] === 10 || o[0] === 127 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254) || o[0] === 0;
}

/* ---------------------------------------------------------------------------
 *  Cliente STUN/TURN mínimo (RFC 5389 / 8656) sin dependencias.
 *  Es el mismo camino que scripts/check-turn.py, para que el panel y la consola
 *  del instalador den el MISMO veredicto.
 * ------------------------------------------------------------------------- */
const MAGIC = 0x2112a442;
const M_BINDING = 0x0001, M_ALLOCATE = 0x0003;
const A_XOR_MAPPED = 0x0020, A_USERNAME = 0x0006, A_MI = 0x0008, A_ERROR = 0x0009;
const A_REALM = 0x0014, A_NONCE = 0x0015, A_XOR_RELAYED = 0x0016, A_REQ_TRANSPORT = 0x0019;

function attr(tipo, val) {
  const pad = (4 - (val.length % 4)) % 4;
  const b = Buffer.alloc(4 + val.length + pad);
  b.writeUInt16BE(tipo, 0); b.writeUInt16BE(val.length, 2); val.copy(b, 4);
  return b;
}
function armar(tipo, tid, attrs, clave) {
  attrs = attrs || Buffer.alloc(0);
  if (!clave) {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(tipo, 0); h.writeUInt16BE(attrs.length, 2); h.writeUInt32BE(MAGIC, 4); tid.copy(h, 8);
    return Buffer.concat([h, attrs]);
  }
  const h = Buffer.alloc(20);
  h.writeUInt16BE(tipo, 0); h.writeUInt16BE(attrs.length + 24, 2); h.writeUInt32BE(MAGIC, 4); tid.copy(h, 8);
  const mi = crypto.createHmac('sha1', clave).update(Buffer.concat([h, attrs])).digest();
  return Buffer.concat([h, attrs, attr(A_MI, mi)]);
}
function leer(d) {
  const tipo = d.readUInt16BE(0), len = d.readUInt16BE(2), out = {};
  let i = 20;
  while (i + 4 <= 20 + len && i + 4 <= d.length) {
    const t = d.readUInt16BE(i), l = d.readUInt16BE(i + 2);
    out[t] = d.slice(i + 4, i + 4 + l);
    i += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { tipo, at: out };
}
function xorAddr(v) {
  if (!v || v.length < 8) return null;
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC, 0);
  const ip = Array.from({ length: 4 }, (_, k) => v[4 + k] ^ m[k]).join('.');
  return { ip, port };
}
function codigoError(at) {
  const b = at[A_ERROR];
  return b && b.length >= 4 ? b[2] * 100 + b[3] : null;
}

/* Un intercambio pedido→respuesta, UDP o TCP, con timeout duro. El socket se cierra
 * siempre: una sonda que deja descriptores abiertos termina tumbando la API. */
function intercambio(host, puerto, msg, tcp, ms) {
  return new Promise((resolve, reject) => {
    let listo = false;
    const fin = (err, d) => { if (listo) return; listo = true; try { cerrar(); } catch (_) {} err ? reject(err) : resolve(d); };
    const t = setTimeout(() => fin(new Error('sin respuesta (timeout)')), ms);
    let cerrar = () => clearTimeout(t);
    if (tcp) {
      /* TCP no respeta los límites del mensaje: hay que acumular hasta tener la respuesta
       * ENTERA (20 bytes de cabecera + el `length` que declara) antes de parsearla. Con
       * `resolve` en el primer `data`, un Allocate firmado —que viene con realm, nonce y
       * MESSAGE-INTEGRITY, o sea el más largo y el candidato natural a llegar partido—
       * se leía truncado y la sonda declaraba «no se comporta como TURN» sobre un TURN
       * sano. Un falso negativo en la herramienta que existe justamente para no creerle
       * al panel es peor que no tener herramienta. */
      const s = net.connect({ host, port: puerto });
      let buf = Buffer.alloc(0);
      cerrar = () => { clearTimeout(t); s.destroy(); };
      s.on('connect', () => s.write(msg));
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 20) return;
        if (buf.length < 20 + buf.readUInt16BE(2)) return;
        fin(null, buf);
      });
      s.on('error', (e) => fin(e));
    } else {
      const s = dgram.createSocket('udp4');
      cerrar = () => { clearTimeout(t); try { s.close(); } catch (_) {} };
      s.on('message', (d) => fin(null, d));
      s.on('error', (e) => fin(e));
      s.send(msg, puerto, host, (e) => { if (e) fin(e); });
    }
  });
}

/**
 * Sonda REAL del TURN: STUN Binding → Allocate sin auth (401) → Allocate firmado (relay).
 * Devuelve { ok, veredicto, pasos:[{paso, ok, detalle}], relay, mapped }.
 * `ok:false` también cuando el relay existe pero es inservible (bridge de Docker,
 * loopback, 0.0.0.0): "el puerto contesta" no es la prueba, el candidato relay lo es.
 */
async function sondear({ host, puerto, usuario, clave, tcp, ms }) {
  const pasos = [];
  const res = { ok: false, host, puerto, proto: tcp ? 'TCP' : 'UDP', pasos, relay: null, mapped: null, veredicto: '' };
  const tope = ms || 4000;
  if (!host) { res.veredicto = 'no hay ningún host de TURN configurado'; return res; }

  /* La dirección REAL del TURN, no la cadena que escribió el administrador. El host casi
   * siempre es un nombre (`DOMAIN` cuando no hay `PUBLIC_IP`), y la comprobación de más
   * abajo —«el relay es privado y el TURN está publicado en una pública»— comparaba
   * contra esa cadena: con un nombre no era ni v4 ni privada, la condición daba falso y
   * un coturn anunciando 172.17.0.1 pasaba como OK. O sea, la sonda escrita para detectar
   * exactamente el caso que originó este release no lo detectaba. Resolvemos una vez y
   * comparamos contra la IP; si el nombre no resuelve, el intercambio de abajo va a
   * fallar igual y con un mensaje mejor. */
  let hostIp = net.isIP(host) ? host : '';
  if (!hostIp) { try { hostIp = (await dns.lookup(host, { family: 4 })).address; } catch (_) { hostIp = ''; } }
  res.host_ip = hostIp || null;

  // 1) ¿contesta STUN? (y de paso, cómo nos ve)
  try {
    const { at } = leer(await intercambio(host, puerto, armar(M_BINDING, crypto.randomBytes(12)), tcp, tope));
    const m = xorAddr(at[A_XOR_MAPPED]);
    res.mapped = m ? m.ip + ':' + m.port : null;
    pasos.push({ paso: 'STUN Binding', ok: true, detalle: m ? 'nos ve como ' + res.mapped : 'responde' });
  } catch (e) {
    pasos.push({ paso: 'STUN Binding', ok: false, detalle: e.message });
    res.veredicto = 'el servidor STUN/TURN no contesta en ' + host + ':' + puerto + ' (¿puerto cerrado, firewall o NAT sin hairpin?)';
    return res;
  }

  if (!usuario || !clave) {
    // Sin credenciales sólo se puede afirmar que hay STUN. Un TURN sin credenciales
    // no es un TURN a medias: es un relay abierto, y no lo damos por bueno.
    res.veredicto = 'responde STUN pero no hay credenciales cargadas: no se puede verificar el relay TURN';
    return res;
  }

  // 2) Allocate sin credenciales: el 401 con realm+nonce es lo que prueba que es TURN
  let realm, nonce;
  try {
    const { at } = leer(await intercambio(host, puerto, armar(M_ALLOCATE, crypto.randomBytes(12), attr(A_REQ_TRANSPORT, Buffer.from([17, 0, 0, 0]))), tcp, tope));
    const c = codigoError(at);
    if (c !== 401 || !at[A_REALM] || !at[A_NONCE]) {
      pasos.push({ paso: 'Allocate sin credenciales', ok: false, detalle: 'esperaba 401 + realm y llegó ' + (c === null ? 'otra cosa' : 'error ' + c) });
      res.veredicto = 'contesta STUN pero no se comporta como TURN (¿coturn sin lt-cred-mech, o es sólo un STUN?)';
      return res;
    }
    realm = at[A_REALM]; nonce = at[A_NONCE];
    pasos.push({ paso: 'Allocate sin credenciales', ok: true, detalle: "401 (esperado) · realm '" + realm.toString('utf8') + "'" });
  } catch (e) {
    pasos.push({ paso: 'Allocate sin credenciales', ok: false, detalle: e.message });
    res.veredicto = 'no responde al Allocate: el puerto contesta pero no hay TURN del otro lado';
    return res;
  }

  // 3) Allocate firmado: 200 + XOR-RELAYED-ADDRESS = el candidato relay de verdad
  const key = crypto.createHash('md5').update(usuario + ':' + realm.toString('utf8') + ':' + clave).digest();
  const attrs = Buffer.concat([
    attr(A_REQ_TRANSPORT, Buffer.from([17, 0, 0, 0])),
    attr(A_USERNAME, Buffer.from(usuario, 'utf8')),
    attr(A_REALM, realm), attr(A_NONCE, nonce),
  ]);
  let at2;
  try {
    const r = leer(await intercambio(host, puerto, armar(M_ALLOCATE, crypto.randomBytes(12), attrs, key), tcp, tope));
    at2 = r.at;
    if (r.tipo !== 0x0103 || !at2[A_XOR_RELAYED]) {
      const c = codigoError(at2);
      pasos.push({ paso: 'Allocate firmado', ok: false, detalle: c ? 'error ' + c : 'respuesta inesperada' });
      res.veredicto = (c === 401 || c === 403)
        ? 'credenciales RECHAZADAS: el usuario/clave del panel no coinciden con los del servidor TURN'
        : 'el Allocate falló' + (c ? ' (error ' + c + ')' : '');
      return res;
    }
  } catch (e) {
    pasos.push({ paso: 'Allocate firmado', ok: false, detalle: e.message });
    res.veredicto = 'el Allocate firmado no obtuvo respuesta';
    return res;
  }

  const relay = xorAddr(at2[A_XOR_RELAYED]);
  res.relay = relay ? relay.ip + ':' + relay.port : null;
  const roto = relayInservible(relay && relay.ip);
  if (roto) {
    pasos.push({ paso: 'Allocate firmado', ok: false, detalle: 'relay ' + res.relay + ' — ' + roto });
    res.veredicto = roto;
    return res;
  }
  /* El caso del coturn del SBC: el TURN se anuncia en una dirección pública o de otra
   * red, pero el relay que reparte es privado. Desde adentro de esa misma LAN "anda";
   * desde afuera —que es para lo que existe el TURN— no llega nadie. */
  if (relay && esPrivada(relay.ip) && hostIp && !esPrivada(hostIp)) {
    pasos.push({ paso: 'Allocate firmado', ok: false, detalle: 'relay ' + res.relay + ' es una dirección privada y el TURN está publicado en una pública' });
    res.veredicto = 'el relay anuncia una dirección privada (' + relay.ip + '): los clientes de afuera no la alcanzan. Falta `external-ip` en turnserver.conf o el port-forward del rango relay.';
    return res;
  }
  pasos.push({ paso: 'Allocate firmado', ok: true, detalle: 'relay = ' + res.relay });
  res.ok = true;
  res.veredicto = 'el TURN entrega candidato relay: WebRTC funciona detrás de NAT simétrico';
  return res;
}

/* ========================================================================== */
/**
 * deps:
 *   app, pool, NODES, errorHttp? (se usa el propio), moduleEnabled(id),
 *   setModule(id, on)   escribe pbxng_settings.mod_<id> (lo comparte con /api/modules)
 *   sbcLink()           enlace a SBC-NG (trunks.js, dueño `api`) — sólo se LEE
 *   turnFwd(m,p,b,ms)   agente HTTP del contenedor coturn (:8091)
 * Devuelve: { iceServers, origenEfectivo, sondearOrigen } para que auth.js (provisión y
 * enrolado) reparta EXACTAMENTE el mismo ICE que /api/ice, sin copiar la lógica.
 */
module.exports = function init(deps) {
  const { app, pool, NODES, moduleEnabled, setModule, sbcLink, turnFwd } = deps;

  async function leerAjustes() {
    const out = {};
    try {
      const { rows } = await pool.query('SELECT key, value FROM pbxng_settings WHERE key = ANY($1)', [Object.values(K)]);
      rows.forEach((r) => { out[r.key] = r.value; });
    } catch (e) { log.warn('no se pudieron leer los ajustes de TURN', { err: e.message }); }
    return out;
  }
  async function guardar(k, v) {
    await pool.query('INSERT INTO pbxng_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [k, String(v == null ? '' : v)]);
  }

  /* Host público del coturn PROPIO. El ajuste del panel manda sobre el `.env`: en la
   * central real nadie pudo corregir `TURN_HOST` sin entrar por SSH, justamente porque
   * sólo se podía tocar el archivo. */
  function hostPropioEnv() { return process.env.PUBLIC_IP || process.env.DOMAIN || NODES.public_ip || NODES.domain || ''; }

  /**
   * Resuelve el ORIGEN efectivo: qué TURN/STUN se le entrega hoy a un softphone.
   * Un solo origen a la vez, siempre. Si el origen elegido no está utilizable
   * (SBC sin enlace activo, externo sin URL) se dice por qué en `motivo` y NO se
   * cae en silencio a otro: repartir un TURN que no es el configurado es el
   * mismo error que repartir uno que no existe.
   */
  async function origenEfectivo() {
    const s = await leerAjustes();
    const origen = ORIGENES.includes(s[K.origen]) ? s[K.origen] : 'propio';
    const stunManual = String(s[K.stun] || process.env.STUN_URL || '').trim();
    const out = { origen, host: '', puerto: PUERTO_TURN, usuario: '', clave: '', usable: false, motivo: '', stun: [], modulo_local: false };

    if (origen === 'propio') {
      out.modulo_local = true;
      out.host = String(s[K.host] || '').trim() || hostPropioEnv();
      out.puerto = +s[K.puerto] || PUERTO_TURN;
      out.usuario = process.env.TURN_USER || 'pbxng';
      out.clave = process.env.TURN_PASS || '';
      if (!out.host) out.motivo = 'el appliance no tiene dirección pública: cargá PUBLIC_IP/DOMAIN o el host del TURN en el panel';
      else if (!out.clave) out.motivo = 'falta TURN_PASS en el .env (la genera install.sh): sin clave el coturn propio no reparte credenciales';
      else out.usable = true;
    } else if (origen === 'sbc') {
      /* El host NO se copia: se lee del enlace (`api`/trunks.js). Tener la IP del SBC en
       * dos lugares es cómo se llegó a un `.env` apuntando a un borde desconectado. */
      let lk = null;
      try { lk = await sbcLink(); } catch (_) {}
      out.host = (lk && lk.host) || '';
      out.puerto = +s[K.sbcPuerto] || PUERTO_TURN;
      out.usuario = String(s[K.sbcUser] || '').trim();
      out.clave = String(s[K.sbcPass] || '');
      if (!lk || !lk.active) out.motivo = 'el módulo «Conexión a SBC-NG» está apagado o el enlace no está configurado: no hay de dónde sacar el host del TURN';
      else if (!out.usuario || !out.clave) out.motivo = 'faltan las credenciales TURN del SBC-NG';
      else out.usable = true;
    } else {
      const urls = String(s[K.extUrls] || '').split(',').map((x) => x.trim()).filter(Boolean);
      out.urls = urls;
      out.usuario = String(s[K.extUser] || '').trim();
      out.clave = String(s[K.extPass] || '');
      const m = /^turns?:\[?([^\]/?]+?)\]?(?::(\d+))?(?:\?|$)/i.exec(urls[0] || '');
      out.host = m ? m[1] : '';
      out.puerto = m && m[2] ? +m[2] : PUERTO_TURN;
      if (!urls.length) out.motivo = 'no se cargó ninguna URL de TURN externo';
      else if (!out.usuario || !out.clave) out.motivo = 'faltan usuario y clave del TURN externo';
      else out.usable = true;
    }

    /* STUN: lo elegido a mano, si no el propio origen. NUNCA un servicio público:
     * una central sin salida a internet no puede depender de Google para juntar
     * candidatos (es el mismo problema que bajar una librería de un CDN en runtime). */
    out.stun = stunManual
      ? stunManual.split(',').map((x) => x.trim()).filter(Boolean).map((u) => (/^stuns?:/i.test(u) ? u : 'stun:' + u))
      : (out.host ? ['stun:' + out.host + ':' + out.puerto] : []);
    return out;
  }

  /**
   * Lo que se le entrega a un cliente WebRTC. Es la ÚNICA función que arma esta lista:
   * `/api/ice`, la provisión por QR y el enrolado salen todos de acá.
   * Sin credenciales no se publica una entrada `turn:`: un `credential` vacío rompe el
   * RTCPeerConnection en algunos navegadores y, peor, esconde el problema real.
   */
  async function iceServers() {
    const e = await origenEfectivo();
    const ice = e.stun.map((u) => ({ urls: u }));
    if (e.usable) {
      if (e.origen === 'externo') {
        ice.push({ urls: e.urls, username: e.usuario, credential: e.clave });
      } else {
        ice.push({ urls: 'turn:' + e.host + ':' + e.puerto + '?transport=udp', username: e.usuario, credential: e.clave });
        ice.push({ urls: 'turn:' + e.host + ':' + e.puerto + '?transport=tcp', username: e.usuario, credential: e.clave });
      }
    }
    return { iceServers: ice, origen: e.origen, motivo: e.motivo || undefined };
  }

  /* Estado REAL, cacheado 20 s. Se usa para que el interruptor del panel diga si el
   * servicio está CORRIENDO y no lo que la API asume por defecto. El tope es corto a
   * propósito (1,8 s por intercambio): esto lo pide una pantalla, no un diagnóstico —el
   * diagnóstico completo, con TCP y todos los pasos, es POST /api/turn/probe. */
  let _cache = { t: 0, v: null };
  async function estado(fresco) {
    if (!fresco && _cache.v && Date.now() - _cache.t < 20000) return _cache.v;
    const e = await origenEfectivo();
    const deseado = await moduleEnabled('turn');
    const s = await sondear({ host: e.host, puerto: e.puerto, usuario: e.usuario, clave: e.clave, ms: 1800 });
    const v = {
      origen: e.origen, host: e.host, puerto: e.puerto,
      /* `deseado` es lo que dice pbxng_settings (el interruptor); `corriendo` es lo que
       * contestó el servidor. Cuando difieren, el que miente es el panel. */
      deseado, corriendo: s.ok, relay: s.relay, mapped: s.mapped,
      motivo: e.motivo || (s.ok ? '' : s.veredicto),
      // Sólo el origen `propio` tiene contenedor local que encender o apagar.
      local: e.modulo_local,
    };
    _cache = { t: Date.now(), v };
    return v;
  }
  function invalidar() { _cache.v = null; }

  // ---------------------------------------------------------------- rutas
  /* Público (allowlist de auth.js): el softphone lo pide antes de tener sesión.
   * `no-store` porque el origen se cambia desde el panel y un ICE cacheado manda al
   * cliente al TURN viejo justo cuando alguien acaba de corregirlo. */
  app.get('/api/ice', async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(await iceServers()); }
    catch (e) { errorHttp(res, e); }
  });

  /* Selector de origen. Nunca devuelve contraseñas: sólo si hay una cargada. */
  app.get('/api/turn/origen', async (req, res) => {
    try {
      const s = await leerAjustes();
      const e = await origenEfectivo();
      let lk = null; try { lk = await sbcLink(); } catch (_) {}
      res.json({
        origen: e.origen,
        propio: { host: String(s[K.host] || ''), host_efectivo: e.origen === 'propio' ? e.host : hostPropioEnv(), puerto: +s[K.puerto] || PUERTO_TURN, usuario: process.env.TURN_USER || 'pbxng', tiene_clave: !!process.env.TURN_PASS },
        sbc: { disponible: !!(lk && lk.active), host: (lk && lk.host) || '', puerto: +s[K.sbcPuerto] || PUERTO_TURN, usuario: String(s[K.sbcUser] || ''), tiene_clave: !!s[K.sbcPass] },
        externo: { urls: String(s[K.extUrls] || ''), usuario: String(s[K.extUser] || ''), tiene_clave: !!s[K.extPass] },
        stun_url: String(s[K.stun] || ''),
        efectivo: { host: e.host, puerto: e.puerto, usable: e.usable, motivo: e.motivo, stun: e.stun },
      });
    } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/turn/origen', async (req, res) => {
    const b = req.body || {};
    const origen = String(b.origen || '').trim();
    if (!ORIGENES.includes(origen)) return res.status(400).json({ error: 'origen inválido: usá propio, sbc o externo' });
    try {
      if (origen === 'sbc') {
        const lk = await sbcLink(true);
        if (!lk || !lk.active) return res.status(400).json({ error: 'no hay un enlace a SBC-NG activo: conectalo primero desde Configuración → SBC-NG' });
        const u = b.sbc_usuario !== undefined ? String(b.sbc_usuario).trim() : String((await leerAjustes())[K.sbcUser] || '');
        if (!u) return res.status(400).json({ error: 'hace falta el usuario TURN del SBC-NG' });
      }
      if (origen === 'externo') {
        const urls = (b.externo_urls !== undefined ? String(b.externo_urls) : String((await leerAjustes())[K.extUrls] || '')).split(',').map((x) => x.trim()).filter(Boolean);
        if (!urls.length) return res.status(400).json({ error: 'cargá al menos una URL de TURN externo (turn:host:3478)' });
        const mala = urls.find((u) => !/^turns?:/i.test(u));
        if (mala) return res.status(400).json({ error: 'la URL «' + mala + '» no empieza con turn: o turns:' });
      }

      await guardar(K.origen, origen);
      if (b.propio_host !== undefined) await guardar(K.host, String(b.propio_host).trim());
      if (b.propio_puerto !== undefined) await guardar(K.puerto, String(+b.propio_puerto || ''));
      if (b.sbc_usuario !== undefined) await guardar(K.sbcUser, String(b.sbc_usuario).trim());
      if (b.sbc_clave) await guardar(K.sbcPass, String(b.sbc_clave));   // vacío = no cambiar
      if (b.sbc_puerto !== undefined) await guardar(K.sbcPuerto, String(+b.sbc_puerto || ''));
      if (b.externo_urls !== undefined) await guardar(K.extUrls, String(b.externo_urls).trim());
      if (b.externo_usuario !== undefined) await guardar(K.extUser, String(b.externo_usuario).trim());
      if (b.externo_clave) await guardar(K.extPass, String(b.externo_clave));
      if (b.stun_url !== undefined) await guardar(K.stun, String(b.stun_url).trim());

      /* UN SOLO ORIGEN A LA VEZ, y eso incluye el contenedor: si el TURN lo pone el SBC
       * o un tercero, el coturn local se apaga. Dos relays escuchando y uno solo
       * anunciado es el estado en el que nadie sabe cuál está sirviendo. */
      const local = origen === 'propio';
      let svc = null;
      try { await setModule('turn', local); } catch (e) { log.warn('no se pudo escribir mod_turn', { err: e.message }); }
      try { const r = await turnFwd('POST', '/service', { action: local ? 'start' : 'stop' }, 12000); svc = await r.json(); }
      catch (e) { svc = { error: e.message }; }   // sin contenedor coturn el reconciliador lo resuelve en el próximo ciclo

      invalidar();
      log.info('origen de TURN cambiado', { origen, coturn_local: local });
      const e = await origenEfectivo();
      res.json({ ok: true, origen, coturn_local: local, svc, efectivo: { host: e.host, puerto: e.puerto, usable: e.usable, motivo: e.motivo, stun: e.stun } });
    } catch (e) { errorHttp(res, e); }
  });

  /* Estado del módulo de infraestructura: lo DESEADO (el interruptor) contra lo que
   * de verdad está corriendo. El panel tiene que dibujar `corriendo`, no `deseado`. */
  app.get('/api/turn/estado', async (req, res) => {
    try { res.json(await estado(req.query.fresco === '1')); } catch (e) { errorHttp(res, e); }
  });

  /* Prueba de verdad, a pedido: STUN + Allocate + cordura del relay, UDP y TCP.
   * Es la misma que corre `scripts/check-turn.py` al terminar la instalación. */
  app.post('/api/turn/probe', async (req, res) => {
    try {
      const b = req.body || {};
      const e = await origenEfectivo();
      const host = String(b.host || e.host || '').trim();
      const puerto = +b.puerto || e.puerto;
      const usuario = b.usuario !== undefined ? String(b.usuario) : e.usuario;
      const clave = b.clave !== undefined ? String(b.clave) : e.clave;
      const [udp, tcp] = await Promise.all([
        sondear({ host, puerto, usuario, clave, tcp: false, ms: 5000 }),
        sondear({ host, puerto, usuario, clave, tcp: true, ms: 5000 }),
      ]);
      invalidar();
      res.json({ origen: e.origen, host, puerto, ok: udp.ok || tcp.ok, udp, tcp,
        veredicto: (udp.ok || tcp.ok) ? udp.veredicto || tcp.veredicto : (udp.veredicto || tcp.veredicto) });
    } catch (e) { errorHttp(res, e); }
  });

  // --- Consola del coturn propio (agente HTTP :8091 del contenedor) ---
  app.get('/api/turn', async (req, res) => { try { const r = await turnFwd('GET', '/health'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
  app.get('/api/turn/config', async (req, res) => { try { const r = await turnFwd('GET', '/config'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
  app.post('/api/turn/config', async (req, res) => { try { const r = await turnFwd('POST', '/config', req.body || {}, 15000); invalidar(); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
  app.post('/api/turn/restart', async (req, res) => { try { const r = await turnFwd('POST', '/restart', {}, 15000); invalidar(); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
  app.get('/api/turn/logs', async (req, res) => { try { const r = await turnFwd('GET', '/logs'); res.json(await r.json()); } catch (e) { errorHttp(res, e); } });
  /* «Probar TURN» del panel. ANTES se lo reenviaba al agente del contenedor, que corría
   * `turnutils_uclient` contra 127.0.0.1: dentro del propio coturn eso da OK SIEMPRE,
   * incluso con el relay escuchando sólo en el bridge de Docker —que es el caso real que
   * nos dejó una central entera sin audio—. Ahora corre la misma sonda que el
   * instalador, desde la API y contra la dirección que se le reparte a los softphones. */
  app.post('/api/turn/test', async (req, res) => {
    try {
      const e = await origenEfectivo();
      const [udp, tcp] = await Promise.all([
        sondear({ host: e.host, puerto: e.puerto, usuario: e.usuario, clave: e.clave, tcp: false, ms: 5000 }),
        sondear({ host: e.host, puerto: e.puerto, usuario: e.usuario, clave: e.clave, tcp: true, ms: 5000 }),
      ]);
      invalidar();
      const linea = (p) => [p.proto + ' ' + e.host + ':' + e.puerto]
        .concat(p.pasos.map((x) => '  ' + (x.ok ? 'OK  ' : 'FALLA ') + x.paso + ' · ' + x.detalle))
        .concat(['  => ' + (p.ok ? 'OK · ' : 'FALLA · ') + p.veredicto]).join('\n');
      res.json({ ok: udp.ok || tcp.ok, origen: e.origen, udp, tcp, out: linea(udp) + '\n\n' + linea(tcp) });
    } catch (e) { errorHttp(res, e); }
  });

  return { iceServers, origenEfectivo, estado, invalidar, sondear };
};

// Se exportan aparte para poder probarlas sin levantar Express ni Postgres.
module.exports.sondear = sondear;
module.exports.relayInservible = relayInservible;
module.exports.esPrivada = esPrivada;
module.exports.ORIGENES = ORIGENES;
