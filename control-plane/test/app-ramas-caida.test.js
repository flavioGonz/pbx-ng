/* ============================================================================
 *  Integración · con la base caída, las rutas de app.js que VALIDAN antes de tocarla.
 *
 *  base-caida.test.js recorre todas las rutas con la base cortada, pero con el cuerpo
 *  vacío: casi todas las que validan contestan 400 antes de llegar a Postgres, así que
 *  su `catch` —el que corre el día que la base se cae de verdad— nunca se ejecutaba.
 *  Acá cada una recibe un cuerpo VÁLIDO, pasa la validación y choca con la base: lo que
 *  se fija es que conteste un error JSON con status de servidor (sin el texto crudo de
 *  Postgres) o, donde el diseño dice «se sigue igual», que siga. También el socket del
 *  panel: con la base caída tiene que conectar igual, sin estado, en vez de cortarse.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Client } = require('pg');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 5000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(60); } return fn(); }

/* Cliente de socket.io mínimo (Engine.IO v4 sobre ws), igual al de app-extra. */
function socketPanel(base, auth) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket');
  const eventos = [];
  let conectado = null;
  const listo = new Promise((ok) => {
    ws.on('message', (d) => {
      const s = String(d);
      if (s[0] === '0') ws.send('40' + JSON.stringify(auth || {}));
      else if (s === '2') ws.send('3');
      else if (s.startsWith('40')) { conectado = true; ok(); }
      else if (s.startsWith('44')) ok();
      else if (s.startsWith('42')) eventos.push(JSON.parse(s.slice(2)));
    });
    ws.on('error', () => ok());
  });
  return { listo, eventos, get conectado() { return conectado; }, emitir: (n, d) => ws.send('42' + JSON.stringify(d === undefined ? [n] : [n, d])), cerrar: () => { try { ws.close(); } catch (_) {} } };
}

/* Errores de Postgres que no pueden llegar crudos al panel. */
const CRUDO = /relation |Connection terminated|ECONNREFUSED|does not allow connections|terminating connection/i;

test('con la base caída, las rutas que validan primero igual contestan bien', async (t) => {
  const ami = await amiFalso();
  const ctx = await entorno(t, ami.env);
  if (!ctx) { await ami.cerrar(); return; }
  const { api, login, base } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  assert.equal((await api('POST', '/api/endpoints', { token: admin, body: { id: '2001', password: 'Clave-2001-xx' } })).status, 201);
  await api('POST', '/api/users', { token: admin, body: { username: 'ana', password: 'Clave-ana-1234', role: 'agente', ext: '2001' } });
  const ana = (await login('ana', 'Clave-ana-1234')).token;
  const link = (await api('POST', '/api/c2c', { token: admin, body: { name: 'Web', dest_value: '2001' } })).json;

  /* Cortar la base como en base-caida: nadie se conecta y se echa a los que estaban. */
  const adm = new Client({ host: ctx.db.env.DB_HOST, port: +ctx.db.env.DB_PORT, user: ctx.db.env.DB_USER, password: ctx.db.env.DB_PASS, database: 'postgres' });
  adm.on('error', () => {});
  await adm.connect();
  const nombre = ctx.db.env.DB_NAME;
  ctx.db.pool.on('error', () => {});
  const abrir = async () => { try { await adm.query('ALTER DATABASE "' + nombre + '" WITH ALLOW_CONNECTIONS true'); } catch (_) {} };
  t.after(async () => { await abrir(); await adm.end().catch(() => {}); await ctx.cerrar(); await ami.cerrar(); });
  await adm.query('ALTER DATABASE "' + nombre + '" WITH ALLOW_CONNECTIONS false');
  await adm.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()', [nombre]);
  assert.ok(await hasta(async () => (await api('GET', '/health')).status === 503), 'la API no se enteró de que la base se cayó');

  await t.test('cada ruta con cuerpo válido contesta un error de servidor en JSON, sin el texto de Postgres', async () => {
    const casos = [
      ['GET', '/api/agent/state', ana],
      ['POST', '/api/push/subscribe', null, { ext: '2001', subscription: { endpoint: 'https://push.ejemplo/x', keys: { p256dh: 'a', auth: 'b' } } }],
      ['POST', '/api/push/register', null, { ext: '2001', provider: 'fcm', prid: 'tok' }],
      ['POST', '/api/geo/report', null, { lat: -34.9, lng: -56.1 }],
      ['POST', '/api/alerts/rules', admin, { default_to: 'a@b.uy' }],
      ['POST', '/api/branding', admin, { name: 'X' }],
      ['POST', '/api/email/config', admin, { tenant_id: 1, host: 'smtp.x' }],
      ['POST', '/api/prompts', admin, { name: 'hola', data: 'eA==' }],
      ['POST', '/api/phones', admin, { mac: '00:15:65:aa:bb:cc', ext: '2001' }],
      ['PUT', '/api/phones/1', admin, { ext: '2001' }],
      ['POST', '/api/capture/start', admin, { preset: 'sip' }],
      ['PUT', '/api/net/mode', admin, { modo: 'router' }],
      ['POST', '/api/modules', admin, { id: 'voz', enabled: true }],
      ['POST', '/api/sysprompts/generate', admin, { names: ['beep'] }],
      ['POST', '/api/c2c', admin, { name: 'Web 2', dest_value: '2001' }],
      ['POST', '/api/endpoints', admin, { id: '2002', password: 'Clave-2002-xx' }],
      ['PUT', '/api/endpoints/2001', admin, { name: 'Ana' }],
      ['DELETE', '/api/endpoints/2001', admin],
      ['PUT', '/api/integrations/telegram', admin, { chat_id: '1' }],
      ['POST', '/api/settings', admin, { cualquier: 'cosa' }],
      ['POST', '/api/sip/toggle', admin, { on: true }],
      ['GET', '/api/intercom/ticket?src=cam1', admin],
      ['POST', '/api/backup/schedule', admin, { hour: 3 }],
      ['POST', '/api/clients/1/devices', admin, { label: 'Portón' }],
      ['PUT', '/api/devices/1', admin, { rele_cfg: { host: 'x' } }],
      ['POST', '/api/devices/1/rele', admin, { rele: 0 }],
      ['POST', '/api/ai-agents/salud', admin],
    ];
    for (const [m, r, tok, body] of casos) {
      const x = await api(m, r, { token: tok || undefined, body });
      assert.ok(x.status >= 500, m + ' ' + r + ' → ' + x.status + ' ' + JSON.stringify(x.json));
      assert.ok(x.json && x.json.error, m + ' ' + r + ' sin {error}');
      assert.doesNotMatch(String(x.json.error), CRUDO, m + ' ' + r + ' filtró el error de Postgres');
    }
  });

  await t.test('lo que por diseño sigue sin base: pausa del agente, prueba de push, aprovisionamiento y el aviso de correo', async () => {
    const p = await api('POST', '/api/agent/pause', { token: ana, body: { paused: true } });
    assert.deepEqual(p.json, { ext: '2001', paused: true }, 'la pausa se contesta aunque no se haya podido anotar');
    const push = await api('POST', '/api/push/test', { token: admin, body: { ext: '2001' } });
    assert.deepEqual(push.json, { ok: true, sent: 0 });
    const prov = await fetch(base + '/prov/001565aabbcc.cfg');
    assert.equal(prov.status, 500);
    assert.equal(await prov.text(), 'error', 'al teléfono no le llega el detalle');
    const s = await api('POST', '/api/c2c/public/' + link.token + '/session', { body: { name: 'Juana' } });
    assert.ok(s.status >= 500 && s.json.error);
    const mail = await api('POST', '/api/email/test', { token: admin, body: { to: 'a@b.uy' } });
    assert.equal(mail.status, 500);
    assert.ok(mail.json.error, 'el error de la base viaja como texto del aviso');
    const ap = await api('POST', '/api/net/mode/apply', { token: admin, body: { confirmar: true } });
    assert.equal(ap.status, 400);
    const npm = await api('POST', '/api/npm/test', { token: admin });
    assert.equal(npm.json.ok, false, 'probar el NPM sin base dice que no, no se cuelga');
    const al = await api('POST', '/api/alerts/test', { token: admin, body: { event: 'trunk.down' } });
    assert.ok(al.status === 200 || al.status >= 500, 'la alerta de prueba contesta');
    assert.ok(al.json.error, 'sin base no se pudo mandar y se dice');
    assert.equal((await api('POST', '/api/intercom/sync', { token: admin })).json.ok, true, 'el barrido de go2rtc no falla aunque no pueda leer la base');
    /* El agente de Asterisk tampoco está (puerto cerrado): cada consola lo dice. */
    for (const [m, r] of [['GET', '/api/asterisk/net'], ['POST', '/api/asterisk/route'], ['POST', '/api/asterisk/diag'], ['POST', '/api/asterisk/iface']]) {
      const x = await api(m, r, { token: admin, body: m === 'POST' ? { x: 1 } : undefined });
      assert.equal(x.status, 500, r);
      assert.ok(x.json.error, r);
    }
  });

  await t.test('el socket del panel conecta igual y una llamada perdida no tumba el aviso a integraciones', async () => {
    const s = socketPanel(base, { token: admin });
    await s.listo;
    assert.equal(s.conectado, true, 'sin base el panel igual se conecta');
    await dormir(1100);
    s.emitir('snapshot:pedir');
    ami.emitir({ Event: 'Newchannel' });   // dispara el refresco por eventos, que también falla
    ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2001-77', DialStatus: 'NOANSWER', CallerIDNum: '099', Linkedid: 'L-caida' });
    await dormir(600);
    assert.equal((await api('GET', '/health')).status, 503, 'la API sigue viva');
    s.cerrar();
  });

  await t.test('sin AMI y sin base la pausa del agente igual contesta', async () => {
    ami.cortar();
    await ami.cerrar();
    /* asterisk-manager avisa el corte con 'close' (no 'disconnect'): si la API escuchara
     * el nombre equivocado, /health seguiría diciendo AMI arriba y la pausa de abajo
     * quedaría colgada esperando una respuesta de un socket muerto. */
    assert.ok(await hasta(async () => (await api('GET', '/health')).json.ami === false), '/health sigue diciendo que el AMI está arriba');
    const p = await api('POST', '/api/agent/pause', { token: ana, body: { paused: false, reason: 'almuerzo' }, timeout: 3000 });
    assert.deepEqual(p.json, { ext: '2001', paused: false });
  });

  await t.test('la base vuelve y la API se recupera sola', async () => {
    await abrir();
    assert.ok(await hasta(async () => (await api('GET', '/health')).status === 200, 15000), 'no volvió a ok');
  });
});
