/* ============================================================================
 *  Tanda 0 · la capa de datos: índices del CDR (D1) y checksum de migraciones (D2).
 *
 *  D1 · `cdr` es la única tabla que crece para siempre y no tenía UN SOLO índice: cada
 *       apertura del historial era un Seq Scan más un sort. Acá se verifica que la
 *       migración los deja puestos y —lo que de verdad importa— que la consulta del
 *       emparejado de grabaciones quedó escrita de una forma que PUEDE usarlos: el
 *       EXPLAIN tiene que dejar de decir «Seq Scan».
 *
 *  D2 · `migrate.js` venía calculando y guardando un checksum por migración desde el
 *       primer día, y no lo comparaba con nada. Una migración ya aplicada que cambia de
 *       contenido se salteaba en silencio: el contenedor arrancaba con un esquema que no
 *       es el que dice el repo, y eso no se descubre al migrar sino en producción.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { baseEfimera, motivoSinDb } = require('./helpers/db');

const RAIZ = path.resolve(__dirname, '..');

test('datos: índices del CDR y migraciones que no se pueden reescribir', async (t) => {
  const db = await baseEfimera();
  if (!db) { t.skip('prueba de integración salteada: ' + motivoSinDb()); return; }
  t.after(() => db.cerrar());

  await t.test('D1 · la migración deja los tres índices sobre cdr', async () => {
    const { rows } = await db.query("SELECT indexname FROM pg_indexes WHERE tablename='cdr'");
    const hay = rows.map((r) => r.indexname);
    for (const i of ['idx_cdr_start', 'idx_cdr_src_start', 'idx_cdr_dst_start']) {
      assert.ok(hay.includes(i), 'falta el índice ' + i + ' (hay: ' + hay.join(', ') + ')');
    }
  });

  await t.test('D1 · el emparejado de grabaciones aprovecha los índices', async () => {
    /* Con la tabla vacía el planner elige Seq Scan igual —es lo más barato— así que
     * primero se le da volumen. Lo que se mide NO es un tiempo (sería frágil): es que el
     * plan deje de leer la tabla entera y que la reescritura del predicado salga más
     * barata que la original, que es exactamente lo que cambió. */
    await db.query(`INSERT INTO cdr (src, dst, start, duration, billsec, disposition)
      SELECT '100' || (g % 50), '200' || (g % 50), timestamp '2026-01-01 00:00:00' + (g || ' seconds')::interval, 10, 8, 'ANSWERED'
      FROM generate_series(1, 20000) g`);
    await db.query('ANALYZE cdr');

    const epoch = Math.floor(Date.UTC(2026, 0, 1, 1, 0, 0) / 1000);
    const viejo = "EXPLAIN (FORMAT JSON) SELECT src, dst FROM cdr WHERE (src=$1 OR dst=$1) AND abs(extract(epoch from start) - $2) < 300 ORDER BY abs(extract(epoch from start) - $2) ASC LIMIT 1";
    const nuevo = `EXPLAIN (FORMAT JSON) SELECT src, dst FROM cdr
       WHERE (src=$1 OR dst=$1)
         AND start >= to_timestamp($2::bigint - 300) AT TIME ZONE 'UTC'
         AND start <= to_timestamp($2::bigint + 300) AT TIME ZONE 'UTC'
       ORDER BY abs(extract(epoch from start) - $2::bigint) ASC LIMIT 1`;

    const plan = async (sql) => (await db.query(sql, ['1001', epoch])).rows[0]['QUERY PLAN'][0].Plan;
    const texto = (p) => JSON.stringify(p);
    const antes = await plan(viejo);
    const ahora = await plan(nuevo);

    assert.ok(!/Seq Scan/.test(texto(ahora)), 'la consulta nueva lee el CDR entero:\n' + texto(ahora));
    assert.ok(ahora['Total Cost'] < antes['Total Cost'],
      'la reescritura no mejoró el plan: antes ' + antes['Total Cost'] + ', ahora ' + ahora['Total Cost']);

    /* Y el resultado tiene que ser el MISMO: la forma cambió, el criterio no. La fila de
     * las 01:00:00 existe y es la más cercana a ese epoch. */
    const r = await db.query(`SELECT src, dst FROM cdr
       WHERE (src=$1 OR dst=$1)
         AND start >= to_timestamp($2::bigint - 300) AT TIME ZONE 'UTC'
         AND start <= to_timestamp($2::bigint + 300) AT TIME ZONE 'UTC'
       ORDER BY abs(extract(epoch from start) - $2::bigint) ASC LIMIT 1`, ['1001', epoch]);
    const v = await db.query("SELECT src, dst FROM cdr WHERE (src=$1 OR dst=$1) AND abs(extract(epoch from start) - $2) < 300 ORDER BY abs(extract(epoch from start) - $2) ASC LIMIT 1", ['1001', epoch]);
    assert.deepEqual(r.rows, v.rows, 'la reescritura cambió el resultado, no sólo el plan');
  });

  await t.test('D2 · una migración ya aplicada que cambia de contenido corta el arranque', async () => {
    const correr = () => spawnSync(process.execPath, ['migrate.js'], { cwd: RAIZ, env: Object.assign({}, process.env, db.env), encoding: 'utf8' });

    // Estado normal: la base ya está al día (baseEfimera corrió migrate.js), no hace nada y sale 0.
    const limpio = correr();
    assert.equal(limpio.status, 0, 'migrate.js falló sobre una base al día:\n' + limpio.stdout + limpio.stderr);

    // Alguien editó un .sql ya aplicado: se simula ensuciando el checksum guardado.
    const { rows } = await db.query('SELECT filename, checksum FROM pbxng_schema_migrations ORDER BY filename DESC LIMIT 1');
    assert.ok(rows[0], 'no hay migraciones registradas: la prueba no estaría midiendo nada');
    await db.query("UPDATE pbxng_schema_migrations SET checksum='0000000000000000' WHERE filename=$1", [rows[0].filename]);

    const sucio = correr();
    assert.equal(sucio.status, 1, 'migrate.js arrancó igual con una migración cambiada');
    assert.match(sucio.stdout + sucio.stderr, /cambiaron en disco/, 'el mensaje tiene que decir cuál cambió');
    assert.match(sucio.stdout + sucio.stderr, new RegExp(rows[0].filename.replace(/\./g, '\\.')), 'el mensaje no nombra el archivo');

    // Se devuelve el checksum bueno y vuelve a salir 0: el corte es por contenido, no un estado pegado.
    await db.query('UPDATE pbxng_schema_migrations SET checksum=$2 WHERE filename=$1', [rows[0].filename, rows[0].checksum]);
    assert.equal(correr().status, 0);
  });
});
