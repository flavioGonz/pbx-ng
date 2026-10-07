/* ============================================================================
 *  Integración · las rutas de sistema de app.js con un Asterisk y unos agentes de
 *  mentira del otro lado.
 *
 *  Hasta ahora estas rutas sólo se probaban con el AMI apagado, así que lo único que se
 *  sabía es que no se caían. Acá hay un AMI que contesta (test/helpers/ami-falso.js) y
 *  un agente HTTP que contesta (test/helpers/http-falso.js): lo que se mira es que la
 *  API interprete bien lo que le dicen, y que cuando le dicen algo malo lo diga.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { httpFalso, crudo } = require('./helpers/http-falso');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 5000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(100); }
  return fn();
}

test('sistema: Asterisk, red, capturas, módulos y tableros con AMI y agentes falsos', async (t) => {
  const ami = await amiFalso();
  const agente = await httpFalso();
  const turn = await httpFalso();
  t.after(async () => { await ami.cerrar(); await agente.cerrar(); await turn.cerrar(); });
  const ctx = await entorno(t, Object.assign({}, ami.env, { AST_AGENT: agente.url, TURN_AGENT: turn.url }));
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();

  await t.test('/health/ready dice ok con la base y el AMI arriba', async () => {
    const r = await api('GET', '/health/ready');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.ami, true);
  });

  await t.test('/api/system lee la versión, los transportes y los módulos del AMI', async () => {
    ami.comando(/^core show version/, 'Asterisk 22.1.0 built by root');
    ami.comando(/^pjsip show transports/, 'transport-udp udp 0.0.0.0:5060\ntransport-ws ws 0.0.0.0:8088');
    ami.comando(/^module show/, 'res_pjsip.so\nres_srtp.so\napp_queue.so\ncdr_pgsql.so');
    const r = await api('GET', '/api/system', { token: admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.asterisk, '22.1.0');
    const c = (n) => r.json.components.find((x) => x.name === n).status;
    assert.equal(c('Asterisk'), 'ok');
    assert.equal(c('PJSIP (chan_pjsip)'), 'ok');
    assert.equal(c('SRTP (cifrado de medios)'), 'ok');
    assert.equal(c('Buzon de voz'), 'off', 'un módulo que no está cargado se muestra apagado');
    assert.equal(c('SIP UDP 5060'), 'ok');
    assert.equal(c('Transporte WebSocket (ws)'), 'ok');
    assert.equal(c('PostgreSQL'), 'ok');
  });

  await t.test('/api/wallboard: llamadas de hoy y las colas leídas de `queue show`', async () => {
    ami.comando(/^queue show/, [
      "ventas has 2 calls (max unlimited) in 'ringall' strategy (12s holdtime, 95s talktime), W:0, C:40, A:3, SL:0.0%, SL2:0.0% within 0s",
      '   Members:',
      "soporte has 0 calls (max 5) in 'leastrecent' strategy (0s holdtime, 0s talktime), W:0, C:0, A:0, SL:0.0%",
    ].join('\n'));
    const r = await api('GET', '/api/wallboard', { token: admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.today.total, 0);
    assert.equal(r.json.today.outbound, 0);
    assert.deepEqual(r.json.queues.map((q) => [q.name, q.waiting, q.strategy, q.holdtime, q.completed, q.abandoned]),
      [['ventas', 2, 'ringall', 12, 40, 3], ['soporte', 0, 'leastrecent', 0, 0, 0]]);
  });

  await t.test('consola de Asterisk: sólo comandos de lectura', async () => {
    ami.comando(/^pjsip show endpoints/, 'Endpoint: 2001');
    const ok = await api('POST', '/api/asterisk/cli', { token: admin, body: { cmd: 'pjsip show endpoints' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.output, 'Endpoint: 2001');
    assert.equal((await api('POST', '/api/asterisk/cli', { token: admin, body: {} })).status, 400);
    const prohibido = await api('POST', '/api/asterisk/cli', { token: admin, body: { cmd: 'core restart now' } });
    assert.equal(prohibido.status, 403);
    assert.match(prohibido.json.error, /Solo lectura/);
  });

  await t.test('colgar un canal: pide el canal y le manda Hangup al AMI', async () => {
    assert.equal((await api('POST', '/api/asterisk/hangup', { token: admin, body: {} })).status, 400);
    ami.olvidar();
    const r = await api('POST', '/api/asterisk/hangup', { token: admin, body: { channel: 'PJSIP/2001-0001' } });
    assert.equal(r.status, 200);
    assert.equal(ami.pedidos('Hangup')[0].channel, 'PJSIP/2001-0001');
    ami.accion('Hangup', { Response: 'Error', Message: 'No such channel' });
    assert.equal((await api('POST', '/api/asterisk/hangup', { token: admin, body: { channel: 'PJSIP/x' } })).status, 500);
  });

  await t.test('dialplan y grupos de captura', async () => {
    ami.comando(/^dialplan show internal/, "[ Context 'internal' created by 'pbx_realtime' ]");
    const d = await api('GET', '/api/dialplan?context=internal', { token: admin });
    assert.match(d.json.output, /Context 'internal'/);
    assert.equal((await api('POST', '/api/endpoints', { token: admin, body: { id: '2001', password: 'Clave-2001-xx' } })).status, 201);
    ami.olvidar();
    const g = await api('PUT', '/api/pickup-groups/2001', { token: admin, body: { grupo: 'ventas;rm -rf' } });
    assert.equal(g.status, 200);
    assert.equal(g.json.grupo, 'ventasrm-rf', 'lo que no es letra, número, punto o guión no llega a Asterisk');
    assert.ok(ami.pedidos('Command').some((c) => c.command === 'module reload res_pjsip.so'));
    const lista = await api('GET', '/api/pickup-groups', { token: admin });
    assert.equal(lista.json.find((x) => x.ext === '2001').named_pickup_group, 'ventasrm-rf');
    const vacio = await api('PUT', '/api/pickup-groups/2001', { token: admin, body: {} });
    assert.equal(vacio.json.grupo, null);
  });

  await t.test('modo de red: plan, aplicar con commit-confirm, confirmar y revertir', async () => {
    agente.ruta('GET', '/net', { ifaces: [{ name: 'eth0' }, { name: 'eth1', rol: 'lan' }, { name: 'eth2', rol: 'lan' }] });
    agente.ruta('POST', '/netmode', (p) => ({ ok: true, pasos: p.body.pasos.map((x) => ({ ...x, ok: true })) }));

    const v = await api('GET', '/api/net/mode', { token: admin });
    assert.equal(v.status, 200);
    assert.equal(v.json.interfaces.length, 3);
    assert.equal(v.json.pendiente, null);

    assert.equal((await api('PUT', '/api/net/mode', { token: admin, body: { modo: 'puente' } })).status, 400);
    assert.equal((await api('PUT', '/api/net/mode', { token: admin, body: { modo: 'router', wan_if: 'eth0', lan_if: 'eth1', nat: true, forward: false } })).status, 200);

    const plan = await api('POST', '/api/net/mode/plan', { token: admin, body: {} });
    assert.equal(plan.status, 200);
    assert.ok(plan.json.pasos.some((p) => /masquerade/.test(p.texto)));
    const malo = await api('POST', '/api/net/mode/plan', { token: admin, body: { lan_if: 'eth0' } });
    assert.equal(malo.status, 400);
    assert.match(malo.json.error, /misma placa/);

    assert.equal((await api('POST', '/api/net/mode/apply', { token: admin, body: {} })).status, 400, 'sin confirmar no se aplica');
    agente.olvidar();
    const ap = await api('POST', '/api/net/mode/apply', { token: admin, body: { confirmar: true, rollback_seg: 5, cfg: { modo: 'switch' } } });
    assert.equal(ap.status, 200, JSON.stringify(ap.json));
    assert.equal(ap.json.modo, 'switch');
    assert.equal(ap.json.rollback_seg, 30, 'el plazo mínimo es 30 s');
    assert.ok(agente.pedidos('/netmode')[0].body.pasos.some((p) => /type bridge/.test(p.texto)));
    assert.ok((await api('GET', '/api/net/mode', { token: admin })).json.pendiente);

    const conf = await api('POST', '/api/net/mode/confirm', { token: admin });
    assert.equal(conf.json.confirmado, true);
    const nada = await api('POST', '/api/net/mode/confirm', { token: admin });
    assert.match(nada.json.nota, /nada pendiente/);
    assert.equal((await api('POST', '/api/net/mode/revert', { token: admin })).status, 400, 'sin cambio pendiente no hay qué revertir');

    /* Aplicar de nuevo y revertir a mano: vuelve al modo anterior (switch). */
    await api('POST', '/api/net/mode/apply', { token: admin, body: { confirmar: true, cfg: { modo: 'router', wan_if: 'eth0', lan_if: 'eth1' } } });
    const rev = await api('POST', '/api/net/mode/revert', { token: admin });
    assert.equal(rev.status, 200);
    assert.equal(rev.json.modo, 'switch');
    assert.equal(rev.json.ok, true);

    /* El agente que falla al aplicar: se informa y la base no cambia. */
    agente.ruta('POST', '/netmode', { ok: false, fallo: 'nft no está', pasos: [] });
    const falla = await api('POST', '/api/net/mode/apply', { token: admin, body: { confirmar: true } });
    assert.equal(falla.status, 500);
    assert.match(falla.json.error, /nft no está/);
    assert.equal((await api('GET', '/api/net/mode', { token: admin })).json.cfg.modo, 'switch');
  });

  await t.test('consola del agente de Asterisk: core, net, route, diag e iface se reenvían con el token', async () => {
    agente.ruta('GET', '/core', { version: '22' });
    agente.ruta('POST', '/route', (p) => ({ eco: p.body }));
    agente.ruta('POST', '/diag', { ok: true });
    agente.ruta('POST', '/iface', { ok: true });
    agente.olvidar();
    assert.deepEqual((await api('GET', '/api/asterisk/core', { token: admin })).json, { version: '22' });
    assert.equal((await api('GET', '/api/asterisk/net', { token: admin })).json.ifaces.length, 3);
    assert.deepEqual((await api('POST', '/api/asterisk/route', { token: admin, body: { a: 1 } })).json, { eco: { a: 1 } });
    assert.equal((await api('POST', '/api/asterisk/diag', { token: admin })).json.ok, true);
    assert.equal((await api('POST', '/api/asterisk/iface', { token: admin })).json.ok, true);
    const tok = fs.readFileSync(path.join(ctx.api.confDir, 'agent.token'), 'utf8').trim();
    assert.ok(agente.pedidos().every((p) => p.headers['x-pbxng-token'] === tok), 'todo pedido al agente lleva su token');
    agente.ruta('GET', '/core', crudo(200, 'esto no es json'));
    assert.equal((await api('GET', '/api/asterisk/core', { token: admin })).status, 500);
  });

  await t.test('capturas de paquetes: arrancar, terminar, bajar, parar y borrar', async () => {
    const pcap = Buffer.from('d4c3b2a1-captura-de-prueba');
    agente.ruta('POST', '/capture', (p) => ({ b64: pcap.toString('base64'), bpf: p.body.bpf }));
    const r = await api('POST', '/api/capture/start', { token: admin, body: { preset: 'siprtp', duration: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.preset, 'siprtp');
    assert.equal(r.json.duration, 3, 'el mínimo son 3 s');
    const fila = await hasta(async () => (await api('GET', '/api/capture/list', { token: admin })).json.find((c) => c.id === r.json.id && c.status === 'done'));
    assert.ok(fila, 'la captura no terminó');
    assert.equal(Number(fila.size), pcap.length);
    assert.equal(agente.pedidos('/capture')[0].body.bpf, 'udp');

    const res = await fetch(ctx.api.base + '/api/capture/' + r.json.id + '/download', { headers: { Authorization: 'Bearer ' + admin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.tcpdump.pcap');
    assert.match(res.headers.get('content-disposition'), /pbxng-asterisk-siprtp-.*\.pcap/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), pcap);
    assert.equal((await api('GET', '/api/capture/999999/download', { token: admin })).status, 404);

    /* El agente que contesta con error deja la captura en error con el motivo. */
    agente.ruta('POST', '/capture', { error: 'tcpdump no está instalado' });
    const mal = await api('POST', '/api/capture/start', { token: admin, body: { preset: 'cualquiera' } });
    assert.equal(mal.json.preset, 'sip', 'un preset desconocido cae en sip');
    const err = await hasta(async () => (await api('GET', '/api/capture/list', { token: admin })).json.find((c) => c.id === mal.json.id && c.status === 'error'));
    assert.match(err.error, /tcpdump no está instalado/);
    agente.ruta('POST', '/capture', crudo(502, 'bad gateway'));
    const http502 = await api('POST', '/api/capture/start', { token: admin, body: {} });
    const e502 = await hasta(async () => (await api('GET', '/api/capture/list', { token: admin })).json.find((c) => c.id === http502.json.id && c.status === 'error'));
    assert.match(e502.error, /HTTP 502/);

    assert.equal((await api('POST', '/api/capture/' + mal.json.id + '/stop', { token: admin })).json.ok, true);
    assert.equal((await api('DELETE', '/api/capture/' + mal.json.id, { token: admin })).json.ok, true);
    assert.equal((await api('GET', '/api/capture/list', { token: admin })).json.some((c) => c.id === mal.json.id), false);
  });

  await t.test('módulos: encender TURN le avisa al agente de coturn; uno inventado es 400', async () => {
    const lista = await api('GET', '/api/modules', { token: admin });
    assert.equal(lista.json.sbc, false, 'el módulo de SBC nace apagado');
    assert.equal(lista.json.turn, true);
    turn.ruta('POST', '/service', (p) => ({ ok: true, action: p.body.action }));
    const r = await api('POST', '/api/modules', { token: admin, body: { id: 'turn', enabled: false } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.svc, { ok: true, action: 'stop' });
    assert.equal((await api('GET', '/api/modules', { token: admin })).json.turn, false);
    turn.ruta('POST', '/service', crudo(500, 'no es json'));
    const caido = await api('POST', '/api/modules', { token: admin, body: { id: 'turn', enabled: true } });
    assert.ok(caido.json.svc.error, 'si el agente no contesta bien se dice, pero el módulo queda guardado');
    assert.equal((await api('POST', '/api/modules', { token: admin, body: { id: 'sbc', enabled: true } })).json.enabled, true);
    assert.equal((await api('POST', '/api/modules', { token: admin, body: { id: 'inventado', enabled: true } })).status, 400);
  });

  await t.test('base de datos, métricas y topología', async () => {
    const db = await api('GET', '/api/db', { token: admin });
    assert.equal(db.status, 200);
    assert.match(db.json.version, /PostgreSQL/);
    assert.ok(db.json.tables.length > 10);
    assert.ok(db.json.conn.max > 0);
    assert.equal((await api('POST', '/api/db/maintenance', { token: admin, body: { table: 'pbxng_settings' } })).json.ok, true);
    assert.equal((await api('POST', '/api/db/maintenance', { token: admin, body: { table: 'x; DROP TABLE y' } })).json.ok, true, 'un nombre raro hace el VACUUM general, no el inyectado');
    const m = await api('GET', '/api/metrics', { token: admin });
    assert.ok(m.json.cores > 0);
    assert.ok(m.json.mem.total > 0);
    const topo = await api('GET', '/api/topology', { token: admin });
    assert.equal(topo.status, 200);
    assert.ok(Array.isArray(topo.json.componentes));
    assert.equal(topo.json.sbc.enabled, true);
  });

  await t.test('pausa del agente: sin interno es 400; con interno pausa en el AMI y en la base', async () => {
    assert.equal((await api('POST', '/api/agent/pause', { token: admin, body: { paused: true } })).status, 400);
    const sinExt = await api('GET', '/api/agent/state', { token: admin });
    assert.deepEqual(sinExt.json, { ext: null, paused: false, inQueue: false, queues: [] });
    assert.equal((await api('POST', '/api/users', { token: admin, body: { username: 'ana', password: 'Clave-ana-1234', role: 'agente', ext: '2001' } })).status, 201);
    const ana = (await login('ana', 'Clave-ana-1234')).token;
    await ctx.db.query("INSERT INTO queue_members (uniqueid, queue_name, interface, membername, paused) VALUES (92001,'ventas','PJSIP/2001','Ana',0)");
    ami.olvidar();
    const p = await api('POST', '/api/agent/pause', { token: ana, body: { paused: true, reason: 'Almuerzo' } });
    assert.deepEqual(p.json, { ext: '2001', paused: true });
    const qp = ami.pedidos('QueuePause')[0];
    assert.equal(qp.interface, 'PJSIP/2001');
    assert.equal(qp.paused, 'true');
    assert.equal(qp.reason, 'Almuerzo');
    const st = await api('GET', '/api/agent/state', { token: ana });
    assert.deepEqual(st.json, { ext: '2001', paused: true, inQueue: true, queues: ['ventas'] });
    await api('POST', '/api/agent/pause', { token: ana, body: {} });
    assert.equal((await api('GET', '/api/agent/state', { token: ana })).json.paused, false);
  });

  await t.test('un evento DialBegin del AMI dispara la notificación de llamada entrante una sola vez', async () => {
    /* El push no tiene suscriptores, pero el evento saliente queda en el outbox: es la
     * parte observable. Dos DialBegin de la misma llamada = un solo evento. */
    const antes = (await ctx.db.query("SELECT count(*)::int n FROM pbxng_outbox WHERE tipo='llamada.entrante'").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    const ev = { Event: 'DialBegin', DestChannel: 'PJSIP/2001-00000001', CallerIDNum: '099123456', CallerIDName: 'Juan', Linkedid: '1700.1', DestUniqueid: '1700.2', Context: 'from-trunk' };
    ami.emitir(ev); ami.emitir(ev);
    ami.emitir({ Event: 'DialBegin', DestChannel: 'Local/xx' });
    const n = await hasta(async () => {
      const r = await ctx.db.query("SELECT count(*)::int n FROM pbxng_outbox WHERE tipo='llamada.entrante'").catch(() => null);
      return r && r.rows[0].n > antes ? r.rows[0].n : 0;
    }, 3000);
    if (n) assert.equal(n - antes, 1, 'la misma llamada no se notifica dos veces');
  });
});
