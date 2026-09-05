/* ============================================================================
 *  PBX-NG · Motor de llamadas sobre ARI.
 *
 *  Hasta 1.3 el estado de internos y de llamadas activas se ENCUESTABA por ARI cada
 *  3 s (endpoints.list / channels.list) aunque Asterisk ya empuja esos cambios por
 *  eventos; y la supervision (escucha / susurro / irrupcion) era un Originate+ChanSpy
 *  por AMI a ciegas: devolvia ok sin saber si el supervisor llego a entrar y no
 *  habia forma de cortarla desde el panel.
 *
 *  Este modulo:
 *    - se suscribe a TODOS los eventos de Asterisk (ari.start(app, true)) y mantiene
 *      una cache de canales y endpoints: el panel se refresca por evento, no por
 *      polling (queda un reconciliado lento por si se pierde algo);
 *    - expone control de llamadas por API: marcar desde un interno (click-to-dial),
 *      colgar, retener/reanudar, transferir a ciegas, aparcar;
 *    - hace la supervision con snoopChannel: un canal espia con estado real, bridge
 *      propio, id de sesion y un DELETE para terminarla.
 *
 *  Todo lo que necesita del resto de app.js llega por `deps` (nada global).
 * ==========================================================================*/
'use strict';

const PJSIP = 'PJSIP/';
const extOf = (name) => { const m = /^PJSIP\/([^-]+)-/.exec(name || ''); return m ? m[1] : null; };

module.exports = function initCallEngine(deps) {
  const { app, auth, amiAction, amiCommand, broadcastSoon, log } = deps;
  /* ¿El que pide puede operar sobre `ext`? (app.js mismaExt: admin/supervisor todo,
   * agente y token phone sólo su interno). Si no viene, se deja pasar (compatibilidad). */
  const mismaExt = deps.mismaExt || (() => true);
  const soloPropia = (req, ext) => { if (!mismaExt(req, ext)) { const e = new Error('no podés operar llamadas de otra extensión'); e.status = 403; throw e; } return ext; };
  const L = log || ((...a) => console.log('[calls]', ...a));
  let ari = null;
  let primed = false;
  const channels = new Map();   // id -> { id, name, state, caller, connected, started, ext }
  const endpoints = new Map();  // resource -> { state, channels }
  const spies = new Map();      // spyId -> { id, sup, target, mode, bridgeId, snoopId, supId, since }

  const chRow = (c) => ({ id: c.id, name: c.name, state: c.state, caller: c.caller && c.caller.number, connected: c.connected && c.connected.number, started: c.creationtime || null, ext: extOf(c.name) });
  const isInternal = (c) => /^(Snoop|Local|UnicastRTP|Recorder|Announcer)\//.test(c.name || '');

  /* ---------- cache por eventos ---------- */
  async function prime() {
    if (!ari) return;
    try {
      const [chs, eps] = await Promise.all([ari.channels.list(), ari.endpoints.list()]);
      channels.clear(); for (const c of chs) if (!isInternal(c)) channels.set(c.id, chRow(c));
      endpoints.clear(); for (const e of eps) endpoints.set(e.resource, { state: e.state, channels: (e.channel_ids || []).length });
      primed = true;
    } catch (e) { primed = false; L('prime', e.message); }
  }
  function attach(client) {
    ari = client; primed = false;
    const touch = () => broadcastSoon && broadcastSoon();
    const onCh = (ev, c) => { if (!c || isInternal(c)) return; channels.set(c.id, chRow(c)); touch(); };
    client.on('ChannelCreated', onCh);
    client.on('ChannelStateChange', onCh);
    client.on('ChannelCallerId', onCh);
    client.on('ChannelConnectedLine', onCh);
    client.on('ChannelDestroyed', (ev, c) => { if (c) channels.delete(c.id); touch(); });
    client.on('EndpointStateChange', (ev, e) => { if (e && e.resource) { endpoints.set(e.resource, { state: e.state, channels: (e.channel_ids || []).length }); touch(); } });
    client.on('DeviceStateChanged', () => touch());
    /* Reconciliado lento: si un evento se perdio (reconexion, carga), la cache se
     * corrige sola sin que nadie lo note. */
    prime();
  }
  function detach() { ari = null; primed = false; channels.clear(); endpoints.clear(); }
  setInterval(() => { if (ari) prime(); }, 20000);

  /* Lectura: cache si esta lista, si no la API (ej. justo despues de conectar). */
  async function getChannels() {
    if (!ari) return [];
    if (primed) return Array.from(channels.values());
    try { return (await ari.channels.list()).filter((c) => !isInternal(c)).map(chRow); } catch (_) { return []; }
  }
  async function endpointStates() {
    const map = {};
    if (!ari) return map;
    if (primed) { for (const [k, v] of endpoints) map[k] = v; return map; }
    try { for (const e of await ari.endpoints.list()) map[e.resource] = { state: e.state, channels: (e.channel_ids || []).length }; } catch (_) {}
    return map;
  }
  const chanOfExt = async (ext) => (await getChannels()).find((c) => c.ext === String(ext) && c.state !== 'Down') || null;

  /* ---------- Stasis: patas de la supervision ---------- */
  async function handleStasis(event, channel) {
    const args = event.args || [];
    if (args[0] !== 'spyjoin' && args[0] !== 'spysnoop') return false;
    const s = spies.get(args[1]);
    if (!s) { try { await channel.hangup(); } catch (_) {} return true; }
    try { await channel.answer(); } catch (_) {}
    try { await ari.bridges.addChannel({ bridgeId: s.bridgeId, channel: channel.id }); } catch (e) { L('spy add', e.message); }
    if (args[0] === 'spyjoin') s.supId = channel.id;
    return true;
  }

  /* ---------- supervision con snoop ---------- */
  async function startSpy({ sup, target, mode }) {
    if (!ari) {
      // Sin ARI: el camino viejo por AMI (a ciegas, pero funciona)
      const opt = mode === 'whisper' ? 'qw' : mode === 'barge' ? 'qB' : 'q';
      await amiAction({ Action: 'Originate', Channel: PJSIP + sup, Application: 'ChanSpy', Data: PJSIP + target + ',' + opt, CallerID: 'Monitor <' + sup + '>', Async: 'true', Timeout: 30000 });
      return { id: null, via: 'ami' };
    }
    const tgt = await chanOfExt(target);
    if (!tgt) { const e = new Error('el interno ' + target + ' no tiene una llamada en curso'); e.status = 404; throw e; }
    const id = 'spy-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const whisper = mode === 'whisper' ? 'out' : mode === 'barge' ? 'both' : 'none';
    const bridge = await ari.bridges.create({ type: 'mixing', name: id });
    const s = { id, sup: String(sup), target: String(target), mode: mode || 'listen', bridgeId: bridge.id, snoopId: null, supId: null, since: new Date().toISOString() };
    spies.set(id, s);
    try {
      const snoop = await ari.channels.snoopChannel({ channelId: tgt.id, app: deps.appName, appArgs: 'spysnoop,' + id, spy: 'both', whisper });
      s.snoopId = snoop.id;
      await ari.channels.originate({ endpoint: PJSIP + sup, app: deps.appName, appArgs: 'spyjoin,' + id, callerId: '"Monitor ' + target + '" <' + sup + '>', timeout: 30 });
    } catch (e) { await stopSpy(id).catch(() => {}); throw e; }
    // Si la llamada supervisada termina, la sesion se cierra sola
    const onEnd = (ev, c) => { if (c && (c.id === tgt.id || c.id === s.snoopId || c.id === s.supId)) { ari.removeListener('ChannelDestroyed', onEnd); stopSpy(id).catch(() => {}); } };
    ari.on('ChannelDestroyed', onEnd);
    return { id, via: 'ari', mode: s.mode };
  }
  async function stopSpy(id) {
    const s = spies.get(id); if (!s) return false;
    spies.delete(id);
    for (const cid of [s.supId, s.snoopId]) if (cid) { try { await ari.channels.hangup({ channelId: cid }); } catch (_) {} }
    try { await ari.bridges.destroy({ bridgeId: s.bridgeId }); } catch (_) {}
    return true;
  }

  /* ---------- control de llamadas ---------- */
  // Transferencia a ciegas: se manda al OTRO extremo (el que habla con `ext`) al destino.
  async function peerOf(ext) {
    const out = await amiCommand('core show channels concise');
    const mine = String(out).split('\n').find((l) => l.startsWith(PJSIP + ext + '-'));
    if (!mine) return null;
    const f = mine.split('!');                       // Channel!Context!Exten!Prio!State!App!Data!CallerID!Acct!AMA!Dur!BridgeId
    const bridgeId = f[f.length - 1] && f[f.length - 1].trim();
    if (!bridgeId) return null;
    const peer = String(out).split('\n').find((l) => l !== mine && l.trim().endsWith(bridgeId));
    return peer ? peer.split('!')[0] : null;
  }
  async function blindTransfer(ext, to, context) {
    const peer = await peerOf(ext);
    if (!peer) { const e = new Error('el interno ' + ext + ' no esta en una llamada puenteada'); e.status = 404; throw e; }
    await amiAction({ Action: 'Redirect', Channel: peer, Context: context || 'internal', Exten: String(to), Priority: 1 });
    return { peer, to: String(to) };
  }

  /* ---------- rutas ---------- */
  const need = (v, what) => { if (!v) { const e = new Error(what + ' requerido'); e.status = 400; throw e; } return v; };
  const wrap = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };

  app.get('/api/calls/live', auth, wrap(async () => ({ channels: await getChannels(), spies: Array.from(spies.values()), via: ari ? (primed ? 'eventos' : 'api') : 'sin-ari' })));

  // click-to-dial: llama al interno y, cuando atiende, marca el destino por el dialplan
  app.post('/api/calls/dial', auth, wrap(async (req) => {
    const from = soloPropia(req, need(req.body && req.body.from, 'from')); const to = need(req.body && req.body.to, 'to');
    if (!ari) { const e = new Error('ARI no disponible'); e.status = 503; throw e; }
    const ch = await ari.channels.originate({ endpoint: PJSIP + from, extension: String(to), context: (req.body && req.body.context) || 'internal', priority: 1, callerId: '"' + to + '" <' + to + '>', timeout: 40, variables: { PBXNG_C2D: '1' } });
    return { ok: true, channel: ch.id };
  }));
  app.post('/api/calls/:id/hangup', auth, wrap(async (req) => { if (!ari) throw Object.assign(new Error('ARI no disponible'), { status: 503 }); await ari.channels.hangup({ channelId: req.params.id }); return { ok: true }; }));
  app.post('/api/calls/:id/hold', auth, wrap(async (req) => { if (!ari) throw Object.assign(new Error('ARI no disponible'), { status: 503 }); await ari.channels.hold({ channelId: req.params.id }); return { ok: true }; }));
  app.post('/api/calls/:id/unhold', auth, wrap(async (req) => { if (!ari) throw Object.assign(new Error('ARI no disponible'), { status: 503 }); await ari.channels.unhold({ channelId: req.params.id }); return { ok: true }; }));
  app.post('/api/calls/transfer', auth, wrap(async (req) => ({ ok: true, ...(await blindTransfer(soloPropia(req, need(req.body && req.body.ext, 'ext')), need(req.body && req.body.to, 'to'), req.body && req.body.context)) })));
  app.post('/api/calls/park', auth, wrap(async (req) => ({ ok: true, ...(await blindTransfer(soloPropia(req, need(req.body && req.body.ext, 'ext')), (req.body && req.body.slot) || '700', 'internal')) })));

  app.get('/api/calls/spy', auth, wrap(async () => Array.from(spies.values())));
  app.post('/api/calls/spy', auth, wrap(async (req) => { const b = req.body || {}; need(b.sup, 'supervisor'); need(b.target, 'destino'); if (String(b.sup) === String(b.target)) throw Object.assign(new Error('el supervisor no puede espiarse a si mismo'), { status: 400 }); return { ok: true, ...(await startSpy({ sup: b.sup, target: b.target, mode: b.mode })) }; }));
  app.delete('/api/calls/spy/:id', auth, wrap(async (req) => ({ ok: await stopSpy(req.params.id) })));

  return { attach, detach, getChannels, endpointStates, handleStasis, startSpy, stopSpy, blindTransfer, spies };
};
