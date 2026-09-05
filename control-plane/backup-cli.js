#!/usr/bin/env node
'use strict';
/* ============================================================================
 *  PBX-NG · Respaldo desde la línea de comandos (cron del host / pbxng-ctl backup)
 *
 *    node backup-cli.js [--keep=N] [--grabaciones] [--nota=texto] [--list]
 *
 *  Por qué existe: el respaldo lo sabe hacer la API (backup.js), pero el cron del
 *  host no tiene un token de panel para pegarle a POST /api/backup y no queremos
 *  inventar uno de servicio. `docker compose exec api node backup-cli.js` corre en
 *  el mismo contenedor, con los mismos volúmenes y el mismo código que el botón
 *  del panel, y encima aplica la retención (BACKUP_KEEP, default 14).
 *
 *  Es EXACTAMENTE lo mismo que hace el planificador interno de la API (app.js,
 *  /api/backup/schedule): backup.programado() → crear + retener. Los dos caminos
 *  anotan backup_last_run / backup_last_ok en pbxng_settings, así el panel muestra
 *  el último respaldo venga de donde venga y el planificador interno no repite el
 *  de hoy si el cron ya lo hizo.
 *
 *  Retención: sólo se borran los respaldos PROGRAMADOS (prefijo pbxng-auto-). Los que
 *  el operador hizo a mano desde el panel no se tocan.
 *
 *  Salida: stdout en español; exit 0 si OK, 1 si falla. Cierra el pool de Postgres
 *  al final para que el proceso salga solo (un pool abierto lo deja colgado).
 * ==========================================================================*/

const backup = require('./backup');
const log = require('./log')('BACKUP');

/* --keep=N --nota=texto --grabaciones --list (también --keep N por comodidad) */
function parsearArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) o[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['keep', 'nota'].includes(k)) o[k] = argv[++i];
    else o[k] = true;
  }
  return o;
}

const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB';

/* pbxng_settings: el pool se abre sólo si hace falta escribir/leer. Si la base no
 * está, el respaldo ya falló antes (pg_dump), así que acá alcanza con avisar. */
let pool = null;
function db() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      host: process.env.DB_HOST || 'postgres', port: +(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || 'pbxng', user: process.env.DB_USER || 'pbxng', password: process.env.DB_PASS || '',
      max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000,
    });
    pool.on('error', (e) => log.warn('pool', e));
  }
  return pool;
}
async function setPut(k, v) {
  try { await db().query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, String(v)]); }
  catch (e) { log.warn('no pude anotar ' + k + ' en pbxng_settings', e); }
}

async function main() {
  const args = parsearArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log('uso: node backup-cli.js [--keep=N] [--grabaciones] [--nota=texto] [--list]');
    return 0;
  }

  if (args.list) {
    const lista = await backup.listar();
    if (!lista.length) { console.log('no hay respaldos en ' + backup.DIR); return 0; }
    for (const b of lista) console.log(`${b.nombre}\t${fmtMB(b.bytes)}\t${b.creado}\t${b.programado ? 'programado' : 'manual'}`);
    return 0;
  }

  const keep = Math.max(1, parseInt(args.keep, 10) || parseInt(process.env.BACKUP_KEEP, 10) || 14);
  const grabaciones = !!args.grabaciones;
  const nota = typeof args.nota === 'string' && args.nota ? args.nota : 'programado';

  log.info('respaldo programado: inicio', { keep, grabaciones });
  // Se anota el inicio ANTES de crear: es la marca que le dice al planificador
  // interno de la API "hoy ya corrió", y evita que arranque otro encima de éste.
  await setPut('backup_last_run', new Date().toISOString());
  try {
    const r = await backup.programado({ grabaciones, keep, nota });
    await setPut('backup_last_ok', '1');
    await setPut('backup_last_error', '');
    await setPut('backup_last_nombre', r.nombre);
    console.log(`respaldo creado: ${r.nombre} (${fmtMB(r.bytes)})${grabaciones ? ' con grabaciones' : ''}`);
    if (r.retencion.borrados.length) console.log(`retención (${keep}): borré ${r.retencion.borrados.length} respaldo(s) viejo(s): ${r.retencion.borrados.join(', ')}`);
    else console.log(`retención (${keep}): nada para borrar (${r.retencion.quedan} programado(s) guardados)`);
    log.info('respaldo programado: OK', { nombre: r.nombre, bytes: r.bytes, borrados: r.retencion.borrados.length });
    return 0;
  } catch (e) {
    await setPut('backup_last_ok', '0');
    await setPut('backup_last_error', String(e && e.message || e).slice(0, 300));
    console.error('el respaldo falló: ' + (e && e.message || e));
    log.error('respaldo programado: falló', e);
    return 1;
  }
}

main()
  .then((rc) => process.exitCode = rc)
  .catch((e) => { console.error('el respaldo falló: ' + (e && e.message || e)); log.error('respaldo-cli', e); process.exitCode = 1; })
  .finally(async () => { if (pool) await pool.end().catch(() => {}); });
