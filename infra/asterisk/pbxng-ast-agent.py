#!/usr/bin/env python3
# PBX-NG Asterisk agent (CT103) - stdlib only. HTTP :8092. Estado nucleo + red + rutas.
import json, os, re, subprocess, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
ROUTES_FILE = "/etc/pbxng-ast-routes.json"

def sh(cmd, t=8):
    try: return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t).stdout.strip()
    except Exception: return ""
def ast(rx, t=8): return sh("asterisk -rx '%s' 2>/dev/null" % rx, t)

def load_routes():
    try: return json.load(open(ROUTES_FILE))
    except Exception: return []
def save_routes(rs): 
    try: json.dump(rs, open(ROUTES_FILE, "w"))
    except Exception: pass
def apply_route(r):
    cmd = "ip route replace %s" % r["dest"]
    if r.get("gw"): cmd += " via %s" % r["gw"]
    if r.get("dev"): cmd += " dev %s" % r["dev"]
    sh(cmd)
def reapply_all():
    for r in load_routes(): apply_route(r)

def metrics():
    m = {}
    try:
        m["load"] = float(open("/proc/loadavg").read().split()[0])
        m["uptime_s"] = int(float(open("/proc/uptime").read().split()[0]))
        mem = {}
        for ln in open("/proc/meminfo"):
            p = ln.split(":")
            if len(p) == 2: mem[p[0]] = int(p[1].strip().split()[0])
        tot = mem.get("MemTotal", 0); av = mem.get("MemAvailable", 0)
        m["mem_total_mb"] = round(tot/1024); m["mem_used_mb"] = round((tot-av)/1024)
        m["mem_pct"] = round((tot-av)*100.0/tot, 1) if tot else 0
        m["ncpu"] = os.cpu_count() or 1
    except Exception: pass
    return m

def ifaces():
    out = sh("ip -br addr 2>/dev/null"); res = []
    for ln in out.splitlines():
        p = ln.split()
        if not p or p[0] == "lo": continue
        res.append({"name": p[0].split("@")[0], "state": p[1] if len(p) > 1 else "", "addrs": [a for a in p[2:] if ":" not in a or a.count(":") < 2]})
    return res

def core():
    ver = ast("core show version"); ver = (ver.split("built")[0].strip() if ver else "")
    chans = ast("core show channels count")
    nch = 0
    m = re.search(r"(\d+)\s+active channel", chans);  nch = int(m.group(1)) if m else 0
    tr = []
    for ln in ast("pjsip show transports").splitlines():
        mm = re.match(r"\s*Transport:\s+(\S+)\s+(\S+)", ln)
        if mm and not mm.group(1).startswith("<"): tr.append({"id": mm.group(1), "proto": mm.group(2)})
    mods = {}
    for k, like in [("pjsip","res_pjsip.so"),("srtp","res_srtp.so"),("crypto","res_crypto.so"),("rtp","res_rtp_asterisk.so")]:
        mods[k] = "Running" in ast("module show like %s" % like) or like in ast("module show like %s" % like)
    uptxt = ast("core show uptime")
    upline = ""
    for l in uptxt.splitlines():
        if "uptime" in l.lower(): upline = l.strip(); break
    eptxt = ast("pjsip show endpoints")
    neps = len([l for l in eptxt.splitlines() if l.strip().startswith("Endpoint:") and "<Endpoint/CID" not in l])
    return {"version": ver[:40], "channels": nch, "transports": tr, "modules": mods,
            "uptime": upline, "endpoints": neps}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _s(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith("/core"): return self._s(200, {"ok": True, "metrics": metrics(), **core()})
        if self.path.startswith("/net"): return self._s(200, {"ifaces": ifaces(), "kernel_routes": sh("ip route show 2>/dev/null").splitlines(), "managed": load_routes()})
        self._s(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        try: b = json.loads(self.rfile.read(n) or b"{}")
        except Exception: b = {}
        if self.path.startswith("/route"):
            act = b.get("action"); rs = load_routes()
            if act == "add":
                r = {"id": str(int(time.time()*1000)), "dest": b.get("dest",""), "gw": b.get("gw",""), "dev": b.get("dev",""), "note": b.get("note","")}
                if not r["dest"]: return self._s(400, {"error": "dest requerido"})
                rs = [x for x in rs if x["dest"] != r["dest"]]; rs.append(r); save_routes(rs); apply_route(r)
                return self._s(200, {"ok": True, "id": r["id"]})
            if act == "del":
                rid = str(b.get("id","")); tgt = [x for x in rs if x["id"] == rid]
                if tgt: sh("ip route del %s" % tgt[0]["dest"])
                rs = [x for x in rs if x["id"] != rid]; save_routes(rs)
                return self._s(200, {"ok": True})
            return self._s(400, {"error": "action invalida"})
        self._s(404, {"error": "not found"})

if __name__ == "__main__":
    reapply_all()
    ThreadingHTTPServer(("0.0.0.0", 8092), H).serve_forever()
