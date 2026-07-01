# PBX-NG · Coturn (TURN/STUN) con config generada desde ENV
FROM coturn/coturn:latest
USER root
# python3 para el agente HTTP :8091 (instala si falta; la imagen coturn es Debian).
RUN (command -v python3 >/dev/null 2>&1) || (apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*)
COPY config/coturn/turnserver.conf /etc/coturn/turnserver.tpl
COPY images/coturn/docker-entrypoint.sh /usr/local/bin/pbxng-entrypoint.sh
# Agente HTTP :8091. Script en infra/turn/, copiado a docker/images/coturn/ porque
# el build context de compose es docker/ (no alcanza infra/ fuera del context).
COPY images/coturn/pbxng-turn-agent.py /usr/local/bin/pbxng-turn-agent.py
RUN chmod +x /usr/local/bin/pbxng-entrypoint.sh /usr/local/bin/pbxng-turn-agent.py
ENTRYPOINT ["/usr/local/bin/pbxng-entrypoint.sh"]
CMD ["turnserver", "-c", "/etc/turnserver.conf"]
