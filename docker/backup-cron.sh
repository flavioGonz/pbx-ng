#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Respaldo programado (lo instala install.sh en el cron del host):
#     0 3 * * * /opt/pbx-ng/docker/backup-cron.sh
#
#  Por que en el host y no un contenedor mas: el respaldo lo sabe hacer la API
#  (control-plane/backup.js: pg_dump + conf + certs + audios + buzones al volumen
#  `respaldos`), asi que no hace falta otra imagen con crond ni un token de
#  servicio para pegarle a POST /api/backup. Se entra por `docker compose exec`
#  al contenedor de la API y se corre backup-cli.js, que usa la misma funcion que
#  el boton del panel y ademas borra los respaldos viejos (BACKUP_KEEP, default 14).
#
#  Uso a mano:  ./backup-cron.sh            (o `pbxng-ctl backup`)
#  Config (.env): BACKUP_KEEP=14   PBXNG_COMPOSE_FILE=docker-compose.yml
#  Log: /var/log/pbxng-backup.log (se recorta solo al pasar 1 MB).
# ============================================================================
set -euo pipefail
DIR="${PBXNG_DIR:-$(cd "$(dirname "$0")" && pwd)}"
cd "$DIR"
set -a; . ./.env 2>/dev/null || true; set +a
CF="${PBXNG_COMPOSE_FILE:-docker-compose.yml}"
KEEP="${BACKUP_KEEP:-14}"
LOG="${PBXNG_BACKUP_LOG:-/var/log/pbxng-backup.log}"
LOCK="/tmp/pbxng-backup.lock"

log(){ local m="$(date '+%F %T') $*"; echo "$m"; { echo "$m" >> "$LOG"; } 2>/dev/null || true; }
# El log no pasa por logrotate: si supera 1 MB se queda con la mitad final.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -c 524288 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" || true
fi

# Un respaldo por vez: si el de ayer sigue corriendo (grabaciones enormes, disco
# lento) no arrancamos otro encima.
exec 9>"$LOCK"
if ! flock -n 9; then log "ya hay un respaldo en curso, salteo"; exit 0; fi

if ! docker compose -f "$CF" ps --status running --services 2>/dev/null | grep -qx api; then
  log "la API no esta corriendo: no se puede respaldar"; exit 1
fi

log "respaldo programado: inicio (conservar $KEEP)"
# -T: sin TTY (cron). BACKUP_KEEP se pasa por env por si el .env del compose no lo tiene.
set +e
docker compose -f "$CF" exec -T -e "BACKUP_KEEP=$KEEP" api node backup-cli.js --keep="$KEEP" 2>&1 \
  | while IFS= read -r l; do log "  $l"; done
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" = 0 ]; then log "respaldo programado: OK"; else log "respaldo programado: FALLO (rc=$rc)"; fi
exit "$rc"
