# Voz IA · Piper (TTS) + faster-whisper (STT)

Microservicio de voz neural, **offline y gratis**, que corre en un CT dedicado (pbxng-voz, 172.26.20.219).
La PBX (`control-plane/ai-pipeline.js`) le pega por HTTP para el IVR conversacional.

## Endpoints
- `POST /tts`  `{ "text": "...", "voice": "es_MX-claude-high", "length_scale": 1.0 }` -> PCM crudo **slin16 16k mono** (listo para AudioSocket).
- `POST /stt`  body = PCM crudo slin16 16k mono -> `{ "text": "..." }` (faster-whisper, espanol).
- `GET  /health` -> estado + voces disponibles.

## Instalacion (Debian 12)
```bash
apt-get install -y python3-pip ffmpeg sox libsndfile1 curl
# Piper (binario standalone + voz ES)
mkdir -p /opt/piper/voices && cd /opt/piper
curl -fsSL -o piper.tgz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar xzf piper.tgz && rm piper.tgz
cd voices
curl -fsSLO https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/claude/high/es_MX-claude-high.onnx
curl -fsSLO https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/claude/high/es_MX-claude-high.onnx.json
# STT
python3 -m pip install --break-system-packages faster-whisper fastapi "uvicorn[standard]" soundfile numpy
# servicio
install -D server.py /opt/voz/server.py
install -D voz.service /etc/systemd/system/voz.service
systemctl daemon-reload && systemctl enable --now voz
```

La PBX usa el setting `voz_url` (default `http://172.26.20.219:8080`). Prioridad de proveedores en el pipeline: **OpenAI** (si hay key) -> **neural (este servicio)** -> demo (espeak/Vosk).
