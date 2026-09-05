# PBX-NG · Empaquetado y despliegue

Modelo único: **MÓDULO = PERFIL de compose = CONTENEDOR(es)**. Un contenedor
existe **solo si su módulo está activo**. El estado activo vive en
`docker/.env` → `COMPOSE_PROFILES`.

## Módulos

| Módulo | Perfil | Contenedor(es) | Función |
|---|---|---|---|
| core | `core` | postgres, asterisk, api, dashboard | Núcleo (siempre) |
| turn | `turn` | coturn | TURN/STUN para WebRTC |
| ai | `ai` | voz | IVR con IA (TTS/STT) |
| intercom | `intercom` | go2rtc | Video RTSP (intercom/cámaras) |
| proxy | `proxy` | npm | Reverse proxy TLS/WSS (opcional) |

Las **grabaciones** son una función del `core` (no un contenedor): Asterisk
graba con MixMonitor en el volumen compartido `recordings`, y la API las lee/
reproduce/indexa directo (sin proceso extra).

El módulo **`sbc` («Conexión a SBC-NG»)** es lógico, sin perfil ni contenedor:
solo administra la troncal `to-sbc` y las rutas hacia un
[SBC-NG](https://github.com/flavioGonz/SBC-NG) externo (otro producto, con su
propio empaquetado). Viene apagado por defecto; la migración 0007 lo enciende en
instalaciones que ya tenían `to-sbc`. Kamailio, rtpengine y wsbridge ya no se
empaquetan acá.

## Formas de desplegar

1. **Single-VM** (todo en un host) → `docker/install.sh`
   - Roles `all` (core+turn+ai+intercom, default) o `core` (solo núcleo; `--turn-ip=`
     si coturn vive en otro host). Escribe `COMPOSE_PROFILES` en `.env` →
     `docker compose up -d`.
   - Instala `pbxng-ctl` + el reconciliador.
2. **Proxmox multi-LXC** → `deploy/pbxng-proxmox.sh`
   - Formas: compacto (1 CT) / núcleo + acceso (2 CTs: LAN + TURN/proxy en DMZ,
     recomendado) / núcleo + voz / separado (core, turn, ai, intercom, proxy) / custom.
   - Crea los LXC, instala Docker, clona el repo, escribe `.env` con `COMPOSE_PROFILES`
     por rol e instala `pbxng-ctl` + reconciliador en cada CT.
3. **All-in-one** (1 contenedor, demo) → `install.sh` opción 2.

## Por dónde se entra al panel

- **Con el perfil `proxy` en el mismo compose** (`install.sh` con NPM, forma compacta de Proxmox):
  se entra por `https://<dominio>` (443, NPM → `http://dashboard:3001` por la red bridge). El
  instalador escribe `DASHBOARD_BIND=127.0.0.1`: `:3001` **no** queda accesible desde la LAN, así
  nadie puede saltear a NPM y falsificar la IP del rate limit del login con un `X-Forwarded-For`.
- **Sin proxy**: `http://<ip>:3001` directo (`DASHBOARD_BIND=0.0.0.0`); el panel arma él mismo el
  `X-Forwarded-For` con la IP del socket.
- **Con NPM en otro host/CT** (formas 2 y 4 de Proxmox, o un nginx externo): `DASHBOARD_BIND=0.0.0.0`
  + `DASHBOARD_TRUST_PROXY=1` (si no, la API vería la IP del proxy para todos los usuarios y el
  límite de 50 fallos/10 min por IP bloquearía a toda la empresa) y restringir `:3001` a la IP del
  proxy por firewall. `pbxng-proxmox.sh` lo escribe solo; con un proxy propio va a mano en `.env`.
- La API (`:3000`) y Postgres (`:5432`) escuchan sólo en `127.0.0.1` del host, en todas las formas.

## pbxng-ctl (módulos = contenedores)

```
pbxng-ctl status                 # perfiles activos + contenedores (con su healthcheck)
pbxng-ctl enable  intercom       # agrega el perfil y CREA go2rtc
pbxng-ctl disable intercom       # DESTRUYE go2rtc y saca el perfil
pbxng-ctl up | down | ps
pbxng-ctl reconcile              # sincroniza contenedores <-> COMPOSE_PROFILES
pbxng-ctl backup [--keep=N ...]  # respaldo ahora, mismo camino que el cron (backup-cli.js)
pbxng-ctl drain [--yes]          # drena Asterisk (core stop gracefully) y lo para
```

Flag global `--yes`: no pregunta antes de cortar llamadas. Desde 1.5.0 `pbxng-ctl` lee
`PBXNG_COMPOSE_FILE` del `.env` (lo escribe `install.sh`; `docker-compose.release.yml` con
`--release`), así opera sobre el compose correcto de la instalación.

## Robustez del stack (1.5.0)

Todo esto está igual en `docker-compose.yml` y `docker-compose.release.yml`
(`check-compose-parity.sh` lo garantiza). El porqué de cada cosa está comentado en el
compose, bloque «ROBUSTEZ».

| Qué | Cómo | Se ajusta en |
|---|---|---|
| Healthcheck en los 8 servicios | postgres `pg_isready`; asterisk `asterisk -rx 'core show uptime'` (start_period 90 s); api `GET /health/ready` (503 sin base); dashboard `GET /login` con Node; coturn TCP 3478 (python3); voz `GET /health` (start_period 120 s, carga de modelos); go2rtc `GET /api` (wget); npm `:81` | — |
| Límite de memoria | `mem_limit` = `memswap_limit` (sin swap: Asterisk paginando corta el audio) | `MEM_POSTGRES=1g MEM_ASTERISK=1g MEM_API=768m MEM_DASHBOARD=512m MEM_COTURN=256m MEM_VOZ=4g MEM_GO2RTC=512m MEM_NPM=512m` en `.env` |
| Rotación de logs | `json-file`, 10 MB × 5 por contenedor (`x-logging`) | — |
| Apagado ordenado | `stop_grace_period` asterisk 60 s, api 20 s; la API cierra sola (SIGTERM → socket.io, espías, ARI/AMI, AudioSocket, pool; tope 15 s) | — |
| Drenado de Asterisk | `docker/asterisk-drain.sh`: cuenta llamadas, confirma (salvo `--yes`), `core stop gracefully`, espera `--timeout` (60 s), para el contenedor. Lo llaman `pbxng-ctl up/enable/down/reconcile` y `deploy.sh` **sólo si el `up -d` va a recrear asterisk** (`docker compose --dry-run`); `reconcile` drena sin preguntar porque corre sin terminal | — |
| Migraciones al arrancar | `control-plane/docker-entrypoint.sh`: espera Postgres (60 s), `node migrate.js`, `exec node app.js`. Si fallan, el contenedor sale con 1. `deploy.sh` además las corre antes del `up -d` (`run --rm --no-deps --entrypoint node api migrate.js`) y aborta si fallan | — |

> Un contenedor que se reinicia en bucle con `OOMKilled: true` en `docker inspect` pasó su
> límite: subí el `MEM_*` correspondiente en `.env` y `pbxng-ctl up`. Los defaults cubren el uso
> normal; `MEM_VOZ` depende del modelo whisper elegido.

Variables que la API lee pero que **el compose todavía no reenvía** desde el `.env`
(agregarlas a mano al `environment:` del servicio `api` si hace falta): `LOG_LEVEL`,
`LOG_FORMAT`, `PG_POOL_MAX`, `PG_STATEMENT_TIMEOUT_MS`, `CORS_ORIGINS`, `TZ`. Ver
`docs/CONTRATOS.md` §6.

## Respaldo programado

Dos caminos que hacen lo mismo (`backup.programado()` en `control-plane/backup.js`: crear el
respaldo sin grabaciones + retención):

1. **Planificador interno de la API** — Sistema → Respaldos → «Respaldo programado»
   (`/api/backup/schedule`). Activo por defecto a las 03:00 del reloj del contenedor de la
   API (UTC si no se le pasa `TZ`), conserva `BACKUP_KEEP` (14). No necesita nada en el host.
2. **Cron del host** — `install.sh` deja `0 3 * * * /opt/pbx-ng/docker/backup-cron.sh` en
   `/etc/cron.d/pbxng-backup` (o en el crontab del usuario), idempotente. El script hace
   `docker compose exec -T api node backup-cli.js --keep=N`, con `flock`, y loguea en
   `/var/log/pbxng-backup.log`.

Los automáticos se llaman `pbxng-auto-AAAAMMDD-HHMM.tar.gz`; **la retención sólo borra esos**,
nunca un respaldo hecho a mano desde el panel. Ambos caminos escriben `backup_last_run` /
`backup_last_ok` en `pbxng_settings`, así el panel muestra la última corrida y el planificador
no repite el de hoy si el cron ya lo hizo. Ojo con la zona horaria: cron = hora del host,
planificador = hora del contenedor; si difieren pueden salir dos por día (pasar `TZ` al servicio
`api` o apagar el planificador desde el panel). El volumen `respaldos` vive en el mismo disco
que la central: **copiarlo afuera** (rsync, NAS) es parte de la instalación, no un extra.

## Activar/desactivar desde el panel

El dashboard (Módulos) escribe `pbxng_settings.mod_<id>` (1/0). El
**reconciliador** (`pbxng-reconciler.timer`, cada 20 s) lee esas claves y llama
a `pbxng-ctl enable/disable` para que el contenedor exista solo si el módulo
está activo. Módulos con contenedor: `turn`, `ai`, `intercom`. El toggle de
`sbc` (Conexión a SBC-NG) no pasa por el reconciliador: solo habilita la página
Sistema → SBC-NG (conexión) y la API `/api/sbc-link`.

> Requisito para el toggle de intercom en el panel: agregar `'intercom'` a
> `MODULE_IDS` en `control-plane/app.js` (hoy: sbc, turn, voz, clicktocall,
> push, autoprov, ai). El reconciliador ya mapea `mod_intercom`.

## Notas
- go2rtc se publica al navegador vía el reverse proxy en `/go2rtc/` (WS/MSE).
  Protegerlo con auth (ver revisión de código): hoy queda accesible.
- El `.env` no se versiona; los secretos se generan en la instalación.
