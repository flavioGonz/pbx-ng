#!/bin/sh
# PBX-NG · vigila la IP dinamica del dominio y reinicia rtpengine/coturn al cambiar
DOMAIN="${PBXNG_DDNS_DOMAIN:-pbx01.infratec.com.uy}"
STATE="/var/lib/pbxng-ip-watch.ip"
CUR="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)"
[ -z "$CUR" ] && { echo "$(date -Is) sin resolucion de $DOMAIN"; exit 0; }
LAST="$(cat "$STATE" 2>/dev/null)"
if [ "$CUR" != "$LAST" ]; then
  echo "$(date -Is) IP de $DOMAIN cambio: ${LAST:-<none>} -> $CUR ; reiniciando rtpengine/coturn"
  docker restart pbxng-rtpengine-1 pbxng-coturn-1 >/dev/null 2>&1 || true
  echo "$CUR" > "$STATE"
else
  echo "$(date -Is) sin cambios ($CUR)"
fi
#!/bin/sh
# PBX-NG · vigila la IP dinamica del dominio y reinicia rtpengine/coturn al cambiar
DOMAIN="${PBXNG_DDNS_DOMAIN:-pbx01.infratec.com.uy}"
STATE="/var/lib/pbxng-ip-watch.ip"
CUR="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)"
[ -z "$CUR" ] && { echo "$(date -Is) sin resolucion de $DOMAIN"; exit 0; }
LAST="$(cat "$STATE" 2>/dev/null)"
if [ "$CUR" != "$LAST" ]; then
  echo "$(date -Is) IP de $DOMAIN cambio: ${LAST:-<none>} -> $CUR ; reiniciando rtpengine/coturn"
  docker restart pbxng-rtpengine-1 pbxng-coturn-1 >/dev/null 2>&1 || true
  echo "$CUR" > "$STATE"
else
  echo "$(date -Is) sin cambios ($CUR)"
fi

