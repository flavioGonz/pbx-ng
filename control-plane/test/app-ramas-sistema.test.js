/* ============================================================================
 *  Integración · los caminos alternativos de las rutas de sistema de app.js.
 *
 *  app-sistema/app-ajustes prueban el camino feliz de cada pantalla. Lo que queda acá
 *  son las otras puertas de las MISMAS rutas, que son las que se abren el día que algo
 *  anda mal o el dato llega distinto: el servicio de voz que no contesta, el proxy
 *  inverso con un certificado comodín, un SMTP que no existe, un gateway de WhatsApp que
 *  devuelve basura, el agente de red que dice que falló sin decir por qué, un interno
 *  cuyo número choca con el plan, un respaldo guardado con valores ilegibles. Cada caso
 *  fija lo que el panel termina mostrando, porque un catch que nunca corrió es un
 *  mensaje que nadie leyó nunca.
 *
 *  Del otro lado hay un AMI de mentira (helpers/ami-falso.js) y un único servidor HTTP
 *  de mentira (helpers/http-falso.js) que hace de agente de Asterisk, de coturn, de
 *  servicio de voz, de NPM y de gateway de WhatsApp a la vez (las rutas no se pisan).
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { httpFalso, crudo } = require('./helpers/http-falso');
const { smtpFalso } = require('./helpers/smtp-falso');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 5000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(60); }
  return fn();
}
/* Un WAV mínimo pero de más de 100 bytes: lo que la API acepta como audio generado. */
const wav = (n = 400) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(n)]);

test('sistema: las otras puertas de las rutas (fallas, datos raros, valores por defecto)', async (t) => {
  const ami = await amiFalso();
  const f = await httpFalso();
  const smtp = await smtpFalso();
  /* «El servicio está caído»: el puerto 1 de 127.0.0.1. Uno pedido libre y soltado no sirve:
   * con la suite en paralelo otra prueba lo toma para su propio servidor falso (pasó en el
   * CI con un SMTP que rechazaba la clave), y sin root nadie puede escuchar en el 1. */
  const cerrado = 1;
  const ctx = await entorno(t, Object.assign({}, ami.env, { AST_AGENT: f.url, TURN_AGENT: f.url, NPM_HOST: '10.9.9.9', DOMAIN: 'pbx.ejemplo.uy' }));
  /* Primero la API (que reconecta el AMI sola) y después los falsos: al revés, el
   * server.close() del AMI falso espera conexiones que la API vuelve a abrir. */
  t.after(async () => { if (ctx) await ctx.cerrar(); await ami.cerrar(); await f.cerrar(); await smtp.cerrar(); });
  if (!ctx) return;
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  const db = ctx.db;
  await ami.conectado();

  await t.test('voz caída: cada consola del servicio contesta con error JSON en vez de colgarse', async () => {
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('voz_url',$1) ON CONFLICT (key) DO UPDATE SET value=$1", ['http://127.0.0.1:' + cerrado]);
    const st = await api('GET', '/api/voz', { token: admin });
    assert.equal(st.json.ok, false, 'el estado dice que no anda');
    for (const [m, r] of [['GET', '/api/voz/logs'], ['POST', '/api/voz/restart'], ['GET', '/api/voz/voices'], ['POST', '/api/voz/voices/install'],
      ['DELETE', '/api/voz/voices/es_AR'], ['GET', '/api/voz/config'], ['POST', '/api/voz/config'], ['POST', '/api/voz/test']]) {
      const x = await api(m, r, { token: admin, body: m === 'GET' || m === 'DELETE' ? undefined : {} });
      assert.equal(x.status, 500, m + ' ' + r);
      assert.ok(x.json.error, m + ' ' + r + ' sin mensaje');
    }
  });

  await t.test('audios del sistema: lo que contesta el TTS decide el resultado de cada uno', async () => {
    await db.query("UPDATE pbxng_settings SET value=$1 WHERE key='voz_url'", [f.url]);
    await api('POST', '/api/sysprompts/seed', { token: admin });
    await api('PUT', '/api/sysprompts/beep', { token: admin, body: {} });   // sin texto
    let n = 0;
    f.ruta('POST', '/tts', () => { n++; return n === 1 ? crudo(500, 'roto') : n === 2 ? crudo(200, 'corto') : crudo(200, wav()); });
    const r = await api('POST', '/api/sysprompts/generate', { token: admin, body: { names: ['vm-intro', 'vm-goodbye', 'hello-world', 'beep', 'no-existe'], voice: 'es_AR' } });
    const por = Object.fromEntries(r.json.results.map((x) => [x.name, x]));
    assert.equal(por['vm-intro'].error, 'tts 500');
    assert.equal(por['vm-goodbye'].error, 'audio vacio');
    assert.equal(por['hello-world'].ok, true);
    assert.equal(por.beep.skipped, 'sin texto');
    assert.equal(por['no-existe'].error, 'no existe');
    assert.equal(r.json.generated, 1);
    /* Sin lista: se generan todos los del catálogo, y un TTS que no contesta queda
     * anotado en cada uno en vez de cortar el lote. */
    await db.query('DELETE FROM pbxng_sysprompts WHERE name <> $1', ['hello-world']);
    await db.query("UPDATE pbxng_settings SET value=$1 WHERE key='voz_url'", ['http://127.0.0.1:' + cerrado]);
    const todos = await api('POST', '/api/sysprompts/generate', { token: admin, body: {} });
    assert.equal(todos.json.results.length, 1);
    assert.equal(todos.json.results[0].ok, false);
    assert.equal(todos.json.voice, 'es-UY-ValentinaNeural', 'sin voz elegida usa la de siempre');
    await db.query("UPDATE pbxng_settings SET value=$1 WHERE key='voz_url'", [f.url]);
  });

  await t.test('NPM: certificado comodín, fecha con zona, caché y proxy host por comodín', async () => {
    const set = (k, v) => db.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, v]);
    /* Sin npm_url pero con NPM_HOST: se arma la URL con el host (y no hay credenciales). */
    assert.equal((await api('GET', '/api/npm/cert', { token: admin })).json.error, 'npm-creds-missing');
    assert.equal((await api('POST', '/api/npm/test', { token: admin })).json.error, 'npm-creds-missing');
    await set('npm_url', f.url + '/');
    await set('npm_identity', 'yo'); await set('npm_secret', 'clave');
    f.ruta('POST', '/api/tokens', { token: 'tk' });
    f.ruta('GET', '/api/nginx/certificates', [{ domain_names: ['otro.uy'] }, { domain_names: ['*.ejemplo.uy'], provider: 'letsencrypt', expires_on: '2030-01-01T00:00:00+00:00' }]);
    const c = await api('POST', '/api/npm/test', { token: admin });   // vacía la caché
    assert.equal(c.json.ok, true);
    assert.equal(c.json.hosts, 0, 'si el NPM no devuelve una lista de hosts, son cero');
    const cert = await api('GET', '/api/npm/cert', { token: admin });
    assert.equal(cert.json.provider, 'letsencrypt', 'el comodín cubre al dominio');
    assert.equal(cert.json.expires_date, '2030-01-01T00:00:00.000Z');
    f.ruta('GET', '/api/nginx/certificates', []);
    assert.equal((await api('GET', '/api/npm/cert', { token: admin })).json.provider, 'letsencrypt', 'la segunda lectura sale de la caché');
    await api('POST', '/api/npm/test', { token: admin });
    f.ruta('GET', '/api/nginx/certificates', { no: 'es una lista' });
    assert.equal((await api('GET', '/api/npm/cert', { token: admin })).json.error, 'cert-not-found');
    await api('POST', '/api/npm/test', { token: admin });
    f.ruta('GET', '/api/nginx/certificates', [{ domain_names: ['pbx.ejemplo.uy'], expires_on: 'cualquier cosa' }]);
    const sinFecha = await api('GET', '/api/npm/cert', { token: admin });
    assert.equal(sinFecha.json.expires_date, null, 'una fecha ilegible no inventa un vencimiento');
    assert.equal(sinFecha.json.days_left, null);
    await api('POST', '/api/npm/test', { token: admin });
    f.ruta('GET', '/api/nginx/certificates', [{ expires_on: '2030-01-01 10:00:00' }]);
    assert.equal((await api('GET', '/api/npm/cert', { token: admin })).json.error, 'cert-not-found');

    f.ruta('GET', '/api/nginx/proxy-hosts', [{ id: 1 }, { id: 7, domain_names: ['*.ejemplo.uy'], forward_host: 'api', forward_port: 3000, enabled: true }]);
    const h = await api('GET', '/api/npm/hosts', { token: admin });
    assert.equal(h.json.host.id, 7);
    assert.equal(h.json.host.forward, 'http://api:3000');
    assert.equal(h.json.host.enabled, true);
    f.ruta('GET', '/api/nginx/proxy-hosts', { mal: 1 });
    assert.equal((await api('GET', '/api/npm/hosts', { token: admin })).json.error, 'host-not-found');
    f.ruta('GET', '/api/nginx/proxy-hosts', [{ id: 8, domain_names: ['pbx.ejemplo.uy'] }]);
    const h2 = await api('GET', '/api/npm/hosts', { token: admin });
    assert.deepEqual([h2.json.host.forward, h2.json.host.enabled], ['http://:', false]);
    f.ruta('POST', '/api/tokens', {});
    assert.equal((await api('GET', '/api/npm/hosts', { token: admin })).json.error, 'npm-auth-failed');
    await set('domain', '');
    assert.equal((await api('GET', '/api/npm/hosts', { token: admin })).json.domain, undefined);
    f.ruta('GET', '/api/nginx/proxy-hosts', crudo(200, 'no json'));
    f.ruta('POST', '/api/tokens', { token: 'tk' });
    assert.equal((await api('GET', '/api/npm/hosts', { token: admin })).status, 500, 'una respuesta ilegible del NPM es un error, no un host inventado');
  });

  await t.test('capturas: preset desconocido cae en SIP, el agente que falla o no devuelve datos queda anotado', async () => {
    f.ruta('POST', '/capture', crudo(503, 'ocupado'));
    const a = await api('POST', '/api/capture/start', { token: admin, body: { preset: 'cualquiera', duration: 'x' } });
    assert.deepEqual([a.json.preset, a.json.duration], ['sip', 30]);
    const fila = async (id) => (await db.query('SELECT status, error, size FROM pbxng_captures WHERE id=$1', [id])).rows[0];
    assert.ok(await hasta(async () => (await fila(a.json.id)).status === 'error'));
    assert.match((await fila(a.json.id)).error, /HTTP 503/);
    f.ruta('POST', '/capture', { error: 'tcpdump no está' });
    const b = await api('POST', '/api/capture/start', { token: admin, body: { preset: 'all', duration: 1 } });
    assert.equal(b.json.duration, 3, 'menos de 3 s no sirve para nada');
    assert.ok(await hasta(async () => (await fila(b.json.id)).status === 'error'));
    assert.equal((await fila(b.json.id)).error, 'tcpdump no está');
    f.ruta('POST', '/capture', {});
    const c = await api('POST', '/api/capture/start', { token: admin, body: { preset: 'siprtp' } });
    assert.ok(await hasta(async () => (await fila(c.json.id)).status === 'done'));
    assert.equal((await fila(c.json.id)).size, '0', 'el agente no mandó datos: la captura queda vacía');
    await db.query("UPDATE pbxng_captures SET data='\\x00', filename=NULL WHERE id=$1", [c.json.id]);
    const d = await fetch(ctx.api.base + '/api/capture/' + c.json.id + '/download', { headers: { Authorization: 'Bearer ' + admin } });
    assert.match(d.headers.get('content-disposition'), new RegExp('cap-' + c.json.id + '\\.pcap'));
  });

  await t.test('modo de red: sin fila guardada, agente sin placas, fallo sin detalle, reaplicar y revertir sin agente', async () => {
    await db.query('DELETE FROM pbxng_net');
    f.ruta('GET', '/net', {});
    const v = await api('GET', '/api/net/mode', { token: admin });
    assert.equal(v.json.cfg.modo, 'router', 'sin fila: router por defecto');
    assert.deepEqual(v.json.interfaces, []);
    await db.query("INSERT INTO pbxng_net (id) VALUES (1)");
    const ifaces = [{ name: 'eth0' }, { name: 'eth1', rol: 'lan' }, { name: 'eth2', modo: 'bridge' }];
    f.ruta('GET', '/net', { ifaces });
    f.ruta('POST', '/netmode', crudo(200, 'null'));
    const nulo = await api('POST', '/api/net/mode/apply', { token: admin, body: { confirmar: true, cfg: { modo: 'switch' } } });
    assert.equal(nulo.status, 500);
    assert.match(nulo.json.error, /sin detalle/);
    assert.deepEqual(nulo.json.pasos, []);
    f.ruta('POST', '/netmode', { ok: true, pasos: [] });
    assert.equal((await api('PUT', '/api/net/mode', { token: admin, body: { wan_if: 'eth0' } })).status, 200);
    const a1 = await api('POST', '/api/net/mode/apply', { token: admin, body: { confirmar: true, rollback_seg: 9999, cfg: { modo: 'switch' } } });
    assert.equal(a1.json.rollback_seg, 600, 'el plazo de confirmación tiene techo');
    const a2 = await api('POST', '/api/net/mode/apply', { token: admin, body: { confirmar: true, cfg: { modo: 'switch', bridge: '' } } });
    assert.equal(a2.json.ok, true, 'reaplicar con un cambio pendiente reemplaza el reloj');
    assert.equal((await db.query('SELECT bridge FROM pbxng_net')).rows[0].bridge, 'br0');
    f.quitar('POST', '/netmode');
    const rev = await api('POST', '/api/net/mode/revert', { token: admin });
    assert.equal(rev.json.ok, false, 'el agente no dijo ok: se informa');
    f.ruta('POST', '/netmode', { ok: true, pasos: [] });
    assert.equal((await api('POST', '/api/net/mode/apply', { token: admin, body: { confirmar: true, cfg: { modo: 'switch' } } })).json.ok, true);
    f.ruta('POST', '/netmode', crudo(200, 'no json'));
    assert.equal((await api('POST', '/api/net/mode/revert', { token: admin })).status, 500);
    const roto = await api('POST', '/api/net/mode/apply', { token: admin, body: { confirmar: true, cfg: { modo: 'router', wan_if: 'eth0', lan_if: 'eth0' } } });
    assert.equal(roto.status, 400);
    assert.match(roto.json.error, /misma placa/);
  });

  await t.test('módulos: el agente de coturn caído no impide guardar; base de datos: VACUUM de una tabla que no existe', async () => {
    f.ruta('POST', '/service', crudo(200, 'no json'));
    const m = await api('POST', '/api/modules', { token: admin, body: { id: 'turn', enabled: false } });
    assert.equal(m.json.ok, true);
    assert.ok(m.json.svc.error, 'lo que dijo el agente viaja como aviso');
    const s = await api('POST', '/api/modules', { token: admin, body: { id: 'sbc', enabled: true } });
    assert.equal(s.json.enabled, true);
    assert.equal((await api('POST', '/api/db/maintenance', { token: admin, body: { table: 'tabla_que_no_existe' } })).status, 500);
    assert.equal((await api('POST', '/api/db/maintenance', { token: admin, body: { table: 'x; DROP TABLE y' } })).json.ok, true, 'un nombre raro no se interpola: VACUUM de todo');
  });

  await t.test('topología e internos con un SBC-NG adelante: el contacto dice por dónde entra cada teléfono', async () => {
    await db.query("INSERT INTO pbxng_trunks (name, kind, provider_host, provider_port) VALUES ('to-sbc','sbc','127.0.0.1',$1)", [cerrado]);
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('sbc_panel_url','https://sbc.ejemplo.uy') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    for (const id of ['3001', '3002', '3003', '3004', '3005', '3006', '3007']) {
      const r = await api('POST', '/api/endpoints', { token: admin, body: { id, password: 'Clave-' + id + '-x', name: id === '3001' ? 'Recepción' : undefined } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    await db.query(`INSERT INTO ps_contacts (id, endpoint, uri, via_addr, via_port) VALUES
      ('a','3001','sip:3001@1.2.3.4:5060;transport=ws',NULL,NULL),
      ('b','3002','sip:3002@10.9.9.9:5060',NULL,NULL),
      ('c','3003','sip:3003@127.0.0.1:5060;alias=200.1.1.1~5062~3',NULL,NULL),
      ('d','3004','sip:3004@127.0.0.1:5060','200.2.2.2',5070),
      ('e','3005','sip:3005@192.168.1.5:5060','192.168.1.5',NULL),
      ('f','3006','sip:3006@192.168.1.6:5060',NULL,NULL),
      ('g','3007','sip:3007@127.0.0.1:5060;alias=200.3.3.3~5060~9',NULL,NULL)`);
    ami.comando(/^pjsip show contacts/, [
      '  Contact:  3001/sip:3001@1.2.3.4:5060;transport=ws   abc Avail   12.5',
      '  Contact:  3002/sip:3002@10.9.9.9:5060               abc Unknown nan',
      '  Contact:  sin-ip-acá                                  x',
    ].join('\n'));
    await dormir(5200);   // el enlace al SBC se cachea 5 s
    const eps = Object.fromEntries((await api('GET', '/api/extensions', { token: admin })).json.map((e) => [e.id, e]));
    assert.deepEqual([eps['3001'].via, eps['3001'].vproto, eps['3001'].ip, eps['3001'].rtt, eps['3001'].name], ['webrtc', 'ws', '1.2.3.4', 12.5, 'Recepción']);
    assert.equal(eps['3002'].via, 'webrtc', 'lo que llega por el proxy inverso es WebRTC');
    assert.equal(eps['3002'].rtt, null, 'una latencia ilegible no se inventa');
    assert.deepEqual([eps['3003'].via, eps['3003'].origin, eps['3003'].vproto], ['sbc', '200.1.1.1:5062', 'tls']);
    assert.deepEqual([eps['3004'].via, eps['3004'].origin], ['sbc', '200.2.2.2:5070']);
    assert.deepEqual([eps['3005'].via, eps['3005'].origin], ['direct', '192.168.1.5']);
    assert.deepEqual([eps['3006'].via, eps['3006'].origin], ['direct', '192.168.1.6']);
    assert.equal(eps['3007'].vproto, 'udp', 'un transporte desconocido en el alias se toma como UDP');
    const top = await api('GET', '/api/topology', { token: admin });
    assert.equal(top.json.nodes.sbc, '127.0.0.1');
    assert.equal(top.json.sbc.panel_url, 'https://sbc.ejemplo.uy');
    assert.ok(Array.isArray(top.json.bordes_externos));
    await db.query("DELETE FROM pbxng_trunks WHERE name='to-sbc'");
    await api('POST', '/api/modules', { token: admin, body: { id: 'sbc', enabled: false } });
  });

  await t.test('internos: DTMF, WebRTC con nombre y grabación, conflicto forzado y edición campo por campo', async () => {
    ami.accion('DBPut', { Response: 'Error', Message: 'astdb ocupada' });
    ami.accion('DBDel', { Response: 'Error', Message: 'astdb ocupada' });
    const a = await api('POST', '/api/endpoints', { token: admin, body: { id: '4001', password: 'Clave-4001-x', webrtc: true, dtmf_mode: 'info', name: 'Ana', record: true } });
    assert.equal(a.status, 201);
    assert.ok(a.json.aviso, 'con el AMI sin DBPut la marca de grabación se avisa');
    const ep = (await db.query('SELECT transport, dtmf_mode, pbxng_record FROM ps_endpoints WHERE id=$1', ['4001'])).rows[0];
    assert.deepEqual([ep.transport, ep.dtmf_mode, ep.pbxng_record], ['transport-ws', 'info', true]);
    const sinDatos = await api('POST', '/api/endpoints', { token: admin, body: { id: '4002' } });
    assert.equal(sinDatos.status, 400);
    const choca = await api('POST', '/api/endpoints', { token: admin, body: { id: 'x9', password: 'Clave-x9-xx' } });
    assert.equal(choca.status, 409, 'un número fuera de formato lo frena el plan de numeración');
    assert.equal(choca.json.motivo, 'formato');
    const forzado = await api('POST', '/api/endpoints', { token: admin, body: { id: 'x9', password: 'Clave-x9-xx', force: true, dtmf_mode: 'cualquiera' } });
    assert.equal(forzado.status, 201, 'con force se crea igual');
    assert.equal((await db.query('SELECT dtmf_mode FROM ps_endpoints WHERE id=$1', ['x9'])).rows[0].dtmf_mode, 'rfc4733', 'un DTMF inventado cae en el estándar');
    const repetido = await api('POST', '/api/endpoints', { token: admin, body: { id: '4001', password: 'Clave-4001-x', force: true } });
    assert.equal(repetido.status, 409, 'un interno repetido es conflicto aunque se fuerce');
    assert.equal(repetido.json.error, 'ya existe un registro con ese valor', 'el mensaje de Postgres no sale crudo');
    await api('DELETE', '/api/endpoints/x9', { token: admin });

    const p = await api('PUT', '/api/endpoints/4001', { token: admin, body: { password: 'Nueva-4001-xx', max_contacts: 3, webrtc: true, video: true, name: 'Ana B', record: false, dtmf_mode: 'auto_info' } });
    assert.equal(p.json.webrtc, true);
    const ep2 = (await db.query('SELECT e.dtmf_mode, e.pbxng_record, a.max_contacts, u.password FROM ps_endpoints e JOIN ps_aors a ON a.id=e.id JOIN ps_auths u ON u.id=e.id WHERE e.id=$1', ['4001'])).rows[0];
    assert.deepEqual([ep2.dtmf_mode, ep2.pbxng_record, ep2.max_contacts, ep2.password], ['auto_info', false, 3, 'Nueva-4001-xx']);
    assert.ok(p.json.aviso, 'apagar la grabación sin AMI que la tome también se avisa');
    ami.accion('DBPut', { Response: 'Success' });
    ami.accion('DBDel', { Response: 'Success' });
    const q = await api('PUT', '/api/endpoints/4001', { token: admin, body: { context: 'internal' } });
    assert.equal(q.json.aviso, undefined, 'sin `record` en el cuerpo la grabación no se toca ni se avisa');
    assert.equal((await db.query('SELECT dtmf_mode, pbxng_record FROM ps_endpoints WHERE id=$1', ['4001'])).rows[0].dtmf_mode, 'auto_info', 'sin dtmf_mode queda el que estaba');
  });

  await t.test('correo: cada falla del SMTP se explica distinto', async () => {
    assert.equal((await api('POST', '/api/email/test', { token: admin, body: { to: 'a@b.uy', tenant_id: 99 } })).status, 400, 'sin configuración');
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: '127.0.0.1', port: cerrado, from_addr: 'pbx@ejemplo.uy', enabled: true } });
    const caido = await api('POST', '/api/email/test', { token: admin, body: { to: 'a@b.uy' } });
    assert.match(caido.json.error, /No se pudo conectar al servidor SMTP/);
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: '127.0.0.1', port: smtp.port, username: 'u', password: 'p', enabled: true } });
    smtp.rechazar();
    const clave = await api('POST', '/api/email/test', { token: admin, body: { to: 'a@b.uy' } });
    assert.match(clave.json.error, /rechazó la contraseña/);
    const sobre = await api('POST', '/api/email/test', { token: admin, body: { to: ',' } });
    assert.match(sobre.json.error, /destinatario|recipient/i);
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('brand_name','Central Sur') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    const ok = await api('POST', '/api/email/test', { token: admin, body: { to: 'a@b.uy' } });
    assert.equal(ok.json.ok, true);
    assert.match(smtp.mensajes.at(-1).data, /Central Sur/);
    await db.query("DELETE FROM pbxng_settings WHERE key='brand_name'");
  });

  await t.test('integraciones: WhatsApp con clave y respuestas raras del gateway; Telegram sin token', async () => {
    assert.equal((await api('PUT', '/api/integrations/whatsapp', { token: admin, body: { url: f.url + '/', apikey: 'k-1', to: '59899', enabled: true } })).json.ok, true);
    f.ruta('POST', '/sendText', crudo(200, 'no es json'));
    assert.equal((await api('POST', '/api/integrations/whatsapp/test', { token: admin })).json.ok, true, 'un 200 que no es JSON cuenta como enviado');
    assert.equal(f.pedidos('/sendText').at(-1).headers.api_key, 'k-1');
    f.ruta('POST', '/sendText', crudo(502, ''));
    assert.equal((await api('POST', '/api/integrations/whatsapp/test', { token: admin })).json.error, 'HTTP 502');
    f.ruta('POST', '/sendText', crudo(500, 'el gateway explotó'));
    assert.equal((await api('POST', '/api/integrations/whatsapp/test', { token: admin })).json.error, 'HTTP 500 el gateway explotó');
    await api('PUT', '/api/integrations/whatsapp', { token: admin, body: { url: '' } });
    assert.match((await api('POST', '/api/integrations/whatsapp/test', { token: admin })).json.error, /falta url/);
    await api('PUT', '/api/integrations/telegram', { token: admin, body: { chat_id: '123' } });
    const tg = await api('POST', '/api/integrations/telegram/test', { token: admin });
    assert.equal(tg.status, 400);
    assert.match(tg.json.error, /falta token/);
    const l = (await api('GET', '/api/integrations', { token: admin })).json;
    assert.deepEqual(l.find((x) => x.type === 'telegram'), { type: 'telegram', enabled: false, configured: false, chat_id: '123' });
    assert.equal(l.find((x) => x.type === 'whatsapp').has_apikey, true);
    assert.equal((await api('POST', '/api/integrations/sms/test', { token: admin })).status, 400);

    /* Una llamada perdida avisa a todas las integraciones encendidas; la que falla no
     * frena a la otra. */
    await api('PUT', '/api/integrations/whatsapp', { token: admin, body: { url: f.url, enabled: true } });
    await api('PUT', '/api/integrations/telegram', { token: admin, body: { enabled: true } });
    f.ruta('POST', '/sendText', { ok: true });
    f.olvidar();
    for (const [st, ln] of [['BUSY', 'L-b'], ['CANCEL', 'L-c'], ['NOANSWER', ''], ['CHANUNAVAIL', 'L-x']]) {
      ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2001-0' + st, DialStatus: st, Linkedid: ln });
    }
    ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2002-01', DialStatus: 'BUSY', CallerIDNum: '099', Linkedid: 'L-d' });
    ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2002-01', DialStatus: 'BUSY', CallerIDNum: '099', Linkedid: 'L-d' });   // repetido
    ami.emitir({ Event: 'DialEnd', DialStatus: 'BUSY' });   // sin canal destino: no es un interno
    assert.ok(await hasta(() => f.pedidos('/sendText').length >= 4));
    await dormir(300);
    const textos = f.pedidos('/sendText').map((p) => p.body.args.content);
    assert.equal(textos.length, 4, 'una por llamada perdida, sin repetir: ' + JSON.stringify(textos));
    assert.ok(textos.some((x) => /ocupado/.test(x)) && textos.some((x) => /cancelada/.test(x)) && textos.some((x) => /sin respuesta/.test(x)));
    assert.ok(textos.some((x) => /desde <b>desconocido<\/b>/.test(x)), 'sin número de origen dice desconocido');
    await api('PUT', '/api/integrations/whatsapp', { token: admin, body: { enabled: false } });
    await api('PUT', '/api/integrations/telegram', { token: admin, body: { enabled: false } });
  });

  await t.test('alertas, marca, mensajes, empresas y SMTP: los campos que no vienen toman su valor por defecto', async () => {
    await api('POST', '/api/alerts/rules', { token: admin, body: { default_to: null } });
    assert.equal((await api('GET', '/api/alerts/rules', { token: admin })).json.default_to, '');
    const ev = (await api('GET', '/api/alerts/rules', { token: admin })).json.rules[0].event;
    await api('POST', '/api/alerts/rules', { token: admin, body: { event: ev } });
    const r = (await api('GET', '/api/alerts/rules', { token: admin })).json.rules.find((x) => x.event === ev);
    assert.deepEqual([r.enabled, r.recipients, r.throttle_min], [false, null, 15]);
    await api('POST', '/api/alerts/rules', { token: admin, body: { event: ev, enabled: true, recipients: 'a@b.uy', params: { umbral: 3 }, throttle_min: 60 } });
    assert.equal((await api('GET', '/api/alerts/rules', { token: admin })).json.rules.find((x) => x.event === ev).throttle_min, 60);

    await api('POST', '/api/branding', { token: admin, body: { name: 'Mi central', tagline: null } });
    const b = (await api('GET', '/api/branding')).json;
    assert.deepEqual([b.name, b.subtitle, b.tagline], ['Mi central', 'Comunicaciones', '']);

    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1 } });
    const e = (await api('GET', '/api/email/config', { token: admin })).json.find((x) => x.tenant_id === 1);
    assert.deepEqual([e.port, e.secure, e.enabled, e.host], [587, false, false, null]);
    assert.equal(e.has_password, true, 'una clave vacía no borra la guardada');

    const pr = await api('POST', '/api/prompts', { token: admin, body: { name: 'Bienvenida!', data: Buffer.from('x').toString('base64') } });
    assert.equal(pr.json.name, 'bienvenida');
    assert.equal((await api('GET', '/api/prompts', { token: admin })).json.find((x) => x.name === 'bienvenida').format, 'wav');
    assert.equal((await api('POST', '/api/prompts', { token: admin, body: { name: '¡¡!!', data: 'eA==' } })).status, 400);
  });

  await t.test('respaldo programado: valores guardados ilegibles vuelven a los de fábrica', async () => {
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('backup_hour','las tres'),('backup_keep','0'),('backup_last_ok','0'),('backup_last_error','disco lleno') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    const s = (await api('GET', '/api/backup/schedule', { token: admin })).json;
    assert.deepEqual([s.hour, s.keep, s.last_ok, s.last_error], [3, 14, false, 'disco lleno']);
    await db.query("UPDATE pbxng_settings SET value='1' WHERE key='backup_last_ok'");
    await db.query("UPDATE pbxng_settings SET value='99' WHERE key='backup_hour'");
    assert.equal((await api('GET', '/api/backup/schedule', { token: admin })).json.last_ok, true);
    assert.equal((await api('GET', '/api/backup/schedule', { token: admin })).json.hour, 3);
    const off = await api('POST', '/api/backup/schedule', { token: admin, body: { enabled: false } });
    assert.equal(off.json.enabled, false);
    assert.equal((await api('POST', '/api/backup/schedule', { token: admin, body: { enabled: true, hour: 4, keep: 5 } })).json.enabled, true);
    assert.equal((await api('POST', '/api/backup/schedule', { token: admin, body: { keep: 0 } })).status, 400);
    assert.equal((await api('POST', '/api/backup/schedule', { token: admin, body: { enabled: 'sí' } })).status, 400);
    assert.equal((await api('GET', '/api/backup/x.tar.gz/inspeccionar', { token: admin })).status, 400, 'un respaldo que no existe');
    assert.equal((await api('DELETE', '/api/backup/x.tar.gz', { token: admin })).status, 400);
    assert.equal((await api('DELETE', '/api/backup/x.zip', { token: admin })).status, 400);
    const rest = await api('POST', '/api/backup/x.tar.gz/restaurar', { token: admin, body: { partes: ['config'], confirmar: true } });
    assert.equal(rest.status, 400);
    const sub = await fetch(ctx.api.base + '/api/backup/subir/malo.zip', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream' }, body: 'x' });
    assert.equal(sub.status, 400, 'un nombre que no es de respaldo');
  });

  await t.test('manuales: si la carpeta de imágenes no se puede usar, cada operación lo dice', async () => {
    const dir = path.join(ctx.api.confDir, 'manuales-img');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'esto no es una carpeta');
    const png = 'data:image/png;base64,' + Buffer.from('png').toString('base64');
    assert.equal((await api('POST', '/api/manuales/img/captura.png', { token: admin, body: { data: png } })).status, 500);
    assert.equal((await api('GET', '/api/manuales/img-list', { token: admin })).status, 500);
    const del = await api('DELETE', '/api/manuales/img/captura.png', { token: admin });
    assert.ok([200, 500].includes(del.status));
    fs.rmSync(dir, { force: true });
    assert.equal((await api('POST', '/api/manuales/img/captura.png', { token: admin, body: {} })).status, 400, 'sin data URL');
    const grande = 'data:image/png;base64,' + Buffer.alloc(16 * 1024 * 1024).toString('base64');
    assert.equal((await api('POST', '/api/manuales/img/grande.png', { token: admin, body: { data: grande }, timeout: 60000 })).status, 413);
    assert.equal((await api('POST', '/api/manuales/img/ok.PNG', { token: admin, body: { data: png } })).status, 200);
    const img = await fetch(ctx.api.base + '/api/manuales/img/ok.PNG', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(img.headers.get('content-type'), 'image/png', 'la extensión en mayúsculas se reconoce igual');
  });

  await t.test('sistema y tableros: módulos que faltan, colas ilegibles y el grupo de captura vacío', async () => {
    ami.comando(/^core show version/, 'Asterisk 22.2.0 built by root');
    ami.comando(/^pjsip show transports/, 'transport-tcp tcp 0.0.0.0:5060');
    ami.comando(/^module show/, 'res_pjsip.so\npbx_realtime.so\napp_queue.so\napp_voicemail.so\napp_confbridge.so\nres_http_websocket.so\ncdr_pgsql.so\nres_srtp.so');
    const s = await api('GET', '/api/system', { token: admin });
    const c = Object.fromEntries(s.json.components.map((x) => [x.name, x.status]));
    assert.equal(s.json.asterisk, '22.2.0');
    assert.equal(c['SIP UDP 5060'], 'off');
    assert.equal(c['Transporte WebSocket (ws)'], 'off');
    assert.equal(c['ARI / AMI'], 'down', 'sin ARI no está todo arriba');
    assert.equal(c.CDR, 'ok');
    ami.comando(/^module show/, '');
    const s2 = Object.fromEntries((await api('GET', '/api/system', { token: admin })).json.components.map((x) => [x.name, x.status]));
    assert.deepEqual([s2['Dialplan realtime'], s2['Buzon de voz'], s2.Conferencias, s2.WebSocket, s2['PJSIP (chan_pjsip)']], ['off', 'off', 'off', 'off', 'down']);

    const g = await api('PUT', '/api/pickup-groups/3001', { token: admin, body: {} });
    assert.equal(g.json.grupo, null, 'sin grupo se borra');
    const dp = await api('GET', '/api/dialplan?context=internal', { token: admin });
    assert.equal(dp.status, 200);
    assert.ok(ami.pedidos('Command').some((p) => p.command === 'dialplan show internal'));
    const m1 = (await api('GET', '/api/metrics', { token: admin })).json;
    const m2 = (await api('GET', '/api/metrics', { token: admin })).json;
    assert.ok(m1.cpu >= 0 && m2.cpu >= 0 && m2.cpu <= 100, 'la segunda lectura ya calcula sobre la anterior');
  });
});
