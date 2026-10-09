/* ============================================================================
 *  apps.js · el buzón de voz por dentro: el volumen /voicemail, el envío por correo y
 *  el PIN de los buzones, con dependencias de mentira (sin Postgres ni Asterisk).
 *
 *  Lo que se fija acá, y por qué importa:
 *   - El buzón visual se lee DIRECTO del volumen que comparte con Asterisk. Un mensaje
 *     con la cabecera rota, una carpeta que no existe o un archivo que no se puede mover
 *     no pueden tirar abajo la lista: el usuario tiene que seguir viendo los demás.
 *   - Marcar como leído mueve INBOX → Old con el primer número libre, como hace *97;
 *     pisar un msg0000 que ya estaba en Old es perder un mensaje.
 *   - El envío por correo es un poller cada 45 s: no puede mandar dos veces el mismo
 *     mensaje, tiene que registrar el fallo (para no reintentar a ciegas) y no puede
 *     correr dos vueltas a la vez.
 *   - El PIN del buzón: nunca el número del buzón, la rotación en lote no rota «todo»
 *     sin que se lo pidan, y el PIN en claro sólo vuelve para los que no se pudo avisar.
 *   - Cada camino de error de la base responde con el error y no deja el pedido colgado.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodemailer = require('nodemailer');
const { appFalsa, poolFalso, errorHttp, loggerFalso, vaciar, hasta } = require('./helpers/tel-ramas-arnes');

const VM_CTX = require('../vmpin').VM_CTX;

/* Un volumen /voicemail de mentira por prueba: VM_DIR se lee al armar el módulo. */
function volumen(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-ramas-vm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const carpeta = (ext, folder) => { const p = path.join(dir, VM_CTX, ext, folder); fs.mkdirSync(p, { recursive: true }); return p; };
  const mensaje = (ext, folder, id, meta, audio = 'RIFFxxxx') => {
    const p = carpeta(ext, folder);
    if (meta != null) fs.writeFileSync(path.join(p, id + '.txt'), meta);
    if (audio != null) fs.writeFileSync(path.join(p, id + '.wav'), audio);
    return p;
  };
  return { dir, carpeta, mensaje };
}

function armar(t, extra = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const app = appFalsa();
  const pool = poolFalso();
  const logger = loggerFalso();
  const deps = Object.assign({
    app, pool, logger, errorHttp,
    amiCommand: async () => 'ok',
    astFwd: async () => ({ json: async () => ({ ok: true, ref: 'custom/x' }) }),
    vozBase: async () => 'http://voz.test',
    setDialplan: async () => {},
    astconf: {},
    exigirExt: () => true,
    wavToPcm: () => ({ pcm: Buffer.alloc(16000), rate: 8000 }),
    analyzeText: (texto, dur) => ({ texto, dur }),
    smtpHint: (e) => 'pista: ' + e.message,
    broadcastSoon: () => {},
  }, extra);
  const mod = require('../apps')(deps);
  return { app, pool, logger, deps, mod };
}

/* nodemailer de mentira: guarda cada transporte y cada correo; `falla` hace tirar el envío. */
function correo(t) {
  const c = { transportes: [], enviados: [], falla: null };
  t.mock.method(nodemailer, 'createTransport', (opts) => {
    c.transportes.push(opts);
    return { sendMail: async (m) => { if (c.falla) throw c.falla; c.enviados.push(m); return { messageId: 'x' }; } };
  });
  return c;
}

const SMTP = { host: 'smtp.test', port: null, secure: false, username: 'yo@test', password: 'x', from_addr: null, enabled: true };

test('buzón visual: lista, audio, borrar y marcar leído sobre el volumen', async (t) => {
  const vol = volumen(t);
  process.env.VM_DIR = vol.dir;
  const { app } = armar(t);

  vol.mensaje('1001', 'INBOX', 'msg0000', 'callerid=099 <099>\norigtime=100\nduration=7\nbasura\n');
  vol.mensaje('1001', 'INBOX', 'msg0001', null, null);
  // Una cabecera que no se puede leer (es una carpeta): el mensaje aparece igual, sin datos.
  fs.mkdirSync(path.join(vol.carpeta('1001', 'INBOX'), 'msg0001.txt'));
  fs.writeFileSync(path.join(vol.carpeta('1001', 'INBOX'), 'notas.wav'), 'x');
  vol.mensaje('1001', 'Old', 'msg0000', 'callerid=24000000\norigtime=200\nduration=3\n');

  await t.test('la lista junta INBOX y Old, ordenada por fecha, y tolera cabeceras rotas', async () => {
    const r = await app.pedir('GET', '/api/vm', { query: { ext: '1001' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((m) => [m.folder, m.id, m.origtime]), [['Old', 'msg0000', 200], ['INBOX', 'msg0000', 100], ['INBOX', 'msg0001', 0]]);
    const roto = r.json.find((m) => m.id === 'msg0001');
    assert.deepEqual([roto.callerid, roto.duration, roto.new], ['', 0, true]);
    assert.equal(r.json[0].new, false, 'lo de Old ya no es nuevo');
    // Sin interno, o un interno sin carpetas, es una lista vacía y no un error.
    assert.deepEqual((await app.pedir('GET', '/api/vm', { query: {} })).json, []);
    assert.deepEqual((await app.pedir('GET', '/api/vm', { query: { ext: '1999' } })).json, []);
  });

  await t.test('audio: .wav, respaldo en .gsm, carpeta desconocida = INBOX, y 404 si no hay', async () => {
    const a = await app.pedir('GET', '/api/vm/audio', { query: { ext: '1001', folder: 'Old', id: 'msg0000' } });
    assert.equal(a.status, 200);
    assert.equal(a.headers['content-type'], 'audio/wav');
    fs.writeFileSync(path.join(vol.carpeta('1001', 'INBOX'), 'msg0007.gsm'), 'GSM');
    const g = await app.pedir('GET', '/api/vm/audio', { query: { ext: '1001', folder: '../../etc', id: 'msg0007' } });
    assert.equal(String(g.json), 'GSM', 'una carpeta inventada no sale del buzón: cae en INBOX');
    const no = await app.pedir('GET', '/api/vm/audio', { query: { ext: '1001', id: 'msg0099' } });
    assert.equal(no.status, 404);
    assert.equal(no.terminado, true);
  });

  await t.test('marcar leído: va a Old con el primer número libre, sin pisar el que estaba', async () => {
    const r = await app.pedir('POST', '/api/vm/read', { body: { ext: '1001', id: 'msg0000' } });
    assert.deepEqual(r.json, { ok: true, id: 'msg0001' });
    const old = fs.readdirSync(vol.carpeta('1001', 'Old')).sort();
    assert.deepEqual(old, ['msg0000.txt', 'msg0000.wav', 'msg0001.txt', 'msg0001.wav']);
    assert.ok(fs.existsSync(path.join(vol.carpeta('1001', 'INBOX'), 'notas.wav')), 'lo que no es del mensaje no se mueve');
    // Un interno sin INBOX, o con un Old que no es carpeta: no revienta, devuelve el id.
    assert.equal((await app.pedir('POST', '/api/vm/read', { body: { ext: '1555', id: 'msg0000' } })).json.ok, true);
    fs.mkdirSync(path.join(vol.dir, VM_CTX, '1002'), { recursive: true });
    fs.writeFileSync(path.join(vol.dir, VM_CTX, '1002', 'Old'), 'no soy carpeta');
    vol.mensaje('1002', 'INBOX', 'msg0000', 'origtime=1\n');
    const raro = await app.pedir('POST', '/api/vm/read', { body: { ext: '1002', id: 'msg0000' } });
    assert.deepEqual(raro.json, { ok: true, id: 'msg0000' });
    assert.ok(fs.existsSync(path.join(vol.carpeta('1002', 'INBOX'), 'msg0000.wav')), 'si no se pudo mover, el mensaje sigue donde estaba');
  });

  await t.test('borrar: se lleva todos los archivos del mensaje y tolera lo que no puede borrar', async () => {
    vol.mensaje('1003', 'INBOX', 'msg0004', 'origtime=5\n');
    fs.mkdirSync(path.join(vol.carpeta('1003', 'INBOX'), 'msg0004.raro'));
    const r = await app.pedir('POST', '/api/vm/del', { body: { ext: '1003', folder: 'INBOX', id: 'msg0004' } });
    assert.deepEqual(r.json, { ok: true });
    assert.deepEqual(fs.readdirSync(vol.carpeta('1003', 'INBOX')), ['msg0004.raro']);
    // Sin cuerpo: no hay buzón que tocar y no es un error.
    assert.deepEqual((await app.pedir('POST', '/api/vm/del', {})).json, { ok: true });
  });
});

test('buzón visual: el alcance por interno corta todas las rutas antes de tocar nada', async (t) => {
  const vistos = [];
  const { app } = armar(t, {
    exigirExt: (req, res, ext) => { vistos.push(ext); res.status(403).json({ error: 'no es tu interno' }); return false; },
  });
  const casos = [
    ['GET', '/api/vm', { query: { ext: '1001' } }],
    ['GET', '/api/vm/audio', { query: { ext: '1001', id: 'm' } }],
    ['POST', '/api/vm/del', { body: { ext: '1001', id: 'm' } }],
    ['POST', '/api/vm/read', {}],
    ['POST', '/api/vm/transcribe', {}],
  ];
  for (const [m, p, o] of casos) assert.equal((await app.pedir(m, p, o)).status, 403, m + ' ' + p);
  assert.deepEqual(vistos, ['1001', '1001', '1001', undefined, undefined]);
});

test('buzón visual: transcripción con cada falla del camino al STT', async (t) => {
  const vol = volumen(t);
  process.env.VM_DIR = vol.dir;
  let pcm = { pcm: Buffer.alloc(32000), rate: 16000 };
  const { app } = armar(t, { wavToPcm: () => pcm });
  vol.mensaje('1001', 'INBOX', 'msg0000', 'origtime=1\n');
  let resp = { ok: true, status: 200, json: async () => ({ text: '  hola  ' }) };
  t.mock.method(globalThis, 'fetch', async () => { if (resp instanceof Error) throw resp; return resp; });
  const tr = (body) => app.pedir('POST', '/api/vm/transcribe', { body });

  assert.equal((await tr(undefined)).status, 400, 'sin cuerpo');
  assert.equal((await tr({ ext: '1001', id: '' })).status, 400, 'id vacío');
  assert.equal((await tr({ ext: '1001', id: 'msg0042' })).status, 404);
  const ok = await tr({ ext: '1001', id: 'msg0000' });
  assert.equal(ok.json.transcript, 'hola');
  assert.deepEqual(ok.json.analysis, { texto: 'hola', dur: 1 });
  // El STT que no trae texto y un PCM sin tasa (se asume 8 kHz).
  resp = { ok: true, status: 200, json: async () => ({}) };
  pcm = { pcm: Buffer.alloc(16000), rate: 0 };
  const vacio = await tr({ ext: '1001', id: 'msg0000' });
  assert.deepEqual(vacio.json, { transcript: '', analysis: { texto: '', dur: 1 } });
  resp = { ok: false, status: 503 };
  assert.deepEqual((await tr({ ext: '1001', id: 'msg0000' })).json, { error: 'STT fallo (503)' });
  resp = new Error('el STT no contesta');
  const caido = await tr({ ext: '1001', id: 'msg0000' });
  assert.equal(caido.status, 500);
  pcm = null;
  assert.equal((await tr({ ext: '1001', id: 'msg0000' })).status, 422, 'un WAV que no es PCM 16-bit');
});

test('buzón → correo: el poller manda una vez, registra fallas y no corre dos vueltas a la vez', async (t) => {
  const vol = volumen(t);
  process.env.VM_DIR = vol.dir;
  const mail = correo(t);
  let pcm = null;
  const stt = [];
  t.mock.method(globalThis, 'fetch', async () => stt.shift() || { ok: false, status: 500 });
  const { pool, logger } = armar(t, { wavToPcm: () => pcm });
  vol.mensaje('1001', 'INBOX', 'msg0000', 'callerid=099\norigtime=1700000000\nduration=9\n');
  vol.mensaje('1001', 'INBOX', 'msg0001', 'origtime=0\n');
  vol.mensaje('1001', 'Old', 'msg0000', 'origtime=5\n');       // lo de Old no se manda
  vol.mensaje('1002', 'INBOX', 'msg0000', 'origtime=3\n', null);  // sin audio: falla el envío

  const cajas = [
    { mailbox: '1001', fullname: 'Ana', email: 'ana@test', email_attach: false, email_transcribe: true, email_delete: true },
    { mailbox: '1002', fullname: 'Beto', email: 'beto@test', email_attach: true, email_transcribe: false, email_delete: false },
  ];
  let boxes = [];
  pool.cuando(/WHERE COALESCE\(NULLIF\(v\.email/, () => boxes);
  let smtp = null;
  pool.cuando(/FROM pbxng_email_config/, () => (smtp ? [smtp] : []));
  pool.cuando(/SELECT 1 FROM pbxng_vm_sent/, (args) => ({ rowCount: args[1] === 'msg0001' ? 1 : 0 }));

  // 1) Sin buzones con correo: ni se busca el SMTP.
  t.mock.timers.tick(20000); await vaciar();
  assert.equal(pool.hechas(/pbxng_email_config/).length, 0);
  // 2) Con buzones pero sin SMTP activo: no se intenta mandar nada.
  boxes = cajas;
  t.mock.timers.tick(45000 - 20000); await vaciar();
  assert.equal(pool.hechas(/pbxng_email_config/).length, 1);
  assert.equal(mail.enviados.length, 0);

  // 3) Con SMTP: el 1001/msg0000 sale (msg0001 ya estaba enviado), el 1002 falla sin audio.
  smtp = Object.assign({}, SMTP, { enabled: true, host: 'smtp.test' });
  // primera transcripción: un STT caído no impide el correo.
  pcm = { pcm: Buffer.alloc(1600), rate: 8000 };
  stt.push({ ok: false, status: 500 });
  t.mock.timers.tick(45000);
  await hasta(() => pool.hechas(/DO UPDATE SET ok=false/).length === 1);
  assert.equal(mail.enviados.length, 1);
  const m = mail.enviados[0];
  assert.equal(m.to, 'ana@test');
  assert.equal(m.from, 'yo@test', 'sin remitente configurado sale con el usuario del SMTP');
  assert.match(m.subject, /de 099 · interno 1001/);
  assert.deepEqual(m.attachments, [], 'email_attach=false no adjunta el WAV');
  assert.doesNotMatch(m.text, /Transcripción/);
  assert.deepEqual(mail.transportes[0], { host: 'smtp.test', port: 587, secure: false, auth: { user: 'yo@test', pass: 'x' } });
  assert.equal(fs.existsSync(path.join(vol.carpeta('1001', 'INBOX'), 'msg0000.wav')), false, 'email_delete borra el mensaje después de mandarlo');
  const ok = pool.hechas(/INSERT INTO pbxng_vm_sent .*true\) ON CONFLICT \(mailbox,mid\) DO NOTHING/);
  assert.deepEqual(ok.map((q) => q.args.slice(0, 2)), [['1001', 'msg0000']]);
  const mal = pool.hechas(/DO UPDATE SET ok=false/);
  assert.deepEqual(mal.map((q) => [q.args[0], q.args[1], q.args[5]]), [['1002', 'msg0000', 'audio no disponible']]);
  assert.ok(logger.lineas.some((l) => l.mod === 'vm-mail' && l.nivel === 'error'), 'la falla queda en el log');

  // 4) Con transcripción, sin cuenta (SMTP abierto), y un mensaje sin CallerID ni fecha.
  vol.mensaje('1001', 'INBOX', 'msg0002', 'origtime=0\n');
  cajas[0].email_delete = false; cajas[0].email_attach = true;
  boxes = [cajas[0]];
  smtp = Object.assign({}, SMTP, { username: '', from_addr: 'central@test', port: 25, secure: true });
  pool.cuando(/key='brand_name'/, [{ value: 'Mi Central' }]);
  pool.cuando(/key='domain'/, [{ value: 'pbx.test' }]);
  stt.push({ ok: true, json: async () => ({ text: ' te llamo luego ' }) });
  t.mock.timers.tick(45000);
  await hasta(() => mail.enviados.length === 2);
  const m2 = mail.enviados[1];
  assert.match(m2.subject, /de desconocido/);
  assert.match(m2.text, /Transcripción:\nte llamo luego/);
  assert.match(m2.text, /Duración: 0s/);
  assert.equal(m2.attachments.length, 1);
  assert.match(m2.html, /pbx\.test\/voz/);
  assert.match(m2.html, /Mi Central/);
  assert.deepEqual(mail.transportes[1], { host: 'smtp.test', port: 25, secure: true, auth: undefined });

  // 5) La transcripción que vuelve vacía no pone la sección; un WAV que no es PCM tampoco.
  vol.mensaje('1001', 'INBOX', 'msg0003', 'origtime=0\n');
  pool.cuando(/SELECT 1 FROM pbxng_vm_sent/, (args) => ({ rowCount: args[1] === 'msg0003' ? 0 : 1 }));
  stt.push({ ok: true, json: async () => ({}) });
  t.mock.timers.tick(45000);
  await hasta(() => mail.enviados.length === 3);
  assert.doesNotMatch(mail.enviados[2].text, /Transcripción/);
  vol.mensaje('1001', 'INBOX', 'msg0004', 'origtime=0\n');
  pool.cuando(/SELECT 1 FROM pbxng_vm_sent/, (args) => ({ rowCount: args[1] === 'msg0004' ? 0 : 1 }));
  pcm = null;
  t.mock.timers.tick(45000);
  await hasta(() => mail.enviados.length === 4);
  assert.doesNotMatch(mail.enviados[3].text, /Transcripción/);
  // Y una excepción del STT se registra como aviso y el correo sale igual.
  vol.mensaje('1001', 'INBOX', 'msg0005', 'origtime=0\n');
  pool.cuando(/SELECT 1 FROM pbxng_vm_sent/, (args) => ({ rowCount: args[1] === 'msg0005' ? 0 : 1 }));
  pcm = { pcm: Buffer.alloc(10), rate: 8000 };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('sin red'); });
  t.mock.timers.tick(45000);
  await hasta(() => mail.enviados.length === 5);
  assert.ok(logger.lineas.some((l) => l.mod === 'vm-mail' && l.nivel === 'warn'));
});

test('buzón → correo: dos vueltas a la vez no se pisan, y un error de la base se registra', async (t) => {
  const { pool, logger } = armar(t);
  let soltar;
  const trabada = new Promise((ok) => { soltar = ok; });
  pool.cuando(/WHERE COALESCE\(NULLIF\(v\.email/, async () => { await trabada; return []; });
  // La primera vuelta (20 s) queda esperando a la base; la del intervalo (45 s) llega con
  // la primera todavía en curso y no tiene que hacer la consulta otra vez.
  t.mock.timers.tick(45000); await vaciar();
  assert.equal(pool.hechas(/WHERE COALESCE\(NULLIF\(v\.email/).length, 1);
  soltar(); await vaciar();
  pool.cuando(/WHERE COALESCE\(NULLIF\(v\.email/, new Error('la base no está'));
  t.mock.timers.tick(45000); await vaciar();
  assert.ok(logger.lineas.some((l) => l.mod === 'vm-mail' && l.nivel === 'error' && /la base no está/.test(l.msg)));
});

test('arranque: los buzones sin PIN de verdad se nombran en el log, y si la base falla también se dice', async (t) => {
  await t.test('con buzones débiles', async (t) => {
    const { pool, logger } = armar(t);
    pool.cuando(/SELECT mailbox, password FROM voicemail WHERE context=\$1$/, [{ mailbox: '1001', password: '1001' }, { mailbox: '1002', password: '583920' }]);
    t.mock.timers.tick(25000); await vaciar();
    assert.ok(logger.lineas.some((l) => l.mod === 'vm' && l.nivel === 'warn' && /sin PIN de verdad/.test(l.msg)));
  });
  await t.test('sin débiles no hay aviso', async (t) => {
    const { logger } = armar(t);
    t.mock.timers.tick(25000); await vaciar();
    assert.equal(logger.lineas.filter((l) => l.mod === 'vm').length, 0);
  });
  await t.test('con la base caída es un error en el log, no una excepción suelta', async (t) => {
    const { pool, logger } = armar(t);
    pool.cuando(/SELECT mailbox, password FROM voicemail/, new Error('x'));
    t.mock.timers.tick(25000); await vaciar();
    assert.ok(logger.lineas.some((l) => l.mod === 'vm' && l.nivel === 'error'));
  });
});

test('configuración de buzón → correo y envío manual de un mensaje', async (t) => {
  const vol = volumen(t);
  process.env.VM_DIR = vol.dir;
  const mail = correo(t);
  const { app, pool } = armar(t, { wavToPcm: () => null });
  vol.mensaje('1001', 'INBOX', 'msg0000', 'callerid=099\norigtime=10\nduration=4\n');

  await t.test('GET y POST de la configuración, con sus errores', async () => {
    pool.cuando(/AS enviados/, [{ mailbox: '1001', enviados: 2 }]);
    assert.deepEqual((await app.pedir('GET', '/api/vm/email')).json, [{ mailbox: '1001', enviados: 2 }]);
    pool.cuando(/AS enviados/, new Error('caída'));
    assert.equal((await app.pedir('GET', '/api/vm/email')).status, 500);

    assert.equal((await app.pedir('POST', '/api/vm/email', {})).status, 400);
    // Sin `email` en el cuerpo no se toca la dirección del buzón; los interruptores por defecto quedan prendidos.
    assert.deepEqual((await app.pedir('POST', '/api/vm/email', { body: { mailbox: 1001 } })).json, { ok: true });
    assert.equal(pool.hechas(/UPDATE voicemail SET email/).length, 0);
    const ins = pool.hechas(/INSERT INTO pbxng_mailboxes \(mailbox, email/).pop();
    assert.deepEqual(ins.args, ['1001', null, true, true, true, false]);
    await app.pedir('POST', '/api/vm/email', { body: { mailbox: '1001', email: '', email_enabled: false, email_attach: false, email_transcribe: false, email_delete: 1 } });
    assert.deepEqual(pool.hechas(/UPDATE voicemail SET email/).pop().args, ['1001', null]);
    assert.deepEqual(pool.hechas(/INSERT INTO pbxng_mailboxes \(mailbox, email/).pop().args, ['1001', null, false, false, false, true]);
    pool.cuando(/INSERT INTO pbxng_mailboxes \(mailbox, email/, new Error('caída'));
    assert.equal((await app.pedir('POST', '/api/vm/email', { body: { mailbox: '1001' } })).status, 500);
  });

  await t.test('envío manual: validaciones, mensaje que no está en la lista y falla del SMTP', async () => {
    const env = (body) => app.pedir('POST', '/api/vm/email/send', { body });
    assert.equal((await env(undefined)).status, 400);
    assert.deepEqual((await env({ mailbox: '1001', id: 'msg0000' })).json, { error: 'sin configuración SMTP activa' });
    pool.cuando(/FROM pbxng_email_config/, [Object.assign({}, SMTP, { enabled: false })]);
    assert.equal((await env({ mailbox: '1001', id: 'msg0000' })).status, 400, 'SMTP apagado = sin SMTP');
    pool.cuando(/FROM pbxng_email_config/, [SMTP]);
    assert.deepEqual((await env({ mailbox: '1001', id: 'msg0000' })).json, { error: 'el buzón no tiene email configurado' });
    pool.cuando(/WHERE v\.mailbox=\$1/, [{ mailbox: '1001', fullname: 'Ana', email: '', email_attach: true }]);
    assert.equal((await env({ mailbox: '1001', id: 'msg0000' })).status, 400, 'email vacío');
    pool.cuando(/WHERE v\.mailbox=\$1/, [{ mailbox: '1001', fullname: 'Ana', email: 'ana@test', email_attach: true, email_transcribe: true }]);

    const ok = await env({ mailbox: '1001', id: 'msg0000' });
    assert.deepEqual(ok.json, { ok: true, to: 'ana@test' });
    assert.match(mail.enviados[0].subject, /de 099/);
    assert.match(mail.enviados[0].html, /PBX-NG/, 'sin marca configurada va la de fábrica');
    const reg = pool.hechas(/DO UPDATE SET ok=true/).pop();
    assert.deepEqual(reg.args, ['1001', 'msg0000', 'INBOX', 10, 'ana@test']);

    // Un id que no está en el volumen: se arma el mensaje con la carpeta pedida y falla el audio.
    const no = await env({ mailbox: '1001', id: 'msg0099', folder: 'Old' });
    assert.equal(no.status, 500);
    assert.equal(no.json.error, 'pista: audio no disponible');
    // Con el audio en Old, el mensaje inventado sale con esa carpeta.
    vol.mensaje('1001', 'Old', 'msg0098', null);
    assert.equal((await env({ mailbox: '1001', id: 'msg0098', folder: 'Old' })).status, 200);
    assert.equal(pool.hechas(/DO UPDATE SET ok=true/).pop().args[2], 'Old');
    vol.mensaje('1001', 'INBOX', 'msg0097', null);
    pool.cuando(/key='brand_name'/, [{ value: 'Marca' }]);
    assert.equal((await env({ mailbox: '1001', id: 'msg0097' })).status, 200);
    assert.equal(pool.hechas(/DO UPDATE SET ok=true/).pop().args[2], 'INBOX', 'sin carpeta: INBOX');
    assert.match(mail.enviados.pop().html, /Marca/);
  });
});

test('buzones: listado, detalle, alta y borrado con sus validaciones y fallas', async (t) => {
  const { app, pool } = armar(t);

  await t.test('listado sin el PIN y detalle con el PIN', async () => {
    pool.cuando(/v\.password AS _pw/, [{ mailbox: '1001', fullname: 'Ana', email: null, _pw: '1001' }, { mailbox: '1002', fullname: 'B', email: 'b@t', _pw: '583920' }]);
    const l = await app.pedir('GET', '/api/mailboxes');
    assert.deepEqual(l.json.map((r) => [r.mailbox, r.pin_debil, 'pin' in r || '_pw' in r]), [['1001', true, false], ['1002', false, false]]);
    pool.cuando(/v\.password AS _pw/, new Error('caída'));
    assert.equal((await app.pedir('GET', '/api/mailboxes')).status, 500);

    assert.equal((await app.pedir('GET', '/api/mailboxes/:mailbox', { params: {} })).status, 404);
    pool.cuando(/SELECT mailbox, fullname, email, password FROM voicemail/, [{ mailbox: '1003', fullname: 'C', email: null, password: null }]);
    const d = await app.pedir('GET', '/api/mailboxes/:mailbox', { params: { mailbox: '1003' } });
    assert.equal(d.json.pin, '', 'un buzón sin password no devuelve null en el PIN');
    pool.cuando(/SELECT mailbox, fullname, email, password FROM voicemail/, new Error('caída'));
    assert.equal((await app.pedir('GET', '/api/mailboxes/:mailbox', { params: { mailbox: '1003' } })).status, 500);
  });

  await t.test('alta: PIN generado, PIN débil, buzón que ya existía y base caída', async () => {
    const alta = (body) => app.pedir('POST', '/api/mailboxes', { body });
    assert.equal((await alta(undefined)).status, 400);
    assert.equal((await alta({ mailbox: '10a' })).status, 400);
    assert.equal((await alta({ mailbox: '1001', password: '12' })).status, 400);
    assert.match((await alta({ mailbox: '1001', password: ' 1001 ' })).json.error, /número del buzón/);

    // Sin PIN escrito se genera uno; si la fila no vuelve, se devuelve el generado.
    const g = await alta({ mailbox: '1004', password: null });
    assert.equal(g.status, 201);
    assert.match(g.json.pin, /^\d{6}$/);
    assert.equal(g.json.ya_existia, false);
    const ins = pool.hechas(/INSERT INTO voicemail/).pop();
    assert.deepEqual([ins.args[1], ins.args[3], ins.args[4]], [VM_CTX, '1004', null], 'sin nombre ni correo: el número y null');

    // El buzón ya existía con otro PIN: se devuelve el que QUEDÓ.
    pool.cuando(/SELECT password FROM voicemail WHERE mailbox=\$1 AND context=\$2/, [{ password: '777333' }]);
    const ya = await alta({ mailbox: '1005', password: '482910', fullname: 'E', email: 'e@t', context: 'otro' });
    assert.deepEqual(ya.json, { created: '1005', pin: '777333', ya_existia: true });

    pool.cuando(/INSERT INTO pbxng_mailboxes \(mailbox,fullname,email\)/, new Error('caída'));
    pool.cuando(/ROLLBACK/, new Error('tampoco'));
    const antes = pool.sueltos;
    assert.equal((await alta({ mailbox: '1006', password: '482910' })).status, 500);
    assert.equal(pool.sueltos, antes + 1, 'el cliente se devuelve aunque falle el ROLLBACK');
    pool.conectar = new Error('sin base');
    assert.equal((await alta({ mailbox: '1006', password: '482910' })).status, 500);
    assert.equal((await app.pedir('DELETE', '/api/mailboxes/:mailbox', { params: { mailbox: '1006' } })).status, 500);
    pool.conectar = null;
  });

  await t.test('borrado: ok y con la base cayéndose a mitad', async () => {
    assert.deepEqual((await app.pedir('DELETE', '/api/mailboxes/:mailbox', { params: { mailbox: '1001' } })).json, { deleted: '1001' });
    pool.cuando(/DELETE FROM pbxng_mailboxes/, new Error('caída'));
    assert.equal((await app.pedir('DELETE', '/api/mailboxes/:mailbox', { params: { mailbox: '1001' } })).status, 500);
  });
});

test('PIN del buzón: rotar de a uno y en lote, con y sin aviso por correo', async (t) => {
  const mail = correo(t);
  const { app, pool, logger } = armar(t);
  const existe = new Set(['1001', '1002', '1003', '1004']);
  pool.cuando(/UPDATE voicemail SET password=\$2/, (args) => ({ rowCount: existe.has(args[0]) ? 1 : 0 }));
  // 1001 y 1003 tienen correo; 1002 no.
  pool.cuando(/SELECT v\.fullname, COALESCE/, (args) => (args[0] === '1002' ? [{ fullname: 'B', email: '' }] : args[0] === '1004' ? [] : [{ fullname: 'X', email: args[0] + '@t' }]));

  await t.test('de a uno: validaciones, sin SMTP, con SMTP y con el SMTP fallando', async () => {
    const rot = (mb, body) => app.pedir('POST', '/api/mailboxes/:mailbox/pin', { params: { mailbox: mb }, body });
    assert.equal((await rot('1001', { pin: 'abcd' })).status, 400);
    assert.equal((await rot('1001', { pin: '1001' })).status, 400);
    assert.equal((await rot('', {})).status, 404, 'buzón vacío: el PIN generado nunca es débil y el UPDATE no encuentra nada');
    assert.equal((await rot('1999', { pin: '' })).status, 404);

    const sin = await rot('1001', undefined);
    assert.equal(sin.json.avisado, false, 'sin SMTP no se avisa, pero el PIN se rota igual');
    assert.match(sin.json.pin, /^\d{6}$/);
    assert.ok(logger.lineas.some((l) => /rotado/.test(l.msg)));

    pool.cuando(/FROM pbxng_email_config/, [Object.assign({}, SMTP, { username: '' })]);
    const con = await rot('1001', { pin: '482910' }, {});
    assert.deepEqual(con.json, { mailbox: '1001', pin: '482910', avisado: true });
    assert.equal(mail.enviados[0].to, '1001@t');
    assert.doesNotMatch(mail.enviados[0].subject, /482910/, 'el asunto no lleva el PIN');
    assert.equal(mail.enviados[0].from, '', 'sin remitente sale con el usuario (vacío), no con una dirección inventada');
    assert.equal((await rot('1002', { pin: '482910' })).json.avisado, false, 'sin correo en el buzón');
    assert.equal((await rot('1004', { pin: '482910' })).json.avisado, false, 'el buzón no está en el contexto');

    mail.falla = new Error('535 auth');
    const falla = await app.pedir('POST', '/api/mailboxes/:mailbox/pin', { params: { mailbox: '1003' }, body: { pin: '482910' }, user: { username: 'admin' } });
    assert.equal(falla.json.avisado, false);
    assert.ok(logger.lineas.some((l) => l.nivel === 'warn' && /avisar el PIN/.test(l.msg)));
    mail.falla = null;
    pool.cuando(/UPDATE voicemail SET password=\$2/, new Error('caída'));
    assert.equal((await rot('1001', { pin: '482910' })).status, 500);
    pool.cuando(/UPDATE voicemail SET password=\$2/, (args) => ({ rowCount: existe.has(args[0]) ? 1 : 0 }));
  });

  await t.test('en lote: hay que decir cuáles, tope, inválidos, inexistentes y el PIN sólo de los no avisados', async () => {
    const lote = (body, user) => app.pedir('POST', '/api/mailboxes/rotar-pin', { body, user });
    assert.equal((await lote(undefined)).status, 400, 'un POST vacío NO rota la central entera');
    assert.deepEqual((await lote({ mailboxes: ['', null] })).json, { rotados: 0, avisados: 0, resultados: [] });
    assert.equal((await lote({ mailboxes: Array.from({ length: 201 }, (_, i) => String(2000 + i)) })).status, 400);

    const r = await lote({ mailboxes: ['1001', '1002', '1002', 'abc', '1999'] }, { username: 'admin' });
    assert.equal(r.json.rotados, 2);
    assert.equal(r.json.avisados, 1);
    const por = Object.fromEntries(r.json.resultados.map((x) => [x.mailbox, x]));
    assert.equal(por['1001'].pin, null, 'al avisado no se le devuelve el PIN');
    assert.match(por['1002'].pin, /^\d{6}$/, 'al que no se pudo avisar sí, para dictárselo');
    assert.equal(por.abc.error, 'buzón inválido (sólo dígitos)');
    assert.equal(por['1999'].error, 'no existe ese buzón');
    assert.equal(mail.transportes.length >= 1, true);

    // solo_debiles calcula la lista; una falla de un buzón no corta el resto.
    pool.cuando(/SELECT mailbox, password FROM voicemail WHERE context=\$1 ORDER BY mailbox/, [{ mailbox: '1003', password: '1003' }, { mailbox: '1001', password: '1001' }, { mailbox: '1002', password: '999111' }]);
    pool.cuando(/UPDATE voicemail SET password=\$2/, (args) => { if (args[0] === '1003') throw new Error('bloqueo'); return { rowCount: 1 }; });
    const d = await lote({ solo_debiles: true });
    assert.deepEqual(d.json.resultados.map((x) => [x.mailbox, x.ok, x.error]), [['1003', false, 'no se pudo rotar'], ['1001', true, null]]);
    pool.cuando(/SELECT mailbox, password FROM voicemail WHERE context=\$1 ORDER BY mailbox/, new Error('caída'));
    assert.equal((await lote({ solo_debiles: true })).status, 500);
  });
});
