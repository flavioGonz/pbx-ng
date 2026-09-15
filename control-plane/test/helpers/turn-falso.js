/* ============================================================================
 *  PBX-NG · TURN de mentira para las pruebas del medio.
 *
 *  POR QUÉ EXISTE: los dos bugs que dejaron una central real sin audio —la sonda que
 *  no resolvía el host por nombre y el framing TCP leído a medias— se arreglaron a
 *  mano y sin red: no había forma de probar la sonda sin un coturn de verdad, así que
 *  no se probó, y el mismo bug de framing siguió vivo en `scripts/check-turn.py`
 *  durante toda una release. Esto es lo mínimo que hace falta para que un cliente
 *  STUN/TURN crea que del otro lado hay un coturn:
 *
 *    · STUN Binding                  → 0x0101 con XOR-MAPPED-ADDRESS
 *    · Allocate sin MESSAGE-INTEGRITY → 0x0113 error 401 + REALM + NONCE
 *    · Allocate firmado              → 0x0103 con XOR-RELAYED-ADDRESS = `relay`
 *    · Refresh lifetime=0            → 0x0104 (la sonda devuelve la asignación)
 *
 *  Codifica los mensajes por su cuenta, a mano y desde el RFC: si reusara el armador
 *  de `turn.js` no probaría el cable, probaría que una función es igual a sí misma.
 *
 *  Opciones que reproducen los casos medidos:
 *    · `partirTcp`  la respuesta TCP sale en DOS writes (12 bytes y el resto 30 ms
 *                   después). TCP es un flujo y el servidor puede partir donde quiera;
 *                   un cliente que hace un solo `recv()` lee la mitad y declara muerto
 *                   un TURN sano. Es EL caso que se arregló en turn.js.
 *    · `soloUdp`    sin listener TCP (port-forward de 3478/udp nada más, que es la
 *                   configuración más común de todas).
 *    · `largoMentidoUdp` la cabecera UDP declara más largo del que llega.
 *    · `relay`      la dirección que el TURN anuncia como candidato relay: acá entra
 *                   el 172.17.0.1 del bridge de Docker que autenticaba perfecto y no
 *                   le servía a nadie.
 * ==========================================================================*/
'use strict';
const dgram = require('node:dgram');
const net = require('node:net');

const MAGIC = 0x2112a442;
const A_XOR_MAPPED = 0x0020, A_MI = 0x0008, A_ERROR = 0x0009;
const A_REALM = 0x0014, A_NONCE = 0x0015, A_XOR_RELAYED = 0x0016, A_LIFETIME = 0x000d;

function attr(tipo, val) {
  const pad = (4 - (val.length % 4)) % 4;
  const b = Buffer.alloc(4 + val.length + pad);
  b.writeUInt16BE(tipo, 0); b.writeUInt16BE(val.length, 2); val.copy(b, 4);
  return b;
}
/* XOR-MAPPED-ADDRESS / XOR-RELAYED-ADDRESS: familia IPv4, puerto e IP en xor con el
 * magic cookie (RFC 5389 §15.2). Sin el xor el cliente lee cualquier cosa. */
function dirXor(ip, puerto) {
  const b = Buffer.alloc(8);
  b.writeUInt8(0, 0); b.writeUInt8(1, 1);
  b.writeUInt16BE(puerto ^ (MAGIC >>> 16), 2);
  const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC, 0);
  ip.split('.').forEach((o, i) => { b.writeUInt8((Number(o) ^ m[i]) & 0xff, 4 + i); });
  return b;
}
function mensaje(tipo, tid, attrs) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(tipo, 0); h.writeUInt16BE(attrs.length, 2); h.writeUInt32BE(MAGIC, 4); tid.copy(h, 8);
  return Buffer.concat([h, attrs]);
}
/** ¿El pedido trae MESSAGE-INTEGRITY? Es lo único que este TURN de mentira mira para
 *  distinguir el Allocate «a ver quién sos» del firmado. No valida el HMAC: lo que se
 *  prueba de este lado es el diálogo y el framing, no la criptografía de coturn. */
function vieneFirmado(d) {
  const len = d.readUInt16BE(2);
  let i = 20;
  while (i + 4 <= Math.min(20 + len, d.length)) {
    const t = d.readUInt16BE(i), l = d.readUInt16BE(i + 2);
    if (t === A_MI) return true;
    i += 4 + l + ((4 - (l % 4)) % 4);
  }
  return false;
}

/**
 * Levanta el TURN de mentira en 127.0.0.1, UDP y (salvo `soloUdp`) TCP en el MISMO
 * puerto. Devuelve { puerto, cerrar() }.
 */
async function levantar(op) {
  const relay = op.relay || '200.40.1.1';
  const realm = op.realm || 'pbxng.test';
  const partirTcp = !!op.partirTcp;

  /* Bitácora de lo que llegó, con el ORIGEN de cada pedido. Sirve para una sola cosa,
   * pero importante: comprobar que el `Refresh lifetime=0` que libera la asignación sale
   * por el MISMO socket que hizo el Allocate. En UDP la asignación está atada a la
   * 5-tupla (RFC 8656 §5), así que un Refresh desde otro puerto de origen no libera nada
   * y la asignación queda viva igual — que es exactamente el bug que se está tapando. */
  const recibido = [];

  const udp = dgram.createSocket('udp4');
  const puerto = await new Promise((res, rej) => {
    udp.once('error', rej);
    udp.bind(0, '127.0.0.1', () => res(udp.address().port));
  });

  function responder(pedido, deIp, dePuerto) {
    if (pedido.length < 20) return null;
    const tipo = pedido.readUInt16BE(0), tid = pedido.slice(8, 20);
    if (tipo === 0x0001) return mensaje(0x0101, tid, attr(A_XOR_MAPPED, dirXor(deIp, dePuerto)));
    if (tipo === 0x0003) {
      if (!vieneFirmado(pedido)) {
        // 401 con realm y nonce: es lo que prueba que del otro lado hay un TURN y no
        // un STUN pelado. El cuerpo del ERROR-CODE es clase 4 + número 01.
        return mensaje(0x0113, tid, Buffer.concat([
          attr(A_ERROR, Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from('Unauthorized', 'utf8')])),
          attr(A_REALM, Buffer.from(realm, 'utf8')),
          attr(A_NONCE, Buffer.from('nonce-de-prueba-0123456789', 'utf8')),
        ]));
      }
      // Allocate firmado: 200 con el candidato relay. Es el mensaje MÁS LARGO del
      // diálogo, y por eso el candidato natural a llegar partido por TCP.
      return mensaje(0x0103, tid, Buffer.concat([
        attr(A_XOR_RELAYED, dirXor(relay, 49160)),
        attr(A_REALM, Buffer.from(realm, 'utf8')),
        attr(A_NONCE, Buffer.from('nonce-de-prueba-0123456789', 'utf8')),
        attr(A_MI, Buffer.alloc(20, 7)),
      ]));
    }
    /* Refresh lifetime=0: la sonda DEVUELVE la asignación para no dejar relays
     * reservados. Un TURN de mentira que no lo contesta hace que ese paso salga en
     * rojo en cada prueba y ensucia justo lo que se quiere leer. */
    if (tipo === 0x0004) return mensaje(0x0104, tid, attr(A_LIFETIME, Buffer.alloc(4)));
    return null;
  }

  udp.on('message', (d, rinfo) => {
    if (d.length >= 20) recibido.push({ tipo: d.readUInt16BE(0), proto: 'UDP', origen: rinfo.address + ':' + rinfo.port });
    let r = responder(d, rinfo.address, rinfo.port);
    if (!r) return;
    /* `largoMentidoUdp`: la cabecera declara MÁS largo del que de verdad viene. Pasa
     * con un datagrama recortado (una respuesta de más de 4096 bytes, un MTU chico) y
     * con cualquier servidor con un bug. El cliente NO puede recorrer los atributos
     * hasta el largo declarado: tiene que acotarse a lo que recibió, o revienta con un
     * «unpack requires a buffer of 4 bytes» que no le dice nada a nadie. Va sólo por
     * UDP: por TCP el cliente acumula, así que esperaría bytes que no llegan nunca. */
    if (op.largoMentidoUdp) { r = Buffer.from(r); r.writeUInt16BE(r.readUInt16BE(2) + 16, 2); }
    try { udp.send(r, rinfo.port, rinfo.address); } catch (_) { /* el cliente ya cerró */ }
  });

  let tcp = null;
  if (!op.soloUdp) {
    tcp = net.createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on('error', () => {});
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        // El servidor también tiene que desframear: el cliente puede mandar partido.
        while (buf.length >= 20 && buf.length >= 20 + buf.readUInt16BE(2)) {
          const largo = 20 + buf.readUInt16BE(2);
          recibido.push({ tipo: buf.readUInt16BE(0), proto: 'TCP', origen: '127.0.0.1:' + (s.remotePort || 0) });
          const r = responder(buf.slice(0, largo), '127.0.0.1', s.remotePort || 1234);
          buf = buf.slice(largo);
          if (!r) continue;
          if (!partirTcp) { s.write(r); continue; }
          s.write(r.slice(0, 12));
          setTimeout(() => { try { s.write(r.slice(12)); } catch (_) { /* cerrado */ } }, 30);
        }
      });
    });
    try {
      await new Promise((res, rej) => { tcp.once('error', rej); tcp.listen(puerto, '127.0.0.1', res); });
    } catch (e) {
      // Si el puerto no estaba libre por TCP hay que soltar TAMBIÉN el UDP, o cada
      // reintento deja un socket abierto y el proceso de prueba no termina nunca.
      await new Promise((res) => udp.close(res));
      throw e;
    }
  }

  return {
    puerto,
    relay,
    recibido,
    // Los pedidos de un transporte, en orden: 0x0001 Binding, 0x0003 Allocate, 0x0004 Refresh.
    pedidos(proto) { return recibido.filter((x) => x.proto === proto); },
    async cerrar() {
      await new Promise((res) => udp.close(res));
      if (tcp) await new Promise((res) => tcp.close(res));
    },
  };
}

/* El puerto lo elige el sistema por UDP y después se pide el MISMO por TCP: si otro
 * proceso lo tenía tomado, se reintenta con otro en vez de fallar la prueba por algo
 * que no tiene nada que ver con el TURN. */
async function turnFalso(op = {}) {
  let ultima;
  for (let i = 0; i < 8; i++) {
    try { return await levantar(op); } catch (e) { ultima = e; }
  }
  throw ultima;
}

module.exports = { turnFalso };
