/* ============================================================================
 *  Integración · el arranque y el cierre de app.js con lo que puede venir torcido.
 *
 *  Lo que pasa UNA vez por proceso no lo prueba ninguna ruta: de dónde sale el par VAPID
 *  (el .env, la base, o uno nuevo cuando lo guardado no firma), qué hace la API cuando el
 *  token compartido con los agentes no se puede leer ni escribir, y el cierre ordenado
 *  por SIGINT o con dos señales seguidas. Son los caminos de un appliance que se
 *  actualiza, que se restaura de un respaldo o al que alguien le tocó el .env a mano, y
 *  un error ahí no se ve hasta el día que pasa: el push deja de sonar sin aviso, o el
 *  contenedor no termina nunca de apagarse.
 *
 *  Una sola base para todo el archivo; cada caso levanta SU API (apiEfimera) contra ella
 *  con el entorno que quiere probar, y la baja antes del siguiente.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const webpush = require('web-push');
const { baseEfimera, apiEfimera, motivoSinDb, puertoLibre } = require('./helpers/db');

const RAIZ = path.resolve(__dirname, '..');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 15000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(100); } return fn(); }

/* La API como proceso propio (no con apiEfimera) cuando hace falta mandarle señales:
 * apiEfimera sólo sabe apagarla con SIGTERM. Mismo entorno mínimo que ella. */
async function apiPropia(db, extra) {
  const port = await puertoLibre();
  const c1 = await puertoLibre(), c2 = await puertoLibre();
  const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-conf-'));
  const env = Object.assign({}, process.env, db.env, {
    PORT: String(port), JWT_SECRET: 'secreto-de-prueba-pbxng-0123456789', ADMIN_DEFAULT_PASS: 'admin',
    ARI_URL: 'http://127.0.0.1:' + c1, AMI_HOST: '127.0.0.1', AMI_PORT: String(c2), AST_AGENT: 'http://127.0.0.1:' + c1,
    CONF_DIR: confDir, AST_CONF_DIR: path.join(confDir, 'pbxng.d'), REC_DIR: path.join(confDir, 'rec'), VM_DIR: path.join(confDir, 'vm'), BACKUP_DIR: path.join(confDir, 'bk'),
    LOG_FORMAT: 'text', LOG_LEVEL: 'info', NODE_ENV: 'test',
  }, extra || {});
  const hijo = spawn(process.execPath, ['app.js'], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  hijo.stdout.on('data', (d) => { log += d; }); hijo.stderr.on('data', (d) => { log += d; });
  const salida = new Promise((ok) => hijo.on('exit', (code, sig) => ok({ code, sig })));
  const base = 'http://127.0.0.1:' + port;
  const vivo = await hasta(async () => { try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).status === 200; } catch (_) { return false; } }, 30000);
  if (!vivo) { hijo.kill('SIGKILL'); throw new Error('la API no arrancó\n' + log); }
  return { base, hijo, salida, confDir, log: () => log, borrar: () => fs.rmSync(confDir, { recursive: true, force: true }) };
}

/* Directorio con pg_dump (el respaldo lo necesita en el PATH). Mismo criterio que
 * helpers/db.js para encontrar los binarios; null si no hay. */
function dirPgDump() {
  const cand = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin'];
  try { for (const v of fs.readdirSync('/usr/lib/postgresql').sort().reverse()) cand.push(path.join('/usr/lib/postgresql', v, 'bin')); } catch (_) {}
  for (const d of (process.env.PATH || '').split(path.delimiter)) cand.push(d);
  return cand.find((d) => d && fs.existsSync(path.join(d, 'pg_dump'))) || null;
}

test('arranque y cierre: par VAPID, token de los agentes y señales', async (t) => {
  const db = await baseEfimera();
  if (!db) { t.skip('prueba de integración salteada: ' + motivoSinDb()); return; }
  t.after(() => db.cerrar());
  const vapid = async () => {
    const { rows } = await db.query("SELECT key, value FROM pbxng_settings WHERE key IN ('vapid_public','vapid_private')");
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  };
  const clavePublica = async (a) => (await a.api('GET', '/api/push/vapid')).json.key;

  await t.test('VAPID del .env válido: se usa tal cual y no se toca la base', async () => {
    const par = webpush.generateVAPIDKeys();
    const a = await apiEfimera(db, { VAPID_PUBLIC: par.publicKey, VAPID_PRIVATE: par.privateKey });
    try {
      assert.ok(await hasta(async () => (await clavePublica(a)) === par.publicKey, 5000), 'no tomó la clave del .env');
      assert.deepEqual(await vapid(), {});
    } finally { await a.stop(); }
  });

  let generado;
  await t.test('VAPID del .env inválido y base vacía: se genera un par, se guarda y se usa', async () => {
    const a = await apiEfimera(db, { VAPID_PUBLIC: 'no-es-una-clave', VAPID_PRIVATE: '' });
    try {
      assert.ok(await hasta(async () => !!(await vapid()).vapid_public, 5000), 'no guardó el par nuevo');
      generado = await vapid();
      assert.ok(await hasta(async () => (await clavePublica(a)) === generado.vapid_public, 5000));
    } finally { await a.stop(); }
  });

  await t.test('sin .env y con un par guardado que firma: se reusa el de la base (los navegadores no se re-suscriben)', async () => {
    const a = await apiEfimera(db, { VAPID_PUBLIC: '', VAPID_PRIVATE: '' });
    try {
      assert.ok(await hasta(async () => (await clavePublica(a)) === generado.vapid_public, 5000));
      assert.deepEqual(await vapid(), generado, 'no lo regeneró');
    } finally { await a.stop(); }
  });

  await t.test('un par guardado que no firma se reemplaza por uno nuevo', async () => {
    await db.query("UPDATE pbxng_settings SET value='roto' WHERE key='vapid_private'");
    await db.query("UPDATE pbxng_settings SET value=NULL WHERE key='vapid_public'");
    const a = await apiEfimera(db, { VAPID_PUBLIC: '', VAPID_PRIVATE: '' });
    try {
      assert.ok(await hasta(async () => { const v = await vapid(); return v.vapid_public && v.vapid_private !== 'roto'; }, 5000), 'no reemplazó el par roto');
      const nuevo = await vapid();
      assert.notEqual(nuevo.vapid_public, generado.vapid_public);
      assert.ok(await hasta(async () => (await clavePublica(a)) === nuevo.vapid_public, 5000));
    } finally { await a.stop(); }
  });

  await t.test('arranque con ajustes previos: go2rtc guardado, instalador roto, ACME que emite y un respaldo de verdad', async (tt) => {
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('go2rtc_url','https://video.ejemplo.uy') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-arr-'));
    const sp = path.join(tmp, 'softphone');
    fs.mkdirSync(sp);
    fs.writeFileSync(path.join(sp, 'latest.yml'), 'version: 9.9.9\npath: PBX-NG-Softphone-Setup-9.9.9.exe\nsha512: x\nreleaseDate: 2026-01-01\n');
    fs.symlinkSync(path.join(tmp, 'no-existe.exe'), path.join(sp, 'PBX-NG-Softphone-Setup-9.9.9.exe'));   // enlace roto
    const acme = path.join(tmp, 'acme.sh');
    fs.writeFileSync(acme, '#!/bin/sh\necho "acme.sh de mentira: $*"\nexit 0\n', { mode: 0o755 });
    const pg = dirPgDump();
    const a = await apiEfimera(db, Object.assign({ SOFTPHONE_DIR: sp, ACME_SH: acme }, pg ? { PATH: pg + path.delimiter + process.env.PATH } : {}));
    try {
      const admin = (await a.login('admin', 'admin')).token;
      const cfg = (await a.api('GET', '/api/intercom/config', { token: admin })).json;
      assert.equal(cfg.efectiva, 'https://video.ejemplo.uy', 'la base de video guardada se toma al arrancar');
      const sl = (await a.api('GET', '/api/softphone/latest')).json;
      assert.equal(sl.available, false, 'un instalador que no se puede leer no se ofrece');
      assert.match(sl.reason, /falta PBX-NG-Softphone-Setup-9\.9\.9\.exe/);

      await a.api('POST', '/api/acme/config', { token: admin, body: { domain: 'pbx.ejemplo.uy', email: 'noc@ejemplo.uy', method: 'http' } });
      const em = await a.api('POST', '/api/acme/issue', { token: admin });
      assert.equal(em.status, 200, 'con acme.sh conforme, la emisión da 200: ' + JSON.stringify(em.json));
      assert.equal(em.json.ok, true);
      fs.rmSync(path.join(a.confDir, 'acme'), { recursive: true, force: true });
      fs.writeFileSync(path.join(a.confDir, 'acme'), 'no es una carpeta');
      const roto = await a.api('POST', '/api/acme/config', { token: admin, body: { domain: 'otro.uy' } });
      assert.equal(roto.status, 500, 'si no se puede guardar la configuración, se dice');
      assert.ok(roto.json.error);

      if (!pg) { tt.diagnostic('sin pg_dump a mano: no se prueba el respaldo real'); return; }
      const bk = await a.api('POST', '/api/backup', { token: admin, body: { nota: 'prueba' }, timeout: 60000 });
      assert.equal(bk.status, 201, JSON.stringify(bk.json));
      const nombre = bk.json.nombre;
      const insp = await a.api('GET', '/api/backup/' + nombre + '/inspeccionar', { token: admin });
      assert.equal(insp.status, 200);
      assert.ok(Array.isArray(insp.json.partes), 'el manifiesto lista las partes');
      /* Subir ese mismo archivo con otro nombre: es un respaldo válido y queda. */
      const bytes = fs.readFileSync(path.join(a.confDir, 'bk', nombre));
      const otro = nombre.replace(/\.tar\.gz$/, '-copia.tar.gz');
      const sub = await fetch(a.base + '/api/backup/subir/' + otro, { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/octet-stream' }, body: bytes });
      assert.equal(sub.status, 201);
      assert.equal((await sub.json()).subido, otro);
      assert.equal((await a.api('DELETE', '/api/backup/' + otro, { token: admin })).json.borrado, otro);
      assert.equal((await a.api('DELETE', '/api/backup/' + nombre, { token: admin })).json.borrado, nombre);
    } finally { await a.stop(); fs.rmSync(tmp, { recursive: true, force: true }); await db.query("DELETE FROM pbxng_settings WHERE key='go2rtc_url'"); }
  });

  await t.test('token de los agentes: un archivo vacío se regenera; si no se puede escribir, sólo se acepta loopback', async () => {
    /* De paso: una base de video guardada en NULL no pisa la de la central. */
    await db.query("INSERT INTO pbxng_settings (key,value) VALUES ('go2rtc_url',NULL) ON CONFLICT (key) DO UPDATE SET value=NULL");
    const a = await apiPropia(db, {});
    try {
      const tk = await (await fetch(a.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })).json();
      const cfg = await (await fetch(a.base + '/api/intercom/config', { headers: { Authorization: 'Bearer ' + tk.token } })).json();
      assert.equal(cfg.por_la_central, true);
      assert.match(cfg.efectiva, /^http:\/\/127\.0\.0\.1:\d+/, 'sin base guardada, el video va por la propia central');
      const tok = fs.readFileSync(path.join(a.confDir, 'agent.token'), 'utf8').trim();
      assert.match(tok, /^[0-9a-f]{64}$/);
    } finally { a.hijo.kill('SIGTERM'); await a.salida; }
    /* Mismo directorio con el archivo vacío: se genera otro. */
    fs.writeFileSync(path.join(a.confDir, 'agent.token'), '\n');
    const b = await apiPropia(db, { CONF_DIR: a.confDir });
    try {
      assert.match(fs.readFileSync(path.join(a.confDir, 'agent.token'), 'utf8').trim(), /^[0-9a-f]{64}$/, 'un token vacío no sirve: se regenera');
    } finally { b.hijo.kill('SIGTERM'); await b.salida; b.borrar(); }
    a.borrar();
    /* agent.token es un directorio: ni se lee ni se escribe. La API arranca igual y el
     * dialplan sólo entra desde loopback (desde-la-central.js, «sin token»). */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-conf-'));
    fs.mkdirSync(path.join(dir, 'agent.token'));
    const c = await apiPropia(db, { CONF_DIR: dir });
    try {
      assert.match(c.log(), /no se pudo generar/);
      const w = await fetch(c.base + '/api/internal/wake?ext=2001');
      assert.equal(w.status, 200, 'sin token, desde loopback se acepta');
      const lejos = await fetch(c.base + '/api/internal/wake?ext=2001', { headers: { 'X-Forwarded-For': '203.0.113.5' } });
      assert.equal(lejos.status, 403, 'sin token, desde afuera no');
    } finally { c.hijo.kill('SIGTERM'); await c.salida; fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t.test('cierre por SIGINT con una consulta colgada: espera a la base, y una segunda señal no lo arranca de nuevo', async () => {
    const a = await apiPropia(db, {});
    const login = await fetch(a.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    const tok = (await login.json()).token;
    /* Una consulta de la API queda esperando un lock: el cierre tiene que esperarla (hasta
     * 10 s) en vez de cortarla, y mientras tanto llega la segunda señal. */
    const lk = await db.pool.connect();
    try {
      await lk.query('BEGIN');
      await lk.query('LOCK TABLE pbxng_settings IN ACCESS EXCLUSIVE MODE');
      const colgada = fetch(a.base + '/api/settings', { headers: { Authorization: 'Bearer ' + tok } }).then((r) => r.status, () => 'cortada');
      await dormir(300);
      a.hijo.kill('SIGINT');
      assert.ok(await hasta(() => /AudioSocket cerrado/.test(a.log()), 5000), 'el cierre no llegó a esperar la base');
      a.hijo.kill('SIGTERM');   // como un `docker stop` impaciente
      await dormir(300);
      assert.doesNotMatch(a.log(), /pool de PostgreSQL cerrado/, 'cerró la base con una consulta en vuelo');
      await lk.query('ROLLBACK');
      assert.equal(await colgada, 200, 'la consulta que estaba en vuelo termina y contesta');
    } finally { lk.release(); }
    const fin = await a.salida;
    assert.equal(fin.code, 0, 'salió con ' + JSON.stringify(fin) + '\n' + a.log());
    assert.match(a.log(), /señal SIGINT/);
    assert.equal((a.log().match(/dejo de aceptar conexiones/g) || []).length, 1, 'el cierre corrió dos veces');
    assert.match(a.log(), /pool de PostgreSQL cerrado/);
    assert.match(a.log(), /listo, salgo con 0/);
    a.borrar();
  });
});
