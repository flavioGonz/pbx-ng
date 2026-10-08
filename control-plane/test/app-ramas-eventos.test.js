/* ============================================================================
 *  Integración · lo que llega por los eventos de Asterisk a app.js, con datos
 *  incompletos o con Asterisk contestando mal.
 *
 *  app-ari y app-extra prueban los eventos bien formados. En una central real llegan
 *  también los otros: un DialBegin sin canal destino o sin número de origen, un Hangup
 *  sin uniqueid, un ContactStatus sin AOR, un StasisStart sin argumentos, un agente de IA
 *  pedido con un id que no es un número, la conferencia a tres cuando ARI no puede listar
 *  los puentes, una lista del AMI que nunca cierra o que contesta error. Lo que se fija es
 *  que la API no se caiga, no repita avisos y diga lo que pasó en el lugar correcto (el
 *  outbox, el push, la respuesta HTTP). También el directorio con alguien EN llamada y la
 *  poda del dedup cuando hay muchas llamadas en vuelo.
 *
 *  Asterisk es de mentira: helpers/ari-falso.js (REST + WebSocket) y helpers/ami-falso.js.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { ariFalso } = require('./helpers/ari-falso');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 5000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(50); } return fn(); }

/* Socket.io a mano (Engine.IO v4 sobre ws). `conectar` = lo que se manda como CONNECT:
 * null manda el paquete sin cuerpo (un cliente que no dice nada de auth). */
function socketPanel(base, conectar, headers) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket', { headers: headers || {} });
  let conectado = null, rechazo = null;
  const listo = new Promise((ok) => {
    ws.on('message', (d) => {
      const s = String(d);
      if (s[0] === '0') ws.send(conectar === null ? '40' : '40' + JSON.stringify(conectar));
      else if (s.startsWith('40')) { conectado = true; ok(); }
      else if (s.startsWith('44')) { rechazo = JSON.parse(s.slice(2)); ok(); }
    });
    ws.on('unexpected-response', (_q, r) => { rechazo = { status: r.statusCode }; ok(); });
    ws.on('error', () => ok());
  });
  return { listo, get conectado() { return conectado; }, get rechazo() { return rechazo; }, cerrar: () => { try { ws.close(); } catch (_) {} } };
}

test('eventos de Asterisk incompletos o con errores: la API no se cae ni repite', async (t) => {
  const ami = await amiFalso();
  const ari = await ariFalso();
  const ctx = await entorno(t, Object.assign({}, ami.env, ari.env));
  t.after(async () => { if (ctx) await ctx.cerrar(); await ami.cerrar(); await ari.cerrar(); });
  if (!ctx) return;
  const t0 = Date.now();
  const { api, login, base } = ctx.api;
  const db = ctx.db;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  await ari.conectado();
  await hasta(async () => (await api('GET', '/health')).json.ari === true);
  for (const id of ['2001', '2002', '2003']) await api('POST', '/api/endpoints', { token: admin, body: { id, password: 'Clave-' + id + '-xx' } });
  const fono = (await api('POST', '/api/phone/token', { body: { ext: '2001', password: 'Clave-2001-xx' } })).json.token;
  assert.ok(fono, 'no salió el token del softphone');
  const outbox = async (tipo) => (await db.query('SELECT datos, call_id FROM pbxng_eventos_salida WHERE tipo=$1 ORDER BY secuencia', [tipo])).rows;
  /* Un DialBegin viejo para la poda del dedup del final (vence a los 8 s). */
  ami.emitir({ Event: 'DialBegin', DestChannel: 'PJSIP/2003-viejo', Linkedid: 'L-viejo' });

  await t.test('directorio: quien tiene un canal abierto figura en llamada', async () => {
    ari.interno({ resource: '2001', state: 'online', channel_ids: ['cx'] });
    ari.interno({ resource: '2002', state: 'online', channel_ids: [] });
    ari.canal({ id: 'cx', name: 'PJSIP/2001-000000aa', state: 'Up' });
    ari.emitir({ type: 'EndpointStateChange', endpoint: { technology: 'PJSIP', resource: '2001', state: 'online', channel_ids: ['cx'] } });
    ari.emitir({ type: 'EndpointStateChange', endpoint: { technology: 'PJSIP', resource: '2002', state: 'online', channel_ids: [] } });
    const dir = await hasta(async () => {
      const d = (await api('GET', '/api/directory', { token: fono })).json;
      const m = Object.fromEntries(d.map((x) => [x.ext, x.status]));
      return m['2001'] === 'in_call' && m['2002'] === 'online' ? m : null;
    });
    assert.ok(dir, 'el directorio no mostró a 2001 en llamada');
    assert.equal(dir['2003'], 'offline');
  });

  await t.test('conferencia a tres: sólo la propia llamada, sin poder listar puentes, y si ARI no crea el puente', async () => {
    const ajena = await api('POST', '/api/calls/conference', { token: fono, body: { ext: '2002', third: '2003' } });
    assert.equal(ajena.status, 403, 'el softphone de 2001 no arma conferencias con la llamada de 2002');
    ari.fallar('GET', '/bridges', 500);
    const r = await api('POST', '/api/calls/conference', { token: fono, body: { ext: '2001', third: '2003' } });
    assert.equal(r.status, 200, 'sin la lista de puentes igual se arma, sólo con la propia pata');
    const nuevo = ari.puentes.get(r.json.bridge);
    assert.deepEqual(nuevo.channels, ['cx']);
    ari.sanar();
    /* El tercero atiende pero no se lo puede responder ni sumar: queda anotado, no se cae. */
    const tercero = await hasta(() => [...ari.canales.values()].find((c) => /^PJSIP\/2003/.test(c.name)));
    ari.fallar('POST', '/channels/' + tercero.id + '/answer', 500);
    ari.fallar('POST', '/bridges/' + r.json.bridge + '/addChannel', 500);
    ari.olvidar();
    ari.stasis(tercero.id, ['conf']);
    assert.ok(await hasta(() => ari.pedidos('POST', new RegExp('/bridges/' + r.json.bridge + '/addChannel')).length), 'no intentó sumarlo');
    ari.sanar();
    /* Un puente que viene sin lista de canales no rompe la búsqueda del par. */
    ari.puentes.set('br-sin', { id: 'br-sin', bridge_type: 'mixing', technology: 'simple_bridge', bridge_class: 'base', creator: 'x', name: '' });
    ari.fallar('POST', '/bridges', 500);
    const sinPuente = await api('POST', '/api/calls/conference', { token: admin, body: { ext: '2001', third: '2003' } });
    assert.equal(sinPuente.status, 500);
    assert.ok(sinPuente.json.error);
    ari.sanar();
    ari.puentes.delete('br-sin');
  });

  await t.test('StasisStart sin argumentos y la IA pedida con un id ilegible o con un canal que no responde', async () => {
    const suelto = ari.canal({ name: 'PJSIP/2002-000000bb' });
    ari.olvidar();
    ari.emitir({ type: 'StasisStart', channel: suelto });   // sin `args`: no es de nadie
    await dormir(200);
    assert.equal(ari.pedidos('POST').length, 0, 'un StasisStart sin destino no toca el canal');

    const raro = ari.canal({ name: 'PJSIP/2002-000000cc', state: 'Ring' });
    ari.stasis(raro.id, ['ai', 'no-es-un-numero']);
    assert.ok(await hasta(() => ari.pedidos('POST', new RegExp('/channels/' + raro.id + '/play')).length), 'un id ilegible también se despide');
    assert.ok(await hasta(() => !ari.canales.has(raro.id), 3000), 'y corta');

    const sordo = ari.canal({ name: 'PJSIP/2002-000000dd', state: 'Ring' });
    ari.fallar('POST', '/channels/' + sordo.id + '/answer', 500);
    ari.fallar('DELETE', '/channels/' + sordo.id, 500);
    ari.olvidar();
    ari.stasis(sordo.id, ['ai', '424242']);
    assert.ok(await hasta(() => ari.pedidos('DELETE', new RegExp('/channels/' + sordo.id)).length, 3000), 'no intentó cortar');
    assert.equal((await api('GET', '/health')).status, 200, 'un canal que no responde ni se deja cortar no tumba la API');
    ari.sanar();
  });

  await t.test('eventos del AMI con campos faltantes: push, outbox y registro sin repetir', async () => {
    await db.query('DELETE FROM pbxng_eventos_salida');
    ami.emitir({ Event: 'DialBegin', DestChannel: 'Local/2001@x-0001' });                 // no es un interno PJSIP
    ami.emitir({ Event: 'DialBegin' });                                                    // sin canal destino
    ami.emitir({ Event: 'DialBegin', DestChannel: 'PJSIP/2002-0001', ConnectedLineNum: '0991' });   // sin linkedid ni callerid
    ami.emitir({ Event: 'DialBegin', DestChannel: 'PJSIP/2002-0001', ConnectedLineNum: '0991' });   // repetido
    ami.emitir({ Event: 'DialBegin', DestChannel: 'PJSIP/2003-0002', CallerIDNum: '0992', CallerIDName: 'Juan', Linkedid: 'L-2', DestUniqueid: 'D-2', Context: 'from-trunk' });
    const ent = await hasta(async () => { const r = await outbox('llamada.entrante'); return r.length >= 2 ? r : null; });
    assert.ok(ent, 'no salieron los eventos de llamada entrante');
    await dormir(200);
    const filas = await outbox('llamada.entrante');
    assert.equal(filas.length, 2, 'uno por llamada: ' + JSON.stringify(filas));
    const sin = filas.find((f) => f.datos.interno === '2002');
    assert.equal(sin.call_id, null);
    assert.equal(sin.datos.desde, '0991', 'sin CallerID se usa el número conectado');
    assert.equal(filas.find((f) => f.datos.interno === '2003').datos.contexto, 'from-trunk');

    ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2003-0002' });   // sin estado: no es nada
    ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2003-0002', DialStatus: 'answer', ConnectedLineNum: '0993' });   // sin linkedid
    ami.emitir({ Event: 'Hangup' });                                        // sin uniqueid
    ami.emitir({ Event: 'Hangup', Uniqueid: 'U-1' });                      // un tramo, no la llamada
    ami.emitir({ Event: 'Hangup', Uniqueid: 'L-9', Linkedid: 'L-9', 'Cause-txt': 'Normal Clearing' });
    ami.emitir({ Event: 'ContactStatus', ContactStatus: 'Reachable' });     // sin AOR
    ami.emitir({ Event: 'ContactStatus', AOR: '2002/sip:2002@x', ContactStatus: 'Removed' });
    ami.emitir({ Event: 'ContactStatus', AOR: '2002', ContactStatus: 'Created' });
    assert.ok(await hasta(async () => (await outbox('interno.registrado')).length >= 2));
    const reg = (await outbox('interno.registrado')).map((r) => [r.datos.interno, r.datos.registrado, r.datos.estado]);
    assert.deepEqual(reg, [['2002', false, 'removed'], ['2002', true, 'created']]);
    const fin = await hasta(async () => { const r = await outbox('llamada.terminada'); return r.length ? r : null; });
    assert.equal(fin[0].call_id, 'L-9');
    assert.deepEqual([fin[0].datos.canal, fin[0].datos.desde, fin[0].datos.causa, fin[0].datos.causa_txt], ['', '', '', 'Normal Clearing']);
    const cont = await hasta(async () => { const r = await outbox('llamada.contestada'); return r.length ? r : null; });
    assert.equal(cont[0].call_id, null);
    assert.equal(cont[0].datos.desde, '0993');
  });

  await t.test('listas del AMI: vacía, con error y sin cierre (aparcado)', async () => {
    ami.accion('ParkedCalls', { Response: 'Error', Message: 'no hay módulo' });
    const e = await api('GET', '/api/parking/lots', { token: admin });
    assert.equal(e.status, 200, 'un error del AMI deja la tabla con las plazas libres');
    ami.accion('ParkedCalls', { Response: 'Success', Message: 'sin cierre' });
    const t1 = Date.now();
    const sinCierre = await api('GET', '/api/parking/lots', { token: admin, timeout: 10000 });
    assert.equal(sinCierre.status, 200);
    assert.ok(Date.now() - t1 >= 3500, 'una lista que no cierra se corta por tiempo, no antes');
    ami.lista('ParkedCalls', [], 'ParkedCallsComplete');
    assert.equal((await api('GET', '/api/parking/lots', { token: admin })).status, 200);
  });

  await t.test('socket: un CONNECT sin auth no entra; un Origin sin host tampoco; el token del softphone sí', async () => {
    const mudo = socketPanel(base, null);
    await mudo.listo;
    assert.equal(mudo.conectado, null);
    assert.equal(mudo.rechazo.message, 'unauthorized');
    mudo.cerrar();
    const archivo = socketPanel(base, { token: admin }, { Origin: 'file://' });
    await archivo.listo;
    assert.equal(archivo.conectado, null, 'un Origin sin host no es el propio');
    archivo.cerrar();
    const trucho = socketPanel(base, { token: 'no-es-un-jwt', scratch: 'tampoco' });
    await trucho.listo;
    assert.equal(trucho.conectado, null, 'un token ilegible no entra');
    trucho.cerrar();
    const tel = socketPanel(base, { token: fono });
    await tel.listo;
    assert.equal(tel.conectado, true, 'el softphone entra (sólo a la pizarra)');
    tel.cerrar();
  });

  await t.test('muchas llamadas en vuelo: el dedup poda las viejas y no vuelve a avisar las nuevas', async () => {
    await dormir(Math.max(0, 8300 - (Date.now() - t0)));   // el DialBegin del principio ya venció
    await db.query('DELETE FROM pbxng_eventos_salida');
    for (let i = 0; i < 205; i++) ami.emitir({ Event: 'DialBegin', DestChannel: 'PJSIP/2003-' + i, CallerIDNum: '09' + i, Linkedid: 'LL-' + i });
    ami.emitir({ Event: 'DialBegin', DestChannel: 'PJSIP/2003-1', CallerIDNum: '091', Linkedid: 'LL-1' });   // repetida
    assert.ok(await hasta(async () => (await outbox('llamada.entrante')).length >= 205, 15000), 'no llegaron todas');
    await dormir(300);
    assert.equal((await outbox('llamada.entrante')).length, 205, 'pasar el tope no hace que se repitan');
  });

  await t.test('refresco del panel con la base trabada: un segundo evento no apila otro armado del estado', async () => {
    const lk = await db.pool.connect();
    try {
      await lk.query('BEGIN');
      await lk.query('LOCK TABLE ps_endpoints IN ACCESS EXCLUSIVE MODE');
      ami.emitir({ Event: 'Newchannel' });   // arranca un refresco que queda esperando la base
      await dormir(500);
      ami.emitir({ Event: 'Hangup' });       // el segundo llega con el primero en curso: se descarta
      await dormir(500);
    } finally { await lk.query('ROLLBACK').catch(() => {}); lk.release(); }
    assert.ok(await hasta(async () => (await api('GET', '/api/extensions', { token: admin })).status === 200), 'la API no se recuperó del lock');
  });

  await t.test('al apagarse con ARI conectado lo suelta (y la API sale limpia)', async () => {
    assert.equal((await api('GET', '/health')).json.ari, true);
    const comp = Object.fromEntries((await api('GET', '/api/system', { token: admin })).json.components.map((x) => [x.name, x.status]));
    assert.equal(comp['ARI / AMI'], 'ok', 'con los dos conectados el panel lo muestra sano');
    /* Una supervisión abierta al apagar: el cierre la corta (no queda un snoop huérfano en Asterisk). */
    const spy = await api('POST', '/api/calls/spy', { token: admin, body: { sup: '2002', target: '2001' } });
    assert.equal(spy.status, 200, JSON.stringify(spy.json));
    assert.equal((await api('GET', '/api/calls/spy', { token: admin })).json.length, 1);
    ari.olvidar();
  });
});
