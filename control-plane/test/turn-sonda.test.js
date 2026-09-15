/* Medio · LA SONDA del TURN contra un TURN de verdad (uno de mentira, pero que habla
 * STUN/TURN por el cable): `control-plane/turn.js` y `scripts/check-turn.py`.
 *
 * POR QUÉ ESTÁ SEPARADO de turn.test.js: acá no hace falta ni Postgres ni la API, así
 * que corre siempre —en la laptop, en la CI y adentro de un contenedor pelado—. Los dos
 * bugs que dejaron una central real sin audio (el host que no se resolvía por nombre y
 * el framing TCP leído a medias) se arreglaron a mano y sin red abajo: no había forma de
 * ejercitar la sonda sin levantar un coturn, así que no se probó, y el mismo bug de
 * framing siguió vivo en el script del instalador durante toda una release.
 *
 * Y se compara el veredicto de la sonda de la API contra el `exit` real de
 * `scripts/check-turn.py`: CONTRATOS §3 promete que las dos herramientas dan el MISMO
 * veredicto sobre el mismo TURN, y una promesa así sólo se sostiene si algo la mide.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

/* El script se corre SIN BLOQUEAR el bucle de eventos: el TURN de mentira vive en este
 * mismo proceso, así que con `spawnSync` nadie contestaría los datagramas y el script
 * daría «STUN sin respuesta» por una razón que no tiene nada que ver con lo que se
 * quiere medir. Devuelve { status, salida }. */
function correrPy(args) {
  return new Promise((resolve) => {
    const h = spawn('python3', args, { encoding: 'utf8' });
    let salida = '';
    h.stdout.on('data', (d) => { salida += d; });
    h.stderr.on('data', (d) => { salida += d; });
    h.on('close', (status) => resolve({ status, salida }));
  });
}
const { turnFalso } = require('./helpers/turn-falso');
const turn = require('../turn');

test('turn: motivoRelay compara contra la IP RESUELTA, no contra el nombre', () => {
  /* Regresión de la ronda anterior: la sonda comparaba el relay privado contra la
   * CADENA del host (`DOMAIN`, un nombre), que nunca es una IPv4 privada, así que la
   * condición daba falso y un coturn anunciando 172.17.0.1 pasaba como OK — la sonda
   * escrita para detectar ese caso no lo detectaba. */
  assert.ok(turn.motivoRelay('172.17.0.1', '200.40.1.1'), 'relay privado + TURN público = FALLA');
  assert.equal(turn.motivoRelay('172.17.0.1', '192.168.1.5'), null, 'todo en la misma LAN privada no es falla');
  assert.equal(turn.motivoRelay('172.17.0.1', ''), null, 'sin IP resuelta no se puede afirmar nada');
  assert.ok(turn.motivoRelay('127.0.0.1', '192.168.1.5'), 'el loopback es inservible siempre');
});

test('turn: la sonda contra un TURN de verdad (framing TCP, relay y liberación)', async (t) => {
  await t.test('TCP partido en dos writes: se lee el mensaje ENTERO', async () => {
    /* Regresión de la ronda anterior. TCP es un flujo: el servidor puede cortar donde
     * quiera, y el Allocate firmado —el mensaje más largo— es el candidato natural a
     * llegar partido. Con un solo `recv()` la sonda declaraba «no se comporta como
     * TURN» sobre un TURN sano: un falso negativo en la herramienta que existe
     * justamente para no creerle al panel. */
    const srv = await turnFalso({ partirTcp: true });
    try {
      const r = await turn.sondear({ host: '127.0.0.1', puerto: srv.puerto, usuario: 'u', clave: 'p', tcp: true, ms: 3000 });
      assert.equal(r.ok, true, r.veredicto);
      assert.equal(r.relay, srv.relay + ':49160');
    } finally { await srv.cerrar(); }
  });

  await t.test('el Refresh lifetime=0 sale por el MISMO socket que el Allocate', async () => {
    /* Cada Allocate que sale bien deja una asignación viva en coturn con su lifetime
     * (600 s por defecto). La pantalla del TURN mide cada 30 s y el Resumen cada 60:
     * sin devolverla, la sonda va llenando de asignaciones colgadas el relay que existe
     * para cuidar. Y tiene que salir por el mismo socket, porque en UDP la asignación
     * está atada a la 5-tupla. */
    const srv = await turnFalso({});
    try {
      const r = await turn.sondear({ host: '127.0.0.1', puerto: srv.puerto, usuario: 'u', clave: 'p', tcp: false, ms: 3000 });
      assert.equal(r.ok, true, r.veredicto);
      assert.equal(r.liberada, true, 'la sonda tiene que devolver la asignación');
      const p = srv.pedidos('UDP');
      const alloc = p.filter((x) => x.tipo === 0x0003).pop();
      const refresh = p.filter((x) => x.tipo === 0x0004).pop();
      assert.ok(alloc && refresh, 'tienen que llegar Allocate y Refresh');
      assert.equal(refresh.origen, alloc.origen, 'otro puerto de origen = otra 5-tupla = no libera nada');
      assert.ok(r.pasos.some((x) => x.paso === 'Refresh lifetime=0' && x.ok));
    } finally { await srv.cerrar(); }
  });

  await t.test('un relay en el bridge de Docker sale FALLA aunque el TURN autentique', async () => {
    const srv = await turnFalso({ relay: '127.0.0.1' });
    try {
      const r = await turn.sondear({ host: '127.0.0.1', puerto: srv.puerto, usuario: 'u', clave: 'p', tcp: false, ms: 3000 });
      assert.equal(r.ok, false);
      assert.match(r.veredicto, /loopback/);
    } finally { await srv.cerrar(); }
  });

  await t.test('sólo UDP (el port-forward más común): verde, con aviso por TCP', async () => {
    const srv = await turnFalso({ soloUdp: true });
    try {
      const [udp, tcp] = await Promise.all([
        turn.sondear({ host: '127.0.0.1', puerto: srv.puerto, usuario: 'u', clave: 'p', tcp: false, ms: 3000 }),
        turn.sondear({ host: '127.0.0.1', puerto: srv.puerto, usuario: 'u', clave: 'p', tcp: true, ms: 3000 }),
      ]);
      const g = turn.agregar(udp, tcp);
      assert.equal(g.ok, true, 'un transporte alcanza: la pregunta es si hay UN candidato relay');
      assert.match(g.aviso, /TCP/);
    } finally { await srv.cerrar(); }
  });

  await t.test('el host por nombre se resuelve antes de juzgar el relay', async () => {
    const srv = await turnFalso({});
    try {
      const r = await turn.sondear({ host: 'localhost', puerto: srv.puerto, usuario: 'u', clave: 'p', tcp: false, ms: 3000 });
      assert.equal(r.host_ip, '127.0.0.1', 'la sonda compara contra la IP resuelta, no contra la cadena');
    } finally { await srv.cerrar(); }
  });
});

/* El instalador y el panel tienen que dar el MISMO veredicto sobre el mismo TURN. Si no
 * hay python3 (una laptop pelada) se saltea: nunca fallar por falta de infraestructura,
 * eso taparía fallos reales. */
test('turn: check-turn.py da el mismo veredicto que la sonda de la API', async (t) => {
  const py = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' });
  if (py.status !== 0) { t.skip('prueba salteada: no hay python3 en este entorno'); return; }
  const script = path.resolve(__dirname, '..', '..', 'scripts', 'check-turn.py');

  await t.test('TURN sano (sólo UDP, el port-forward más común): los dos dan OK', async () => {
    const srv = await turnFalso({ soloUdp: true });
    try {
      const r = await turn.sondear({ host: '127.0.0.1', puerto: srv.puerto, usuario: 'u', clave: 'p', tcp: false, ms: 3000 });
      const cli = await correrPy([script, '--host', '127.0.0.1', '--port', String(srv.puerto), '--user', 'u', '--pass', 'p']);
      assert.equal(r.ok, true, r.veredicto);
      assert.equal(cli.status, 0, cli.salida);
    } finally { await srv.cerrar(); }
  });

  await t.test('relay inservible: los dos dan FALLA', async () => {
    const srv = await turnFalso({ relay: '127.0.0.1' });
    try {
      const r = await turn.sondear({ host: '127.0.0.1', puerto: srv.puerto, usuario: 'u', clave: 'p', tcp: false, ms: 3000 });
      const cli = await correrPy([script, '--host', '127.0.0.1', '--port', String(srv.puerto), '--user', 'u', '--pass', 'p']);
      assert.equal(r.ok, false);
      assert.notEqual(cli.status, 0, 'el instalador no puede cerrar en verde un relay que nadie alcanza: ' + cli.salida);
    } finally { await srv.cerrar(); }
  });

  await t.test('la sonda del instalador también devuelve la asignación', async () => {
    const srv = await turnFalso({});
    try {
      await correrPy([script, '--host', '127.0.0.1', '--port', String(srv.puerto), '--user', 'u', '--pass', 'p']);
      const p = srv.pedidos('UDP');
      const alloc = p.filter((x) => x.tipo === 0x0003).pop();
      const refresh = p.filter((x) => x.tipo === 0x0004).pop();
      assert.ok(refresh, 'sin Refresh lifetime=0 cada instalación deja una asignación colgada');
      assert.equal(refresh.origen, alloc.origen);
    } finally { await srv.cerrar(); }
  });
});
