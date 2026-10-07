/* ============================================================================
 *  Diagnóstico de troncal: cada paso tiene que decir la verdad sobre la red.
 *
 *  Nada sale de la máquina. El operador es un servidor en loopback (UDP que contesta
 *  el OPTIONS, TCP, TLS, un WebSocket que contesta 101 o no), y `ip`, `traceroute` y
 *  `ping` son scripts falsos puestos al frente del PATH: así cada camino —con
 *  gateway, sin gateway, sin el binario— se prueba igual en una Mac y en la CI.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const { execFileSync } = require('child_process');
const { diagnosticar } = require('../diagtrunk');

/* ── Binarios falsos ─────────────────────────────────────────────────────────
 * Cada script imprime lo que diga su variable de entorno (FALSO_IP, FALSO_TRACE,
 * FALSO_PING). Si la variable es «__falta__», el binario «no existe»: se saca del PATH. */
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'diagtrunk-bin-'));
const PATH_ORIGINAL = process.env.PATH;
for (const [nombre, v] of [['ip', 'FALSO_IP'], ['traceroute', 'FALSO_TRACE'], ['ping', 'FALSO_PING']]) {
  fs.writeFileSync(path.join(BIN, nombre), `#!/bin/sh\nprintf '%s' "$${v}"\n`, { mode: 0o755 });
}
/* Un PATH SIN los binarios del sistema para el caso «no está instalado»: sólo un
 * directorio vacío, así `ip` del sistema tampoco aparece. */
const VACIO = fs.mkdtempSync(path.join(os.tmpdir(), 'diagtrunk-vacio-'));
function conBinarios(salidas) {
  process.env.PATH = BIN + path.delimiter + PATH_ORIGINAL;
  process.env.FALSO_IP = salidas.ip || '';
  process.env.FALSO_TRACE = salidas.trace || '';
  process.env.FALSO_PING = salidas.ping || '';
}
function sinBinarios() { process.env.PATH = VACIO; }
test.after(() => {
  process.env.PATH = PATH_ORIGINAL;
  fs.rmSync(BIN, { recursive: true, force: true });
  fs.rmSync(VACIO, { recursive: true, force: true });
});

/* ── Operadores falsos ──────────────────────────────────────────────────────── */
function udpQueContesta() {
  return new Promise((ok) => {
    const s = dgram.createSocket('udp4');
    s.on('message', (m, r) => s.send(Buffer.from('SIP/2.0 200 OK\r\n\r\n'), r.port, r.address));
    s.bind(0, '127.0.0.1', () => ok({ port: s.address().port, cerrar: () => s.close() }));
  });
}
function puertoUdpMudo() {
  /* Un socket UDP que recibe y no contesta: el OPTIONS se queda sin respuesta. */
  return new Promise((ok) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => ok({ port: s.address().port, cerrar: () => s.close() }));
  });
}
function tcpAbierto(port = 0) {
  return new Promise((ok) => {
    const s = net.createServer((c) => c.end());
    s.listen(port, '127.0.0.1', () => ok({ port: s.address().port, cerrar: () => new Promise((r) => s.close(r)) }));
  });
}
async function puertoCerrado() {
  const t = await tcpAbierto();
  await t.cerrar();
  return t.port;
}
function wsFalso(respuesta) {
  return new Promise((ok) => {
    const s = net.createServer((c) => {
      c.on('data', () => { c.write(respuesta); });
      c.on('error', () => {});
    });
    s.listen(0, '127.0.0.1', () => ok({ port: s.address().port, cerrar: () => new Promise((r) => s.close(r)) }));
  });
}
/* Certificado autofirmado de un solo uso para el camino TLS/WSS. */
function certificado() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagtrunk-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } catch (_) { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const CERT = certificado();
function tlsServidor(alConectar) {
  return new Promise((ok) => {
    const s = tls.createServer(CERT, (c) => { c.on('error', () => {}); alConectar(c); });
    s.listen(0, '127.0.0.1', () => ok({ port: s.address().port, cerrar: () => new Promise((r) => s.close(r)) }));
  });
}
const paso = (r, nombre) => r.pasos.find((p) => p.paso === nombre || p.paso.startsWith(nombre));

/* ── Troncal SIP por UDP ────────────────────────────────────────────────────── */
test('sin host no se prueba nada y se dice qué falta', async () => {
  const r = await diagnosticar({});
  assert.equal(r.ok, false);
  assert.equal(r.pasos.length, 1);
  assert.match(r.pasos[0].detalle, /falta el host/);
});

test('UDP: el operador contesta el OPTIONS, sin gateway en el camino, por IP', async () => {
  const op = await udpQueContesta();
  conBinarios({ ip: '127.0.0.1 dev lo src 127.0.0.1', trace: ' 1  127.0.0.1  0.1 ms\n' });
  try {
    const r = await diagnosticar({ provider_host: '127.0.0.1', provider_port: op.port });
    assert.equal(r.ok, true, JSON.stringify(r.pasos));
    assert.equal(r.gateway, null);
    assert.match(paso(r, 'Resolver DNS').detalle, /IP literal/);
    assert.match(paso(r, 'Ruta hacia el operador').detalle, /red directa de lo/);
    assert.match(paso(r, 'Traceroute').detalle, /^1 salto hasta el destino$/);
    assert.match(paso(r, 'Ping SIP OPTIONS').detalle, /SIP\/2.0 200 OK/);
    const nat = paso(r, 'NAT / SIP ALG');
    assert.equal(nat.ok, true);
    assert.match(nat.detalle, /no se detecta NAT/);
    /* Sin modo register, el operador reconoce por IP. */
    assert.ok(paso(r, 'Reconocimiento por IP'));
  } finally { op.cerrar(); }
});

test('UDP con gateway: se detecta NAT y se recomienda apagar el SIP ALG', async () => {
  const op = await udpQueContesta();
  conBinarios({ ip: '8.8.8.8 via 192.168.1.1 dev eth0 src 192.168.1.20', trace: ' 1  192.168.1.1\n 2  10.0.0.1\n 3  *\n' });
  try {
    const r = await diagnosticar({ provider_host: '127.0.0.1', provider_port: op.port, mode: 'register' });
    assert.equal(r.gateway, '192.168.1.1');
    assert.match(paso(r, 'Ruta hacia el operador').detalle, /sale por eth0 vía gateway 192\.168\.1\.1/);
    assert.match(paso(r, 'Traceroute').detalle, /3 saltos .*no completó/);
    const nat = paso(r, 'NAT / SIP ALG');
    assert.equal(nat.ok, false);
    assert.match(nat.detalle, /un gateway/);
    assert.match(nat.detalle, /DESACTIVAR el SIP ALG/);
    /* NAT es informativo: no hace fallar el diagnóstico entero. */
    assert.equal(r.ok, true);
    assert.ok(paso(r, 'Registro con credenciales'));
  } finally { op.cerrar(); }
});

test('una IP privada como operador cuenta como NAT aunque no haya gateway', async () => {
  conBinarios({ ip: '' });
  /* Se mira sólo el veredicto de NAT, que no depende de que el puerto conteste. Las
   * conexiones a esas redes pueden tardar hasta el timeout (5 s): van en paralelo. */
  const ips = ['10.1.2.3', '192.168.0.9', '172.16.5.5', '172.31.0.1', '169.254.1.1'];
  /* 172.32 ya no es privada: el rango es 172.16–172.31. Va en la misma tanda. */
  const rs = await Promise.all([...ips, '172.32.0.1'].map((ip) => diagnosticar({ provider_host: ip, provider_port: 9, transport: 'tcp' })));
  ips.forEach((ip, i) => assert.match(paso(rs[i], 'NAT / SIP ALG').detalle, /una red privada/, ip));
  assert.doesNotMatch(paso(rs[ips.length], 'NAT / SIP ALG').detalle, /red privada/);
});

test('ruta sin gateway ni interfaz reconocible: se dice que no se pudo determinar', async () => {
  const op = await udpQueContesta();
  conBinarios({ ip: 'RTNETLINK answers: Network is unreachable', trace: '' });
  try {
    const r = await diagnosticar({ provider_host: '127.0.0.1', provider_port: op.port });
    assert.match(paso(r, 'Ruta hacia el operador').detalle, /no se pudo determinar/);
    assert.match(paso(r, 'Traceroute').detalle, /sin saltos/);
  } finally { op.cerrar(); }
});

test('sin `ip` ni `traceroute` en el contenedor se avisa, no se rompe', async () => {
  const op = await udpQueContesta();
  sinBinarios();
  try {
    const r = await diagnosticar({ provider_host: '127.0.0.1', provider_port: op.port });
    assert.match(paso(r, 'Ruta hacia el operador').detalle, /no verificable/);
    assert.match(paso(r, 'Traceroute').detalle, /no disponible/);
    assert.equal(r.ok, true);
  } finally { op.cerrar(); }
});

test('OPTIONS sin respuesta pero TCP abierto: típico de Grandstream, no es un error', async (t) => {
  /* El mismo número de puerto en UDP (mudo) y en TCP (abierto). */
  const udp = await puertoUdpMudo();
  let tcp;
  try { tcp = await tcpAbierto(udp.port); } catch (_) { udp.cerrar(); t.skip('el puerto TCP gemelo estaba ocupado'); return; }
  conBinarios({});
  try {
    const r = await diagnosticar({ provider_host: '127.0.0.1', provider_port: udp.port });
    const alc = paso(r, 'Alcance del operador');
    assert.equal(alc.ok, true);
    assert.equal(alc.info, true);
    assert.match(alc.detalle, /Grandstream/);
  } finally { udp.cerrar(); await tcp.cerrar(); }
});

test('OPTIONS y TCP mudos, pero responde a ping: puede filtrar SIP por IP', async () => {
  const udp = await puertoUdpMudo();
  conBinarios({ ping: '64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.05 ms' });
  try {
    const r = await diagnosticar({ provider_host: '127.0.0.1', provider_port: udp.port });
    const alc = paso(r, 'Alcance del operador');
    assert.equal(alc.ok, true);
    assert.match(alc.detalle, /responde a ping/);
  } finally { udp.cerrar(); }
});

test('nada responde: OPTIONS, TCP ni ping. El diagnóstico falla y dice qué revisar', async () => {
  const udp = await puertoUdpMudo();
  conBinarios({ ping: '2 packets transmitted, 0 received' });
  try {
    const r = await diagnosticar({ provider_host: '127.0.0.1', provider_port: udp.port });
    assert.equal(r.ok, false);
    assert.match(paso(r, 'Alcance del operador').detalle, /Revisá host, puerto y firewall/);
  } finally { udp.cerrar(); }
});

test('un host que no resuelve deja el paso de DNS en falso y sigue con lo demás', async () => {
  conBinarios({});
  const r = await diagnosticar({ provider_host: 'no-existe.invalid', provider_port: await puertoCerrado(), transport: 'tcp' });
  const d = paso(r, 'Resolver DNS');
  assert.equal(d.ok, false);
  assert.ok(d.detalle);
  /* Sin IP no hay ruta ni traceroute. */
  assert.equal(paso(r, 'Ruta hacia el operador'), undefined);
  assert.equal(r.ok, false);
});

test('un nombre que resuelve muestra la IP a la que fue', async () => {
  const op = await tcpAbierto();
  conBinarios({});
  try {
    const r = await diagnosticar({ provider_host: 'localhost', provider_port: op.port, transport: 'tcp' });
    assert.match(paso(r, 'Resolver DNS').detalle, /^localhost → /);
  } finally { await op.cerrar(); }
});

/* ── TCP y TLS ──────────────────────────────────────────────────────────────── */
test('TCP: puerto abierto y puerto cerrado', async () => {
  const op = await tcpAbierto();
  conBinarios({});
  try {
    const bien = await diagnosticar({ provider_host: '127.0.0.1', provider_port: op.port, transport: 'tcp' });
    assert.match(paso(bien, 'Abrir puerto').detalle, /\/tcp abierto/);
    assert.equal(bien.ok, true);
  } finally { await op.cerrar(); }
  const mal = await diagnosticar({ provider_host: '127.0.0.1', provider_port: await puertoCerrado(), transport: 'tcp' });
  assert.equal(paso(mal, 'Abrir puerto').ok, false);
  assert.match(paso(mal, 'Abrir puerto').detalle, /ECONNREFUSED/);
  assert.equal(mal.ok, false);
});

test('TLS: se completa el handshake contra un certificado autofirmado', async (t) => {
  if (!CERT) { t.skip('sin openssl para fabricar el certificado'); return; }
  const op = await tlsServidor((c) => c.end());
  conBinarios({});
  try {
    const r = await diagnosticar({ provider_host: '127.0.0.1', provider_port: op.port, transport: 'tls' });
    assert.match(paso(r, 'Abrir puerto').detalle, /\/tls abierto/);
  } finally { await op.cerrar(); }
});

test('un puerto por defecto 5060 cuando no se dice cuál', async () => {
  conBinarios({});
  /* Sólo se mira el nombre del paso: dice qué puerto se probó. */
  const r = await diagnosticar({ provider_host: 'no-existe.invalid', transport: 'tcp' });
  assert.ok(paso(r, 'Abrir puerto 5060/tcp'));
});

/* ── Cliente WebRTC (WSS) ───────────────────────────────────────────────────── */
test('webrtc-client: un servidor que contesta 101 pasa el handshake', async () => {
  const ws = await wsFalso('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
  conBinarios({ ip: '127.0.0.1 dev lo' });
  try {
    const r = await diagnosticar({ kind: 'webrtc-client', remote_url: `ws://127.0.0.1:${ws.port}/ws` });
    assert.equal(r.ok, true, JSON.stringify(r.pasos));
    assert.match(paso(r, 'Handshake WSS').detalle, /101 Switching Protocols/);
    assert.ok(paso(r, 'Ruta hacia el destino'));
    assert.ok(paso(r, 'Registro con credenciales'));
  } finally { await ws.cerrar(); }
});

test('webrtc-client: otra respuesta que no sea 101 se marca y se explica', async () => {
  const ws = await wsFalso('HTTP/1.1 404 Not Found\r\n\r\n');
  conBinarios({});
  try {
    const r = await diagnosticar({ mode: 'webrtc-client', remote_url: `ws://127.0.0.1:${ws.port}` });
    const h = paso(r, 'Handshake WSS');
    assert.equal(h.ok, false);
    assert.match(h.detalle, /se esperaba 101/);
    assert.equal(r.ok, false);
  } finally { await ws.cerrar(); }
});

test('webrtc-client: wss:// con TLS y puerto cerrado', async (t) => {
  conBinarios({});
  const cerrado = await diagnosticar({ kind: 'webrtc-client', remote_url: `ws://127.0.0.1:${await puertoCerrado()}/` });
  assert.match(paso(cerrado, 'Handshake WSS').detalle, /ECONNREFUSED/);
  if (!CERT) { t.skip('sin openssl para fabricar el certificado'); return; }
  const op = await tlsServidor((c) => c.on('data', () => c.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')));
  try {
    const r = await diagnosticar({ kind: 'webrtc-client', remote_url: `wss://127.0.0.1:${op.port}/` });
    assert.equal(paso(r, 'Handshake WSS').ok, true);
  } finally { await op.cerrar(); }
});

test('webrtc-client: una URL inválida no tira, se informa', async () => {
  conBinarios({});
  const r = await diagnosticar({ kind: 'webrtc-client', remote_url: 'esto no es una url' });
  assert.match(paso(r, 'Handshake WSS').detalle, /no es válida/);
  assert.equal(r.ok, false);
});
