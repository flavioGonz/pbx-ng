#!/usr/bin/env bash
# PBX-NG · Asterisk entrypoint: genera los configs con secretos desde ENV,
# crea un cert TLS self-signed si falta, espera la DB y arranca Asterisk.
set -e

: "${DB_HOST:=127.0.0.1}"; : "${DB_PORT:=5432}"; : "${DB_NAME:=pbxng}"
: "${DB_USER:=pbxng}"; : "${DB_PASS:?DB_PASS requerido}"
: "${ARI_USER:=pbxng}"; : "${ARI_PASS:?ARI_PASS requerido}"
: "${AMI_USER:=pbxng-ami}"; : "${AMI_PASS:?AMI_PASS requerido}"
# redes autorizadas para AMI (la API). Por defecto rangos privados + loopback.
: "${AMI_PERMIT:=127.0.0.1/255.255.255.255,10.0.0.0/255.0.0.0,172.16.0.0/255.240.0.0,192.168.0.0/255.255.0.0}"

# --- res_pgsql.conf (realtime ARA) ---
cat > /etc/asterisk/res_pgsql.conf <<EOF
[general]
dbhost=${DB_HOST}
dbport=${DB_PORT}
dbname=${DB_NAME}
dbuser=${DB_USER}
dbpass=${DB_PASS}
EOF

# --- cdr_pgsql.conf ---
cat > /etc/asterisk/cdr_pgsql.conf <<EOF
[global]
hostname=${DB_HOST}
port=${DB_PORT}
dbname=${DB_NAME}
user=${DB_USER}
password=${DB_PASS}
table=cdr
EOF

# --- ari.conf ---
cat > /etc/asterisk/ari.conf <<EOF
[general]
enabled=yes
pretty=yes
allowed_origins=*

[${ARI_USER}]
type=user
password=${ARI_PASS}
password_format=plain
EOF

# --- manager.conf (AMI) ---
{
  echo "[general]"
  echo "enabled=yes"
  echo "port=5038"
  echo "bindaddr=0.0.0.0"
  echo
  echo "[${AMI_USER}]"
  echo "secret=${AMI_PASS}"
  echo "deny=0.0.0.0/0.0.0.0"
  IFS=','; for net in $AMI_PERMIT; do echo "permit=${net}"; done; unset IFS
  echo "read=all"
  echo "write=all"
} > /etc/asterisk/manager.conf

# --- cert TLS self-signed si no hay uno montado (transport-tls de pjsip.conf) ---
if [ ! -f /etc/asterisk/keys/pbxng.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout /etc/asterisk/keys/pbxng.key -out /etc/asterisk/keys/pbxng.crt \
    -subj "/CN=${DOMAIN:-pbx.local}" >/dev/null 2>&1 || true
  chown -R asterisk:asterisk /etc/asterisk/keys || true
fi

# --- esperar la base (realtime) ---
for i in $(seq 1 30); do
  if pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" >/dev/null 2>&1; then break; fi
  echo "esperando Postgres ${DB_HOST}:${DB_PORT} ($i)…"; sleep 2
done

# --- resolver la URL de la API en el dialplan (wake webhook, etc.) ---
sed -i "s|@@API_URL@@|${API_URL:-127.0.0.1:3000}|g" /etc/asterisk/extensions.conf 2>/dev/null || true

# --- agente HTTP PBX-NG (:8092) en background ---
# El script no usa token (la API le manda X-PBXNG-Token pero el agente no lo valida).
# Se arranca antes de Asterisk; las llamadas a "asterisk -rx" responderan vacio
# hasta que el core este arriba, sin romper el arranque.
python3 /usr/local/bin/pbxng-ast-agent.py &

exec "$@"
