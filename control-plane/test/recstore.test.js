/* ============================================================================
 *  Almacenamiento de grabaciones (recstore.js): NAS por copia y S3 con firma SigV4
 *  hecha a mano.
 *
 *  El S3 es un servidor HTTP de mentira que VERIFICA la firma con la misma receta que
 *  AWS: si la firma está mal, contesta 403 como contestaría un bucket de verdad. Así la
 *  prueba no dice «subió»: dice «subió con una firma que S3 aceptaría».
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'recstore-'));
process.env.REC_DIR = path.join(RAIZ, 'rec');
fs.mkdirSync(process.env.REC_DIR);
const rs = require('../recstore');
test.after(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();

/* Un bucket que verifica la firma SigV4 y guarda lo que le suben. */
async function s3Falso({ secret = 'secreto', region = 'sa-east-1' } = {}) {
  const guardado = new Map();
  const srv = http.createServer((req, res) => {
    const partes = []; req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const body = Buffer.concat(partes);
      const auth = req.headers.authorization || '';
      const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(auth);
      if (!m || m[3] !== region) { res.writeHead(403); return res.end('sin firma'); }
      const amz = req.headers['x-amz-date'], hash = req.headers['x-amz-content-sha256'];
      if (hash !== sha256(body)) { res.writeHead(400); return res.end('hash'); }
      const canon = ['PUT', req.url, '', `host:${req.headers.host.split(':')[0]}\nx-amz-content-sha256:${hash}\nx-amz-date:${amz}\n`, m[4], hash].join('\n');
      const scope = `${m[2]}/${region}/s3/aws4_request`;
      const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canon)].join('\n');
      const k = hmac(hmac(hmac(hmac('AWS4' + secret, m[2]), region), 's3'), 'aws4_request');
      if (crypto.createHmac('sha256', k).update(toSign).digest('hex') !== m[5]) { res.writeHead(403); return res.end('SignatureDoesNotMatch'); }
      guardado.set(req.url, body);
      res.writeHead(200); res.end();
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { url: 'http://127.0.0.1:' + srv.address().port, guardado, cerrar: () => new Promise((ok) => srv.close(ok)) };
}

/* Un pool de mentira: la configuración y las grabaciones viven en memoria. */
function poolFalso(cfg, recs = []) {
  const updates = [];
  return {
    updates, cfg, recs,
    async query(sql, args) {
      if (/FROM pbxng_rec_config/.test(sql)) return { rows: this.cfg ? [this.cfg] : [] };
      if (/SELECT id, filename FROM pbxng_recordings/.test(sql)) return { rows: this.recs.filter((r) => r.storage === 'local') };
      if (/UPDATE pbxng_recordings/.test(sql)) { updates.push(args); const r = this.recs.find((x) => x.id === args[0]); if (r) Object.assign(r, { storage: args[1], remote_url: args[2] }); return { rowCount: 1 }; }
      if (/GROUP BY 1/.test(sql)) { if (this.fallaUso) throw new Error('x'); return { rows: [{ storage: 'local', n: 2, bytes: '100' }, { storage: 's3', n: 1, bytes: '50' }] }; }
      throw new Error('consulta inesperada: ' + sql);
    },
  };
}
function grabacion(nombre, contenido = 'RIFF-audio') {
  fs.writeFileSync(path.join(process.env.REC_DIR, nombre), contenido);
  return { id: Math.floor(Math.random() * 1e6), filename: '/otra/ruta/../' + nombre, storage: 'local' };
}

test('sin configuración o local, la prueba lo dice y la ronda no hace nada', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  rs.init(poolFalso(null));
  t.mock.timers.reset();
  assert.match((await rs.test()).msg, /Destino local/);
  await rs.sweep();
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  rs.init(poolFalso({ backend: 'nas', auto_upload: false, nas_path: '/x' }));
  t.mock.timers.reset();
  await rs.sweep();   // auto_upload apagado: no sube
});

test('NAS: copia el archivo con su nombre y la ronda marca la grabación como subida', async (t) => {
  const nas = path.join(RAIZ, 'nas');
  const rec = grabacion('pbxng-2001-1.wav', 'audio-1');
  const pool = poolFalso({ backend: 'nas', nas_path: nas, auto_upload: true, retain_local: false }, [rec]);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] }); rs.init(pool); t.mock.timers.reset();
  assert.match((await rs.test()).msg, /NAS accesible/);
  await rs.sweep();
  assert.equal(fs.readFileSync(path.join(nas, 'pbxng-2001-1.wav'), 'utf8'), 'audio-1');
  assert.deepEqual(pool.updates[0], [rec.id, 'nas', path.join(nas, 'pbxng-2001-1.wav')]);
  assert.equal(fs.existsSync(path.join(process.env.REC_DIR, 'pbxng-2001-1.wav')), false, 'retain_local=false libera el disco');
  await assert.rejects(rs.upload(grabacion('x.wav'), { backend: 'nas' }), /falta la ruta del NAS/);
  pool.cfg = { backend: 'nas' };
  await assert.rejects(rs.test(), /falta la ruta del NAS/);
  await assert.rejects(rs.upload(grabacion('y.wav'), { backend: 'ftp' }), /destino no soportado: ftp/);
});

test('S3 compatible (MinIO): la firma SigV4 es la que S3 acepta, con prefijo y path-style', async (t) => {
  const s3 = await s3Falso();
  t.after(() => s3.cerrar());
  const cfg = { backend: 's3', s3_endpoint: s3.url, s3_bucket: 'grab', s3_key: 'AKIA', s3_secret: 'secreto', s3_region: 'sa-east-1', s3_prefix: 'central-sur/', auto_upload: true };
  const rec = grabacion('pbxng-cola-ventas-2.wav', 'audio-2');
  const pool = poolFalso(cfg, [rec]);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] }); rs.init(pool); t.mock.timers.reset();
  await rs.sweep();
  assert.equal(s3.guardado.get('/grab/central-sur/pbxng-cola-ventas-2.wav').toString(), 'audio-2');
  assert.equal(pool.updates[0][1], 's3');
  assert.equal(pool.updates[0][2], s3.url + '/grab/central-sur/pbxng-cola-ventas-2.wav');
  assert.ok(fs.existsSync(path.join(process.env.REC_DIR, 'pbxng-cola-ventas-2.wav')), 'por defecto se conserva la copia local');
  assert.match((await rs.test()).msg, /Subida a S3 correcta/);
  assert.ok(s3.guardado.has('/grab/central-sur/.pbxng-test'));

  /* Una clave mal: S3 contesta 403 y la grabación sigue local para el próximo intento. */
  pool.cfg = { ...cfg, s3_secret: 'otra' };
  const otra = grabacion('pbxng-2001-3.wav');
  pool.recs.push(otra);
  await rs.sweep();
  assert.equal(otra.storage, 'local');
  await assert.rejects(rs.test(), /S3 403: SignatureDoesNotMatch/);
  await assert.rejects(rs.upload(otra, { backend: 's3', s3_bucket: 'b' }), /faltan credenciales de S3/);
});

test('uso del disco: local, NAS montado o no, y por destino', async (t) => {
  const pool = poolFalso({ backend: 's3', nas_path: path.join(RAIZ, 'nas') });
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] }); rs.init(pool); t.mock.timers.reset();
  const u = await rs.usage();
  assert.equal(u.backend, 's3');
  assert.equal(u.local.files, 2);
  assert.equal(u.s3.bytes, 50);
  assert.equal(u.nas.mounted, true);
  assert.ok(u.local.total > 0, 'df contesta en cualquier sistema');
  pool.cfg = { nas_path: '/no/existe/esto' };
  pool.fallaUso = true;
  const v = await rs.usage();
  assert.equal(v.backend, 'local');
  assert.deepEqual(v.nas, { mounted: false, path: '/no/existe/esto', files: 0, bytes: 0 });
  pool.cfg = {};
  assert.equal((await rs.usage()).nas, null);
});

test('probar el NAS: ruta montada, servidor NFS o CIFS, y lo que falta', async () => {
  assert.match((await rs.nastest()).pasos[0].detalle, /falta la ruta montada/);
  const bien = await rs.nastest({ nas_path: RAIZ });
  assert.equal(bien.ok, true);
  assert.ok(bien.pasos.some((p) => p.paso === 'Espacio'));
  const noEsta = await rs.nastest({ nas_path: '/no/existe' });
  assert.equal(noEsta.ok, false);
  assert.match(noEsta.pasos[0].detalle, /no existe/);

  assert.match((await rs.nastest({ nas_type: 'nfs' })).pasos[0].detalle, /falta el servidor NAS/);
  const cerrado = await rs.nastest({ nas_type: 'nfs', nas_server: '127.0.0.1', nas_share: '/export/grab', nas_path: RAIZ });
  assert.equal(cerrado.ok, false, 'en esta máquina no hay NFS en el 2049');
  assert.equal(cerrado.mount_cmd, 'mount -t nfs 127.0.0.1:/export/grab ' + RAIZ);
  assert.ok(cerrado.pasos.some((p) => p.paso === 'Ya montado'));
  const cifs = await rs.nastest({ nas_type: 'cifs', nas_server: '127.0.0.1', nas_user: 'grab' });
  assert.match(cifs.mount_cmd, /^mount -t cifs \/\/127\.0\.0\.1\/share \/mnt\/nas -o username=grab,password=\*\*\*/);
  assert.equal((await rs.nastest({ nas_type: 'otro', nas_server: 'x' })).mount_cmd, '');
});
