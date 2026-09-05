#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Drenado de Asterisk antes de recrearlo/actualizarlo.
#
#  Por que existe: `docker compose up -d` recrea el contenedor con SIGTERM, y
#  Asterisk ante SIGTERM CORTA las llamadas activas (equivale a "core stop now").
#  El stop_grace_period del compose solo evita el SIGKILL; no protege a nadie que
#  este hablando. Este script hace lo que haria un operador con criterio:
#    1. mira cuantas llamadas hay;
#    2. si hay, pide confirmacion (salvo --yes) y manda "core stop gracefully":
#       Asterisk deja de aceptar llamadas nuevas y se apaga solo cuando cuelga la
#       ultima;
#    3. espera acotado (--timeout, default 60 s) y despues para el contenedor
#       (`docker compose stop`) para que el restart policy no lo vuelva a levantar
#       antes de que el que llamo haga su `up -d`.
#
#  Uso (lo llaman pbxng-ctl y deploy.sh; tambien sirve a mano):
#     ./asterisk-drain.sh [--yes] [--timeout=60] [-f docker-compose.release.yml]
#  Sale 0 si Asterisk no corre, no tenia llamadas o se dreno; 1 si el operador
#  no confirmo (con llamadas y sin --yes/tty).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
YES=0; TIMEOUT=60; CF=docker-compose.yml
while [ $# -gt 0 ]; do case "$1" in
  --yes|-y) YES=1;; --timeout=*) TIMEOUT="${1#*=}";;
  -f) CF="$2"; shift;; -f=*) CF="${1#*=}";;
  *) echo "asterisk-drain: arg desconocido: $1" >&2; exit 2;; esac; shift; done

dc(){ docker compose -f "$CF" "$@"; }
cli(){ dc exec -T asterisk asterisk -rx "$1" 2>/dev/null || true; }
# "core show channels count" imprime "N active calls"; sin core (arrancando o
# apagandose) no imprime nada y lo tratamos como 0.
calls(){ cli "core show channels count" | awk '/active call/ {print $1; exit}'; }

# Sin contenedor corriendo no hay nada que drenar (perfil core apagado, primer deploy).
if ! dc ps --status running --services 2>/dev/null | grep -qx asterisk; then exit 0; fi

N="$(calls)"; N="${N:-0}"
if [ "$N" = 0 ]; then echo "asterisk-drain: sin llamadas activas, se puede recrear."; exit 0; fi

echo "asterisk-drain: hay $N llamada(s) activa(s) en Asterisk."
if [ "$YES" != 1 ]; then
  if [ -t 0 ]; then
    read -rp "  Drenar (no acepta nuevas, espera hasta ${TIMEOUT}s a que cuelguen) y recrear? (s/n) [n]: " a
    [[ "${a:-n}" =~ ^[sSyY] ]] || { echo "  Abortado: Asterisk sigue como esta."; exit 1; }
  else
    echo "  Sin terminal para confirmar: abortado. Repeti con --yes para drenar igual." >&2; exit 1
  fi
fi

echo "asterisk-drain: core stop gracefully (espera maxima ${TIMEOUT}s)…"
cli "core stop gracefully" >/dev/null
t=0
while [ "$t" -lt "$TIMEOUT" ]; do
  # Cuando Asterisk termina de apagarse la CLI deja de responder: calls() da vacio.
  N="$(calls)"
  if [ -z "$N" ] || [ "$N" = 0 ]; then break; fi
  printf '  %2ds: quedan %s llamada(s)\n' "$t" "$N"
  sleep 5; t=$((t+5))
done
N="$(calls)"; N="${N:-0}"
[ "$N" = 0 ] && echo "asterisk-drain: drenado." \
              || echo "asterisk-drain: se agoto la espera con $N llamada(s); se cortan." >&2
# Parar el contenedor a proposito: al salir Asterisk solo, restart:unless-stopped
# lo levantaria de nuevo aceptando llamadas justo antes del `up -d` del que llamo.
dc stop -t 10 asterisk >/dev/null 2>&1 || true
exit 0
