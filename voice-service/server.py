import os, json, subprocess
import numpy as np
from fastapi import FastAPI, Request, Response
from faster_whisper import WhisperModel

PIPER = "/opt/piper/piper/piper"
VOICES = "/opt/piper/voices"
DEFAULT_VOICE = os.environ.get("VOZ_VOICE", "es_MX-claude-high")
WMODEL_NAME = os.environ.get("VOZ_WHISPER", "small")

app = FastAPI(title="PBX-NG Voz")
print("[voz] cargando whisper", WMODEL_NAME, "...", flush=True)
WMODEL = WhisperModel(WMODEL_NAME, device="cpu", compute_type="int8")
print("[voz] whisper listo", flush=True)

def voice_rate(voice):
    try:
        j = json.load(open(f"{VOICES}/{voice}.onnx.json"))
        return int(j.get("audio", {}).get("sample_rate", 22050))
    except Exception:
        return 22050

def list_voices():
    try:
        return sorted([f[:-5] for f in os.listdir(VOICES) if f.endswith(".onnx")])
    except Exception:
        return []

@app.get("/health")
def health():
    return {"ok": True, "whisper": WMODEL_NAME, "default_voice": DEFAULT_VOICE, "voices": list_voices()}

@app.post("/tts")
async def tts(req: Request):
    b = await req.json()
    text = (b.get("text") or "").strip()
    voice = b.get("voice") or DEFAULT_VOICE
    if not os.path.exists(f"{VOICES}/{voice}.onnx"):
        voice = DEFAULT_VOICE
    if not text:
        return Response(b"", media_type="application/octet-stream")
    ls = str(b.get("length_scale", 1.0))
    sr = voice_rate(voice)
    p1 = subprocess.Popen([PIPER, "--model", f"{VOICES}/{voice}.onnx", "--length_scale", ls, "--output-raw"],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p2 = subprocess.Popen(["sox", "-t", "raw", "-r", str(sr), "-e", "signed", "-b", "16", "-c", "1", "-",
                           "-t", "raw", "-r", "16000", "-e", "signed", "-b", "16", "-c", "1", "-"],
                          stdin=p1.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p1.stdout.close()
    try:
        p1.stdin.write(text.encode("utf-8")); p1.stdin.close()
    except Exception:
        pass
    out = p2.stdout.read(); p2.wait(); p1.wait()
    return Response(out, media_type="application/octet-stream")

@app.post("/stt")
async def stt(req: Request):
    raw = await req.body()
    if len(raw) < 640:
        return {"text": ""}
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    segs, _ = WMODEL.transcribe(audio, language="es", beam_size=1, vad_filter=True,
                                condition_on_previous_text=False)
    text = " ".join(s.text.strip() for s in segs).strip()
    return {"text": text}
