# PBX-NG · Asterisk 22 LTS + res_config_pjsip (realtime) + res_config_pgsql + res_srtp
# Compila desde fuente (misma versión que el sistema vivo: 22.10.0) con soporte
# PostgreSQL realtime (ARA), SRTP/DTLS y CDR a Postgres.
FROM debian:12-slim AS build

ARG AST_VERSION=22.10.0
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential wget ca-certificates pkg-config \
      libjansson-dev libxml2-dev libsqlite3-dev uuid-dev libedit-dev \
      libssl-dev libpq-dev libsrtp2-dev libcurl4-openssl-dev libncurses-dev \
      libspeex-dev libspeexdsp-dev libogg-dev libvorbis-dev libgsm1-dev \
      libresample1-dev zlib1g-dev subversion \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN wget -q https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${AST_VERSION}.tar.gz \
    && tar xzf asterisk-${AST_VERSION}.tar.gz
WORKDIR /usr/src/asterisk-${AST_VERSION}

# pjproject bundled (chan_pjsip) + jansson bundled
RUN ./configure --with-pjproject-bundled --with-jansson-bundled --with-ssl --with-srtp

# Habilitar explícitamente los módulos que usamos (pgsql realtime, cdr pgsql, srtp)
RUN make menuselect.makeopts \
    && menuselect/menuselect \
       --enable res_config_pgsql \
       --enable cdr_pgsql \
       --enable res_srtp \
       --enable res_pjsip \
       --enable chan_pjsip \
       --enable res_pjsip_outbound_registration \
       --disable BUILD_NATIVE \
       menuselect.makeopts

RUN make -j2 && make install && make install-headers

# ---------- runtime ----------
FROM debian:12-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libjansson4 libxml2 libsqlite3-0 libedit2 libssl3 libpq5 libsrtp2-1 \
      libcurl4 libspeex1 libspeexdsp1 libogg0 libvorbis0a libgsm1 libuuid1 \
      openssl ca-certificates gettext-base postgresql-client procps \
    && rm -rf /var/lib/apt/lists/*

# binarios + módulos + datos de Asterisk desde el build
COPY --from=build /usr/sbin/asterisk /usr/sbin/asterisk
COPY --from=build /usr/lib/asterisk /usr/lib/asterisk
COPY --from=build /var/lib/asterisk /var/lib/asterisk
COPY --from=build /var/spool/asterisk /var/spool/asterisk
COPY --from=build /usr/sbin/astgenkey /usr/sbin/astgenkey
COPY --from=build /usr/lib/libasterisk*.so* /usr/lib/
RUN ldconfig
RUN useradd -r -d /var/lib/asterisk asterisk 2>/dev/null || true \
    && mkdir -p /var/run/asterisk /var/log/asterisk /etc/asterisk/keys \
    && chown -R asterisk:asterisk /var/lib/asterisk /var/spool/asterisk /var/run/asterisk /var/log/asterisk /etc/asterisk

# configs estáticos (endpoints van en realtime/DB). Los que llevan secretos
# los genera el entrypoint desde variables de entorno.
COPY config/asterisk/ /etc/asterisk/
COPY images/asterisk/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 5060/udp 5060/tcp 5061/tcp 8088/tcp 10000-20000/udp
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["asterisk", "-f", "-vvv"]
