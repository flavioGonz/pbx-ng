#!/usr/bin/env bash
# PBX-NG · Kamailio entrypoint: resuelve los @@TOKENS@@ desde ENV (sed dirigido,
# NO toca las variables $ de Kamailio), espera la DB y arranca.
set -e
: "${DB_HOST:=127.0.0.1}"; : "${DB_PORT:=5432}"; : "${DB_NAME:=pbxng}"
: "${DB_USER:=pbxng}"; : "${DB_PASS:?DB_PASS requerido}"
: "${ASTERISK_HOST:?ASTERISK_HOST requerido (IP/host de Asterisk)}"

SELF_IP="${SELF_IP:-$(hostname -I | awk '{print $1}')}"
: "${PUBLIC_IP:=$SELF_IP}"
# red confiable (salta anti-flood): por defecto el /24 del SELF_IP
if [ -z "${TRUSTED_NET:-}" ]; then
  TRUSTED_NET="$(echo "$SELF_IP" | awk -F. '{print $1"."$2"."$3".0/24"}')"
fi
DB_URL="postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

cd /etc/kamailio
# usar | como separador (DB_URL trae /)
sed -i \
  -e "s|@@DB_URL@@|${DB_URL}|g" \
  -e "s|@@ASTERISK_IP@@|${ASTERISK_HOST}|g" \
  -e "s|@@SELF_IP@@|${SELF_IP}|g" \
  -e "s|@@PUBLIC_IP@@|${PUBLIC_IP}|g" \
  -e "s|@@TRUSTED_NET@@|${TRUSTED_NET}|g" \
  kamailio.cfg dispatcher.list

# validar sintaxis antes de arrancar
kamailio -c -f /etc/kamailio/kamailio.cfg || { echo "kamailio.cfg inválido"; exit 1; }

for i in $(seq 1 30); do
  pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" >/dev/null 2>&1 && break
  echo "esperando Postgres ${DB_HOST}:${DB_PORT} ($i)…"; sleep 2
done

exec "$@"
