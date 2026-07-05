#!/usr/bin/env bash
# ============================================================
#  PBX-NG · verificador de despliegue (correr en el nodo Proxmox, como root)
#  Audita el plan, cada CT del stack, Docker, puertos y salud de servicios.
#  Uso:  bash verify-pbxng.sh
# ============================================================
set -uo pipefail

C_OK=$'\e[32m'; C_BAD=$'\e[31m'; C_WARN=$'\e[33m'; C_H=$'\e[36m'; C_0=$'\e[0m'
line(){ printf '%s\n' "------------------------------------------------------------"; }
head(){ printf '\n%s== %s ==%s\n' "$C_H" "$1" "$C_0"; }

head "NODO PROXMOX"
hostname; pveversion 2>/dev/null | head -1
echo "Fecha: $(date)"
echo "Uptime:$(uptime | sed 's/.*up//;s/,.*load/ | load/')"
free -h | awk '/Mem:/{print "RAM: usada "$3" / total "$2" | libre "$4}'

head "CLUSTER"
pvecm status 2>/dev/null | grep -E 'Cluster name|Quorate|Nodes' || echo "(nodo standalone, sin cluster)"
echo "-- nodos online --"
pvesh get /cluster/resources --type node --output-format text 2>/dev/null | awk 'NR==1||/online/'

head "PLAN DE DESPLIEGUE"
if [ -f /etc/pbxng-deploy.plan ]; then cat /etc/pbxng-deploy.plan; else echo "${C_WARN}No existe /etc/pbxng-deploy.plan (¿se corrió el orquestador en este nodo?)${C_0}"; fi

head "CONTENEDORES LXC (pct list)"
pct list 2>/dev/null

# CTs del stack: por nombre pbxng-* o los del plan
CTS=$(pct list 2>/dev/null | awk 'NR>1{print $1" "$3}' | grep -Ei 'pbxng|pbx-ng' | awk '{print $1}')
[ -z "$CTS" ] && CTS=$(pct list 2>/dev/null | awk 'NR>1{print $1}')

for id in $CTS; do
  name=$(pct config "$id" 2>/dev/null | awk -F': ' '/^hostname/{print $2}')
  st=$(pct status "$id" 2>/dev/null | awk '{print $2}')
  head "CT $id  ($name)  estado=$st"
  [ "$st" != "running" ] && { echo "${C_BAD}CT no está corriendo${C_0}"; continue; }

  echo "-- IP --"
  pct exec "$id" -- bash -lc "hostname -I 2>/dev/null" 2>/dev/null
  echo "-- Docker --"
  pct exec "$id" -- bash -lc "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo 'docker no instalado/activo'" 2>/dev/null
  echo "-- compose (si aplica) --"
  pct exec "$id" -- bash -lc "cd /opt/pbx-ng/docker 2>/dev/null && docker compose ps 2>/dev/null | tail -n +1 || true" 2>/dev/null
  echo "-- contenedores no-sanos / reiniciando --"
  pct exec "$id" -- bash -lc "docker ps -a --filter health=unhealthy --filter status=restarting --format '{{.Names}} {{.Status}}' 2>/dev/null | grep . || echo 'ninguno'" 2>/dev/null
  echo "-- puertos en escucha (clave PBX) --"
  pct exec "$id" -- bash -lc "ss -tulnp 2>/dev/null | grep -E ':(5060|5061|5038|5432|6379|8088|3000|3001|3478|8080)\b' || echo 'sin puertos PBX escuchando'" 2>/dev/null
done

head "SALUD DE SERVICIOS (desde el nodo)"
CORE_IP=$(pct exec $(echo "$CTS"|head -1) -- bash -lc "hostname -I 2>/dev/null|awk '{print \$1}'" 2>/dev/null)
for id in $CTS; do
  ip=$(pct exec "$id" -- bash -lc "hostname -I 2>/dev/null|awk '{print \$1}'" 2>/dev/null)
  [ -z "$ip" ] && continue
  echo "-- CT $id ($ip) --"
  echo -n "API :3000/api/health -> "; curl -s -o /dev/null -w '%{http_code}\n' --max-time 4 "http://$ip:3000/api/health" 2>/dev/null || echo "sin respuesta"
  echo -n "Dashboard :3001     -> "; curl -s -o /dev/null -w '%{http_code}\n' --max-time 4 "http://$ip:3001" 2>/dev/null || echo "sin respuesta"
  echo -n "Asterisk ARI :8088  -> "; curl -s -o /dev/null -w '%{http_code}\n' --max-time 4 "http://$ip:8088/httpstatus" 2>/dev/null || echo "sin respuesta"
done

head "ÚLTIMOS ERRORES EN LOGS (por CT)"
for id in $CTS; do
  echo "-- CT $id --"
  pct exec "$id" -- bash -lc "docker ps --format '{{.Names}}' 2>/dev/null | while read c; do echo \"[\$c]\"; docker logs --tail 8 \"\$c\" 2>&1 | grep -iE 'error|fatal|denied|refused|cannot|exception' | tail -4; done" 2>/dev/null
done

head "FIN"
echo "Pegale toda esta salida a Claude para el análisis."
