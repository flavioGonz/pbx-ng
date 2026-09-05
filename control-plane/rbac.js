'use strict';
/* PBX-NG - Control de acceso por rol (RBAC) para /api.
 *
 * Antes cada ruta decidía sola si miraba el rol o no, y la enorme mayoría no lo
 * miraba: un usuario 'agente' con sesión válida podía borrar troncales, crear
 * usuarios admin o bajar un respaldo completo. El panel lo escondía, la API no.
 *
 * Acá hay UNA tabla, deny-by-default: cada familia de ruta (método + path) dice
 * qué roles la pueden usar. Lo que no está en la tabla es sólo para 'admin'. Así
 * agregar una ruta nueva sin pensar en permisos la deja cerrada, no abierta.
 *
 * Qué NO hace este módulo:
 *   - No autentica: corre DESPUÉS del gate de auth (req.user ya está).
 *   - No mira tokens de softphone (scope 'phone'): esos ya pasan por la
 *     allowlist FONO_PERMITIDO de app.js, que es más chica que cualquier rol.
 *   - No reemplaza los chequeos de "misma extensión" (mismaExt/exigirExt): que un
 *     agente PUEDA pedir /api/vm no significa que pueda pedir el buzón de otro.
 *
 * Roles (docs/CONTRATOS.md §2):
 *   admin      todo.
 *   supervisor operación + call center: llamadas, colas (pausar / agentes),
 *              presencia, directorio, CDR, grabaciones, CRM, encuestas, buzones
 *              ajenos, monitor, wallboard, escucha, aprovisionamiento y enrolado
 *              de internos. NADA de configuración del sistema.
 *   agente     su panel de agente y su extensión, nada más.
 *
 * La tabla se recorre en orden y gana la PRIMERA coincidencia: las reglas
 * específicas (p.ej. "GET /api/queues" para supervisor) van antes que las
 * generales que las taparían ("* /api/queues.*" para admin). */

const TODOS = ['admin', 'supervisor', 'agente'];
const SUP   = ['admin', 'supervisor'];
const ADMIN = ['admin'];

/* [métodos, regex sobre la ruta completa, roles]
 *  métodos: 'GET', 'GET|POST', '*' (cualquiera). */
const PERMISOS = [
  /* ── Sesión propia (cualquiera con sesión) ───────────────────────────────── */
  ['GET',      /^\/api\/auth\/me$/,                         TODOS],
  ['POST',     /^\/api\/auth\/password$/,                   TODOS],
  ['*',        /^\/api\/me(\/|$)/,                          TODOS],
  ['GET',      /^\/api\/(directory|presence|ice|branding)$/, TODOS],
  ['GET',      /^\/api\/modules$/,                          TODOS],   // qué módulos están prendidos: lo lee el shell del panel
  // Notificaciones del propio teléfono (push/test verifica la ext). Sólo estas cuatro:
  // el comodín push/* arrastraba GET push/devices, que es el inventario de dispositivos
  // de TODAS las extensiones (pantalla /notificaciones, sólo admin: cae al default).
  ['POST',     /^\/api\/push\/(subscribe|register|unsubscribe|test)$/, TODOS],
  ['GET',      /^\/api\/agent\/state$/,                     TODOS],   // pausa propia en cola (la ruta usa req.user.ext)
  ['POST',     /^\/api\/agent\/pause$/,                     TODOS],
  // Buzón de voz: la ruta exige mismaExt (agente = sólo el suyo; supervisor = todos).
  ['GET',      /^\/api\/vm(\/audio)?$/,                     TODOS],
  ['POST',     /^\/api\/vm\/(del|read|transcribe)$/,        TODOS],
  // Llamadas sobre la propia extensión: la ruta compara el ext del body con req.user.ext.
  ['POST',     /^\/api\/calls\/(dial|transfer|park|record|conference)$/, TODOS],
  // Historial y grabaciones propias: la ruta fuerza ext = req.user.ext para 'agente'.
  ['GET',      /^\/api\/cdr$/,                              TODOS],
  ['GET',      /^\/api\/recordings\/match$/,                TODOS],
  ['GET',      /^\/api\/recordings\/\d+\/audio$/,           TODOS],
  // Screen-pop y encuesta post-llamada del panel de agente (lectura del CRM, alta de encuesta).
  ['GET',      /^\/api\/clients\/lookup$/,                  TODOS],
  ['GET',      /^\/api\/survey\/fields$/,                   TODOS],
  ['POST',     /^\/api\/survey$/,                           TODOS],

  /* ── Operación / call center (admin + supervisor) ────────────────────────── */
  ['*',        /^\/api\/calls(\/|$)/,                       SUP],     // live, hangup/hold por canal, spy
  ['GET',      /^\/api\/channels$/,                         SUP],
  ['GET',      /^\/api\/wallboard$/,                        SUP],
  ['GET',      /^\/api\/queues$/,                           SUP],
  ['GET',      /^\/api\/queues\/[^/]+\/live$/,              SUP],
  ['POST',     /^\/api\/queues\/[^/]+\/members$/,           SUP],     // meter / sacar agentes de una cola
  ['DELETE',   /^\/api\/queues\/[^/]+\/members\/[^/]+$/,    SUP],
  ['GET',      /^\/api\/cdr\/report$/,                      SUP],
  ['GET',      /^\/api\/recordings$/,                       SUP],
  ['GET',      /^\/api\/recordings\/\d+\/(transcript|peaks)$/, SUP],
  ['POST',     /^\/api\/recordings\/\d+\/transcribe$/,      SUP],
  ['*',        /^\/api\/(clients|persons|spaces|devices)(\/|$)/, SUP], // CRM (crmWrite ya limita la escritura a estos roles)
  ['GET',      /^\/api\/intercom\/(clients|streams)$/,      SUP],
  ['*',        /^\/api\/survey(\/|$)/,                      SUP],
  ['GET',      /^\/api\/(extensions|tenants|metrics)$/,     SUP],
  ['GET',      /^\/api\/provision$/,                        SUP],     // config completa de un teléfono (la ruta ya lo exigía)
  ['GET',      /^\/api\/enrollments$/,                      SUP],
  ['POST',     /^\/api\/enroll(\/email)?$/,                 SUP],     // enrolar un interno / mandar el QR por correo
  ['GET',      /^\/api\/phones$/,                           SUP],

  /* ── Todo lo demás (configuración del sistema) queda en ADMIN por defecto:
   *    users, settings, trunks, routes, sbc-link, modules (escritura), backup,
   *    asterisk, net, system, turn, acme, npm, integrations, branding (escritura),
   *    extensions/endpoints (escritura), ivr, queues/ringgroups (escritura),
   *    recordings (borrado y almacenamiento), vm/email, security, email, voz,
   *    prompts, sysprompts, capture, sip, db, manuales, c2c, alerts, etc. */
];

function metodoOk(spec, method) {
  return spec === '*' || spec.split('|').includes(method);
}

/* Roles que pueden usar (method, path). `path` es la ruta completa ('/api/...'). */
function rolesPara(method, path) {
  for (const [m, re, roles] of PERMISOS) {
    if (metodoOk(m, method) && re.test(path)) return roles;
  }
  return ADMIN;
}

function rolPuede(role, method, path) {
  return rolesPara(method, path).includes(role);
}

/* Middleware para montar en '/api' justo después del gate de auth.
 * Deja pasar lo público (sin req.user) y los tokens de softphone (scope 'phone'),
 * que tienen su propia allowlist. */
function middleware(req, res, next) {
  const u = req.user;
  if (!u) return next();                       // ruta pública: no hay rol que mirar
  if (u.scope === 'phone') return next();      // ya filtrado por FONO_PERMITIDO en auth()
  // El middleware va montado en '/api': req.path acá es '/vm', hay que rearmar la ruta completa.
  const full = (req.baseUrl || '') + req.path;
  if (rolPuede(u.role, req.method, full)) return next();
  return res.status(403).json({ error: 'no tenés permiso para esta acción' });
}

module.exports = { PERMISOS, TODOS, SUP, ADMIN, rolesPara, rolPuede, middleware };
