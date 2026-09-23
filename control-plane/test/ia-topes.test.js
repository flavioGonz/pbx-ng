/* ============================================================================
 *  A1 · El CRM del backoffice no puede quedarse con la llamada.
 *
 *  `crmLookup()` corre CON LA LLAMADA ABIERTA: el asistente le pregunta al webhook del
 *  backoffice por el cliente que está hablando y, mientras tanto, la persona escucha
 *  silencio. Sin tope, un servidor que acepta la conexión y no contesta nunca dejaba la
 *  llamada muda 90 segundos —el default de undici— y para cuando volvía ya habían
 *  cortado. El código YA tenía escrita la frase de degradación: faltaba llegar a ella.
 *
 *  Esta prueba levanta exactamente ese servidor —acepta y se calla— y exige que la
 *  función vuelva con la frase degradada en menos de 3 s. No necesita Postgres ni
 *  Asterisk, así que corre siempre, también en la CI.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const ia = require('../ai-pipeline');

test('el lookup al CRM se corta solo y devuelve el camino degradado', async (t) => {
  /* Servidor mudo: acepta el TCP y no escribe una sola respuesta. Se guardan los sockets
   * para romperlos al final: `close()` solo no vuelve mientras quede una conexión
   * abierta, y la del cliente abortado queda del lado del servidor. */
  const vivos = [];
  const mudo = net.createServer((s) => { vivos.push(s); });
  await new Promise((ok) => mudo.listen(0, '127.0.0.1', ok));
  const puerto = mudo.address().port;
  t.after(() => new Promise((ok) => { for (const s of vivos) s.destroy(); mudo.close(ok); }));

  /* node --test da por terminada la prueba si el bucle de eventos se queda sin handles
   * REFERENCIADOS, y los dos relojes que cortan acá están unref'ados a propósito (no
   * tienen por qué mantener viva a la API). Este latido sostiene el bucle mientras se
   * mide, y se apaga al final. */
  const latido = setInterval(() => {}, 100);
  t.after(() => clearInterval(latido));

  const sesion = { agent: { crm_webhook: 'http://127.0.0.1:' + puerto + '/crm', name: 'prueba' }, callerId: '1001' };
  const t0 = Date.now();
  const r = await ia._crmLookup('saldo', sesion);
  const ms = Date.now() - t0;

  assert.match(String(r), /No pude consultar el CRM/, 'tiene que volver la frase degradada, no una excepción');
  assert.ok(ms < 3000, 'tardó ' + ms + ' ms: el tope de ' + ia._TOPE_CRM_MS + ' ms no se está aplicando');
});

test('sin CRM configurado no se intenta nada y se ofrece una persona', async () => {
  const r = await ia._crmLookup('saldo', { agent: {}, callerId: '1001' });
  assert.match(String(r), /pasarte con una persona/);
});
