#!/bin/sh
# PBX-NG · Coturn entrypoint: resuelve @@TOKENS@@ desde ENV → /etc/turnserver.conf
set -e
: "${TURN_REALM:=${DOMAIN:-pbx.local}}"
: "${TURN_USER:=pbxng}"
: "${TURN_PASS:?TURN_PASS requerido}"
: "${TURN_CLI_PASS:=pbxng-cli}"
SELF_IP="${SELF_IP:-$(hostname -i 2>/dev/null | awk '{print $1}')}"
: "${TURN_EXT_IP:=${PUBLIC_IP:-$SELF_IP}}"

sed -e "s|@@TURN_REALM@@|${TURN_REALM}|g" \
    -e "s|@@TURN_USER@@|${TURN_USER}|g" \
    -e "s|@@TURN_PASS@@|${TURN_PASS}|g" \
    -e "s|@@TURN_EXT_IP@@|${TURN_EXT_IP}|g" \
    -e "s|@@TURN_CLI_PASS@@|${TURN_CLI_PASS}|g" \
    /etc/coturn/turnserver.tpl > /etc/turnserver.conf

# si no hay IP externa, quitar la línea (coturn rechaza external-ip vacío)
[ -n "${TURN_EXT_IP}" ] || sed -i '/^external-ip=/d' /etc/turnserver.conf
# loguear a stdout en contenedor
sed -i 's|^log-file=.*|log-file=stdout|' /etc/turnserver.conf

exec "$@"
