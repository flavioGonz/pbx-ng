/* ============================================================================
 *  Integración · salas de reunión con Asterisk y correo de mentira (salas.js).
 *
 *  La prueba principal (salas.test.js) corre sin AMI: sabe que la vista en vivo dice
 *  «ami:false» y que expulsar da 503. Acá hay un AMI que contesta ConfbridgeList con
 *  gente adentro, un SMTP que recibe las invitaciones y los eventos de Confbridge que
 *  arman el historial: lo que se mira es que el PIN de moderador viaje sólo a quien
 *  modera, que no se pueda expulsar a alguien que no está en la sala, y que el historial
 *  cuente la reunión como pasó.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { smtpFalso } = require('./helpers/smtp-falso');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 4000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(60); } return fn(); }

test('salas en vivo: participantes, moderar, invitar, enlace web, entrada de moderador e historial', async (t) => {
  const ami = await amiFalso();
  const smtp = await smtpFalso();
  t.after(async () => { await ami.cerrar(); await smtp.cerrar(); });
  const ctx = await entorno(t, ami.env);
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  const s = await api('POST', '/api/salas', { token: admin, body: { name: 'directorio', label: 'Directorio', access_exten: '9001', grabar: true, video: true } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  const det = (await api('GET', '/api/salas/directorio', { token: admin })).json;

  const adentro = [
    { Event: 'ConfbridgeList', Conference: 'directorio', Channel: 'PJSIP/2001-01', CallerIDNum: '2001', CallerIDName: 'Ana', Admin: 'Yes', MuteStatus: 'No', AnsweredTime: '30' },
    { Event: 'ConfbridgeList', Conference: 'directorio', Channel: 'PJSIP/2002-02', CallerIDNum: '2002', CallerIDName: 'Beto', Admin: 'No', Muted: 'Yes', WaitMarked: 'Yes' },
  ];
  ami.lista('ConfbridgeList', adentro, 'ConfbridgeListComplete');
  ami.lista('ConfbridgeListRooms', [{ Event: 'ConfbridgeListRooms', Conference: 'directorio', Parties: '2' }], 'ConfbridgeListRoomsComplete');

  await t.test('vista en vivo y la lista con cuántos hay adentro', async () => {
    const v = (await api('GET', '/api/salas/directorio/live', { token: admin })).json;
    assert.equal(v.ami, true);
    assert.equal(v.grabando, true);
    assert.deepEqual(v.participantes.map((p) => [p.numero, p.moderador, p.mudo, p.esperando]), [['2001', true, false, false], ['2002', false, true, true]]);
    const l = (await api('GET', '/api/salas', { token: admin })).json;
    assert.equal(l.find((x) => x.name === 'directorio').participantes, 2);
    assert.equal((await api('GET', '/api/salas/no-existe/live', { token: admin })).status, 404);
  });

  await t.test('silenciar y expulsar sólo a quien está en la sala', async () => {
    ami.olvidar();
    const m = await api('POST', '/api/salas/directorio/mute', { token: admin, body: { canal: 'PJSIP/2002-02' } });
    assert.deepEqual(m.json, { ok: true, canal: 'PJSIP/2002-02', mudo: true });
    assert.equal(ami.pedidos('ConfbridgeMute')[0].channel, 'PJSIP/2002-02');
    await api('POST', '/api/salas/directorio/mute', { token: admin, body: { canal: 'PJSIP/2002-02', mudo: false } });
    assert.equal(ami.pedidos('ConfbridgeUnmute').length, 1);
    assert.equal((await api('POST', '/api/salas/directorio/kick', { token: admin, body: { canal: 'PJSIP/2099-09' } })).status, 404, 'un canal que no está en la sala no se toca');
    assert.equal((await api('POST', '/api/salas/directorio/kick', { token: admin, body: { canal: 'PJSIP/2001-01' } })).json.ok, true);
    assert.equal(ami.pedidos('ConfbridgeKick')[0].channel, 'PJSIP/2001-01');
    assert.equal((await api('POST', '/api/salas/no-existe/mute', { token: admin, body: { canal: 'x' } })).status, 404);
    assert.equal((await api('POST', '/api/salas/no-existe/kick', { token: admin, body: { canal: 'x' } })).status, 404);
  });

  await t.test('invitar: validaciones, un correo por persona y el PIN de moderador sólo al moderador', async () => {
    assert.equal((await api('POST', '/api/salas/no-existe/invitar', { token: admin, body: {} })).status, 404);
    assert.equal((await api('POST', '/api/salas/directorio/invitar', { token: admin, body: {} })).status, 400);
    assert.equal((await api('POST', '/api/salas/directorio/invitar', { token: admin, body: { destinatarios: 'no-es-correo' } })).status, 400);
    assert.equal((await api('POST', '/api/salas/directorio/invitar', { token: admin, body: { destinatarios: Array.from({ length: 51 }, (_, i) => i + '@x.uy') } })).status, 400);
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: smtp.host, port: smtp.port, from_addr: 'central@ejemplo.uy', enabled: true } });
    await ctx.db.query("INSERT INTO pbxng_settings (key,value) VALUES ('domain','pbx.ejemplo.uy'),('sala_numero_externo','+598 2900 0000') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    await api('POST', '/api/salas/directorio/enlace', { token: admin });
    smtp.olvidar();
    const r = await api('POST', '/api/salas/directorio/invitar', { token: admin, body: { destinatarios: 'a@x.uy; b@x.uy', mensaje: 'Traer el balance' } });
    assert.deepEqual(r.json.enviados, ['a@x.uy', 'b@x.uy']);
    const ms = await smtp.esperar(2);
    assert.equal(ms.length, 2, 'un correo por destinatario');
    const cuerpo = ms[0].data.replace(/=\r?\n/g, '');
    assert.ok(cuerpo.includes(det.pin), 'el participante recibe su PIN');
    assert.equal(cuerpo.includes(det.pin_mod), false, 'el PIN de moderador no viaja a un participante');
    assert.match(cuerpo, /pbx\.ejemplo\.uy\/sala\//, 'con enlace web, el correo lo trae');
    smtp.olvidar();
    await api('POST', '/api/salas/directorio/invitar', { token: admin, body: { destinatarios: ['mod@x.uy'], moderador: true } });
    const [mm] = await smtp.esperar(1);
    const c2 = mm.data.replace(/=\r?\n/g, '');
    assert.ok(c2.includes(det.pin_mod));
    assert.doesNotMatch(c2, /\/sala\//, 'al moderador no se le manda el enlace: entra con su PIN');
    const inv = (await api('GET', '/api/salas/directorio', { token: admin })).json.invitados;
    assert.equal(inv.length, 3);
    smtp.rechazar();
    await api('POST', '/api/email/config', { token: admin, body: { tenant_id: 1, host: smtp.host, port: smtp.port, username: 'u', password: 'p', from_addr: 'central@ejemplo.uy', enabled: true } });
    const mal = await api('POST', '/api/salas/directorio/invitar', { token: admin, body: { destinatarios: 'c@x.uy' } });
    assert.equal(mal.status, 502, 'si no salió ninguno, se dice');
    assert.equal(mal.json.fallados[0].destino, 'c@x.uy');
  });

  await t.test('enlace web: público sin PIN, sesión de invitado, tope y agenda cerrada', async () => {
    const e = await api('POST', '/api/salas/directorio/enlace', { token: admin });
    assert.match(e.json.url, /^https:\/\/pbx\.ejemplo\.uy\/sala\//);
    const pub = await api('GET', '/api/salas/web/' + e.json.token);
    assert.deepEqual(Object.keys(pub.json).sort(), ['abierta', 'agenda_inicio', 'agenda_min', 'sala', 'video']);
    assert.equal(JSON.stringify(pub.json).includes(det.pin), false);
    assert.equal((await api('GET', '/api/salas/web/no-existe')).status, 404);
    const ses = await api('POST', '/api/salas/web/' + e.json.token + '/session', { body: { name: 'Carla <x>' } });
    assert.equal(ses.status, 200, JSON.stringify(ses.json));
    assert.equal(ses.json.video, true);
    const dp = (await ctx.db.query('SELECT app, appdata FROM extensions WHERE context=$1 ORDER BY priority', ['c2c_' + ses.json.session])).rows;
    assert.equal(dp[1].appdata, 'CALLERID(name)=Carla x');
    assert.match(dp[4].appdata, /^ivr,9001,/);
    assert.equal((await api('POST', '/api/salas/web/no-existe/session', { body: {} })).status, 404);
    await ctx.db.query("UPDATE pbxng_conferences SET agenda_inicio = now() + interval '2 days', agenda_min = 30 WHERE name='directorio'");
    assert.equal((await api('POST', '/api/salas/web/' + e.json.token + '/session', { body: {} })).status, 409, 'la agenda vale también para la web');
    await ctx.db.query("UPDATE pbxng_conferences SET agenda_inicio = NULL WHERE name='directorio'");
    assert.equal((await api('DELETE', '/api/salas/directorio/enlace', { token: admin })).json.ok, true);
    assert.equal((await api('DELETE', '/api/salas/no-existe/enlace', { token: admin })).status, 404);
    assert.equal((await api('POST', '/api/salas/no-existe/enlace', { token: admin })).status, 404);
  });

  await t.test('entrar como moderador: crea el enlace si falta, y la entrada es de un solo uso', async () => {
    assert.equal((await api('POST', '/api/salas/no-existe/moderar', { token: admin })).status, 404);
    const m = await api('POST', '/api/salas/directorio/moderar', { token: admin });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    const id = new URL('http://x' + m.json.url).searchParams.get('e');
    const e1 = await api('POST', '/api/salas/entrada/' + id);
    assert.equal(e1.json.moderador, true);
    assert.equal(e1.json.sala, 'Directorio');
    assert.equal((await api('POST', '/api/salas/entrada/' + id)).status, 404, 'la misma entrada no sirve dos veces');
    assert.equal((await api('POST', '/api/salas/entrada/inventada')).status, 404);
  });

  await t.test('historial: los eventos de Confbridge cuentan la reunión', async () => {
    ami.emitir({ Event: 'ConfbridgeJoin', Conference: 'directorio', Channel: 'PJSIP/2001-11', CallerIDNum: '2001', CallerIDName: 'Ana', Admin: 'Yes' });
    ami.emitir({ Event: 'ConfbridgeJoin', Conference: 'directorio', Channel: 'PJSIP/c2cabc-12', CallerIDNum: 'c2cabc', CallerIDName: 'Carla', Admin: 'No' });
    ami.emitir({ Event: 'ConfbridgeJoin', Conference: 'otra-que-no-es-nuestra', Channel: 'PJSIP/9-1' });
    ami.emitir({ Event: 'ConfbridgeJoin', Conference: '' });
    await dormir(300);
    ami.emitir({ Event: 'ConfbridgeLeave', Conference: 'directorio', Channel: 'PJSIP/c2cabc-12' });
    ami.emitir({ Event: 'ConfbridgeLeave', Conference: 'directorio' });
    await dormir(200);
    ami.emitir({ Event: 'ConfbridgeEnd', Conference: 'directorio' });
    ami.emitir({ Event: 'ConfbridgeEnd' });
    const h = await hasta(async () => { const r = (await api('GET', '/api/salas/directorio/historial?limite=500', { token: admin })).json; return r.length && r[0].fin ? r : null; });
    assert.ok(h, 'no se cerró la reunión');
    assert.equal(h[0].pico, 2);
    assert.equal(h[0].grabada, true);
    const p = h[0].participantes;
    assert.deepEqual(p.map((x) => [x.numero, x.moderador, x.web]), [['2001', true, false], ['c2cabc', false, true]]);
    assert.ok(p.every((x) => x.salio));
    assert.deepEqual((await api('GET', '/api/salas/no-existe/historial', { token: admin })).json, []);
  });
});
