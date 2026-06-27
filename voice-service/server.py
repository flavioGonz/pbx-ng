import os, json, subprocess, time, glob
import numpy as np
from fastapi import FastAPI, Request, Response
from faster_whisper import WhisperModel

PIPER = "/opt/piper/piper/piper"
VOICES = "/opt/piper/voices"
ENVFILE = "/etc/voz.env"
HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
DEFAULT_VOICE = os.environ.get("VOZ_VOICE", "es_MX-claude-high")
WMODEL_NAME = os.environ.get("VOZ_WHISPER", "small")

# catalogo curado de voces en espanol (Piper)
CATALOG = [
    {"key": "es_MX-claude-high", "label": "Mexicana - Claude (alta, natural)", "path": "es/es_MX/claude/high"},
    {"key": "es_MX-ald-medium", "label": "Mexicana - Ald (media, masculina)", "path": "es/es_MX/ald/medium"},
    {"key": "es_ES-sharvard-medium", "label": "Espana - Sharvard (media, expresiva)", "path": "es/es_ES/sharvard/medium"},
    {"key": "es_ES-davefx-medium", "label": "Espana - Dave (media, masculina)", "path": "es/es_ES/davefx/medium"},
    {"key": "es_ES-mls_9972-low", "label": "Espana - MLS 9972 (femenina)", "path": "es/es_ES/mls_9972/low"},
    {"key": "es_ES-mls_10246-low", "label": "Espana - MLS 10246 (masculina)", "path": "es/es_ES/mls_10246/low"},
    {"key": "es_ES-carlfm-x_low", "label": "Espana - Carl (rapida, liviana)", "path": "es/es_ES/carlfm/x_low"},
]


EDGE_VOICES = [
    {"key": "es-UY-MateoNeural", "label": "Uruguay - Mateo (masculina)"},
    {"key": "es-UY-ValentinaNeural", "label": "Uruguay - Valentina (femenina)"},
    {"key": "es-AR-TomasNeural", "label": "Argentina - Tomas (masculina)"},
    {"key": "es-AR-ElenaNeural", "label": "Argentina - Elena (femenina)"},
    {"key": "es-MX-JorgeNeural", "label": "Mexico - Jorge (masculina)"},
    {"key": "es-MX-DaliaNeural", "label": "Mexico - Dalia (femenina)"},
    {"key": "es-CO-GonzaloNeural", "label": "Colombia - Gonzalo (masculina)"},
    {"key": "es-CO-SalomeNeural", "label": "Colombia - Salome (femenina)"},
    {"key": "es-CL-LorenzoNeural", "label": "Chile - Lorenzo (masculina)"},
    {"key": "es-CL-CatalinaNeural", "label": "Chile - Catalina (femenina)"},
    {"key": "es-PE-AlexNeural", "label": "Peru - Alex (masculina)"},
    {"key": "es-PE-CamilaNeural", "label": "Peru - Camila (femenina)"},
    {"key": "es-VE-SebastianNeural", "label": "Venezuela - Sebastian (masculina)"},
    {"key": "es-VE-PaolaNeural", "label": "Venezuela - Paola (femenina)"},
]
EDGE_KEYS = {v["key"] for v in EDGE_VOICES}

async def edge_synth(text, voice, out_rate, fmt):
    import edge_tts, os, time as _t
    ts = "%d_%d" % (os.getpid(), int(_t.time() * 1000))
    mp3 = "/tmp/edge_%s.mp3" % ts
    try:
        await edge_tts.Communicate(text, voice, rate="+12%").save(mp3)
        if fmt == "wav":
            wav = "/tmp/edge_%s.wav" % ts
            try:
                subprocess.run(["ffmpeg", "-y", "-i", mp3, "-ar", str(out_rate),
                                "-ac", "1", "-c:a", "pcm_s16le", wav], capture_output=True)
                with open(wav, "rb") as f:
                    return f.read()
            finally:
                try: os.remove(wav)
                except Exception: pass
        else:
            p = subprocess.run(["ffmpeg", "-y", "-i", mp3, "-ar", str(out_rate),
                                "-ac", "1", "-f", "s16le", "-"], capture_output=True)
            return p.stdout
    finally:
        try: os.remove(mp3)
        except Exception: pass

app = FastAPI(title="PBX-NG Voz")
STATS = {"tts": 0, "stt": 0, "tts_ms": 0.0, "stt_ms": 0.0, "started": time.time()}
print("[voz] cargando whisper", WMODEL_NAME, "...", flush=True)
WMODEL = WhisperModel(WMODEL_NAME, device="cpu", compute_type="int8")
print("[voz] whisper listo", flush=True)

def sys_metrics():
    try:
        load = float(open("/proc/loadavg").read().split()[0])
        mem = {}
        for line in open("/proc/meminfo"):
            p = line.split(":")
            if len(p) == 2: mem[p[0]] = int(p[1].split()[0])
        total = mem.get("MemTotal", 1); avail = mem.get("MemAvailable", 0)
        up = int(float(open("/proc/uptime").read().split()[0]))
        ncpu = os.cpu_count() or 1
        return {"load": round(load, 2), "cpu_pct": round(min(100.0, load / ncpu * 100), 1),
                "mem_pct": round((total - avail) * 100.0 / total, 1),
                "mem_used_mb": round((total - avail) / 1024), "mem_total_mb": round(total / 1024),
                "uptime_s": up, "ncpu": ncpu}
    except Exception:
        return {}

def installed_voices():
    out = []
    for f in sorted(glob.glob(f"{VOICES}/*.onnx")):
        k = os.path.basename(f)[:-5]
        out.append({"key": k, "size_mb": round(os.path.getsize(f) / 1048576, 1)})
    return out

def stats_view():
    s = dict(STATS)
    s["tts_avg_ms"] = round(s["tts_ms"] / s["tts"]) if s["tts"] else 0
    s["stt_avg_ms"] = round(s["stt_ms"] / s["stt"]) if s["stt"] else 0
    s["svc_uptime_s"] = int(time.time() - s["started"])
    return {"tts": s["tts"], "stt": s["stt"], "tts_avg_ms": s["tts_avg_ms"], "stt_avg_ms": s["stt_avg_ms"], "svc_uptime_s": s["svc_uptime_s"]}

def voice_rate(voice):
    try:
        j = json.load(open(f"{VOICES}/{voice}.onnx.json"))
        return int(j.get("audio", {}).get("sample_rate", 22050))
    except Exception:
        return 22050

@app.get("/health")
def health():
    return {"ok": True, "whisper": WMODEL_NAME, "default_voice": DEFAULT_VOICE,
            "voices": [v["key"] for v in installed_voices()], "metrics": sys_metrics(), "stats": stats_view()}

@app.post("/tts")
async def tts(req: Request):
    t0 = time.time()
    b = await req.json()
    text = (b.get("text") or "").strip()
    voice = b.get("voice") or DEFAULT_VOICE
    if not text:
        return Response(b"", media_type="application/octet-stream")
    out_rate = int(b.get("rate", 16000))
    fmt = b.get("format", "raw")
    if voice in EDGE_KEYS:
        out = await edge_synth(text, voice, out_rate, fmt)
        STATS["tts"] += 1; STATS["tts_ms"] += (time.time() - t0) * 1000
        return Response(out, media_type="audio/wav" if fmt == "wav" else "application/octet-stream")
    if not os.path.exists(f"{VOICES}/{voice}.onnx"):
        voice = DEFAULT_VOICE
    ls = str(b.get("length_scale", 1.0))
    sr = voice_rate(voice)
    out_args = ["-t", "wav"] if fmt == "wav" else ["-t", "raw"]
    p1 = subprocess.Popen([PIPER, "--model", f"{VOICES}/{voice}.onnx", "--length_scale", ls, "--output-raw"],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p2 = subprocess.Popen(["sox", "-t", "raw", "-r", str(sr), "-e", "signed", "-b", "16", "-c", "1", "-"] +
                          out_args + ["-r", str(out_rate), "-e", "signed", "-b", "16", "-c", "1", "-"],
                          stdin=p1.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p1.stdout.close()
    try:
        p1.stdin.write(text.encode("utf-8")); p1.stdin.close()
    except Exception:
        pass
    out = p2.stdout.read(); p2.wait(); p1.wait()
    STATS["tts"] += 1; STATS["tts_ms"] += (time.time() - t0) * 1000
    return Response(out, media_type="audio/wav" if fmt == "wav" else "application/octet-stream")

@app.post("/stt")
async def stt(req: Request):
    t0 = time.time()
    raw = await req.body()
    if len(raw) < 320:
        return {"text": ""}
    in_rate = int(req.query_params.get("rate", 16000))
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if in_rate != 16000 and len(audio) > 1:
        n = len(audio); m = max(1, int(round(n * 16000.0 / in_rate)))
        audio = np.interp(np.linspace(0, n, m, endpoint=False), np.arange(n), audio).astype(np.float32)
    segs, _ = WMODEL.transcribe(audio, language="es", beam_size=1, vad_filter=True, condition_on_previous_text=False)
    text = " ".join(s.text.strip() for s in segs).strip()
    STATS["stt"] += 1; STATS["stt_ms"] += (time.time() - t0) * 1000
    return {"text": text}

# ---------------- ADMIN ----------------
@app.get("/admin/voices")
def adm_voices():
    inst = installed_voices(); ik = {v["key"] for v in inst}
    catalog = [{**c, "installed": c["key"] in ik} for c in CATALOG]
    return {"installed": inst, "catalog": catalog, "edge": EDGE_VOICES, "default": DEFAULT_VOICE}

@app.post("/admin/voices/install")
async def adm_install(req: Request):
    b = await req.json(); key = (b.get("key") or "").strip()
    item = next((c for c in CATALOG if c["key"] == key), None)
    if not item:
        return {"error": "voz no esta en el catalogo"}
    base = f"{HF}/{item['path']}/{key}"
    try:
        for ext in (".onnx", ".onnx.json"):
            r = subprocess.run(["curl", "-fsSL", "-o", f"{VOICES}/{key}{ext}", f"{base}{ext}"], timeout=180)
            if r.returncode != 0:
                return {"error": "fallo la descarga de " + ext}
        return {"ok": True, "key": key}
    except Exception as e:
        return {"error": str(e)}

@app.delete("/admin/voices/{key}")
def adm_delete(key: str):
    if key == DEFAULT_VOICE:
        return {"error": "no se puede borrar la voz por defecto"}
    n = 0
    for ext in (".onnx", ".onnx.json"):
        p = f"{VOICES}/{key}{ext}"
        if os.path.exists(p): os.remove(p); n += 1
    return {"ok": True, "removed": n}

@app.get("/admin/config")
def adm_get_config():
    return {"whisper": WMODEL_NAME, "default_voice": DEFAULT_VOICE, "models": ["tiny", "base", "small", "medium"]}

@app.post("/admin/config")
async def adm_set_config(req: Request):
    b = await req.json()
    wm = b.get("whisper") or WMODEL_NAME
    dv = b.get("default_voice") or DEFAULT_VOICE
    try:
        with open(ENVFILE, "w") as f:
            f.write(f"VOZ_WHISPER={wm}\nVOZ_VOICE={dv}\n")
        subprocess.Popen(["bash", "-c", "sleep 1 && systemctl restart voz"])
        return {"ok": True, "restarting": True}
    except Exception as e:
        return {"error": str(e)}

@app.get("/admin/logs")
def adm_logs():
    try:
        out = subprocess.run(["journalctl", "-u", "voz", "-n", "120", "--no-pager", "-o", "short-iso"],
                             capture_output=True, text=True, timeout=8).stdout
        return {"logs": out[-8000:]}
    except Exception as e:
        return {"logs": "error: " + str(e)}

@app.post("/admin/restart")
def adm_restart():
    try:
        subprocess.Popen(["bash", "-c", "sleep 1 && systemctl restart voz"])
        return {"ok": True, "restarting": True}
    except Exception as e:
        return {"error": str(e)}
