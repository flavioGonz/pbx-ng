/* Pruebas del vigía de la conexión ARI (ari-vigia.js), con un fetch falso: sin
 * Asterisk. Se corren con `npm test` (node --test) desde control-plane/.
 *
 * El caso que lo motivó: el WebSocket del ARI muerto sin aviso, la API diciendo "ok"
 * y Asterisk sin la app, cortando cada llamada a la IA (2026-10-04). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { vigilarAri } = require('../ari-vigia');

/** Un fetch que contesta, en orden, los estados (o errores) dados. */
function centralFalsa(respuestas) {
  const pedidos = [];
  async function fetchImpl(url, opt) {
    pedidos.push({ url, opt });
    const r = respuestas.shift();
    if (r instanceof Error) throw r;
    return { status: r };
  }
  return { fetchImpl, pedidos };
}

const ARI = { url: 'http://asterisk:8088/', user: 'pbxng', pass: 'clave-ari', app: 'pbxng', cadaMs: 60000 };

test('con la app registrada no avisa nada', async () => {
  const { fetchImpl } = centralFalsa([200, 200]);
  let perdidas = 0;
  const vigia = vigilarAri({ ...ARI, fetchImpl, alPerder: () => perdidas++ });
  assert.equal(await vigia.comprobar(), 'ok');
  assert.equal(await vigia.comprobar(), 'ok');
  assert.equal(perdidas, 0);
  vigia.parar();
});

test('la central sin la app (404): avisa una sola vez y el vigía se apaga', async () => {
  const { fetchImpl, pedidos } = centralFalsa([200, 404, 404]);
  let perdidas = 0;
  const vigia = vigilarAri({ ...ARI, fetchImpl, alPerder: () => perdidas++ });
  assert.equal(await vigia.comprobar(), 'ok');
  assert.equal(await vigia.comprobar(), 'perdida');
  assert.equal(perdidas, 1);
  // Apagado: ya no pregunta ni vuelve a avisar.
  assert.equal(await vigia.comprobar(), 'parado');
  assert.equal(pedidos.length, 2);
  assert.equal(perdidas, 1);
});

test('un error de red no avisa (si Asterisk se cayó, lo avisa el WebSocket) y se loguea una vez por racha', async () => {
  const { fetchImpl } = centralFalsa([new Error('connect ECONNREFUSED'), new Error('connect ECONNREFUSED'), 200, new Error('timeout')]);
  const logs = [];
  let perdidas = 0;
  const vigia = vigilarAri({ ...ARI, fetchImpl, alPerder: () => perdidas++, log: (m) => logs.push(m) });
  assert.equal(await vigia.comprobar(), 'sin-respuesta');
  assert.equal(await vigia.comprobar(), 'sin-respuesta');
  assert.equal(await vigia.comprobar(), 'ok');
  assert.equal(await vigia.comprobar(), 'sin-respuesta');
  assert.equal(perdidas, 0);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /no se pudo comprobar la app pbxng en la central \(connect ECONNREFUSED\)/);
  vigia.parar();
});

test('otro estado (por ejemplo, 401 con la clave mal) no es prueba de que la app se perdió', async () => {
  const { fetchImpl } = centralFalsa([401, 500]);
  let perdidas = 0;
  const vigia = vigilarAri({ ...ARI, fetchImpl, alPerder: () => perdidas++ });
  assert.equal(await vigia.comprobar(), 'ok');
  assert.equal(await vigia.comprobar(), 'ok');
  assert.equal(perdidas, 0);
  vigia.parar();
});

test('pregunta por la app correcta, con la clave del ARI y un tope de tiempo', async () => {
  const { fetchImpl, pedidos } = centralFalsa([200]);
  const vigia = vigilarAri({ ...ARI, app: 'mi app', fetchImpl, alPerder: () => {} });
  await vigia.comprobar();
  vigia.parar();
  assert.equal(pedidos[0].url, 'http://asterisk:8088/ari/applications/mi%20app');
  assert.equal(pedidos[0].opt.headers.Authorization, 'Basic ' + Buffer.from('pbxng:clave-ari').toString('base64'));
  assert.ok(pedidos[0].opt.signal instanceof AbortSignal);
});

test('comprueba solo cada cadaMs, y parar() corta los chequeos', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { fetchImpl, pedidos } = centralFalsa([200, 200, 200]);
  const vigia = vigilarAri({ ...ARI, fetchImpl, alPerder: () => {} });
  assert.equal(pedidos.length, 0);
  t.mock.timers.tick(60000);
  assert.equal(pedidos.length, 1);
  t.mock.timers.tick(60000);
  assert.equal(pedidos.length, 2);
  vigia.parar();
  t.mock.timers.tick(120000);
  assert.equal(pedidos.length, 2);
});
