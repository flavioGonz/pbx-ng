# PBX-NG · Voz IA (TTS/STT): FastAPI + faster-whisper (STT) + Edge-TTS/espeak (TTS)
FROM python:3.11-slim
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg espeak-ng ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/voz
RUN pip install --no-cache-dir \
      fastapi "uvicorn[standard]" faster-whisper edge-tts numpy soundfile
COPY server.py ./
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
