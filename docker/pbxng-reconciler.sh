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
# mod_sbc NO esta aca: es la conexion a SBC-NG (otro producto), no un contenedor de esta central.
declare -A KEY=( [turn]=mod_turn [ai]=mod_ai [intercom]=mod_intercom )
# ---------------------------------------------------------------------------
#  EL CASO "NO HAY FILA" ES UN ESTADO, NO UN AGUJERO.
#  Aca habia un `[ -z "$v" ] && continue`: si nadie habia tocado nunca el modulo
#  en el panel, no habia fila en pbxng_settings y este script no hacia NADA.
#  Pero la API, en ese mismo caso, devuelve el DEFAULT del modulo (moduleEnabled()
#  de control-plane/app.js: sin fila => encendido, salvo `sbc`). Resultado medido en
#  una central real: el panel mostraba «TURN/STUN» en ON, el contenedor coturn no
#  existia, y /api/ice repartia la direccion de un relay que nadie corria. Nadie lo
#  prendia nunca porque para todos ya estaba prendido.
#  Ahora, sin fila, se aplica el default declarado abajo y se ESCRIBE la fila, asi
#  la decision queda visible en el panel y este script no vuelve a adivinarla.
#
#  `turn` = 1: sin TURN un softphone detras de un NAT simetrico se queda sin audio.
#  Eso es ROTO, no mejorable: el relay propio viene encendido de fabrica.
#
#  `ai` e `intercom` NO estan en la tabla a proposito, aunque la API tambien los
#  de por encendidos sin fila: levantar `ai` arranca faster-whisper (4 GB de RAM,
#  MEM_VOZ) en un appliance que pudo haberse instalado con `--profiles=core`
#  justamente para no tenerlo. Alinear ese default (o cambiarlo en la API) es
#  decision de `empaquetado`/`api`, no de este script; hasta entonces se saltean,
#  y el panel dice la verdad sobre ellos por el estado REAL, no por el default.
# ---------------------------------------------------------------------------
declare -A DEF=( [turn]=1 )
prof="$("$CTL" status 2>/dev/null | grep '^COMPOSE_PROFILES=' | cut -d= -f2 | tr -d ' ')"
cur=",${prof},"
for m in "${!KEY[@]}"; do
  v="$(PSQL "SELECT value FROM pbxng_settings WHERE key='${KEY[$m]}'")"
  if [ -z "$v" ]; then
    v="${DEF[$m]:-}"
    [ -z "$v" ] && continue
    PSQL "INSERT INTO pbxng_settings(key,value) VALUES ('${KEY[$m]}','$v') ON CONFLICT (key) DO NOTHING" >/dev/null
  fi
  if [ "$v" != "0" ]; then
    echo "$cur" | grep -q ",${m}," || "$CTL" enable "$m"
  else
    echo "$cur" | grep -q ",${m}," && "$CTL" disable "$m" || true
  fi
done
