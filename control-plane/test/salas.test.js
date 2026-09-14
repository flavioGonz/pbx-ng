/* Integración · salas de reunión (salas.js) contra la API real y un PostgreSQL efímero.
 * Sin Postgres se saltea.
 *
 * Asterisk NO está: los DBPut/DBDel a la AstDB y las acciones Confbridge* fallan y se
 * ignoran a propósito (la fuente de verdad es Postgres y syncSalas() vuelve a volcar al
 * reconectar), así que acá se verifica lo que SÍ tiene que quedar: la fila en la base, el
 * dialplan realtime de la tabla `extensions` y las respuestas de la API. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');

const dp = async (ctx, exten) => (await ctx.db.query(
  "SELECT priority, app, appdata FROM extensions WHERE context='ivr' AND exten=$1 ORDER BY priority", [exten])).rows;
const texto = (filas) => filas.map((r) => r.priority + ' ' + r.app + '(' + r.appdata + ')').join('\n');

test('salas: alta con PIN al azar, dialplan, agenda, edición, permisos y baja', async (t) => {
  const ctx = await entorno(t);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;

  await t.test('validaciones: nombre, número y PIN', async () => {
    assert.equal((await api('POST', '/api/salas', { token: admin, body: { name: 'sala uno', access_exten: '9001' } })).status, 400);
    assert.equal((await api('POST', '/api/salas', { token: admin, body: { name: 'sala1', access_exten: '90*1' } })).status, 400);
    // Los dos PIN iguales no sirven: el moderador dejaría de ser moderador.
    const r = await api('POST', '/api/salas', { token: admin, body: { name: 'sala1', access_exten: '9001', pin: '1234', pin_mod: '1234' } });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    // Y el PIN nunca puede ser el número de la sala (con el buzón ya aprendimos).
    assert.equal((await api('POST', '/api/salas', { token: admin, body: { name: 'sala1', access_exten: '9001', pin: '9001', pin_mod: '4321' } })).status, 400);
  });

  await t.test('alta: PIN al azar distintos y dialplan completo', async () => {
    const r = await api('POST', '/api/salas', { token: admin, body: { name: 'directorio', label: 'Reunión de directorio', access_exten: '9001', grabar: true, max_part: 8 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const s = r.json;
    assert.match(s.pin, /^\d{6}$/);
    assert.match(s.pin_mod, /^\d{6}$/);
    assert.notEqual(s.pin, s.pin_mod);
    assert.equal(s.abierta, true);            // sin agenda, siempre abierta

    const filas = await dp(ctx, '9001');
    const t2 = texto(filas);
    assert.match(t2, /DB\(sala\/directorio\)/, t2);
    assert.match(t2, /CONFBRIDGE\(bridge,max_members\)=8/, t2);
    assert.match(t2, /CONFBRIDGE\(bridge,record_conference\)=yes/, t2);
    // El nombre del archivo es el que ya indexa recordings.js (pbxng-<alnum>-<epoch>.wav).
    assert.match(t2, /pbxng-sala9001-\$\{EPOCH\}\.wav/, t2);
    // Los PIN NO están en el dialplan: se comparan contra la AstDB, por eso cambiarlos no lo reescribe.
    assert.ok(!t2.includes(s.pin), 'el PIN de participante no puede quedar escrito en el dialplan');
    assert.ok(!t2.includes(s.pin_mod), 'el PIN de moderador no puede quedar escrito en el dialplan');
    assert.match(t2, /GotoIf\(\$\["\$\{SALAPIN\}"="\$\{DB\(salamod\/directorio\)\}"\]\?40\)/, t2);
    /* El PIN vacío se rechaza ANTES de comparar: sin esto, una clave ausente en la AstDB
     * (sala guardada con el AMI caído) hacía que el que no marca nada entre de MODERADOR. */
    const vacio = filas.find((r) => r.app === 'GotoIf' && r.appdata === '$["${SALAPIN}"=""]?' + (r.priority + 3));
    assert.ok(vacio, 'falta el rechazo del PIN vacío delante de las comparaciones: ' + t2);
    const invalido = filas.find((r) => r.app === 'Playback' && r.appdata === 'conf-invalidpin');
    assert.equal(invalido.priority, vacio.priority + 3, 'el salto del PIN vacío tiene que caer en conf-invalidpin');
    assert.ok(filas.filter((r) => r.app === 'GotoIf').every((r) => r.priority >= vacio.priority || !/SALAPIN/.test(r.appdata)),
      'las comparaciones de PIN tienen que ir DESPUÉS del rechazo del vacío');
    // Moderador = admin + marked; participante espera al marcado con música.
    assert.match(t2, /CONFBRIDGE\(user,admin\)=yes/, t2);
    assert.match(t2, /CONFBRIDGE\(user,wait_marked\)=yes/, t2);
    assert.match(t2, /ConfBridge\(directorio\)/, t2);
  });

  await t.test('el número no se puede repetir entre salas', async () => {
    assert.equal((await api('POST', '/api/salas', { token: admin, body: { name: 'otra', access_exten: '9001' } })).status, 409);
  });

  await t.test('agenda: fuera de la ventana la sala queda cerrada', async () => {
    const ayer = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    const r = await api('PUT', '/api/salas/directorio', { token: admin, body: { agenda_inicio: ayer, agenda_min: 60 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.abierta, false);
    const ahora = new Date(Date.now() - 5 * 60000).toISOString();
    const r2 = await api('PUT', '/api/salas/directorio', { token: admin, body: { agenda_inicio: ahora, agenda_min: 60 } });
    assert.equal(r2.json.abierta, true);
    // Borrar la agenda deja la sala siempre disponible.
    const r3 = await api('PUT', '/api/salas/directorio', { token: admin, body: { agenda_inicio: null } });
    assert.equal(r3.json.agenda_inicio, null);
    assert.equal(r3.json.abierta, true);
  });

  await t.test('cambiar el número borra la extensión vieja', async () => {
    const r = await api('PUT', '/api/salas/directorio', { token: admin, body: { access_exten: '9002' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await dp(ctx, '9001')).length, 0, 'el número viejo no puede seguir entrando a la sala');
    assert.ok((await dp(ctx, '9002')).length > 0);
  });

  await t.test('vista en vivo sin Asterisk: 200 con la lista vacía y ami:false', async () => {
    const r = await api('GET', '/api/salas/directorio/live', { token: admin });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ami, false);
    assert.deepEqual(r.json.participantes, []);
    assert.equal((await api('GET', '/api/salas/nohay/live', { token: admin })).status, 404);
  });

  await t.test('expulsar sin Asterisk: 503, y un canal con cabeceras AMI: 400', async () => {
    /* Con el AMI caído no se puede saber quién está en la sala, así que no se expulsa a
     * ciegas: 503. Con Asterisk arriba y un canal ajeno la respuesta es 404. */
    assert.equal((await api('POST', '/api/salas/directorio/kick', { token: admin, body: { canal: 'PJSIP/1001-00000001' } })).status, 503);
    // Un canal con salto de línea es inyección de cabeceras AMI: se rechaza antes de mirar la sala.
    assert.equal((await api('POST', '/api/salas/directorio/kick', { token: admin, body: { canal: 'PJSIP/1001\r\nAction: Command' } })).status, 400);
  });

  await t.test('invitación sin SMTP configurado: 400 en español', async () => {
    const r = await api('POST', '/api/salas/directorio/invitar', { token: admin, body: { destinatarios: ['alguien@ejemplo.test'] } });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, /SMTP/);
    // Y una dirección inválida ni siquiera llega a mirar el SMTP.
    assert.equal((await api('POST', '/api/salas/directorio/invitar', { token: admin, body: { destinatarios: ['no-es-correo'] } })).status, 400);
  });

  await t.test('permisos: el supervisor ve y modera, no configura', async () => {
    const alta = await api('POST', '/api/users', { token: admin, body: { username: 'sup', password: 'sup12345', role: 'supervisor' } });
    assert.ok(alta.status === 201 || alta.status === 200, JSON.stringify(alta.json));
    const sup = (await login('sup', 'sup12345')).token;
    const lista = await api('GET', '/api/salas', { token: sup });
    assert.equal(lista.status, 200);
    /* El listado NO puede traer los PIN: con el de moderador el supervisor entra a la
     * reunión de directorio, silencia y expulsa, y no queda rastro de que lo sacó de ahí. */
    assert.equal(lista.json[0].pin, undefined, JSON.stringify(lista.json[0]));
    assert.equal(lista.json[0].pin_mod, undefined, JSON.stringify(lista.json[0]));
    assert.equal(lista.json[0].tiene_pin, true);
    // Y el detalle, que sí los trae, es admin.
    assert.equal((await api('GET', '/api/salas/directorio', { token: sup })).status, 403);
    const det = await api('GET', '/api/salas/directorio', { token: admin });
    assert.equal(det.status, 200, JSON.stringify(det.json));
    assert.match(det.json.pin_mod, /^\d{4,10}$/);
    assert.equal((await api('GET', '/api/salas/no-existe', { token: admin })).status, 404);
    assert.equal((await api('GET', '/api/salas/directorio/live', { token: sup })).status, 200);
    assert.equal((await api('POST', '/api/salas', { token: sup, body: { name: 'x', access_exten: '9009' } })).status, 403);
    assert.equal((await api('DELETE', '/api/salas/directorio', { token: sup })).status, 403);
    // Invitar manda el PIN por correo: es configuración, no operación.
    assert.equal((await api('POST', '/api/salas/directorio/invitar', { token: sup, body: { destinatarios: ['a@b.test'] } })).status, 403);
  });

  await t.test('baja: se va la fila y el dialplan', async () => {
    assert.equal((await api('DELETE', '/api/salas/directorio', { token: admin })).status, 200);
    assert.equal((await dp(ctx, '9002')).length, 0);
    assert.equal((await api('GET', '/api/salas', { token: admin })).json.length, 0);
    assert.equal((await api('DELETE', '/api/salas/directorio', { token: admin })).status, 404);
  });
});
