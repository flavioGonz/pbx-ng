/* ============================================================================
 *  Tanda 1 · el contrato público: credencial de sistema (B2), `/api/v1` (B4),
 *  paginación del CDR (B3) e identidad de llamada (B6).
 *
 *  Lo que estas pruebas cuidan NO es que las rutas anden: es que el contrato se pueda
 *  CUMPLIR. Un contrato con un tercero se rompe de tres formas, y las tres están acá:
 *    · alguien afloja la puerta (una sesión de panel entrando por /api/v1, un token de
 *      un cliente revocado que sigue sirviendo, un alcance que no se mira);
 *    · alguien cambia la forma de una respuesta (el sobre con `tope_aplicado` se
 *      convierte en un arreglo pelado y el que pagina deja de poder paginar);
 *    · alguien deja que un recorte sea silencioso, que es la peor: el backoffice arma un
 *      reporte al que le faltan llamadas y nadie se entera nunca.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

/* Una llamada con dos tramos, como las escribe Asterisk: mismo `linkedid`, distinto
 * `uniqueid`. Es la forma que obliga a que `call_id` y `leg_id` sean dos cosas. */
async function sembrarLlamada(db, { call, cuando, src, dst }) {
  await db.query(
    "INSERT INTO cdr (linkedid, uniqueid, start, src, dst, duration, billsec, disposition, dcontext) VALUES ($1,$2,$3,$4,$5,10,8,'ANSWERED','internal')",
    [call, call, cuando, src, dst]);
  await db.query(
    "INSERT INTO cdr (linkedid, uniqueid, start, src, dst, duration, billsec, disposition, dcontext) VALUES ($1,$2,$3,$4,$5,6,6,'ANSWERED','internal')",
    [call, call + '.b', new Date(new Date(cuando).getTime() + 1000), src, dst]);
}

test('v1: credencial de sistema, sobre, paginación e identidad de llamada', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  // ── Alta de la credencial (sólo admin: lo cubre el RBAC) ───────────────────
  const alta = await api('POST', '/api/api-clients', { token: admin, body: {
    client_id: 'horizon', nombre: 'Backoffice Horizon', alcances: ['cdr:leer', 'llamadas:ver'] } });
  assert.equal(alta.status, 201, JSON.stringify(alta.json));
  assert.ok(alta.json.secreto && alta.json.secreto.length >= 24, 'el secreto tiene que venir una vez y ser largo');
  const secreto = alta.json.secreto;

  await t.test('el secreto se muestra UNA vez y no se puede volver a leer', async () => {
    const lista = await api('GET', '/api/api-clients', { token: admin });
    assert.equal(lista.status, 200);
    const txt = JSON.stringify(lista.json);
    assert.ok(!txt.includes(secreto), 'el listado devolvió el secreto');
    assert.ok(!/secreto_hash/.test(txt), 'el listado devolvió el hash: tampoco tiene que salir');
  });

  await t.test('una credencial sin alcances se rechaza: no sirve para nada', async () => {
    const r = await api('POST', '/api/api-clients', { token: admin, body: { client_id: 'vacio', nombre: 'x', alcances: [] } });
    assert.equal(r.status, 400);
  });

  await t.test('un alcance inventado se rechaza nombrando los válidos', async () => {
    const r = await api('POST', '/api/api-clients', { token: admin, body: { client_id: 'raro', nombre: 'x', alcances: ['todo:todo'] } });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.json.alcances_validos), 'el error tiene que decir cuáles valen');
  });

  // ── Token de servicio ──────────────────────────────────────────────────────
  const tok = await api('POST', '/api/v1/auth/token', { body: { client_id: 'horizon', secreto } });
  assert.equal(tok.status, 200, JSON.stringify(tok.json));
  const servicio = tok.json.token;
  assert.deepEqual(tok.json.alcances, ['cdr:leer', 'llamadas:ver']);

  await t.test('con secreto equivocado no se emite token, y el error no dice por qué', async () => {
    const r = await api('POST', '/api/v1/auth/token', { body: { client_id: 'horizon', secreto: 'no-es' } });
    assert.equal(r.status, 401);
    assert.match(String(r.json.error), /incorrectos/);
    const r2 = await api('POST', '/api/v1/auth/token', { body: { client_id: 'no-existe', secreto: 'x' } });
    assert.equal(r2.status, 401);
    assert.equal(r2.json.error, r.json.error, 'el mensaje distingue «no existe» de «clave mala»: no tiene que');
  });

  await t.test('sin token, /api/v1 no deja pasar nada, ni siquiera un 404', async () => {
    for (const ruta of ['/api/v1/yo', '/api/v1/cdr', '/api/v1/lo-que-sea']) {
      assert.equal((await api('GET', ruta)).status, 401, 'entró sin credencial a ' + ruta);
    }
  });

  await t.test('una sesión de PANEL no sirve en /api/v1, y eso es a propósito', async () => {
    const r = await api('GET', '/api/v1/yo', { token: admin });
    assert.equal(r.status, 403, 'un token de panel entró al contrato público');
    assert.match(String(r.json.error), /credenciales de sistema/);
  });

  await t.test('/yo dice quién sos, qué podés y cuál es la política', async () => {
    const r = await api('GET', '/api/v1/yo', { token: servicio });
    assert.equal(r.status, 200);
    assert.equal(r.json.client_id, 'horizon');
    assert.deepEqual(r.json.alcances, ['cdr:leer', 'llamadas:ver']);
    assert.match(String(r.json.politica), /v2/, 'la política de compatibilidad tiene que estar en la respuesta, no sólo en un .md');
  });

  await t.test('un alcance que no se tiene da 403 y NOMBRA el que falta', async () => {
    const r = await api('GET', '/api/v1/grabaciones', { token: servicio });
    assert.equal(r.status, 403);
    assert.equal(r.json.alcance_requerido, 'grabaciones:leer');
  });

  // ── El sobre y la paginación ───────────────────────────────────────────────
  const base = new Date('2026-09-20T12:00:00Z');
  for (let i = 0; i < 7; i++) {
    await sembrarLlamada(ctx.db, { call: '17900000' + i + '.1', cuando: new Date(base.getTime() - i * 60000), src: '2001', dst: '2002' });
  }

  await t.test('toda lista viene en un sobre, con el tope aplicado a la vista', async () => {
    const r = await api('GET', '/api/v1/cdr?limite=5&desde=2026-09-01T00:00:00Z&hasta=2026-09-21T00:00:00Z', { token: servicio });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(Array.isArray(r.json.items), 'items tiene que ser un arreglo');
    assert.equal(r.json.tope_aplicado, 5);
    assert.equal(r.json.truncado, true, 'hay más filas que el tope: el que pregunta tiene que enterarse');
    assert.ok(r.json.next_cursor, 'con más filas tiene que venir el cursor');
  });

  await t.test('el cursor recorre TODO sin repetir ni saltear, aunque entren llamadas nuevas', async () => {
    const vistos = [];
    let cursor = null, vueltas = 0;
    do {
      const url = '/api/v1/cdr?limite=4&desde=2026-09-01T00:00:00Z&hasta=2026-09-21T00:00:00Z' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const r = await api('GET', url, { token: servicio });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      for (const f of r.json.items) vistos.push(f.leg_id);
      cursor = r.json.next_cursor;
      /* Una llamada nueva EN EL MEDIO de la paginación. Con OFFSET esto corre todas las
       * filas y el que pagina se saltea una; con cursor sobre (start, uniqueid), no. */
      if (vueltas === 0) await sembrarLlamada(ctx.db, { call: '17909999.1', cuando: new Date(base.getTime() + 60000), src: '2001', dst: '2003' });
      vueltas++;
    } while (cursor && vueltas < 20);

    const unicos = new Set(vistos);
    assert.equal(unicos.size, vistos.length, 'el cursor repitió filas: ' + vistos.length + ' vistas, ' + unicos.size + ' distintas');
    assert.ok(vistos.length >= 14, 'faltan filas: se vieron ' + vistos.length + ' de las 14 sembradas');
  });

  await t.test('un rango más largo que el máximo se rechaza diciendo cuánto es el máximo', async () => {
    const r = await api('GET', '/api/v1/cdr?desde=2020-01-01T00:00:00Z&hasta=2026-09-21T00:00:00Z', { token: servicio });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /m[aá]ximo es \d+/);
  });

  await t.test('un cursor inventado se rechaza en vez de devolver cualquier cosa', async () => {
    const r = await api('GET', '/api/v1/cdr?cursor=no-es-un-cursor', { token: servicio });
    assert.equal(r.status, 400);
  });

  // ── Identidad de llamada ───────────────────────────────────────────────────
  await t.test('B6 · call_id agrupa los tramos y leg_id los distingue', async () => {
    const r = await api('GET', '/api/v1/cdr/17900000' + 0 + '.1', { token: servicio });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.tramos.length, 2, 'la llamada tiene dos tramos');
    const [a, b] = r.json.tramos;
    assert.equal(a.call_id, b.call_id, 'los dos tramos son la MISMA llamada');
    assert.notEqual(a.leg_id, b.leg_id, 'y son tramos distintos');
    assert.equal(typeof a.call_id, 'string', 'call_id viaja como texto: como número pierde precisión');
  });

  await t.test('un call_id que no existe da 404, no una lista vacía', async () => {
    assert.equal((await api('GET', '/api/v1/cdr/no.existe', { token: servicio })).status, 404);
  });

  await t.test('/api/cdr (el del panel) también trae call_id y leg_id, sin romper su forma', async () => {
    const r = await api('GET', '/api/cdr?limit=3', { token: admin });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json), 'el panel espera un arreglo: esta ruta NO cambia de forma');
    assert.ok(r.json[0] && 'call_id' in r.json[0] && 'leg_id' in r.json[0]);
  });

  // ── Revocar corta de verdad ────────────────────────────────────────────────
  // ── Idempotencia (B5) ──────────────────────────────────────────────────────
  await t.test('B5 · la misma Idempotency-Key no ordena la llamada dos veces', async () => {
    /* El cliente necesita el alcance de ordenar: se lo damos y se pide un token nuevo,
     * porque los alcances viajan en el token y el viejo no los tiene. */
    assert.equal((await api('PUT', '/api/api-clients/horizon', { token: admin, body: { alcances: ['cdr:leer', 'llamadas:ver', 'llamadas:ordenar'] } })).status, 200);
    const t2 = await api('POST', '/api/v1/auth/token', { body: { client_id: 'horizon', secreto } });
    assert.equal(t2.status, 200);
    const tk = t2.json.token;

    /* Asterisk NO está en las pruebas, así que originar devuelve 503. Eso no debilita la
     * prueba: lo que se mide es que la SEGUNDA vez conteste lo mismo sin volver a
     * intentar, y un 503 guardado es tan bueno como un 202 para eso. */
    const uno = await api('POST', '/api/v1/llamadas/originar', { token: tk, headers: { 'Idempotency-Key': 'ticket-4711' }, body: { desde: '2001', hacia: '2002' } });
    const dos = await api('POST', '/api/v1/llamadas/originar', { token: tk, headers: { 'Idempotency-Key': 'ticket-4711' }, body: { desde: '2001', hacia: '2002' } });
    assert.equal(dos.status, uno.status, 'el reintento contestó distinto que el original');
    assert.deepEqual(dos.json, uno.json, 'el reintento no devolvió la respuesta guardada');
    assert.equal(dos.headers.get('idempotent-replay'), 'true', 'falta el aviso de que esto es una repetición');

    // La MISMA clave con OTRO cuerpo es un bug del que llama: 409, no la respuesta vieja.
    const otro = await api('POST', '/api/v1/llamadas/originar', { token: tk, headers: { 'Idempotency-Key': 'ticket-4711' }, body: { desde: '2001', hacia: '2999' } });
    assert.equal(otro.status, 409, 'la misma clave con otro cuerpo devolvió una respuesta cacheada que no corresponde');

    // Sin la cabecera se ejecuta normal (no se obliga: un consumidor que arranca no la tiene).
    const libre = await api('POST', '/api/v1/llamadas/originar', { token: tk, body: { desde: '2001', hacia: '2002' } });
    assert.ok([202, 503].includes(libre.status), 'sin Idempotency-Key tiene que ejecutarse igual, dio ' + libre.status);

    // Y el destino se valida: lo que entra acá termina en un dialplan.
    assert.equal((await api('POST', '/api/v1/llamadas/originar', { token: tk, body: { desde: '2001', hacia: 'rm -rf' } })).status, 400);
  });

  await t.test('revocar corta el acceso aunque el token siga vigente', async () => {
    const antes = await api('GET', '/api/v1/yo', { token: servicio });
    assert.equal(antes.status, 200);

    assert.equal((await api('POST', '/api/api-clients/horizon/revocar', { token: admin })).status, 200);
    /* La caché de clientes dura unos segundos y el aviso de la respuesta lo dice; acá se
     * espera ese tiempo para medir lo que importa: que DESPUÉS ya no entre. */
    await new Promise((r) => setTimeout(r, 5200));

    const despues = await api('GET', '/api/v1/yo', { token: servicio });
    assert.equal(despues.status, 401, 'el token de un cliente revocado sigue entrando: revocar no sirve');
    assert.equal((await api('POST', '/api/v1/auth/token', { body: { client_id: 'horizon', secreto } })).status, 401,
      'un cliente revocado todavía puede pedir un token nuevo');
  });

  await t.test('rotar revive la credencial y el secreto viejo deja de servir', async () => {
    const r = await api('POST', '/api/api-clients/horizon/rotar', { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.notEqual(r.json.secreto, secreto);
    assert.equal((await api('POST', '/api/v1/auth/token', { body: { client_id: 'horizon', secreto } })).status, 401, 'el secreto viejo sigue sirviendo');
    assert.equal((await api('POST', '/api/v1/auth/token', { body: { client_id: 'horizon', secreto: r.json.secreto } })).status, 200);
  });
});
