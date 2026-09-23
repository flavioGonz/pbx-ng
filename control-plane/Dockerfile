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
# Acá NO hay ghostscript ni libtiff-tools: eran del módulo de fax, que salió del producto en
# 1.11.0, y se llevaban ~72 MiB de imagen (casi todo libgs10 con sus fuentes urw-base35 y
# poppler-data, que son dependencias duras y no se podían podar). Si algún día vuelve a hacer
# falta renderizar un PDF acá adentro, que sea con esa cuenta a la vista.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg socat openssl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
# acme.sh (un solo script) para emitir/renovar certificados Let's Encrypt sin proxy adelante
RUN curl -fsSL https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh -o /usr/local/bin/acme.sh \
 && chmod +x /usr/local/bin/acme.sh
COPY package.json package-lock.json ./
# `npm ci` A SECAS, sin el `|| npm install` que tenia antes. Ese fallback convertia un
# lockfile desincronizado -el error que npm ci existe para gritar- en una instalacion
# silenciosa de otras versiones: la imagen quedaba armada con lo que hubiera en el
# registry ese dia y no con lo que dice el repo, y dos builds del mismo commit podian
# no ser la misma imagen. Si esto falla, el arreglo es correr `npm install` y commitear
# el lockfile, no seguir de largo. Y `package*.json` pasa a ser explicito para que un
# `package-lock.json` ausente rompa el build en vez de caer al fallback.
RUN npm ci --omit=dev
COPY . .
RUN chmod +x /app/docker-entrypoint.sh
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:3000/health/ready || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]
