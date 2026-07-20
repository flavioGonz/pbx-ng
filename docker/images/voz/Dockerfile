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
COPY server.py ./
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
