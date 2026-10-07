/* ============================================================================
 *  Integración · las aplicaciones de la central (apps.js): buzón de voz leído del
 *  volumen, buzón → correo, PIN de los buzones, IVR, agentes de IA, colas con sus
 *  anuncios por TTS, grupos de timbrado, voceo, aparcado y música en espera.
 *
 *  El servicio de voz y el agente de Asterisk son http-falso, el AMI es ami-falso y
 *  el correo smtp-falso. El buzón se arma a mano en VM_DIR como lo deja Asterisk.
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

/* Un WAV PCM 16-bit mono de verdad: wavToPcm lo tiene que poder leer. */
function wav(ms = 200, rate = 8000) {
  const n = Math.round(rate * ms / 1000), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

test('aplicaciones: buzones, IVR, IA, colas, grupos, voceo, aparcado y música', async (t) => {
  const ami = await amiFalso();
  const svc = await httpFalso();
  const smtp = await smtpFalso();
  t.after(async () => { await ami.cerrar(); await svc.cerrar(); await smtp.cerrar(); });
  const ctx = await entorno(t, Object.assign({}, ami.env, { AST_AGENT: svc.url, AST_MOH_DIR: path.join(require('os').tmpdir(), 'pbxng-moh-' + process.pid) }));
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login, base } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  await ctx.db.query("INSERT INTO pbxng_settings (key,value) VALUES ('voz_url',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [svc.url]);
  svc.ruta('POST', '/tts', crudo(200, wav(), { 'Content-Type': 'audio/wav' }));
  svc.ruta('POST', '/sound', (p) => ({ ok: true, ref: 'custom/' + p.body.name }));
  svc.ruta('POST', '/stt', { text: 'Hola, llamo por la factura de setiembre' });

  /* Un interno con su buzón, y un mensaje en INBOX como lo deja Asterisk. */
  assert.equal((await api('POST', '/api/endpoints', { token: admin, body: { id: '2001', password: 'Clave-2001-xx' } })).status, 201);
  const VM = path.join(ctx.api.confDir, 'vm', 'default', '2001');
  const ponerMensaje = (carpeta, id, meta) => {
    fs.mkdirSync(path.join(VM, carpeta), { recursive: true });
    fs.writeFileSync(path.join(VM, carpeta, id + '.txt'), ';\n[message]\n' + Object.entries(meta).map(([k, v]) => k + '=' + v).join('\n') + '\n');
    fs.writeFileSync(path.join(VM, carpeta, id + '.wav'), wav());
  };
  ponerMensaje('INBOX', 'msg0000', { callerid: '"Juan" <099123>', origtime: 1700000100, duration: 7 });
  ponerMensaje('Old', 'msg0000', { callerid: '099999', origtime: 1700000000, duration: 3 });
  await api('POST', '/api/users', { token: admin, body: { username: 'ana', password: 'Clave-ana-1234', role: 'agente', ext: '2001' } });
  const ana = (await login('ana', 'Clave-ana-1234')).token;

  await t.test('buzón visual: el propio sí, el de otro no; escuchar, transcribir, marcar leído y borrar', async () => {
    assert.equal((await api('GET', '/api/vm?ext=2002', { token: ana })).status, 403);
    const l = (await api('GET', '/api/vm?ext=2001', { token: ana })).json;
    assert.deepEqual(l.map((m) => [m.folder, m.new, m.duration]), [['INBOX', true, 7], ['Old', false, 3]]);
    const a = await fetch(base + '/api/vm/audio?ext=2001&folder=INBOX&id=msg0000', { headers: { Authorization: 'Bearer ' + ana } });
    assert.equal(a.status, 200);
    assert.equal((await api('GET', '/api/vm/audio?ext=2001&folder=INBOX&id=noexiste', { token: ana })).status, 404);

    assert.equal((await api('POST', '/api/vm/transcribe', { token: ana, body: { ext: '2001' } })).status, 400);
    assert.equal((await api('POST', '/api/vm/transcribe', { token: ana, body: { ext: '2001', id: 'nada' } })).status, 404);
    const tr = await api('POST', '/api/vm/transcribe', { token: ana, body: { ext: '2001', folder: 'INBOX', id: 'msg0000' } });
    assert.equal(tr.status, 200, JSON.stringify(tr.json));
    assert.match(tr.json.transcript, /factura/);
    assert.ok(tr.json.analysis);
    svc.ruta('POST', '/stt', crudo(503, 'no'));
    assert.equal((await api('POST', '/api/vm/transcribe', { token: ana, body: { ext: '2001', id: 'msg0000' } })).status, 502);
    svc.ruta('POST', '/stt', { text: 'Hola, llamo por la factura de setiembre' });
    fs.writeFileSync(path.join(VM, 'INBOX', 'msg0009.wav'), Buffer.from('RIFF basura'));
    assert.equal((await api('POST', '/api/vm/transcribe', { token: ana, body: { ext: '2001', id: 'msg0009' } })).status, 422);
    fs.rmSync(path.join(VM, 'INBOX', 'msg0009.wav'));

    const r = await api('POST', '/api/vm/read', { token: ana, body: { ext: '2001', id: 'msg0000' } });
    assert.equal(r.json.id, 'msg0001', 'pasa a Old con el primer número libre');
    assert.ok(fs.existsSync(path.join(VM, 'Old', 'msg0001.wav')));
    assert.equal((await api('POST', '/api/vm/del', { token: ana, body: { ext: '2001', folder: 'Old', id: 'msg0001' } })).json.ok, true);
    assert.equal(fs.existsSync(path.join(VM, 'Old', 'msg0001.wav')), false);
    assert.equal((await api('POST', '/api/vm/del', { token: ana, body: { ext: '2002' } })).status, 403);
    assert.equal((await api('POST', '/api/vm/read', { token: ana, body: { ext: '2002' } })).status, 403);
  });

  await t.test('buzón → correo: configurar, sin SMTP no se manda, con SMTP manda con la transcripción y el WAV', async () => {
    assert.equal((await api('POST', '/api/vm/email', { token: admin, body: {} })).status, 400);
    await api('POST', '/api/vm/email', { token: admin, body: { mailbox: '2001', email: 'ana@ejemplo.uy', email_delete: false } });
    const cfg = (await api('GET', '/api/vm/email', { token: admin })).json.find((b) => b.mailbox === '2001');
    assert.equal(cfg.email, 'ana@ejemplo.uy');
    ponerMensaje('INBOX', 'msg0005', { callerid: '099777', origtime: 1700000500, duration: 4 });
    assert.equal((await api('POST', '/api/vm/email/send', { token: admin, body: {} })).status, 400);
    const sin = await api('POST', '/api/vm/email/send', { token: admin, body: { mailbox: '2001', id: 'msg0005' } });
    assert.match(sin.json.error, /sin configuración SMTP/);
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: smtp.host, port: smtp.port, from_addr: 'central@ejemplo.uy', enabled: true } });
    smtp.olvidar();
    const ok = await api('POST', '/api/vm/email/send', { token: admin, body: { mailbox: '2001', id: 'msg0005' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.to, 'ana@ejemplo.uy');
    const [m] = await smtp.esperar(1);
    assert.match(m.data, /factura/, 'la transcripción viaja en el correo');
    assert.match(m.data, /mensaje-2001-msg0005\.wav/, 'el WAV va adjunto');
    const sinMail = await api('POST', '/api/vm/email/send', { token: admin, body: { mailbox: '9999', id: 'x' } });
    assert.match(sinMail.json.error, /no tiene email/);
  });

  await t.test('PIN de los buzones: alta con PIN al azar, débil rechazado, detalle, rotar de a uno y en lote', async () => {
    assert.equal((await api('POST', '/api/mailboxes', { token: admin, body: {} })).status, 400);
    assert.equal((await api('POST', '/api/mailboxes', { token: admin, body: { mailbox: '20a' } })).status, 400);
    assert.equal((await api('POST', '/api/mailboxes', { token: admin, body: { mailbox: '3001', password: '12' } })).status, 400);
    assert.equal((await api('POST', '/api/mailboxes', { token: admin, body: { mailbox: '3001', password: '3001' } })).status, 400);
    const n = await api('POST', '/api/mailboxes', { token: admin, body: { mailbox: '3001', fullname: 'Caja', email: 'caja@ejemplo.uy' } });
    assert.equal(n.status, 201);
    assert.match(n.json.pin, /^\d{4,10}$/);
    const ya = await api('POST', '/api/mailboxes', { token: admin, body: { mailbox: '3001', password: '987654' } });
    assert.equal(ya.json.ya_existia, true, 'el PIN que vuelve es el que quedó, no el pedido');
    assert.equal(ya.json.pin, n.json.pin);
    /* Un buzón viejo con el PIN igual al número. */
    await ctx.db.query("INSERT INTO voicemail (mailbox, context, password, fullname) VALUES ('3002','default','3002','Viejo')");
    const lista = (await api('GET', '/api/mailboxes', { token: admin })).json;
    assert.equal(lista.find((b) => b.mailbox === '3002').pin_debil, true);
    assert.equal(JSON.stringify(lista).includes(n.json.pin), false, 'el listado no trae los PIN');
    assert.equal((await api('GET', '/api/mailboxes/3001', { token: admin })).json.pin, n.json.pin);
    assert.equal((await api('GET', '/api/mailboxes/9999', { token: admin })).status, 404);

    assert.equal((await api('POST', '/api/mailboxes/3001/pin', { token: admin, body: { pin: '3001' } })).status, 400);
    assert.equal((await api('POST', '/api/mailboxes/3001/pin', { token: admin, body: { pin: 'abc' } })).status, 400);
    assert.equal((await api('POST', '/api/mailboxes/9999/pin', { token: admin, body: {} })).status, 404);
    smtp.olvidar();
    const rot = await api('POST', '/api/mailboxes/3001/pin', { token: admin, body: { pin: '24680' } });
    assert.deepEqual(rot.json, { mailbox: '3001', pin: '24680', avisado: true });
    const [aviso] = await smtp.esperar(1);
    assert.deepEqual(aviso.to, ['caja@ejemplo.uy']);
    assert.doesNotMatch(aviso.data.split('\n').find((l) => /^Subject:/.test(l)), /24680/, 'el PIN no va en el asunto');

    assert.equal((await api('POST', '/api/mailboxes/rotar-pin', { token: admin, body: {} })).status, 400, 'no hay «rotar todos» implícito');
    assert.deepEqual((await api('POST', '/api/mailboxes/rotar-pin', { token: admin, body: { mailboxes: [] } })).json, { rotados: 0, avisados: 0, resultados: [] });
    assert.equal((await api('POST', '/api/mailboxes/rotar-pin', { token: admin, body: { mailboxes: Array.from({ length: 201 }, (_, i) => String(i)) } })).status, 400);
    const lote = await api('POST', '/api/mailboxes/rotar-pin', { token: admin, body: { mailboxes: ['3001', '3002', 'x1', '7777', '3001'] } });
    const por = Object.fromEntries(lote.json.resultados.map((r) => [r.mailbox, r]));
    assert.equal(por['3001'].avisado, true);
    assert.equal(por['3001'].pin, null, 'a quien se le avisó, el PIN no vuelve en la respuesta');
    assert.match(por['3002'].pin, /^\d+$/, 'al que no tiene correo hay que dictárselo');
    assert.match(por.x1.error, /sólo dígitos/);
    assert.match(por['7777'].error, /no existe/);
    assert.equal(lote.json.rotados, 2);
    await ctx.db.query("UPDATE voicemail SET password='3002' WHERE mailbox='3002'");
    const deb = await api('POST', '/api/mailboxes/rotar-pin', { token: admin, body: { solo_debiles: true } });
    assert.ok(deb.json.resultados.some((r) => r.mailbox === '3002' && r.ok));
    assert.equal((await api('DELETE', '/api/mailboxes/3002', { token: admin })).json.deleted, '3002');
  });

  await t.test('IVR: audio por TTS desplegado al agente, menú con todos los destinos, edición y baja', async () => {
    assert.equal((await api('POST', '/api/ivr/gen-audio', { token: admin, body: {} })).status, 400);
    const g = await api('POST', '/api/ivr/gen-audio', { token: admin, body: { text: 'Para ventas marque 1', name: 'menu principal!' } });
    assert.deepEqual(g.json, { ok: true, ref: 'custom/menuprincipal', name: 'menuprincipal' });
    const aud = (await api('GET', '/api/ivr/audios', { token: admin })).json;
    assert.equal(aud[0].name, 'menuprincipal');
    svc.ruta('POST', '/sound', { ok: false, error: 'disco lleno' });
    assert.match((await api('POST', '/api/ivr/gen-audio', { token: admin, body: { text: 'x' } })).json.error, /disco lleno/);
    svc.ruta('POST', '/tts', crudo(200, ''));
    assert.match((await api('POST', '/api/ivr/gen-audio', { token: admin, body: { text: 'x' } })).json.error, /vacío/);
    svc.ruta('POST', '/tts', crudo(200, wav(), { 'Content-Type': 'audio/wav' }));
    svc.ruta('POST', '/sound', (p) => ({ ok: true, ref: 'custom/' + p.body.name }));
    await api('DELETE', '/api/ivr/audios/' + aud[0].id, { token: admin });

    assert.equal((await api('POST', '/api/ivr', { token: admin, body: {} })).status, 400);
    const opciones = [
      { digit: '1', dest_type: 'extension', dest_value: '2001' }, { digit: '2', dest_type: 'ringgroup', dest_value: '600' },
      { digit: '3', dest_type: 'queue', dest_value: 'ventas' }, { digit: '4', dest_type: 'voicemail', dest_value: '2001' },
      { digit: '5', dest_type: 'ivr', dest_value: '8001' }, { digit: '6', dest_type: 'colgar' },
    ];
    const iv = await api('POST', '/api/ivr', { token: admin, body: { name: 'Principal', exten: '8000', greeting: 'custom/menu', timeout: 5, options: opciones, record: true } });
    assert.equal(iv.status, 201);
    const dp = (await ctx.db.query("SELECT priority, app, appdata FROM extensions WHERE context='ivr' AND exten='8000' ORDER BY priority")).rows;
    assert.equal(dp[1].app, 'MixMonitor');
    assert.match(dp[1].appdata, /^pbxng-ivr8000-/);
    assert.equal(dp[2].appdata, 'SEL,custom/menu,1,,1,5');
    const app = (p) => dp.find((r) => r.priority === p);
    assert.equal(app(101).appdata, 'PJSIP/2001,30,${DIAL_OPCIONES}');
    assert.equal(app(111).appdata, 'internal,600,1');
    assert.equal(app(121).app, 'Queue');
    assert.equal(app(131).appdata, '2001@default,u');
    assert.equal(app(141).appdata, 'ivr,8001,1');
    assert.equal(app(151).app, 'Hangup');
    assert.equal((await api('GET', '/api/ivr', { token: admin })).json[0].options.length, 6);
    assert.equal((await api('PUT', '/api/ivr/' + iv.json.created, { token: admin, body: {} })).status, 400);
    assert.equal((await api('PUT', '/api/ivr/999999', { token: admin, body: { name: 'x', exten: '1' } })).status, 404);
    await api('PUT', '/api/ivr/' + iv.json.created, { token: admin, body: { name: 'Principal', exten: '8005', options: [] } });
    assert.equal((await ctx.db.query("SELECT count(*)::int n FROM extensions WHERE context='ivr' AND exten='8000'")).rows[0].n, 0, 'el número viejo se borra del dialplan');
    await api('DELETE', '/api/ivr/' + iv.json.created, { token: admin });
    assert.equal((await ctx.db.query("SELECT count(*)::int n FROM extensions WHERE context='ivr' AND exten='8005'")).rows[0].n, 0);
  });

  let agenteId;
  await t.test('agentes de IA: proveedor desconocido, IA externa incompleta, alta, edición y baja', async () => {
    assert.ok((await api('GET', '/api/ai-agents/proveedores', { token: admin })).json['openai-realtime']);
    assert.ok((await api('GET', '/api/ai-agents/herramientas', { token: admin })).json.length > 0);
    assert.equal((await api('POST', '/api/ai-agents', { token: admin, body: {} })).status, 400);
    const malo = await api('POST', '/api/ai-agents', { token: admin, body: { name: 'x', exten: '8100', provider: 'openai-realtme' } });
    assert.match(malo.json.error, /proveedor desconocido/);
    const ext = await api('POST', '/api/ai-agents', { token: admin, body: { name: 'x', exten: '8100', provider: 'ia-externa', externo_url: 'ftp://x', herramientas: { abrir_porton: { on: true, dtmf: '12Z' } } } });
    assert.match(ext.json.error, /falta el token del backend/);
    assert.match(ext.json.error, /falta un destino/);
    assert.match(ext.json.error, /0-9, \*, # y A-D/);

    const a = await api('POST', '/api/ai-agents', { token: admin, body: {
      name: 'Portero', exten: '8100', provider: 'openai-realtime', model: 'gpt-live-1', record: true,
      inact1_s: 500, inact2_s: -3, herramientas: { abrir_porton: { on: true }, inventada: { on: true }, delegacion: { model: 'gpt-5.1' }, remoto: { on: true, url: 'https://bo', token: 't', tope_ms: 99999 } },
    } });
    assert.equal(a.status, 201, JSON.stringify(a.json));
    agenteId = a.json.created;
    const fila = (await api('GET', '/api/ai-agents', { token: admin })).json[0];
    assert.equal(fila.inact1_s, 120, 'la inactividad tiene techo de 120 s');
    assert.equal(fila.inact2_s, 0);
    assert.equal(fila.herramientas.inventada, undefined, 'una herramienta fuera del catálogo no se guarda');
    assert.equal(fila.herramientas.delegacion.model, '', 'un modelo retirado se guarda como «el default»');
    assert.equal(fila.herramientas.remoto.tope_ms, 10000);
    const dp = (await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='ivr' AND exten='8100' ORDER BY priority")).rows;
    assert.deepEqual(dp.map((r) => r.app), ['NoOp', 'Answer', 'MixMonitor', 'Stasis', 'Hangup']);
    assert.equal(dp[3].appdata, 'pbxng,ai,' + agenteId);
    assert.doesNotMatch(dp[2].appdata, /,b$/, 'la IA no se graba con `b`: nunca se puentea');

    assert.equal((await api('PUT', '/api/ai-agents/999999', { token: admin, body: { name: 'x', exten: '1', provider: 'demo' } })).status, 404);
    assert.equal((await api('PUT', '/api/ai-agents/' + agenteId, { token: admin, body: { name: 'x', exten: '1', provider: 'nada' } })).status, 400);
    const u = await api('PUT', '/api/ai-agents/' + agenteId, { token: admin, body: { name: 'Portero', exten: '8101', provider: 'demo' } });
    assert.equal(u.json.exten, '8101');
    assert.equal((await ctx.db.query("SELECT count(*)::int n FROM extensions WHERE context='ivr' AND exten='8100'")).rows[0].n, 0);
    assert.ok(Array.isArray((await api('GET', '/api/ai-agents/acciones?limite=9999', { token: admin })).json));
    assert.equal((await api('POST', '/api/ai-agents/probar-backoffice', { token: admin, body: {} })).status, 400);
    svc.ruta('GET', '/bo/herramientas', { herramientas: [{ nombre: 'consultar_saldo', descripcion: 'Saldo de la cuenta', parametros: {} }] });
    const bo = await api('POST', '/api/ai-agents/probar-backoffice', { token: admin, body: { url: svc.url + '/bo', token: 'x' } });
    assert.equal(bo.status, 200);
    assert.ok('descartes' in bo.json);
  });

  await t.test('colas: alta con anuncios por TTS, destino al vencer, el agente de IA como miembro, y baja', async () => {
    assert.equal((await api('POST', '/api/queues', { token: admin, body: {} })).status, 500, 'sin nombre');
    assert.equal((await api('POST', '/api/queues', { token: admin, body: { name: 'ventas' } })).status, 400);
    const q = await api('POST', '/api/queues', { token: admin, body: {
      name: 'ventas', access_exten: '8200', label: 'Ventas', strategy: 'leastrecent', record: true, max_wait: 60,
      timeout_dest: 'ext', timeout_value: '2001', welcome_text: 'Bienvenido a ventas', periodic_text: 'Ya lo atendemos',
      ia_modo: 'desborde', ia_agente_id: agenteId, ia_simultaneas: 3, monitor_type: 'otra',
    } });
    assert.equal(q.status, 201, JSON.stringify(q.json));
    assert.equal(q.json.strategy, 'leastrecent');
    assert.equal(q.json.welcome_ref, 'custom/q_ventas_welcome');
    assert.equal(q.json.periodic_announce, 'custom/q_ventas_periodic');
    assert.equal(q.json.monitor_type, null);
    const dp = (await ctx.db.query("SELECT app, appdata FROM extensions WHERE context='ivr' AND exten='8200' ORDER BY priority")).rows;
    assert.deepEqual(dp.map((r) => r.app), ['NoOp', 'Answer', 'MixMonitor', 'Playback', 'Queue', 'Goto', 'Hangup']);
    assert.equal(dp[4].appdata, 'ventas,tT,,,60');
    assert.equal(dp[5].appdata, 'internal,2001,1');
    const ia = (await ctx.db.query("SELECT interface, penalty FROM queue_members WHERE queue_name='ventas' ORDER BY interface")).rows;
    assert.deepEqual(ia.map((m) => [m.interface, m.penalty]), [['Local/iaventas_1@ivr', 1], ['Local/iaventas_2@ivr', 1], ['Local/iaventas_3@ivr', 1]], 'en desborde la IA va con penalidad 1');

    for (const [dest, val, appEsperada] of [['voicemail', '2001', 'VoiceMail'], ['queue', 'soporte', 'Queue'], ['ivr', '8000', 'Goto'], ['hangup', '', 'Hangup']]) {
      const r = await api('PUT', '/api/queues/ventas', { token: admin, body: { timeout_dest: dest, timeout_value: val, welcome_text: 'Bienvenido a ventas', periodic_text: '' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const d = (await ctx.db.query("SELECT app FROM extensions WHERE context='ivr' AND exten='8200' ORDER BY priority")).rows.map((x) => x.app);
      assert.ok(d.includes(appEsperada), dest);
    }
    assert.equal((await api('GET', '/api/queues/ventas/live', { token: admin })).status, 200);
    /* Sin tocar la IA desde otra solapa: no se apaga. Apagarla limpia los miembros. */
    await api('PUT', '/api/queues/ventas', { token: admin, body: { label: 'Ventas 2' } });
    assert.equal((await ctx.db.query("SELECT count(*)::int n FROM queue_members WHERE queue_name='ventas' AND interface LIKE 'Local/ia%'")).rows[0].n, 3);
    await api('PUT', '/api/queues/ventas', { token: admin, body: { ia_modo: 'apagado' } });
    assert.equal((await ctx.db.query("SELECT count(*)::int n FROM queue_members WHERE queue_name='ventas' AND interface LIKE 'Local/ia%'")).rows[0].n, 0);

    assert.equal((await api('POST', '/api/queues/ventas/members', { token: admin, body: {} })).status, 400);
    assert.equal((await api('POST', '/api/queues/ventas/members', { token: admin, body: { ext: '2001' } })).status, 201);
    assert.equal((await api('GET', '/api/queues', { token: admin })).json[0].members, '1');
    assert.equal((await api('DELETE', '/api/queues/ventas/members/2001', { token: admin })).json.removed, '2001');
    assert.equal((await api('POST', '/api/queues/preview-announce', { token: admin, body: {} })).status, 400);
    const prev = await fetch(base + '/api/queues/preview-announce', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hola' }) });
    assert.equal(prev.headers.get('content-type'), 'audio/wav');
    svc.ruta('POST', '/tts', crudo(200, ''));
    assert.equal((await api('POST', '/api/queues/preview-announce', { token: admin, body: { text: 'x' } })).status, 500);
    svc.ruta('POST', '/tts', crudo(200, wav(), { 'Content-Type': 'audio/wav' }));
    assert.equal((await api('DELETE', '/api/queues/ventas', { token: admin })).json.deleted, 'ventas');
    assert.equal((await ctx.db.query("SELECT count(*)::int n FROM extensions WHERE context='ivr' AND exten='8200'")).rows[0].n, 0);
  });

  await t.test('grupos de timbrado y voceo', async () => {
    assert.equal((await api('POST', '/api/ringgroups', { token: admin, body: { name: 'g' } })).status, 400);
    assert.equal((await api('POST', '/api/ringgroups', { token: admin, body: { name: 'g', access_exten: '600', members: '2001', ring_time: '20,m' } })).status, 400, 'una coma no mete opciones en el Dial');
    assert.equal((await api('POST', '/api/ringgroups', { token: admin, body: { name: 'g', access_exten: '600', members: '2001', ring_time: 3 } })).status, 400);
    assert.equal((await api('POST', '/api/ringgroups', { token: admin, body: { name: 'g', access_exten: '600', members: '2001, 2002,' } })).status, 201);
    const d = (await ctx.db.query("SELECT appdata FROM extensions WHERE context='ivr' AND exten='600' AND app='Dial'")).rows[0];
    assert.equal(d.appdata, 'PJSIP/2001&PJSIP/2002,25,${DIAL_OPCIONES}');
    assert.equal((await api('GET', '/api/ringgroups', { token: admin })).json[0].members, '2001,2002');
    assert.equal((await api('DELETE', '/api/ringgroups/g', { token: admin })).json.deleted, 'g');
    assert.equal((await api('POST', '/api/paging', { token: admin, body: { name: 'p' } })).status, 400);
    assert.equal((await api('POST', '/api/paging', { token: admin, body: { name: 'p', access_exten: '650', members: '2001,2002' } })).status, 201);
    const pg = (await ctx.db.query("SELECT appdata FROM extensions WHERE context='ivr' AND exten='650' AND app='Page'")).rows[0];
    assert.equal(pg.appdata, 'PJSIP/2001&PJSIP/2002,i');
    assert.equal((await api('GET', '/api/paging', { token: admin })).json.length, 1);
    assert.equal((await api('DELETE', '/api/paging/p', { token: admin })).json.deleted, 'p');
  });

  await t.test('aparcado: configuración, aplicar recarga el módulo, y las plazas ocupadas salen del AMI', async () => {
    const g = await api('GET', '/api/parking', { token: admin });
    assert.deepEqual(g.json, { parkext: '700', desde: 701, hasta: 720, parkingtime: 300, comebacktoorigin: true });
    await api('PUT', '/api/parking', { token: admin, body: { parkext: '7a0', desde: '801', hasta: '803', parkingtime: '5', comebacktoorigin: false } });
    ami.olvidar();
    const ap = await api('POST', '/api/parking/apply', { token: admin });
    assert.deepEqual(ap.json.cfg, { parkext: '70', desde: 801, hasta: 803, parkingtime: 10, comebacktoorigin: false });
    assert.ok(ami.pedidos('Command').some((c) => c.command === 'module reload res_parking.so'));
    assert.match(fs.readFileSync(path.join(ctx.api.confDir, 'pbxng.d', 'parking.conf'), 'utf8'), /parkpos = 801-803/);

    ami.lista('ParkedCalls', [{ Event: 'ParkedCall', ParkingSpace: '802', ParkeeChannel: 'PJSIP/2001-01', ParkeeCallerIDNum: '099123', ParkeeCallerIDName: 'Juan', ParkerDialString: 'PJSIP/2002', ParkingTimeout: '45' }], 'ParkedCallsComplete');
    const l = await api('GET', '/api/parking/lots', { token: admin });
    assert.equal(l.json.total, 3);
    assert.equal(l.json.ocupadas, 1, 'la llamada aparcada tiene que aparecer: antes la tabla decía que todo estaba libre');
    const p802 = l.json.plazas.find((p) => p.plaza === 802);
    assert.equal(p802.libre, false);
    assert.equal(p802.numero, '099123');
    assert.equal(p802.restante, 45);
  });

  await t.test('música en espera: clase, audio, archivo generado y recarga', async () => {
    assert.equal((await api('POST', '/api/moh', { token: admin, body: { nombre: '!!' } })).status, 400);
    assert.equal((await api('POST', '/api/moh', { token: admin, body: { nombre: 'default' } })).status, 400);
    assert.equal((await api('POST', '/api/moh', { token: admin, body: { nombre: 'espera ventas', sort: 'random' } })).json.nombre, 'esperaventas');
    assert.equal((await api('POST', '/api/moh/esperaventas/audio', { token: admin, body: {} })).status, 400);
    assert.equal((await api('POST', '/api/moh/esperaventas/audio', { token: admin, body: { filename: 'x.exe', data: 'eA==' } })).status, 400);
    assert.equal((await api('POST', '/api/moh/esperaventas/audio', { token: admin, body: { filename: 'x.wav', data: '' } })).status, 400);
    const up = await api('POST', '/api/moh/esperaventas/audio', { token: admin, body: { filename: 'tema 1.wav', data: 'data:audio/wav;base64,' + wav().toString('base64') } });
    assert.equal(up.json.archivo, 'tema1.wav');
    assert.deepEqual((await api('GET', '/api/moh', { token: admin })).json[0].archivos, ['tema1.wav']);
    ami.olvidar();
    const ap = await api('POST', '/api/moh/apply', { token: admin });
    assert.equal(ap.json.clases, 1);
    assert.ok(ami.pedidos('Command').some((c) => c.command === 'moh reload'));
    await api('DELETE', '/api/moh/esperaventas/audio/tema1.wav', { token: admin });
    assert.deepEqual((await api('GET', '/api/moh', { token: admin })).json[0].archivos, []);
    await api('DELETE', '/api/moh/esperaventas', { token: admin });
    assert.deepEqual((await api('GET', '/api/moh', { token: admin })).json, []);
  });

  await t.test('borrar el agente de IA saca su número del dialplan', async () => {
    assert.equal((await api('DELETE', '/api/ai-agents/' + agenteId, { token: admin })).json.deleted, String(agenteId));
    assert.equal((await ctx.db.query("SELECT count(*)::int n FROM extensions WHERE context='ivr' AND exten='8101'")).rows[0].n, 0);
    await dormir(10);
  });
});
