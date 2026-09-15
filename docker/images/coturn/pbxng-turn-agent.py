#!/usr/bin/env python3
# PBX-NG TURN agent (Coturn) - stdlib only. HTTP en :8091.
import json
import os, re, socket, subprocess, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF = "/etc/turnserver.conf"
CLI_HOST, CLI_PORT = "127.0.0.1", 5766
CLI_PASS = "pbxngturn"

def sh(cmd, t=8):
    try: return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t).stdout.strip()
    except Exception as e: return ""

def parse_conf():
    d = {}; raw = ""
    try: raw = open(CONF).read()
    except Exception: pass
    for ln in raw.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#"): continue
        if "=" in ln:
            k, v = ln.split("=", 1); d[k.strip()] = v.strip()
        else:
            d[ln] = True
    return d, raw

def metrics():
    m = {}
    try:
        with open("/proc/loadavg") as f: m["load"] = float(f.read().split()[0])
        with open("/proc/uptime") as f: m["uptime_s"] = int(float(f.read().split()[0]))
        mem = {}
        for ln in open("/proc/meminfo"):
            p = ln.split(":"); 
            if len(p) == 2: mem[p[0]] = int(p[1].strip().split()[0])
        tot = mem.get("MemTotal", 0); av = mem.get("MemAvailable", 0)
        m["mem_total_mb"] = round(tot/1024); m["mem_used_mb"] = round((tot-av)/1024)
        m["mem_pct"] = round((tot-av)*100.0/tot, 1) if tot else 0
        m["ncpu"] = os.cpu_count() or 1
    except Exception: pass
    return m

def cli_cmd(cmd):
    try:
        s = socket.create_connection((CLI_HOST, CLI_PORT), timeout=3)
        s.settimeout(3); buf = b""
        def rd():
            nonlocal buf
            try:
                while True:
                    d = s.recv(4096)
                    if not d: break
                    buf += d
                    if b">" in d or len(buf) > 65536: break
            except Exception: pass
        rd(); s.sendall((CLI_PASS + "\n").encode()); time.sleep(0.2); rd()
        s.sendall((cmd + "\n").encode()); time.sleep(0.4); rd()
        s.sendall(b"quit\n"); s.close()
        return buf.decode(errors="replace")
    except Exception:
        return ""

def sessions():
    out = cli_cmd("ps")
    sess = []
    if not out: return sess
    cur = {}
    for ln in out.splitlines():
        ln = ln.strip()
        m = re.match(r"\d+\)\s+id=([0-9a-fx]+)", ln)
        if m:
            if cur: sess.append(cur)
            cur = {"id": m.group(1)}
        mm = re.search(r"user\s+<([^>]*)>", ln);  cur and mm and cur.update(user=mm.group(1))
        mm = re.search(r"realm\s+<([^>]*)>", ln);  cur and mm and cur.update(realm=mm.group(1))
        mm = re.search(r"client_protocol=(\w+)", ln); cur and mm and cur.update(proto=mm.group(1))
        mm = re.search(r"(\d+\.\d+\.\d+\.\d+:\d+)", ln); cur and mm and (cur.setdefault("addr", mm.group(1)))
        mm = re.search(r"rp=(\d+).*sp=(\d+)", ln) or re.search(r"packets:.*rcvd\s+(\d+).*sent\s+(\d+)", ln)
    if cur: sess.append(cur)
    return sess

def turn_escucha():
    """¿El proceso turnserver está de verdad escuchando el puerto de señalización?

    POR QUE ASI Y NO `turnserver --version`: eso es el BINARIO, no el servicio. El agente
    decia "active" con sólo poder ejecutar el ejecutable, asi que el panel mostraba
    «Operativo» aunque el turnserver estuviera caido o ni siquiera hubiera arrancado.
    Y `systemctl` no existe en el contenedor (coturn es PID 1 via exec), o sea que la
    rama de systemd devolvia vacio SIEMPRE. Aca se mide lo unico que importa: que haya
    alguien aceptando conexiones en listening-port.

    OJO: esto sigue siendo "el puerto contesta", que NO alcanza para decir que el TURN
    sirve. El veredicto de verdad (Allocate + candidato relay + cordura de la direccion
    del relay) lo da la API: POST /api/turn/probe y scripts/check-turn.py.
    """
    d, _ = parse_conf()
    try: port = int(d.get("listening-port", 3478))
    except Exception: port = 3478
    for host in ("127.0.0.1", "::1"):
        try:
            socket.create_connection((host, port), 2).close()
            return True
        except Exception:
            continue
    return False

def health():
    d, raw = parse_conf()
    active = "active" if turn_escucha() else "inactive"
    ver = sh("turnserver --version 2>&1 | head -1") or sh("turnserver -h 2>&1 | grep -i version | head -1")
    relay_sockets = sh("ss -lun 2>/dev/null | grep -cE '0.0.0.0|::'")
    user = d.get("user", ""); uname = user.split(":")[0] if user else ""
    cli_on = "no-cli" not in d
    return {
        "ok": True, "active": active, "version": (ver or "").replace("Version ", "").strip()[:40],
        "realm": d.get("realm", ""), "listening_port": d.get("listening-port", "3478"),
        "min_port": d.get("min-port", ""), "max_port": d.get("max-port", ""),
        "external_ip": d.get("external-ip", ""), "user_name": uname,
        "tls": "no-tls" not in d, "dtls": "no-dtls" not in d, "cli": cli_on,
        "fingerprint": "fingerprint" in d, "lt_cred": "lt-cred-mech" in d,
        "relay_sockets": relay_sockets, "metrics": metrics(), "sessions": sessions(),
    }

def save_config(b):
    d, raw = parse_conf()
    # campos editables
    setk = {}
    if b.get("realm") is not None: setk["realm"] = b["realm"]
    if b.get("listening_port"): setk["listening-port"] = str(b["listening_port"])
    if b.get("min_port"): setk["min-port"] = str(b["min_port"])
    if b.get("max_port"): setk["max-port"] = str(b["max_port"])
    if b.get("external_ip") is not None: setk["external-ip"] = b["external_ip"]
    if b.get("user_name") and b.get("user_password"):
        setk["user"] = b["user_name"] + ":" + b["user_password"]
    elif b.get("user_password") and d.get("user"):
        setk["user"] = d["user"].split(":")[0] + ":" + b["user_password"]
    # reescribir conservando otras lineas
    lines = raw.splitlines(); seen = set(); out = []
    for ln in lines:
        s = ln.strip()
        if "=" in s and not s.startswith("#"):
            k = s.split("=", 1)[0].strip()
            if k in setk: out.append(k + "=" + setk[k]); seen.add(k); continue
        out.append(ln)
    for k, v in setk.items():
        if k not in seen: out.append(k + "=" + v)
    open(CONF + ".bak", "w").write(raw)
    open(CONF, "w").write("\n".join(out) + "\n")
    subprocess.run("systemctl restart coturn", shell=True, capture_output=True, text=True)
    time.sleep(1.5)
    # Mismo criterio que health(): lo que decide es que haya alguien escuchando, no lo
    # que conteste un systemctl que en el contenedor ni existe.
    return {"ok": turn_escucha(), "applied": list(setk.keys())}


# ---------------------------------------------------------------------------
# Metricas del nodo de borde (el mismo host donde viven kamailio, rtpengine y
# coturn). El Resumen del panel las consume para mostrar CPU, RAM, disco e
# interfaces de red de cada componente, no solo del core.
# ---------------------------------------------------------------------------
def _metrics():
    m = {}
    try:
        m["load"] = float(open("/proc/loadavg").read().split()[0])
        m["uptime_s"] = int(float(open("/proc/uptime").read().split()[0]))
        mem = {}
        for ln in open("/proc/meminfo"):
            p = ln.split(":")
            if len(p) == 2: mem[p[0]] = int(p[1].strip().split()[0])
        tot = mem.get("MemTotal", 0); av = mem.get("MemAvailable", 0)
        m["mem_total_mb"] = round(tot / 1024); m["mem_used_mb"] = round((tot - av) / 1024)
        m["mem_pct"] = round((tot - av) * 100.0 / tot, 1) if tot else 0
        m["ncpu"] = os.cpu_count() or 1
        m["cpu_pct"] = round(min(100.0, m["load"] * 100.0 / max(1, m["ncpu"])), 1)
    except Exception: pass
    try:
        st = os.statvfs("/")
        tot = st.f_blocks * st.f_frsize; free = st.f_bavail * st.f_frsize
        m["disk_total"] = tot; m["disk_free"] = free; m["disk_used"] = tot - free
        m["disk_pct"] = round((tot - free) * 100.0 / tot, 1) if tot else 0
    except Exception: pass
    return m

def _ifaces():
    """Interfaces del host. El contenedor de coturn no trae `ip`, asi que leemos /sys
    y sacamos la IPv4 con un ioctl (SIOCGIFADDR): stdlib pura, sin dependencias."""
    import fcntl, struct
    res = []
    try: names = sorted(os.listdir("/sys/class/net"))
    except Exception: names = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    SKIP = ("veth", "br-", "docker", "virbr", "lxcbr", "bonding_masters", "tap")
    for name in names:
        # solo placas reales: nada de bridges de docker, veths ni pseudo-dispositivos
        if name == "lo" or name.startswith(SKIP): continue
        def rd(p, d=""):
            try: return open("/sys/class/net/%s/%s" % (name, p)).read().strip()
            except Exception: return d
        addr = None
        try:
            addr = socket.inet_ntoa(fcntl.ioctl(s.fileno(), 0x8915,
                   struct.pack("256s", name[:15].encode()))[20:24])
        except Exception: pass
        rx = tx = None
        try:
            rx = int(rd("statistics/rx_bytes", "0")); tx = int(rd("statistics/tx_bytes", "0"))
        except Exception: pass
        res.append({"name": name, "state": (rd("operstate") or "unknown").upper(),
                    "addrs": [addr] if addr else [], "mac": rd("address"),
                    "rx_bytes": rx, "tx_bytes": tx})
    try: s.close()
    except Exception: pass
    return res

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith("/health"): return self._send(200, health())
        if self.path.startswith("/core"): return self._send(200, {"ok": True, "metrics": _metrics()})
        if self.path.startswith("/net"): return self._send(200, {"ifaces": _ifaces()})
        if self.path.startswith("/config"):
            d, raw = parse_conf(); return self._send(200, {"raw": raw, "parsed": {k: (v if v is not True else True) for k, v in d.items()}})
        if self.path.startswith("/logs"):
            return self._send(200, {"log": sh("tail -n 120 /var/log/turnserver.log 2>/dev/null || journalctl -u coturn --no-pager -n 120 2>/dev/null", 10)})
        self._send(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        try: b = json.loads(self.rfile.read(n) or b"{}")
        except Exception: b = {}
        if self.path.startswith("/service"):
            act = b.get("action")
            if act in ("start","stop","restart"):
                # Bajo Docker el ciclo de vida del contenedor NO lo maneja este agente:
                # lo maneja el reconciliador (docker/pbxng-reconciler.sh) leyendo
                # pbxng_settings.mod_turn y llamando a `pbxng-ctl enable/disable turn`.
                # Se contesta `queued` (que es lo que el panel ya sabe mostrar) en vez de
                # correr un `systemctl` que no existe y devolver ok:false sin explicar nada.
                subprocess.run("systemctl %s coturn" % act, shell=True,
                               capture_output=True)   # sirve en un host con systemd (instalacion sin Docker)
                time.sleep(1.0)
                vivo = turn_escucha()
                esperado = (act != "stop")
                return self._send(200, {"ok": vivo == esperado, "action": act, "activo": vivo,
                                        "queued": vivo != esperado,
                                        "nota": "en Docker lo aplica el reconciliador (pbxng-ctl enable/disable turn)"})
            return self._send(400, {"error":"action invalida"})
        if self.path.startswith("/restart"):
            subprocess.run("systemctl restart coturn", shell=True, capture_output=True); time.sleep(1.2)
            return self._send(200, {"ok": turn_escucha(),
                                    "nota": "en Docker el reinicio real es `pbxng-ctl` / `docker compose restart coturn`"})
        if self.path.startswith("/config"):
            try: return self._send(200, save_config(b))
            except Exception as e: return self._send(500, {"error": str(e)})
        if self.path.startswith("/test"):
            # RETIRADO A PROPOSITO. Antes corria `turnutils_uclient` contra 127.0.0.1
            # DESDE ADENTRO del propio coturn: eso da OK siempre, incluso con el relay
            # escuchando solo en la direccion del bridge de Docker (el caso real que dejo
            # una central entera sin audio con el panel en verde). Una prueba que no puede
            # fallar no es una prueba. La sonda de verdad la hace la API contra la
            # direccion que se le reparte a los softphones: POST /api/turn/test o
            # /api/turn/probe (control-plane/turn.js), y scripts/check-turn.py.
            return self._send(410, {"error": "prueba local retirada: usa POST /api/turn/probe (mide contra la direccion publica, no contra loopback)"})
        self._send(404, {"error": "not found"})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8091), H).serve_forever()
