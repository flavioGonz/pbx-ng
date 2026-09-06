/* ============================================================================
 *  PBX-NG · Troncales y rutas (Troncales, Rutas, Configuración → SBC-NG).
 *
 *  Todo lo que conecta la central con el mundo exterior: las troncales de operador
 *  (fila en pbxng_trunks + endpoint/aor/auth/registration pjsip en las tablas ps_*),
 *  las rutas salientes (patrón → Dial por una troncal, escritas en el dialplan
 *  realtime del contexto `internal`) y entrantes (DID → destino en `from-trunk`), el
 *  estado real de cada troncal (registro saliente + qualify + OPTIONS) y el diagnóstico
 *  de troncal (diagtrunk.js).
 *
 *  Acá vive también el enlace con SBC-NG (módulo "Conexión a SBC-NG"): SBC-NG es OTRO
 *  producto; PBX-NG funciona completa sin él y, cuando hay uno adelante, se lo conecta
 *  como una troncal fija ('to-sbc'). `sbcLink()` es lo único que el resto de la PBX
 *  debe mirar para decidir "hay SBC adelante" (auth.js lo usa en el enrolado, app.js en
 *  la topología, las alertas y el detalle de internos).
 *
 *  Acceso: las rutas se registran DESPUÉS del gate de auth + RBAC de app.js; qué rol ve
 *  o escribe cada familia (`trunks`, `routes`, `sbc-link`) lo decide rbac.js.
 * ==========================================================================*/
'use strict';

const _dgram = require('dgram');

/**
 * deps:
 *   app               Express (las rutas se registran acá, DESPUÉS del gate)
 *   pool              pg.Pool
 *   NODES             direcciones del despliegue (domain para el enlace WSS de troncales WebRTC)
 *   amiCommand        (cmd) => salida del CLI de Asterisk por AMI (pjsip show registrations/contacts)
 *   endpointStates    () => estado de los endpoints pjsip según el motor ARI (callengine.js)
 *   moduleEnabled     (id) => si el módulo `mod_<id>` está encendido (app.js, Configuración → Módulos)
 *   setDialplan       (client, context, exten, rows) escribe una extensión en el dialplan realtime (app.js)
 *   astFwd            (method, path, body, ms) llamada al agente de Asterisk (reload tras tocar el SBC)
 *   salud             salud.probarPuerto para medir el SBC en GET /api/sbc-link
 *   diagtrunk         diagnóstico de troncal (POST /api/trunks/diagnose)
 *   errorHttp         traduce errores a {error} con status (errores.js)
 *   broadcastSoon     refresca el snapshot del socket tras cambiar troncales o rutas
 *   logger            fábrica de loggers de log.js (logger('TRK'), logger('SBC'))
 *
 * Devuelve: { sbcLink, upsertSbcLink, invalidarSbcLink, trunkStatuses, defaultOutTrunk, SBC_TRUNK }.
 */
module.exports = function init(deps) {
  const { app, pool, NODES, amiCommand, endpointStates, moduleEnabled, setDialplan, astFwd, salud, diagtrunk, errorHttp, broadcastSoon, logger } = deps;

  /* ============================================================
   *  Enlace con SBC-NG (modulo "Conexion a SBC-NG").
   *  SBC-NG es OTRO producto. PBX-NG funciona completo sin el; cuando hay uno
   *  adelante, se lo conecta como una troncal fija ('to-sbc') y el modulo `sbc`
   *  decide si el panel lo muestra y si el ruteo saliente lo usa por defecto.
   *  Nada mas de la PBX debe suponer que existe un SBC.
   * ============================================================ */
  const SBC_TRUNK = 'to-sbc';
  let _sbcLinkCache = { t: 0, v: null };
  async function sbcLink(fresh) {
    if (!fresh && _sbcLinkCache.v && Date.now() - _sbcLinkCache.t < 5000) return _sbcLinkCache.v;
    const out = { enabled: false, configured: false, name: SBC_TRUNK, host: '', port: 5060, transport: 'udp', context: 'from-trunk', codecs: ['ulaw', 'alaw', 'g722'], panel_url: '' };
    try {
      out.enabled = await moduleEnabled('sbc');
      const { rows } = await pool.query("SELECT name, provider_host, provider_port, adv_config FROM pbxng_trunks WHERE kind='sbc' ORDER BY (name=$1) DESC, id LIMIT 1", [SBC_TRUNK]);
      if (rows[0]) {
        const a = rows[0].adv_config || {};
        out.configured = true; out.name = rows[0].name; out.host = rows[0].provider_host || ''; out.port = +rows[0].provider_port || 5060;
        out.transport = a.transport || 'udp'; out.context = a.context || 'from-trunk'; if (Array.isArray(a.codecs) && a.codecs.length) out.codecs = a.codecs;
      }
      const { rows: pu } = await pool.query("SELECT value FROM pbxng_settings WHERE key='sbc_panel_url'"); out.panel_url = (pu[0] && pu[0].value) || '';
    } catch (_) {}
    /* activo = modulo encendido Y troncal configurada: es lo unico que el resto del
     * codigo debe mirar para decidir "hay SBC adelante" */
    out.active = out.enabled && out.configured;
    _sbcLinkCache = { t: Date.now(), v: out };
    return out;
  }
  /* Crea o actualiza la troncal fija hacia el SBC-NG (endpoint pjsip 'to-sbc' identificado
   * por IP) y, si la central todavia no tiene rutas salientes, una ruta "marca 0" que
   * sale por el SBC. Enciende el modulo. Usado por /api/sbc-link y por
   * POST /api/trunks kind=sbc (compatibilidad). */
  async function upsertSbcLink(b) {
    const ip = String(b.host || '').trim();
    if (!ip) { const e = new Error('la dirección IP del SBC-NG es obligatoria'); e.status = 400; throw e; }
    const port = +b.port || 5060;
    const transport = ['udp', 'tcp', 'tls'].includes(b.transport) ? b.transport : 'udp';
    const ctx = (b.context || 'from-trunk').trim();
    const codecs = (Array.isArray(b.codecs) && b.codecs.length) ? b.codecs.join(',') : 'ulaw,alaw,g722';
    const tenant_id = +b.tenant_id || 1;
    const contact = 'sip:' + ip + ':' + port + (transport !== 'udp' ? ';transport=' + transport : '');
    const c = await pool.connect();
    // Declarada acá y no dentro del try: se devuelve después del finally (antes era un
    // ReferenceError al final de cada guardado del enlace SBC; lo encontró el lint).
    let ruta = null;
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO ps_aors(id,contact,qualify_frequency) VALUES($1,$2,30) ON CONFLICT(id) DO UPDATE SET contact=$2,qualify_frequency=30", [SBC_TRUNK, contact]);
      await c.query("INSERT INTO ps_endpoints(id,transport,aors,context,disallow,allow,direct_media,rtp_symmetric,force_rport,rewrite_contact,identify_by,tenant_id,pbxng_kind) VALUES($1,$2,$1,$3,'all',$4,'no','yes','yes','yes','ip',$5,'trunk') ON CONFLICT(id) DO UPDATE SET context=$3,allow=$4,transport=$2,aors=$1,identify_by='ip',direct_media='no'", [SBC_TRUNK, 'transport-' + transport, ctx, codecs, tenant_id]);
      await c.query("INSERT INTO ps_endpoint_id_ips(id,endpoint,match) VALUES($1,$1,$2) ON CONFLICT(id) DO UPDATE SET match=$2,endpoint=$1", [SBC_TRUNK, ip]);
      const adv = { sbc: true, label: 'SBC-NG', provider_host: ip, provider_port: port, context: ctx, codecs: codecs.split(','), mode: 'ip', transport };
      await c.query("INSERT INTO pbxng_trunks (name,provider_host,provider_port,username,do_register,tenant_id,kind,adv_config) VALUES ($1,$2,$3,NULL,false,$4,'sbc',$5) ON CONFLICT (name) DO UPDATE SET kind='sbc',provider_host=$2,provider_port=$3,adv_config=$5", [SBC_TRUNK, ip, port, tenant_id, JSON.stringify(adv)]);
      await c.query("DELETE FROM pbxng_settings WHERE key='sbc_link_removed'");
      await c.query("INSERT INTO pbxng_settings(key,value) VALUES('mod_sbc','1') ON CONFLICT(key) DO UPDATE SET value='1'");
      if (b.panel_url !== undefined) await c.query("INSERT INTO pbxng_settings(key,value) VALUES('sbc_panel_url',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [String(b.panel_url || '').trim()]);
      if (b.create_route !== false) {
        const rc = await c.query('SELECT count(*)::int AS n FROM pbxng_outbound_routes');
        if (!rc.rows[0] || rc.rows[0].n === 0) {
          const pat = '0X.'; const strip = 1;
          await c.query("INSERT INTO pbxng_outbound_routes (name,pattern,trunk,strip,prepend,callerid) VALUES ('Salida por el SBC-NG (marca 0)',$1,$2,$3,NULL,NULL)", [pat, SBC_TRUNK, strip]);
          await setDialplan(c, 'internal', outExten(pat), [[1, 'Dial', 'PJSIP/${EXTEN:' + strip + '}@' + SBC_TRUNK + ',60'], [2, 'Hangup', '']]);
          ruta = pat;
        }
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    _sbcLinkCache.v = null;
    try { await astFwd('POST', '/reload', {}, 12000); } catch (_) {}
    return { ruta };
  }
  // Sondeo SIP OPTIONS a una troncal (para troncales gestionadas por el SBC/kamailio)
  const _sipProbeCache = {};
  function sipOptionsProbe(host, port, timeout) {
    port = +port || 5060; timeout = timeout || 1500;
    return new Promise((resolve) => {
      let done = false; const sock = _dgram.createSocket('udp4');
      const rnd = () => Math.random().toString(36).slice(2, 10);
      const msg = [
        `OPTIONS sip:${host}:${port} SIP/2.0`,
        `Via: SIP/2.0/UDP pbxng-probe;branch=z9hG4bK${rnd()};rport`,
        'Max-Forwards: 70',
        `From: <sip:pbxng@pbxng>;tag=${rnd()}`,
        `To: <sip:${host}:${port}>`,
        `Call-ID: ${rnd()}${rnd()}@pbxng`,
        'CSeq: 1 OPTIONS',
        'Contact: <sip:pbxng@pbxng>',
        'Content-Length: 0', '', ''
      ].join('\r\n');
      const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); try { sock.close(); } catch (_) {} resolve(ok); };
      const timer = setTimeout(() => finish(false), timeout);
      sock.on('message', () => finish(true));
      sock.on('error', () => finish(false));
      try { sock.send(Buffer.from(msg), port, host, (err) => { if (err) finish(false); }); } catch (_) { finish(false); }
    });
  }
  async function sipProbeCached(host, port) {
    const key = host + ':' + (port || 5060); const c = _sipProbeCache[key];
    if (c && Date.now() - c.t < 15000) return c.ok;
    const ok = await sipOptionsProbe(host, port, 1500);
    _sipProbeCache[key] = { t: Date.now(), ok }; return ok;
  }
  // Estado real de troncales: registro saliente (pjsip show registrations) + alcanzabilidad
  async function trunkStatuses(trunks) {
    let reg = '';
    try { reg = await amiCommand('pjsip show registrations'); } catch (_) {}
    const eps = await endpointStates();
    const lines = String(reg).split('\n');
    const out = {};
    const rttMap = {};
    try { const co = await amiCommand('pjsip show contacts'); for (const line of String(co).split('\n')) { if (!line.includes('Contact:') || !line.includes('sip:')) continue; const aorM = /Contact:\s*([^/]+)\//.exec(line); const toks = line.trim().split(/\s+/); const last = toks[toks.length - 1]; const rtt = /^[0-9.]+$/.test(last) ? parseFloat(last) : null; if (aorM) rttMap[aorM[1].trim()] = rtt; } } catch (_) {}
    for (const t of trunks) {
      if (t.kind === 'webrtc-client') {
        /* El bridge cliente-WSS vivia en el SBC embebido, que ya no forma parte de
         * PBX-NG. Estas troncales se administran en SBC-NG. */
        out[t.name] = { status: 'offline', detail: 'Requiere SBC-NG (troncal WebRTC cliente)' };
        continue;
      }
      if (t.kind === 'webrtc') {
        const ep = eps[t.name];
        out[t.name] = (ep && ep.state === 'online') ? { status: 'online', detail: 'Conectada (WebRTC/WSS)' } : { status: 'offline', detail: 'Esperando registro WSS' };
        continue;
      }
      if (t.kind === 'kamailio') {
        const up = await sipProbeCached(t.provider_host, t.provider_port);
        out[t.name] = up ? { status: 'online', detail: 'Alcanzable (OPTIONS) · vía SBC-NG' } : { status: 'offline', detail: 'No responde · vía SBC-NG' };
        continue;
      }
      const ep = eps[t.name]; const reachable = ep && ep.state === 'online';
      if (t.do_register) {
        const rx = new RegExp('^\\s*' + t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/');
        const line = lines.find(l => rx.test(l)) || '';
        if (/Registered/i.test(line)) out[t.name] = { status: 'online', detail: 'Registrada' + ((line.match(/exp\.?\s*(\d+)/i) || [])[1] ? ' (exp ' + line.match(/exp\.?\s*(\d+)/i)[1] + 's)' : '') };
        else if (/Rejected/i.test(line)) out[t.name] = { status: 'offline', detail: 'Rechazada por el proveedor' };
        else if (/Auth/i.test(line)) out[t.name] = { status: 'offline', detail: 'Autenticando…' };
        else if (line) out[t.name] = { status: 'offline', detail: 'Sin registrar' };
        else out[t.name] = { status: reachable ? 'online' : 'offline', detail: reachable ? 'Alcanzable' : 'Sin registro' };
      } else {
        out[t.name] = { status: reachable ? 'online' : 'offline', detail: reachable ? 'Alcanzable (qualify)' : 'No responde' };
      }
    }
    for (const t of trunks) { if (out[t.name] && rttMap[t.name] != null) out[t.name].rtt = rttMap[t.name]; }
    return out;
  }

  /* Rutas salientes e entrantes, troncales y enlace SBC-NG. Se registran en este orden
   * (el mismo que tenían en app.js). */
  // --- Conexion a SBC-NG (modulo) ---
  app.get('/api/sbc-link', async (req, res) => {
    try {
      const lk = await sbcLink(true);
      let estado = null;
      if (lk.configured && lk.host) { const p = await salud.probarPuerto(lk.host, lk.port); estado = { vivo: p.vivo, ms: p.ms ?? null, motivo: p.motivo || null }; }
      const { rows: ru } = await pool.query('SELECT count(*)::int AS n FROM pbxng_outbound_routes WHERE trunk=$1', [lk.name]).catch(() => ({ rows: [{ n: 0 }] }));
      res.json({ ...lk, estado, rutas_salientes: ru[0] ? ru[0].n : 0 });
    } catch (e) { errorHttp(res, e); }
  });
  app.post('/api/sbc-link', async (req, res) => {
    try { const r = await upsertSbcLink(req.body || {}); broadcastSoon(); res.json({ ok: true, ruta_creada: r.ruta, link: await sbcLink(true) }); }
    catch (e) { errorHttp(res, e); }
  });
  /* Desconectar el SBC-NG: borra la troncal fija y las rutas salientes que dependian de
   * ella (quedarian marcando a un endpoint inexistente) y apaga el modulo. La PBX sigue
   * funcionando con sus troncales de operador directas. */
  app.delete('/api/sbc-link', async (req, res) => {
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      const { rows: rutas } = await c.query('SELECT id, pattern FROM pbxng_outbound_routes WHERE trunk=$1', [SBC_TRUNK]);
      for (const r of rutas) { await c.query("DELETE FROM extensions WHERE context='internal' AND exten=$1", [outExten(r.pattern)]); await c.query('DELETE FROM pbxng_outbound_routes WHERE id=$1', [r.id]); }
      for (const t of ['ps_registrations', 'ps_endpoint_id_ips', 'ps_endpoints', 'ps_auths', 'ps_aors']) await c.query(`DELETE FROM ${t} WHERE id=$1`, [SBC_TRUNK]);
      await c.query('DELETE FROM pbxng_trunks WHERE kind=$1', ['sbc']);
      await c.query("INSERT INTO pbxng_settings(key,value) VALUES('sbc_link_removed','1') ON CONFLICT(key) DO UPDATE SET value='1'");
      await c.query("INSERT INTO pbxng_settings(key,value) VALUES('mod_sbc','0') ON CONFLICT(key) DO UPDATE SET value='0'");
      await c.query('COMMIT');
      _sbcLinkCache.v = null;
      try { await astFwd('POST', '/reload', {}, 12000); } catch (_) {}
      broadcastSoon();
      res.json({ ok: true, rutas_borradas: rutas.length });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  // ---------------- Rutas SALIENTES ----------------
  function outExten(p) { return p && p[0] === '_' ? p : '_' + p; }
  app.get('/api/routes/outbound', async (req, res) => {
    try { const { rows } = await pool.query('SELECT id,name,pattern,trunk,strip,prepend,callerid FROM pbxng_outbound_routes ORDER BY id'); res.json(rows); }
    catch (e) { errorHttp(res, e); }
  });
  // Troncal de salida por defecto. Con el modulo "Conexion a SBC-NG" activo y la troncal
  // to-sbc configurada, el saliente va por el SBC; si no, sale directo por la primera
  // troncal de operador. La PBX funciona completa con o sin SBC adelante.
  async function defaultOutTrunk(q) {
    try {
      const lk = await sbcLink();
      if (lk.active) return lk.name;
      const r = await q.query("SELECT name FROM pbxng_trunks WHERE COALESCE(kind,'asterisk') NOT IN ('webrtc','webrtc-client','sbc','kamailio') ORDER BY id LIMIT 1");
      return r.rows[0] ? r.rows[0].name : null;
    } catch (_) { return null; }
  }
  app.post('/api/routes/outbound', async (req, res) => {
    const { name, pattern, trunk, strip = 0, prepend = '', callerid = '' } = req.body || {};
    if (!pattern) return res.status(400).json({ error: 'patrón requerido' });
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      const tk = (trunk && String(trunk).trim()) || (await defaultOutTrunk(c));
      if (!tk) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'No hay ninguna troncal por donde salir: creá una troncal de operador primero (o conectá un SBC-NG en Configuración → SBC-NG).' }); }
      await c.query('INSERT INTO pbxng_outbound_routes (name,pattern,trunk,strip,prepend,callerid) VALUES ($1,$2,$3,$4,$5,$6)', [name || pattern, pattern, tk, +strip || 0, prepend || null, callerid || null]);
      const rows = []; let p = 1;
      if (callerid) rows.push([p++, 'Set', 'CALLERID(num)=' + callerid]);
      rows.push([p++, 'Dial', 'PJSIP/' + (prepend || '') + '${EXTEN:' + (+strip || 0) + '}@' + tk + ',60']);
      rows.push([p++, 'Hangup', '']);
      await setDialplan(c, 'internal', outExten(pattern), rows);
      await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: pattern, trunk: tk });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.delete('/api/routes/outbound/:id', async (req, res) => {
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('SELECT pattern FROM pbxng_outbound_routes WHERE id=$1', [req.params.id]);
      if (rows[0]) await c.query("DELETE FROM extensions WHERE context='internal' AND exten=$1", [outExten(rows[0].pattern)]);
      await c.query('DELETE FROM pbxng_outbound_routes WHERE id=$1', [req.params.id]);
      await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: req.params.id });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  // ---------------- Rutas ENTRANTES (DID) ----------------
  function inboundRows(dest_type, v) {
    if (dest_type === 'ivr') return [[1, 'Goto', 'ivr,' + v + ',1']];
    if (dest_type === 'cola') return [[1, 'Answer', ''], [2, 'Queue', v], [3, 'Hangup', '']];
    if (dest_type === 'app') return [[1, 'Goto', 'internal,' + v + ',1']];
    return [[1, 'Dial', 'PJSIP/' + v + ',30'], [2, 'Voicemail', v + '@default,u'], [3, 'Hangup', '']];
  }
  app.get('/api/routes/inbound', async (req, res) => {
    try { const { rows } = await pool.query('SELECT id,did,name,dest_type,dest_value FROM pbxng_inbound_routes ORDER BY id'); res.json(rows); }
    catch (e) { errorHttp(res, e); }
  });
  app.post('/api/routes/inbound', async (req, res) => {
    const { did, name, dest_type = 'interno', dest_value } = req.body || {};
    if (!did || !dest_value) return res.status(400).json({ error: 'DID y destino requeridos' });
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO pbxng_inbound_routes (did,name,dest_type,dest_value) VALUES ($1,$2,$3,$4)', [did, name || did, dest_type, dest_value]);
      await setDialplan(c, 'from-trunk', did, inboundRows(dest_type, dest_value));
      await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: did });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });
  app.delete('/api/routes/inbound/:id', async (req, res) => {
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('SELECT did FROM pbxng_inbound_routes WHERE id=$1', [req.params.id]);
      if (rows[0]) await c.query("DELETE FROM extensions WHERE context='from-trunk' AND exten=$1", [rows[0].did]);
      await c.query('DELETE FROM pbxng_inbound_routes WHERE id=$1', [req.params.id]);
      await c.query('COMMIT'); broadcastSoon(); res.json({ deleted: req.params.id });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  // ---------------- Troncales SIP (avanzado) ----------------
  const TRUNK_TRANSPORT = { udp: 'transport-udp', tcp: 'transport-tcp', tls: 'transport-tls' };
  function trunkDefaults(o = {}) {
    return {
      provider_host: o.provider_host || '', provider_port: +o.provider_port || 5060,
      transport: ['udp', 'tcp', 'tls'].includes(o.transport) ? o.transport : 'udp',
      mode: o.mode === 'ip' ? 'ip' : 'register',
      username: o.username || '', from_user: o.from_user || o.username || '',
      from_domain: o.from_domain || o.provider_host || '', callerid: o.callerid || '',
      codecs: Array.isArray(o.codecs) && o.codecs.length ? o.codecs : ['ulaw', 'alaw'],
      dtmf_mode: ['rfc4733', 'inband', 'info', 'auto'].includes(o.dtmf_mode) ? o.dtmf_mode : 'rfc4733',
      nat: o.nat !== false, direct_media: !!o.direct_media,
      qualify_frequency: +o.qualify_frequency || 60, expiration: +o.expiration || 3600,
      retry_interval: +o.retry_interval || 60, context: o.context || 'from-trunk',
      outbound_enabled: o.outbound_enabled !== false, outbound_prefix: o.outbound_prefix != null ? String(o.outbound_prefix) : '0',
      outbound_strip: +o.outbound_strip || 0, logo: o.logo || (o.adv_config && o.adv_config.logo) || '',
      dids: Array.isArray(o.dids) ? o.dids.filter(Boolean) : (o.dids ? String(o.dids).split(/[\s,]+/).filter(Boolean) : ((o.adv_config && o.adv_config.dids) || [])),
      channels: +o.channels || (o.adv_config && +o.adv_config.channels) || 0,
      gateway: o.gateway || (o.adv_config && o.adv_config.gateway) || '',
    };
  }
  async function writeAsteriskTrunk(c, name, a, password, tenant_id) {
    for (const t of ['ps_registrations', 'ps_endpoint_id_ips', 'ps_endpoints', 'ps_auths', 'ps_aors']) await c.query(`DELETE FROM ${t} WHERE id=$1`, [name]);
    const tr = TRUNK_TRANSPORT[a.transport] || 'transport-udp';
    const tsuf = a.transport === 'tcp' ? ';transport=tcp' : a.transport === 'tls' ? ';transport=tls' : '';
    const allow = a.codecs.join(',');
    const nat = a.nat ? 'yes' : 'no';
    await c.query("INSERT INTO ps_aors (id,contact,qualify_frequency,max_contacts,tenant_id) VALUES ($1,$2,$3,1,$4)", [name, `sip:${a.provider_host}:${a.provider_port}${tsuf}`, a.qualify_frequency, tenant_id]);
    const hasAuth = !!(a.username && password);
    if (hasAuth) await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$2,$3,$4)", [name, a.username, password, tenant_id]);
    await c.query(
      "INSERT INTO ps_endpoints (id,transport,aors,outbound_auth,context,disallow,allow,from_user,from_domain,callerid,dtmf_mode,direct_media,rtp_symmetric,force_rport,rewrite_contact,identify_by,tenant_id,pbxng_kind) " +
      "VALUES ($1,$2,$1,$3,$4,'all',$5,$6,$7,$8,$9,$10,$11,$11,$11,'username,ip',$12,'trunk')",
      [name, tr, hasAuth ? name : null, a.context, allow, a.from_user || null, a.from_domain || null, a.callerid || null, a.dtmf_mode, a.direct_media ? 'yes' : 'no', nat, tenant_id]
    );
    await c.query("INSERT INTO ps_endpoint_id_ips (id,endpoint,match) VALUES ($1,$1,$2)", [name, a.provider_host]);
    if (a.mode === 'register') {
      const cli = a.username ? `sip:${a.username}@${a.provider_host}:${a.provider_port}${tsuf}` : `sip:${a.provider_host}:${a.provider_port}${tsuf}`;
      await c.query("INSERT INTO ps_registrations (id,server_uri,client_uri,outbound_auth,retry_interval,expiration,transport) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [name, `sip:${a.provider_host}:${a.provider_port}${tsuf}`, cli, hasAuth ? name : null, a.retry_interval, a.expiration, tr]);
    }
    if (a.outbound_enabled) {
      const pre = a.outbound_prefix || '';
      const exten = '_' + (pre ? pre : 'X') + '.';
      const dialNum = a.outbound_strip ? `${'${EXTEN:' + a.outbound_strip + '}'}` : '${EXTEN}';
      await setDialplan(c, 'internal', exten, [[1, 'NoOp', 'Salida ' + name], [2, 'Dial', 'PJSIP/' + dialNum + '@' + name + ',60'], [3, 'Hangup', '']]);
    }
  }

  app.get('/api/trunks', async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT id,name,provider_host,provider_port,username,do_register,tenant_id,COALESCE(kind,'asterisk') AS kind,kam_config,adv_config FROM pbxng_trunks ORDER BY id");
      const st = await trunkStatuses(rows);
      res.json(rows.map(({ kam_config, adv_config, ...t }) => ({ ...t, status: (st[t.name] || {}).status || 'unknown', detail: (st[t.name] || {}).detail || '', register_provider: !!(kam_config && kam_config.register), link: ((t.kind === 'webrtc' || t.kind === 'webrtc-client') && kam_config && (kam_config.link || kam_config.remote_url)) || null, target: ((t.kind === 'webrtc' || t.kind === 'webrtc-client') && kam_config) ? (((String(kam_config.remote_url || kam_config.link || '').match(/wss?:\/\/([^/:]+)/) || [])[1]) || t.provider_host || '') : null, adv: adv_config || ((kam_config && kam_config.logo) ? { logo: kam_config.logo } : null), logo: (adv_config && adv_config.logo) || (kam_config && kam_config.logo) || null, rtt: (st[t.name] || {}).rtt != null ? (st[t.name] || {}).rtt : null, dids: (adv_config && adv_config.dids) || (kam_config && kam_config.dids) || [], channels: (adv_config && adv_config.channels) || (kam_config && kam_config.channels) || 0, gateway: (adv_config && adv_config.gateway) || (kam_config && kam_config.gateway) || '', mode: (t.kind === 'webrtc' || t.kind === 'webrtc-client') ? t.kind : ((adv_config && adv_config.mode) || (t.do_register ? 'register' : 'ip')), transport: (t.kind === 'webrtc' || t.kind === 'webrtc-client') ? 'wss' : ((adv_config && adv_config.transport) || 'udp') })));
    } catch (e) { errorHttp(res, e); }
  });

  app.get('/api/trunks/:name/detail', async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT name,provider_host,provider_port,username,COALESCE(kind,'asterisk') AS kind,adv_config,kam_config FROM pbxng_trunks WHERE name=$1", [req.params.name]);
      if (!rows[0]) return res.status(404).json({ error: 'no existe' });
      const t = rows[0];
      const { rows: au } = await pool.query("SELECT 1 FROM ps_auths WHERE id=$1", [req.params.name]);
      const kc = t.kam_config || {};
      res.json({ name: t.name, kind: t.kind, has_password: !!au[0], username: t.username || kc.username || '', link: (t.kind === 'webrtc') ? (kc.link || ('wss://' + (NODES.domain || '') + '/ws')) : null, remote_url: (t.kind === 'webrtc-client') ? (kc.remote_url || '') : null, adv: trunkDefaults(t.adv_config || t.kam_config || { provider_host: t.provider_host, provider_port: t.provider_port, username: t.username, mode: t.do_register ? 'register' : 'ip' }) });
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/trunks', async (req, res) => {
    const b = req.body || {};
    const { name, password, tenant_id = 1, kind = 'asterisk' } = b;
    // WebRTC (expone enlace WSS; el remoto registra como cliente WSS estándar SIP+DTLS-SRTP)
    if (kind === 'webrtc') {
      if (!name || !password) return res.status(400).json({ error: 'name y password son obligatorios' });
      const uname = (b.username || name);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("INSERT INTO ps_aors (id,max_contacts,remove_existing,qualify_frequency,tenant_id) VALUES ($1,1,'yes',30,$2) ON CONFLICT (id) DO UPDATE SET max_contacts=1,qualify_frequency=30", [name, tenant_id]);
        await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$2,$3,$4) ON CONFLICT (id) DO UPDATE SET username=$2,password=$3", [name, uname, password, tenant_id]);
        await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,webrtc,dtls_auto_generate_cert,ice_support,use_avpf,media_encryption,media_use_received_transport,rtcp_mux,direct_media,rtp_symmetric,force_rport,rewrite_contact,identify_by) VALUES ($1,'transport-ws',$1,$1,'from-trunk','all','ulaw,alaw,g722,vp8,h264',$2,'trunk','yes','yes','yes','yes','dtls','yes','yes','no','yes','yes','yes','username') ON CONFLICT (id) DO UPDATE SET context='from-trunk',webrtc='yes',transport='transport-ws',allow='ulaw,alaw,g722,vp8,h264',media_encryption='dtls',identify_by='username'", [name, tenant_id]);
        const link = 'wss://' + (NODES.domain || '') + '/ws';
        const kam = { kind: 'webrtc', username: uname, wss_path: '/ws', link, note: b.note || '' };
        await c.query("INSERT INTO pbxng_trunks (name,provider_host,provider_port,username,do_register,tenant_id,kind,kam_config) VALUES ($1,$2,5060,$3,false,$4,'webrtc',$5) ON CONFLICT (name) DO UPDATE SET kind='webrtc',username=$3,kam_config=$5", [name, (NODES.domain || ''), uname, tenant_id, JSON.stringify(kam)]);
        await c.query('COMMIT'); broadcastSoon();
        return res.status(201).json({ created: name, kind: 'webrtc', link, username: uname });
      } catch (e) { await c.query('ROLLBACK'); return errorHttp(res, e); } finally { c.release(); }
    }
    // Troncales que vivian en el SBC embebido: hoy se administran en SBC-NG (otro producto).
    if (kind === 'webrtc-client' || kind === 'kamailio') return res.status(400).json({ error: 'Las troncales vía SBC se administran en el panel de SBC-NG. En PBX-NG solo se configura la conexión al SBC (Configuración → SBC-NG).' });
    if (kind === 'sbc') {
      try { const r = await upsertSbcLink({ host: b.provider_host, port: b.provider_port, transport: b.transport, context: b.context, codecs: b.codecs, tenant_id }); broadcastSoon(); return res.status(201).json({ created: SBC_TRUNK, kind: 'sbc', ruta_creada: r.ruta }); }
      catch (e) { return errorHttp(res, e); }
    }
    if (!name || !b.provider_host) return res.status(400).json({ error: 'name y provider_host son obligatorios' });
    const a = trunkDefaults(b);
    if (a.mode === 'register' && !(a.username && password)) return res.status(400).json({ error: 'usuario y contraseña son obligatorios en modo Registro' });
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO pbxng_trunks (name,provider_host,provider_port,username,do_register,tenant_id,kind,adv_config) VALUES ($1,$2,$3,$4,$5,$6,'asterisk',$7)", [name, a.provider_host, a.provider_port, a.username || null, a.mode === 'register', tenant_id, JSON.stringify(a)]);
      await writeAsteriskTrunk(c, name, a, password, tenant_id);
      await c.query('COMMIT'); res.status(201).json({ created: name, mode: a.mode });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  app.put('/api/trunks/:name', async (req, res) => {
    const name = req.params.name; const b = req.body || {};
    const { password, tenant_id = 1, kind = 'asterisk' } = b;
    if (kind === 'webrtc') {
      const uname = (b.username || name);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const { rows: ex } = await c.query("SELECT 1 FROM pbxng_trunks WHERE name=$1", [name]);
        if (!ex[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'troncal no existe' }); }
        const { rows: oldAuth } = await c.query('SELECT password FROM ps_auths WHERE id=$1', [name]);
        const pass = password || (oldAuth[0] ? oldAuth[0].password : null);
        if (!pass) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'contrasena requerida' }); }
        await c.query("INSERT INTO ps_aors (id,max_contacts,remove_existing,qualify_frequency,tenant_id) VALUES ($1,1,'yes',30,$2) ON CONFLICT (id) DO UPDATE SET max_contacts=1,qualify_frequency=30", [name, tenant_id]);
        await c.query("INSERT INTO ps_auths (id,auth_type,username,password,tenant_id) VALUES ($1,'userpass',$2,$3,$4) ON CONFLICT (id) DO UPDATE SET username=$2,password=$3", [name, uname, pass, tenant_id]);
        await c.query("INSERT INTO ps_endpoints (id,transport,aors,auth,context,disallow,allow,tenant_id,pbxng_kind,webrtc,dtls_auto_generate_cert,ice_support,use_avpf,media_encryption,media_use_received_transport,rtcp_mux,direct_media,rtp_symmetric,force_rport,rewrite_contact,identify_by) VALUES ($1,'transport-ws',$1,$1,'from-trunk','all','ulaw,alaw,g722,vp8,h264',$2,'trunk','yes','yes','yes','yes','dtls','yes','yes','no','yes','yes','yes','username') ON CONFLICT (id) DO UPDATE SET context='from-trunk',webrtc='yes',transport='transport-ws',allow='ulaw,alaw,g722,vp8,h264',media_encryption='dtls',identify_by='username'", [name, tenant_id]);
        const link = 'wss://' + (NODES.domain || '') + '/ws';
        const kam = { kind: 'webrtc', username: uname, wss_path: '/ws', link, note: b.note || '' };
        await c.query("UPDATE pbxng_trunks SET username=$2, kind='webrtc', kam_config=$3, adv_config=NULL WHERE name=$1", [name, uname, JSON.stringify(kam)]);
        await c.query('COMMIT'); return res.json({ updated: name, kind: 'webrtc', link, username: uname });
      } catch (e) { await c.query('ROLLBACK'); return errorHttp(res, e); } finally { c.release(); }
    }
    if (kind === 'webrtc-client') {
      if (!b.remote_url || !b.username) return res.status(400).json({ error: 'remote_url y username son obligatorios' });
      try {
        const { rows: old } = await pool.query('SELECT kam_config FROM pbxng_trunks WHERE name=$1', [name]);
        if (!old[0]) return res.status(404).json({ error: 'troncal no existe' });
        const prev = (old[0] && old[0].kam_config) || {};
        const pass = password || prev.password;
        if (!pass) return res.status(400).json({ error: 'contrasena requerida' });
        const rhost = (String(b.remote_url).match(/wss?:\/\/([^/:]+)/) || [])[1] || '';
        const kam = { kind: 'webrtc-client', remote_url: b.remote_url, username: b.username, password: pass, note: b.note || '' };
        await pool.query("UPDATE pbxng_trunks SET provider_host=$2, username=$3, do_register=true, kind='webrtc-client', kam_config=$4, adv_config=NULL WHERE name=$1", [name, rhost, b.username, JSON.stringify(kam)]);
        return res.json({ updated: name, kind: 'webrtc-client' });
      } catch (e) { return errorHttp(res, e); }
    }
    if (!b.provider_host) return res.status(400).json({ error: 'provider_host es obligatorio' });
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      const { rows: ex } = await c.query("SELECT COALESCE(kind,'asterisk') AS kind FROM pbxng_trunks WHERE name=$1", [name]);
      if (!ex[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'troncal no existe' }); }
      const { rows: oldAuth } = await c.query('SELECT password FROM ps_auths WHERE id=$1', [name]);
      const oldPass = oldAuth[0] ? oldAuth[0].password : null;
      for (const t of ['ps_registrations', 'ps_endpoint_id_ips', 'ps_endpoints', 'ps_auths', 'ps_aors']) await c.query(`DELETE FROM ${t} WHERE id=$1`, [name]);
      if (kind === 'kamailio') {
        const { rows: old } = await c.query('SELECT kam_config FROM pbxng_trunks WHERE name=$1', [name]);
        const prev = (old[0] && old[0].kam_config) || {};
        const kam = Object.assign(trunkDefaults(b), { host: b.provider_host, port: +b.provider_port || 5060, register: b.mode !== 'ip', password: password || prev.password || null });
        await c.query("UPDATE pbxng_trunks SET provider_host=$1, provider_port=$2, username=$3, do_register=$4, kind='kamailio', kam_config=$5, adv_config=NULL WHERE name=$6", [b.provider_host, kam.port, b.username || null, kam.register, JSON.stringify(kam), name]);
        await c.query('COMMIT'); return res.json({ updated: name, kind: 'kamailio' });
      }
      const a = trunkDefaults(b);
      const pass = password || oldPass;
      if (a.mode === 'register' && !(a.username && pass)) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'usuario y contraseña requeridos en modo Registro' }); }
      await c.query("UPDATE pbxng_trunks SET provider_host=$1, provider_port=$2, username=$3, do_register=$4, kind='asterisk', kam_config=NULL, adv_config=$5 WHERE name=$6", [a.provider_host, a.provider_port, a.username || null, a.mode === 'register', JSON.stringify(a), name]);
      await writeAsteriskTrunk(c, name, a, pass, tenant_id);
      await c.query('COMMIT'); res.json({ updated: name, mode: a.mode });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  app.delete('/api/trunks/:name', async (req, res) => {
    const { name } = req.params; const c = await pool.connect();
    try { await c.query('BEGIN'); for (const t of ['ps_registrations', 'ps_endpoint_id_ips', 'ps_endpoints', 'ps_auths', 'ps_aors']) await c.query(`DELETE FROM ${t} WHERE id=$1`, [name]); await c.query('DELETE FROM pbxng_trunks WHERE name=$1', [name]); if (name === SBC_TRUNK) { await c.query("INSERT INTO pbxng_settings(key,value) VALUES('sbc_link_removed','1') ON CONFLICT(key) DO UPDATE SET value='1'"); _sbcLinkCache.v = null; } await c.query('COMMIT'); res.json({ deleted: name }); }
    catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  app.post('/api/trunks/diagnose', async (req, res) => { try { res.json(await diagtrunk.diagnosticar(req.body || {})); } catch (e) { errorHttp(res, e); } });
  app.get('/api/registrations', async (req, res) => { try { res.json({ output: await amiCommand('pjsip show registrations') }); } catch (e) { errorHttp(res, e); } });

  /* Semillas de arranque (idempotentes; sin base sólo se loguea el error). */
  /* Troncal fija al SBC creada antes del modulo: se registra en pbxng_trunks para que
   * el panel la vea (idempotente; 'sbc_link_removed' evita resucitarla si la borraron). */
  pool.query("INSERT INTO pbxng_trunks (name,provider_host,provider_port,do_register,tenant_id,kind,adv_config) " +
    "SELECT 'to-sbc', COALESCE((SELECT match FROM ps_endpoint_id_ips WHERE id='to-sbc'),''), 5060, false, 1, 'sbc', " +
    "'{\"sbc\":true,\"label\":\"SBC\",\"mode\":\"ip\",\"transport\":\"udp\"}'::jsonb " +
    "WHERE EXISTS (SELECT 1 FROM ps_endpoints WHERE id='to-sbc') AND NOT EXISTS (SELECT 1 FROM pbxng_trunks WHERE name='to-sbc') AND NOT EXISTS (SELECT 1 FROM pbxng_settings WHERE key='sbc_link_removed')").catch(e => logger('TRK').error('sbc-seed', e));
  /* Instalaciones anteriores al modulo: si ya habia una troncal al SBC, el modulo
   * "Conexion a SBC-NG" arranca encendido (misma regla que la migracion 0007). */
  pool.query("INSERT INTO pbxng_settings(key,value) SELECT 'mod_sbc','1' WHERE EXISTS (SELECT 1 FROM pbxng_trunks WHERE kind='sbc') AND NOT EXISTS (SELECT 1 FROM pbxng_settings WHERE key='mod_sbc') ON CONFLICT (key) DO NOTHING").catch(e => logger('SBC').error('mod-seed', e));

  /* Quien apaga/enciende el módulo `sbc` desde /api/modules necesita descartar el cache
   * para que la próxima consulta lo refleje. */
  function invalidarSbcLink() { _sbcLinkCache.v = null; }

  return { sbcLink, upsertSbcLink, invalidarSbcLink, trunkStatuses, defaultOutTrunk, SBC_TRUNK };
};
