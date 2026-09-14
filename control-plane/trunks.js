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
 *   amiCommand        (cmd) => salida del CLI de Asterisk por AMI (pjsip show registrations/contacts,
 *                     `database show rutasal` para saber por qué troncal está saliendo cada ruta)
 *   amiAction         (action) => respuesta AMI; DBPut de `trunkup/<troncal>` (failover de troncal)
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
 * Devuelve: { sbcLink, upsertSbcLink, invalidarSbcLink, trunkStatuses, defaultOutTrunk,
 *             regenerarEntrantes, failoverStates, filasSalida, SBC_TRUNK }.
 *             `failoverStates()` lo consume el motor de alertas (aviso de failover) y el panel;
 *             `filasSalida()` se exporta sólo para poder probar la escalera sin base ni Asterisk. `regenerarEntrantes` lo usa telefonia.js
 *             cuando cambia un horario o un feriado (los tramos viven en el dialplan del DID).
 */
/* `internal` es un contexto COMPARTIDO (códigos de función, DISA, abreviados, fax) y
 * `setDialplan()` es DELETE + INSERT: quién puede ocupar cada extensión lo contesta un solo
 * lugar, el mismo que usan telefonia.js y marcacion.js (ver el encabezado de
 * `dueno-internal.js`). Este módulo publica dos cosas ahí: las rutas salientes y la salida
 * directa de cada troncal. */
const dueno = require('./dueno-internal');

module.exports = function init(deps) {
  const { app, pool, NODES, amiCommand, amiAction, endpointStates, moduleEnabled, setDialplan, astFwd, salud, diagtrunk, errorHttp, broadcastSoon, logger } = deps;
  /* Lo usa `dueno.borrarPropio()` para dejar dicho en el log cuándo NO borró: una extensión
   * vieja colgada se ve con `dialplan show`, el dialplan de otro borrado en silencio no. */
  const log = logger('TRK');

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
          /* La semilla escribe el dialplan con el MISMO generador que el resto de las rutas
           * salientes (y no una copia a mano): así lleva la firma `NoOp(ruta <id>: …)` que
           * después permite reconocerla como propia, y no se puede publicar encima de un
           * código de función o una DISA que ya esté en ese número. */
          const { rows: sem } = await c.query(
            "INSERT INTO pbxng_outbound_routes (name,pattern,trunk,strip,prepend,callerid) VALUES ('Salida por el SBC-NG (marca 0)',$1,$2,$3,NULL,NULL) RETURNING " + COLS_OUT,
            [pat, SBC_TRUNK, strip]);
          await dueno.exigirLibre(c, outExten(pat), 'outbound', sem[0].id);
          await escribirSaliente(c, sem[0]);
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
  /* ¿El último sondeo sirve para tomar decisiones, o sólo para pintar la pantalla?
   *
   * `endpointStates()` devuelve `{}` SIN lanzar cuando ARI no está conectado (callengine.js)
   * y `amiCommand` puede fallar en silencio: con eso TODAS las troncales salen 'offline'.
   * Para la pantalla da igual (se ve un rato en rojo y se arregla solo), pero el failover
   * llegó a apagar la cadena entera durante una reconexión de ARI y dejar la central sin
   * salida con las dos troncales sanas. Así que el que decide (`refrescarTrunkUp`) mira
   * esto antes de escribir nada en la AstDB. */
  let _sondeoFiable = false;

  // Estado real de troncales: registro saliente (pjsip show registrations) + alcanzabilidad
  async function trunkStatuses(trunks) {
    let reg = '';
    let amiOk = true;
    try { reg = await amiCommand('pjsip show registrations'); } catch (_) { amiOk = false; }
    const eps = await endpointStates();
    /* `firme` = hay evidencia POSITIVA de que la troncal está caída (el proveedor nos
     * rechazó el registro, o el sondeo OPTIONS salió y no volvió). El 'offline' derivado
     * de `endpointStates` NO es evidencia: sale igual con ARI caído o con una troncal
     * IP-auth cuyo proveedor no contesta OPTIONS aunque curse llamadas perfecto. */
    _sondeoFiable = amiOk && !!Object.keys(eps || {}).length;
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
        out[t.name] = up ? { status: 'online', detail: 'Alcanzable (OPTIONS) · vía SBC-NG' } : { status: 'offline', detail: 'No responde · vía SBC-NG', firme: true };
        continue;
      }
      const ep = eps[t.name]; const reachable = ep && ep.state === 'online';
      if (t.do_register) {
        const rx = new RegExp('^\\s*' + t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/');
        const line = lines.find(l => rx.test(l)) || '';
        if (/Registered/i.test(line)) out[t.name] = { status: 'online', detail: 'Registrada' + ((line.match(/exp\.?\s*(\d+)/i) || [])[1] ? ' (exp ' + line.match(/exp\.?\s*(\d+)/i)[1] + 's)' : '') };
        /* Rechazada / sin registrar = el proveedor nos contestó que no: eso sí es evidencia
         * para saltarse la troncal. «Autenticando…» es un estado de paso (el REGISTER está
         * en vuelo) y no se marca: apagarla ahí es cortar la salida por medio segundo. */
        else if (/Rejected/i.test(line)) out[t.name] = { status: 'offline', detail: 'Rechazada por el proveedor', firme: true };
        else if (/Auth/i.test(line)) out[t.name] = { status: 'offline', detail: 'Autenticando…' };
        else if (line) out[t.name] = { status: 'offline', detail: 'Sin registrar', firme: true };
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
      /* El dialplan se borra ANTES que la fila y sólo si es nuestro: si alguien publicó otra
       * cosa en ese patrón, desconectar el SBC no tiene por qué dejarlo sin dialplan. */
      for (const r of rutas) { await dueno.borrarPropio(c, outExten(r.pattern), 'outbound', r.id, log); await c.query('DELETE FROM pbxng_outbound_routes WHERE id=$1', [r.id]); }
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
  const COLS_OUT = 'id,name,pattern,trunk,strip,prepend,callerid,backups,intento_seg,total_seg';
  const malPedido = (msg) => Object.assign(new Error(msg), { status: 400 });

  /* Listas blancas de TODO lo que termina adentro del dialplan generado.
   * Ya nos pasó con los desvíos (ver telefonia.js): un destino con '*' dejaba al que
   * LLAMABA ejecutar códigos de función con su propia identidad. Acá el riesgo es el
   * mismo con otra cara: el nombre de la troncal y el prefijo se pegan dentro de
   * `Dial(PJSIP/<prefijo>${EXTEN:n}@<troncal>,<seg>)`, así que una coma, un '&' o una '@'
   * agregan argumentos al Dial o un segundo destino que nadie configuró. */
  const TRONCAL_OK = /^[A-Za-z0-9_.-]{1,64}$/;
  const PATRON_OK = /^[0-9A-Za-z*#+.!XZN[\]-]{1,38}$/;
  const PREPEND_OK = /^[0-9+*#]{0,16}$/;
  const CID_OK = /^[0-9+]{0,24}$/;
  const NO_SALEN = ['webrtc', 'webrtc-client'];   // troncales de cliente WebRTC: no van a la calle

  /* AstDB del failover (DB() SIEMPRE con familia y clave, ver telefonia.js):
   *   rutasal/<id ruta>  = troncal que cursó la última llamada de esa ruta, o `!sin-salida`
   *                        si se agotaron todas. Es lo que el panel muestra como «en uso» y
   *                        de lo que salen las transiciones que se avisan por correo.
   *   trunkup/<troncal>  = '0' cuando el sondeo la da por caída. Lo escribe esta API cada
   *                        minuto y lo lee el dialplan para SALTARLA sin gastar el timeout. */
  const FAM_RUTA = 'rutasal';
  const FAM_UP = 'trunkup';
  const SIN_SALIDA = '!sin-salida';

  /* LA distinción del failover. Un corte puede venir de la TRONCAL (no responde, 503, sin
   * circuitos) o del DESTINO (486 ocupado, 480 no contesta, 603 rechazada, 404 número
   * inexistente). Sólo el primero justifica salir por otra troncal: reintentar un 486 le
   * hace sonar el teléfono dos veces al destinatario y, si la segunda entra, el cliente
   * paga dos llamadas. Asterisk mapea 486 → BUSY y 503 → CONGESTION, pero también manda a
   * CONGESTION cosas del destino (404), así que además de DIALSTATUS se mira HANGUPCAUSE:
   * 1/2/3 número inexistente, 17 ocupado, 19 no contesta, 20 abonado ausente, 22 número
   * cambiado. Comparación como TEXTO a propósito: con la troncal sin registrar
   * HANGUPCAUSE puede venir vacío y `$[ = 17]` sería un error de sintaxis por llamada.
   *
   * La 21 (call rejected) NO va en esta lista, pero NO alcanza con dejarla afuera. Lo que
   * dice el código de Asterisk 20, comprobado línea por línea:
   *   - `ast_sip_hangup_sip2cause()` (res/res_pjsip.c) manda a 21 CUATRO respuestas:
   *     401, 403, 407 y 603. Las tres primeras son «la troncal nos rechaza» (cuenta
   *     suspendida por saldo, clave rotada, IP fuera de la lista blanca) y ahí el respaldo
   *     es justo lo que hay que usar; la 603 Decline es «el que llamamos cortó», y ahí el
   *     respaldo es plata tirada.
   *   - `handle_cause()` (apps/app_dial.c) NO tiene un `case` para la 21: cae en el
   *     `default`, que hace `num->nochan++`, y con un solo destino eso deja
   *     DIALSTATUS=CHANUNAVAIL (app_dial.c: `else if (num.nochan) strcpy(pa->status,
   *     "CHANUNAVAIL")`). O sea que la 603 del destino prende FALLA=1 igual que un corte de
   *     troncal — lo contrario de lo que decía el comentario viejo, que daba por hecho un
   *     DIALSTATUS=BUSY que app_dial nunca pone acá. Costo real del error: un 603 del
   *     destino recorría la cadena entera (un intento facturado por troncal) y encima
   *     disparaba el correo de failover con la troncal principal sana.
   *   - Para 486 y 403 el mapeo confirma lo demás: 486 → AST_CAUSE_BUSY (17), que sí está
   *     en la lista y ya cancelaba bien; 403 → 21, igual que 401/407.
   * Como la causa 21 sola no distingue, el dialplan mira ADEMÁS el código SIP crudo, que
   * Asterisk guarda por canal marcado (`HANGUPCAUSE(<canal>,tech)` → «SIP 603 Decline»,
   * chan_pjsip lo escribe con `ast_channel_hangupcause_hash_set`): 603 = destino (no se
   * reintenta), 401/403/407 y cualquier otra = troncal (se reintenta, que es el
   * comportamiento de siempre). La ambigüedad que queda es el 403: un operador lo usa para
   * «no te autorizo» y algún destino para «no me llames», y elegimos que SIGA saltando al
   * respaldo porque equivocarse ahí del otro lado deja a la central sin salida.
   * Comparación como TEXTO a propósito: con la troncal sin registrar HANGUPCAUSE puede venir
   * vacío y `$[ = 17]` sería un error de sintaxis por llamada. */
  const CAUSAS_DESTINO = ['1', '2', '3', '17', '19', '20', '22'];
  const COND_DESTINO = '$[' + CAUSAS_DESTINO.map((c) => '"${CAUSA}"="' + c + '"').join('|') + ']';
  /* Códigos SIP que, con HANGUPCAUSE=21, son del DESTINO y no de la troncal (ver arriba). */
  const SIP_DESTINO = ['603'];
  /* Los paréntesis no sobran: en el expr de Asterisk `&` liga más fuerte que `|`, así que
   * sin ellos un segundo código SIP quedaría fuera del "CAUSA=21". */
  const COND_SIP_DESTINO = '$["${CAUSA}"="21" & (' + SIP_DESTINO.map((c) => '"${SIPCODE}"="' + c + '"').join('|') + ')]';
  const LINEAS_INTENTO = 19;   // tiene que coincidir con lo que empuja filasSalida()

  /* Dialplan de UNA ruta saliente.
   *
   * Sin respaldos queda EXACTAMENTE el de siempre (un Dial de 60 s y Hangup): la
   * instalación que no usa failover no paga la escalera ni cambia una línea al actualizar.
   *
   * Con respaldos se arma una escalera de intentos en la misma extensión. Tres cuidados,
   * que son los que hacen que esto se pueda usar con clientes de verdad:
   *  1. No hay bucles: cada intento sólo puede saltar HACIA ADELANTE (a una prioridad
   *     mayor, calculada acá), y el último cae en «se agotaron».
   *  2. El tiempo total está acotado: `TOPE` se fija una vez al entrar y se chequea ANTES
   *     de cada Dial, así que tres troncales no son tres timeouts encadenados. Un cliente
   *     no espera 90 s escuchando silencio.
   *  3. Cada intento termina antes del siguiente: `Dial` con timeout corta la pata saliente
   *     al vencer, y cuando la troncal contesta con congestión ya la cortó el propio Dial.
   *     Nunca hay dos troncales marcando el mismo número a la vez (eso sí sería cobrar dos).
   */
  function filasSalida(r) {
    const strip = Math.min(20, Math.max(0, parseInt(r.strip, 10) || 0));
    const num = (r.prepend || '') + '${EXTEN:' + strip + '}';
    const cadena = [r.trunk].concat(Array.isArray(r.backups) ? r.backups : []);
    const rows = [];
    let p = 1;
    /* La firma va PRIMERA y en TODAS las rutas, también en la de una sola troncal. Antes
     * sólo la escribía la escalera de failover, así que `dueno-internal.js` no tenía forma
     * de reconocer como propia la ruta simple y el candado del contexto compartido se caía
     * justo en el caso más común de una central chica. */
    rows.push([p++, 'NoOp', 'ruta ' + r.id + ': ' + cadena.join(' > ')]);
    if (r.callerid) rows.push([p++, 'Set', 'CALLERID(num)=' + r.callerid]);
    if (cadena.length < 2) {
      rows.push([p++, 'Dial', 'PJSIP/' + num + '@' + cadena[0] + ',60']);
      rows.push([p++, 'Hangup', '']);
      return rows;
    }
    const intento = Math.min(120, Math.max(5, parseInt(r.intento_seg, 10) || 20));
    const total = Math.min(300, Math.max(intento, parseInt(r.total_seg, 10) || 45));
    rows.push([p++, 'Set', 'TOPE=$[${EPOCH} + ' + total + ']']);
    const base = p;                                        // prioridad de la primera línea del primer intento
    const agotado = base + LINEAS_INTENTO * cadena.length;  // única salida cuando ninguna sirvió
    cadena.forEach((t, i) => {
      const b = base + LINEAS_INTENTO * i;
      const sig = (i + 1 < cadena.length) ? b + LINEAS_INTENTO : agotado;
      rows.push([b + 0, 'NoOp', 'intento ' + (i + 1) + '/' + cadena.length + ' por ' + t]);
      rows.push([b + 1, 'ExecIf', '$[${EPOCH} >= ${TOPE}]?Goto(' + agotado + ')']);
      rows.push([b + 2, 'GotoIf', '$["${DB(' + FAM_UP + '/' + t + ')}"="0"]?' + sig]);
      /* La marca va ANTES del Dial. Estaba después y sólo se escribía cuando la llamada
       * terminaba por el lado del destino: si colgaba el que llamó —la mayoría de las
       * llamadas— Asterisk destruía el canal sin ejecutar las prioridades siguientes y
       * `rutasal/<id>` se quedaba con la troncal vieja. Resultado: la central entera
       * saliendo por el respaldo y alerts.js sin ver transición, o sea sin mandar NUNCA el
       * aviso de failover, que es la razón de ser de toda esta escalera. Si el intento
       * falla, el intento siguiente pisa la marca, y si fallan todos la pisa `!sin-salida`. */
      rows.push([b + 3, 'Set', 'DB(' + FAM_RUTA + '/' + r.id + ')=' + t]);
      /* Las causas por canal se ACUMULAN en el canal que llama, así que sin limpiarlas el
       * intento 2 leería el código SIP del intento 1 (o, con dos claves, ninguno). */
      rows.push([b + 4, 'HangupCauseClear', '']);
      rows.push([b + 5, 'Dial', 'PJSIP/' + num + '@' + t + ',' + intento]);
      rows.push([b + 6, 'Set', 'FALLA=0']);
      rows.push([b + 7, 'Set', 'CAUSA=${HANGUPCAUSE}']);
      rows.push([b + 8, 'ExecIf', '$["${CAUSA}"=""]?Set(CAUSA=0)']);
      rows.push([b + 9, 'ExecIf', '$["${DIALSTATUS}"="CONGESTION"|"${DIALSTATUS}"="CHANUNAVAIL"]?Set(FALLA=1)']);
      rows.push([b + 10, 'ExecIf', COND_DESTINO + '?Set(FALLA=0)']);
      /* El código SIP crudo («SIP 603 Decline») en dos pasos y con Set, no dentro del
       * ExecIf: el texto del motivo lo escribe el otro extremo y un ')' suelto ahí adentro
       * rompería el parseo del ExecIf y con él la llamada. Acá se queda en SIPRESP y lo
       * único que llega a la condición son los tres dígitos.
       *
       * Y la lectura se SALTEA cuando no hay ninguna clave. Si el Dial no llegó a crear
       * canal saliente (troncal caída, sin contacto, rechazo inmediato) la lista de causas
       * por canal queda vacía, y `HANGUPCAUSE(,tech)` no es una lectura vacía: son dos
       * argumentos válidos con un nombre de canal que no existe, así que func_hangupcause
       * no encuentra la información y escribe un WARNING en el log por cada intento —
       * justo en el camino que más nos importa, el del failover, que es el que después hay
       * que leer para entender por qué la central se fue al respaldo. El resultado
       * funcional es el mismo de antes (SIPCODE vacío ⇒ se reintenta); lo que cambia es
       * que el log queda limpio. Como ahora la lectura se puede saltear, SIPCODE se limpia
       * ANTES: las variables de canal sobreviven al intento anterior y sin limpiarlo el
       * intento 2 podría cancelar el failover con el código SIP del intento 1. */
      rows.push([b + 11, 'Set', 'CLAVES=${HANGUPCAUSE_KEYS()}']);
      rows.push([b + 12, 'Set', 'SIPCODE=']);
      rows.push([b + 13, 'GotoIf', '$["${CLAVES}"=""]?' + (b + 16)]);
      rows.push([b + 14, 'Set', 'SIPRESP=${HANGUPCAUSE(${CLAVES},tech)}']);
      rows.push([b + 15, 'Set', 'SIPCODE=${SIPRESP:4:3}']);
      rows.push([b + 16, 'ExecIf', COND_SIP_DESTINO + '?Set(FALLA=0)']);
      rows.push([b + 17, 'GotoIf', '$["${FALLA}"="1"]?' + sig]);
      rows.push([b + 18, 'Hangup', '']);
    });
    rows.push([agotado + 0, 'NoOp', 'ruta ' + r.id + ': ninguna troncal pudo cursar la llamada']);
    rows.push([agotado + 1, 'Set', 'DB(' + FAM_RUTA + '/' + r.id + ')=' + SIN_SALIDA]);
    rows.push([agotado + 2, 'Congestion', '3']);
    rows.push([agotado + 3, 'Hangup', '']);
    return rows;
  }

  const escribirSaliente = (c, r) => setDialplan(c, 'internal', outExten(r.pattern), filasSalida(r));

  async function troncalesPorNombre(q) {
    const { rows } = await q.query("SELECT name, COALESCE(kind,'asterisk') AS kind FROM pbxng_trunks");
    const m = {};
    for (const t of rows) m[t.name] = t.kind;
    return m;
  }

  /* Valida y completa una ruta saliente ANTES de que toque la base o el dialplan.
   * `actual` = la fila que ya estaba (PUT parcial); null en el alta. */
  async function normalizarSalida(q, b, actual) {
    const r = Object.assign({ name: '', pattern: '', trunk: '', strip: 0, prepend: '', callerid: '', backups: [], intento_seg: 20, total_seg: 45 }, actual || {});
    for (const k of ['name', 'pattern', 'trunk', 'prepend', 'callerid']) if (b[k] !== undefined) r[k] = b[k] == null ? '' : String(b[k]).trim();
    if (b.strip !== undefined) r.strip = parseInt(b.strip, 10) || 0;
    if (b.intento_seg !== undefined) r.intento_seg = parseInt(b.intento_seg, 10) || 20;
    if (b.total_seg !== undefined) r.total_seg = parseInt(b.total_seg, 10) || 45;
    if (b.backups !== undefined) r.backups = Array.isArray(b.backups) ? b.backups : String(b.backups || '').split(',');
    r.backups = (Array.isArray(r.backups) ? r.backups : []).map((x) => String(x || '').trim()).filter(Boolean);
    /* El '_' es de la tabla realtime (`pbx_realtime` sólo hace match de patrón sobre las
     * filas que empiezan con '_'), no del dato: se guarda sin él, como hasta ahora. */
    r.pattern = String(r.pattern || '').replace(/^_/, '');
    if (!r.pattern) throw malPedido('patrón requerido');
    if (!PATRON_OK.test(r.pattern)) throw malPedido('patrón inválido: sólo dígitos, letras de patrón (X Z N), . ! * # + y [rangos]');
    if (r.prepend && !PREPEND_OK.test(r.prepend)) throw malPedido('lo que se antepone sólo puede ser dígitos, +, * o #');
    if (r.callerid && !CID_OK.test(r.callerid)) throw malPedido('el CallerID saliente sólo puede ser dígitos y +');
    r.strip = Math.min(20, Math.max(0, r.strip));
    r.intento_seg = Math.min(120, Math.max(5, r.intento_seg));
    r.total_seg = Math.min(300, Math.max(r.intento_seg, r.total_seg));
    if (!r.trunk) r.trunk = await defaultOutTrunk(q);
    if (!r.trunk) throw malPedido('No hay ninguna troncal por donde salir: creá una troncal de operador primero (o conectá un SBC-NG en Configuración → SBC-NG).');
    const conocidas = await troncalesPorNombre(q);
    const vistas = new Set();
    const revisar = (n, quees) => {
      if (!TRONCAL_OK.test(n)) throw malPedido(quees + ' inválida: el nombre sólo puede tener letras, dígitos, punto, guion y guion bajo');
      if (!(n in conocidas)) throw malPedido('la troncal «' + n + '» no existe');
      if (NO_SALEN.includes(conocidas[n])) throw malPedido('la troncal «' + n + '» es de cliente WebRTC: no sirve para salir a la calle');
      if (vistas.has(n)) throw malPedido('la troncal «' + n + '» está repetida en la ruta');
      vistas.add(n);
    };
    revisar(r.trunk, 'troncal principal');
    if (r.backups.length > 5) throw malPedido('como máximo 5 troncales de respaldo');
    for (const n of r.backups) revisar(n, 'troncal de respaldo');
    /* Último paso, y ACÁ y no en `escribirSaliente()`: la pregunta se hace con el patrón ya
     * normalizado y ANTES de que la fila entre (o se mueva) en `pbxng_outbound_routes`, así
     * que el único que puede reclamar ese número es OTRO —un código de función, una DISA, un
     * abreviado global, el fax, la salida directa de una troncal, otra ruta saliente—. Sin
     * esto, `escribirSaliente()` (DELETE + INSERT) le borraba el dialplan al otro en
     * silencio: se borraba una ruta `_*21*.`, el admin publicaba ahí el código de desvío
     * porque el número figuraba libre, y al recrear la ruta el código desaparecía. */
    await dueno.exigirLibre(q, outExten(r.pattern), 'outbound', actual ? actual.id : null);
    return r;
  }

  app.get('/api/routes/outbound', async (req, res) => {
    try { const { rows } = await pool.query('SELECT ' + COLS_OUT + ' FROM pbxng_outbound_routes ORDER BY id'); res.json(rows); }
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

  /* Qué troncal cursó la última llamada de cada ruta, según la AstDB. Se lee por CLI y no
   * por evento: el dialplan escribe la marca en cada llamada y acá sólo interesa el ÚLTIMO
   * valor, así que una lectura cada tanto alcanza y no depende de haber estado escuchando. */
  async function leerEnUso() {
    const out = {};
    try {
      const txt = await amiCommand('database show ' + FAM_RUTA);
      const rx = new RegExp('^/' + FAM_RUTA + '/(\\S+)\\s*:\\s*(\\S+)');
      for (const line of String(txt).split('\n')) {
        const m = rx.exec(line.trim());
        if (m) out[m[1]] = m[2];
      }
    } catch (_) {}
    return out;
  }

  /* Estado del failover de cada ruta saliente: la cadena ordenada de troncales, el estado
   * real de cada una y cuál está cursando ahora. Lo usa el panel (pantalla de rutas) y el
   * motor de alertas, así que va con un cache corto: las dos cosas preguntan cada minuto o
   * menos y por debajo hay comandos AMI y sondeos OPTIONS. */
  let _foCache = { t: 0, v: null };
  async function failoverStates(fresh) {
    if (!fresh && _foCache.v && Date.now() - _foCache.t < 8000) return _foCache.v;
    const { rows } = await pool.query('SELECT ' + COLS_OUT + ' FROM pbxng_outbound_routes ORDER BY id');
    let est = {};
    if (rows.length) {
      const { rows: tk } = await pool.query("SELECT id,name,provider_host,provider_port,username,do_register,tenant_id,COALESCE(kind,'asterisk') AS kind,adv_config FROM pbxng_trunks ORDER BY id");
      try { est = await trunkStatuses(tk); } catch (_) { est = {}; }
    }
    const conResp = rows.filter((r) => Array.isArray(r.backups) && r.backups.length);
    const uso = conResp.length ? await leerEnUso() : {};
    const salida = rows.map((r) => {
      const backups = Array.isArray(r.backups) ? r.backups : [];
      const marca = uso[String(r.id)] || '';
      const cadena = [r.trunk].concat(backups).map((n, i) => ({
        trunk: n, rol: i === 0 ? 'principal' : 'respaldo',
        estado: (est[n] && est[n].status) || 'desconocido',
        detalle: (est[n] && est[n].detail) || '',
        /* `estado` es para la pantalla; `caida` es lo único con lo que se puede apagar una
         * troncal en el dialplan (ver `firme` en trunkStatuses). No los mezcles. */
        caida: !!(est[n] && est[n].firme),
        sbc: n === SBC_TRUNK,
        en_uso: n === marca,
      }));
      const enUso = cadena.some((x) => x.en_uso) ? marca : null;
      /* Sin llamadas desde el último arranque no hay marca: mostramos por cuál SALDRÍA
       * hoy (la primera de la cadena que el sondeo ve viva) en vez de dejar el campo
       * vacío, que en el panel se lee como «no sé» y no como «todavía nadie llamó». */
      const prevista = (cadena.find((x) => x.estado === 'online') || cadena[0] || {}).trunk || null;
      return {
        id: r.id, name: r.name, pattern: r.pattern, principal: r.trunk, backups,
        intento_seg: r.intento_seg, total_seg: r.total_seg,
        en_uso: enUso, prevista, en_respaldo: !!(enUso && enUso !== r.trunk),
        sin_salida: marca === SIN_SALIDA, cadena,
      };
    });
    _foCache = { t: Date.now(), v: salida };
    return salida;
  }

  /* Vuelca a la AstDB qué troncales da por caídas el sondeo (`trunkup/<troncal>`).
   * Sin esto el dialplan descubre que la principal está muerta pagando el timeout del
   * Dial: con dos respaldos eso es medio minuto de silencio antes de la primera troncal
   * que de verdad podía cursar. Fail-open a propósito: si la clave no está (Asterisk recién
   * arrancado, AMI caído) se intenta igual, que es el comportamiento seguro.
   *
   * Escribir '0' es apagar una troncal para TODAS las llamadas salientes, así que se hace
   * sólo con evidencia positiva de caída (`caida`, no el 'offline' de pantalla) y sólo si el
   * sondeo de esta vuelta sirvió. Antes esto miraba `estado === 'offline'`, que con ARI
   * reconectando o con una troncal IP-auth sin qualify da 'offline' para todo: se apagaba la
   * cadena entera y el dialplan caía derecho en Congestion con las dos troncales sanas.
   * Y aunque haya evidencia de todas, la principal queda en '1': que el dialplan pague el
   * timeout de un intento es mucho más barato que dejar la central sin salida por un sondeo
   * equivocado. */
  async function refrescarTrunkUp() {
    const { rows } = await pool.query('SELECT 1 FROM pbxng_outbound_routes WHERE jsonb_array_length(backups) > 0 LIMIT 1');
    if (!rows.length) return 0;                       // nadie usa failover: no molestamos al AMI
    const est = await failoverStates(true);
    const marcas = new Map();                         // troncal → '0' (saltarla) | '1' (intentarla)
    for (const r of est) {
      if (!r.backups.length) continue;
      const todas = r.cadena.every((t) => t.caida);
      r.cadena.forEach((t, i) => {
        const apagar = _sondeoFiable && t.caida && !(todas && i === 0);
        /* Una misma troncal puede ser principal de una ruta y respaldo de otra: si en
         * alguna hay que intentarla, gana el '1'. */
        if (!apagar || !marcas.has(t.trunk)) marcas.set(t.trunk, apagar ? '0' : '1');
      });
    }
    for (const [trunk, val] of marcas) {
      try { await amiAction({ Action: 'DBPut', Family: FAM_UP, Key: trunk, Val: val }); } catch (_) {}
    }
    return marcas.size;
  }
  const _tUp = setInterval(() => { refrescarTrunkUp().catch(() => {}); }, 60000);
  if (_tUp.unref) _tUp.unref();                       // que no mantenga vivo el proceso (pruebas)
  setTimeout(() => { refrescarTrunkUp().catch(() => {}); }, 20000).unref?.();

  /* Literal ANTES que `:id`: Express resuelve en orden y `/failover` no puede quedar
   * tapada por una ruta con parámetro (mismo criterio que el resto de app.js). */
  app.get('/api/routes/outbound/failover', async (req, res) => {
    try { res.json(await failoverStates()); } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/routes/outbound', async (req, res) => {
    const b = req.body || {};
    if (!b.pattern) return res.status(400).json({ error: 'patrón requerido' });
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      const r = await normalizarSalida(c, b, null);
      const { rows } = await c.query(
        'INSERT INTO pbxng_outbound_routes (name,pattern,trunk,strip,prepend,callerid,backups,intento_seg,total_seg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ' + COLS_OUT,
        [r.name || r.pattern, r.pattern, r.trunk, r.strip, r.prepend || null, r.callerid || null, JSON.stringify(r.backups), r.intento_seg, r.total_seg]);
      await escribirSaliente(c, rows[0]);
      await c.query('COMMIT'); _foCache.v = null; broadcastSoon();
      res.status(201).json({ created: r.pattern, trunk: r.trunk, id: rows[0].id, backups: r.backups });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} errorHttp(res, e); } finally { c.release(); }
  });
  /* Editar en vez de borrar y rehacer: reordenar los respaldos desde el panel no puede
   * dejar el patrón unos segundos sin dialplan (en esos segundos nadie sale a la calle). */
  app.put('/api/routes/outbound/:id', async (req, res) => {
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }
    try {
      await c.query('BEGIN');
      const { rows: viejo } = await c.query('SELECT ' + COLS_OUT + ' FROM pbxng_outbound_routes WHERE id=$1', [req.params.id]);
      if (!viejo[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'ruta inexistente' }); }
      const r = await normalizarSalida(c, req.body || {}, viejo[0]);
      // El patrón ES la extensión: si cambió hay que borrar la vieja o queda marcable.
      if (outExten(viejo[0].pattern) !== outExten(r.pattern)) await dueno.borrarPropio(c, outExten(viejo[0].pattern), 'outbound', viejo[0].id, log);
      const { rows } = await c.query(
        'UPDATE pbxng_outbound_routes SET name=$2, pattern=$3, trunk=$4, strip=$5, prepend=$6, callerid=$7, backups=$8, intento_seg=$9, total_seg=$10 WHERE id=$1 RETURNING ' + COLS_OUT,
        [req.params.id, r.name || r.pattern, r.pattern, r.trunk, r.strip, r.prepend || null, r.callerid || null, JSON.stringify(r.backups), r.intento_seg, r.total_seg]);
      await escribirSaliente(c, rows[0]);
      await c.query('COMMIT'); _foCache.v = null; broadcastSoon(); res.json(rows[0]);
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} errorHttp(res, e); } finally { c.release(); }
  });
  app.delete('/api/routes/outbound/:id', async (req, res) => {
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('SELECT id, pattern FROM pbxng_outbound_routes WHERE id=$1', [req.params.id]);
      // Primero el dialplan (y sólo el propio), después la fila: `borrarPropio` necesita que
      // la fila siga estando para reconocer la extensión como nuestra.
      if (rows[0]) await dueno.borrarPropio(c, outExten(rows[0].pattern), 'outbound', rows[0].id, log);
      await c.query('DELETE FROM pbxng_outbound_routes WHERE id=$1', [req.params.id]);
      await c.query('COMMIT'); _foCache.v = null; broadcastSoon(); res.json({ deleted: req.params.id });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  // ---------------- Rutas ENTRANTES (DID) ----------------
  /* Modo noche en la AstDB. Es la MISMA clave que escribe telefonia.js; el contrato del
   * sprint 6 la llamó `DB(nightmode)` a secas, pero la función DB() de Asterisk exige
   * familia/clave (func_db.c), así que acá y allá se usa `DB(nightmode/modo)`. */
  const NIGHTMODE = 'DB(nightmode/modo)';
  /* `fax` (sprint 10, fax.js): el DID entra directo a una caja de fax. El destino es el id
   * de la caja y el dialplan de `fax-rx-<id>` (ReceiveFAX + aviso a la API) lo escribe
   * fax.js, que es el dueño de esa extensión: acá sólo se salta a ella. */
  const DEST_OK = ['interno', 'ivr', 'cola', 'app', 'fax'];

  function inboundRows(dest_type, v) {
    if (dest_type === 'ivr') return [[1, 'Goto', 'ivr,' + v + ',1']];
    // Sólo dígitos: el id de la caja va crudo al Goto (mismo criterio que el resto del módulo).
    if (dest_type === 'fax') return [[1, 'Goto', 'from-trunk,fax-rx-' + String(v).replace(/[^0-9]/g, '') + ',1']];
    if (dest_type === 'cola') return [[1, 'Answer', ''], [2, 'Queue', v], [3, 'Hangup', '']];
    if (dest_type === 'app') return [[1, 'Goto', 'internal,' + v + ',1']];
    return [[1, 'Dial', 'PJSIP/' + v + ',30'], [2, 'Voicemail', v + '@default,u'], [3, 'Hangup', '']];
  }

  /* Dialplan de la extensión que DECIDE (sólo cuando la ruta tiene horario). Orden: modo
   * noche forzado desde el panel o el *28 → feriado (anual MM-DD o puntual YYYY-MM-DD) →
   * los tramos del horario; lo que no entró en ningún tramo cae a la rama cerrada.
   * Todo sale de la AstDB y no de la base a propósito: así cambiar el modo noche o poner
   * un feriado NO obliga a regenerar el dialplan ni a recargar nada. */
  function filasDecide(did, tramos) {
    const rows = [];
    let p = 1;
    rows.push([p++, 'NoOp', 'entrante ' + did]);
    rows.push([p++, 'ExecIf', '$["${' + NIGHTMODE + '}"="cerrado"]?Goto(from-trunk,cerrado-' + did + ',1)']);
    rows.push([p++, 'ExecIf', '$["${' + NIGHTMODE + '}"="abierto"]?Goto(from-trunk,abierto-' + did + ',1)']);
    rows.push([p++, 'GotoIf', '$[${DB_EXISTS(hol/${STRFTIME(${EPOCH},,%m-%d)})} | ${DB_EXISTS(hol/${STRFTIME(${EPOCH},,%Y-%m-%d)})}]?from-trunk,cerrado-' + did + ',1']);
    for (const t of tramos) rows.push([p++, 'GotoIfTime', t.desde + '-' + t.hasta + ',' + t.dias + ',*,*?from-trunk,abierto-' + did + ',1']);
    rows.push([p++, 'Goto', 'from-trunk,cerrado-' + did + ',1']);
    return rows;
  }

  /* Fuera de hora: el destino configurado o, si no hay ninguno, el buzón del interno
   * (y un saludo + colgar cuando el destino normal no es un interno). */
  function filasCerrado(r) {
    if (r.dest_cerrado_type && r.dest_cerrado_value) return inboundRows(r.dest_cerrado_type, r.dest_cerrado_value);
    if ((r.dest_type || 'interno') === 'interno') return [[1, 'Answer', ''], [2, 'Voicemail', r.dest_value + '@default,u'], [3, 'Hangup', '']];
    return [[1, 'Answer', ''], [2, 'Playback', 'vm-goodbye'], [3, 'Hangup', '']];
  }

  /* Escribe (o reescribe) el dialplan de UNA ruta entrante. Sin horario asignado queda
   * como siempre: una sola extensión. Las ramas `abierto-<did>` / `cerrado-<did>` se
   * borran primero para que sacarle el horario a una ruta no deje huérfanos marcables. */
  async function escribirEntrante(c, r) {
    const did = String(r.did);
    await c.query("DELETE FROM extensions WHERE context='from-trunk' AND exten = ANY($1)", [['abierto-' + did, 'cerrado-' + did]]);
    let tramos = [];
    if (r.horario_id) {
      const { rows } = await c.query('SELECT tramos, activo FROM pbxng_horarios WHERE id=$1', [r.horario_id]);
      if (rows[0] && rows[0].activo !== false && Array.isArray(rows[0].tramos)) tramos = rows[0].tramos;
    }
    if (!tramos.length) { await setDialplan(c, 'from-trunk', did, inboundRows(r.dest_type, r.dest_value)); return; }
    await setDialplan(c, 'from-trunk', did, filasDecide(did, tramos));
    await setDialplan(c, 'from-trunk', 'abierto-' + did, inboundRows(r.dest_type, r.dest_value));
    await setDialplan(c, 'from-trunk', 'cerrado-' + did, filasCerrado(r));
  }

  /* Regenera el dialplan de las rutas entrantes. Lo llama telefonia.js cuando cambia un
   * horario (los tramos están DENTRO del dialplan del DID) o un feriado. Con
   * {horario_id} sólo las que usan ese horario; sin filtro, todas. */
  async function regenerarEntrantes(filtro) {
    const f = filtro || {};
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = f.horario_id
        ? await c.query('SELECT * FROM pbxng_inbound_routes WHERE horario_id=$1 ORDER BY id', [f.horario_id])
        : await c.query('SELECT * FROM pbxng_inbound_routes ORDER BY id');
      for (const r of rows) await escribirEntrante(c, r);
      await c.query('COMMIT');
      if (rows.length) broadcastSoon();
      return rows.length;
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; } finally { c.release(); }
  }

  const COLS_IN = 'id,did,name,dest_type,dest_value,horario_id,dest_cerrado_type,dest_cerrado_value';
  function validarEntrante(b) {
    if (b.dest_type && !DEST_OK.includes(b.dest_type)) throw Object.assign(new Error('destino inválido: ' + b.dest_type), { status: 400 });
    if (b.dest_cerrado_type && !DEST_OK.includes(b.dest_cerrado_type)) throw Object.assign(new Error('destino fuera de hora inválido: ' + b.dest_cerrado_type), { status: 400 });
    // El destino de fax es el id de una caja: sin dígitos el Goto quedaría apuntando a `fax-rx-`.
    if (b.dest_type === 'fax' && !/^[0-9]+$/.test(String(b.dest_value || ''))) throw Object.assign(new Error('elegí a qué caja de fax entra el DID'), { status: 400 });
    if (b.dest_cerrado_type === 'fax' && !/^[0-9]+$/.test(String(b.dest_cerrado_value || ''))) throw Object.assign(new Error('elegí a qué caja de fax va fuera de hora'), { status: 400 });
  }

  app.get('/api/routes/inbound', async (req, res) => {
    try { const { rows } = await pool.query('SELECT ' + COLS_IN + ' FROM pbxng_inbound_routes ORDER BY id'); res.json(rows); }
    catch (e) { errorHttp(res, e); }
  });
  app.post('/api/routes/inbound', async (req, res) => {
    const b = req.body || {};
    const { did, name, dest_type = 'interno', dest_value } = b;
    if (!did || !dest_value) return res.status(400).json({ error: 'DID y destino requeridos' });
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      validarEntrante(b);
      await c.query('BEGIN');
      const { rows } = await c.query(
        'INSERT INTO pbxng_inbound_routes (did,name,dest_type,dest_value,horario_id,dest_cerrado_type,dest_cerrado_value) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ' + COLS_IN,
        [did, name || did, dest_type, dest_value, parseInt(b.horario_id, 10) || null, b.dest_cerrado_type || null, b.dest_cerrado_value || null]);
      await escribirEntrante(c, rows[0]);
      await c.query('COMMIT'); broadcastSoon(); res.status(201).json({ created: did, id: rows[0].id });
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} errorHttp(res, e); } finally { c.release(); }
  });
  app.put('/api/routes/inbound/:id', async (req, res) => {
    const b = req.body || {};
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }
    try {
      validarEntrante(b);
      await c.query('BEGIN');
      const { rows: viejo } = await c.query('SELECT ' + COLS_IN + ' FROM pbxng_inbound_routes WHERE id=$1', [req.params.id]);
      if (!viejo[0]) { await c.query('ROLLBACK'); return res.status(404).json({ error: 'ruta inexistente' }); }
      const { rows } = await c.query(
        `UPDATE pbxng_inbound_routes SET name=COALESCE($2,name), dest_type=COALESCE($3,dest_type), dest_value=COALESCE($4,dest_value),
           horario_id=$5, dest_cerrado_type=$6, dest_cerrado_value=$7 WHERE id=$1 RETURNING ` + COLS_IN,
        [req.params.id, b.name === undefined ? null : String(b.name), b.dest_type || null, b.dest_value || null,
          b.horario_id === undefined ? viejo[0].horario_id : (parseInt(b.horario_id, 10) || null),
          b.dest_cerrado_type === undefined ? viejo[0].dest_cerrado_type : (b.dest_cerrado_type || null),
          b.dest_cerrado_value === undefined ? viejo[0].dest_cerrado_value : (b.dest_cerrado_value || null)]);
      await escribirEntrante(c, rows[0]);
      await c.query('COMMIT'); broadcastSoon(); res.json(rows[0]);
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} errorHttp(res, e); } finally { c.release(); }
  });
  app.delete('/api/routes/inbound/:id', async (req, res) => {
    let c; try { c = await pool.connect(); } catch (e) { return errorHttp(res, e); }   // sin DB: 503 en vez de un pedido colgado
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('SELECT did FROM pbxng_inbound_routes WHERE id=$1', [req.params.id]);
      // Con horario el DID ocupa tres extensiones: se van las tres o queda dialplan muerto.
      if (rows[0]) await c.query("DELETE FROM extensions WHERE context='from-trunk' AND exten = ANY($1)", [[rows[0].did, 'abierto-' + rows[0].did, 'cerrado-' + rows[0].did]]);
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
  /* La extensión que publica la salida directa de una troncal. Tiene que dar EXACTAMENTE lo
   * mismo que la expresión de `pbxng_trunks` en `dueno-internal.js`, porque las dos hablan
   * del mismo número: acá desde `adv_config` ya parseado, allá desde el JSON en SQL. */
  const extenSalida = (a) => '_' + ((a && a.outbound_prefix) || 'X') + '.';
  const publicaSalida = (a) => !!a && a.outbound_enabled !== false;

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
      const exten = extenSalida(a);
      const dialNum = a.outbound_strip ? `${'${EXTEN:' + a.outbound_strip + '}'}` : '${EXTEN}';
      /* «Crear ruta de salida automática» publica en el contexto compartido como cualquier
       * otro: si el prefijo ya lo usa otra troncal, un código de función o una aplicación,
       * se corta con 409 diciendo quién en vez de borrarle el dialplan. El prefijo y el
       * interruptor están los dos en el formulario de la troncal, así que el que mira la
       * pantalla puede arreglarlo sin salir de ahí. */
      await dueno.exigirLibre(c, exten, 'troncal', name);
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
      const { rows: ex } = await c.query("SELECT COALESCE(kind,'asterisk') AS kind, adv_config FROM pbxng_trunks WHERE name=$1", [name]);
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
      /* Cambiar el prefijo de salida (o apagar la ruta automática) tiene que llevarse el
       * dialplan VIEJO, y sólo si sigue siendo el nuestro: hasta ahora quedaba publicado para
       * siempre, marcando por una troncal que el administrador creía que ya no usaba ese
       * prefijo. Va ANTES del UPDATE para que la fila todavía reclame la extensión vieja. */
      const viejoAdv = ex[0].adv_config;
      if (publicaSalida(viejoAdv)) {
        const anterior = extenSalida(viejoAdv);
        if (!a.outbound_enabled || anterior !== extenSalida(a)) await dueno.borrarPropio(c, anterior, 'troncal', name, log);
      }
      await c.query("UPDATE pbxng_trunks SET provider_host=$1, provider_port=$2, username=$3, do_register=$4, kind='asterisk', kam_config=NULL, adv_config=$5 WHERE name=$6", [a.provider_host, a.provider_port, a.username || null, a.mode === 'register', JSON.stringify(a), name]);
      await writeAsteriskTrunk(c, name, a, pass, tenant_id);
      await c.query('COMMIT'); res.json({ updated: name, mode: a.mode });
    } catch (e) { await c.query('ROLLBACK'); errorHttp(res, e); } finally { c.release(); }
  });

  app.delete('/api/trunks/:name', async (req, res) => {
    const { name } = req.params; const c = await pool.connect();
    try {
      await c.query('BEGIN');
      /* Su salida directa se va con ella: si no, el `_<prefijo>.` seguía publicado marcando
       * contra un endpoint que ya no existe (el mismo problema que este handler ya arregla
       * unas líneas más abajo para los respaldos de las rutas). Antes de borrar la fila,
       * para que `borrarPropio` pueda reconocer la extensión como nuestra. */
      const { rows: quedaba } = await c.query('SELECT adv_config FROM pbxng_trunks WHERE name=$1', [name]);
      if (quedaba[0] && publicaSalida(quedaba[0].adv_config)) await dueno.borrarPropio(c, extenSalida(quedaba[0].adv_config), 'troncal', name, log);
      for (const t of ['ps_registrations', 'ps_endpoint_id_ips', 'ps_endpoints', 'ps_auths', 'ps_aors']) await c.query(`DELETE FROM ${t} WHERE id=$1`, [name]);
      await c.query('DELETE FROM pbxng_trunks WHERE name=$1', [name]);
      if (name === SBC_TRUNK) { await c.query("INSERT INTO pbxng_settings(key,value) VALUES('sbc_link_removed','1') ON CONFLICT(key) DO UPDATE SET value='1'"); _sbcLinkCache.v = null; }
      /* Sacarla de los respaldos de las rutas que la nombraban y reescribir su dialplan.
       * Si no, el failover seguiría marcando contra un endpoint que ya no existe: un salto
       * perdido y unos segundos de silencio en cada llamada, sin nada en el panel que lo
       * explique (la troncal ya no está en la lista). */
      const { rows: afect } = await c.query('SELECT ' + COLS_OUT + ' FROM pbxng_outbound_routes WHERE backups @> to_jsonb($1::text)', [name]);
      for (const r of afect) {
        r.backups = (r.backups || []).filter((x) => x !== name);
        await c.query('UPDATE pbxng_outbound_routes SET backups=$2 WHERE id=$1', [r.id, JSON.stringify(r.backups)]);
        /* Acá NO se vuelve a preguntar quién ocupa la extensión: la ruta está reescribiendo su
         * propio dialplan, en su propio patrón, sin que nadie haya elegido un número nuevo. Un
         * 409 en este punto sólo lograría que no se pueda borrar una troncal. */
        await escribirSaliente(c, r);
      }
      await c.query('COMMIT'); _foCache.v = null;
      if (afect.length) broadcastSoon();
      res.json({ deleted: name, rutas_sin_respaldo: afect.length });
    }
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

  return { sbcLink, upsertSbcLink, invalidarSbcLink, trunkStatuses, defaultOutTrunk, regenerarEntrantes, failoverStates, filasSalida, SBC_TRUNK };
};
