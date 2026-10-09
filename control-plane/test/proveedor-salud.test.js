/* ============================================================================
 *  ¿La cuenta del proveedor puede atender una llamada AHORA?
 *
 *  Esto nació de una llamada real: la cuenta se quedó sin créditos y la única forma de
 *  enterarse fue marcar el interno y escuchar «no puedo atenderte». Lo que se prueba acá
 *  es que el chequeo conteste esa pregunta —no «cuánto saldo hay», que el proveedor ni
 *  siquiera publica— y que traduzca cada falla a algo accionable.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../proveedor-salud');

const modelos = (ids) => ({ ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) });
const error = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
const bien = { ok: true, status: 200, json: async () => ({ output: [] }) };
const IDS = ['gpt-6-sol', 'gpt-5-nano', 'gpt-live-1', 'gpt-realtime-2.1'];

test('sin clave no se consulta a nadie, y se dice qué hacer', async () => {
  let llamo = false;
  const r = await s.revisar({ key: '', fetch: async () => { llamo = true; return bien; } });
  assert.equal(r.estado, 'sin_clave');
  assert.equal(llamo, false);
  assert.match(r.arreglo, /Nube/);
});

test('la cuenta sin crédito se detecta ANTES de que alguien llame', async () => {
  /* El punto de todo el archivo: listar modelos responde igual con la cuenta vacía. Sin la
   * segunda petición, el panel diría «todo bien» hasta que entre una llamada. */
  const pasos = [];
  const r = await s.revisar({
    key: 'sk-x',
    fetch: async (url) => {
      pasos.push(url);
      if (url.endsWith('/models')) return modelos(IDS);
      return error(429, 'You have no credits remaining. Add credits to continue using the API');
    },
  });
  assert.equal(pasos.length, 2, 'se quedó en la lista de modelos: eso no prueba el crédito');
  assert.equal(r.estado, 'sin_saldo', 'clasificó como límite de uso lo que era falta de saldo');
  assert.match(r.que, /crédito/i);
  assert.match(r.arreglo, /saldo/i);
});

test('una clave rechazada no se confunde con falta de saldo', async () => {
  const r = await s.revisar({ key: 'sk-mala', fetch: async () => error(401, 'Incorrect API key provided') });
  assert.equal(r.estado, 'clave');
  assert.match(r.arreglo, /clave/i);
});

test('cuenta sana: estado ok y con qué se probó', async () => {
  const r = await s.revisar({ key: 'sk-x', fetch: async (url) => (url.endsWith('/models') ? modelos(IDS) : bien) });
  assert.equal(r.estado, 'ok');
  assert.equal(r.modelos, IDS.length);
  assert.ok(r.ts);
});

test('el chequeo gasta lo mínimo: elige el modelo más barato y pide pocos tokens', async () => {
  let cuerpo = null;
  await s.revisar({ key: 'sk-x', fetch: async (url, opts) => {
    if (url.endsWith('/models')) return modelos(IDS);
    cuerpo = JSON.parse(opts.body); return bien;
  } });
  assert.equal(cuerpo.model, 'gpt-5-nano', 'usó un modelo caro para un chequeo que corre cada rato');
  assert.ok(cuerpo.max_output_tokens <= 16);
  /* Y nunca prueba con un modelo de voz: esos se pagan por minuto de sesión. */
  assert.doesNotMatch(cuerpo.model, /live|realtime/);
});

test('sin modelos utilizables lo dice, en vez de romper', async () => {
  const r = await s.revisar({ key: 'sk-x', fetch: async () => modelos(['whisper-1', 'tts-1']) });
  assert.equal(r.estado, 'modelo');
});

test('un problema de red no se disfraza de problema de cuenta', async () => {
  const r = await s.revisar({ key: 'sk-x', fetch: async () => { throw new Error('ENOTFOUND api.openai.com'); } });
  assert.equal(r.estado, 'error');
  assert.match(r.arreglo, /red|proveedor/i);
});
