# PBX-NG · Coturn (TURN/STUN) con config generada desde ENV
FROM coturn/coturn:latest
USER root
# python3 para el agente HTTP :8091 (instala si falta; la imagen coturn es Debian).
RUN (command -v python3 >/dev/null 2>&1) || (apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*)
COPY config/coturn/turnserver.conf /etc/coturn/turnserver.tpl
COPY images/coturn/docker-entrypoint.sh /usr/local/bin/pbxng-entrypoint.sh
# Agente HTTP :8091. El script vive ACA y en ningun otro lado: habia una segunda copia en
# infra/turn/ (el arbol previo a docker, fuera del build context de compose, que es docker/)
# que quedo atras y seguia diciendo "active" con solo poder ejecutar el binario de turnserver
# -aunque el TURN estuviera caido-. Se borro: lo que se construye, se prueba en CI y se
# despliega es este.
COPY images/coturn/pbxng-turn-agent.py /usr/local/bin/pbxng-turn-agent.py
# Medicion del nodo compartida por las TRES imagenes (asterisk, coturn, voz). Ver el
# comentario equivalente en images/asterisk/Dockerfile.
COPY images/common/pbxng_nodo.py /usr/local/lib/pbxng/pbxng_nodo.py
RUN chmod +x /usr/local/bin/pbxng-entrypoint.sh /usr/local/bin/pbxng-turn-agent.py
# Gate: si el modulo compartido no se puede importar, que falle el build y no el agente.
RUN python3 -c "import sys; sys.path.insert(0, '/usr/local/lib/pbxng'); import pbxng_nodo; assert pbxng_nodo.metricas_nodo()"
ENTRYPOINT ["/usr/local/bin/pbxng-entrypoint.sh"]
CMD ["turnserver", "-c", "/etc/turnserver.conf"]
