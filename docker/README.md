# PBX-NG · Despliegue con Docker

El instalador interactivo te pregunta la **topología** y levanta el stack.

```bash
cd docker
./install.sh
```

## Topologías

1. **Un contenedor por servicio** (recomendado, producción)
   Usa `docker-compose.yml` con perfiles: `core` (DB/Asterisk/API/Dashboard), `turn` (Coturn), `ai` (Voz), `intercom` (go2rtc), `proxy` (Nginx Proxy Manager). Cada servicio aislado y escalable. `docker-compose.release.yml` es su espejo por imagen (sin `build:`).

2. **Todo en un contenedor** (experimental, demos)
   `Dockerfile.allinone` corre todo el stack con supervisord en un único contenedor. Rápido para probar; no recomendado en producción.

3. **Bare-metal / LXC** (sin Docker)
   Instalación nativa por componente (ver `docs/`).

## Perfiles (compose)

```bash
docker compose --profile core --profile turn up -d --build
```

## Configuración

`.env` se genera automáticamente con secretos aleatorios (o copiá `.env.example`). Las claves de OpenAI/FCM/APNs/SMTP se cargan cifradas desde el panel, no en `.env`.

## Operación (`pbxng-ctl`)

`install.sh` lo deja en `/usr/local/bin`. Módulo = perfil = contenedor.

```bash
pbxng-ctl status                # perfiles activos + estado (con healthcheck) de cada contenedor
pbxng-ctl enable intercom       # agrega el perfil y crea sus contenedores
pbxng-ctl up | down | ps        # aplica el COMPOSE_PROFILES del .env
pbxng-ctl backup                # respaldo ahora (mismo camino que el cron; --keep=N, --grabaciones…)
pbxng-ctl drain                 # drena Asterisk (sin llamadas nuevas, espera a las activas) y lo para
```

### Robustez del stack (igual en `docker-compose.yml` y `docker-compose.release.yml`)

- **Healthcheck en todos los servicios.** `docker compose ps` muestra `healthy`/`unhealthy`
  de verdad: Postgres (`pg_isready`), Asterisk (`core show uptime` por la CLI), API
  (`GET /health/ready`, 503 si la base no responde), panel (`GET /login`), coturn (TCP 3478),
  voz (`GET /health`), go2rtc (`GET /api`), NPM (`:81`).
- **Límite de memoria por contenedor** (`mem_limit` = `memswap_limit`, o sea sin swap: Asterisk
  paginando a disco corta el audio; preferimos que Docker lo reinicie limpio). Se ajusta en `.env`:
  `MEM_POSTGRES=1g MEM_ASTERISK=1g MEM_API=768m MEM_DASHBOARD=512m MEM_COTURN=256m
  MEM_VOZ=4g MEM_GO2RTC=512m MEM_NPM=512m` (defaults). Si un contenedor se reinicia en bucle
  con `OOMKilled`, subí el suyo.
- **Rotación de logs**: `json-file`, 10 MB × 5 por contenedor (`x-logging` en el compose).
- **Apagado ordenado**: `stop_grace_period` 60 s para Asterisk y 20 s para la API. Ojo: el
  SIGTERM de un `up -d` que recrea Asterisk **corta las llamadas activas** (para Asterisk
  equivale a `core stop now`), así que `pbxng-ctl up|enable|down|reconcile` y `deploy.sh`
  drenan antes (`asterisk-drain.sh`): cuentan las llamadas, piden confirmación (salvo `--yes`
  o `reconcile`, que corre sin terminal y drena solo), mandan `core stop gracefully` y esperan
  hasta 60 s a que cuelguen.

### Respaldo programado

El respaldo lo hace la API (`control-plane/backup.js`: `pg_dump` + config generada + certs +
audios + buzones al volumen `respaldos`; es lo mismo que el botón de `/respaldos`). Para
programarlo no hay un contenedor extra: `install.sh` instala en el cron del host
(`/etc/cron.d/pbxng-backup`, o el crontab del usuario si no existe `cron.d`) la línea

```
0 3 * * * /opt/pbx-ng/docker/backup-cron.sh
```

que entra por `docker compose exec` a la API y corre `backup-cli.js`, con retención
`BACKUP_KEEP` (default 14, en `.env`). Log en `/var/log/pbxng-backup.log`. A mano:
`pbxng-ctl backup`. Los archivos quedan en el volumen `respaldos` de Docker: **copialos
afuera del host** (rsync, NAS), un respaldo en el mismo disco no sirve el día que el disco
se muere.

Además, **la API trae su propio planificador** (Sistema → Respaldos → «Respaldo
programado», `GET/POST /api/backup/schedule`): activo por defecto a las 03:00 del reloj del
contenedor, revisa cada minuto y hace exactamente lo mismo que el cron (`backup.programado()`).
Los dos caminos anotan `backup_last_run` en `pbxng_settings`, así el panel muestra la última
corrida venga de donde venga y el planificador no repite el de hoy si el cron ya lo hizo.
Detalles que importan:

- Los automáticos se llaman `pbxng-auto-AAAAMMDD-HHMM.tar.gz`. **La retención borra sólo
  esos**; un respaldo hecho a mano desde el panel (`pbxng-…` sin `auto`) no se toca nunca.
  Si la creación falla, no se poda nada.
- La hora del planificador es la del contenedor de la API, que sin `TZ` es **UTC**. El cron
  del host usa la hora local. Si el host no está en UTC, los dos corren en momentos distintos
  y salen dos respaldos por día (la retención de 14 cubre 7 días): pasá `TZ` al servicio
  `api` en el compose, o apagá el planificador desde el panel si preferís el cron.
- Sin `TZ`, `GET /api/backup/schedule` devuelve `tz` con la zona que está usando.

## Diagnóstico rápido

- `docker compose ps` (o `pbxng-ctl status`): la columna de estado dice `healthy` /
  `unhealthy` por servicio. `unhealthy` en `api` casi siempre es la base: `curl -s
  127.0.0.1:3000/health` responde `503 {status:'degraded', db:false}` cuando Postgres no
  contesta y `200 {status:'ok', db:true}` cuando sí (ARI/AMI caídos se reportan pero no
  bajan el health).
- **Logs de la API en JSON** (una línea por evento, `{ts, level, mod, msg, …}`), filtrables
  con `jq`: `docker compose logs --no-color api | jq -c 'select(.level=="error")'`. Para
  leer a mano, `LOG_FORMAT=text`; para ver más, `LOG_LEVEL=debug` (default `info`). Estas
  variables las lee la API de su entorno: hoy hay que agregarlas al `environment:` del
  servicio `api` (el compose todavía no las reenvía desde el `.env`).
- `docker stop api` / `pbxng-ctl down` es ordenado: la API cierra socket.io, corta las
  supervisiones, cierra ARI/AMI y espera hasta 10 s a las consultas (tope duro 15 s, dentro
  de los 20 s de `stop_grace_period`); en el log se ven los pasos `cierre: …`.
- Al arrancar, el contenedor de la API corre las migraciones (`[entrypoint] aplicando
  migraciones` … `esquema al dia`). Si una falla, **la API no arranca** (sale con 1 y el
  error queda arriba en `docker compose logs api`): es a propósito, arrancar con esquema
  viejo es peor. `deploy.sh` las corre antes del `up -d` por lo mismo.
- Un contenedor que se reinicia en bucle con `docker inspect <ct> --format
  '{{.State.OOMKilled}}'` en `true` pasó su `MEM_*`: subilo en `.env` y `pbxng-ctl up`.

## URLs

- Dashboard: `http://localhost:3001`
- API: `http://127.0.0.1:3000` (solo loopback del host; el panel la consume por `/backend`)
- Nginx Proxy Manager: `http://localhost:81` (admin@example.com / changeme)
