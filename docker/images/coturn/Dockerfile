# PBX-NG · Coturn (TURN/STUN) con config generada desde ENV
FROM coturn/coturn:latest
USER root
COPY config/coturn/turnserver.conf /etc/coturn/turnserver.tpl
COPY images/coturn/docker-entrypoint.sh /usr/local/bin/pbxng-entrypoint.sh
RUN chmod +x /usr/local/bin/pbxng-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/pbxng-entrypoint.sh"]
CMD ["turnserver", "-c", "/etc/turnserver.conf"]
