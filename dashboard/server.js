/* PBX-NG · servidor del panel: Next.js + proxy propio hacia la API.
 *
 * Por qué no alcanza con los `rewrites` de next.config.js: el proxy interno de Next
 * (http-proxy sin `xfwd`) NO agrega la IP del cliente a X-Forwarded-For. Como la API
 * confía en un solo salto (`trust proxy = 1`), cuando el panel se usa directo por
 * :3001 (sin NPM adelante) la API veía la IP del contenedor del dashboard para todos
 * (un solo cupo de login compartido por toda la LAN) y, peor, cualquiera podía mandar
 * un X-Forwarded-For inventado que Next dejaba pasar intacto y la API creía. Además
 * los rewrites fijaban API_URL en el build, no en el arranque.
 *
 * Este server intercepta /backend, /socket.io, /prov y /descargas/softphone y los
 * manda a API_URL con X-Forwarded-For armado ACÁ (ver clienteDeXff), y le deja a Next
 * todo lo demás. Sin dependencias extra: el standalone de Next no rastrea las de un
 * server propio, y con `http` pelado no hay que copiar node_modules a mano.
 *
 * Variables: PORT (3001), HOSTNAME (0.0.0.0), API_URL (http://127.0.0.1:3000),
 * TRUST_PROXY = cantidad de reverse proxies delante del panel (0 = el navegador pega
 * directo a :3001; 1 = NPM/nginx adelante). Si no está, se infiere de COMPOSE_PROFILES
 * (perfil `proxy` activo → 1). NODE_ENV=development levanta Next en modo dev (HMR). */
const http = require('http');
const path = require('path');
const fs = require('fs');

const dev = process.env.NODE_ENV === 'development';
const port = parseInt(process.env.PORT, 10) || 3001;
const hostname = process.env.HOSTNAME || '0.0.0.0';
const API = new URL(process.env.API_URL || 'http://127.0.0.1:3000');
const TRUST_PROXY = (() => {
  if (process.env.TRUST_PROXY !== undefined && process.env.TRUST_PROXY !== '') {
    const n = parseInt(process.env.TRUST_PROXY, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  const perfiles = String(process.env.COMPOSE_PROFILES || '').split(',').map((s) => s.trim());
  return perfiles.includes('proxy') ? 1 : 0;
})();

/* En la imagen Docker corre el standalone de Next, que no trae next.config.js: la
 * config va embebida en required-server-files.json (igual que hace el server.js que
 * genera Next). Si el archivo no está (modo dev, `next build` sin standalone), Next
 * lee next.config.js como siempre. */
if (!dev && !process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
  try {
    const rsf = JSON.parse(fs.readFileSync(path.join(__dirname, '.next', 'required-server-files.json'), 'utf8'));
    if (rsf && rsf.config) process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(rsf.config);
  } catch (_) { /* sin standalone: Next carga next.config.js */ }
}
process.chdir(__dirname);

/* Rutas que van a la API y cómo se reescriben. El orden importa: /socket.io tiene
 * que matchear tanto "/socket.io" pelado como "/socket.io/?EIO=4..." (handshake). */
const REGLAS = [
  { test: /^\/backend(\/|$)/, reescribir: (u) => u.replace(/^\/backend/, '') || '/' },
  { test: /^\/socket\.io(\/|\?|$)/, reescribir: (u) => u },
  { test: /^\/prov(\/|$)/, reescribir: (u) => u },
  { test: /^\/descargas\/softphone(\/|$)/, reescribir: (u) => u.replace(/^\/descargas\/softphone/, '/softphone') },
  /* Video de los porteros y cámaras. Antes esto dependía de que alguien agregara a mano
   * una regla en el proxy de adelante apuntando a go2rtc; si no estaba —y en pbx01 no
   * estaba, devolvía 403— el intercom no mostraba imagen y no había forma de saber por
   * qué desde el panel. Un equipo que se vende no puede pedirle al cliente que configure
   * un reverse proxy para que se vea la puerta: lo sirve él.
   *
   * SÓLO reproducción. El API de administración de go2rtc (PUT/DELETE de streams, la
   * consola de configuración) queda del lado de adentro: publicarlo sería regalarle a
   * cualquiera con un navegador la capacidad de apuntar un canal a donde quiera. */
  { test: /^\/camaras\/api\/(ws|frame\.jpeg|stream\.mjpeg)(\?|$)/, reescribir: (u) => u.replace(/^\/camaras/, ''), arriba: 'go2rtc', entrada: true },
];
function destino(url) {
  for (const r of REGLAS) if (r.test.test(url)) return { path: r.reescribir(url), arriba: r.arriba || 'api', entrada: !!r.entrada };
  return null;
}

/* Cabeceras salto-a-salto: no se reenvían (el proxy negocia las suyas). */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);

/* Arma X-Forwarded-For de modo que el ÚLTIMO elemento sea la IP real del cliente,
 * que es el que toma la API (`trust proxy = 1`, un único salto confiable: este).
 * Cadena = lo que ya venía en el header + la IP del socket; los últimos TRUST_PROXY
 * elementos son proxies nuestros (NPM) y se recortan. Así:
 *   - sin proxy adelante (TRUST_PROXY=0): un cliente LAN que manda "XFF: 1.2.3.4"
 *     llega como "1.2.3.4, 192.168.1.50" → la API usa 192.168.1.50 (no se puede falsear);
 *   - con NPM (TRUST_PROXY=1): NPM manda "spoof, 198.51.100.7" y acá se sumaría la IP
 *     de NPM; se recorta y la API sigue viendo 198.51.100.7.
 * Nunca se recorta el último elemento de la cadena: si TRUST_PROXY está mal puesto se
 * cae a la IP del socket, que es lo peor que puede pasar (cupo compartido), no una
 * IP inventada. */
function ipSocket(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a.startsWith('::ffff:') ? a.slice(7) : a;   // IPv4 mapeada en socket dual-stack
}
function cadenaXff(req) {
  const previos = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const cadena = previos.concat(ipSocket(req));
  const recorte = Math.min(TRUST_PROXY, cadena.length - 1);
  return recorte > 0 ? cadena.slice(0, cadena.length - recorte) : cadena;
}
/* X-Forwarded-Proto/Host: sólo se respeta lo que venga si hay un proxy confiable
 * adelante; si no, se reemplaza con lo que ve este socket (un cliente directo no puede
 * hacerse pasar por https ni por otro host). */
function cabecerasProxy(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
  const cadena = cadenaXff(req);
  h['x-forwarded-for'] = cadena.join(', ');
  const confiable = TRUST_PROXY > 0;
  h['x-forwarded-proto'] = (confiable && req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
  h['x-forwarded-host'] = (confiable && req.headers['x-forwarded-host']) || req.headers.host || '';
  h['x-forwarded-port'] = (confiable && req.headers['x-forwarded-port']) || String(req.socket.localPort || port);
  h['x-real-ip'] = cadena[cadena.length - 1];
  return h;
}

const agente = new http.Agent({ keepAlive: true, maxSockets: 256 });

/* go2rtc puede estar corriendo con dos nombres distintos: `go2rtc` si lo levantó
 * compose (alias del servicio) o `pbxng-go2rtc` si alguien lo arrancó a mano con
 * --name. En pbx01 estaba el segundo, y como el resto del sistema buscaba el primero,
 * el video daba 502 y el sincronizador de canales de la API fallaba en silencio —tiene
 * el catch vacío—, así que nadie se enteraba. En vez de elegir un nombre y esperar que
 * sea el correcto, se prueban los dos y se recuerda el que contestó. */
const CANDIDATOS = (process.env.GO2RTC_URL_INTERNA || 'http://go2rtc:1984,http://pbxng-go2rtc:1984')
  .split(',').map((s) => s.trim()).filter(Boolean).map((s) => new URL(s));
let GO2RTC = null;          // el que contestó; null = todavía no se probó
let buscando = null;        // promesa en curso, para no sondear en paralelo
function vivo(c) {
  return new Promise((resolve) => {
    const r = http.request({ hostname: c.hostname, port: c.port || 80, path: '/api', method: 'GET', timeout: 2500 },
      (resp) => { resp.resume(); resolve(resp.statusCode < 500 ? c : null); });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end();
  });
}
async function resolverGo2rtc() {
  if (GO2RTC) return GO2RTC;
  if (!buscando) {
    buscando = Promise.all(CANDIDATOS.map(vivo))
      .then((r) => { GO2RTC = r.find(Boolean) || null; buscando = null; return GO2RTC; });
  }
  return buscando;
}
// Se sondea al arrancar para que la primera cámara que alguien abra no espere.
resolverGo2rtc().then((u) => console.log('[panel] go2rtc ' + (u ? 'en ' + u.origin : 'no encontrado (' + CANDIDATOS.map((c) => c.origin).join(', ') + ')')));

/* Canjea la entrada de un solo uso contra la API antes de dejar pasar video. Un
 * WebSocket del navegador no puede mandar Authorization, así que la sesión viaja como
 * este parámetro `t`, que la API emitió hace menos de un minuto para ESE canal y que
 * se destruye al usarse. Sin esto, el que supiera el nombre del canal miraba la puerta
 * de un cliente sin haber iniciado sesión jamás. */
function entradaValida(url) {
  return new Promise((resolve) => {
    let q; try { q = new URL(url, 'http://x'); } catch (_) { return resolve(false); }
    const t = q.searchParams.get('t') || '', src = q.searchParams.get('src') || '';
    if (!t || !src) return resolve(false);
    const r = http.request({
      protocol: API.protocol, hostname: API.hostname, port: API.port || 80, method: 'GET',
      path: '/api/intercom/ticket/verify?t=' + encodeURIComponent(t) + '&src=' + encodeURIComponent(src),
      timeout: 4000,
    }, (resp) => { resp.resume(); resolve(resp.statusCode === 200); });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.end();
  });
}

function proxyHttp(req, res, pathApi, U = API) {
  const headers = cabecerasProxy(req);
  const up = http.request({
    protocol: U.protocol, hostname: U.hostname, port: U.port || 80,
    method: req.method, path: pathApi, headers, agent: agente,
  }, (r) => {
    res.writeHead(r.statusCode, r.statusMessage, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    /* La API caída no tiene que verse como una página de Next rota: JSON claro y 502,
     * que el panel muestra como error de red (toast) en vez de tragarlo. */
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'la API no responde (' + e.code + ')' }));
  });
  req.on('aborted', () => up.destroy());
  req.pipe(up);
}

function proxyUpgrade(req, socket, head, pathApi, U = API) {
  const headers = cabecerasProxy(req);
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade;
  const up = http.request({
    protocol: U.protocol, hostname: U.hostname, port: U.port || 80,
    method: req.method, path: pathApi, headers,
  });
  up.on('upgrade', (r, upSocket, upHead) => {
    const lineas = ['HTTP/1.1 ' + r.statusCode + ' ' + r.statusMessage];
    for (let i = 0; i < r.rawHeaders.length; i += 2) lineas.push(r.rawHeaders[i] + ': ' + r.rawHeaders[i + 1]);
    socket.write(lineas.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    const cerrar = () => { socket.destroy(); upSocket.destroy(); };
    socket.on('error', cerrar); upSocket.on('error', cerrar);
    socket.on('close', () => upSocket.destroy()); upSocket.on('close', () => socket.destroy());
  });
  up.on('response', (r) => {
    /* La API contestó sin upgrade (p. ej. 401 del handshake): se devuelve tal cual. */
    const lineas = ['HTTP/1.1 ' + r.statusCode + ' ' + r.statusMessage];
    for (let i = 0; i < r.rawHeaders.length; i += 2) lineas.push(r.rawHeaders[i] + ': ' + r.rawHeaders[i + 1]);
    socket.write(lineas.join('\r\n') + '\r\n\r\n');
    r.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  up.end();
}

const next = require('next');
const app = next({ dev, dir: __dirname, hostname, port });
const handle = app.getRequestHandler();
const handleUpgrade = typeof app.getUpgradeHandler === 'function' ? app.getUpgradeHandler() : null;

app.prepare().then(() => {
  const server = http.createServer(async (req, res) => {
    const d = destino(req.url);
    if (d === null) return handle(req, res);
    if (d.arriba === 'api') return proxyHttp(req, res, d.path, API);
    // Video: primero la entrada, después averiguar dónde está go2rtc.
    if (d.entrada && !(await entradaValida(req.url))) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: 'entrada de video inválida o vencida' }));
    }
    const U = await resolverGo2rtc();
    if (!U) { res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ error: 'el servicio de video no está corriendo' })); }
    proxyHttp(req, res, d.path, U);
  });
  server.on('upgrade', async (req, socket, head) => {
    const d = destino(req.url);
    if (d === null) { if (handleUpgrade) return handleUpgrade(req, socket, head); return socket.destroy(); }  // HMR de Next en dev
    if (d.arriba === 'api') return proxyUpgrade(req, socket, head, d.path, API);
    const cortar = (linea) => { try { socket.write('HTTP/1.1 ' + linea + '\r\nConnection: close\r\n\r\n'); } catch (_) {} socket.destroy(); };
    if (d.entrada && !(await entradaValida(req.url))) return cortar('403 Forbidden');
    const U = await resolverGo2rtc();
    if (!U) return cortar('502 Bad Gateway');
    proxyUpgrade(req, socket, head, d.path, U);
  });
  /* socket.io en long-polling deja pedidos abiertos ~25 s; el timeout por defecto de
   * node (0 = sin límite en el server, pero keepAlive) alcanza. Sin límite de headers. */
  server.keepAliveTimeout = 65 * 1000;
  server.listen(port, hostname, () => {
    console.log('[panel] Next ' + (dev ? 'dev' : 'prod') + ' en http://' + hostname + ':' + port + ' → API ' + API.origin + ' (TRUST_PROXY=' + TRUST_PROXY + ')');
  });
}).catch((e) => { console.error('[panel] no arranca:', e); process.exit(1); });
