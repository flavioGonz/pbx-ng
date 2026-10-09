/* Integración · migración 0030 (el tono en las derivaciones de la IA) contra un PostgreSQL
 * efímero. Sin Postgres se saltea.
 *
 * La migración le agrega `,${DIAL_OPCIONES}` a los Dial que el panel escribió ANTES del
 * cambio: los de los grupos de timbre y los de las opciones de IVR que marcan un interno.
 * Lo que se fija acá es lo que, si sale mal, rompe llamadas que hoy andan:
 *   · el sufijo va una sola vez, aunque el SQL corra dos veces;
 *   · pasa literal por el runner real (migrate.js), sin que nadie interprete el `$`;
 *   · no se toca nada que no sea de un grupo o de un IVR: agentes de IA, salas, rutas
 *     entrantes y salientes, ni un Dial escrito a mano con otras opciones. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { baseEfimera, motivoSinDb } = require('./helpers/db');

const ARCHIVO = '0030_tono_derivaciones.sql';
const SQL = fs.readFileSync(path.join(__dirname, '..', 'migrations', ARCHIVO), 'utf8');

test('migración 0030: agrega ${DIAL_OPCIONES} a los grupos e IVR viejos, una sola vez, y no toca nada más', async (t) => {
  const db = await baseEfimera();
  if (!db) { t.skip('prueba de integración salteada: ' + motivoSinDb()); return; }
  t.after(() => db.cerrar());

  const fila = (context, exten, priority, app, appdata) => db.query(
    'INSERT INTO extensions (context,exten,priority,app,appdata) VALUES ($1,$2,$3,$4,$5)', [context, exten, priority, app, appdata]);
  const appdata = async (context, exten, priority) => (await db.query(
    'SELECT appdata FROM extensions WHERE context=$1 AND exten=$2 AND priority=$3', [context, exten, priority])).rows[0].appdata;

  /* Lo que escribía el panel antes del cambio. */
  await db.query("INSERT INTO pbxng_ringgroups (name,access_exten,members,ring_time) VALUES ('rg-viejo','6601','1001,1002',20)");
  await fila('ivr', '6601', 1, 'NoOp', 'Ring group rg-viejo');
  await fila('ivr', '6601', 2, 'Dial', 'PJSIP/1001&PJSIP/1002,20');
  await fila('ivr', '6601', 3, 'Hangup', '');
  await db.query("INSERT INTO pbxng_ivr (name,exten) VALUES ('ivr-viejo','6602')");
  await fila('ivr', '6602', 1, 'Answer', '');
  await fila('ivr', '6602', 101, 'Dial', 'PJSIP/1001,30');
  await fila('ivr', '6602', 111, 'Goto', 'internal,6601,1');

  /* Lo que NO se toca. */
  await db.query("INSERT INTO pbxng_ringgroups (name,access_exten,members,ring_time) VALUES ('rg-a-mano','6603','1003',20)");
  await fila('ivr', '6603', 2, 'Dial', 'PJSIP/1003,20,m');              // opciones propias
  await fila('ivr', '9750', 1, 'Stasis', 'pbxng,ai,9');                  // agente de IA
  await fila('ivr', '7000', 3, 'ConfBridge', 'sala-7000');               // sala
  await fila('ivr', '6699', 101, 'Dial', 'PJSIP/1001,30');              // sin grupo ni IVR dueño
  await fila('from-trunk', '29001234', 1, 'Dial', 'PJSIP/1001,30');      // ruta entrante
  await fila('internal', '_0.', 2, 'Dial', 'PJSIP/${EXTEN:1}@troncal,60'); // ruta saliente

  const antes = (await db.query("SELECT id, appdata FROM extensions WHERE NOT (context='ivr' AND exten IN ('6601','6602') AND app='Dial') ORDER BY id")).rows;

  /* Primera vez: por el runner real. baseEfimera ya aplicó todas las migraciones con la
   * base vacía, así que se borra el registro de la 0030 para que migrate.js la corra de
   * nuevo sobre las filas viejas. */
  await db.query('DELETE FROM pbxng_schema_migrations WHERE filename=$1', [ARCHIVO]);
  const mig = spawnSync(process.execPath, ['migrate.js'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: Object.assign({}, process.env, db.env, { LOG_FORMAT: 'text', LOG_LEVEL: 'warn' }),
  });
  assert.equal(mig.status, 0, 'migrate.js falló: ' + (mig.stderr || mig.stdout));
  /* Segunda vez: el mismo SQL a mano. Tiene que ser idempotente. */
  await db.query(SQL);

  assert.equal(await appdata('ivr', '6601', 2), 'PJSIP/1001&PJSIP/1002,20,${DIAL_OPCIONES}', 'el grupo viejo lleva el sufijo una sola vez');
  assert.equal(await appdata('ivr', '6602', 101), 'PJSIP/1001,30,${DIAL_OPCIONES}', 'la opción de IVR vieja lleva el sufijo una sola vez');

  const despues = (await db.query("SELECT id, appdata FROM extensions WHERE NOT (context='ivr' AND exten IN ('6601','6602') AND app='Dial') ORDER BY id")).rows;
  assert.deepEqual(despues, antes, 'la migración tocó filas que no son de un grupo ni de un IVR');
});
