/* ============================================================================
 *  PBX-NG · Grabaciones y CDR (Grabaciones, Historial de llamadas, Informe).
 *
 *  Todo lo que tiene que ver con el audio grabado y el historial: la marca de
 *  grabación por interno y global (familia `rec` de la AstDB, que el dialplan mira
 *  para decidir el MixMonitor), grabar/parar una llamada en vivo desde la PWA, el
 *  indexador que descubre los WAV de /recordings y los cruza con el CDR, la entrega
 *  del audio (con alcance por extensión para el agente), la transcripción + análisis
 *  (STT del servicio de voz), los picos para la forma de onda, el almacenamiento
 *  remoto (recstore.js: NAS/S3) y el historial (`cdr`, `cdr/report`).
 *
 *  Acceso: las rutas se registran DESPUÉS del gate de auth + RBAC de app.js; qué rol
 *  ve o escribe cada familia (`recordings`, `cdr`, `calls/record`, `extensions/record-all`)
 *  lo decide rbac.js. El alcance fino (un agente sólo escucha/lista lo que pasó por su
 *  interno) se resuelve acá con `extPropia` / `exigirExt` de auth.js.
 * ==========================================================================*/
'use strict';

const recstore = require('./recstore');   // grabaciones: NAS/S3, subida automática y retención local
const report = require('./report');       // informe ejecutivo del CDR (HTML A4)

/**
 * deps:
 *   app          Express (las rutas se registran acá, DESPUÉS del gate)
 *   pool         pg.Pool
 *   ami          instancia de asterisk-manager (el indexador escucha Hangup)
 *   amiAction    (action) => promesa de la respuesta AMI (DBPut/DBDel, MixMonitor)
 *   amiCommand   (cmd) => salida del CLI de Asterisk por AMI (core show channels)
 *   getAri       () => cliente ARI vivo o null (para ubicar el canal del interno)
 *   state        { ari, ami } estado de conexión (mensaje de error cuando no hay canal)
 *   extPropia    (req) => ext propia si el usuario tiene alcance limitado, '' sin interno, null si ve todo (auth.js)
 *   exigirExt    (req, res, ext) => true si puede operar esa ext; ya respondió 403 si no (auth.js)
 *   vozBase      () => URL base del servicio de voz (STT de la transcripción)
 *   errorHttp    traduce errores a {error} con status (errores.js)
 *   logger       fábrica de loggers de log.js
 *
 * Devuelve: { setRecFlag, setRecAll, syncRecFlags, wavToPcm, analyzeText, indexRecordings }.
 *   setRecFlag lo usan las rutas de internos de app.js (crear/editar con `record`);
 *   wavToPcm y analyzeText los comparte la transcripción del buzón de voz (vm/transcribe).
 */
module.exports = function init(deps) {
  const { app, pool, ami, amiAction, amiCommand, getAri, state, extPropia, exigirExt, vozBase, errorHttp, logger } = deps;

  /* Marca de grabación en la AstDB (familia `rec`): el dialplan la consulta al armar
   * la llamada; se re-sincroniza desde la base al arrancar porque la AstDB no sobrevive
   * a un contenedor nuevo de Asterisk. */
  async function setRecFlag(ext, on) { try { await amiAction(on ? { Action: 'DBPut', Family: 'rec', Key: String(ext), Val: '1' } : { Action: 'DBDel', Family: 'rec', Key: String(ext) }); } catch (_) {} }
  async function setRecAll(on) { try { await amiAction(on ? { Action: 'DBPut', Family: 'rec', Key: '_ALL_', Val: '1' } : { Action: 'DBDel', Family: 'rec', Key: '_ALL_' }); } catch (_) {} }
  async function syncRecFlags() { try { const { rows } = await pool.query("SELECT id FROM ps_endpoints WHERE pbxng_record=true"); for (const r of rows) await setRecFlag(r.id, true); const { rows: s } = await pool.query("SELECT value FROM pbxng_settings WHERE key='record_all'"); await setRecAll(!!(s[0] && s[0].value === '1')); } catch (_) {} }
  setTimeout(() => { syncRecFlags().catch(() => {}); }, 9000);

  pool.query("INSERT INTO pbxng_rec_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING").catch(e => logger('REC').error('cfg', e));

  app.get('/api/recordings/:id/audio', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT filename, ext, src, dst FROM pbxng_recordings WHERE id=$1 AND deleted=false', [req.params.id]);
      if (!rows[0]) return res.status(404).end();
      // Un agente escucha sólo las llamadas en las que estuvo su interno; el resto es de supervisión.
      const propio = extPropia(req);
      if (propio !== null && ![rows[0].ext, rows[0].src, rows[0].dst].map(v => String(v || '')).includes(propio)) return res.status(403).json({ error: 'no podés acceder a las grabaciones de otra extensión' });
      const _fp = '/recordings/' + require('path').basename(rows[0].filename); const r = require('fs').existsSync(_fp) ? { ok: true, arrayBuffer: async () => require('fs').readFileSync(_fp) } : { ok: false };
      if (!r.ok) return res.status(502).end();
      res.set('Content-Type', 'audio/wav');
      res.set('Content-Disposition', 'inline; filename="' + rows[0].filename + '"');
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    } catch (e) { res.status(500).end(); }
  });

  // ---------- Transcripcion + analisis de grabaciones ----------
  function wavToPcm(buf) {
    if (buf.length < 44 || buf.slice(0, 4).toString() !== 'RIFF') return null;
    let pos = 12, rate = 8000, ch = 1, bits = 16, dataOff = -1, dataLen = 0;
    while (pos + 8 <= buf.length) {
      const cid = buf.slice(pos, pos + 4).toString('latin1'); const sz = buf.readUInt32LE(pos + 4);
      if (cid === 'fmt ') { ch = buf.readUInt16LE(pos + 10); rate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
      else if (cid === 'data') { dataOff = pos + 8; dataLen = Math.min(sz, buf.length - pos - 8); break; }
      pos += 8 + sz + (sz & 1);
    }
    if (dataOff < 0 || bits !== 16) return null;
    let pcm = buf.slice(dataOff, dataOff + dataLen);
    if (ch === 2) {
      const n = Math.floor(pcm.length / 4); const mono = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) { const l = pcm.readInt16LE(i * 4), rr = pcm.readInt16LE(i * 4 + 2); mono.writeInt16LE(Math.max(-32768, Math.min(32767, (l + rr) >> 1)), i * 2); }
      pcm = mono;
    }
    return { pcm, rate };
  }
  const STOP_ES = new Set('de la que el en y a los las un una por con no se su para es al lo como mas pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tu te ti tu tus ellas nosotras vosostros vosostras os mio mia mios mias tuyo tuya suyo suya nuestro nuestra vuestro vuestra esos esas estoy esta soy son fue ser hola si claro bueno ok dale gracias buenas buenos dias tardes noches'.split(' '));
  const NEG_W = ['molesto','enojado','enojada','reclamo','queja','quejar','cancelar','cancelacion','pesimo','pesima','horrible','terrible','inaceptable','gerente','supervisor','demanda','furioso','indignado','estafa','robo','mentira','nunca','jamas','harto','cansado','problema','problemas','mal','mala','peor','no funciona','no sirve','desastre','verguenza','urgente','grosero'];
  const POS_W = ['gracias','excelente','perfecto','genial','resuelto','solucionado','amable','satisfecho','contento','contenta','buenisimo','barbaro','joya','agradezco','felicito','rapido','eficiente'];
  function analyzeText(text, durSec) {
    const t = (text || '').toLowerCase();
    const words = t.replace(/[^a-zaeiouunu0-9\s]/gi, ' ').split(/\s+/).filter(Boolean);
    let neg = 0, pos = 0; const flags = [];
    for (const w of NEG_W) { if (t.includes(w)) { neg++; flags.push(w); } }
    for (const w of POS_W) { if (t.includes(w)) pos++; }
    let sentiment = 'neutral';
    if (neg >= 2 && neg > pos) sentiment = 'negativo';
    else if (neg > pos) sentiment = 'tension';
    else if (pos >= 2 && pos > neg) sentiment = 'positivo';
    const conflict = neg >= 2;
    const freq = {};
    for (const w of words) { if (w.length > 3 && !STOP_ES.has(w) && !/^[0-9]+$/.test(w)) freq[w] = (freq[w] || 0) + 1; }
    const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
    const wc = words.length;
    const wpm = durSec ? Math.round(wc / (durSec / 60)) : 0;
    const summary = (text || '').trim().slice(0, 220) + ((text || '').length > 220 ? '…' : '');
    return { sentiment, conflict, neg, pos, flags: [...new Set(flags)].slice(0, 10), keywords, words: wc, wpm, summary };
  }
  async function doTranscribe(id) {
    const { rows } = await pool.query('SELECT filename, duration FROM pbxng_recordings WHERE id=$1 AND deleted=false', [id]);
    if (!rows[0]) throw new Error('grabacion no existe');
    const _fp = '/recordings/' + require('path').basename(rows[0].filename); const r = require('fs').existsSync(_fp) ? { ok: true, arrayBuffer: async () => require('fs').readFileSync(_fp) } : { ok: false };
    if (!r.ok) throw new Error('audio no disponible');
    const wav = Buffer.from(await r.arrayBuffer());
    const pc = wavToPcm(wav);
    if (!pc) throw new Error('formato WAV no soportado (se requiere PCM 16-bit)');
    const base = await vozBase();
    const sr = await fetch(base + '/stt?rate=' + pc.rate, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pc.pcm, signal: AbortSignal.timeout(180000) });
    if (!sr.ok) throw new Error('STT fallo (' + sr.status + ')');
    const sd = await sr.json();
    const text = (sd.text || '').trim();
    const analysis = analyzeText(text, rows[0].duration || 0);
    await pool.query('UPDATE pbxng_recordings SET transcript=$1, analysis=$2, transcribed_at=now() WHERE id=$3', [text, JSON.stringify(analysis), id]);
    return { transcript: text, analysis };
  }
  app.get('/api/recordings/:id/transcript', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT transcript, analysis, extract(epoch from transcribed_at)*1000 AS at FROM pbxng_recordings WHERE id=$1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'no existe' });
      res.json({ transcript: rows[0].transcript || null, analysis: rows[0].analysis || null, at: rows[0].at || null });
    } catch (e) { errorHttp(res, e); }
  });
  app.post('/api/recordings/:id/transcribe', async (req, res) => {
    try { const out = await doTranscribe(req.params.id); res.json(out); }
    catch (e) { errorHttp(res, e); }
  });
  function pcmPeaks(pcm, bars) {
    bars = bars || 40; const n = Math.floor(pcm.length / 2); const per = Math.max(1, Math.floor(n / bars)); const out = []; let max = 1, rawmax = 0;
    for (let b = 0; b < bars; b++) { let sum = 0, cnt = 0; for (let i = b * per; i < (b + 1) * per && i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; cnt++; if (Math.abs(v) > rawmax) rawmax = Math.abs(v); } const rms = cnt ? Math.sqrt(sum / cnt) : 0; out.push(rms); if (rms > max) max = rms; }
    return { peaks: out.map((v) => Math.round((v / max) * 100)), silent: rawmax < 180 };
  }
  app.get('/api/recordings/:id/peaks', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT filename, peaks FROM pbxng_recordings WHERE id=$1 AND deleted=false', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'no existe' });
      if (rows[0].peaks) return res.json(rows[0].peaks);
      const _fp = '/recordings/' + require('path').basename(rows[0].filename); const r = require('fs').existsSync(_fp) ? { ok: true, arrayBuffer: async () => require('fs').readFileSync(_fp) } : { ok: false };
      if (!r.ok) return res.json({ peaks: [], silent: true });
      const pc = wavToPcm(Buffer.from(await r.arrayBuffer()));
      if (!pc) return res.json({ peaks: [], silent: true });
      const out = pcmPeaks(pc.pcm, 40);
      await pool.query('UPDATE pbxng_recordings SET peaks=$1 WHERE id=$2', [JSON.stringify(out), req.params.id]);
      res.json(out);
    } catch (e) { errorHttp(res, e); }
  });

  // Control de llamada en vivo: grabacion (MixMonitor) - publica para la PWA
  app.post('/api/calls/record', async (req, res) => {
    const { ext, action } = req.body || {};
    if (!ext) return res.status(400).json({ error: 'ext requerido' });
    if (!exigirExt(req, res, ext)) return;    // agente y token phone: sólo su propia llamada
    try {
      const ari = getAri();
      let name = null;
      if (ari) { try { const chans = await ari.channels.list(); const ch = chans.find(c => c.name && c.name.startsWith('PJSIP/' + ext + '-')); name = ch && ch.name; } catch (_) {} }
      if (!name && state.ami) {
        /* ARI caido o sin respuesta: el nombre del canal tambien sale por AMI */
        try { const out = await amiCommand('core show channels concise'); const line = String(out).split('\n').find((l) => l.startsWith('PJSIP/' + ext + '-')); if (line) name = line.split('!')[0]; } catch (_) {}
      }
      if (!name) return res.status(404).json({ error: (ari || state.ami) ? 'sin canal activo' : 'Asterisk no disponible (ARI/AMI desconectados)' });
      if (action === 'stop') { await amiAction({ Action: 'StopMixMonitor', Channel: name }); }
      else { const file = 'pbxng-' + ext + '-' + Date.now() + '.wav'; await amiAction({ Action: 'MixMonitor', Channel: name, File: file }); }
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });

  recstore.init(pool);
  report.init(pool);

  // Informe ejecutivo del historial de llamadas (HTML A4 -> imprimir / guardar como PDF)
  app.get('/api/cdr/report', async (req, res) => {
    try {
      const html = await report.build({
        from: req.query.from, to: req.query.to,
        tipo: req.query.tipo, q: req.query.q,
        usuario: (req.user && (req.user.name || req.user.username)) || '',
      });
      res.type('html').send(html);
    } catch (e) { errorHttp(res, e); }
  });
  // Probar el destino de almacenamiento ANTES de confiarle las grabaciones
  app.post('/api/recordings/storage/test', async (req, res) => {
    try { res.json(await recstore.test()); }
    catch (e) { if (e && e.code) return errorHttp(res, e); res.status(400).json({ error: e.message }); }
  });
  // Forzar la subida de lo pendiente (sin esperar la ronda automática)
  app.post('/api/recordings/storage/sync', async (req, res) => {
    try { await recstore.sweep(); res.json({ ok: true }); }
    catch (e) { errorHttp(res, e); }
  });
  app.get('/api/recordings/storage/usage', async (req, res) => { try { res.json(await recstore.usage()); } catch (e) { errorHttp(res, e); } });
  app.post('/api/recordings/storage/nastest', async (req, res) => { try { res.json(await recstore.nastest(req.body || {})); } catch (e) { if (e && e.code) return errorHttp(res, e); res.status(400).json({ error: e.message }); } });

  // Grabaciones (admin)
  // Match de grabación para un diálogo SIP (por from/to y proximidad temporal)
  app.get('/api/recordings/match', async (req, res) => {
    try {
      const a = (req.query.from || '').toString().slice(0, 40);
      const b = (req.query.to || '').toString().slice(0, 40);
      const ts = parseInt(req.query.ts, 10) || 0;
      if (!a && !b) return res.json({});
      // Un agente sólo puede buscar grabaciones de llamadas en las que participó su interno.
      const propio = extPropia(req);
      if (propio !== null && a !== propio && b !== propio) return res.status(403).json({ error: 'no podés acceder a las grabaciones de otra extensión' });
      const { rows } = await pool.query(
        `SELECT id, duration, src, dst, extract(epoch from started_at)*1000 AS started_ms
         FROM pbxng_recordings
         WHERE deleted=false
           AND (src=$1 OR src=$2 OR dst=$1 OR dst=$2)
           AND ($3::bigint = 0 OR abs(extract(epoch from started_at)*1000 - $3::bigint) < 300000)
         ORDER BY ($3::bigint <> 0)::int * abs(extract(epoch from started_at)*1000 - $3::bigint) ASC, id DESC
         LIMIT 1`, [a, b, ts]);
      res.json(rows[0] || {});
    } catch (e) { errorHttp(res, e); }
  });
  app.get('/api/recordings', async (req, res) => {
    try { const { rows } = await pool.query('SELECT id, filename, ext, src, dst, started_at, bytes, duration, storage, remote_url FROM pbxng_recordings WHERE deleted=false ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 500'); res.json(rows); }
    catch (e) { errorHttp(res, e); }
  });
  app.delete('/api/recordings/:id', async (req, res) => {
    try { await pool.query('UPDATE pbxng_recordings SET deleted=true WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
    catch (e) { errorHttp(res, e); }
  });
  app.get('/api/recordings/config', async (req, res) => {
    try { const { rows } = await pool.query("SELECT id, backend, nas_path, s3_endpoint, s3_region, s3_bucket, s3_key, COALESCE(NULLIF(s3_secret,''),'') <> '' AS has_secret, s3_prefix, auto_upload, retain_local, nas_type, nas_server, nas_share, nas_user, COALESCE(NULLIF(nas_pass,''),'') <> '' AS has_nas_pass FROM pbxng_rec_config WHERE id=1"); res.json(rows[0] || {}); }
    catch (e) { errorHttp(res, e); }
  });
  app.post('/api/recordings/config', async (req, res) => {
    const b = req.body || {};
    try {
      await pool.query(`UPDATE pbxng_rec_config SET backend=COALESCE($1,backend), nas_path=$2, s3_endpoint=$3, s3_region=$4, s3_bucket=$5, s3_key=$6, s3_secret=COALESCE(NULLIF($7,''), s3_secret), s3_prefix=COALESCE($8,s3_prefix), auto_upload=COALESCE($9,auto_upload), retain_local=COALESCE($10,retain_local), nas_type=COALESCE($11,nas_type), nas_server=$12, nas_share=$13, nas_user=$14, nas_pass=COALESCE(NULLIF($15,''),nas_pass), updated_at=now() WHERE id=1`,
        [b.backend || null, b.nas_path || null, b.s3_endpoint || null, b.s3_region || null, b.s3_bucket || null, b.s3_key || null, b.s3_secret || '', b.s3_prefix || null, b.auto_upload, b.retain_local, b.nas_type || null, b.nas_server || null, b.nas_share || null, b.nas_user || null, b.nas_pass || '']);
      res.json({ ok: true });
    } catch (e) { errorHttp(res, e); }
  });


  app.get('/api/extensions/record-all', async (req, res) => { try { const { rows } = await pool.query("SELECT value FROM pbxng_settings WHERE key='record_all'"); res.json({ enabled: !!(rows[0] && rows[0].value === '1') }); } catch (e) { errorHttp(res, e); } });
  app.post('/api/extensions/record-all', async (req, res) => { try { const on = !!(req.body && req.body.enabled); await pool.query("INSERT INTO pbxng_settings (key,value) VALUES ('record_all',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [on ? '1' : '0']); await setRecAll(on); res.json({ ok: true, enabled: on }); } catch (e) { errorHttp(res, e); } });

  /* Historial: admin y supervisor ven todo (con ?ext= filtran); agente y token de softphone
   * SIEMPRE ven sólo su interno, se ignore lo que manden en ?ext=. */
  app.get('/api/cdr', async (req, res) => { const limit = Math.min(+(req.query.limit || 100), 500); const propio = extPropia(req); const ext = propio ? propio : (req.query.ext ? String(req.query.ext) : null); if (propio === '') return res.status(403).json({ error: 'tu usuario no tiene interno asignado' }); try { const q = ext ? await pool.query("SELECT start, clid, src, dst, dcontext, duration, billsec, disposition, channel, dstchannel, lastapp, lastdata FROM cdr WHERE src=$2 OR dst=$2 ORDER BY start DESC LIMIT $1", [limit, ext]) : await pool.query("SELECT start, clid, src, dst, dcontext, duration, billsec, disposition, channel, dstchannel, lastapp, lastdata FROM cdr ORDER BY start DESC LIMIT $1", [limit]); res.json(q.rows); } catch (e) { errorHttp(res, e); } });

  // ==================== Indexador de grabaciones (MixMonitor -> pbxng_recordings) ====================
  async function indexRecordings() {
    try {
      const _fs = require('fs'); let files = [];
      try { files = _fs.readdirSync('/recordings').filter(f => f.endsWith('.wav')).map(f => { try { const st = _fs.statSync('/recordings/' + f); return { filename: f, bytes: st.size, mtime: Math.floor(st.mtimeMs / 1000) }; } catch (e) { return null; } }).filter(Boolean); } catch (e) { return; }
      for (const f of (Array.isArray(files) ? files : [])) {
        if (!f.filename || f.bytes == null || f.bytes < 1200) continue;
        const m = /^pbxng-([0-9A-Za-z]+)-(\d+)\.wav$/.exec(f.filename);
        if (!m) continue;
        const rext = m[1]; const epoch = parseInt(m[2], 10);
        const ex = await pool.query('SELECT 1 FROM pbxng_recordings WHERE filename=$1 LIMIT 1', [f.filename]);
        if (ex.rows.length) continue;
        let src = rext, dst = null;
        try {
          const cq = await pool.query(
            "SELECT src, dst FROM cdr WHERE (src=$1 OR dst=$1) AND abs(extract(epoch from start) - $2) < 300 ORDER BY abs(extract(epoch from start) - $2) ASC LIMIT 1",
            [rext, epoch]);
          if (cq.rows[0]) { src = cq.rows[0].src; dst = cq.rows[0].dst; }
        } catch (e) {}
        const dur = Math.max(0, Math.round((f.bytes - 44) / 16000));
        try {
          await pool.query(
            "INSERT INTO pbxng_recordings (filename, ext, src, dst, started_at, bytes, duration, storage, deleted) VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7,'local',false)",
            [f.filename, rext, src, dst, epoch, f.bytes, dur]);
        } catch (e) {}
      }
    } catch (e) {}
  }
  setTimeout(indexRecordings, 8000);
  setInterval(indexRecordings, 45000);
  let _hangIdxT = null; try { ami.on('managerevent', (e) => { const ev = ((e && (e.event || e.Event)) || '').toLowerCase(); if (ev === 'hangup') { clearTimeout(_hangIdxT); _hangIdxT = setTimeout(indexRecordings, 4000); } }); } catch (e) {}
  // ==================== fin indexador ====================

  return { setRecFlag, setRecAll, syncRecFlags, wavToPcm, analyzeText, indexRecordings };
};
