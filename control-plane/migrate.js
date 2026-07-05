#!/usr/bin/env node
// PBX-NG · Runner de migraciones. Aplica control-plane/migrations/*.sql una sola vez,
// en orden, registrando cada una en pbxng_schema_migrations. Transaccional por archivo.
// Uso: node migrate.js   (dentro del contenedor api, con env DB_* disponible)
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres', port: +(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'pbxng', user: process.env.DB_USER || 'pbxng',
  password: process.env.DB_PASS || '',
});
const DIR = path.join(__dirname, 'migrations');
(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS pbxng_schema_migrations (
    id serial PRIMARY KEY, filename text UNIQUE NOT NULL,
    checksum text NOT NULL, applied_at timestamptz DEFAULT now())`);
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort(); }
  catch (e) { console.log('sin migrations/ — nada que hacer'); process.exit(0); }
  const done = new Set((await pool.query('SELECT filename FROM pbxng_schema_migrations')).rows.map(r => r.filename));
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const sum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query(sql);
      await c.query('INSERT INTO pbxng_schema_migrations (filename, checksum) VALUES ($1,$2)', [f, sum]);
      await c.query('COMMIT'); applied++; console.log('  aplicada', f);
    } catch (e) { await c.query('ROLLBACK'); console.error('  FALLO', f, '->', e.message); process.exit(1); }
    finally { c.release(); }
  }
  console.log(applied ? ('Migraciones aplicadas: ' + applied) : 'DB al dia (sin migraciones nuevas)');
  await pool.end();
})().catch(e => { console.error('migrate:', e.message); process.exit(1); });
