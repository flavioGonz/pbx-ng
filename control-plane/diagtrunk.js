'use strict';
/* ============================================================================
 *  PBX-NG · diagnóstico de troncal (pre-conexión)
 *
 *  Antes de guardar una troncal corremos las pruebas que uno haría a mano para no
 *  crear una troncal que nace muerta: ¿resuelve el DNS?, ¿el puerto está abierto?,
 *  ¿habla SIP (OPTIONS)?, ¿hay NAT/SIP-ALG en el camino? Cada tipo se prueba distinto.
 *  Sólo builtins de Node: dns, net, tls, dgram, crypto, url, child_process.
 * ==========================================================================*/
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { URL } = require('url');

async function correr(nombre, fn) {
  const t0 = Date.now();
  try { const r = await fn(); return { paso: nombre, ok: r.ok !== false, info: !!r.info, detalle: r.detalle, ms: Date.now() - t0, ...r.extra }; }
  catch (e) { return { paso: nombre, ok: false, detalle: e.message, ms: Date.now() - t0 }; }
}
function ejecutar(cmd, args, seg = 6) {
  return new Promise((ok) => {
    execFile(cmd, args, { timeout: seg * 1000 }, (e, so, se) => ok({ code: e ? (e.code ?? 1) : 0, missing: e && e.code === 'ENOENT', out: (so || '') + (se || '') }));
  });
}
async function resolverDNS(host) {
  if (net.isIP(host)) return { ok: true, detalle: `${host} es una IP literal`, extra: { ip: host } };
  const r = await dns.lookup(host);
  return { ok: true, detalle: `${host} → ${r.address}`, extra: { ip: r.address } };
}
async function gatewayHacia(ip) {
  const r = await ejecutar('ip', ['route', 'get', ip], 4);
  if (r.missing) return { ok: true, info: true, detalle: 'ruta hacia el operador: no verificable desde el panel' };
  const via = /via\s+(\d+\.\d+\.\d+\.\d+)/.exec(r.out);
  const dev = /dev\s+(\S+)/.exec(r.out);
  if (via) return { ok: true, info: true, detalle: `sale por ${dev ? dev[1] : '?'} vía gateway ${via[1]}`, extra: { gateway: via[1], gateway_dev: dev ? dev[1] : null } };
  if (dev) return { ok: true, info: true, detalle: `red directa de ${dev[1]} (sin gateway intermedio)`, extra: { gateway: null, gateway_dev: dev[1] } };
  return { ok: true, info: true, detalle: 'no se pudo determinar la ruta' };
}
async function rutaHasta(ip) {
  const r = await ejecutar('traceroute', ['-n', '-m', '8', '-q', '1', '-w', '2', ip], 20);
  if (r.missing) return { ok: true, info: true, detalle: 'traceroute no disponible en este contenedor' };
  const hops = (r.out.match(/^\s*\d+\s+/gm) || []).length;
  const llega = r.out.includes(ip);
  if (!hops) return { ok: true, info: true, detalle: 'sin saltos (el operador puede filtrar ICMP)' };
  return { ok: true, info: true, detalle: `${hops} salto${hops === 1 ? '' : 's'} hasta el destino${llega ? '' : ' (no completó, normal si filtra ICMP)'}`, extra: { hops } };
}
function conectarTCP(host, port, conTls, seg = 5) {
  return new Promise((ok) => {
    const sock = conTls ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }) : net.connect({ host, port });
    const to = setTimeout(() => { sock.destroy(); ok({ ok: false, detalle: `sin conexión en ${seg}s (¿firewall o puerto cerrado?)` }); }, seg * 1000);
    sock.on(conTls ? 'secureConnect' : 'connect', () => { clearTimeout(to); sock.end(); ok({ ok: true, detalle: `puerto ${port}/${conTls ? 'tls' : 'tcp'} abierto` }); });
    sock.on('error', (e) => { clearTimeout(to); ok({ ok: false, detalle: e.code || e.message }); });
  });
}
function optionsUDP(host, port, seg = 5) {
  return new Promise((ok) => {
    const sock = dgram.createSocket('udp4');
    const branch = 'z9hG4bK' + crypto.randomBytes(6).toString('hex');
    const tag = crypto.randomBytes(4).toString('hex');
    const call = crypto.randomBytes(8).toString('hex');
    const msg = [
      `OPTIONS sip:${host}:${port} SIP/2.0`,
      `Via: SIP/2.0/UDP 0.0.0.0:5060;branch=${branch};rport`,
      'Max-Forwards: 70',
      `From: "PBX-NG diag" <sip:diag@pbx-ng>;tag=${tag}`,
      `To: <sip:${host}>`,
      `Call-ID: ${call}@pbx-ng`,
      'CSeq: 1 OPTIONS', 'User-Agent: PBX-NG-diag', 'Accept: application/sdp', 'Content-Length: 0', '', '',
    ].join('\r\n');
    const to = setTimeout(() => { try { sock.close(); } catch (_) {} ok({ ok: false, detalle: `sin respuesta a OPTIONS en ${seg}s` }); }, seg * 1000);
    sock.on('message', (buf) => { clearTimeout(to); try { sock.close(); } catch (_) {} ok({ ok: true, detalle: 'responde: ' + buf.toString('utf8').split('\r\n')[0] }); });
    sock.on('error', (e) => { clearTimeout(to); try { sock.close(); } catch (_) {} ok({ ok: false, detalle: e.message }); });
    sock.send(Buffer.from(msg), port, host);
  });
}
async function sondaAlternativa(host, port) {
  const tcp = await conectarTCP(host, port, false, 3);
  if (tcp.ok) return { ok: true, info: true, detalle: `no contestó el OPTIONS, pero el puerto ${port}/tcp responde. Típico de Grandstream/UCM que sólo contestan OPTIONS a peers conocidos: al registrar la troncal lo confirma.` };
  const ping = await ejecutar('ping', ['-c', '2', '-W', '2', '-n', host], 8);
  if (!ping.missing && /ttl=|time=/i.test(ping.out)) return { ok: true, info: true, detalle: 'no contestó OPTIONS ni TCP, pero el host responde a ping. Puede filtrar SIP por IP; se confirma al registrar.' };
  return { ok: false, detalle: 'no responde al OPTIONS, ni al puerto TCP, ni al ping. Revisá host, puerto y firewall.' };
}
function handshakeWSS(urlStr, seg = 7) {
  return new Promise((ok) => {
    let u; try { u = new URL(urlStr); } catch { return ok({ ok: false, detalle: 'la URL no es válida' }); }
    const conTls = u.protocol === 'wss:';
    const port = u.port ? Number(u.port) : (conTls ? 443 : 80);
    const key = crypto.randomBytes(16).toString('base64');
    const mod = conTls ? tls : net;
    const opts = conTls ? { host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false } : { host: u.hostname, port };
    const sock = mod.connect(opts);
    const to = setTimeout(() => { sock.destroy(); ok({ ok: false, detalle: `sin handshake en ${seg}s` }); }, seg * 1000);
    sock.on(conTls ? 'secureConnect' : 'connect', () => {
      sock.write(`GET ${u.pathname || '/'} HTTP/1.1\r\nHost: ${u.hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: sip\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes('\r\n\r\n')) { clearTimeout(to); sock.destroy(); const linea = buf.split('\r\n')[0]; ok({ ok: /\s101\s/.test(linea), detalle: linea + (/\s101\s/.test(linea) ? '' : ' (se esperaba 101 Switching Protocols)') }); } });
    sock.on('error', (e) => { clearTimeout(to); ok({ ok: false, detalle: e.code || e.message }); });
  });
}
function esPrivada(ip) {
  if (!ip) return false;
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip);
}

async function diagnosticar(t = {}) {
  const pasos = [];
  let ip = null, gateway = null;
  if (t.kind === 'webrtc-client' || t.mode === 'webrtc-client') {
    let host = t.remote_url;
    try { host = new URL(t.remote_url).hostname; } catch (_) {}
    const dnsp = await correr('Resolver DNS del extremo', () => resolverDNS(host)); ip = dnsp.ip; pasos.push(dnsp);
    if (ip) { pasos.push(await correr('Ruta hacia el destino', () => gatewayHacia(ip))); }
    pasos.push(await correr('Handshake WSS', () => handshakeWSS(t.remote_url)));
    pasos.push({ paso: 'Registro con credenciales', ok: true, info: true, ms: 0, detalle: 'El usuario y la clave se prueban al registrar, apenas guardes la troncal.' });
  } else {
    const host = t.provider_host; const port = Number(t.provider_port) || 5060; const tr = t.transport || 'udp';
    if (!host) return { ok: false, pasos: [{ paso: 'Host', ok: false, detalle: 'falta el host del operador', ms: 0 }] };
    const dnsp = await correr('Resolver DNS del operador', () => resolverDNS(host)); ip = dnsp.ip; pasos.push(dnsp);
    if (ip) { const g = await correr('Ruta hacia el operador', () => gatewayHacia(ip)); if (g.gateway) gateway = g.gateway; pasos.push(g); pasos.push(await correr('Traceroute', () => rutaHasta(ip))); }
    if (tr === 'udp') {
      const opt = await correr('Ping SIP OPTIONS (UDP)', () => optionsUDP(host, port));
      if (opt.ok) pasos.push(opt);
      else { const alt = await sondaAlternativa(host, port); pasos.push({ paso: 'Alcance del operador', ok: alt.ok, info: alt.info, ms: opt.ms, detalle: alt.detalle }); }
    } else pasos.push(await correr(`Abrir puerto ${port}/${tr}`, () => conectarTCP(host, port, tr === 'tls')));
    const priv = esPrivada(ip || host); const nat = priv || (!!gateway && gateway !== '0.0.0.0');
    pasos.push({ paso: 'NAT / SIP ALG', ok: !nat, info: true, ms: 0,
      detalle: nat
        ? `Hay ${priv ? 'una red privada' : 'un gateway'} en el camino: probable NAT. Si el router tiene SIP ALG activo reescribe puertos/IP del SIP y el SDP y rompe el audio (registra pero no entra sonido). Recomendado: DESACTIVAR el SIP ALG del router.`
        : 'El operador es alcanzable sin gateway intermedio: no se detecta NAT/ALG en el camino.' });
    if (t.mode === 'register') pasos.push({ paso: 'Registro con credenciales', ok: true, info: true, ms: 0, detalle: 'El usuario y la clave se validan al registrar, apenas guardes la troncal.' });
    else pasos.push({ paso: 'Reconocimiento por IP', ok: true, info: true, ms: 0, detalle: 'El operador te reconoce por la IP pública: confirmá que la tenga en su lista blanca.' });
  }
  const ok = pasos.filter((p) => !p.info).every((p) => p.ok);
  return { ok, gateway, pasos };
}
module.exports = { diagnosticar };
