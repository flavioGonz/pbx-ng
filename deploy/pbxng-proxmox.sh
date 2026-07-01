#!/usr/bin/env bash
# ============================================================================
#  PBX-NG · Orquestador de despliegue para Proxmox VE
#  ----------------------------------------------------------------------------
#  Corre EN un nodo Proxmox (o cualquier nodo quorate del cluster) y crea por
#  si mismo todos los contenedores LXC necesarios, preguntando:
#    - forma de despliegue (compacto / standalone / hibrido / separado / custom)
#    - modo de la app (PBX simple / multi-tenant)
#    - donde ubicar cada componente (recomienda el nodo con mas RAM libre)
#  Cada CT corre Docker y levanta su(s) perfil(es) del docker-compose de PBX-NG.
#
#  Uso:   ./pbxng-proxmox.sh
#  Requisitos: ejecutarse en un host Proxmox VE 8/9 (pct, pvesh, pveam).
#  Es idempotente a nivel "plan": guarda el plan en /etc/pbxng-deploy.plan.
# ============================================================================
set -euo pipefail

REPO_URL="${PBXNG_REPO_URL:-https://github.com/flavioGonz/pbx-ng.git}"
REPO_BRANCH="${PBXNG_REPO_BRANCH:-main}"
PLAN_FILE="/etc/pbxng-deploy.plan"

# ---------- helpers de salida ----------
c(){ printf "\033[1;36m%s\033[0m\n" "$*"; }
g(){ printf "\033[1;32m%s\033[0m\n" "$*"; }
y(){ printf "\033[1;33m%s\033[0m\n" "$*"; }
r(){ printf "\033[1;31m%s\033[0m\n" "$*"; }
die(){ r "ERROR: $*"; exit 1; }
ask(){ local p="$1" d="${2:-}" a; read -rp "$(printf '\033[1m%s\033[0m %s: ' "$p" "${d:+[$d]}")" a; echo "${a:-$d}"; }
yn(){ local a; read -rp "$(printf '\033[1m%s\033[0m (s/n) [%s]: ' "$1" "${2:-s}")" a; a="${a:-${2:-s}}"; [[ "$a" =~ ^[sSyY] ]]; }

# ---------- preflight ----------
command -v pct   >/dev/null || die "Este script debe correr en un nodo Proxmox VE (no encuentro 'pct')."
command -v pvesh >/dev/null || die "No encuentro 'pvesh'. ¿Es un host Proxmox?"
[[ $EUID -eq 0 ]] || die "Corré como root."

clear 2>/dev/null || true
c "================================================================"
c "   PBX-NG · Orquestador de despliegue en Proxmox"
c "   Crea los contenedores LXC del stack y los deja corriendo"
c "================================================================"
echo

# ---------- descubrir el cluster ----------
c "Descubriendo el cluster…"
# nodos online + RAM libre (MB), ordenados por libre desc
mapfile -t NODE_ROWS < <(pvesh get /cluster/resources --type node --output-format json 2>/dev/null \
  | python3 -c '
import sys,json
for n in json.load(sys.stdin):
    if n.get("status")!="online": continue
    free=(n.get("maxmem",0)-n.get("mem",0))//(1024*1024)
    print(n["node"], free, n.get("maxcpu",0))
' | sort -k2 -nr)
[[ ${#NODE_ROWS[@]} -gt 0 ]] || die "No pude listar nodos online."
NODES=(); declare -A NODE_FREE
echo "   Nodos disponibles:"
for row in "${NODE_ROWS[@]}"; do
  nn=$(awk '{print $1}' <<<"$row"); nf=$(awk '{print $2}' <<<"$row"); nc=$(awk '{print $3}' <<<"$row")
  NODES+=("$nn"); NODE_FREE[$nn]=$nf
  printf "     - %-10s  RAM libre: %5s MB   CPUs: %s\n" "$nn" "$nf" "$nc"
done
BEST_NODE="${NODES[0]}"   # el de mas RAM libre
NEXTID=$(pvesh get /cluster/nextid 2>/dev/null || echo 200)
LOCAL_NODE=$(hostname -s)
# VMIDs ya usados en el cluster (para no chocar al asignar IDs)
cat > /tmp/pbxng_ids.py <<'PYIDS'
import sys, json
try:
    data = json.load(sys.stdin)
    print(" ".join(str(x.get("vmid","")) for x in data if x.get("vmid")))
except Exception:
    print("")
PYIDS
USED_IDS=" $(pvesh get /cluster/resources --type vm --output-format json 2>/dev/null | python3 /tmp/pbxng_ids.py) "
is_used(){ [[ "$USED_IDS" == *" $1 "* ]]; }
echo

# recomienda el nodo con mas RAM libre entre los online
recommend_node(){ echo "$BEST_NODE"; }

# ---------- 1) forma de despliegue ----------
c "1) Forma de despliegue"
echo "   1) Compacto      · 1 contenedor con TODO el stack                    (demo)"
echo "   2) Standalone    · 2 CTs: app+telefonía (DB+Asterisk+App) / SBC aparte  (RECOMENDADO stand-alone)"
echo "   3) Híbrido       · 3 CTs: núcleo / borde / voz"
echo "   4) Separado      · 1 contenedor por componente                       (aislamiento máx.)"
echo "   5) Personalizado · vos agrupás los servicios en los contenedores que quieras"
SHAPE=$(ask "Elegí" "2")
echo

# define los ROLES (nombre → perfiles docker-compose) segun la forma
declare -A ROLE_PROFILES ROLE_DESC
ROLES=()
case "$SHAPE" in
  1) ROLES=(all)
     ROLE_PROFILES[all]="core sbc media ai proxy"; ROLE_DESC[all]="Stack completo (DB+Asterisk+App+SBC+media+voz)" ;;
  2) ROLES=(main sbc)
     ROLE_PROFILES[main]="core media ai proxy"; ROLE_DESC[main]="App+telefonía: DB, Redis, Asterisk, API, Dashboard, media, voz, proxy"
     ROLE_PROFILES[sbc]="sbc";                  ROLE_DESC[sbc]="SBC: Kamailio + rtpengine (borde, aparte)" ;;
  3) ROLES=(core edge ai)
     ROLE_PROFILES[core]="core";            ROLE_DESC[core]="Núcleo: DB, Redis, Asterisk, API, Dashboard"
     ROLE_PROFILES[edge]="sbc media proxy"; ROLE_DESC[edge]="Borde: SBC Kamailio, rtpengine, TURN, Proxy"
     ROLE_PROFILES[ai]="ai";                ROLE_DESC[ai]="Voz IA: TTS/STT (pesado, aislado)" ;;
  4) ROLES=(core sbc media ai proxy)
     ROLE_PROFILES[core]="core";   ROLE_DESC[core]="Núcleo: DB, Redis, Asterisk, API, Dashboard"
     ROLE_PROFILES[sbc]="sbc";     ROLE_DESC[sbc]="SBC: Kamailio + rtpengine"
     ROLE_PROFILES[media]="media"; ROLE_DESC[media]="Media: Coturn (TURN/STUN)"
     ROLE_PROFILES[ai]="ai";       ROLE_DESC[ai]="Voz IA: TTS/STT"
     ROLE_PROFILES[proxy]="proxy"; ROLE_DESC[proxy]="Proxy inverso: Nginx Proxy Manager" ;;
  5) # personalizado: el usuario agrupa los 5 perfiles en N contenedores
     c "Modo personalizado — agrupá los servicios en contenedores"
     echo "   Perfiles: core (DB+Asterisk+App) · sbc · media (TURN) · ai (voz) · proxy (NPM)"
     echo "   Poné un número de grupo a cada uno (mismo número = mismo contenedor)."
     echo
     declare -A GRP SEEN
     for p in core sbc media ai proxy; do GRP[$p]=$(ask "   Grupo para '$p'" "1"); done
     for p in core sbc media ai proxy; do
       gid="${GRP[$p]}"; rname="g${gid}"
       if [[ -z "${SEEN[$gid]:-}" ]]; then ROLES+=("$rname"); ROLE_PROFILES[$rname]="$p"; SEEN[$gid]=1
       else ROLE_PROFILES[$rname]="${ROLE_PROFILES[$rname]} $p"; fi
       ROLE_DESC[$rname]="Grupo $gid"
     done
     [[ ${#ROLES[@]} -gt 0 ]] || die "No definiste ningún grupo." ;;
  *) die "Opción inválida" ;;
esac

# rol que contiene el núcleo (DB+Asterisk+API): los demás CTs apuntan a su IP
CORE_ROLE=""
for role in "${ROLES[@]}"; do [[ " ${ROLE_PROFILES[$role]} " == *" core "* ]] && CORE_ROLE="$role"; done
[[ -n "$CORE_ROLE" ]] || die "Ningún contenedor incluye el perfil 'core' (DB/Asterisk/App)."

# ---------- 2) modo de la aplicacion ----------
c "2) Modo de la aplicación"
echo "   1) PBX simple (single-tenant)  · una sola empresa, UI plana   (RECOMENDADO)"
echo "   2) Multi-tenant (SaaS)         · varias empresas aisladas"
TMODE_SEL=$(ask "Elegí" "1")
[[ "$TMODE_SEL" == "2" ]] && TENANT_MODE="multi" || TENANT_MODE="single"
echo

# ---------- 3) parametros generales ----------
c "3) Parámetros generales"
DOMAIN=$(ask "Dominio público" "pbx.tu-dominio.com")
PUBLIC_IP=$(ask "IP pública (TURN/RTP, opcional)" "")
NET_MODE=$(ask "Red de los contenedores: dhcp / static" "dhcp")
BRIDGE=$(ask "Bridge de red" "vmbr0")
GW=""; STATIC_BASE=""
if [[ "$NET_MODE" == "static" ]]; then
  GW=$(ask "Gateway" "192.168.1.1")
  STATIC_BASE=$(ask "IP base (se asigna secuencial /24, ej 192.168.1.50)" "192.168.1.50")
fi
# detectar plantilla Debian ya descargada en 'local'; si no hay, ofrecer descargarla
DETECTED_TPL=$(pveam list local 2>/dev/null | awk '/debian-12-standard/{print $1; exit}')
if [[ -z "$DETECTED_TPL" ]]; then
  pveam update >/dev/null 2>&1 || true
  AVAIL=$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/{print $2}' | sort -V | tail -1)
  if [[ -n "$AVAIL" ]]; then
    y "No hay plantilla Debian 12 en 'local'. Disponible: $AVAIL"
    if yn "¿La descargo ahora?" "s"; then
      c "Descargando $AVAIL (una vez)…"
      pveam download local "$AVAIL" && DETECTED_TPL="local:vztmpl/$AVAIL"
    fi
  fi
fi
TEMPLATE=$(ask "Plantilla LXC" "${DETECTED_TPL:-local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst}")
while :; do
  STORAGE=$(ask "Storage/pool para discos (nombre, ej. local-lvm)" "local-lvm")
  if pvesm status 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$STORAGE"; then break; fi
  r "  Storage '$STORAGE' no existe. Disponibles: $(pvesm status 2>/dev/null | awk 'NR>1{print $1}' | paste -sd, -)"
done
echo

# recursos por rol, derivados de los PERFILES que agrupa (cores/RAM MB/disco GB)
res_for(){
  local p=" ${ROLE_PROFILES[$1]} " cores=1 ram=1024 disk=8
  [[ "$p" == *" core "* ]]  && { cores=4; ram=4096; disk=20; }
  [[ "$p" == *" ai "*   ]]  && { (( cores<4 )) && cores=4; ram=$((ram+2048)); disk=$((disk+8)); }
  [[ "$p" == *" sbc "*  ]]  && { (( cores<2 )) && cores=2; (( ram<2048 )) && ram=2048; (( disk<12 )) && disk=12; }
  echo "$cores $ram $disk"
}

# ---------- 4) planificar: VMID, nodo, recursos por rol ----------
c "4) Recursos por componente (todos los CTs se crean en este nodo: $LOCAL_NODE)"
declare -A ROLE_ID ROLE_NODE ROLE_CORES ROLE_RAM ROLE_DISK ROLE_IP
id=$NEXTID; idx=0
for role in "${ROLES[@]}"; do
  read -r rc rm rd <<<"$(res_for "$role")"
  echo
  y "   • ${role}  — ${ROLE_DESC[$role]}"
  echo "     perfiles: ${ROLE_PROFILES[$role]}   recursos: ${rc} vCPU / ${rm} MB / ${rd} GB"
  while is_used "$id"; do id=$((id+1)); done
  ROLE_ID[$role]=$id
  ROLE_NODE[$role]="$LOCAL_NODE"
  ROLE_CORES[$role]=$rc; ROLE_RAM[$role]=$rm; ROLE_DISK[$role]=$rd
  if [[ "$NET_MODE" == "static" ]]; then
    base_last="${STATIC_BASE##*.}"; base_net="${STATIC_BASE%.*}"
    ROLE_IP[$role]="${base_net}.$((base_last+idx))"
  fi
  id=$((id+1)); idx=$((idx+1))
done
echo

# hostname de los CTs
PREFIX=$(ask "Prefijo de hostname" "pbxng")

# ---------- resumen + confirmar ----------
c "================================================================"
c "  RESUMEN DEL DESPLIEGUE"
c "================================================================"
echo "  Forma        : $SHAPE   ($(printf '%s ' "${ROLES[@]}"))"
echo "  Modo app     : $TENANT_MODE"
echo "  Dominio      : $DOMAIN"
echo "  Red          : $NET_MODE (bridge $BRIDGE)"
echo "  Plantilla    : $TEMPLATE   Storage: $STORAGE"
echo "  Repo         : $REPO_URL ($REPO_BRANCH)"
echo "  ---------------------------------------------------------------"
for role in "${ROLES[@]}"; do
  printf "  %-6s CT %s  @ %-8s  %s vCPU/%sMB/%sGB  %s\n" \
    "$role" "${ROLE_ID[$role]}" "${ROLE_NODE[$role]}" \
    "${ROLE_CORES[$role]}" "${ROLE_RAM[$role]}" "${ROLE_DISK[$role]}" \
    "${ROLE_IP[$role]:-dhcp}"
done
c "================================================================"
echo
yn "¿Creo estos contenedores y despliego?" "n" || { y "Cancelado."; exit 0; }
echo

# genera secretos una sola vez (compartidos entre CTs para que se entiendan)
DB_PASS=$(openssl rand -hex 12)
JWT_SECRET=$(openssl rand -hex 24)
ARI_PASS=$(openssl rand -hex 8)
AMI_PASS=$(openssl rand -hex 8)

# ---------- helper: crear un CT ----------
create_ct(){
  local role="$1" ctid="${ROLE_ID[$role]}" node="${ROLE_NODE[$role]}"
  local host="${PREFIX}-${role}"
  local net="name=eth0,bridge=${BRIDGE}"
  if [[ "$NET_MODE" == "static" ]]; then net+=",ip=${ROLE_IP[$role]}/24,gw=${GW}"; else net+=",ip=dhcp"; fi

  c "→ Creando CT $ctid ($host) en $node…"
  pct create "$ctid" "$TEMPLATE" \
    --hostname "$host" \
    --cores "${ROLE_CORES[$role]}" --memory "${ROLE_RAM[$role]}" --swap 512 \
    --rootfs "${STORAGE}:${ROLE_DISK[$role]}" \
    --net0 "$net" \
    --features nesting=1,keyctl=1 \
    --unprivileged 1 --onboot 1 --start 1 >/dev/null
  # esperar arranque + IP
  local ip="" tries=0
  while [[ -z "$ip" && $tries -lt 30 ]]; do
    sleep 2; tries=$((tries+1))
    ip=$(pct exec "$ctid" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
  done
  [[ -n "$ip" ]] || die "CT $ctid no obtuvo IP."
  ROLE_IP[$role]="$ip"
  g "   CT $ctid arriba · IP $ip"
}

# ---------- helper: instalar Docker + PBX-NG dentro de un CT ----------
provision_ct(){
  local role="$1" ctid="${ROLE_ID[$role]}"
  local profiles="${ROLE_PROFILES[$role]}"
  local core_ip="${ROLE_IP[$CORE_ROLE]:-127.0.0.1}"

  c "→ Aprovisionando CT $ctid (perfiles: $profiles)…"
  # instalar dependencias + docker
  pct exec "$ctid" -- bash -lc '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl git gnupg >/dev/null
    if ! command -v docker >/dev/null; then
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release; echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
    fi
  '
  # clonar repo
  pct exec "$ctid" -- bash -lc "
    set -e
    [[ -d /opt/pbx-ng ]] || git clone -q --branch '$REPO_BRANCH' '$REPO_URL' /opt/pbx-ng
  "
  # escribir .env (inyecta la IP del núcleo para servicios que viven en otro CT)
  pct exec "$ctid" -- bash -lc "
    set -e
    cd /opt/pbx-ng/docker
    cp -n .env.example .env 2>/dev/null || true
    cat > .env <<EOF
DOMAIN=$DOMAIN
PUBLIC_IP=$PUBLIC_IP
TENANT_MODE=$TENANT_MODE
DB_HOST=$core_ip
DB_PORT=5432
DB_NAME=pbxng
DB_USER=pbxng
DB_PASS=$DB_PASS
ARI_URL=http://$core_ip:8088
ARI_USER=pbxng
ARI_PASS=$ARI_PASS
AMI_HOST=$core_ip
AMI_PORT=5038
AMI_USER=pbxng-ami
AMI_PASS=$AMI_PASS
ASTERISK_HOST=$core_ip
REDIS_HOST=$core_ip
JWT_SECRET=$JWT_SECRET
EOF
  "
  # levantar los perfiles de este rol
  local args=""
  for p in $profiles; do args="$args --profile $p"; done
  # compilar asterisk SOLO primero (evita OOM por builds en paralelo)
  if [[ " $profiles " == *" core "* ]]; then
    pct exec "$ctid" -- bash -lc "cd /opt/pbx-ng/docker && docker compose build asterisk" \
      || y "   (build de asterisk con warnings)"
  fi
  pct exec "$ctid" -- bash -lc "cd /opt/pbx-ng/docker && docker compose $args up -d --build" \
    || y "   (algunos servicios pueden tardar en construir; revisá con 'docker compose ps')"
  g "   CT $ctid aprovisionado."
}

# ---------- ejecutar: primero el nucleo (para tener su IP), luego el resto ----------
ORDER=("$CORE_ROLE")
for role in "${ROLES[@]}"; do [[ "$role" == "$CORE_ROLE" ]] || ORDER+=("$role"); done

for role in "${ORDER[@]}"; do create_ct "$role"; done
for role in "${ORDER[@]}"; do provision_ct "$role"; done

# ---------- persistir el plan ----------
{
  echo "# PBX-NG deploy plan · $(date -Is)"
  echo "SHAPE=$SHAPE TENANT_MODE=$TENANT_MODE DOMAIN=$DOMAIN"
  for role in "${ROLES[@]}"; do
    echo "$role CT=${ROLE_ID[$role]} node=${ROLE_NODE[$role]} ip=${ROLE_IP[$role]} profiles=\"${ROLE_PROFILES[$role]}\""
  done
} > "$PLAN_FILE"

# ---------- resumen final ----------
echo
g "================================================================"
g "  PBX-NG desplegado en Proxmox"
g "================================================================"
for role in "${ROLES[@]}"; do
  printf "  %-6s CT %-4s  %s\n" "$role" "${ROLE_ID[$role]}" "${ROLE_IP[$role]}"
done
CORE_IP="${ROLE_IP[$CORE_ROLE]:-}"
echo "  ---------------------------------------------------------------"
g "  Dashboard : http://$CORE_IP:3001"
g "  API       : http://$CORE_IP:3000"
PROXY_ROLE=""; for role in "${ROLES[@]}"; do [[ " ${ROLE_PROFILES[$role]} " == *" proxy "* ]] && PROXY_ROLE="$role"; done
[[ -n "$PROXY_ROLE" ]] && g "  Proxy NPM : http://${ROLE_IP[$PROXY_ROLE]}:81  (admin@example.com / changeme)"
g "  Modo app  : $TENANT_MODE   Plan guardado en $PLAN_FILE"
y "  Publicá el dominio con TLS/WSS desde el proxy inverso y abrí los"
y "  puertos SIP/RTP/TURN en tu firewall/NAT."
g "================================================================"
