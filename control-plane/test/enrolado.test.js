/* ============================================================================
 *  Integración · enrolar un teléfono (auth.js): el QR de un solo uso, qué config le
 *  llega a cada aparato, el envío por correo y las credenciales propias.
 *
 *  El enlace de enrolado entrega la clave SIP en claro, así que lo que importa es que
 *  sirva UNA vez (con la ventana de gracia para el mismo aparato), que un token vencido
 *  o usado no la entregue, y que el transporte que se le dice al teléfono salga del
 *  endpoint real: decirle WebRTC a un interno SIP autentica y deja la llamada muda.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const { smtpFalso } = require('./helpers/smtp-falso');

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36',
  escritorioWin: 'Mozilla/5.0 (Windows NT 10.0) PBXNG-Desktop/0.18.0 Electron/30',
  escritorioMac: 'Mozilla/5.0 (Macintosh) Electron/30',
  escritorioLinux: 'Mozilla/5.0 (X11; Linux) Electron/30',
  edge: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36 Edg/120.0',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
  raro: 'curl/8.0',
};

test('enrolado: QR de un solo uso, transporte del endpoint real, correo y credenciales propias', async (t) => {
  const smtp = await smtpFalso();
  t.after(() => smtp.cerrar());
  const ctx = await entorno(t, { ENROLL_REUSE_SECONDS: '1' });
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login, base } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  const canjear = (token, ua) => fetch(base + '/api/enroll/' + token, { headers: { 'User-Agent': ua || UA.iphone } }).then(async (r) => ({ status: r.status, json: await r.json() }));

  await t.test('un interno nuevo nace WebRTC: el QR entrega wss, STUN y un token de softphone', async () => {
    assert.equal((await api('POST', '/api/enroll', { token: admin, body: {} })).status, 400);
    const e = await api('POST', '/api/enroll', { token: admin, body: { ext: '3101', label: 'Celular de Ana', video: true } });
    assert.equal(e.status, 200, JSON.stringify(e.json));
    await ctx.db.query("INSERT INTO pbxng_settings (key,value) VALUES ('domain','pbx.ejemplo.uy') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    const c = await canjear(e.json.token, UA.iphone);
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.prov.transport, 'webrtc');
    assert.equal(c.json.prov.wss, 'wss://pbx.ejemplo.uy/ws');
    assert.equal(c.json.prov.sipServer, '');
    assert.match(c.json.prov_url, /^pbxng:\/\/prov#[A-Za-z0-9_-]+$/);
    const tok = JSON.parse(Buffer.from(c.json.prov.apiToken.split('.')[1], 'base64').toString());
    assert.equal(tok.scope, 'phone', 'el QR no entrega una sesión de panel');
    assert.equal(tok.ext, '3101');
    /* Dentro de la ventana de gracia el mismo aparato lo puede volver a canjear. */
    assert.equal((await canjear(e.json.token, UA.iphone)).status, 200);
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal((await canjear(e.json.token)).status, 410, 'pasada la ventana, el QR ya usado no entrega la clave');
    const l = (await api('GET', '/api/enrollments', { token: admin })).json.find((x) => x.ext === '3101');
    assert.deepEqual([l.estado, l.device, l.platform], ['activado', 'iPhone', 'iOS']);
  });

  await t.test('un interno SIP existente: se reusa su clave y el teléfono recibe servidor, puerto y transporte', async () => {
    assert.equal((await api('POST', '/api/endpoints', { token: admin, body: { id: '3102', password: 'Clave-3102-xx' } })).status, 201);
    await ctx.db.query("INSERT INTO pbxng_settings (key,value) VALUES ('sip_host','sip.pbx.ejemplo.uy') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    const e = await api('POST', '/api/enroll', { token: admin, body: { ext: '3102' } });
    assert.equal(e.json.password, 'Clave-3102-xx', 'no se le cambia la clave a un interno que ya andaba');
    const c = await canjear(e.json.token, UA.android);
    assert.deepEqual([c.json.prov.transport, c.json.prov.sipServer, c.json.prov.sipPort, c.json.prov.sipTransport, c.json.prov.wss], ['sip', 'sip.pbx.ejemplo.uy', '5060', 'udp', '']);
    await ctx.db.query("UPDATE ps_endpoints SET transport='transport-tls', media_encryption='sdes' WHERE id='3102'");
    const e2 = await api('POST', '/api/enroll', { token: admin, body: { ext: '3102' } });
    const c2 = await canjear(e2.json.token, UA.escritorioWin);
    assert.deepEqual([c2.json.prov.sipTransport, c2.json.prov.sipPort, c2.json.prov.sipSrtp], ['tls', '5061', 'sdes']);
    await ctx.db.query("UPDATE ps_endpoints SET transport='transport-tcp', media_encryption='no' WHERE id='3102'");
    const e3 = await api('POST', '/api/enroll', { token: admin, body: { ext: '3102' } });
    assert.equal((await canjear(e3.json.token, UA.firefox)).json.prov.sipTransport, 'tcp');
  });

  await t.test('cada aparato se reconoce por su User-Agent', async () => {
    const esperado = { ipad: ['iPad', 'iOS'], escritorioMac: ['App de escritorio', 'macOS'], escritorioLinux: ['App de escritorio', 'Escritorio'], edge: ['Edge', 'Windows'], safariMac: ['Safari', 'macOS'], raro: ['Navegador', 'Desconocida'] };
    for (const [k, [device, platform]] of Object.entries(esperado)) {
      const e = await api('POST', '/api/enroll', { token: admin, body: { ext: '32' + Object.keys(esperado).indexOf(k) + '0' } });
      await canjear(e.json.token, UA[k]);
      const l = (await api('GET', '/api/enrollments', { token: admin })).json.find((x) => x.ext === e.json.ext);
      assert.deepEqual([l.device, l.platform], [device, platform], k);
    }
  });

  await t.test('token inexistente, vencido; y los estados pendiente y vencido', async () => {
    assert.equal((await canjear('no-existe')).status, 404);
    const e = await api('POST', '/api/enroll', { token: admin, body: { ext: '3103' } });
    let l = (await api('GET', '/api/enrollments', { token: admin })).json.find((x) => x.ext === '3103');
    assert.equal(l.estado, 'pendiente');
    await ctx.db.query("UPDATE pbxng_enroll SET expires_at = now() - interval '1 minute' WHERE token=$1", [e.json.token]);
    assert.equal((await canjear(e.json.token)).status, 410);
    l = (await api('GET', '/api/enrollments', { token: admin })).json.find((x) => x.ext === '3103');
    assert.equal(l.estado, 'vencido');
  });

  await t.test('enviar el acceso por correo: sin SMTP, sin dominio, y el que llega con el QR adjunto', async () => {
    assert.equal((await api('POST', '/api/enroll/email', { token: admin, body: { ext: '3104' } })).status, 400);
    const sin = await api('POST', '/api/enroll/email', { token: admin, body: { ext: '3104', to: 'ana@x.uy' } });
    assert.match(sin.json.error, /Configurá y activá el email/);
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: smtp.host, port: smtp.port, from_addr: 'central@ejemplo.uy', enabled: true } });
    await ctx.db.query("DELETE FROM pbxng_settings WHERE key='domain'");
    assert.match((await api('POST', '/api/enroll/email', { token: admin, body: { ext: '3104', to: 'ana@x.uy' } })).json.error, /Falta el dominio/);
    await ctx.db.query("INSERT INTO pbxng_settings (key,value) VALUES ('domain','pbx.ejemplo.uy')");
    smtp.olvidar();
    const ok = await api('POST', '/api/enroll/email', { token: admin, body: { ext: '3104', to: 'ana@x.uy' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const [m] = await smtp.esperar(1);
    assert.deepEqual(m.to, ['ana@x.uy']);
    assert.match(m.data, /acceso-qr\.png/);
    smtp.rechazar();
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: smtp.host, port: smtp.port, username: 'u', password: 'p', from_addr: 'c@x.uy', enabled: true } });
    const mal = await api('POST', '/api/enroll/email', { token: admin, body: { ext: '3104', to: 'ana@x.uy' } });
    assert.equal(mal.status, 500);
    assert.match(mal.json.error, /Contraseña de aplicación/);
  });

  await t.test('credenciales propias: la sesión y la clave SIP del propio interno', async () => {
    await api('POST', '/api/users', { token: admin, body: { username: 'ana', password: 'Clave-ana-1234', role: 'agente', ext: '3102', name: 'Ana' } });
    await api('POST', '/api/users', { token: admin, body: { username: 'beto', password: 'Clave-beto-123', role: 'agente', ext: '3999' } });
    const ana = (await login('ana', 'Clave-ana-1234')).token, beto = (await login('beto', 'Clave-beto-123')).token;
    assert.deepEqual((await api('GET', '/api/auth/me', { token: ana })).json.user, { username: 'ana', name: 'Ana', role: 'agente', ext: '3102' });
    assert.deepEqual((await api('GET', '/api/me/sipcreds', { token: ana })).json, { ext: '3102', password: 'Clave-3102-xx' });
    assert.equal((await api('GET', '/api/me/sipcreds', { token: admin })).status, 400, 'sin interno asignado');
    assert.equal((await api('GET', '/api/me/sipcreds', { token: beto })).status, 404, 'un interno que no existe');
    const p = await api('POST', '/api/phone/token', { body: { ext: '3102', password: 'Clave-3102-xx' } });
    assert.equal(p.status, 200);
    assert.equal((await api('POST', '/api/phone/token', { body: { ext: '3102', password: 'mal' } })).status, 401);
    assert.equal((await api('POST', '/api/phone/token', { body: {} })).status, 400);
    /* Aprovisionar a mano: sólo admin y supervisor. */
    assert.equal((await api('GET', '/api/provision?ext=3102', { token: ana })).status, 403);
    assert.equal((await api('GET', '/api/provision', { token: admin })).status, 400);
    assert.equal((await api('GET', '/api/provision?ext=9999', { token: admin })).status, 404);
    const pr = await api('GET', '/api/provision?ext=3102', { token: admin });
    assert.equal(pr.status, 200, JSON.stringify(pr.json));
  });
});
