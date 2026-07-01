#!/usr/bin/env bash
# entrypoint all-in-one (demo): prepara DB minima y arranca supervisord.
set -e
echo "[pbxng] all-in-one demo · dominio=$DOMAIN"
# init de PostgreSQL si esta vacio (best-effort)
if [ ! -d /var/lib/postgresql/data/base ]; then
  su postgres -c "/usr/lib/postgresql/*/bin/initdb -D /var/lib/postgresql/data" || true
fi
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/pbxng.conf
