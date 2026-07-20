/* ============================================================================
 *  PBX-NG · Almacenamiento de grabaciones (local / NAS / S3)
 *
 *  El panel ofrecía configurar un NAS o un bucket S3, pero nada subía los archivos:
 *  las grabaciones se quedaban siempre en el disco del servidor. Esto lo resuelve.
 *
 *  - NAS: una copia de archivo a una ruta montada en el servidor (NFS, CIFS, lo que sea).
 *  - S3:  subida por HTTPS con firma AWS SigV4 hecha a mano. Sin SDK: agregar el SDK de
 *         AWS a la imagen por un PUT es traer 20 MB de dependencias para 80 líneas de
 *         crypto. Funciona igual con MinIO, Wasabi, Backblaze o cualquier compatible.
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const REC_DIR = process.env.REC_DIR || '/recordings';
let pool;

function init(_pool) {
  pool = _pool;
  setInterval(() => { sweep().catch((e) => console.error('[recstore]', e.message)); }, 120000);
  setTimeout(() => { sweep().catch(() => {}); }, 45000);
  console.log('[recstore] almacenamiento de grabaciones activo');
}

async function config() {
  const { rows } = await pool.query('SELECT * FROM pbxng_rec_config WHERE id=1');
  return rows[0] || { backend: 'local' };
}

// ---------------------------------------------------------------- S3 (SigV4)
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();

function s3Url(cfg, key) {
  if (cfg.s3_endpoint) {                       // MinIO / Wasabi / B2: path-style
    const u = new URL(cfg.s3_endpoint);
    return { host: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
             secure: u.protocol !== 'http:', path: '/' + cfg.s3_bucket + '/' + key };
  }
  return { host: cfg.s3_bucket + '.s3.' + (cfg.s3_region || 'us-east-1') + '.amazonaws.com',
           port: 443, secure: true, path: '/' + key };
}

function s3Put(cfg, key, body, contentType = 'audio/wav') {
  const { host, port, secure, path: p } = s3Url(cfg, key);
  const region = cfg.s3_region || 'us-east-1';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260713T190000Z
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', p, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + cfg.s3_secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');

  const headers = {
    Host: host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'Content-Type': contentType,
    'Content-Length': body.length,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.s3_key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };

  return new Promise((resolve, reject) => {
    const lib = secure ? https : http;
    const req = lib.request({ method: 'PUT', host, port, path: p, headers, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve((secure ? 'https://' : 'http://') + host + (port && ![80, 443].includes(+port) ? ':' + port : '') + p);
        } else {
          reject(new Error('S3 ' + res.statusCode + ': ' + Buffer.concat(chunks).toString().slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end(body);
  });
}

// ---------------------------------------------------------------- subida de una grabación
async function upload(rec, cfg) {
  const src = path.join(REC_DIR, path.basename(rec.filename));
  const body = await fsp.readFile(src);

  if (cfg.backend === 'nas') {
    if (!cfg.nas_path) throw new Error('falta la ruta del NAS');
    await fsp.mkdir(cfg.nas_path, { recursive: true }).catch(() => {});
    const dst = path.join(cfg.nas_path, path.basename(rec.filename));
    await fsp.copyFile(src, dst);
    return { storage: 'nas', url: dst };
  }
  if (cfg.backend === 's3') {
    if (!cfg.s3_bucket || !cfg.s3_key || !cfg.s3_secret) throw new Error('faltan credenciales de S3');
    const key = (cfg.s3_prefix || 'recordings/') + path.basename(rec.filename);
    const url = await s3Put(cfg, key, body);
    return { storage: 's3', url };
  }
  throw new Error('destino no soportado: ' + cfg.backend);
}

/** Ronda periódica: sube lo que quedó local y, si corresponde, libera el disco. */
async function sweep() {
  const cfg = await config();
  if (!cfg || cfg.backend === 'local' || !cfg.auto_upload) return;
  const { rows } = await pool.query(
    "SELECT id, filename FROM pbxng_recordings WHERE deleted=false AND storage='local' ORDER BY id LIMIT 20");
  for (const rec of rows) {
    try {
      const r = await upload(rec, cfg);
      await pool.query('UPDATE pbxng_recordings SET storage=$2, remote_url=$3 WHERE id=$1', [rec.id, r.storage, r.url]);
      // Liberar el disco local solo si el admin lo pidió. Por defecto se conserva la copia:
      // perder una grabación por un error de red es peor que gastar disco.
      if (cfg.retain_local === false) {
        try { await fsp.unlink(path.join(REC_DIR, path.basename(rec.filename))); } catch (_) {}
      }
      console.log('[recstore]', rec.filename, '->', r.storage);
    } catch (e) {
      console.error('[recstore] fallo', rec.filename, e.message);
    }
  }
}

/** Prueba de configuración: sube un archivo chico y lo confirma. */
async function test() {
  const cfg = await config();
  if (!cfg || cfg.backend === 'local') return { ok: true, msg: 'Destino local: las grabaciones quedan en el servidor.' };
  const body = Buffer.from('pbxng-test-' + Date.now());
  if (cfg.backend === 'nas') {
    if (!cfg.nas_path) throw new Error('falta la ruta del NAS');
    await fsp.mkdir(cfg.nas_path, { recursive: true });
    const p = path.join(cfg.nas_path, '.pbxng-test');
    await fsp.writeFile(p, body); await fsp.unlink(p);
    return { ok: true, msg: 'NAS accesible y con permiso de escritura en ' + cfg.nas_path };
  }
  const key = (cfg.s3_prefix || 'recordings/') + '.pbxng-test';
  const url = await s3Put(cfg, key, body, 'text/plain');
  return { ok: true, msg: 'Subida a S3 correcta: ' + url };
}

const { execFile } = require('child_process');
const net = require('net');
function dfPath(p) {
  return new Promise((ok) => {
    execFile('df', ['-kP', p], { timeout: 5000 }, (e, so) => {
      if (e) return ok(null);
      const lines = (so || '').trim().split('\n'); const parts = (lines[lines.length - 1] || '').split(/\s+/);
      const totalK = +parts[1], usedK = +parts[2]; if (!totalK) return ok(null);
      ok({ total: totalK * 1024, used: usedK * 1024, avail: (+parts[3] || 0) * 1024, pct: Math.round(usedK * 100 / totalK) });
    });
  });
}
async function usage() {
  const cfg = await config();
  const local = await dfPath(REC_DIR);
  let nas = null;
  if (cfg.nas_path) { const ex = fs.existsSync(cfg.nas_path); nas = ex ? Object.assign({ mounted: true, path: cfg.nas_path }, (await dfPath(cfg.nas_path)) || {}) : { mounted: false, path: cfg.nas_path }; }
  let by = {};
  try { const { rows } = await pool.query("SELECT COALESCE(storage,'local') storage, count(*)::int n, COALESCE(sum(bytes),0)::bigint bytes FROM pbxng_recordings WHERE deleted=false GROUP BY 1"); rows.forEach(r => by[r.storage] = { n: r.n, bytes: Number(r.bytes) }); } catch (_) {}
  return {
    backend: cfg.backend || 'local',
    local: Object.assign({}, local || {}, { files: (by.local && by.local.n) || 0, bytes: (by.local && by.local.bytes) || 0 }),
    nas: nas ? Object.assign({}, nas, { files: (by.nas && by.nas.n) || 0, bytes: (by.nas && by.nas.bytes) || 0 }) : null,
    s3: { files: (by.s3 && by.s3.n) || 0, bytes: (by.s3 && by.s3.bytes) || 0 },
  };
}
function tcpProbe(host, port, label, seg = 4) {
  return new Promise((ok) => {
    const c = net.connect({ host, port });
    const to = setTimeout(() => { c.destroy(); ok({ paso: label, ok: false, detalle: 'sin conexion a ' + host + ':' + port + ' en ' + seg + 's' }); }, seg * 1000);
    c.on('connect', () => { clearTimeout(to); c.end(); ok({ paso: label, ok: true, detalle: 'puerto ' + port + ' abierto en ' + host }); });
    c.on('error', (e) => { clearTimeout(to); ok({ paso: label, ok: false, detalle: e.code || e.message }); });
  });
}
function mountHint(type, p) {
  if (type === 'nfs') return 'mount -t nfs ' + (p.nas_server || 'SERVIDOR') + ':' + (p.nas_share || '/export') + ' ' + (p.nas_path || '/mnt/nas');
  if (type === 'cifs') return 'mount -t cifs //' + (p.nas_server || 'SERVIDOR') + '/' + (p.nas_share || 'share') + ' ' + (p.nas_path || '/mnt/nas') + ' -o username=' + (p.nas_user || 'usuario') + ',password=***,uid=asterisk';
  return '';
}
async function nastest(p) {
  p = p || {};
  const type = p.nas_type || 'mount';
  const pasos = [];
  if (type === 'mount') {
    if (!p.nas_path) return { ok: false, pasos: [{ paso: 'Ruta', ok: false, detalle: 'falta la ruta montada' }] };
    const ex = fs.existsSync(p.nas_path);
    pasos.push({ paso: 'Existe la ruta', ok: ex, detalle: ex ? p.nas_path + ' existe' : 'no existe (esta montado el NAS en el server de Asterisk?)' });
    if (ex) {
      try { const t = path.join(p.nas_path, '.pbxng-test'); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); pasos.push({ paso: 'Escritura', ok: true, detalle: 'permiso de escritura OK' }); }
      catch (e) { pasos.push({ paso: 'Escritura', ok: false, detalle: e.code || e.message }); }
      const u = await dfPath(p.nas_path); if (u) pasos.push({ paso: 'Espacio', ok: true, info: true, detalle: (u.used / 1e9).toFixed(1) + ' GB de ' + (u.total / 1e9).toFixed(1) + ' GB usados (' + u.pct + '%)' });
    }
  } else {
    if (!p.nas_server) return { ok: false, pasos: [{ paso: 'Servidor', ok: false, detalle: 'falta el servidor NAS' }] };
    const port = type === 'nfs' ? 2049 : 445;
    pasos.push(await tcpProbe(p.nas_server, port, 'Alcance ' + type.toUpperCase() + ' (' + port + ')'));
    pasos.push({ paso: 'Comando de montaje', ok: true, info: true, detalle: mountHint(type, p) });
    if (p.nas_path && fs.existsSync(p.nas_path)) { const u = await dfPath(p.nas_path); if (u) pasos.push({ paso: 'Ya montado', ok: true, info: true, detalle: 'montado en ' + p.nas_path + ' (' + u.pct + '% usado)' }); }
  }
  const ok = pasos.filter((x) => !x.info).every((x) => x.ok);
  return { ok, pasos, mount_cmd: mountHint(type, p) };
}

module.exports = { init, sweep, upload, test, usage, nastest, REC_DIR };
