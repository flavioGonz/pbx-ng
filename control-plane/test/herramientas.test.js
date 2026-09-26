/* ============================================================================
 *  Las herramientas del agente, y sobre todo sus CANDADOS.
 *
 *  Qué se está cuidando acá: que la puerta de un edificio no se abra por lo que dijo una
 *  voz por teléfono. El resto de las pruebas de este repo protegen llamadas; estas
 *  protegen un portón, así que son las que hay que leer con más desconfianza.
 *
 *  La regla que las ordena: el modelo PIDE, la central DECIDE. Cada prueba de acá abajo
 *  es una forma distinta de comprobar que la decisión no depende de lo que diga el modelo.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../herramientas');

const base = (extra = {}) => Object.assign({
  agenteId: 1,
  ahora: new Date('2026-09-25T15:00:00Z'),
  hhmm: '12:00',
  sesion: { verificada: false },
  leerCrm: async () => ({ ok: true, texto: 'Unidad 402 · titular Pérez' }),
  transferir: async () => {},
  mensaje: async () => {},
  terminar: async () => {},
  abrir: async () => ({ ok: true, detalle: 'DTMF #' }),
  log: () => {},
}, extra);
const TODO_ON = {
  verificar_unidad: { on: true }, consultar_datos: { on: true }, transferir_a_agente: { on: true },
  tomar_mensaje: { on: true }, terminar_llamada: { on: true }, abrir_porton: { on: true },
};

test.beforeEach(() => h._resetTopes());

test('sólo se le declaran al modelo las herramientas encendidas', () => {
  const d = h.declarar({ verificar_unidad: { on: true }, abrir_porton: { on: false } });
  assert.equal(d.length, 1);
  assert.equal(d[0].name, 'verificar_unidad');
  /* La descripción es lo ÚNICO que el modelo usa para decidir cuándo pedirla: una vaga es
   * una herramienta que se dispara cuando no corresponde. */
  assert.ok(d[0].description.length > 60, 'la descripción es demasiado corta para guiar al modelo');
  assert.ok(d[0].parameters.required.includes('unidad'));
});

test('una herramienta apagada se contesta, no se ejecuta', async () => {
  let abrio = false;
  const r = await h.ejecutar('abrir_porton', { motivo: 'x' }, base({ cfg: { abrir_porton: { on: false } }, abrir: async () => { abrio = true; return { ok: true }; } }));
  assert.equal(r.ok, false);
  assert.equal(abrio, false, 'ejecutó una herramienta apagada');
  assert.doesNotMatch(String(r.motivo), /error|exception/i, 'al modelo se le contesta en cristiano, no con un error técnico');
});

test('una herramienta inventada por el modelo no rompe nada', async () => {
  const r = await h.ejecutar('abrir_la_caja_fuerte', {}, base({ cfg: TODO_ON }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no existe/);
});

/* ── El portón ─────────────────────────────────────────────────────────────── */
test('sin verificación previa NO se abre, por más que el modelo insista', async () => {
  let abrio = false;
  const ctx = base({ cfg: TODO_ON, abrir: async () => { abrio = true; return { ok: true }; } });
  const r = await h.ejecutar('abrir_porton', { motivo: 'dice que es de la 402' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(abrio, false, 'abrió la puerta con lo que alguien dijo por teléfono');
  assert.match(r.motivo, /confirmar|persona/i, 'no le dio al modelo una salida sensata');
});

test('la bandera de «verificada» la escribe la central, no el modelo', async () => {
  const ctx = base({ cfg: TODO_ON });
  /* El modelo no puede mandar `verificada: true` en los argumentos y saltearse el candado. */
  const r1 = await h.ejecutar('abrir_porton', { motivo: 'x', verificada: true, ok: true }, ctx);
  assert.equal(r1.ok, false, 'un argumento del modelo alcanzó para abrir la puerta');

  /* Y una verificación que FALLA tampoco habilita. */
  const malo = base({ cfg: TODO_ON, leerCrm: async () => ({ ok: false, motivo: 'no existe' }) });
  await h.ejecutar('verificar_unidad', { unidad: '999' }, malo);
  assert.equal(malo.sesion.verificada, false, 'una verificación fallida dejó la sesión como verificada');
  assert.equal((await h.ejecutar('abrir_porton', { motivo: 'x' }, malo)).ok, false);

  /* Con la verificación buena, sí. */
  await h.ejecutar('verificar_unidad', { unidad: '402' }, ctx);
  assert.equal(ctx.sesion.verificada, true);
  assert.equal((await h.ejecutar('abrir_porton', { motivo: 'visita de la 402' }, ctx)).ok, true);
});

test('fuera de la ventana horaria no se abre', async () => {
  const ctx = base({ cfg: { abrir_porton: { on: true, exigir_verificacion: false, ventana: '07:00-22:00' } }, hhmm: '03:20' });
  assert.equal((await h.ejecutar('abrir_porton', { motivo: 'x' }, ctx)).ok, false);
  ctx.hhmm = '10:00';
  assert.equal((await h.ejecutar('abrir_porton', { motivo: 'x' }, ctx)).ok, true);
});

test('una ventana que cruza la medianoche se entiende bien', () => {
  /* Portería nocturna: 22:00 a 06:00. Con una comparación ingenua, esta ventana no deja
   * pasar NADA, y el portón queda muerto justo en el turno que más lo usa. */
  assert.equal(h.enVentana('22:00-06:00', '23:30'), true);
  assert.equal(h.enVentana('22:00-06:00', '03:00'), true);
  assert.equal(h.enVentana('22:00-06:00', '12:00'), false);
  assert.equal(h.enVentana('07:00-22:00', '07:00'), true);
  assert.equal(h.enVentana('cualquier cosa', '12:00'), true, 'una ventana mal escrita no puede dejar el portón bloqueado');
});

test('el tope por hora frena una ráfaga', async () => {
  /* El modo en que esto sale mal no es «se abre una vez de más»: es una ráfaga a las tres
   * de la mañana que nadie mira hasta el lunes. */
  const ctx = base({ cfg: { abrir_porton: { on: true, exigir_verificacion: false, max_por_hora: 2 } } });
  assert.equal((await h.ejecutar('abrir_porton', { motivo: '1' }, ctx)).ok, true);
  assert.equal((await h.ejecutar('abrir_porton', { motivo: '2' }, ctx)).ok, true);
  assert.equal((await h.ejecutar('abrir_porton', { motivo: '3' }, ctx)).ok, false, 'tercera apertura en la misma hora');

  /* Una hora después, otra vez disponible. */
  ctx.ahora = new Date('2026-09-25T16:30:00Z');
  assert.equal((await h.ejecutar('abrir_porton', { motivo: '4' }, ctx)).ok, true);
});

test('si el comando de apertura falla, NO se cuenta como abierta', async () => {
  const ctx = base({ cfg: { abrir_porton: { on: true, exigir_verificacion: false, max_por_hora: 1 } }, abrir: async () => ({ ok: false, detalle: 'el relé no responde' }) });
  assert.equal((await h.ejecutar('abrir_porton', { motivo: '1' }, ctx)).ok, false);
  /* Si contara igual, un relé roto gastaría el cupo y bloquearía las aperturas buenas. */
  ctx.abrir = async () => ({ ok: true });
  assert.equal((await h.ejecutar('abrir_porton', { motivo: '2' }, ctx)).ok, true);
});

test('TODO intento de apertura queda auditado, se abra o no', async () => {
  const filas = [];
  const ctx = base({ cfg: { abrir_porton: { on: true, exigir_verificacion: true } }, auditar: (r) => filas.push(r) });
  await h.ejecutar('abrir_porton', { motivo: 'sin verificar' }, ctx);       // rechazada
  ctx.sesion.verificada = true;
  await h.ejecutar('abrir_porton', { motivo: 'visita 402' }, ctx);          // abierta
  assert.equal(filas.length, 2, 'un intento de apertura no quedó registrado');
  assert.equal(filas[0].resultado, 'rechazada');
  assert.match(filas[0].razon, /verificación/i, 'el registro no dice POR QUÉ se rechazó');
  assert.equal(filas[1].resultado, 'ABIERTO');
  assert.match(filas[1].motivo, /402/);
});

test('un error de la herramienta no le llega al modelo como detalle técnico', async () => {
  /* Lo que se le devuelve al modelo lo puede leer EN VOZ ALTA. «ECONNREFUSED 10.0.0.5:8080»
   * en la voz de la portería es una fuga de infraestructura al visitante. */
  const ctx = base({ cfg: TODO_ON, abrir: async () => { throw new Error('ECONNREFUSED 10.0.0.5:8080'); }, sesion: { verificada: true } });
  const r = await h.ejecutar('abrir_porton', { motivo: 'x' }, ctx);
  assert.equal(r.ok, false);
  assert.doesNotMatch(JSON.stringify(r), /ECONNREFUSED|10\.0\.0\.5/, 'se filtró el detalle técnico al modelo');
});

test('una consulta lenta no deja la conversación colgada', async () => {
  const ctx = base({ cfg: TODO_ON, leerCrm: () => new Promise(() => {}) });   // no resuelve nunca
  const t0 = Date.now();
  const r = await h.ejecutar('consultar_datos', { consulta: '¿a qué hora cierra?' }, ctx);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < h.TOPE_LECTURA_MS + 500, 'la herramienta se colgó esperando al CRM');
});

test('las que actúan quedan auditadas también', async () => {
  const filas = [];
  const ctx = base({ cfg: TODO_ON, auditar: (r) => filas.push(r) });
  await h.ejecutar('transferir_a_agente', { motivo: 'pide una persona' }, ctx);
  await h.ejecutar('tomar_mensaje', { mensaje: 'que lo llame el 2 de la 402' }, ctx);
  await h.ejecutar('terminar_llamada', { motivo: 'pidió cortar' }, ctx);
  assert.deepEqual(filas.map((f) => f.herramienta), ['transferir_a_agente', 'tomar_mensaje', 'terminar_llamada']);
});

test('los argumentos del modelo se recortan: son dato no confiable', async () => {
  let guardado = null;
  const ctx = base({ cfg: TODO_ON, mensaje: async (d) => { guardado = d; } });
  await h.ejecutar('tomar_mensaje', { mensaje: 'x'.repeat(9000), unidad: 'y'.repeat(500) }, ctx);
  assert.ok(guardado.mensaje.length <= 2000, 'un mensaje de 9000 caracteres entró tal cual a la base');
  assert.ok(guardado.unidad.length <= 40);
  assert.equal((await h.ejecutar('tomar_mensaje', { mensaje: '   ' }, ctx)).ok, false, 'guardó un mensaje vacío');
});

/* ── Lo que puede y lo que no ─────────────────────────────────────────────────
 * Esta prueba existe por una llamada real: con CERO herramientas encendidas, el agente
 * contestó «listo, ya le avisé a Tathiana, tome asiento». No avisó a nadie. Tampoco tenía
 * cómo saberlo: nadie le había dicho qué puede hacer. En una portería, improvisar así
 * significa mandar a alguien a sentarse a esperar a una persona que nunca se enteró. */
test('sin herramientas, se le dice explícitamente que no puede hacer NADA', () => {
  const t = h.resumenCapacidades({});
  assert.match(t, /NO tenés ninguna herramienta/);
  assert.match(t, /no podés ejecutar ninguna acción/i);
  assert.match(t, /nunca digas que hiciste algo que no hiciste/i,
    'falta la regla que evita el «ya le avisé»');
  assert.match(t, /ya le avisé/, 'conviene nombrar la frase exacta: es la que salió en la llamada real');
  assert.match(t, /ofrecé pasar con una persona/, 'sin salida, el modelo igual improvisa');
});

test('el resumen se arma solo desde lo encendido, y nombra lo que NO puede', () => {
  const t = h.resumenCapacidades({ verificar_autorizado: { on: true }, transferir_a_agente: { on: true } });
  assert.match(t, /verificar a un autorizado/i);
  assert.match(t, /transferir a una persona/i);
  /* Y lo apagado se nombra como lo que es: una acción que no puede hacer. */
  assert.match(t, /no podés:/i);
  assert.match(t, /abrir la puerta/i, 'con el portón apagado tiene que decir que no puede abrir');
  assert.doesNotMatch(t.split('NO podés:')[1] || '', /pasar la llamada con una persona/,
    'dijo que no puede transferir cuando la herramienta está encendida');
});

test('una acción sólo cuenta si la herramienta devolvió bien', () => {
  const t = h.resumenCapacidades({ tomar_mensaje: { on: true } });
  assert.match(t, /sólo está hecha si LLAMASTE a la herramienta/i);
});
