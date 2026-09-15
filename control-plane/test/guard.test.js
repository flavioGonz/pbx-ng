/* Pruebas del motor de seguridad (guard.js) con mocks: sin Postgres, sin Asterisk,
 * sin ip-api. Se corren con `npm test` (node --test) desde control-plane/.
 *
 * Cubren los dos bloqueantes de la revisión del sprint /seguridad:
 *   1) el AMI real trae `Event: ChallengeResponseFailed` (no `Event: SecurityEvent`);
 *   2) una ráfaga de N eventos en el mismo tick tiene que producir UN solo ban. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const initGuard = require('../guard');

/* Fábrica de un guard con dependencias falsas. Devuelve también los contadores
 * que miran las pruebas (POST al agente, filas insertadas, correos). */
function armar(opt) {
  const o = opt || {};
  const ami = new EventEmitter();
  const cont = { fwBan: [], fwOtros: [], filasBloqueo: 0, filasSecEvents: [], geoConsultas: 0, raise: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (s.includes('INSERT INTO pbxng_blocked')) {
        cont.filasBloqueo++;
        return { rows: [{ ip: params[0], reason: params[1], hits: cont.filasBloqueo, permanent: params[5], exp: params[6] > 0 ? Date.now() + params[6] * 1000 : null }] };
      }
      if (s.includes('INSERT INTO pbxng_sec_events')) { cont.filasSecEvents.push({ kind: params[0], severity: params[1], detail: JSON.parse(params[2]) }); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
  const astFwd = async (method, path, body) => {
    if (path === '/fw/ban') cont.fwBan.push(body); else cont.fwOtros.push({ method, path, body });
    return { ok: true, status: 200, json: async () => ({ ok: true, enabled: true, bans: [] }) };
  };
  const geoLookup = async (ips) => {
    cont.geoConsultas++;
    await new Promise((r) => setTimeout(r, o.geoMs === undefined ? 5 : o.geoMs));   // simula la ida a ip-api
    const out = {}; for (const ip of ips) out[ip] = { country: 'Testland', cc: 'TL', city: '', isp: 'ISP de prueba' };
    return out;
  };
  const alerts = { raise: async (k, d) => { cont.raise.push({ k, d }); } };
  const log = { debug() {}, info() {}, warn() {}, error(...a) { cont.errores = (cont.errores || []).concat([a]); } };
  const guard = initGuard({ app: null, pool, ami, io: null, astFwd, escribir() {}, alerts, geoLookup, amiCommand: async () => '', log });
  return { guard, ami, cont };
}

const amiEvent = (event, ip, cuenta) => ({ event, privilege: 'security,all', eventversion: '1', severity: 'Error', service: 'PJSIP', eventtv: new Date().toISOString(), accountid: cuenta || '1001', sessionid: 'x', localaddress: 'IPV4/UDP/10.0.0.5/5060', remoteaddress: 'IPV4/UDP/' + ip + '/5060' });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test('el AMI real (Event: ChallengeResponseFailed) llega al buffer y banea', async () => {
  const { guard, ami, cont } = armar();
  // Sin iniciar() (no hay base): se engancha el AMI a mano como hace iniciar().
  guard._engancharAmi();
  for (let i = 0; i < 6; i++) { ami.emit('managerevent', amiEvent('ChallengeResponseFailed', '203.0.113.9')); await esperar(20); }
  await esperar(50);
  const ev = guard.recientes();
  assert.ok(ev.length >= 6, 'los eventos tienen que entrar al buffer en vivo, hubo ' + ev.length);
  assert.equal(ev[0].tipo, 'auth');
  assert.equal(cont.fwBan.length, 1, 'exactamente un POST /fw/ban');
  assert.equal(cont.fwBan[0].ip, '203.0.113.9');
  assert.equal(cont.fwBan[0].seconds, 3600);
});

test('Event: SecurityEvent (formato de security.log) y eventos ajenos se ignoran', async () => {
  const { guard, ami, cont } = armar();
  guard._engancharAmi();
  ami.emit('managerevent', { event: 'SecurityEvent', securityevent: 'InvalidPassword', remoteaddress: 'IPV4/UDP/203.0.113.8/5060' });
  ami.emit('managerevent', { event: 'PeerStatus', peer: 'PJSIP/1001' });
  ami.emit('managerevent', amiEvent('ChallengeSent', '203.0.113.8'));
  await esperar(30);
  assert.equal(guard.recientes().length, 0);
  assert.equal(cont.fwBan.length, 0);
});

test('una ráfaga de 12 fallos en el mismo tick produce UN solo ban', async () => {
  const { guard, ami, cont } = armar();
  guard._engancharAmi();
  // Como asterisk-manager: todos los eventos del mismo chunk TCP salen en un bucle síncrono.
  for (let i = 0; i < 12; i++) ami.emit('managerevent', amiEvent('ChallengeResponseFailed', '203.0.113.9'));
  await esperar(80);
  assert.equal(cont.geoConsultas, 1, 'una sola consulta a ip-api para la IP nueva');
  assert.equal(cont.fwBan.length, 1, 'exactamente un POST /fw/ban');
  assert.equal(cont.filasBloqueo, 1, 'exactamente una fila de bloqueo');
  assert.equal(cont.filasSecEvents.filter((e) => e.kind === 'bloqueo').length, 1);
  assert.equal(cont.raise.length, 1, 'un solo correo security.ban');
  assert.equal(cont.fwBan[0].seconds, 3600, 'el primer bloqueo no puede quedar permanente por la propia ráfaga');
  const sig = guard.recientes().filter((e) => /sigue golpeando/.test(e.texto));
  assert.equal(sig.length, 12 - 5, 'los golpes posteriores al ban se ven como "sigue golpeando"');
});

test('si el INSERT falla, la marca en memoria se deshace', async () => {
  const { guard, cont } = armar();
  const pool = { async query(sql) { if (String(sql).includes('INSERT INTO pbxng_blocked')) throw new Error('db caída'); return { rows: [] }; } };
  const g2 = initGuard({ app: null, pool, ami: null, io: null, astFwd: async () => ({ ok: true, status: 200, json: async () => ({}) }), escribir() {}, alerts: null, geoLookup: async () => ({}), amiCommand: async () => '', log: { debug() {}, info() {}, warn() {}, error() {} } });
  await assert.rejects(g2.banear('203.0.113.10', { manual: true, permanent: true }));
  await assert.rejects(g2.banear('203.0.113.10', { manual: true, permanent: true }), 'la segunda también tiene que intentar el INSERT (no quedó marcada)');
  void guard; void cont;
});

test('las privadas nunca se banean', async () => {
  const { guard, ami, cont } = armar();
  guard._engancharAmi();
  for (let i = 0; i < 10; i++) ami.emit('managerevent', amiEvent('ChallengeResponseFailed', '192.168.1.50'));
  await esperar(40);
  assert.equal(cont.fwBan.length, 0);
  await assert.rejects(guard.banear('192.168.1.50', { manual: true }), /privadas/);
});

/* ---------------------------------------------------------------------------
 *  IPv6. La tabla de nftables ya era `inet`, pero el SOC descartaba todo lo que no
 *  fuera IPV4: un atacante por v6 contra el 5060 golpeaba sin que nadie lo contara.
 *  Lo que se prueba acá es lo que no se ve en una central sin v6: que el evento se
 *  entienda en las dos formas que manda Asterisk, que la dirección se guarde en UNA
 *  sola forma (si no, el desbloqueo no encuentra lo que baneó) y que la LAN v6
 *  (link-local y ULA) siga tan protegida como la v4.
 * ------------------------------------------------------------------------ */
const { parseRemote, ipEn, normalizarIp, esPrivada } = require('../guard');

test('parseRemote entiende las dos formas v6 de Asterisk (y la v4 de siempre)', () => {
  assert.deepEqual(parseRemote('IPV4/UDP/203.0.113.9/5060'), { ip: '203.0.113.9', proto: 'UDP', puerto: '5060' });
  assert.deepEqual(parseRemote('IPV6/UDP/2001:db8::1/5060'), { ip: '2001:db8::1', proto: 'UDP', puerto: '5060' });
  // Con corchetes el puerto viaja pegado a la dirección y todo cae en el tercer campo.
  assert.deepEqual(parseRemote('IPV6/WSS/[2001:db8::1]:5060'), { ip: '2001:db8::1', proto: 'WSS', puerto: '5060' });
  assert.equal(parseRemote('[::1]:5060').ip, '::1');
  assert.equal(parseRemote('IPV6/UDP/no-es-una-ip/5060'), null);
});

test('la misma IPv6 escrita de varias formas es una sola', () => {
  assert.equal(normalizarIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(normalizarIp('[2001:db8::1]'), '2001:db8::1');
  assert.equal(normalizarIp('fe80::1%eth0'), 'fe80::1');
  // Una v4 vista por un socket v6 se guarda como v4: el paquete que llega es v4 y el
  // drop que lo corta está en el set v4.
  assert.equal(normalizarIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(normalizarIp('1.2.3.4.5'), null);
});

test('la lista blanca acepta prefijos v6 y no mezcla familias', () => {
  assert.ok(ipEn('2001:db8:0:1::20', '2001:db8::/32'));
  assert.ok(!ipEn('2001:dba::20', '2001:db8::/32'));
  assert.ok(ipEn('2001:db8::1', '2001:0db8:0:0:0:0:0:1'));
  // Una regla v4 no puede eximir a una v6 (ni al revés): son espacios distintos.
  assert.ok(!ipEn('2001:db8::1', '0.0.0.0/0'));
  assert.ok(!ipEn('203.0.113.9', '::/0'));
  assert.ok(ipEn('203.0.113.9', '203.0.113.0/24'), 'la v4 de siempre tiene que seguir andando');
});

test('la LAN v6 (link-local, ULA, loopback) nunca se banea', async () => {
  assert.ok(esPrivada('fe80::1') && esPrivada('fd00::5') && esPrivada('::1'));
  assert.ok(!esPrivada('2a02:1234::5'));
  const { guard, ami, cont } = armar();
  guard._engancharAmi();
  for (let i = 0; i < 10; i++) ami.emit('managerevent', { ...amiEvent('ChallengeResponseFailed', 'x'), remoteaddress: 'IPV6/UDP/[fe80::1]:5060' });
  await esperar(40);
  assert.equal(cont.fwBan.length, 0, 'un teléfono de la LAN con la clave vieja no puede dejar a la oficina sin central');
});

test('un ataque por IPv6 se banea igual que uno por v4', async () => {
  const { guard, ami, cont } = armar();
  guard._engancharAmi();
  for (let i = 0; i < 6; i++) { ami.emit('managerevent', { ...amiEvent('ChallengeResponseFailed', 'x'), remoteaddress: 'IPV6/UDP/[2a02:1234::5]:5060' }); await esperar(20); }
  await esperar(50);
  assert.equal(cont.fwBan.length, 1, 'exactamente un POST /fw/ban');
  assert.equal(cont.fwBan[0].ip, '2a02:1234::5', 'al agente le tiene que llegar la forma canónica');
});
