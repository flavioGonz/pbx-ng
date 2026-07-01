#!/usr/bin/env bash
# PBX-NG · instalador interactivo del stack Docker.
set -euo pipefail
cd "$(dirname "$0")"
say(){ printf "\033[1;36m%s\033[0m\n" "$*"; }
ask(){ local p="$1" d="${2:-}" a; read -rp "$p ${d:+[$d]} : " a; echo "${a:-$d}"; }

command -v docker >/dev/null || { echo "Falta Docker. Instalalo: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Falta el plugin 'docker compose'."; exit 1; }

clear
say "==================================================="
say "   PBX-NG · Instalador del stack (Docker)"
say "==================================================="
echo
echo "Modo de instalación:"
echo "  1) Todo en uno (todos los servicios en este host)"
echo "  2) Elegir servicios (núcleo / SBC / media / IA / proxy)"
echo "  3) Solo núcleo (DB + Asterisk + API + Dashboard)"
MODE=$(ask "Opción" "1")

PROFILES=()
case "$MODE" in
  1) PROFILES=(core sbc media ai proxy) ;;
  3) PROFILES=(core) ;;
  2)
     yn(){ local a; read -rp "¿Instalar $1? (s/n) [s]: " a; [[ "${a:-s}" =~ ^[sS] ]]; }
     yn "Núcleo (DB/Asterisk/API/Dashboard)" && PROFILES+=(core)
     yn "SBC (Kamailio + rtpengine)"          && PROFILES+=(sbc)
     yn "Media (Coturn TURN/STUN)"            && PROFILES+=(media)
     yn "IA de Voz (TTS/STT)"                 && PROFILES+=(ai)
     yn "Proxy inverso (Nginx Proxy Manager)" && PROFILES+=(proxy)
     ;;
  *) echo "Opción inválida"; exit 1 ;;
esac

# --- .env ---
if [[ ! -f .env ]]; then
  say "Configuración inicial (se guarda en .env)"
  DOMAIN=$(ask "Dominio público" "pbx.tu-dominio.com")
  DB_PASS=$(ask "Contraseña de PostgreSQL" "$(openssl rand -hex 12 2>/dev/null || echo pbxng_$RANDOM)")
  JWT_SECRET=$(openssl rand -hex 24 2>/dev/null || echo "jwt_$RANDOM$RANDOM")
  PUBLIC_IP=$(ask "IP pública (para TURN/RTP, opcional)" "")
  cp .env.example .env
  sed -i "s|^DB_PASS=.*|DB_PASS=$DB_PASS|; s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|; s|^DOMAIN=.*|DOMAIN=$DOMAIN|; s|^PUBLIC_IP=.*|PUBLIC_IP=$PUBLIC_IP|" .env
  say ".env creado."
else
  say "Usando .env existente."
fi

ARGS=(); for p in "${PROFILES[@]}"; do ARGS+=(--profile "$p"); done
say "Perfiles: ${PROFILES[*]}"
say "Construyendo e iniciando contenedores…"
docker compose "${ARGS[@]}" up -d --build

echo
say "Listo. Servicios levantados:"
docker compose "${ARGS[@]}" ps
echo
say "Dashboard: http://localhost:3001   ·   API: http://localhost:3000"
[[ " ${PROFILES[*]} " == *" proxy "* ]] && say "Nginx Proxy Manager: http://localhost:81 (admin@example.com / changeme)"
