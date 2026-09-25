/* ============================================================================
 *  Portería remota: quién llama y a quién se deja pasar.
 *
 *  Estas pruebas están escritas desde la vereda: alguien parado en la puerta diciendo un
 *  nombre. Cada una es una forma concreta de entrar a un edificio sin permiso, y lo que
 *  se comprueba es que NO alcanza.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../porteria');

const HOY = new Date('2026-09-25T12:00:00Z');
const PERSONAS = [
  { id: 1, name: 'Juan Carlos Pérez', doc: '1.234.567-8', relation: 'titular', valid_until: null },
  { id: 2, name: 'María Rodríguez', doc: '4.567.890-1', relation: 'hija', valid_until: null },
  { id: 3, name: 'Ana Gómez', doc: '5.555.555-5', relation: 'servicio', valid_until: '2026-09-20' },   // vencida
  { id: 4, name: 'Juan Pérez Silva', doc: '9.999.999-9', relation: 'sobrino', valid_until: null },     // homónimo
];

test('«soy Juan» no verifica a nadie', () => {
  /* Con un solo token, cualquiera que sepa un nombre común entra. */
  const r = p.verificarAutorizado(PERSONAS, { nombre: 'Juan' }, HOY);
  assert.equal(r.ok, false);
  assert.match(r.alModelo, /nombre y apellido/);
});

test('nombre y apellido alcanzan, aunque falte el segundo nombre', () => {
  /* La gente no dice sus segundos nombres: «Juan Pérez» tiene que matchear a «Juan Carlos
   * Pérez». Pero «Pérez» solo, no. */
  const r = p.verificarAutorizado([PERSONAS[0]], { nombre: 'juan perez' }, HOY);
  assert.equal(r.ok, true);
  assert.equal(r.persona.id, 1);
  assert.equal(p.verificarAutorizado([PERSONAS[0]], { nombre: 'Pérez' }, HOY).ok, false);
});

test('las tildes y las mayúsculas no deciden si alguien entra', () => {
  assert.equal(p.verificarAutorizado([PERSONAS[1]], { nombre: 'MARIA RODRIGUEZ' }, HOY).ok, true);
  assert.equal(p.verificarAutorizado([PERSONAS[1]], { nombre: 'maría rodríguez' }, HOY).ok, true);
});

test('con dos personas del mismo nombre NO se elige una: se pide documento', () => {
  /* Elegir la primera sería dejar entrar a alguien con el permiso de otro. */
  const r = p.verificarAutorizado(PERSONAS, { nombre: 'Juan Pérez' }, HOY);
  assert.equal(r.ok, false);
  assert.match(r.razon, /más de una/);
  assert.match(r.alModelo, /documento/);

  /* Y con el documento, se desempata. */
  const r2 = p.verificarAutorizado(PERSONAS, { nombre: 'Juan Pérez', documento: '9999999-9' }, HOY);
  assert.equal(r2.ok, true);
  assert.equal(r2.persona.id, 4);
});

test('una autorización vencida no deja entrar', () => {
  /* Es la razón de ser de `valid_until`: una autorización temporal que no se chequea es
   * una autorización permanente. */
  const r = p.verificarAutorizado(PERSONAS, { nombre: 'Ana Gómez' }, HOY);
  assert.equal(r.ok, false);
  assert.match(r.razon, /vencida/);

  /* El último día vale entero, no hasta la medianoche del día anterior. */
  const ese = new Date('2026-09-20T23:00:00Z');
  assert.equal(p.verificarAutorizado(PERSONAS, { nombre: 'Ana Gómez' }, ese).ok, true);
});

test('el documento manda sobre el nombre, pero tiene que existir', () => {
  const r = p.verificarAutorizado(PERSONAS, { nombre: 'Pedro Inventado', documento: '1234567-8' }, HOY);
  assert.equal(r.ok, true, 'el documento correcto tiene que alcanzar');
  assert.equal(r.persona.id, 1);
  assert.equal(p.verificarAutorizado(PERSONAS, { documento: '0000000' }, HOY).ok, false);
});

test('sin autorizados cargados no se improvisa: se deriva', () => {
  const r = p.verificarAutorizado([], { nombre: 'Juan Pérez' }, HOY);
  assert.equal(r.ok, false);
  assert.match(r.alModelo, /persona/i, 'no ofreció pasar con alguien');
});

test('el contexto que ve el modelo NO trae la lista de residentes', () => {
  /* Un modelo con la lista a mano se la lee al primero que pregunte «¿quién vive acá?». */
  const bloque = p.bloqueContexto({
    cliente: { name: 'Edificio Aramendia', address: 'Rambla 1234' },
    personas: PERSONAS,
    espacios: [{ name: '402', kind: 'apartamento' }],
  });
  for (const persona of PERSONAS) {
    assert.ok(!bloque.includes(persona.name), 'se filtró el nombre de un residente al prompt: ' + persona.name);
    if (persona.doc) assert.ok(!bloque.includes(persona.doc), 'se filtró un documento al prompt');
  }
  assert.match(bloque, /Edificio Aramendia/, 'el agente tiene que saber de dónde entra la llamada');
  assert.match(bloque, /402/);
  assert.match(bloque, /4 personas autorizadas/, 'conviene que sepa que la lista existe, sin verla');
  assert.match(bloque, /Nunca digas nombres/);
});

/* ── El candado del portón, ahora con el CRM de verdad detrás ───────────────── */
const h = require('../herramientas');

test('sólo una verificación BUENA contra el CRM habilita abrir', async () => {
  h._resetTopes();
  const personas = [{ id: 1, name: 'Juan Carlos Pérez', doc: '1234567', relation: 'titular', valid_until: null }];
  let abrio = false;
  const ctx = {
    cfg: { verificar_autorizado: { on: true }, abrir_porton: { on: true, exigir_verificacion: true } },
    agenteId: 7, ahora: HOY, hhmm: '12:00', sesion: { verificada: false },
    verificarPersona: async (d) => p.verificarAutorizado(personas, d, HOY),
    abrir: async () => { abrio = true; return { ok: true, detalle: 'DTMF #' }; },
    auditar: () => {}, log: () => {},
  };

  /* Un nombre que no está: ni verifica ni abre. */
  assert.equal((await h.ejecutar('verificar_autorizado', { nombre: 'Pedro Falso' }, ctx)).ok, false);
  assert.equal((await h.ejecutar('abrir_porton', { motivo: 'dice ser Pedro' }, ctx)).ok, false);
  assert.equal(abrio, false, 'abrió la puerta a alguien que el CRM no reconoce');

  /* El nombre correcto: verifica, y recién entonces abre. */
  const v = await h.ejecutar('verificar_autorizado', { nombre: 'Juan Pérez' }, ctx);
  assert.equal(v.ok, true);
  assert.equal(ctx.sesion.verificada, true);
  assert.equal((await h.ejecutar('abrir_porton', { motivo: 'visita autorizada' }, ctx)).ok, true);
  assert.equal(abrio, true);
});

test('la respuesta de la verificación no le pasa datos de más al modelo', async () => {
  const personas = [{ id: 1, name: 'Juan Carlos Pérez', doc: '1234567', relation: 'titular', valid_until: null }];
  const ctx = {
    cfg: { verificar_autorizado: { on: true } }, agenteId: 1, ahora: HOY, sesion: {},
    verificarPersona: async (d) => p.verificarAutorizado(personas, d, HOY),
    auditar: () => {}, log: () => {},
  };
  const r = await h.ejecutar('verificar_autorizado', { nombre: 'Juan Pérez' }, ctx);
  const texto = JSON.stringify(r);
  /* Lo que vuelve se puede leer en voz alta: que confirme, sin recitar la ficha. */
  assert.doesNotMatch(texto, /1234567/, 'le devolvió el documento del residente al modelo');
  assert.doesNotMatch(texto, /Juan Carlos/, 'le devolvió el nombre completo de la ficha');
  assert.match(texto, /autorizado/);
});
