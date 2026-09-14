/* Integración · reportes de call center (ccreport.js) contra la API real y un PostgreSQL
 * efímero. Sin Postgres se saltea.
 *
 * Asterisk NO está, así que los eventos de cola no llegan por AMI: la prueba los escribe
 * directamente en `pbxng_queue_events`, que es exactamente lo que hace el consumidor. Lo
 * que se verifica es el CÁLCULO (nivel de servicio, abandono, esperas, fuera de horario),
 * los permisos por rol y la validación de las programaciones de envío. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

const HOY = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DIA = ymd(HOY);
/* Una hora de hoy que esté lejos de medianoche, para que el evento caiga en el mismo día
 * local que el rango pedido aunque la prueba corra a las 23:59. */
const aLas = (h, m = 0, s = 0) => new Date(HOY.getFullYear(), HOY.getMonth(), HOY.getDate(), h, m, s);
const DIA_SEM_N = (n) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][n];
const DIA_SEM = DIA_SEM_N(HOY.getDay());

test('call center: métricas por cola y agente, CSV, informe, roles y programaciones', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  /* Escenario: cola `ventas` con 4 llamadas ofrecidas — 2 atendidas dentro del umbral,
   * 1 atendida fuera del umbral y 1 abandonada. Una de las atendidas entra a las 22 h,
   * que va a quedar fuera del horario de atención que se configura más abajo. */
  const ev = async (ts, cola, evento, extra = {}) => {
    await ctx.db.query(
      'INSERT INTO pbxng_queue_events (ts, cola, evento, uniqueid, agente, espera_s, habla_s, origen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [ts, cola, evento, extra.uniqueid || null, extra.agente || null,
        extra.espera_s === undefined ? null : extra.espera_s,
        extra.habla_s === undefined ? null : extra.habla_s, extra.origen || null]);
  };
  await ev(aLas(10, 0), 'ventas', 'entra', { uniqueid: 'a' });
  await ev(aLas(10, 0, 5), 'ventas', 'atendida', { uniqueid: 'a', agente: '1001', espera_s: 5 });
  await ev(aLas(10, 2), 'ventas', 'fin', { uniqueid: 'a', agente: '1001', espera_s: 5, habla_s: 120 });
  await ev(aLas(11, 0), 'ventas', 'entra', { uniqueid: 'b' });
  await ev(aLas(11, 0, 10), 'ventas', 'atendida', { uniqueid: 'b', agente: '1002', espera_s: 10 });
  await ev(aLas(11, 1), 'ventas', 'fin', { uniqueid: 'b', agente: '1002', espera_s: 10, habla_s: 60 });
  await ev(aLas(12, 0), 'ventas', 'entra', { uniqueid: 'c' });
  await ev(aLas(12, 1), 'ventas', 'atendida', { uniqueid: 'c', agente: '1001', espera_s: 45 });
  await ev(aLas(12, 3), 'ventas', 'fin', { uniqueid: 'c', agente: '1001', espera_s: 45, habla_s: 300 });
  await ev(aLas(22, 0), 'ventas', 'entra', { uniqueid: 'd' });
  await ev(aLas(22, 1), 'ventas', 'abandona', { uniqueid: 'd', espera_s: 90 });
  await ev(aLas(13, 0), 'ventas', 'sin_respuesta', { uniqueid: 'e', agente: '1002', espera_s: 15 });

  await t.test('métricas: nivel de servicio, abandono, esperas y conversación', async () => {
    const r = await api('GET', `/api/ccreport?from=${DIA}&to=${DIA}&sla=20`, { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const T = r.json.totales;
    assert.equal(T.ofrecidas, 4);
    assert.equal(T.atendidas, 3);
    assert.equal(T.abandonadas, 1);
    assert.equal(T.sla_pct, 50);            // 2 de 4 atendidas antes de 20 s
    assert.equal(T.abandono_pct, 25);
    assert.equal(T.espera_max, 90);
    assert.equal(T.espera_media, 38);       // (5+10+45+90)/4 = 37,5 → 38
    assert.equal(T.habla_media, 160);       // (120+60+300)/3
    assert.equal(T.habla_total, 480);
    const c = r.json.colas[0];
    assert.equal(c.cola, 'ventas');
    assert.equal(c.otras_salidas, 0);
    assert.equal(c.sin_respuesta, 1);
    // Sin horario configurado el dato viaja en null: el informe no inventa un 9 a 18.
    assert.equal(c.fuera_horario, null);
    assert.equal(r.json.fuente.sin_horario, true);
    assert.equal(r.json.fuente.sin_datos, false);
  });

  await t.test('métricas por agente', async () => {
    const r = await api('GET', `/api/ccreport?from=${DIA}&to=${DIA}&sla=20`, { token: admin });
    const porAg = Object.fromEntries(r.json.agentes.map((a) => [a.agente, a]));
    assert.equal(porAg['1001'].atendidas, 2);
    assert.equal(porAg['1001'].habla_total, 420);
    assert.equal(porAg['1001'].habla_max, 300);
    assert.equal(porAg['1002'].atendidas, 1);
    assert.equal(porAg['1002'].sin_respuesta, 1);
  });

  await t.test('fuera de horario sale del horario de atención, no de un valor fijo', async () => {
    const h = await api('POST', '/api/horarios', { token: admin, body: { nombre: 'Oficina', tramos: [{ dias: DIA_SEM, desde: '09:00', hasta: '18:00' }] } });
    assert.equal(h.status, 201, JSON.stringify(h.json));
    const r = await api('GET', `/api/ccreport?from=${DIA}&to=${DIA}&sla=20`, { token: admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.fuente.sin_horario, false);
    // La única entrada de las 22 h queda afuera; las de 10, 11 y 12 adentro.
    assert.equal(r.json.totales.fuera_horario, 1);
    assert.equal(r.json.colas[0].fuera_horario, 1);
  });

  /* El filtro de "fuera de horario" se resuelve en SQL (sqlFuera): estas pruebas cubren
   * los tres casos que el traductor de tramos tiene que respetar igual que tramoAhora()
   * de telefonia.js — el tramo que cruza medianoche, el rango de días con vuelta de
   * semana y el feriado, que cierra el día entero. */
  await t.test('fuera de horario: tramo que cruza medianoche', async () => {
    const hs = await api('GET', '/api/horarios', { token: admin });
    for (const h of hs.json) await api('DELETE', '/api/horarios/' + h.id, { token: admin });
    // 22:00–06:00 todos los días: la entrada de las 22 h queda DENTRO y las de 10, 11 y 12 fuera.
    const h = await api('POST', '/api/horarios', { token: admin, body: { nombre: 'Nocturno', tramos: [{ dias: '*', desde: '22:00', hasta: '06:00' }] } });
    assert.equal(h.status, 201, JSON.stringify(h.json));
    const r = await api('GET', `/api/ccreport?from=${DIA}&to=${DIA}&sla=20`, { token: admin });
    assert.equal(r.json.totales.fuera_horario, 3);
  });

  await t.test('fuera de horario: rango de días con vuelta de semana', async () => {
    const hs = await api('GET', '/api/horarios', { token: admin });
    for (const h of hs.json) await api('DELETE', '/api/horarios/' + h.id, { token: admin });
    /* Rango que da la vuelta a la semana arrancando MAÑANA: hoy queda justo fuera, así
     * que las cuatro entradas del día son fuera de horario. */
    const manana = DIA_SEM_N((HOY.getDay() + 1) % 7);
    const ayer = DIA_SEM_N((HOY.getDay() + 6) % 7);
    const h = await api('POST', '/api/horarios', { token: admin, body: { nombre: 'Vuelta', tramos: [{ dias: `${manana}-${ayer}`, desde: '00:00', hasta: '23:59' }] } });
    assert.equal(h.status, 201, JSON.stringify(h.json));
    const r = await api('GET', `/api/ccreport?from=${DIA}&to=${DIA}&sla=20`, { token: admin });
    assert.equal(r.json.totales.fuera_horario, 4);
  });

  await t.test('fuera de horario: un feriado cierra el día entero', async () => {
    const hs = await api('GET', '/api/horarios', { token: admin });
    for (const h of hs.json) await api('DELETE', '/api/horarios/' + h.id, { token: admin });
    const h = await api('POST', '/api/horarios', { token: admin, body: { nombre: 'Oficina', tramos: [{ dias: DIA_SEM, desde: '09:00', hasta: '18:00' }] } });
    assert.equal(h.status, 201, JSON.stringify(h.json));
    const f = await api('POST', '/api/feriados', { token: admin, body: { nombre: 'Prueba', anual: false, fecha: DIA } });
    assert.equal(f.status, 201, JSON.stringify(f.json));
    const r = await api('GET', `/api/ccreport?from=${DIA}&to=${DIA}&sla=20`, { token: admin });
    assert.equal(r.json.totales.fuera_horario, 4);   // el feriado gana sobre el tramo
    assert.equal((await api('DELETE', '/api/feriados/' + f.json.id, { token: admin })).status, 200);
  });

  await t.test('filtros inválidos: mensaje claro y 400, nunca un 500', async () => {
    for (const [qs, txt] of [
      ['from=ayer&to=' + DIA, 'desde'],
      ['from=' + DIA + '&to=mañana', 'hasta'],
      [`from=${DIA}&to=${DIA}&cola=ven;DROP`, 'cola'],
      ['from=2020-01-01&to=' + DIA, 'días'],
    ]) {
      const r = await api('GET', '/api/ccreport?' + qs, { token: admin });
      assert.equal(r.status, 400, qs + ' → ' + r.status);
      assert.match(r.json.error, new RegExp(txt));
    }
    // Rango dado vuelta
    const r = await api('GET', `/api/ccreport?from=${DIA}&to=2020-01-01`, { token: admin });
    assert.equal(r.status, 400);
  });

  await t.test('export CSV e informe A4', async () => {
    const csv = await api('GET', `/api/ccreport/csv?from=${DIA}&to=${DIA}&sla=20`, { token: admin });
    assert.equal(csv.status, 200);
    const texto = csv.json && csv.json._raw ? csv.json._raw : '';
    assert.match(texto, /Cola;Nombre;Ofrecidas/);
    assert.match(texto, /ventas/);
    assert.match(csv.headers.get('content-disposition') || '', /attachment; filename="callcenter-/);
    const pdf = await api('GET', `/api/ccreport/report?from=${DIA}&to=${DIA}&sla=20`, { token: admin });
    assert.equal(pdf.status, 200);
    const doc = pdf.json && pdf.json._raw ? pdf.json._raw : '';
    assert.match(doc, /Informe<br>de call center/);
    assert.match(doc, /Nivel de servicio/);
  });

  await t.test('roles: supervisor ve y exporta, agente no; programar es sólo admin', async () => {
    for (const [u, role] of [['sup2', 'supervisor'], ['age2', 'agente']]) {
      const r = await api('POST', '/api/users', { token: admin, body: { username: u, password: 'Clave-' + u + '-123', role } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    const sup = (await login('sup2', 'Clave-sup2-123')).token;
    const age = (await login('age2', 'Clave-age2-123')).token;
    for (const ruta of ['/api/ccreport', '/api/ccreport/csv', '/api/ccreport/report']) {
      assert.equal((await api('GET', ruta + '?from=' + DIA + '&to=' + DIA, { token: sup })).status, 200, ruta);
      assert.equal((await api('GET', ruta + '?from=' + DIA + '&to=' + DIA, { token: age })).status, 403, ruta);
    }
    assert.equal((await api('GET', '/api/ccreport/schedules', { token: sup })).status, 403);
    assert.equal((await api('GET', '/api/ccreport/schedules', { token: admin })).status, 200);
  });

  await t.test('programaciones: alta, validación de destinatarios y borrado', async () => {
    const mal = await api('POST', '/api/ccreport/schedules', { token: admin, body: { periodo: 'diario', destinatarios: 'jefe@ejemplo.com, esto no es un mail' } });
    assert.equal(mal.status, 400);
    assert.match(mal.json.error, /correo/);
    const malP = await api('POST', '/api/ccreport/schedules', { token: admin, body: { periodo: 'cuando sea', destinatarios: '' } });
    assert.equal(malP.status, 400);

    const ok = await api('POST', '/api/ccreport/schedules', { token: admin, body: { nombre: 'Semanal ventas', cola: 'ventas', periodo: 'semanal', dia: 1, hora: 8, sla_seg: 20, destinatarios: 'jefe@ejemplo.com' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.periodo, 'semanal');
    assert.equal(ok.json.dia, 1);

    // El día del mes se topa en 28: un envío el 31 no saldría nunca en febrero.
    const mens = await api('PUT', '/api/ccreport/schedules/' + ok.json.id, { token: admin, body: { periodo: 'mensual', dia: 31, hora: 7, destinatarios: 'jefe@ejemplo.com' } });
    assert.equal(mens.status, 200, JSON.stringify(mens.json));
    assert.equal(mens.json.dia, 28);

    assert.equal((await api('PUT', '/api/ccreport/schedules/999999', { token: admin, body: { periodo: 'diario', destinatarios: '' } })).status, 404);
    assert.equal((await api('DELETE', '/api/ccreport/schedules/' + ok.json.id, { token: admin })).status, 200);
    assert.equal((await api('DELETE', '/api/ccreport/schedules/' + ok.json.id, { token: admin })).status, 404);
  });
});
