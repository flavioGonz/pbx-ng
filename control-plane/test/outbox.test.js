/* ============================================================================
 *  B1 · Outbox de eventos salientes.
 *
 *  Lo que estas pruebas cuidan es lo que hace que un outbox SIRVA, que no es «postea
 *  eventos»:
 *    · que el camino de la llamada no espere a Postgres (se encola y se vuelca de a lotes);
 *    · que un destino caído NO pierda eventos y los reciba cuando vuelve;
 *    · que el orden por llamada se respete;
 *    · que la entrega venga firmada, para que el que recibe sepa que salió de esta central;
 *    · que dar de alta un destino no le dispare una semana de historia de golpe;
 *    · y que el modo PULL (para el que no puede exponer un webhook) no reentregue lo ya
 *      confirmado ni deje retroceder el cursor.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { entorno } = require('./helpers/db');

/* Un destino de webhook de mentira, que se puede romper y arreglar a voluntad. */
function destinoFalso() {
  const recibido = [];
  let estado = 200;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (estado >= 400) { res.writeHead(estado); return res.end('no'); }
      try { recibido.push({ firma: req.headers['x-pbxng-firma'], cuerpo: JSON.parse(b) }); } catch (_) {}
      res.writeHead(200); res.end('ok');
    });
  });
  return {
    recibido,
    romper: (c) => { estado = c || 500; },
    arreglar: () => { estado = 200; },
    eventos: () => recibido.flatMap((r) => r.cuerpo.eventos || []),
    escuchar: () => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok('http://127.0.0.1:' + srv.address().port + '/hook'))),
    cerrar: () => new Promise((ok) => srv.close(ok)),
  };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
/* El worker corre cada segundo: se espera a que pase algo en vez de dormir a ciegas. */
async function hasta(fn, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await esperar(250); }
  return false;
}

test('outbox: entrega firmada, reintento sin pérdida, y modo pull', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  const destino = destinoFalso();
  const url = await destino.escuchar();
  t.after(() => destino.cerrar());

  const alta = await api('POST', '/api/eventos/suscripciones', { token: admin, body: { nombre: 'Backoffice de prueba', url, tipos: ['llamada.terminada'] } });
  assert.equal(alta.status, 201, JSON.stringify(alta.json));
  const secreto = alta.json.secreto;
  assert.ok(secreto && secreto.length >= 24, 'la suscripción tiene que nacer con un secreto propio y largo');

  await t.test('la entrega llega firmada con HMAC del cuerpo', async () => {
    assert.equal((await api('POST', '/api/eventos/prueba', { token: admin })).status, 200);
    assert.ok(await hasta(() => destino.eventos().length >= 1), 'no llegó ningún evento al destino');
    const r = destino.recibido[0];
    const esperada = 'sha256=' + crypto.createHmac('sha256', secreto).update(JSON.stringify(r.cuerpo)).digest('hex');
    assert.equal(r.firma, esperada, 'la firma no valida: el que recibe no puede comprobar que salió de esta central');
    assert.equal(r.cuerpo.eventos[0].tipo, 'llamada.terminada');
    assert.ok(r.cuerpo.eventos[0].evento_id, 'falta evento_id: es la garantía de «exactamente una vez» del lado de quien recibe');
  });

  await t.test('un destino caído no pierde eventos: los recibe cuando vuelve', async () => {
    const antes = destino.eventos().length;
    destino.romper(503);
    for (let i = 0; i < 3; i++) assert.equal((await api('POST', '/api/eventos/prueba', { token: admin })).status, 200);

    /* Mientras está roto, el cursor NO avanza y los intentos suben: es lo que hace que
     * los eventos sigan ahí en vez de darse por entregados. */
    assert.ok(await hasta(async () => {
      const l = await api('GET', '/api/eventos/suscripciones', { token: admin });
      return l.json.suscripciones[0].intentos > 0;
    }), 'el destino roto no dejó rastro de intentos fallidos');
    assert.equal(destino.eventos().length, antes, 'llegaron eventos a un destino que está devolviendo 503');

    const l = await api('GET', '/api/eventos/suscripciones', { token: admin });
    assert.ok(l.json.suscripciones[0].pendientes >= 3, 'el panel tiene que mostrar cuántos eventos están esperando');
    assert.ok(l.json.suscripciones[0].ultimo_error, 'y por qué fallan');

    destino.arreglar();
    /* El backoff crece, así que se le da tiempo; lo que importa es que NINGUNO se perdió. */
    assert.ok(await hasta(() => destino.eventos().length >= antes + 3, 30000),
      'después de volver, el destino no recibió los eventos que se habían acumulado');
  });

  await t.test('el orden de los eventos de una llamada se respeta', async () => {
    const seqs = destino.eventos().map((e) => Number(e.secuencia));
    const ordenado = [...seqs].sort((a, b) => a - b);
    assert.deepEqual(seqs, ordenado, 'los eventos llegaron desordenados');
  });

  await t.test('un destino nuevo NO recibe la historia vieja', async () => {
    const otro = destinoFalso();
    const url2 = await otro.escuchar();
    t.after(() => otro.cerrar());
    const a2 = await api('POST', '/api/eventos/suscripciones', { token: admin, body: { nombre: 'Recién llegado', url: url2, tipos: [] } });
    assert.equal(a2.status, 201);
    await esperar(2500);
    assert.equal(otro.eventos().length, 0, 'un alta nueva se comió toda la historia: eso es un aluvión de eventos viejos para el que recién se conecta');

    // Pero sí recibe lo que pase DESPUÉS.
    assert.equal((await api('POST', '/api/eventos/prueba', { token: admin })).status, 200);
    assert.ok(await hasta(() => otro.eventos().length >= 1), 'el destino nuevo no recibió un evento posterior a su alta');
  });

  await t.test('una URL que no es http se rechaza al dar de alta', async () => {
    const r = await api('POST', '/api/eventos/suscripciones', { token: admin, body: { nombre: 'mala', url: 'ftp://x/y' } });
    assert.equal(r.status, 400);
  });

  // ── Modo PULL: para el que no puede exponer un webhook ──────────────────────
  await t.test('pull: leer, confirmar, y no volver a recibir lo confirmado', async () => {
    const cli = await api('POST', '/api/api-clients', { token: admin, body: { client_id: 'pull-test', nombre: 'Sin webhook', alcances: ['eventos:recibir'] } });
    assert.equal(cli.status, 201, JSON.stringify(cli.json));
    const tk = (await api('POST', '/api/v1/auth/token', { body: { client_id: 'pull-test', secreto: cli.json.secreto } })).json.token;

    // Sin suscripción, el error dice qué falta en vez de devolver una lista vacía.
    const sin = await api('GET', '/api/v1/eventos', { token: tk });
    assert.equal(sin.status, 409);

    const s = await api('POST', '/api/eventos/suscripciones', { token: admin, body: { nombre: 'Pull', client_id: 'pull-test', tipos: [] } });
    assert.equal(s.status, 201);

    assert.equal((await api('POST', '/api/eventos/prueba', { token: admin })).status, 200);
    await esperar(1200);

    const uno = await api('GET', '/api/v1/eventos', { token: tk });
    assert.equal(uno.status, 200, JSON.stringify(uno.json));
    assert.ok(uno.json.items.length >= 1, 'el modo pull no devolvió el evento');
    assert.ok(uno.json.next_cursor, 'falta el cursor para confirmar');
    assert.ok(/confirm/.test(String(uno.json.aviso || '')), 'el que consume tiene que saber que si no confirma, lo vuelve a recibir');

    // Sin confirmar, vuelve a venir: es el comportamiento correcto (al menos una vez).
    const otra = await api('GET', '/api/v1/eventos', { token: tk });
    assert.equal(otra.json.items.length, uno.json.items.length, 'sin acuse, el evento tiene que seguir ahí');

    assert.equal((await api('POST', '/api/v1/eventos/acuse', { token: tk, body: { cursor: uno.json.next_cursor } })).status, 200);
    const vacia = await api('GET', '/api/v1/eventos', { token: tk });
    assert.equal(vacia.json.items.length, 0, 'después del acuse siguió devolviendo lo mismo');

    /* El cursor sólo avanza: un acuse hacia atrás le reenviaría eventos a sí mismo para
     * siempre. Para releer está `desde_cursor`, que no toca el acuse. */
    assert.equal((await api('POST', '/api/v1/eventos/acuse', { token: tk, body: { cursor: '0' } })).status, 200);
    assert.equal((await api('GET', '/api/v1/eventos', { token: tk })).json.items.length, 0, 'el cursor retrocedió con un acuse viejo');
    assert.ok((await api('GET', '/api/v1/eventos?desde_cursor=0', { token: tk })).json.items.length >= 1, 'desde_cursor tiene que poder releer sin tocar el acuse');
  });

  await t.test('un tipo de evento inventado se rechaza nombrando los válidos', async () => {
    const r = await api('POST', '/api/eventos/suscripciones', { token: admin, body: { nombre: 'x', url, tipos: ['llamada.inventada'] } });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.json.tipos_validos));
  });

  await t.test('el catálogo es público para el panel y trae la versión de cada tipo', async () => {
    const r = await api('GET', '/api/eventos/catalogo', { token: admin });
    assert.equal(r.status, 200);
    assert.equal(Object.keys(r.json).length, 7, 'son siete tipos, ni más ni menos: agregar uno es una decisión de contrato');
    assert.equal(r.json['llamada.terminada'].version, 1, 'la versión va POR TIPO');
  });
});
