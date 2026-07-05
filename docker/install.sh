#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Instalador multi-rol
#  Roles:
#    all   · Todo en esta maquina (SOHO / demo)                       [default]
#    core  · Nucleo (Asterisk + API + Dashboard + Postgres + Redis)   -> zona LAN
#    edge  · Borde SBC (Kamailio + rtpengine + wsbridge + TURN)       -> zona DMZ
#
#  Modelo: MODULO = PERFIL de compose = CONTENEDOR (COMPOSE_PROFILES en .env).
#  Dos VMs: instalar 'core' primero (genera edge-join.env con los secretos
#  compartidos), copiar ese archivo al edge e instalar 'edge --join=...'.
#
#  Uso interactivo:   ./install.sh
#  No interactivo:    ./install.sh --role=core  --public-ip=1.2.3.4 --domain=pbx.x.com --edge-ip=10.0.0.20 --yes
#                     ./install.sh --role=edge  --join=edge-join.env --public-ip=1.2.3.4 --yes
#  Flags: --role= --profiles=a,b --core-ip= --edge-ip= --public-ip= --domain=
#         --join=FILE --tenant=single|multi --release --yes
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"; HERE="$(pwd)"

c(){ printf "\033[1;36m%s\033[0m\n" "$*"; }
g(){ printf "\033[1;32m%s\033[0m\n" "$*"; }
y(){ printf "\033[1;33m%s\033[0m\n" "$*"; }
r(){ printf "\033[1;31m%s\033[0m\n" "$*"; }
ask(){ local p="$1" d="${2:-}" a; read -rp "$(printf '\033[1m%s\033[0m %s: ' "$p" "${d:+[$d]}")" a; echo "${a:-$d}"; }
yn(){ local a; read -rp "$(printf '\033[1m%s\033[0m (s/n) [%s]: ' "$1" "${2:-s}")" a; a="${a:-${2:-s}}"; [[ "$a" =~ ^[sSyY] ]]; }
gen(){ openssl rand -hex "$1" 2>/dev/null || echo "x$RANDOM$RANDOM$RANDOM"; }
lanip(){ hostname -I 2>/dev/null | awk '{print $1}'; }
put(){ local k="$1" v="$2"; grep -q "^$k=" .env && sed -i "s|^$k=.*|$k=$v|" .env || echo "$k=$v" >> .env; }
has(){ grep -q "^$1=..*" .env 2>/dev/null; }               # clave con valor no vacio
getv(){ grep "^$1=" .env | head -1 | cut -d= -f2-; }
WEAK="cambia_esta_clave cambia_este_secreto_jwt changeme admin pbxng-turn-changeme pbxng-cli pbxng-turn-cli x test testpass"
need(){ local v w; v="$(getv "$1")"; [[ -z "$v" ]] && return 0; for w in $WEAK; do [[ "$v" == "$w" ]] && return 0; done; return 1; }
tcpok(){ timeout 3 bash -c "echo > /dev/tcp/$1/$2" 2>/dev/null && echo ok || echo fail; }

# ---------------- flags ----------------
ROLE=""; PROFILES=""; CORE_IP=""; EDGE_IP=""; PUBLIC_IP_F=""; DOMAIN_F=""; JOIN=""; TENANT_F=""; RELEASE=0; YES=0
for a in "$@"; do case "$a" in
  --role=*) ROLE="${a#*=}";; --profiles=*) PROFILES="${a#*=}";;
  --core-ip=*) CORE_IP="${a#*=}";; --edge-ip=*) EDGE_IP="${a#*=}";;
  --public-ip=*) PUBLIC_IP_F="${a#*=}";; --domain=*) DOMAIN_F="${a#*=}";;
  --join=*) JOIN="${a#*=}";; --tenant=*) TENANT_F="${a#*=}";;
  --release) RELEASE=1;; --yes|-y) YES=1;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
  *) r "arg desconocido: $a"; exit 1;;
esac; done

clear 2>/dev/null || true
c "================================================================"
c "   PBX-NG · Instalador multi-rol (all | core | edge)"
c "================================================================"; echo

command -v docker >/dev/null || { r "Falta Docker: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { r "Falta el plugin 'docker compose'."; exit 1; }

# ---------------- rol ----------------
if [[ -z "$ROLE" ]]; then
  if [[ "$YES" == 1 ]]; then ROLE=all; else
    c "Rol de esta VM/host"
    echo "   1) all   · Todo en esta maquina (SOHO / demo)         (RECOMENDADO chico)"
    echo "   2) core  · Nucleo (Asterisk+API+Dashboard+DB) — LAN"
    echo "   3) edge  · Borde SBC (Kamailio+rtpengine+wsbridge+TURN) — DMZ"
    case "$(ask 'Elegi' '1')" in 1) ROLE=all;; 2) ROLE=core;; 3) ROLE=edge;; *) r "Opcion invalida"; exit 1;; esac
  fi
fi
LAN="$(lanip)"; LAN="${LAN:-127.0.0.1}"
CF="docker-compose.yml"; UP=(up -d --build)
[[ "$RELEASE" == 1 ]] && { CF="docker-compose.release.yml"; UP=(up -d); }
g "  Rol: $ROLE   ·   IP LAN detectada: $LAN"; echo

ensure_env(){ [[ -f .env ]] || { cp -n .env.example .env 2>/dev/null || : > .env; }; chmod 600 .env 2>/dev/null || true; }
gen_shared_secrets(){  # genera lo que falte O sea débil (re-run idempotente y seguro)
  need DB_PASS        && put DB_PASS "$(gen 16)"
  need JWT_SECRET     && put JWT_SECRET "$(gen 32)"
  need ARI_PASS       && put ARI_PASS "$(gen 12)"
  need AMI_PASS       && put AMI_PASS "$(gen 12)"
  need TURN_PASS      && put TURN_PASS "$(gen 12)"
  need TURN_CLI_PASS  && put TURN_CLI_PASS "$(gen 10)"
  need ADMIN_DEFAULT_PASS && put ADMIN_DEFAULT_PASS "$(gen 6)"
  has DB_NAME  || put DB_NAME pbxng
  has DB_USER  || put DB_USER pbxng
  has ARI_USER || put ARI_USER pbxng
  has AMI_USER || put AMI_USER pbxng-ami
  has TURN_USER || put TURN_USER pbxng
}
preflight_secrets(){
  local k miss=0
  for k in DB_PASS JWT_SECRET AMI_PASS ARI_PASS; do
    if need "$k"; then r "  ✗ Secreto ausente o débil: $k"; miss=1; fi
  done
  [[ "$miss" == 1 ]] && { r "Abortado: hay secretos sin generar. Usá el instalador, no edites .env a mano."; exit 1; }
  g "  ✓ Secretos por-deployment verificados"
}
install_ctl(){
  [[ -f "$HERE/pbxng-ctl" ]] && { install -m 0755 "$HERE/pbxng-ctl" /usr/local/bin/pbxng-ctl 2>/dev/null || sudo install -m 0755 "$HERE/pbxng-ctl" /usr/local/bin/pbxng-ctl; sed -i "s|^DIR=.*|DIR=\"\${PBXNG_DIR:-$HERE}\"|" /usr/local/bin/pbxng-ctl 2>/dev/null || true; }
  if [[ -f "$HERE/pbxng-reconciler.sh" ]] && command -v systemctl >/dev/null; then
    install -m 0755 "$HERE/pbxng-reconciler.sh" /usr/local/bin/pbxng-reconciler.sh 2>/dev/null || sudo install -m 0755 "$HERE/pbxng-reconciler.sh" /usr/local/bin/pbxng-reconciler.sh
    sed "s|/opt/pbx-ng/docker|$HERE|g" "$HERE/pbxng-reconciler.service" > /etc/systemd/system/pbxng-reconciler.service 2>/dev/null || true
    cp "$HERE/pbxng-reconciler.timer" /etc/systemd/system/pbxng-reconciler.timer 2>/dev/null || true
    systemctl daemon-reload 2>/dev/null && systemctl enable --now pbxng-reconciler.timer 2>/dev/null && g "  reconciliador activo (cada 20s)." || y "  (timer systemd no activado; el panel togglea via pbxng-ctl igual)"
  fi
}
deploy(){
  preflight_secrets
  install_ctl
  c "Desplegando [$ROLE]  modulos: $CPROFILES  (compose: $CF)"
  COMPOSE_PROFILES="$CPROFILES" docker compose -f "$CF" "${UP[@]}"
  echo; c "Estado"; COMPOSE_PROFILES="$CPROFILES" docker compose -f "$CF" ps
  if [[ " $CPROFILES " == *" core "* ]]; then
    echo; g "  Usuario admin inicial:  admin  /  $(getv ADMIN_DEFAULT_PASS)"
    y "  (se te pedirá cambiarla en el primer ingreso)"
  fi
}

case "$ROLE" in
# ==========================================================================
all)
  TENANT_MODE="${TENANT_F:-single}"
  c "Modulos (perfiles). core siempre; el resto opcional."
  PROFS=(core)
  if [[ -n "$PROFILES" ]]; then IFS=',' read -ra PROFS <<< "core,$PROFILES"; PROFS=($(printf '%s\n' "${PROFS[@]}" | awk '!s[$0]++'));
  elif [[ "$YES" == 1 ]]; then PROFS=(core sbc turn ai intercom); else
    echo "   1) Todo (core+sbc+turn+ai+intercom)   2) Elegir   3) Solo core"
    case "$(ask 'Elegi' '1')" in
      1) PROFS=(core sbc turn ai intercom);;
      3) PROFS=(core);;
      2) yn "sbc (SBC/WebRTC)"  && PROFS+=(sbc); yn "turn (Coturn)" && PROFS+=(turn); yn "ai (Voz IA)" && PROFS+=(ai); yn "intercom (go2rtc)" && PROFS+=(intercom);;
      *) r "Opcion invalida"; exit 1;;
    esac
  fi
  if [[ "$YES" != 1 ]]; then yn "Desplegar Nginx Proxy Manager (proxy)?" n && PROFS+=(proxy); fi
  CPROFILES="$(IFS=,; echo "${PROFS[*]}")"
  DOMAIN="${DOMAIN_F:-$( [[ "$YES" == 1 ]] && echo pbx.local || ask 'Dominio publico' 'pbx.tu-dominio.com')}"
  PUBLIC_IP="${PUBLIC_IP_F:-$( [[ "$YES" == 1 ]] && echo '' || ask 'IP publica (TURN/RTP, opcional)' '')}"
  ensure_env; gen_shared_secrets
  put DOMAIN "$DOMAIN"; put PUBLIC_IP "$PUBLIC_IP"; put TENANT_MODE "$TENANT_MODE"
  put DB_HOST "$LAN"; put ASTERISK_HOST "$LAN"; put SBC_HOST "$LAN"
  put TURN_HOST "$LAN"; put VOZ_HOST "$LAN"; put MEDIA_HOST "$LAN"
  put COMPOSE_PROFILES "$CPROFILES"
  deploy
;;
# ==========================================================================
core)
  TENANT_MODE="${TENANT_F:-single}"
  DOMAIN="${DOMAIN_F:-$( [[ "$YES" == 1 ]] && echo pbx.local || ask 'Dominio publico' 'pbx.tu-dominio.com')}"
  PUBLIC_IP="${PUBLIC_IP_F:-$( [[ "$YES" == 1 ]] && echo '' || ask 'IP publica (WAN)' '')}"
  EDGE_IP="${EDGE_IP:-$( [[ "$YES" == 1 ]] && echo '' || ask 'IP del EDGE/SBC en la LAN (vacio si aun no existe)' '')}"
  PROFS=(core)
  if [[ -n "$PROFILES" ]]; then IFS=',' read -ra PROFS <<< "core,$PROFILES"; PROFS=($(printf '%s\n' "${PROFS[@]}" | awk '!s[$0]++'));
  elif [[ "$YES" != 1 ]]; then yn "Incluir 'ai' (Voz IA/IVR)?" n && PROFS+=(ai); yn "Incluir 'intercom' (video go2rtc)?" n && PROFS+=(intercom); fi
  CPROFILES="$(IFS=,; echo "${PROFS[*]}")"
  SB="${EDGE_IP:-$LAN}"
  ensure_env; gen_shared_secrets
  put DOMAIN "$DOMAIN"; put PUBLIC_IP "$PUBLIC_IP"; put TENANT_MODE "$TENANT_MODE"
  put DB_HOST 127.0.0.1; put ASTERISK_HOST 127.0.0.1; put VOZ_HOST 127.0.0.1
  put SBC_HOST "$SB"; put TURN_HOST "$SB"; put MEDIA_HOST "$SB"
  put COMPOSE_PROFILES "$CPROFILES"
  # join file para el edge (secretos compartidos + IP del core)
  JF="$HERE/edge-join.env"
  { echo "# PBX-NG edge-join — generado $(date -Is). Copialo al EDGE y corre:"
    echo "#   ./install.sh --role=edge --join=edge-join.env"
    echo "CORE_IP=$LAN"; echo "DB_HOST=$LAN"; echo "ASTERISK_HOST=$LAN"
    echo "DB_NAME=$(getv DB_NAME)"; echo "DB_USER=$(getv DB_USER)"; echo "DB_PASS=$(getv DB_PASS)"
    echo "AMI_USER=$(getv AMI_USER)"; echo "AMI_PASS=$(getv AMI_PASS)"
    echo "ARI_USER=$(getv ARI_USER)"; echo "ARI_PASS=$(getv ARI_PASS)"
    echo "JWT_SECRET=$(getv JWT_SECRET)"
    echo "TURN_USER=$(getv TURN_USER)"; echo "TURN_PASS=$(getv TURN_PASS)"
    echo "PUBLIC_IP=$PUBLIC_IP"; echo "DOMAIN=$DOMAIN"
  } > "$JF"; chmod 600 "$JF"
  deploy
  echo; g "================================================================"
  g "  CORE listo.  Dashboard :3001 · API :3000"
  y "  Para el EDGE (SBC/TURN) copia el archivo de secretos:"
  echo "     scp $JF root@<IP-edge>:/opt/pbx-ng/docker/"
  echo "     # en el edge:  ./install.sh --role=edge --join=edge-join.env --public-ip=$PUBLIC_IP"
  r  "  Seguridad: restringi el acceso a Postgres (5432) SOLO desde la IP del edge."
  g "================================================================"
;;
# ==========================================================================
edge)
  if [[ -n "$JOIN" && -f "$JOIN" ]]; then set -a; . "$JOIN"; set +a; g "  join cargado: $JOIN"; fi
  CORE_IP="${CORE_IP:-}"; [[ -z "$CORE_IP" && "$YES" != 1 ]] && CORE_IP="$(ask 'IP del CORE (LAN)' '')"
  [[ -z "$CORE_IP" ]] && { r "Falta CORE_IP (usa --join=edge-join.env o --core-ip=)"; exit 1; }
  DB_HOST="${DB_HOST:-$CORE_IP}"; ASTERISK_HOST="${ASTERISK_HOST:-$CORE_IP}"
  PUBLIC_IP="${PUBLIC_IP_F:-${PUBLIC_IP:-}}"
  [[ -z "${DB_PASS:-}" ]] && { r "Falta DB_PASS (viene del edge-join.env del core)"; exit 1; }
  PROFS=(sbc turn); [[ -n "$PROFILES" ]] && IFS=',' read -ra PROFS <<< "$PROFILES"
  CPROFILES="$(IFS=,; echo "${PROFS[*]}")"
  c "Validando conectividad al core ($CORE_IP)…"
  ok=1
  for pp in "Postgres 5432" "Asterisk-AMI 5038" "Asterisk-ARI 8088"; do
    nm="${pp% *}"; pt="${pp#* }"
    if [[ "$(tcpok "$CORE_IP" "$pt")" == ok ]]; then g "  OK  $nm ($CORE_IP:$pt)"; else y "  ... $nm ($CORE_IP:$pt) no responde — revisa firewall/servicio"; ok=0; fi
  done
  [[ "$ok" == 0 && "$YES" != 1 ]] && { yn "Algunos puertos del core no responden. ¿Continuar igual?" n || { r "Abortado."; exit 1; }; }
  ensure_env
  put DB_HOST "$DB_HOST"; put DB_NAME "${DB_NAME:-pbxng}"; put DB_USER "${DB_USER:-pbxng}"; put DB_PASS "$DB_PASS"
  put ASTERISK_HOST "$ASTERISK_HOST"; put KAM_HOST 127.0.0.1
  put AMI_USER "${AMI_USER:-pbxng-ami}"; put AMI_PASS "${AMI_PASS:-}"
  put ARI_USER "${ARI_USER:-pbxng}"; put ARI_PASS "${ARI_PASS:-}"
  put JWT_SECRET "${JWT_SECRET:-$(gen 24)}"
  put TURN_USER "${TURN_USER:-pbxng}"; put TURN_PASS "${TURN_PASS:-$(gen 12)}"
  need TURN_CLI_PASS && put TURN_CLI_PASS "$(gen 10)"
  put PUBLIC_IP "$PUBLIC_IP"; put DOMAIN "${DOMAIN:-}"
  put TRUSTED_NET "${TRUSTED_NET:-}"
  put COMPOSE_PROFILES "$CPROFILES"
  deploy
  echo; g "================================================================"
  g "  EDGE (SBC/TURN) desplegado. Apunta al core en $CORE_IP."
  g "  Kamailio SIP :5060 · TURN :3478 · rtpengine (media)"
  r "  Abri al WAN solo: 5060/5061 (SIP), 3478+relay (TURN), 443 (WSS por proxy)."
  g "================================================================"
;;
*) r "Rol invalido: $ROLE (usa all | core | edge)"; exit 1;;
esac
