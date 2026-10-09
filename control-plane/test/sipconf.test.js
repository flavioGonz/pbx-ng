/* ============================================================================
 *  Configuración SIP de la central (sipconf.js): lo que el panel guarda termina en
 *  pbxng.d/pjsip.conf y rtp.conf, validado, y se recarga por AMI.
 *
 *  Lo que importa fijar: que nada llegue a un .conf sin limpiar (un salto de línea en el
 *  User-Agent sería una línea de configuración nueva), que el panel sepa cuándo hace falta
 *  reiniciar Asterisk (NAT, TLS y el rango RTP no se recargan en caliente), y que los
 *  temporizadores y el ToS de audio se apliquen a todos los endpoints cuando se pide.
 * ==========================================================================*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const initSipConf = require('../sipconf');

function armar({ guardado, amiFalla = false, baseCaida = false } = {}) {
  const rutas = {}, archivos = {}, comandos = [], updates = [];
  const settings = new Map(guardado ? [['sipconf', JSON.stringify(guardado)]] : []);
  const pool = {
    async query(sql, args) {
      if (baseCaida) throw new Error('base caída');
      if (/SELECT value FROM pbxng_settings WHERE key=\$1/.test(sql)) return { rows: settings.has(args[0]) ? [{ value: settings.get(args[0]) }] : [] };
      if (/key='record_all'/.test(sql)) return { rows: [{ value: '1' }] };
      if (/INSERT INTO pbxng_settings/.test(sql)) { settings.set(args[0], args[1]); return { rowCount: 1 }; }
      if (/UPDATE ps_endpoints/.test(sql)) { updates.push([sql, args]); return { rowCount: 3 }; }
      throw new Error('consulta inesperada: ' + sql);
    },
  };
  const app = { get: (p, h) => { rutas['GET ' + p] = h; }, post: (p, h) => { rutas['POST ' + p] = h; } };
  const amiCommand = async (c) => {
    comandos.push(c);
    if (amiFalla) throw new Error('AMI caído');
    if (c === 'pjsip show transports') return 'Transport:  <TransportId........>  <Type>  <cos>  <tos>  <BindAddress....>\n  Transport:  transport-udp  udp  0  96  0.0.0.0:5060\n';
    return 'ok';
  };
  const sc = initSipConf({ app, pool, amiCommand, escribir: (n, t) => { archivos[n] = t; } });
  const llamar = async (ruta, body) => {
    let status = 200, json;
    const res = { status(s) { status = s; return this; }, json(j) { json = j; return this; } };
    await rutas[ruta]({ body }, res);
    return { status, json };
  };
  return { sc, llamar, archivos, comandos, updates, settings };
}

test('leer: sin nada guardado vale lo de la imagen, con los transportes reales y la grabación global', async () => {
  const { llamar } = armar();
  const r = await llamar('GET /api/sipconf');
  assert.equal(r.json.general.user_agent, 'PBX-NG');
  assert.equal(r.json.record_all, true);
  assert.deepEqual(r.json.transports, [{ id: 'transport-udp', protocol: 'udp', bind: '0.0.0.0:5060' }]);
  assert.ok(r.json.options.audio.includes('opus'));
  /* Con AMI caído, la lista de transportes viene vacía en vez de romper. */
  assert.deepEqual((await armar({ amiFalla: true }).llamar('GET /api/sipconf')).json.transports, []);
  /* Con la base caída se ve lo de fábrica. */
  assert.equal((await armar({ baseCaida: true }).llamar('GET /api/sipconf')).json.record_all, false);
});

test('guardar: limpia lo que va al .conf, avisa si hace falta reiniciar y aplica a todos si se pide', async () => {
  const { llamar, archivos, comandos, updates, settings } = armar();
  const r = await llamar('POST /api/sipconf', {
    general: { user_agent: 'Mi PBX\n[global]\nauth=x', default_realm: 'pbx.ejemplo.uy' },
    nat: { external_media_address: '200.1.2.3', external_signaling_address: '200.1.2.3', local_net: ['192.168.0.0/16', '10.0.0.0/255.0.0.0', 'cualquiera', '1.2.3.4'], tos_audio: 'ef;x' },
    rtp: { rtpstart: 12000, rtpend: 14000, strictrtp: 'seqno', icesupport: 'no', stunaddr: '', rtpchecksums: 'yes' },
    timers: { timers: 'always', timers_min_se: 120, timers_sess_expires: 900 },
    tls: { method: 'tlsv1_3', cipher: 'ECDHE-RSA-AES256-GCM-SHA384;rm' },
    codecs: { audio: ['opus', 'mp3'], video: ['vp9'] },
    apply_timers: true, apply_tos: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, restart_required: true, timers_applied: 3 });
  assert.match(archivos['pjsip.conf'], /^user_agent=Mi PBXglobalauth=x$/m, 'un salto de línea no abre una sección nueva');
  assert.match(archivos['pjsip.conf'], /^default_realm=pbx\.ejemplo\.uy$/m);
  assert.match(archivos['pjsip.conf'], /^external_media_address=200\.1\.2\.3$/m);
  assert.deepEqual(archivos['pjsip.conf'].match(/^local_net=.*$/gm).slice(0, 3), ['local_net=192.168.0.0/16', 'local_net=10.0.0.0/255.0.0.0', 'local_net=1.2.3.4']);
  assert.match(archivos['pjsip.conf'], /^cipher=ECDHE-RSA-AES256-GCM-SHA384rm$/m);
  assert.match(archivos['rtp.conf'], /^; stunaddr= \(sin STUN\)$/m);
  assert.match(archivos['rtp.conf'], /^strictrtp=seqno$/m);
  assert.deepEqual(comandos, ['module reload res_pjsip.so', 'module reload res_rtp_asterisk.so']);
  assert.deepEqual(updates.map(([, a]) => a), [['always', '120', '900'], ['efx']]);
  assert.deepEqual(JSON.parse(settings.get('sipconf')).codecs, { audio: ['opus'], video: ['vp9'] });

  /* Lo mismo otra vez: no cambió nada que pida reinicio, y sin pedirlo no se aplica a todos. */
  const otra = await llamar('POST /api/sipconf', { general: { keep_alive_interval: 'nada' } });
  assert.deepEqual(otra.json, { ok: true, restart_required: false, timers_applied: null });
});

test('guardar: rangos imposibles se rechazan con 400, y sin códecs de audio queda ulaw', async () => {
  const { llamar, sc } = armar();
  const a = await llamar('POST /api/sipconf', { rtp: { rtpstart: 20000, rtpend: 15000 } });
  assert.equal(a.status, 400);
  assert.match(a.json.error, /rango RTP/);
  const b = await llamar('POST /api/sipconf', { timers: { timers_min_se: 1800, timers_sess_expires: 600 } });
  assert.equal(b.status, 400);
  assert.match(b.json.error, /Min-SE/);
  await llamar('POST /api/sipconf', { codecs: { audio: [] }, timers: { timers: 'cualquiera' }, tls: { method: 'ssl2' } });
  assert.equal(await sc.defaultCodecs(false), 'ulaw');
  assert.equal(await sc.defaultCodecs(true), 'ulaw,vp8,h264');
  /* Un recargo de AMI que falla no impide guardar. */
  const conAmiCaido = armar({ amiFalla: true });
  assert.equal((await conAmiCaido.llamar('POST /api/sipconf', {})).status, 200);
});

test('reiniciar Asterisk: cuando convenga, o ya', async () => {
  const { llamar, comandos } = armar();
  assert.deepEqual((await llamar('POST /api/sipconf/restart', {})).json, { ok: true, mode: 'when-convenient', out: 'ok' });
  assert.equal((await llamar('POST /api/sipconf/restart', { now: true })).json.mode, 'now');
  assert.deepEqual(comandos, ['core restart when convenient', 'core restart now']);
  assert.equal((await llamar('POST /api/sipconf/restart')).json.mode, 'when-convenient');
});

test('al arrancar se regeneran los archivos; un endpoint nuevo hereda temporizadores y ToS', async () => {
  const { sc, archivos } = armar({ guardado: { general: { default_realm: 'x.uy' } } });
  await sc.ensure();
  assert.match(archivos['pjsip.conf'], /default_realm=x\.uy/);
  const hechos = [];
  await sc.afterCreate({ query: async (sql, a) => { hechos.push(a); } }, 2001);
  assert.deepEqual(hechos[0], ['2001', 'yes', '90', '1800', 'ef']);
  /* Si falla, no rompe el alta del endpoint. */
  await sc.afterCreate({ query: async () => { throw new Error('x'); } }, 2002);
  const roto = initSipConf({ app: { get() {}, post() {} }, pool: { query: async () => ({ rows: [] }) }, amiCommand: async () => '', escribir: () => { throw new Error('disco lleno'); }, log: () => {} });
  await roto.ensure();
});
