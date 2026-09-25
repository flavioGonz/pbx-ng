import os, json, subprocess, time, glob
import sys

# Medicion del nodo: UNA sola implementacion para los tres agentes de PBX-NG (asterisk,
# coturn y este). La imagen la deja en /usr/local/lib/pbxng/ y el Dockerfile verifica que
# se pueda importar. El segundo path es el del repo (docker/images/common/), para correr el
# servicio a mano desde el arbol.
sys.path[:0] = [os.environ.get("PBXNG_COMMON_DIR", "/usr/local/lib/pbxng"),
                os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "..", "docker", "images", "common")]
from pbxng_nodo import metricas_nodo   # noqa: E402
import numpy as np
from fastapi import FastAPI, Request, Response
from faster_whisper import WhisperModel

# Motor Piper: preferimos el binario si esta, y si no el CLI que instala el paquete pip
# (piper-tts). Antes se asumia una ruta fija que la imagen ni siquiera traia -> el TTS local
# nunca funcionaba y todo salia por Edge sin que nadie se enterara.
import shutil as _sh
PIPER = os.environ.get("PIPER_BIN") or (
    "/opt/piper/piper/piper" if os.path.exists("/opt/piper/piper/piper") else (_sh.which("piper") or "piper"))
# Los modelos van al volumen persistente: si se recrea el contenedor, no hay que bajarlos de nuevo.
VOICES = os.environ.get("VOICES_DIR", "/opt/voz/models")
# Ajustes que el panel cambia en caliente (modelo Whisper y voz por defecto). Hay DOS
# ubicaciones a propósito:
#   · /etc/voz.env          el despliegue con systemd, donde la unidad lo lee como
#                           EnvironmentFile;
#   · <volumen>/voz.env     el despliegue en Docker, donde /etc NO sobrevive a recrear el
#                           contenedor. El volumen de modelos sí, así que el ajuste vive
#                           ahí y se relee al arrancar.
# Antes se escribía sólo el primero y NADIE lo leía en Docker: «Aplicar y reiniciar»
# devolvía ok y la configuración volvía sola a la de antes.
ENVFILE = "/etc/voz.env"
HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
ENVFILE_VOL = os.path.join(VOICES, "voz.env")

def _leer_env_guardado():
    """Los dos archivos, el del volumen manda (es el que sobrevive en Docker)."""
    vals = {}
    for ruta in (ENVFILE, ENVFILE_VOL):
        try:
            with open(ruta) as f:
                for linea in f:
                    if "=" in linea and not linea.strip().startswith("#"):
                        k, v = linea.split("=", 1)
                        vals[k.strip()] = v.strip()
        except Exception:
            pass
    return vals

_GUARDADO = _leer_env_guardado()
DEFAULT_VOICE = _GUARDADO.get("VOZ_VOICE") or os.environ.get("VOZ_VOICE", "es_MX-claude-high")
WMODEL_NAME = _GUARDADO.get("VOZ_WHISPER") or os.environ.get("VOZ_WHISPER", "small")

# Log a archivo. En Docker no hay journalctl —ni systemd— y la salida del proceso se la
# queda el motor de contenedores, donde este servicio no puede leerla: el panel mostraba
# «No such file or directory: journalctl» y nada más. Con esto, los logs salen del mismo
# lugar en los dos despliegues.
LOGFILE = os.environ.get("VOZ_LOG", "/tmp/voz.log")

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

import logging                                    # noqa: E402
from logging.handlers import RotatingFileHandler  # noqa: E402

def _armar_log():
    """Un archivo rotado de 1 MB. No reemplaza la salida estándar: la duplica, para que
    `docker logs` siga sirviendo y el panel tenga de dónde leer."""
    try:
        h = RotatingFileHandler(LOGFILE, maxBytes=1_000_000, backupCount=1)
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%Y-%m-%dT%H:%M:%S"))
        raiz = logging.getLogger()
        if not any(isinstance(x, RotatingFileHandler) for x in raiz.handlers):
            raiz.addHandler(h)
        raiz.setLevel(logging.INFO)
        for nombre in ("uvicorn", "uvicorn.error", "uvicorn.access"):
            lg = logging.getLogger(nombre)
            if not any(isinstance(x, RotatingFileHandler) for x in lg.handlers):
                lg.addHandler(h)
    except Exception as e:
        print("[voz] no se pudo abrir el log:", e, flush=True)

_armar_log()

@app.on_event("startup")
def _log_al_arrancar():
    # uvicorn arma SUS loggers después de importar el módulo, así que se vuelve a colgar
    # el handler acá: si no, el archivo queda vacío y parece que el log no funciona.
    _armar_log()
    logging.getLogger("voz").info("servicio arriba · whisper=%s · voz=%s", WMODEL_NAME, DEFAULT_VOICE)

def _reiniciar_servicio():
    """Reiniciar significa dos cosas distintas según dónde corre esto.

    Con systemd: `systemctl restart voz`. En Docker no hay systemd —y tampoco hace falta—:
    salir del proceso alcanza, porque el contenedor tiene `restart: unless-stopped` y el
    motor lo vuelve a levantar. Antes se llamaba a systemctl siempre; en Docker eso era un
    ok que no reiniciaba nada."""
    import threading
    if _sh.which("systemctl") and os.path.exists("/run/systemd/system"):
        subprocess.Popen(["bash", "-c", "sleep 1 && systemctl restart voz"])
        return "systemd"
    def _chau():
        time.sleep(1.0)      # que la respuesta HTTP salga antes de cortarse
        os._exit(0)
    threading.Thread(target=_chau, daemon=True).start()
    return "contenedor"
STATS = {"tts": 0, "stt": 0, "tts_ms": 0.0, "stt_ms": 0.0, "started": time.time()}
print("[voz] cargando whisper", WMODEL_NAME, "...", flush=True)
WMODEL = WhisperModel(WMODEL_NAME, device="cpu", compute_type="int8")
print("[voz] whisper listo", flush=True)

def sys_metrics():
    """Metricas de ESTE contenedor, no de la maquina de abajo (ver docker/images/common/
    pbxng_nodo.py: en un contenedor /proc/meminfo y /proc/uptime son del host, y por eso
    los tres agentes informaban los mismos 35948 MB y los mismos 36 dias de uptime).

    El disco no se incluye: el panel no lo usa para este nodo y el volumen que importa acá
    (los modelos de voz) ya se informa aparte."""
    try:
        m = metricas_nodo(con_disco=False)
        if m.get("load") is not None: m["load"] = round(m["load"], 2)
        return m
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
    # Descarga del modelo. Los .onnx de HuggingFace viajan por su CDN "xet", que rechaza los
    # GET planos (403 AccessDenied) -> por eso "instalar voz" fallaba. La libreria oficial
    # huggingface_hub habla ese protocolo; si no esta disponible, caemos a HTTP directo (que
    # alcanza para los .json y para mirrors que no usen xet).
    import shutil, tempfile, urllib.request
    os.makedirs(VOICES, exist_ok=True)
    try:
        from huggingface_hub import hf_hub_download
        for ext in (".onnx", ".onnx.json"):
            src = hf_hub_download("rhasspy/piper-voices", f"{item['path']}/{key}{ext}")
            shutil.copyfile(src, f"{VOICES}/{key}{ext}")
        return {"ok": True, "key": key, "via": "huggingface_hub"}
    except ImportError:
        pass
    except Exception as e:
        return {"error": f"no se pudo descargar el modelo: {e}"}

    base = f"{HF}/{item['path']}/{key}"
    try:
        for ext in (".onnx", ".onnx.json"):
            req = urllib.request.Request(f"{base}{ext}", headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                "Accept": "*/*",
            })
            with urllib.request.urlopen(req, timeout=300) as resp:
                if resp.status != 200:
                    return {"error": f"fallo la descarga de {ext} (HTTP {resp.status})"}
                with tempfile.NamedTemporaryFile(delete=False, dir=VOICES) as tmp:
                    shutil.copyfileobj(resp, tmp)
                    tmp_path = tmp.name
            os.replace(tmp_path, f"{VOICES}/{key}{ext}")
        return {"ok": True, "key": key, "via": "http"}
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
    escritos = []
    for ruta in (ENVFILE_VOL, ENVFILE):
        try:
            os.makedirs(os.path.dirname(ruta), exist_ok=True)
            with open(ruta, "w") as f:
                f.write(f"VOZ_WHISPER={wm}\nVOZ_VOICE={dv}\n")
            escritos.append(ruta)
        except Exception:
            pass          # /etc puede ser de sólo lectura; con el del volumen alcanza
    if not escritos:
        return {"error": "no se pudo guardar la configuración en ningún lado"}
    modo = _reiniciar_servicio()
    return {"ok": True, "restarting": True, "modo": modo, "guardado_en": escritos}

@app.get("/admin/logs")
def adm_logs():
    """El archivo primero, journalctl después. El orden importa: en Docker journalctl no
    existe y el panel mostraba su error de import en vez de los logs."""
    try:
        if os.path.exists(LOGFILE):
            with open(LOGFILE, errors="replace") as f:
                out = f.read()[-8000:]
            if out.strip():
                return {"logs": out, "fuente": LOGFILE}
    except Exception:
        pass
    if _sh.which("journalctl"):
        try:
            out = subprocess.run(["journalctl", "-u", "voz", "-n", "120", "--no-pager", "-o", "short-iso"],
                                 capture_output=True, text=True, timeout=8).stdout
            if out.strip():
                return {"logs": out[-8000:], "fuente": "journalctl"}
        except Exception:
            pass
    return {"logs": "Todavía no hay líneas en " + LOGFILE + ".\n"
                    "El archivo se escribe desde que arranca el servicio: si acaba de "
                    "actualizarse, reiniciálo desde «Motor local» y volvé a cargar.",
            "fuente": "vacío"}

@app.post("/admin/restart")
def adm_restart():
    try:
        return {"ok": True, "restarting": True, "modo": _reiniciar_servicio()}
    except Exception as e:
        return {"error": str(e)}
