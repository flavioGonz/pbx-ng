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
      libspandsp-dev libtiff-dev \
    && rm -rf /var/lib/apt/lists/*
# libspandsp-dev + libtiff-dev: sin ellos ./configure NO detecta spandsp y menuselect deja
# res_fax_spandsp fuera SIN avisar. El resultado es una imagen con res_fax.so pero sin el
# motor de modulacion: ReceiveFAX/SendFAX ni siquiera existen como aplicaciones y el
# dialplan de fax.js muere con "no such application" en medio de la llamada. Es el unico
# modulo de fax que importa: res_fax solo es el marco. libtiff va explicito aunque lo
# arrastre spandsp, porque el TIFF G3 es el formato en el que se guarda el fax.

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
       --enable res_fax \
       --enable res_fax_spandsp \
       --disable BUILD_NATIVE \
       menuselect.makeopts

# pjproject (bundled) puede fallar en pjnath con build paralelo bajo presion de RAM -> compilar en serie
RUN make -j1 && make install && make install-headers

# Los modulos que el panel da por hechos tienen que estar EN LA IMAGEN, no "por lo general".
# menuselect --enable no falla si la dependencia no esta: deja el modulo en "no seleccionable"
# y el build termina verde con el modulo ausente, que es exactamente como se escapo
# res_fax_spandsp hasta produccion. Este test corta el build ahi: mejor no poder publicar la
# imagen que publicar una que se rompe en la primera llamada de fax.
#
# Va en DOS listas porque el precio de que falte no es el mismo:
#
# 1) REQUERIDOS: son EXACTAMENTE los que config/asterisk/modules.conf pide con "require =".
#    Si uno falta, Asterisk NO arranca: sale con codigo 2 y el contenedor queda en crash-loop,
#    o sea la central entera sin telefonos, y el log habla de un modulo ausente y no del
#    servicio que se perdio. Por eso esta lista y los "require =" de modules.conf tienen que
#    moverse SIEMPRE juntos: el que agregue un require ahi lo agrega aca, o el gate pasa
#    verde sobre una imagen que no levanta. (Asi se escapo func_hangupcause.so del failover
#    de troncales: estaba en el require y en ninguna verificacion.)
# 2) ESPERADOS: no van como require justamente porque que falte el fax o una conferencia no
#    puede dejar sin telefonos a toda la central. Igual tienen que estar: el build corta aca
#    y el entrypoint vuelve a avisar en el arranque para imagenes viejas o armadas a mano.
RUN set -e; \
    for m in func_curl.so func_uri.so func_db.so func_strings.so \
             app_directory.so app_read.so func_hangupcause.so; do \
      [ -f "/usr/lib/asterisk/modules/$m" ] || { echo "FALTA el modulo REQUERIDO $m (modules.conf lo pide con require =): sin el Asterisk sale con codigo 2 al arrancar. Revisar las dependencias de build (-dev) y el menuselect de arriba"; exit 1; }; \
    done; \
    for m in res_fax.so res_fax_spandsp.so app_disa.so \
             app_confbridge.so res_config_pgsql.so cdr_pgsql.so res_srtp.so chan_pjsip.so; do \
      [ -f "/usr/lib/asterisk/modules/$m" ] || { echo "FALTA el modulo $m: revisar las dependencias de build (-dev) y el menuselect de arriba"; exit 1; }; \
    done

# ---------- runtime ----------
FROM debian:12-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libjansson4 libxml2 libsqlite3-0 libedit2 libssl3 libpq5 libsrtp2-1 \
      libcurl4 libspeex1 libspeexdsp1 libogg0 libvorbis0a libgsm1 libuuid1 \
      libspandsp2 libtiff6 \
      openssl ca-certificates gettext-base postgresql-client procps \
      python3 iproute2 tcpdump iputils-ping traceroute \
      nftables tzdata \
    && rm -rf /var/lib/apt/lists/*
# tzdata: debian:12-slim NO lo trae, y sin /usr/share/zoneinfo glibc ignora la
# variable TZ del compose y vuelve a UTC sin decir nada. Todo el bloque de horarios
# del dialplan (GotoIfTime, STRFTIME para feriados, modo noche automatico) se evalua
# con el reloj de este contenedor: en UTC-3 una oficina 09:00-18:00 atenderia de
# 06:00 a 15:00 y el panel diria "abierto" mientras la central manda al destino de
# fuera de hora. La zona la fija el compose (TZ, el mismo valor que recibe la api).
# libspandsp2 + libtiff6: son la parte de RUNTIME del fax. Los .so se copian de la etapa de
# build, pero un módulo sin su librería compartida no carga: Asterisk lo saltea con un
# "error loading module" en el log y se sigue quedando sin ReceiveFAX/SendFAX. Suman ~3,6 MiB
# a la imagen final (~1,3 MiB de .deb), que es nada al lado de tener el módulo de fax.
# nftables: el bloqueo de IPs del módulo /seguridad lo hace este contenedor (corre en
# network_mode host con NET_ADMIN), así que el set "banned" vive en el kernel del host
# y sobrevive a reinicios del contenedor. Lo administra pbxng-ast-agent.py (/fw/*).

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
# Audios en espanol rioplatense (voz uruguaya), generados con el TTS propio:
#   scripts/gen-sounds.py  (manifiesto: voice-service/sounds/manifest.es.json)
# Va como tarball: preserva mayus/minus (vm-Old != vm-old) y no infla el repo.
# Sin estos audios, defaultlanguage=es cae al set en ingles.
ADD sounds/pbxng-sounds-es.tar.gz /var/lib/asterisk/sounds/

COPY config/asterisk/ /etc/asterisk/
COPY images/asterisk/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Agente HTTP :8092 (estado nucleo + red + rutas). El script vive en infra/asterisk/,
# pero el build context de compose es docker/, por eso se copia a docker/images/asterisk/.
COPY images/asterisk/pbxng-ast-agent.py /usr/local/bin/pbxng-ast-agent.py
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/pbxng-ast-agent.py \
 && chown -R asterisk:asterisk /var/lib/asterisk/sounds

EXPOSE 5060/udp 5060/tcp 5061/tcp 8088/tcp 10000-20000/udp
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["asterisk", "-f", "-vvv"]
