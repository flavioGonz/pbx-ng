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
# Cada -dev de esta lista habilita un modulo del menuselect de abajo: ./configure detecta lo
# que encuentra y menuselect deja AFUERA SIN AVISAR lo que no, asi que agregar un --enable sin
# su -dev da un build verde con el modulo ausente. Por eso la verificacion de mas abajo.

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

# pjproject (bundled) puede fallar en pjnath con build paralelo bajo presion de RAM -> compilar en serie
RUN make -j1 && make install && make install-headers

# Los modulos que el panel da por hechos tienen que estar EN LA IMAGEN, no "por lo general".
# menuselect --enable no falla si la dependencia no esta: deja el modulo en "no seleccionable"
# y el build termina verde con el modulo ausente, que es exactamente como un modulo que
# nadie pidio como require se escapa hasta produccion. Este test corta el build ahi: mejor no
# poder publicar la imagen que publicar una que se rompe en la primera llamada.
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
# 2) ESPERADOS: no van como require justamente porque que falte una conferencia no
#    puede dejar sin telefonos a toda la central. Igual tienen que estar: el build corta aca
#    y el entrypoint vuelve a avisar en el arranque para imagenes viejas o armadas a mano.
RUN set -e; \
    for m in func_curl.so func_uri.so func_db.so func_strings.so \
             app_directory.so app_read.so func_hangupcause.so; do \
      [ -f "/usr/lib/asterisk/modules/$m" ] || { echo "FALTA el modulo REQUERIDO $m (modules.conf lo pide con require =): sin el Asterisk sale con codigo 2 al arrancar. Revisar las dependencias de build (-dev) y el menuselect de arriba"; exit 1; }; \
    done; \
    for m in app_disa.so \
             app_confbridge.so res_config_pgsql.so cdr_pgsql.so res_srtp.so chan_pjsip.so; do \
      [ -f "/usr/lib/asterisk/modules/$m" ] || { echo "FALTA el modulo $m: revisar las dependencias de build (-dev) y el menuselect de arriba"; exit 1; }; \
    done

# ---------- runtime ----------
FROM debian:12-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libjansson4 libxml2 libsqlite3-0 libedit2 libssl3 libpq5 libsrtp2-1 \
      libcurl4 libspeex1 libspeexdsp1 libogg0 libvorbis0a libgsm1 libuuid1 \
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
# /var/lib/asterisk/db: ahi vive la astdb (asterisk.conf, astdbdir) y encima va el volumen
# asterisk_db de los compose. Se crea en la imagen para que Asterisk arranque igual si alguien
# levanta el contenedor sin el volumen.
RUN useradd -r -d /var/lib/asterisk asterisk 2>/dev/null || true \
    && mkdir -p /var/run/asterisk /var/log/asterisk /etc/asterisk/keys /var/lib/asterisk/db \
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
# Agente HTTP :8092 (estado nucleo + red + rutas + nftables). El script vive ACA y en
# ningun otro lado: hubo una segunda copia en infra/asterisk/ (el arbol previo a docker,
# fuera del build context de compose, que es docker/) y quedo dos versiones atras sin que
# nadie lo notara, porque lo que se construye, se prueba en CI y se despliega es este.
COPY images/asterisk/pbxng-ast-agent.py /usr/local/bin/pbxng-ast-agent.py
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/pbxng-ast-agent.py \
 && chown -R asterisk:asterisk /var/lib/asterisk/sounds

EXPOSE 5060/udp 5060/tcp 5061/tcp 8088/tcp 10000-20000/udp
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["asterisk", "-f", "-vvv"]
