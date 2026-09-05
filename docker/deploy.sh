#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Deploy/Update por IMAGEN (sin build, sin docker cp).
#    ./deploy.sh                          # pull del registry + up
#    ./deploy.sh --images=pbxng-1.0.0-images.tar.gz   # air-gapped (docker load) + up
#    ./deploy.sh --yes                    # no preguntar antes de cortar llamadas activas
#  Requiere docker/.env con secretos y COMPOSE_PROFILES exportado (o en .env).
#  Si la imagen de Asterisk cambia, el `up -d` lo recrea y eso corta las llamadas
#  en curso: antes se drena (asterisk-drain.sh) y sin --yes se pide confirmacion.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
CF=docker-compose.release.yml
VERSION="${PBXNG_VERSION:-$(cat ../VERSION 2>/dev/null || echo latest)}"
REGISTRY="${PBXNG_REGISTRY:-pbxng}"
IMAGES=""; YES=0
for a in "$@"; do case "$a" in --images=*) IMAGES="${a#*=}";; --version=*) VERSION="${a#*=}";; --yes|-y) YES=1;; esac; done
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
# --wait espera al healthcheck de Postgres (un disco lento tardaba más que el sleep fijo).
docker compose -f "$CF" up -d --wait postgres
# El entrypoint de la imagen (docker-entrypoint.sh) ignora los argumentos y termina en
# `exec node app.js`: sin --entrypoint, este `run` migraria y despues dejaria la API entera
# en primer plano y el deploy se colgaria aca. Se pisa el entrypoint para correr SOLO
# migrate.js (idempotente; el arranque de la API lo vuelve a correr y no hace nada).
# Correrlo aca, antes del up, es para que un esquema roto frene el deploy con el error a la
# vista en vez de dejar la API en crash-loop.
docker compose -f "$CF" run --rm -T --no-deps --entrypoint node api migrate.js \
  || { echo "Las migraciones fallaron: no se actualiza nada (ver el error de arriba)"; exit 1; }

echo "== Drenado de Asterisk (si el up lo va a recrear) =="
# El dry-run dice que contenedores se recrean; si no esta disponible, drenamos igual
# (sin llamadas activas es instantaneo). El drenado para el contenedor: el up lo levanta.
if plan="$(docker compose -f "$CF" --dry-run up -d 2>&1)" && ! echo "$plan" | grep -Eqi 'asterisk.*(recreat|creat)'; then
  echo "  asterisk no cambia: sin drenado"
else
  ./asterisk-drain.sh -f "$CF" $([ "$YES" = 1 ] && echo --yes)
fi

echo "== Up (modulos: ${COMPOSE_PROFILES:-core}) =="
docker compose -f "$CF" up -d
docker compose -f "$CF" ps
echo "OK. Dashboard :3001 (la API solo escucha en 127.0.0.1:3000; el panel la sirve en /backend)"
