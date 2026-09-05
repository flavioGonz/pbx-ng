#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Paridad docker-compose.yml <-> docker-compose.release.yml
#  Los clientes corren el release y el desarrollo corre el canonico: si
#  divergen, lo que se prueba no es lo que se entrega (ya paso: el release
#  perdio volumenes, NET_ADMIN y monto grabaciones en :ro). Este script
#  resuelve los dos con 'docker compose config' y exige que sean identicos
#  salvo build:/image:. Lo corre la CI (release.yml) y sirve a mano:
#     ./check-compose-parity.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Secretos de mentira solo para que la interpolacion ${VAR:?} no corte el config.
cat > "$TMP/env" <<'ENV'
DB_PASS=parity
ARI_PASS=parity
AMI_PASS=parity
JWT_SECRET=parity
TURN_PASS=parity
TURN_CLI_PASS=parity
COMPOSE_PROFILES=core,turn,ai,intercom,proxy
ENV
norm(){   # config resuelto sin build:/image: (unica diferencia legitima)
  docker compose --env-file "$TMP/env" -f "$1" config \
    | grep -v -E '^\s+(build|context|dockerfile|image):' \
    | sed -E 's#pbxng/(asterisk|api|dashboard|coturn|voz)(:[^ ]*)?#IMG#'
}
norm docker-compose.yml         > "$TMP/dev.yml"
norm docker-compose.release.yml > "$TMP/rel.yml"
if diff -u "$TMP/dev.yml" "$TMP/rel.yml"; then
  echo "OK: docker-compose.release.yml es espejo de docker-compose.yml"
else
  echo "ERROR: los compose divergen (arriba el diff). Igualalos antes de publicar." >&2
  exit 1
fi
