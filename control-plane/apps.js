/* ============================================================================
 *  PBX-NG · Aplicaciones de la central (Aplicaciones, Funciones, IVR, Voz).
 *
 *  Todo lo que "hace algo" con una llamada que entró, además de sonar en un
 *  interno: colas (tabla realtime `queues` + pbxng_queues con lo nuestro), grupos de
 *  timbrado, paging, IVR clásico (pbxng_ivr + opciones) e IVR con IA (pbxng_ai_agents
 *  → Stasis pbxng,ai,<id>, lo atiende ai-pipeline.js), buzones (voicemail realtime +
 *  pbxng_mailboxes, lectura directa del volumen /voicemail y buzón → correo), códigos
 *  de función (*43, *65, *97, *98), aparcado y música en espera (estas dos NO viven
 *  en la base: astconf.js genera el archivo y se recarga por AMI).
 *
 *  Cada aplicación se publica en el dialplan realtime del contexto `ivr` (o `internal`
 *  para los códigos de función) con `setDialplan` de app.js, en la misma transacción
 *  que su fila, para que la base y el plan de marcado nunca queden desparejos.
 *
 *  Acceso: las rutas se registran DESPUÉS del gate de auth + RBAC de app.js; qué rol
 *  ve o escribe cada familia lo decide rbac.js (supervisor: GET queues, live y
 *  miembros; agente: nada de acá salvo su propio buzón, que filtra `exigirExt`).
 * ==========================================================================*/
'use strict';

const nodemailer = require('nodemailer');
const emails = require('./emails');

/**
 * deps:
 *   app            Express (las rutas se registran acá, DESPUÉS del gate)
 *   pool           pg.Pool
 *   amiAction      (action) => respuesta AMI (ParkedCalls para las plazas del aparcado)
 *   amiCommand     (cmd) => salida del CLI de Asterisk por AMI (queue show, reloads)
 *   astFwd         (method, path, body, ms) llamada al agente de Asterisk (desplegar audios TTS)
 *   vozBase        () => URL base del servicio de voz (TTS/STT), de pbxng_settings o NODES.voz
 *   setDialplan    (client, context, exten, rows) escribe una extensión en el dialplan realtime (app.js)
 *   astconf        aparcado y música en espera: genera la config en el volumen compartido (astconf.js)
 *   exigirExt      (req, res, ext) => false y responde 403 si la sesión no alcanza a ese interno (auth.js)
 *   wavToPcm       (wav) => {pcm, rate} | null, para mandar un WAV al STT (recordings.js)
 *   analyzeText    (texto, dur) => resumen/sentimiento de una transcripción (recordings.js)
 *   smtpHint       (err) => mensaje entendible de un fallo SMTP (app.js, Configuración → Correo)
 *   errorHttp      traduce errores a {error} con status (errores.js)
 *   broadcastSoon  refresca el snapshot del socket tras cambiar una aplicación
 *   logger         fábrica de loggers de log.js (logger('vm-mail'))
 *
 * Devuelve: { aiAgentDialplan, buildIvrDialplan, vmList } (generadores de dialplan puros,
 * útiles para pruebas; vmList para quien necesite el buzón sin pasar por HTTP).
 */
module.exports = function init(deps) {
  const { app, pool, amiAction, amiCommand, astFwd, vozBase, setDialplan, astconf,
    exigirExt, wavToPcm, analyzeText, smtpHint, errorHttp, broadcastSoon, logger } = deps;

  // ---------------------------------------------------------------------------
  //  Buzon de voz: se lee DIRECTO del volumen compartido con Asterisk (/voicemail).
  //  Antes esto dependia de un agente HTTP (:8089) que dejo de correr cuando pasamos
  //  a "grabaciones por volumen compartido" -> el buzon visual quedo mudo. Sin agente,
  //  sin token, sin red de por medio.
  // ---------------------------------------------------------------------------
  const VM_DIR = process.env.VM_DIR || '/voicemail';
  const VM_CTX = process.env.VM_CONTEXT || 'default';
  const _fsp = require('fs').promises;
  const _path = require('path');
  const vmSafe = (x) => String(x || '').replace(/[^A-Za-z0-9_-]/g, '');
  const vmFolder = (f) => (['INBOX', 'Old', 'Urgent', 'Work', 'Family', 'Friends'].includes(f) ? f : 'INBOX');
  const vmBase = (ext, folder) => _path.join(VM_DIR, VM_CTX, vmSafe(ext), vmFolder(folder));
  async function vmMeta(file) {
    const d = {};
    try {
      const txt = await _fsp.readFile(file, 'utf8');
      for (const line of txt.split('\n')) { const i = line.indexOf('='); if (i > 0) d[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    } catch (_) {}
    return d;
  }
  async function vmList(ext) {
    const out = [];
    for (const folder of ['INBOX', 'Old']) {
      const base = vmBase(ext, folder);
      let files = [];
      try { files = await _fsp.readdir(base); } catch (_) { continue; }
      for (const f of files) {
        if (!f.endsWith('.txt')) continue;
        const id = f.slice(0, -4);
        const m = await vmMeta(_path.join(base, f));
        out.push({ id, folder, callerid: m.callerid || '', origtime: Number(m.origtime || 0), duration: Number(m.duration || 0), new: folder === 'INBOX' });
      }
    }
    out.sort((a, b) => b.origtime - a.origtime);
    return out;
  }
  async function vmAudio(ext, folder, id) {
    const base = vmBase(ext, folder);
    for (const e of ['.wav', '.WAV', '.gsm']) {
      try { return await _fsp.readFile(_path.join(base, vmSafe(id) + e)); } catch (_) {}
    }
    throw new Error('audio no disponible');
  }
  async function vmDelete(ext, folder, id) {
    const base = vmBase(ext, folder);
    for (const f of await _fsp.readdir(base).catch(() => [])) {
      if (f.startsWith(vmSafe(id) + '.')) { try { await _fsp.unlink(_path.join(base, f)); } catch (_) {} }
    }
  }
  async function vmMarkRead(ext, id) {   // INBOX -> Old (como hace *97 al guardar)
    const from = vmBase(ext, 'INBOX'), to = vmBase(ext, 'Old');
    await _fsp.mkdir(to, { recursive: true }).catch(() => {});
    const used = (await _fsp.readdir(to).catch(() => [])).filter((f) => f.endsWith('.txt')).map((f) => f.slice(3, -4));
    let n = 0; while (used.includes(String(n).padStart(4, '0'))) n++;
    const nid = 'msg' + String(n).padStart(4, '0');
    for (const f of await _fsp.readdir(from).catch(() => [])) {
      if (!f.startsWith(vmSafe(id) + '.')) continue;
      const ext2 = f.slice(f.indexOf('.'));
      try { await _fsp.rename(_path.join(from, f), _path.join(to, nid + ext2)); } catch (_) {}
    }
    return nid;
  }
  app.get('/api/vm', async (req, res) => {
    if (!exigirExt(req, res, req.query.ext)) return;
    try { res.json(await vmList(req.query.ext || '')); }
    catch (e) { errorHttp(res, e); }
  });
  app.get('/api/vm/audio', async (req, res) => {
    if (!exigirExt(req, res, req.query.ext)) return;
    try { const buf = await vmAudio(req.query.ext, req.query.folder, req.query.id); res.set('Content-Type', 'audio/wav').send(buf); }
    catch (e) { res.status(404).end(); }
  });
  app.post('/api/vm/del', async (req, res) => {
    if (!exigirExt(req, res, (req.body || {}).ext)) return;
    try { const { ext, folder, id } = req.body || {}; await vmDelete(ext, folder, id); res.json({ ok: true }); }
    catch (e) { errorHttp(res, e); }
  });
  app.post('/api/vm/read', async (req, res) => {
    if (!exigirExt(req, res, (req.body || {}).ext)) return;
    try { const { ext, id } = req.body || {}; const nid = await vmMarkRead(ext, id); res.json({ ok: true, id: nid }); }
    catch (e) { errorHttp(res, e); }
  });
  // Transcripcion de un mensaje de voz (Whisper): baja el WAV del agente VM, lo pasa a PCM
  // y lo manda al servicio STT (faster-whisper). No persiste (los VM los maneja el agente).
  app.post('/api/vm/transcribe', async (req, res) => {
    if (!exigirExt(req, res, (req.body || {}).ext)) return;
    try {
      const { ext, folder, id } = req.body || {};
      if (!ext || id == null || id === '') return res.status(400).json({ error: 'faltan ext/id' });
      let wav;
      try { wav = await vmAudio(ext, folder, id); } catch (_) { return res.status(404).json({ error: 'audio no disponible' }); }
      const pc = wavToPcm(wav);
      if (!pc) return res.status(422).json({ error: 'formato WAV no soportado (se requiere PCM 16-bit)' });
      const base = await vozBase();
      const sr = await fetch(base + '/stt?rate=' + pc.rate, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pc.pcm, signal: AbortSignal.timeout(180000) });
      if (!sr.ok) return res.status(502).json({ error: 'STT fallo (' + sr.status + ')' });
      const sd = await sr.json();
      const text = (sd.text || '').trim();
      const dur = Math.round((pc.pcm.length / 2) / (pc.rate || 8000));
      const analysis = analyzeText(text, dur);
      res.json({ transcript: text, analysis });
    } catch (e) { errorHttp(res, e); }
  });
  // ============================================================================
  //  Buzon de voz -> Email  (voicemail-to-email con transcripcion)
  //  Poller: cada 45 s revisa los INBOX de los buzones con email configurado, y de
  //  cada mensaje NUEVO manda un correo con: quien llamo, cuando, cuanto duro, la
  //  transcripcion (Whisper) y el WAV adjunto. Lo enviado se registra en
  //  pbxng_vm_sent (idempotente: no se manda dos veces el mismo mensaje).
  // ============================================================================
  async function smtpFor(tenantId = 1) {
    const { rows } = await pool.query('SELECT host,port,secure,username,password,from_addr,enabled FROM pbxng_email_config WHERE tenant_id=$1', [tenantId]);
    const c = rows[0];
    return (c && c.enabled && c.host) ? c : null;
  }
  async function vmTranscript(wav) {
    const pc = wavToPcm(wav);
    if (!pc) return null;
    const base = await vozBase();
    const sr = await fetch(base + '/stt?rate=' + pc.rate, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pc.pcm, signal: AbortSignal.timeout(180000) });
    if (!sr.ok) return null;
    const sd = await sr.json();
    return (sd.text || '').trim() || null;
  }
  async function vmSendOne(smtp, brand, box, msg) {
    const wav = await vmAudio(box.mailbox, msg.folder, msg.id);
    let transcript = null;
    if (box.email_transcribe) { try { transcript = await vmTranscript(wav); } catch (e) { logger('vm-mail').warn('stt', e); } }
    const when = new Date((msg.origtime || 0) * 1000).toLocaleString('es-UY', { timeZone: process.env.TZ || 'America/Montevideo' });
    const tx = nodemailer.createTransport({ host: smtp.host, port: smtp.port || 587, secure: !!smtp.secure, auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined });
    const { rows: dm } = await pool.query("SELECT value FROM pbxng_settings WHERE key='domain'");
    const dom = (dm[0] && dm[0].value) || process.env.DOMAIN || '';
    await tx.sendMail({
      from: smtp.from_addr || smtp.username,
      to: box.email,
      subject: `Mensaje de voz de ${msg.callerid || 'desconocido'} · interno ${box.mailbox}`,
      html: emails.voicemailEmail({ brand, mailbox: box.mailbox, fullname: box.fullname, from: msg.callerid,
        when, duration: msg.duration || 0, transcript, hasAudio: !!box.email_attach,
        panelUrl: dom ? 'https://' + dom + '/voz' : '' }),
      text: `Nuevo mensaje de voz para el interno ${box.mailbox}\nDe: ${msg.callerid || 'desconocido'}\nFecha: ${when}\nDuración: ${msg.duration || 0}s\n` + (transcript ? `\nTranscripción:\n${transcript}\n` : ''),
      attachments: box.email_attach ? [{ filename: `mensaje-${box.mailbox}-${msg.id}.wav`, content: wav }] : [],
    });
  }
  let VM_MAIL_BUSY = false;
  async function vmMailTick() {
    if (VM_MAIL_BUSY) return; VM_MAIL_BUSY = true;
    try {
      const { rows: boxes } = await pool.query(`SELECT v.mailbox, v.fullname, COALESCE(NULLIF(v.email,''), m.email) AS email,
          COALESCE(m.email_enabled,true) AS email_enabled, COALESCE(m.email_attach,true) AS email_attach,
          COALESCE(m.email_transcribe,true) AS email_transcribe, COALESCE(m.email_delete,false) AS email_delete
        FROM voicemail v LEFT JOIN pbxng_mailboxes m ON m.mailbox = v.mailbox
        WHERE COALESCE(NULLIF(v.email,''), m.email, '') <> '' AND COALESCE(m.email_enabled,true)`);
      if (!boxes.length) return;
      const smtp = await smtpFor(1);
      if (!smtp) return;
      const { rows: br } = await pool.query("SELECT value FROM pbxng_settings WHERE key='brand_name'");
      const brand = (br[0] && br[0].value) || 'PBX-NG';
      for (const box of boxes) {
        let list = [];
        try { list = await vmList(box.mailbox); } catch (e) { continue; }
        for (const msg of (Array.isArray(list) ? list : []).filter((m) => m.folder === 'INBOX')) {
          const { rowCount } = await pool.query('SELECT 1 FROM pbxng_vm_sent WHERE mailbox=$1 AND mid=$2', [box.mailbox, msg.id]);
          if (rowCount) continue;
          try {
            await vmSendOne(smtp, brand, box, msg);
            await pool.query('INSERT INTO pbxng_vm_sent (mailbox,mid,folder,origtime,to_addr,ok) VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (mailbox,mid) DO NOTHING',
              [box.mailbox, msg.id, msg.folder, msg.origtime || 0, box.email]);
            logger('vm-mail').info('enviado', { mailbox: box.mailbox, id: msg.id, to: box.email });
            if (box.email_delete) { try { await vmDelete(box.mailbox, msg.folder, msg.id); } catch (_) {} }
          } catch (e) {
            logger('vm-mail').error('fallo', { mailbox: box.mailbox, id: msg.id }, e);
            await pool.query('INSERT INTO pbxng_vm_sent (mailbox,mid,folder,origtime,to_addr,ok,err) VALUES ($1,$2,$3,$4,$5,false,$6) ON CONFLICT (mailbox,mid) DO UPDATE SET ok=false, err=$6',
              [box.mailbox, msg.id, msg.folder, msg.origtime || 0, box.email, String(e.message || e).slice(0, 300)]);
          }
        }
      }
    } catch (e) { logger('vm-mail').error(e); }
    finally { VM_MAIL_BUSY = false; }
  }
  setInterval(() => { vmMailTick().catch(() => {}); }, 45000);
  setTimeout(() => { vmMailTick().catch(() => {}); }, 20000);

  // Config de "buzon -> email" por buzon
  app.get('/api/vm/email', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT v.mailbox, v.fullname, COALESCE(NULLIF(v.email,''), m.email, '') AS email,
          COALESCE(m.email_enabled,true) AS email_enabled, COALESCE(m.email_attach,true) AS email_attach,
          COALESCE(m.email_transcribe,true) AS email_transcribe, COALESCE(m.email_delete,false) AS email_delete,
          (SELECT count(*) FROM pbxng_vm_sent s WHERE s.mailbox=v.mailbox AND s.ok) AS enviados
        FROM voicemail v LEFT JOIN pbxng_mailboxes m ON m.mailbox=v.mailbox ORDER BY v.mailbox`);
      res.json(rows);
    } catch (e) { errorHttp(res, e); }
  });
  app.post('/api/vm/email', async (req, res) => {
    const b = req.body || {};
    if (!b.mailbox) return res.status(400).json({ error: 'falta mailbox' });
    try {
      if (b.email !== undefined) await pool.query('UPDATE voicemail SET email=$2 WHERE mailbox=$1', [String(b.mailbox), b.email || null]);
      await pool.query(`INSERT INTO pbxng_mailboxes (mailbox, email, email_enabled, email_attach, email_transcribe, email_delete)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (mailbox) DO UPDATE SET email=COALESCE(EXCLUDED.email, pbxng_mailboxes.email),
            email_enabled=EXCLUDED.email_enabled, email_attach=EXCLUDED.email_attach,
            email_transcribe=EXCLUDED.email_transcribe, email_delete=EXCLUDED.email_delete`,
        [String(b.mailbox), b.email || null, b.email_enabled !== false, b.email_attach !== false, b.email_transcribe !== false, !!b.email_delete]);
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });
  // Forzar el envio de un mensaje puntual (boton "Enviar por correo" en el panel)
  app.post('/api/vm/email/send', async (req, res) => {
    const { mailbox, id, folder } = req.body || {};
    if (!mailbox || !id) return res.status(400).json({ error: 'faltan mailbox/id' });
    try {
      const smtp = await smtpFor(1);
      if (!smtp) return res.status(400).json({ error: 'sin configuración SMTP activa' });
      const { rows } = await pool.query(`SELECT v.mailbox, v.fullname, COALESCE(NULLIF(v.email,''), m.email, '') AS email,
          COALESCE(m.email_attach,true) AS email_attach, COALESCE(m.email_transcribe,true) AS email_transcribe
        FROM voicemail v LEFT JOIN pbxng_mailboxes m ON m.mailbox=v.mailbox WHERE v.mailbox=$1`, [String(mailbox)]);
      const box = rows[0];
      if (!box || !box.email) return res.status(400).json({ error: 'el buzón no tiene email configurado' });
      let list = [];
      try { list = await vmList(mailbox); } catch (_) {}
      const msg = (Array.isArray(list) ? list : []).find((m) => String(m.id) === String(id)) || { id, folder: folder || 'INBOX', callerid: '', origtime: Math.floor(Date.now() / 1000), duration: 0 };
      const { rows: br } = await pool.query("SELECT value FROM pbxng_settings WHERE key='brand_name'");
      await vmSendOne(smtp, (br[0] && br[0].value) || 'PBX-NG', box, msg);
      await pool.query('INSERT INTO pbxng_vm_sent (mailbox,mid,folder,origtime,to_addr,ok) VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (mailbox,mid) DO UPDATE SET ok=true, err=NULL, sent_at=now()',
        [String(mailbox), String(id), msg.folder || 'INBOX', msg.origtime || 0, box.email]);
      res.json({ ok: true, to: box.email });
    } catch (e) { res.status(500).json({ error: smtpHint(e) }); }
  });

  // --- IVR: generar audio por TTS y desplegarlo a Asterisk ---
  app.get('/api/ivr/audios', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,text,voice,ref,created_at FROM pbxng_ivr_audios ORDER BY created_at DESC'); res.json(rows); } catch (e) { errorHttp(res, e); } });
  app.post('/api/ivr/gen-audio', async (req, res) => {
    try {
      const b = req.body || {}; const text = (b.text || '').trim();
      if (!text) return res.status(400).json({ error: 'texto requerido' });
      let name = (b.name || ('ivr_' + Date.now())).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || ('ivr_' + Date.now());
      const u = await vozBase();
      const r = await fetch(u + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: b.voice, rate: 8000, format: 'wav' }), signal: AbortSignal.timeout(25000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return res.status(500).json({ error: 'TTS devolvió vacío' });
      const sr = await astFwd('POST', '/sound', { name, b64: buf.toString('base64') }, 15000).then((x) => x.json());
      if (!sr.ok) return res.status(500).json({ error: 'deploy: ' + (sr.error || '?') });
      await pool.query("INSERT INTO pbxng_ivr_audios(name,text,voice,ref) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO UPDATE SET text=$2,voice=$3,ref=$4,created_at=now()", [name, text, b.voice || '', sr.ref]);
      res.json({ ok: true, ref: sr.ref, name });
    } catch (e) { errorHttp(res, e); }
  });
  app.delete('/api/ivr/audios/:id', async (req, res) => { try { await pool.query('DELETE FROM pbxng_ivr_audios WHERE id=$1', [req.params.id]); res.json({ ok: true }); } catch (e) { errorHttp(res, e); } });

  // ---------------- AI IVR (agentes) ----------------
  function aiAgentDialplan(exten, id) {
    return [['ivr', exten, 1, 'NoOp', 'AI IVR agente ' + id], ['ivr', exten, 2, 'Answer', ''], ['ivr', exten, 3, 'Stasis', 'pbxng,ai,' + id], ['ivr', exten, 4, 'Hangup', '']];
  }

  app.get('/api/ai-agents', async (req, res) => {
    try { const { rows } = await pool.query('SELECT id,name,exten,greeting,system_prompt,voice,provider,model,enabled,sales_exten,support_exten,default_exten,crm_webhook,greeting_text FROM pbxng_ai_agents ORDER BY id'); res.json(rows); }
    catch (e) { errorHttp(res, e); }
  });
  app.post('/api/ai-agents', async (req, res) => {
    const { name, exten, greeting = 'demo-congrats', system_prompt = '', voice = 'es-ES', provider = 'openai', model = 'gpt-4o-mini', enabled = true, sales_exten = '', support_exten = '', default_exten = '', crm_webhook = '', greeting_text = '' } = req.body || {};
    if (!name || !exten) return res.status(400).json({ error: 'name y exten son obligatorios' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('INSERT INTO pbxng_ai_agents (name,exten,greeting,system_prompt,voice,provider,model,enabled,sales_exten,support_exten,default_exten,crm_webhook,greeting_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id', [name, exten, greeting, system_prompt, voice, provider, model, enabled, sales_exten, support_exten, default_exten, crm_webhook, greeting_text]);
      await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [exten]);
      for (const r of aiAgentDialplan(exten, rows[0].id)) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
      await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: rows[0].id, exten });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.put('/api/ai-agents/:id', async (req, res) => {
    const { id } = req.params;
    const { name, exten, greeting = 'demo-congrats', system_prompt = '', voice = 'es-ES', provider = 'openai', model = 'gpt-4o-mini', enabled = true, sales_exten = '', support_exten = '', default_exten = '', crm_webhook = '', greeting_text = '' } = req.body || {};
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: old } = await c.query('SELECT exten FROM pbxng_ai_agents WHERE id=$1', [id]);
      if (!old[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'agente no existe' }); }
      await c.query('UPDATE pbxng_ai_agents SET name=$1,exten=$2,greeting=$3,system_prompt=$4,voice=$5,provider=$6,model=$7,enabled=$8,sales_exten=$10,support_exten=$11,default_exten=$12,crm_webhook=$13,greeting_text=$14 WHERE id=$9', [name, exten, greeting, system_prompt, voice, provider, model, enabled, id, sales_exten, support_exten, default_exten, crm_webhook, greeting_text]);
      await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [old[0].exten]);
      if (exten !== old[0].exten) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [exten]);
      for (const r of aiAgentDialplan(exten, id)) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
      await c.query('COMMIT'); broadcastSoon(); res.json({ updated: id, exten });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.delete('/api/ai-agents/:id', async (req, res) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('SELECT exten FROM pbxng_ai_agents WHERE id=$1', [req.params.id]);
      if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].exten]);
      await c.query('DELETE FROM pbxng_ai_agents WHERE id=$1', [req.params.id]);
      await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: req.params.id });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  app.get('/api/ivr', async (req, res) => {
    try { const { rows: ivrs } = await pool.query('SELECT id,name,exten,greeting,timeout,tenant_id,flow FROM pbxng_ivr ORDER BY id'); for (const iv of ivrs) { const { rows: o } = await pool.query('SELECT digit,dest_type,dest_value FROM pbxng_ivr_options WHERE ivr_id=$1 ORDER BY digit', [iv.id]); iv.options = o; } res.json(ivrs); }
    catch (e) { errorHttp(res, e); }
  });
  function buildIvrDialplan(exten, greeting, timeout, options) {
    const rows = [['ivr', exten, 1, 'Answer', ''], ['ivr', exten, 2, 'Read', `SEL,${greeting},1,,1,${timeout}`]];
    options.forEach((o, i) => rows.push(['ivr', exten, 3 + i, 'GotoIf', `$["\${SEL}"="${o.digit}"]?${100 + i * 10}`]));
    rows.push(['ivr', exten, 3 + options.length, 'Goto', `${exten},2`]);
    options.forEach((o, i) => {
      const b = 100 + i * 10; const v = o.dest_value;
      rows.push(['ivr', exten, b, 'NoOp', `Opcion ${o.digit} -> ${o.dest_type}:${v || ''}`]);
      if (o.dest_type === 'extension') { rows.push(['ivr', exten, b + 1, 'Dial', `PJSIP/${v},30`]); rows.push(['ivr', exten, b + 2, 'Hangup', '']); }
      else if (o.dest_type === 'ringgroup') rows.push(['ivr', exten, b + 1, 'Goto', `internal,${v},1`]);
      else if (o.dest_type === 'queue') { rows.push(['ivr', exten, b + 1, 'Queue', v]); rows.push(['ivr', exten, b + 2, 'Hangup', '']); }
      else if (o.dest_type === 'voicemail') { rows.push(['ivr', exten, b + 1, 'VoiceMail', `${v}@default,u`]); rows.push(['ivr', exten, b + 2, 'Hangup', '']); }
      else if (o.dest_type === 'ivr' || o.dest_type === 'ai') rows.push(['ivr', exten, b + 1, 'Goto', `ivr,${v},1`]);
      else rows.push(['ivr', exten, b + 1, 'Hangup', '']);
    });
    return rows;
  }
  app.post('/api/ivr', async (req, res) => {
    const { name, exten, greeting = 'demo-congrats', timeout = 10, options = [], tenant_id = 1, flow = null } = req.body || {};
    if (!name || !exten) return res.status(400).json({ error: 'name y exten son obligatorios' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('INSERT INTO pbxng_ivr (name,exten,greeting,timeout,tenant_id,flow) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [name, exten, greeting, timeout, tenant_id, flow]);
      const id = rows[0].id;
      for (const o of options) await c.query('INSERT INTO pbxng_ivr_options (ivr_id,digit,dest_type,dest_value) VALUES ($1,$2,$3,$4)', [id, o.digit, o.dest_type, o.dest_value]);
      await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [exten]);
      for (const r of buildIvrDialplan(exten, greeting, timeout, options)) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
      await c.query('COMMIT'); res.status(201).json({ created: id, exten });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.put('/api/ivr/:id', async (req, res) => {
    const { id } = req.params;
    const { name, exten, greeting = 'demo-congrats', timeout = 10, options = [], flow = null } = req.body || {};
    if (!name || !exten) return res.status(400).json({ error: 'name y exten son obligatorios' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: old } = await c.query('SELECT exten FROM pbxng_ivr WHERE id=$1', [id]);
      if (!old[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'IVR no existe' }); }
      await c.query('UPDATE pbxng_ivr SET name=$1,exten=$2,greeting=$3,timeout=$4,flow=$5 WHERE id=$6', [name, exten, greeting, timeout, flow, id]);
      await c.query('DELETE FROM pbxng_ivr_options WHERE ivr_id=$1', [id]);
      for (const o of options) await c.query('INSERT INTO pbxng_ivr_options (ivr_id,digit,dest_type,dest_value) VALUES ($1,$2,$3,$4)', [id, o.digit, o.dest_type, o.dest_value]);
      await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [old[0].exten]);
      if (exten !== old[0].exten) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [exten]);
      for (const r of buildIvrDialplan(exten, greeting, timeout, options)) await c.query('INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', r);
      await c.query('COMMIT'); broadcastSoon(); res.json({ updated: id, exten });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  app.delete('/api/ivr/:id', async (req, res) => {
    const { id } = req.params; const c = await pool.connect();
    try { await c.query('BEGIN'); const { rows } = await c.query('SELECT exten FROM pbxng_ivr WHERE id=$1', [id]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].exten]); await c.query('DELETE FROM pbxng_ivr WHERE id=$1', [id]); await c.query('COMMIT'); res.json({ deleted: id }); }
    catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  // ---------------------------------------------------------------------------
  //  Colas completas (bloque 1+2): los campos nativos viven en la tabla realtime
  //  `queues` (app_queue ya los soporta); pbxng_queues guarda lo nuestro (destino
  //  al vencer la espera, grabacion, anuncios por TTS).
  // ---------------------------------------------------------------------------
  const Q_NATIVE = ['strategy', 'timeout', 'musiconhold', 'maxlen', 'retry', 'wrapuptime', 'weight',
    'servicelevel', 'joinempty', 'leavewhenempty', 'ringinuse', 'autofill', 'autopause',
    'reportholdtime', 'memberdelay', 'announce_frequency', 'announce_holdtime', 'announce_position',
    'periodic_announce', 'periodic_announce_frequency', 'monitor_type', 'monitor_format'];
  const Q_DEFAULTS = { strategy: 'ringall', timeout: 20, musiconhold: 'default', maxlen: 0, retry: 5,
    wrapuptime: 10, weight: 0, servicelevel: 30, joinempty: 'yes', leavewhenempty: 'no',
    ringinuse: 'no', autofill: 'yes', autopause: 'no', reportholdtime: 'no', memberdelay: 0,
    announce_frequency: 0, announce_holdtime: 'no', announce_position: 'no',
    periodic_announce: null, periodic_announce_frequency: 0, monitor_type: null, monitor_format: 'wav' };

  async function queueDialplan(c, q) {
    // 1 NoOp · 2 Answer · [MixMonitor] · [Playback bienvenida] · Queue(...) · destino al vencer
    const rows = [];
    let p = 1;
    rows.push([p++, 'NoOp', 'Cola ' + q.name + ' (' + (q.label || q.name) + ')']);
    rows.push([p++, 'Answer', '']);
    if (q.record) rows.push([p++, 'MixMonitor', 'pbxng-q' + q.name + '-${UNIQUEID}.wav,b']);
    if (q.welcome_ref) rows.push([p++, 'Playback', q.welcome_ref]);
    const maxw = Number(q.max_wait || 0) > 0 ? String(q.max_wait) : '';
    rows.push([p++, 'Queue', q.name + ',tT,,,' + maxw]);
    const dest = q.timeout_dest || 'hangup';
    const val = String(q.timeout_value || '').trim();
    if (dest === 'ext' && val) rows.push([p++, 'Goto', 'internal,' + val + ',1']);
    else if (dest === 'voicemail' && val) rows.push([p++, 'VoiceMail', val + '@default,u']);
    else if (dest === 'queue' && val) rows.push([p++, 'Queue', val + ',tT']);
    else if (dest === 'ivr' && val) rows.push([p++, 'Goto', 'ivr,' + val + ',1']);
    else rows.push([p++, 'Hangup', '']);
    if (dest !== 'hangup') rows.push([p++, 'Hangup', '']);
    await setDialplan(c, 'ivr', q.access_exten, rows);
  }
  async function queueFull(name) {
    const { rows } = await pool.query(`SELECT pq.*, ${Q_NATIVE.map((x) => 'q.' + x).join(', ')} FROM pbxng_queues pq LEFT JOIN queues q ON q.name = pq.name WHERE pq.name=$1`, [name]);
    return rows[0] || null;
  }
  // TTS -> prompt de Asterisk (reusa el pipeline del IVR: voz propia, sin subir WAVs)
  async function queueTts(text, voice, name) {
    const u = await vozBase();
    const r = await fetch(u + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voice || undefined, rate: 8000, format: 'wav' }), signal: AbortSignal.timeout(30000) });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('el TTS devolvió audio vacío');
    const sr = await astFwd('POST', '/sound', { name, b64: buf.toString('base64') }, 20000).then((x) => x.json());
    if (!sr.ok) throw new Error('no se pudo desplegar el audio: ' + (sr.error || '?'));
    return sr.ref;   // p.ej. custom/q_ventas_welcome
  }
  app.get('/api/queues', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT pq.*, ${Q_NATIVE.map((x) => 'q.' + x).join(', ')},
          (SELECT count(*) FROM queue_members m WHERE m.queue_name = pq.name) AS members
        FROM pbxng_queues pq LEFT JOIN queues q ON q.name = pq.name ORDER BY pq.name`);
      res.json(rows);
    } catch (e) { errorHttp(res, e); }
  });
  function qNative(b) {
    const out = {};
    for (const k of Q_NATIVE) out[k] = (b[k] === undefined || b[k] === '') ? Q_DEFAULTS[k] : b[k];
    if (out.monitor_type !== 'MixMonitor') out.monitor_type = null;   // la grabacion la maneja el dialplan
    return out;
  }
  async function saveQueue(b, creating) {
    const name = String(b.name || '').trim();
    const access_exten = String(b.access_exten || '').trim();
    if (!name) throw new Error('name es obligatorio');
    if (creating && !access_exten) throw Object.assign(new Error('access_exten es obligatorio'), { status: 400 });
    const n = qNative(b);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const cols = Object.keys(n);
      if (creating) {
        await c.query(`INSERT INTO queues (name, ${cols.join(',')}) VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(',')})`, [name, ...cols.map((k) => n[k])]);
        await c.query('INSERT INTO pbxng_queues (name,label,access_exten,tenant_id) VALUES ($1,$2,$3,$4)', [name, b.label || name, access_exten, b.tenant_id || 1]);
      } else {
        await c.query(`UPDATE queues SET ${cols.map((k, i) => k + '=$' + (i + 2)).join(', ')} WHERE name=$1`, [name, ...cols.map((k) => n[k])]);
        await c.query('UPDATE pbxng_queues SET label=$2, access_exten=COALESCE(NULLIF($3,\'\'), access_exten) WHERE name=$1', [name, b.label || name, access_exten]);
      }
      // metadatos propios
      await c.query(`UPDATE pbxng_queues SET max_wait=$2, timeout_dest=$3, timeout_value=$4, record=$5, voice=COALESCE($6, voice) WHERE name=$1`,
        [name, Number(b.max_wait || 0), b.timeout_dest || 'hangup', b.timeout_value || null, !!b.record, b.voice || null]);
      // anuncios por TTS (solo si cambio el texto)
      const { rows: cur } = await c.query('SELECT welcome_text, welcome_ref, periodic_text, periodic_ref, voice FROM pbxng_queues WHERE name=$1', [name]);
      const q0 = cur[0] || {};
      const voice = b.voice || q0.voice || null;
      const wTxt = (b.welcome_text || '').trim(), pTxt = (b.periodic_text || '').trim();
      let wRef = q0.welcome_ref, pRef = q0.periodic_ref;
      if (wTxt !== (q0.welcome_text || '') || (wTxt && !wRef)) {
        wRef = wTxt ? await queueTts(wTxt, voice, 'q_' + name.replace(/[^a-zA-Z0-9_-]/g, '') + '_welcome') : null;
        await c.query('UPDATE pbxng_queues SET welcome_text=$2, welcome_ref=$3 WHERE name=$1', [name, wTxt || null, wRef]);
      }
      if (pTxt !== (q0.periodic_text || '') || (pTxt && !pRef)) {
        pRef = pTxt ? await queueTts(pTxt, voice, 'q_' + name.replace(/[^a-zA-Z0-9_-]/g, '') + '_periodic') : null;
        await c.query('UPDATE pbxng_queues SET periodic_text=$2, periodic_ref=$3 WHERE name=$1', [name, pTxt || null, pRef]);
      }
      await c.query('UPDATE queues SET periodic_announce=$2, periodic_announce_frequency=$3 WHERE name=$1',
        [name, pRef || null, pRef ? Number(b.periodic_announce_frequency || 60) : 0]);
      // dialplan del numero de acceso
      const { rows: qr } = await c.query('SELECT * FROM pbxng_queues WHERE name=$1', [name]);
      await queueDialplan(c, qr[0]);
      await c.query('COMMIT');
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
    broadcastSoon();
    return await queueFull(name);
  }
  app.post('/api/queues', async (req, res) => {
    try { res.status(201).json(await saveQueue(req.body || {}, true)); }
    catch (e) { errorHttp(res, e); }
  });
  app.put('/api/queues/:name', async (req, res) => {
    try { res.json(await saveQueue({ ...(req.body || {}), name: req.params.name }, false)); }
    catch (e) { errorHttp(res, e); }
  });
  // Escuchar un anuncio antes de guardarlo (devuelve el WAV, no lo despliega)
  app.post('/api/queues/preview-announce', async (req, res) => {
    try {
      const b = req.body || {}; const text = (b.text || '').trim();
      if (!text) return res.status(400).json({ error: 'texto requerido' });
      const u = await vozBase();
      const r = await fetch(u + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: b.voice || undefined, rate: 22050, format: 'wav' }), signal: AbortSignal.timeout(30000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return res.status(500).json({ error: 'el TTS devolvió audio vacío' });
      res.set('Content-Type', 'audio/wav').send(buf);
    } catch (e) { errorHttp(res, e); }
  });
  app.delete('/api/queues/:name', async (req, res) => {
    const { name } = req.params; const c = await pool.connect();
    try { await c.query('BEGIN'); const { rows } = await c.query('SELECT access_exten FROM pbxng_queues WHERE name=$1', [name]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].access_exten]); await c.query('DELETE FROM queue_members WHERE queue_name=$1', [name]); await c.query('DELETE FROM queues WHERE name=$1', [name]); await c.query('DELETE FROM pbxng_queues WHERE name=$1', [name]); await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: name }); }
    catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.post('/api/queues/:name/members', async (req, res) => {
    const { name } = req.params; const { ext } = req.body || {};
    if (!ext) return res.status(400).json({ error: 'ext es obligatorio' });
    try { await pool.query(`INSERT INTO queue_members (queue_name,interface,membername,state_interface,penalty,paused,uniqueid) VALUES ($1,$2,$3,$2,0,0,(SELECT COALESCE(MAX(uniqueid),0)+1 FROM queue_members)) ON CONFLICT (queue_name,interface) DO NOTHING`, [name, 'PJSIP/' + ext, ext]); broadcastSoon(); res.status(201).json({ added: ext }); }
    catch (e) { errorHttp(res, e); }
  });
  app.delete('/api/queues/:name/members/:ext', async (req, res) => { const { name, ext } = req.params; try { await pool.query('DELETE FROM queue_members WHERE queue_name=$1 AND interface=$2', [name, 'PJSIP/' + ext]); broadcastSoon(); res.json({ removed: ext }); } catch (e) { errorHttp(res, e); } });
  app.get('/api/queues/:name/live', async (req, res) => { try { res.json({ output: await amiCommand('queue show ' + req.params.name) }); } catch (e) { errorHttp(res, e); } });

  app.get('/api/ringgroups', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,label,access_exten,members,strategy,ring_time FROM pbxng_ringgroups ORDER BY id'); res.json(rows); } catch (e) { errorHttp(res, e); } });
  app.post('/api/ringgroups', async (req, res) => {
    const { name, label, access_exten, members, strategy = 'ringall', ring_time = 25 } = req.body || {};
    if (!name || !access_exten || !members) return res.status(400).json({ error: 'name, access_exten y members son obligatorios' });
    const list = String(members).split(',').map(s => s.trim()).filter(Boolean); const dialStr = list.map(e => 'PJSIP/' + e).join('&');
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query('INSERT INTO pbxng_ringgroups (name,label,access_exten,members,strategy,ring_time) VALUES ($1,$2,$3,$4,$5,$6)', [name, label || name, access_exten, list.join(','), strategy, ring_time]); await setDialplan(c, 'ivr', access_exten, [[1, 'NoOp', 'Ring group ' + name], [2, 'Dial', dialStr + ',' + ring_time], [3, 'Hangup', '']]); await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: name }); }
    catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.delete('/api/ringgroups/:name', async (req, res) => { const { name } = req.params; const c = await pool.connect(); try { await c.query('BEGIN'); const { rows } = await c.query('SELECT access_exten FROM pbxng_ringgroups WHERE name=$1', [name]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].access_exten]); await c.query('DELETE FROM pbxng_ringgroups WHERE name=$1', [name]); await c.query('COMMIT'); res.json({ deleted: name }); } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); } });

  app.get('/api/paging', async (req, res) => { try { const { rows } = await pool.query('SELECT id,name,label,access_exten,members FROM pbxng_paging ORDER BY id'); res.json(rows); } catch (e) { errorHttp(res, e); } });
  app.post('/api/paging', async (req, res) => {
    const { name, label, access_exten, members } = req.body || {};
    if (!name || !access_exten || !members) return res.status(400).json({ error: 'name, access_exten y members son obligatorios' });
    const list = String(members).split(',').map(s => s.trim()).filter(Boolean); const pageStr = list.map(e => 'PJSIP/' + e).join('&');
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query('INSERT INTO pbxng_paging (name,label,access_exten,members) VALUES ($1,$2,$3,$4)', [name, label || name, access_exten, list.join(',')]); await setDialplan(c, 'ivr', access_exten, [[1, 'NoOp', 'Paging ' + name], [2, 'Page', pageStr + ',i'], [3, 'Hangup', '']]); await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: name }); }
    catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.delete('/api/paging/:name', async (req, res) => { const { name } = req.params; const c = await pool.connect(); try { await c.query('BEGIN'); const { rows } = await c.query('SELECT access_exten FROM pbxng_paging WHERE name=$1', [name]); if (rows[0]) await c.query("DELETE FROM extensions WHERE context='ivr' AND exten=$1", [rows[0].access_exten]); await c.query('DELETE FROM pbxng_paging WHERE name=$1', [name]); await c.query('COMMIT'); res.json({ deleted: name }); } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); } });

  app.get('/api/mailboxes', async (req, res) => { try { const { rows } = await pool.query("SELECT mailbox,fullname,email FROM pbxng_mailboxes ORDER BY mailbox"); res.json(rows); } catch (e) { errorHttp(res, e); } });
  app.post('/api/mailboxes', async (req, res) => {
    const { mailbox, password, fullname, email, context = 'default' } = req.body || {};
    if (!mailbox || !password) return res.status(400).json({ error: 'mailbox y password son obligatorios' });
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query("INSERT INTO voicemail (mailbox,context,password,fullname,email) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [mailbox, context, String(password), fullname || mailbox, email || null]); await c.query("INSERT INTO pbxng_mailboxes (mailbox,fullname,email) VALUES ($1,$2,$3) ON CONFLICT (mailbox) DO UPDATE SET fullname=EXCLUDED.fullname,email=EXCLUDED.email", [mailbox, fullname || mailbox, email || null]); await c.query('COMMIT'); res.status(201).json({ created: mailbox }); }
    catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.delete('/api/mailboxes/:mailbox', async (req, res) => { const { mailbox } = req.params; const c = await pool.connect(); try { await c.query('BEGIN'); await c.query('DELETE FROM voicemail WHERE mailbox=$1', [mailbox]); await c.query('DELETE FROM pbxng_mailboxes WHERE mailbox=$1', [mailbox]); await c.query('COMMIT'); res.json({ deleted: mailbox }); } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); } });

  const FEATURE_CODES = [
    { code: '*43', name: 'Prueba de eco', desc: 'Repite tu voz para probar audio', rows: [[1, 'Answer', ''], [2, 'Echo', ''], [3, 'Hangup', '']] },
    { code: '*65', name: 'Decir mi número', desc: 'Locuta el número del interno', rows: [[1, 'Answer', ''], [2, 'SayDigits', '${CALLERID(num)}'], [3, 'Hangup', '']] },
    { code: '*97', name: 'Mi buzón de voz', desc: 'Entra al buzón del interno que llama', rows: [[1, 'Answer', ''], [2, 'VoiceMailMain', '${CALLERID(num)}@default'], [3, 'Hangup', '']] },
    { code: '*98', name: 'Buzón (otro)', desc: 'Pide número de buzón y PIN', rows: [[1, 'Answer', ''], [2, 'VoiceMailMain', ''], [3, 'Hangup', '']] },
  ];
  app.get('/api/featurecodes', async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT exten FROM extensions WHERE context='internal' AND exten = ANY($1)", [FEATURE_CODES.map(f => f.code)]);
      const installed = new Set(rows.map(r => r.exten));
      res.json(FEATURE_CODES.map(f => ({ code: f.code, name: f.name, desc: f.desc, installed: installed.has(f.code) })));
    } catch (e) { errorHttp(res, e); }
  });
  app.post('/api/featurecodes/install', async (req, res) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const f of FEATURE_CODES) await setDialplan(c, 'internal', f.code, f.rows);
      await c.query('COMMIT'); broadcastSoon(); res.json({ ok: true, count: FEATURE_CODES.length });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.post('/api/featurecodes/uninstall', async (req, res) => {
    try { await pool.query("DELETE FROM extensions WHERE context='internal' AND exten = ANY($1)", [FEATURE_CODES.map(f => f.code)]); broadcastSoon(); res.json({ ok: true }); }
    catch (e) { errorHttp(res, e); }
  });

  /* ═══════════════ Aparcado y música en espera ═══════════════════════════════
   *
   * Estas dos NO viven en la base (Asterisk las lee de archivos), así que el panel
   * genera su config en el volumen compartido y recarga por AMI. Ver astconf.js.
   * (La captura de llamada —pickup-groups— sí es realtime, en ps_endpoints: sigue en app.js.)
   * ==========================================================================*/

  const setGet = async (k, def) => { try { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value != null ? rows[0].value : def; } catch (_) { return def; } };
  const setPut = (k, v) => pool.query("INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2", [k, String(v)]);

  // --- Aparcado de llamadas ---
  app.get('/api/parking', async (req, res) => {
    try {
      res.json({
        parkext: await setGet('park_ext', '700'),
        desde: parseInt(await setGet('park_desde', '701'), 10),
        hasta: parseInt(await setGet('park_hasta', '720'), 10),
        parkingtime: parseInt(await setGet('park_time', '300'), 10),
        comebacktoorigin: (await setGet('park_comeback', '1')) === '1',
      });
    } catch (e) { errorHttp(res, e); }
  });
  app.put('/api/parking', async (req, res) => {
    const b = req.body || {};
    try {
      if (b.parkext) await setPut('park_ext', String(b.parkext).replace(/\D/g, '') || '700');
      if (b.desde) await setPut('park_desde', parseInt(b.desde, 10) || 701);
      if (b.hasta) await setPut('park_hasta', parseInt(b.hasta, 10) || 720);
      if (b.parkingtime) await setPut('park_time', Math.max(10, parseInt(b.parkingtime, 10) || 300));
      if (b.comebacktoorigin !== undefined) await setPut('park_comeback', b.comebacktoorigin ? '1' : '0');
      res.json({ ok: true, pendiente: 'aplicar para que Asterisk lo tome' });
    } catch (e) { errorHttp(res, e); }
  });
  app.post('/api/parking/apply', async (req, res) => {
    try {
      const cfg = {
        parkext: await setGet('park_ext', '700'),
        desde: parseInt(await setGet('park_desde', '701'), 10),
        hasta: parseInt(await setGet('park_hasta', '720'), 10),
        parkingtime: parseInt(await setGet('park_time', '300'), 10),
        comebacktoorigin: (await setGet('park_comeback', '1')) === '1',
      };
      astconf.parking(cfg);
      const out = await amiCommand('module reload res_parking.so');
      res.json({ ok: true, cfg, salida: String(out || '').slice(0, 400) });
    } catch (e) { errorHttp(res, e); }
  });
  /* Plazas del aparcado, ESTRUCTURADAS: devolvemos el rango completo y cuáles están
   * ocupadas, para que el panel dibuje una tabla de verdad y no un volcado de texto.
   * Los datos salen de la acción AMI ParkedCalls (eventos), no de parsear el CLI. */
  app.get('/api/parking/lots', async (req, res) => {
    try {
      const desde = parseInt(await setGet('park_desde', '701'), 10);
      const hasta = parseInt(await setGet('park_hasta', '720'), 10);
      const tiempo = parseInt(await setGet('park_time', '300'), 10);

      // ParkedCalls devuelve un evento por llamada aparcada.
      let evs = [];
      try {
        const r = await amiAction({ Action: 'ParkedCalls' });
        evs = (r && (r.events || r.eventlist || [])) || [];
        if (!Array.isArray(evs)) evs = [];
      } catch (_) {}

      const ocupadas = evs
        .filter((e) => String(e.event || e.Event || '').toLowerCase() === 'parkedcall')
        .map((e) => ({
          plaza: parseInt(e.parkingspace || e.ParkingSpace, 10),
          canal: e.parkeechannel || e.ParkeeChannel || '',
          numero: e.parkeecalleridnum || e.ParkeeCallerIDNum || '',
          nombre: e.parkeecalleridname || e.ParkeeCallerIDName || '',
          aparcada_por: e.parkerdialstring || e.ParkerDialString || '',
          restante: parseInt(e.parkingtimeout || e.ParkingTimeout, 10) || null,
        }))
        .filter((p) => p.plaza);

      const mapa = Object.fromEntries(ocupadas.map((o) => [o.plaza, o]));
      const plazas = [];
      for (let n = Math.min(desde, hasta); n <= Math.max(desde, hasta); n++) {
        plazas.push(mapa[n] ? { plaza: n, libre: false, ...mapa[n] } : { plaza: n, libre: true });
      }
      res.json({ plazas, ocupadas: ocupadas.length, total: plazas.length, parkingtime: tiempo });
    } catch (e) { errorHttp(res, e); }
  });

  // --- Música en espera ---
  app.get('/api/moh', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM pbxng_moh_classes ORDER BY nombre');
      res.json(rows.map((c) => ({ ...c, archivos: astconf.mohArchivos(c.nombre) })));
    } catch (e) { errorHttp(res, e); }
  });
  app.post('/api/moh', async (req, res) => {
    const b = req.body || {};
    const nombre = String(b.nombre || '').replace(/[^\w.\-]/g, '').slice(0, 40);
    if (!nombre) return res.status(400).json({ error: 'nombre inválido' });
    if (nombre === 'default') return res.status(400).json({ error: '"default" es la clase de fábrica' });
    try {
      await pool.query("INSERT INTO pbxng_moh_classes (nombre, descripcion, sort, announcement) VALUES ($1,$2,$3,$4) ON CONFLICT (nombre) DO UPDATE SET descripcion=EXCLUDED.descripcion, sort=EXCLUDED.sort, announcement=EXCLUDED.announcement",
        [nombre, b.descripcion || null, ['alpha', 'random', 'randstart'].includes(b.sort) ? b.sort : 'alpha', b.announcement || null]);
      astconf.mohCarpeta(nombre);
      res.json({ ok: true, nombre });
    } catch (e) { errorHttp(res, e); }
  });
  app.delete('/api/moh/:nombre', async (req, res) => {
    try {
      await pool.query('DELETE FROM pbxng_moh_classes WHERE nombre=$1', [req.params.nombre]);
      astconf.mohBorrarCarpeta(req.params.nombre);
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });
  // Subir un audio a una clase (base64, como el resto de las subidas del panel)
  app.post('/api/moh/:nombre/audio', async (req, res) => {
    const b = req.body || {};
    const nombre = String(req.params.nombre).replace(/[^\w.\-]/g, '');
    const file = String(b.filename || '').replace(/[^\w.\-]/g, '').slice(0, 80);
    if (!nombre || !file) return res.status(400).json({ error: 'falta clase o nombre de archivo' });
    if (!/\.(wav|gsm|ulaw|alaw|sln|g722|mp3)$/i.test(file)) return res.status(400).json({ error: 'formato no soportado (wav, gsm, ulaw, alaw, sln, g722, mp3)' });
    try {
      const datos = String(b.data || '').replace(/^data:[^,]+,/, '');
      const buf = Buffer.from(datos, 'base64');
      if (!buf.length) return res.status(400).json({ error: 'archivo vacío' });
      const dir = astconf.mohCarpeta(nombre);
      require('fs').writeFileSync(require('path').join(dir, file), buf);
      res.json({ ok: true, archivo: file, bytes: buf.length });
    } catch (e) { errorHttp(res, e); }
  });
  app.delete('/api/moh/:nombre/audio/:file', async (req, res) => {
    try {
      const dir = astconf.mohCarpeta(String(req.params.nombre).replace(/[^\w.\-]/g, ''));
      require('fs').rmSync(require('path').join(dir, String(req.params.file).replace(/[^\w.\-]/g, '')), { force: true });
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });
  app.post('/api/moh/apply', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM pbxng_moh_classes ORDER BY nombre');
      astconf.moh(rows);
      const out = await amiCommand('moh reload');
      res.json({ ok: true, clases: rows.length, salida: String(out || '').slice(0, 400) });
    } catch (e) { errorHttp(res, e); }
  });

  return { aiAgentDialplan, buildIvrDialplan, vmList };
};
