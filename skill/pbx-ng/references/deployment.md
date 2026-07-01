# PBX-NG — Despliegue

## Índice
1. [Vías de despliegue](#vias-de-despliegue)
2. [Requisitos](#requisitos)
3. [.env y secretos](#env-y-secretos)
4. [Cómo buildean las imágenes Docker](#como-buildean-las-imagenes)
5. [docker-compose + install.sh](#docker-compose--installsh)
6. [Orquestador Proxmox (deploy/pbxng-proxmox.sh)](#orquestador-proxmox)
7. [Validación end-to-end](#validacion-end-to-end)

---

## Vías de despliegue

Todo el empaquetado nuevo vive en el repo bajo `docker/` y `deploy/`. Tres vías:

1. **docker-compose en un host** — `docker/install.sh` (interactivo). Para un servidor
   único (bare-metal o VM/CT) con Docker.
2. **Orquestador Proxmox** — `deploy/pbxng-proxmox.sh`. Corre en un nodo Proxmox, crea los
   LXC, instala Docker, clona el repo y arranca el compose por perfiles. Es la vía "cluster".
3. **Contenedores LXC vivos (histórico)** — el despliegue IES original, hecho a mano CT a CT.
   El empaquetado Docker se EXTRAJO de esos CTs vivos (configs probadas, tokenizadas).

Las tres montan el mismo software; el empaquetado Docker es la fuente reproducible.

## Requisitos

- **Docker dentro de LXC** requiere `nesting=1,keyctl=1` en el CT (se setea desde el host
  Proxmox con `pct set <vmid> --features nesting=1,keyctl=1`). Sin esto Docker no arranca.
- **Plantilla Debian 12** disponible en el nodo (el orquestador la autodetecta/ofrece bajar).
- **Storage válido** para el rootfs del CT (el orquestador lo valida).
- **Internet** en el CT (para `get.docker.com`, `git clone`, descargar Asterisk/Kamailio,
  imágenes base).
- **RAM:** compilar Asterisk necesita margen; con 4GB compilar en paralelo con api+dashboard
  causa OOM. El orquestador compila Asterisk **aislado primero** y con `make -j2`.

## .env y secretos

Los secretos van SIEMPRE por ENV, nunca en las imágenes. `docker/install.sh` y el orquestador
generan un `.env` con secretos aleatorios + la IP del host/core. Variables clave:

- `DB_PASS`, `JWT_SECRET`, `ARI_PASS`, `AMI_PASS`, `TURN_PASS` — secretos random por deploy.
- `HOST_IP` / IP del core — asterisk y kamailio usan `DB_HOST` = IP del host (host-net);
  la api usa `DB_HOST=postgres` (bridge).
- `API_URL` — **usar `API_URL` (NO `BACKEND_URL`)** en el dashboard, o los rewrites
  `/backend/:path* → ${API_URL}/:path*` dan 500 y el panel no carga. (Gotcha crítico.)
- Credenciales de servicios externos (OpenAI, FCM service-account, APNs .p8, SMTP) NO van
  en `.env`: se cargan en la tabla `pbxng_settings` desde el panel (gated/enmascaradas).

En el despliegue histórico había fallbacks hardcodeados en `app.js` y agentes
(`JWT_SECRET||'<jwt-fallback>'`, `<db-pass-fallback>`, `<ari-fallback>`,
`<ami-fallback>`, VAPID privada literal, coturn CLI `<turn-cli-fallback>`). Están en el repo GitHub y
**deben rotarse** (el VAPID privado filtrado hay que regenerarlo). Ver `operations.md`.

## Cómo buildean las imágenes

`docker/docker-compose.yml`: perfiles `core / sbc / media / ai / proxy`. Build contexts:
`context: .` + `dockerfile: images/<X>/Dockerfile`. Cada entrypoint resuelve tokens desde ENV.

- **asterisk** (`docker/images/asterisk/Dockerfile`): Asterisk 22.10.0 desde fuente,
  multi-stage (build `debian:12` + runtime `debian:12-slim`).
  `./configure --with-pjproject-bundled --with-jansson-bundled --with-ssl --with-srtp`;
  menuselect habilita `res_config_pgsql / cdr_pgsql / res_srtp / res_pjsip`;
  `make -j2` (para no OOM). El runtime copia binario + `/usr/lib/asterisk` +
  `/var/lib/asterisk` + **`/usr/lib/libasterisk*.so`** (si falta `libasteriskssl.so.1`
  no arranca). URL de descarga en subcarpeta `releases/`:
  `.../pub/telephony/asterisk/releases/asterisk-${VER}.tar.gz`.
  `docker-entrypoint.sh` genera desde ENV: `res_pgsql.conf`, `cdr_pgsql.conf`, `ari.conf`,
  `manager.conf` (permit por `AMI_PERMIT`), cert TLS self-signed en `/etc/asterisk/keys`
  si falta, resuelve `@@API_URL@@` en `extensions.conf` (webhook wake), espera a Postgres.
- **kamailio** (`docker/images/kamailio/Dockerfile`): Kamailio 5.6 de deb.kamailio.org
  (`kamailio56` bookworm) + `kamailio-postgres/tls/websocket/presence/json/utils/extra-modules`.
  El entrypoint resuelve por `sed` los tokens `@@DB_URL@@ @@ASTERISK_IP@@ @@SELF_IP@@
  @@PUBLIC_IP@@ @@TRUSTED_NET@@` (NO usa envsubst por los `$var` de kamailio), valida `kamailio -c`.
- **coturn** (`docker/images/coturn/Dockerfile`): `FROM coturn/coturn`; el entrypoint resuelve
  `@@TURN_REALM@@ @@TURN_USER@@ @@TURN_PASS@@ @@TURN_EXT_IP@@ @@TURN_CLI_PASS@@`.
  **El CMD NO debe llevar `-o`** (daemoniza y mata el contenedor → "Restarting (0)").
- **voz** (`docker/images/voz/Dockerfile`): `python:3.11-slim` + `ffmpeg/espeak-ng` +
  pip `fastapi uvicorn faster-whisper edge-tts numpy soundfile`; `uvicorn server:app` en :8080.
- **control-plane** (`control-plane/Dockerfile`): `node:20-slim`, `npm ci`, `node app.js`, :3000.
- **dashboard** (`dashboard/Dockerfile`): `node:20-slim` multi-stage, `npm run build`,
  `next start` :3001. `next.config.js` usa `process.env.API_URL` para los rewrites
  `/backend/:path* → ${API_URL}/:path*` (y `/socket.io`, `/prov`, `/ws`).

**Configs tokenizadas** en `docker/config/{asterisk,kamailio,coturn}/` (extraídas de los CTs
vivos, sin secretos ni IPs de IES):
- asterisk: `asterisk.conf, modules.conf, extconfig.conf` (mapea ps_* + extensions/queues/
  queue_members/voicemail a pgsql), `sorcery.conf, pjsip.conf` (solo transportes udp/tcp/tls/ws
  + `[global] endpoint_identifier_order=username,ip,anonymous`), `http.conf, rtp.conf, cdr.conf,
  logger.conf, acl.conf, extensions.conf, queues.conf, features.conf, confbridge.conf,
  musiconhold.conf`.
- kamailio: `kamailio.cfg` + `dispatcher.list`.
- coturn: `turnserver.conf`.
- `initdb/01-schema.sql` (74 tablas, `pg_dump --schema-only`) + `initdb/02-seed-version.sql`
  (DATA de la tabla `version`).

## docker-compose + install.sh

`docker/docker-compose.yml`:
- `postgres` publica 5432 (para que asterisk/kamailio host-net lo alcancen).
- asterisk/kamailio/coturn/rtpengine usan `network_mode: host`.
- Secretos por ENV (`DB_PASS/JWT_SECRET/ARI_PASS/AMI_PASS/TURN_PASS`).
- `api` usa `DB_HOST=postgres` (bridge); asterisk/kamailio usan `DB_HOST` = IP del host.

`docker/install.sh` (instalador interactivo de un host):
1. Pregunta **modo app** (single-tenant / multi-tenant).
2. Pregunta **topología** (docker por servicio / todo-en-uno / bare-metal).
3. Genera `.env` con secretos random + `HOST_IP`.
4. `docker compose up` con los perfiles elegidos.

## Orquestador Proxmox

`deploy/pbxng-proxmox.sh` — corre en un nodo Proxmox. Flujo:

1. **Descubre nodos** por RAM libre: `pvesh get /cluster/resources --type node`.
   (El python inline de descubrimiento no debe usar comillas simples ni f-strings con comillas
   anidadas dentro de `python3 -c '...'` — usar `print(n["node"], free, n.get("maxcpu",0))`.)
2. Pregunta **FORMA**:
   - **1 Compacto** — 1 CT con todo.
   - **2 Standalone** — 2 CT: main (core+media+ai+proxy) / sbc.
   - **3 Híbrido** — core / edge / ai.
   - **4 Separado** — 1 CT por perfil.
   - **5 Personalizado** — agrupás perfiles a gusto.
3. Pregunta **MODO** (single / multi-tenant).
4. Deriva **recursos por CT** de los perfiles que agrupa.
5. **Salta VMIDs** ya usados en el cluster; **valida el storage**; **autodetecta/ofrece bajar**
   la plantilla Debian.
6. **Crea los LXC** (unprivileged, `features nesting=1,keyctl=1`, onboot, start), espera IP.
   Todos los CT se crean en el **nodo local** (`pct create` es local, NO lleva `--node`).
7. En cada CT: instala Docker (`get.docker.com`), clona el repo, escribe `.env` (inyecta la
   IP del CT `core` en los CTs dependientes), **compila Asterisk AISLADO primero**, luego
   `docker compose up`.
8. El rol con perfil `core` se crea primero (los demás apuntan a su IP).

Detalles no-fatales que el script maneja: `clear` no-fatal si no hay TERM; repo privado vs
público (git clone anónimo falla en privado → pasar token en `PBXNG_REPO_URL` o repo público;
`raw.githubusercontent` cachea ~5min → usar la API de contenidos con
`Accept: application/vnd.github.raw` para la última versión).

## Validación end-to-end

Probado en un CT descartable: las **6 imágenes compilan**, Postgres carga las **74 tablas**,
Asterisk levanta y conecta al realtime (`res_config_pgsql` + `cdr_pgsql` Running), API healthy,
dashboard Up. La PBX core funciona. **Pendiente:** rtpengine (imagen drachtio) falla al crear
el listener websocket sobre iface IPv6 link-local (`Failed to init websocket listener`) — la
PBX funciona sin él para WebRTC en LAN (los internos web registran directo a Asterisk ws :8088).
Ver `gotchas.md`.
