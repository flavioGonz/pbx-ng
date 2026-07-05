#!/usr/bin/env bash
# ============================================================================
#  pbxng-reconciler · aplica el estado DESEADO de modulos (dashboard) a los
#  contenedores. El panel escribe pbxng_settings.mod_<id> (1/0); esto lo lee y
#  llama a pbxng-ctl enable/disable para que el contenedor exista solo si el
#  modulo esta activo. Pensado para systemd timer (cada ~20s).
# ============================================================================
set -euo pipefail
DIR="${PBXNG_DIR:-/opt/pbx-ng/docker}"
CTL="${PBXNG_CTL:-/usr/local/bin/pbxng-ctl}"
set -a; . "$DIR/.env" 2>/dev/null || true; set +a
PSQL(){ docker exec -i pbxng-postgres-1 psql -U "${DB_USER:-pbxng}" -d "${DB_NAME:-pbxng}" -tAc "$1" 2>/dev/null || true; }
declare -A KEY=( [sbc]=mod_sbc [turn]=mod_turn [ai]=mod_ai [intercom]=mod_intercom )
prof="$("$CTL" status 2>/dev/null | grep '^COMPOSE_PROFILES=' | cut -d= -f2 | tr -d ' ')"
cur=",${prof},"
for m in "${!KEY[@]}"; do
  v="$(PSQL "SELECT value FROM pbxng_settings WHERE key='${KEY[$m]}'")"
  [ -z "$v" ] && continue
  if [ "$v" != "0" ]; then
    echo "$cur" | grep -q ",${m}," || "$CTL" enable "$m"
  else
    echo "$cur" | grep -q ",${m}," && "$CTL" disable "$m" || true
  fi
done
