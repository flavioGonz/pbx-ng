/* ============================================================================
 *  La central se trae sola el instalador del softphone (softphone-ota.js).
 *
 *  GitHub se intercepta en `fetch`: cada prueba decide qué publica el release. Lo que
 *  importa es el orden (el latest.yml SIEMPRE al final, así ningún softphone va a buscar
 *  un .exe a medio bajar), que una descarga cortada no deje un .exe truncado, que se
 *  conserven la versión actual y la anterior, y que sin disco no se baje nada.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initOta = require('../softphone-ota');

const yml = (v, extra = '') => `version: ${v}\nfiles:\n  - url: PBX-NG Softphone Setup ${v}.exe\n    sha512: x\n    size: 6\npath: PBX-NG Softphone Setup ${v}.exe\nsha512: x\nreleaseDate: 2026-10-01T00:00:00.000Z\n${extra}`;
const fetchReal = globalThis.fetch;
let publicado = {};
let pedidos = [];
test.before(() => {
  globalThis.fetch = async (url) => {
    pedidos.push(String(url));
    const r = publicado[String(url).split('/releases/')[1]];
    if (r === undefined) return new Response('no', { status: 404 });
    if (typeof r === 'function') return r();
    return new Response(r, { status: 200, headers: { 'content-length': String(Buffer.byteLength(r)) } });
  };
});
test.after(() => { globalThis.fetch = fetchReal; });

function armar(ajustes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-'));
  const pool = { query: async (sql, args) => ({ rows: ajustes[args[0]] !== undefined ? [{ value: ajustes[args[0]] }] : [] }) };
  const ota = initOta({ pool, dir });
  return { ota, dir, ls: () => fs.readdirSync(dir).sort() };
}

test('sin repositorio no se sale a buscar nada', async (t) => {
  const { ota, dir } = armar({ softphone_ota_repo: '/' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await ota.revisar(), { ok: false, motivo: 'no hay repositorio configurado' });
  assert.equal((await ota.estado()).resultado, 'sin_repo');
});

test('baja el instalador nuevo, después el blockmap y recién al final el latest.yml', async (t) => {
  const { ota, dir, ls } = armar({ softphone_ota_repo: 'org/repo', softphone_ota_auto: '1', softphone_ota_cada_h: '999' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  publicado = { 'latest/download/latest.yml': yml('0.18.0'), 'latest/download/PBX-NG.Softphone.Setup.0.18.0.exe': 'MZ0180', 'latest/download/PBX-NG.Softphone.Setup.0.18.0.exe.blockmap': 'bm' };
  pedidos = [];
  const r = await ota.revisar({});
  assert.deepEqual(r, { ok: true, actualizado: true, version: '0.18.0', anterior: null });
  assert.deepEqual(ls(), ['PBX-NG Softphone Setup 0.18.0.exe', 'PBX-NG Softphone Setup 0.18.0.exe.blockmap', 'latest.yml']);
  assert.match(pedidos[1], /PBX-NG\.Softphone\.Setup\.0\.18\.0\.exe$/, 'GitHub publica los espacios como puntos');
  const e = await ota.estado();
  assert.equal(e.sirviendo.version, '0.18.0');
  assert.equal(e.cada_h, 168, 'el reloj tiene techo de una semana');
  assert.deepEqual(await ota.revisar({}), { ok: true, al_dia: true, version: '0.18.0' }, 'la misma versión no se vuelve a bajar');

  /* Una versión pedida a mano, sin blockmap, y la poda deja la actual y la anterior. */
  publicado['download/softphone-v0.19.0/latest.yml'] = yml('0.19.0');
  publicado['download/softphone-v0.19.0/PBX-NG.Softphone.Setup.0.19.0.exe'] = 'MZ0190';
  fs.writeFileSync(path.join(dir, 'PBX-NG Softphone Setup 0.17.0.exe'), 'viejo');
  fs.writeFileSync(path.join(dir, 'algo.exe.part'), 'cortado');
  const r2 = await ota.revisar({ version: '0.19.0', forzar: true });
  assert.equal(r2.version, '0.19.0');
  assert.deepEqual(ls(), ['PBX-NG Softphone Setup 0.18.0.exe', 'PBX-NG Softphone Setup 0.18.0.exe.blockmap', 'PBX-NG Softphone Setup 0.19.0.exe', 'latest.yml'], 'se va la 0.17 y el .part; quedan la actual y la anterior');
  await ota.programar();
});

test('feed ausente o inválido, descarga cortada, archivo enorme y una revisión por vez', async (t) => {
  const { ota, dir, ls } = armar({ softphone_ota_repo: 'org/repo' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  publicado = {};
  assert.match((await ota.revisar()).motivo, /HTTP 404/);
  publicado = { 'latest/download/latest.yml': 'version: 1\n' };
  assert.match((await ota.revisar()).motivo, /no trae path\/version/);
  publicado = { 'latest/download/latest.yml': yml('1.0.0'), 'latest/download/PBX-NG.Softphone.Setup.1.0.0.exe': () => new Response('MZ', { status: 200, headers: { 'content-length': '999' } }) };
  assert.match((await ota.revisar()).motivo, /descarga incompleta/);
  assert.deepEqual(ls(), [], 'ni el .exe truncado ni el latest.yml quedan servidos');
  publicado['latest/download/PBX-NG.Softphone.Setup.1.0.0.exe'] = () => new Response('MZ', { status: 200, headers: { 'content-length': String(500 * 1048576) } });
  assert.match((await ota.revisar()).motivo, /mas que el tope/);
  publicado['latest/download/PBX-NG.Softphone.Setup.1.0.0.exe'] = () => new Promise((r) => setTimeout(() => r(new Response('MZ', { status: 503 })), 100));
  const [a, b] = await Promise.all([ota.revisar(), ota.revisar()]);
  assert.equal(b.motivo, 'ya hay una descarga en curso');
  assert.match(a.motivo, /HTTP 503/);
  assert.equal((await ota.estado()).resultado, 'error');
});
