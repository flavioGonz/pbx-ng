#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Deploy/Update por IMAGEN (sin build, sin docker cp).
#    ./deploy.sh                          # pull del registry + up
#    ./deploy.sh --images=pbxng-1.0.0-images.tar.gz   # air-gapped (docker load) + up
#  Requiere docker/.env con secretos y COMPOSE_PROFILES exportado (o en .env).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
CF=docker-compose.release.yml
VERSION="${PBXNG_VERSION:-$(cat ../VERSION 2>/dev/null || echo latest)}"
REGISTRY="${PBXNG_REGISTRY:-pbxng}"
IMAGES=""
for a in "$@"; do case "$a" in --images=*) IMAGES="${a#*=}";; --version=*) VERSION="${a#*=}";; esac; done
export PBXNG_VERSION="$VERSION" PBXNG_REGISTRY="$REGISTRY"
[ -f .env ] || { echo "Falta docker/.env (copia .env.example y completa secretos)"; exit 1; }

if [ -n "$IMAGES" ]; then
  echo "== Cargando imagenes de $IMAGES =="
  case "$IMAGES" in *.gz) gunzip -c "$IMAGES" | docker load;; *) docker load -i "$IMAGES";; esac
else
  echo "== Pull $REGISTRY/*:$VERSION =="
  docker compose -f "$CF" pull
fi

echo "== Migraciones de DB =="
docker compose -f "$CF" up -d postgres
sleep 5
docker compose -f "$CF" run --rm -T api node migrate.js || echo "  (migraciones: revisar salida)"

echo "== Up (modulos: ${COMPOSE_PROFILES:-core}) =="
docker compose -f "$CF" up -d
docker compose -f "$CF" ps
echo "OK. Dashboard :3001 · API :3000"
