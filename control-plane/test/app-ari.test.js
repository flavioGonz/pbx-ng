/* ============================================================================
 *  Integración · el motor de llamadas sobre ARI (callengine.js y lo de ARI en app.js)
 *  contra un Asterisk de mentira (helpers/ari-falso.js + helpers/ami-falso.js).
 *
 *  Hasta ahora las pruebas tenían ARI apagado: lo único que se sabía de estas rutas es
 *  que contestaban 503. Acá la API se conecta de verdad (ari-client contra el ARI falso),
 *  recibe eventos, y se mira lo que le pide a Asterisk: espiar con snoop, originar,
 *  retener, cortar por ARI y por AMI cuando ARI falla, la conferencia a tres, la IA que
 *  entra por StasisStart, y la reconexión cuando Asterisk pierde la app.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');
const { ariFalso } = require('./helpers/ari-falso');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 5000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(50); } return fn(); }

test('ARI: llamadas en vivo, supervisión, control, conferencia, IA y reconexión', async (t) => {
  const ami = await amiFalso();
  const ari = await ariFalso();
  t.after(async () => { await ami.cerrar(); await ari.cerrar(); });
  const ctx = await entorno(t, Object.assign({}, ami.env, ari.env));
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();
  await ari.conectado();
  await hasta(async () => (await api('GET', '/health')).json.ari === true);

  ari.interno({ resource: '2001', state: 'online', channel_ids: ['c1'] });
  ari.interno({ resource: '2002', state: 'offline' });
  const c1 = ari.canal({ id: 'c1', name: 'PJSIP/2001-00000001', state: 'Up', caller: { name: 'Ana', number: '2001' } });
  ari.canal({ id: 'c2', name: 'PJSIP/antel-00000002', state: 'Up', caller: { name: '', number: '099123456' } });
  ari.canal({ id: 'snoopx', name: 'Snoop/c1-0001' });

  await t.test('llamadas en vivo: los canales internos (Snoop, Local) no se muestran', async () => {
    const l = await hasta(async () => { const r = (await api('GET', '/api/calls/live', { token: admin })).json; return r.channels.length >= 2 ? r : null; });
    assert.ok(l, 'no aparecieron las llamadas');
    assert.equal(l.via, 'eventos');
    assert.deepEqual(l.channels.map((c) => c.ext).sort(), ['2001', 'antel']);
    assert.equal(l.channels.some((c) => /^Snoop/.test(c.name)), false);
    ari.emitir({ type: 'ChannelStateChange', channel: Object.assign({}, c1, { state: 'Ringing' }) });
    ari.emitir({ type: 'EndpointStateChange', endpoint: { technology: 'PJSIP', resource: '2002', state: 'online', channel_ids: [] } });
    ari.emitir({ type: 'DeviceStateChanged', device_state: { name: 'PJSIP/2002', state: 'NOT_INUSE' } });
    assert.ok(await hasta(async () => (await api('GET', '/api/calls/live', { token: admin })).json.channels.find((c) => c.id === 'c1').state === 'Ringing'));
    assert.equal((await api('GET', '/api/presence', { token: admin })).status, 200);
  });

  let spy;
  await t.test('supervisión: snoop sobre la llamada, el supervisor entra por Stasis, y se cierra sola al colgar', async () => {
    assert.equal((await api('POST', '/api/calls/spy', { token: admin, body: { sup: '2003' } })).status, 400);
    assert.equal((await api('POST', '/api/calls/spy', { token: admin, body: { sup: '2003', target: '2003' } })).status, 400);
    assert.equal((await api('POST', '/api/calls/spy', { token: admin, body: { sup: '2003', target: '2009' } })).status, 404);
    ari.olvidar();
    const r = await api('POST', '/api/calls/spy', { token: admin, body: { sup: '2003', target: '2001', mode: 'whisper' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    spy = r.json;
    assert.equal(spy.via, 'ari');
    const snoop = ari.pedidos('POST', /\/channels\/c1\/snoop/)[0];
    assert.equal(snoop.args.whisper, 'out');
    assert.equal(snoop.args.appArgs, 'spysnoop,' + spy.id);
    const orig = ari.pedidos('POST', /^\/channels$/)[0];
    assert.equal(orig.args.endpoint, 'PJSIP/2003');
    /* El supervisor atiende: entra a Stasis con spyjoin y se lo mete al puente. */
    const supCh = [...ari.canales.values()].find((c) => /^PJSIP\/2003/.test(c.name));
    ari.stasis(supCh.id, ['spyjoin', spy.id]);
    assert.ok(await hasta(() => ari.pedidos('POST', /addChannel$/).some((p) => p.args.channel === supCh.id)));
    /* Una pata de supervisión de una sesión que no existe se cuelga. */
    const huerf = ari.canal({ name: 'PJSIP/2004-9' });
    ari.stasis(huerf.id, ['spyjoin', 'spy-inexistente']);
    assert.ok(await hasta(() => !ari.canales.has(huerf.id)));
    assert.equal((await api('GET', '/api/calls/spy', { token: admin })).json.length, 1);
    /* La llamada supervisada termina: la sesión se cierra sola. */
    ari.colgar('c1');
    assert.ok(await hasta(async () => (await api('GET', '/api/calls/spy', { token: admin })).json.length === 0), 'la supervisión quedó viva');
    assert.equal((await api('DELETE', '/api/calls/spy/' + spy.id, { token: admin })).json.ok, false);
  });

  await t.test('supervisión: si el snoop falla se limpia el puente', async () => {
    ari.canal({ id: 'c3', name: 'PJSIP/2001-00000003', state: 'Up' });
    await hasta(async () => (await api('GET', '/api/calls/live', { token: admin })).json.channels.some((c) => c.id === 'c3'));
    ari.fallar('POST', '/channels/c3/snoop', 500);
    const r = await api('POST', '/api/calls/spy', { token: admin, body: { sup: '2003', target: '2001' } });
    assert.ok(r.status >= 500);
    assert.equal((await api('GET', '/api/calls/spy', { token: admin })).json.length, 0);
    ari.sanar();
    const ok = await api('POST', '/api/calls/spy', { token: admin, body: { sup: '2003', target: '2001', mode: 'barge' } });
    assert.equal(ok.status, 200);
    assert.equal((await api('DELETE', '/api/calls/spy/' + ok.json.id, { token: admin })).json.ok, true);
  });

  await t.test('originar, retener, recuperar y cortar (por ARI, y por AMI si ARI no puede)', async () => {
    assert.equal((await api('POST', '/api/calls/dial', { token: admin, body: { from: '2001' } })).status, 400);
    const d = await api('POST', '/api/calls/dial', { token: admin, body: { from: '2001', to: '099123456' } });
    assert.equal(d.status, 200);
    const o = ari.pedidos('POST', /^\/channels$/).at(-1);
    assert.equal(o.args.endpoint, 'PJSIP/2001');
    assert.equal(o.args.extension, '099123456');
    assert.equal((await api('POST', '/api/calls/c3/hold', { token: admin })).json.ok, true);
    assert.equal(ari.canales.get('c3').retenido, true);
    assert.equal((await api('POST', '/api/calls/c3/unhold', { token: admin })).json.ok, true);
    assert.equal((await api('POST', '/api/calls/c3/hangup', { token: admin })).json.via, 'ari');

    ari.canal({ id: 'c4', name: 'PJSIP/2001-00000004', state: 'Up' });
    await hasta(async () => (await api('GET', '/api/calls/live', { token: admin })).json.channels.some((c) => c.id === 'c4'));
    ari.fallar('DELETE', '/channels/c4', 500);
    ami.olvidar();
    const r = await api('POST', '/api/calls/c4/hangup', { token: admin });
    assert.equal(r.json.via, 'ami', 'si ARI no corta, se corta por AMI con el nombre del canal');
    assert.equal(ami.pedidos('Hangup')[0].channel, 'PJSIP/2001-00000004');
    assert.equal((await api('POST', '/api/calls/inexistente/hangup', { token: admin })).status, 502);
    ami.accion('Hangup', { Response: 'Error', Message: 'No such channel' });
    ari.canal({ id: 'c5', name: 'PJSIP/2001-00000005', state: 'Up' });
    await hasta(async () => (await api('GET', '/api/calls/live', { token: admin })).json.channels.some((c) => c.id === 'c5'));
    ari.fallar('DELETE', '/channels/c5', 500);
    assert.equal((await api('POST', '/api/calls/c5/hangup', { token: admin })).status, 502);
    ari.sanar();
  });

  await t.test('transferir y aparcar: se manda el OTRO extremo; sin llamada puenteada es 404', async () => {
    ami.comando(/^core show channels concise/, [
      'PJSIP/2001-00000009!internal!2001!1!Up!Dial!PJSIP/x!2001!!!3!br-77',
      'PJSIP/antel-0000000a!from-trunk!s!1!Up!AppDial!(Outgoing)!099!!!3!br-77',
    ].join('\n'));
    ami.olvidar();
    const r = await api('POST', '/api/calls/transfer', { token: admin, body: { ext: '2001', to: '2050' } });
    assert.deepEqual(r.json, { ok: true, peer: 'PJSIP/antel-0000000a', to: '2050' });
    assert.equal(ami.pedidos('Redirect')[0].exten, '2050');
    const p = await api('POST', '/api/calls/park', { token: admin, body: { ext: '2001' } });
    assert.equal(p.json.to, '700');
    assert.equal((await api('POST', '/api/calls/transfer', { token: admin, body: { ext: '2099', to: '1' } })).status, 404);
    ami.comando(/^core show channels concise/, 'PJSIP/2001-1!internal!2001!1!Up!Dial!x!2001!!!3!');
    assert.equal((await api('POST', '/api/calls/transfer', { token: admin, body: { ext: '2001', to: '1' } })).status, 404);
  });

  await t.test('conferencia a tres: puente de mezcla con la llamada y su par, y el tercero entra por Stasis', async () => {
    ari.canal({ id: 'ca', name: 'PJSIP/2077-0000000b', state: 'Up' });
    ari.canal({ id: 'cb', name: 'PJSIP/antel-0000000c', state: 'Up' });
    const br = ari.puentes.size;
    ari.puentes.set('br-conf', { id: 'br-conf', channels: ['ca', 'cb'], bridge_type: 'mixing', technology: 'simple_bridge', bridge_class: 'base', creator: 'x', name: '' });
    assert.equal((await api('POST', '/api/calls/conference', { token: admin, body: { ext: '2009', third: '2002' } })).status, 404);
    const r = await api('POST', '/api/calls/conference', { token: admin, body: { ext: '2077', third: '2002' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(ari.puentes.size, br + 2);
    const nuevo = ari.puentes.get(r.json.bridge);
    assert.deepEqual(nuevo.channels.sort(), ['ca', 'cb']);
    const tercero = [...ari.canales.values()].find((c) => /^PJSIP\/2002/.test(c.name));
    assert.ok(tercero, 'no originó al tercero');
    ari.stasis(tercero.id, ['conf']);
    assert.ok(await hasta(() => nuevo.channels.includes(tercero.id)), 'el tercero no entró a la conferencia');
    ari.stasis('cb', []);   // un StasisStart sin conferencia pendiente no hace nada
  });

  await t.test('IA por StasisStart: un agente inexistente o apagado se despide y corta', async () => {
    await ctx.db.query("INSERT INTO pbxng_ai_agents (id, name, exten, provider, enabled) VALUES (90, 'Apagado', '8190', 'demo', false)");
    const ch = ari.canal({ name: 'PJSIP/2001-0000000d', state: 'Ring' });
    ari.olvidar();
    ari.stasis(ch.id, ['ai', '90']);
    assert.ok(await hasta(() => ari.pedidos('POST', new RegExp('/channels/' + ch.id + '/play')).length), 'no se despidió');
    assert.equal(ari.pedidos('POST', new RegExp('/channels/' + ch.id + '/play'))[0].args.media, 'sound:vm-goodbye');
    assert.ok(await hasta(() => !ari.canales.has(ch.id), 3000), 'no cortó');
    const otro = ari.canal({ name: 'PJSIP/2001-0000000e' });
    ari.stasis(otro.id, ['ai', '999']);
    assert.ok(await hasta(() => !ari.canales.has(otro.id), 3000));
  });

  await t.test('si Asterisk pierde la app, la API lo nota y se vuelve a conectar', async () => {
    ari.cortarWs();
    await dormir(100);
    await ari.conectado(15000);   // vuelve a abrir el WebSocket de eventos
    assert.ok(await hasta(async () => (await api('GET', '/health')).json.ari === true, 10000), 'no se volvió a conectar');
    const ch = ari.canal({ name: 'PJSIP/2001-0000000f', state: 'Up' });
    assert.ok(await hasta(async () => (await api('GET', '/api/calls/live', { token: admin })).json.channels.some((c) => c.id === ch.id)), 'después de reconectar no le llegan los eventos');
  });
});
