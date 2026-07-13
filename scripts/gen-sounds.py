#!/usr/bin/env python3
"""
PBX-NG · gen-sounds — genera el set de audios de Asterisk con el motor TTS propio.

Toma un manifiesto (id -> texto) y sintetiza cada prompt con el servicio de Voz
(voice-service /tts). Por defecto usa una voz uruguaya (Edge: es-UY), pero sirve
cualquier voz del catalogo (Piper o Edge) — asi cada cliente puede tener su propia voz.

Salida: WAV mono 16-bit @ 8 kHz (formato nativo de Asterisk) respetando subcarpetas
(digits/, vm-*, etc.), listo para /var/lib/asterisk/sounds/<lang>/.

Uso:
  ./gen-sounds.py --voz http://192.168.99.18:8080 --voice es-UY-ValentinaNeural \
                  --manifest ../voice-service/sounds/manifest.es.json --out ../docker/sounds/es
  ./gen-sounds.py --list-voices --voz http://...      # ver voces disponibles
Opciones utiles:
  --workers 6      paralelismo    --force   regenerar aunque exista
  --only vm-       generar solo los ids que empiecen con ese prefijo
"""
import argparse, concurrent.futures as cf, json, os, sys, urllib.request, wave

def tts(voz, voice, text, rate, timeout=60):
    body = json.dumps({"text": text, "voice": voice, "format": "wav", "rate": rate}).encode()
    req = urllib.request.Request(voz.rstrip("/") + "/tts", data=body,
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout).read()

def valid_wav(path, rate):
    try:
        with wave.open(path, "rb") as w:
            return (w.getnchannels() == 1 and w.getsampwidth() == 2
                    and w.getframerate() == rate and w.getnframes() > 400)
    except Exception:
        return False

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--voz", default=os.environ.get("VOZ_URL", "http://127.0.0.1:8080"))
    p.add_argument("--voice", default="es-UY-ValentinaNeural")
    p.add_argument("--manifest", default=os.path.join(os.path.dirname(__file__), "..", "voice-service", "sounds", "manifest.es.json"))
    p.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "docker", "sounds", "es"))
    p.add_argument("--rate", type=int, default=8000)
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--only", default="")
    p.add_argument("--force", action="store_true")
    p.add_argument("--list-voices", action="store_true")
    a = p.parse_args()

    if a.list_voices:
        d = json.load(urllib.request.urlopen(a.voz.rstrip("/") + "/admin/voices", timeout=15))
        print("Edge (neuronales, requieren internet):")
        for v in d.get("edge", []): print("  %-26s %s" % (v["key"], v["label"]))
        print("Piper instaladas (offline):")
        for v in d.get("installed", []): print("  %-26s %s" % (v.get("key"), v.get("label", "")))
        return 0

    man = json.load(open(a.manifest, encoding="utf-8"))
    items = [(k, v) for k, v in sorted(man.items()) if not a.only or k.startswith(a.only)]
    os.makedirs(a.out, exist_ok=True)
    todo = []
    for pid, text in items:
        dst = os.path.join(a.out, pid + ".wav")
        if not a.force and valid_wav(dst, a.rate):
            continue
        todo.append((pid, text, dst))
    print("Voz: %s · %d prompts (%d a generar, %d ya estaban)" % (a.voice, len(items), len(todo), len(items) - len(todo)))

    ok, fail = [], []
    def work(t):
        pid, text, dst = t
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        last = ""
        for _ in range(3):
            try:
                data = tts(a.voz, a.voice, text, a.rate)
                if len(data) < 1200:
                    last = "audio vacio"; continue
                open(dst, "wb").write(data)
                if valid_wav(dst, a.rate):
                    return (pid, None)
                last = "wav invalido"
            except Exception as e:
                last = str(e)
        return (pid, last or "error")

    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for i, (pid, err) in enumerate(ex.map(work, todo), 1):
            if err: fail.append((pid, err)); print("  ✗ %-28s %s" % (pid, err))
            else:   ok.append(pid)
            if i % 25 == 0: print("  ... %d/%d" % (i, len(todo)), flush=True)

    print("\nGenerados: %d · fallidos: %d · destino: %s" % (len(ok), len(fail), os.path.abspath(a.out)))
    for pid, err in fail[:10]: print("  ✗ %s: %s" % (pid, err))
    return 1 if fail else 0

if __name__ == "__main__":
    sys.exit(main())
