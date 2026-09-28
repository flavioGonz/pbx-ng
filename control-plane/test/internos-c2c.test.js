'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

/* Los invitados de las llamadas desde la web (contexto `c2c`) son endpoints WebRTC
 * descartables que la central crea para cada visita y borra sola a los 40 minutos. En la
 * lista de internos se veían como un interno WebRTC desconocido registrado desde la IP del
 * proxy: indistinguible de un intruso. Esta prueba fija la exclusión — es una línea de SQL
 * que cualquier refactor puede perder sin que nada falle a la vista. */
test('la lista de internos excluye a los invitados de click-to-call', () => {
  const src = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const m = src.match(/async function getExtensions\(\)[\s\S]{0,900}?pool\.query\("([^"]+)"\)/);
  assert.ok(m, 'no se encontró la consulta de getExtensions');
  const sql = m[1];
  assert.ok(/pbxng_kind/.test(sql), 'debe seguir filtrando por pbxng_kind');
  assert.ok(/<>\s*'c2c'|!=\s*'c2c'|NOT IN \('c2c'\)/.test(sql), 'debe excluir el contexto c2c');
});
