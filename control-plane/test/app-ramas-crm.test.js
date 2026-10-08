/* ============================================================================
 *  Integración · lo que la central le da a los de AFUERA, con datos incompletos:
 *  porteros y cámaras (go2rtc y los relés), el click-to-call público, el
 *  aprovisionamiento de teléfonos y el push web a los navegadores.
 *
 *  app-crm y app-ajustes prueban el camino completo con todos los campos. Acá van los
 *  otros: un relé sin nombre, un portero sin usuario, un Hikvision que pide digest sin
 *  `qop` o que abre sin pedir firma, un cliente sin teléfonos guardados, un alta de
 *  cámara desde el softphone, el visitante web que no deja nombre, el teléfono detrás
 *  de un proxy que manda la cabecera con varios saltos, la suscripción de push que el
 *  navegador ya dio de baja (410) y go2rtc que deja de contestar. Cada caso fija lo que
 *  ve el que está del otro lado: el portero que se abre o el motivo por el que no, el
 *  archivo que baja el teléfono, la suscripción muerta que se limpia sola.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { entorno, puertoLibre } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { httpFalso, crudo } = require('./helpers/http-falso');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 5000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(50); } return fn(); }

/* Un servicio de push (como el de Chrome o Firefox) de mentira, por HTTPS con un
 * certificado propio: web-push sólo habla HTTPS. Sin openssl a mano devuelve null. */
async function pushFalso() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-push-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  if (r.status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
  const pedidos = [];
  const respuestas = {};
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    req.resume();
    req.on('end', () => { pedidos.push(req.url); res.writeHead(respuestas[req.url] || 201); res.end(); });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  fs.rmSync(dir, { recursive: true, force: true });
  return { url: 'https://127.0.0.1:' + srv.address().port, pedidos, respuestas, cerrar: () => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok); }) };
}
/* Las claves de una suscripción de verdad (P-256 + 16 bytes de auth), como las arma el navegador. */
function clavesNavegador() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}

test('porteros, click-to-call, aprovisionamiento y push con datos incompletos', async (t) => {
  const ami = await amiFalso();
  const g2 = await httpFalso();
  const portero = await httpFalso();
  const push = await pushFalso();
  const cerrado = await puertoLibre();
  /* go2rtc: el primer candidato no contesta y el segundo sí; la API se queda con ése. */
  const ctx = await entorno(t, Object.assign({}, ami.env, { GO2RTC_MGMT: 'http://127.0.0.1:' + cerrado + ',' + g2.url, NODE_TLS_REJECT_UNAUTHORIZED: '0' }));
  t.after(async () => { if (ctx) await ctx.cerrar(); await ami.cerrar(); await g2.cerrar(); await portero.cerrar(); if (push) await push.cerrar(); });
  if (!ctx) return;
  const { api, login, base } = ctx.api;
  const db = ctx.db;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  g2.ruta('GET', '/api', {});
  g2.ruta('PUT', '/api/streams', {});
  g2.ruta('DELETE', '/api/streams', {});
  for (const id of ['2001', '2002']) await api('POST', '/api/endpoints', { token: admin, body: { id, password: 'Clave-' + id + '-xx' } });
  const fono = (await api('POST', '/api/phone/token', { body: { ext: '2001', password: 'Clave-2001-xx' } })).json.token;
  const cli = (await api('POST', '/api/clients', { token: admin, body: { name: 'Torre Norte', phones: ['099000111'] } })).json;
  const nuevoDev = async (body) => (await api('POST', '/api/clients/' + cli.id + '/devices', { token: admin, body: Object.assign({ label: 'Puerta' }, body) })).json;
  const rele = (id, body) => api('POST', '/api/devices/' + id + '/rele', { token: admin, body: body || {} });

  await t.test('cámara desde el softphone: entra, queda en la bitácora como softphone y el relé lo abre el aparato', async () => {
    const r = await api('POST', '/api/clients/' + cli.id + '/devices', { token: fono, body: { label: 'Cochera', rtsp_url: 'rtsp://10.0.0.7/x', ext: '2090', rele_modo: 'dtmf', rele_cfg: { reles: [{ codigo: '*1' }] } } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.ok(await hasta(async () => (await db.query("SELECT 1 FROM pbxng_sec_events WHERE kind='crm' AND detail->>'via'='softphone' AND detail->>'por'='2001'")).rows.length), 'la bitácora no dice que vino del softphone');
    assert.ok(await hasta(() => g2.pedidos('/api/streams').length >= 1), 'go2rtc no se enteró del alta: se buscó el candidato que contesta');
    assert.ok(g2.pedidos('/api').length >= 1, 'se preguntó cuál go2rtc está vivo');
    const ab = await api('POST', '/api/devices/' + r.json.id + '/rele', { token: fono, body: {} });
    if (ab.status === 200) {
      assert.deepEqual(ab.json, { ok: true, modo: 'dtmf', dtmf: '*1', nombre: '' }, 'un relé sin nombre abre igual');
      assert.ok(await hasta(async () => (await db.query("SELECT 1 FROM pbxng_sec_events WHERE kind='apertura' AND detail->>'via'='softphone'")).rows.length));
    } else assert.equal(ab.status, 403, 'si el softphone no abre relés, que sea un 403 claro');
    /* Otro portero con el mismo interno: conflicto, tanto al crear como al editar. */
    const otro = await nuevoDev({ label: 'Otro' });
    assert.equal((await api('PUT', '/api/devices/' + otro.id, { token: admin, body: { ext: '2090' } })).status, 409);
    assert.equal((await api('PUT', '/api/devices/' + otro.id, { token: admin, body: { ext: '' } })).status, 200, 'un interno vacío es «sin interno»');
  });

  await t.test('relés: sin configuración, por código sin nombre, Akuvox sin usuario y Hikvision sin qop o sin pedir firma', async () => {
    const d = await nuevoDev({ rele_modo: 'codigo' });
    assert.ok(await hasta(async () => (await db.query("SELECT 1 FROM pbxng_sec_events WHERE kind='crm' AND detail->>'por'='admin' AND detail->>'via'='panel'")).rows.length), 'el alta desde el panel quedó sin dueño en la bitácora');
    await db.query(`UPDATE pbxng_client_devices SET rele_cfg='"texto suelto"'::jsonb WHERE id=$1`, [d.id]);
    const sinCfg = await rele(d.id);
    assert.equal(sinCfg.status, 400);
    assert.match(sinCfg.json.error, /no está configurado/);
    const ficha = (await api('GET', '/api/clients/' + cli.id, { token: admin })).json;
    assert.deepEqual(ficha.devices.find((x) => x.id === d.id).rele_cfg, {}, 'una configuración vacía sale como objeto vacío');
    await db.query("UPDATE pbxng_client_devices SET rele_cfg='{\"reles\":\"no es lista\"}' WHERE id=$1", [d.id]);
    assert.equal((await rele(d.id)).status, 400);
    const st = (await api('GET', '/api/intercom/streams?client=' + cli.id, { token: admin })).json.find((x) => x.id === d.id);
    assert.deepEqual([st.reles, st.ext], [[], null]);

    await api('PUT', '/api/devices/' + d.id, { token: admin, body: { rele_cfg: { reles: [{ codigo: '*77' }, {}] } } });
    ami.olvidar();
    const cod = await rele(d.id, { rele: 'x' });
    assert.deepEqual(cod.json, { ok: true, modo: 'codigo', nombre: '' });
    /* Un admin sin interno abre igual, y queda escrito con su usuario (la sesión del panel
     * trae `username`; leer `user` dejaba la apertura sin dueño en la bitácora). */
    assert.equal(ami.pedidos('Originate').at(-1).callerid, 'Apertura <admin>');
    assert.ok(await hasta(async () => (await db.query("SELECT 1 FROM pbxng_sec_events WHERE kind='apertura' AND detail->>'por'='admin' AND (detail->>'dispositivo')::int=$1", [d.id])).rows.length), 'la apertura quedó sin dueño en la bitácora');
    const st2 = (await api('GET', '/api/intercom/streams?client=' + cli.id, { token: admin })).json.find((x) => x.id === d.id);
    assert.deepEqual(st2.reles.map((x) => x.nombre), ['Relé 1', 'Relé 2'], 'un relé sin nombre se muestra numerado');

    const host = '127.0.0.1:' + portero.port;
    await api('PUT', '/api/devices/' + d.id, { token: admin, body: { rele_modo: 'http', rele_cfg: { host, reles: [{ num: 'abc' }] } } });
    portero.ruta('GET', '/fcgi/do', crudo(200, 'OK'));
    const ak = await rele(d.id);
    assert.deepEqual(ak.json, { ok: true, modo: 'http', nombre: '' });
    const q = new URLSearchParams(portero.pedidos('/fcgi/do').at(-1).query);
    assert.deepEqual([q.get('UserName'), q.get('Password'), q.get('DoorNum')], ['', '', '1'], 'sin usuario ni número de puerta: vacío y la puerta 1');

    await api('PUT', '/api/devices/' + d.id, { token: admin, body: { rele_cfg: { marca: 'HikVision', user: 'u', pass: 'p', reles: [{ num: 3, nombre: 'Peatonal' }] } } });
    const ruta = '/ISAPI/AccessControl/RemoteControl/door/3';
    let cab = null;
    portero.ruta('PUT', ruta, (p) => {
      if (!p.headers.authorization) return crudo(401, '', { 'WWW-Authenticate': 'Digest realm="hik", nonce="n1"' });
      cab = p.headers.authorization;
      return crudo(200, '<ok/>');
    });
    assert.equal((await rele(d.id)).json.nombre, 'Peatonal');
    assert.doesNotMatch(cab, /qop=|opaque=/, 'sin qop ni opaque en el desafío no se inventan');
    const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
    assert.match(cab, new RegExp('response="' + md5(md5('u:hik:p') + ':n1:' + md5('PUT:' + ruta)) + '"'));
    portero.ruta('PUT', ruta, crudo(200, '<ok/>'));
    portero.olvidar();
    assert.equal((await rele(d.id)).json.ok, true);
    assert.equal(portero.pedidos(ruta).length, 1, 'si el portero abre sin pedir firma, no se insiste');
  });

  await t.test('CRM con campos mínimos: personas, espacios, cliente sin teléfonos guardados, encuesta y su formulario', async () => {
    const p = await api('POST', '/api/clients/' + cli.id + '/persons', { token: admin, body: { name: 'Sólo nombre' } });
    assert.deepEqual([p.status, p.json.doc, p.json.relation, p.json.valid_until], [201, null, null, null]);
    const s = await api('POST', '/api/clients/' + cli.id + '/spaces', { token: admin, body: { name: 'Depósito' } });
    assert.deepEqual([s.status, s.json.kind], [201, null]);
    const u = await api('PUT', '/api/clients/' + cli.id, { token: admin, body: { phones: null } });
    assert.deepEqual(u.json.phones, ['099000111'], 'phones: null no borra los teléfonos');
    assert.deepEqual((await api('PUT', '/api/clients/999999', { token: admin, body: {} })).json, {});
    const vacio = (await api('POST', '/api/clients', { token: admin, body: { name: 'Sin datos' } })).json;
    await db.query('UPDATE pbxng_clients SET phones=NULL WHERE id=$1', [vacio.id]);
    assert.deepEqual((await api('GET', '/api/clients/' + vacio.id + '/calls', { token: admin })).json, []);
    const agenda = await api('GET', '/api/agenda/csv', { token: admin });
    assert.equal(agenda.status, 200, 'un cliente sin teléfonos no rompe la agenda');

    assert.equal((await api('PUT', '/api/survey/fields', { token: admin, body: { nada: 1 } })).json.ok, true);
    assert.deepEqual((await api('GET', '/api/survey/fields', { token: admin })).json, [], 'sin lista: el formulario queda vacío');
    await api('PUT', '/api/survey/fields', { token: admin, body: [{ label: 'Nota' }] });
    assert.equal((await api('GET', '/api/survey/fields', { token: admin })).json[0].ftype, 'text');
    assert.equal((await api('POST', '/api/survey', { token: admin, body: {} })).status, 201);
    const enc = (await api('GET', '/api/survey', { token: admin })).json[0];
    assert.deepEqual([enc.ext, enc.client_id, enc.answers], [null, null, {}]);
  });

  await t.test('go2rtc deja de contestar: probar el portero lo dice y sincronizar no falla', async () => {
    const d = await nuevoDev({ rtsp_url: 'rtsp://10.0.0.8/y' });
    g2.ruta('GET', '/api/probe', crudo(200, 'no es json'));
    assert.match((await api('POST', '/api/devices/' + d.id + '/test', { token: admin })).json.motivo, /no ofrecio video/);
    g2.ruta('GET', '/api/probe', { producers: [{ medias: 'no es lista' }, { medias: ['video, recvonly, H264'] }] });
    assert.deepEqual((await api('POST', '/api/devices/' + d.id + '/test', { token: admin })).json.pistas, 1);
    await g2.cerrar();
    const r = await api('POST', '/api/devices/' + d.id + '/test', { token: admin });
    assert.deepEqual(r.json, { ok: false, motivo: 'no se pudo hablar con go2rtc' });
    assert.equal((await api('POST', '/api/intercom/sync', { token: admin })).json.ok, true);
    assert.equal((await api('DELETE', '/api/devices/' + d.id, { token: admin })).json.ok, true, 'borrar no depende de que go2rtc conteste');
  });

  await t.test('click-to-call: a un IVR, con video, sin nombre del visitante; cinco enlaces malos avisan al guardia', async () => {
    const l = (await api('POST', '/api/c2c', { token: admin, body: { name: 'Mesa', dest_type: 'ivr', dest_value: '1', video: true, require_name: false, enabled: false } })).json;
    assert.equal((await api('GET', '/api/c2c/public/' + l.token)).status, 404, 'nace apagado si así se pidió');
    await api('PUT', '/api/c2c/' + l.id, { token: admin, body: { name: 'Mesa', dest_type: 'ivr', dest_value: '1', video: true } });
    const pub = (await api('GET', '/api/c2c/public/' + l.token)).json;
    assert.deepEqual([pub.video, pub.require_name, pub.enabled], [true, true, true], 'lo que no viene en la edición toma su valor por defecto');
    const s = await api('POST', '/api/c2c/public/' + l.token + '/session', { body: { name: '<<<>>>', meta: { pagina: '/contacto' } } });
    assert.equal(s.json.video, true);
    const fila = (await db.query('SELECT visitor_name, geo, meta FROM pbxng_c2c_sessions WHERE id=$1', [s.json.session])).rows[0];
    assert.deepEqual([fila.visitor_name, fila.geo, JSON.parse(fila.meta).pagina], ['Visitante web', null, '/contacto']);
    const dp = (await db.query("SELECT appdata FROM extensions WHERE context=$1 AND app='Goto'", ['c2c_' + s.json.session])).rows[0];
    assert.equal(dp.appdata, 'ivr,1,1', 'el destino IVR va al contexto ivr');
    const sinCuerpo = await api('POST', '/api/c2c/public/' + l.token + '/session', {});
    assert.equal(sinCuerpo.status, 200);

    /* IP privada a propósito: con una pública el guardia consulta la geolocalización afuera. */
    const ip = '10.77.' + Math.floor(Math.random() * 250) + '.9';
    const malo = () => fetch(base + '/api/c2c/public/enlace-falso', { headers: { 'X-Forwarded-For': ip } });
    const visto = async () => (await api('GET', '/api/security/live', { token: admin })).json.some((e) => e.ip === ip);
    for (let i = 0; i < 4; i++) assert.equal((await malo()).status, 404);
    await dormir(200);
    assert.equal(await visto(), false, 'cuatro enlaces vencidos todavía no son un ataque');
    await malo();
    assert.ok(await hasta(visto), 'al quinto enlace malo el guardia no se enteró');
  });

  await t.test('aprovisionamiento: detrás de un proxy con varios saltos, nombre de línea y un Grandstream sin clave', async () => {
    await db.query("INSERT INTO pbxng_phones (mac, vendor, ext, label, line_label, password) VALUES ('0015651a2b3c','yealink','2001','Recepción','Línea 1','s3cr3t'), ('000b82aabbcc','grandstream','2002',NULL,NULL,NULL)");
    const y = await fetch(base + '/prov/0015651a2b3c.cfg', { headers: { 'X-Forwarded-Proto': 'https, http', 'X-Forwarded-Host': 'pbx.ejemplo.uy, interno:3000' } });
    const ty = await y.text();
    assert.match(ty, /account\.1\.label = Línea 1/);
    assert.match(ty, /account\.1\.display_name = Recepción/);
    assert.match(ty, /remote_phonebook\.data\.1\.url = https:\/\/pbx\.ejemplo\.uy\/prov\/agenda-yealink\.xml/, 'la URL de la agenda es la del primer salto del proxy');
    const g = await fetch(base + '/prov/cfg000b82aabbcc.xml');
    const tg = await g.text();
    assert.match(tg, /<P34><!\[CDATA\[\]\]><\/P34>/, 'sin clave guardada va vacía, no "null"');
    assert.match(tg, /<P270><!\[CDATA\[2002\]\]><\/P270>/, 'sin etiqueta se usa el interno');
    assert.equal((await fetch(base + '/prov/0015651a2b3d.cfg')).status, 404);
  });

  await t.test('push web: la suscripción viva recibe, la que el navegador dio de baja (410) se borra y la que falla por otra cosa queda', async (tt) => {
    if (!push) { tt.skip('sin openssl para el servicio de push de mentira'); return; }
    const sub = (n) => ({ ext: '2002', subscription: { endpoint: push.url + '/' + n, keys: clavesNavegador() } });
    for (const n of ['viva', 'muerta', 'rara']) assert.equal((await api('POST', '/api/push/subscribe', { body: sub(n) })).json.ok, true);
    push.respuestas['/muerta'] = 410;
    push.respuestas['/rara'] = 500;
    const r = await api('POST', '/api/push/test', { token: admin, body: { ext: '2002' } });
    assert.equal(r.json.sent, 1, JSON.stringify(r.json));
    assert.deepEqual(push.pedidos.sort(), ['/muerta', '/rara', '/viva']);
    const quedan = (await db.query('SELECT endpoint FROM pbxng_push_subs WHERE ext=$1 ORDER BY endpoint', ['2002'])).rows.map((x) => x.endpoint.split('/').pop());
    assert.deepEqual(quedan, ['rara', 'viva']);
    /* El wake del dialplan sin número de origen ni nombre: el aviso dice «desconocido». */
    const tok = fs.readFileSync(path.join(ctx.api.confDir, 'agent.token'), 'utf8').trim();
    push.pedidos.length = 0;
    assert.equal((await fetch(base + '/api/internal/wake?ext=2002&tok=' + tok)).status, 200);
    assert.ok(await hasta(() => push.pedidos.length >= 2), 'el wake no despertó a las suscripciones');
    assert.equal((await fetch(base + '/api/internal/wake?tok=' + tok)).status, 200, 'sin interno no hay a quién despertar, pero no es un error');
  });
});
