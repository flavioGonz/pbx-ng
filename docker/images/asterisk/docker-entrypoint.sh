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

# --- config que genera el panel (aparcado, captura, música en espera) ---
# Los .conf horneados hacen #include de pbxng.d/. Si el panel todavía no escribió nada,
# dejamos los archivos vacíos para que Asterisk no avise por cada include faltante.
mkdir -p /etc/asterisk/pbxng.d
for f in parking.conf moh.conf features.conf pjsip.conf rtp.conf pjsip-security.conf; do
  [ -f "/etc/asterisk/pbxng.d/$f" ] || echo "; generado por el panel PBX-NG (vacío por ahora)" > "/etc/asterisk/pbxng.d/$f"
done
# Carpeta de audios de música en espera administrada desde el panel.
mkdir -p /var/lib/asterisk/sounds/custom/moh 2>/dev/null || true

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

# --- firewall del módulo /seguridad (nftables en el kernel del host) ---
# Idempotente: crea tabla inet pbxng + set banned + regla drop sólo si faltan, y nunca
# borra los bloqueos vigentes. También deja 8088 (ARI/WS) y 5038 (AMI) sólo para redes
# privadas, salvo {"ari_public": true} en /etc/pbxng/fw.json (ver docs/FIREWALL.md §1.2).
# Si el kernel no trae nf_tables o falta NET_ADMIN, avisa
# y sigue: la central tiene que arrancar igual (el panel mostrará enforcement.nft=false).
if command -v nft >/dev/null 2>&1; then
  python3 /usr/local/bin/pbxng-ast-agent.py --ensure-fw 2>&1 || echo "aviso: no se pudo preparar nftables (se sigue sin bloqueo de IPs)"
else
  echo "aviso: nft no está instalado, el bloqueo de IPs de /seguridad queda deshabilitado"
fi

# --- agente HTTP PBX-NG (:8092) en background ---
# Todo POST y los GET de configuración (/net, /route, /fw/bans) validan X-PBXNG-Token
# (/etc/pbxng/agent.token, mismo volumen que la API); sin token configurado acepta sólo
# desde redes privadas. /core y /metrics quedan abiertos (no exponen secretos).
# Se arranca antes de Asterisk; las llamadas a "asterisk -rx" responderan vacio
# hasta que el core este arriba, sin romper el arranque.
python3 /usr/local/bin/pbxng-ast-agent.py &

exec "$@"
