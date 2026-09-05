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
