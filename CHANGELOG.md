# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com). Versionado: [SemVer](https://semver.org).

## [1.1.0] - 2026-07-11
### Added
- **`docs/FIREWALL.md`**: firewall/NAT como **requisito de instalacion** — matriz de puertos por rol, reglas dst-nat, `external-ip=<publica>/<privada>` del coturn, **NAT hairpin** (la trampa del `in-interface=WAN/all-ppp` que rompe el loopback), verificacion y lectura de errores ICE (701 vs 401).
- **`scripts/check-turn.py`**: sonda TURN **real** (STUN Binding -> Allocate 401 -> Allocate firmado con MESSAGE-INTEGRITY -> `XOR-RELAYED-ADDRESS`). Prueba UDP y TCP; veredicto claro. Lee credenciales de un `.env`.
- **`install.sh`**: nueva funcion `fw_note()` que imprime **exactamente que abrir** segun los modulos activos (con el aviso de que `3478` va UDP **y** TCP y de que sin el rango relay no hay audio), autochequeo del TURN al terminar (`turn_selfcheck`) y flag **`--print-firewall`**.
- **Diagnostico ICE/TURN en vivo** en el panel (SBC -> TURN) y en el softphone: `RTCPeerConnection` real, candidatos host/srflx/relay, IP publica, IP del relay y errores ICE crudos. El verde animado ahora significa **alcanzable Y autenticado**, no "campos completos".
- Indicador de **ruta de medios** durante la llamada (`VIA TURN` / `DIRECTO`) en el softphone web y en el de escritorio, leyendo el par ICE nominado (`candidateType`).
- **Buzon de voz por defecto** en cada extension nueva (PIN = numero de interno): `ps_endpoints.mailboxes` + fila en `voicemail` en las 4 rutas de creacion. `*97` para escucharlo.
- **`softphone-app/`**: softphone de escritorio standalone (Vite+React+SIP.js+Electron) con doble motor (WebRTC / SIP nativo UDP-TCP-TLS), mini-widget flotante, config cifrada (DPAPI), provisioning por QR, MWI, transferencia y estadisticas de calidad. Instalador NSIS en espanol.
- **Audios de la PBX en espanol rioplatense (voz uruguaya)**: `voice-service/sounds/manifest.es.json` (326 prompts: voicemail con el flujo ES real —`vm-INBOXs`/`vm-Olds`/`vm-nomessages`—, digits/numeros segun `ast_say_number_full_es`, dias y meses, colas, conferencias, directorio, agentes) + `scripts/gen-sounds.py` que los sintetiza con el TTS propio (Edge `es-UY-*` o Piper) en WAV 8 kHz mono. El pack se distribuye como `docker/sounds/pbxng-sounds-es.tar.gz` y la imagen de Asterisk lo instala en `/var/lib/asterisk/sounds/es` (el tarball preserva `vm-Old` != `vm-old`).
- `GET /api/enroll/:token` ahora devuelve la **config completa de aprovisionamiento** (`prov` + `prov_url` = `pbxng://prov#…`), asi el link `https://pbx/enroll?token=…` que genera el panel sirve tanto para la PWA como para el **softphone de escritorio** (que lo canjea desde el lector de QR o pegando el link).
- **Buzon de voz -> Email**: cada mensaje nuevo se envia al correo del buzon con el **audio adjunto** y la **transcripcion automatica (Whisper)** en el cuerpo. Poller idempotente (`pbxng_vm_sent`), opciones por buzon (enviar / adjuntar / transcribir / borrar tras enviar), UI en Aplicaciones -> Buzones, usa el SMTP por empresa. Migracion `0002_vm_email.sql`.
- **Colas completas (bloque 1+2)**: se exponen los campos nativos de `app_queue` que ya existian en la tabla realtime (`wrapuptime`, `maxlen`, `retry`, `joinempty`, `leavewhenempty`, `ringinuse`, `autofill`, `autopause`, `servicelevel`, `weight`, `memberdelay`, `reportholdtime`, anuncios de posicion/espera), **destino al vencer la espera maxima** (colgar / interno / buzon / otra cola / IVR) resuelto en el dialplan generado, y **grabacion automatica por cola**. Editor nuevo (`QueueEditor.jsx`) con pestanas Basico/Anuncios/Avanzado. Migracion `0003_queues_full.sql`.
- **Anuncios de cola por TTS**: la bienvenida y el anuncio periodico se escriben **como texto** y los sintetiza el motor de voz propio (voz uruguaya), con boton de escucha previa. No hay que subir WAVs (a diferencia del UCM de Grandstream).
- `docs/QUEUES-ROADMAP.md`: analisis competitivo del Grandstream UCM6304 + plan por bloques (callback/cola virtual, skills, SLA).
### Fixed
- `defaultlanguage = es` estaba seteado pero **no existia** `/var/lib/asterisk/sounds/es/`: Asterisk caia al set en ingles y el buzon hablaba en ingles.
- Creacion de extension fallaba con `inconsistent types deduced for parameter $1`: el `$1` del auto-buzon se usaba como texto (`$1 || '@default'`) y como varchar (`id=$1`) en la misma sentencia. Ahora `mailboxes = id || '@default'` y casts explicitos (`$1::text`).
- MWI (buzon visual) daba 401->404: los `ps_endpoints` tenian `mailboxes` vacio y la tabla realtime `voicemail` estaba vacia. Se siembran las filas y se recarga `res_pjsip_mwi.so`.

## [1.0.0] - 2026-07-05
### Added
- Empaquetado por **modulos = perfiles de compose = contenedores** (`pbxng-ctl` + reconciliador).
- **Sistema de release**: imagenes versionadas (`docker/release.sh`: build -> tag -> push y/o bundle air-gapped) y **deploy por pull/load** (`docker/deploy.sh` + `docker-compose.release.yml`) — sin `docker cp`.
- **Instalador multi-rol** (`docker/install.sh --role=all|core|edge`): topologia 1 VM o 2 VMs (core en LAN + edge SBC en DMZ), con `edge-join.env` (secretos compartidos) y validacion de conectividad edge->core. Guia en `docs/TOPOLOGY.md`.
- **Orquestador Proxmox** (`deploy/pbxng-proxmox.sh`): nueva forma **6) Dos VMs** (núcleo LAN + borde SBC en DMZ con **doble NIC** opcional), crea/aprovisiona ambas LXC con secretos compartidos e IPs cruzadas + nota de firewall.
- **Migraciones de DB** versionadas (`control-plane/migrate.js` + `control-plane/migrations/`).
- CI de release a GHCR por tag `v*` (`.github/workflows/release.yml`).
- CRM (clientes/personas/espacios/dispositivos) + encuestas; Intercom (go2rtc) protegido tras el proxy.
- Panel de agente (estilo glass), **pausa por cola** (`/api/agent/pause`), self-cam; topologia con host por nodo.
### Changed
- Reconciliacion **repo == produccion** (single source of truth); `control-plane/app.js` del repo estaba truncado y se restauro completo.
### Security
- `/go2rtc/` ya no expone el panel publico (solo `/api/ws`); resto -> 403.
- **Secretos por-deployment**: `install.sh` genera TODOS los secretos (DB, JWT, ARI, AMI, TURN, TURN_CLI, admin) con `openssl`, detecta y **regenera valores débiles/placeholder** (bug: antes `has()` dejaba pasar `cambia_esta_clave`), preflight que **aborta** si queda algo débil, `.env` con `chmod 600`, y clave inicial de `admin` generada (must_change en 1er login) via `ADMIN_DEFAULT_PASS`.
- `.env.example` ahora trae los secretos **vacíos** (nada débil se versiona).
- Compose: credenciales de **TURN requeridas** (`${TURN_PASS:?}` / `${TURN_CLI_PASS:?}`) — sin default adivinable; falla fuerte si no están. TURN_PASS es secreto **compartido** core↔edge (via `edge-join.env`).
- Compose: **Redis ya no publica** el puerto 6379 al host (era accesible sin auth).
