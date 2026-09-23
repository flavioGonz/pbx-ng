/* ============================================================================
 *  El filtro de «esto lo mandó el dialplan de esta central» (desde-la-central.js).
 *
 *  Esta prueba existe por un bug que NINGUNA prueba de integración podía ver: el filtro
 *  exigía origen loopback, y con la API detrás del bridge de Docker el origen que llega es
 *  el gateway del bridge, porque `docker-proxy` abre una conexión nueva hacia el
 *  contenedor. O sea que rechazaba justo al único que tenía que dejar pasar: los desvíos,
 *  el no-molestar, el sígueme, la DISA y el callback marcados DESDE UN TELÉFONO no hacían
 *  nada, sin un solo error en el log. Verificado en producción con el token correcto:
 *  `POST /api/internal/feature` → 403.
 *
 *  Las pruebas de integración no lo veían porque le pegan a la API por loopback: no hay
 *  contenedor ni docker-proxy en el medio. Por eso acá se prueba el PREDICADO con pedidos
 *  falsos, que es la única forma de cubrir algo que depende de la red de abajo.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crear = require('../desde-la-central');

const TOKEN = 'a'.repeat(64);
const filtro = crear({ token: TOKEN, clientIp: (req) => req.ip });
const pedido = (ip, opt) => Object.assign({ ip, headers: {}, query: {}, body: {} }, opt || {});

test('loopback con el token pasa; sin el token no, aunque sea loopback', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(filtro.permitido(pedido(ip, { query: { tok: TOKEN } })).ok, true, 'rechazó ' + ip);
    /* Loopback prueba que el pedido nació en esta máquina, no que lo hizo el dialplan:
     * cualquier proceso del host llega igual al puerto publicado. */
    assert.equal(filtro.permitido(pedido(ip)).ok, false, 'pasó sin token desde ' + ip);
  }
});

test('el gateway del bridge de Docker pasa CON el token: es el caso que estaba roto', () => {
  // 172.18.0.1 es exactamente lo que ve la API cuando Asterisk pega a 127.0.0.1:3000 y
  // docker-proxy reenvía al contenedor.
  const r = filtro.permitido(pedido('172.18.0.1', { query: { tok: TOKEN } }));
  assert.equal(r.ok, true, 'sigue rechazando al dialplan detrás de docker-proxy: ' + r.motivo);
  assert.match(r.motivo, /token del agente/);
});

test('sin token, una IP privada NO alcanza', () => {
  const r = filtro.permitido(pedido('172.18.0.1'));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /token del agente/);
  assert.equal(filtro.permitido(pedido('192.168.1.50')).ok, false);
});

test('un token equivocado no pasa ni desde loopback', () => {
  const r = filtro.permitido(pedido('127.0.0.1', { query: { tok: 'b'.repeat(64) } }));
  assert.equal(r.ok, false, 'un token incorrecto entró igual porque venía de loopback');
  assert.match(r.motivo, /no coincide/);
});

test('una IP pública no pasa ni con el token', () => {
  const r = filtro.permitido(pedido('203.0.113.9', { query: { tok: TOKEN } }));
  assert.equal(r.ok, false, 'entró un pedido desde una IP pública con el token: el token se filtró y no hay segunda barrera');
});

test('cualquier cabecera de proxy descarta el pedido antes de mirar nada', () => {
  for (const h of ['x-forwarded-for', 'x-real-ip']) {
    const r = filtro.permitido(pedido('127.0.0.1', { headers: { [h]: '203.0.113.9' }, query: { tok: TOKEN } }));
    assert.equal(r.ok, false, 'pasó con ' + h);
    assert.match(r.motivo, /proxy/);
  }
});

test('sin token configurado se vuelve al criterio estricto de loopback', () => {
  const sinToken = crear({ token: '', clientIp: (req) => req.ip });
  assert.equal(sinToken.permitido(pedido('127.0.0.1')).ok, true);
  assert.match(sinToken.permitido(pedido('127.0.0.1')).motivo, /todavía no hay token/);
  const r = sinToken.permitido(pedido('172.18.0.1'));
  assert.equal(r.ok, false, 'sin token, una IP privada no puede alcanzar');
  assert.match(r.motivo, /sólo se acepta loopback/);
});

test('exigir() corta con 403 y respeta el formato que espera cada quien', () => {
  const resFalsa = () => {
    const o = { code: null, cuerpo: null, tipoDado: null };
    o.status = (c) => { o.code = c; return o; };
    o.json = (b) => { o.cuerpo = b; return o; };
    o.type = (t) => { o.tipoDado = t; return o; };
    o.send = (b) => { o.cuerpo = b; return o; };
    return o;
  };
  const r1 = resFalsa();
  assert.equal(filtro.exigir(pedido('203.0.113.9'), r1), false);
  assert.equal(r1.code, 403);
  assert.deepEqual(r1.cuerpo, { error: 'sólo desde la central' });

  // El que lee la respuesta de la DISA y del wake es un ${CURL(...)}, no un navegador.
  const r2 = resFalsa();
  assert.equal(filtro.exigir(pedido('203.0.113.9'), r2, 'texto'), false);
  assert.equal(r2.tipoDado, 'text/plain');
  assert.equal(r2.cuerpo, 'no');

  const r3 = resFalsa();
  assert.equal(filtro.exigir(pedido('127.0.0.1', { query: { tok: TOKEN } }), r3), true);
  assert.equal(r3.code, null, 'tocó la respuesta en un pedido que sí tenía que pasar');
});
