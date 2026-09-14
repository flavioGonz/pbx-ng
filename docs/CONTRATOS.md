# PBX-NG · Contratos entre componentes

Este archivo es el acuerdo que todos los agentes del proyecto (`.claude/agents/`) respetan y
mantienen al día. Si un cambio toca algo de acá, se actualiza en el mismo commit. Lo que no está
acá no se puede asumir.

## 1. Piezas y quién es dueño

| Pieza | Directorio | Agente |
|---|---|---|
| API / control-plane | `control-plane/` | `api` |
| Panel web | `dashboard/` | `panel` |
| Asterisk y dialplan | `docker/config/asterisk/`, `docker/images/asterisk/`, `control-plane/astconf.js` | `telefonia` |
| Empaquetado / operación | `docker/`, `deploy/`, `.github/workflows/`, `VERSION` | `empaquetado` |
| Softphone de escritorio | `softphone-app/` | `softphone` |
| Documentación | `README.md`, `CHANGELOG.md`, `docs/`, manuales | `docs` |
| Revisión | (no escribe producto) | `revisor` |

### 1.1 Archivos de la API por dominio (`control-plane/`)

`app.js` (≈2.200 líneas) arma Express, el gate de auth + RBAC, ARI/AMI, socket.io y lo que
todavía no se partió (internos, push, click-to-call, teléfonos físicos, red, respaldos, CRM,
wallboard, pickup-groups). El resto vive en módulos con el patrón
`module.exports = function init(deps) { …registra rutas en deps.app…; return {…} }`: reciben
TODO por `deps` (nada global) y **se registran en `app.js` después del gate de auth y de
`rbac.middleware`** (Express resuelve en orden: un módulo registrado antes queda sin token ni
rol). Orden efectivo hoy: gate → `auth.js` → `sipconf.js` → `callengine.js` → `recordings.js`
→ `apps.js` → `trunks.js` → `telefonia.js` → `marcacion.js` → `salas.js` → `fax.js` →
`ccreport.js` → `guard.js` → 404 JSON + `errores.js` (`telefonia.js` va después de `trunks.js`
porque usa su `regenerarEntrantes`; `marcacion.js` después de `telefonia.js` porque sus números
cortos no pueden pisar los códigos de función de aquel; `fax.js` después de `trunks.js` porque
el envío sale por las rutas salientes que aquél publica en `internal`).

| Archivo | Dominio (rutas `/api/…`) | Devuelve a `app.js` |
|---|---|---|
| `auth.js` | JWT de panel y token `phone`, `PUBLIC_API`, `FONO_PERMITIDO`, alcance por extensión, rate limit de login; `auth/*`, `users/*`, `phone/token`, `me/sipcreds`, `provision`, `enroll*`; bootstrap del usuario `admin` | `auth`, `isPublicApi`, `PUBLIC_API`, `FONO_PERMITIDO`, `mismaExt`, `exigirExt`, `extPropia`, `clientIp`, `limiteIntentos`, `ROLES` |
| `sipconf.js` | SIP de la central (`pbxng.d/pjsip.conf`, `rtp.conf`, transportes) | — |
| `callengine.js` | motor ARI: `calls/*` (dial, hangup, live, spy…) | — |
| `recordings.js` | `recordings/*`, `cdr`, `cdr/report`, `calls/record`, `extensions/record-all`; marca `rec/<ext>` en la AstDB, indexador de `/recordings`, transcripción y picos; inicializa `recstore.js` y `report.js` | `setRecFlag`, `setRecAll`, `syncRecFlags`, `wavToPcm`, `analyzeText`, `indexRecordings` |
| `apps.js` | `queues/*`, `ringgroups/*`, `paging/*`, `ivr/*` (+ `ivr/audios`, `ivr/gen-audio`), `ai-agents/*`, `featurecodes/*`, `parking/*`, `moh/*`, `mailboxes/*`, `vm/*` (volumen `/voicemail`, transcripción, poller buzón → correo) | `aiAgentDialplan`, `buildIvrDialplan`, `vmList` |
| `salas.js` | salas de reunión (ítem 9 de `BRECHA-UCM-XORCOM.md`): `salas` (CRUD), `salas/:name/live`, `salas/:name/mute|kick` (AMI `Confbridge*`) y `salas/:name/invitar` (correo con `emails.meetingEmail`). Escribe Postgres **y** la AstDB (`sala`/`salapin`/`salamod`); un reloj interno abre y cierra las salas agendadas | `syncSalas`, `salaDialplan`, `ventanaAbierta` |
| `trunks.js` | `trunks/*`, `routes/inbound|outbound`, `sbc-link`, `registrations`; sondeo OPTIONS, semillas `to-sbc` / `mod_sbc`, failover de troncal. Publica DOS cosas en el contexto compartido `internal` —la ruta saliente (`_<patrón>`) y la salida directa de cada troncal (`_<prefijo>.`, «crear ruta de salida automática»)— y las dos pasan por `dueno-internal.js`: 409 antes de escribir, y borrar sólo lo propio | `sbcLink`, `upsertSbcLink`, `invalidarSbcLink`, `trunkStatuses`, `defaultOutTrunk`, `regenerarEntrantes`, `failoverStates`, `filasSalida`, `SBC_TRUNK` |
| `telefonia.js` | telefonía clásica de oficina (1.9.0): `extensions/:ext/features` (desvíos, DND, sígueme), `horarios/*`, `feriados/*`, `nightmode`, `featurecodes/*` (catálogo editable, reemplaza al `FEATURE_CODES` fijo de `apps.js`) y `internal/feature` (lo que el usuario marca en el teléfono → Postgres). Escribe Postgres **y** la AstDB por AMI; le pide a `trunks.js` que regenere las rutas entrantes cuando cambia un horario o un feriado. Antes de publicar un código de función en `internal` pregunta quién ocupa esa extensión con `dueno-internal.js` (409 si es de otro) y sólo borra del dialplan lo que publicó él: el contexto es compartido y `setDialplan()` es DELETE + INSERT | `syncFeatures`, `estadoNightmode`, `filasCodigo`, `tramoAhora`, `leerFeat`, `guardarFeat` |
| `marcacion.js` | marcación (1.10.0, ítem 12 de `BRECHA-UCM-XORCOM.md`): `disa/*`, `callback/*`, `dialbyname`, `abreviados/*`, `extensions/:ext/abreviados` y las dos rutas que llama el dialplan (`internal/disa`, `internal/callback`). DISA y callback **nacen apagados**; el PIN vive en bcrypt en Postgres y **nunca** en el dialplan: el dialplan lo pregunta por CURL y esta API compara, cuenta intentos, bloquea y registra cada uso con el CallerID de origen en `pbxng_marcacion_log`. Sus extensiones de entrada pasan por el mismo `dueno-internal.js` que los códigos de función: el candado del contexto compartido `internal` es simétrico y la lista de quién puede ocupar una extensión está en un solo lugar | `syncAbreviados`, `matchPatron`, `rutaGanadora`, `filasDisa`, `filasCallback`, `filasDbn`, `filasAbrevPropio` |
| `fax.js` | fax (1.10.0, ítem 7 de `BRECHA-UCM-XORCOM.md`): `fax/estado`, `fax/config`, `fax/boxes*`, `fax/in*`, `fax/out*` y `internal/fax` (el dialplan avisa cómo terminó un ReceiveFAX/SendFAX). Escribe el dialplan realtime de recepción (`from-trunk`, `fax-rx-<caja>` y `fax` para el CNG) y de envío (`internal`, `fax-tx`, que pasa por `dueno-internal.js` como el resto de lo que se publica en ese contexto compartido). **En una central sin fax no escribe dialplan**: `syncFax` en el arranque y `escribirDialplan()` sólo publican `fax-tx` si hay al menos una caja o un trabajo de salida, y el primer envío lo crea si falta. Reconcilia las columnas T.38 del endpoint de cada troncal, convierte PDF ⇄ TIFF (ghostscript / tiff2pdf, siempre por `execFile`), manda el fax recibido por correo y maneja la cola de salida con reintentos | `syncFax`, `filasRx`, `filasTx`, `paginasTiff`, `aplicarT38` |
| `ccreport.js` | reportes de call center (1.10.0, ítem 8 de `BRECHA-UCM-XORCOM.md`): `ccreport`, `ccreport/csv`, `ccreport/report`, `ccreport/schedules*`. Lee el mismo horario de atención que el modo noche (`pbxng_horarios` + `nightmode_horario_id`) pero lo evalúa **dentro del SQL**, no con el `tramoAhora` de `telefonia.js`. Consume por AMI los eventos de cola (`QueueCallerJoin`, `AgentConnect`, `AgentComplete`, `QueueCallerAbandon`, `AgentRingNoAnswer`) → `pbxng_queue_events`, que es la fuente del informe (el `cdr` no sabe nada de lo que pasa dentro de una cola); reusa `report.js` para el A4 y `alerts.js`/`emails.js` para el envío programado | `metricas`, `filasCsv`, `tick` (hoy `app.js` no usa ninguno) |
| `guard.js` | centro de seguridad: `security/*`, `ipgeo`, eventos AMI `security`, nftables vía el agente | (ver §3, familia `security`) |
| `rbac.js` | tabla deny-by-default método+ruta → rol | `middleware` |

Auxiliares sin rutas propias: `astconf.js`, `salud.js`, `sysmon.js`, `alerts.js`, `backup.js`,
`acme.js`, `recstore.js`, `report.js`, `diagtrunk.js`, `emails.js`, `log.js`, `errores.js`,
`numbering.js`, `netmode.js`, `push-providers.js`, `ai-pipeline.js`, `dueno-internal.js`,
`migrate.js` + `migrations/`. El detalle de qué recibe cada módulo por `deps` está en el JSDoc de cabecera
de cada archivo y en `.claude/agents/api.md`.

## 2. Autenticación y roles

- Sesión de panel: `POST /api/auth/login` → JWT (`{uid, username, role, name, ext}`, 12 h). El
  panel lo guarda en `localStorage.pbxng_jwt` y `app/auth.jsx` lo inyecta en cada
  `fetch('/backend/...')` como `Authorization: Bearer`. Rate limit: 10 fallos / 10 min por
  IP+usuario **más** 50 fallos / 10 min por IP sola (contra password spraying), ambos
  `429 {error}`; los logins correctos no consumen cupo. La IP es siempre `req.ip` (la API
  confía en un salto de proxy, `trust proxy = 1`), nunca el primer valor de `X-Forwarded-For`.
  **El único salto que la API confía es el panel** (`dashboard/server.js`, proxy propio en
  vez de los `rewrites` de Next, que no agregaban `X-Forwarded-For`): reenvía `/backend`,
  `/socket.io`, `/prov` y `/descargas/softphone` a `API_URL` dejando la IP real del cliente
  como ÚLTIMO elemento de `X-Forwarded-For`. Sin proxy adelante (`TRUST_PROXY=0`) esa IP es
  la del socket (un `X-Forwarded-For` inventado por el cliente queda adelante y se ignora);
  con NPM (`TRUST_PROXY=1`, se infiere del perfil `proxy` en `COMPOSE_PROFILES`) se recorta
  el salto de NPM y queda la IP que NPM agregó. Así el límite por IP vale tanto detrás de
  NPM como con el panel usado directo por `:3001`. Nadie más debe llegar a `:3000`.
  Un usuario cuyo rol no esté en `{admin, supervisor, agente}` recibe `403` en el login con
  un mensaje claro (no se emite JWT); `migrations/0008_roles.sql` y el bootstrap de la API
  convierten los roles viejos (`operator` → `supervisor`, `viewer` → `agente`) y dejan el
  default de la columna en `agente`.
- Token de softphone (`scope:'phone'`): además de lo que ya tenía, `FONO_PERMITIDO` incluye
  desde 1.9.0 `GET|PUT /api/extensions/:ext/features` — el aparato cambia sus propios desvíos,
  y la ruta comprueba con `exigirExt` que sea su interno.
- Roles: `admin` (todo), `supervisor` (operación + call center, sin configuración de sistema),
  `agente` (solo su panel de agente y su extensión). **Regla desde 1.4.0:** el middleware de
  `control-plane/rbac.js` (montado en `/api` justo después del gate de auth) decide por
  método+ruta qué roles pasan. Desde sprint1-seguridad el dominio de autenticación vive en
  `control-plane/auth.js` (mismo patrón que `callengine.js`: `require('./auth')(deps)` registra
  las rutas de sesión, usuarios, `phone/token`, `provision`, `enroll*` y devuelve `auth`,
  `isPublicApi`, `PUBLIC_API`, `FONO_PERMITIDO`, `mismaExt`, `exigirExt`, `extPropia`,
  `clientIp`, `limiteIntentos`, `ROLES`); `app.js` sigue montando el gate ANTES de ese init; lo que no está en la tabla es `admin` por defecto. Rechazo:
  `403 {error:'no tenés permiso para esta acción'}`. La tabla `PERMISOS` se recorre en orden y
  gana la primera coincidencia (las reglas específicas van antes que las generales). Transcripción
  por familia (`TODOS` = admin+supervisor+agente; `SUP` = admin+supervisor; el resto = `admin`):

  | Familia (ruta bajo `/api`) | Métodos | Roles | Nota |
  |---|---|---|---|
  | `auth/me` | GET | TODOS | |
  | `auth/password` | POST | TODOS | exige `current` (ver más abajo) |
  | `me/*` | * | TODOS | |
  | `directory`, `presence`, `ice`, `branding` | GET | TODOS | |
  | `modules` | GET | TODOS | el shell lee qué módulos están prendidos |
  | `push/subscribe`, `push/register`, `push/unsubscribe`, `push/test` | POST | TODOS | `push/test` exige la ext propia. `GET push/devices` (inventario de todas las extensiones) es sólo `admin` |
  | `agent/state` · `agent/pause` | GET · POST | TODOS | pausa propia en cola (usa `req.user.ext`) |
  | `vm`, `vm/audio` · `vm/del`, `vm/read`, `vm/transcribe` | GET · POST | TODOS | la ruta exige `mismaExt` (agente = sólo el suyo) |
  | `calls/dial`, `calls/transfer`, `calls/park`, `calls/record`, `calls/conference` | POST | TODOS | la ruta compara `from`/`ext` con `req.user.ext` (`403 'no podés operar llamadas de otra extensión'`) |
  | `cdr` | GET | TODOS | agente y token phone: se fuerza `ext` propia (`403` si no tiene interno) |
  | `recordings/match`, `recordings/:id/audio` | GET | TODOS | agente: sólo llamadas en las que participó su interno |
  | `extensions/:ext/features` | GET\|PUT | TODOS | desvíos, DND y sígueme del **propio** interno: la ruta exige la ext con `exigirExt`, así que el agente sólo alcanza el suyo y admin/supervisor cualquiera. Va ANTES de la regla general de `extensions` |
  | `extensions/:ext/abreviados` | GET\|PUT | TODOS | libreta de marcación abreviada **personal** del interno: misma idea y mismo `exigirExt` que `features`, y también va ANTES de la regla general de `extensions`. Los números cortos GLOBALES (`abreviados`) son configuración de la central: `admin` |
  | `clients/lookup` | GET | TODOS | screen-pop |
  | `survey/fields` · `survey` | GET · POST | TODOS | encuesta post-llamada |
  | `calls/*` (live, `:id/hangup|hold|unhold`, spy…) | * | SUP | |
  | `channels`, `wallboard` | GET | SUP | |
  | `queues` · `queues/:n/live` | GET | SUP | |
  | `queues/:n/members` · `queues/:n/members/:ext` | POST · DELETE | SUP | meter / sacar agentes de una cola |
  | `cdr/report` | GET | SUP | |
  | `ccreport` · `ccreport/csv` · `ccreport/report` | GET | SUP | reportes de call center: ver y exportar es operación (el informe lo firma el supervisor). `ccreport/schedules*` —programar el envío por correo— es configuración y cae al default `admin` |
  | `recordings` · `recordings/:id/transcript|peaks` · `recordings/:id/transcribe` | GET · GET · POST | SUP | |
  | `clients`, `persons`, `spaces`, `devices` (y subrutas) | * | SUP | CRM completo (`crmWrite` ya limitaba la escritura) |
  | `intercom/clients`, `intercom/streams` | GET | SUP | |
  | `survey/*` | * | SUP | |
  | `extensions`, `tenants`, `metrics` | GET | SUP | |
  | `provision` | GET | SUP | config completa de un teléfono |
  | `enrollments` · `enroll`, `enroll/email` | GET · POST | SUP | enrolar un interno / mandar el QR por correo |
  | `phones` | GET | SUP | |
  | `nightmode` | GET | SUP | el supervisor VE si la central está abierta o cerrada; forzarlo (PUT), los horarios, los feriados y los códigos de función son `admin` |
  | `disa/registro` · `callback/registro` | GET | SUP | registro de uso de DISA y callback (quién entró, desde qué CallerID, a qué número): es operación —es lo que explica una factura rara o un barrido de PINes— y es sólo lectura. Configurar la DISA (PIN, rutas habilitadas, encenderla) cae al default `admin` |
  | `security` · `security/live` | GET | SUP | centro de seguridad: resumen y registro en vivo (sólo lectura); bloquear/desbloquear, listas, geo-bloqueo, ajustes y `apply` son `admin` |
  | `salas` · `salas/:name/live` · `salas/:name/mute`\|`kick` | GET · GET · POST | SUP | salas de reunión: el supervisor ve la lista, entra a la vista en vivo y **modera** (silenciar, expulsar) — es lo mismo que ya puede hacer con una llamada. El **detalle** `GET salas/:name` es `admin` porque es el único lugar que devuelve los dos PIN, y con el PIN de moderador se entra, se silencia y se expulsa: verlo es ser moderador de todas las salas. Alta, baja, edición e `invitar` (el correo puede llevar el PIN de moderador) caen al default `admin`. El panel esconde esos botones cuando el rol no es admin (`/salas` está en `SUP_OK`), igual que el borrar de `/fax` |
  | `fax/estado`, `fax/config`, `fax/boxes`, `fax/in`, `fax/out`, `fax/(in\|out)/:id/pdf` | GET | SUP | ver las dos bandejas y bajar el documento |
  | `fax/out` · `fax/out/:id/retry` · `fax/out/:id` | POST · POST · DELETE | SUP | mandar un fax, reintentarlo y cancelarlo es operación del día a día (el supervisor ya puede originar llamadas). Configurar cajas y T.38, y **borrar un fax recibido**, caen al default `admin`: un fax recibido es un documento. El panel **esconde** el botón de borrar de Recibidos cuando el rol no es admin (`/fax` está en SUP): un botón que sólo sabe dar 403 es peor que no tenerlo |
  | Todo lo demás | * | admin | users, settings, trunks, routes, sbc-link, modules (escritura), backup, asterisk, net, system, turn, acme, npm, integrations, branding (escritura), extensions/endpoints (escritura), ivr, queues/ringgroups (escritura), recordings (borrado y almacenamiento), vm/email, security (escritura, whitelist, geoblock, settings, apply), ipgeo, email, voz, prompts, sysprompts, capture, sip, db, manuales, c2c, alerts, geo, push/devices, salas (detalle con PIN, alta/baja/edición e invitación), disa, callback, dialbyname, abreviados (globales y prefijo)… |

  El RBAC no aplica a rutas públicas (sin `req.user`) ni a tokens `scope:'phone'` (van por
  `FONO_PERMITIDO`).
- **`SUP_OK`: qué pantallas del shell abre un supervisor.** La lista vive en
  `dashboard/app/auth.jsx` (exportada) y es **una sola** para dos cosas: qué ítems se le
  dibujan en el menú (`app/shell.jsx`) y en qué rutas lo deja quedarse el redirect de
  `AuthProvider`. Estuvieron separadas y pasó lo previsible: el menú ofrecía `/fax` y
  `/salas` y el redirect lo mandaba a `/supervisor` sin excepciones, así que todo el
  esconder-por-rol de adentro de esas pantallas era código que nunca corría con rol
  supervisor. Hoy: `['/cdr', '/reportes', '/wallboard', '/monitor', '/fax', '/salas']`.
  `/supervisor` sigue siendo su pantalla de **inicio** (a donde lo manda el login y a donde
  vuelve desde cualquier ruta que no le corresponde); el rol `agente` no cambia: sigue
  yendo siempre a `/agente`.
  Para entrar a la lista, la pantalla tiene que cumplir una de dos: **todos** sus pedidos
  son de familias SUP, o **esconde sola** lo que es de admin (la solapa «Configuración» de
  `/fax`, el alta/edición/baja/invitar/«Ver PIN» de `/salas`, los «Envíos programados» de
  `/reportes`, la solapa «Almacenamiento» y el botón de borrar de `/cdr`), siempre con
  `useEsAdmin()`. Una pantalla que igual va a comer un `403` **no se agrega**. Por eso
  quedaron **afuera** `/mapa` (su único dato es `GET /api/geo`, que es `admin`) y
  `/telefonos` (`GET|POST /api/settings` y el ABM de teléfonos son `admin`: la pantalla
  entera es configuración). Lo mismo vale para `/seguridad`, que tampoco está: sus solapas
  «Listas negras/blancas» y «Filtro por país» hacen `GET security/whitelist` y `GET
  security/geoblock`, que son `admin`; si algún día se la quiere abrir al supervisor hay
  que ocultar esas dos solapas o pasar esos dos GET a SUP acá y en `rbac.js`.
- Usuarios (`/api/users`, solo admin): rol por defecto al crear = `agente`; `role` ∈
  `{admin, supervisor, agente}`; contraseñas de 8+ caracteres; no se puede borrar el propio
  usuario ni el último `admin`.
- Cambio de clave propia: `POST /api/auth/password` `{ current, password }` (mínimo 8). `current`
  es obligatorio salvo en el primer ingreso (`must_change: true` en el login), donde el panel no
  lo pide. La clave de OTRO usuario se cambia por `POST /api/users/:id/password` (solo `admin`).
- Panel ante 401: borra la sesión y va a `/login`. Ante 403: no redirige, muestra un toast con el
  `error` del JSON (dedupe de 3 s) y le deja el body intacto a la página. Eso lo hace el parche
  global de `window.fetch` en `app/auth.jsx` y **no se duplica** en la capa de acceso.
- Capa de acceso del panel (`dashboard/app/api.js`, desde sprint1-seguridad): `api(path,
  {method, body, signal, raw, headers})` pega a `/backend/api` + `path` (con o sin barra
  inicial), pone `Content-Type: application/json` si el body es un objeto, parsea el JSON
  (`null` sin cuerpo) y, si `!r.ok`, tira un `Error` con `.status` y `.message` = `data.error`
  o el texto en español por status (400 «Datos inválidos», 401 «Sesión vencida», 403 «No tenés
  permiso para esta acción», 404 «No encontrado», 409 «Ya existe», 429 «Demasiados intentos»,
  5xx «Error del servidor»); un fallo de red da `status: 0` y «Sin conexión con el servidor».
  Con `raw: true` devuelve la `Response` (audio, descargas). Ayudantes: `apiGet/apiPost/apiPut/
  apiDel`, `usePoll(path, ms, opts)` y `useApi(path, deps)` → `{data, error, cargando,
  recargar}`; los hooks cancelan con `AbortController` al desmontar y `usePoll` **pausa
  mientras `document.hidden`** y recarga al volver. Formateo compartido en
  `dashboard/app/fmt.js` (`fmtDur`, `fmtReloj`, `fmtFecha`, `fmtHora`, `fmtFechaHora`,
  `fmtBytes`, `fmtUptime`, `codecLabel`, `banderaCC`, `estadoColor`).
- **Política de encuestado del panel** (desde sprint1-seguridad; vale para pantallas nuevas):
  1) lo que ya viaja en el `snapshot` del socket (§4: `health`, `extensions`, `channels`,
  `queues`) **no se pide por HTTP** — Resumen, Extensiones, Monitor, Wallboard y Topología lo
  leen de `useLive()`; 2) lo que es configuración (troncales, rutas, módulos, IVR, teléfonos,
  agentes IA, tablas de `CrudPanel`, `/asterisk/core`, `/asterisk/net`, `/turn`, `/db`) se
  encuesta cada **30 s o más**, porque lo cambia una persona desde este mismo panel y el
  cambio propio ya recarga a mano; 3) sólo se deja cadencia de segundos donde el dato se
  mueve solo y se lo está mirando: traza SIP (`SipLadder`, 3 s), plazas de aparcado
  (`/funciones`, 5 s) y el tablero del supervisor (`/presence`, `/queues/*/live`, 6 s);
  4) ningún poll pide nada con `document.hidden` (lo garantiza `usePoll`; los pocos
  `setInterval` que quedan lo comprueban a mano). Con esto una pestaña abierta en el Resumen
  hace 5 pedidos por minuto (`/system/overview` cada 30 s + `/trunks`, `/asterisk/core` y
  `/topology` cada 60 s) contra los ~44 de antes, y cero en segundo plano.
- `GET /api/metrics` ya **no lo usa ninguna pantalla**: su contenido es un subconjunto de
  `GET /api/system/overview` (el nodo `core` es el mismo `os.*` del host y `storage.db.bytes`
  es el `db_size`), así que el Resumen pide uno solo de los dos. La ruta sigue existiendo para
  quien la consuma desde afuera.
- Estado degradado en el panel (`app/shell.jsx`): banner rojo "Base de datos sin respuesta" si el
  `snapshot` del socket trae `health.db=false` o, con el socket caído, si `GET /backend/health`
  (→ `/health` de la API) responde 503 o `db:false`; ese poll corre cada 30 s **sólo** mientras
  el socket está desconectado. El menú del shell se
  filtra por rol (`app/shell.jsx` con el `SUP_OK` de `app/auth.jsx`, ver arriba) como espejo
  de `rbac.js`.
- **Esconder por rol en el panel: una sola forma.** El `user` de `app/auth.jsx` arranca en
  `undefined` («todavía no sé quién entró») y recién pasa a la sesión o a `null` cuando vuelve
  `GET auth/me`. Ese limbo se resuelve SIEMPRE del lado prudente —mientras no se sabe, **no** es
  admin— y con el helper `useEsAdmin()` / `esAdmin(user)` de `app/auth.jsx`, nunca repitiendo la
  expresión en cada pantalla. Resolverlo al revés (`!user || user.role === 'admin'`) le hace
  parpadear los controles de administración a un supervisor y lo deja apretar un botón que sólo
  sabe dar 403. Esto es cosmética: el permiso de verdad lo decide `rbac.js`. El **menú** del
  shell entra en la misma regla: en el limbo dibuja el menú chico (el de operación), no el de
  administración. Al día de hoy usan el helper `/fax` (solapa «Configuración» y borrar de
  Recibidos), `/salas` (`SalasPanel`: nueva, editar, borrar, invitar y «Ver PIN»), `/reportes`
  («Envíos programados»), `/cdr` (solapa «Almacenamiento») y `/grabaciones` (ocupación del
  disco, configuración y borrado), más `app/shell.jsx` (menú y chip de modo noche) y
  `/seguridad`.
- Token de softphone: `POST /api/phone/token` → JWT `{scope:'phone', ext}` (30 d). Mismo rate
  limit que el login (por IP+ext). Solo puede lo que lista `FONO_PERMITIDO` en `control-plane/auth.js`, y
  siempre sobre su propia extensión (`mismaExt`): `vm*`, `directory`, `presence`, `ice`,
  `branding`, `calls/record|conference`, `push/subscribe|register|unsubscribe|test` (POST), `cdr` (forzado a su ext) y `clients/lookup`.
  El RBAC por rol no aplica a estos tokens.
- Token de enrolamiento (`GET /api/enroll/:token`): de un solo uso (`used_at`), con ventana de
  gracia `ENROLL_REUSE_SECONDS` (default 120 s) para que la PWA y el softphone del mismo aparato
  lo canjeen seguido; después responde `410 {error:'token ya usado'}`. Entrega credenciales SIP
  y `prov.apiToken` = **un token de alcance `phone`**, nunca una sesión de panel. Lo mismo vale
  para el `apiToken` de `GET /api/provision`.
- Cabeceras: `helmet` con CSP apagada y `Cross-Origin-Resource-Policy: cross-origin` (el panel,
  `/softphone/` y los audios se sirven a través del proxy).
- Cabeceras del panel (`dashboard/next.config.js`, `SECURITY_HEADERS`, salen en TODA respuesta
  de Next: páginas, `/_next/static` y `public/`): `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (geo/mic/cámara sólo
  `self`, que el softphone necesita) y desde `sprint1-seguridad` una **CSP completa**:
  `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src
  'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline'
  https://fonts.googleapis.com https://unpkg.com; img-src 'self' data: blob: https:; font-src
  'self' data: https://fonts.gstatic.com; media-src 'self' blob:; connect-src 'self'; worker-src
  'self' blob:`. Consecuencias para todo el equipo: **cualquier recurso nuevo de un tercero
  (script, hoja de estilo, fuente, o un `fetch`/WebSocket a otro origen) hay que agregarlo ahí
  o el navegador lo bloquea en silencio**. `connect-src 'self'` vale porque todo va por el mismo
  origen (API `/backend`, socket `/socket.io`, SIP `wss://<host>/ws`); si alguna vez el panel
  tiene que pegarle a la API en otro host hay que abrir `connect-src`. `script-src` lleva
  `'unsafe-inline'` y no un nonce porque Next 14 sólo firma sus inline si la CSP la pone un
  `middleware.js` (y las páginas del panel son estáticas: el nonce quedaría cacheado); el
  porqué largo está comentado en `next.config.js`.
- Rutas públicas (sin token) = exactamente `PUBLIC_API` en `control-plane/auth.js`. Hoy: `auth/login`,
  `phone/token`, `auth/setup`, `ice`, `branding`, `enroll/:token`, `prompts/:id/audio`,
  `push/vapid`, `push/(subscribe|register|unsubscribe)`, `internal/wake`, `internal/feature`,
  `internal/disa`, `internal/callback`, `internal/fax`, `c2c/public/*`, `softphone/latest`,
  `geo/report`, `manuales/img/*`.
  **`POST /api/internal/{feature,disa,callback,fax}` las llama el dialplan por CURL** (lo que el
  usuario marca en el teléfono —DND, desvíos, sígueme, modo noche—, el PIN de la DISA y cómo
  terminó un ReceiveFAX/SendFAX) y por eso no tienen sesión, pero `telefonia.js` / `marcacion.js`
  / `fax.js` las cierran con los mismos tres candados: la IP tiene que ser **loopback**, el pedido **no puede traer
  `X-Forwarded-For` ni `X-Real-IP`**, y tiene que venir con el secreto compartido de
  `/etc/pbxng/agent.token` en el campo `tok` (comparado con `timingSafeEqual`). Cualquiera de
  los tres que falle → `403 {error:'sólo desde la central'}`. **Un filtro de "red privada" no
  sirve para nada acá y no se vuelve a usar**: el panel proxya `/backend/**` (cualquier método,
  cualquier ruta) y deja la IP real del navegador como último `X-Forwarded-For`, que con
  `trust proxy = 1` es lo que la API ve como `req.ip` — o sea una IP privada de la LAN. Con el
  criterio viejo, cualquiera en la oficina, sin usuario ni clave, ponía un desvío en el interno
  ajeno (escucha de llamadas ajenas), dejaba a un compañero en no molestar o desviaba a la calle
  por la ruta saliente (fraude de tarifación).
  **`POST /api/internal/disa` y `POST /api/internal/callback` (`marcacion.js`) usan EXACTAMENTE
  el mismo candado de tres llaves** y responden **texto plano** (`ok` / `no` / `bloqueado`), no
  JSON: quien las lee es un `${CURL(…)}` comparado con `$["${DRES}"="ok"]`. Existen porque el
  PIN de la DISA **no puede estar en el dialplan** —la tabla realtime `extensions` se lee con
  `dialplan show`, se respalda en claro y la ve cualquiera con acceso a la base—, así que el
  dialplan pregunta y la API compara el bcrypt, cuenta los intentos, bloquea y registra. Si la
  API no contesta, el `CURL` devuelve vacío y la llamada se rechaza: el fallo cae del lado seguro.

## 3. API HTTP (`/api`, servida por control-plane :3000; el panel la ve en `/backend/api`)

285 rutas (contadas como `app.<método>('/api…')` en `control-plane/*.js`, 1.6.0). Familias y su dueño funcional en el panel:

| Familia | Para qué | Pantalla |
|---|---|---|
| `auth`, `users`, `me` | sesión, usuarios, cambio de clave | `/login`, `/usuarios` |
| `extensions`, `endpoints`, `directory`, `presence` | internos y presencia | `/internos` |
| `trunks`, `routes`, `sbc-link`, `registrations` | troncales, rutas entrantes/salientes, conexión a SBC-NG, diagnóstico de troncal (`control-plane/trunks.js`, mismo patrón `init(deps)` que `auth.js`; `sbcLink()` es lo único que el resto de la API mira para saber si hay SBC adelante) | `/troncales`, `/rutas`, `/sbc` |
| `queues`, `ringgroups`, `paging`, `ivr`, `ai-agents`, `featurecodes`, `parking`, `moh`, `mailboxes`, `vm` | aplicaciones: colas (tabla realtime `queues` + `pbxng_queues`), grupos de timbrado, paging, IVR clásico y con IA (`Stasis pbxng,ai,<id>` → `ai-pipeline.js`), códigos de función, aparcado y música en espera (archivos vía `astconf.js`), buzones y buzón → correo (`control-plane/apps.js`, mismo patrón `init(deps)` que `auth.js`/`trunks.js`/`recordings.js`; devuelve `aiAgentDialplan`, `buildIvrDialplan`, `vmList`; `wallboard` y `pickup-groups` siguen en `app.js`) | `/aplicaciones/*`, `/funciones`, `/ivr`, `/voz` |
| `salas` | salas de reunión: alta/baja/edición, vista en vivo (quién está adentro, silenciar, expulsar) e invitación por correo (`control-plane/salas.js`, 1.10.0; reemplaza a `conferences` de `app.js`). Detalle abajo | `/salas` (y `/aplicaciones/conf`, que muestra la misma pantalla). `SUP_OK` de `dashboard/app/shell.jsx` incluye `/salas`: el supervisor ve el ítem y modera desde el panel; alta, baja, edición e invitación se esconden si no es admin |
| `extensions/:ext/features`, `horarios`, `feriados`, `nightmode`, `featurecodes` | telefonía clásica de oficina (`control-plane/telefonia.js`, 1.9.0): desvíos / DND / sígueme por interno, horarios de atención, feriados, modo noche y el catálogo editable de códigos de función. Detalle abajo | `/internos` (solapa «Desvíos y no molestar»), `/agente` («Mis desvíos»), `/horarios`, `/funciones` |
| `disa`, `callback`, `dialbyname`, `abreviados`, `extensions/:ext/abreviados` | marcación (`control-plane/marcacion.js`, 1.10.0): DISA con PIN y rutas restringidas, callback, directorio por nombre (`Directory()`, prompts `dir-*` que ya vienen en el paquete de audios) y números cortos globales y por interno. DISA y callback **nacen apagados**. Detalle abajo | pendiente (pedido a `panel`) |
| `internal/feature` | el dialplan avisa por CURL qué marcó el usuario en el teléfono (§2: loopback + sin cabecera de proxy + `agent.token`) | — |
| `internal/disa`, `internal/callback` | el dialplan de la DISA pregunta por CURL si el PIN es correcto y si puede marcar ese número; el del callback avisa a quién devolverle la llamada (mismo candado que `internal/feature`) | — |
| `fax/estado`, `fax/config`, `fax/boxes`, `fax/in`, `fax/out` | fax (`control-plane/fax.js`, 1.10.0): cajas de fax (a qué correo va cada número), bandeja de recibidos y de enviados con descarga del PDF, envío (PDF crudo en el cuerpo) con cola y reintentos, T.38 por troncal y detección de tono. `GET fax/estado` dice qué falta en el servidor (ghostscript, tiff2pdf, `res_fax_spandsp`, permiso de escritura del spool). Detalle abajo | `/fax` |
| `internal/fax` | el dialplan avisa cómo terminó un `ReceiveFAX`/`SendFAX` (`FAXOPT(status\|statusstr\|pages\|error\|remotestationid)` sólo existe en el canal); mismo candado que `internal/feature` | — |
| `calls` | control de llamadas (dial, hangup, hold, transfer, park, spy, live) | agente, supervisor, monitor |
| `recordings`, `cdr`, `calls/record`, `extensions/record-all` | grabaciones e historial: marca de grabación (AstDB `rec`), grabar en vivo, indexador de `/recordings`, audio/transcripción/picos, almacenamiento remoto (`recstore.js`) e informe (`report.js`) (`control-plane/recordings.js`, mismo patrón `init(deps)` que `auth.js`/`trunks.js`; devuelve `setRecFlag`, `setRecAll`, `syncRecFlags`, `wavToPcm`, `analyzeText`, `indexRecordings`) | `/grabaciones`, `/cdr` |
| `ccreport`, `ccreport/csv`, `ccreport/report`, `ccreport/schedules` | reportes de call center (`control-plane/ccreport.js`, 1.10.0). Detalle abajo | `/reportes` |
| `clients`, `survey` | CRM propio | `/clientes` |
| `asterisk`, `net`, `sip`, `capture`, `system`, `topology`, `metrics` | núcleo, red, diagnóstico | `/asterisk`, `/red`, `/topologia`, `/` |
| `sipconf` | ajustes SIP de la central (NAT, RTP, timers, TLS, códecs por defecto; sólo admin) | Configuración → SIP |
| `turn`, `ice`, `acme`, `npm` | WebRTC/TURN, certificados, proxy | Configuración |
| `modules`, `settings`, `branding`, `integrations`, `alerts`, `email` | configuración | `/configuracion` |
| `backup` | respaldo y restauración; `backup/schedule` (GET → `{enabled, hour, keep, last_run, last_ok, last_error, last_nombre, running, tz}`, POST `{enabled, hour, keep}` con `hour` entero 0–23, `keep` entero ≥ 1, `enabled` booleano, cada campo opcional, `400 {error}` si no valida; devuelve el estado nuevo. Se guarda en `pbxng_settings` (`backup_enabled` default `1`, `backup_hour` default 3, `backup_keep` default `BACKUP_KEEP`/14, `backup_last_run|ok|error|nombre`). Un planificador interno de la API revisa cada minuto: si está activo, es esa hora (reloj local del contenedor, `tz`) y hoy no hay marca `backup_last_run`, corre `backup.programado()` (crear sin grabaciones + retención). El cron del host (`backup-cli.js`) escribe las mismas claves, así que ninguno repite el del otro. El panel tolera 404 en versiones sin el endpoint) | `/respaldos` |
| `push`, `c2c`, `enroll`, `phones`, `provision` | PWA, click-to-call, aprovisionamiento. `GET /api/push/vapid` → `{key}` con la pública VAPID vigente (`''` mientras la API no tenga un par que firme: el panel muestra «Servidor sin clave VAPID»). El par sale, en este orden, de `VAPID_PUBLIC`/`VAPID_PRIVATE` del `.env` si web-push lo acepta, de `pbxng_settings` (`vapid_public`/`vapid_private`) o, si ninguno sirve, la API genera uno al arrancar, lo guarda en `pbxng_settings` y lo avisa con un `warn` (las suscripciones hechas con otra pública fallan al enviar y se limpian solas con 404/410) | varios |
| `voz`, `prompts`, `sysprompts` | TTS/STT y audios | `/voz`, `/ia-voz` |
| `softphone` | instalador y feed OTA del softphone | login |
| `manuales` | manuales in-panel | `/manuales` |
| `security`, `ipgeo` | centro de seguridad (`control-plane/guard.js`): bloqueos por IP en nftables, registro en vivo, lista blanca, filtro por país, ajustes anti fuerza bruta | `/seguridad` |

Telefonía clásica de oficina (`control-plane/telefonia.js`, 1.9.0; migración
`0011_telefonia_clasica.sql`). **La fuente de verdad es PostgreSQL y el dialplan lee la AstDB**:
cada escritura de estas rutas toca las dos cosas (la AstDB por AMI `DBPut`/`DBDel`), y
`syncFeatures()` vuelca Postgres → AstDB al arrancar la API y en **cada (re)conexión del AMI**
(§5). Los errores de AMI se tragan a propósito: sin Asterisk el panel tiene que poder guardar.

- `GET|PUT /api/extensions/:ext/features` (**TODOS**, la ruta acota con `exigirExt`: agente y
  token de softphone sólo su propio interno) → `{dnd:bool, cfu, cfb, cfnr, fm, fm_seg}`. Los
  cuatro destinos son **sólo dígitos, hasta 32** (`400 {error}` si no; ni `*` ni `#` ni `+`) y
  **vacío = apagado**. `fm` va **con el prefijo de la ruta saliente** (el dialplan marca
  `Local/<fm>@internal` y no adivina prefijos); `fm_seg` se acota a 5–120, default 15. El PUT es
  parcial (sólo pisa los campos presentes), pero el panel manda siempre los seis.
- `GET|POST|PUT|DELETE /api/horarios` (admin) → `[{id, nombre, tramos, activo}]`; `tramos` es
  `[{dias, desde, hasta}]` en el formato de `GotoIfTime`: `dias` = `*` o `mon-fri` (rangos con
  vuelta de semana incluidos), `desde`/`hasta` = `HH:MM` 24 h, máximo 20 tramos. Cruzar
  medianoche se hace con **dos tramos**. Cambiar o borrar un horario **regenera el dialplan de
  las rutas entrantes que lo usan**; borrarlo deja esas rutas en `horario_id = NULL` (24 h).
- `GET|POST|PUT|DELETE /api/feriados` (admin) → `[{id, md, fecha, nombre, anual}]`. Anual: `md` =
  `MM-DD`. Puntual: `anual:false` + `fecha` = `YYYY-MM-DD`. Se reflejan en la AstDB como
  `hol/<clave> = 1`.
- `GET|PUT /api/nightmode` (**GET = SUP**, PUT = admin) → `{modo, estado, motivo, horario_id}`.
  `modo` ∈ `auto|abierto|cerrado` (se guarda en `pbxng_settings.nightmode` y en
  `DB(nightmode/modo)`); `estado` ∈ `abierto|cerrado` **calculado ahora por la API** con el reloj
  de su contenedor (§6, `TZ`), en este orden: modo forzado → feriado de hoy (siempre cerrado) →
  tramos del horario. **Sin horario configurado el estado es `abierto`**: instalar la
  actualización no puede empezar a mandar todo al buzón. El PUT acepta `{modo, horario_id}`
  (`horario_id` elige qué horario gobierna el indicador, en `pbxng_settings.nightmode_horario_id`;
  el panel manda `'0'` como «sin horario» y la API lo resuelve a `NULL`).
- `GET|PUT /api/featurecodes` (admin) → `[{accion, code, nombre, name, desc, enabled, installed}]`
  (`name`/`desc` se mantienen por compatibilidad con el panel 1.8.0). La **PK del catálogo es la
  acción**, no el código: el código lo edita el administrador. El PUT acepta un objeto suelto, una
  lista o `{codes:[{accion, code?, enabled?, nombre?}]}`; cambiar un código **borra el dialplan
  del anterior** antes de publicar el nuevo, y sólo reescribe el dialplan si los códigos ya
  estaban instalados. Se mantienen `POST /api/featurecodes/install|uninstall`. **`install` es todo
  o nada**: si algún código habilitado choca con lo que ya está publicado en `internal` no se
  instala NINGUNO y el **409** los nombra a **todos** (código, función y quién ocupa el número) en
  un solo mensaje, para que el administrador los arregle de una vez. No se instala «lo que se
  puede» porque la pantalla de códigos no muestra cuáles están publicados: una instalación parcial
  sería invisible para quien la está mirando. Acciones:
  `dnd_on dnd_off cfu_set cfu_off cfb_set cfb_off cfnr_set cfnr_off fm_set fm_off night eco
  midigito vm_propio vm_otro`. **Ojo con las dos formas del código**: lo que se ve y se edita va
  sin `_` (`*21*.`), pero a la tabla realtime `extensions` se escribe **con** `_` cuando es un
  patrón, porque `pbx_realtime` sólo corre `ast_extension_match` sobre las filas cuyo `exten`
  empieza con `_` (misma convención que `outExten()` de `trunks.js`).
- `POST /api/routes/inbound/:id` → ver `PUT /api/routes/inbound/:id` y las columnas nuevas
  `horario_id`, `dest_cerrado_type`, `dest_cerrado_value` de `pbxng_inbound_routes` (§5).
- `POST /api/internal/feature` (pública, §2): `{tok, ext, accion, valor}` como **formulario**
  (`func_curl` no manda JSON). `accion` ∈ `dnd_on | dnd_off | cfu | cfb | cfnr | fm | off |
  night`; con `off`, `valor` dice qué apagar (`cfu|cfb|cfnr|fm|dnd`, o vacío = todo).
- `POST /api/internal/disa` (pública, §2): `{tok, id, accion, pin|num, cid}` como **formulario**.
  `accion` ∈ `pin | marcar`. Responde texto plano `ok` | `no` | `bloqueado`.
- `POST /api/internal/callback` (pública, §2): `{tok, id, cid[, pin]}` como **formulario**;
  responde `ok` | `no` y, si es `ok`, la API devuelve la llamada por AMI `Originate` a los
  `demora_seg` configurados (`Local/<cid>@internal` → el destino configurado).
- `GET|PUT /api/extensions/:ext/abreviados`: libreta de abreviados personales del interno
  (códigos de dos dígitos). El PUT manda la lista **completa**: lo que no está, se borra.
  La ruta exige la ext propia con `exigirExt`, igual que `…/features`.

Fax (`control-plane/fax.js`, 1.10.0; migración `0016_fax.sql`). **Asterisk habla con el otro
módem y esta API convierte, guarda, avisa por correo y encola.** Archivos en disco (volumen
compartido con Asterisk, `FAX_DIR` / `FAX_DIR_AST`, §6), índice en Postgres: un TIFF de veinte
páginas en un `bytea` hace que el respaldo lógico pase de megabytes a gigabytes.

Las imágenes traen lo necesario: `control-plane/Dockerfile` instala **ghostscript** y
**libtiff-tools** (`gs` / `tiff2pdf`, ~72 MiB) y `docker/images/asterisk/Dockerfile` compila
**`res_fax` + `res_fax_spandsp`** (`libspandsp-dev` en el build, `libspandsp2` + `libtiff6` en
runtime) y **corta el build** si el módulo no quedó. Los dos entrypoints avisan en el arranque
si algo falta, en vez de dejar que el fax falle en medio de una llamada.

- `GET /api/fax/estado` (SUP) → `{herramientas:{ghostscript, ghostscript_version, tiff2pdf},
  asterisk:{res_fax, spandsp}, spool:{dir, dir_asterisk, escribible}, limites:{max_mb,
  max_mb_duro, max_paginas}, en_cola, listo}`. `asterisk.*` en `null` = no se pudo preguntar
  (AMI caído). Es lo primero que pide el panel: si falta algo lo dice con nombre y apellido en
  vez de dejar que el fax falle en medio de una llamada.
- `GET|PUT /api/fax/config` (GET SUP, PUT admin) → `{station_id, header, ecm, t38, t38_ec,
  trunks, detect, detect_box, detect_seg, max_mb, max_paginas, reintentos, reintento_min,
  dial_seg}`. `t38_ec` ∈ `none|fec|redundancy`. `trunks` = troncales a las que se les aplica
  T.38 (y la detección de tono); el PUT reescribe el dialplan de fax y reconcilia
  `ps_endpoints` (§5). Cada nombre de `trunks` tiene que ser una troncal **existente**
  (`pbxng_trunks`, las mismas que ofrece el selector del panel): un nombre desconocido o con
  caracteres fuera de `[A-Za-z0-9_-]{1,64}` da `400` diciendo cuál, ya no se descarta en
  silencio; los repetidos se colapsan. `max_mb` **no puede superar** el tope duro `FAX_MAX_MB` del entorno.
- `GET|POST|PUT|DELETE /api/fax/boxes` (GET SUP, resto admin) → cajas de fax
  `{id, nombre, email, station_id, header, adjuntar_tiff, enabled, recibidos, rutas}`. `email`
  admite varios separados por coma. Borrar una caja con rutas entrantes apuntándole da `409`.
- `GET /api/fax/in` (SUP) → recibidos; `GET /api/fax/in/:id/pdf` (SUP, `?tiff=1` para el TIFF)
  baja el documento **con el token** (el panel lo pide con `raw: true`); `DELETE /api/fax/in/:id`
  (admin) borra la fila **y los archivos**.
- `GET /api/fax/out` (SUP) → la cola de salida con `{estado, intentos, max_intentos, detalle}`;
  `estado` ∈ `pendiente | enviando | cancelando | ok | error | cancelado`.
- `POST /api/fax/out?numero=&nombre=&asunto=` (SUP) con el **PDF como cuerpo crudo**
  (`Content-Type: application/pdf`, sin multipart, igual que `backup/subir`). Validación antes
  de tocar nada: tope de tamaño en el parser, firma `%PDF-` y `%%EOF`, y tope de páginas después
  de convertir. `numero` sólo dígitos (se aceptan espacios, puntos, guiones y paréntesis como
  separadores y se sacan; **cualquier otra cosa se rechaza**, no se limpia: un `*21*099…`
  limpiado a dígitos sería marcar un número que nadie pidió). Errores: `400` número,
  `413` tamaño/páginas, `415` no es un PDF, `503` falta ghostscript.
- `POST /api/fax/out/:id/retry` (SUP) revive un trabajo `error`/`cancelado` **sin volver a subir
  el PDF**; `DELETE /api/fax/out/:id` (SUP) borra, o **cancela** si está `enviando` (no se le
  saca el archivo a un `SendFAX` en curso). Cancelar deja el trabajo en el estado intermedio
  **`cancelando`**, no en `cancelado`: el canal sigue vivo unos segundos y el chequeo de **un
  fax a la vez** de la cola cuenta `cancelando` como ocupado (si no, arrancaría el siguiente con
  el anterior todavía modulando por la misma troncal). Lo pasa a `cancelado` el aviso del
  dialplan, o el barrido de colgados del reloj si ese aviso nunca llega; un `cancelando` no se
  puede reintentar ni borrar hasta que cierre.
- `POST /api/internal/fax` (pública, §2): `{tok, dir:'in'|'out', …}` como **formulario**.
  Responde `ok` en texto plano **antes** de convertir y mandar el correo (del otro lado hay un
  canal de Asterisk esperando). El `uniqueid` es UNIQUE y hay además un barrido del spool que
  importa el TIFF que quedó sin aviso: un fax recibido no se pierde porque el que llamaba colgó
  dos segundos antes de tiempo. Ese barrido saca la caja del **nombre del archivo**
  (`<caja>-<uniqueid>.tif`) y nunca de la configuración: si no la puede deducir (nombre viejo,
  caja borrada) el fax entra con `box_id = NULL`, **sin correo** y con el motivo en `email_err`
  para que se vea en la bandeja. Adivinar el destinatario filtraba el documento a otra área.

Reportes de call center (`control-plane/ccreport.js`, 1.10.0; migración `0012_ccreport.sql`).
**La fuente es `pbxng_queue_events`, NO el `cdr`**: el CDR no distingue «esperó 40 s en cola y
colgó» de «sonó 40 s en un interno», y sin esa distinción no hay nivel de servicio ni abandono.
Esa tabla la llena este módulo escuchando el AMI (`QueueCallerJoin` → `entra`, `AgentConnect` →
`atendida`, `AgentComplete` → `fin`, `QueueCallerAbandon` → `abandona`, `AgentRingNoAnswer` →
`sin_respuesta`). `QueueCallerLeave` **no** se guarda: Asterisk también lo emite cuando la
llamada sale porque la atendieron, así que contarlo sería contar dos veces; las salidas por
desborde o timeout se deducen (`entradas − atendidas − abandonadas`) y se muestran como «otras
salidas». Consecuencia que la API informa y el panel muestra: **no hay datos anteriores a la
instalación de esta versión**, y el tiempo de pausa/sesión del agente no se mide todavía.

**El consumidor está ACOTADO y ese techo es parte del contrato.** Es la única pieza del sprint
que escribe en la base **al ritmo de las llamadas**, y el pool de Postgres (`PG_POOL_MAX`, 10)
es el MISMO que usan los `CURL()` del dialplan: el PIN de la DISA (`internal/disa`), el aviso de
código de función (`internal/feature`) y el fin de un fax (`internal/fax`). Un INSERT por evento
y sin esperar a nadie hace que, con la base momentáneamente lenta (un vacuum, el respaldo
nocturno, la poda de `pbxng_sec_events`), las adquisiciones de conexión se encolen sin límite
dentro de `pg.Pool` y las que quedan atrás sean las del camino de llamada: el `CURL()` vuelve
vacío y la DISA rechaza la llamada. Por eso los eventos se juntan en memoria y se vuelcan en un
**INSERT multi-fila**, de a **un volcado por vez**: este módulo ocupa como máximo **1 conexión
de las 10** y hace como mucho **1 adquisición cada `CC_LOTE_MS`** (2 s por defecto), con o sin
pico de cola. El buffer tiene tope (`CC_LOTE_TOPE`, 2000 filas): pasado el tope se **descartan**
eventos con aviso en el log —perder filas del informe se ve y se aguanta; frenar una llamada
no—. El `ts` se toma cuando **llega el evento**, no con el `now()` del INSERT, así el informe
mide la hora de la llamada. Lo que se paga y se declara: hasta `CC_LOTE_MS` de retraso en que el
evento llegue a la tabla y hasta un lote perdido si el proceso se cae entre dos volcados.
**Ninguna pieza nueva puede escribir en la base al ritmo de las llamadas sin una cota así.**

- `GET /api/ccreport?from=&to=&cola=&sla=&limite=` (SUP) → `{desde, hasta, dias, sla_seg, cola,
  colas:[{cola, label, ofrecidas, atendidas, abandonadas, otras_salidas, sin_respuesta, sla_pct,
  abandono_pct, espera_media, espera_max, espera_abandono, habla_media, habla_total,
  fuera_horario}], agentes:[{agente, nombre, atendidas, sin_respuesta, espera_media, habla_media,
  habla_max, habla_total}], serie:[{dia, atendidas, abandonadas}], totales:{…mismos campos…},
  horario, fuente:{tabla, primer_evento, rango_incompleto, sin_datos, sin_horario},
  agentes_truncado, agentes_tope}`. `from`/`to` son `YYYY-MM-DD` (default: los últimos 7 días) y
  **el rango no puede pasar de 92 días** (`400 {error}` con el número de días pedido): el informe
  no puede colgar la pantalla ni el pool. `sla` = umbral en segundos del nivel de servicio (1–3600,
  default 20). **Todas** las consultas se agregan en SQL —incluida la de `fuera_horario`, que
  traduce los tramos del horario y los feriados a una condición del `WHERE`—, así que ninguna
  devuelve más de una fila por cola, por agente o por día del rango y el costo depende de la
  cantidad de colas y agentes, no del volumen de llamadas. `sla_pct` y `abandono_pct` son `null` cuando no hubo llamadas —**no
  0**—, y `fuera_horario` es `null` cuando no hay horario de atención configurado: el informe no
  asume un «9 a 18».
- `GET /api/ccreport/csv?…` (SUP) → `text/csv` con `Content-Disposition: attachment`. Dos bloques
  (colas y agentes) separados por una línea en blanco, separador `;` y BOM (Excel en es-UY). Sin
  tope de agentes, al revés que la pantalla.
- `GET /api/ccreport/report?…` (SUP) → HTML A4 para **Imprimir → Guardar como PDF**, con el CSS,
  los gráficos SVG y la marca de `report.js` (el mismo informe ejecutivo del CDR, no una copia).
- `GET|POST|PUT|DELETE /api/ccreport/schedules[/:id]` (admin) → `[{id, nombre, cola, periodo, hora,
  dia, sla_seg, destinatarios, enabled, last_run_at}]`. `periodo` ∈ `diario|semanal|mensual`
  (ventana: el día anterior / los últimos 7 días / el mes anterior), `hora` 0–23 del reloj del
  contenedor (§6, `TZ`), `dia` = 1–7 (lunes a domingo) en semanal y **1–28** en mensual (un envío
  el 31 no saldría en febrero), `destinatarios` csv validado dirección por dirección (termina en
  la cabecera `To` de un correo real). `POST /api/ccreport/schedules/:id/test` manda el informe en
  el momento (`502 {error}` si el SMTP no está configurado). El envío usa `alerts.raise()` con el
  evento `ccreport.scheduled` (regla sembrada **prendida**: el interruptor real es el `enabled` de
  cada programación) y el layout `digestEmail` de `emails.js`; queda registrado en `pbxng_alerts`
  como cualquier alerta. `last_run_at` avanza cuando el informe **se calculó y se intentó
  entregar**, salga o no el correo: `alerts.raise()` devuelve `false` también cuando no había
  que mandarlo (regla apagada, sin SMTP, sin destinatarios), y marcar sólo el éxito dejaba al
  reloj recalculando la consulta cada minuto durante toda la hora de envío. Que el correo no
  haya salido se ve en el log y en `pbxng_alerts`; `…/schedules/:id/test` lo prueba en el momento.
  En el correo de resumen (`digest.daily` y `ccreport.scheduled`) **todas** las líneas que no son
  «Top …» salen como tarjeta: no hay tope de seis. Los eventos de cola se podan por `pbxng_settings.cc_retencion_dias`
  (365 por defecto; 0 = nunca).

Salas de reunión (`control-plane/salas.js`; migración `0014_salas_reunion.sql`, que amplía
`pbxng_conferences`). Una sala es un número, **dos PIN** (participante y moderador, distintos y
generados al azar si no se mandan), tope de participantes, música en espera hasta que entra el
moderador, anuncio de entrada/salida, grabación opcional y —si la reunión está agendada— una
ventana fuera de la cual la sala no abre.

- `GET /api/salas` (**SUP**) → `[{id, name, label, access_exten, tiene_pin, tiene_pin_mod,
  max_part, moh_hasta_moderador, anunciar, grabar, agenda_inicio, agenda_min, aviso_cerrada,
  invitados, invitado_at, tenant_id, abierta, participantes}]`. `abierta` la calcula la API con
  la agenda; `participantes` sale de `ConfbridgeListRooms` (0 si el AMI no contesta: una sala
  vacía no existe para ConfBridge y eso **no** es un error). El listado **no trae los PIN**
  (sólo las dos banderas, como la DISA): con el PIN de moderador se entra, se silencia y se
  expulsa, así que verlo es ser moderador de todas las salas —por eso `invitar` ya era admin—.
  Son **dos** banderas y no una porque una sala heredada de 1.9.x puede tener PIN de
  participante y no de moderador, y llamarla «Sin PIN» sería mentirle al administrador.
- `GET /api/salas/:name` (**admin**) → la sala completa **con** `pin` y `pin_mod` (`404` si no
  existe). Es el único lugar de lectura donde salen los PIN; es lo que usa el panel para editar.
- `POST /api/salas` (admin) / `PUT /api/salas/:name` (admin, edición parcial) → la sala completa.
  `DELETE /api/salas/:name` (admin) → `{deleted}` (`404` si no existe); borra también su
  extensión del dialplan y sus claves de la AstDB.
- `GET /api/salas/:name/live` (**SUP**) → `{sala, numero, abierta, grabando, ami,
  participantes:[{canal, numero, nombre, moderador, mudo, desde}]}` (AMI `ConfbridgeList`).
  Con el AMI caído responde `200` con `ami:false` y la lista vacía, no un error.
- `POST /api/salas/:name/mute {canal, mudo=true}` y `POST /api/salas/:name/kick {canal}`
  (**SUP**) → `ConfbridgeMute|ConfbridgeUnmute|ConfbridgeKick`. El canal tiene que estar **en esa
  sala** (se comprueba contra `ConfbridgeList`): `404` si no está, `400` si no pasa la lista
  blanca —un `Channel` con `\r\n` es una acción AMI extra— y `503` si no hay AMI (sin saber
  quién está adentro no se expulsa a ciegas).
- `POST /api/salas/:name/invitar {destinatarios, moderador?=false, mensaje?}` (admin) →
  `{enviados, fallados}`; un correo **por persona** (nadie ve la lista de los demás) con el
  layout `meetingEmail` de `emails.js`. El PIN de moderador sólo viaja si `moderador:true`.
  `400` sin SMTP activo o con una dirección inválida; `502` si no salió ninguno. Lo enviado
  queda en `pbxng_conferences.invitados`.
- **Salas que ya existían (1.9.x) — se dejan como están.** La migración `0014` **no** les pone
  PIN: no toca ninguna fila de `pbxng_conferences`. Ponerle un PIN al azar a una sala que venía
  andando sin PIN dejaba a la base diciendo una cosa y al dialplan otra (la migración no
  reescribe el dialplan), y al administrador viendo en el panel un PIN que no rige; además, que
  una sala no pida PIN es una decisión que alguien tomó y una actualización no es el lugar para
  cambiarla. Lo que sí hace la API: **republica el dialplan de todas las salas al arrancar**
  (`republicarDialplan()` de `salas.js`, en la misma vuelta que el volcado inicial de
  `syncSalas()`, y sólo cuando el plan publicado difiere del que genera Postgres), así las
  funciones nuevas —tope, grabación, música hasta el moderador, anuncios, agenda— les aplican
  **sin entrar a editarlas una por una**. El plan generado refleja la fila tal cual: una sala
  **sin PIN no pide PIN** (si lo pidiera quedaría inaccesible, porque el PIN vacío se rechaza) y
  **sin PIN de moderador no lleva `wait_marked`** —nadie podría entrar como `marked` y la
  reunión entera se quedaría escuchando música para siempre— ni publica el bloque de moderador.
  El panel las nombra en un aviso naranja arriba de la tabla y las marca «Sin PIN» / «Sin
  moderador» en la columna PIN. Ponerles PIN es editarlas desde el panel, que es donde se ve
  lo que se está cambiando y que reescribe el dialplan en el mismo movimiento.
- **Validación** (todo esto termina dentro del dialplan): `name` `^[A-Za-z0-9_-]{1,32}$`,
  `access_exten` 2–10 dígitos y único entre salas (`409`), PIN 4–10 dígitos, distintos entre sí
  y distintos del número de la sala, `aviso_cerrada` `^[A-Za-z0-9_/-]{1,64}$`.
- **Dialplan** (contexto `ivr`, una extensión por sala; prioridades fijas: 4 = fuera de la
  ventana, 6 = entrada, 20 = participante, 40 = moderador): el PIN **vacío** se rechaza antes de
  comparar (`GotoIf $["${SALAPIN}"=""]` → PIN inválido); si no, un `Read` sin dígitos contra una
  clave ausente de la AstDB daba `$[""=""]` y el que se quedaba callado entraba de moderador.
  Los perfiles de ConfBridge se arman
  al vuelo con la función `CONFBRIDGE()` —`bridge,max_members`, `bridge,record_conference`,
  `bridge,record_file`, `user,announce_join_leave`, `user,music_on_hold_when_empty`,
  `user,wait_marked`, `user,admin`, `user,marked`—, así que **no** se toca `confbridge.conf` ni
  hace falta un `module reload app_confbridge`. La grabación se guarda como
  `pbxng-sala<numero>-<epoch>.wav`, que es el patrón que ya indexa `recordings.js`.
- **AstDB** (DB() siempre familia/clave): `sala/<nombre>` = `1` abierta / `0` fuera de la ventana
  agendada (lo escribe la API: al guardar, en `syncSalas()` y en un reloj interno cada 30 s,
  `SALAS_AGENDA_MS`), `salapin/<nombre>` y `salamod/<nombre>` = los dos PIN (un PIN vacío **no**
  se escribe: se hace `DBDel` y la sala queda cerrada, que es el lado seguro del error). Por eso cambiar un
  PIN o que empiece la reunión **no** reescribe el dialplan ni corta a nadie. `syncSalas()` entra
  en `resincronizar`: vuelca Postgres → AstDB al arrancar y en cada reconexión del AMI.
- Panel: pantalla **/salas** (alta/baja/edición, invitación y vista en vivo con silenciar y
  expulsar). `/aplicaciones/conf` muestra la misma pantalla sin encabezado. La tabla **no**
  muestra los PIN (el listado no los trae): muestra «Configurado / Sin moderador / Sin PIN» con
  `tiene_pin` y `tiene_pin_mod` —y nombra en un aviso las salas heredadas que no piden nada— y,
  si el rol es admin, un botón **Ver PIN** y el formulario de edición los piden por
  `GET /api/salas/:name`. Con rol supervisor la pantalla queda en modo moderación: sólo la
  vista en vivo con silenciar y expulsar.

Marcación: DISA, callback, dial-by-name y abreviados (`control-plane/marcacion.js`; migración
`0015_marcacion.sql`). **DISA y callback nacen apagados** (`enabled=false`): son la puerta
clásica del fraude de tarifación y una actualización no puede encender sola algo que gasta plata.

- **El PIN no está nunca en el dialplan.** `Authenticate(<pin>)` habría sido una línea, pero deja
  el PIN en la tabla realtime `extensions` (se lee con `dialplan show`, se respalda en claro) y
  además no sabe contar intentos. El dialplan pregunta por `POST /api/internal/disa` (§2) y esta
  API compara un **bcrypt**, cuenta los fallos **por CallerID de origen** (así nadie deja la DISA
  bloqueada para todos), bloquea `bloqueo_min` minutos y registra todo en `pbxng_marcacion_log`.
- **El PIN no puede ser el número de un interno** (se comprueba contra `ps_endpoints`), ni todos
  los dígitos iguales, ni una secuencia; 4–12 dígitos.
- **Qué puede marcar la DISA** lo decide la API, no el dialplan: `pbxng_disa.rutas` es una lista
  de ids de `pbxng_outbound_routes` y `matchPatron()` hace el match del número contra el patrón de
  cada una con la semántica de `ast_extension_match` (X/Z/N, `[..]`, `.`, `!`, el `-` se ignora).
  Lista vacía + `internos=false` = no se puede activar. **La pregunta NO es «¿alguna de las
  habilitadas matchea?» sino «¿la que GANA el best-match de Asterisk está habilitada?»**
  (`rutaGanadora()`, con el orden de `ext_cmp1()` de `pbx.c`: en la primera posición distinta gana
  la que acepta menos dígitos, y `.`/`!` son lo menos específico): como se marca
  `Local/<num>@internal`, Asterisk vuelve a elegir entre **todas** las rutas del contexto, así que
  una habilitada más laxa autorizaba justo lo que se quería prohibir (con la `_0X.` que siembra el
  panel, marcar `00`+internacional pasaba la validación y salía por `_00.`, que no estaba
  habilitada). Si dos patrones empatan en especificidad no se puede saber cuál cursaría: se niega. Se hace en JS y no con un `REGEX()` dentro
  de un `$[…]` porque ese regex generado es imposible de probar y fácil de romper con un corchete;
  y de paso el mismo viaje deja el registro de uso. Los internos se validan contra `ps_endpoints`,
  no contra un `_[1-9]XXX` escrito a mano: el plan de numeración es de `numbering.js`.
- **Duración acotada** con `Set(TIMEOUT(absolute)=dur_seg)`, fijado **después** de autenticar (si
  no, los segundos que tarda alguien en marcar el PIN se los come su propia llamada).
- **Se marca con `Local/${FNUM}@internal/n`**, no con un `Dial` a una troncal, por lo mismo que el
  sígueme de `extensions.conf`: la única salida a la calle son las rutas salientes que `trunks.js`
  deja como extensiones de `internal`, con su prefijo, su CallerID y su failover.
- **Callback**: `modo` ∈ `lista | pin | lista_pin`. En modo `lista` el dialplan **no atiende** (la
  gracia del callback es que al que llama no le cobren). El CallerID se puede falsear, así que
  `pin` a secas equivale a «quien sepa el PIN hace que la central llame a donde quiera»: el default
  es `lista` y no se puede activar en modo lista sin al menos un número. Dos frenos más contra el
  uso como amplificador: `cooldown_seg` por número y `max_dia` por callback.
  **`pbxng_callback.rutas`** (migración `0017_callback_rutas.sql`) es la misma lista de ids de
  `pbxng_outbound_routes` que la DISA y se valida por el mismo camino (`rutaGanadora()`): en modo
  `pin` —el único sin lista blanca— es **obligatoria para encender el callback** (400 si no) y se
  vuelve a exigir en `/api/internal/callback` por si la fila se tocó a mano; en los modos con lista
  se aplica sólo si el administrador eligió rutas, para no cambiarle el comportamiento a los
  callbacks que ya existen (ahí el destino ya lo acota la lista blanca). La migración además
  **apaga** los callbacks en modo `pin` que estuvieran encendidos: no hay forma de adivinar a qué
  rutas quería restringirlos el administrador.
  **El balde de intentos del PIN en modo `pin` es por callback, no por CallerID**: ahí el CallerID
  lo elige el que llama, así que rotándolo tenía un balde nuevo por intento y el bloqueo no se
  activaba nunca. En `lista_pin` sigue siendo por origen (ya está acotado a la lista blanca) para
  que uno de la lista no deje el callback muerto para los demás. La devolución sale por
  AMI `Originate` a los `demora_seg` (primero se contesta el CURL para que el dialplan cuelgue la
  entrante; si no, el usuario tendría el teléfono ocupado con su propia llamada).
- **Dial-by-name** es `Directory(<vm_context>,internal,<opciones>)`: usa los nombres de `voicemail`
  y los prompts `dir-*`, que **ya vienen** en el paquete de audios en español uruguayo (no hay que
  grabar nada). El contexto donde marca es **siempre `internal`** y no se configura. `GET
  /api/dialbyname` devuelve además `directorio` y `sin_nombre`: quién aparecería y a quién le falta
  el nombre en el buzón (un interno sin `fullname` no sale en el directorio, es de `app_directory`).
- **Marcación abreviada**: los números cortos **globales** son una extensión propia en `internal`
  (`Goto(internal,<destino>,1)`), y el alta rechaza con `409` los que pisarían un código de función
  o una extensión que ya existe. Los **personales** no ocupan dialplan: una sola extensión patrón
  `_<prefijo>XX` (prefijo en `pbxng_settings.abrev_prefijo`, `*75` por defecto) que lee
  `DB(abrev/<ext>-<NN>)`, así que agregar un abreviado no recarga nada. La identidad sale de
  `CHANNEL(endpoint)` y no de `CALLERID(num)` por lo mismo que `*97`: el CallerID lo pone el
  teléfono. El patrón sólo se publica si hay al menos un abreviado personal cargado.
- **Validación** (todo esto termina dentro de un `Goto`/`Dial`): extensión de entrada
  `^[*#0-9][*#0-9]{0,9}$` (sin patrones), destinos **sólo dígitos** `^[0-9]{1,32}$`, CallerID
  `^[0-9+]{0,24}$`, opciones de `Directory()` `^[efblmnop]{0,8}$`, código global
  `^[*#0-9][*#0-9]{1,7}$`, código personal dos dígitos. Además el número que se marca en la DISA
  pasa por `FILTER(0-9,…)` **en el dialplan** y se vuelve a validar acá, y lo que sale de la AstDB
  en los abreviados personales también: es el mismo agujero que ya nos pasó con los desvíos (un
  destino con `*` dejaba al que LLAMABA ejecutar códigos de función con su propia identidad).
- **Módulos de Asterisk**: `modules.conf` agrega `require = app_directory.so` y `require =
  app_read.so` (y, por el failover de troncal, `require = func_hangupcause.so`), para que una
  imagen sin ellos falle al arrancar y no en medio de una llamada.
  **Verificado contra la central en producción**: los dos módulos (y `app_disa.so`) existen en la
  imagen, así que el `require` no deja la central sin arrancar. Todo `require =` va además en
  las **dos listas de verificación** de la imagen (§5, «regla de los tres lugares»).
- **La extensión de entrada no puede pisar a otro**: `internal` es un contexto compartido (códigos
  de función, rutas salientes, fax, abreviados globales), así que el alta y la edición de DISA,
  callback, directorio y número corto rechazan con **409** —diciendo quién la ocupa— una extensión
  que ya tenga dueño, **también cuando la aplicación se crea apagada**. Y el borrado del dialplan
  se limita a las filas que publicó `marcacion.js` (se reconocen por el `NoOp` de la prioridad 1):
  antes, dar de alta una DISA en `*97` borraba en silencio el dialplan del buzón de voz.
- **El candado es simétrico y lo cierran los CUATRO módulos que publican en `internal`** (1.10.0):
  `marcacion.js`, `telefonia.js`, `trunks.js` (rutas salientes y salida directa de troncal) y
  `fax.js` (`fax-tx`). La lista de quién puede ocupar una extensión (`DUENOS` de
  `dueno-internal.js`) es **única**: el módulo que empiece a publicar ahí se agrega en esa lista
  y los dos lados se enteran solos. Con dos de los cuatro escribiendo a ciegas el candado no
  servía: se borraba una ruta saliente `_*21*.`, el administrador publicaba ahí un código de
  función porque el número figuraba libre, y al recrear la ruta `setDialplan()` (DELETE + INSERT)
  se llevaba puesto el código sin avisar. Firmas de la prioridad 1 que permiten reconocer lo
  propio: `DISA `, `Callback `, `Directorio por nombre`, `Abreviado `, `ruta ` (rutas salientes,
  **también las de una sola troncal**, que antes no llevaban `NoOp`), `Salida ` (salida directa de
  troncal) y `fax saliente` (`fax-tx`); los códigos de función no tienen firma y se reconocen por
  el catálogo.
- Panel: **pendiente** (pedido a `panel`).

Failover de troncal (`control-plane/trunks.js`; migración `0013_trunk_failover.sql`). Una ruta
saliente tiene una troncal **principal** y una lista **ordenada** de respaldos; si la principal
no cursa, la llamada sale por la siguiente. Columnas nuevas de `pbxng_outbound_routes`:
`backups jsonb` (`[]` = sin failover, comportamiento idéntico a 1.9.0), `intento_seg` (default 20)
y `total_seg` (default 45).

- `GET /api/routes/outbound` (admin) → ahora incluye `backups`, `intento_seg`, `total_seg`.
- `POST /api/routes/outbound` (admin) acepta además `backups` (lista de nombres de troncal, hasta
  5, sin repetir y sin incluir la principal) e `intento_seg` / `total_seg`. Devuelve `{created,
  trunk, id, backups}`.
- `PUT /api/routes/outbound/:id` (admin) **nuevo**: edición parcial de la ruta (es lo que usa el
  panel para reordenar respaldos sin dejar el patrón unos segundos sin dialplan). `404` si la ruta
  no existe.
- `GET /api/routes/outbound/failover` (**admin**: lo único que lo muestra es
  `<FailoverSalida/>`, que vive dentro de `/rutas`, que es configuración entera y no está en
  `SUP_OK`) → `[{id, name, pattern, principal, backups,
  intento_seg, total_seg, en_uso, prevista, en_respaldo, sin_salida, cadena:[{trunk, rol, estado,
  detalle, caida, sbc, en_uso}]}]`. `estado` es el de pantalla; `caida` es `true` sólo con
  evidencia positiva de caída (registro rechazado o sin registrar, OPTIONS sin respuesta) y es lo
  ÚNICO que puede apagar una troncal en el dialplan.
  `en_uso` = por qué troncal salió la última llamada de esa ruta;
  `prevista` = por cuál saldría hoy si todavía no hubo ninguna; `sin_salida` = se agotó la cadena.
  Ruta **literal registrada antes** que `:id`.
- **Validación** (todo esto termina dentro del dialplan): nombre de troncal
  `^[A-Za-z0-9_.-]{1,64}$` y que exista en `pbxng_trunks`; las de `kind` `webrtc`/`webrtc-client`
  se rechazan; `prepend` sólo `[0-9+*#]`, `callerid` sólo `[0-9+]`, patrón sin comas ni `@`.
  `400 {error}` en español en todos los casos.
- **Cuándo salta a la siguiente troncal**: sólo cuando el corte es de la TRONCAL (`DIALSTATUS`
  `CONGESTION` o `CHANUNAVAIL`). Si `HANGUPCAUSE` es 1/2/3 (número inexistente), 17 (ocupado, 486),
  19 (no contesta), 20 o 22, la llamada **termina ahí**: el que dijo que no fue el destino y
  reintentar sería hacerle sonar el teléfono dos veces y cobrarle dos al cliente. La **21**
  (rechazada) es el caso feo y **necesita el código SIP además de la causa**:
  `ast_sip_hangup_sip2cause()` mapea a 21 tanto el 401/403/407 del *proveedor* (cuenta suspendida,
  clave rotada, IP fuera de la lista blanca → hay que saltar al respaldo) como el **603 Decline
  del destino** (→ no hay que saltar), y `handle_cause()` de `app_dial` no tiene `case` para la 21:
  cae en el `default` (`nochan++`), así que las dos llegan como `DIALSTATUS=CHANUNAVAIL`. Por eso
  el dialplan lee además el código SIP crudo (`HANGUPCAUSE(${HANGUPCAUSE_KEYS()},tech)` →
  `SIP 603 Decline`, con un `HangupCauseClear` antes de cada `Dial` para no leer el del intento
  anterior) y **sólo el 603 cancela el salto**. Esa lectura se **saltea con un `GotoIf` cuando
  `HANGUPCAUSE_KEYS()` viene vacío** (el `Dial` no llegó a crear canal saliente): `HANGUPCAUSE(,tech)`
  son dos argumentos válidos con un canal que no existe, así que devuelve vacío **y deja un
  WARNING por intento** justo en el camino que después hay que leer para entender el failover.
  Como la lectura se puede saltear, `SIPCODE` se limpia antes de cada intento (las variables de
  canal sobreviven al intento anterior). Los tres —`HangupCauseClear`, `HANGUPCAUSE` y
  `HANGUPCAUSE_KEYS`— viven en **`func_hangupcause.so`**, que por eso está en el `require =` de
  `modules.conf` (verificado cargado en producción). El 403 sigue saltando: es ambiguo, y equivocarse
  del lado de no saltar deja la central sin salida. Si no se pudo leer el código, se salta (igual
  que antes).
- **AstDB** (DB() siempre familia/clave): `rutasal/<id de ruta>` = troncal por la que salió la
  última llamada de esa ruta, o `!sin-salida`; lo escribe el dialplan generado **antes del `Dial`**
  (después no se ejecuta cuando cuelga el que llama) y lo lee la API con `database show rutasal`.
  `trunkup/<troncal>` = `0` cuando hay evidencia de que está caída; **lo escribe la API** cada 60 s
  (sólo si hay alguna ruta con respaldos) y lo lee el dialplan para saltarse una troncal ya sabida
  muerta sin gastar el timeout del `Dial`. Fail-open: sin la clave, se intenta. Nunca se escribe
  `0` a partir del 'offline' de pantalla (con ARI caído da 'offline' para todo) ni a toda una
  cadena a la vez: si todas dieran `0`, la principal queda en `1`.
- **Alertas**: evento `trunk.failover` en `pbxng_alert_rules` (apagado por defecto, throttle 5 min).
  Se avisa **una vez por transición** —cae al respaldo, vuelve a la principal, se agota la cadena—
  y nunca una vez por llamada. Si la ruta deja de salir por `to-sbc`, el correo lo dice explícito:
  esas llamadas ya no pasan por el SBC-NG ni por su normalización y selección de ruta.
- Borrar una troncal la **saca de los respaldos** de toda ruta que la nombrara y reescribe su
  dialplan (`DELETE /api/trunks/:name` devuelve `rutas_sin_respaldo`).
- Panel: pantalla **Rutas → Salientes**, tarjeta «Failover de troncal» (orden de los respaldos,
  tiempos y por cuál troncal está saliendo cada ruta ahora mismo).

Centro de seguridad (`control-plane/guard.js`, clon funcional del SOC de SBC-NG; desde 1.6.0
reemplaza a `/api/security` de fail2ban, `security/ban` y `security/unban`, que ya no existen):

- `GET /api/security` (SUP) → `{kpis:{bloqueados, permanentes, ultimas_24h, paises, fallos_24h},
  bloqueos:[{ip, reason, country, cc, flag, isp, hits, permanent, blocked_at, expires_at}] (500 más
  recientes), top_paises:[{pais, cc, flag, n}] (12), top_atacantes:[…bloqueos por hits] (10),
  eventos:[{id, kind, severity, detail, created_at}] (100; `kind` ∈ bloqueo | desbloqueo | ataque |
  geo | ajustes | motor; `detail.motivo` es el texto para la línea de tiempo),
  ataque:{activo, golpes_min, ips, top_ip, top_ip_golpes, por_tipo} (umbral: 12 eventos de
  seguridad en 60 s, igual que el SBC), enforcement:{nft, agente, motivo}}`. `enforcement.agente`
  = el agente de Asterisk contesta; `nft` = nftables está aplicando el set; con `nft:false` los
  bloqueos quedan en la base y se reintentan en cada sync, y el panel debe avisarlo.
- `GET /api/security/live` (SUP) → últimos 200 eventos del buffer en vivo (misma forma que
  `sec:ev`, §4). `GET /api/security/enforcement` (admin) fuerza un sync con el agente y devuelve
  `enforcement`.
- `POST /api/security/block {ip, reason?, permanent?=true}` (admin) → `{ok, ip, permanent}`;
  `400` si la IP es inválida o privada (nunca se bloquea la LAN), `409` si está en la lista blanca.
  `POST /api/security/unblock {ip}` → `{ok, ip, habia}`.
- `GET|PUT /api/security/settings` (admin): `{max_fallos, ventana_s, ban_s, ban_permanente_tras,
  escaneres, unidentified_count, unidentified_period, unidentified_prune, alertar}` (defaults
  5 / 60 / 3600 / 3 / true / 5 / 60 / 30 / true; `ban_s` 0 = permanente). Se guardan en
  `pbxng_settings` como `sec_<clave>`; los tres `unidentified_*` recién llegan a Asterisk con
  `POST /api/security/apply` (escribe `pbxng.d/pjsip-security.conf` con `[global](+)` y hace
  `module reload res_pjsip.so`; `502` si el reload lanzó error — ojo, hallazgo abierto del
  revisor: con el AMI desconectado `amiCommand()` resuelve vacío y la ruta responde `200
  {ok:true, output:''}`). La API crea ese archivo con los defaults en el arranque si no existe;
  como el entrypoint de Asterisk lo crea vacío antes, en una instalación nueva queda vacío
  hasta el primer `apply` (Asterisk corre mientras tanto con los `unidentified_*` de fábrica).
- Lista blanca (`pbxng_f2b_whitelist`, IP o CIDR; exime del contador y del geo-bloqueo):
  `GET /api/security/whitelist` → `[{ip, note, created}]`; `POST {ip, note?}` (si esa IP estaba
  bloqueada, la desbloquea); `DELETE /api/security/whitelist?ip=` / `DELETE …/whitelist/:ip` /
  `POST …/whitelist/remove {ip}` (compatibilidad).
- Filtro por país (`pbxng_geoblock`, modo en `pbxng_settings.sec_geoblock_modo`):
  `GET /api/security/geoblock` → `{paises:[{cc, nombre, added_at}], modo:'bloquear'|'permitir',
  geoip:true}`; `PUT {paises:[cc|{cc,nombre}], modo}` reemplaza la lista;
  `POST /api/security/geoblock/apply` → `{ok, modo, paises, bloqueadas, desbloqueadas}`: libera
  las bloqueadas por geo cuyo país ya no está vetado y banea (permanente, motivo `país no
  permitido (geo-bloqueo)`) las IPs vistas en las últimas 24 h cuyo país sí lo está;
  `POST /api/security/geoblock/add {cc, nombre?}` = "banear este país" desde el SOC (en modo
  permitir lo SACA de los permitidos) y aplica en el acto. En vivo, el primer `SecurityEvent`
  (aunque sea `SuccessfulAuth`) desde un país vetado es ban permanente. Sin país resuelto
  (ip-api caído) no se decide nada.
- `GET /api/ipgeo?ips=a,b` (admin) → `{ip:{country, cc, city, isp}}` (cache en memoria, ip-api).
- Reglas del motor: fallos por IP en ventana deslizante (`max_fallos` en `ventana_s`) → ban
  de `ban_s`; el ban número `ban_permanente_tras` en 24 h es permanente; `InvalidAccountID`
  con ≥3 cuentas distintas en la ventana = escáner (ban inmediato si `escaneres`);
  `SuccessfulAuth` resetea el contador de esa IP; IPs privadas nunca se banean. Un
  `unblock` manual borra también el historial de bans de esa IP (la escalada a permanente
  arranca de cero: es un "perdón"; la escalada sólo se acumula cuando el ban vence solo).
  Agregar un CIDR a la lista blanca no suelta las IPs ya bloqueadas dentro del rango (sólo
  una IP suelta se desbloquea al agregarla). Cada minuto
  vencen los temporales (`DELETE` + `/fw/unban`); al arrancar y cada 5 min `POST /fw/sync`
  con el set vigente y `GET /fw/bans` para `enforcement`. Los fallos se guardan agregados
  (`pbxng_sec_events` kind `fallo`, una fila por IP cada 15 s con `detail.n`; se podan a los
  30 días, el resto de eventos a los 180). Alertas por correo: `security.ban` (por bloqueo,
  throttle global de la regla) y `security.attack` (al pasar el umbral en vivo, cada 10 min
  como máximo) si `alertar` está prendido; `alerts.js` mantiene además el chequeo por
  ventana larga de `security.attack` sobre los fallos agregados.

Cómo la consume el panel (desde 1.8.0): **`dashboard/app/api.js` es el único punto de acceso
del panel a la API**. Toda pantalla o componente nuevo pide por `api()`/`apiGet`/`apiPost`/
`apiPut`/`apiDel`/`usePoll`/`useApi` (forma y opciones en §2) y **no** escribe `fetch('/backend/api…')`
a mano; el formateo sale de `dashboard/app/fmt.js`. Las únicas excepciones legítimas son los
pedidos que no cuelgan de `/api`: `GET /backend/health` (estado degradado del shell), los
archivos estáticos del propio panel (`/version.json`, `/manuales/*`) y el parche de
`window.fetch` de `app/auth.jsx`, que es la implementación y no un consumidor. Contrato de
errores del lado del panel, espejo del de acá: la capa convierte todo `!r.ok` en un `Error` con
`.status`, `.data` (el body) y `.message` = el campo `error` del JSON o, si la respuesta no
traía uno, el texto en español por status; un fallo de red da `.status = 0` y «Sin conexión con
el servidor». Consecuencia para `api`: **el texto de `{error}` se le muestra tal cual al
usuario en un toast**, así que tiene que estar en español y ser entendible (los 8 `catch` con
`status(400).json({error: e.message})` que quedan en rutas admin/supervisor, §5 bloque 3 de la
evaluación, hoy llegan a la pantalla). Una respuesta `200` con `{error}` en el cuerpo **no** es
un error para la capa: hay que devolver el status HTTP correcto. Los cuatro casos que quedan
así (`GET /api/npm/cert`, `GET /api/npm/hosts`, `GET /api/npm/test` y `topology.error_medicion`)
son estados previsibles, no fallos, y el panel los trata a mano. La CSP del panel (§2) cierra
`connect-src` en `'self'`: la API, el socket y el SIP tienen que seguir viniendo por el mismo
origen (`/backend`, `/socket.io`, `wss://<host>/ws`); mover cualquiera de los tres a otro host
obliga a abrir esa directiva en `dashboard/next.config.js` en el mismo cambio.

Convenciones: JSON siempre; errores `{ error: '<mensaje en español para el usuario>' }` con
el status HTTP correcto (400 validación, 401 sin sesión, 403 sin permiso, 404, 409, 500). Los
mensajes crudos de PostgreSQL no se devuelven al cliente. `Cache-Control: no-store` en todo `/api`.

Cómo se cumple (`control-plane/errores.js`): los `catch` de las rutas llaman a
`errorHttp(res, e)`, que respeta `e.status` con mensaje propio (400/403/404/409…), traduce un
error de PostgreSQL (SQLSTATE `2xxxx`/`4xxxx`/`5xxxx`/`08xxx`, o un `ECONNREFUSED` al puerto de la
DB) a un mensaje genérico en español con status según la clase — `23505` → `409 'ya existe un
registro con ese valor'`, `23503` → `409`, `23502`/`22xxx` → `400`, `57014` (statement_timeout) →
`504 'la consulta a la base de datos tardó demasiado'`, conexión caída → `503 'sin conexión con
la base de datos…'`, el resto → `500 'error interno de la base de datos'` — y deja el detalle
real (código, tabla, constraint, stack) en el log. Lo que ninguna ruta atrapa cae en el
middleware final de Express (montado después de todas las rutas): `500 {error:'error interno'}`
siempre, salvo `throw` con `e.status` 4xx que conserva su mensaje. Una ruta inexistente bajo
`/api` con sesión válida responde `404 {error:'ruta inexistente'}` (sin sesión sigue siendo 401:
el gate de auth va antes).

`GET /health` y `GET /health/ready` (idénticos; el segundo es el que pega el healthcheck de
compose y el `HEALTHCHECK` del Dockerfile): `200 {status:'ok', db:true, db_ms, ari, ami,
shutting_down:false, ts}` si la base contesta en 2 s, aunque ARI/AMI estén caídos (se
reportan); `503 {status:'degraded', db:false, …}` si la DB no responde; `503
{status:'shutting_down', shutting_down:true, db:<lo medido>, …}` mientras el proceso cierra
(`db` siempre viene en el body, así el panel distingue un reinicio de una base caída). Son
públicos (no cuelgan de `/api`).

Cierre ordenado: ante `SIGTERM`/`SIGINT` la API deja de aceptar conexiones, cierra socket.io,
corta las supervisiones activas (snoop), cierra ARI/AMI y el AudioSocket, espera hasta 10 s a
que terminen las consultas (`pool.end`) y sale con 0; a los 15 s sale con 1 sin esperar más.
Cada paso queda en el log (`mod: 'API'`, `msg: 'cierre: …'`). El `stop_grace_period` de la API
en compose (20 s, §7) cubre ese tope.

Logs: cada línea es JSON `{ts, level, mod, msg, …campos}` (`control-plane/log.js`); el prefijo
viejo (`[ARI]`, `[PUSH]`…) es ahora el campo `mod`. Nivel por `LOG_LEVEL`, formato legible con
`LOG_FORMAT=text` (§6).

## 4. Tiempo real (socket.io en `/socket.io`, mismo origen vía el proxy)

- Origen del handshake: ya no es `origin: '*'`. Se acepta un pedido **sin** cabecera `Origin`
  (el proxy del panel, curl, el softphone nativo), uno cuyo `Origin` coincide con el `Host` (o
  `X-Forwarded-Host`) con el que llegó, o uno listado en `CORS_ORIGINS` (§6). Cualquier otro
  recibe `403 {code:4, message:'origen no permitido'}` en el handshake y queda en el log
  (`mod: 'SOCKET'`). La comparación es `host:puerto` contra `host:puerto`: detrás de NPM
  (nginx manda `Host $host`, sin puerto) un panel publicado en un puerto no estándar
  (p. ej. `https://pbx:8443`) llega con `Origin` `pbx:8443` y `Host` `pbx` → hay que sumar
  ese origen a `CORS_ORIGINS`.
- El panel (`app/useLive.js`, `app/Scratchpad.jsx`) conecta **siempre al mismo origen**
  (`io({ path: '/socket.io', transports: ['polling'], upgrade: false, auth })`): `dashboard/server.js`
  proxya `/socket.io` (HTTP y upgrade) tanto en `npm run dev` como en producción, y `:3000`
  sólo escucha en loopback (§8), así que nunca se salta directo a la API.
- **El socket no se abre sin JWT.** El servidor exige `auth.token` en el handshake, así que del
  lado del panel `getSocket()` (`app/useLive.js`) devuelve `null` si no hay
  `localStorage.pbxng_jwt` en vez de conectar igual: desde `/login` la conexión sólo lograba que
  engine.io cerrara la sesión y que el poll en vuelo devolviera 400 en la consola. Todo
  consumidor de `getSocket()` tiene que tolerar el `null` (hoy `useLive()`, `app/LiveLog.jsx` y
  `app/seguridad/page.jsx`). Después del login hay recarga completa de página, así que el
  módulo se re-evalúa con el token ya guardado.
- Handshake con `auth.token` = JWT de panel. Sala `state` recibe `snapshot` (`{ts, health:{db,ari,ami},
  extensions, channels, queues}`) al conectar, en cada evento relevante (debounce 300 ms) y cada
  15 s como reconciliado.
- Registro en vivo de seguridad (pantalla `/seguridad`): el panel emite `sec:join` (sin
  argumentos) sobre el mismo socket; si el JWT es de panel con rol `admin` o `supervisor` el
  socket entra a la sala `security` y recibe `sec:hist` (array con los últimos 200 eventos) y
  después un `sec:ev` por evento: `{t (ms epoch), sev:'crit'|'warn'|'info',
  tipo:'auth'|'cuenta'|'acl'|'escaner'|'ban'|'flood'|'geo'|'ok', ip, cuenta, texto}`.
  `sec:leave` sale de la sala. Un token `phone` o un rol `agente` no entra (sin error: se
  ignora el `sec:join`). `GET /api/security/live` devuelve el mismo buffer para arrancar sin socket.
  Lado panel: `app/LiveLog.jsx` usa el socket compartido de `app/useLive.js` (`getSocket()`),
  emite `sec:join` en cada `connect` (al reconectar la API lo ve como socket nuevo) y `sec:leave`
  al desmontar; `app/seguridad/page.jsx` escucha `sec:ev` en ese mismo socket para refrescar
  `GET /api/security` con debounce de 1,5 s (más un poll de 8 s como reconciliado).
- Pizarra de videollamada: eventos `scratch:join|leave|op|clear` por sala. **Desde 1.4.0 exige
  un JWT válido**: `auth.token` (panel) o `auth.scratch` (token de softphone, scope `phone`);
  `scratch: true` a secas ya no alcanza. Un token `phone` (venga en `token` o en `scratch`)
  queda `scratchOnly`: no entra a la sala `state` ni recibe `snapshot`.

## 5. Asterisk ↔ API

- ARI (`:8088`, app Stasis `pbxng`, `subscribeAll`): eventos de canales/endpoints → cache del
  motor de llamadas; `Stasis(pbxng,ai,<agentId>)` para IVR con IA; `spysnoop,<id>` /
  `spyjoin,<id>` para supervisión. AMI (`:5038`): acciones (Originate, Redirect, MixMonitor,
  QueuePause, Command…) y eventos. AudioSocket: la API escucha en `:9092`.
- Dialplan estático (`extensions.conf`): el paso `wake` de los internos pide
  `GET /api/internal/wake?ext=&from=` con `URIENCODE()` en los dos valores. `modules.conf` exige
  cuatro módulos (`require = …`, o sea que un build sin ellos **no arranca**, que es lo buscado):
  `func_curl.so`, `func_uri.so` (ahí viven `URIENCODE`/`URIDECODE`; **no existe**
  `func_uriencode.so`), `func_db.so` (`DB`, `DB_EXISTS`, `DB_DELETE`) y `func_strings.so`
  (`STRFTIME` **y** `FILTER`; tampoco existe ningún `func_strftime.so`). A esos se suman
  `app_directory.so` y `app_read.so` (marcación) y `func_hangupcause.so` (la escalera de failover
  de `trunks.js` usa la aplicación `HangupCauseClear` y las funciones `HANGUPCAUSE` /
  `HANGUPCAUSE_KEYS`). **Regla**: al `require =` sólo se agrega un módulo verificado contra la
  central (`module show like …` → `Running`), porque Asterisk sale con código 2 si falta.
  **Regla de los tres lugares** (1.10.x): un módulo con `require =` vive en TRES lugares que se
  mueven juntos — `docker/config/asterisk/modules.conf`, la lista de REQUERIDOS del gate de
  `docker/images/asterisk/Dockerfile` (corta el build) y la lista de REQUERIDOS del aviso de
  `docker/images/asterisk/docker-entrypoint.sh` (avisa en el arranque). Si sólo está en
  `modules.conf`, el build sale verde sobre una imagen que no levanta y el síntoma es el
  contenedor de Asterisk en crash-loop, o sea la central entera sin teléfonos. Así se escapó
  `func_hangupcause.so`.
  **`docker/Dockerfile.allinone` queda fuera a propósito**: su Asterisk es el de Debian y no
  copia `docker/config/asterisk/`, así que no recibe ningún `require =` ni el dialplan. Es una
  demo del panel y la API; no valida telefonía y no se la hace equivalente (el porqué está
  escrito en el encabezado de ese Dockerfile). Los dos últimos son de
  1.9.0: sin ellos el dialplan no falla, devuelve vacío — o sea que todo desvío queda apagado y
  toda llamada entra como si fuera horario de oficina. Buzón de voz:
  `*97` usa `VoiceMailMain(${CHANNEL(endpoint)}@default,s)` sólo en canales PJSIP (la identidad
  es el endpoint que autenticó, no el `CALLERID(num)` que manda el teléfono); otros canales y
  `*98` (buzón ajeno) piden clave, nunca llevan `s`. Mailbox = id del endpoint = interno.
  **Telefonía clásica (1.9.0)**, en el patrón `_[1-9]XXX` del contexto `internal` y por lo tanto
  **dentro de la imagen** (cambiarlo obliga a reconstruirla): guardia de bucle (`SALTOS`, tope 5 →
  buzón, porque un desvío A→B y otro B→A giraban sin fin) → `DB(dnd/<ext>)=1` va a la extensión
  nueva `vm-DND` (`VoiceMail(…,b)`, el teléfono **no suena** y el motivo queda en el log y en el
  CDR) → `DB(cfu/<ext>)` con contenido salta a `Goto(internal,<destino>,1)` **antes** del wake y
  del `Dial` → el timeout del `Dial` es 25 s salvo que haya sígueme, y ahí sale de
  `FILTER(0-9,${DB(fmt/<ext>)})` acotado a 5–120 (default 15) → por `DIALSTATUS`: `BUSY` → `cfb`
  o `vm-BUSY`; `NOANSWER` → `cfnr`, si no sígueme (`Dial(Local/${DB(fm/<ext>)}@internal/n,45)`,
  que sale por la ruta saliente del propio contexto `internal` con el CallerID de siempre), si no
  `vm-NOANSWER`; todo lo demás sigue cayendo en `vm-${DIALSTATUS}`. El dialplan **lee la AstDB y
  no la base** a propósito: no puede pagar una consulta por timbrazo y estas banderas cambian
  todo el tiempo.
- **AstDB (base interna de Asterisk): quién escribe y quién lee.** La escribe **sólo la API**
  (por AMI `DBPut`/`DBDel`) y el **dialplan de los códigos de función** (que después avisa a la
  API por `POST /api/internal/feature`, §3). La lee el dialplan, estático y generado.

  | Clave | Valor | La escribe | La lee |
  |---|---|---|---|
  | `rec/<ext>`, `rec/_ALL_` | `1` | `recordings.js` (`setRecFlag`, `setRecAll`) | `extensions.conf`, bloque de grabación |
  | `dnd/<ext>` | `1` (ausente = apagado) | `telefonia.js`, código `*78`/`*79` | `extensions.conf`, `_[1-9]XXX` |
  | `cfu/<ext>` | destino (sólo dígitos) | `telefonia.js`, código `*21*<dest>` / `*21` | `extensions.conf` |
  | `cfb/<ext>` | destino si ocupado | `telefonia.js`, código `*22*<dest>` / `*22` | `extensions.conf` |
  | `cfnr/<ext>` | destino si no contesta | `telefonia.js`, código `*23*<dest>` / `*23` | `extensions.conf` |
  | `fm/<ext>` | número del sígueme, **con prefijo de salida** | `telefonia.js`, código `*24*<dest>` / `*24` | `extensions.conf` |
  | `fmt/<ext>` | segundos antes del sígueme (5–120, default 15) | `telefonia.js` | `extensions.conf` (pasado por `FILTER(0-9,…)`) |
  | `hol/<MM-DD>`, `hol/<YYYY-MM-DD>` | `1` | `telefonia.js` (feriados) | dialplan de ruta entrante con horario (realtime) |
  | `nightmode/modo` | `auto` \| `abierto` \| `cerrado` | `telefonia.js`, código `*28` | dialplan de ruta entrante con horario (realtime) |
  | `sala/<nombre>` | `1` abierta \| `0` fuera de la ventana agendada | `salas.js` (al guardar, `syncSalas()` y su reloj de agenda) | dialplan de la sala (realtime) |
  | `salapin/<nombre>`, `salamod/<nombre>` | PIN de participante y de moderador | `salas.js` | dialplan de la sala (realtime) |
  | `abrev/<ext>-<NN>` | destino del abreviado personal `NN` del interno (sólo dígitos) | `marcacion.js` (`syncAbreviados()` y el PUT del interno) | patrón `_<prefijo>XX` (realtime), pasado por `FILTER(0-9,…)` |

  **`nightmode/modo`, no `nightmode` a secas**: la función `DB()` exige familia/clave
  (`func_db.c`: *"DB requires an argument, DB(<family>/<key>)"*), así que la forma corta sería
  siempre vacía y con un WARNING por llamada. El contrato del sprint 6 decía `DB(nightmode)`; la
  desviación es deliberada y está aplicada igual en `telefonia.js` y en `trunks.js`.

  **La AstDB no está en un volumen** (`astdbdir` apunta a `/var/lib/asterisk`, y los compose sólo
  montan `…/sounds/custom`): recrear el contenedor de Asterisk la deja vacía. Por eso el volcado
  Postgres → AstDB (`syncFeatures` de `telefonia.js`, `syncRecFlags` de `recordings.js`,
`syncSalas` de `salas.js` y `syncAbreviados` de `marcacion.js`) corre en
  **cada conexión del AMI** y no sólo a los 9 s del arranque de la API (`app.js`, array
  `resincronizar`; 2 s de gracia para que Asterisk cargue `func_db`, freno de 60 s si el AMI
  flapea). Aun así queda una ventana de ~30–40 s tras recrear Asterisk en la que nada de esto
  aplica; el arreglo de fondo es darle volumen propio.
- **Dialplan que genera la API para una ruta entrante CON horario** (contexto realtime
  `from-trunk`, `trunks.js`): el DID ocupa **tres extensiones**, `<did>` (decide),
  `abierto-<did>` (destino normal) y `cerrado-<did>` (destino fuera de hora, o el buzón del
  interno si no se configuró ninguno). La extensión que decide hace, en orden: modo noche forzado
  (`ExecIf` sobre `DB(nightmode/modo)`, primero `cerrado` y después `abierto`) → feriado
  (`GotoIf` con `DB_EXISTS(hol/${STRFTIME(${EPOCH},,%m-%d)})` o la misma con `%Y-%m-%d`) → un
  `GotoIfTime(<desde>-<hasta>,<dias>,*,*?from-trunk,abierto-<did>,1)` **por tramo** → lo que no
  entró en ninguno cae en `cerrado-<did>`. Todo sale de la AstDB, así que poner un feriado o
  apretar el modo noche **no regenera dialplan ni recarga nada**; lo único que obliga a regenerar
  son los **tramos** (viven en el dialplan de cada DID), y eso lo dispara `telefonia.js` llamando
  a `regenerarEntrantes({horario_id})`. **Sin horario asignado la ruta se genera como siempre**,
  con una sola extensión. Borrar la ruta, o sacarle el horario, borra las tres. La zona horaria
  que usan `GotoIfTime` y `STRFTIME` es la del contenedor de Asterisk (§6, `TZ`).
- **Fax (`fax.js`, 1.10.0).** Dialplan realtime, no estático: recepción en `from-trunk`
  (`fax-rx-<caja>`: `ReceiveFAX(<spool>/in/<caja>-${UNIQUEID}.tif,fz)` + aviso por CURL; la caja
  va en el nombre para que el barrido del spool sepa de quién es el fax, ver §3) y envío en
  `internal` (`fax-tx`: `SendFAX(${FAXFILE},fz)`), los dos contextos con `switch => Realtime` en
  `extensions.conf` — **un contexto nuevo no existiría sin reconstruir la imagen**. Las opciones
  son siempre `f` (respaldo en audio) **y** `z` (pedir T.38): así el mismo dialplan sirve con
  T.38, sin T.38 y con un SBC-NG en el medio que no pase el reinvite. El envío se origina con
  `Local/<numero>@internal/n` + `Variable: FAXJOB/FAXFILE/FAXSID/FAXHDR` (una cabecera
  `Variable:` por clave), o sea que sale por la **ruta saliente de siempre**, con su prefijo, su
  CallerID y su cadena de failover. La detección de tono (CNG) usa `fax_detect` del endpoint de
  la troncal: chan_pjsip manda la llamada a la extensión **`fax`** del contexto del endpoint
  (`from-trunk`), que deriva a la caja elegida. `fax.js` es el único que escribe las columnas
  T.38 de `ps_endpoints` (`t38_udptl`, `t38_udptl_ec`, `t38_udptl_nat`, `t38_udptl_maxdatagram`,
  `fax_detect`, `fax_detect_timeout`) y las **reconcilia cada vuelta de su reloj**, porque
  `writeAsteriskTrunk()` de `trunks.js` borra y reinserta esa fila en cada edición de troncal
  (pendiente: que `trunks.js` llame a `aplicarT38()` después de escribir). Esa reconciliación
  **sólo enciende las troncales de la lista `trunks` de la configuración y sólo apaga las que
  SALIERON de esa lista** (el diff se calcula en el `PUT /api/fax/config`, que es donde se sabe
  cuál era la lista vieja): el fax no apaga el T.38 de una troncal que él nunca encendió. Y con
  la lista vacía —el default de `0016_fax.sql`, o sea toda central que no usa fax—
  `aplicarT38()` **sale sin tocar `ps_endpoints`**, que es una tabla realtime que Asterisk
  consulta en cada llamada. Los dos UPDATE (el que enciende y el que apaga) filtran por
  `pbxng_kind='trunk'`: en esa tabla conviven troncales e internos y el fax no puede tocar
  el endpoint de un teléfono. Las rutas entrantes
  aceptan `dest_type='fax'` con el **id de la caja** como `dest_value`.
  **Ojo con `extensions.appdata`: es `varchar(256)`.** Por eso el aviso final va partido en
  `FQ1`/`FQ2`/`FQ3` y no en un solo CURL; pasarse no da un error entendible (Postgres contesta
  22001 y el panel muestra «alguno de los datos no es válido»), así que `fax.js` lo frena al
  generar con un mensaje que dice qué línea no entra.
- Config generada por el panel: `pbxng.d/{parking,features,moh,pjsip,rtp,pjsip-security}.conf`
  (volumen `asterisk_conf`) incluida por `#include` desde los `.conf` base. Dialplan de
  aplicaciones: tabla realtime `extensions`. Contextos: `from-trunk` (entrantes), `internal`
  (internos), `ivr`, `c2c`. `pjsip-security.conf` lo escribe `POST /api/security/apply`
  (`[global](+)` con `unidentified_request_count|period|prune_interval`) y se incluye desde
  `pjsip.conf` después de `pbxng.d/pjsip.conf`.
- Eventos de seguridad: `res_security_log` está cargado (`modules.conf` autoload, sin
  `noload`) y `logger.conf` tiene el canal `security`; el AMI (usuario con `read=all`) recibe
  **un evento por tipo, cuyo nombre ES el del evento de seguridad** (Asterisk 20,
  `main/security_events.c`): `Event: InvalidPassword|InvalidAccountID|ChallengeResponseFailed|
  FailedACL|RequestNotAllowed|RequestNotSupported|RequestBadFormat|UnexpectedAddress|
  InvalidTransport|SessionLimit|MemoryLimit|LoadAverageLimit|ChallengeSent|SuccessfulAuth`, con
  `Privilege: security,all`, `EventTV`, `Severity`, `Service`, `EventVersion`, `AccountID`,
  `SessionID`, `LocalAddress`, `RemoteAddress=IPV4/UDP/1.2.3.4/5060`. **No existe** un
  `Event: SecurityEvent` ni un campo `SecurityEvent` en el AMI: ese formato
  (`SecurityEvent="InvalidPassword"`) es el del archivo `security.log`. Ojo: PJSIP no emite
  `InvalidPassword` para clave errada sino `ChallengeResponseFailed`.
  Del lado de la API los consume `control-plane/guard.js` (`ami.on('managerevent')`: se toma
  `e.event` y se acepta si es una clave de `CLASES`; asterisk-manager baja las CLAVES a
  minúscula y conserva los valores: `event`, `privilege`, `remoteaddress`, `accountid`,
  `service`, `eventtv`). Clasificación: `InvalidPassword` /
  `ChallengeResponseFailed` → `auth`; `InvalidAccountID` → `cuenta` (≥3 cuentas distintas desde
  la misma IP en la ventana → `escaner`, crit); `FailedACL` → `acl`; `RequestNotAllowed` /
  `RequestNotSupported` / `RequestBadFormat` / `UnexpectedAddress` / `InvalidTransport` →
  `escaner`; `SessionLimit` / `MemoryLimit` / `LoadAverageLimit` → `flood` (crit);
  `SuccessfulAuth` → `ok` (no cuenta como fallo y resetea el contador de la IP);
  `ChallengeSent` se ignora. Sólo `IPV4/...` se procesa (nftables del módulo es IPv4).
- Agente de Asterisk `:8092` (`docker/images/asterisk/pbxng-ast-agent.py`; la API le habla
  con `astFwd()` y `sysmon.js` con `get()`, ambos mandan `X-PBXNG-Token`). **Autenticación**:
  todo `POST` (`/fw/*`, `/route`, `/iface`, `/netmode`, `/diag`, `/sound`, `/reload`) y los
  `GET` que describen el host (`/net`, `/route`, `/fw/bans`) exigen `X-PBXNG-Token` =
  `/etc/pbxng/agent.token` (volumen `certs`, montado en Asterisk como `/etc/pbxng` ro; también
  `PBXNG_AGENT_TOKEN` por entorno) → `401 {error:'token inválido'}`; si no hay token
  configurado (instalación vieja) se aceptan sólo pedidos desde redes privadas/loopback (de
  ahí llega la API por el bridge). `GET /core` y `GET /metrics` quedan abiertos: versión,
  contadores, carga y memoria, sin secretos ni IPs. `GET /route` → `{managed:[{id,dest,gw,
  dev,note}]}`; `POST /route {action:'add',dest,gw?,dev?,note?}` valida `dest` (red CIDR o
  `default`), `gw` (IP) y `dev` (nombre de placa) → `400 {error}` si no; `ip route` se
  invoca siempre con argv, nunca por shell.
  - Firewall del módulo `/seguridad`:
  - `POST /fw/ban {ip, seconds}` (`seconds` 0 = permanente, tope 10 años) →
    `200 {ok, ip, seconds, enabled:true}`.
  - `POST /fw/unban {ip}` → `200 {ok, ip, enabled:true}` (idempotente: no estar en el set no es error).
  - `GET /fw/bans` → `{enabled:bool, bans:[{ip, expires_s|null}], motivo?}` (`expires_s` = segundos
    que le quedan; `null` = permanente).
  - `POST /fw/sync {bans:[{ip,seconds}]}` → `200 {ok, enabled, total, rechazados:[{ip,error}]}`:
    deja el set EXACTAMENTE así (flush + add en una sola transacción `nft -f`).
  - Errores: `400 {error}` (IP inválida, IPv6, privada/loopback/reservada, IP del propio host,
    `bans` no es lista), `401 {error:'token inválido'}`, `503 {ok:false, enabled:false, motivo}`
    si no hay `nft` o el kernel no soporta nf_tables, `500 {ok:false, error}` si `nft` falló.
  - Implementación: tabla `inet pbxng`, set `banned {type ipv4_addr; flags timeout;}`, chain
    `input` (`type filter hook input priority -10; policy accept`) con la regla
    `ip saddr @banned drop`. `ensure_fw()` es idempotente (crea sólo lo que falta, nunca borra el
    set): la corre el entrypoint (`pbxng-ast-agent.py --ensure-fw`, tolera un host sin nftables
    y sigue), el agente al arrancar y cada `/fw/*`. Los bloqueos viven en el kernel del host:
    sobreviven a reinicios del contenedor; la API debe llamar a `/fw/sync` al arrancar para
    reconciliar con `pbxng_blocked`.
  - **Reglas de gestión** (`docs/FIREWALL.md` §1.2): en la misma chain, `ensure_fw()` mantiene
    tres reglas con `comment "pbxng-mgmt"` que aceptan `tcp dport {8088, 5038}` (ARI/HTTP+WS de
    PJSIP y AMI) sólo desde los sets `mgmt_allow` (`127/8, 10/8, 172.16/12, 192.168/16`;
    incluye la subred bridge de docker) y `mgmt_allow6` (`::1, fc00::/7, fe80::/10`) y dropean
    el resto. `http.conf` sigue con `bindaddr=0.0.0.0` porque la API llega por `ASTERISK_HOST`
    (IP LAN del host). Configurable con `/etc/pbxng/fw.json` (opcional, lo escribe el
    administrador; `PBXNG_FW_CONFIG` cambia la ruta): `{"ari_public": true}` no pone las reglas
    (y las borra por handle si estaban), `"mgmt_allow": ["cidr", ...]` suma redes (v4 o v6;
    lo inválido se ignora). Los sets se reconcilian (flush + add) en cada `ensure_fw()`; las
    reglas se agregan una sola vez (se detectan por el comment). `ensure_fw()` devuelve además
    `mgmt:bool` (y `motivo` si la parte de gestión falló sin deshabilitar los baneos).
    `pbxng-ast-agent.py --print-fw` imprime el ruleset declarativo equivalente (para
    `nft -c -f`), no se aplica con `nft -f`.

## 6. Variables de entorno (`.env` del compose)

`DOMAIN PUBLIC_IP TENANT_MODE DEFAULT_COMPANY` · `DB_HOST DB_PORT DB_NAME DB_USER DB_PASS` ·
`ARI_USER ARI_PASS AMI_USER AMI_PASS JWT_SECRET ADMIN_DEFAULT_PASS` · `ASTERISK_HOST MEDIA_HOST
TURN_HOST VOZ_HOST NPM_HOST AST_AGENT TURN_AGENT` · `TURN_USER TURN_PASS TURN_CLI_PASS
TURN_REALM` · `API_URL` (el dashboard lo lee al arrancar, `server.js`; ya no se fija en el build) · `SOFTPHONE_DIR` (opcional) ·
`COMPOSE_PROFILES` (módulos activos) · `VAPID_PUBLIC VAPID_PRIVATE VAPID_SUBJECT` (Web Push;
opcionales: si el par falta o no firma —placeholder, largo incorrecto— la API genera uno y lo
guarda en `pbxng_settings.vapid_*`, §3 familia `push`; `VAPID_SUBJECT` default
`mailto:soporte@example.com`) · `GO2RTC_MGMT` (intercom, default `http://go2rtc:1984`)
· **`FAX_DIR`** (dónde ve la API el spool de fax, default `<REC_DIR>/fax`, o sea `/recordings/fax`) y **`FAX_DIR_AST`**
(el MISMO directorio como lo ve Asterisk, default `/var/spool/asterisk/monitor/fax`): son los
dos nombres del mismo lugar, y por defecto cuelgan del volumen `recordings`, que ya está montado
en los dos contenedores — el fax funciona sin tocar el compose, y el spool sobrevive a un `up -d`
porque `recordings` es un volumen con nombre. Si cambia uno hay que cambiar el
otro, o Asterisk escribe el TIFF donde la API no lo encuentra. Desde 1.10.0 los dos compose
reenvían `FAX_DIR FAX_DIR_AST FAX_MAX_MB FAX_TICK_MS FAX_CONVERT_MS` en el `environment:` del
servicio `api`, vacíos por defecto (vacío = el default de `fax.js`) · `FAX_MAX_MB` (tope DURO del PDF
que se sube, default 20, máximo 64; la configuración del panel puede bajarlo pero no subirlo,
porque el límite lo aplica `express.raw` al registrar la ruta) · `FAX_TICK_MS` (cada cuánto corre
la cola de envío, el barrido del spool y la reconciliación de T.38; default 20000, mínimo 5000) ·
`FAX_CONVERT_MS` (tiempo máximo de ghostscript / tiff2pdf, default 120000)
· `ENROLL_REUSE_SECONDS` (opcional, default 120) · `SALAS_AGENDA_MS` (opcional, default
30000, mínimo 10000: cada cuánto la API revisa si una sala agendada tiene que abrir o cerrar)
· **`CC_LOTE_MS CC_LOTE_TOPE CC_LOTE_FILAS`** (opcionales, la cota del consumidor AMI de
`ccreport.js`: cada cuánto se vuelcan los eventos de cola —default 2000, mínimo 250—, cuántos
se guardan en memoria antes de empezar a descartarlos —default 2000, mínimo 100— y cuántas
filas entran en cada INSERT —default 250, mínimo 20—. Es el techo que evita que el informe le
gane el pool a los `CURL()` del dialplan; ver §3, «Reportes de call center». Bajar `CC_LOTE_MS`
acerca el informe al tiempo real y sube la frecuencia de adquisición, nunca la concurrencia:
el volcado sigue siendo de a uno)
· `LOG_LEVEL` (`debug|info|warn|error`,
default `info`; **ojo:** `LOG_LEVEL`, `LOG_FORMAT`, `PG_POOL_MAX`, `PG_STATEMENT_TIMEOUT_MS`,
`CORS_ORIGINS` y `TZ` los lee la API de su entorno y desde 1.8.0 los dos compose sí los
reenvían en el `environment:` del servicio `api`; `TZ` va además al servicio `asterisk`,
ver su entrada más abajo) · `LOG_FORMAT` (`json` default, `text` para desarrollo) · `PG_POOL_MAX`
(conexiones máximas del pool de la API, default 10; además el pool fija `idleTimeoutMillis`
30 s y `connectionTimeoutMillis` 5 s) · `PG_STATEMENT_TIMEOUT_MS` (default 30000: Postgres
cancela toda consulta que pase de ahí; el cliente la corta 5 s después si el servidor no
respondió ni a la cancelación) · `CORS_ORIGINS` (opcional, orígenes extra para el handshake
de socket.io separados por coma, p. ej. `http://localhost:3001` en desarrollo; sin él sólo se
acepta el mismo origen o ningún `Origin`, §4) · `MEM_POSTGRES MEM_ASTERISK MEM_API
MEM_DASHBOARD MEM_COTURN MEM_VOZ MEM_GO2RTC MEM_NPM` (límite de memoria de cada contenedor,
`mem_limit` = `memswap_limit`; defaults `1g 1g 768m 512m 256m 4g 512m 512m`, solo los lee el
compose) · `BACKUP_KEEP` (cuántos respaldos programados conserva `backup-cli.js` y el planificador
interno, default 14; el compose se lo pasa a la API y `docker/backup-cron.sh` lo manda además
como `--keep=N`) · **`TZ`** (opcional, default `America/Montevideo` en los dos compose; va al
`environment:` de **los dos servicios, `api` Y `asterisk`, con el MISMO valor**, y no es
decorativo en ninguno de los dos. En la API: la hora del respaldo programado interno y el
`estado` ('abierto'/'cerrado') que devuelve `GET /api/nightmode` salen del reloj de ese
contenedor (el campo `tz` de `backup/schedule` dice cuál está usando). En Asterisk: el bloque
de telefonía clásica del dialplan —`GotoIfTime()` de los tramos de horario, `STRFTIME()` de
las claves `hol/<MM-DD>` y `hol/<YYYY-MM-DD>` de feriados y, por lo tanto, el modo noche
automático— se evalúa con `ast_localtime()`, o sea con el reloj del contenedor de Asterisk.
Si las dos zonas no coinciden **el panel miente sin un solo error en el log**: dice «abierto»
mientras la central manda las entrantes al destino de fuera de hora. La imagen de Asterisk
instala `tzdata` (`docker/images/asterisk/Dockerfile`) porque `debian:12-slim` no lo trae y
sin `/usr/share/zoneinfo` glibc ignora `TZ` y vuelve a UTC en silencio: poner la variable sin
el paquete parece arreglado y no lo está. Comprobación: `docker compose exec asterisk date` y
`docker compose exec api date` tienen que dar la misma hora local) ·
`PBXNG_COMPOSE_FILE` (qué compose usa la instalación, lo fija `install.sh`; lo leen
`pbxng-ctl` y `backup-cron.sh`, no los contenedores) · `CONF_DIR` (directorio de
configuración persistente de la API, default `/etc/pbxng`; el compose lo fija ahí: ACME,
imágenes de los manuales y `agent.token` viven adentro — fuera del contenedor, p. ej. en las
pruebas de integración, apunta a un temporal para no escribir en el `/etc` del host) ·
`DASHBOARD_BIND` (interfaz del host
donde se publica `:3001`, ver §8) · `DASHBOARD_TRUST_PROXY` (opcional:
cantidad de reverse proxies delante del panel; el compose lo pasa como `TRUST_PROXY` al
dashboard junto con `COMPOSE_PROFILES`, y si está vacío el panel usa 1 con el perfil `proxy`
y 0 sin él; ponerlo en 1 si hay un nginx externo al compose) · `PBXNG_REGISTRY PBXNG_VERSION`
(solo release). Secretos vacíos = los genera `install.sh`; la API **no arranca** (log claro + `exit 1`)
con `JWT_SECRET` vacío, placeholder `__SET_JWT_SECRET__` o de menos de 16 caracteres. `TURN_PASS`/`TURN_CLI_PASS` no tienen
default en ningún compose (`${VAR:?}`). `DB_HOST` lo usa **solo Asterisk** (host network) y vale
`127.0.0.1`; la API siempre va por la red interna (`postgres`). `ASTERISK_HOST` es la IP LAN del
host donde corre Asterisk (nunca `127.0.0.1`: dentro del contenedor de la API eso es la propia
API). No existe `REDIS_HOST`: Redis se retiró del stack (nada lo usaba).

## 7. Volúmenes (iguales en `docker-compose.yml` y `docker-compose.release.yml`)

`pg_data npm_data npm_letsencrypt asterisk_sounds asterisk_conf voz_models go2rtc_config
recordings voicemail certs respaldos`. Montajes: asterisk → `recordings`, `voicemail`, `certs`
(`/etc/pbxng`, ro), `asterisk_conf` (`/etc/asterisk/pbxng.d`), `asterisk_sounds`, `respaldos`;
api → `recordings` (rw), `voicemail`, `certs` (`/etc/pbxng`), `respaldos`, `asterisk_conf`,
`asterisk_sounds`. Asterisk con `cap_add: NET_ADMIN` y `network_mode: host`. Servicios: `core`
= postgres, asterisk, api, dashboard · `turn` = coturn · `ai` = voz · `intercom` = go2rtc ·
`proxy` = npm (sin Redis). `docker/check-compose-parity.sh` (lo corre `release.sh` y la CI)
falla si los dos compose difieren en algo que no sea `build:`/`image:`.
El **fax** (§3) todavía no tiene volumen propio: usa un subdirectorio del volumen `recordings`
(`FAX_DIR=/recordings/fax` en la API, `FAX_DIR_AST=/var/spool/asterisk/monitor/fax` en Asterisk),
que es el único ya montado en los dos contenedores, así que funciona sin tocar el compose.
Pedido a `empaquetado`: un volumen `fax` propio, `ghostscript` + `libtiff-tools` en la imagen de
la API y `libspandsp2`/`libspandsp-dev` (res_fax_spandsp) en la de Asterisk.
Todos los servicios llevan `healthcheck`, `mem_limit`/`memswap_limit` (variables `MEM_*`, §6)
y `logging` json-file 10 MB × 5 (`x-logging`). `stop_grace_period`: asterisk 60 s, api 20 s.
El healthcheck de la API pega a `GET /health/ready` (tiene que devolver 503 si la base no
responde; hoy `/health` hace lo mismo, pero el contrato del healthcheck es `/health/ready`);
el del panel a `GET /login`.
Recrear Asterisk corta llamadas: `pbxng-ctl` y `deploy.sh` drenan antes con
`docker/asterisk-drain.sh` (`core stop gracefully`, espera acotada, confirmación salvo `--yes`).
Respaldo programado: `docker/backup-cron.sh` (cron del host 03:00, lo instala `install.sh`)
→ `docker compose exec -T api node backup-cli.js --keep=N`; `pbxng-ctl backup [args]` es el
mismo camino a mano. `control-plane/backup-cli.js` (dueño `api`) invoca `backup.programado()` (= `crear()` con
nombre `pbxng-auto-YYYYMMDD-HHMM.tar.gz` + retención: se borran sólo los `pbxng-auto-*` que
excedan `--keep`/`BACKUP_KEEP`, nunca los manuales del panel; si la creación falla no se poda
nada). Además, la API trae un planificador interno equivalente (§3, `backup/schedule`), activo
por defecto a las 03:00 del reloj del contenedor, así que el cron del host es opcional. Los dos
escriben `backup_last_run` al empezar y el planificador salta si hoy ya hay marca, pero como el
cron usa la hora local del host y el planificador la del contenedor, en un host con zona
distinta de la de `TZ` pueden caer en momentos distintos del mismo día y salir DOS respaldos
diarios (la retención se consume al doble): alinear `TZ` con la zona del host o apagar uno de
los dos.

## 8. Puertos publicados al host

Solo: `3001` (panel; se publica en `${DASHBOARD_BIND:-0.0.0.0}:3001` en ambos compose:
`install.sh` y `pbxng-proxmox.sh` ponen `DASHBOARD_BIND=127.0.0.1` cuando el perfil `proxy`
corre en el mismo compose — NPM llega por la red bridge a `dashboard:3001` y se entra por
443 — y `0.0.0.0` si no hay proxy o está en otro host/CT, en cuyo caso además va
`DASHBOARD_TRUST_PROXY=1` y hay que restringir `:3001` a la IP del proxy por firewall; si
`:3001` quedara abierto con un proxy confiado, cualquiera de la LAN falsificaría la IP del
rate limit con un `X-Forwarded-For` propio), `80/443/81` (proxy), `3478/5349 + relay` (TURN, host
network), `5060/5061 + 10000-20000/UDP` (Asterisk, host network), `8080` (voz, solo LAN),
`1984 + 8555/tcp+udp` (go2rtc, módulo intercom, solo LAN).
**Solo loopback del host** (`127.0.0.1:` en ambos compose, no alcanzables desde afuera): `5432`
(Postgres) y `3000` (API). Existen únicamente porque Asterisk corre en host network y necesita
la DB (realtime/CDR) y la API (`/api/internal/wake`); nunca pasarlos a `0.0.0.0`. Para usar la
DB desde otra máquina en desarrollo: túnel ssh (`ssh -L 5432:127.0.0.1:5432 host`).
**No** se publican `6379` (Redis ya no existe), `5038`, `8088`. Asterisk corre en host network,
así que `8088` (ARI + WS de PJSIP) y `5038` (AMI) escuchan en `0.0.0.0` del host — no pueden ir
a `127.0.0.1` porque la API llega por `ASTERISK_HOST` — y los protege nftables en el kernel del
host: sólo redes privadas (reglas `pbxng-mgmt` de la tabla `inet pbxng`, §5 y
`docs/FIREWALL.md` §1.2; se desactiva con `{"ari_public": true}` en `/etc/pbxng/fw.json`). El
AMI además tiene su propio `permit=` (`AMI_PERMIT`). Pendiente: AudioSocket de la IA (`:9092` de la API) tampoco está publicado, así
que Asterisk no llega al pipeline de voz desde compose (ver evaluación).

## 9. Versionado

`VERSION` + `CHANGELOG.md` (SemVer). Tag `vX.Y.Z` → imágenes a GHCR, **sólo si la CI pasa**:
desde 1.7.0 `release.yml` corre primero `ci.yml` (`images: needs: ci`; lint + `npm test` de la
API contra Postgres efímero, lint + `next build` del panel, paridad y `config -q` de los compose,
`bash -n`/`py_compile`), sin entrada para saltearla; qué corre cada job y cómo reproducirlo a
mano está en §10 y en `docs/PACKAGING.md` §CI. Tag `softphone-vX.Y.Z` →
release del softphone. Cambios de esquema = `control-plane/migrations/000N_*.sql` (nunca se
edita una aplicada; se agrega otra). **Las corre el arranque de la API**:
`control-plane/docker-entrypoint.sh` espera a Postgres (60 s; si no aparece, sale con 1), corre
`node migrate.js` y recién después `exec node app.js`. Si una migración falla el contenedor sale
con 1 y NO arranca con esquema viejo. `migrate.js` es idempotente (registra cada archivo en
`pbxng_schema_migrations`, transacción por archivo, candado `pg_advisory_lock` para que dos
réplicas no migren a la vez); `deploy.sh` lo corre además antes del `up -d` (con
`run --rm --no-deps --entrypoint node api migrate.js`: el entrypoint de la imagen ignora los
argumentos y terminaría levantando la API, hay que pisarlo) para que un esquema roto frene el
deploy en vez de dejar la API en crash-loop; al arrancar no hace nada la segunda vez.
`0012_ccreport.sql` (1.10.0) crea `pbxng_queue_events` (la vida de cada llamada dentro de una
cola, que llena el consumidor AMI de `ccreport.js`) y `pbxng_cc_reports` (los envíos
programados del informe), siembra la regla de alerta `ccreport.scheduled` **prendida** y el
ajuste `cc_retencion_dias` (365).
`0013_trunk_failover.sql` (1.10.0) le agrega a `pbxng_outbound_routes` las columnas `backups`
(jsonb, lista ORDENADA de troncales de respaldo), `intento_seg` (20) y `total_seg` (45), y
siembra la regla de alerta `trunk.failover`.
`0014_salas_reunion.sql` (1.10.0) amplía `pbxng_conferences` (`pin_mod`, `max_part`,
`moh_hasta_moderador`, `anunciar`, `grabar`, `agenda_inicio`, `agenda_min`, `aviso_cerrada`,
`invitados`, `invitado_at`) y le pone un PIN al azar a las salas viejas que no tenían: una sala
sin PIN que además ahora se puede moderar es una sala abierta a cualquiera que marque el número.
`0015_marcacion.sql` (1.10.0) crea `pbxng_disa`, `pbxng_callback`, `pbxng_dialbyname`,
`pbxng_abreviados` y `pbxng_marcacion_log`. **DISA y callback nacen con `enabled=false`**: una
actualización no enciende sola algo que gasta plata.
`0016_fax.sql` (1.10.0) crea `pbxng_fax_config` (singleton), `pbxng_fax_boxes`, `pbxng_fax_in` y
`pbxng_fax_out`. Los documentos van al disco (§7), no a un `bytea`.
`0017_callback_rutas.sql` (1.10.0) le agrega a `pbxng_callback` la columna `rutas` (jsonb, las
mismas ids de `pbxng_outbound_routes` que usa la DISA) **y apaga los callbacks en modo `pin` que
estuvieran encendidos**: ahí el destino lo ponía el CallerID de quien llamaba —que se falsea en
cualquier softphone— sin ninguna lista que lo acotara, y no hay forma de adivinar a qué rutas
quería restringirlo el administrador. Arranca en `'[]'`, así que los callbacks con lista blanca
no cambian de comportamiento.
`0011_telefonia_clasica.sql` (1.9.0) crea `pbxng_ext_features`, `pbxng_horarios`,
`pbxng_feriados` y `pbxng_featurecodes`, le agrega a `pbxng_inbound_routes` las columnas
`horario_id`, `dest_cerrado_type` y `dest_cerrado_value`, y siembra los 15 códigos de función
con `ON CONFLICT DO NOTHING` (no pisa un código ya editado).
`0010_soc.sql` crea `pbxng_blocked`, `pbxng_sec_events`, `pbxng_geoblock` (y `pbxng_f2b_whitelist`
si faltara) y **borra** `pbxng_fail2ban` / `pbxng_fail2ban_cmd` (nadie las llenaba).
Desde `0009_schema_runtime.sql` **ningún módulo crea tablas ni columnas en tiempo de
ejecución** (`app.js`, `ai-pipeline.js`, `push-providers.js` ya no traen `CREATE TABLE` /
`ADD COLUMN`); el esquema base de una instalación nueva lo sigue creando
`docker/config/initdb/01-schema.sql` y las migraciones completan lo que falte. Lo que queda en
el código son filas semilla (admin, empresa, `pbxng_rec_config` id=1, `pbxng_net` id=1, campos
de encuesta), idempotentes. Instalación sin Docker (`infra/systemd/pbxng-api.service`,
`ExecStart=node app.js`): hay que correr `node migrate.js` antes (p. ej. `ExecStartPre`); hoy
no rompe porque las tablas ya existen, pero la próxima migración no se aplicaría sola.

## 10. Red de seguridad de desarrollo

- `control-plane/`: `npm test` (`node --test test/*.test.js`, < 90 s) y `npm run lint` (`eslint .`,
  flat config en `eslint.config.js`, ESLint 10 + `@eslint/js` + `globals` como devDependencies).
  Hay dos clases de prueba en `test/`:
  - **unitarias con mocks** (`guard.test.js`): sin base ni Asterisk, corren siempre.
  - **de integración** (`auth`, `rbac`, `users`, `trunks`, `sbc-link`, `calls`, `telefonia`,
    `marcacion`, `salas`, `ccreport`, `fax`, `fax-barrido` `.test.js`; 102 pruebas en total con
    `guard.test.js`, ~51 s):
    levantan la API REAL (`app.js` como proceso hijo en un puerto libre, `JWT_SECRET` de
    prueba, `ADMIN_DEFAULT_PASS=admin`, ARI/AMI/agente apuntando a puertos cerrados de
    loopback, `CONF_DIR`/`REC_DIR`/`VM_DIR`/`BACKUP_DIR` en un temporal) contra un
    **PostgreSQL efímero** con el esquema de una instalación nueva (`01-schema.sql` +
    `node migrate.js`, el mismo camino que `docker-entrypoint.sh`). El ayudante es
    `test/helpers/db.js` (`entorno(t)` → `{db, api, cerrar}`; `api.api(método, ruta,
    {body, token})`, `api.login(usuario, clave)`, `db.query(sql, params)`). De dónde sale
    la base, en este orden: (1) `PGURL` o `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASS`/`DB_NAME`
    del entorno (la CI; también un desarrollador con Postgres a mano) → crea una base
    `pbxng_t_<azar>` por archivo de prueba en ese servidor y la borra al final (el usuario
    necesita `CREATEDB`; si no se llama `pbxng`, el `OWNER TO pbxng` del dump se reescribe
    a ese usuario); (2) sin nada en el entorno, `initdb`/`pg_ctl` locales
    (`/usr/lib/postgresql/<v>/bin`, Homebrew, `PATH` o `PG_BIN=/ruta/bin`) → clúster
    propio en un temporal, puerto al azar, usuario `pbxng` con `trust`, apagado y borrado
    al terminar; como root se baja a `postgres`/`nobody` con `setpriv`/`runuser`/`su`
    (initdb no corre como root); (3) nada de eso → el archivo se marca **skip** con el
    motivo (nunca falla por falta de infraestructura). Cada archivo tiene su propia base y
    su propia API, así que `node --test` puede correrlos en paralelo. Depuración:
    `TEST_API_VERBOSE=1` vuelca el log de la API hija; `TEST_API_LOG_LEVEL=debug` sube su
    nivel. Instalación local: `apt install postgresql-16` (Debian/Ubuntu) o `brew install
    postgresql@16`; no hace falta que el servicio esté corriendo.
  El lint sólo corta por errores reales (`no-undef`, `no-dupe-keys`, `no-unreachable`,
  `no-cond-assign` sin paréntesis…); `no-unused-vars`, `no-empty` y `no-useless-assignment`
  son avisos y el estilo no se lintea. Todo cambio en `control-plane/*.js` debe dejar
  `npm run lint` en 0 errores. ESLint 10 exige Node `^20.19 || ^22.13 || >=24` (la CI usa 22;
  con un Node 18 o 20.x viejo el lint no arranca, `npm test` y `npm start` sí).
- `dashboard/`: `npm run lint` (`next lint`, `.eslintrc.json` con `next/core-web-vitals`;
  Next 14 no acepta flat config). `next build` corre ese lint y falla con errores
  (`react/jsx-no-undef`, `react-hooks/rules-of-hooks`…); los `react-hooks/exhaustive-deps`
  quedan como avisos.
- CI (`.github/workflows/ci.yml`, dueño `empaquetado`): en push a `main`, en PR y como primer
  job de `release.yml` (`needs: ci`, un tag con la CI roja no publica). Jobs: `api` (Node 22,
  `npm ci`, lint, `npm test` contra `postgres:16-alpine` efímero con `DB_HOST=127.0.0.1
  DB_PORT=5432 DB_USER=pbxng DB_PASS=pbxng_test DB_NAME=pbxng_test`, `PGURL` equivalente y
  `JWT_SECRET` de prueba; el test de integración aplica `01-schema.sql` + `node migrate.js`
  él mismo), `dashboard` (`npm ci`, lint, `next build` con `API_URL` de relleno), `compose`
  (`check-compose-parity.sh` + `docker compose config -q` de ambos), `shell` (`bash -n` de
  todos los `.sh` y `pbxng-ctl`, `py_compile` de los agentes). Detalle en `docs/PACKAGING.md`
  §CI.
