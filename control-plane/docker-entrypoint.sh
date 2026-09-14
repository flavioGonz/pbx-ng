#!/bin/sh
# PBX-NG · API entrypoint:
#   1) espera a que Postgres acepte conexiones (evita el flood de ECONNREFUSED de los
#      subsistemas cuando la DB aun no esta lista);
#   2) corre las migraciones (migrations/*.sql) ANTES de arrancar la API. Si fallan, el
#      contenedor sale con 1: arrancar con esquema viejo es peor que no arrancar
#      (docs/CONTRATOS.md §9).
set -e
H="${DB_HOST:-postgres}"; P="${DB_PORT:-5432}"
echo "[entrypoint] esperando Postgres ${H}:${P} ..."
i=0
until node -e "const n=require('net');const s=n.connect(${P},'${H}',()=>process.exit(0));s.on('error',()=>process.exit(1));s.setTimeout(2000,()=>process.exit(1));" 2>/dev/null; do
  i=$((i+1)); [ "$i" -ge 60 ] && { echo "[entrypoint] Postgres ${H}:${P} no respondio en 60 s; no arranco (revisar el servicio postgres / DB_HOST)"; exit 1; }
  sleep 1
done
echo "[entrypoint] Postgres OK, aplicando migraciones"
# `set -e` ya corta si migrate.js sale con 1; el `||` es para dejar un mensaje claro en el log.
node migrate.js || { echo "[entrypoint] las migraciones fallaron: la API NO arranca (ver el error de arriba)"; exit 1; }
echo "[entrypoint] esquema al dia, iniciando API"

# --- herramientas del modulo de fax (control-plane/fax.js) ---
# Se AVISA, no se corta: el fax es un modulo mas y una central que no lo usa tiene que
# arrancar igual. Pero el aviso va aca y no cuando alguien aprieta "enviar": el sintoma de
# que falten es un 503 en medio de un envio, o un fax recibido que llega como TIFF, y eso
# se descubre el dia de la demo. Con esto queda en el log del arranque, que es lo primero
# que se mira. El panel lo vuelve a decir en /fax con GET /api/fax/estado.
for bin in gs tiff2pdf; do
  command -v "$bin" >/dev/null 2>&1 || echo "[entrypoint] AVISO: falta '$bin' en esta imagen; el modulo de fax no va a poder convertir PDF <-> TIFF (instalar ghostscript / libtiff-tools en control-plane/Dockerfile)"
done

exec node app.js
