/* ============================================================================
 *  PBX-NG · Ayudantes para las pruebas de integración (node:test).
 *
 *  Dos piezas, pensadas para que `npm test` corra igual en la laptop de un
 *  desarrollador, en la CI y dentro de un contenedor sin nada instalado:
 *
 *   - baseEfimera(): una base PostgreSQL LIMPIA con el esquema real de una
 *     instalación nueva (docker/config/initdb/01-schema.sql + `node migrate.js`,
 *     el mismo camino que docker-entrypoint.sh). Si hay PGURL o DB_HOST en el
 *     entorno (la CI levanta un postgres:16-alpine como servicio) se crea UNA
 *     base nueva por archivo de prueba en ese servidor y se borra al final. Si no
 *     hay nada, se busca `initdb`/`pg_ctl` (PostgreSQL 16 instalado localmente),
 *     se inicializa un clúster en un directorio temporal, se lo levanta en un
 *     puerto libre y se lo apaga al terminar. Sin ninguna de las dos cosas devuelve
 *     null y el archivo de prueba se SALTA con un mensaje claro (nunca falla por
 *     falta de infraestructura: eso taparía fallos reales).
 *
 *   - apiEfimera(): arranca `app.js` como proceso hijo en un puerto libre con
 *     JWT_SECRET de prueba y ARI/AMI/agente apuntando a puertos cerrados de
 *     loopback (la API tolera Asterisk ausente: reconecta con backoff y las rutas
 *     responden `sin-ari`/503). Espera /health y el bootstrap del usuario admin.
 *
 *  Cada archivo de prueba tiene su propia base y su propia API: no comparten
 *  estado, así que pueden correr en paralelo (node --test lanza un proceso por
 *  archivo) sin pisarse el rate limit del login ni las filas.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client, Pool } = require('pg');

const RAIZ_CP = path.resolve(__dirname, '..', '..');                 // control-plane/
const SCHEMA = path.resolve(RAIZ_CP, '..', 'docker', 'config', 'initdb', '01-schema.sql');

/* Puerto TCP libre en loopback. Se pide al kernel (puerto 0) y se suelta: hay una
 * ventana mínima hasta que lo usa el hijo, aceptable para pruebas locales. */
function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Ubicar los binarios de PostgreSQL ─────────────────────────────────────
 * Debian/Ubuntu no los ponen en el PATH (van en /usr/lib/postgresql/<v>/bin);
 * PG_BIN del entorno gana si el desarrollador tiene otra instalación. */
function binariosPg() {
  const candidatos = [];
  if (process.env.PG_BIN) candidatos.push(process.env.PG_BIN);
  for (const base of ['/usr/lib/postgresql', '/usr/local/pgsql', '/opt/homebrew/opt/postgresql@16', '/usr/local/opt/postgresql@16']) {
    try {
      const st = fs.statSync(base);
      if (!st.isDirectory()) continue;
      if (fs.existsSync(path.join(base, 'bin', 'initdb'))) candidatos.push(path.join(base, 'bin'));
      // /usr/lib/postgresql/16, /usr/lib/postgresql/15… la versión más alta primero
      for (const v of fs.readdirSync(base).filter((d) => /^\d+$/.test(d)).sort((a, b) => +b - +a)) candidatos.push(path.join(base, v, 'bin'));
    } catch (_) {}
  }
  for (const dir of candidatos) if (fs.existsSync(path.join(dir, 'initdb')) && fs.existsSync(path.join(dir, 'pg_ctl'))) return dir;
  // Último recurso: el PATH
  const r = spawnSync('initdb', ['--version'], { stdio: 'ignore' });
  if (!r.error) return '';
  return null;
}

/* initdb se niega a correr como root. Si somos root y existe el usuario `postgres`
 * (o `nobody`), corremos los binarios con ese usuario vía runuser/setpriv/su. */
function comoUsuarioSinPrivilegio() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  for (const u of ['postgres', 'nobody']) {
    const r = spawnSync('id', ['-u', u], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0) {
      const uid = String(r.stdout).trim();
      const gid = String(spawnSync('id', ['-g', u], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout || '').trim();
      for (const [bin, args] of [['setpriv', ['--reuid=' + uid, '--regid=' + gid, '--clear-groups']], ['runuser', ['-u', u, '--']], ['su', ['-s', '/bin/sh', u, '-c']]]) {
        const ok = spawnSync(bin, ['--version'], { stdio: 'ignore' });
        if (!ok.error) return { user: u, uid: +uid, gid: +gid, bin, args, shell: bin === 'su' };
      }
    }
  }
  return null;
}

function correr(cmd, args, opt) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opt || {}));
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(cmd + ' ' + args.join(' ') + ' salió con ' + r.status + ': ' + (r.stderr || r.stdout || '').trim().slice(-800));
  return r;
}

/* Levanta un clúster PostgreSQL propio en un directorio temporal. Devuelve
 * { host, port, user, pass, apagar } o lanza si no se pudo. */
function clusterLocal(bin, puerto) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-pg-'));
  const data = path.join(dir, 'data');
  const bajar = comoUsuarioSinPrivilegio();
  const envPg = Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C', PGHOST: dir });
  const ejecutar = (nombre, args) => {
    const full = path.join(bin, nombre);
    if (!bajar) return correr(full, args, { env: envPg });
    if (bajar.shell) {
      // su -c "cmd 'arg' ..." : se entrecomilla cada argumento
      const linea = [full].concat(args).map((a) => "'" + String(a).replace(/'/g, "'\\''") + "'").join(' ');
      return correr(bajar.bin, bajar.args.concat([linea]), { env: envPg });
    }
    return correr(bajar.bin, bajar.args.concat([full]).concat(args), { env: envPg });
  };
  try {
    if (bajar) fs.chownSync(dir, bajar.uid, bajar.gid);
    /* El usuario del clúster se llama `pbxng` a propósito: 01-schema.sql es un
     * pg_dump con `OWNER TO pbxng` en cada objeto. --auth=trust: es un clúster
     * efímero en loopback con un puerto al azar, no una instalación. */
    ejecutar('initdb', ['-D', data, '-U', 'pbxng', '--auth=trust', '--no-sync', '-E', 'UTF8', '--locale=C']);
    const opciones = ['-p', String(puerto), '-c', 'listen_addresses=127.0.0.1', '-k', dir, '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'log_min_messages=warning'];
    ejecutar('pg_ctl', ['-D', data, '-w', '-t', '30', '-l', path.join(dir, 'pg.log'), '-o', opciones.join(' '), 'start']);
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
  return {
    host: '127.0.0.1', port: puerto, user: 'pbxng', pass: 'pbxng', dbAdmin: 'postgres', propio: true,
    apagar() {
      try { ejecutar('pg_ctl', ['-D', data, '-m', 'immediate', '-w', '-t', '20', 'stop']); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

/* Servidor ya existente (CI o desarrollador con Postgres a mano): PGURL o DB_*. */
function servidorDelEntorno() {
  if (process.env.PGURL) {
    const u = new URL(process.env.PGURL);
    return { host: u.hostname, port: +u.port || 5432, user: decodeURIComponent(u.username || 'pbxng'), pass: decodeURIComponent(u.password || ''), dbAdmin: (u.pathname || '/postgres').slice(1) || 'postgres', apagar() {} };
  }
  if (process.env.DB_HOST) {
    return { host: process.env.DB_HOST, port: +(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'pbxng', pass: process.env.DB_PASS || '', dbAdmin: process.env.DB_NAME || 'postgres', apagar() {} };
  }
  return null;
}

/* 01-schema.sql es un pg_dump: trae metacomandos de psql (`\restrict`, `\unrestrict`)
 * que el protocolo no entiende, y `OWNER TO pbxng`. Se limpian y, si el usuario de
 * conexión no es `pbxng`, el dueño pasa a ser ese usuario (en la CI el rol sí se
 * llama pbxng; en un servidor ajeno puede no existir). */
function sqlDelEsquema(usuario) {
  let sql = fs.readFileSync(SCHEMA, 'utf8').split('\n').filter((l) => !/^\\/.test(l)).join('\n');
  if (usuario !== 'pbxng') sql = sql.replace(/OWNER TO pbxng;/g, 'OWNER TO "' + usuario.replace(/"/g, '""') + '";');
  return sql;
}

async function conectarConReintentos(cfg, ms) {
  const t0 = Date.now();
  let ultimo = null;
  while (Date.now() - t0 < ms) {
    const c = new Client(cfg);
    try { await c.connect(); return c; }
    catch (e) { ultimo = e; try { await c.end(); } catch (_) {} await dormir(250); }
  }
  throw new Error('PostgreSQL en ' + cfg.host + ':' + cfg.port + ' no aceptó conexiones en ' + ms + ' ms: ' + (ultimo && ultimo.message));
}

/**
 * Base PostgreSQL efímera con el esquema real. Devuelve null si no hay cómo
 * levantarla (el test debe hacer t.skip con `motivoSinDb()`).
 *
 * @returns {Promise<null|{env:object, url:string, pool:import('pg').Pool, query:Function, cerrar:Function}>}
 */
let _motivoSinDb = '';
function motivoSinDb() { return _motivoSinDb; }

async function baseEfimera() {
  let srv = servidorDelEntorno();
  if (!srv) {
    const bin = binariosPg();
    if (bin === null) {
      _motivoSinDb = 'sin PostgreSQL: no hay PGURL/DB_HOST en el entorno ni initdb/pg_ctl instalados (apt install postgresql-16, o PG_BIN=/ruta/bin)';
      return null;
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0 && !comoUsuarioSinPrivilegio()) {
      _motivoSinDb = 'initdb no corre como root y no hay usuario postgres/nobody para bajar privilegios; definí PGURL o DB_HOST';
      return null;
    }
    try { srv = clusterLocal(bin, await puertoLibre()); }
    catch (e) { _motivoSinDb = 'no se pudo levantar un PostgreSQL local: ' + e.message; return null; }
  }
  // Una base NUEVA por archivo de prueba: nombre único, se borra al cerrar.
  const nombre = 'pbxng_t_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const admin = await conectarConReintentos({ host: srv.host, port: srv.port, user: srv.user, password: srv.pass, database: srv.dbAdmin }, 20000);
  try { await admin.query('CREATE DATABASE "' + nombre + '"'); } finally { await admin.end(); }

  const env = { DB_HOST: srv.host, DB_PORT: String(srv.port), DB_USER: srv.user, DB_PASS: srv.pass, DB_NAME: nombre };
  const cfg = { host: srv.host, port: srv.port, user: srv.user, password: srv.pass, database: nombre };
  const url = 'postgres://' + encodeURIComponent(srv.user) + ':' + encodeURIComponent(srv.pass) + '@' + srv.host + ':' + srv.port + '/' + nombre;

  // Esquema base (una instalación nueva) y después las migraciones, como el entrypoint.
  const c = new Client(cfg);
  await c.connect();
  try { await c.query(sqlDelEsquema(srv.user)); } finally { await c.end(); }
  const mig = spawnSync(process.execPath, ['migrate.js'], { cwd: RAIZ_CP, env: Object.assign({}, process.env, env, { LOG_FORMAT: 'text', LOG_LEVEL: 'warn' }), encoding: 'utf8' });
  if (mig.status !== 0) throw new Error('node migrate.js falló (' + mig.status + '): ' + (mig.stderr || mig.stdout || '').slice(-1500));

  const pool = new Pool(Object.assign({ max: 3 }, cfg));
  let cerrada = false;
  return {
    env, url, pool,
    query: (sql, params) => pool.query(sql, params),
    async cerrar() {
      if (cerrada) return; cerrada = true;
      try { await pool.end(); } catch (_) {}
      // Con servidor ajeno (CI) la base se borra; con clúster propio se tira todo el directorio.
      if (!srv.propio) {
        try {
          const a = new Client({ host: srv.host, port: srv.port, user: srv.user, password: srv.pass, database: srv.dbAdmin });
          await a.connect();
          try { await a.query('DROP DATABASE IF EXISTS "' + nombre + '" WITH (FORCE)'); } finally { await a.end(); }
        } catch (_) {}
      }
      srv.apagar();
    },
  };
}

/**
 * Arranca la API (app.js) como proceso hijo contra `db.env`. Devuelve
 * { base, port, api(), stop(), log }.
 *   api(method, path, {body, token, headers}) → { status, json, headers }
 */
async function apiEfimera(db, extraEnv) {
  const port = await puertoLibre();
  // Puertos cerrados de loopback para ARI/AMI/agente: la API tiene que arrancar igual.
  const cerrado1 = await puertoLibre(), cerrado2 = await puertoLibre(), cerrado3 = await puertoLibre();
  const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-conf-'));
  const env = Object.assign({}, process.env, db.env, {
    PORT: String(port),
    JWT_SECRET: 'secreto-de-prueba-pbxng-0123456789',
    ADMIN_DEFAULT_PASS: 'admin',
    ARI_URL: 'http://127.0.0.1:' + cerrado1, ARI_USER: 'pbxng', ARI_PASS: 'x',
    AMI_HOST: '127.0.0.1', AMI_PORT: String(cerrado2), AMI_USER: 'pbxng-ami', AMI_PASS: 'x',
    ASTERISK_HOST: '127.0.0.1', AST_AGENT: 'http://127.0.0.1:' + cerrado3, TURN_AGENT: 'http://127.0.0.1:' + cerrado3,
    CONF_DIR: confDir, AST_CONF_DIR: path.join(confDir, 'pbxng.d'), REC_DIR: path.join(confDir, 'rec'), VM_DIR: path.join(confDir, 'vm'), BACKUP_DIR: path.join(confDir, 'bk'),
    LOG_FORMAT: 'text', LOG_LEVEL: process.env.TEST_API_LOG_LEVEL || 'error',
    NODE_ENV: 'test',
  }, extraEnv || {});
  const log = [];
  const hijo = spawn(process.execPath, ['app.js'], { cwd: RAIZ_CP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const guardar = (chunk) => { log.push(String(chunk)); if (log.length > 400) log.shift(); if (process.env.TEST_API_VERBOSE) process.stderr.write(chunk); };
  hijo.stdout.on('data', guardar); hijo.stderr.on('data', guardar);
  let salio = null;
  hijo.on('exit', (code, sig) => { salio = { code, sig }; });

  const base = 'http://127.0.0.1:' + port;
  async function api(method, ruta, opt) {
    const o = opt || {};
    const headers = Object.assign({}, o.headers || {});
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    let body;
    if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch(base + ruta, { method, headers, body, signal: AbortSignal.timeout(o.timeout || 15000) });
    const texto = await r.text();
    let json;
    try { json = texto ? JSON.parse(texto) : null; } catch (_) { json = { _raw: texto }; }
    return { status: r.status, json, headers: r.headers };
  }

  // Espera /health (la API escucha) y después el bootstrap del admin (es asíncrono al arrancar).
  const t0 = Date.now();
  let listo = false;
  while (Date.now() - t0 < 30000) {
    if (salio) throw new Error('la API salió antes de escuchar (código ' + salio.code + ')\n' + log.join(''));
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) { listo = true; break; }
    } catch (_) {}
    await dormir(200);
  }
  if (!listo) { try { hijo.kill('SIGKILL'); } catch (_) {} throw new Error('la API no respondió /health en 30 s\n' + log.join('')); }
  while (Date.now() - t0 < 30000) {
    const { rows } = await db.query("SELECT 1 FROM pbxng_users WHERE username='admin'");
    if (rows.length) break;
    await dormir(150);
  }

  async function stop() {
    if (salio) return;
    hijo.kill('SIGTERM');
    const fin = Date.now() + 8000;
    while (!salio && Date.now() < fin) await dormir(100);
    if (!salio) { try { hijo.kill('SIGKILL'); } catch (_) {} }
    try { fs.rmSync(confDir, { recursive: true, force: true }); } catch (_) {}
  }

  /* Sesión de panel: login y devuelve el token (o lanza con el body para diagnosticar). */
  async function login(username, password) {
    const r = await api('POST', '/api/auth/login', { body: { username, password } });
    if (r.status !== 200) throw new Error('login ' + username + ' → ' + r.status + ' ' + JSON.stringify(r.json));
    return r.json;
  }

  return { base, port, api, login, stop, log: () => log.join('') };
}

/**
 * Atajo para un archivo de prueba entero: base + API, con `t.skip` si no hay
 * PostgreSQL. Uso:
 *   const ctx = await entorno(t); if (!ctx) return;   // ya se marcó skip
 *   t.after(ctx.cerrar);
 */
async function entorno(t, extraEnv) {
  const db = await baseEfimera();
  if (!db) { t.skip('prueba de integración salteada: ' + motivoSinDb()); return null; }
  let api;
  try { api = await apiEfimera(db, extraEnv); }
  catch (e) { await db.cerrar(); throw e; }
  return {
    db, api,
    async cerrar() { await api.stop(); await db.cerrar(); },
  };
}

module.exports = { baseEfimera, apiEfimera, entorno, motivoSinDb, puertoLibre };
