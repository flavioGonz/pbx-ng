/* Salas heredadas (las que ya existían antes de 1.10.0) con mocks: sin Postgres y sin
 * Asterisk. Se corren con `npm test` (node --test) desde control-plane/.
 *
 * La migración 0014 NO le pone un PIN al azar a una sala que ya andaba sin PIN: eso sería
 * que la base diga una cosa y el dialplan otra, y que el admin vea en el panel un PIN que
 * no rige. Lo que sí se hace es republicar el dialplan al arrancar, para que las funciones
 * nuevas les apliquen sin entrar a editarlas una por una. Esto verifica las dos mitades:
 *   1) una sala sin PIN genera un dialplan que NO pide PIN (si lo pidiera, quedaría
 *      inaccesible: el PIN vacío se rechaza antes de comparar);
 *   2) sin PIN de moderador no se pone `wait_marked` — nadie podría entrar como `marked`
 *      y la reunión entera se quedaría escuchando música para siempre;
 *   3) republicarDialplan() reescribe la sala vieja y deja en paz a la que ya está al día. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const CAMPOS_SALA = {
  id: 1, name: 'recepcion', label: 'Recepción', access_exten: '9100', pin: null, pin_mod: null,
  max_part: 0, moh_hasta_moderador: true, anunciar: true, grabar: false,
  agenda_inicio: null, agenda_min: null, aviso_cerrada: 'conf-locked', invitados: [], invitado_at: null, tenant_id: 1,
};

/* salas.js con dependencias falsas. `salas` son las filas de pbxng_conferences y
 * `dialplan` es la tabla `extensions` (context 'ivr') tal como está ANTES de republicar. */
function armar(salas, dialplan) {
  const cont = { escrito: {}, borrado: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (s.includes('FROM pbxng_conferences')) return { rows: salas };
      if (s.includes('FROM extensions')) return { rows: (dialplan || {})[params[0]] || [] };
      return { rows: [] };
    },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
  const setDialplan = async (_c, context, exten, rows) => { cont.escrito[context + ':' + exten] = rows; };
  const app = { get() {}, post() {}, put() {}, delete() {} };
  const logger = () => ({ debug() {}, info() {}, warn() {}, error() {} });
  const salasMod = require('../salas')({
    app, pool, amiAction: async () => ({}), setDialplan, smtpHint: (e) => String(e),
    errorHttp() {}, broadcastSoon() {}, logger,
  });
  return { salasMod, cont };
}

const apps = (rows) => rows.map((r) => r[1]);

test('sala heredada sin PIN: el dialplan no pide PIN ni espera a un moderador que no existe', () => {
  const { salasMod } = armar([CAMPOS_SALA]);
  const rows = salasMod.salaDialplan(CAMPOS_SALA);
  const lista = apps(rows);
  assert.ok(!lista.includes('Read'), 'una sala sin PIN no puede pedir un PIN que no tiene');
  assert.ok(!lista.includes('Playback') || !rows.some((r) => r[2] === 'conf-invalidpin'));
  assert.ok(rows.some((r) => r[1] === 'Goto'), 'se entra derecho como participante');
  assert.ok(!rows.some((r) => String(r[2]).includes('wait_marked')),
    'sin PIN de moderador nadie puede entrar como marked: wait_marked dejaría a todos en música para siempre');
  assert.ok(!rows.some((r) => String(r[2]).includes('CONFBRIDGE(user,admin)')),
    'no se publica un bloque de moderador al que no se puede llegar');
  assert.ok(rows.some((r) => r[1] === 'ConfBridge' && r[2] === 'recepcion'));
});

test('sala con los dos PIN: sigue pidiendo PIN y manteniendo el bloque de moderador', () => {
  const sala = { ...CAMPOS_SALA, pin: '1234', pin_mod: '5678' };
  const { salasMod } = armar([sala]);
  const rows = salasMod.salaDialplan(sala);
  assert.ok(rows.some((r) => r[1] === 'Read'));
  assert.ok(rows.some((r) => String(r[2]).includes('DB(salamod/recepcion)')));
  assert.ok(rows.some((r) => String(r[2]).includes('wait_marked')));
  // El PIN nunca queda escrito en el dialplan: se compara contra la AstDB.
  assert.ok(!rows.some((r) => String(r[2]).includes('1234') || String(r[2]).includes('5678')));
});

test('republicarDialplan(): reescribe la sala vieja y no toca la que ya está al día', async () => {
  const vieja = { ...CAMPOS_SALA };
  const alDia = { ...CAMPOS_SALA, id: 2, name: 'directorio', access_exten: '9200', pin: '1111', pin_mod: '2222' };
  // El dialplan VIEJO de `conferences`: Answer · Authenticate · ConfBridge · Hangup.
  const previo = { '9100': [
    { priority: 1, app: 'Answer', appdata: '' },
    { priority: 2, app: 'ConfBridge', appdata: 'recepcion' },
    { priority: 3, app: 'Hangup', appdata: '' },
  ] };
  const { salasMod, cont } = armar([vieja, alDia], previo);
  // La que ya está al día se simula con su propio plan generado.
  previo['9200'] = salasMod.salaDialplan(alDia).map((r) => ({ priority: r[0], app: r[1], appdata: r[2] }));
  const hechas = await salasMod.republicarDialplan();
  assert.equal(hechas, 1);
  assert.ok(cont.escrito['ivr:9100'], 'la sala vieja se republica');
  assert.equal(cont.escrito['ivr:9200'], undefined, 'la que ya coincide no se reescribe');
});
