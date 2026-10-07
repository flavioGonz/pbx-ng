/* ============================================================================
 *  Push nativo (push-providers.js): FCM para Android y APNs VoIP para iPhone.
 *
 *  Sin credenciales no se manda nada. Con credenciales: FCM firma un JWT con la cuenta de
 *  servicio, lo canjea y manda un mensaje por aparato; un token que Google da por muerto
 *  se borra. APNs firma con la clave .p8 y habla HTTP/2; un 410 borra el aparato. Los
 *  aparatos salen de la tabla y también del Contact registrado (RFC 8599, pn-*).
 *
 *  Google se intercepta en fetch; Apple es un servidor HTTP/2 local.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http2 = require('http2');
const push = require('../push-providers');

function poolFalso({ ajustes = {}, aparatos = [], contactos = [] } = {}) {
  const p = { ajustes, aparatos, contactos, borrados: [], insertados: [] };
  p.query = async (sql, args) => {
    if (/FROM pbxng_settings/.test(sql)) return { rows: ajustes[args[0]] ? [{ value: ajustes[args[0]] }] : [] };
    if (/FROM pbxng_push_devices WHERE ext/.test(sql)) return { rows: aparatos.filter((a) => a.ext === args[0]) };
    if (/FROM ps_contacts/.test(sql)) { if (p.contactosRotos) throw new Error('x'); return { rows: contactos }; }
    if (/DELETE FROM pbxng_push_devices/.test(sql)) { p.borrados.push(args[0]); return { rowCount: 1 }; }
    if (/INSERT INTO pbxng_push_devices/.test(sql)) { p.insertados.push(args); return { rowCount: 1 }; }
    if (/ORDER BY updated_at/.test(sql)) return { rows: [{ id: 1 }] };
    throw new Error('consulta inesperada: ' + sql);
  };
  return p;
}

test('sin credenciales no se manda nada, y el estado de los proveedores lo dice', async () => {
  const pool = poolFalso({ aparatos: [{ id: 1, ext: '2001', provider: 'fcm', prid: 'a' }, { id: 2, ext: '2001', provider: 'apns', prid: 'b' }] });
  push.init(pool);
  assert.deepEqual(await push.providerStatus(), { fcm: false, apns: false });
  assert.equal(await push.sendNative('2001', { title: 'x' }), 0);
  pool.ajustes.fcm_service_account = '{roto';
  assert.equal(await push.sendNative('2001', {}), 0, 'una cuenta de servicio que no es JSON no rompe');
  /* La base que se cae al buscar aparatos. */
  push.init({ query: async () => { throw new Error('base caída'); } });
  assert.equal(await push.sendNative('2001', {}), 0);
  assert.deepEqual(await push.providerStatus(), { fcm: false, apns: false });
});

test('alta y listado de aparatos', async () => {
  const pool = poolFalso();
  push.init(pool);
  await assert.rejects(push.registerDevice('2001', 'fcm', ''), /faltan datos/);
  await push.registerDevice('2001', 'fcm', 'tok-1');
  assert.deepEqual(pool.insertados[0], ['2001', 'fcm', 'tok-1', null, null, null]);
  assert.deepEqual(await push.listDevices(), [{ id: 1 }]);
});

test('FCM: canjea el JWT, manda uno por aparato y borra el que Google da por muerto', async (t) => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const sa = { client_email: 'pbx@proyecto.iam.gserviceaccount.com', private_key: privateKey, project_id: 'proyecto' };
  const pool = poolFalso({
    ajustes: { fcm_service_account: JSON.stringify(sa) },
    aparatos: [{ id: 1, ext: '2001', provider: 'fcm', prid: 'vivo' }, { id: 2, ext: '2001', provider: 'fcm', prid: 'muerto' }, { id: 3, ext: '2001', provider: 'fcm', prid: 'red' }],
    contactos: [
      { uri: 'sip:2001@1.2.3.4;pn-provider=fcm;pn-prid=desde%2Dcontact;pn-param=x' },
      { uri: 'sip:2001@1.2.3.4' },
      { uri: 'sip:2001@1.2.3.4;pn-provider=otro;pn-prid=z' },
    ],
  });
  push.init(pool);
  const pedidos = [];
  let tokenMalo = true;
  t.mock.method(globalThis, 'fetch', async (url, o) => {
    pedidos.push({ url, o });
    if (url === 'https://oauth2.googleapis.com/token') {
      if (tokenMalo) return Response.json({ error: 'invalid_grant' });
      const jwt = new URLSearchParams(o.body).get('assertion');
      const [h, c] = jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url')));
      assert.equal(h.alg, 'RS256');
      assert.equal(c.iss, sa.client_email);
      return Response.json({ access_token: 'ya29.x', expires_in: 3600 });
    }
    const msg = JSON.parse(o.body).message;
    if (msg.token === 'muerto') return new Response('{"error":{"status":"UNREGISTERED"}}', { status: 404 });
    if (msg.token === 'red') throw new Error('sin red');
    assert.equal(o.headers.Authorization, 'Bearer ya29.x');
    assert.equal(msg.data.title, 'Llamada entrante');
    return Response.json({ name: 'ok' });
  });
  assert.equal(await push.sendNative('2001', { from: '099' }), 0, 'sin token de Google no se manda');
  tokenMalo = false;
  assert.equal(await push.sendNative('2001', { from: '099' }), 2, 'el vivo y el que vino en el Contact');
  assert.deepEqual(pool.borrados, [2]);
  assert.ok(pedidos.some((p) => /projects\/proyecto\/messages:send/.test(p.url)));
  /* El token de Google se reusa mientras no vence. */
  const antes = pedidos.filter((p) => /oauth2/.test(p.url)).length;
  await push.sendNative('2001', {});
  assert.equal(pedidos.filter((p) => /oauth2/.test(p.url)).length, antes);
  assert.deepEqual(await push.providerStatus(), { fcm: true, apns: false });
});

test('APNs: firma con la .p8, habla HTTP/2 con Apple y un 410 borra el aparato', async (t) => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const llegados = [];
  const srv = http2.createServer();
  srv.on('stream', (st, h) => {
    llegados.push(h);
    st.on('data', () => {});
    st.on('end', () => { st.respond({ ':status': h[':path'].endsWith('/viejo') ? 410 : 200 }); st.end(); });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => srv.close(ok)));
  const destinos = [];
  const original = http2.connect;
  t.mock.method(http2, 'connect', (host) => { destinos.push(host); return original('http://127.0.0.1:' + srv.address().port); });

  const pool = poolFalso({
    ajustes: { apns_key_p8: privateKey, apns_key_id: 'KID1', apns_team_id: 'TEAM1', apns_topic: 'uy.pbx.voip' },
    aparatos: [{ id: 7, ext: '2002', provider: 'apns', prid: 'nuevo' }, { id: 8, ext: '2002', provider: 'apns', prid: 'viejo', topic: 'otro.topic' }],
    contactos: [{ uri: 'sip:2002@x;pn-provider=apns;pn-prid=c1' }],
  });
  push.init(pool);
  assert.equal(await push.sendNative('2002', { title: 'Portero', from: '099' }), 2);
  assert.deepEqual(pool.borrados, [8]);
  assert.equal(destinos[0], 'https://api.sandbox.push.apple.com');
  const h = llegados.find((x) => x[':path'] === '/3/device/nuevo');
  assert.equal(h['apns-topic'], 'uy.pbx.voip');
  assert.equal(h['apns-push-type'], 'voip');
  assert.equal(llegados.find((x) => x[':path'] === '/3/device/viejo')['apns-topic'], 'otro.topic');
  const jwt = h.authorization.replace(/^bearer /, '');
  const [cab, cuerpo] = jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url')));
  assert.deepEqual([cab.alg, cab.kid, cuerpo.iss], ['ES256', 'KID1', 'TEAM1']);
  pool.ajustes.apns_prod = '1';
  await push.sendNative('2002', {});
  assert.equal(destinos.at(-1), 'https://api.push.apple.com');
  assert.equal(llegados.at(-1).authorization, h.authorization, 'el JWT de Apple se reusa');
  /* Si conectar revienta, ese aparato no cuenta y se sigue. */
  http2.connect.mock.mockImplementation(() => { throw new Error('sin red'); });
  assert.equal(await push.sendNative('2002', {}), 0);
  /* Los contactos que no se pueden leer no rompen el envío. */
  pool.contactosRotos = true;
  http2.connect.mock.restore();
  t.mock.method(http2, 'connect', () => original('http://127.0.0.1:' + srv.address().port));
  assert.equal(await push.sendNative('2002', {}), 1);
});
