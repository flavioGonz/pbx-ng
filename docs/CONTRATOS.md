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
- Roles: `admin` (todo), `supervisor` (operación + call center, sin configuración de sistema),
  `agente` (solo su panel de agente y su extensión). **Regla desde 1.4.0:** el middleware de
  `control-plane/rbac.js` (montado en `/api` justo después del gate de auth) decide por
  método+ruta qué roles pasan; lo que no está en la tabla es `admin` por defecto. Rechazo:
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
  | `clients/lookup` | GET | TODOS | screen-pop |
  | `survey/fields` · `survey` | GET · POST | TODOS | encuesta post-llamada |
  | `calls/*` (live, `:id/hangup|hold|unhold`, spy…) | * | SUP | |
  | `channels`, `wallboard` | GET | SUP | |
  | `queues` · `queues/:n/live` | GET | SUP | |
  | `queues/:n/members` · `queues/:n/members/:ext` | POST · DELETE | SUP | meter / sacar agentes de una cola |
  | `cdr/report` | GET | SUP | |
  | `recordings` · `recordings/:id/transcript|peaks` · `recordings/:id/transcribe` | GET · GET · POST | SUP | |
  | `clients`, `persons`, `spaces`, `devices` (y subrutas) | * | SUP | CRM completo (`crmWrite` ya limitaba la escritura) |
  | `intercom/clients`, `intercom/streams` | GET | SUP | |
  | `survey/*` | * | SUP | |
  | `extensions`, `tenants`, `metrics` | GET | SUP | |
  | `provision` | GET | SUP | config completa de un teléfono |
  | `enrollments` · `enroll`, `enroll/email` | GET · POST | SUP | enrolar un interno / mandar el QR por correo |
  | `phones` | GET | SUP | |
  | Todo lo demás | * | admin | users, settings, trunks, routes, sbc-link, modules (escritura), backup, asterisk, net, system, turn, acme, npm, integrations, branding (escritura), extensions/endpoints (escritura), ivr, queues/ringgroups (escritura), recordings (borrado y almacenamiento), vm/email, security, email, voz, prompts, sysprompts, capture, sip, db, manuales, c2c, alerts, geo, push/devices… |

  El RBAC no aplica a rutas públicas (sin `req.user`) ni a tokens `scope:'phone'` (van por
  `FONO_PERMITIDO`). Nota para el panel: `GET /api/geo` (pantalla `/mapa`) y `GET /api/settings`
  (`/telefonos`) son `admin` aunque `SUP_OK` del shell los liste; hoy no rompe porque el
  supervisor nunca ve el shell (auth.jsx lo manda a `/supervisor`).
- Usuarios (`/api/users`, solo admin): rol por defecto al crear = `agente`; `role` ∈
  `{admin, supervisor, agente}`; contraseñas de 8+ caracteres; no se puede borrar el propio
  usuario ni el último `admin`.
- Cambio de clave propia: `POST /api/auth/password` `{ current, password }` (mínimo 8). `current`
  es obligatorio salvo en el primer ingreso (`must_change: true` en el login), donde el panel no
  lo pide. La clave de OTRO usuario se cambia por `POST /api/users/:id/password` (solo `admin`).
- Panel ante 401: borra la sesión y va a `/login`. Ante 403: no redirige, muestra un toast con el
  `error` del JSON (dedupe de 3 s) y le deja el body intacto a la página.
- Estado degradado en el panel (`app/shell.jsx`): banner rojo "Base de datos sin respuesta" si el
  `snapshot` del socket trae `health.db=false` o, con el socket caído, si `GET /backend/health`
  (→ `/health` de la API) responde 503 o `db:false`; ese poll corre cada 30 s **sólo** mientras
  el socket está desconectado. El menú del shell se
  filtra por rol (`app/shell.jsx`, `SUP_OK`) como espejo de `rbac.js`.
- Token de softphone: `POST /api/phone/token` → JWT `{scope:'phone', ext}` (30 d). Mismo rate
  limit que el login (por IP+ext). Solo puede lo que lista `FONO_PERMITIDO` en `app.js`, y
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
- Rutas públicas (sin token) = exactamente `PUBLIC_API` en `app.js`. Hoy: `auth/login`,
  `phone/token`, `auth/setup`, `ice`, `branding`, `enroll/:token`, `prompts/:id/audio`,
  `push/vapid`, `push/(subscribe|register|unsubscribe)`, `internal/wake`, `c2c/public/*`,
  `softphone/latest`, `geo/report`, `manuales/img/*`.

## 3. API HTTP (`/api`, servida por control-plane :3000; el panel la ve en `/backend/api`)

272 rutas. Familias y su dueño funcional en el panel:

| Familia | Para qué | Pantalla |
|---|---|---|
| `auth`, `users`, `me` | sesión, usuarios, cambio de clave | `/login`, `/usuarios` |
| `extensions`, `endpoints`, `directory`, `presence` | internos y presencia | `/internos` |
| `trunks`, `routes`, `sbc-link` | troncales, rutas entrantes/salientes, conexión a SBC-NG | `/troncales`, `/rutas`, `/sbc` |
| `queues`, `ringgroups`, `paging`, `ivr`, `ai-agents`, `featurecodes`, `parking`, `moh`, `mailboxes`, `vm` | aplicaciones | `/aplicaciones/*`, `/funciones`, `/ivr` |
| `calls` | control de llamadas (dial, hangup, hold, transfer, park, spy, live) | agente, supervisor, monitor |
| `recordings`, `cdr` | grabaciones e historial | `/grabaciones`, `/cdr` |
| `clients`, `survey` | CRM propio | `/clientes` |
| `asterisk`, `net`, `sip`, `capture`, `system`, `topology`, `metrics` | núcleo, red, diagnóstico | `/asterisk`, `/red`, `/topologia`, `/` |
| `sipconf` | ajustes SIP de la central (NAT, RTP, timers, TLS, códecs por defecto; sólo admin) | Configuración → SIP |
| `turn`, `ice`, `acme`, `npm` | WebRTC/TURN, certificados, proxy | Configuración |
| `modules`, `settings`, `branding`, `integrations`, `alerts`, `email` | configuración | `/configuracion` |
| `backup` | respaldo y restauración; `backup/schedule` (GET → `{enabled, hour, keep, last_run, last_ok, last_error, last_nombre, running, tz}`, POST `{enabled, hour, keep}` con `hour` entero 0–23, `keep` entero ≥ 1, `enabled` booleano, cada campo opcional, `400 {error}` si no valida; devuelve el estado nuevo. Se guarda en `pbxng_settings` (`backup_enabled` default `1`, `backup_hour` default 3, `backup_keep` default `BACKUP_KEEP`/14, `backup_last_run|ok|error|nombre`). Un planificador interno de la API revisa cada minuto: si está activo, es esa hora (reloj local del contenedor, `tz`) y hoy no hay marca `backup_last_run`, corre `backup.programado()` (crear sin grabaciones + retención). El cron del host (`backup-cli.js`) escribe las mismas claves, así que ninguno repite el del otro. El panel tolera 404 en versiones sin el endpoint) | `/respaldos` |
| `push`, `c2c`, `enroll`, `phones`, `provision` | PWA, click-to-call, aprovisionamiento | varios |
| `voz`, `prompts`, `sysprompts` | TTS/STT y audios | `/voz`, `/ia-voz` |
| `softphone` | instalador y feed OTA del softphone | login |
| `manuales` | manuales in-panel | `/manuales` |

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
- Handshake con `auth.token` = JWT de panel. Sala `state` recibe `snapshot` (`{ts, health:{db,ari,ami},
  extensions, channels, queues}`) al conectar, en cada evento relevante (debounce 300 ms) y cada
  15 s como reconciliado.
- Pizarra de videollamada: eventos `scratch:join|leave|op|clear` por sala. **Desde 1.4.0 exige
  un JWT válido**: `auth.token` (panel) o `auth.scratch` (token de softphone, scope `phone`);
  `scratch: true` a secas ya no alcanza. Un token `phone` (venga en `token` o en `scratch`)
  queda `scratchOnly`: no entra a la sala `state` ni recibe `snapshot`.

## 5. Asterisk ↔ API

- ARI (`:8088`, app Stasis `pbxng`, `subscribeAll`): eventos de canales/endpoints → cache del
  motor de llamadas; `Stasis(pbxng,ai,<agentId>)` para IVR con IA; `spysnoop,<id>` /
  `spyjoin,<id>` para supervisión. AMI (`:5038`): acciones (Originate, Redirect, MixMonitor,
  QueuePause, Command…) y eventos. AudioSocket: la API escucha en `:9092`.
- Config generada por el panel: `pbxng.d/{parking,features,moh,pjsip,rtp}.conf` (volumen `asterisk_conf`)
  incluida por `#include` desde los `.conf` base. Dialplan de aplicaciones: tabla realtime
  `extensions`. Contextos: `from-trunk` (entrantes), `internal` (internos), `ivr`, `c2c`.

## 6. Variables de entorno (`.env` del compose)

`DOMAIN PUBLIC_IP TENANT_MODE DEFAULT_COMPANY` · `DB_HOST DB_PORT DB_NAME DB_USER DB_PASS` ·
`ARI_USER ARI_PASS AMI_USER AMI_PASS JWT_SECRET ADMIN_DEFAULT_PASS` · `ASTERISK_HOST MEDIA_HOST
TURN_HOST VOZ_HOST NPM_HOST AST_AGENT TURN_AGENT` · `TURN_USER TURN_PASS TURN_CLI_PASS
TURN_REALM` · `API_URL` (el dashboard lo lee al arrancar, `server.js`; ya no se fija en el build) · `SOFTPHONE_DIR` (opcional) ·
`COMPOSE_PROFILES` (módulos activos) · `GO2RTC_MGMT` (intercom, default `http://go2rtc:1984`)
· `ENROLL_REUSE_SECONDS` (opcional, default 120) · `LOG_LEVEL` (`debug|info|warn|error`,
default `info`; **ojo:** `LOG_LEVEL`, `LOG_FORMAT`, `PG_POOL_MAX`, `PG_STATEMENT_TIMEOUT_MS`,
`CORS_ORIGINS` y `TZ` los lee la API de su entorno, pero en 1.5.0 ningún compose los reenvía
desde el `.env` al servicio `api`: para cambiarlos en producción hay que agregarlos al
`environment:` del servicio — pendiente de `empaquetado`) · `LOG_FORMAT` (`json` default, `text` para desarrollo) · `PG_POOL_MAX`
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
como `--keep=N`) · `TZ` (opcional; la hora del respaldo programado interno se compara con el
reloj del contenedor de la API, que sin `TZ` es UTC: el campo `tz` de `backup/schedule` dice
cuál está usando) ·
`PBXNG_COMPOSE_FILE` (qué compose usa la instalación, lo fija `install.sh`; lo leen
`pbxng-ctl` y `backup-cron.sh`, no los contenedores) · `DASHBOARD_BIND` (interfaz del host
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
cron usa la hora local del host y el planificador la del contenedor (UTC sin `TZ`), en un host
con zona distinta de UTC pueden caer en momentos distintos del mismo día y salir DOS respaldos
diarios (la retención se consume al doble): fijar `TZ` en el servicio `api` o apagar uno de
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
**No** se publican `6379` (Redis ya no existe), `5038`, `8088` (Asterisk en host network expone
8088: la API ARI debe atarse a `127.0.0.1` o protegerse por firewall — pendiente, ver
evaluación). Pendiente: AudioSocket de la IA (`:9092` de la API) tampoco está publicado, así
que Asterisk no llega al pipeline de voz desde compose (ver evaluación).

## 9. Versionado

`VERSION` + `CHANGELOG.md` (SemVer). Tag `vX.Y.Z` → imágenes a GHCR. Tag `softphone-vX.Y.Z` →
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
Desde `0009_schema_runtime.sql` **ningún módulo crea tablas ni columnas en tiempo de
ejecución** (`app.js`, `ai-pipeline.js`, `push-providers.js` ya no traen `CREATE TABLE` /
`ADD COLUMN`); el esquema base de una instalación nueva lo sigue creando
`docker/config/initdb/01-schema.sql` y las migraciones completan lo que falte. Lo que queda en
el código son filas semilla (admin, empresa, `pbxng_rec_config` id=1, `pbxng_net` id=1, campos
de encuesta), idempotentes. Instalación sin Docker (`infra/systemd/pbxng-api.service`,
`ExecStart=node app.js`): hay que correr `node migrate.js` antes (p. ej. `ExecStartPre`); hoy
no rompe porque las tablas ya existen, pero la próxima migración no se aplicaría sola.
