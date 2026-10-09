/* ============================================================================
 *  Reportes de call center (ccreport.js) con dependencias falsas: sin Postgres, sin
 *  SMTP y sin Asterisk. Complementa ccreport.test.js (integración, el cálculo en SQL)
 *  y ccreport-consumidor.test.js (el techo del buffer) con los bordes que esas dos no
 *  tocan y que son los que un supervisor ve cuando algo no está "lindo":
 *
 *   - el consumidor AMI con eventos incompletos (sin MemberName, con la interfaz cruda
 *     de un canal Local, sin cola, sin Uniqueid): el informe no puede mostrar
 *     «Local/6098@ivr/n» ni guardar strings vacíos donde va NULL;
 *   - el traductor de horario a SQL con tramos rotos o días inválidos: un tramo mal
 *     cargado se ignora y, si no queda ninguno, TODO es fuera de horario (el lado
 *     prudente, igual que tramoAhora() de telefonia.js);
 *   - el CSV y el informe A4 con valores nulos, comillas y punto y coma, sin horario,
 *     sin datos, con agentes truncados y con varias colas (la «peor cola»);
 *   - las programaciones: validación (período, cola, destinatarios), 404, errores de la
 *     base que llegan al cliente por errorHttp, la prueba manual (502 si no sale), la
 *     ventana semanal/mensual, cuándo «le toca» y la poda por retención.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const initCcreport = require('../ccreport');

/* Pool falso: cada consulta se resuelve con el primer [regex, respuesta] que matchee.
 * La respuesta puede ser una función (sql, args) o un objeto; si es un Error, se tira,
 * y si la función devuelve undefined la regla se saltea. */
function poolFalso(reglas) {
  const sql = [];
  return {
    sql,
    async query(q, args) {
      const s = String(q).replace(/\s+/g, ' ').trim();
      sql.push({ q: s, args });
      for (const [re, r] of reglas()) {
        if (re.test(s)) {
          const v = typeof r === 'function' ? await r(s, args) : r;
          if (v === undefined) continue;          // la regla no aplica: sigue la próxima
          if (v instanceof Error) throw v;
          return v;
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function armar({ reglas = () => [], raise = async () => true, conLogger = true, ami = null } = {}) {
  const rutas = {};
  const reg = (m) => (p, h) => { rutas[m + ' ' + p] = h; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  const pool = poolFalso(reglas);
  const raises = [];
  const alerts = { async raise(ev, datos) { raises.push({ ev, datos }); return raise(ev, datos); } };
  const errores = [], infos = [];
  const logger = () => ({ debug() {}, info(...a) { infos.push(a); }, warn() {}, error(...a) { errores.push(a); } });
  const errorHttp = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'error interno' });
  const cc = initCcreport({ app, pool, ami, alerts, errorHttp, ...(conLogger ? { logger } : {}) });
  const llamar = async (ruta, { query = {}, params = {}, body, user } = {}) => {
    const r = { status: 200, json: undefined, body: undefined, headers: {}, tipo: null };
    const res = {
      status(s) { r.status = s; return this; },
      json(j) { r.json = j; return this; },
      type(t) { r.tipo = t; return this; },
      setHeader(k, v) { r.headers[k.toLowerCase()] = v; },
      send(b) { r.body = b; return this; },
    };
    await rutas[ruta]({ query, params, body, user }, res);
    return r;
  };
  return { cc, pool, rutas, llamar, raises, errores, infos };
}

/* Filas típicas de las consultas de métricas, para armar escenarios a mano. */
const filaCola = (cola, o = {}) => ({
  cola, entradas: 0, atendidas: 0, abandonadas: 0, sin_respuesta: 0, en_sla: 0,
  espera_media: 0, espera_max: 0, espera_abandono: 0, habla_media: 0, habla_total: 0, ...o,
});

/* ── Consumidor AMI ───────────────────────────────────────────────────────*/

test('consumidor: el agente sale limpio de la interfaz cruda y los vacíos van como NULL', async () => {
  const ami = new EventEmitter();
  const { cc, pool } = armar({ ami });
  const emitir = (event, extra) => ami.emit('managerevent', { event, ...extra });
  // Sin MemberName: se usa la interfaz, y un canal Local se reduce al interno.
  emitir('AgentConnect', { queue: 'ventas', interface: 'Local/6098@ivr/n', holdtime: '3', linkedid: 'L1' });
  // MemberName con instancia PJSIP: se le saca la tecnología y el sufijo.
  emitir('AgentRingNoAnswer', { queue: 'ventas', membername: 'PJSIP/2001-0000001a', ringtime: '15' });
  // MemberName que no es interfaz («Juan Perez») va tal cual.
  emitir('AgentComplete', { Queue: 'ventas', MemberName: 'Juan Perez', HoldTime: '2', TalkTime: '40' });
  // Una interfaz que limpia a vacío («PJSIP/» sola) cae al texto crudo antes que a nada.
  emitir('AgentConnect', { queue: 'ventas', membername: 'PJSIP/', holdtime: 'x' });
  // Sin nombre ni interfaz: agente NULL.
  emitir('AgentConnect', { queue: 'ventas', holdtime: '-4' });
  // Sin cola no hay nada que informar; un evento que no se mapea tampoco.
  emitir('QueueCallerJoin', { queue: '   ' });
  emitir('QueueCallerLeave', { queue: 'ventas' });
  ami.emit('managerevent', null);
  assert.equal(cc.pendientes.length, 5);
  await cc.volcar();
  const ins = pool.sql.find((x) => /INSERT INTO pbxng_queue_events/.test(x.q));
  assert.ok(ins, 'se volcó el lote');
  const filas = [];
  for (let i = 0; i < ins.args.length; i += 10) filas.push(ins.args.slice(i, i + 10));
  const [a, b, c, d, e] = filas;
  assert.equal(a[4], '6098');
  assert.equal(a[3], 'L1', 'sin Uniqueid se toma el Linkedid');
  assert.equal(a[8], null, 'sin CallerIDNum el origen va NULL, no cadena vacía');
  assert.equal(b[4], '2001');
  assert.equal(b[2], 'sin_respuesta');
  assert.equal(b[5], 15, 'el tiempo de timbre del no-contestó va en espera_s');
  assert.equal(c[4], 'Juan Perez');
  assert.equal(c[6], 40);
  assert.equal(d[4], 'PJSIP/');
  assert.equal(d[5], null, 'una espera no numérica no se guarda como 0');
  assert.equal(e[4], null);
  assert.equal(e[5], null, 'una espera negativa tampoco');
  assert.equal(e[3], null);
});

test('consumidor: lo descartado por buffer lleno se informa en el volcado siguiente', async () => {
  const prev = process.env.CC_LOTE_TOPE;
  process.env.CC_LOTE_TOPE = '100';
  try {
    const ami = new EventEmitter();
    const { cc, errores } = armar({ ami });
    for (let i = 0; i < 105; i++) ami.emit('managerevent', { event: 'QueueCallerJoin', queue: 'ventas', position: '1' });
    assert.equal(cc.pendientes.length, 100);
    await cc.volcar();
    assert.ok(errores.some((a) => /descartados por buffer lleno/.test(a[0]) && a[1].descartados === 5));
    // Ya informados: un segundo volcado (vacío) no repite el aviso.
    const antes = errores.length;
    await cc.volcar();
    assert.equal(errores.length, antes);
  } finally {
    if (prev === undefined) delete process.env.CC_LOTE_TOPE; else process.env.CC_LOTE_TOPE = prev;
  }
});

test('consumidor: el reloj de lote vuelca solo, sin que nadie llame a volcar()', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const ami = new EventEmitter();
  const { cc, pool } = armar({ ami, conLogger: false });   // sin logger: cae al log mudo
  ami.emit('managerevent', { event: 'QueueCallerAbandon', queue: 'ventas', originalposition: '2', holdtime: '30' });
  t.mock.timers.tick(2000);
  // El callback del reloj dispara un volcado asíncrono: dejo correr las promesas.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(cc.pendientes.length, 0);
  assert.ok(pool.sql.some((x) => /INSERT INTO pbxng_queue_events/.test(x.q)));
});

/* ── Métricas ─────────────────────────────────────────────────────────────*/

test('métricas: horario elegido por id, feriados en las dos listas y tramos rotos ignorados', async () => {
  const { cc, pool } = armar({
    reglas: () => [
      [/key='nightmode_horario_id'/, { rows: [{ value: '5' }] }],
      [/FROM pbxng_horarios WHERE id=\$1/, { rows: [{ id: 5, nombre: '', activo: true, tramos: [
        null,
        { dias: 'mon-fri', desde: '9:00', hasta: '18:00' },       // hora mal escrita: se ignora
        { dias: 'lun-vie', desde: '09:00', hasta: '18:00' },      // días que no existen: se ignora
        { desde: '09:00', hasta: '13:00' },                        // sin días = todos
        { dias: 'sat', desde: '22:00', hasta: '02:00' },           // cruza medianoche
      ] }] }],
      [/FROM pbxng_feriados/, { rows: [
        { anual: true, md: '12-25' }, { anual: true, md: null },
        { anual: false, fecha: '2026-05-01T12:00:00' }, { anual: false, fecha: null },
      ] }],
      [/GROUP BY cola ORDER BY cola/, { rows: [filaCola('ventas', { entradas: 2, atendidas: 1, en_sla: 1, espera_media: 4, habla_total: 50 }), filaCola('vacia')] }],
      [/SELECT cola, count\(\*\)::int AS fuera/, { rows: [{ cola: 'ventas', fuera: 1 }] }],
      [/min\(ts\)/, { rows: [{ t: '2026-01-01T00:00:00Z' }] }],
    ],
  });
  const m = await cc.metricas({ from: '2026-05-01', to: '2026-05-03', cola: 'ventas' });
  const fuera = pool.sql.find((x) => /AS fuera/.test(x.q));
  assert.ok(fuera, 'con horario se consulta fuera de horario');
  // Los parámetros: desde, hasta, cola, zona, anuales, fechas y los minutos de los dos tramos válidos.
  assert.deepEqual(fuera.args[4], ['12-25']);
  assert.deepEqual(fuera.args[5], ['2026-05-01']);
  assert.deepEqual(fuera.args.slice(6), [540, 780, 1320, 120]);
  assert.match(fuera.q, /EXTRACT\(DOW FROM [^)]+\)\) IN \(6\)/);
  assert.match(fuera.q, / AND cola=\$3 /, 'el filtro de cola va en la consulta de fuera de horario');
  assert.equal(m.horario.nombre, 'horario 5', 'sin nombre se nombra por id');
  assert.equal(m.colas[0].fuera_horario, 1);
  assert.equal(m.colas[1].fuera_horario, 0);
  assert.equal(m.colas[1].sla_pct, null, 'una cola sin llamadas no tiene nivel de servicio (no 0 %)');
  assert.equal(m.colas[1].abandono_pct, null);
  assert.equal(m.totales.fuera_horario, 1);
  assert.equal(m.cola, 'ventas');
  const porCola = pool.sql.find((x) => /GROUP BY cola ORDER BY cola/.test(x.q));
  assert.match(porCola.q, /AND cola=\$4/);
  assert.equal(porCola.args[3], 'ventas');
});

test('métricas: sin ningún tramo válido todo queda fuera de horario', async () => {
  const { cc, pool } = armar({
    reglas: () => [
      [/key='nightmode_horario_id'/, { rows: [] }],
      [/WHERE activo=true ORDER BY id LIMIT 1/, { rows: [{ id: 1, nombre: 'Raro', activo: true, tramos: [{ dias: 'xyz', desde: '09:00', hasta: '10:00' }] }] }],
    ],
  });
  await cc.metricas({});
  const fuera = pool.sql.find((x) => /AS fuera/.test(x.q));
  assert.match(fuera.q, /AND true GROUP BY cola$/);
});

test('métricas: un horario inactivo o sin tramos es como no tener horario', async () => {
  for (const h of [{ id: 1, activo: false, tramos: [{ desde: '09:00', hasta: '10:00' }] }, { id: 1, activo: true, tramos: [] }]) {
    const { cc, pool } = armar({ reglas: () => [[/WHERE activo=true/, { rows: [h] }]] });
    const m = await cc.metricas({});
    assert.equal(m.fuente.sin_horario, true);
    assert.ok(!pool.sql.some((x) => /FROM pbxng_feriados/.test(x.q)), 'sin horario no se piden los feriados');
  }
});

test('métricas: rangos con un solo extremo y fechas imposibles', async () => {
  const { cc } = armar();
  // Sólo "hasta": la semana que termina ese día.
  const m1 = await cc.metricas({ to: '2026-03-10' });
  assert.equal(m1.dias, 6);
  // Sólo "desde": hasta ahora (dentro del tope si es reciente).
  const hoy = new Date();
  const hace3 = new Date(hoy.getTime() - 3 * 864e5);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const m2 = await cc.metricas({ from: ymd(hace3) });
  assert.ok(m2.dias >= 3 && m2.dias <= 4);
  // Formato correcto pero fecha que no existe: 400 con mensaje propio, no un Invalid Date en SQL.
  await assert.rejects(cc.metricas({ from: '2026-13-45', to: '2026-01-01' }), (e) => e.status === 400 && /no es válido/.test(e.message));
});

test('métricas: los agentes se cortan en el tope y se avisa', async () => {
  const { cc } = armar({
    reglas: () => [
      [/GROUP BY agente/, { rows: [{ agente: '1001', atendidas: 3 }, { agente: '1002', atendidas: 2 }, { agente: '1003', atendidas: 1 }] }],
      [/SELECT ext, name FROM pbxng_directory/, { rows: [{ ext: 1001, name: 'Ana' }] }],
      [/SELECT name, label FROM pbxng_queues/, { rows: [{ name: 'ventas', label: 'Ventas' }] }],
    ],
  });
  const m = await cc.metricas({ limite: '2' });
  assert.equal(m.agentes.length, 2);
  assert.equal(m.agentes_truncado, true);
  assert.equal(m.agentes[0].nombre, 'Ana');
  assert.equal(m.agentes[1].nombre, '');
  assert.equal(m.fuente.sin_datos, true);
});

/* ── CSV ──────────────────────────────────────────────────────────────────*/

test('CSV: comillas, punto y coma y saltos se escapan; los nulos quedan vacíos', () => {
  const { cc } = armar();
  const csv = cc.filasCsv({
    desde: '2026-05-01T03:00:00Z', hasta: '2026-05-02T02:59:59Z', sla_seg: 20,
    colas: [{ cola: 'ventas', label: 'Ventas; "norte"', ofrecidas: 1, atendidas: 1, abandonadas: 0, otras_salidas: 0,
      sla_pct: 66.7, abandono_pct: null, espera_media: 1, espera_max: 1, espera_abandono: 0, habla_media: 1, habla_total: 1, fuera_horario: null }],
    agentes: [{ agente: '1001', nombre: 'Ana\nMaría', atendidas: 1, sin_respuesta: 0, espera_media: 1, habla_media: 1, habla_max: 1, habla_total: 1 }],
  });
  assert.ok(csv.startsWith('﻿'), 'lleva BOM para Excel');
  assert.match(csv, /ventas;"Ventas; ""norte""";1;1;0;0;66,7;;1;1;0;1;1;sin horario/);
  assert.match(csv, /1001;"Ana\nMaría";1/);
});

/* ── Rutas de consulta ────────────────────────────────────────────────────*/

test('rutas: CSV con cola en el nombre del archivo, informe con usuario y errores por errorHttp', async () => {
  let rompe = false;
  const { llamar } = armar({
    reglas: () => [
      [/GROUP BY cola ORDER BY cola/, () => (rompe ? new Error('relation "x" does not exist') : { rows: [] })],
    ],
  });
  const csv = await llamar('GET /api/ccreport/csv', { query: { from: '2026-05-01', to: '2026-05-02', cola: 'ventas' } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-disposition'], /filename="callcenter-.*-ventas\.csv"/);

  const rep = await llamar('GET /api/ccreport/report', { query: { from: '2026-05-01', to: '2026-05-02' }, user: { username: 'sup' } });
  assert.equal(rep.tipo, 'html');
  assert.match(rep.body, /generado por sup/);
  const anon = await llamar('GET /api/ccreport/report', { query: {} });
  assert.doesNotMatch(anon.body, /generado por/);

  // Validación: 400 con mensaje propio en las tres rutas.
  for (const r of ['GET /api/ccreport', 'GET /api/ccreport/csv', 'GET /api/ccreport/report']) {
    const x = await llamar(r, { query: { from: 'ayer' } });
    assert.equal(x.status, 400, r);
  }
  rompe = true;
  const x = await llamar('GET /api/ccreport/csv', { query: {} });
  assert.equal(x.status, 500);
  assert.doesNotMatch(x.json.error, /relation/, 'el error de Postgres no llega crudo');
});

/* ── Informe A4 ───────────────────────────────────────────────────────────*/

test('informe A4: avisos, peor cola, chips y filas según los datos', async () => {
  const { llamar } = armar({
    reglas: () => [
      [/WHERE activo=true/, { rows: [{ id: 2, nombre: 'Oficina', activo: true, tramos: [{ desde: '09:00', hasta: '18:00' }] }] }],
      [/GROUP BY cola ORDER BY cola/, { rows: [
        filaCola('ventas', { entradas: 10, atendidas: 9, en_sla: 9, espera_media: 5, espera_max: 20, habla_media: 60, habla_total: 540 }),
        filaCola('soporte', { entradas: 10, atendidas: 4, abandonadas: 6, en_sla: 2, espera_media: 40, espera_max: 200 }),
      ] }],
      [/AS fuera/, { rows: [{ cola: 'soporte', fuera: 3 }] }],
      [/GROUP BY agente/, { rows: [{ agente: '1001', atendidas: 9, sin_respuesta: 0, espera_media: 5, habla_media: 60, habla_max: 90, habla_total: 540 }, { agente: '1002', atendidas: 4 }] }],
      [/SELECT ext, name/, { rows: [{ ext: '1001', name: 'Ana <b>' }] }],
      [/SELECT name, label/, { rows: [{ name: 'soporte', label: 'Mesa de ayuda' }] }],
      [/min\(ts\)/, { rows: [{ t: new Date().toISOString() }] }],
      [/SELECT to_char/, { rows: [{ dia: '2026-05-01', atendidas: 13, abandonadas: 6 }] }],
    ],
  });
  const r = await llamar('GET /api/ccreport/report', { query: { from: '2026-05-01', to: '2026-05-02', cola: undefined, limite: '1' }, user: { name: 'Super Visora' } });
  const h = r.body;
  assert.match(h, /generado por Super Visora/);
  assert.match(h, /El registro de colas arranca el/, 'rango anterior al primer evento: se avisa');
  assert.match(h, /Se listan los <b>1<\/b> agentes/);
  assert.match(h, /<b>3<\/b> llamadas entraron fuera del horario de atención \(Oficina\)/);
  assert.match(h, /La cola con peor nivel de servicio es <b>Mesa de ayuda<\/b> \(20%\)/);
  assert.match(h, /chip no">20%/);
  assert.match(h, /chip ok">90%/);
  assert.match(h, /Mesa de ayuda<\/b><span class="sm">soporte/, 'si la etiqueta difiere, se muestra el nombre técnico');
  assert.match(h, /Ana &lt;b&gt;/, 'el nombre del agente se escapa');
  assert.match(h, /Todas las colas/);
  assert.doesNotMatch(h, /No hay un horario de atención/);
});

test('informe A4: sin datos ni horario, con una cola elegida', async () => {
  const { llamar } = armar();
  const r = await llamar('GET /api/ccreport/report', { query: { cola: 'ventas' } });
  const h = r.body;
  assert.match(h, /No hay <b>ningún<\/b> evento de cola registrado/);
  assert.match(h, /No hay un horario de atención configurado/);
  assert.match(h, /No hubo llamadas de cola en el período/);
  assert.match(h, /Sin datos de cola en el período/);
  assert.match(h, /Ningún agente atendió/);
  assert.match(h, /Sin llamadas de cola en el período/);
  assert.match(h, /Cola ventas/);
});

test('informe A4: una cola sola sin conversación ni fuera de horario no inventa conclusiones', async () => {
  const { llamar } = armar({
    reglas: () => [
      [/GROUP BY cola ORDER BY cola/, { rows: [filaCola('ventas', { entradas: 2, abandonadas: 2, espera_media: 10 })] }],
      [/min\(ts\)/, { rows: [{ t: '2020-01-01T00:00:00Z' }] }],
    ],
  });
  const h = (await llamar('GET /api/ccreport/report', { query: {} })).body;
  assert.doesNotMatch(h, /La conversación media duró/);
  assert.doesNotMatch(h, /peor nivel de servicio/, 'con una sola cola no hay «peor»');
  assert.doesNotMatch(h, /El registro de colas arranca/);
  assert.match(h, /<td>—<\/td><\/tr>/, 'sin horario, la columna fuera de hora va con raya');
});

/* ── Programaciones ───────────────────────────────────────────────────────*/

test('programaciones: normalización, validaciones y errores de la base', async () => {
  let caida = false;
  const { llamar, pool } = armar({
    reglas: () => [
      [/./, () => (caida ? new Error('Connection terminated') : undefined)],
      [/INSERT INTO pbxng_cc_reports/, (q, a) => ({ rows: [{ id: 1, nombre: a[0], cola: a[1], periodo: a[2], hora: a[3], dia: a[4], enabled: a[7], destinatarios: a[6] }] })],
      [/UPDATE pbxng_cc_reports SET nombre/, { rows: [{ id: 3 }] }],
      [/DELETE FROM pbxng_cc_reports/, { rowCount: 1 }],
      [/SELECT id,nombre,cola,periodo/, { rows: [{ id: 1 }] }],
    ],
  });
  // Sin cuerpo: diario a las 8, sin destinatarios, habilitado.
  const a = await llamar('POST /api/ccreport/schedules', {});
  assert.equal(a.status, 201);
  assert.equal(a.json.nombre, 'Informe diario');
  assert.equal(a.json.destinatarios, '');
  assert.equal(a.json.enabled, true);
  assert.equal(a.json.dia, null);
  const b = await llamar('POST /api/ccreport/schedules', { body: { periodo: 'semanal', dia: 9, cola: 'ventas', enabled: 0, destinatarios: ' a@b.com , c@d.org ' } });
  assert.equal(b.json.nombre, 'Informe semanal · ventas');
  assert.equal(b.json.dia, 7);
  assert.equal(b.json.enabled, false);
  assert.equal(b.json.destinatarios, 'a@b.com,c@d.org');

  const muchos = Array.from({ length: 21 }, (_, i) => `x${i}@a.com`).join(',');
  for (const [body, txt] of [
    [{ destinatarios: muchos }, /máximo 20/],
    [{ cola: 'ven tas' }, /cola/],
    [{ periodo: 'anual' }, /período/],
  ]) {
    const r = await llamar('POST /api/ccreport/schedules', { body });
    assert.equal(r.status, 400);
    assert.match(r.json.error, txt);
  }
  const put = await llamar('PUT /api/ccreport/schedules/:id', { params: { id: '3' } });
  assert.equal(put.status, 200);
  const putMal = await llamar('PUT /api/ccreport/schedules/:id', { params: { id: '3' }, body: { periodo: 'x' } });
  assert.equal(putMal.status, 400);
  assert.equal((await llamar('GET /api/ccreport/schedules')).json.length, 1);

  caida = true;
  for (const [ruta, o] of [
    ['GET /api/ccreport/schedules', {}],
    ['POST /api/ccreport/schedules', {}],
    ['PUT /api/ccreport/schedules/:id', { params: { id: '1' } }],
    ['DELETE /api/ccreport/schedules/:id', { params: { id: '1' } }],
    ['POST /api/ccreport/schedules/:id/test', { params: { id: '1' } }],
  ]) {
    const r = await llamar(ruta, o);
    assert.equal(r.status, 500, ruta);
  }
  assert.ok(pool.sql.length > 0);
});

test('programaciones: probar el envío ahora (404, 502 si no sale, 200 si sale)', async () => {
  let sale = false;
  const prog = { id: 4, nombre: '', cola: 'ventas', periodo: 'mensual', hora: 8, sla_seg: 30, destinatarios: null };
  const { llamar, raises } = armar({
    raise: async () => sale,
    reglas: () => [
      [/SELECT \* FROM pbxng_cc_reports WHERE id=\$1/, (q, a) => ({ rows: a[0] === 4 ? [prog] : [] })],
      [/GROUP BY cola ORDER BY cola/, { rows: [filaCola('ventas', { entradas: 1, atendidas: 1, en_sla: 1 })] }],
      [/GROUP BY agente/, { rows: [{ agente: '1001', atendidas: 1, habla_media: 30 }] }],
    ],
  });
  assert.equal((await llamar('POST /api/ccreport/schedules/:id/test', { params: { id: '99' } })).status, 404);
  const no = await llamar('POST /api/ccreport/schedules/:id/test', { params: { id: '4' } });
  assert.equal(no.status, 502);
  assert.match(no.json.error, /configuración de correo/);
  sale = true;
  const si = await llamar('POST /api/ccreport/schedules/:id/test', { params: { id: '4' } });
  assert.equal(si.status, 200);
  const d = raises[1].datos;
  assert.equal(d.force, true, 'la prueba manual fuerza el envío');
  assert.equal(d.to, '');
  assert.match(d.title, /^Informe de call center · 1 llamadas/);
  assert.match(d.foot, /cola ventas/);
  assert.ok(d.lines.some(([k]) => k === 'Top cola ventas'));
  assert.ok(d.lines.some(([k, v]) => k === 'Top agente 1001' && /conversación media/.test(v)));
  assert.ok(d.lines.some(([k, v]) => k === 'Fuera de horario' && v === 'sin horario configurado'));
});

test('ventana del envío: diario = ayer, semanal = 7 días, mensual = el mes anterior', () => {
  const { cc } = armar();
  const ahora = new Date(2026, 4, 15, 8, 30);   // 15/05/2026 08:30 local
  assert.deepEqual(cc.ventana({ periodo: 'diario' }, ahora), { from: '2026-05-14', to: '2026-05-14' });
  assert.deepEqual(cc.ventana({ periodo: 'semanal' }, ahora), { from: '2026-05-08', to: '2026-05-14' });
  assert.deepEqual(cc.ventana({ periodo: 'mensual' }, ahora), { from: '2026-04-15', to: '2026-05-14' });
});

test('cuándo le toca: hora, día de la semana o del mes, y lo ya enviado', () => {
  const { cc } = armar();
  const lunes = new Date(2026, 4, 11, 8, 5);      // 11/05/2026 es lunes
  const domingo = new Date(2026, 4, 10, 8, 5);
  assert.equal(cc.toca({ periodo: 'diario', hora: 9 }, lunes, null), false, 'otra hora');
  assert.equal(cc.toca({ periodo: 'diario', hora: 8 }, lunes, new Date(2026, 4, 10, 8, 0)), true, 'ayer no cuenta');
  assert.equal(cc.toca({ periodo: 'semanal', hora: 8, dia: null }, lunes, null), true, 'sin día = lunes');
  assert.equal(cc.toca({ periodo: 'semanal', hora: 8, dia: 7 }, domingo, null), true, 'domingo es el 7');
  assert.equal(cc.toca({ periodo: 'semanal', hora: 8, dia: 2 }, lunes, null), false);
  assert.equal(cc.toca({ periodo: 'semanal', hora: 8, dia: 1 }, lunes, new Date(2026, 4, 8)), false, 'hace 3 días: no repite');
  assert.equal(cc.toca({ periodo: 'semanal', hora: 8, dia: 1 }, lunes, new Date(2026, 4, 4)), true);
  const el11 = lunes;
  assert.equal(cc.toca({ periodo: 'mensual', hora: 8, dia: 11 }, el11, null), true);
  assert.equal(cc.toca({ periodo: 'mensual', hora: 8 }, el11, null), false, 'sin día = el 1');
  assert.equal(cc.toca({ periodo: 'mensual', hora: 8, dia: 11 }, el11, new Date(2026, 4, 1)), false);
  assert.equal(cc.toca({ periodo: 'mensual', hora: 8, dia: 11 }, el11, new Date(2026, 3, 11)), true);
});

test('tick: lo que no toca se saltea, un envío que tira se registra y la poda respeta la retención', async () => {
  const ahora = new Date();
  let retencion = '30';
  const { cc, pool, errores, infos } = armar({
    raise: async () => { throw new Error('SMTP caído'); },
    reglas: () => [
      [/FROM pbxng_cc_reports WHERE enabled=true/, { rows: [
        { id: 1, nombre: 'Ya enviado', periodo: 'diario', hora: ahora.getHours(), last_run_at: ahora.toISOString() },
        { id: 2, nombre: 'Rompe', periodo: 'diario', hora: ahora.getHours(), last_run_at: null },
      ] }],
      [/key='cc_retencion_dias'/, () => ({ rows: retencion === null ? [] : [{ value: retencion }] })],
      [/DELETE FROM pbxng_queue_events/, { rowCount: 12 }],
    ],
  });
  await cc.tick();
  const marcas = pool.sql.filter((x) => /SET last_run_at/.test(x.q));
  assert.deepEqual(marcas.map((x) => x.args[0]), [2], 'sólo la que tocaba; se marca aunque el envío tire');
  assert.ok(errores.some((a) => a[0] === 'informe programado' && a[1].id === 2));
  const del = pool.sql.find((x) => /DELETE FROM pbxng_queue_events/.test(x.q));
  assert.deepEqual(del.args, [30]);
  assert.ok(infos.some((a) => /podados/.test(a[0]) && a[1].filas === 12));
  // Dentro de las 6 h no vuelve a podar.
  const n = pool.sql.length;
  await cc.tick();
  assert.equal(pool.sql.filter((x, i) => i >= n && /cc_retencion_dias/.test(x.q)).length, 0);
});

test('poda: sin retención configurada, con un valor inválido o con la base caída no borra nada', async (t) => {
  for (const caso of [null, 'abc', '0', 'caida']) {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
    const { pool, errores } = armar({
      reglas: () => [
        [/key='cc_retencion_dias'/, () => (caso === 'caida' ? new Error('base caída') : { rows: caso === null ? [] : [{ value: caso }] })],
      ],
    });
    // La poda inicial corre sola a los 45 s del arranque.
    t.mock.timers.tick(45000);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.ok(pool.sql.some((x) => /cc_retencion_dias/.test(x.q)), String(caso));
    assert.ok(!pool.sql.some((x) => /DELETE FROM pbxng_queue_events/.test(x.q)), String(caso));
    if (caso === 'caida') assert.ok(errores.some((a) => /poda de eventos/.test(a[0])));
    t.mock.timers.reset();
  }
});

test('tick por reloj: un fallo de la consulta de programaciones queda en el log', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { errores } = armar({ reglas: () => [[/WHERE enabled=true/, new Error('base caída')]] });
  t.mock.timers.tick(60000);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.ok(errores.some((a) => a[0] === 'tick'));
});
