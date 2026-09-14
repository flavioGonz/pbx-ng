# PBX-NG · Control Plane (Node/Express + ARI/AMI + Socket.io)
FROM node:20-slim
WORKDIR /app
# pg_dump/psql son el corazón del respaldo. El volcado va lógico (no una copia cruda
# del volumen) para que entre en una instalación nueva aunque tenga otra versión de
# PostgreSQL: es la única forma de que un respaldo sirva el día que hay que levantar
# la central en otro servidor.
#
# OJO con la versión del cliente: pg_dump se NIEGA a volcar un servidor más nuevo que
# él. El postgresql-client de Debian 12 es el 15 y el motor que usamos es el 16, así
# que el paquete de la distro no sirve. Se instala del repo oficial de PostgreSQL, y
# a propósito una versión POR ENCIMA de la del servidor: un cliente nuevo puede volcar
# servidores viejos, al revés no. Si algún día el motor sube de la 17, hay que subir
# esto también.
#
# ghostscript + libtiff-tools son el motor de fax de ESTE contenedor (control-plane/fax.js):
# Asterisk habla con el otro módem y manda/recibe un TIFF G3, pero el que sube y baja el
# usuario es un PDF. `gs` convierte PDF → TIFF G3 (204x196) para SendFAX y `tiff2pdf` hace el
# camino de vuelta para adjuntar lo recibido al correo. Sin ellos `POST /api/fax/out`
# devuelve 503 y el fax recibido sale como TIFF, que medio mundo no sabe abrir.
# Van con --no-install-recommends: suman ~72 MiB a la imagen (~23 MiB de .deb, la mayor parte
# libgs10, las fuentes urw-base35 y poppler-data, que son dependencias duras de libgs10 y no
# se pueden sacar). Es el precio de tener fax; no hay alternativa liviana que renderice PDF.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg socat openssl ghostscript libtiff-tools \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
# acme.sh (un solo script) para emitir/renovar certificados Let's Encrypt sin proxy adelante
RUN curl -fsSL https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh -o /usr/local/bin/acme.sh \
 && chmod +x /usr/local/bin/acme.sh
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
RUN chmod +x /app/docker-entrypoint.sh
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:3000/health/ready || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]
