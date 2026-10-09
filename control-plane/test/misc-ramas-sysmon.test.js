/* ============================================================================
 *  Resumen del sistema (sysmon.js): la foto de TODOS los nodos, sin red de verdad.
 *
 *  Lo que se fija:
 *   - Con los agentes de Asterisk y TURN y el motor de voz contestando, cada uno sale
 *     como su propio nodo con los números del agente (CPU por carga si el agente no
 *     manda el %, disco sólo si lo informa, placas virtuales filtradas).
 *   - Un agente caído NO tumba el resumen: Asterisk sale `ok:false`, el TURN y la voz
 *     directamente no aparecen, y el servicio coturn no se lista.
 *   - La base rota se informa como servicio caído en vez de reventar la ruta.
 *   - El nodo core toma el % de CPU del cgroup; sin cgroup cae a os.cpus() y, con
 *     cgroup pero sin medición previa, queda en null (un 0 inventado se lee «ocioso»).
 *   - El tamaño de grabaciones/buzón recorre como mucho 3 niveles y un directorio
 *     inexistente da null (no 0: el panel distingue «no sé» de «vacío»).
 *  Importa porque es la primera pantalla que ve el operador: si una pieza ausente la
 *  rompe, el panel entero queda en blanco justo cuando algo anda mal.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cg = require('../cgroup');
const sysmon = require('../sysmon');

const poolBien = { async query() { return { rows: [{ bytes: '1024', conns: '3', cdr: '7' }] }; } };
const poolRoto = { async query() { throw new Error('base caída'); } };

function respuesta(cuerpo, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return cuerpo; } };
}

// Árbol de grabaciones con un archivo demasiado hondo (nivel 5): no se cuenta.
function arbol(t) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  fs.writeFileSync(path.join(raiz, 'a.wav'), 'x'.repeat(10));
  const hondo = path.join(raiz, '1', '2', '3', '4');
  fs.mkdirSync(hondo, { recursive: true });
  fs.writeFileSync(path.join(raiz, '1', 'b.wav'), 'y'.repeat(5));
  fs.writeFileSync(path.join(hondo, 'c.wav'), 'z'.repeat(100));
  return raiz;
}

function entornoVars(t, vars) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  t.after(() => { for (const k of Object.keys(antes)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; } });
}

test('sysmon: con todos los agentes arriba cada nodo sale con sus números', async (t) => {
  const rec = arbol(t);
  entornoVars(t, { AST_AGENT: null, TURN_AGENT: null, REC_DIR: rec, VM_DIR: path.join(rec, 'no-existe') });
  t.mock.method(cg, 'cpuPct', () => ({ cpu_pct: 42, origen: 'cgroup v2 (cpu.stat)' }));
  t.mock.method(os, 'networkInterfaces', () => ({
    lo: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8' }],
    eth0: [{ family: 'IPv4', address: '10.0.0.5', cidr: '10.0.0.5/24', mac: 'aa:bb' }, { family: 'IPv6', address: '::1' }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', cidr: '172.17.0.1/16' }],
    solo6: [{ family: 'IPv6', address: 'fe80::1' }],
    sincidr: [{ family: 'IPv4', address: '192.168.0.9' }],
  }));
  const pedidas = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    pedidas.push({ url, token: opts.headers['X-PBXNG-Token'] });
    if (url.endsWith(':8092/core')) return respuesta({ version: '22.1', channels: 0, metrics: { load: 2, ncpu: 4, disk_total: 100, disk_used: 40, disk_free: 60, disk_pct: 40, mem_pct: 0 } });
    if (url.endsWith(':8092/net')) return respuesta({ ifaces: [{ name: 'eth0' }, { name: 'veth123' }, null, {}] });
    if (url.endsWith(':8091/core')) return respuesta({ metrics: { cpu_pct: 7, ncpu: 2, load: 0.1, mem_total_mb: 512, mem_used_mb: 100, uptime_s: 99 } });
    if (url.endsWith(':8091/net')) return respuesta({});
    if (url.endsWith(':8080/health')) return respuesta({ metrics: { cpu_pct: 0, ncpu: 8, load: 1, mem_total_mb: 1000, mem_used_mb: 10, mem_pct: 1, uptime_s: 5 } });
    throw new Error('url inesperada ' + url);
  });
  sysmon.init(poolBien, { nodes: { asterisk: 'ast.local', turn: 'turn.local', voz: 'voz.local' }, state: { ami: true }, token: 'tok' });
  const o = await sysmon.overview();

  assert.ok(pedidas.every((p) => p.token === 'tok'), 'todos los agentes reciben el token');
  const porId = Object.fromEntries(o.nodes.map((n) => [n.id, n]));
  assert.deepEqual(Object.keys(porId).sort(), ['asterisk', 'core', 'turn', 'voz']);
  assert.equal(porId.core.host, 'ast.local');
  assert.equal(porId.core.cpu_pct, 42);
  assert.deepEqual(porId.core.ifaces.map((i) => i.name).sort(), ['eth0', 'sincidr'], 'sin lo, sin docker, sin placas sólo IPv6');
  assert.deepEqual(porId.core.ifaces.find((i) => i.name === 'eth0').addrs, ['10.0.0.5/24']);
  // Asterisk: sin cpu_pct del agente, sale de la carga / núcleos.
  assert.equal(porId.asterisk.cpu_pct, 50);
  assert.equal(porId.asterisk.version, '22.1');
  assert.equal(porId.asterisk.channels, 0, 'cero canales es un dato, no «sin dato»');
  assert.equal(porId.asterisk.mem_pct, 0);
  assert.deepEqual(porId.asterisk.disk, { total: 100, used: 40, free: 60, pct: 40 });
  assert.deepEqual(porId.asterisk.ifaces.map((i) => i.name), ['eth0']);
  // TURN: con su propio % y sin disco informado.
  assert.equal(porId.turn.cpu_pct, 7);
  assert.equal(porId.turn.disk, null);
  assert.equal(porId.turn.mem_pct, null);
  assert.deepEqual(porId.turn.ifaces, []);
  assert.equal(porId.voz.cpu_pct, 0);
  assert.equal(porId.voz.mem_pct, 1);
  // Almacenamiento: el archivo del nivel 5 no entra; el buzón inexistente es null.
  assert.deepEqual(o.storage.recordings, { bytes: 15, files: 2 });
  assert.equal(o.storage.voicemail, null);
  assert.deepEqual(o.storage.db, { ok: true, bytes: 1024, conns: 3, cdr: 7 });
  const serv = Object.fromEntries(o.services.map((s) => [s.id, s]));
  assert.equal(serv.coturn.ok, true);
  assert.equal(serv.asterisk.detail, 'AMI y ARI conectados');
  assert.equal(serv.voz.ok, true);
});

test('sysmon: agentes caídos y base rota no tumban el resumen', async (t) => {
  entornoVars(t, { AST_AGENT: 'http://ast-env:8092', TURN_AGENT: 'http://turn-env:8091', REC_DIR: path.join(os.tmpdir(), 'no-existe-sysmon'), VM_DIR: path.join(os.tmpdir(), 'no-existe-sysmon') });
  t.mock.method(cg, 'cpuPct', () => ({ cpu_pct: null, origen: 'cgroup v2 (cpu.stat)' }));
  t.mock.method(os, 'networkInterfaces', () => ({ eth0: undefined }));
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('ast-env')) return respuesta({}, 503);    // el agente contesta con error
    throw new Error('ECONNREFUSED');                           // el de TURN ni contesta
  });
  sysmon.init(poolRoto, { nodes: { voz: 'voz.local' } });
  const o = await sysmon.overview();
  const porId = Object.fromEntries(o.nodes.map((n) => [n.id, n]));
  assert.deepEqual(Object.keys(porId).sort(), ['asterisk', 'core'], 'TURN y voz caídos no se dibujan');
  assert.equal(porId.core.host, os.hostname());
  assert.equal(porId.core.cpu_pct, null, 'con cgroup y sin medición previa: null, no 0');
  assert.equal(porId.asterisk.ok, false);
  assert.equal(porId.asterisk.version, null);
  assert.equal(porId.asterisk.channels, null);
  assert.equal(o.storage.recordings, null);
  assert.equal(o.storage.db.ok, false);
  assert.equal(o.storage.db.error, 'base caída');
  const serv = Object.fromEntries(o.services.map((s) => [s.id, s]));
  assert.equal(serv.postgres.ok, false);
  assert.equal(serv.asterisk.ok, false);
  assert.equal(serv.asterisk.detail, 'sin AMI');
  assert.equal(serv.coturn, undefined);
  assert.equal(serv.voz.ok, false);
});

test('sysmon: sin cgroup el core mide con os.cpus() y nunca se sale de 0..100', async (t) => {
  entornoVars(t, { AST_AGENT: null, TURN_AGENT: null, REC_DIR: path.join(os.tmpdir(), 'no-existe-sysmon'), VM_DIR: path.join(os.tmpdir(), 'no-existe-sysmon') });
  t.mock.method(cg, 'cpuPct', () => ({ cpu_pct: null, origen: 'sin cgroup: no se mide el uso del nodo' }));
  // Dos fotos de os.cpus(): la segunda con 100 ticks más, 25 de ellos ociosos → 75 %.
  t.mock.method(cg, 'cpus', () => ({ ncpu: 1, origen: 'os.cpus() (sin cgroup)' }));
  let vuelta = 0;
  t.mock.method(os, 'cpus', () => {
    vuelta++;
    if (vuelta === 1) return [{ times: { user: 100, idle: 100 } }];
    if (vuelta === 2) return [{ times: { user: 175, idle: 125 } }];
    return [{ times: { user: 175, idle: 125 } }];   // sin avance: delta 0 → 0 %
  });
  sysmon.init(poolBien);
  const pcts = [];
  for (let i = 0; i < 3; i++) pcts.push((await sysmon.overview()).nodes[0].cpu_pct);
  assert.equal(pcts[1], 75);
  assert.equal(pcts[2], 0);
  for (const p of pcts) assert.ok(p >= 0 && p <= 100);
});

test('sysmon: agentes que contestan sin métricas dan «sin dato» y un disco ilegible da null', async (t) => {
  entornoVars(t, { AST_AGENT: null, TURN_AGENT: null, REC_DIR: null, VM_DIR: null });
  t.mock.method(cg, 'cpuPct', () => ({ cpu_pct: 1, origen: 'cgroup v2 (cpu.stat)' }));
  // Primer statfs: disco de tamaño 0 (pct 0, sin dividir por cero); después, ilegible.
  let n = 0;
  t.mock.method(fs, 'statfsSync', () => { if (n++ === 0) return { blocks: 0, bsize: 4096, bfree: 0 }; throw new Error('EACCES'); });
  t.mock.method(globalThis, 'fetch', async (url) => respuesta(url.endsWith('/net') ? null : {}));
  sysmon.init(poolBien, { nodes: { asterisk: 'ast.local', turn: 'turn.local', voz: 'voz.local' } });
  const o = await sysmon.overview();
  const porId = Object.fromEntries(o.nodes.map((x) => [x.id, x]));
  assert.deepEqual(porId.core.disk, { total: 0, free: 0, used: 0, pct: 0 });
  assert.equal(o.storage.disk, null);
  for (const id of ['asterisk', 'turn']) {
    assert.equal(porId[id].ok, true, id + ': el agente contestó');
    assert.equal(porId[id].cpu_pct, null);
    assert.equal(porId[id].ncpu, null);
    assert.equal(porId[id].load, null);
    assert.deepEqual(porId[id].ifaces, []);
  }
  for (const k of ['cpu_pct', 'ncpu', 'load', 'mem_total_mb', 'mem_used_mb', 'mem_pct', 'uptime_s']) assert.equal(porId.voz[k], null, 'voz.' + k);
  // Sin REC_DIR/VM_DIR mira las rutas del contenedor; en la máquina de pruebas no existen o se leen: nunca revienta.
  assert.ok(o.storage.recordings === null || typeof o.storage.recordings.bytes === 'number');
});
