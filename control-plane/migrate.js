#!/usr/bin/env node
'use strict';
// PBX-NG · Runner de migraciones. Aplica control-plane/migrations/*.sql una sola vez,
// en orden, registrando cada una en pbxng_schema_migrations. Transaccional por archivo.
//
// Lo corre docker-entrypoint.sh ANTES de `node app.js` (y deploy.sh a mano): si falla,
// sale con 1 y el contenedor NO arranca, que es mejor que atender con esquema viejo.
// Idempotente: correrlo dos veces seguidas no hace nada la segunda. Un candado
// consultivo de Postgres evita que dos réplicas migren a la vez.
// Uso: node migrate.js   (dentro del contenedor api, con env DB_* disponible)
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { Pool } = require('pg');
const log = require('./log')('migrate');
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres', port: +(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'pbxng', user: process.env.DB_USER || 'pbxng',
  password: process.env.DB_PASS || '',
  max: 2, connectionTimeoutMillis: 5000,
});
const DIR = path.join(__dirname, 'migrations');
const LOCK = 7264790;   // id arbitrario del candado (pg_advisory_lock), fijo para PBX-NG

(async () => {
  // Sin DB no hay nada que hacer: mensaje claro y salida 1 (el entrypoint corta ahí).
  try { await pool.query('SELECT 1'); }
  catch (e) { log.error('no se puede conectar a PostgreSQL (' + (process.env.DB_HOST || 'postgres') + ':' + (process.env.DB_PORT || 5432) + '): ' + e.message); process.exit(1); }
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await c.query(`CREATE TABLE IF NOT EXISTS pbxng_schema_migrations (
      id serial PRIMARY KEY, filename text UNIQUE NOT NULL,
      checksum text NOT NULL, applied_at timestamptz DEFAULT now())`);
    let files = [];
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort(); }
    catch (e) { log.info('sin migrations/ — nada que hacer'); return; }
    const done = new Set((await c.query('SELECT filename FROM pbxng_schema_migrations')).rows.map(r => r.filename));
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      const sum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
      try {
        await c.query('BEGIN'); await c.query(sql);
        await c.query('INSERT INTO pbxng_schema_migrations (filename, checksum) VALUES ($1,$2)', [f, sum]);
        await c.query('COMMIT'); applied++; log.info('aplicada ' + f);
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) {}
        log.error('FALLO ' + f + ' -> ' + e.message, { code: e.code, position: e.position });
        process.exit(1);
      }
    }
    log.info(applied ? ('migraciones aplicadas: ' + applied) : 'DB al día (sin migraciones nuevas)', { total: files.length });
  } finally {
    try { await c.query('SELECT pg_advisory_unlock($1)', [LOCK]); } catch (_) {}
    c.release();
    await pool.end();
  }
})().catch(e => { log.error('migrate: ' + e.message, e); process.exit(1); });
