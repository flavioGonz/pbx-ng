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
  `error` del JSON (dedupe de 3 s) y le deja el body intacto a la página. El menú del shell se
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
| `backup` | respaldo y restauración | `/respaldos` |
| `push`, `c2c`, `enroll`, `phones`, `provision` | PWA, click-to-call, aprovisionamiento | varios |
| `voz`, `prompts`, `sysprompts` | TTS/STT y audios | `/voz`, `/ia-voz` |
| `softphone` | instalador y feed OTA del softphone | login |
| `manuales` | manuales in-panel | `/manuales` |

Convenciones: JSON siempre; errores `{ error: '<mensaje en español para el usuario>' }` con
el status HTTP correcto (400 validación, 401 sin sesión, 403 sin permiso, 404, 409, 500). Los
mensajes crudos de PostgreSQL no se devuelven al cliente. `Cache-Control: no-store` en todo `/api`.

## 4. Tiempo real (socket.io en `/socket.io`, mismo origen vía el proxy)

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
· `ENROLL_REUSE_SECONDS` (opcional, default 120) · `DASHBOARD_BIND` (interfaz del host
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
release del softphone. Cambios de esquema = `control-plane/migrations/000N_*.sql`; `deploy.sh`
las corre; el arranque de la API también debe correrlas (pendiente, ver evaluación).
