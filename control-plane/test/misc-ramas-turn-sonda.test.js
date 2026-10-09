/* ============================================================================
 *  La sonda STUN/TURN (turn.js · sondear) contra un servidor que contesta lo que
 *  le pidamos, incluso lo que un coturn sano nunca manda.
 *
 *  test/turn-sonda.test.js prueba el diálogo feliz contra helpers/turn-falso.js. Acá
 *  se fija el VEREDICTO de cada respuesta rara, porque es lo que lee el instalador en
 *  el panel y lo que decide si se acepta un cambio de origen:
 *   - un STUN pelado (Binding sí, Allocate sin 401) no se da por TURN;
 *   - 401/403 en el Allocate firmado = credenciales rechazadas, no «caído»;
 *   - 438 (nonce vencido) se reintenta EXACTAMENTE una vez, con el realm nuevo si
 *     cambió, y un segundo 438 se explica (dos coturn detrás del mismo puerto);
 *   - la liberación (Refresh lifetime=0) es mejor esfuerzo: si falla se informa pero
 *     NO cambia el veredicto sobre el relay;
 *   - una respuesta con otro transaction id o truncada no resuelve el pedido en curso;
 *   - sin host, sin credenciales o sin respuesta, el motivo dice cuál de todas es.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const turn = require('../turn');

const MAGIC = 0x2112a442;
const A_XOR_MAPPED = 0x0020, A_MI = 0x0008, A_ERROR = 0x0009, A_REALM = 0x0014, A_NONCE = 0x0015, A_XOR_RELAYED = 0x0016;

function attr(tipo, val) {
  const pad = (4 - (val.length % 4)) % 4;
  const b = Buffer.alloc(4 + val.length + pad);
  b.writeUInt16BE(tipo, 0); b.writeUInt16BE(val.length, 2); val.copy(b, 4);
  return b;
}
function dirXor(ip, puerto) {
  const b = Buffer.alloc(8);
  b.writeUInt8(1, 1);
  b.writeUInt16BE(puerto ^ (MAGIC >>> 16), 2);
  const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC, 0);
  ip.split('.').forEach((o, i) => { b.writeUInt8((Number(o) ^ m[i]) & 0xff, 4 + i); });
  return b;
}
const error = (codigo) => attr(A_ERROR, Buffer.from([0, 0, Math.floor(codigo / 100), codigo % 100]));
const realm = (r) => attr(A_REALM, Buffer.from(r));
const nonce = (n) => attr(A_NONCE, Buffer.from(n));
const relay = (ip) => attr(A_XOR_RELAYED, dirXor(ip, 49160));

function firmado(d) {
  const len = d.readUInt16BE(2);
  for (let i = 20; i + 4 <= Math.min(20 + len, d.length);) {
    const t = d.readUInt16BE(i), l = d.readUInt16BE(i + 2);
    if (t === A_MI) return true;
    i += 4 + l + ((4 - (l % 4)) % 4);
  }
  return false;
}

/* Servidor UDP con guion: `guion(pedido)` recibe { tipo, firmado, n } (n = cuántos de ese
 * tipo/firma llegaron) y devuelve { tipo, attrs, tidMalo, corto } o null (no contesta). */
async function servidor(t, guion) {
  const s = dgram.createSocket('udp4');
  const cuenta = {};
  const realms = [];
  s.on('message', (d, rinfo) => {
    const tipo = d.readUInt16BE(0), f = firmado(d);
    const clave = tipo + ':' + f;
    cuenta[clave] = (cuenta[clave] || 0) + 1;
    // Para comprobar el reintento con el realm nuevo, se anota lo que trae el pedido.
    if (f) { const i = d.indexOf(Buffer.from('realm-')); if (i >= 0) realms.push(d.slice(i, i + 7).toString()); }
    const r = guion({ tipo, firmado: f, n: cuenta[clave] });
    if (!r) return;
    const enviar = (tid, attrs, largo) => {
      const h = Buffer.alloc(20);
      h.writeUInt16BE(r.tipo, 0); h.writeUInt16BE(largo != null ? largo : attrs.length, 2); h.writeUInt32BE(MAGIC, 4); tid.copy(h, 8);
      s.send(Buffer.concat([h, attrs]), rinfo.port, rinfo.address);
    };
    const attrs = r.attrs || Buffer.alloc(0);
    if (r.corto) s.send(Buffer.alloc(10), rinfo.port, rinfo.address);       // basura de menos de 20 bytes
    if (r.tidMalo) enviar(Buffer.alloc(12, 9), attrs);                      // la respuesta de OTRO pedido
    enviar(d.slice(8, 20), attrs);
  });
  const puerto = await new Promise((ok) => s.bind(0, '127.0.0.1', () => ok(s.address().port)));
  t.after(() => new Promise((ok) => s.close(ok)));
  return { puerto, cuenta, realms };
}

const sondar = (puerto, extra = {}) => turn.sondear({ host: '127.0.0.1', puerto, usuario: 'u', clave: 'p', tcp: false, ms: 300, ...extra });
const binding = { tipo: 0x0101, attrs: attr(A_XOR_MAPPED, dirXor('127.0.0.1', 5555)) };
const pide401 = { tipo: 0x0113, attrs: Buffer.concat([error(401), realm('realm-A'), nonce('n1')]) };

test('sin host no se sondea nada, y el tope por defecto existe', async () => {
  const r = await turn.sondear({ puerto: 3478 });
  assert.equal(r.ok, false);
  assert.equal(r.veredicto, 'no hay ningún host de TURN configurado');
  assert.equal(r.proto, 'UDP');
  assert.deepEqual(r.pasos, []);
});

test('un STUN pelado: responde Binding (aun sin dirección) pero no se da por TURN', async (t) => {
  const s = await servidor(t, ({ tipo }) => (tipo === 1 ? { tipo: 0x0101 } : { tipo: 0x0103 }));
  let r = await sondar(s.puerto, { usuario: '', clave: '' });
  assert.equal(r.mapped, null);
  assert.equal(r.pasos[0].detalle, 'responde');
  assert.match(r.veredicto, /no hay credenciales cargadas/);
  r = await sondar(s.puerto);
  assert.match(r.pasos[1].detalle, /llegó otra cosa/);
  assert.match(r.veredicto, /no se comporta como TURN/);
});

test('Allocate sin credenciales que da otro error, o 401 sin realm, tampoco es TURN', async (t) => {
  const s = await servidor(t, ({ tipo, n }) => {
    if (tipo === 1) return binding;
    return n === 1 ? { tipo: 0x0113, attrs: error(400) } : { tipo: 0x0113, attrs: Buffer.concat([error(401), nonce('n')]) };
  });
  let r = await sondar(s.puerto);
  assert.match(r.pasos[1].detalle, /llegó error 400/);
  assert.equal(r.mapped, '127.0.0.1:5555');
  r = await sondar(s.puerto);
  assert.match(r.pasos[1].detalle, /llegó error 401/, 'un 401 sin realm no alcanza');
});

test('el puerto contesta STUN pero el Allocate no: se dice que no hay TURN del otro lado', async (t) => {
  const s = await servidor(t, ({ tipo }) => (tipo === 1 ? { ...binding, corto: true, tidMalo: true } : null));
  const r = await sondar(s.puerto);
  assert.equal(r.pasos[0].ok, true, 'la basura corta y la respuesta ajena se ignoran; la buena resuelve');
  assert.equal(r.pasos[1].detalle, 'sin respuesta (timeout)');
  assert.match(r.veredicto, /no responde al Allocate/);
});

test('Allocate firmado: cada rechazo con su veredicto', async (t) => {
  const casos = [
    [{ tipo: 0x0113, attrs: error(401) }, /credenciales RECHAZADAS/, 'error 401'],
    [{ tipo: 0x0113, attrs: error(403) }, /credenciales RECHAZADAS/, 'error 403'],
    [{ tipo: 0x0113, attrs: error(508) }, /^el Allocate falló \(error 508\)$/, 'error 508'],
    [{ tipo: 0x0103, attrs: realm('x') }, /^el Allocate falló$/, 'respuesta inesperada'],
    [null, /no obtuvo respuesta/, 'sin respuesta (timeout)'],
  ];
  for (const [resp, veredicto, detalle] of casos) {
    const s = await servidor(t, ({ tipo, firmado: f }) => (tipo === 1 ? binding : !f ? pide401 : resp));
    const r = await sondar(s.puerto);
    assert.match(r.veredicto, veredicto);
    assert.equal(r.pasos.at(-1).detalle, detalle);
    assert.equal(r.ok, false);
  }
});

test('438: se reintenta UNA vez con el nonce (y el realm) nuevos', async (t) => {
  const s = await servidor(t, ({ tipo, firmado: f, n }) => {
    if (tipo === 1) return binding;
    if (tipo === 3 && !f) return pide401;
    if (tipo === 3) return n === 1 ? { tipo: 0x0113, attrs: Buffer.concat([error(438), nonce('n2'), realm('realm-B')]) } : { tipo: 0x0103, attrs: relay('200.40.1.1') };
    // Refresh: también se vence el nonce una vez, y después se libera.
    return n === 1 ? { tipo: 0x0114, attrs: Buffer.concat([error(438), nonce('n3')]) } : { tipo: 0x0104 };
  });
  const r = await sondar(s.puerto);
  assert.equal(r.ok, true, r.veredicto);
  assert.equal(r.relay, '200.40.1.1:49160');
  assert.equal(r.liberada, true);
  assert.equal(s.cuenta['3:true'], 2, 'exactamente un reintento del Allocate');
  assert.equal(s.cuenta['4:true'], 2, 'y uno del Refresh');
  assert.ok(r.pasos.some((p) => /438 \(nonce vencido\)/.test(p.detalle)));
  assert.deepEqual(s.realms, ['realm-A', 'realm-B', 'realm-B', 'realm-B'], 'el reintento firma con el realm que mandó el 438');
});

test('438 sin realm nuevo conserva el realm; un segundo 438 se explica y no hay bucle', async (t) => {
  const s = await servidor(t, ({ tipo, firmado: f }) => {
    if (tipo === 1) return binding;
    if (!f) return pide401;
    return { tipo: 0x0113, attrs: Buffer.concat([error(438), nonce('otro')]) };
  });
  const r = await sondar(s.puerto);
  assert.match(r.veredicto, /sigue rechazando el nonce/);
  assert.equal(s.cuenta['3:true'], 2);
  assert.deepEqual(s.realms, ['realm-A', 'realm-A']);
});

test('la liberación es mejor esfuerzo: si falla se informa y el veredicto sigue siendo del relay', async (t) => {
  for (const [refresh, motivo] of [[{ tipo: 0x0114, attrs: error(500) }, 'error 500'], [null, 'sin respuesta (timeout)']]) {
    const s = await servidor(t, ({ tipo, firmado: f }) => {
      if (tipo === 1) return binding;
      if (tipo === 3) return f ? { tipo: 0x0103, attrs: relay('200.40.1.1') } : pide401;
      return refresh;
    });
    const r = await sondar(s.puerto);
    assert.equal(r.ok, true);
    assert.equal(r.liberada, false);
    assert.match(r.pasos.at(-1).detalle, new RegExp('no se pudo devolver la asignación \\(' + motivo.replace(/[()]/g, '\\$&')));
  }
});

test('un relay en loopback o sin dirección legible sale FALLA aunque todo el diálogo ande', async (t) => {
  for (const [rel, re] of [[relay('127.0.0.1'), /loopback/], [attr(A_XOR_RELAYED, Buffer.alloc(4)), /no es una IPv4 válida/]]) {
    const s = await servidor(t, ({ tipo, firmado: f }) => {
      if (tipo === 1) return binding;
      if (tipo === 3) return f ? { tipo: 0x0103, attrs: rel } : pide401;
      return { tipo: 0x0104 };
    });
    const r = await sondar(s.puerto);
    assert.equal(r.ok, false);
    assert.match(r.veredicto, re);
    assert.equal(r.liberada, true, 'igual se devuelve la asignación');
  }
});

test('reglas puras: entradas vacías o raras no revientan', () => {
  assert.equal(turn.parseUrlTurn(null), null);
  assert.equal(turn.parseUrlTurn('turn:host:0'), null, 'puerto 0 no');
  assert.equal(turn.parseUrlTurn('turn:host:70000'), null);
  assert.deepEqual(turn.parseUrlTurn('turns:[2001:db8::1]:5349?transport=tcp'), { host: '2001:db8::1', puerto: 5349 });
  assert.equal(turn.relayInservible(undefined), 'la dirección del relay no es una IPv4 válida');
  assert.equal(turn.relayInservible('1.2.3.300'), 'la dirección del relay no es una IPv4 válida');
  assert.equal(turn.esPrivada(null), false);
  assert.equal(turn.esPrivada('10.1.2.3'), true);
  assert.equal(turn.esPrivada('172.32.0.1'), false);
  assert.equal(turn.esPrivada('169.254.0.1'), true);
  assert.equal(turn.esPrivada('0.0.0.0'), true);
  assert.equal(turn.motivoRelay('10.0.0.5', ''), null, 'sin IP del TURN resuelta no se acusa a un relay privado');
  // Sólo TCP anda: verde, avisando que UDP no.
  const g = turn.agregar({ ok: false, proto: 'UDP', veredicto: 'no contesta' }, { ok: true, proto: 'TCP', veredicto: 'relay ok' });
  assert.equal(g.ok, true);
  assert.equal(g.veredicto, 'relay ok');
  assert.match(g.aviso, /TURN sobre UDP no entrega relay \(no contesta\)/);
  assert.deepEqual(turn.agregar(null, null), { ok: false, veredicto: '', aviso: '' });
});
