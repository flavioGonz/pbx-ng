#!/bin/sh
# PBX-NG · API entrypoint: espera a que Postgres acepte conexiones antes de arrancar
# (evita el flood de ECONNREFUSED de los subsistemas cuando la DB aun no esta lista)
set -e
H="${DB_HOST:-postgres}"; P="${DB_PORT:-5432}"
echo "[entrypoint] esperando Postgres ${H}:${P} ..."
i=0
until node -e "const n=require('net');const s=n.connect(${P},'${H}',()=>process.exit(0));s.on('error',()=>process.exit(1));s.setTimeout(2000,()=>process.exit(1));" 2>/dev/null; do
  i=$((i+1)); [ "$i" -ge 60 ] && { echo "[entrypoint] Postgres no respondio en 60s, arranco igual"; break; }
  sleep 1
done
echo "[entrypoint] Postgres OK, iniciando API"
exec node app.js
