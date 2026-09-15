/* ============================================================================
 *  PBX-NG · Marcación: DISA, callback, dial-by-name y marcación abreviada
 *  (sprint 7, ítem 12 de docs/BRECHA-UCM-XORCOM.md).
 *
 *  Las cuatro son baratas y se lucen en una demo, y las dos primeras son, desde hace
 *  treinta años, el agujero clásico de fraude de tarifación: una DISA mal hecha es una
 *  central que el mundo entero usa para llamar a internacional a costa del cliente.
 *  Por eso acá, cada vez que había que elegir entre cómodo y seguro, se eligió seguro:
 *
 *   1. DISA y callback nacen APAGADAS (`enabled=false` en la migración 0015). Instalar
 *      una actualización nunca puede encender solo algo que gasta plata.
 *   2. El PIN NO viaja al dialplan. `Authenticate(<pin>)` habría sido una línea, pero
 *      deja el PIN en la tabla realtime `extensions` —que se lee con `dialplan show`, se
 *      respalda en claro y la ve cualquier admin de base—, y además no sabe contar
 *      intentos. Acá el dialplan pregunta por CURL a `/api/internal/disa` (loopback + el
 *      token de /etc/pbxng/agent.token, el mismo guard que `/api/internal/feature` de
 *      telefonia.js) y esta API compara contra un bcrypt, cuenta los fallos y bloquea.
 *   3. El PIN NUNCA puede ser el número de un interno: se rechaza en el alta contra
 *      `ps_endpoints`. Es el PIN que pone todo el mundo y el primero que prueba el que
 *      escanea.
 *   4. La DISA no marca lo que se le cante: el número que el usuario disca se filtra con
 *      `FILTER(0-9,...)` en el dialplan Y se vuelve a validar acá contra las rutas salientes
 *      habilitadas para ESA DISA. Lista vacía = no sale a la calle. Y la validación NO es
 *      «¿alguna de las habilitadas matchea?» sino «¿la que va a GANAR el best-match de
 *      Asterisk está habilitada?» (`rutaGanadora`): se marca `Local/<num>@internal` y ahí
 *      Asterisk vuelve a elegir entre TODAS las rutas, así que una habilitada más laxa que
 *      otra prohibida autorizaba justo lo que se quería prohibir.
 *   7. El callback tiene su propia lista de rutas (`pbxng_callback.rutas`) y el destino pasa
 *      por el mismo camino: el número al que se devuelve la llamada es el CallerID entrante,
 *      que se falsea con dos líneas en cualquier softphone. En modo `pin` —que no tiene lista
 *      blanca— la restricción de rutas es OBLIGATORIA para encenderlo, y el balde de intentos
 *      es por callback y no por CallerID (el CallerID lo elige el atacante: rotándolo tenía
 *      un balde nuevo por intento y el bloqueo no se activaba nunca).
 *   5. Duración acotada con `TIMEOUT(absolute)`: una DISA sin tope es una llamada
 *      internacional abierta hasta que al otro lado se aburran.
 *   6. Cada intento y cada llamada quedan en `pbxng_marcacion_log` con el CallerID de
 *      origen. Sin eso no te enterás de que te están probando el PIN hasta la factura.
 *
 *  POR QUÉ EL NÚMERO SE VALIDA ACÁ Y NO EN EL DIALPLAN: para decidir si un número entra en
 *  una ruta saliente hay que hacer match contra un patrón de Asterisk (`_0.`, `0[1-9]XXX…`).
 *  Se podía armar un `REGEX()` dentro del dialplan, pero queda un regex generado metido
 *  dentro de un `$[...]` —comillas, corchetes y el parser de expresiones— imposible de
 *  probar y fácil de romper. `matchPatron()` hace lo mismo en JS, es una función pura con
 *  pruebas, y de paso el mismo viaje deja el registro de uso. El dialplan sólo marca
 *  después de que esta API dijo "ok"; si la API no contesta, el CURL devuelve vacío y la
 *  llamada se rechaza (el fallo cae del lado seguro).
 *
 *  Claves de AstDB que escribe este módulo (las lee el dialplan):
 *    abrev/<ext>-<NN>   destino del abreviado PERSONAL NN del interno <ext>
 *  Los abreviados GLOBALES no van a la AstDB: son una extensión propia en `internal`.
 *  (DB() SIEMPRE con familia Y clave, ver el encabezado de telefonia.js.)
 *
 *  Acceso (rbac.js): toda la configuración es admin (cae al default deny-by-default);
 *  `GET /api/disa/registro` y `GET /api/callback/registro` también supervisor (es
 *  operación: explica por qué hay llamadas raras); `GET|PUT /api/extensions/:ext/abreviados`
 *  es de cualquier rol porque la ruta exige la ext propia con `exigirExt`, igual que los
 *  desvíos. `POST /api/internal/disa` y `/api/internal/callback` son públicas (PUBLIC_API)
 *  pero sólo se aceptan desde LOOPBACK, sin cabecera de proxy y con el token del agente.
 * ==========================================================================*/
'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
/* Quién ocupa cada extensión del contexto compartido `internal`: la lista es única y la
 * comparten telefonia.js y este módulo (ver el encabezado de dueno-internal.js). */
const dueno = require('./dueno-internal');

/**
 * deps:
 *   app            Express (las rutas se registran acá, DESPUÉS del gate de auth + RBAC)
 *   pool           pg.Pool
 *   amiAction      (action) => respuesta AMI; DBPut/DBDel de los abreviados y el Originate del callback
 *   setDialplan    (client, context, exten, rows) escribe una extensión en el dialplan realtime (app.js)
 *   exigirExt      (req, res, ext) => false y responde 403 si la sesión no alcanza a ese interno (auth.js)
 *   clientIp       (req) => IP real del cliente (auth.js, respeta trust proxy)
 *   agentToken     secreto compartido con los agentes (/etc/pbxng/agent.token, app.js)
 *   errorHttp      traduce errores a {error} con status (errores.js)
 *   broadcastSoon  refresca el snapshot del socket
 *   logger         fábrica de loggers (log.js)
 *
 * Devuelve: { syncAbreviados, matchPatron, rutaGanadora, filasDisa, filasCallback, filasDbn } (los
 * generadores son puros y se exportan para poder probarlos sin base ni Asterisk).
 */
module.exports = function init(deps) {
  const { app, pool, amiAction, setDialplan, exigirExt, clientIp, errorHttp, broadcastSoon, logger } = deps;
  const log = logger ? logger('marcacion') : { info() {}, warn() {}, error() {} };

  /* URL con la que ASTERISK ve a esta API (mismo criterio y misma variable que telefonia.js). */
  const API_URL = String(process.env.AST_API_URL || process.env.API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const API_BASE = /^https?:\/\//.test(API_URL) ? API_URL : 'http://' + API_URL;

  const err = (status, msg) => Object.assign(new Error(msg), { status });

  // ── Listas blancas de TODO lo que termina dentro de un Goto/Dial ──────────
  /* Mismo motivo que en telefonia.js y trunks.js: un destino con `*` dejaba al que LLAMABA
   * ejecutar códigos de función con su propia identidad (fraude de tarifación). Un destino
   * es siempre un interno o un número marcable por una ruta saliente, y los dos son
   * dígitos; `*`, `#`, comas y arrobas no tienen nada que hacer ahí. */
  const DESTINO = /^[0-9]{1,32}$/;
  const EXT_OK = /^[A-Za-z0-9_-]{1,32}$/;
  /* La extensión por la que se ENTRA a una DISA / callback / directorio: la elige el
   * administrador y se publica tal cual en el contexto `internal`. Se permite `*` y `#`
   * (son extensiones de servicio, tipo `*30`), pero nada de patrones: una DISA detrás de
   * `_X.` se comería medio plan de marcado. */
  const ENTRADA_OK = /^[*#0-9][*#0-9]{0,9}$/;
  const CID_OK = /^[0-9+]{0,24}$/;
  const PIN_OK = /^[0-9]{4,12}$/;
  /* Opciones de Directory(): e (locuta el interno), f/l/b (buscar por nombre, apellido o
   * los dos), m (menú por coincidencia), n/p/o. Se valida porque va crudo al dialplan. */
  const DBN_OPTS = /^[efblmnop]{0,8}$/;
  const CTX_OK = /^[A-Za-z0-9_-]{1,32}$/;
  const CODE_GLOBAL = /^[*#0-9][*#0-9]{1,7}$/;
  const CODE_PROPIO = /^[0-9]{2}$/;
  const PREFIJO_OK = /^[*#][0-9*#]{0,3}$/;
  const MODOS_CB = ['lista', 'pin', 'lista_pin'];
  const DEST_CB = ['disa', 'ivr', 'app'];

  /* SÓLO loopback, y se mira ANTES que la IP si hay cabecera de proxy. El porqué completo
   * está en telefonia.js: el panel proxya /backend/** y con `trust proxy = 1` la IP que ve
   * la API termina siendo la del navegador de cualquiera en la LAN, que también es privada,
   * así que "red interna" NO alcanzaba como filtro. */
  function esLoopback(ip) {
    const s = String(ip || '').replace(/^::ffff:/i, '');
    return s === '::1' || s === '127.0.0.1' || /^127\./.test(s);
  }
  const TOKEN = String(deps.agentToken || '');
  const TOK_Q = TOKEN ? '&tok=' + encodeURIComponent(TOKEN) : '';
  function tokenOk(req) {
    const dado = Buffer.from(String((req.body || {}).tok || (req.query || {}).tok || ''), 'utf8');
    const esp = Buffer.from(TOKEN, 'utf8');
    return dado.length === esp.length && crypto.timingSafeEqual(dado, esp);
  }
  function soloDesdeLaCentral(req, res) {
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) { res.status(403).type('text/plain').send('no'); return false; }
    if (!esLoopback(clientIp(req))) { res.status(403).type('text/plain').send('no'); return false; }
    if (TOKEN && !tokenOk(req)) { res.status(403).type('text/plain').send('no'); return false; }
    return true;
  }
  /* Único armador del CURL del dialplan: así el token no se olvida en ninguno. */
  const curlA = (ruta, qs) => '${CURL(' + API_BASE + ruta + ',' + qs + TOK_Q + ')}';

  /* ── AstDB por AMI (mismo criterio que telefonia.js: el guardado no se cae por un AMI
   * caído, la fuente de verdad es Postgres y syncAbreviados() la vuelve a volcar). Lo que
   * SÍ cambió: el error se registra y se devuelve. Un DBPut perdido acá deja el abreviado
   * en la libreta del panel y mudo en el teléfono, y el usuario se entera marcándolo. */
  async function astPut(family, key, val) {
    try { await amiAction({ Action: 'DBPut', Family: family, Key: String(key), Val: String(val) }); return true; }
    catch (e) { log.error('AstDB: no se pudo escribir ' + family + '/' + key, e); return false; }
  }
  async function astDel(family, key) {
    try { await amiAction({ Action: 'DBDel', Family: family, Key: String(key) }); return true; }
    catch (e) { log.error('AstDB: no se pudo borrar ' + family + '/' + key, e); return false; }
  }
  const AVISO_ASTDB = 'Guardado en la base, pero Asterisk no tomó el cambio (AMI caído): se aplica solo cuando la central vuelva.';

  const setGet = async (k, def) => { try { const { rows } = await pool.query('SELECT value FROM pbxng_settings WHERE key=$1', [k]); return rows[0] && rows[0].value != null ? rows[0].value : def; } catch (_) { return def; } };
  const setPut = (k, v) => pool.query('INSERT INTO pbxng_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, String(v)]);

  /* Una transacción con cliente propio, que es lo que pide setDialplan. */
  async function conCliente(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }

  // ═══════════════ Quién es dueño de una extensión de `internal` ═══════════

  /* `internal` es un contexto COMPARTIDO: ahí conviven los códigos de función de
   * telefonia.js (`*97` y compañía), las rutas salientes de trunks.js, los
   * abreviados globales y estas cuatro aplicaciones. Publicar una extensión sin
   * preguntar quién la tiene era pisar al otro EN SILENCIO: dar de alta una DISA en
   * `*97` borraba el dialplan del buzón de voz y nadie se enteraba hasta que un usuario
   * se quejaba. Por eso toda alta y toda edición pregunta primero (`libreEnInternal`) y
   * todo borrado se limita a lo que publicó ESTE módulo (`borrarPropio`).
   *
   * La pregunta y la lista de quién puede ocupar una extensión de `internal` viven en
   * `dueno-internal.js`, no acá: el candado sólo sirve cerrado de los dos lados, y
   * telefonia.js hace exactamente la misma pregunta antes de publicar sus códigos de
   * función. Duplicar la lista era garantizar que dentro de tres sprints uno de los dos
   * quedara viejo.
   *
   * La primera fila que escriben `filasDisa`/`filasCallback`/`filasDbn`/`filasAbrev*` es
   * siempre un `NoOp` con la marca de la familia: es la firma que deja reconocer una
   * extensión propia sin agregarle una columna a la tabla realtime de Asterisk. */
  const libreEnInternal = (c, exten, familia, id) => (exten ? dueno.exigirLibre(c, exten, familia, id) : Promise.resolve());
  const borrarPropio = (c, exten, familia) => dueno.borrarPropio(c, exten, familia, null, log);

  // ═══════════════ Armador de filas con etiquetas ══════════════════════════

  /* `setDialplan` guarda (prioridad, app, appdata) y NO admite el `same => n(etiqueta)` de
   * extensions.conf: todo salto tiene que ir a un NÚMERO de prioridad. Contarlos a mano
   * (como hace filasSalida() en trunks.js) funciona, pero agregar una línea en el medio
   * corre todos los Goto y el error no se ve hasta que alguien llama. Acá se escribe con
   * etiquetas simbólicas `<<nombre>>` y este armador las reemplaza por la prioridad real.
   * El marcador es `<<…>>` y no `@…` porque `@` aparece de verdad en los destinos
   * (`Local/${FNUM}@internal`) y se habría reemplazado solo. */
  function armar(def) {
    const filas = [];
    const etq = Object.create(null);
    for (const f of def) {
      if (!f) continue;                         // permite `cond ? fila : null` en la definición
      if (typeof f === 'string') { etq[f] = filas.length + 1; continue; }
      filas.push(f);
    }
    return filas.map((f, i) => [i + 1, f[0], String(f[1]).replace(/<<([a-z0-9_]+)>>/g, (m, k) => (etq[k] != null ? String(etq[k]) : m))]);
  }

  // ═══════════════ ¿Este número entra en esta ruta saliente? ═══════════════

  /* Match de un patrón de extensión de Asterisk contra un número de SÓLO DÍGITOS (el que
   * viene del dialplan ya pasó por FILTER(0-9,...)). Es la misma semántica que usa
   * `ast_extension_match`: X=0-9, Z=1-9, N=2-9, [..] rango, `.` uno o más, `!` cero o más,
   * y el guion se IGNORA (por eso `_NXX-XXXX` es lo mismo que `_NXXXXXX`).
   * Devuelve false ante cualquier cosa rara en vez de tirar: un patrón que no se entiende
   * significa "esta ruta no autoriza este número", que es el lado seguro. */
  function matchPatron(patron, numero) {
    const p = String(patron || '').replace(/^_/, '');
    const num = String(numero || '');
    if (!p || !/^[0-9]+$/.test(num)) return false;
    let re = '';
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === '-') continue;
      else if (ch === 'X' || ch === 'x') re += '[0-9]';
      else if (ch === 'Z' || ch === 'z') re += '[1-9]';
      else if (ch === 'N' || ch === 'n') re += '[2-9]';
      else if (ch === '.') re += '[0-9]+';
      else if (ch === '!') re += '[0-9]*';
      else if (ch === '[') {
        const j = p.indexOf(']', i);
        if (j < 0) return false;
        const cuerpo = p.slice(i + 1, j).replace(/[^0-9-]/g, '');
        if (!cuerpo) return false;
        re += '[' + cuerpo + ']';
        i = j;
      } else if (ch >= '0' && ch <= '9') re += ch;
      /* `*`, `#`, `+` en el patrón: el número es sólo dígitos, así que nunca va a matchear.
       * Se corta acá en vez de construir un regex con metacaracteres sueltos. */
      else return false;
    }
    try { return new RegExp('^' + re + '$').test(num); } catch (_) { return false; }
  }

  /* ¿CUÁL de todas las rutas salientes elegiría Asterisk para este número?
   *
   * POR QUÉ HACE FALTA: preguntar «¿alguna de las rutas habilitadas matchea?» NO restringe
   * nada, porque después se marca `Local/<num>@internal` y ahí Asterisk vuelve a hacer
   * best-match contra TODAS las rutas del contexto, habilitadas o no. Con la ruta que
   * siembra el panel por defecto (`_0X.`, «salida por 0») alcanzaba: el que entraba a la
   * DISA marcaba `00` + un número internacional, `_0X.` matcheaba, la API decía «ok» y
   * Asterisk cursaba por `_00.` —la ruta internacional, la que el administrador NO había
   * habilitado—. La pantalla decía «sólo salida nacional» y la factura decía otra cosa.
   *
   * El orden es el de `ext_cmp1()` de pbx.c: se compara posición por posición y gana la
   * que en la primera posición distinta acepta MENOS dígitos (un literal acepta uno, `[1-3]`
   * tres, N ocho, Z nueve, X diez), y los comodines que se comen el resto (`.`, `!`) son lo
   * menos específico que hay. Un patrón que no se entiende vale `null` y su ruta queda
   * fuera de la comparación: no se puede afirmar nada sobre ella. */
  const COSTE_PUNTO = 1000, COSTE_BANG = 1001;
  function perfilPatron(patron) {
    const p = String(patron || '').replace(/^_/, '');
    const t = [];
    let wild = null;
    for (let i = 0; i < p.length && wild === null; i++) {
      const ch = p[i];
      if (ch === '-') continue;
      else if (ch === '.') wild = COSTE_PUNTO;
      else if (ch === '!') wild = COSTE_BANG;
      else if (ch === 'X' || ch === 'x') t.push(10);
      else if (ch === 'Z' || ch === 'z') t.push(9);
      else if (ch === 'N' || ch === 'n') t.push(8);
      else if (ch === '[') {
        const j = p.indexOf(']', i);
        if (j < 0) return null;
        const cuerpo = p.slice(i + 1, j);
        const set = new Set();
        for (let k = 0; k < cuerpo.length; k++) {
          if (cuerpo[k + 1] === '-' && cuerpo[k + 2] >= '0' && cuerpo[k + 2] <= '9' && cuerpo[k] >= '0' && cuerpo[k] <= '9') {
            for (let d = +cuerpo[k]; d <= +cuerpo[k + 2]; d++) set.add(d);
            k += 2;
          } else if (cuerpo[k] >= '0' && cuerpo[k] <= '9') set.add(+cuerpo[k]);
        }
        if (!set.size) return null;
        t.push(set.size);
        i = j;
      } else if (ch >= '0' && ch <= '9') t.push(1);
      else return null;
    }
    return { t, wild };
  }
  /* Coste de la posición i: pasado el final, manda el comodín; sin comodín el patrón ya
   * terminó y no compite (sólo se comparan patrones que matchearon el MISMO número, así
   * que esto no llega a pasar salvo con patrones raros: ahí conviene "el menos específico"
   * y que el empate lo resuelva el lado seguro). */
  const costeEn = (perfil, i) => (i < perfil.t.length ? perfil.t[i] : (perfil.wild != null ? perfil.wild : Number.MAX_SAFE_INTEGER));
  function cmpPerfil(a, b, largo) {
    for (let i = 0; i < largo; i++) {
      const ca = costeEn(a, i), cb = costeEn(b, i);
      if (ca !== cb) return ca < cb ? -1 : 1;
    }
    return 0;
  }

  /* Devuelve la ruta que ganaría el best-match, o null si ninguna matchea. `empate` marca
   * que hay dos patrones igual de específicos: ahí no se puede saber cuál elige Asterisk
   * (depende del orden interno de la tabla) y el que pregunta tiene que negar. */
  function rutaGanadora(rutas, num) {
    const cand = [];
    for (const r of rutas || []) {
      if (!matchPatron(r.pattern, num)) continue;
      const perfil = perfilPatron(r.pattern);
      if (perfil) cand.push({ r, perfil });
    }
    if (!cand.length) return null;
    const largo = Math.max(String(num).length, ...cand.map((c) => c.perfil.t.length));
    cand.sort((a, b) => cmpPerfil(a.perfil, b.perfil, largo) || (a.r.id - b.r.id));
    const empate = cand.length > 1 && cmpPerfil(cand[0].perfil, cand[1].perfil, largo) === 0 && cand[0].r.id !== cand[1].r.id;
    return { ruta: cand[0].r, empate };
  }

  /* ¿Sale este número a la calle por una ruta que ESTE servicio (DISA o callback) tiene
   * habilitada? Devuelve el motivo del rechazo para que quede en `pbxng_marcacion_log`:
   * «no sale» y «sale por otra ruta» son dos problemas distintos para el que mira el
   * registro tratando de entender una factura. */
  async function rutaHabilitada(ids, num) {
    const { rows } = await pool.query('SELECT id, pattern FROM pbxng_outbound_routes');
    const g = rutaGanadora(rows, num);
    if (!g) return { ok: false, motivo: 'el destino no entra en ninguna ruta saliente' };
    if (g.empate) return { ok: false, motivo: 'hay dos rutas salientes igual de específicas para ese destino: no se puede saber cuál cursaría' };
    if (!ids.includes(g.ruta.id)) return { ok: false, motivo: 'la ruta que cursaría el destino (' + g.ruta.pattern + ') no está habilitada acá' };
    return { ok: true, motivo: null };
  }

  /* Lista de ids de rutas salientes que llega del panel (la tienen la DISA y el callback):
   * se limpia y se comprueba que existan. Una ruta que no existe silenciosamente sería
   * «habilité algo y no anda» o, peor, «creía que estaba restringido». */
  async function normalizarRutas(v) {
    const ids = [...new Set((Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter((x) => x > 0))];
    if (!ids.length) return ids;
    const { rows } = await pool.query('SELECT id FROM pbxng_outbound_routes WHERE id = ANY($1)', [ids]);
    const hay = new Set(rows.map((r) => r.id));
    const falta = ids.filter((x) => !hay.has(x));
    if (falta.length) throw err(400, 'ruta saliente inexistente: ' + falta.join(', '));
    return ids;
  }

  // ═══════════════ DISA ════════════════════════════════════════════════════

  const COLS_DISA = 'id,nombre,exten,enabled,rutas,internos,callerid,max_intentos,bloqueo_min,dur_seg,dial_seg,max_digitos';
  const salidaDisa = (r) => (r ? Object.assign({}, r, { pin_hash: undefined, tiene_pin: true }) : r);

  /* Dialplan de UNA DISA. Orden: pedir PIN (hasta max_intentos, con el bloqueo del lado de
   * la API) → tono → leer el número → que la API diga si puede marcarlo → marcar.
   *
   * El número se marca con `Local/<num>@internal/n` y no con un Dial a una troncal por el
   * mismo motivo que el sígueme de extensions.conf: la única salida a la calle que conoce
   * esta central son las rutas salientes que trunks.js deja como extensiones de `internal`,
   * con su prefijo, su CallerID y su cadena de failover. Reimplementar eso acá sería tener
   * dos verdades. El `/n` (sin optimizar) mantiene el canal vivo para el CDR.
   *
   * `TIMEOUT(absolute)` se fija DESPUÉS de autenticar a propósito: si se fijara antes, los
   * segundos que tarda alguien en marcar su PIN se los estaría comiendo a su propia llamada. */
  function filasDisa(d) {
    const maxInt = Math.min(10, Math.max(1, parseInt(d.max_intentos, 10) || 3));
    const maxDig = Math.min(32, Math.max(3, parseInt(d.max_digitos, 10) || 20));
    const dur = Math.min(7200, Math.max(30, parseInt(d.dur_seg, 10) || 300));
    const dialSeg = Math.min(300, Math.max(10, parseInt(d.dial_seg, 10) || 60));
    const qsPin = 'accion=pin&id=' + d.id + '&pin=${URIENCODE(${DPIN})}&cid=${URIENCODE(${CALLERID(num)})}';
    const qsNum = 'accion=marcar&id=' + d.id + '&num=${FNUM}&cid=${URIENCODE(${CALLERID(num)})}';
    return armar([
      ['NoOp', 'DISA ' + (d.nombre || '') + ' (#' + d.id + ')'],
      ['Answer', ''],
      ['Wait', '1'],
      ['Set', 'INTENTO=0'],
      'pedir',
      ['Set', 'INTENTO=$[${INTENTO} + 1]'],
      ['Read', 'DPIN,vm-password,12,,1,8'],
      ['Set', 'DRES=' + curlA('/api/internal/disa', qsPin)],
      ['GotoIf', '$["${DRES}"="ok"]?<<tono>>'],
      // Bloqueado por intentos: no se le dice al que llama cuánto falta ni por qué.
      ['GotoIf', '$["${DRES}"="bloqueado"]?<<chau>>'],
      ['Playback', 'auth-incorrect'],
      ['GotoIf', '$[${INTENTO} < ' + maxInt + ']?<<pedir>>'],
      'chau',
      ['Playback', 'vm-goodbye'],
      ['Hangup', ''],
      'tono',
      ['Playback', 'auth-thankyou'],
      ['Set', 'TIMEOUT(absolute)=' + dur],
      /* CallerID saliente de la DISA. Sin esto sale el CallerID del que llamó de afuera y
       * la mayoría de las troncales lo rechazan (o lo reescriben con el principal). */
      d.callerid ? ['Set', 'CALLERID(num)=' + d.callerid] : null,
      ['Read', 'DNUM,vm-enter-num-to-call,' + maxDig + ',,1,10'],
      /* FILTER(0-9,...) igual que en los códigos de función: lo que se marca después del
       * tono llega crudo, y sin filtrar un `*21*…` terminaría dentro de un contexto donde
       * viven los códigos de función, ejecutándose con la identidad de ESTE canal. */
      ['Set', 'FNUM=${FILTER(0-9,${DNUM})}'],
      ['GotoIf', '$["${FNUM}"=""]?<<malo>>'],
      ['Set', 'DRES=' + curlA('/api/internal/disa', qsNum)],
      // Cualquier respuesta que no sea exactamente "ok" (incluida la vacía, si la API no
      // está) rechaza la llamada: el fallo tiene que caer del lado seguro.
      ['GotoIf', '$["${DRES}"!="ok"]?<<malo>>'],
      ['Dial', 'Local/${FNUM}@internal/n,' + dialSeg],
      ['Hangup', ''],
      'malo',
      ['Playback', 'cannot-complete-as-dialed'],
      ['Hangup', ''],
    ]);
  }

  async function escribirDisa(c, d) {
    await borrarPropio(c, d.exten, 'disa');
    if (d.enabled) await setDialplan(c, 'internal', d.exten, filasDisa(d));
  }

  /* Intentos fallidos y bloqueo. En memoria, como el rate limit del login (auth.js): se
   * pierde al reiniciar la API, y está bien —el bloqueo es contra el que está probando
   * PINes AHORA—, pero el registro de cada intento sí queda en Postgres. La clave incluye
   * el CallerID para no dejar que un atacante bloquee la DISA para todos los demás;
   * el CallerID vacío o falseado cae en su propio balde compartido, que también se frena. */
  const fallos = new Map();
  const claveFallo = (id, cid) => id + ':' + (cid || '?');
  function bloqueado(id, cid) {
    const f = fallos.get(claveFallo(id, cid));
    return !!(f && f.hasta > Date.now());
  }
  function sumarFallo(id, cid, d) {
    const k = claveFallo(id, cid);
    const f = fallos.get(k) || { n: 0, hasta: 0 };
    f.n += 1;
    if (f.n >= Math.min(10, Math.max(1, d.max_intentos || 3))) {
      f.hasta = Date.now() + Math.min(1440, Math.max(1, d.bloqueo_min || 15)) * 60000;
      f.n = 0;
    }
    fallos.set(k, f);
    return f.hasta > Date.now();
  }
  const limpiarFallo = (id, cid) => fallos.delete(claveFallo(id, cid));

  async function registrar(familia, refId, cid, evento, destino, motivo) {
    try {
      await pool.query('INSERT INTO pbxng_marcacion_log (familia,ref_id,cid,evento,destino,motivo) VALUES ($1,$2,$3,$4,$5,$6)',
        [familia, refId || null, String(cid || '').slice(0, 40) || null, evento, destino ? String(destino).slice(0, 40) : null, motivo ? String(motivo).slice(0, 200) : null]);
    } catch (e) { log.error('registrar: ' + (e && e.message)); }
  }

  /* Un PIN no puede ser el número de un interno (es EL PIN que pone todo el mundo y el
   * primero que prueba el que escanea), ni todos los dígitos iguales, ni una escalera. */
  async function validarPin(pin) {
    if (!PIN_OK.test(String(pin || ''))) throw err(400, 'el PIN tiene que ser de 4 a 12 dígitos');
    const p = String(pin);
    if (/^(\d)\1+$/.test(p)) throw err(400, 'ese PIN es todos los dígitos iguales: elegí otro');
    const asc = '01234567890', desc = '09876543210';
    if (asc.includes(p) || desc.includes(p)) throw err(400, 'ese PIN es una secuencia de dígitos: elegí otro');
    const { rows } = await pool.query('SELECT 1 FROM ps_endpoints WHERE id=$1 LIMIT 1', [p]).catch(() => ({ rows: [] }));
    if (rows.length) throw err(400, 'el PIN no puede ser el número de un interno');
    return bcrypt.hash(p, 10);
  }

  /* Normaliza y valida una DISA antes de que toque la base o el dialplan. */
  async function normalizarDisa(b, actual) {
    const d = Object.assign({
      nombre: 'DISA', exten: '', enabled: false, rutas: [], internos: false, callerid: '',
      max_intentos: 3, bloqueo_min: 15, dur_seg: 300, dial_seg: 60, max_digitos: 20,
    }, actual || {});
    if (b.nombre !== undefined) d.nombre = String(b.nombre || '').slice(0, 80) || 'DISA';
    if (b.exten !== undefined) d.exten = String(b.exten || '').trim();
    if (b.enabled !== undefined) d.enabled = !!b.enabled;
    if (b.internos !== undefined) d.internos = !!b.internos;
    if (b.callerid !== undefined) d.callerid = String(b.callerid || '').trim();
    for (const k of ['max_intentos', 'bloqueo_min', 'dur_seg', 'dial_seg', 'max_digitos']) if (b[k] !== undefined) d[k] = parseInt(b[k], 10) || 0;
    if (b.rutas !== undefined) d.rutas = Array.isArray(b.rutas) ? b.rutas : [];
    if (!ENTRADA_OK.test(d.exten)) throw err(400, 'la extensión de entrada sólo puede ser dígitos, * y #, hasta 10 caracteres');
    if (d.callerid && !CID_OK.test(d.callerid)) throw err(400, 'el CallerID saliente sólo puede ser dígitos y +');
    d.max_intentos = Math.min(10, Math.max(1, d.max_intentos || 3));
    d.bloqueo_min = Math.min(1440, Math.max(1, d.bloqueo_min || 15));
    d.dur_seg = Math.min(7200, Math.max(30, d.dur_seg || 300));
    d.dial_seg = Math.min(300, Math.max(10, d.dial_seg || 60));
    d.max_digitos = Math.min(32, Math.max(3, d.max_digitos || 20));
    d.rutas = await normalizarRutas(d.rutas);
    /* Encender una DISA que no puede salir por ninguna ruta ni llamar internos es tener una
     * puerta abierta que no sirve para nada: mejor decirlo que dejarla ahí. */
    if (d.enabled && !d.rutas.length && !d.internos) throw err(400, 'para activar la DISA elegí al menos una ruta saliente o permití las llamadas a internos');
    return d;
  }

  app.get('/api/disa', async (req, res) => {
    try { const { rows } = await pool.query('SELECT ' + COLS_DISA + ' FROM pbxng_disa ORDER BY id'); res.json(rows.map(salidaDisa)); }
    catch (e) { errorHttp(res, e); }
  });

  app.post('/api/disa', async (req, res) => {
    const b = req.body || {};
    try {
      const d = await normalizarDisa(b, null);
      const hash = await validarPin(b.pin);
      const fila = await conCliente(async (c) => {
        // Antes de tocar nada: esa extensión puede ser el *97 del buzón o un IVR.
        await libreEnInternal(c, d.exten, 'disa', null);
        const { rows } = await c.query(
          `INSERT INTO pbxng_disa (nombre,exten,pin_hash,enabled,rutas,internos,callerid,max_intentos,bloqueo_min,dur_seg,dial_seg,max_digitos)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ` + COLS_DISA,
          [d.nombre, d.exten, hash, d.enabled, JSON.stringify(d.rutas), d.internos, d.callerid || null, d.max_intentos, d.bloqueo_min, d.dur_seg, d.dial_seg, d.max_digitos]);
        await escribirDisa(c, rows[0]);
        return rows[0];
      });
      broadcastSoon();
      res.status(201).json(salidaDisa(fila));
    } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/disa/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    try {
      const { rows: viejo } = await pool.query('SELECT ' + COLS_DISA + ' FROM pbxng_disa WHERE id=$1', [id]);
      if (!viejo[0]) return res.status(404).json({ error: 'DISA inexistente' });
      const d = await normalizarDisa(b, viejo[0]);
      const hash = b.pin === undefined || b.pin === '' ? null : await validarPin(b.pin);
      const fila = await conCliente(async (c) => {
        await libreEnInternal(c, d.exten, 'disa', id);
        const { rows } = await c.query(
          `UPDATE pbxng_disa SET nombre=$2, exten=$3, enabled=$4, rutas=$5, internos=$6, callerid=$7,
             max_intentos=$8, bloqueo_min=$9, dur_seg=$10, dial_seg=$11, max_digitos=$12,
             pin_hash=COALESCE($13, pin_hash)
           WHERE id=$1 RETURNING ` + COLS_DISA,
          [id, d.nombre, d.exten, d.enabled, JSON.stringify(d.rutas), d.internos, d.callerid || null,
            d.max_intentos, d.bloqueo_min, d.dur_seg, d.dial_seg, d.max_digitos, hash]);
        // Cambiar la extensión de entrada tiene que borrar la vieja: si no, la DISA sigue
        // marcable por el número anterior para siempre (y con el PIN viejo en la cabeza
        // de quien lo sabía).
        if (viejo[0].exten !== d.exten) await borrarPropio(c, viejo[0].exten, 'disa');
        await escribirDisa(c, rows[0]);
        return rows[0];
      });
      broadcastSoon();
      res.json(salidaDisa(fila));
    } catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/disa/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const n = await conCliente(async (c) => {
        const { rows } = await c.query('DELETE FROM pbxng_disa WHERE id=$1 RETURNING exten', [id]);
        if (!rows[0]) return 0;
        await borrarPropio(c, rows[0].exten, 'disa');
        return 1;
      });
      if (!n) return res.status(404).json({ error: 'DISA inexistente' });
      broadcastSoon();
      res.json({ deleted: id });
    } catch (e) { errorHttp(res, e); }
  });

  /* Registro de uso: quién entró, desde qué CallerID, a qué número llamó y qué se rechazó.
   * Lo ve también el supervisor (rbac.js) porque es lo que explica una factura rara. */
  function rutaRegistro(familia) {
    return async (req, res) => {
      const lim = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
      try {
        const { rows } = await pool.query(
          'SELECT id,ts,ref_id,cid,evento,destino,motivo FROM pbxng_marcacion_log WHERE familia=$1 ORDER BY ts DESC LIMIT $2', [familia, lim]);
        res.json(rows);
      } catch (e) { errorHttp(res, e); }
    };
  }
  app.get('/api/disa/registro', rutaRegistro('disa'));
  app.get('/api/callback/registro', rutaRegistro('callback'));

  // ═══════════════ Callback ════════════════════════════════════════════════

  const COLS_CB = 'id,nombre,exten,enabled,modo,numeros,rutas,demora_seg,cooldown_seg,max_dia,dest_type,dest_value';
  const salidaCb = (r) => (r ? Object.assign({}, r, { tiene_pin: !!r.pin_hash, pin_hash: undefined }) : r);

  /* Dialplan de UN callback. En modo 'lista' NO se atiende la llamada: la gracia del
   * callback es justamente que al que llama no le cobren nada, y atender es tarifar.
   * Cuando hay PIN no queda otra que atender (hay que escuchar DTMF) y se avisa igual. */
  function filasCallback(cb) {
    const conPin = cb.modo === 'pin' || cb.modo === 'lista_pin';
    const qs = 'id=' + cb.id + '&cid=${URIENCODE(${CALLERID(num)})}' + (conPin ? '&pin=${URIENCODE(${CPIN})}' : '');
    if (!conPin) {
      return armar([
        ['NoOp', 'Callback ' + (cb.nombre || '') + ' (#' + cb.id + ')'],
        ['Set', 'CRES=' + curlA('/api/internal/callback', qs)],
        ['Hangup', ''],
      ]);
    }
    return armar([
      ['NoOp', 'Callback ' + (cb.nombre || '') + ' (#' + cb.id + ')'],
      ['Answer', ''],
      ['Wait', '1'],
      ['Read', 'CPIN,vm-password,12,,1,8'],
      ['Set', 'CRES=' + curlA('/api/internal/callback', qs)],
      ['GotoIf', '$["${CRES}"="ok"]?<<ok>>'],
      ['Playback', 'auth-incorrect'],
      ['Hangup', ''],
      'ok',
      ['Playback', 'auth-thankyou'],
      ['Hangup', ''],
    ]);
  }

  async function escribirCallback(c, cb) {
    await borrarPropio(c, cb.exten, 'callback');
    if (cb.enabled) await setDialplan(c, 'internal', cb.exten, filasCallback(cb));
  }

  async function normalizarCb(b, actual) {
    const cb = Object.assign({
      nombre: 'Callback', exten: '', enabled: false, modo: 'lista', numeros: [], rutas: [],
      demora_seg: 5, cooldown_seg: 60, max_dia: 20, dest_type: 'disa', dest_value: '',
    }, actual || {});
    if (b.nombre !== undefined) cb.nombre = String(b.nombre || '').slice(0, 80) || 'Callback';
    if (b.exten !== undefined) cb.exten = String(b.exten || '').trim();
    if (b.enabled !== undefined) cb.enabled = !!b.enabled;
    if (b.modo !== undefined) cb.modo = String(b.modo || '').trim();
    if (b.dest_type !== undefined) cb.dest_type = String(b.dest_type || '').trim();
    if (b.dest_value !== undefined) cb.dest_value = String(b.dest_value || '').trim();
    for (const k of ['demora_seg', 'cooldown_seg', 'max_dia']) if (b[k] !== undefined) cb[k] = parseInt(b[k], 10) || 0;
    if (b.numeros !== undefined) cb.numeros = Array.isArray(b.numeros) ? b.numeros : String(b.numeros || '').split(',');
    cb.numeros = [...new Set((cb.numeros || []).map((x) => String(x || '').trim()).filter(Boolean))];
    if (b.rutas !== undefined) cb.rutas = Array.isArray(b.rutas) ? b.rutas : [];
    cb.rutas = await normalizarRutas(cb.rutas);
    if (!ENTRADA_OK.test(cb.exten)) throw err(400, 'la extensión de entrada sólo puede ser dígitos, * y #, hasta 10 caracteres');
    if (!MODOS_CB.includes(cb.modo)) throw err(400, 'modo inválido: se espera lista, pin o lista_pin');
    if (!DEST_CB.includes(cb.dest_type)) throw err(400, 'destino inválido: se espera disa, ivr o app');
    if (!ENTRADA_OK.test(cb.dest_value)) throw err(400, 'el destino del callback sólo puede ser dígitos, * y #');
    if (cb.numeros.length > 200) throw err(400, 'como máximo 200 números en la lista');
    for (const n of cb.numeros) if (!DESTINO.test(n)) throw err(400, 'número inválido en la lista: ' + n + ' (sólo dígitos)');
    cb.demora_seg = Math.min(120, Math.max(2, cb.demora_seg || 5));
    cb.cooldown_seg = Math.min(3600, Math.max(10, cb.cooldown_seg || 60));
    cb.max_dia = Math.min(500, Math.max(1, cb.max_dia || 20));
    if (cb.modo !== 'pin' && !cb.numeros.length && cb.enabled) throw err(400, 'en modo lista hace falta al menos un número permitido');
    /* En modo `pin` NO hay lista blanca y el número al que se devuelve la llamada es el
     * CallerID entrante, que se falsea con dos líneas en cualquier softphone: sin rutas
     * habilitadas, quien tenga el PIN se hace llamar a un premium internacional y el
     * `max_dia` sólo le pone un techo de veinte por día. La restricción de rutas es lo
     * ÚNICO que acota el destino en ese modo, así que sin ella no se puede encender. */
    if (cb.modo === 'pin' && cb.enabled && !cb.rutas.length) throw err(400, 'en modo PIN hace falta al menos una ruta saliente habilitada: el CallerID de quien llama se puede falsear y sin rutas la central devolvería la llamada a cualquier destino del mundo');
    return cb;
  }

  app.get('/api/callback', async (req, res) => {
    try { const { rows } = await pool.query('SELECT ' + COLS_CB + ', pin_hash FROM pbxng_callback ORDER BY id'); res.json(rows.map(salidaCb)); }
    catch (e) { errorHttp(res, e); }
  });

  app.post('/api/callback', async (req, res) => {
    const b = req.body || {};
    try {
      const cb = await normalizarCb(b, null);
      const conPin = cb.modo === 'pin' || cb.modo === 'lista_pin';
      if (conPin && !b.pin) throw err(400, 'ese modo necesita un PIN');
      const hash = conPin ? await validarPin(b.pin) : null;
      const fila = await conCliente(async (c) => {
        await libreEnInternal(c, cb.exten, 'callback', null);
        const { rows } = await c.query(
          `INSERT INTO pbxng_callback (nombre,exten,enabled,modo,pin_hash,numeros,rutas,demora_seg,cooldown_seg,max_dia,dest_type,dest_value)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ` + COLS_CB + ', pin_hash',
          [cb.nombre, cb.exten, cb.enabled, cb.modo, hash, JSON.stringify(cb.numeros), JSON.stringify(cb.rutas), cb.demora_seg, cb.cooldown_seg, cb.max_dia, cb.dest_type, cb.dest_value]);
        await escribirCallback(c, rows[0]);
        return rows[0];
      });
      broadcastSoon();
      res.status(201).json(salidaCb(fila));
    } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/callback/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    try {
      const { rows: viejo } = await pool.query('SELECT ' + COLS_CB + ', pin_hash FROM pbxng_callback WHERE id=$1', [id]);
      if (!viejo[0]) return res.status(404).json({ error: 'callback inexistente' });
      const cb = await normalizarCb(b, viejo[0]);
      const conPin = cb.modo === 'pin' || cb.modo === 'lista_pin';
      if (conPin && !viejo[0].pin_hash && !b.pin) throw err(400, 'ese modo necesita un PIN');
      const hash = b.pin === undefined || b.pin === '' ? null : await validarPin(b.pin);
      const fila = await conCliente(async (c) => {
        await libreEnInternal(c, cb.exten, 'callback', id);
        const { rows } = await c.query(
          `UPDATE pbxng_callback SET nombre=$2, exten=$3, enabled=$4, modo=$5, numeros=$6, rutas=$7, demora_seg=$8,
             cooldown_seg=$9, max_dia=$10, dest_type=$11, dest_value=$12, pin_hash=COALESCE($13, pin_hash)
           WHERE id=$1 RETURNING ` + COLS_CB + ', pin_hash',
          [id, cb.nombre, cb.exten, cb.enabled, cb.modo, JSON.stringify(cb.numeros), JSON.stringify(cb.rutas), cb.demora_seg,
            cb.cooldown_seg, cb.max_dia, cb.dest_type, cb.dest_value, hash]);
        if (viejo[0].exten !== cb.exten) await borrarPropio(c, viejo[0].exten, 'callback');
        await escribirCallback(c, rows[0]);
        return rows[0];
      });
      broadcastSoon();
      res.json(salidaCb(fila));
    } catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/callback/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const n = await conCliente(async (c) => {
        const { rows } = await c.query('DELETE FROM pbxng_callback WHERE id=$1 RETURNING exten', [id]);
        if (!rows[0]) return 0;
        await borrarPropio(c, rows[0].exten, 'callback');
        return 1;
      });
      if (!n) return res.status(404).json({ error: 'callback inexistente' });
      broadcastSoon();
      res.json({ deleted: id });
    } catch (e) { errorHttp(res, e); }
  });

  /* Devolver la llamada. Se marca con `Local/<num>@internal` por lo mismo que la DISA: las
   * rutas salientes viven ahí —y por eso mismo el número ya vino validado contra la ruta que
   * GANA el best-match (`rutaHabilitada`), que es la que va a cursar de verdad—. Cuando el usuario atiende, el canal cae en el destino
   * configurado (una DISA, un IVR o una extensión de `internal`), que es lo que le da tono.
   * Async porque el Originate sincrónico deja al AMI esperando todo el timbrado. */
  async function devolverLlamada(cb, num) {
    const ctx = cb.dest_type === 'ivr' ? 'ivr' : 'internal';
    await amiAction({
      Action: 'Originate',
      Channel: 'Local/' + num + '@internal',
      Context: ctx, Exten: cb.dest_value, Priority: 1,
      CallerID: 'Callback <' + num + '>',
      Async: 'true', Timeout: 45000,
    });
  }

  // ═══════════════ Dial-by-name (directorio por nombre) ════════════════════

  /* Directory() usa los nombres de los buzones (`voicemail.fullname`) y los prompts
   * `dir-*`, que ya vienen en el paquete de audios en español uruguayo: no hace falta
   * grabar nada nuevo. Un interno sin buzón con nombre NO aparece en el directorio; es
   * limitación de la aplicación de Asterisk, no de acá. */
  function filasDbn(d) {
    const opts = DBN_OPTS.test(String(d.opciones || '')) ? String(d.opciones || '') : 'e';
    const vmc = CTX_OK.test(String(d.vm_context || '')) ? String(d.vm_context) : 'default';
    return armar([
      ['NoOp', 'Directorio por nombre'],
      ['Answer', ''],
      ['Wait', '1'],
      /* `Directory()` es `app_directory.so` y el `Read()` de la DISA es `app_read.so`: los
       * dos están en `modules.conf` como `require` y se verificó contra la central en
       * producción que la imagen los trae (junto con `app_disa.so`), así que el `require`
       * no deja la central sin arrancar. */
      // El contexto donde marca es SIEMPRE `internal` y no se configura: es lo único de
      // esta pantalla que entra al dialplan y no hay motivo para que lo escriba nadie.
      ['Directory', vmc + ',internal' + (opts ? ',' + opts : '')],
      ['Playback', 'vm-goodbye'],
      ['Hangup', ''],
    ]);
  }

  const dbnDefault = { id: 0, exten: '', enabled: false, opciones: 'e', vm_context: 'default' };
  async function leerDbn() {
    const { rows } = await pool.query('SELECT id,exten,enabled,opciones,vm_context FROM pbxng_dialbyname ORDER BY id LIMIT 1');
    return rows[0] || Object.assign({}, dbnDefault);
  }

  app.get('/api/dialbyname', async (req, res) => {
    try {
      const d = await leerDbn();
      /* Quién aparecería si alguien marca el directorio AHORA: es la pregunta que se hace
       * el instalador, y la respuesta no está en ninguna pantalla del panel. */
      const { rows } = await pool.query("SELECT mailbox, COALESCE(fullname,'') AS fullname FROM voicemail WHERE context=$1 ORDER BY mailbox", [d.vm_context || 'default']);
      res.json(Object.assign({}, d, { directorio: rows.filter((r) => r.fullname.trim()), sin_nombre: rows.filter((r) => !r.fullname.trim()).map((r) => r.mailbox) }));
    } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/dialbyname', async (req, res) => {
    const b = req.body || {};
    try {
      const actual = await leerDbn();
      const d = {
        exten: b.exten === undefined ? actual.exten : String(b.exten || '').trim(),
        enabled: b.enabled === undefined ? actual.enabled : !!b.enabled,
        opciones: b.opciones === undefined ? actual.opciones : String(b.opciones || '').trim(),
        vm_context: b.vm_context === undefined ? actual.vm_context : String(b.vm_context || '').trim(),
      };
      if (!ENTRADA_OK.test(d.exten)) throw err(400, 'la extensión del directorio sólo puede ser dígitos, * y #, hasta 10 caracteres');
      if (!DBN_OPTS.test(d.opciones)) throw err(400, 'opciones inválidas: sólo e, f, l, b, m, n, o, p');
      if (!CTX_OK.test(d.vm_context)) throw err(400, 'contexto de buzones inválido');
      const fila = await conCliente(async (c) => {
        await libreEnInternal(c, d.exten, 'dialbyname', actual.id || null);
        const { rows } = actual.id
          ? await c.query('UPDATE pbxng_dialbyname SET exten=$2, enabled=$3, opciones=$4, vm_context=$5 WHERE id=$1 RETURNING id,exten,enabled,opciones,vm_context', [actual.id, d.exten, d.enabled, d.opciones, d.vm_context])
          : await c.query('INSERT INTO pbxng_dialbyname (exten,enabled,opciones,vm_context) VALUES ($1,$2,$3,$4) RETURNING id,exten,enabled,opciones,vm_context', [d.exten, d.enabled, d.opciones, d.vm_context]);
        if (actual.exten && actual.exten !== d.exten) await borrarPropio(c, actual.exten, 'dialbyname');
        await borrarPropio(c, d.exten, 'dialbyname');
        if (d.enabled) await setDialplan(c, 'internal', d.exten, filasDbn(d));
        return rows[0];
      });
      broadcastSoon();
      res.json(fila);
    } catch (e) { errorHttp(res, e); }
  });

  // ═══════════════ Marcación abreviada ═════════════════════════════════════

  const PREF_KEY = 'abrev_prefijo';
  const PREF_DEF = '*75';
  /* El patrón de los abreviados PERSONALES: `<prefijo>XX`. El destino no está en el
   * dialplan sino en la AstDB (`abrev/<ext>-<NN>`), así que agregar un número corto no
   * recarga nada, igual que un desvío. La identidad sale de CHANNEL(endpoint) y no de
   * CALLERID(num) por lo mismo que *97 en extensions.conf: el CallerID lo pone el teléfono,
   * y si no, cualquier interno marcaría los abreviados de otro. */
  function filasAbrevPropio(prefijo) {
    const off = prefijo.length;
    return armar([
      ['NoOp', 'Abreviado personal ${EXTEN:' + off + '}'],
      ['Set', 'MIEXT=${IF($["${CHANNEL(channeltype)}"="PJSIP"]?${CHANNEL(endpoint)}:${CALLERID(num)})}'],
      // FILTER aunque la API ya valide: este camino lee la AstDB, que también escribe
      // cualquiera con acceso al CLI de Asterisk, y el valor termina en un Goto a `internal`,
      // el contexto donde viven los códigos de función.
      ['Set', 'ADEST=${FILTER(0-9,${DB(abrev/${MIEXT}-${EXTEN:' + off + '})})}'],
      ['GotoIf', '$["${ADEST}"=""]?<<vacio>>'],
      ['Goto', 'internal,${ADEST},1'],
      'vacio',
      ['Answer', ''],
      ['Playback', 'pbx-invalid'],
      ['Hangup', ''],
    ]);
  }
  const filasAbrevGlobal = (a) => armar([
    ['NoOp', 'Abreviado ' + a.code + ' → ' + a.destino + (a.nombre ? ' (' + a.nombre + ')' : '')],
    ['Goto', 'internal,' + a.destino + ',1'],
  ]);

  async function prefijoAbrev() {
    const p = String(await setGet(PREF_KEY, PREF_DEF) || PREF_DEF);
    return PREFIJO_OK.test(p) ? p : PREF_DEF;
  }
  const extenPatron = (prefijo) => '_' + prefijo + 'XX';

  /* Publica (o saca) el patrón de los abreviados personales. Se publica sólo si hay al
   * menos uno cargado: una central que no los usa no tiene por qué tener `*75XX` ocupando
   * el plan de marcado. */
  async function publicarPatron(c, prefijo) {
    const pref = prefijo || await prefijoAbrev();
    const { rows } = await c.query('SELECT 1 FROM pbxng_abreviados WHERE ext IS NOT NULL LIMIT 1');
    await borrarPropio(c, extenPatron(pref), 'abreviado');
    if (!rows.length) return;
    // El patrón también va a `internal`: si el prefijo elegido pisa algo de otro, se avisa.
    await libreEnInternal(c, extenPatron(pref), 'abreviado', null);
    await setDialplan(c, 'internal', extenPatron(pref), filasAbrevPropio(pref));
  }

  /* Un código corto no puede pisar un código de función ni una extensión que ya existe:
   * el que gana es impredecible (dialplan estático vs realtime) y el síntoma es "desde ayer
   * *78 hace otra cosa". Es exactamente la misma pregunta que se hacen la DISA, el callback
   * y el directorio, así que la contesta el mismo chequeo para todos. */
  const libreGlobal = (c, code, id) => libreEnInternal(c, code, 'abreviado', id);

  app.get('/api/abreviados', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT id,code,destino,nombre FROM pbxng_abreviados WHERE ext IS NULL ORDER BY code');
      res.json({ prefijo: await prefijoAbrev(), globales: rows });
    } catch (e) { errorHttp(res, e); }
  });

  app.post('/api/abreviados', async (req, res) => {
    const b = req.body || {};
    const code = String(b.code || '').trim();
    const destino = String(b.destino || '').trim();
    try {
      if (!CODE_GLOBAL.test(code)) throw err(400, 'número corto inválido: de 2 a 8 caracteres, sólo dígitos, * y #');
      if (!DESTINO.test(destino)) throw err(400, 'destino inválido (sólo dígitos, hasta 32)');
      const fila = await conCliente(async (c) => {
        await libreGlobal(c, code, null);
        const { rows } = await c.query('INSERT INTO pbxng_abreviados (ext,code,destino,nombre) VALUES (NULL,$1,$2,$3) RETURNING id,code,destino,nombre',
          [code, destino, String(b.nombre || '').slice(0, 80) || null]);
        await setDialplan(c, 'internal', code, filasAbrevGlobal(rows[0]));
        return rows[0];
      });
      broadcastSoon();
      res.status(201).json(fila);
    } catch (e) { errorHttp(res, e); }
  });

  /* Cambiar el prefijo de los abreviados personales reescribe el patrón: el viejo se borra
   * para no dejar dos formas de marcar lo mismo (y una de ellas sin mantenimiento).
   * Va ANTES de `/api/abreviados/:id`: Express resuelve en orden y `:id` se comería
   * «prefijo» dando un 404 con parseInt(NaN). */
  app.put('/api/abreviados/prefijo', async (req, res) => {
    const p = String((req.body || {}).prefijo || '').trim();
    try {
      if (!PREFIJO_OK.test(p)) throw err(400, 'prefijo inválido: empieza con * o # y hasta 3 caracteres más');
      const viejo = await prefijoAbrev();
      await setPut(PREF_KEY, p);
      await conCliente(async (c) => {
        if (viejo !== p) await borrarPropio(c, extenPatron(viejo), 'abreviado');
        await publicarPatron(c, p);
      });
      broadcastSoon();
      res.json({ prefijo: p });
    } catch (e) { errorHttp(res, e); }
  });

  app.put('/api/abreviados/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    try {
      const { rows: viejo } = await pool.query('SELECT id,code,destino,nombre FROM pbxng_abreviados WHERE id=$1 AND ext IS NULL', [id]);
      if (!viejo[0]) return res.status(404).json({ error: 'número corto inexistente' });
      const code = b.code === undefined ? viejo[0].code : String(b.code).trim();
      const destino = b.destino === undefined ? viejo[0].destino : String(b.destino).trim();
      if (!CODE_GLOBAL.test(code)) throw err(400, 'número corto inválido: de 2 a 8 caracteres, sólo dígitos, * y #');
      if (!DESTINO.test(destino)) throw err(400, 'destino inválido (sólo dígitos, hasta 32)');
      const fila = await conCliente(async (c) => {
        if (code !== viejo[0].code) {
          await libreGlobal(c, code, id);
          await borrarPropio(c, viejo[0].code, 'abreviado');
        }
        const { rows } = await c.query('UPDATE pbxng_abreviados SET code=$2, destino=$3, nombre=COALESCE($4,nombre) WHERE id=$1 RETURNING id,code,destino,nombre',
          [id, code, destino, b.nombre === undefined ? null : String(b.nombre).slice(0, 80)]);
        await setDialplan(c, 'internal', code, filasAbrevGlobal(rows[0]));
        return rows[0];
      });
      broadcastSoon();
      res.json(fila);
    } catch (e) { errorHttp(res, e); }
  });

  app.delete('/api/abreviados/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const n = await conCliente(async (c) => {
        const { rows } = await c.query('DELETE FROM pbxng_abreviados WHERE id=$1 AND ext IS NULL RETURNING code', [id]);
        if (!rows[0]) return 0;
        await borrarPropio(c, rows[0].code, 'abreviado');
        return 1;
      });
      if (!n) return res.status(404).json({ error: 'número corto inexistente' });
      broadcastSoon();
      res.json({ deleted: id });
    } catch (e) { errorHttp(res, e); }
  });

  // ── Abreviados PERSONALES del interno (los cambia el propio usuario) ──────
  app.get('/api/extensions/:ext/abreviados', async (req, res) => {
    const ext = String(req.params.ext || '');
    if (!EXT_OK.test(ext)) return res.status(400).json({ error: 'interno inválido' });
    if (!exigirExt(req, res, ext)) return;
    try {
      const { rows } = await pool.query('SELECT id,code,destino,nombre FROM pbxng_abreviados WHERE ext=$1 ORDER BY code', [ext]);
      res.json({ prefijo: await prefijoAbrev(), entradas: rows });
    } catch (e) { errorHttp(res, e); }
  });

  /* PUT con la lista COMPLETA: es una libreta de dos dígitos, no vale la pena un CRUD por
   * entrada, y así borrar es sacar la fila de la lista. */
  app.put('/api/extensions/:ext/abreviados', async (req, res) => {
    const ext = String(req.params.ext || '');
    if (!EXT_OK.test(ext)) return res.status(400).json({ error: 'interno inválido' });
    if (!exigirExt(req, res, ext)) return;
    const lista = Array.isArray((req.body || {}).entradas) ? req.body.entradas : null;
    try {
      if (!lista) throw err(400, 'se espera {entradas: [...]}');
      if (lista.length > 100) throw err(400, 'como máximo 100 abreviados por interno');
      const limpias = lista.map((e) => {
        const code = String((e && e.code) || '').trim();
        const destino = String((e && e.destino) || '').trim();
        if (!CODE_PROPIO.test(code)) throw err(400, 'código inválido: ' + code + ' (dos dígitos, 00 a 99)');
        if (!DESTINO.test(destino)) throw err(400, 'destino inválido en ' + code + ' (sólo dígitos, hasta 32)');
        return { code, destino, nombre: String((e && e.nombre) || '').slice(0, 80) || null };
      });
      const vistos = new Set();
      for (const e of limpias) { if (vistos.has(e.code)) throw err(400, 'código repetido: ' + e.code); vistos.add(e.code); }
      const prefijo = await prefijoAbrev();
      await conCliente(async (c) => {
        const { rows: antes } = await c.query('SELECT code FROM pbxng_abreviados WHERE ext=$1', [ext]);
        await c.query('DELETE FROM pbxng_abreviados WHERE ext=$1', [ext]);
        for (const e of limpias) await c.query('INSERT INTO pbxng_abreviados (ext,code,destino,nombre) VALUES ($1,$2,$3,$4)', [ext, e.code, e.destino, e.nombre]);
        await publicarPatron(c, prefijo);
        // La AstDB se sincroniza FUERA de la transacción (es de Asterisk, no de Postgres),
        // pero se calcula acá lo que hay que borrar: los que ya no están.
        const quedan = new Set(limpias.map((e) => e.code));
        for (const r of antes) if (!quedan.has(r.code)) await astDel('abrev', ext + '-' + r.code);
      });
      let ok = true;
      for (const e of limpias) if (!await astPut('abrev', ext + '-' + e.code, e.destino)) ok = false;
      broadcastSoon();
      const out = { prefijo, entradas: limpias };
      if (!ok) { out.aviso = AVISO_ASTDB; log.warn('abreviados guardados sin llegar a la AstDB', { ext }); }
      res.json(out);
    } catch (e) { errorHttp(res, e); }
  });

  /* Postgres → AstDB al arrancar y en cada reconexión del AMI, igual que syncFeatures():
   * la astdb ya tiene volumen propio, pero si quedó desincronizada de Postgres (o viene de
   * una instalación anterior al volumen) los abreviados personales quedarían mudos. */
  async function syncAbreviados() {
    try {
      const { rows } = await pool.query('SELECT ext,code,destino FROM pbxng_abreviados WHERE ext IS NOT NULL');
      let fallados = 0;
      for (const r of rows) if (!await astPut('abrev', r.ext + '-' + r.code, r.destino)) fallados++;
      // Este vuelco es la red de seguridad del resto: si queda incompleto, el teléfono
      // marca abreviados que ya no existen (o no marca los que sí) hasta la próxima vuelta.
      if (fallados) log.warn('el volcado de abreviados a la AstDB quedó incompleto', { entradas: rows.length, fallados });
      else log.info('abreviados personales volcados a la AstDB', { entradas: rows.length });
    } catch (e) { log.error('syncAbreviados: ' + (e && e.message)); }
  }

  // ═══════════════ Lo que el dialplan le pregunta a la API ═════════════════

  /* Las dos rutas de acá son PÚBLICAS (PUBLIC_API) porque el CURL del dialplan no tiene
   * sesión, y responden TEXTO PLANO ("ok" / "no" / "bloqueado") en vez de JSON: el que las
   * lee es un `${CURL(...)}` comparado con `$["${DRES}"="ok"]`, no un navegador. Cualquier
   * otra respuesta —incluida la vacía, si la API está caída— hace que el dialplan rechace
   * la llamada, que es el lado seguro. */
  const urlenc = express.urlencoded({ extended: false, limit: '8kb' });
  const texto = (res, s) => res.type('text/plain').send(s);

  app.post('/api/internal/disa', urlenc, async (req, res) => {
    if (!soloDesdeLaCentral(req, res)) return;
    const b = Object.assign({}, req.body || {}, req.query || {});
    const id = parseInt(b.id, 10) || 0;
    const cid = String(b.cid || '').replace(/[^0-9+]/g, '').slice(0, 40);
    const accion = String(b.accion || '').trim();
    try {
      const { rows } = await pool.query('SELECT ' + COLS_DISA + ', pin_hash FROM pbxng_disa WHERE id=$1', [id]);
      const d = rows[0];
      if (!d || !d.enabled) { await registrar('disa', id, cid, 'rechazo', null, 'DISA inexistente o apagada'); return texto(res, 'no'); }

      if (accion === 'pin') {
        if (bloqueado(id, cid)) { await registrar('disa', id, cid, 'bloqueado', null, 'origen bloqueado por intentos'); return texto(res, 'bloqueado'); }
        const ok = await bcrypt.compare(String(b.pin || ''), d.pin_hash || '').catch(() => false);
        if (!ok) {
          const seBloqueo = sumarFallo(id, cid, d);
          await registrar('disa', id, cid, seBloqueo ? 'bloqueado' : 'pin_mal', null, seBloqueo ? 'bloqueado ' + d.bloqueo_min + ' min' : null);
          return texto(res, seBloqueo ? 'bloqueado' : 'no');
        }
        limpiarFallo(id, cid);
        await registrar('disa', id, cid, 'pin_ok', null, null);
        return texto(res, 'ok');
      }

      if (accion === 'marcar') {
        const num = String(b.num || '').replace(/[^0-9]/g, '').slice(0, 32);
        if (!num) { await registrar('disa', id, cid, 'rechazo', null, 'número vacío'); return texto(res, 'no'); }
        const v = await puedeMarcar(d, num);
        await registrar('disa', id, cid, v.ok ? 'llamada' : 'rechazo', num, v.ok ? null : v.motivo);
        return texto(res, v.ok ? 'ok' : 'no');
      }
      return texto(res, 'no');
    } catch (e) {
      log.error('internal/disa: ' + (e && e.message));
      return texto(res, 'no');
    }
  });

  /* ¿Esta DISA puede marcar este número? Sólo si la ruta que ELEGIRÍA ASTERISK está entre
   * las suyas (ver rutaGanadora(): que «alguna habilitada matchee» no restringe nada), o si
   * es un interno que existe y la DISA tiene permitido llamar internos. Que el interno se
   * compruebe contra `ps_endpoints` y no contra un `_[1-9]XXX` escrito acá es a propósito:
   * el plan de numeración lo decide numbering.js, no este módulo.
   * Los internos se miran PRIMERO porque una llamada interna no pasa por ninguna ruta
   * saliente y no gasta plata: no tiene por qué caerse por el criterio de las rutas. */
  async function puedeMarcar(d, num) {
    if (d.internos) {
      const { rows } = await pool.query('SELECT 1 FROM ps_endpoints WHERE id=$1 LIMIT 1', [num]).catch(() => ({ rows: [] }));
      if (rows.length) return { ok: true, motivo: null };
    }
    const ids = Array.isArray(d.rutas) ? d.rutas : [];
    if (!ids.length) return { ok: false, motivo: 'esta DISA no tiene ninguna ruta saliente habilitada' };
    return rutaHabilitada(ids, num);
  }

  app.post('/api/internal/callback', urlenc, async (req, res) => {
    if (!soloDesdeLaCentral(req, res)) return;
    const b = Object.assign({}, req.body || {}, req.query || {});
    const id = parseInt(b.id, 10) || 0;
    const cid = String(b.cid || '').replace(/[^0-9]/g, '').slice(0, 32);
    try {
      const { rows } = await pool.query('SELECT ' + COLS_CB + ', pin_hash FROM pbxng_callback WHERE id=$1', [id]);
      const cb = rows[0];
      if (!cb || !cb.enabled) { await registrar('callback', id, cid, 'rechazo', null, 'callback inexistente o apagado'); return texto(res, 'no'); }
      if (!cid) { await registrar('callback', id, cid, 'rechazo', null, 'sin CallerID: no hay a quién devolver la llamada'); return texto(res, 'no'); }

      const lista = Array.isArray(cb.numeros) ? cb.numeros : [];
      if (cb.modo !== 'pin' && !lista.includes(cid)) {
        await registrar('callback', id, cid, 'rechazo', cid, 'número fuera de la lista permitida');
        return texto(res, 'no');
      }
      /* A DÓNDE se devuelve la llamada. En modo `pin` no hay lista blanca y el número es el
       * CallerID entrante, que se falsea con dos líneas en cualquier softphone: la
       * restricción de rutas es lo único que acota el destino, y por eso es obligatoria
       * para encenderlo (normalizarCb). Se vuelve a exigir acá porque una fila vieja o
       * tocada a mano en la base no pasó por esa validación. En los modos con lista, las
       * rutas se aplican si el administrador eligió alguna; si no, manda la lista blanca,
       * que es lo que ya acotaba el destino. */
      const rutasCb = Array.isArray(cb.rutas) ? cb.rutas : [];
      if (rutasCb.length || cb.modo === 'pin') {
        const v = rutasCb.length
          ? await rutaHabilitada(rutasCb, cid)
          : { ok: false, motivo: 'callback en modo PIN sin ninguna ruta saliente habilitada' };
        if (!v.ok) { await registrar('callback', id, cid, 'rechazo', cid, v.motivo); return texto(res, 'no'); }
      }

      if (cb.modo === 'pin' || cb.modo === 'lista_pin') {
        /* El balde de intentos en modo `pin` es POR CALLBACK y no por origen: ahí el
         * CallerID lo elige el que llama, así que rotándolo tenía un balde nuevo por
         * intento y el bloqueo no se activaba nunca. En `lista_pin` el origen ya está
         * acotado a la lista blanca, y ahí sí conviene por origen para que uno de la
         * lista no deje el callback muerto para los demás. */
        const kcid = cb.modo === 'pin' ? '' : cid;
        // El bloqueo se mira ANTES de comparar: si no, el que está probando PINes sigue
        // gastando comparaciones de bcrypt (~100 ms cada una) aunque ya esté bloqueado.
        if (bloqueado('cb' + id, kcid)) { await registrar('callback', id, cid, 'bloqueado', cid, 'bloqueado por intentos'); return texto(res, 'no'); }
        const ok = await bcrypt.compare(String(b.pin || ''), cb.pin_hash || '').catch(() => false);
        if (!ok) {
          const seBloqueo = sumarFallo('cb' + id, kcid, { max_intentos: 3, bloqueo_min: 15 });
          await registrar('callback', id, cid, seBloqueo ? 'bloqueado' : 'pin_mal', cid, null);
          return texto(res, 'no');
        }
        limpiarFallo('cb' + id, kcid);
      }
      /* Dos frenos para que la central no sirva de amplificador: un mismo número no puede
       * pedir callback dos veces seguidas dentro del cooldown, y hay un tope diario por
       * callback. Sin esto, alguien de la lista (o que falsea el CallerID de alguien de la
       * lista) nos hace marcar sin parar y el costo lo paga el cliente. */
      const { rows: ult } = await pool.query(
        "SELECT ts FROM pbxng_marcacion_log WHERE familia='callback' AND ref_id=$1 AND cid=$2 AND evento='llamada' ORDER BY ts DESC LIMIT 1", [id, cid]);
      if (ult[0] && Date.now() - new Date(ult[0].ts).getTime() < cb.cooldown_seg * 1000) {
        await registrar('callback', id, cid, 'rechazo', cid, 'dentro del tiempo de espera entre callbacks');
        return texto(res, 'no');
      }
      const { rows: hoy } = await pool.query(
        "SELECT count(*)::int AS n FROM pbxng_marcacion_log WHERE familia='callback' AND ref_id=$1 AND evento='llamada' AND ts > now() - interval '1 day'", [id]);
      if (hoy[0] && hoy[0].n >= cb.max_dia) {
        await registrar('callback', id, cid, 'rechazo', cid, 'tope diario de callbacks alcanzado');
        return texto(res, 'no');
      }

      await registrar('callback', id, cid, 'llamada', cid, null);
      /* La devolución sale DESPUÉS de contestar el CURL: el dialplan tiene que colgar la
       * llamada entrante antes de que suene la de vuelta, si no el usuario tiene el teléfono
       * ocupado con su propia llamada saliente. */
      setTimeout(() => {
        devolverLlamada(cb, cid).catch((e) => {
          log.error('callback: no se pudo devolver la llamada a ' + cid + ': ' + (e && e.message));
          registrar('callback', id, cid, 'rechazo', cid, 'no se pudo originar la llamada').catch(() => {});
        });
      }, cb.demora_seg * 1000).unref();
      return texto(res, 'ok');
    } catch (e) {
      log.error('internal/callback: ' + (e && e.message));
      return texto(res, 'no');
    }
  });

  // Postgres → AstDB al arrancar, en la misma ventana que syncFeatures/syncRecFlags.
  setTimeout(() => { syncAbreviados().catch(() => {}); }, 9000);

  return { syncAbreviados, matchPatron, rutaGanadora, filasDisa, filasCallback, filasDbn, filasAbrevPropio };
};
