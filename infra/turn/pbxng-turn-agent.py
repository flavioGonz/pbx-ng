#!/usr/bin/env python3
# PBX-NG TURN agent (Coturn) - stdlib only. HTTP en :8091.
import json, os, re, socket, subprocess, time
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

def health():
    d, raw = parse_conf()
    active = sh("systemctl is-active coturn") or sh("systemctl is-active coturn-turnserver")
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
    r = subprocess.run("systemctl restart coturn", shell=True, capture_output=True, text=True)
    time.sleep(1.5)
    return {"ok": sh("systemctl is-active coturn") == "active", "applied": list(setk.keys())}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith("/health"): return self._send(200, health())
        if self.path.startswith("/config"):
            d, raw = parse_conf(); return self._send(200, {"raw": raw, "parsed": {k: (v if v is not True else True) for k, v in d.items()}})
        if self.path.startswith("/logs"):
            return self._send(200, {"log": sh("tail -n 120 /var/log/turnserver.log 2>/dev/null || journalctl -u coturn --no-pager -n 120 2>/dev/null", 10)})
        self._send(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        try: b = json.loads(self.rfile.read(n) or b"{}")
        except Exception: b = {}
        if self.path.startswith("/restart"):
            subprocess.run("systemctl restart coturn", shell=True); time.sleep(1.2)
            return self._send(200, {"ok": sh("systemctl is-active coturn") == "active"})
        if self.path.startswith("/config"):
            try: return self._send(200, save_config(b))
            except Exception as e: return self._send(500, {"error": str(e)})
        if self.path.startswith("/test"):
            d, _ = parse_conf(); ip = "127.0.0.1"; user = d.get("user", "pbxng:x").split(":")
            out = sh("turnutils_uclient -y -u %s -w %s -e %s -n 2 %s 2>&1 | tail -8" % (user[0], user[1] if len(user) > 1 else "x", ip, ip), 12)
            return self._send(200, {"out": out or "turnutils_uclient no disponible"})
        self._send(404, {"error": "not found"})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8091), H).serve_forever()
