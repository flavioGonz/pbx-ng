# PBX-NG · Kamailio 5.6 SBC (borde SIP: LCR, seguridad, manipulación, topohide)
FROM debian:12-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates gnupg wget iproute2 gettext-base postgresql-client \
    && wget -qO- https://deb.kamailio.org/kamailiodebkey.gpg | gpg --dearmor > /usr/share/keyrings/kamailio.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio56 bookworm main" > /etc/apt/sources.list.d/kamailio.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      kamailio kamailio-postgres-modules kamailio-tls-modules kamailio-websocket-modules \
      kamailio-presence-modules kamailio-json-modules kamailio-utils-modules kamailio-extra-modules \
    && rm -rf /var/lib/apt/lists/*
COPY config/kamailio/ /etc/kamailio/
COPY images/kamailio/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 5060/udp 5060/tcp 8088/tcp
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["kamailio", "-DD", "-E", "-m", "64", "-M", "8"]
