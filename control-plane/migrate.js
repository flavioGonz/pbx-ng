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
  /* Los RAISE NOTICE de las migraciones SON el único rastro de lo que una migración decidió
   * por su cuenta (la 0018, por ejemplo, avisa qué ruta entrante repuntó o borró). Postgres
   * los manda al cliente —`client_min_messages` es NOTICE por defecto; `log_min_messages` es
   * WARNING, así que en el log del servidor no aparecen—, pero node-pg los descarta en
   * silencio si nadie escucha el evento. Sin este listener el aviso se perdía y el
   * administrador se enteraba cuando un cliente llamaba al DID. */
  c.on('notice', (m) => log.info('[sql] ' + (m && m.message ? m.message : String(m))));
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await c.query(`CREATE TABLE IF NOT EXISTS pbxng_schema_migrations (
      id serial PRIMARY KEY, filename text UNIQUE NOT NULL,
      checksum text NOT NULL, applied_at timestamptz DEFAULT now())`);
    let files = [];
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort(); }
    catch (e) { log.info('sin migrations/ — nada que hacer'); return; }
  /* Se traen los checksums, no sólo los nombres: el checksum se venía calculando y
   * guardando desde el primer día, y no se comparaba con nada. Una migración YA APLICADA
   * que cambia de contenido —alguien edita un .sql viejo en vez de escribir el siguiente,
   * o dos ramas numeran igual— se salteaba en silencio y el contenedor arrancaba con un
   * esquema que no es el que dice el repo. Eso NO se descubre al migrar: se descubre en
   * producción, con tres pantallas devolviendo 500. Ahora corta el arranque: es un
   * problema humano y se arregla escribiendo una migración nueva, no editando la vieja. */
    const previas = new Map((await c.query('SELECT filename, checksum FROM pbxng_schema_migrations')).rows.map(r => [r.filename, r.checksum]));
    const suma = (sql) => crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const cambiadas = [];
    for (const f of files) {
      if (!previas.has(f)) continue;
      const esperado = previas.get(f);
      const ahora = suma(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (esperado !== ahora) cambiadas.push(f + ' (aplicada con ' + esperado + ', en disco ' + ahora + ')');
    }
    if (cambiadas.length) {
      log.error('migraciones YA APLICADAS que cambiaron en disco: ' + cambiadas.join('; '));
      log.error('esta base no es la que describe el repo. Una migración aplicada no se edita: escribí la siguiente. '
        + 'Si el cambio es cosmético y estás seguro, actualizá el checksum a mano en pbxng_schema_migrations.');
      process.exit(1);
    }
    const done = new Set(previas.keys());
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      const sum = suma(sql);
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
