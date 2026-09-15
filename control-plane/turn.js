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
 *  DOS REGLAS QUE VALEN MÁS QUE CUALQUIER PARCHE PUNTUAL, aprendidas midiendo:
 *   1. `/api/ice` NUNCA queda sin un `stun:` utilizable. Es la última red del WebRTC:
 *      sin STUN el navegador junta sólo candidatos de host y cualquiera detrás de un
 *      NAT se queda mudo, sin un mensaje de error. Si el origen elegido no da host, se
 *      cae al host propio del appliance —inocuo en los tres orígenes, porque es esta
 *      misma central— y nunca a un tercero.
 *   2. NO SE APAGA LO QUE ANDA HASTA COMPROBAR QUE LO NUEVO SIRVE. Cambiar el origen a
 *      uno ajeno apaga el coturn local; hacerlo antes de sondear el relay nuevo deja a
 *      la central sin ningún TURN mientras se averigua si el nuevo existía.
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

/* ---------------------------------------------------------------------------
 *  UNA SOLA lectura de una URL `turn:`/`turns:`, porque la usan TRES lugares: el
 *  origen efectivo (de ahí saca host y puerto), la validación del PUT y el armado de
 *  `/api/ice`. Mientras la validación fue una copia más floja que el parseo —«empieza
 *  con turn:» y nada más—, un `turn:` pelado (sin host) pasaba el 400, no matcheaba el
 *  parseo, dejaba el host vacío y con eso `/api/ice` salía SIN NINGUNA entrada `stun:`
 *  y con una `turn:` inválida. Chrome y Edge tiran `SyntaxError` al construir el
 *  RTCPeerConnection con una `urls` así: no degradan la llamada, la rompen entera. Y
 *  como `auth.js` arma el QR de provisión con la MISMA función, un teléfono de
 *  escritorio se llevaba esa configuración GRABADA y no se arreglaba sola cuando
 *  alguien corregía el panel. Dos ideas de «qué es una URL de TURN válida» siempre
 *  terminan en que la más floja decide.
 * ------------------------------------------------------------------------- */
const RE_URL_TURN = /^turns?:\[?([^\]/?]+?)\]?(?::(\d+))?(?:\?.*)?$/i;
const RE_URL_STUN = /^stuns?:\[?([^\]/?]+?)\]?(?::(\d+))?(?:\?.*)?$/i;
/* Un host suelto (el que se escribe en «host del TURN propio»): sin espacios, sin
 * barras y sin esquema. `mi central` o `http://foo/bar` terminaban armando una `urls`
 * que el navegador no puede construir, igual que la URL sin host. Los dos puntos sólo
 * se aceptan DENTRO de corchetes (IPv6): si no, `turn:` pasaba como nombre de host. */
const RE_HOST = /^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9._-]{1,253})$/;

/* Un host aceptable, venga con corchetes o sin ellos: la expresión de la URL ya se los
 * saca, así que un IPv6 llega pelado y hay que volver a ponérselos para juzgarlo. */
function hostOk(h) { const v = String(h == null ? '' : h).trim(); return RE_HOST.test(v) || RE_HOST.test('[' + v + ']'); }

function conPuerto(m) {
  if (!m || !m[1]) return null;
  /* El host también se valida acá y no sólo «que haya algo»: la clase de caracteres de
   * la expresión de arriba acepta espacios, así que `stun:no es una url` pasaba como
   * una URL con host «no es una url» y se publicaba tal cual. */
  if (!hostOk(m[1])) return null;
  const puerto = m[2] ? +m[2] : PUERTO_TURN;
  if (!(puerto > 0 && puerto <= 65535)) return null;
  return { host: m[1], puerto };
}
function parseUrlTurn(u) { return conPuerto(RE_URL_TURN.exec(String(u == null ? '' : u).trim())); }
/* La hermana de `parseUrlTurn`, y existe por la misma razón: el agujero se cerró para
 * `turn:` y seguía abierto por la puerta de al lado. Un `stun:` pelado, un
 * `http://stun.example` o un `stun:,,` pasaban sin que nadie los mirara y se publicaban
 * en `/api/ice` —y de ahí al QR de provisión, o sea GRABADOS en el teléfono—. */
function parseUrlStun(u) { return conPuerto(RE_URL_STUN.exec(String(u == null ? '' : u).trim())); }
function hostSueltoOk(h) { return !!String(h == null ? '' : h).trim() && hostOk(h); }

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

/**
 * ¿Por qué este relay NO le sirve a un cliente? Devuelve el motivo o null.
 * Está separado de `sondear()` a propósito: es la regla que decide si el panel pinta
 * verde o rojo, y una regla que sólo se puede ejercitar levantando un TURN de verdad
 * no se prueba nunca. `hostIp` es la IP **resuelta** del TURN, no la cadena que
 * escribió el administrador: con un nombre (`DOMAIN`, que es el caso normal) la
 * comparación de abajo daba falso siempre y un coturn anunciando 172.17.0.1 pasaba
 * como OK — o sea, la sonda escrita para detectar ese caso no lo detectaba.
 */
function motivoRelay(relayIp, hostIp) {
  const roto = relayInservible(relayIp);
  if (roto) return roto;
  /* El caso del coturn del SBC: el TURN se anuncia en una dirección pública o de otra
   * red, pero el relay que reparte es privado. Desde adentro de esa misma LAN "anda";
   * desde afuera —que es para lo que existe el TURN— no llega nadie. */
  if (esPrivada(relayIp) && hostIp && !esPrivada(hostIp)) {
    return 'el relay anuncia una dirección privada (' + relayIp + '): los clientes de afuera no la alcanzan. Falta `external-ip` en turnserver.conf o el port-forward del rango relay.';
  }
  return null;
}

/**
 * LA REGLA DE AGREGACIÓN de la sonda, escrita UNA sola vez (docs/CONTRATOS.md §3).
 * La comparten `POST /api/turn/probe`, `POST /api/turn/test` y `scripts/check-turn.py`
 * (que la reimplementa en Python, con este mismo comentario como referencia).
 *
 * **Alcanza con UN transporte**: `ok = udp.ok || tcp.ok`.
 * El porqué, que es lo único que importa acá: la pregunta que contesta la sonda es
 * «¿un softphone detrás de un NAT simétrico va a tener audio?», y para eso necesita UN
 * candidato relay, no dos. Con TURN sobre UDP andando ya lo tiene. Exigir los dos
 * (AND) declaraba rota la configuración más común de todas —port-forward de 3478/udp y
 * nada más— al final de CADA instalación.
 * TURN sobre TCP es el plan B de la red que bloquea UDP saliente (un hotel, una oficina
 * con proxy): sin él ese cliente puntual queda sin audio y el resto anda. O sea MEJORA,
 * no ROMPE —la regla del producto—, así que va como `aviso`, no como falla.
 */
function agregar(udp, tcp) {
  const partes = [udp, tcp].filter(Boolean);
  const buenos = partes.filter((p) => p.ok);
  const malos = partes.filter((p) => !p.ok);
  const ok = buenos.length > 0;
  return {
    ok,
    veredicto: ok ? buenos[0].veredicto : (partes[0] && partes[0].veredicto) || '',
    // El aviso existe para el caso mixto: verde SÍ, pero diciendo a quién deja afuera.
    aviso: ok && malos.length
      ? malos.map((p) => p.proto === 'TCP'
        ? 'TURN sobre TCP no entrega relay (' + p.veredicto + '): los clientes en redes que bloquean UDP saliente van a quedar sin audio. Falta abrir 3478/tcp.'
        : 'TURN sobre UDP no entrega relay (' + p.veredicto + '): todo el medio va a ir por TCP, con más latencia y peor calidad. Falta abrir 3478/udp.').join(' · ')
      : '',
  };
}

/* ---------------------------------------------------------------------------
 *  Cliente STUN/TURN mínimo (RFC 5389 / 8656) sin dependencias.
 *  Es el mismo camino que scripts/check-turn.py, para que el panel y la consola
 *  del instalador den el MISMO veredicto.
 * ------------------------------------------------------------------------- */
const MAGIC = 0x2112a442;
const M_BINDING = 0x0001, M_ALLOCATE = 0x0003, M_REFRESH = 0x0004;
const A_XOR_MAPPED = 0x0020, A_USERNAME = 0x0006, A_MI = 0x0008, A_ERROR = 0x0009;
const A_REALM = 0x0014, A_NONCE = 0x0015, A_XOR_RELAYED = 0x0016, A_REQ_TRANSPORT = 0x0019;
const A_LIFETIME = 0x000d;

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

/* Una CONEXIÓN al TURN que sobrevive a varios intercambios, UDP o TCP, con timeout
 * duro por pedido. Existe por una razón concreta: en UDP la asignación TURN queda atada
 * a la 5-tupla (RFC 8656 §5), así que el `Refresh lifetime=0` que la LIBERA tiene que
 * salir por el MISMO socket que hizo el Allocate. Con un socket por intercambio el
 * Refresh llegaba desde otro puerto de origen y el servidor ni se enteraba.
 * El socket se cierra siempre: una sonda que deja descriptores abiertos termina
 * tumbando la API. */
function conexion(host, puerto, tcp) {
  let sock = null;
  let buf = Buffer.alloc(0);
  let pend = null;      // { resolve, reject, t } — los pedidos son de a uno, en orden
  let roto = null;
  const fallar = (e) => { roto = e; if (pend) { const p = pend; pend = null; clearTimeout(p.t); p.reject(e); } };
  /* Se entrega sólo la respuesta al pedido EN CURSO: el transaction id tiene que
   * coincidir. Con la conexión reusada, un datagrama duplicado o la retransmisión tardía
   * del Allocate llegaría cuando ya se está esperando la respuesta del Refresh, y sin
   * esta comparación se resolvería ese pedido con el mensaje equivocado. */
  const entregar = (d) => {
    if (!pend || d.length < 20) return;
    if (!d.slice(8, 20).equals(pend.tid)) return;
    const p = pend; pend = null; clearTimeout(p.t); p.resolve(d);
  };

  function abrir() {
    if (sock) return;
    if (tcp) {
      /* TCP no respeta los límites del mensaje: hay que acumular hasta tener la
       * respuesta ENTERA (20 bytes de cabecera + el `length` que declara) antes de
       * parsearla. Con `resolve` en el primer `data`, un Allocate firmado —que viene con
       * realm, nonce y MESSAGE-INTEGRITY, o sea el más largo y el candidato natural a
       * llegar partido— se leía truncado y la sonda declaraba «no se comporta como TURN»
       * sobre un TURN sano. Un falso negativo en la herramienta que existe justamente
       * para no creerle al panel es peor que no tener herramienta. Y al revés: dos
       * respuestas pegadas en el mismo `data` se separan acá, porque ahora la conexión
       * se reusa y la segunda es la del Refresh. */
      sock = net.connect({ host, port: puerto });
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 20 && buf.length >= 20 + buf.readUInt16BE(2)) {
          const n = 20 + buf.readUInt16BE(2);
          const msg = buf.slice(0, n);
          buf = buf.slice(n);
          entregar(msg);
        }
      });
      sock.on('error', fallar);
    } else {
      sock = dgram.createSocket('udp4');
      sock.on('message', (d) => entregar(d));
      sock.on('error', fallar);
    }
  }

  return {
    pedir(msg, ms) {
      return new Promise((resolve, reject) => {
        if (roto) return reject(roto);
        try { abrir(); } catch (e) { return reject(e); }
        pend = { resolve, reject, tid: msg.slice(8, 20), t: setTimeout(() => { pend = null; reject(new Error('sin respuesta (timeout)')); }, ms) };
        try {
          if (tcp) { if (sock.connecting) sock.once('connect', () => { try { sock.write(msg); } catch (e) { fallar(e); } }); else sock.write(msg); }
          else sock.send(msg, puerto, host, (e) => { if (e) fallar(e); });
        } catch (e) { fallar(e); }
      });
    },
    cerrar() {
      try { if (!sock) return; if (tcp) sock.destroy(); else sock.close(); } catch (_) {}
      sock = null;
    },
  };
}

/* Un intercambio suelto pedido→respuesta: abre, pregunta y cierra. */
async function intercambio(host, puerto, msg, tcp, ms) {
  const cx = conexion(host, puerto, tcp);
  try { return await cx.pedir(msg, ms); } finally { cx.cerrar(); }
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
  const cred = [attr(A_USERNAME, Buffer.from(usuario, 'utf8')), attr(A_REALM, realm), attr(A_NONCE, nonce)];
  const attrs = Buffer.concat([attr(A_REQ_TRANSPORT, Buffer.from([17, 0, 0, 0]))].concat(cred));
  /* La misma conexión para el Allocate y para el Refresh que lo libera: en UDP la
   * asignación vive atada a la 5-tupla, así que un Refresh desde otro socket no libera
   * nada. */
  const cx = conexion(host, puerto, tcp);
  try {
    let at2;
    try {
      const r = leer(await cx.pedir(armar(M_ALLOCATE, crypto.randomBytes(12), attrs, key), tope));
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
    const motivo = motivoRelay(relay && relay.ip, hostIp);
    pasos.push(motivo
      ? { paso: 'Allocate firmado', ok: false, detalle: 'relay ' + res.relay + ' — ' + motivo }
      : { paso: 'Allocate firmado', ok: true, detalle: 'relay = ' + res.relay });

    /* DEVOLVER LA ASIGNACIÓN (RFC 8656 §7), pase lo que pase con el veredicto: un
     * Allocate que sale bien deja una asignación viva en coturn con su lifetime —600 s
     * por defecto— y unos puertos de relay reservados. Esta sonda no la corre una
     * persona de vez en cuando: la pantalla del TURN mide cada 30 s y el Resumen cada
     * 60, así que irse sin cerrar era ir dejando asignaciones colgadas justo en el relay
     * que la sonda existe para cuidar. Es «mejor esfuerzo»: si el Refresh no llega, la
     * asignación vence igual, y por eso NO toca `res.ok` —el veredicto es sobre el
     * relay, no sobre nuestra prolijidad—. */
    let liberada;
    try {
      const rl = leer(await cx.pedir(armar(M_REFRESH, crypto.randomBytes(12), Buffer.concat([attr(A_LIFETIME, Buffer.from([0, 0, 0, 0]))].concat(cred)), key), tope));
      liberada = rl.tipo === 0x0104 ? true : 'error ' + codigoError(rl.at);
    } catch (e) { liberada = e.message; }
    res.liberada = liberada === true;
    pasos.push(res.liberada
      ? { paso: 'Refresh lifetime=0', ok: true, detalle: 'asignación devuelta (la sonda no deja relay reservado)' }
      : { paso: 'Refresh lifetime=0', ok: false, detalle: 'no se pudo devolver la asignación (' + liberada + '): vence sola al cumplirse el lifetime' });

    if (motivo) { res.veredicto = motivo; return res; }
    res.ok = true;
    res.veredicto = 'el TURN entrega candidato relay: WebRTC funciona detrás de NAT simétrico';
    return res;
  } finally { cx.cerrar(); }
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
  async function origenEfectivo(sCandidato) {
    /* `sCandidato` permite resolver un origen que TODAVÍA NO SE GUARDÓ: lo usa el PUT
     * para sondear lo nuevo antes de apagar lo que anda. Sin parámetro, lo de la base. */
    const s = sCandidato || await leerAjustes();
    const origen = ORIGENES.includes(s[K.origen]) ? s[K.origen] : 'propio';
    const stunManual = String(s[K.stun] || process.env.STUN_URL || '').trim();
    const out = { origen, host: '', puerto: PUERTO_TURN, usuario: '', clave: '', usable: false, motivo: '', stun: [], modulo_local: false };

    if (origen === 'propio') {
      out.modulo_local = true;
      const hManual = String(s[K.host] || '').trim();
      out.host = (hManual && hostSueltoOk(hManual) ? hManual : '') || (hostSueltoOk(hostPropioEnv()) ? hostPropioEnv() : '');
      if (hManual && !hostSueltoOk(hManual)) out.motivo = 'el host del TURN propio («' + hManual + '») no es un nombre ni una dirección válida';
      out.puerto = +s[K.puerto] || PUERTO_TURN;
      out.usuario = process.env.TURN_USER || 'pbxng';
      out.clave = process.env.TURN_PASS || '';
      if (!out.host) out.motivo = 'el appliance no tiene dirección pública: cargá PUBLIC_IP/DOMAIN o el host del TURN en el panel';
      /* EL BUG FUNDACIONAL DE ESTE MÓDULO, alcanzable con un solo interruptor: con el
       * módulo `turn` apagado desde Configuración → Módulos, la API seguía repartiendo
       * `turn:<host>` —con usuario y clave— de un coturn que ella misma acababa de parar.
       * Es literalmente lo que dice el encabezado que vinimos a arreglar. El `stun:` se
       * mantiene (el appliance sigue ahí y es la última red del WebRTC); lo que no se
       * publica es la entrada `turn:`, ni se regala la clave por una ruta pública para
       * un relay que no existe. */
      else if (!(await moduleEnabled('turn'))) {
        out.motivo = 'el coturn de este appliance está apagado desde Configuración → Módulos';
      }
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
      const m = parseUrlTurn(urls[0]);
      out.host = m ? m.host : '';
      out.puerto = m ? m.puerto : PUERTO_TURN;
      /* Las URL mal formadas se filtran ACÁ además de en el PUT: en una central que ya
       * guardó una `turn:` sin host —lo que el PUT dejaba pasar— el origen tiene que
       * salir NO utilizable y decir por qué, en vez de quedar «usable» con host vacío. */
      const malas = urls.filter((u) => !parseUrlTurn(u));
      if (!urls.length) out.motivo = 'no se cargó ninguna URL de TURN externo';
      else if (malas.length) out.motivo = 'la URL «' + malas[0] + '» no tiene host: una URL así rompe el RTCPeerConnection del softphone en vez de degradarlo';
      else if (!out.usuario || !out.clave) out.motivo = 'faltan usuario y clave del TURN externo';
      else out.usable = true;
    }

    /* STUN: lo elegido a mano, si no el propio origen. NUNCA un servicio público:
     * una central sin salida a internet no puede depender de Google para juntar
     * candidatos (es el mismo problema que bajar una librería de un CDN en runtime). */
    /* Lo cargado a mano se NORMALIZA y se FILTRA: una entrada que no parsea no se
     * publica, y si no queda ninguna sana se cae al propio appliance como si no hubiera
     * nada configurado. Publicar lo que el administrador escribió mal es exactamente el
     * camino por el que una URL rota llegaba al teléfono. */
    const stunSano = stunManual
      ? stunManual.split(',').map((x) => x.trim()).filter(Boolean)
        .map((u) => (/^stuns?:/i.test(u) ? u : 'stun:' + u))
        .filter((u) => parseUrlStun(u))
      : [];
    if (stunSano.length) {
      out.stun = stunSano;
    } else {
      /* EL STUN ES LA ÚLTIMA RED DEL WebRTC y por eso esta lista no puede quedar vacía.
       * Sin una sola entrada `stun:` el navegador arma la oferta sólo con candidatos de
       * host: dos softphones en la misma LAN se escuchan, y cualquiera detrás de un NAT
       * se queda mudo sin un solo mensaje de error. Pasaba justo cuando el origen
       * elegido NO daba host (una URL externa sin host, el SBC sin enlace): el TURN ya
       * estaba roto y encima se iba también el STUN, que es lo único que seguía
       * sirviendo. Así que si el origen no da host se cae al host propio del appliance:
       * es inocuo en los tres orígenes —es esta misma central, no un tercero— y es lo
       * que promete CONTRATOS §3 («el STUN por defecto es el propio appliance»). */
      const hPropio = hostPropioEnv();
      const h = out.host || hPropio;
      const pto = out.host ? out.puerto : (+s[K.puerto] || PUERTO_TURN);
      out.stun = h ? ['stun:' + h + ':' + pto] : [];
    }
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
        /* Sólo las URL que PARSEAN. Una `urls` inválida (`turn:` pelado, por ejemplo) no
         * degrada nada: Chrome y Edge tiran SyntaxError al construir el
         * RTCPeerConnection y se cae la llamada entera —y el QR de provisión, que sale
         * de esta misma función, se la graba al teléfono de escritorio—. Si no queda
         * ninguna URL sana no se publica la entrada: mejor sólo STUN que una lista que
         * el cliente no puede ni construir. */
        const urls = (e.urls || []).filter((u) => parseUrlTurn(u));
        if (urls.length) ice.push({ urls, username: e.usuario, credential: e.clave });
      } else {
        ice.push({ urls: 'turn:' + e.host + ':' + e.puerto + '?transport=udp', username: e.usuario, credential: e.clave });
        ice.push({ urls: 'turn:' + e.host + ':' + e.puerto + '?transport=tcp', username: e.usuario, credential: e.clave });
      }
    }
    return { iceServers: ice, origen: e.origen, motivo: e.motivo || undefined };
  }

  /* Los dos transportes en paralelo, con la regla de agregación. Lo comparten la
   * verificación del PUT, `POST /api/turn/probe` y `POST /api/turn/test`: tres lugares
   * que tienen que dar EL MISMO veredicto sobre el mismo relay. */
  async function sondaDoble(e, ms) {
    const [udp, tcp] = await Promise.all([
      sondear({ host: e.host, puerto: e.puerto, usuario: e.usuario, clave: e.clave, tcp: false, ms }),
      sondear({ host: e.host, puerto: e.puerto, usuario: e.usuario, clave: e.clave, tcp: true, ms }),
    ]);
    return { udp, tcp, ...agregar(udp, tcp) };
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
    /* NO se sondea cuando no hay nada que sondear. Esta función la piden dos pantallas
     * en bucle (el TURN cada 30 s, el Resumen cada 60) y cada sonda son tres
     * intercambios contra el relay: correrla con el coturn propio apagado a propósito
     * —o sin host configurado— es gastar tiempo de request y ruido en los logs del
     * relay para confirmar lo que el motivo ya explica. Ojo con la condición: con el
     * origen `sbc` o `externo` el interruptor local está en OFF POR DISEÑO y ahí sí hay
     * que medir, porque el relay lo corre otro. */
    const apagadoAdrede = e.modulo_local && !deseado;
    const sondeado = !!e.host && !apagadoAdrede;
    const s = !sondeado
      ? { ok: false, relay: null, mapped: null, veredicto: apagadoAdrede ? 'el coturn de este appliance está apagado desde Configuración → Módulos' : 'no hay ningún host de TURN configurado' }
      : await sondear({ host: e.host, puerto: e.puerto, usuario: e.usuario, clave: e.clave, ms: 1800 });
    const v = {
      origen: e.origen, host: e.host, puerto: e.puerto,
      /* `deseado` es lo que dice pbxng_settings (el interruptor); `corriendo` es lo que
       * contestó el servidor. Cuando difieren, el que miente es el panel. */
      deseado, corriendo: s.ok, relay: s.relay, mapped: s.mapped,
      /* `sondeado:false` = no se midió (el coturn propio está apagado a propósito, o no
       * hay host configurado). Un `corriendo:false` sin medición no es lo mismo que uno
       * medido, y esa diferencia se dice: el módulo entero existe para que el panel no
       * afirme lo que no comprobó. */
      sondeado,
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
      const actuales = await leerAjustes();
      if (origen === 'sbc') {
        const lk = await sbcLink(true);
        if (!lk || !lk.active) return res.status(400).json({ error: 'no hay un enlace a SBC-NG activo: conectalo primero desde Configuración → SBC-NG' });
        const u = b.sbc_usuario !== undefined ? String(b.sbc_usuario).trim() : String(actuales[K.sbcUser] || '');
        if (!u) return res.status(400).json({ error: 'hace falta el usuario TURN del SBC-NG' });
      }
      if (origen === 'externo') {
        const urls = (b.externo_urls !== undefined ? String(b.externo_urls) : String(actuales[K.extUrls] || '')).split(',').map((x) => x.trim()).filter(Boolean);
        if (!urls.length) return res.status(400).json({ error: 'cargá al menos una URL de TURN externo (turn:host:3478)' });
        /* La MISMA `parseUrlTurn()` que después saca el host y arma `/api/ice`, no una
         * segunda copia más floja. Cuando acá sólo se miraba «empieza con turn:», un
         * `turn:` sin host guardaba bien, dejaba el host vacío y el panel cantaba verde
         * mientras `/api/ice` salía sin un solo `stun:` y con una URL que le hace tirar
         * SyntaxError al navegador. La validación y el parseo tienen que ser la misma
         * idea: si no, la más floja es la que manda. */
        const mala = urls.find((u) => !parseUrlTurn(u));
        if (mala) {
          return res.status(400).json({ error: 'la URL «' + mala + '» no es una URL de TURN válida: tiene que ser turn:host[:puerto] o turns:host[:puerto] (con host, que es lo que se le reparte al softphone)' });
        }
      }

      /* El STUN y el host propio van por el MISMO control que las URL de TURN, y no por
       * uno más flojo: el bloqueante de la ronda anterior se cerró para `turn:` y seguía
       * abierto acá al lado. Todo lo que termina en `/api/ice` termina también en el QR
       * de provisión, o sea GRABADO en un teléfono de escritorio que no se arregla
       * cuando alguien corrige el panel. */
      if (b.stun_url !== undefined && String(b.stun_url).trim()) {
        const malo = String(b.stun_url).split(',').map((x) => x.trim()).filter(Boolean)
          .map((u) => (/^stuns?:/i.test(u) ? u : 'stun:' + u))
          .find((u) => !parseUrlStun(u));
        if (malo) return res.status(400).json({ error: 'el STUN «' + malo + '» no es válido: tiene que ser stun:host[:puerto] (o el host solo)' });
      }
      if (b.propio_host !== undefined && String(b.propio_host).trim() && !hostSueltoOk(b.propio_host)) {
        return res.status(400).json({ error: 'el host del TURN propio no puede tener espacios, barras ni esquema: escribí el nombre o la dirección, por ejemplo central.ejemplo.com' });
      }
      if (b.propio_puerto !== undefined && String(b.propio_puerto).trim()) {
        const pto = +b.propio_puerto;
        if (!(pto > 0 && pto <= 65535)) return res.status(400).json({ error: 'el puerto del TURN propio tiene que estar entre 1 y 65535' });
      }

      /* Los cambios se arman UNA vez y se usan dos: primero para resolver el origen
       * candidato sin escribir nada, después para guardarlo. Dos listas separadas
       * —una para verificar y otra para guardar— es cómo se termina verificando una
       * cosa y guardando otra. */
      const cambios = [[K.origen, origen]];
      const poner = (cond, k, v) => { if (cond) cambios.push([k, v]); };
      poner(b.propio_host !== undefined, K.host, String(b.propio_host).trim());
      poner(b.propio_puerto !== undefined, K.puerto, String(+b.propio_puerto || ''));
      poner(b.sbc_usuario !== undefined, K.sbcUser, String(b.sbc_usuario).trim());
      poner(!!b.sbc_clave, K.sbcPass, String(b.sbc_clave));   // vacío = no cambiar
      poner(b.sbc_puerto !== undefined, K.sbcPuerto, String(+b.sbc_puerto || ''));
      poner(b.externo_urls !== undefined, K.extUrls, String(b.externo_urls).trim());
      poner(b.externo_usuario !== undefined, K.extUser, String(b.externo_usuario).trim());
      poner(!!b.externo_clave, K.extPass, String(b.externo_clave));
      poner(b.stun_url !== undefined, K.stun, String(b.stun_url).trim());

      /* UN SOLO ORIGEN A LA VEZ, y eso incluye el contenedor: si el TURN lo pone el SBC
       * o un tercero, el coturn local se apaga. Dos relays escuchando y uno solo
       * anunciado es el estado en el que nadie sabe cuál está sirviendo. */
      const local = origen === 'propio';

      /* NO SE APAGA LO QUE ANDA HASTA COMPROBAR QUE LO NUEVO SIRVE.
       * Antes esto guardaba, apagaba el coturn local y recién después alguien se
       * enteraba —mirando el panel— de si el relay nuevo existía: la validación previa
       * era de FORMA (que la URL empiece con turn:), no de funcionamiento. El resultado
       * de un dedazo en el host era una central sin ningún relay, y sin aviso, porque
       * las llamadas detrás de NAT simétrico se caen calladas.
       * Así que el candidato se resuelve EN MEMORIA (nada escrito todavía) y se sondea
       * de verdad; recién si entrega candidato relay se guarda y se apaga lo local.
       * Volver a `propio` no pasa por acá a propósito: no apaga nada, ENCIENDE, y es la
       * salida de emergencia que tiene que estar disponible siempre —incluso con el
       * coturn caído, que es justo cuando hace falta—.
       * `forzar: true` es la puerta del administrador que sabe lo que hace: un relay que
       * sólo contesta desde afuera del NAT (sin hairpin) es un caso real y legítimo. */
      const candidato = await origenEfectivo({ ...actuales, ...Object.fromEntries(cambios) });
      let verificacion = null;
      if (!local && !b.forzar) {
        if (!candidato.usable) {
          return res.status(400).json({ error: candidato.motivo || 'el origen nuevo no está utilizable', sin_cambios: true });
        }
        verificacion = await sondaDoble(candidato, 4000);
        if (!verificacion.ok) {
          log.warn('cambio de origen de TURN rechazado: el relay nuevo no contesta', { origen, host: candidato.host, veredicto: verificacion.veredicto });
          return res.status(409).json({
            error: 'el TURN nuevo no entrega candidato relay: ' + verificacion.veredicto
              + ' · No se cambió nada y el coturn de este appliance sigue como estaba. Corregí los datos, o volvé a mandarlo con «cambiar igual» si sabés que ese relay sólo responde desde afuera.',
            sin_cambios: true, verificacion,
          });
        }
      }

      for (const [k, v] of cambios) await guardar(k, v);

      let svc = null;
      try { await setModule('turn', local); } catch (e) { log.warn('no se pudo escribir mod_turn', { err: e.message }); }
      try { const r = await turnFwd('POST', '/service', { action: local ? 'start' : 'stop' }, 12000); svc = await r.json(); }
      catch (e) { svc = { error: e.message }; }   // sin contenedor coturn el reconciliador lo resuelve en el próximo ciclo

      invalidar();
      log.info('origen de TURN cambiado', { origen, coturn_local: local, verificado: !!(verificacion && verificacion.ok), forzado: !!b.forzar });
      const e = await origenEfectivo();
      res.json({
        ok: true, origen, coturn_local: local, svc, forzado: !!b.forzar,
        // Lo que midió la verificación viaja al panel: «guardado» no es «anda».
        verificacion: verificacion ? { ok: verificacion.ok, veredicto: verificacion.veredicto, aviso: verificacion.aviso } : null,
        efectivo: { host: e.host, puerto: e.puerto, usable: e.usable, motivo: e.motivo, stun: e.stun },
      });
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
      /* SIN CUERPO, a propósito: se sondea el origen EFECTIVO y nada más. Aceptar host,
       * puerto, usuario y clave por el cuerpo convertía a este endpoint en una primitiva
       * de escaneo de red desde la central —un admin del panel podía preguntarle a la
       * PBX si tal IP:puerto de la LAN contesta, y con qué—, y además permitía probar
       * algo distinto de lo que `/api/ice` le reparte a los softphones: un verde que no
       * corresponde a la realidad es peor que no tener botón. El panel ya lo llama sin
       * cuerpo (`TurnOrigen.jsx`); esto lo vuelve la única forma posible. */
      const e = await origenEfectivo();
      const g = await sondaDoble(e, 5000);
      invalidar();
      // La regla de agregación vive en `agregar()`, no acá: es la MISMA que tiene que
      // dar `scripts/check-turn.py` al final de la instalación (docs/CONTRATOS.md §3).
      res.json({ origen: e.origen, host: e.host, puerto: e.puerto, ok: g.ok, udp: g.udp, tcp: g.tcp, veredicto: g.veredicto, aviso: g.aviso });
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
      const g = await sondaDoble(e, 5000);
      invalidar();
      const linea = (p) => [p.proto + ' ' + e.host + ':' + e.puerto]
        .concat(p.pasos.map((x) => '  ' + (x.ok ? 'OK  ' : 'FALLA ') + x.paso + ' · ' + x.detalle))
        .concat(['  => ' + (p.ok ? 'OK · ' : 'FALLA · ') + p.veredicto]).join('\n');
      res.json({ ok: g.ok, origen: e.origen, udp: g.udp, tcp: g.tcp, veredicto: g.veredicto, aviso: g.aviso,
        out: [linea(g.udp), linea(g.tcp)].concat(g.aviso ? ['AVISO · ' + g.aviso] : []).join('\n\n') });
    } catch (e) { errorHttp(res, e); }
  });

  return { iceServers, origenEfectivo, estado, invalidar, sondear };
};

// Se exportan aparte para poder probarlas sin levantar Express ni Postgres.
module.exports.sondear = sondear;
module.exports.agregar = agregar;
module.exports.parseUrlTurn = parseUrlTurn;
module.exports.motivoRelay = motivoRelay;
module.exports.relayInservible = relayInservible;
module.exports.esPrivada = esPrivada;
module.exports.ORIGENES = ORIGENES;
