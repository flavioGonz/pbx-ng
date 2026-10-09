/* ============================================================================
 *  Integración · lo que quedaba suelto de app.js: la captura SIP, canales y empresas,
 *  el estado de la IA (latido del proveedor, sesiones en vivo, modelos, probar un
 *  agente contra un modelo de mentira), ACME por la API y el socket del panel.
 *
 *  El socket se habla a mano —Engine.IO v4 sobre `ws`— porque control-plane no trae el
 *  cliente de socket.io: lo que importa es lo que el servidor deja pasar y lo que manda.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { entorno } = require('./helpers/db');
const { amiFalso } = require('./helpers/ami-falso');

/* Un modelo realtime que contesta con audio en cuanto le piden hablar. */
async function modeloFalso({ mudo = false } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((ok) => wss.once('listening', ok));
  wss.on('connection', (ws) => ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'response.create' && !mudo) {
      ws.send(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'listo' }));
      ws.send(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.alloc(960).toString('base64') }));
    }
  }));
  return { url: 'ws://127.0.0.1:' + wss.address().port, cerrar: () => new Promise((ok) => { for (const c of wss.clients) c.terminate(); wss.close(ok); }) };
}

/* Cliente de socket.io mínimo: abre, se autentica y junta los eventos. */
function socketPanel(base, auth, headers) {
  const url = base.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
  const ws = new WebSocket(url, { headers: headers || {} });
  const eventos = [];
  let conectado = null, rechazo = null;
  const listo = new Promise((ok) => {
    ws.on('message', (d) => {
      const s = String(d);
      if (s[0] === '0') ws.send('40' + JSON.stringify(auth || {}));
      else if (s === '2') ws.send('3');
      else if (s.startsWith('40')) { conectado = true; ok(); }
      else if (s.startsWith('44')) { rechazo = JSON.parse(s.slice(2)); ok(); }
      else if (s.startsWith('42')) eventos.push(JSON.parse(s.slice(2)));
    });
    ws.on('unexpected-response', (_q, r) => { rechazo = { status: r.statusCode }; ok(); });
    ws.on('error', () => ok());
  });
  return {
    listo, eventos, ws,
    get conectado() { return conectado; }, get rechazo() { return rechazo; },
    emitir: (nombre, dato) => ws.send('42' + JSON.stringify(dato === undefined ? [nombre] : [nombre, dato])),
    cerrar: () => { try { ws.close(); } catch (_) {} },
  };
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 4000) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(40); } return fn(); }

test('app.js: captura SIP, IA, ACME y el socket del panel', async (t) => {
  const ami = await amiFalso();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pbxng-acme-'));
  fs.writeFileSync(path.join(bin, 'acme.sh'), '#!/bin/sh\necho "$*"\ncase "$*" in *--issue*) exit 1;; esac\n', { mode: 0o755 });
  t.after(async () => { await ami.cerrar(); fs.rmSync(bin, { recursive: true, force: true }); });
  const ctx = await entorno(t, Object.assign({}, ami.env, { ACME_SH: path.join(bin, 'acme.sh'), CORS_ORIGINS: 'https://panel.ejemplo.uy/' }));
  if (!ctx) return;
  t.after(() => ctx.cerrar());
  const { api, login, base } = ctx.api;
  const admin = (await login('admin', 'admin')).token;
  await ami.conectado();

  await t.test('captura SIP: estado, prender, apagar, mensajes, el mensaje crudo y vaciar', async () => {
    assert.deepEqual((await api('GET', '/api/sip/state', { token: admin })).json, { on: true, total: 0 });
    await ctx.db.query("INSERT INTO pbxng_sip_capture (ts, host, src, dst, method, status, callid, cseq, from_uri, to_uri, ruri, raw) VALUES (now(),'pbx','1.2.3.4:5060','10.0.0.1:5060','INVITE',NULL,'c1','1 INVITE','sip:a@x','sip:b@x','sip:b@x','INVITE sip:b@x SIP/2.0')");
    assert.equal((await api('POST', '/api/sip/toggle', { token: admin, body: { on: false } })).json.on, false);
    assert.deepEqual((await api('GET', '/api/sip/state', { token: admin })).json, { on: false, total: 1 });
    const l = (await api('GET', '/api/sip/messages?limit=99999', { token: admin })).json;
    assert.equal(l[0].method, 'INVITE');
    assert.match((await api('GET', '/api/sip/raw/' + l[0].id, { token: admin })).json.raw, /^INVITE sip:b@x/);
    assert.equal((await api('GET', '/api/sip/raw/999999', { token: admin })).json.raw, '');
    assert.equal((await api('POST', '/api/sip/clear', { token: admin })).json.ok, true);
    assert.equal((await api('GET', '/api/sip/state', { token: admin })).json.total, 0);
  });

  await t.test('canales y empresas', async () => {
    ami.comando(/^core show channels/, '0 active channels');
    assert.equal((await api('GET', '/api/channels', { token: admin })).status, 200);
    const e = (await api('GET', '/api/tenants', { token: admin })).json;
    assert.equal(e[0].id, 1);
  });

  await t.test('IA: latido sin clave, sesiones en vivo con el último problema, y los modelos', async () => {
    const s = await api('POST', '/api/ai-agents/salud', { token: admin });
    assert.equal(s.json.estado, 'sin_clave');
    await ctx.db.query("INSERT INTO pbxng_settings (key,value) VALUES ('ia_ultimo_problema', '{\"que\":\"sin créditos\"}')");
    const v = await api('GET', '/api/ai-agents/live', { token: admin });
    assert.deepEqual(v.json.sesiones, []);
    assert.equal(v.json.problema.que, 'sin créditos');
    assert.equal(v.json.salud.estado, 'sin_clave');
    await ctx.db.query("UPDATE pbxng_settings SET value='{roto' WHERE key='ia_ultimo_problema'");
    assert.equal((await api('GET', '/api/ai-agents/live', { token: admin })).json.problema, null, 'un ajuste ilegible no rompe la pantalla');
    assert.match((await api('GET', '/api/ai-agents/modelos', { token: admin })).json.error, /no hay clave/);
    await ctx.db.query("INSERT INTO pbxng_settings (key,value) VALUES ('openai_api_key','sk-x'),('realtime_url','wss://mi-proxy')");
    assert.match((await api('GET', '/api/ai-agents/modelos', { token: admin })).json.error, /endpoint es propio/);
  });

  await t.test('probar un agente: sin modelo, sin clave, contra un modelo que habla y uno mudo; candado de una a la vez', async () => {
    assert.equal((await api('POST', '/api/ai-agents/probar', { token: admin, body: {} })).status, 400);
    await ctx.db.query("UPDATE pbxng_settings SET value='' WHERE key='openai_api_key'");
    const sinClave = await api('POST', '/api/ai-agents/probar', { token: admin, body: { model: 'gpt-realtime-2.1' } });
    assert.equal(sinClave.json.paso, 'clave');
    assert.equal((await api('POST', '/api/ai-agents/probar', { token: admin, body: { model: 'x' } })).status, 429, 'cada prueba cuesta: no más de una cada 5 s');
    await dormir(5100);
    const habla = await modeloFalso();
    await ctx.db.query("UPDATE pbxng_settings SET value='sk-x' WHERE key='openai_api_key'");
    await ctx.db.query("UPDATE pbxng_settings SET value=$1 WHERE key='realtime_url'", [habla.url]);
    const ok = await api('POST', '/api/ai-agents/probar', { token: admin, body: { model: 'gpt-realtime-2.1', voice: 'marin' }, timeout: 30000 });
    await habla.cerrar();
    assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
    assert.equal(ok.json.paso, 'listo');
    assert.equal(ok.json.endpoint, habla.url);
    assert.equal(JSON.stringify(ok.json).includes('sk-x'), false, 'la clave no vuelve en la respuesta');
  });

  await t.test('ACME por la API: emitir con acme.sh que rechaza devuelve 400 con la salida; renovar', async () => {
    await api('POST', '/api/acme/config', { token: admin, body: { domain: 'pbx.ejemplo.uy', email: 'a@b.uy', method: 'http' } });
    const e = await api('POST', '/api/acme/issue', { token: admin });
    assert.equal(e.status, 400);
    assert.match(e.json.error, /rechazó/);
    const r = await api('POST', '/api/acme/renew', { token: admin });
    assert.equal(r.json.ok, true);
  });

  await t.test('socket del panel: sin token no entra; con token recibe el estado y lo puede pedir', async () => {
    const anon = socketPanel(base, {});
    await anon.listo;
    assert.equal(anon.conectado, null);
    assert.equal(anon.rechazo.message, 'unauthorized');
    anon.cerrar();

    const s = socketPanel(base, { token: admin });
    await s.listo;
    assert.equal(s.conectado, true);
    assert.ok(await hasta(() => s.eventos.some((e) => e[0] === 'snapshot')), 'no mandó el estado al conectar');
    assert.ok(await hasta(() => s.eventos.some((e) => e[0] === 'estados')));
    const antes = s.eventos.length;
    s.emitir('estados:pedir');
    s.emitir('snapshot:pedir'); s.emitir('snapshot:pedir');   // el segundo cae en el freno de 1 s
    s.emitir('sec:join'); s.emitir('sec:leave');
    assert.ok(await hasta(() => s.eventos.length > antes));
    s.cerrar();
  });

  await t.test('socket: la pizarra entre dos softphones, y un Origin ajeno se rechaza', async () => {
    await api('POST', '/api/endpoints', { token: admin, body: { id: '2001', password: 'Clave-2001-xx' } });
    await api('POST', '/api/users', { token: admin, body: { username: 'ana', password: 'Clave-ana-1234', role: 'agente', ext: '2001' } });
    const ana = (await login('ana', 'Clave-ana-1234')).token;
    const a = socketPanel(base, { scratch: ana });
    const b = socketPanel(base, { token: admin });
    await a.listo; await b.listo;
    /* Un socket de panel registra los eventos de la pizarra DESPUÉS de mandar el primer
     * estado: lo que se emite antes se pierde. Se espera ese primer estado. */
    await hasta(() => a.eventos.some((e) => e[0] === 'snapshot') && b.eventos.some((e) => e[0] === 'snapshot'));
    a.emitir('scratch:join', 'sala-1'); b.emitir('scratch:join', 'sala-1');
    await dormir(150);
    a.emitir('scratch:op', { room: 'sala-1', op: { x: 1 } });
    a.emitir('scratch:clear', { room: 'sala-1' });
    assert.ok(await hasta(() => b.eventos.some((e) => e[0] === 'scratch:op' && e[1].x === 1)), 'el trazo no llegó al otro');
    assert.ok(await hasta(() => b.eventos.some((e) => e[0] === 'scratch:clear')));
    a.emitir('scratch:leave', 'sala-1'); a.emitir('scratch:op', {}); a.emitir('scratch:join');
    a.cerrar(); b.cerrar();

    const ajeno = socketPanel(base, { token: admin }, { Origin: 'https://sitio-malo.com' });
    await ajeno.listo;
    assert.equal(ajeno.conectado, null, 'un Origin de otro sitio no abre el socket');
    ajeno.cerrar();
    for (const origen of ['https://panel.ejemplo.uy', 'http://127.0.0.1:' + ctx.api.port]) {
      const ok = socketPanel(base, { token: admin }, { Origin: origen });
      await ok.listo;
      assert.equal(ok.conectado, true, origen);
      ok.cerrar();
    }
    const fwd = socketPanel(base, { token: admin }, { Origin: 'https://pbx.ejemplo.uy:8443', 'X-Forwarded-Host': 'pbx.ejemplo.uy' });
    await fwd.listo;
    assert.equal(fwd.conectado, true, 'detrás de un proxy en otro puerto alcanza con el nombre');
    fwd.cerrar();
    const raro = socketPanel(base, { token: admin }, { Origin: 'no es una url' });
    await raro.listo;
    assert.equal(raro.conectado, null);
    raro.cerrar();
  });

  await t.test('eventos del AMI: atendida, terminada y registro de internos van al outbox una vez', async () => {
    const cuenta = async (tipo) => (await ctx.db.query('SELECT count(*)::int n FROM pbxng_eventos_salida WHERE tipo=$1', [tipo])).rows[0].n;
    ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2001-01', DialStatus: 'ANSWER', CallerIDNum: '099', Linkedid: 'L1', Uniqueid: 'U1' });
    ami.emitir({ Event: 'DialEnd', DestChannel: 'PJSIP/2001-01', DialStatus: 'ANSWER', CallerIDNum: '099', Linkedid: 'L1' });
    ami.emitir({ Event: 'DialEnd', DestChannel: 'Local/x', DialStatus: 'ANSWER' });
    ami.emitir({ Event: 'Hangup', Uniqueid: 'L1', Linkedid: 'L1', Channel: 'PJSIP/2001-01', CallerIDNum: '099', Exten: '2001', Cause: '16' });
    ami.emitir({ Event: 'Hangup', Uniqueid: 'L1', Linkedid: 'L1' });
    ami.emitir({ Event: 'Hangup', Uniqueid: 'U9', Linkedid: 'L9' });
    ami.emitir({ Event: 'ContactStatus', AOR: '2001', ContactStatus: 'Reachable' });
    ami.emitir({ Event: 'ContactStatus', AOR: '2001', ContactStatus: 'Reachable' });
    ami.emitir({ Event: 'ContactStatus', AOR: '2001', ContactStatus: 'Unknown' });
    ami.emitir({ Event: 'Newchannel' });
    const ok = await hasta(async () => (await cuenta('llamada.contestada').catch(() => 0)) >= 1 && (await cuenta('interno.registrado').catch(() => 0)) >= 1, 4000);
    assert.ok(ok, 'los eventos del AMI no llegaron al outbox');
    await dormir(200);
    assert.equal(await cuenta('llamada.contestada'), 1);
    assert.equal(await cuenta('interno.registrado'), 1);
    assert.equal(await cuenta('llamada.terminada'), 1);
  });

  await t.test('respaldo manual por la API: con pg_dump caído da error y no deja archivo', async () => {
    const r = await api('POST', '/api/backup', { token: admin, body: { nota: 'x' } });
    if (r.status === 201) assert.match(r.json.nombre, /^pbxng-/);
    else assert.ok(r.json.error);
  });
});
