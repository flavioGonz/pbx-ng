/* ============================================================================
 *  Integración · los ajustes de la central en app.js: marca, alertas, correo,
 *  integraciones, audios, click-to-call, aprovisionamiento de teléfonos, push, voz,
 *  proxy inverso, manuales, respaldos e internos.
 *
 *  Los servicios externos son de mentira y viven en este proceso: un SMTP
 *  (helpers/smtp-falso.js), un HTTP que hace de servicio de voz, de proxy inverso y
 *  de gateway de WhatsApp (helpers/http-falso.js), y un AMI (helpers/ami-falso.js).
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { httpFalso, crudo } = require('./helpers/http-falso');
const { smtpFalso } = require('./helpers/smtp-falso');

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(300, 1)]);

test('ajustes: marca, correo, integraciones, audios, c2c, teléfonos, voz, proxy, manuales y respaldos', async (t) => {
  const ami = await amiFalso();
  const svc = await httpFalso();
  const smtp = await smtpFalso();
  const SOFT = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-soft-'));
  t.after(async () => { await ami.cerrar(); await svc.cerrar(); await smtp.cerrar(); fs.rmSync(SOFT, { recursive: true, force: true }); });
  const ctx = await entorno(t, Object.assign({}, ami.env, { SOFTPHONE_DIR: SOFT, TURN_AGENT: svc.url }));
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login, base } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  const ajuste = (k, v) => ctx.db.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, v]);

  await t.test('marca: los valores por defecto, guardar y leer; es pública', async () => {
    const d = await api('GET', '/api/branding');
    assert.equal(d.status, 200);
    assert.equal(d.json.name, 'PBX-NG');
    assert.equal(d.json.callcenter, true);
    assert.equal((await api('POST', '/api/branding', { token: admin, body: { name: 'Portería Sur', subtitle: 'Central', logo: 'data:x' } })).json.ok, true);
    const r = await api('GET', '/api/branding');
    assert.equal(r.json.name, 'Portería Sur');
    assert.equal(r.json.logo, 'data:x');
  });

  await t.test('ajustes generales: los secretos se tapan al leer y `__SET__` no pisa lo guardado', async () => {
    await api('POST', '/api/settings', { token: admin, body: { openai_api_key: 'sk-secreto', domain: 'pbx.ejemplo.uy', vacio: null } });
    const s = (await api('GET', '/api/settings', { token: admin })).json;
    assert.equal(s.openai_api_key, '__SET__');
    assert.equal(s.domain, 'pbx.ejemplo.uy');
    assert.equal(s.vacio, '');
    await api('POST', '/api/settings', { token: admin, body: { openai_api_key: '__SET__' } });
    const { rows } = await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='openai_api_key'");
    assert.equal(rows[0].value, 'sk-secreto');
  });

  await t.test('correo: configurar por empresa, probar contra el SMTP y explicar el rechazo de clave', async () => {
    assert.equal((await api('POST', '/api/email/config', { token: admin, body: {} })).status, 400);
    assert.equal((await api('POST', '/api/email/test', { token: admin, body: {} })).status, 400);
    const sinCfg = await api('POST', '/api/email/test', { token: admin, body: { to: 'a@b.uy' } });
    assert.match(sinCfg.json.error, /sin configuración SMTP/);
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: smtp.host, port: smtp.port, secure: false, username: 'central', password: 'clave', from_addr: 'central@ejemplo.uy', enabled: true } });
    const cfg = (await api('GET', '/api/email/config', { token: admin })).json[0];
    assert.equal(cfg.has_password, true);
    assert.equal(cfg.password, undefined, 'la clave del SMTP no sale nunca');
    /* Guardar sin clave no borra la que había. */
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: smtp.host, port: smtp.port, username: 'central', from_addr: 'central@ejemplo.uy', enabled: true } });
    assert.equal((await api('GET', '/api/email/config', { token: admin })).json[0].has_password, true);

    smtp.olvidar();
    const ok = await api('POST', '/api/email/test', { token: admin, body: { to: 'destino@ejemplo.uy' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const [m] = await smtp.esperar(1);
    assert.deepEqual(m.to, ['destino@ejemplo.uy']);
    assert.match(m.data, /Prueba_de_correo/, 'el asunto viaja codificado en UTF-8');

    smtp.rechazar();
    const mal = await api('POST', '/api/email/test', { token: admin, body: { to: 'destino@ejemplo.uy' } });
    assert.equal(mal.status, 500);
    assert.match(mal.json.error, /Contraseña de aplicación/);

    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: '127.0.0.1', port: 1, enabled: true } });
    const caido = await api('POST', '/api/email/test', { token: admin, body: { to: 'x@y.uy' } });
    assert.match(caido.json.error, /No se pudo conectar al servidor SMTP/);
    /* Lo deja andando para las alertas. */
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: smtp.host, port: smtp.port, username: 'central', password: 'clave', from_addr: 'central@ejemplo.uy', enabled: true } });
  });

  await t.test('alertas: reglas, destinatario por defecto, historial y la prueba que manda de verdad', async () => {
    const r0 = await api('GET', '/api/alerts/rules', { token: admin });
    assert.ok(r0.json.rules.length > 0);
    const sinDestino = await api('POST', '/api/alerts/test', { token: admin, body: { event: 'security.ban' } });
    assert.match(sinDestino.json.error, /falta destinatario/);
    await api('POST', '/api/alerts/rules', { token: admin, body: { default_to: 'guardia@ejemplo.uy', event: 'security.ban', enabled: true, recipients: null, params: { umbral: 3 }, throttle_min: 5 } });
    const r1 = await api('GET', '/api/alerts/rules', { token: admin });
    assert.equal(r1.json.default_to, 'guardia@ejemplo.uy');
    const regla = r1.json.rules.find((x) => x.event === 'security.ban');
    assert.equal(regla.enabled, true);
    assert.equal(regla.throttle_min, 5);
    smtp.olvidar();
    const ok = await api('POST', '/api/alerts/test', { token: admin, body: {} });
    assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
    const [m] = await smtp.esperar(1);
    assert.deepEqual(m.to, ['guardia@ejemplo.uy']);
    const h = await api('GET', '/api/alerts/history', { token: admin });
    assert.ok(h.json.some((a) => a.event === 'security.ban' && a.sent));
  });

  await t.test('integraciones: telegram y whatsapp, lo secreto no sale; whatsapp manda al gateway', async () => {
    assert.equal((await api('PUT', '/api/integrations/fax', { token: admin, body: {} })).status, 400);
    await api('PUT', '/api/integrations/telegram', { token: admin, body: { token: 'bot-secreto', chat_id: '123', enabled: false } });
    await api('PUT', '/api/integrations/whatsapp', { token: admin, body: { url: svc.url + '/wa/', apikey: 'k', to: '59899', enabled: true } });
    const l = (await api('GET', '/api/integrations', { token: admin })).json;
    assert.deepEqual(l[0], { type: 'telegram', enabled: false, configured: true, chat_id: '123' });
    assert.equal(l[1].has_apikey, true);
    assert.equal(l[1].apikey, undefined);

    svc.ruta('POST', '/wa/sendText', (p) => ({ ok: true, a: p.body.args.to }));
    svc.olvidar();
    assert.equal((await api('POST', '/api/integrations/whatsapp/test', { token: admin })).json.ok, true);
    const p = svc.pedidos('/wa/sendText')[0];
    assert.equal(p.headers.api_key, 'k');
    assert.equal(p.body.args.to, '59899');
    svc.ruta('POST', '/wa/sendText', crudo(503, 'caído'));
    const mal = await api('POST', '/api/integrations/whatsapp/test', { token: admin });
    assert.equal(mal.status, 400);
    assert.match(mal.json.error, /HTTP 503 caído/);
    assert.equal((await api('POST', '/api/integrations/fax/test', { token: admin })).status, 400);
    /* Una llamada perdida avisa a las integraciones encendidas. */
    svc.ruta('POST', '/wa/sendText', { ok: true });
    svc.olvidar();
    ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2001-0009', DialStatus: 'NOANSWER', CallerIDNum: '099111', Linkedid: 'perdida-1' });
    ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2001-0009', DialStatus: 'NOANSWER', CallerIDNum: '099111', Linkedid: 'perdida-1' });
    const fin = Date.now() + 3000;
    while (!svc.pedidos('/wa/sendText').length && Date.now() < fin) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(svc.pedidos('/wa/sendText').length, 1, 'la misma llamada perdida se avisa una sola vez');
    assert.match(svc.pedidos('/wa/sendText')[0].body.args.content, /Llamada perdida al interno <b>2001<\/b>/);
  });

  await t.test('audios propios: subir, servir, listar y borrar', async () => {
    assert.equal((await api('POST', '/api/prompts', { token: admin, body: {} })).status, 400);
    assert.equal((await api('POST', '/api/prompts', { token: admin, body: { name: '!!!', data: 'eA==' } })).status, 400);
    const r = await api('POST', '/api/prompts', { token: admin, body: { name: 'Bienvenida Sur', data: WAV.toString('base64') } });
    assert.equal(r.json.name, 'bienvenidasur');
    const lista = (await api('GET', '/api/prompts', { token: admin })).json;
    const p = lista.find((x) => x.name === 'bienvenidasur');
    assert.equal(p.bytes, WAV.length);
    const audio = await fetch(base + '/api/prompts/' + p.id + '/audio', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), WAV);
    await api('POST', '/api/prompts', { token: admin, body: { name: 'musica', format: 'mp3', data: 'SUQz' } });
    const mp3 = (await api('GET', '/api/prompts', { token: admin })).json.find((x) => x.name === 'musica');
    assert.equal((await fetch(base + '/api/prompts/' + mp3.id + '/audio', { headers: { Authorization: 'Bearer ' + admin } })).headers.get('content-type'), 'audio/mpeg');
    await api('DELETE', '/api/prompts/' + p.id, { token: admin });
    assert.equal((await api('GET', '/api/prompts/' + p.id + '/audio', { token: admin })).status, 404);
  });

  await t.test('voz: estado, consola del servicio y generación de los audios del sistema', async () => {
    const caida = await api('GET', '/api/voz', { token: admin });
    assert.equal(caida.json.ok, false, 'sin servicio de voz se dice, no se cae');
    await ajuste('voz_url', svc.url);
    svc.ruta('GET', '/health', { piper: true, whisper: true });
    const v = await api('GET', '/api/voz', { token: admin });
    assert.equal(v.json.ok, true);
    assert.equal(v.json.piper, true);
    for (const [m, ruta, url] of [['GET', '/api/voz/logs', '/admin/logs'], ['POST', '/api/voz/restart', '/admin/restart'],
      ['GET', '/api/voz/voices', '/admin/voices'], ['POST', '/api/voz/voices/install', '/admin/voices/install'],
      ['DELETE', '/api/voz/voices/es_UY%20x', '/admin/voices/es_UY%20x'], ['GET', '/api/voz/config', '/admin/config'], ['POST', '/api/voz/config', '/admin/config']]) {
      svc.ruta(m, url, { ok: true, url });
      const r = await api(m, ruta, { token: admin, body: m === 'GET' || m === 'DELETE' ? undefined : { a: 1 } });
      assert.equal(r.json.url, url, ruta);
    }
    svc.ruta('POST', '/tts', (p) => crudo(200, p.body.text === 'roto' ? 'x' : WAV, { 'Content-Type': 'audio/wav' }));
    const prueba = await fetch(base + '/api/voz/test', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(prueba.headers.get('content-type'), 'audio/wav');

    const seed = await api('POST', '/api/sysprompts/seed', { token: admin });
    assert.ok(seed.json.inserted > 50);
    assert.equal((await api('POST', '/api/sysprompts/seed', { token: admin })).json.inserted, 0, 'sembrar dos veces no duplica');
    await api('PUT', '/api/sysprompts/vm-intro', { token: admin, body: { text: 'Deje su mensaje.' } });
    await api('PUT', '/api/sysprompts/vm-goodbye', { token: admin, body: { text: 'roto' } });
    await api('PUT', '/api/sysprompts/beep', { token: admin, body: {} });
    const g = await api('POST', '/api/sysprompts/generate', { token: admin, body: { names: ['vm-intro', 'vm-goodbye', 'beep', 'no-existe'] } });
    const por = Object.fromEntries(g.json.results.map((x) => [x.name, x]));
    assert.equal(por['vm-intro'].ok, true);
    assert.equal(por['vm-goodbye'].error, 'audio vacio');
    assert.equal(por.beep.skipped, 'sin texto');
    assert.equal(por['no-existe'].error, 'no existe');
    assert.equal(g.json.generated, 1);
    svc.ruta('POST', '/tts', crudo(500, 'no'));
    assert.equal((await api('POST', '/api/sysprompts/generate', { token: admin, body: { names: ['vm-intro'] } })).json.results[0].error, 'tts 500');
    const audio = await fetch(base + '/api/sysprompts/test/vm-intro', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(audio.status, 200);
    assert.equal((await api('GET', '/api/sysprompts/test/beep', { token: admin })).status, 404);
    const lista = (await api('GET', '/api/sysprompts', { token: admin })).json;
    assert.equal(lista.find((x) => x.name === 'vm-intro').has_audio, true);
    assert.equal((await api('POST', '/api/sysprompts/revert', { token: admin, body: { names: ['vm-intro'] } })).json.count, 1);
    assert.ok((await api('POST', '/api/sysprompts/revert', { token: admin, body: {} })).json.count >= 1);
  });

  await t.test('proxy inverso (NPM): sin configurar, credenciales malas y el certificado del dominio', async () => {
    assert.equal((await api('GET', '/api/npm/cert', { token: admin })).json.error, 'npm-not-configured');
    assert.equal((await api('POST', '/api/npm/test', { token: admin })).json.error, 'npm-not-configured');
    await ajuste('npm_url', svc.url + '/');
    assert.equal((await api('POST', '/api/npm/test', { token: admin })).json.error, 'npm-creds-missing');
    assert.equal((await api('GET', '/api/npm/hosts', { token: admin })).json.error, 'npm-creds-missing');
    await ajuste('npm_identity', 'a@b.uy'); await ajuste('npm_secret', 'x');
    svc.ruta('POST', '/api/tokens', {});
    assert.equal((await api('POST', '/api/npm/test', { token: admin })).json.error, 'npm-auth-failed');
    assert.equal((await api('GET', '/api/npm/cert', { token: admin })).json.error, 'npm-auth-failed');
    svc.ruta('POST', '/api/tokens', { token: 'tk' });
    svc.ruta('GET', '/api/nginx/proxy-hosts', [{ id: 7, domain_names: ['*.ejemplo.uy'], forward_host: 'dashboard', forward_port: 3000, certificate_id: 3, enabled: 1, allow_websocket_upgrade: 1 }]);
    await ajuste('domain', '');
    assert.equal((await api('GET', '/api/npm/hosts', { token: admin })).json.error, 'domain-missing');
    await ajuste('domain', 'pbx.ejemplo.uy');
    const t1 = await api('POST', '/api/npm/test', { token: admin });
    assert.equal(t1.json.ok, true);
    assert.equal(t1.json.hosts, 1);
    const h = await api('GET', '/api/npm/hosts', { token: admin });
    assert.deepEqual(h.json.host, { id: 7, domains: ['*.ejemplo.uy'], forward: 'http://dashboard:3000', ssl: true, ssl_forced: false, enabled: true, ws: true });
    svc.ruta('GET', '/api/nginx/proxy-hosts', []);
    assert.equal((await api('GET', '/api/npm/hosts', { token: admin })).json.error, 'host-not-found');
    svc.ruta('GET', '/api/nginx/certificates', [{ domain_names: ['otro.uy'] }]);
    assert.equal((await api('GET', '/api/npm/cert', { token: admin })).json.error, 'cert-not-found');
    await api('POST', '/api/npm/test', { token: admin });   // vacía el caché
    svc.ruta('GET', '/api/nginx/certificates', [{ domain_names: ['pbx.ejemplo.uy'], provider: 'letsencrypt', expires_on: '2099-01-01 10:00:00' }]);
    const c = await api('GET', '/api/npm/cert', { token: admin });
    assert.equal(c.json.provider, 'letsencrypt');
    assert.equal(c.json.expires_date, '2099-01-01T10:00:00.000Z', 'la fecha de NPM sin zona se toma como UTC');
    assert.ok(c.json.days_left > 1000);
  });

  await t.test('click-to-call: alta, enlace público, sesión con contexto propio y baja', async () => {
    assert.equal((await api('POST', '/api/c2c', { token: admin, body: {} })).status, 400);
    const l = await api('POST', '/api/c2c', { token: admin, body: { name: 'Web Sur', dest_value: '2001', video: true } });
    assert.equal(l.status, 201);
    const pub = await api('GET', '/api/c2c/public/' + l.json.token);
    assert.equal(pub.status, 200);
    assert.equal(pub.json.name, 'Web Sur');
    assert.equal((await api('GET', '/api/c2c/public/no-existe')).status, 404);
    const s = await api('POST', '/api/c2c/public/' + l.json.token + '/session', { body: { name: 'Juana <script>', geo: { lat: 1 } } });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.match(s.json.ext, /^c2c[0-9a-f]{6}$/);
    assert.equal(s.json.video, true);
    const dp = (await ctx.db.query('SELECT exten, app, appdata FROM extensions WHERE context=$1 ORDER BY priority', ['c2c_' + s.json.session])).rows;
    assert.equal(dp.length, 5);
    assert.equal(dp[3].appdata, '__C2C_VISITOR=Juana script', 'el nombre del visitante no lleva caracteres que rompan el dialplan');
    assert.equal(dp[4].appdata, 'internal,2001,1');
    assert.equal((await api('POST', '/api/c2c/public/no-existe/session', { body: {} })).status, 404);
    await api('PUT', '/api/c2c/' + l.json.id, { token: admin, body: { name: 'Web Sur', dest_type: 'ivr', dest_value: 'menu', enabled: false } });
    assert.equal((await api('GET', '/api/c2c/public/' + l.json.token)).status, 404, 'un enlace apagado no se muestra');
    assert.equal((await api('GET', '/api/c2c', { token: admin })).json[0].dest_type, 'ivr');
    await api('DELETE', '/api/c2c/' + l.json.id, { token: admin });
    assert.equal((await api('GET', '/api/c2c', { token: admin })).json.length, 0);
  });

  await t.test('teléfonos: alta por MAC, el archivo de aprovisionamiento de cada marca y la agenda', async () => {
    assert.equal((await api('POST', '/api/phones', { token: admin, body: { mac: 'zz' } })).status, 400);
    assert.equal((await api('POST', '/api/phones', { token: admin, body: { mac: '00:15:65:aa:bb:cc' } })).status, 400);
    const y = await api('POST', '/api/phones', { token: admin, body: { mac: '00:15:65:AA:BB:CC', ext: '3001', label: 'Recepción', vendor: 'yealink' } });
    assert.equal(y.status, 201, JSON.stringify(y.json));
    assert.equal(y.json.mac, '001565aabbcc');
    const g = await api('POST', '/api/phones', { token: admin, body: { mac: '000b82112233', ext: '3002', vendor: 'grandstream', password: 'Fija-3002' } });
    assert.equal(g.status, 201);
    await ctx.db.query("INSERT INTO pbxng_clients (name, phones) VALUES ('Edificio Sol', ARRAY['099123123'])");

    const cfg = await fetch(base + '/prov/001565aabbcc.cfg');
    assert.equal(cfg.status, 200);
    const txt = await cfg.text();
    assert.match(txt, /account\.1\.user_name = 3001/);
    assert.match(txt, /remote_phonebook\.data\.1\.url = http:\/\/127\.0\.0\.1:\d+\/prov\/agenda-yealink\.xml/);
    const xml = await (await fetch(base + '/prov/cfg000b82112233.xml')).text();
    assert.match(xml, /<P34><!\[CDATA\[Fija-3002\]\]><\/P34>/);
    assert.match(xml, /<P330>/);
    assert.equal((await fetch(base + '/prov/cfg000000000000')).status, 404);
    assert.equal((await fetch(base + '/prov/cualquier-cosa.txt')).status, 404);
    const agenda = await (await fetch(base + '/prov/agenda-yealink.xml')).text();
    assert.match(agenda, /Edificio Sol/);
    assert.match(await (await fetch(base + '/prov/phonebook.xml')).text(), /Edificio Sol/);
    assert.match(await (await fetch(base + '/prov/agenda.csv')).text(), /Edificio Sol/);
    assert.equal((await fetch(base + '/prov/agenda-desconocido.xml')).status, 404);
    await ajuste('agenda_clientes', '0');
    assert.doesNotMatch(await (await fetch(base + '/prov/agenda.csv')).text(), /Edificio Sol/, 'los clientes se pueden sacar de la agenda');

    /* Con token de aprovisionamiento, sin él o con otro no se entrega nada. */
    await ajuste('prov_token', 'tok123');
    assert.equal((await fetch(base + '/prov/001565aabbcc.cfg')).status, 403);
    assert.equal((await fetch(base + '/prov/otro/001565aabbcc.cfg')).status, 403);
    const conTok = await (await fetch(base + '/prov/tok123/001565aabbcc.cfg', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'pbx.ejemplo.uy' } })).text();
    assert.match(conTok, /https:\/\/pbx\.ejemplo\.uy\/prov\/tok123\/agenda-yealink\.xml/);
    const desdePanel = await fetch(base + '/api/agenda/csv', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(desdePanel.status, 200);

    const lista = (await api('GET', '/api/phones', { token: admin })).json;
    assert.equal(lista.length, 2);
    assert.ok(lista.find((p) => p.mac === '001565aabbcc').last_seen, 'el teléfono que pidió su archivo queda visto');
    await api('PUT', '/api/phones/' + lista[0].id, { token: admin, body: { ext: '3009', label: 'Nueva' } });
    assert.equal((await api('GET', '/api/phones', { token: admin })).json.find((p) => p.id === lista[0].id).ext, '3009');
    await ctx.db.query("INSERT INTO ps_contacts (id, endpoint, uri, user_agent) VALUES ('3002;@x','3002','sip:3002@10.0.0.9','Grandstream GXP1625'),('9999;@y','9999','sip:9999@10.0.0.8','Yealink SIP-T46U')").catch(() => {});
    const det = await api('GET', '/api/phones/detectados', { token: admin });
    assert.ok(Array.isArray(det.json));
    await api('DELETE', '/api/phones/' + lista[0].id, { token: admin });
    assert.equal((await api('GET', '/api/phones', { token: admin })).json.length, 1);
  });

  await t.test('push: suscribir, registrar un dispositivo nativo, desuscribir y la prueba sólo al propio interno', async () => {
    assert.equal((await api('POST', '/api/push/subscribe', { body: {} })).status, 400);
    assert.equal((await api('POST', '/api/push/subscribe', { body: { ext: '2001', subscription: { endpoint: 'https://push.ejemplo/1', keys: { p256dh: 'a', auth: 'b' } } } })).json.ok, true);
    assert.equal((await api('POST', '/api/push/register', { body: { ext: '2001' } })).status, 400);
    assert.equal((await api('POST', '/api/push/register', { body: { ext: '2001', provider: 'sms', prid: 'x' } })).status, 400);
    assert.equal((await api('POST', '/api/push/register', { body: { ext: '2001', provider: 'fcm', prid: 'tok-fcm' } })).json.ok, true);
    const d = await api('GET', '/api/push/devices', { token: admin });
    assert.equal(d.json.webpush[0].ext, '2001');
    assert.ok(d.json.vapid);
    assert.ok((await api('GET', '/api/push/vapid')).json.key);
    assert.equal((await api('POST', '/api/push/unsubscribe', { body: { endpoint: 'https://push.ejemplo/1' } })).json.ok, true);
    const t1 = await api('POST', '/api/push/test', { token: admin, body: { ext: '2001' } });
    assert.equal(t1.status, 200);
  });

  await t.test('ubicación de llamadas: coordenadas inválidas se rechazan y las válidas se listan', async () => {
    assert.equal((await api('POST', '/api/geo/report', { body: { lat: 'x', lng: 1 } })).status, 400);
    assert.equal((await api('POST', '/api/geo/report', { body: { lat: 91, lng: 1 } })).status, 400);
    assert.equal((await api('POST', '/api/geo/report', { body: { lat: -34.9, lng: -56.2, ext: '2001', dir: 'in', accuracy: '12' } })).json.ok, true);
    const g = await api('GET', '/api/geo?hours=5000&limit=5000', { token: admin });
    assert.equal(g.json.length, 1);
    assert.equal(g.json[0].dir, 'in');
  });

  await t.test('wake del dialplan: sólo con el token del agente y sin cabeceras de proxy', async () => {
    const tok = fs.readFileSync(path.join(ctx.api.confDir, 'agent.token'), 'utf8').trim();
    assert.equal((await fetch(base + '/api/internal/wake?ext=2001')).status, 403);
    assert.equal((await fetch(base + '/api/internal/wake?ext=2001&tok=' + tok, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403);
    const ok = await fetch(base + '/api/internal/wake?ext=2001&from=099&name=Juan&tok=' + tok);
    assert.equal(ok.status, 200);
  });

  await t.test('directorio y presencia: sin Asterisk listan vacío en vez de fallar', async () => {
    ami.accion('PJSIPShowEndpoints', { Response: 'Error', Message: 'x' });
    assert.equal((await api('GET', '/api/directory', { token: admin })).status, 200);
    assert.equal((await api('GET', '/api/presence', { token: admin })).status, 200);
  });

  await t.test('conferencia a tres: pide los dos números, sólo la propia llamada, y sin ARI dice 503', async () => {
    assert.equal((await api('POST', '/api/calls/conference', { token: admin, body: { ext: '2001' } })).status, 400);
    assert.equal((await api('POST', '/api/calls/conference', { token: admin, body: { ext: '2001', third: '2002' } })).status, 503);
  });

  await t.test('internos: alta con conflicto de numeración, edición, WebRTC y baja', async () => {
    assert.equal((await api('POST', '/api/endpoints', { token: admin, body: { id: '4001' } })).status, 400);
    const a = await api('POST', '/api/endpoints', { token: admin, body: { id: '4001', password: 'Clave-4001-xx', name: 'Caja', record: true, dtmf_mode: 'info' } });
    assert.equal(a.status, 201, JSON.stringify(a.json));
    assert.match(String(a.json.vm_pin), /^\d+$/, 'el PIN del buzón nace con el interno y sale una vez');
    const ep = (await ctx.db.query("SELECT dtmf_mode, pbxng_record, mailboxes FROM ps_endpoints WHERE id='4001'")).rows[0];
    assert.equal(ep.dtmf_mode, 'info');
    assert.equal(ep.pbxng_record, true);
    assert.ok(ami.pedidos('DBPut').some((p) => /4001/.test(JSON.stringify(p))), 'la marca de grabación va a la AstDB');
    const dup = await api('POST', '/api/endpoints', { token: admin, body: { id: '4001', password: 'Clave-4001-xx' } });
    assert.equal(dup.status, 409);

    const w = await api('POST', '/api/endpoints', { token: admin, body: { id: '4002', password: 'Clave-4002-xx', webrtc: true, video: true, dtmf_mode: 'raro' } });
    assert.equal(w.status, 201);
    const epw = (await ctx.db.query("SELECT transport, webrtc, dtmf_mode FROM ps_endpoints WHERE id='4002'")).rows[0];
    assert.deepEqual([epw.transport, epw.webrtc, epw.dtmf_mode], ['transport-ws', 'yes', 'rfc4733']);

    const u = await api('PUT', '/api/endpoints/4001', { token: admin, body: { password: 'Otra-clave-4001', max_contacts: 3, webrtc: true, name: 'Caja 2' } });
    assert.equal(u.status, 200);
    const tras = (await ctx.db.query("SELECT e.webrtc, e.pbxng_record, a.max_contacts FROM ps_endpoints e JOIN ps_aors a ON a.id=e.id WHERE e.id='4001'")).rows[0];
    assert.equal(tras.webrtc, 'yes');
    assert.equal(tras.max_contacts, 3);
    assert.equal(tras.pbxng_record, true, 'un PUT sin `record` no apaga la grabación');
    await api('PUT', '/api/endpoints/4001', { token: admin, body: { record: false, dtmf_mode: 'auto' } });
    assert.equal((await ctx.db.query("SELECT pbxng_record FROM ps_endpoints WHERE id='4001'")).rows[0].pbxng_record, false);
    const listado = await api('GET', '/api/extensions', { token: admin });
    assert.ok(listado.json.some((e) => e.id === '4001'));
    assert.ok((await api('GET', '/api/endpoints', { token: admin })).json.length >= 2);
    assert.equal((await api('DELETE', '/api/endpoints/4002', { token: admin })).json.deleted, '4002');
  });

  await t.test('numeración: el plan y el chequeo de un número', async () => {
    const plan = await api('GET', '/api/numbering/plan', { token: admin });
    assert.equal(plan.status, 200);
    const ocupado = await api('GET', '/api/numbering/check?ext=4001', { token: admin });
    assert.equal(ocupado.json.ok, false);
    const libre = await api('GET', '/api/numbering/check?ext=4001&ignorar=4001', { token: admin });
    assert.equal(libre.status, 200);
    assert.equal((await api('GET', '/api/system/overview', { token: admin })).status, 200);
  });

  await t.test('manuales: subir una captura, servirla, listarla y borrarla; nombres raros no', async () => {
    const png = 'data:image/png;base64,' + Buffer.from('png-falso').toString('base64');
    assert.equal((await api('POST', '/api/manuales/img/..%2F..%2Fetc.png', { token: admin, body: { data: png } })).status, 400);
    assert.equal((await api('POST', '/api/manuales/img/captura.png', { token: admin, body: { data: 'no es data url' } })).status, 400);
    assert.equal((await api('POST', '/api/manuales/img/captura-1.png', { token: admin, body: { data: png } })).json.bytes, 9);
    const img = await fetch(base + '/api/manuales/img/captura-1.png', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(await img.text(), 'png-falso');
    const falta = await fetch(base + '/api/manuales/img/no-esta.png', { headers: { Authorization: 'Bearer ' + admin }, redirect: 'manual' });
    assert.equal(falta.status, 302, 'si no se subió, se cae a la imagen que trae el producto');
    assert.equal((await fetch(base + '/api/manuales/img/x', { headers: { Authorization: 'Bearer ' + admin } })).status, 400);
    assert.deepEqual((await api('GET', '/api/manuales/img-list', { token: admin })).json.cargadas, ['captura-1.png']);
    assert.equal((await api('DELETE', '/api/manuales/img/x', { token: admin })).status, 400);
    assert.equal((await api('DELETE', '/api/manuales/img/captura-1.png', { token: admin })).json.ok, true);
    assert.deepEqual((await api('GET', '/api/manuales/img-list', { token: admin })).json.cargadas, []);
  });

  await t.test('respaldos: programación con validaciones, nombres fuera del directorio y subida inválida', async () => {
    const s = await api('GET', '/api/backup/schedule', { token: admin });
    assert.equal(s.json.enabled, true);
    assert.equal(s.json.hour, 3);
    for (const malo of [{ hour: 24 }, { hour: 1.5 }, { keep: 0 }, { enabled: 'si' }]) {
      assert.equal((await api('POST', '/api/backup/schedule', { token: admin, body: malo })).status, 400, JSON.stringify(malo));
    }
    const ok = await api('POST', '/api/backup/schedule', { token: admin, body: { hour: 4, keep: 7, enabled: false } });
    assert.deepEqual([ok.json.hour, ok.json.keep, ok.json.enabled], [4, 7, false]);
    const l = await api('GET', '/api/backup', { token: admin });
    assert.deepEqual(l.json.respaldos, []);
    assert.ok(l.json.partes.some((p) => p.id === 'grabaciones' && p.opcional));
    assert.equal((await api('GET', '/api/backup/..%2Fsecreto/inspeccionar', { token: admin })).status, 400);
    assert.equal((await api('DELETE', '/api/backup/no-existe.tar.gz', { token: admin })).status, 400);
    assert.equal((await api('GET', '/api/backup/no-existe.tar.gz/archivo', { token: admin })).status, 404);
    assert.equal((await api('GET', '/api/backup/x.zip/archivo', { token: admin })).status, 400);
    assert.equal((await api('POST', '/api/backup/x.tar.gz/restaurar', { token: admin, body: {} })).status, 400);
    const vacio = await fetch(base + '/api/backup/subir/x.tar.gz', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream' } });
    assert.equal(vacio.status, 400);
    const basura = await fetch(base + '/api/backup/subir/x.tar.gz', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('no soy un tar') });
    assert.equal(basura.status, 400);
    assert.match((await basura.json()).error, /no parece un respaldo/);
    assert.deepEqual((await api('GET', '/api/backup', { token: admin })).json.respaldos, [], 'lo que no es un respaldo no queda guardado');
  });

  await t.test('softphone: feed, subida a mano con nombres sanos y el lote con el latest.yml al final', async () => {
    const vacio = await api('GET', '/api/softphone/latest', { token: admin });
    assert.equal(vacio.status, 200);
    assert.equal((await api('POST', '/api/softphone/ota/subir', { token: admin, body: {} })).status, 400);
    const malo = await api('POST', '/api/softphone/ota/subir', { token: admin, body: { archivos: [{ name: '../x.exe', data: 'eA==' }] } });
    assert.equal(malo.status, 400);
    assert.match(malo.json.error, /no permitido/);
    assert.equal((await api('POST', '/api/softphone/ota/subir', { token: admin, body: { archivos: [{ name: 'x.sh', data: 'eA==' }] } })).status, 400);
    const yml = 'version: 0.18.0\nfiles:\n  - url: PBX-NG-Softphone-Setup-0.18.0.exe\n    sha512: abc\n    size: 3\npath: PBX-NG-Softphone-Setup-0.18.0.exe\nsha512: abc\nreleaseDate: 2026-10-01T00:00:00.000Z\n';
    const r = await api('POST', '/api/softphone/ota/subir', { token: admin, body: { archivos: [
      { name: 'latest.yml', data: Buffer.from(yml).toString('base64') },
      { name: 'PBX-NG-Softphone-Setup-0.18.0.exe', data: Buffer.from('MZ!').toString('base64') },
    ] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(fs.readFileSync(path.join(SOFT, 'PBX-NG-Softphone-Setup-0.18.0.exe'), 'utf8'), 'MZ!');
    assert.ok(fs.existsSync(path.join(SOFT, 'latest.yml')));
    assert.equal(fs.readdirSync(SOFT).some((f) => f.endsWith('.part')), false, 'no quedan .part');
    const exe = await fetch(base + '/softphone/PBX-NG-Softphone-Setup-0.18.0.exe');
    assert.equal(exe.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await fetch(base + '/softphone/latest.yml')).headers.get('content-type'), 'text/yaml; charset=utf-8');
    const cfg = await api('POST', '/api/softphone/ota/config', { token: admin, body: { auto: false, repo: ' org/repo ', cada_h: 500 } });
    assert.equal(cfg.status, 200);
    assert.equal((await ctx.db.query("SELECT value FROM pbxng_settings WHERE key='softphone_ota_cada_h'")).rows[0].value, '168');
    assert.equal((await api('GET', '/api/softphone/ota', { token: admin })).status, 200);
  });

  await t.test('ACME: la configuración se guarda y la clave del DNS no sale', async () => {
    const r = await api('POST', '/api/acme/config', { token: admin, body: { domain: ' pbx.ejemplo.uy ', email: 'a@b.uy', method: 'dns', dns_provider: 'dns_cf', dns_creds: { CF_Token: 'secreto' } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.config.domain, 'pbx.ejemplo.uy');
    assert.equal(JSON.stringify(r.json).includes('secreto'), false);
    const g = await api('GET', '/api/acme', { token: admin });
    assert.equal(g.json.config.method, 'dns');
  });

  await t.test('las rutas de admin no se abren a un agente', async () => {
    await api('POST', '/api/users', { token: admin, body: { username: 'beto', password: 'Clave-beto-123', role: 'agente', ext: '2001' } });
    const beto = (await login('beto', 'Clave-beto-123')).token;
    assert.equal((await api('GET', '/api/acme', { token: beto })).status, 403);
    assert.equal((await api('GET', '/api/softphone/ota', { token: beto })).status, 403);
    assert.equal((await api('POST', '/api/push/test', { token: beto, body: { ext: '2002' } })).status, 403, 'la prueba de push sólo al propio teléfono');
  });

  await t.test('una ruta de /api que no existe contesta 404 en JSON', async () => {
    const r = await api('GET', '/api/no-existe-esta-ruta', { token: admin });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'ruta inexistente');
  });
});
