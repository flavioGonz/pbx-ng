/* ============================================================================
 *  Pipeline de IA en tres pasos (ai-pipeline.js, modos demo y openai): las
 *  conversaciones que no salen derecho.
 *
 *  ai-pipeline.test.js recorre el camino feliz de cada modo. Acá se fija el resto, que
 *  es lo que escucha de verdad alguien del otro lado:
 *
 *   · el demo por reglas: una frase que no entiende (pide repetir, y la segunda vez
 *     ofrece opciones), el saludo, una consulta de cuenta sin CRM configurado, una
 *     palabra suelta que no es frase, y las derivaciones con los internos por defecto
 *     cuando el agente no tiene cargados los suyos;
 *   · el servicio de voz que falla de todas las formas (status de error, audio vacío,
 *     red caída, velocidad ilegible) y la caída a espeak-ng local, que nunca deja muda
 *     la llamada;
 *   · el barge-in sobre una frase larga, y quien cuelga mientras se genera la voz;
 *   · OpenAI: herramientas sin argumentos, una herramienta desconocida, una respuesta
 *     final vacía (se pide repetir en vez de quedarse callado), una derivación con su
 *     propia frase, y el TTS / Whisper que fallan.
 *
 *  Vosk es un script de mentira que «escucha» una frase por cada tanda de audio; el
 *  servicio de voz y OpenAI se interceptan en `fetch`. Asterisk es helpers/llamada-ia.js.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { hasta, dormir, puertoLibre, asteriskFalso, canal, hablar, audioDe } = require('./helpers/llamada-ia');

/* ── Binarios de mentira ──────────────────────────────────────────────────────
 * python3 hace de Vosk: dice la frase siguiente de FALSO_VOSK_TEXTOS (separadas por |)
 * cada vez que junta 1600 bytes de audio nuevo, de a una por tanda. sox copia; espeak-ng
 * escupe un poco de audio. */
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'iaramas-bin-'));
fs.writeFileSync(path.join(BIN, 'python3'), `#!/usr/bin/env node
process.stderr.write('vosk: modelo cargado\\n');
const textos = (process.env.FALSO_VOSK_TEXTOS || '').split('|').filter(Boolean);
let n = 0, desde = 0, i = 0;
process.stdin.on('data', (d) => {
  n += d.length;
  if (i < textos.length && n - desde >= 1600) { desde = n; process.stdout.write(JSON.stringify({ final: textos[i++] }) + '\\n'); }
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'sox'), '#!/bin/sh\ncat\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'espeak-ng'), '#!/bin/sh\nhead -c 4000 /dev/zero\n', { mode: 0o755 });
/* Un PATH donde sólo está Vosk: sin espeak-ng ni sox, la voz local no arranca. */
const SOLO_VOSK = fs.mkdtempSync(path.join(os.tmpdir(), 'iaramas-solo-'));
fs.copyFileSync(path.join(BIN, 'python3'), path.join(SOLO_VOSK, 'python3'));
fs.chmodSync(path.join(SOLO_VOSK, 'python3'), 0o755);
const PATH_ORIG = process.env.PATH;
const NODE_DIR = path.dirname(process.execPath);
process.env.PATH = BIN + path.delimiter + PATH_ORIG;

/* ── fetch: el servicio de voz y OpenAI, interceptados ────────────────────── */
const VOZ = 'http://voz.test:8080';
const fetchReal = globalThis.fetch;
const voz = { tts: [], stt: [], ttsFn: null, sttFn: null };
const openai = { tts: null, stt: null, llm: [], llmPedidos: [] };
const AUDIO_CORTO = Buffer.alloc(1600, 1);   // 100 ms: sale entero en el colchón
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith(VOZ + '/tts')) {
    const body = JSON.parse(opts.body);
    voz.tts.push(body);
    return voz.ttsFn ? voz.ttsFn(body) : new Response(AUDIO_CORTO);
  }
  if (u.startsWith(VOZ + '/stt')) { voz.stt.push(u); return voz.sttFn ? voz.sttFn() : Response.json({ text: '' }); }
  if (u.startsWith('https://api.openai.com/')) {
    if (u.endsWith('/audio/speech')) return openai.tts ? openai.tts(JSON.parse(opts.body)) : new Response('no', { status: 500 });
    if (u.endsWith('/audio/transcriptions')) return openai.stt ? openai.stt() : new Response('no', { status: 500 });
    if (u.endsWith('/chat/completions')) {
      openai.llmPedidos.push(JSON.parse(opts.body));
      const r = openai.llm.shift();
      if (!r) return new Response('no', { status: 500 });
      return Response.json({ choices: [{ message: r }] });
    }
  }
  return fetchReal(url, opts);
};
const dichos = () => voz.tts.map((b) => b.text);

/* ── La base de mentira ───────────────────────────────────────────────────── */
const ajustes = new Map([['voz_url', VOZ]]);
let clientesFalla = false;
const pool = {
  async query(sql, args) {
    if (/SELECT value FROM pbxng_settings WHERE key=\$1/.test(sql)) return { rows: ajustes.has(args[0]) ? [{ value: ajustes.get(args[0]) }] : [] };
    if (/FROM pbxng_clients/.test(sql)) { if (clientesFalla) throw new Error('CRM caído'); return { rows: [] }; }
    return { rows: [], rowCount: 1 };
  },
};

let pipe, AS_PORT;
test.before(async () => {
  AS_PORT = await puertoLibre();
  process.env.AUDIOSOCKET_PORT = String(AS_PORT);
  pipe = require('../ai-pipeline');
});
test.after(async () => {
  try { await pipe.close(); } catch (_) {}
  globalThis.fetch = fetchReal;
  process.env.PATH = PATH_ORIG;
  delete process.env.FALSO_VOSK_TEXTOS;
  fs.rmSync(BIN, { recursive: true, force: true });
  fs.rmSync(SOLO_VOSK, { recursive: true, force: true });
});
test.beforeEach(() => {
  voz.tts.length = 0; voz.stt.length = 0; voz.ttsFn = null; voz.sttFn = null;
  openai.tts = null; openai.stt = null; openai.llm = []; openai.llmPedidos = [];
});

const AGENTE = { id: 9, name: 'Recepción', provider: 'demo', voice: 'alloy', greeting_text: 'Hola, recepción', herramientas: {} };

/* Arranca una llamada y espera el saludo. */
async function llamar(agente, textos, ch = canal()) {
  process.env.FALSO_VOSK_TEXTOS = (textos || []).join('|');
  const ari = asteriskFalso();
  pipe.init(ari, pool);
  await pipe.startAiSession(ch, Object.assign({}, AGENTE, agente));
  const m = ari.medios.at(-1);
  assert.ok(await hasta(() => audioDe(m) > 0, 5000), 'no saludó');
  return { ari, ch, m };
}
/* Una tanda de audio del llamante (una frase para el Vosk falso) y espera que se diga
 * algo nuevo. */
async function turno(m, cuantos = dichos().length + 1) {
  await dormir(100);   // que termine el turno anterior: con el agente ocupado, Vosk se descarta
  hablar(m, 6, 0);
  return hasta(() => dichos().length >= cuantos, 5000);
}

for (const [frase, interno] of [['quiero comprar', '1001'], ['tengo un problema', '1002'], ['con un operador', '1001']]) {
  test('demo: «' + frase + '» con el agente sin internos cargados deriva al ' + interno + ' por defecto', async () => {
    const { ch, m } = await llamar({}, [frase]);
    hablar(m, 6, 0);
    assert.ok(await hasta(() => ch.derivado, 5000), 'no derivó');
    assert.equal(ch.derivado.extension, interno);
  });
}

test('demo: lo que no entiende lo pide otra vez y después ofrece opciones; sin CRM lo dice; una letra suelta no es frase', async () => {
  /* El servicio de voz no transcribe (500, red caída, sin texto): se usa lo que oyó Vosk. */
  const sttRespuestas = [() => new Response('no', { status: 500 }), () => { throw new Error('ECONNRESET'); }];
  voz.sttFn = () => (sttRespuestas.length ? sttRespuestas.shift()() : Response.json({}));
  const { ch, m } = await llamar({}, ['zzz', 'a', 'hola', 'qwerty', 'mi cuenta', 'chau']);
  assert.ok(await turno(m));
  assert.match(dichos().at(-1), /no te entendí bien/);
  hablar(m, 6, 0);   // «a»: no es una frase, no se contesta
  await dormir(200);
  assert.ok(await turno(m));
  assert.match(dichos().at(-1), /Soy el asistente virtual/, 'el saludo se contesta con la presentación');
  assert.equal(dichos().length, 3, 'la letra suelta no tuvo respuesta');
  assert.ok(await turno(m));
  assert.match(dichos().at(-1), /Puedo derivarte a ventas o soporte/, 'la segunda vez que no entiende ofrece opciones');
  assert.ok(await turno(m));
  assert.match(dichos().at(-1), /No tengo el CRM configurado/);
  assert.ok(await turno(m));
  assert.match(dichos().at(-1), /Gracias por llamar/);
  assert.ok(await hasta(() => ch.colgado, 4000), 'después de despedirse corta');
  assert.ok(voz.stt.length >= 5, 'cada frase pasó por el servicio de voz antes de usar a Vosk');
});

test('demo: el servicio de voz que falla de cualquier forma cae a espeak-ng; la velocidad ilegible usa 1.0', async () => {
  ajustes.set('voz_length_scale', 'rápido');
  const respuestas = [
    () => new Response('no', { status: 503 }),
    () => new Response(Buffer.alloc(0)),
    () => { throw new Error('ECONNREFUSED'); },
  ];
  voz.ttsFn = () => (respuestas.length ? respuestas.shift()() : new Response(AUDIO_CORTO));
  try {
    const { m } = await llamar({}, ['zzz', 'qwerty']);
    assert.equal(voz.tts[0].length_scale, 1, 'una velocidad ilegible no llega como NaN');
    assert.ok(await hasta(() => audioDe(m) >= 4000), 'el saludo con el servicio en 503 salió por espeak-ng');
    const antes = audioDe(m);
    assert.ok(await turno(m));
    assert.ok(await hasta(() => audioDe(m) >= antes + 4000), 'audio vacío del servicio: habló espeak-ng');
    const antes2 = audioDe(m);
    assert.ok(await turno(m));
    assert.ok(await hasta(() => audioDe(m) >= antes2 + 4000), 'red caída: habló espeak-ng');
  } finally { ajustes.delete('voz_length_scale'); }
});

test('demo: sin servicio de voz ni espeak-ng ni sox, la llamada sigue viva (muda) y se puede colgar', async () => {
  voz.ttsFn = () => new Response('no', { status: 500 });
  process.env.PATH = SOLO_VOSK + path.delimiter + NODE_DIR;
  try {
    process.env.FALSO_VOSK_TEXTOS = '';
    const ari = asteriskFalso();
    pipe.init(ari, pool);
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE));
    assert.ok(await hasta(() => voz.tts.length > 0, 3000));
    await dormir(300);
    assert.equal(audioDe(ari.medios[0]), 0);
    assert.equal(ch.colgado, false, 'que no haya voz no corta la llamada');
    ch.emit('StasisEnd');
    assert.ok(await hasta(() => ch.colgado));
  } finally { process.env.PATH = BIN + path.delimiter + PATH_ORIG; }
});

test('demo: sin python3 (Vosk) el reconocedor no arranca, pero la API no se cae y la llamada se cuelga', async () => {
  /* spawn de un binario que no existe emite 'error' en el proceso: sin quien lo escuche,
   * Node lo tira como excepción no atrapada y se lleva puesta toda la API. */
  process.env.PATH = NODE_DIR;
  try {
    const ari = asteriskFalso();
    pipe.init(ari, pool);
    const ch = canal();
    await pipe.startAiSession(ch, Object.assign({}, AGENTE));
    const m = await hasta(() => ari.medios.at(-1), 3000);
    assert.ok(m);
    hablar(m, 20);
    await dormir(300);
    assert.equal(ch.colgado, false);
    ch.emit('StasisEnd');
    assert.ok(await hasta(() => ch.colgado));
  } finally { process.env.PATH = BIN + path.delimiter + PATH_ORIG; }
});

test('demo: si quien llama habla encima de una frase larga, la frase se corta (barge-in)', async () => {
  const LARGO = Buffer.alloc(8000 * 2 * 4, 1);   // 4 s de voz
  voz.ttsFn = (b) => new Response(/no te entendí/.test(b.text) ? LARGO : AUDIO_CORTO);
  const { ch, m } = await llamar({}, ['zzz']);
  hablar(m, 6, 0);
  assert.ok(await hasta(() => dichos().length === 2));
  await hasta(() => audioDe(m) > 4000);
  /* Medio segundo de voz fuerte mientras el agente habla. */
  for (let i = 0; i < 25; i++) { hablar(m, 1, 4000); await dormir(20); }
  await dormir(300);
  const parcial = audioDe(m);
  assert.ok(parcial < LARGO.length, 'la frase larga salió entera pese al barge-in');
  await dormir(300);
  assert.equal(audioDe(m), parcial, 'después del barge-in no sigue saliendo audio');
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
});

test('demo: quien cuelga mientras se genera la voz no recibe audio después', async () => {
  let soltar;
  voz.ttsFn = (b) => (/no te entendí/.test(b.text) ? new Promise((ok) => { soltar = () => ok(new Response(AUDIO_CORTO)); }) : new Response(AUDIO_CORTO));
  const { ch, m } = await llamar({}, ['zzz']);
  hablar(m, 6, 0);
  assert.ok(await hasta(() => soltar));
  const antes = audioDe(m);
  m.socket.write(Buffer.from([0x00, 0, 0]));   // Asterisk termina la sesión
  assert.ok(await hasta(() => ch.colgado));
  soltar();
  await dormir(150);
  assert.equal(audioDe(m), antes);
});

test('AudioSocket: tramas partidas, audio vacío y un socket que se va sin presentarse no rompen nada', async () => {
  const { ch, m } = await llamar({}, []);
  /* Una trama de audio vacía (Asterisk las manda) y otra partida en dos escrituras. */
  m.socket.write(Buffer.from([0x10, 0, 0]));
  const pcm = Buffer.alloc(320, 2);
  const trama = Buffer.concat([Buffer.from([0x10, 0x01, 0x40]), pcm]);
  m.socket.write(trama.slice(0, 100));
  await dormir(30);
  m.socket.write(trama.slice(100));
  /* Mucho audio de una: el acumulador para Whisper tiene techo. */
  m.socket.write(Buffer.concat(Array.from({ length: 1600 }, () => trama)));
  await dormir(200);
  assert.equal(ch.colgado, false);
  /* Un cliente que abre y cierra sin mandar el UUID. */
  await new Promise((ok) => { const s = net.connect({ host: '127.0.0.1', port: AS_PORT }, () => { s.end(); ok(); }); });
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
});

test('arranque: sin número de quien llama, con el CRM caído y el answer que falla, la llamada se atiende igual; VOZ_HOST arma la URL de voz', async (t) => {
  ajustes.delete('voz_url');
  process.env.VOZ_HOST = 'voz.test';
  clientesFalla = true;
  t.after(() => { ajustes.set('voz_url', VOZ); delete process.env.VOZ_HOST; clientesFalla = false; });
  const ch = canal();
  delete ch.caller;
  ch.answer = async () => { throw new Error('ya respondido'); };
  const { m } = await llamar({ name: '', greeting_text: '' }, [], ch);
  assert.ok(audioDe(m) > 0);
  assert.match(voz.tts[0].text, /Soy el asistente virtual\. ¿En qué/, 'sin nombre de agente el saludo no queda con un « de » colgando');
  ch.emit('StasisEnd');
  assert.ok(await hasta(() => ch.colgado));
  /* Con número, pero el CRM no contesta: se atiende sin identificar al portero. */
  const ch2 = canal('099111222');
  const { m: m2 } = await llamar({}, [], ch2);
  assert.ok(audioDe(m2) > 0);
  ch2.emit('StasisEnd');
  assert.ok(await hasta(() => ch2.colgado));
});

test('openai: herramientas sin argumentos o desconocidas, respuesta final vacía, y derivación con frase propia', async () => {
  ajustes.set('openai_api_key', 'sk-prueba');
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(1596, 2)]);
  const vocesPedidas = [];
  openai.tts = (b) => { vocesPedidas.push(b.voice); return new Response(wav); };
  openai.stt = () => Response.json({});   // Whisper sin texto: se usa lo de Vosk
  openai.llm = [
    { content: null, tool_calls: [{ id: 't1', function: { name: 'crm_lookup' } }] },
    { content: null, tool_calls: [{ id: 't2', function: { name: 'inventada', arguments: '{}' } }] },
    { content: '' },
    { content: 'Ya te paso con soporte.', tool_calls: [{ id: 't3', function: { name: 'transfer_call', arguments: '{"destination":"2020"}' } }] },
  ];
  try {
    const { ch, m } = await llamar({ provider: 'openai', voice: 'nova' }, ['quiero saber mi saldo', 'pasame con soporte']);
    assert.ok(vocesPedidas.includes('nova'), 'una voz de OpenAI válida se respeta');
    hablar(m, 6, 0);
    assert.ok(await hasta(() => openai.llmPedidos.length === 3));
    const tool = openai.llmPedidos[1].messages.find((x) => x.role === 'tool');
    assert.match(tool.content, /No tengo el CRM configurado/, 'crm_lookup sin consulta usa la frase de quien llama');
    assert.equal(openai.llmPedidos[2].messages.filter((x) => x.role === 'tool').at(-1).content, 'ok', 'una herramienta desconocida se contesta «ok»');
    await dormir(200);
    hablar(m, 6, 0);
    assert.ok(await hasta(() => ch.derivado, 5000), 'no derivó');
    assert.equal(ch.derivado.extension, '2020');
  } finally { ajustes.delete('openai_api_key'); }
});

test('openai: si el TTS y Whisper fallan, habla el servicio de voz y entiende con Vosk; una voz no válida usa nova', async () => {
  ajustes.set('openai_api_key', 'sk-prueba');
  const vocesPedidas = [];
  openai.tts = (b) => { vocesPedidas.push(b.voice); throw new Error('ECONNRESET'); };
  openai.stt = () => { throw new Error('ECONNRESET'); };
  openai.llm = [{ content: 'Entendido.' }];
  try {
    const { ch, m } = await llamar({ provider: 'openai', voice: 'es' }, ['hola']);
    assert.equal(vocesPedidas[0], 'nova');
    assert.match(dichos()[0], /Hola, recepción/, 'el saludo salió por el servicio de voz');
    hablar(m, 6, 0);
    assert.ok(await hasta(() => dichos().includes('Entendido.')));
    assert.equal(openai.llmPedidos[0].messages.at(-1).content, 'hola');
    ch.emit('StasisEnd');
    assert.ok(await hasta(() => ch.colgado));
  } finally { ajustes.delete('openai_api_key'); }
});

test('openai: Whisper que contesta con texto manda sobre Vosk', async () => {
  ajustes.set('openai_api_key', 'sk-prueba');
  openai.stt = () => Response.json({ text: '  quiero hablar con alguien  ' });
  openai.llm = [{ content: 'Claro.' }];
  try {
    const { ch, m } = await llamar({ provider: 'openai' }, ['ruido']);
    hablar(m, 6, 0);
    assert.ok(await hasta(() => openai.llmPedidos.length === 1));
    assert.equal(openai.llmPedidos[0].messages.at(-1).content, 'quiero hablar con alguien');
    ch.emit('StasisEnd');
    assert.ok(await hasta(() => ch.colgado));
  } finally { ajustes.delete('openai_api_key'); }
});
