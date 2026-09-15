/* Integración · módulo Portería (id interno `intercom`) contra la API real y un
 * PostgreSQL efímero. Sin Postgres disponible se saltea.
 *
 * Cubre las tres cosas que este módulo NO puede romper, y que son justamente las que
 * se rompen solas si alguien "limpia" el código sin leer docs/CONTRATOS.md §3:
 *
 *   1) el id del módulo sigue siendo `intercom` — el perfil del compose, el
 *      reconciliador y la fila `mod_intercom` de las centrales instaladas lo conocen
 *      con ese nombre; la etiqueta «Portería» es sólo lo que ve el usuario;
 *   2) apagar Portería apaga el VIDEO, no el screen-pop: `GET /api/clients/lookup`
 *      tiene que seguir devolviendo al cliente con sus personas y espacios, con
 *      `devices` vacío. Si esto se pone rojo, el agente dejó de ver quién lo llama;
 *   3) las credenciales RTSP no salen enteras por la API, y guardar una etiqueta no
 *      borra la clave de la cámara.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

const RTSP = 'rtsp://admin:S3cr3ta@192.0.2.50:554/Streaming/Channels/101';

test('portería: módulo `intercom`, screen-pop intacto y credenciales RTSP tapadas', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const token = (await login('admin', 'admin')).token;

  // Cliente con teléfono (para el lookup) y un portero con credenciales en la URL.
  const cli = await api('POST', '/api/clients', { token, body: { name: 'Casa de prueba', phones: '29001122' } });
  assert.equal(cli.status, 201, JSON.stringify(cli.json));
  const cid = cli.json.id;
  const dev = await api('POST', '/api/clients/' + cid + '/devices', { token, body: { label: 'Frente', type: 'intercom', rtsp_url: RTSP } });
  assert.equal(dev.status, 201, JSON.stringify(dev.json));
  const did = dev.json.id;

  await t.test('el id del módulo es `intercom` y se puede prender y apagar', async () => {
    const m = await api('GET', '/api/modules', { token });
    assert.equal(m.status, 200);
    assert.ok(Object.prototype.hasOwnProperty.call(m.json, 'intercom'), 'falta el módulo intercom en /api/modules');
    assert.equal(m.json.intercom, true, 'Portería viene encendida por defecto (es lo que ya hacen las centrales instaladas)');
    assert.equal((await api('POST', '/api/modules', { token, body: { id: 'porteria', enabled: true } })).status, 400,
      'el id NO es `porteria`: renombrarlo desconectaría el switch del contenedor go2rtc');
  });

  await t.test('la API nunca devuelve la URL RTSP entera', async () => {
    assert.ok(!String(dev.json.rtsp_url || '').includes('S3cr3ta'), 'el alta devolvió la clave de la cámara');
    const ficha = await api('GET', '/api/clients/' + cid, { token });
    assert.equal(ficha.status, 200);
    const d = ficha.json.devices.find((x) => x.id === did);
    assert.ok(!JSON.stringify(ficha.json).includes('S3cr3ta'), 'la ficha del cliente devolvió la clave de la cámara');
    assert.equal(d.rtsp_set, true, 'la pantalla necesita saber que ya hay una URL cargada');
    assert.ok(d.rtsp_url.includes('192.0.2.50'), 'se conserva el host para reconocer el aparato');
  });

  await t.test('editar la etiqueta con el campo de URL vacío NO borra la credencial', async () => {
    const r = await api('PUT', '/api/devices/' + did, { token, body: { label: 'Portón', rtsp_url: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.label, 'Portón');
    const { rows } = await ctx.db.query('SELECT rtsp_url FROM pbxng_client_devices WHERE id=$1', [did]);
    assert.equal(rows[0].rtsp_url, RTSP, 'guardar la etiqueta se llevó puesta la clave de la cámara');
  });

  await t.test('con Portería APAGADA el screen-pop sigue vivo y sólo se cae el video', async () => {
    assert.equal((await api('POST', '/api/clients/' + cid + '/persons', { token, body: { name: 'Flavio' } })).status, 201);
    assert.equal((await api('POST', '/api/modules', { token, body: { id: 'intercom', enabled: false } })).status, 200);

    const lk = await api('GET', '/api/clients/lookup?number=29001122', { token });
    assert.equal(lk.status, 200);
    assert.equal(lk.json.id, cid, 'el agente dejó de ver quién llama al apagar el video: esto rompe el call center');
    assert.equal(lk.json.name, 'Casa de prueba');
    assert.equal(lk.json.persons.length, 1, 'las personas autorizadas son CRM, no video');
    assert.deepEqual(lk.json.devices, [], 'sin go2rtc corriendo no se ofrecen canales que nunca van a cargar');

    // Y al volver a encenderlo, el canal vuelve.
    assert.equal((await api('POST', '/api/modules', { token, body: { id: 'intercom', enabled: true } })).status, 200);
    const lk2 = await api('GET', '/api/clients/lookup?number=29001122', { token });
    assert.equal(lk2.json.devices.length, 1);
    assert.ok(!JSON.stringify(lk2.json).includes('S3cr3ta'), 'el screen-pop del agente no lleva credenciales de cámara');
  });
});
