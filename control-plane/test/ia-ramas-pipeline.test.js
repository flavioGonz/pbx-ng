/* ============================================================================
 *  Pipeline de IA (ai-pipeline.js): el cierre, el barrido y el arranque cuando algo
 *  de afuera falla.
 *
 *  ai-pipeline.test.js recorre llamadas enteras que salen bien. Acá se fija lo que pasa
 *  cuando lo de alrededor se rompe a mitad de camino, que es justo lo que deja canales
 *  zombis o llamadas mudas si nadie lo mira:
 *
 *   · el puerto de AudioSocket ocupado (se anota y el siguiente `init` lo vuelve a abrir);
 *   · la base que no lista agentes al armar la IA externa (se avisa, no tira la API);
 *   · colgar el canal de medios, destruir el puente, matar Vosk o cortar el socket que
 *     fallan al cerrar o transferir: se sigue con lo demás, y los errores de ARI quedan
 *     escritos (un hangup que falla callado es cómo se juntaron los zombis);
 *   · el barrido de huérfanos con canales a medio armar, sin fecha, con dueños vivos o
 *     pendientes, y sesiones pasadas del tope de duración;
 *   · el respaldo de la IA externa cuando ni siquiera se puede derivar.
 *
 *  Todo con un ARI y una base de mentira; el log se captura para ver que se anotó.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { hasta, puertoLibre, canal } = require('./helpers/llamada-ia');

let pipe, AS_PORT;
const ajustes = new Map();
const estado = { agentesFalla: false, agentes: [], configs: new Map() };
const pool = {
  async query(sql, args) {
    if (/SELECT value FROM pbxng_settings WHERE key=\$1/.test(sql)) return { rows: ajustes.has(args[0]) ? [{ value: ajustes.get(args[0]) }] : [] };
    if (/FROM pbxng_ai_agents/.test(sql)) { if (estado.agentesFalla) throw new Error('base caída'); return { rows: estado.agentes }; }
    if (/FROM pbxng_ia_externa_config/.test(sql)) return { rows: estado.configs.has(args[0]) ? [estado.configs.get(args[0])] : [] };
    if (/INSERT INTO pbxng_ia_externa_config/.test(sql)) { estado.guardada = args; return { rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  },
};

/* Lo que escribe el log (JSON por línea) se junta; lo demás sigue de largo. */
function capturarLog(t) {
  const lineas = [];
  for (const s of [process.stdout, process.stderr]) {
    const orig = s.write.bind(s);
    t.mock.method(s, 'write', (chunk, ...resto) => {
      const txt = String(chunk);
      if (txt.startsWith('{"ts"')) { try { lineas.push(JSON.parse(txt)); return true; } catch (_) {} }
      return orig(chunk, ...resto);
    });
  }
  return lineas;
}
const hay = (lineas, re) => lineas.some((l) => re.test(l.msg + ' ' + JSON.stringify(l)));

test.before(async () => {
  AS_PORT = await puertoLibre();
  process.env.AUDIOSOCKET_PORT = String(AS_PORT);
  process.env.AI_MAX_SESION_MS = '1000';
  pipe = require('../ai-pipeline');
});
test.after(async () => { try { await pipe.close(); } catch (_) {} });

function ariFalso(extra = {}) {
  const a = { colgados: [], channels: { hangup: async ({ channelId }) => { a.colgados.push(channelId); }, list: async () => [] } };
  Object.assign(a.channels, extra);
  return a;
}

test('init: el puerto ocupado se anota y el próximo init lo abre; la base caída no tira la IA externa', async (t) => {
  const lineas = capturarLog(t);
  const ocupa = net.createServer();
  await new Promise((ok) => ocupa.listen(AS_PORT, '0.0.0.0', ok));
  estado.agentesFalla = true;
  pipe.init(ariFalso(), pool);
  assert.ok(await hasta(() => hay(lineas, /AudioSocket/) && lineas.some((l) => l.level === 'error')), 'el puerto ocupado no se anotó');
  assert.ok(await hasta(() => hay(lineas, /no se pudieron abrir los canales.*base caída/)), 'la base caída no se avisó');
  pipe.recargarIaExterna();
  assert.ok(await hasta(() => hay(lineas, /no se pudieron recargar los canales/)));
  estado.agentesFalla = false;
  await new Promise((ok) => ocupa.close(ok));
  /* Con el puerto libre, el init siguiente (una reconexión de ARI) abre el servidor. */
  pipe.init(ariFalso(), pool);
  const conecta = await hasta(() => new Promise((ok) => {
    const s = net.connect({ host: '127.0.0.1', port: AS_PORT }, () => { s.destroy(); ok(true); });
    s.on('error', () => ok(false));
  }));
  assert.equal(conecta, true, 'el servidor de AudioSocket no se volvió a abrir');
});

test('IA externa: la configuración guardada se lee de la base, y la bajada se guarda', async (t) => {
  t.mock.method(globalThis, 'fetch', async (u) => {
    assert.match(String(u), /\/api\/pbx\/session-config$/);
    return Response.json({ version: 'v9', session: { model: 'gpt-live-1' }, attachTimeoutMs: 2000 });
  });
  estado.configs.set(31, { version: 'v1', session: { model: 'gpt-live-1' }, attach_timeout_ms: 3000, resume_window_ms: 0 });
  estado.agentes = [
    { id: 31, provider: 'ia-externa', enabled: true, externo_url: 'http://127.0.0.1:1', externo_token: 't' },
  ];
  pipe.recargarIaExterna();
  /* Un agente nuevo en el mismo backend: baja su configuración y la guarda. */
  await new Promise((ok) => setTimeout(ok, 50));
  estado.agentes.push({ id: 32, provider: 'ia-externa', enabled: true, externo_url: 'http://127.0.0.1:1', externo_token: 't' });
  pipe.recargarIaExterna();
  assert.ok(await hasta(() => estado.guardada), 'la configuración bajada no se guardó');
  assert.deepEqual(estado.guardada.slice(0, 2), [32, 'v9']);
  assert.equal(estado.guardada[4], 20000, 'sin ventana del backend se guarda la de por defecto');
  /* Se apagan los canales: sin agentes no queda ninguno reconectando. */
  estado.agentes = [];
  pipe.recargarIaExterna();
  await new Promise((ok) => setTimeout(ok, 30));
});

test('IA externa: con la configuración, la llamada que no se puede mandar al respaldo se anota', async (t) => {
  const lineas = capturarLog(t);
  ajustes.set('openai_api_key', 'sk-x');
  try {
    /* Con clave pero sin la IA externa inicializada (la API todavía está arrancando), la
     * llamada va al respaldo sin abrir sesión, y dice por qué. */
    pipe._setIax(null);
    const ch = canal();
    ch.falloDerivar = true;
    await pipe.startAiSession(ch, { id: 31, provider: 'ia-externa', default_exten: '2030' });
    assert.ok(hay(lineas, /va al respaldo sin abrir sesión/));
    assert.ok(lineas.some((l) => l.motivo === 'la IA externa no está inicializada'));
    assert.ok(hay(lineas, /no se pudo mandar al respaldo/), 'la derivación fallida al respaldo no quedó escrita');
  } finally {
    ajustes.delete('openai_api_key');
    pipe.init(ariFalso(), pool);   // vuelve a armar la IA externa
  }
});

test('doTransfer: suelta todo aunque cada pieza falle, y sin etiqueta no rompe el log', async () => {
  const logs = [];
  pipe._setAri(ariFalso({ hangup: () => { throw new Error('ARI caído'); } }));
  const s = {
    uuid: 'u-transfer', channel: canal(), log: (m) => logs.push(m), agent: {},
    endpointTimer: setInterval(() => {}, 1000), rtReloj: setInterval(() => {}, 1000),
    rt: { cerrar() { throw new Error('ya cerrado'); } },
    sttProc: { kill() { throw new Error('ya muerto'); } },
    em: { id: 'em-1' },
    bridge: { destroy: () => Promise.reject(new Error('sin puente')) },
    socket: { destroy() { throw new Error('ya destruido'); } },
  };
  assert.equal(await pipe._doTransfer(s, '2001'), true);
  assert.deepEqual(s.channel.derivado, { context: 'internal', extension: '2001', priority: 1 });
  assert.ok(logs.includes('TRANSFER -> 2001 ()'));
  assert.equal(s.closed, true);
  /* El hangup del canal de medios que rechaza (en vez de tirar) tampoco frena nada. */
  pipe._setAri(ariFalso({ hangup: () => Promise.reject(new Error('404')) }));
  const s2 = { uuid: 'u-t2', channel: canal(), log: () => {}, agent: {}, em: { id: 'em-2' }, bridge: { destroy: async () => {} } };
  assert.equal(await pipe._doTransfer(s2, '2002', 'Ventas'), true);
});

test('cierre por tope de duración: cada falla al soltar queda escrita y no frena el resto', async () => {
  const logs1 = [], logs2 = [];
  const ari = ariFalso({ hangup: async () => { throw new Error('500 boom'); } });
  pipe._setAri(ari);
  const ses = pipe._sesiones();
  const ch1 = canal(); ch1.falloColgar = '500 interno';
  const relay = { mandar: () => false, terminado: false, avisoMandado: false, cerrar() { throw new Error('x'); } };
  const s1 = {
    uuid: 's1', channel: ch1, agent: {}, nacida: Date.now() - 5000, log: (m) => logs1.push(m), modo: 'externo', relay,
    alDtmf: () => {}, vigilante: { cerrar() { throw new Error('x'); } },
    socket: { destroy() { throw new Error('x'); } },
    rtReloj: setInterval(() => {}, 1000), rt: { cerrar() { throw new Error('x'); } },
    sttProc: { kill() { throw new Error('x'); } }, em: { id: 'em-s1' },
    bridge: { destroy: () => Promise.reject(new Error('puente trabado')) },
    endpointTimer: setInterval(() => {}, 1000),
  };
  ch1.removeListener = () => { throw new Error('x'); };
  /* El segundo: ARI y el puente tiran en el acto, y el canal rechaza sin motivo. */
  const ch2 = canal();
  ch2.hangup = () => Promise.reject(undefined);
  const s2 = {
    uuid: 's2', channel: ch2, agent: {}, nacida: Date.now() - 5000, log: (m) => logs2.push(m),
    em: { id: 'em-s2' }, bridge: { destroy() { throw new Error('destrucción imposible'); } },
  };
  /* Y los que el barrido no toca: uno ya cerrado y uno sin fecha de nacimiento. */
  const s3 = { uuid: 's3', closed: true, nacida: 1, log: () => { throw new Error('no debería'); } };
  const s4 = { uuid: 's4', log: () => { throw new Error('no debería'); } };
  for (const s of [s1, s2, s3, s4]) ses.set(s.uuid, s);
  try {
    await pipe._barrer();
    assert.ok(await hasta(() => logs1.some((l) => /no se pudo destruir el bridge: puente trabado/.test(l))));
    assert.ok(await hasta(() => logs1.some((l) => /no se pudo colgar el canal de medios: 500 boom/.test(l))));
    assert.ok(await hasta(() => logs1.some((l) => /no se pudo colgar el canal del llamante: 500 interno/.test(l))));
    assert.ok(logs1.includes('END (tope-duracion)'));
    assert.ok(await hasta(() => logs2.some((l) => /no se pudo destruir el bridge: destrucción imposible/.test(l))));
    assert.ok(await hasta(() => logs2.some((l) => /no se pudo colgar el canal de medios: 500 boom/.test(l))));
    assert.ok(await hasta(() => logs2.some((l) => /no se pudo colgar el canal del llamante: undefined/.test(l))));
    assert.equal(ses.has('s1'), false);
    assert.equal(ses.has('s2'), false);
    assert.equal(ses.has('s3'), true, 'una sesión ya cerrada no se vuelve a cortar');
    assert.equal(ses.has('s4'), true);
  } finally { ses.delete('s3'); ses.delete('s4'); }
});

test('cierre: con ARI que tira en el acto al colgar el canal de medios, se anota igual', async () => {
  const logs = [];
  pipe._setAri(ariFalso({ hangup: () => { throw new Error('sin conexión'); } }));
  const ses = pipe._sesiones();
  const ch = canal(); ch.falloColgar = 'Channel not found';
  const s = { uuid: 's5', channel: ch, agent: {}, nacida: Date.now() - 5000, log: (m) => logs.push(m), em: { id: 'em-s5' },
    socket: { destroy() {}, end() { throw new Error('x'); } } };
  ses.set('s5', s);
  await pipe._barrer();
  assert.ok(await hasta(() => !ses.has('s5')));
  assert.ok(logs.some((l) => /no se pudo colgar el canal de medios: sin conexión/.test(l)));
  assert.ok(!logs.some((l) => /canal del llamante/.test(l)), 'un «not found» es el llamante que ya colgó: no se anota');
});

test('barrido: sin ARI no hace nada; si listar falla se anota; sin fecha y sin dialplan se decide igual', async (t) => {
  const lineas = capturarLog(t);
  pipe._setAri(null);
  await pipe._barrer();
  pipe._setAri(ariFalso({ list: async () => { throw new Error('ARI caído'); } }));
  await pipe._barrer();
  assert.ok(hay(lineas, /barrido de canales.*ARI caído/));
  const uuidVivo = '11111111-2222-3333-4444-555555555555';
  const ses = pipe._sesiones();
  ses.set(uuidVivo, { uuid: uuidVivo, channel: { id: 'otro' }, log: () => {} });
  const colgados = [];
  pipe._setAri(ariFalso({
    list: async () => [
      { id: 'sin-dialplan' },
      { id: 'ia-sin-fecha', name: 'PJSIP/1-1', dialplan: { app_data: 'pbxng,ai' } },
      { id: 'medios-vivo', name: 'AudioSocket/x', dialplan: { app_data: 'pbxng,' + uuidVivo } },
      { id: 'medios-huerfano', name: 'AudioSocket/y', creationtime: 'no es fecha', dialplan: { app_data: 'pbxng,99999999-2222-3333-4444-555555555555' } },
    ],
    hangup: async ({ channelId }) => { colgados.push(channelId); throw new Error('ya no existe'); },
  }));
  try { await pipe._barrer(); } finally { ses.delete(uuidVivo); }
  assert.deepEqual(colgados, ['ia-sin-fecha', 'medios-huerfano'], 'los canales sin fecha se tratan como viejos; el de una sesión viva no se toca');
  assert.ok(hay(lineas, /no se pudo colgar la llamada huérfana/));
  assert.ok(hay(lineas, /no se pudo colgar el canal huérfano/));
});

test('barrido: no cuelga la llamada de una sesión que todavía está armando su canal de medios', async (t) => {
  const lineas = capturarLog(t);
  let soltar;
  const colgados = [];
  const ch = canal();
  const ari = {
    Bridge: () => ({ async create() {}, async addChannel() {}, async destroy() {} }),
    channels: {
      externalMedia: () => new Promise((_ok, mal) => { soltar = mal; }),
      hangup: async ({ channelId }) => { colgados.push(channelId); },
      list: async () => [{ id: ch.id, name: 'PJSIP/2-2', dialplan: { app_data: 'pbxng,ai,7' } }],
    },
  };
  pipe._setAri(ari);
  const arranque = pipe.startAiSession(ch, { id: 7, name: 'Portero', provider: 'demo' });
  assert.ok(await hasta(() => soltar), 'no llegó a pedir el canal de medios');
  await pipe._barrer();
  assert.deepEqual(colgados, [], 'la sesión pendiente es dueña del canal');
  soltar(new Error('externalMedia falló'));
  await arranque;
  assert.equal(ch.colgado, true);
  assert.ok(hay(lineas, /startAiSession.*externalMedia falló/));
});

test('metricas(): una sesión sin agente, sin modo y sin modelo se informa con valores vacíos', () => {
  const ses = pipe._sesiones();
  ses.set('m1', { uuid: 'aaaaaaaa-1', log: () => {} });
  ses.set('m2', { uuid: 'bbbbbbbb-2', agent: { name: 'Portero' }, modo: 'realtime', callerId: '099', rt: { metricas: () => ({ turnos: 2 }) }, rtCola: [1, 2, 3], log: () => {} });
  try {
    const m = pipe.metricas();
    assert.deepEqual(m.find((x) => x.sesion === 'aaaaaaaa'), { sesion: 'aaaaaaaa', agente: '', modo: 'demo', llamante: '', latencia: null, en_cola: 0 });
    assert.deepEqual(m.find((x) => x.sesion === 'bbbbbbbb'), { sesion: 'bbbbbbbb', agente: 'Portero', modo: 'realtime', llamante: '099', latencia: { turnos: 2 }, en_cola: 3 });
  } finally { ses.delete('m1'); ses.delete('m2'); }
});

test('crmLookup: lo que conteste el CRM se lee en el orden result → text → message, y un cuerpo roto no se lee', async (t) => {
  const s = { agent: { crm_webhook: 'http://crm/x', name: 'P' }, callerId: '099' };
  let cuerpo;
  t.mock.method(globalThis, 'fetch', async () => (cuerpo === null ? new Response('no es json') : Response.json(cuerpo)));
  cuerpo = { text: 'por texto' };
  assert.equal(await pipe._crmLookup('q', s), 'por texto');
  cuerpo = { message: 'por mensaje' };
  assert.equal(await pipe._crmLookup('q', s), 'por mensaje');
  cuerpo = null;
  assert.equal(await pipe._crmLookup('q', s), 'No encontré datos para esa consulta.');
  globalThis.fetch.mock.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(await pipe._crmLookup('q', s), 'No pude consultar el CRM en este momento.');
});

test('respaldo de la IA externa: con la llamada cerrada no hace nada; sin destino corta', async () => {
  pipe._setAri(ariFalso());
  const cerrada = { closed: true, log: () => { throw new Error('no debería'); } };
  await pipe._respaldoExterno(cerrada, 'x');
  const logs = [];
  const ch = canal();
  const s = { uuid: 'r1', channel: ch, agent: null, log: (m) => logs.push(m) };
  await pipe._respaldoExterno(s, 'el backend no confirmó a tiempo');
  assert.equal(ch.colgado, true);
  assert.ok(logs.includes('END (sin respaldo configurado)'));
  assert.equal(ch.derivado, null);
});

test('quién atendió: sin canal no se anota nada; un DialEnd o un Hangup sin datos no rompen', async () => {
  pipe.alAtender(undefined, undefined, '2001');
  pipe.alColgar(undefined);
  /* Una transferencia ordenada por el backend sobre una sesión sin canal no se puede seguir. */
  const ordenes = pipe._ordenesExternas({
    uuid: 'x1', agent: { default_exten: '2030' }, channel: { continueInDialplan: async () => {}, setChannelVar: async () => {} },
    log: () => {}, relay: null,
  });
  await ordenes.transferir('2030');
  assert.equal(pipe._atenciones().size, 0, 'sin id de canal no hay a quién atribuirle la atención');
});
