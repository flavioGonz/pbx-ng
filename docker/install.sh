#!/usr/bin/env bash
# ============================================================
#  PBX-NG · Instalador interactivo
#  Pregunta la TOPOLOGIA de despliegue y levanta el stack.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

c(){ printf "\033[1;36m%s\033[0m\n" "$*"; }        # cyan
g(){ printf "\033[1;32m%s\033[0m\n" "$*"; }        # green
y(){ printf "\033[1;33m%s\033[0m\n" "$*"; }        # yellow
r(){ printf "\033[1;31m%s\033[0m\n" "$*"; }        # red
ask(){ local p="$1" d="${2:-}" a; read -rp "$(printf '\033[1m%s\033[0m %s: ' "$p" "${d:+[$d]}")" a; echo "${a:-$d}"; }
yn(){ local a; read -rp "$(printf '\033[1m%s\033[0m (s/n) [%s]: ' "$1" "${2:-s}")" a; a="${a:-${2:-s}}"; [[ "$a" =~ ^[sSyY] ]]; }

clear
c "================================================================"
c "   PBX-NG · Instalador"
c "   UCaaS: Asterisk 22 + WebRTC + SBC Kamailio + IVR IA"
c "================================================================"
echo

# ---------------- 0) Modo de la aplicacion ----------------
c "Modo de la aplicacion"
echo "   1) PBX simple (single-tenant)  · una sola empresa   (RECOMENDADO)"
echo "   2) Multi-tenant (SaaS)         · varias empresas aisladas"
TMODE_SEL=$(ask "Elegi" "1")
[[ "$TMODE_SEL" == "2" ]] && TENANT_MODE="multi" || TENANT_MODE="single"
g "  Modo: $TENANT_MODE"
echo

# ---------------- 1) Topologia ----------------
c "1) Topologia de despliegue"
echo "   1) Docker · un contenedor por servicio   (RECOMENDADO, produccion)"
echo "   2) Docker · todo en un solo contenedor    (experimental, demos)"
echo "   3) Bare-metal / LXC nativo (sin Docker)    (guia manual)"
TOPO=$(ask "Elegi" "1")
echo

case "$TOPO" in
  3)
    y "Instalacion bare-metal / LXC (sin Docker)"
    echo "Cada componente se instala nativo sobre Debian/Ubuntu (idealmente 1 por host/CT):"
    echo "  - PostgreSQL 16 + Redis"
    echo "  - Asterisk 22 (chan_pjsip + res_config_pgsql, realtime)"
    echo "  - Kamailio 5.6 + rtpengine (SBC)"
    echo "  - Coturn (TURN/STUN)"
    echo "  - Control Plane (Node) + Dashboard (Next.js) + Voz IA (Python)"
    echo "  - Nginx Proxy Manager (TLS/WSS)"
    echo
    y "Segui la guia por componente en la carpeta docs/ del repo."
    exit 0
    ;;
  2)
    c "Modo monolitico (todo en un contenedor) — experimental"
    command -v docker >/dev/null || { r "Falta Docker: https://docs.docker.com/engine/install/"; exit 1; }
    [[ -f Dockerfile.allinone ]] || { r "Falta docker/Dockerfile.allinone"; exit 1; }
    DOMAIN=$(ask "Dominio publico" "pbx.tu-dominio.com")
    y "Construyendo imagen all-in-one (puede tardar)…"
    docker build -f Dockerfile.allinone -t pbxng/allinone:latest ..
    docker run -d --name pbxng --restart unless-stopped \
      -p 3000:3000 -p 3001:3001 -p 5060:5060/udp -p 5060:5060/tcp -p 8088:8088 \
      -p 10000-10200:10000-10200/udp -e DOMAIN="$DOMAIN" -e TENANT_MODE="$TENANT_MODE" pbxng/allinone:latest
    g "Listo. Dashboard: http://localhost:3001 · API: http://localhost:3000"
    y "Nota: modo demo. Para produccion usa 'un contenedor por servicio'."
    exit 0
    ;;
  1) : ;;
  *) r "Opcion invalida"; exit 1 ;;
esac

# ---------------- Verificar Docker ----------------
command -v docker >/dev/null || { r "Falta Docker: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { r "Falta el plugin 'docker compose'."; exit 1; }

# ---------------- 2) Servicios (perfiles) ----------------
c "2) Que servicios levantar (un contenedor por cada uno)"
echo "   1) Todo el stack (nucleo + SBC + media + IA + proxy)"
echo "   2) Elegir servicios"
echo "   3) Solo nucleo (DB + Redis + Asterisk + API + Dashboard)"
MODE=$(ask "Elegi" "1")
PROFILES=()
case "$MODE" in
  1) PROFILES=(core sbc media ai proxy) ;;
  3) PROFILES=(core) ;;
  2)
     yn "Nucleo (DB/Redis/Asterisk/API/Dashboard)" && PROFILES+=(core)
     yn "SBC (Kamailio + rtpengine)"               && PROFILES+=(sbc)
     yn "Media (Coturn TURN/STUN)"                 && PROFILES+=(media)
     yn "Voz IA (TTS/STT)"                         && PROFILES+=(ai)
     yn "Proxy inverso (Nginx Proxy Manager)"      && PROFILES+=(proxy)
     ;;
  *) r "Opcion invalida"; exit 1 ;;
esac
[[ ${#PROFILES[@]} -gt 0 ]] || { r "No elegiste ningun servicio."; exit 1; }
echo

# ---------------- 3) Configuracion (.env) ----------------
if [[ ! -f .env ]]; then
  c "3) Configuracion inicial (se guarda en .env, no se versiona)"
  DOMAIN=$(ask "Dominio publico" "pbx.tu-dominio.com")
  PUBLIC_IP=$(ask "IP publica (TURN/RTP, opcional)" "")
  DB_PASS=$(openssl rand -hex 12 2>/dev/null || echo "pbxng_$RANDOM$RANDOM")
  JWT_SECRET=$(openssl rand -hex 24 2>/dev/null || echo "jwt_$RANDOM$RANDOM$RANDOM")
  cp -n .env.example .env 2>/dev/null || cp .env.example .env
  sed -i "s|^DB_PASS=.*|DB_PASS=$DB_PASS|; s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|; s|^DOMAIN=.*|DOMAIN=$DOMAIN|; s|^PUBLIC_IP=.*|PUBLIC_IP=$PUBLIC_IP|" .env
  grep -q "^TENANT_MODE=" .env && sed -i "s|^TENANT_MODE=.*|TENANT_MODE=$TENANT_MODE|" .env || echo "TENANT_MODE=$TENANT_MODE" >> .env
  g "  .env creado (secretos generados automaticamente)."
else
  y "3) Usando .env existente (borralo para reconfigurar)."
fi
echo

# ---------------- 4) Desplegar ----------------
ARGS=(); for p in "${PROFILES[@]}"; do ARGS+=(--profile "$p"); done
c "4) Perfiles: ${PROFILES[*]}"
c "   Construyendo e iniciando contenedores…"
docker compose "${ARGS[@]}" up -d --build

echo
c "5) Estado"
docker compose "${ARGS[@]}" ps
echo
# health-check basico
sleep 4
for hc in "API|http://localhost:3000/health" "Dashboard|http://localhost:3001"; do
  n="${hc%%|*}"; u="${hc#*|}"
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$u" 2>/dev/null || echo 000)
  if [[ "$code" =~ ^(200|401|404)$ ]]; then g "  OK   $n ($code)"; else y "  ...  $n aun iniciando ($code)"; fi
done
echo
g "================================================================"
g "  PBX-NG desplegado."
g "  Dashboard : http://localhost:3001"
g "  API       : http://localhost:3000"
[[ " ${PROFILES[*]} " == *" proxy "* ]] && g "  Proxy NPM : http://localhost:81  (admin@example.com / changeme)"
g "  Publica el dominio con TLS/WSS desde el proxy inverso."
g "================================================================"
