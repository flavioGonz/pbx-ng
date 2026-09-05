#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Instalador
#  Roles:
#    all   · Todo en esta maquina (nucleo + TURN + IA + intercom)     [default]
#    core  · Solo el nucleo (Asterisk + API + Dashboard + Postgres);
#            el TURN puede vivir en otro host (--turn-ip=)
#
#  Modelo: MODULO = PERFIL de compose = CONTENEDOR (COMPOSE_PROFILES en .env).
#  El borde SIP (SBC) NO es parte de PBX-NG: es otro producto, SBC-NG, con su
#  propio instalador. La central funciona completa sin el; si hay uno adelante
#  se conecta desde el panel (Configuracion -> SBC-NG).
#
#  Uso interactivo:   ./install.sh
#  No interactivo:    ./install.sh --role=all  --public-ip=1.2.3.4 --domain=pbx.x.com --yes
#                     ./install.sh --role=core --public-ip=1.2.3.4 --domain=pbx.x.com --turn-ip=10.0.0.20 --yes
#  Flags: --role= --profiles=a,b --turn-ip= --public-ip= --domain=
#         --tenant=single|multi --release --yes --print-firewall
#
#  Firewall/NAT: es REQUISITO, no un anexo. Al terminar, el instalador imprime
#  exactamente que abrir segun los modulos activos y verifica el TURN de verdad
#  (STUN Binding + TURN Allocate). Detalle completo en docs/FIREWALL.md.
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
ROLE=""; PROFILES=""; TURN_IP=""; PUBLIC_IP_F=""; DOMAIN_F=""; TENANT_F=""; RELEASE=0; YES=0; PRINT_FW=0
for a in "$@"; do case "$a" in
  --role=*) ROLE="${a#*=}";; --profiles=*) PROFILES="${a#*=}";;
  --turn-ip=*) TURN_IP="${a#*=}";; --edge-ip=*) TURN_IP="${a#*=}";;   # --edge-ip: compatibilidad
  --public-ip=*) PUBLIC_IP_F="${a#*=}";; --domain=*) DOMAIN_F="${a#*=}";;
  --join=*) ;; --tenant=*) TENANT_F="${a#*=}";;
  --release) RELEASE=1;; --yes|-y) YES=1;;
  --print-firewall) PRINT_FW=1;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
  *) r "arg desconocido: $a"; exit 1;;
esac; done

clear 2>/dev/null || true
c "================================================================"
c "   PBX-NG · Instalador (all | core)"
c "================================================================"; echo

if [[ "$PRINT_FW" != 1 ]]; then
  command -v docker >/dev/null || { r "Falta Docker: https://docs.docker.com/engine/install/"; exit 1; }
  docker compose version >/dev/null 2>&1 || { r "Falta el plugin 'docker compose'."; exit 1; }
fi

# ---------------- rol ----------------
if [[ -z "$ROLE" ]]; then
  if [[ "$YES" == 1 || "$PRINT_FW" == 1 ]]; then ROLE=all; else
    c "Rol de esta VM/host"
    echo "   1) all   · Todo en esta maquina (nucleo + TURN + IA + intercom)   (RECOMENDADO)"
    echo "   2) core  · Solo el nucleo (Asterisk+API+Dashboard+DB); TURN en otro host"
    case "$(ask 'Elegi' '1')" in 1) ROLE=all;; 2) ROLE=core;; *) r "Opcion invalida"; exit 1;; esac
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
# Con NPM en este mismo compose (perfil proxy) el panel se ata a loopback: NPM le
# llega por la red bridge (dashboard:3001) y nadie de la LAN puede entrar directo a
# :3001 con un X-Forwarded-For inventado (falsificaria la IP del rate limit del login).
# Sin proxy queda en 0.0.0.0 porque :3001 ES la entrada al panel.
put_dashboard_bind(){   # $1 = perfiles activos (csv)
  if [[ ",$1," == *",proxy,"* ]]; then put DASHBOARD_BIND 127.0.0.1; else put DASHBOARD_BIND 0.0.0.0; fi
}
# Respaldo programado: una linea en el cron del host (3:00) que corre backup-cron.sh
# (respaldo + retencion BACKUP_KEEP dentro del contenedor de la API). Idempotente:
# si la linea ya esta no la duplica; si apunta a otro directorio la reemplaza.
install_backup_cron(){
  local sh="$HERE/backup-cron.sh" tag="# pbxng-backup" line cur
  [[ -f "$sh" ]] || return 0
  chmod +x "$sh" "$HERE/asterisk-drain.sh" 2>/dev/null || true
  has BACKUP_KEEP || put BACKUP_KEEP 14
  line="0 3 * * * $sh >/dev/null 2>&1 $tag"
  if [[ -d /etc/cron.d ]]; then
    # cron.d exige usuario: root, que es quien puede hablar con Docker.
    printf 'SHELL=/bin/bash\n0 3 * * * root %s >/dev/null 2>&1 %s\n' "$sh" "$tag" > /etc/cron.d/pbxng-backup 2>/dev/null \
      && chmod 644 /etc/cron.d/pbxng-backup && { g "  respaldo programado: todos los dias 03:00 (/etc/cron.d/pbxng-backup)"; return 0; }
  fi
  if command -v crontab >/dev/null; then
    cur="$(crontab -l 2>/dev/null | grep -v "$tag" || true)"
    printf '%s\n%s\n' "$cur" "$line" | sed '/^$/d' | crontab - 2>/dev/null \
      && { g "  respaldo programado: todos los dias 03:00 (crontab de $(id -un))"; return 0; }
  fi
  y "  (no pude instalar el cron del respaldo; agregalo a mano: $line)"
}
deploy(){
  preflight_secrets
  install_ctl
  install_backup_cron
  c "Desplegando [$ROLE]  modulos: $CPROFILES  (compose: $CF)"
  COMPOSE_PROFILES="$CPROFILES" docker compose -f "$CF" "${UP[@]}"
  echo; c "Estado"; COMPOSE_PROFILES="$CPROFILES" docker compose -f "$CF" ps
  if [[ " $CPROFILES " == *" core "* ]]; then
    echo; g "  Usuario admin inicial:  admin  /  $(getv ADMIN_DEFAULT_PASS)"
    y "  (se te pedirá cambiarla en el primer ingreso)"
  fi
}

# ---------------- firewall / NAT ----------------
fw_note(){   # $1 = perfiles activos (csv)
  local P=",${1:-core},"
  echo; c "================================================================"
  c "  FIREWALL / NAT — abrir SOLO esto hacia Internet"
  c "================================================================"
  echo "  443/TCP            HTTPS + WSS (softphone WebRTC)      -> reverse proxy"
  echo "  80/TCP             ACME (Let's Encrypt), si aplica     -> reverse proxy"
  echo "  5060/UDP+TCP       SIP de Asterisk (troncales / telefonos remotos) -> esta VM"
  echo "                     (si hay un SBC-NG adelante, esto se publica en el SBC, no aca)"
  echo "  5061/TCP           SIP TLS (opcional)"
  echo "  10000-20000/UDP    RTP de Asterisk (medios de troncales y telefonos remotos)"
  if [[ "$P" == *",turn,"* ]]; then
  y "  3478/UDP  Y  3478/TCP    STUN/TURN (coturn)               <- LOS DOS"
  y "  49152-65535/UDP          Rango RELAY del TURN             <- SIN ESTO NO HAY AUDIO"
  echo "  5349/TCP           TURNS (TLS) — recomendado para redes corporativas"
  fi
  echo
  r "  NUNCA publicar: 5432 (Postgres), 3000/3001 (API/panel), 5038 (AMI),"
  r "                  8088 (ARI), 8091/8092 (agentes), 81 (NPM admin)."
  echo "  (5432 y 3000 solo escuchan en 127.0.0.1 del host: los necesita Asterisk, que corre en host network)"
  if [[ "$P" == *",turn,"* ]]; then
    echo
    y "  NAT hairpin: si probas el TURN por el FQDN publico DESDE LA LAN y falla"
    y "  (error ICE 701), tu router no hace loopback. La regla dst-nat debe matchear"
    y "  tambien el trafico que nace en la LAN (ojo con in-interface=WAN/all-ppp)."
  fi
  echo "  Detalle, recetas y troubleshooting:  docs/FIREWALL.md"
  c "================================================================"
}
turn_selfcheck(){   # verificacion REAL: STUN Binding + TURN Allocate (401 -> firmado -> 200 relay)
  local CK="$HERE/../scripts/check-turn.py" H
  [[ -x "$CK" || -f "$CK" ]] || return 0
  command -v python3 >/dev/null || return 0
  H="$(getv DOMAIN)"; [[ -z "$H" || "$H" == pbx.local ]] && H="$(getv PUBLIC_IP)"
  [[ -z "$H" ]] && { y "  (sin DOMAIN/PUBLIC_IP: salteo el chequeo de TURN)"; return 0; }
  echo; c "Verificando el TURN de verdad (candidato relay) contra $H ..."
  python3 "$CK" --host "$H" --user "$(getv TURN_USER)" --pass "$(getv TURN_PASS)" --tcp || {
    y "  El TURN no entrega candidato relay. Los clientes detras de NAT simetrico"
    y "  quedaran sin audio. Revisa docs/FIREWALL.md (port-forward 3478 + rango relay)."; }
}

if [[ "$PRINT_FW" == 1 ]]; then ROLE="${ROLE:-all}"; fw_note "${PROFILES:-core,turn}"; exit 0; fi

case "$ROLE" in
# ==========================================================================
all)
  TENANT_MODE="${TENANT_F:-single}"
  c "Modulos (perfiles). core siempre; el resto opcional."
  PROFS=(core)
  if [[ -n "$PROFILES" ]]; then IFS=',' read -ra PROFS <<< "core,$PROFILES"; PROFS=($(printf '%s\n' "${PROFS[@]}" | awk '!s[$0]++'));
  elif [[ "$YES" == 1 ]]; then PROFS=(core turn ai intercom); else
    echo "   1) Todo (core+turn+ai+intercom)   2) Elegir   3) Solo core"
    case "$(ask 'Elegi' '1')" in
      1) PROFS=(core turn ai intercom);;
      3) PROFS=(core);;
      2) yn "turn (Coturn, WebRTC detras de NAT)" && PROFS+=(turn); yn "ai (Voz IA)" && PROFS+=(ai); yn "intercom (go2rtc)" && PROFS+=(intercom);;
      *) r "Opcion invalida"; exit 1;;
    esac
  fi
  if [[ "$YES" != 1 ]]; then yn "Desplegar Nginx Proxy Manager (proxy)?" n && PROFS+=(proxy); fi
  CPROFILES="$(IFS=,; echo "${PROFS[*]}")"
  DOMAIN="${DOMAIN_F:-$( [[ "$YES" == 1 ]] && echo pbx.local || ask 'Dominio publico' 'pbx.tu-dominio.com')}"
  PUBLIC_IP="${PUBLIC_IP_F:-$( [[ "$YES" == 1 ]] && echo '' || ask 'IP publica (TURN/RTP, opcional)' '')}"
  ensure_env; gen_shared_secrets
  put DOMAIN "$DOMAIN"; put PUBLIC_IP "$PUBLIC_IP"; put TENANT_MODE "$TENANT_MODE"
  # DB_HOST es 127.0.0.1 y no la IP LAN: Postgres solo escucha en loopback del host
  # y el unico que lo usa por fuera de la red interna es Asterisk (host network).
  put DB_HOST 127.0.0.1; put ASTERISK_HOST "$LAN"
  put TURN_HOST "$LAN"; put VOZ_HOST "$LAN"; put MEDIA_HOST "$LAN"
  put_dashboard_bind "$CPROFILES"
  put COMPOSE_PROFILES "$CPROFILES"; put PBXNG_COMPOSE_FILE "$CF"
  deploy
  echo; g "================================================================"
  if [[ ",$CPROFILES," == *",proxy,"* ]]; then
    g "  Listo.  Panel: https://$DOMAIN (por NPM, publicalo en :81 -> http://dashboard:3001)"
    y "  :3001 quedo en 127.0.0.1 del host: con proxy se entra por 443, no por :3001."
  else
    g "  Listo.  Panel: http://$LAN:3001 (la API queda en 127.0.0.1:3000, solo local)"
  fi
  g "================================================================"
  fw_note "$CPROFILES"
  [[ "$CPROFILES" == *turn* ]] && turn_selfcheck
;;
# ==========================================================================
core)
  TENANT_MODE="${TENANT_F:-single}"
  DOMAIN="${DOMAIN_F:-$( [[ "$YES" == 1 ]] && echo pbx.local || ask 'Dominio publico' 'pbx.tu-dominio.com')}"
  PUBLIC_IP="${PUBLIC_IP_F:-$( [[ "$YES" == 1 ]] && echo '' || ask 'IP publica (WAN)' '')}"
  TURN_IP="${TURN_IP:-$( [[ "$YES" == 1 ]] && echo '' || ask 'IP del host TURN (coturn) si esta separado (vacio = esta VM)' '')}"
  PROFS=(core)
  if [[ -n "$PROFILES" ]]; then IFS=',' read -ra PROFS <<< "core,$PROFILES"; PROFS=($(printf '%s\n' "${PROFS[@]}" | awk '!s[$0]++'));
  elif [[ "$YES" != 1 ]]; then yn "Incluir 'ai' (Voz IA/IVR)?" n && PROFS+=(ai); yn "Incluir 'intercom' (video go2rtc)?" n && PROFS+=(intercom); fi
  CPROFILES="$(IFS=,; echo "${PROFS[*]}")"
  ensure_env; gen_shared_secrets
  put DOMAIN "$DOMAIN"; put PUBLIC_IP "$PUBLIC_IP"; put TENANT_MODE "$TENANT_MODE"
  # ASTERISK_HOST lo usa la API (red bridge) para llegar a ARI/AMI/agente de Asterisk,
  # que corre en host network: tiene que ser la IP LAN del host, nunca 127.0.0.1
  # (dentro del contenedor de la API eso seria la propia API).
  put DB_HOST 127.0.0.1; put ASTERISK_HOST "$LAN"; put VOZ_HOST "$LAN"; put MEDIA_HOST "$LAN"
  put TURN_HOST "${TURN_IP:-$LAN}"
  put_dashboard_bind "$CPROFILES"
  put COMPOSE_PROFILES "$CPROFILES"; put PBXNG_COMPOSE_FILE "$CF"
  deploy
  echo; g "================================================================"
  if [[ ",$CPROFILES," == *",proxy,"* ]]; then
    g "  CORE listo.  Panel: https://$DOMAIN (por NPM; :3001 quedo en 127.0.0.1, con proxy se entra por 443)"
  else
    g "  CORE listo.  Panel: http://$LAN:3001 (la API queda en 127.0.0.1:3000, solo local)"
    y "  Si el reverse proxy esta en OTRO host: DASHBOARD_TRUST_PROXY=1 en .env y restringi :3001 a su IP."
  fi
  [[ -n "$TURN_IP" ]] && y "  TURN esperado en $TURN_IP:3478 (instalalo con: ./install.sh --role=all --profiles=turn en ese host, mismas TURN_USER/TURN_PASS)"
  y "  Si hay un SBC-NG adelante, conectalo desde el panel: Configuracion -> SBC-NG."
  g "================================================================"
  fw_note "$CPROFILES"
;;
# ==========================================================================
*) r "Rol invalido: $ROLE (usa all | core)"; exit 1;;
esac
