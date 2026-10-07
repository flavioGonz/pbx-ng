/* ============================================================================
 *  Centro de seguridad (guard.js) por sus rutas, contra una base efímera.
 *
 *  Express corre en este mismo proceso con las rutas del guardia montadas: así el
 *  geoLookup es de mentira (el de verdad consulta ip-api.com por internet) y el país de
 *  cada IP lo decide la prueba, que es lo que hace falta para probar el geo-bloqueo. El
 *  firewall es el agente falso: se mira qué le piden (ban, unban, sync).
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { EventEmitter } = require('events');
const { baseEfimera, motivoSinDb } = require('./helpers/db');

const PAISES = { '203.0.113.5': { country: 'Rusia', cc: 'RU', isp: 'X' }, '198.51.100.7': { country: 'Uruguay', cc: 'UY', isp: 'Antel' }, '2a00:1450::5': { country: 'Brasil', cc: 'BR', isp: 'Y' } };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

test('seguridad por sus rutas: bloqueos, ajustes, lista blanca, geo-bloqueo y el firewall', async (t) => {
  const db = await baseEfimera();
  if (!db) { t.skip('prueba de integración salteada: ' + motivoSinDb()); return; }
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  process.env.AST_CONF_DIR = conf;
  const fw = { pedidos: [], estado: 200, enabled: true, caido: false };
  const astFwd = async (method, ruta, body) => {
    fw.pedidos.push({ method, ruta, body });
    if (fw.caido) throw new Error('ECONNREFUSED');
    return { ok: fw.estado < 400, status: fw.estado, json: async () => (fw.estado === 503 ? { error: 'nft no está' } : { ok: true, enabled: fw.enabled, bans: [] }) };
  };
  const escritos = {};
  const correos = [];
  const ami = new EventEmitter();
  const amiCmds = [];
  let amiFalla = false;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { username: 'admin', role: 'admin' }; next(); });
  const guard = require('../guard')({
    app, pool: db.pool, ami, io: { to: () => ({ emit() {} }) },
    astFwd, escribir: (n, txt) => { escritos[n] = txt; },
    alerts: { raise: async (k, d) => { correos.push({ k, d }); } },
    geoLookup: async (ips) => Object.fromEntries(ips.map((ip) => [ip, PAISES[ip] || { country: 'Desconocido', cc: 'ZZ', isp: '' }])),
    amiCommand: async (c) => { amiCmds.push(c); if (amiFalla) throw new Error('AMI caído'); return 'Module reloaded'; },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  t.after(async () => { guard.detener(); srv.close(); await db.cerrar(); fs.rmSync(conf, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const api = async (method, ruta, body) => {
    const r = await fetch(base + ruta, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  t.mock.timers.enable({ apis: ['setInterval'] });
  await guard.iniciar();
  t.mock.timers.reset();
  assert.match(escritos['pjsip-security.conf'] || '', /unidentified_request_count=/, 'al arrancar se crea pjsip-security.conf con los defaults');

  await t.test('ajustes: leer, validar, guardar y aplicar recargando res_pjsip', async () => {
    const s = (await api('GET', '/api/security/settings')).json;
    assert.equal(s.max_fallos, 5);
    for (const malo of [{ max_fallos: 0 }, { ventana_s: 2 }, { ban_s: 'x' }, { max_fallos: 99999999 }]) {
      assert.equal((await api('PUT', '/api/security/settings', malo)).status, 400, JSON.stringify(malo));
    }
    const g = await api('PUT', '/api/security/settings', { max_fallos: 3, ventana_s: 60, ban_s: 600, escaneres: 'false', alertar: true, unidentified_count: 7 });
    assert.equal(g.status, 200);
    assert.equal(g.json.escaneres, false);
    assert.match(g.json.pendiente, /aplicar/);
    assert.equal((await api('GET', '/api/security/settings')).json.max_fallos, 3, 'queda guardado en la base');
    const a = await api('POST', '/api/security/apply');
    assert.equal(a.json.ok, true);
    assert.match(escritos['pjsip-security.conf'], /unidentified_request_count=7/);
    assert.ok(amiCmds.includes('module reload res_pjsip.so'));
    amiFalla = true;
    const mal = await api('POST', '/api/security/apply');
    assert.equal(mal.status, 502);
    assert.match(mal.json.error, /Asterisk no respondió al reload/);
    amiFalla = false;
  });

  await t.test('bloqueo manual: IP inválida, privada y una pública; desbloquear', async () => {
    assert.equal((await api('POST', '/api/security/block', { ip: 'no-ip' })).status, 400);
    assert.equal((await api('POST', '/api/security/block', { ip: '10.0.0.9' })).status, 400);
    fw.pedidos.length = 0;
    const b = await api('POST', '/api/security/block', { ip: '198.51.100.7', permanent: false, reason: 'prueba' });
    assert.deepEqual(b.json, { ok: true, ip: '198.51.100.7', permanent: false });
    assert.deepEqual(fw.pedidos.find((p) => p.ruta === '/fw/ban').body, { ip: '198.51.100.7', seconds: 600 });
    assert.equal(correos.at(-1).k, 'security.ban');
    const r = await api('GET', '/api/security');
    assert.equal(r.json.kpis.bloqueados, 1);
    assert.equal(r.json.bloqueos[0].flag, '🇺🇾');
    assert.equal(r.json.top_paises[0].pais, 'Uruguay');
    assert.equal(r.json.enforcement.nft, true);
    const u = await api('POST', '/api/security/unblock', { ip: '198.51.100.7' });
    assert.equal(u.json.habia, true);
    assert.ok(fw.pedidos.some((p) => p.ruta === '/fw/unban'));
    assert.equal((await api('POST', '/api/security/unblock', { ip: '198.51.100.7' })).json.habia, false);
    assert.equal((await api('POST', '/api/security/unblock', { ip: 'x' })).status, 400);
  });

  await t.test('si el agente no contesta, el ban queda en la base y el estado lo dice', async () => {
    fw.caido = true;
    await api('POST', '/api/security/block', { ip: '198.51.100.7' });
    let e = (await api('GET', '/api/security')).json.enforcement;
    assert.equal(e.agente, false);
    assert.match(e.motivo, /sin respuesta del agente/);
    assert.match(correos.at(-1).d.foot, /no confirmó el bloqueo/);
    e = (await api('GET', '/api/security/enforcement')).json;
    assert.equal(e.agente, false);
    fw.caido = false; fw.estado = 503;
    e = (await api('GET', '/api/security/enforcement')).json;
    assert.deepEqual([e.agente, e.nft], [true, false]);
    assert.match(e.motivo, /nft no está/);
    fw.estado = 200; fw.enabled = false;
    assert.equal((await api('GET', '/api/security/enforcement')).json.nft, false);
    fw.enabled = true;
    e = (await api('GET', '/api/security/enforcement')).json;
    assert.equal(e.nft, true);
    const sync = fw.pedidos.filter((p) => p.ruta === '/fw/sync').at(-1);
    assert.deepEqual(sync.body.bans, [{ ip: '198.51.100.7', seconds: 0 }], 'el sync manda el set completo, con el permanente en 0');
    await api('POST', '/api/security/unblock', { ip: '198.51.100.7' });
  });

  await t.test('lista blanca: IP, CIDR v4 y v6, regla inválida; meter una bloqueada la suelta', async () => {
    await api('POST', '/api/security/block', { ip: '203.0.113.5' });
    assert.equal((await api('POST', '/api/security/whitelist', { ip: '1.2.3.0/33' })).status, 400);
    assert.equal((await api('POST', '/api/security/whitelist', { ip: 'nada' })).status, 400);
    assert.equal((await api('POST', '/api/security/whitelist', { ip: '203.0.113.5', note: 'oficina' })).json.ip, '203.0.113.5');
    assert.equal((await api('GET', '/api/security')).json.kpis.bloqueados, 0, 'entrar a la lista blanca desbloquea');
    assert.equal((await api('POST', '/api/security/whitelist', { ip: '2A00:1450:0::/32' })).json.ip, '2a00:1450::/32');
    assert.equal((await api('POST', '/api/security/block', { ip: '2a00:1450::5' })).status, 409, 'una IP de la lista blanca no se bloquea a mano');
    const l = (await api('GET', '/api/security/whitelist')).json;
    assert.equal(l.length, 2);
    await api('DELETE', '/api/security/whitelist?ip=203.0.113.5');
    await api('DELETE', '/api/security/whitelist/' + encodeURIComponent('2a00:1450::/32'));
    assert.equal((await api('POST', '/api/security/whitelist/remove', {})).status, 400);
    assert.equal((await api('GET', '/api/security/whitelist')).json.length, 0);
  });

  await t.test('geo-bloqueo: vetar un país banea lo ya visto de ahí, y sacarlo lo suelta', async () => {
    /* Una IP rusa ya dejó un fallo en las últimas 24 h. */
    await db.query("INSERT INTO pbxng_sec_events (kind, severity, detail) VALUES ('fallo','warn','{\"ip\":\"203.0.113.5\",\"n\":2}')");
    const p = await api('PUT', '/api/security/geoblock', { paises: [{ cc: 'ru', nombre: 'Rusia' }, 'X', { cc: 'cn' }], modo: 'bloquear' });
    assert.equal(p.json.total, 2);
    const g = await api('GET', '/api/security/geoblock');
    assert.deepEqual(g.json.paises.map((x) => x.cc), ['CN', 'RU']);
    const ap = await api('POST', '/api/security/geoblock/apply');
    assert.equal(ap.json.bloqueadas, 1);
    const r = (await api('GET', '/api/security')).json;
    assert.equal(r.bloqueos[0].ip, '203.0.113.5');
    assert.equal(r.bloqueos[0].permanent, true);
    assert.deepEqual(r.geoblock.paises.map((x) => x.cc).sort(), ['CN', 'RU']);
    /* Un evento en vivo desde un país vetado banea a la primera, aunque sea un login correcto. */
    ami.emit('managerevent', { event: 'SuccessfulAuth', remoteaddress: 'IPV6/UDP/[2a00:1450::5]/5060', accountid: '2001' });
    await api('PUT', '/api/security/geoblock', { paises: ['RU', 'BR'] });
    ami.emit('managerevent', { event: 'SuccessfulAuth', remoteaddress: 'IPV6/UDP/[2a00:1450::5]/5060', accountid: '2001' });
    await dormir(150);
    assert.ok((await api('GET', '/api/security')).json.bloqueos.some((b) => b.ip === '2a00:1450::5'));
    /* Sacar Rusia de la lista suelta lo que se había bloqueado por geo. */
    await api('PUT', '/api/security/geoblock', { paises: ['BR'] });
    const ap2 = await api('POST', '/api/security/geoblock/apply');
    assert.ok(ap2.json.desbloqueadas >= 1);
    /* Modo permitir: «banear país» desde el SOC lo saca de los permitidos. */
    await api('PUT', '/api/security/geoblock', { paises: ['UY', 'AR'], modo: 'permitir' });
    assert.equal((await api('POST', '/api/security/geoblock/add', { cc: '1' })).status, 400);
    const add = await api('POST', '/api/security/geoblock/add', { cc: 'ar' });
    assert.equal(add.json.modo, 'permitir');
    assert.deepEqual((await api('GET', '/api/security/geoblock')).json.paises.map((x) => x.cc), ['UY']);
    await api('PUT', '/api/security/geoblock', { paises: [], modo: 'bloquear' });
    const add2 = await api('POST', '/api/security/geoblock/add', { cc: 'kp', nombre: 'Corea del Norte' });
    assert.equal(add2.json.paises, 1);
  });

  await t.test('banderas por IP para otras pantallas', async () => {
    assert.deepEqual((await api('GET', '/api/ipgeo')).json, {});
    const g = (await api('GET', '/api/ipgeo?ips=198.51.100.7,basura,203.0.113.5')).json;
    assert.deepEqual(Object.keys(g).sort(), ['198.51.100.7', '203.0.113.5']);
    assert.equal(guard.bandera('uy'), '🇺🇾');
    assert.equal(guard.bandera('x'), '');
  });

  await t.test('vencimientos, golpes de IPs bloqueadas y el vuelco de fallos', async () => {
    await db.query("INSERT INTO pbxng_blocked (ip, reason, permanent, expires_at) VALUES ('192.0.2.77','vencido',false, now() - interval '1 minute')");
    await guard._cargar.bloqueadas();
    fw.pedidos.length = 0;
    assert.equal(await guard.expirar(), 1);
    assert.ok(fw.pedidos.some((p) => p.ruta === '/fw/unban' && p.body.ip === '192.0.2.77'));
    assert.equal(await guard.expirar(), 0);
    assert.ok(guard.recientes().some((e) => /bloqueo vencido/.test(e.texto)));
    const live = (await api('GET', '/api/security/live')).json;
    assert.ok(live.length > 0);
    /* Un ataque desde la web (enlace público inventado) cuenta igual que uno SIP. */
    for (let i = 0; i < 4; i++) await guard.web('203.0.113.99', 'c2c:x');
    await guard.web('no es ip');
    assert.equal(guard.enforcement().nft, true);
    assert.equal(guard.settings().max_fallos, 3);
  });
});
