#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Release de imagenes.  build -> tag(version) -> push  y/o  bundle
#  Appliance on-prem: --bundle genera un tarball para instalar SIN internet.
#  Uso:
#    ./release.sh                 # build + tag (local, nombres pbxng/<svc>:<VERSION>)
#    ./release.sh --push          # + push a $PBXNG_REGISTRY
#    ./release.sh --bundle        # + dist/pbxng-<VERSION>-images.tar.gz (air-gapped)
#  Var: PBXNG_REGISTRY (def: pbxng) — para registry: ghcr.io/tuorg/pbx-ng
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"                    # docker/
ROOT="$(cd .. && pwd)"
VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo 0.0.0)"
REGISTRY="${PBXNG_REGISTRY:-pbxng}"
PUSH=0; BUNDLE=0
for a in "$@"; do case "$a" in
  --push) PUSH=1;; --bundle) BUNDLE=1;; --version=*) VERSION="${a#*=}";;
  *) echo "arg desconocido: $a"; exit 1;; esac; done

# imagenes construidas por el compose canonico -> nombre corto del servicio
declare -A SRC=( [asterisk]=pbxng/asterisk:22 [api]=pbxng/api:latest \
  [dashboard]=pbxng/dashboard:latest [kamailio]=pbxng/kamailio:5.6 \
  [wsbridge]=pbxng/wsbridge:latest [coturn]=pbxng/coturn:latest [voz]=pbxng/voz:latest )
THIRD=( postgres:16-alpine redis:7-alpine drachtio/rtpengine:latest \
  alexxit/go2rtc:latest jc21/nginx-proxy-manager:latest )

echo "== PBX-NG release v$VERSION  (registry=$REGISTRY) =="
# Placeholders SOLO para satisfacer la interpolación del compose durante el BUILD.
# NO se hornean en las imágenes (son variables de runtime; los valores reales van en .env al desplegar).
export DB_PASS="${DB_PASS:-build}" ARI_PASS="${ARI_PASS:-build}" AMI_PASS="${AMI_PASS:-build}" \
       JWT_SECRET="${JWT_SECRET:-build}" TURN_PASS="${TURN_PASS:-build}" TURN_CLI_PASS="${TURN_CLI_PASS:-build}"
COMPOSE_PROFILES=core,sbc,turn,ai,intercom,proxy docker compose -f docker-compose.yml build

echo "== Tag =="
for svc in "${!SRC[@]}"; do
  docker tag "${SRC[$svc]}" "$REGISTRY/$svc:$VERSION"
  echo "  ${SRC[$svc]} -> $REGISTRY/$svc:$VERSION"
done

if [ "$PUSH" = 1 ]; then
  echo "== Push =="
  for svc in "${!SRC[@]}"; do docker push "$REGISTRY/$svc:$VERSION"; done
fi

if [ "$BUNDLE" = 1 ]; then
  echo "== Bundle air-gapped =="
  for i in "${THIRD[@]}"; do docker pull "$i" || true; done
  mkdir -p "$ROOT/dist"
  imgs=(); for svc in "${!SRC[@]}"; do imgs+=("$REGISTRY/$svc:$VERSION"); done
  docker save "${imgs[@]}" "${THIRD[@]}" -o "$ROOT/dist/pbxng-$VERSION-images.tar"
  gzip -f "$ROOT/dist/pbxng-$VERSION-images.tar"
  tar -czf "$ROOT/dist/pbxng-$VERSION.tar.gz" -C "$ROOT" \
    VERSION docker/docker-compose.release.yml docker/deploy.sh docker/.env.example \
    docker/pbxng-ctl docker/config control-plane/migrate.js control-plane/migrations 2>/dev/null || true
  echo "  -> dist/pbxng-$VERSION-images.tar.gz   (docker load)"
  echo "  -> dist/pbxng-$VERSION.tar.gz          (compose + scripts + config)"
fi
echo "OK v$VERSION"
