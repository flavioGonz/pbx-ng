// PBX-NG Softphone · descubrir camaras por ONVIF y sacarles la URL RTSP
//
// QUE PROBLEMA RESUELVE. Para agregar una camara hay que pegar una URL como
// `rtsp://usuario:clave@192.168.1.50:554/Streaming/Channels/101`. Ese path no se adivina:
// cambia por fabricante, por modelo y por canal, y el tecnico termina buscandolo en un
// foro o probando a ciegas con VLC. ONVIF es el estandar que todas estas camaras hablan y
// que contesta exactamente esa pregunta: deci quien sos y te doy tus perfiles con su URL.
//
// POR QUE ACA Y NO EN LA CENTRAL. El que esta agregando la camara esta parado al lado de
// la camara, con el softphone en la misma LAN. La central casi nunca ve esa red. Ademas el
// descubrimiento es multicast (239.255.255.250:3702): no atraviesa routers, tiene que
// salir del equipo que esta en el mismo segmento.
//
// POR QUE SIN DEPENDENCIAS. El paquete `onvif` de npm arrastra un parser XML completo y
// mas superficie de la que esto necesita. Aca se usan tres mensajes SOAP fijos y se leen
// cuatro campos. El parseo es por expresion regular, que para XML en general es una mala
// idea — y queda dicho: vale SOLO porque son respuestas de forma conocida y de las que
// solo se extraen campos simples. Si algun dia hace falta leer el arbol, entra un parser.
'use strict';

const dgram = require('dgram');
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

const MULTICAST = '239.255.255.250';
const PUERTO_WSD = 3702;

/* Saca el contenido de la PRIMERA etiqueta con ese nombre local, ignorando el prefijo de
 * espacio de nombres (tds:, trt:, tt:, sin prefijo: cada fabricante usa el suyo). */
/* El XML viene con entidades: la URL que devuelve GetStreamUri trae `&amp;` entre los
 * parametros de la query. Pasarla asi a go2rtc le da un `&amp;profile=` literal y la
 * camara contesta cualquier cosa — la URL hay que DESESCAPARLA, no copiarla. */
function desescapar(v) {
  return String(v || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&');     // ultimo: si no, un `&amp;lt;` se convertiria dos veces
}
function tag(xml, nombre) {
  const m = new RegExp('<(?:[A-Za-z0-9_.-]+:)?' + nombre + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?' + nombre + '>').exec(xml || '');
  return m ? desescapar(m[1].trim()) : '';
}
/* Devuelve, por cada elemento, los ATRIBUTOS de la etiqueta de apertura y su contenido.
 * Los dos por separado y a proposito: el token del perfil viaja como atributo
 * (`<trt:Profiles token="Profile_1">`) y el resto como hijos. La primera version devolvia
 * solo el contenido, asi que el token salia vacio, no entraba ningun perfil y el error que
 * se veia era «ningun perfil devolvio URL RTSP» — que apuntaba al lado equivocado. */
function tagTodos(xml, nombre) {
  const rx = new RegExp('<(?:[A-Za-z0-9_.-]+:)?' + nombre + '((?:\\s[^>]*)?)>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?' + nombre + '>', 'g');
  const out = []; let m;
  while ((m = rx.exec(xml || ''))) out.push({ attrs: m[1] || '', inner: m[2] || '' });
  return out;
}
const atributo = (frag, attr) => { const m = new RegExp('\\b' + attr + '="([^"]*)"').exec(frag || ''); return m ? m[1] : ''; };

/* WS-Security UsernameToken con PasswordDigest: base64(sha1(nonce + created + clave)).
 * La clave NO viaja en claro, que es lo minimo cuando esto sale por la LAN del cliente. */
function seguridad(user, pass) {
  if (!user) return '';
  const nonce = crypto.randomBytes(16);
  const creado = new Date().toISOString();
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(creado, 'utf8'), Buffer.from(String(pass || ''), 'utf8')])).digest('base64');
  return '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
    + '<UsernameToken><Username>' + esc(user) + '</Username>'
    + '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' + digest + '</Password>'
    + '<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' + nonce.toString('base64') + '</Nonce>'
    + '<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' + creado + '</Created>'
    + '</UsernameToken></Security></s:Header>';
}
const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sobre(cuerpo, user, pass) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
    + seguridad(user, pass)
    + '<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + cuerpo + '</s:Body></s:Envelope>';
}

function postSoap(urlStr, xml, ms) {
  return new Promise((res, rej) => {
    let u; try { u = new URL(urlStr); } catch (e) { return rej(new Error('URL de servicio inválida')); }
    if (u.protocol !== 'http:') return rej(new Error('ONVIF sólo por http en esta versión'));
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) },
      timeout: ms || 6000,
    }, (r) => {
      const trozos = [];
      r.on('data', (d) => trozos.push(d));
      r.on('end', () => {
        const cuerpo = Buffer.concat(trozos).toString('utf8');
        /* Un 401 de ONVIF no viene como 401 siempre: muchos contestan 500 con un
         * `NotAuthorized` adentro. Se mira el texto, que es lo que de verdad llega. */
        if (/NotAuthorized|FailedAuthentication|not authorized/i.test(cuerpo)) return rej(new Error('usuario o contraseña rechazados por la cámara'));
        if (r.statusCode >= 400) return rej(new Error('la cámara contestó HTTP ' + r.statusCode));
        res(cuerpo);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('la cámara no contestó a tiempo')); });
    req.on('error', rej);
    req.write(xml); req.end();
  });
}

/**
 * WS-Discovery: quien contesta en esta red.
 * @returns {Promise<Array<{xaddr:string, host:string, nombre:string, modelo:string}>>}
 */
function descubrir(ms) {
  return new Promise((res) => {
    const vistos = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { return res([]); }
    const cerrar = () => { try { sock.close(); } catch (_) {} res(Array.from(vistos.values())); };
    const t = setTimeout(cerrar, ms || 4000);

    sock.on('error', () => { clearTimeout(t); cerrar(); });
    sock.on('message', (buf) => {
      const xml = buf.toString('utf8');
      const xaddrs = tag(xml, 'XAddrs');
      if (!xaddrs) return;
      /* Un equipo puede anunciar varias direcciones (una por interfaz). Se toma la
       * primera http:// que se pueda parsear: es la que responde en esta red. */
      const url = xaddrs.split(/\s+/).find((x) => /^http:\/\//i.test(x));
      if (!url || vistos.has(url)) return;
      let host = ''; try { host = new URL(url).hostname; } catch (_) {}
      /* `Scopes` trae pares tipo onvif://www.onvif.org/name/DS-2CD2043 */
      const scopes = tag(xml, 'Scopes');
      const scope = (clave) => {
        const m = new RegExp('onvif://www\\.onvif\\.org/' + clave + '/([^\\s]+)').exec(scopes || '');
        return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : '';
      };
      vistos.set(url, { xaddr: url, host, nombre: scope('name') || host, modelo: scope('hardware') || '' });
    });

    sock.bind(() => {
      try { sock.setBroadcast(true); sock.setMulticastTTL(2); } catch (_) {}
      const msg = '<?xml version="1.0" encoding="UTF-8"?>'
        + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"'
        + ' xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"'
        + ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"'
        + ' xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
        + '<e:Header><w:MessageID>uuid:' + crypto.randomUUID() + '</w:MessageID>'
        + '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>'
        + '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>'
        + '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
      const b = Buffer.from(msg, 'utf8');
      /* Se manda tres veces: el Probe es UDP y en una red con wifi de por medio se pierde
       * sin que nadie avise. Tres intentos separados cuestan nada y cambian el resultado. */
      const mandar = () => { try { sock.send(b, 0, b.length, PUERTO_WSD, MULTICAST); } catch (_) {} };
      mandar(); setTimeout(mandar, 500); setTimeout(mandar, 1400);
    });
  });
}

/* La direccion del servicio Media. Muchas camaras anuncian el device service en el XAddr
 * del descubrimiento y el media service en otro path; se pregunta con GetCapabilities y,
 * si no contesta, se cae al path estandar sobre el mismo host. */
async function urlMedia(xaddr, user, pass) {
  try {
    const r = await postSoap(xaddr, sobre('<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>Media</Category></GetCapabilities>', user, pass), 6000);
    const media = tag(r, 'Media');
    const x = tag(media, 'XAddr');
    if (x) return x;
  } catch (e) { if (/rechazad/i.test(e.message)) throw e; }
  try { const u = new URL(xaddr); return u.origin + '/onvif/Media'; } catch (_) { return xaddr; }
}

/**
 * Los perfiles de una camara, con la URL RTSP de cada uno y la clave ya puesta.
 * @returns {Promise<Array<{nombre:string, resolucion:string, codec:string, fps:number|null, rtsp:string}>>}
 */
async function perfiles(o) {
  const { xaddr, user, pass } = o || {};
  if (!xaddr) throw new Error('falta la dirección de la cámara');
  const media = await urlMedia(xaddr, user, pass);

  const rp = await postSoap(media, sobre('<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>', user, pass), 8000);
  const crudos = tagTodos(rp, 'Profiles');
  if (!crudos.length) throw new Error('la cámara no devolvió perfiles');

  const salida = [];
  let sinUri = 0;
  for (const el of crudos) {
    const token = atributo(el.attrs, 'token');
    if (!token) continue;
    const frag = el.inner;
    const nombre = tag(frag, 'Name') || token;
    const cfg = tag(frag, 'VideoEncoderConfiguration');
    const res = tag(cfg, 'Resolution');
    const ancho = tag(res, 'Width'), alto = tag(res, 'Height');
    const codec = tag(cfg, 'Encoding') || '';
    const fps = parseInt(tag(tag(cfg, 'RateControl'), 'FrameRateLimit'), 10);
    let rtsp = '';
    try {
      const ru = await postSoap(media, sobre(
        '<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">'
        + '<StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>'
        + '<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup>'
        + '<ProfileToken>' + esc(token) + '</ProfileToken></GetStreamUri>', user, pass), 8000);
      rtsp = tag(tag(ru, 'MediaUri'), 'Uri') || tag(ru, 'Uri');
    } catch (_) { /* un perfil puede fallar y los otros servir */ }
    if (!rtsp) { sinUri++; continue; }
    /* La camara devuelve la URL SIN credenciales. Se le ponen las mismas con las que se
     * acaba de autenticar: es lo que necesita go2rtc, y es lo que el tecnico tendria que
     * escribir a mano si no. */
    if (user) { try { const u = new URL(rtsp); u.username = encodeURIComponent(user); u.password = encodeURIComponent(String(pass || '')); rtsp = u.toString(); } catch (_) {} }
    salida.push({
      nombre, codec,
      resolucion: (ancho && alto) ? (ancho + '×' + alto) : '',
      fps: Number.isFinite(fps) ? fps : null,
      rtsp,
    });
  }
  /* Los dos finales se distinguen porque mandan a mirar lugares distintos: sin URI es un
   * problema de la camara (RTSP apagado, perfil sin encoder); sin token es que la
   * respuesta no tiene la forma esperada y el que hay que mirar es este codigo. */
  if (!salida.length) {
    throw new Error(sinUri
      ? 'la cámara devolvió ' + sinUri + ' perfil(es) pero ninguno con URL RTSP (¿RTSP deshabilitado en la cámara?)'
      : 'la respuesta de la cámara no trae perfiles reconocibles');
  }
  return salida;
}

module.exports = { descubrir, perfiles };
