/* Envío programado del informe de call center (ccreport.js) con mocks: sin Postgres, sin
 * SMTP y sin Asterisk. Cubre los dos arreglos de la segunda pasada del revisor:
 *
 *   1) `last_run_at` avanza cuando el informe SE CALCULÓ Y SE INTENTÓ ENTREGAR, salga o
 *      no el correo. `alerts.raise()` devuelve false por motivos que no son un fallo
 *      pasajero (regla apagada, sin SMTP, sin destinatarios); antes, con cualquiera de
 *      ellos la marca no avanzaba y el tick recalculaba la consulta pesada cada minuto
 *      durante toda la hora de envío.
 *   2) el correo lleva los OCHO números del informe, no seis: "Espera máxima" y "Fuera de
 *      horario" son justamente dos de los que se pidió, y se perdían en el layout.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const initCcreport = require('../ccreport');
const emails = require('../emails');

/* Express de mentira: las rutas se registran y no se usan. */
const appFalso = () => ({ get() {}, post() {}, put() {}, delete() {} });

/* Pool de mentira: todo devuelve vacío (sin horario, sin eventos, sin colas), que es el
 * caso más pobre y el que igual tiene que marcar el período como procesado. La única
 * consulta que importa acá es el UPDATE de `last_run_at`; queda anotada en `sql`. */
function armar({ raiseDevuelve = false, programacion } = {}) {
  const sql = [];
  const pool = {
    async query(q, params) {
      sql.push({ q: String(q).replace(/\s+/g, ' ').trim(), params });
      if (String(q).includes('FROM pbxng_cc_reports WHERE enabled=true')) return { rows: [programacion] };
      return { rows: [], rowCount: 0 };
    },
  };
  const raises = [];
  const alerts = { async raise(evento, datos) { raises.push({ evento, datos }); return raiseDevuelve; } };
  const errores = [];
  const logger = () => ({ info() {}, debug() {}, error(...a) { errores.push(a); } });
  const cc = initCcreport({ app: appFalso(), pool, ami: null, alerts, errorHttp() {}, logger });
  return { cc, sql, raises, errores };
}

const programacionDeAhora = () => ({
  id: 7, nombre: 'Diario ventas', cola: null, periodo: 'diario',
  hora: new Date().getHours(), dia: null, sla_seg: 20,
  destinatarios: 'jefe@ejemplo.com', enabled: true, last_run_at: null,
});

test('el período queda marcado aunque el correo no salga (regla apagada / sin SMTP)', async () => {
  const { cc, sql, raises } = armar({ raiseDevuelve: false, programacion: programacionDeAhora() });
  await cc.tick();
  assert.equal(raises.length, 1, 'se intentó entregar el informe');
  const update = sql.filter((x) => /UPDATE pbxng_cc_reports SET last_run_at/.test(x.q));
  assert.equal(update.length, 1, 'last_run_at tiene que avanzar igual, si no el tick reintenta en bucle');
  assert.deepEqual(update[0].params, [7]);
});

test('con el correo enviado también se marca, y entonces ya no le toca', async () => {
  const { cc, sql } = armar({ raiseDevuelve: true, programacion: programacionDeAhora() });
  await cc.tick();
  assert.equal(sql.filter((x) => /UPDATE pbxng_cc_reports SET last_run_at/.test(x.q)).length, 1);
  // Con la marca puesta, la misma programación no vuelve a salir en el mismo día.
  const ahora = new Date();
  assert.equal(cc.toca({ periodo: 'diario', hora: ahora.getHours() }, ahora, ahora), false);
});

test('el correo del informe lleva los ocho números, no seis', async () => {
  const { cc, raises } = armar({ raiseDevuelve: true, programacion: programacionDeAhora() });
  await cc.tick();
  const etiquetas = raises[0].datos.lines.map(([k]) => k);
  for (const k of ['Llamadas ofrecidas', 'Atendidas', 'Abandonadas', 'Nivel de servicio',
    'Espera media', 'Conversación media', 'Espera máxima', 'Fuera de horario']) {
    assert.ok(etiquetas.includes(k), 'falta la línea «' + k + '» en el correo');
  }
});

/* El otro lado del mismo arreglo: el layout de resumen tiene que dibujar TODAS las
 * tarjetas que le pasan (antes `alerts.raise()` las cortaba en seis antes de llegar acá). */
test('digestEmail dibuja las ocho tarjetas que recibe', () => {
  const kpis = ['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco', 'Seis', 'Espera máxima', 'Fuera de horario']
    .map((label, i) => ({ label, value: i }));
  const html = emails.digestEmail({ brand: 'PBX', title: 'Informe', kpis, rows: [] });
  for (const k of kpis) assert.ok(html.includes(k.label), 'falta la tarjeta «' + k.label + '»');
});
