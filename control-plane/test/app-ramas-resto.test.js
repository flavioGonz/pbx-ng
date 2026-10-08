/* ============================================================================
 *  Integración · los últimos desvíos de app.js que se pueden ejercer sin red de afuera.
 *
 *  Un cuerpo que no es JSON o viene en un charset que nadie habla, la subida del
 *  instalador cuando el directorio del softphone no existe, el teléfono que se da de
 *  alta sin clave (y hereda la del interno), el NPM que contesta HTML en vez de JSON,
 *  ACME configurado por DNS, el Telegram sin chat, el gateway de WhatsApp sin clave, el
 *  video del portero pedido por WebSocket con una entrada de un solo uso, un relé por
 *  código cuando Asterisk rechaza la llamada. Cada caso fija la respuesta que ve el panel,
 *  el teléfono o el visitante: casi todos son mensajes de error que, si no se prueban,
 *  nadie sabe si dicen algo útil.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');
const { entorno, puertoLibre } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { httpFalso, crudo } = require('./helpers/http-falso');


/* Abre un WebSocket y devuelve cómo terminó: 'abierto' o el status HTTP del rechazo. */
function intentarWs(url) {
  return new Promise((ok) => {
    const ws = new WebSocket(url);
    const fin = (v) => { try { ws.terminate(); } catch (_) {} ok(v); };
    ws.on('open', () => fin('abierto'));
    ws.on('unexpected-response', (_q, r) => fin(r.statusCode));
    ws.on('error', (e) => fin('error: ' + e.message));
    setTimeout(() => fin('sin respuesta'), 4000);
  });
}

test('lo que queda de app.js: cuerpos ilegibles, subidas, teléfonos, NPM, ACME, integraciones y video', async (t) => {
  const ami = await amiFalso();
  const f = await httpFalso();
  const g2 = await httpFalso();
  const sinDir = path.join(os.tmpdir(), 'pbxng-softphone-que-no-existe-' + process.pid);
  const ctx = await entorno(t, Object.assign({}, ami.env, { SOFTPHONE_DIR: sinDir, DOMAIN: 'pbx.ejemplo.uy', GO2RTC_URL: g2.url, GO2RTC_MGMT: g2.url }));
  t.after(async () => { if (ctx) await ctx.cerrar(); await ami.cerrar(); await f.cerrar(); await g2.cerrar(); });
  if (!ctx) return;
  const { api, login, base } = ctx.api;
  const db = ctx.db;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  const crudoHttp = (ruta, opt) => fetch(base + ruta, Object.assign({ method: 'POST' }, opt, { headers: Object.assign({ Authorization: 'Bearer ' + admin }, (opt && opt.headers) || {}) }));

  await t.test('un cuerpo que no es JSON o en un charset desconocido contesta JSON, no HTML', async () => {
    const malo = await crudoHttp('/api/settings', { headers: { 'Content-Type': 'application/json' }, body: '{"a":' });
    assert.equal(malo.status, 400);
    assert.equal((await malo.json()).error, 'El cuerpo del pedido no es JSON válido.');
    const charset = await crudoHttp('/api/settings', { headers: { 'Content-Type': 'application/json; charset=klingon' }, body: '{}' });
    assert.equal(charset.status, 415);
    assert.ok((await charset.json()).error, 'otro error del parser sigue al manejador final, también en JSON');
    const enorme = await crudoHttp('/api/settings', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(5 * 1024 * 1024) }) });
    assert.equal(enorme.status, 413);
    assert.match((await enorme.json()).error, /demasiado grande/);
  });

  await t.test('softphone: la configuración del OTA con valores raros y la subida sin directorio', async () => {
    const c = await api('POST', '/api/softphone/ota/config', { token: admin, body: { auto: true, cada_h: 'cada tanto' } });
    assert.deepEqual([c.json.auto, c.json.cada_h], [true, 6], 'un intervalo ilegible vuelve a 6 h');
    await api('POST', '/api/softphone/ota/config', { token: admin, body: { auto: false } });
    const sinNombre = await api('POST', '/api/softphone/ota/subir', { token: admin, body: { archivos: [null] } });
    assert.equal(sinNombre.status, 400);
    assert.match(sinNombre.json.error, /no permitido/);
    const sub = await api('POST', '/api/softphone/ota/subir', { token: admin, body: { archivos: [{ name: 'latest.yml' }] } });
    assert.equal(sub.status, 500, 'sin el directorio del softphone no se puede escribir');
    assert.ok(sub.json.error);
    assert.equal(fs.existsSync(sinDir), false);
  });

  await t.test('pausa del agente: si todas sus colas están en pausa, figura pausado', async () => {
    await api('POST', '/api/endpoints', { token: admin, body: { id: '2001', password: 'Clave-2001-xx' } });
    await api('POST', '/api/users', { token: admin, body: { username: 'ana', password: 'Clave-ana-1234', role: 'agente', ext: '2001' } });
    const ana = (await login('ana', 'Clave-ana-1234')).token;
    assert.deepEqual((await api('GET', '/api/agent/state', { token: ana })).json, { ext: '2001', paused: false, inQueue: false, queues: [] }, 'sin colas no hay pausa que mostrar');
    await db.query("INSERT INTO queue_members (queue_name, interface, membername, paused, uniqueid) VALUES ('ventas','PJSIP/2001','2001',1,9001),('soporte','PJSIP/2001','2001',1,9002)");
    const s = (await api('GET', '/api/agent/state', { token: ana })).json;
    assert.deepEqual([s.paused, s.inQueue, s.queues.sort()], [true, true, ['soporte', 'ventas']]);
    await db.query("UPDATE queue_members SET paused=0 WHERE queue_name='soporte'");
    assert.equal((await api('GET', '/api/agent/state', { token: ana })).json.paused, false, 'con una cola activa no está en pausa');
  });

  await t.test('teléfonos: alta sin clave hereda la del interno, o se inventa una; valores por defecto', async () => {
    const a = await api('POST', '/api/phones', { token: admin, body: { mac: '00-15-65-11-22-33', ext: '2001' } });
    assert.equal(a.status, 201);
    const fila = (await db.query("SELECT vendor, model, password, label FROM pbxng_phones WHERE mac='001565112233'")).rows[0];
    assert.deepEqual([fila.vendor, fila.model, fila.password, fila.label], ['yealink', null, 'Clave-2001-xx', null], 'hereda la clave SIP del interno');
    const b = await api('POST', '/api/phones', { token: admin, body: { mac: '000b82445566', ext: '2077', vendor: 'grandstream', label: 'Hall', tenant_id: 1 } });
    assert.equal(b.status, 201);
    assert.match((await db.query("SELECT password FROM pbxng_phones WHERE mac='000b82445566'")).rows[0].password, /^Tel[0-9a-f]{8}#\d{2}$/, 'sin interno previo se genera una clave');
    await api('PUT', '/api/phones/' + b.json.id, { token: admin, body: { ext: '2077' } });
    assert.equal((await db.query('SELECT vendor FROM pbxng_phones WHERE id=$1', [b.json.id])).rows[0].vendor, 'yealink', 'editar sin marca la vuelve a la de por defecto');
    await db.query("INSERT INTO pbxng_phones (mac, vendor, ext, label, password) VALUES ('001565778899','yealink','2001','Sólo etiqueta','x')");
    const y = await (await fetch(base + '/prov/001565778899.cfg')).text();
    assert.match(y, /account\.1\.label = Sólo etiqueta/, 'sin nombre de línea se usa la etiqueta');
    assert.match(y, /remote_phonebook\.data\.1\.url = http:\/\/127\.0\.0\.1:\d+\/prov\/agenda-yealink\.xml/, 'sin proxy, la URL es la del pedido');
    await db.query("INSERT INTO pbxng_phones (mac, vendor, ext, password) VALUES ('001565000001','yealink','2001','x')");
    assert.match(await (await fetch(base + '/prov/001565000001.cfg')).text(), /account\.1\.label = 2001\n/, 'sin etiqueta ni línea, el interno');
    const roto = await api('POST', '/api/phones', { token: admin, body: { mac: '001565000002', ext: '2088', tenant_id: 'uno' } });
    assert.equal(roto.status, 400, 'una empresa ilegible se rechaza y no deja el interno a medio crear');
    assert.equal((await db.query("SELECT count(*)::int n FROM ps_endpoints WHERE id='2088'")).rows[0].n, 0, 'la transacción se deshizo');
    const malEp = await api('PUT', '/api/endpoints/2001', { token: admin, body: { max_contacts: 'muchos', name: 'No se guarda' } });
    assert.equal(malEp.status, 400);
    assert.equal((await db.query("SELECT count(*)::int n FROM pbxng_directory WHERE name='No se guarda'")).rows[0].n, 0, 'nada a medias');
    assert.equal((await api('POST', '/api/push/test', { token: admin, body: {} })).status, 403, 'una prueba de push sin interno no se manda a nadie');
    assert.equal((await api('POST', '/api/phones', { token: admin, body: { mac: 'zz', ext: '1' } })).status, 400);
    assert.equal((await api('POST', '/api/phones', { token: admin, body: { mac: '001565aabbcc' } })).status, 400);
    const g = await api('POST', '/api/geo/report', { body: { lat: 1, lng: 2, number: '099123', dir: 'out', accuracy: 'x' } });
    assert.equal(g.json.ok, true);
    const geo = (await db.query("SELECT ext, number, dir, accuracy FROM pbxng_call_geo WHERE number='099123'")).rows[0];
    assert.deepEqual([geo.ext, geo.dir, geo.accuracy], [null, 'out', null]);
  });

  await t.test('NPM: certificado sin vencimiento, respuesta que no es JSON, y el esquema del proxy host', async () => {
    const set = (k, v) => db.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, v]);
    await set('npm_url', f.url); await set('npm_identity', 'yo'); await set('npm_secret', 's'); await set('domain', 'pbx.ejemplo.uy');
    f.ruta('POST', '/api/tokens', { token: 'tk' });
    f.ruta('GET', '/api/nginx/certificates', [{ domain_names: ['pbx.ejemplo.uy'], provider: 'other' }]);
    await api('POST', '/api/npm/test', { token: admin });
    const c = (await api('GET', '/api/npm/cert', { token: admin })).json;
    assert.deepEqual([c.provider, c.expires_date, c.days_left], ['other', null, null], 'un certificado sin fecha no inventa un vencimiento');
    await api('POST', '/api/npm/test', { token: admin });
    f.ruta('GET', '/api/nginx/certificates', crudo(502, '<html>Bad Gateway</html>'));
    const html = await api('GET', '/api/npm/cert', { token: admin });
    assert.equal(html.status, 500, 'un HTML del proxy es un error, no un certificado');
    f.ruta('GET', '/api/nginx/proxy-hosts', [{ id: 3, domain_names: ['pbx.ejemplo.uy'], forward_scheme: 'https', forward_host: 'api', forward_port: 443, certificate_id: 9, ssl_forced: 1, enabled: 1, allow_websocket_upgrade: 1 }]);
    const h = (await api('GET', '/api/npm/hosts', { token: admin })).json.host;
    assert.deepEqual([h.forward, h.ssl, h.ssl_forced, h.enabled, h.ws], ['https://api:443', true, true, true, true]);
  });

  await t.test('ACME: configurar por DNS, dejar campos vacíos, y leer el estado', async () => {
    const r = await api('POST', '/api/acme/config', { token: admin, body: { domain: null, email: null, method: 'dns', dns_provider: null, dns_creds: { CF_Token: 'secreto' } } });
    assert.equal(r.json.ok, true);
    assert.deepEqual([r.json.config.domain, r.json.config.email, r.json.config.method], ['', '', 'dns']);
    assert.equal(JSON.stringify(r.json).includes('secreto'), false, 'la credencial del DNS no vuelve');
    assert.equal((await api('POST', '/api/acme/config', { token: admin, body: {} })).json.config.method, 'dns', 'un cuerpo vacío no cambia nada');
    const g = await api('GET', '/api/acme', { token: admin });
    assert.ok(g.json.config && 'cert' in g.json);
  });

  await t.test('integraciones: Telegram con token y sin chat, WhatsApp sin clave del gateway; ajustes con un secreto vacío', async () => {
    await api('PUT', '/api/integrations/telegram', { token: admin, body: { token: '123:abc' } });
    const tg = await api('POST', '/api/integrations/telegram/test', { token: admin });
    assert.match(tg.json.error, /falta token o chat_id/, 'sin chat no se sale a Telegram');
    await api('PUT', '/api/integrations/whatsapp', { token: admin, body: { url: f.url, to: '598' } });
    f.ruta('POST', '/sendText', { ok: true });
    assert.equal((await api('POST', '/api/integrations/whatsapp/test', { token: admin })).json.ok, true);
    assert.equal(f.pedidos('/sendText').at(-1).headers.api_key, undefined, 'sin clave no se manda la cabecera');
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('openai_api_key','') ON CONFLICT (key) DO UPDATE SET value=''");
    assert.equal((await api('GET', '/api/settings', { token: admin })).json.openai_api_key, '', 'un secreto vacío se muestra vacío, no como cargado');
  });

  await t.test('correo con el puerto sin guardar usa el 587; restaurar con partes que no son lista', async () => {
    await db.query("INSERT INTO pbxng_email_config (tenant_id, host, port, enabled) VALUES (1, '127.0.0.1', NULL, true) ON CONFLICT (tenant_id) DO UPDATE SET host='127.0.0.1', port=NULL");
    const m = await api('POST', '/api/email/test', { token: admin, body: { to: 'a@b.uy' }, timeout: 30000 });
    assert.equal(m.status, 500);
    assert.ok(m.json.error);
    const r = await api('POST', '/api/backup/x.tar.gz/restaurar', { token: admin, body: { partes: 'config' } });
    assert.equal(r.status, 400);
  });

  await t.test('video del portero por WebSocket: entrada de un solo uso, de otro canal o inventada', async () => {
    const cli = (await api('POST', '/api/clients', { token: admin, body: { name: 'Edificio' } })).json;
    g2.ruta('PUT', '/api/streams', {});
    await api('POST', '/api/clients/' + cli.id + '/devices', { token: admin, body: { label: 'Cam', go2rtc_src: 'cam_a', rtsp_url: 'rtsp://10.0.0.1/a' } });
    await api('POST', '/api/clients/' + cli.id + '/devices', { token: admin, body: { label: 'Cam B', go2rtc_src: 'cam_b' } });
    const ticket = async (src) => (await api('GET', '/api/intercom/ticket?src=' + src, { token: admin })).json.ticket;
    const ws = (q) => intentarWs(base.replace(/^http/, 'ws') + '/api/intercom/g2/api/ws?' + q);
    const t1 = await ticket('cam_a');
    assert.equal(await ws('src=cam_b&t=' + t1), 401, 'una entrada de un canal no abre otro');
    assert.equal(await ws('src=cam_a&t=' + t1), 401, 'y queda quemada aunque no se haya usado bien');
    assert.equal(await ws('src=cam_a&t=inventada'), 401);
    assert.equal(await ws('src=cam_a&token=no-es-un-jwt'), 401, 'un token ilegible no entra');
    const t0 = await ticket('cam_a');
    assert.notEqual(await ws('t=' + t0), 401, 'una entrada sin canal en el pedido se acepta (go2rtc decide qué sirve)');
    const t2 = await ticket('cam_a');
    assert.notEqual(await ws('src=cam_a&t=' + t2), 401, 'la entrada buena deja pasar');
    assert.notEqual(await ws('src=cam_b&t=' + (await ticket('cam_b')) + '&x=1'), 401);
  });

  await t.test('portero: probar con pistas sin códec reconocible, digest sin desafío y relé por código que Asterisk rechaza', async () => {
    const cli = (await api('GET', '/api/clients', { token: admin })).json[0];
    const d = (await api('POST', '/api/clients/' + cli.id + '/devices', { token: admin, body: { label: 'Prueba', rtsp_url: 'rtsp://10.0.0.2/b', rele_modo: 'codigo', rele_cfg: { reles: [{ codigo: '*9' }] } } })).json;
    g2.ruta('GET', '/api/probe', { producers: [{ medias: ['!!!'] }] });
    assert.deepEqual((await api('POST', '/api/devices/' + d.id + '/test', { token: admin })).json, { ok: true, motivo: '', pistas: 1, codecs: [] });
    ami.accion('Originate', { Response: 'Error', Message: 'Extension does not exist' });
    const r = await api('POST', '/api/devices/' + d.id + '/rele', { token: admin, body: {} });
    assert.equal(r.status, 502, 'si Asterisk no marca el código, es un 502 con su motivo');
    assert.ok(r.json.error);
    ami.accion('Originate', { Response: 'Success' });
    await api('PUT', '/api/devices/' + d.id, { token: admin, body: { rele_modo: 'http', rele_cfg: { host: '127.0.0.1:' + f.port, marca: 'hikvision', reles: [{ num: 4 }] } } });
    f.ruta('PUT', '/ISAPI/AccessControl/RemoteControl/door/4', crudo(401, 'sin desafío'));
    const sinDesafio = await api('POST', '/api/devices/' + d.id + '/rele', { token: admin, body: {} });
    assert.equal(sinDesafio.status, 502);
    assert.match(sinDesafio.json.error, /contestó HTTP 401/);
    assert.equal(f.pedidos('/ISAPI/AccessControl/RemoteControl/door/4').length, 2, 'un 401 sin desafío se reintenta firmado una vez y se da por perdido');
  });

  await t.test('wake del dialplan con nombre y sin número: el aviso no queda con paréntesis vacíos rotos', async () => {
    const tok = fs.readFileSync(path.join(ctx.api.confDir, 'agent.token'), 'utf8').trim();
    assert.equal((await fetch(base + '/api/internal/wake?ext=2001&name=Juana&tok=' + tok)).status, 200);
    assert.equal((await fetch(base + '/api/internal/wake?ext=2001&name=Juana&tok=' + tok)).status, 200, 'el repetido dentro de los 6 s se descarta sin error');
  });

  await t.test('probar un agente: dos clics seguidos abren UNA sesión; si el modelo no contesta, falla en el paso sesión', async () => {
    const cerrado = await puertoLibre();
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('openai_api_key','sk-prueba'),('realtime_url',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", ['ws://127.0.0.1:' + cerrado]);
    const body = { model: 'gpt-realtime-2.1' };
    const [a, b] = await Promise.all([api('POST', '/api/ai-agents/probar', { token: admin, body, timeout: 30000 }), api('POST', '/api/ai-agents/probar', { token: admin, body, timeout: 30000 })]);
    const [ok, otro] = a.status === 409 ? [b, a] : [a, b];
    assert.equal(otro.status, 409, 'el segundo clic no abre otra sesión paga');
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.ok, ok.json.paso, ok.json.endpoint], [false, 'sesion', 'ws://127.0.0.1:' + cerrado]);
    assert.equal(JSON.stringify(ok.json).includes('sk-prueba'), false);
    await db.query("UPDATE pbxng_settings SET value='' WHERE key IN ('openai_api_key','realtime_url')");
  });

  await t.test('click-to-call de un enlace sin empresa: el invitado nace en la empresa 1', async () => {
    const l = (await api('POST', '/api/c2c', { token: admin, body: { name: 'Sin empresa', dest_value: '2001' } })).json;
    await db.query('UPDATE pbxng_click2call SET tenant_id=NULL WHERE id=$1', [l.id]).catch(() => {});
    const s = await api('POST', '/api/c2c/public/' + l.token + '/session', { body: { name: 'Pepe', geo: { lat: 1 } } });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal((await db.query('SELECT tenant_id FROM ps_endpoints WHERE id=$1', [s.json.ext])).rows[0].tenant_id, 1);
  });

  await t.test('un portero que acepta la conexión y no contesta: a los 8 s se corta y se dice cuál', async () => {
    const mudo = net.createServer(() => {});   // acepta y se queda callado
    await new Promise((ok) => mudo.listen(0, '127.0.0.1', ok));
    try {
      const cli = (await api('GET', '/api/clients', { token: admin })).json[0];
      const host = '127.0.0.1:' + mudo.address().port;
      const d = (await api('POST', '/api/clients/' + cli.id + '/devices', { token: admin, body: { label: 'Mudo', rele_modo: 'http', rele_cfg: { host, reles: [{ num: 1 }] } } })).json;
      const t0 = Date.now();
      const r = await api('POST', '/api/devices/' + d.id + '/rele', { token: admin, body: {}, timeout: 20000 });
      assert.equal(r.status, 502);
      assert.equal(r.json.error, 'el portero ' + host + ' no contestó a tiempo');
      assert.ok(Date.now() - t0 >= 7500, 'se cortó antes del tope');
    } finally { mudo.close(); }
  });
});
