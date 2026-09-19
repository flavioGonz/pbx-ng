# PBX-NG · Voz IA (TTS/STT): FastAPI + faster-whisper (STT) + Edge-TTS/espeak (TTS)
FROM python:3.11-slim
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg espeak-ng ca-certificates sox \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/voz
RUN pip install --no-cache-dir \
      fastapi "uvicorn[standard]" faster-whisper edge-tts numpy soundfile \
      huggingface_hub piper-tts   # huggingface_hub: el CDN xet de HF rechaza los GET planos. piper-tts: el motor local (la imagen no lo traia y el TTS offline nunca funciono)
# OJO: el contexto de build de esta imagen es la RAIZ del repo (ver docker-compose.yml), no
# voice-service/, porque hacen falta los dos arboles. Por eso las rutas van completas.
COPY voice-service/server.py ./
# Medicion del nodo compartida por las TRES imagenes (asterisk, coturn, voz): una sola copia,
# en docker/images/common/. Adentro de un contenedor /proc/meminfo y /proc/uptime son del
# host, y con la funcion triplicada los tres agentes informaban el hipervisor.
COPY docker/images/common/pbxng_nodo.py /usr/local/lib/pbxng/pbxng_nodo.py
# Gate: si el modulo no se puede importar, que falle el build y no el /health en produccion.
RUN python3 -c "import sys; sys.path.insert(0, '/usr/local/lib/pbxng'); import pbxng_nodo; assert pbxng_nodo.metricas_nodo()"
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
