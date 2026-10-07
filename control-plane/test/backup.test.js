/* ============================================================================
 *  Respaldo y restauración (backup.js) y su línea de comandos (backup-cli.js).
 *
 *  `pg_dump` y `psql` son scripts de mentira al frente del PATH: el volcado real de
 *  Postgres no es lo que se prueba acá (es de Postgres), y así la prueba no depende de
 *  que la versión del cliente coincida con la del servidor. `tar` y `gzip` sí son los
 *  de verdad: el archivo que sale es un respaldo que se puede abrir.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-bk-test-'));
const BIN = path.join(RAIZ, 'bin');
const DIR = path.join(RAIZ, 'respaldos');
fs.mkdirSync(BIN);
/* pg_dump escribe un volcado chico en el -f; psql contesta la versión y registra lo que
 * le piden restaurar, así la prueba puede mirar que el SQL restaurado es el del respaldo. */
fs.writeFileSync(path.join(BIN, 'pg_dump'), `#!/bin/sh
[ -n "$FALSO_PGDUMP_FALLA" ] && { echo "pg_dump: conexión rechazada" >&2; exit 1; }
while [ $# -gt 0 ]; do [ "$1" = "-f" ] && { shift; echo "-- volcado de prueba $PGDATABASE" > "$1"; }; shift; done
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'psql'), `#!/bin/sh
case "$*" in *"SHOW server_version"*) echo "16.4"; exit 0;; esac
while [ $# -gt 0 ]; do [ "$1" = "-f" ] && { shift; cat "$1" >> "${RAIZ}/restaurado.sql"; }; shift; done
`, { mode: 0o755 });
process.env.PATH = BIN + path.delimiter + process.env.PATH;
process.env.BACKUP_DIR = DIR;
process.env.APP_VERSION = '9.9.9';
const backup = require('../backup');
test.after(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

test('crear: un tar.gz con la base y el manifiesto; las partes que no están se marcan', async () => {
  const r = await backup.crear({ nota: 'antes del cambio' });
  assert.match(r.nombre, /^pbxng-\d{8}-\d{6}\.tar\.gz$/);
  assert.ok(r.bytes > 0);
  const m = r.manifiesto;
  assert.equal(m.producto, 'PBX-NG');
  assert.equal(m.formato, backup.FORMATO);
  assert.equal(m.version, '9.9.9');
  assert.equal(m.postgres, '16.4');
  assert.equal(m.nota, 'antes del cambio');
  assert.equal(m.programado, false);
  const base = m.partes.find((p) => p.id === 'base');
  assert.match(base.sha256, /^[0-9a-f]{64}$/);
  assert.equal(m.partes.find((p) => p.id === 'grabaciones').omitida, 'no solicitada');
  assert.ok(m.partes.filter((p) => p.ausente).length >= 1, 'un volumen que no está montado no rompe el respaldo');
  const dentro = execFileSync('tar', ['-tzf', path.join(DIR, r.nombre)], { encoding: 'utf8' });
  assert.match(dentro, /manifiesto\.json/);
  assert.match(dentro, /base\.sql\.gz/);
  const con = await backup.crear({ grabaciones: true });
  assert.equal(con.manifiesto.incluye_grabaciones, true);
  assert.notEqual(con.nombre, r.nombre, 'dos respaldos seguidos no se pisan');
  const otro = await backup.crear({});
  assert.equal(new Set([r.nombre, con.nombre, otro.nombre]).size, 3);
});

test('inspeccionar: lee el manifiesto sin restaurar; uno ajeno, futuro o roto no pasa', async () => {
  const [b] = await backup.listar();
  const m = await backup.inspeccionar(b.nombre);
  assert.deepEqual(m.compatible, { ok: true });

  const armar = (nombre, manifiesto) => {
    const d = fs.mkdtempSync(path.join(RAIZ, 'arm-'));
    fs.writeFileSync(path.join(d, 'manifiesto.json'), JSON.stringify(manifiesto));
    execFileSync('tar', ['-czf', path.join(DIR, nombre), '-C', d, '.']);
  };
  armar('ajeno.tar.gz', { producto: 'SBC-NG', formato: 1 });
  assert.match((await backup.inspeccionar('ajeno.tar.gz')).compatible.motivo, /es de SBC-NG/);
  armar('futuro.tar.gz', { producto: 'PBX-NG', formato: 99 });
  assert.match((await backup.inspeccionar('futuro.tar.gz')).compatible.motivo, /formato 99/);
  armar('nulo.tar.gz', null);
  assert.match((await backup.inspeccionar('nulo.tar.gz')).compatible.motivo, /otro producto/);
  fs.writeFileSync(path.join(DIR, 'roto.tar.gz'), 'esto no es un tar');
  await assert.rejects(backup.inspeccionar('roto.tar.gz'), /no tiene manifiesto/);
  await assert.rejects(backup.restaurar('futuro.tar.gz', { confirmar: true }), /incompatible.*formato 99/);
  for (const n of ['ajeno.tar.gz', 'futuro.tar.gz', 'nulo.tar.gz', 'roto.tar.gz']) await backup.borrar(n);
});

test('restaurar: pide confirmación, saca un respaldo previo y restaura la base', async () => {
  const [b] = await backup.listar();
  await assert.rejects(backup.restaurar(b.nombre), /falta la confirmación/);
  const antes = (await backup.listar()).length;
  const r = await backup.restaurar(b.nombre, { confirmar: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.restauradas, ['base']);
  assert.equal(r.reiniciar, true);
  assert.ok(r.saltadas.some((s) => /no venía en el archivo|no está montado/.test(s)));
  assert.match(r.respaldo_previo, /^pbxng-/);
  assert.equal((await backup.listar()).length, antes + 1, 'antes de pisar nada queda un respaldo de seguridad');
  assert.notEqual(r.respaldo_previo, b.nombre, 'el de seguridad no puede pisar al que se restaura');
  assert.match(fs.readFileSync(path.join(RAIZ, 'restaurado.sql'), 'utf8'), /volcado de prueba/);
  const soloConf = await backup.restaurar(b.nombre, { confirmar: true, partes: ['conf'] });
  assert.deepEqual(soloConf.restauradas, []);
  assert.equal(soloConf.reiniciar, false);
});

test('programado, retención y nombres que no salen del directorio', async () => {
  for (const f of fs.readdirSync(DIR)) fs.unlinkSync(path.join(DIR, f));
  /* Tres programados viejos y uno manual: con keep=2 se borran los programados de más,
   * el manual no se toca nunca. */
  const viejo = (nombre, dias) => { const f = path.join(DIR, nombre); fs.writeFileSync(f, 'x'); const t = new Date(Date.now() - dias * 864e5); fs.utimesSync(f, t, t); };
  viejo('pbxng-auto-20260101-0300.tar.gz', 30); viejo('pbxng-auto-20260102-0300.tar.gz', 20); viejo('pbxng-auto-20260103-0300.tar.gz', 10);
  viejo('pbxng-20250101-1200.tar.gz', 400);
  const r = await backup.programado({ keep: 2 });
  assert.match(r.nombre, /^pbxng-auto-/);
  assert.deepEqual(r.retencion.borrados.sort(), ['pbxng-auto-20260101-0300.tar.gz', 'pbxng-auto-20260102-0300.tar.gz']);
  const quedan = (await backup.listar()).map((b) => b.nombre);
  assert.ok(quedan.includes('pbxng-20250101-1200.tar.gz'), 'el respaldo manual no entra en la retención');
  assert.equal(backup.esProgramado('pbxng-auto-x'), true);
  assert.equal(backup.esProgramado(null), false);
  assert.equal((await backup.retener('basura')).keep, 14);

  assert.equal(backup.seguro('../../etc/passwd.tar.gz'), path.join(DIR, 'passwd.tar.gz'), 'un ../ no sale del directorio');
  assert.throws(() => backup.seguro('x.zip'), /inválido/);
  assert.throws(() => backup.seguro(''), /inválido/);
  await assert.rejects(backup.borrar('no-existe.tar.gz'));

  process.env.FALSO_PGDUMP_FALLA = '1';
  try { await assert.rejects(backup.crear({}), /pg_dump: conexión rechazada/); }
  finally { delete process.env.FALSO_PGDUMP_FALLA; }
  assert.equal(fs.readdirSync(DIR).filter((f) => f.endsWith('.tar.gz')).length, 3, 'un respaldo fallido no deja archivo a medias');
});

/* ── La línea de comandos ───────────────────────────────────────────────────── */
const cli = (args, env) => spawnSync(process.execPath, ['backup-cli.js', ...args], {
  cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  env: Object.assign({}, process.env, { BACKUP_DIR: DIR, LOG_LEVEL: 'error', DB_HOST: '127.0.0.1', DB_PORT: '1' }, env || {}),
});

test('cli: --help, --list vacío y con respaldos', () => {
  assert.match(cli(['--help']).stdout, /^uso: node backup-cli\.js/);
  const lista = cli(['--list']);
  assert.equal(lista.status, 0);
  assert.match(lista.stdout, /pbxng-auto-.*programado/);
  assert.match(lista.stdout, /pbxng-20250101-1200\.tar\.gz.*manual/);
  const vacio = cli(['--list'], { BACKUP_DIR: path.join(RAIZ, 'vacio') });
  assert.match(vacio.stdout, /no hay respaldos/);
});

test('cli: respaldo con retención y nota; sin base anota igual que puede y sale 0', () => {
  const r = cli(['--keep', '1', '--nota=desde el cron', '--grabaciones']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /respaldo creado: pbxng-auto-.* con grabaciones/);
  assert.match(r.stdout, /retención \(1\): borré \d+ respaldo\(s\) viejo\(s\)/);
  const otra = cli(['--keep=50']);
  assert.match(otra.stdout, /retención \(50\): nada para borrar/);
});

test('cli: si el respaldo falla sale 1 y lo dice', () => {
  const r = cli([], { FALSO_PGDUMP_FALLA: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /el respaldo falló: pg_dump: .*conexión rechazada/);
});
