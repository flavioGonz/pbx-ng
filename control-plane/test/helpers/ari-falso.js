/* ============================================================================
 *  PBX-NG · Un ARI de Asterisk de mentira para las pruebas de integración.
 *
 *  apiEfimera() apunta ARI a un puerto cerrado, así que todo lo que pasa por ARI —el
 *  motor de llamadas, la supervisión, la conferencia, la IA— nunca corría en las
 *  pruebas. Esto levanta un servidor HTTP + WebSocket que `ari-client` acepta como
 *  Asterisk: sirve los documentos swagger (test/fixtures/ari, la SUPERFICIE de la API de
 *  Asterisk 22 sin las descripciones), contesta las operaciones con un estado en memoria
 *  (canales, puentes, internos) y empuja eventos por /ari/events.
 *
 *    const ari = await ariFalso();
 *    ctx = await entorno(t, ari.env);               // ARI_URL apuntando acá
 *    await ari.conectado();                         // la API abrió el WebSocket
 *    ari.canal({ id: 'c1', name: 'PJSIP/2001-0001' });   // un canal en la central
 *    ari.stasis('c1', ['ai', '7']);                 // StasisStart con argumentos
 *    ari.pedidos('POST', /\/bridges/)               // lo que la API pidió
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const DOCS = path.join(__dirname, '..', 'fixtures', 'ari');

async function ariFalso({ app = 'pbxng' } = {}) {
  const canales = new Map();
  const puentes = new Map();
  const internos = [];
  const recibidos = [];
  const sockets = new Set();
  const errores = new Map();   // 'POST /channels/x/hold' → status
  let seq = 0;
  let appRegistrada = true;
  let base = '';

  const ahora = () => new Date().toISOString();
  const canalJson = (c) => Object.assign({
    state: 'Up', caller: { name: '', number: '' }, connected: { name: '', number: '' }, accountcode: '',
    dialplan: { context: 'internal', exten: 's', priority: 1, app_name: '', app_data: '' }, creationtime: ahora(), language: 'es',
  }, c);
  /* Los campos que vienen en `undefined` no pisan los de por defecto (un canal sin id
   * rompe a ari-client, que le pide `_id()` a cada objeto de un evento). */
  const sinIndefinidos = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));
  const nuevoCanal = (c) => { const ch = canalJson(Object.assign({ id: 'ch-' + (++seq), name: 'PJSIP/x-' + seq }, sinIndefinidos(c))); canales.set(ch.id, ch); return ch; };
  const nuevoPuente = (b) => { const p = Object.assign({ id: 'br-' + (++seq), technology: 'simple_bridge', bridge_type: 'mixing', bridge_class: 'base', creator: app, name: '', channels: [], creationtime: ahora() }, b); puentes.set(p.id, p); return p; };

  function emitir(ev) {
    const msg = JSON.stringify(Object.assign({ timestamp: ahora(), application: app, asterisk_id: 'falso' }, ev));
    for (const s of sockets) { try { s.send(msg); } catch (_) {} }
  }

  function responder(req, res, cuerpo) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace(/^\/ari/, '');
    const q = Object.fromEntries(u.searchParams.entries());
    let body = {};
    try { body = cuerpo ? JSON.parse(cuerpo) : {}; } catch (_) {}
    const args = Object.assign({}, q, body);
    recibidos.push({ method: req.method, path: p, args });
    const json = (status, o) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
    const err = errores.get(req.method + ' ' + p);
    if (err) return json(err, { message: 'falla de prueba' });

    /* Documentos swagger con el basePath de este servidor. */
    if (p.startsWith('/api-docs/')) {
      const f = path.join(DOCS, path.basename(p));
      if (!fs.existsSync(f)) return json(404, { message: 'no' });
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      d.basePath = base + '/ari';
      return json(200, d);
    }
    let m;
    if (req.method === 'GET' && p === '/applications/' + app) return appRegistrada ? json(200, { name: app, channel_ids: [], bridge_ids: [], endpoint_ids: [], device_names: [], events_allowed: [], events_disallowed: [] }) : json(404, { message: 'Application not found' });
    if (req.method === 'GET' && p === '/channels') return json(200, [...canales.values()]);
    if (req.method === 'GET' && p === '/endpoints') return json(200, internos);
    if (req.method === 'GET' && p === '/bridges') return json(200, [...puentes.values()]);
    if (req.method === 'POST' && p === '/bridges') return json(200, nuevoPuente({ bridge_type: args.type || 'mixing', name: args.name || '' }));
    if (req.method === 'POST' && (m = /^\/bridges\/([^/]+)$/.exec(p))) return json(200, nuevoPuente({ id: m[1], bridge_type: args.type || 'mixing' }));
    if (req.method === 'DELETE' && (m = /^\/bridges\/([^/]+)$/.exec(p))) { puentes.delete(m[1]); return json(204); }
    if (req.method === 'POST' && (m = /^\/bridges\/([^/]+)\/addChannel$/.exec(p))) {
      const b = puentes.get(m[1]); if (!b) return json(404, { message: 'Bridge not found' });
      for (const id of String(args.channel).split(',')) if (!b.channels.includes(id)) b.channels.push(id);
      return json(204);
    }
    if (req.method === 'POST' && (p === '/channels' || (m = /^\/channels\/([^/]+)$/.exec(p))) && !/\/channels\/(create|externalMedia)$/.test(p)) {
      const ch = nuevoCanal({ id: (m && m[1]) || args.channelId || undefined, name: String(args.endpoint || 'PJSIP/x') + '-' + (++seq), state: 'Down',
        caller: { name: '', number: String(args.callerId || '') }, dialplan: { context: args.context || 'internal', exten: args.extension || 's', priority: 1, app_name: args.app ? 'Stasis' : '', app_data: args.app ? args.app + ',' + (args.appArgs || '') : '' } });
      return json(200, ch);
    }
    if (req.method === 'POST' && p === '/channels/externalMedia') return json(200, nuevoCanal({ name: 'UnicastRTP/' + args.external_host + '-' + seq, dialplan: { context: '', exten: '', priority: 1, app_name: 'Stasis', app_data: app + ',' + (args.data || '') } }));
    if ((m = /^\/channels\/([^/]+)(\/[a-z_A-Z]+)?(\/[^/]+)?$/.exec(p))) {
      const ch = canales.get(m[1]);
      const sub = m[2] || '';
      if (req.method === 'GET' && !sub) return ch ? json(200, ch) : json(404, { message: 'Channel not found' });
      if (!ch) return json(404, { message: 'Channel not found' });
      if (req.method === 'DELETE' && !sub) { canales.delete(m[1]); emitir({ type: 'ChannelDestroyed', channel: ch, cause: 16, cause_txt: 'Normal Clearing' }); return json(204); }
      if (sub === '/snoop') return json(200, nuevoCanal({ name: 'Snoop/' + ch.id + '-' + seq, dialplan: { context: '', exten: '', priority: 1, app_name: 'Stasis', app_data: app + ',' + (args.appArgs || '') } }));
      if (sub === '/variable' && req.method === 'GET') return json(200, { value: (ch.vars || {})[args.variable] || '' });
      if (sub === '/variable') { ch.vars = Object.assign(ch.vars || {}, { [args.variable]: args.value }); return json(204); }
      if (sub === '/play') return json(200, { id: 'pb-' + (++seq), media_uri: args.media, target_uri: 'channel:' + ch.id, language: 'es', state: 'queued' });
      if (sub === '/continue') { ch.continuo = args; return json(204); }
      if (sub === '/answer') { ch.state = 'Up'; return json(204); }
      if (sub === '/hold') { ch.retenido = req.method === 'POST'; return json(204); }
      return json(204);
    }
    return json(404, { message: 'sin ruta en el ARI falso: ' + req.method + ' ' + p });
  }

  const server = http.createServer((req, res) => {
    let c = '';
    req.on('data', (d) => { c += d; });
    req.on('end', () => responder(req, res, c));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    if (!req.url.startsWith('/ari/events')) return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      for (const f of esperandoWs.splice(0)) f();
    });
  });
  const esperandoWs = [];
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + server.address().port;

  return {
    url: base,
    env: { ARI_URL: base, ARI_USER: 'pbxng', ARI_PASS: 'x' },
    canales, puentes,
    /* Un canal que existe en la central. Se avisa con ChannelCreated. */
    canal(c) { const ch = nuevoCanal(c); emitir({ type: 'ChannelCreated', channel: ch }); return ch; },
    interno(e) { internos.push(Object.assign({ technology: 'PJSIP', state: 'online', channel_ids: [] }, e)); },
    /* StasisStart: la llamada entró a la aplicación con esos argumentos. */
    stasis(id, args) { const ch = canales.get(id); emitir({ type: 'StasisStart', channel: ch, args: args || [] }); return ch; },
    emitir,
    colgar(id) { const ch = canales.get(id); canales.delete(id); emitir({ type: 'ChannelDestroyed', channel: ch, cause: 16 }); },
    fallar(metodo, ruta, status) { errores.set(metodo + ' ' + ruta, status); },
    sanar() { errores.clear(); },
    perderApp() { appRegistrada = false; },
    pedidos(metodo, re) { return recibidos.filter((r) => (!metodo || r.method === metodo) && (!re || re.test(r.path))); },
    olvidar() { recibidos.length = 0; },
    /* Espera a que la API abra el WebSocket de eventos (ari.start). */
    conectado(ms = 20000) {
      if (sockets.size) return Promise.resolve();
      return new Promise((ok, mal) => { const t = setTimeout(() => mal(new Error('la API no abrió el WebSocket de ARI en ' + ms + ' ms')), ms); esperandoWs.push(() => { clearTimeout(t); ok(); }); });
    },
    cortarWs() { for (const s of sockets) s.terminate(); },
    cerrar() { for (const s of sockets) s.terminate(); return new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }); },
  };
}

module.exports = { ariFalso };
