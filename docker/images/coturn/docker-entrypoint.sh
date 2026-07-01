#!/bin/sh
# PBX-NG · Coturn entrypoint: resuelve @@TOKENS@@ desde ENV -> /etc/turnserver.conf
set -e
: "${TURN_REALM:=${DOMAIN:-pbx.local}}"
: "${TURN_USER:=pbxng}"
: "${TURN_PASS:?TURN_PASS requerido}"
: "${TURN_CLI_PASS:=pbxng-cli}"
# IP privada del host (network_mode host): primera IP no loopback
SELF_IP="${SELF_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')}"
[ -n "$SELF_IP" ] || SELF_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | head -1)"
: "${TURN_EXT_IP:=${PUBLIC_IP:-$SELF_IP}}"

# Si TURN_EXT_IP es un hostname (IP dinamica via DDNS), resolver a IP
case "$TURN_EXT_IP" in
  *[a-zA-Z]*)
    RES="$(getent hosts "$TURN_EXT_IP" | awk '{print $1}' | head -1)"
    [ -n "$RES" ] && TURN_EXT_IP="$RES" ;;
esac
# NAT: anunciar IP publica mapeada a la IP privada del host
if [ -n "$SELF_IP" ] && [ -n "$TURN_EXT_IP" ] && [ "$TURN_EXT_IP" != "$SELF_IP" ]; then
  TURN_EXT_IP="${TURN_EXT_IP}/${SELF_IP}"
fi
echo "coturn: SELF_IP=${SELF_IP} external-ip=${TURN_EXT_IP}"

sed -e "s|@@TURN_REALM@@|${TURN_REALM}|g" \
    -e "s|@@TURN_USER@@|${TURN_USER}|g" \
    -e "s|@@TURN_PASS@@|${TURN_PASS}|g" \
    -e "s|@@TURN_EXT_IP@@|${TURN_EXT_IP}|g" \
    -e "s|@@TURN_CLI_PASS@@|${TURN_CLI_PASS}|g" \
    /etc/coturn/turnserver.tpl > /etc/turnserver.conf

[ -n "${TURN_EXT_IP}" ] || sed -i '/^external-ip=/d' /etc/turnserver.conf
sed -i 's|^log-file=.*|log-file=stdout|' /etc/turnserver.conf

# --- agente HTTP PBX-NG (:8091) en background ---
# El script no valida token (la API manda X-PBXNG-Token pero el agente lo ignora).
# NOTA: el agente usa "systemctl" para restart/estado de coturn, que NO existe en
# el contenedor; /health, /config (GET) y /logs funcionan, pero restart/apply de
# config y el flag "active" no operan bajo Docker (coturn corre como PID 1 via exec).
python3 /usr/local/bin/pbxng-turn-agent.py &

exec "$@"
