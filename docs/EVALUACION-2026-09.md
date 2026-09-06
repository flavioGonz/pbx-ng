# PBX-NG · Evaluación completa del sistema (septiembre 2026)

Estado evaluado: `main` en 1.3.1 (2026-09-04), después de retirar el SBC embebido, sumar el módulo
«Conexión a SBC-NG», el motor de llamadas ARI y la distribución OTA del softphone. La evaluación
se hizo leyendo el código completo (control-plane 6.800 líneas en 17 archivos, dashboard 12.400
líneas en 91 archivos, empaquetado y configuración de Asterisk) y contrastando contra la
instalación real de pbx01. Cada afirmación tiene archivo y línea; los números son medidos, no
estimados.

> **Actualización 1.4.0 (2026-09-05, sprint 1 de seguridad):** los ítems marcados con **✅ 1.4.0**
> quedaron resueltos en esa versión (ver `CHANGELOG.md` y `docs/CONTRATOS.md`). El texto original
> se conserva tal cual como registro de lo que había. Lo mismo para **✅ 1.5.0** (robustez) y
> **✅ 1.6.0** (centro de seguridad real sobre Asterisk + nftables).

## 1. Qué es hoy, en una frase

Una central Asterisk 22 con panel propio en tiempo real, WebRTC nativo, softphone de escritorio
con OTA, IVR con IA, call center (colas, agente, supervisor), CRM, intercom de video, respaldo y
restauración desde el panel, alertas por correo, manuales in-panel, y un empaquetado por módulos
con imágenes versionadas. Es mucho producto para el tamaño del equipo, y la mayoría de las
decisiones de dominio telefónico están bien tomadas. Lo que le falta no es funcionalidad: es
disciplina de producción — control de acceso por rol, pruebas, operación desatendida y
consistencia entre el modo de desarrollo y el de entrega a clientes.

## 2. Fortalezas

**Criterio telefónico.** La configuración WebRTC de los endpoints es completa y correcta
(`app.js:2569`: DTLS, ICE, AVPF, rtcp-mux, `rewrite_contact`, `force_rport`), el dialplan separa
`from-trunk` de `internal` con `exten => i` que cuelga (`extensions.conf:11-19`), RFC 5626 con
`keep_alive_interval=30` para NAT, DTMF por extensión para porteros, buzón activado por defecto,
326 prompts en español rioplatense generados por el TTS propio. Está hecho por alguien que sabe
dónde duelen las centrales.

**Seguridad de base sólida donde se aplicó.** Cero inyección SQL en 272 endpoints (todo
parametrizado; los tres casos con interpolación usan listas literales o validan con regex), cero
`exec` con shell (solo `execFile`/`spawn` con arreglos), path traversal cerrado en las cinco
superficies (grabaciones, buzón, respaldos, manuales, MoH), gate de autenticación
*deny-by-default* con allowlist explícita (`app.js:504`), token de softphone con alcance mínimo
(`FONO_PERMITIDO` + `mismaExt`), secretos enmascarados en las lecturas con *preserve-on-empty*,
cero `dangerouslySetInnerHTML` en el panel, cabeceras `X-Frame-Options`/`nosniff`/`Referrer-Policy`.

**Instalador y secretos.** `install.sh` genera todos los secretos con `openssl`, detecta y
regenera placeholders débiles, aborta si queda algo débil, deja `.env` con `chmod 600`, imprime
exactamente qué puertos abrir según los módulos activos, y verifica el TURN de verdad (STUN
Binding + Allocate + candidato relay) en vez de un ping.

**Operación pensada desde incidentes reales.** `salud.js` mide puertos TCP reales con caché de
8 s (documenta el día que el borde estuvo caído medio día con el panel en verde); `Cache-Control:
no-store` en `/api` documenta el proxy que cacheaba grabaciones; `backup.js` hace `pg_dump`
lógico con manifiesto SHA-256, valida formato y excluye credenciales; `alerts.js` tiene reglas en
base, dedupe, severidades y detección de login desde IP nueva; `registersw.jsx` no recarga si hay
una llamada en curso.

**Resiliencia de I/O.** Timeout explícito en prácticamente toda llamada de red (`AbortSignal.
timeout` en 15+ `fetch`, `{timeout}` en todos los `execFile`, sockets con `setTimeout`).
Transacciones correctas: 35 `pool.connect()` ↔ 35 `BEGIN` con `finally { release() }`. AMI y
ahora ARI reconectan solos.

**Empaquetado como producto.** Módulo = perfil = contenedor (`pbxng-ctl` con `enable/disable/
reconcile`), imágenes versionadas, migraciones SQL transaccionales con checksum, bundle
air-gapped, CI que publica a GHCR y el instalador del softphone como release. El repo es la única
fuente de verdad y hoy coincide con producción.

**Arquitectura ya limpia de lo que no es suyo.** Tras 1.3.0 el SBC es otro producto y la central
no lo supone en ningún lado; un solo punto de verdad (`sbcLink()`) gobierna todo lo que depende
de él.

## 3. Debilidades

Ordenadas por lo que más puede costar. Las cinco primeras son de seguridad y hay que cerrarlas
antes de vender el producto a un tercero.

**3.1 No hay control de acceso por rol.** ✅ 1.4.0 — `control-plane/rbac.js`: tabla única
deny-by-default montada en `/api` antes de cualquier ruta (callengine incluido); rol por defecto
`agente` y validado; clave propia exige la actual; agente acotado a su extensión; `DELETE` no
borra el propio usuario ni el último admin. Sigue sin haber registro de auditoría (bloque 4+). ·
272 endpoints y solo 4 chequean rol (`app.js:559`,
`2236`, `3492` y `mismaExt`). El gate global solo verifica que el JWT sea válido. Con un token de
`agente`: `POST /api/users` crea usuarios y **el rol por defecto es `admin`** (`app.js:2210`);
`POST /api/users/:id/password` resetea la clave de cualquier usuario sin pedir la actual
(`2218`); `POST /api/backup/:nombre/restaurar` ejecuta un `psql -f` con un tarball subido por el
mismo agente (`3308`, `3319`, `backup.js:226`) — SQL arbitrario sobre toda la base;
`/api/calls/spy` permite escuchar, susurrar o irrumpir en cualquier llamada
(`callengine.js:165`: `need(b.sup)` valida presencia, no rol); `/api/recordings` y
`/api/recordings/:id/audio` listan y bajan todas las grabaciones; `/api/settings`, `/api/trunks`,
`/api/net/mode/apply`, `/api/db/maintenance`, `/api/security/whitelist` sin rol. Un agente es
administrador en un POST. No hay registro de auditoría de nada de esto.

**3.2 El enlace de enrolamiento entrega una sesión de panel.** ✅ 1.4.0 — `apiToken` de
enroll y de `/api/provision` es un token `scope:'phone'`; el token de enrolamiento es de un solo
uso (`used_at` + `ENROLL_REUSE_SECONDS`, 410 después). · `GET /api/enroll/:token` es
público y devuelve la clave SIP en claro, las credenciales TURN y un `apiToken` de 30 días
firmado **con el rol real del usuario** (`app.js:792`). Si el interno es de un admin, el QR de
aprovisionamiento es una sesión de administrador por un mes. El token de enrolamiento cuenta usos
pero no los limita (`758`): es reutilizable hasta que vence.

**3.3 Login sin límite de intentos y con bcrypt síncrono.** ✅ 1.4.0 — `express-rate-limit`
doble (10/10 min por IP+usuario, 50/10 min por IP) en login y `phone/token`, `trust proxy = 1`
con `req.ip` (el panel arma `X-Forwarded-For` en `dashboard/server.js`), bcrypt asíncrono. · `POST /api/auth/login`
(`app.js:531-544`) no tiene rate limit; `bcrypt.compareSync` bloquea el event loop ~90 ms por
intento, así que un ataque de fuerza bruta moderado también tumba la API. `clientIp()` confía en
`X-Forwarded-For` sin `trust proxy` (`527`), por lo que cualquier limitador por IP que se agregue
es falsificable con un header. El limitador correcto ya existe para el softphone
(`FONO_INTENTOS`); no se aplicó al panel.

**3.4 El compose de release —el que va a clientes— pierde datos.** ✅ 1.4.0 — release espejo
exacto del canónico (volúmenes, `NET_ADMIN`, `recordings` rw, go2rtc) y `check-compose-parity.sh`
en `release.sh` y en la CI. · `docker-compose.release.yml`
no declara los volúmenes `respaldos`, `voicemail`, `certs` ni `asterisk_conf` que sí tiene el
compose de desarrollo, no da `NET_ADMIN` a Asterisk y monta `recordings` como `:ro` en la API.
Consecuencias en un despliegue de cliente: los respaldos van a la capa efímera y desaparecen al
recrear el contenedor, los buzones de voz también, los certificados ACME no persisten, y el
aparcado/captura/MoH que el panel genera en `pbxng.d/` nunca llega a Asterisk. pbx01 no lo sufre
porque corre el compose de desarrollo.

**3.5 Superficie de red del appliance.** Parcial en 1.4.0: ✅ Redis retirado del stack, ✅ 5432
y 3000 sólo en `127.0.0.1` del host, ✅ `scratch` atado a un JWT válido, ✅ `:3001` en loopback
cuando NPM corre en el mismo compose. ✅ 1.5.0 `origin:'*'` del socket reemplazado por mismo
origen / `CORS_ORIGINS`. ✅ 1.7.0 ARI/AMI (`8088`/`5038`) sólo desde redes privadas por nftables
(`pbxng-mgmt` en `inet pbxng`, ajustable con `/etc/pbxng/fw.json`; `bindaddr` sigue en `0.0.0.0`
porque la API llega por el bridge de Docker) y token del agente en todo POST y en los GET de
configuración. Lo que sigue describe el estado previo. · `http.conf` expone ARI y el WebSocket SIP en HTTP plano
sobre `0.0.0.0:8088` del host (Asterisk va en `network_mode: host`): las credenciales ARI viajan
en Basic Auth sin cifrar y ARI es control total de la central. Redis se publica en `6379` sin
`requirepass` en el compose de desarrollo y **la API no lo usa** (única mención: un nombre en
`sysmon.js`). Postgres se publica en `5432` en ambos compose. Docker inserta sus reglas por
delante de UFW: la advertencia de `install.sh` («nunca publicar 5432/6379/3000/8088») la
incumple el propio compose. Socket.io con `origin:'*'` y un bypass `scratch` sin token que
permite unirse a cualquier pizarra de videollamada (`app.js:3376-3386`).

**3.6 Fail2ban es una pantalla sin servicio.** ✅ resuelto en 1.6.0 — `control-plane/guard.js`
consume los eventos de seguridad de Asterisk por AMI (`res_security_log`), cuenta fallos por IP,
banea vía el agente de Asterisk en **nftables del host** (`/fw/*`, tabla `inet pbxng`), con
lista blanca, geo-bloqueo, alertas y registro en vivo; `POST /api/security/apply` escribe
`unidentified_request_*` en `pbxng.d/pjsip-security.conf`; la migración 0010 borra las tablas
de fail2ban. `acl.conf` sigue vacío (el corte lo hace nftables, no Asterisk). · El panel de Seguridad, las alertas y la API leen
jaulas de un fail2ban que ninguna imagen instala (`images/asterisk/Dockerfile`: cero
referencias). `acl.conf` está vacío y `pjsip.conf` no define `unidentified_request_count`. La
central no tiene protección real contra fuerza bruta SIP mientras el panel transmite lo contrario.

**3.7 Sin pruebas, sin lint, sin tipos.** ✅ resuelto en 1.7.0 en lo esencial (bloque 5 de §5): ESLint en
API y panel, 36 pruebas (`guard.test.js` con mocks desde 1.6.0 + integración contra Postgres
efímero), CI en GitHub Actions como puerta del release, y `app.js` partido en `auth.js`, `trunks.js`,
`recordings.js`, `apps.js` (≈2.200 líneas quedan). Siguen: sin tipos, sin Prettier, sin e2e del
panel, los `catch` vacíos. Lo que sigue describe el estado previo. Cero tests en todo el repositorio (control-plane,
dashboard, softphone). Cero ESLint/Prettier. `app.js` tiene 3.668 líneas (54 % del backend) con
líneas de hasta 1.322 caracteres y 262 endpoints; `app.js.orig` está commiteado. 97 `catch` vacíos
en el backend y 237 en el panel: los errores se tragan sin avisar. El panel no tiene ningún
`error.jsx`/`loading.jsx`: un throw en render deja la pantalla en blanco, y con la API caída
muestra datos viejos sin ninguna señal (resuelto en 1.5.0: `ErrorBoundary.jsx` dentro del shell,
`error.jsx`, `loading.jsx` y banner «Base de datos sin respuesta»; el resto de 3.7 sigue).

**3.8 Proceso sin red de seguridad.** ✅ resuelto en 1.5.0 (bloques 2 y 3 de §5): `pool.on('error')` ✅ 1.4.0 (loguea y el pool reconecta);
pool acotado, cierre ordenado, `/health` 503, healthchecks, `mem_limit` y rotación ✅ 1.5.0. Lo que sigue describe el estado previo. · `new Pool(CFG.db)` sin `max`, sin `statement_timeout` y
**sin `pool.on('error')`**: un cliente idle que falla (reinicio de Postgres) emite `error` sin
handler y el proceso muere. Cero handlers de `SIGTERM`/`unhandledRejection`: un `docker stop`
mata la API a los 10 s con transacciones abiertas y espías de ARI huérfanos. `/health` devuelve
200 aunque `db:false`, y el `HEALTHCHECK` usa `curl -f`: el contenedor se reporta sano con la
base caída. Solo 1 de 8 servicios tiene healthcheck (Postgres); ninguno tiene límite de memoria
ni rotación de logs.

**3.9 Esquema de base con dos verdades.** ✅ resuelto en 1.5.0 (`migrate.js` en el entrypoint, DDL de runtime movido a `0009_schema_runtime.sql`; `initdb` sigue siendo el baseline de una instalación nueva y las migraciones lo completan). Estado previo: `migrate.js` es correcto pero solo lo ejecuta
`deploy.sh` (flujo de release). El entrypoint hace `exec node app.js`, y el esquema real sale de
30 `CREATE TABLE IF NOT EXISTS` + 13 `ALTER TABLE` lanzados al importar el módulo, sin `await`,
mientras el servidor ya acepta tráfico (carrera en el arranque; `ACCESS EXCLUSIVE` en cada
reinicio). Las migraciones y el `initdb` divergen.

**3.10 Multi-tenant es decorativo.** `tenant_id` se escribe en 59 lugares y se filtra en 3
(config SMTP, con el tenant tomado del body, no de la sesión). El JWT no lleva tenant. En modo
multi-empresa, cada empresa ve y modifica la otra. Cerrarlo es refactorizar las 262 rutas, no un
parche.

**3.11 Sin respaldo automático ni monitoreo externo.** Respaldo programado ✅ 1.5.0 (planificador interno + cron opcional, retención) y logs estructurados ✅ 1.5.0 (`log.js`, JSON con niveles); sigue pendiente `/metrics` Prometheus. Estado previo: `backup.js` está bien, pero no hay
programación (ningún cron ni timer). No hay `/metrics` en formato Prometheus, ni trazas, ni logs
estructurados (52 `console.error` con prefijos a mano; la clave de admin por defecto se loguea en
claro, `app.js:647`). Si la central cae de madrugada, nadie se entera salvo por Uptime Kuma
externo.

**3.12 Sin Opus, con la UI ofreciéndolo.** El backend fija `ulaw,alaw,g722` en 6 puntos; Opus y
G.729 aparecen en tres selectores del panel pero nunca se escriben y la imagen de Asterisk no
trae `codec_opus`. Para una PBX WebRTC-first esto obliga a transcodificar cada llamada de
navegador y renuncia a la resistencia a pérdida de paquetes que Opus da en móviles. `rtp.conf`
depende de `stun.l.google.com` en un producto que se vende air-gapped.

**3.13 Panel: deuda mecánica.** 265 URLs `/backend/...` sueltas en 60+ archivos, sin capa de API;
la autenticación es un monkey-patch de `window.fetch` (`auth.jsx:8-30`) que falla con `Request`
de URL absoluta y que deja que el JWT de admin viaje desde la vista `/phone`. JWT y **credenciales
SIP en claro** en `localStorage` (`useSoftphone.js:190`) sin CSP de `script-src`. 46 `setInterval`
(varias páginas con tres timers a la vez) conviviendo con un socket.io degradado a long-polling.
7 implementaciones de `fmtDur` con formatos distintos, 3 listas de códecs divergentes. Service
worker que declara caché y nunca la usa (el modo offline es código muerto). Accesibilidad: 11
`aria-*` en 12.400 líneas y 22 `div` clicables sin teclado. Cero i18n.

**3.14 Actualizar corta las llamadas.** `docker compose up -d` recrea contenedores sin
`stop_grace_period` ni drenado. No hay rollback más allá de cambiar `PBXNG_VERSION` a mano ni
migraciones inversas. `nginx-proxy-manager:latest` y `go2rtc:latest` sin fijar.

## 4. Qué le falta para ser completa

Como producto, hay pocas funciones de central que no tenga. Lo que falta está en los bordes:

- **Transferencia atendida** por API y desde el softphone (hoy solo a ciegas), **grabación bajo
  demanda por ARI** con estado, **eventos de cola por ARI** para el wallboard, y sobre esa base la
  **IA en vivo**: transcripción en tiempo real y resumen post-llamada por `externalMedia`,
  coaching susurrado al agente, y **webhooks/CTI** (screen-pop al CRM propio o a uno externo)
  alimentados por los mismos eventos. Es la etapa 2 del motor de llamadas ya empezado.
- **Opus** en la imagen y en los endpoints WebRTC; **TLS para SIP** con certificado provisto (el
  transporte 5061 apunta a un certificado que nada aprovisiona) y **HTTPS/WSS en ARI** o, al
  menos, ARI atado a `127.0.0.1` (1.7.0: loopback no alcanza porque la API está en bridge; se
  optó por restringir `8088`/`5038` a redes privadas con nftables. HTTPS/WSS en ARI sigue
  pendiente).
- **Auditoría**: quién cambió una troncal, quién descargó una grabación, quién escuchó una
  llamada. Hoy no queda registro.
- **Respaldo programado** con retención y verificación de restauración, y **métricas Prometheus**
  (requests, latencia, pool, llamadas, colas) con un dashboard Grafana de referencia.
- **Multi-tenant real** si se va a vender como SaaS; si no, quitar el modo del instalador para no
  prometer lo que no aísla.
- **Softphone**: firma de código (hoy el instalador Windows no está firmado: SmartScreen lo
  frena), y una versión macOS/Linux si el mercado la pide.
- **Manuales**: faltan capturas en varios capítulos; y documentación de API (OpenAPI) para
  integradores.

## 5. Qué le falta para ser robusta

En orden de ejecución sugerido. Los tres primeros bloques son días, no semanas.

**Bloque 1 — cerrar los agujeros de acceso (antes de cualquier venta).** ✅ 1.4.0 (todo salvo el
origen del socket). Middleware de rol
(`soloAdmin`, `adminOSupervisor`) aplicado por defecto a todo `/api` de escritura y a las lecturas
sensibles (grabaciones, usuarios, settings, respaldos, spy) ✅ 1.4.0 (`rbac.js`, tabla
deny-by-default por método+ruta en vez de dos middlewares); `role` en `POST /api/users` sin
default y validado contra la lista ✅ 1.4.0 (default `agente`, el menos privilegiado, y validado);
cambio de clave que exija la actual (o rol admin) ✅ 1.4.0; `enroll`
que entregue un token de alcance `phone`, nunca uno de panel, y de un solo uso ✅ 1.4.0; rate limit en
login (`express-rate-limit` + bcrypt asíncrono) con `trust proxy` configurado ✅ 1.4.0; `helmet`
✅ 1.4.0; socket.io
con origen restringido (pendiente: sigue `origin:'*'`, menor con el JWT obligatorio) y el bypass
`scratch` atado a un token ✅ 1.4.0; abortar el arranque si
`JWT_SECRET` es el placeholder ✅ 1.4.0 (también vacío o de menos de 16 caracteres).

**Bloque 2 — que el release no pierda datos.** Igualar `docker-compose.release.yml` al canónico
(volúmenes, `NET_ADMIN`, `recordings` rw) ✅ 1.4.0, y un test de CI que compare ambos compose para que no
vuelvan a divergir ✅ 1.4.0 (`docker/check-compose-parity.sh`). Sacar Redis del stack (no se usa) ✅ 1.4.0
o autenticarlo y no publicarlo; dejar de
publicar 5432 ✅ 1.4.0 (queda en `127.0.0.1` del host para Asterisk, igual que 3000). Healthchecks en los 8 servicios ✅ 1.5.0 (cada uno con la herramienta que trae su imagen; el de la API pega a `/health/ready`), `mem_limit` ✅ 1.5.0 (`MEM_*` en `.env`, sin swap), rotación de logs ✅ 1.5.0 (json-file 10 MB × 5), `stop_grace_period`
para Asterisk ✅ 1.5.0 (60 s; api 20 s) y drenado antes de recrear ✅ 1.5.0 (`docker/asterisk-drain.sh`, lo llaman `pbxng-ctl` y `deploy.sh` sólo si el `up -d` recrea asterisk). Respaldo programado ✅ 1.5.0 (planificador interno de la API con pantalla en `/respaldos`, más cron del host opcional con `backup-cli.js`; retención sólo de los `pbxng-auto-*`). Queda para después: verificación automática de la restauración (§4).

**Bloque 3 — que el proceso no muera solo.** ✅ 1.5.0 (completo). `pool.on('error')` ✅ 1.4.0, `max`/`statement_timeout` ✅ 1.5.0 (`PG_POOL_MAX`, `PG_STATEMENT_TIMEOUT_MS`, timeouts de conexión e idle),
`SIGTERM` con cierre ordenado (cerrar espías ARI, esperar transacciones) ✅ 1.5.0 (`cerrarOrdenado`: 10 s de espera al pool, tope duro de 15 s; `unhandledRejection` logueado), `/health` que devuelva
503 si la base no responde ✅ 1.5.0 (también `/health/ready`, que usan el compose y el Dockerfile), esquema creado por migraciones al arrancar (correr `migrate.js` en el
entrypoint y retirar los `CREATE TABLE` del módulo) ✅ 1.5.0 (`docker-entrypoint.sh` + `0009_schema_runtime.sql`; cero DDL en runtime), middleware de error de Express que no filtre
mensajes de Postgres ✅ 1.5.0 (`errores.js`; quedan 8 `catch` con `status(400).json({error:e.message})` en rutas admin/supervisor, menor), logger con niveles y formato JSON ✅ 1.5.0 (`log.js`, `LOG_LEVEL`/`LOG_FORMAT`).

**Bloque 4 — fail2ban de verdad y endurecimiento de Asterisk.** ✅ 1.7.0 (todo salvo STUN y la
clave del buzón). Instalar fail2ban en la imagen (o
un vigía propio sobre el canal `security` que ya se emite) y que el panel muestre lo que existe
✅ 1.6.0 (vigía propio: `guard.js` sobre los eventos de seguridad del AMI + nftables en el host
por el agente de Asterisk; el panel `/seguridad` muestra sólo lo que existe, incluido si el
firewall está aplicando o no);
`unidentified_request_*` en `pjsip.conf` ✅ 1.6.0 (`pbxng.d/pjsip-security.conf`, editable desde
Seguridad → Ajustes de la central). `*97` con `CHANNEL(endpoint)` y
`*98` siempre con clave ✅ 1.7.0; `URIENCODE` en el `CURL` del wake ✅ 1.7.0 (+ `require` de
`func_curl`/`func_uriencode` en `modules.conf`); ARI/AMI (`8088`/`5038`) sólo desde
redes privadas por nftables (`pbxng-mgmt`, `fw.json`) ✅ 1.7.0, ya que loopback no sirve con la API en
bridge y TLS no tiene certificado; token en todo POST y en los GET de configuración del agente
(`/net`, `/route`, `/fw/bans`) + validación de `/route` sin shell ✅ 1.7.0. Pendiente: STUN configurable
(no Google); la clave del buzón nace igual al interno (`voicemail.password = mailbox`) y nadie
obliga a cambiarla — corresponde a `api`; sumar `8092` (agente) a `pbxng-mgmt` (`GET /core`
queda abierto a cualquiera que llegue al host).

**Bloque 5 — red de seguridad de desarrollo.** Casi completo en 1.7.0. Primer paso en 1.6.0: `control-plane/test/guard.test.js`
(`npm test`, `node --test`, con mocks) fue la primera prueba automatizada del repo. ESLint ✅ 1.7.0
(`control-plane/eslint.config.js` flat + `dashboard/.eslintrc.json` con `next/core-web-vitals`;
`npm run lint` en ambos, `next build` corta por errores de lint; de paso salieron un
`ReferenceError` en `POST /api/sbc-link` y dos íconos sin importar en `/internos` y `/phone`);
Prettier pendiente. Pruebas de integración de los endpoints críticos (auth, roles, usuarios,
troncales, rutas, sbc-link, calls) contra un Postgres efímero ✅ 1.7.0 (`test/{auth,rbac,users,
trunks,sbc-link,calls}.test.js` + `test/helpers/db.js`; 36 pruebas en ~20 s; sin Postgres a mano
se marcan `skip`, ver `docs/CONTRATOS.md` §10). CI ✅ 1.7.0 (`.github/workflows/ci.yml`: jobs
`api` con `postgres:16-alpine`, `dashboard`, `compose`, `shell`; `release.yml` depende de ella,
un tag con la CI roja no publica). Partir `app.js` por dominio siguiendo el patrón de
`callengine.js` ✅ 1.7.0 para `auth`, `trunks` (incluye `routes` y `sbc-link`), `recordings`
(incluye `cdr`) y `apps` (colas, IVR, ring groups, paging, buzones, MOH, aparcado, códigos,
agentes IA): 3.980 → ≈2.200 líneas, código movido sin reescribir (285 rutas antes y después).
Quedan en `app.js` internos/endpoints, push/click-to-call, teléfonos físicos (`prov`, `phones`),
red/TURN/NPM/captura, `backup`, CRM/encuesta, wallboard, conferencias y pickup-groups. Sigue
pendiente: Prettier y la prueba e2e de humo del panel (login → topología → troncales) con
Playwright.

**Bloque 6 — panel.** Una capa `api.js` (un solo lugar para URL base, token, `r.ok`, errores y
reintento) y reemplazar los 265 fetch; `error.jsx`/`loading.jsx`; JWT en cookie `HttpOnly`;
no guardar la clave SIP en `localStorage` (o cifrarla); reducir el polling apoyándose en los
eventos que ya llegan por socket (y arreglar el upgrade a WebSocket en el proxy para dejar el
long-polling); utilidades compartidas (`fmtDur`, códecs); CSP con `script-src`.

## 6. Veredicto

Es una central seria, con más funcionalidad y mejor criterio telefónico que muchas comerciales
de su segmento, y con una base de seguridad *técnica* (SQL, comandos, rutas) mejor que la media.
Sus riesgos no están en lo que hace sino en lo que no controla: quién puede hacer qué, qué pasa
cuando algo falla, y que el modo de entrega a clientes no sea el mismo que el que se usa a
diario. Los bloques 1 a 3 son trabajo de días y convierten el producto en algo vendible con la
conciencia tranquila; los bloques 4 a 6 son lo que lo hace mantenible a dos años. Para la
ambición declarada de «PBX súper moderna», la etapa 2 del motor ARI (IA en vivo, CTI) es lo que
diferencia; conviene hacerla *después* del bloque 1, porque cada endpoint nuevo de control de
llamadas sin RBAC agranda el mismo agujero.
