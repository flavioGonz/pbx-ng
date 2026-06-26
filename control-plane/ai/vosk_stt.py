#!/usr/bin/env python3
# Sidecar STT offline (Vosk). Lee PCM 16-bit LE mono 16kHz de stdin,
# emite lineas JSON: {"partial":"..."} y {"final":"..."} a stdout.
import sys, json, os
from vosk import Model, KaldiRecognizer, SetLogLevel
SetLogLevel(-1)
MODEL = os.environ.get("VOSK_MODEL", "/opt/vosk-model-es")
RATE = int(os.environ.get("VOSK_RATE", "16000"))
model = Model(MODEL)
rec = KaldiRecognizer(model, RATE)
rec.SetWords(False)
sys.stderr.write("vosk-ready\n"); sys.stderr.flush()
last_partial = ""
while True:
    chunk = sys.stdin.buffer.read(3200)  # ~100ms a 16kHz
    if not chunk:
        break
    if rec.AcceptWaveform(chunk):
        txt = json.loads(rec.Result()).get("text", "").strip()
        if txt:
            sys.stdout.write(json.dumps({"final": txt}) + "\n"); sys.stdout.flush()
            last_partial = ""
    else:
        p = json.loads(rec.PartialResult()).get("partial", "").strip()
        if p and p != last_partial:
            last_partial = p
            sys.stdout.write(json.dumps({"partial": p}) + "\n"); sys.stdout.flush()
# fin de stream: emitir resto
txt = json.loads(rec.FinalResult()).get("text", "").strip()
if txt:
    sys.stdout.write(json.dumps({"final": txt}) + "\n"); sys.stdout.flush()
