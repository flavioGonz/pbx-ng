/* Pruebas del consumidor AMI de eventos de cola (ccreport.js) con mocks: sin Postgres,
 * sin Asterisk. Se corren con `npm test` (node --test) desde control-plane/.
 *
 * Lo que se verifica es el TECHO, que es el motivo por el que el consumidor existe así:
 * es la única pieza del informe que escribe al ritmo de las llamadas y comparte el pool
 * con los `CURL()` del dialplan (el PIN de la DISA, el código de función).
 *   1) un pico de eventos NO se traduce en un INSERT por evento: se juntan en lotes;
 *   2) con la base lenta no se acumulan consultas en vuelo (una sola por vez);
 *   3) pasado el tope del buffer se descartan eventos en vez de crecer sin límite;
 *   4) el `ts` es el de la llamada, no el del INSERT (el volcado es diferido). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* Un ccreport con dependencias falsas. `demoraMs` simula una base lenta (un vacuum, el
 * respaldo nocturno) para ver qué hace el consumidor mientras tanto. */
function armar(opt) {
  const o = opt || {};
  const ami = new EventEmitter();
  const cont = { inserts: [], enVuelo: 0, maxEnVuelo: 0, errores: [] };
  const pool = {
    async query(sql, params) {
      if (String(sql).includes('INSERT INTO pbxng_queue_events')) {
        cont.enVuelo++;
        cont.maxEnVuelo = Math.max(cont.maxEnVuelo, cont.enVuelo);
        try {
          if (o.demoraMs) await esperar(o.demoraMs);
          if (o.fallar) throw new Error('base caida');
          cont.inserts.push(params);
          return { rows: [], rowCount: params.length / 10 };
        } finally { cont.enVuelo--; }
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
  // El módulo registra rutas al cargarse: alcanza con un Express de mentira.
  const app = { get() {}, post() {}, put() {}, delete() {} };
  const logger = () => ({ debug() {}, info() {}, warn() {}, error(...a) { cont.errores.push(a); } });
  const cc = require('../ccreport')({ app, pool, ami, alerts: { raise: async () => false }, errorHttp() {}, logger });
  return { cc, ami, cont };
}

const evento = (event, cola, extra) => Object.assign({ event, queue: cola, uniqueid: '1.1', calleridnum: '099111222' }, extra || {});

test('un pico de eventos de cola se guarda en UN lote, no en un INSERT por evento', async () => {
  const { cc, ami, cont } = armar();
  for (let i = 0; i < 60; i++) ami.emit('managerevent', evento('QueueCallerJoin', 'ventas', { position: String(i) }));
  assert.equal(cont.inserts.length, 0, 'el handler del AMI no puede tocar el pool');
  assert.equal(cc.pendientes.length, 60);
  await cc.volcar();
  assert.equal(cont.inserts.length, 1, '60 eventos = 1 INSERT multi-fila');
  assert.equal(cont.inserts[0].length, 60 * 10);
  assert.equal(cc.pendientes.length, 0);
});

test('con la base lenta no se encima un volcado con otro: una consulta por vez', async () => {
  const { cc, ami, cont } = armar({ demoraMs: 40 });
  for (let i = 0; i < 10; i++) ami.emit('managerevent', evento('AgentConnect', 'ventas', { membername: '1001', holdtime: '5' }));
  const a = cc.volcar();
  for (let i = 0; i < 10; i++) ami.emit('managerevent', evento('QueueCallerAbandon', 'ventas', { holdtime: '9' }));
  const b = cc.volcar();          // llega mientras la anterior sigue en la base
  await Promise.all([a, b]);
  assert.equal(cont.maxEnVuelo, 1, 'el consumidor nunca puede tener dos consultas en vuelo');
  await cc.volcar();
  assert.equal(cc.pendientes.length, 0);
});

test('pasado el tope, el buffer descarta eventos en vez de crecer sin límite', async () => {
  /* El tope se lee en cada init(), así que alcanza con ponerlo antes de armar. */
  process.env.CC_LOTE_TOPE = '120';
  let cc, ami, cont;
  try { ({ cc, ami, cont } = armar()); } finally { delete process.env.CC_LOTE_TOPE; }
  for (let i = 0; i < 500; i++) ami.emit('managerevent', evento('QueueCallerJoin', 'ventas'));
  assert.equal(cc.pendientes.length, 120, 'el buffer tiene techo');
  assert.ok(cont.errores.length >= 1, 'descartar eventos se avisa en el log');
});

test('el ts es el del evento y no el del INSERT diferido', async () => {
  const { cc, ami, cont } = armar();
  const antes = Date.now();
  ami.emit('managerevent', evento('AgentComplete', 'ventas', { membername: '1001', holdtime: '3', talktime: '120', reason: 'agent' }));
  await esperar(30);
  await cc.volcar();
  const ts = cont.inserts[0][0];
  assert.ok(ts instanceof Date);
  assert.ok(ts.getTime() >= antes && ts.getTime() <= antes + 25, 'el ts se toma cuando llega el evento');
});

test('si el INSERT falla, el lote se pierde con aviso y el consumidor sigue vivo', async () => {
  const { cc, ami, cont } = armar({ fallar: true });
  ami.emit('managerevent', evento('QueueCallerJoin', 'ventas'));
  await cc.volcar();
  assert.equal(cc.pendientes.length, 0);
  assert.ok(cont.errores.length >= 1);
  // El siguiente evento se sigue encolando: un fallo no deja el consumidor mudo.
  ami.emit('managerevent', evento('QueueCallerJoin', 'ventas'));
  assert.equal(cc.pendientes.length, 1);
});
