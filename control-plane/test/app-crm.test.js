/* ============================================================================
 *  Integración · CRM y Portería en app.js: clientes, personas, espacios, porteros
 *  (con su URL RTSP y su clave que nunca salen enteras), apertura de relés por los
 *  tres caminos, entradas de video de un solo uso y la encuesta de fin de llamada.
 *
 *  go2rtc y el portero son servidores HTTP de mentira (helpers/http-falso.js). El
 *  portero Hikvision pide digest de verdad: 401 con el nonce y recién después abre.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { httpFalso, crudo } = require('./helpers/http-falso');

const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');

test('CRM y portería: fichas, porteros, relés, video y encuestas', async (t) => {
  const ami = await amiFalso();
  const g2 = await httpFalso();
  const portero = await httpFalso();
  t.after(async () => { await ami.cerrar(); await g2.cerrar(); await portero.cerrar(); });
  const ctx = await entorno(t, Object.assign({}, ami.env, { GO2RTC_MGMT: g2.url }));
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  g2.ruta('PUT', '/api/streams', {});
  g2.ruta('DELETE', '/api/streams', {});

  await api('POST', '/api/users', { token: admin, body: { username: 'ana', password: 'Clave-ana-1234', role: 'agente', ext: '2001' } });
  const ana = (await login('ana', 'Clave-ana-1234')).token;
  /* Abrir un relé desde el panel hoy es de supervisor para arriba (rbac.js manda todo
   * /api/devices a SUP); el softphone lo puede por su propia lista. */
  await api('POST', '/api/users', { token: admin, body: { username: 'sofi', password: 'Clave-sofi-123', role: 'supervisor', ext: '2002' } });
  const sup = (await login('sofi', 'Clave-sofi-123')).token;
  const g2espera = async (metodo) => { const fin = Date.now() + 3000; while (Date.now() < fin) { if (g2.pedidos('/api/streams').some((p) => p.method === metodo)) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };
  let cli, dev;

  await t.test('clientes: alta con teléfonos en texto, ficha, edición y búsqueda por número', async () => {
    assert.equal((await api('POST', '/api/clients', { token: ana, body: { name: 'X' } })).status, 403, 'un agente no escribe el CRM');
    const r = await api('POST', '/api/clients', { token: admin, body: { name: 'Edificio Sol', phones: '099 123 456, 2900 1234', address: 'Av. Brasil 100' } });
    assert.equal(r.status, 201);
    cli = r.json;
    assert.deepEqual(cli.phones, ['099 123 456', '2900 1234']);
    await api('POST', '/api/clients', { token: admin, body: { name: 'Otro', phones: ['1'] } });

    const u = await api('PUT', '/api/clients/' + cli.id, { token: admin, body: { notes: 'llaves en portería', phones: ['099123456', '29001234'] } });
    assert.equal(u.json.name, 'Edificio Sol', 'un PUT sin nombre no lo borra');
    assert.equal(u.json.notes, 'llaves en portería');
    await api('PUT', '/api/clients/' + cli.id, { token: admin, body: { phones: '099123456,29001234', address: 'Av. Brasil 100' } });

    const lista = (await api('GET', '/api/clients', { token: ana })).json;
    assert.equal(lista.length, 2);
    assert.deepEqual((await api('GET', '/api/clients/lookup', { token: ana })).json, {});
    assert.deepEqual((await api('GET', '/api/clients/lookup?number=777', { token: ana })).json, {});
    /* Por los últimos 8 dígitos: el mismo número con prefijo internacional. */
    const pop = await api('GET', '/api/clients/lookup?number=%2B598%2099123456', { token: ana });
    assert.equal(pop.json.id, cli.id);
    assert.ok(Array.isArray(pop.json.persons));
    assert.equal((await api('GET', '/api/clients/999999', { token: ana })).status, 404);
  });

  await t.test('personas y espacios', async () => {
    const p = await api('POST', '/api/clients/' + cli.id + '/persons', { token: admin, body: { name: 'Juan Pérez', doc: '1.234.567-8', valid_until: '2099-01-01' } });
    assert.equal(p.status, 201);
    const s = await api('POST', '/api/clients/' + cli.id + '/spaces', { token: admin, body: { name: 'Garaje', kind: 'cochera' } });
    assert.equal(s.status, 201);
    const f = (await api('GET', '/api/clients/' + cli.id, { token: ana })).json;
    assert.equal(f.persons[0].name, 'Juan Pérez');
    assert.equal(f.spaces[0].name, 'Garaje');
    assert.equal((await api('DELETE', '/api/persons/' + p.json.id, { token: admin })).json.ok, true);
    assert.equal((await api('DELETE', '/api/spaces/' + s.json.id, { token: admin })).json.ok, true);
    assert.equal((await api('GET', '/api/clients/' + cli.id, { token: ana })).json.persons.length, 0);
  });

  await t.test('portero: la URL RTSP y la clave nunca salen; go2rtc se entera del alta', async () => {
    g2.olvidar();
    const r = await api('POST', '/api/clients/' + cli.id + '/devices', { token: admin, body: {
      label: 'Portón', type: 'intercom', rtsp_url: 'rtsp://admin:clave123@10.0.0.5:554/Streaming/101', ext: ' 2090 ',
      rele_modo: 'dtmf', rele_cfg: { reles: [{ nombre: 'Portón', codigo: '#9' }, { nombre: 'Sin código' }], pass: 'clave-portero' },
    } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    dev = r.json;
    assert.equal(dev.rtsp_url, 'rtsp://•••:•••@10.0.0.5:554/Streaming/101');
    assert.equal(dev.rtsp_set, true);
    assert.equal(dev.rele_cfg.pass, undefined);
    assert.equal(dev.rele_cfg.pass_set, true);
    assert.equal(dev.ext, '2090');
    assert.equal(JSON.stringify(dev).includes('clave'), false);
    assert.ok(await g2espera('PUT'), 'go2rtc no se enteró del alta');
    assert.ok(g2.pedidos('/api/streams').some((p) => p.method === 'PUT' && decodeURIComponent(p.query).includes('clave123')));
    const bitacora = (await ctx.db.query("SELECT detail FROM pbxng_sec_events WHERE kind='crm'")).rows;
    assert.equal(bitacora[0].detail.que, 'alta de camara');

    const dup = await api('POST', '/api/clients/' + cli.id + '/devices', { token: admin, body: { label: 'Otro', ext: '2090' } });
    assert.equal(dup.status, 409, 'un interno no puede ser de dos porteros');
    const ficha = (await api('GET', '/api/clients/' + cli.id, { token: admin })).json;
    assert.equal(ficha.devices[0].rtsp_url, 'rtsp://•••:•••@10.0.0.5:554/Streaming/101');
  });

  await t.test('editar el portero: un campo vacío no borra la URL ni la clave', async () => {
    const u = await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { label: 'Portón principal', rtsp_url: '', rele_cfg: { reles: [{ nombre: 'Portón', codigo: '#9' }], pass: '', pass_set: true } } });
    assert.equal(u.status, 200);
    const fila = (await ctx.db.query('SELECT rtsp_url, rele_cfg FROM pbxng_client_devices WHERE id=$1', [dev.id])).rows[0];
    assert.match(fila.rtsp_url, /clave123/);
    assert.equal(fila.rele_cfg.pass, 'clave-portero');
    assert.equal(fila.rele_cfg.pass_set, undefined, 'el indicador de la pantalla no se guarda');
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { rele_cfg: { pass: 'nueva' } } });
    assert.equal((await ctx.db.query('SELECT rele_cfg FROM pbxng_client_devices WHERE id=$1', [dev.id])).rows[0].rele_cfg.pass, 'nueva');
    g2.olvidar();
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { enabled: false } });
    assert.ok(await g2espera('DELETE'), 'deshabilitar corta el RTSP');
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { enabled: true } });
    assert.equal((await api('PUT', '/api/devices/999999', { token: admin, body: { label: 'x' } })).status, 404);
  });

  await t.test('probar el portero contra go2rtc', async () => {
    g2.ruta('GET', '/api/probe', { producers: [{ medias: ['video, recvonly, H264', 'audio, recvonly, PCMA'] }] });
    const ok = await api('POST', '/api/devices/' + dev.id + '/test', { token: admin });
    assert.deepEqual(ok.json, { ok: true, motivo: '', pistas: 2, codecs: ['video', 'audio'] });
    g2.ruta('GET', '/api/probe', { producers: [] });
    assert.match((await api('POST', '/api/devices/' + dev.id + '/test', { token: admin })).json.motivo, /no ofrecio video/);
    g2.ruta('GET', '/api/probe', crudo(500, 'x'));
    assert.match((await api('POST', '/api/devices/' + dev.id + '/test', { token: admin })).json.motivo, /go2rtc respondio 500/);
    assert.equal((await api('POST', '/api/devices/999999/test', { token: admin })).status, 404);
    const sinUrl = await api('POST', '/api/clients/' + cli.id + '/devices', { token: admin, body: { label: 'Cámara vacía' } });
    assert.match((await api('POST', '/api/devices/' + sinUrl.json.id + '/test', { token: admin })).json.motivo, /no tiene URL RTSP/);
    await api('PUT', '/api/devices/' + sinUrl.json.id, { token: admin, body: { rtsp_url: 'rtsp://10.0.0.9/x', enabled: false } });
    assert.match((await api('POST', '/api/devices/' + sinUrl.json.id + '/test', { token: admin })).json.motivo, /deshabilitado/);
    await api('DELETE', '/api/devices/' + sinUrl.json.id, { token: admin });
  });

  await t.test('abrir un relé por DTMF: devuelve el código y deja escrito quién', async () => {
    const r = await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: { rele: 0 } });
    assert.deepEqual(r.json, { ok: true, modo: 'dtmf', dtmf: '#9', nombre: 'Portón' });
    let ev = [];
    for (let i = 0; i < 60 && !ev.length; i++) { ev = (await ctx.db.query("SELECT detail FROM pbxng_sec_events WHERE kind='apertura'")).rows; if (!ev.length) await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(ev[0].detail.por, '2002');
    assert.equal((await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: { rele: 5 } })).status, 400);
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { rele_cfg: { reles: [{ nombre: 'Sin código' }] } } });
    assert.match((await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} })).json.error, /no tiene código DTMF/);
    assert.equal((await api('POST', '/api/devices/999999/rele', { token: sup, body: {} })).status, 404);
  });

  await t.test('abrir un relé por código de función: lo marca la central desde el interno de quien abre', async () => {
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { rele_modo: 'codigo', rele_cfg: { reles: [{ nombre: 'Portón', codigo: '*55' }] } } });
    ami.olvidar();
    const r = await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: { rele: 0 } });
    assert.equal(r.json.modo, 'codigo');
    const o = ami.pedidos('Originate')[0];
    assert.equal(o.channel, 'Local/*55@internal');
    assert.equal(o.callerid, 'Apertura <2002>');
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { rele_cfg: { reles: [{ nombre: 'x' }] } } });
    assert.match((await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} })).json.error, /no tiene código de función/);
  });

  await t.test('abrir un relé por HTTP: Akuvox por fcgi y Hikvision con digest', async () => {
    const host = '127.0.0.1:' + portero.port;
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { rele_modo: 'http', rele_cfg: { host, marca: 'akuvox', user: 'admin', pass: 'p@ss', reles: [{ nombre: 'Puerta', num: 2 }] } } });
    portero.ruta('GET', '/fcgi/do', crudo(200, '{"retcode":0,"result":1}'));
    const ak = await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} });
    assert.equal(ak.json.ok, true, JSON.stringify(ak.json));
    const q = new URLSearchParams(portero.pedidos('/fcgi/do')[0].query);
    assert.deepEqual([q.get('action'), q.get('UserName'), q.get('Password'), q.get('DoorNum')], ['OpenDoor', 'admin', 'p@ss', '2']);
    portero.ruta('GET', '/fcgi/do', crudo(200, '{"result":0,"message":"fail"}'));
    const rech = await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} });
    assert.equal(rech.status, 502);
    assert.match(rech.json.error, /rechazó la apertura/);
    portero.ruta('GET', '/fcgi/do', crudo(403, 'no'));
    assert.match((await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} })).json.error, /contestó HTTP 403/);

    /* Hikvision: primero 401 con el desafío, después se valida la firma. */
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { rele_cfg: { marca: 'hikvision', reles: [{ nombre: 'Puerta', num: 1 }] } } });
    const nonce = 'abc123';
    portero.ruta('PUT', '/ISAPI/AccessControl/RemoteControl/door/1', (p) => {
      const a = p.headers.authorization;
      if (!a) return crudo(401, '', { 'WWW-Authenticate': `Digest realm="hik", nonce="${nonce}", qop="auth", opaque="op"` });
      const campo = (k) => (new RegExp(k + '="?([^",]+)"?').exec(a) || [])[1];
      const ha1 = md5('admin:hik:p@ss'), ha2 = md5('PUT:/ISAPI/AccessControl/RemoteControl/door/1');
      const esperado = md5(`${ha1}:${nonce}:${campo('nc')}:${campo('cnonce')}:auth:${ha2}`);
      return campo('response') === esperado ? crudo(200, '<ResponseStatus><statusCode>1</statusCode></ResponseStatus>') : crudo(401, 'firma mala');
    });
    const hk = await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} });
    assert.equal(hk.json.ok, true, JSON.stringify(hk.json));
    assert.equal(portero.pedidos('/ISAPI/AccessControl/RemoteControl/door/1').length, 2);

    /* Un portero que no está: se nombra la dirección. */
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { rele_cfg: { host: '127.0.0.1:1', marca: 'akuvox' } } });
    assert.match((await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} })).json.error, /no se llegó al portero 127\.0\.0\.1:1/);
    await api('PUT', '/api/devices/' + dev.id, { token: admin, body: { rele_cfg: { host: '' } } });
    const sinHost = (await ctx.db.query('SELECT rele_cfg FROM pbxng_client_devices WHERE id=$1', [dev.id])).rows[0].rele_cfg;
    if (!sinHost.host) assert.match((await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} })).json.error, /no tiene dirección/);
  });

  await t.test('sin modo de apertura o deshabilitado, no se abre', async () => {
    await ctx.db.query("UPDATE pbxng_client_devices SET rele_modo=NULL WHERE id=$1", [dev.id]);
    assert.match((await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} })).json.error, /no tiene modo de apertura/);
    await ctx.db.query('UPDATE pbxng_client_devices SET enabled=false WHERE id=$1', [dev.id]);
    assert.equal((await api('POST', '/api/devices/' + dev.id + '/rele', { token: sup, body: {} })).status, 409);
    await ctx.db.query('UPDATE pbxng_client_devices SET enabled=true WHERE id=$1', [dev.id]);
  });

  await t.test('video: configuración, entradas de un solo uso, canales y clientes con portero', async () => {
    const c0 = await api('GET', '/api/intercom/config', { token: admin });
    assert.equal(c0.json.por_la_central, true);
    assert.equal((await api('POST', '/api/intercom/config', { token: admin, body: { go2rtc_url: 'https://video.ejemplo.uy' } })).json.ok, true);
    assert.equal((await api('GET', '/api/intercom/config', { token: admin })).json.go2rtc_url, 'https://video.ejemplo.uy');
    await api('POST', '/api/intercom/config', { token: admin, body: { go2rtc_url: '' } });
    assert.equal((await api('POST', '/api/intercom/sync', { token: admin })).json.ok, true);

    assert.equal((await api('GET', '/api/intercom/ticket', { token: ana })).status, 400);
    assert.equal((await api('GET', '/api/intercom/ticket?src=inventado', { token: ana })).status, 404);
    const tk = await api('GET', '/api/intercom/ticket?src=' + dev.go2rtc_src, { token: ana });
    assert.equal(tk.json.expira_en, 60);
    const v = (src) => api('GET', '/api/intercom/ticket/verify?t=' + tk.json.ticket + '&src=' + src);
    assert.equal((await v('otro-canal')).status, 403, 'una entrada de un canal no abre otro');
    const tk2 = await api('GET', '/api/intercom/ticket?src=' + dev.go2rtc_src, { token: ana });
    const ok = await api('GET', '/api/intercom/ticket/verify?t=' + tk2.json.ticket + '&src=' + dev.go2rtc_src);
    assert.equal(ok.json.ok, true);
    assert.equal((await api('GET', '/api/intercom/ticket/verify?t=' + tk2.json.ticket + '&src=' + dev.go2rtc_src)).status, 403, 'se usa una sola vez');

    const st = (await api('GET', '/api/intercom/streams?client=' + cli.id, { token: ana })).json;
    assert.equal(st[0].src, dev.go2rtc_src);
    assert.equal(JSON.stringify(st).includes('p@ss'), false, 'la clave del portero no sale en la lista de video');
    assert.deepEqual((await api('GET', '/api/intercom/clients', { token: ana })).json, [{ id: cli.id, name: 'Edificio Sol' }]);
    const pop = await api('GET', '/api/clients/lookup?number=099123456', { token: ana });
    assert.equal(pop.json.devices.length, 1);
    await api('POST', '/api/modules', { token: admin, body: { id: 'intercom', enabled: false } });
    assert.deepEqual((await api('GET', '/api/clients/lookup?number=099123456', { token: ana })).json.devices, [], 'con Portería apagada la ficha viaja sin los canales');
  });

  await t.test('encuesta: campos por defecto, editar el formulario, responder y ver las intervenciones', async () => {
    const f = (await api('GET', '/api/survey/fields', { token: ana })).json;
    assert.equal(f.length, 5);
    assert.equal((await api('PUT', '/api/survey/fields', { token: ana, body: [] })).status, 403);
    await api('PUT', '/api/survey/fields', { token: admin, body: { fields: [{ id: f[0].id, label: 'Motivo', ftype: 'select', options: ['A'], required: true }, { label: 'Patente' }] } });
    const f2 = (await api('GET', '/api/survey/fields', { token: ana })).json;
    assert.deepEqual(f2.map((x) => x.label), ['Motivo', 'Patente']);
    assert.equal((await api('POST', '/api/survey', { token: ana, body: { ext: '2001', client_id: cli.id, caller: '099123456', answers: { Motivo: 'A' } } })).status, 201);
    assert.equal((await api('GET', '/api/survey', { token: admin })).json.length, 1);
    const iv = await api('GET', '/api/clients/' + cli.id + '/interventions', { token: sup });
    assert.equal(iv.json.items[0].caller, '099123456');
    assert.equal(iv.json.fields.length, 2);
  });

  await t.test('llamadas del cliente por sus teléfonos, y geocodificar sin dirección', async () => {
    await ctx.db.query("INSERT INTO cdr (start, clid, src, dst, duration, billsec, disposition, uniqueid, linkedid) VALUES (now(), 'x', '099123456', '2001', 30, 25, 'ANSWERED', 'u1', 'u1')");
    const c = await api('GET', '/api/clients/' + cli.id + '/calls', { token: sup });
    assert.equal(c.json.length, 1);
    assert.equal((await api('GET', '/api/clients/999999/calls', { token: sup })).status, 404);
    const sinTel = await api('POST', '/api/clients', { token: admin, body: { name: 'Sin teléfono' } });
    assert.deepEqual((await api('GET', '/api/clients/' + sinTel.json.id + '/calls', { token: sup })).json, []);
    assert.equal((await api('POST', '/api/clients/' + sinTel.json.id + '/geocode', { token: admin })).status, 400);
  });

  await t.test('borrar el portero lo saca de go2rtc; borrar el cliente', async () => {
    g2.olvidar();
    assert.equal((await api('DELETE', '/api/devices/' + dev.id, { token: admin })).json.ok, true);
    assert.ok(await g2espera('DELETE'));
    assert.equal((await api('DELETE', '/api/clients/' + cli.id, { token: admin })).json.ok, true);
    assert.equal((await api('GET', '/api/clients/' + cli.id, { token: admin })).status, 404);
  });
});
