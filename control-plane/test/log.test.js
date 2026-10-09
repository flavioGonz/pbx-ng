/* ============================================================================
 *  El logger (log.js): niveles, JSON o texto, los errores con su stack, y que nunca
 *  rompa la app (un objeto circular, un BigInt). El formato se lee al cargar el módulo,
 *  así que cada caso corre en un proceso aparte con su LOG_FORMAT y su LOG_LEVEL.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const correr = (codigo, env) => spawnSync(process.execPath, ['-e', "const logger = require('" + path.resolve(__dirname, '..', 'log.js') + "'); " + codigo], {
  encoding: 'utf8', env: Object.assign({}, process.env, { LOG_FORMAT: 'json', LOG_LEVEL: 'info' }, env || {}),
});
const lineas = (s) => s.trim().split('\n').filter(Boolean);

test('JSON: un registro por línea, warn y error a stderr, los campos y el error con su stack', () => {
  const r = correr(`const l = logger('pago'); l.debug('no sale'); l.info('cobro', { monto: 10, err: new Error('dentro') }, 42, undefined, [1]);
    const e = Object.assign(new Error('falló'), { code: 'E1', status: 502 }); l.warn('cuidado', e); l.error({ x: 1 });`);
  const out = lineas(r.stdout).map((x) => JSON.parse(x));
  const err = lineas(r.stderr).map((x) => JSON.parse(x));
  assert.equal(out.length, 1, 'debug no sale con LOG_LEVEL=info');
  assert.equal(out[0].mod, 'pago');
  assert.equal(out[0].msg, 'cobro 42 undefined [1]');
  assert.equal(out[0].monto, 10);
  assert.equal(out[0].err.message, 'dentro', 'un Error dentro de un campo no queda como {}');
  assert.equal(err[0].level, 'warn');
  assert.deepEqual([err[0].err.code, err[0].err.status], ['E1', 502]);
  assert.match(err[0].err.stack, /falló/);
  assert.equal(err[1].x, 1);
});

test('texto: legible, con el error sólo por su mensaje (el stack en debug)', () => {
  const r = correr(`const l = logger(); l.info('hola', { a: 1 }); l.error('mal', new Error('boom')); l.info('nada');`, { LOG_FORMAT: 'text' });
  assert.match(r.stdout, /INFO {2}\[app\] hola \{"a":1\}/);
  assert.match(r.stdout, /INFO {2}\[app\] nada$/m);
  assert.match(r.stderr, /ERROR \[app\] mal \{"err":"boom"\}/);
  const d = correr(`logger('x').debug('d', new Error('con stack'));`, { LOG_FORMAT: 'text', LOG_LEVEL: 'debug' });
  assert.match(d.stdout, /"stack":/, 'en debug el error va entero');
});

test('nunca rompe: un objeto circular o un BigInt no tiran, y un nivel desconocido cae en info', () => {
  const r = correr(`const l = logger('c'); const o = {}; o.o = o; l.info('circular', { o }); l.info('big', { n: 1n }); l.debug('no'); console.log('sigue');`, { LOG_LEVEL: 'cualquiera' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"err":"no serializable"/);
  assert.match(r.stdout, /sigue/);
  assert.doesNotMatch(r.stdout, /"msg":"no"/);
});

test('el logger mudo no dice nada y no se puede pisar', () => {
  const { mudo, NIVELES, logger } = require('../log');
  for (const k of ['debug', 'info', 'warn', 'error']) assert.equal(mudo[k]('x'), undefined);
  assert.equal(Object.isFrozen(mudo), true);
  assert.equal(NIVELES.warn, 30);
  assert.equal(logger('m').mod, 'm');
});
