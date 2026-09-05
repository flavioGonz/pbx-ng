#!/usr/bin/env python3
# PBX-NG Asterisk agent (CT103) - stdlib only. HTTP :8092. Estado nucleo + red + rutas.
import json, os, re, subprocess, time, sys, hmac, ipaddress, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
ROUTES_FILE = "/etc/pbxng-ast-routes.json"
# Token compartido con la API (mismo volumen "certs" montado en /etc/pbxng). La API lo
# manda en X-PBXNG-Token; acá sólo se exige para /fw/* (control del firewall del host).
TOKEN_FILE = os.environ.get("PBXNG_AGENT_TOKEN_FILE", "/etc/pbxng/agent.token")

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

# ---------------------------------------------------------------------------
# Firewall (nftables) para el módulo /seguridad. Contrato con la API:
#   POST /fw/ban   {ip, seconds}   seconds 0 = permanente
#   POST /fw/unban {ip}
#   GET  /fw/bans                  -> {enabled, bans:[{ip, expires_s|null}]}
#   POST /fw/sync  {bans:[{ip,seconds}]}  deja el set EXACTAMENTE así
# Todo vive en el kernel del host (network_mode host + NET_ADMIN): tabla inet pbxng,
# set "banned" (ipv4_addr, flags timeout) y regla 'ip saddr @banned drop' en una chain
# input de prioridad -10 (antes del filter normal, así ni siquiera llega a Asterisk).
# Se usa argv (nunca shell): las IPs se validan con ipaddress pero igual no se concatenan.
FW_FAMILY, FW_TABLE, FW_SET, FW_CHAIN = "inet", "pbxng", "banned", "input"
FW_LOCK = threading.Lock()

def nft(args, t=8, stdin=None):
    """Corre nft con argv. Devuelve (rc, stdout, stderr). rc=127 si no está instalado,
    124 si venció el timeout: así el llamador distingue 'no hay nftables' de 'falló'."""
    try:
        p = subprocess.run(["nft"] + list(args), capture_output=True, text=True, timeout=t, input=stdin)
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
    except FileNotFoundError:
        return 127, "", "nft no está instalado en el contenedor"
    except subprocess.TimeoutExpired:
        return 124, "", "nft no respondió en %ds" % t
    except Exception as e:
        return 1, "", str(e)

def fw_exists(kind, name=None):
    a = ["list", kind, FW_FAMILY, FW_TABLE] + ([name] if name else [])
    rc, out, err = nft(a)
    return rc, out, err

def ensure_fw():
    """Idempotente: crea tabla/set/chain/regla sólo si faltan. Nunca borra el set (los
    bloqueos vigentes sobreviven a un reinicio del contenedor). Devuelve
    {enabled, motivo?, creado:[...]}; enabled=False si el kernel no tiene nf_tables o
    falta el binario, con el motivo legible para que el panel lo muestre."""
    creado = []
    rc, out, err = fw_exists("table")
    if rc == 127 or rc == 124:
        return {"enabled": False, "motivo": err}
    if rc != 0:
        # No hay tabla: puede ser que no exista o que el kernel no soporte nftables.
        rc2, _, err2 = nft(["add", "table", FW_FAMILY, FW_TABLE])
        if rc2 != 0:
            return {"enabled": False, "motivo": "no se pudo crear la tabla nftables: %s" % (err2 or "exit %d" % rc2)}
        creado.append("table")
    rc, out, err = fw_exists("set", FW_SET)
    if rc != 0:
        rc2, _, err2 = nft(["add", "set", FW_FAMILY, FW_TABLE, FW_SET, "{ type ipv4_addr; flags timeout; }"])
        if rc2 != 0:
            return {"enabled": False, "motivo": "no se pudo crear el set: %s" % (err2 or "exit %d" % rc2)}
        creado.append("set")
    rc, out, err = fw_exists("chain", FW_CHAIN)
    if rc != 0:
        rc2, _, err2 = nft(["add", "chain", FW_FAMILY, FW_TABLE, FW_CHAIN, "{ type filter hook input priority -10; policy accept; }"])
        if rc2 != 0:
            return {"enabled": False, "motivo": "no se pudo crear la chain: %s" % (err2 or "exit %d" % rc2)}
        creado.append("chain")
        out = ""
    # La regla se busca por texto en la chain listada: 'nft -f' con la sintaxis declarativa
    # la duplicaría en cada arranque, por eso se agrega a mano sólo cuando no está.
    if ("@%s" % FW_SET) not in out or "drop" not in out:
        rc2, _, err2 = nft(["add", "rule", FW_FAMILY, FW_TABLE, FW_CHAIN, "ip", "saddr", "@" + FW_SET, "drop"])
        if rc2 != 0:
            return {"enabled": False, "motivo": "no se pudo agregar la regla: %s" % (err2 or "exit %d" % rc2)}
        creado.append("rule")
    return {"enabled": True, "creado": creado}

def host_ips():
    """IPs propias del host (red del host): jamás se banea una, cortaría la gestión."""
    res = set()
    for i in ifaces():
        for a in i.get("addrs", []):
            try: res.add(str(ipaddress.ip_interface(a).ip))
            except Exception: pass
    return res

def fw_valid_ip(raw):
    """Devuelve (ip_str, error). Sólo IPv4 pública y que no sea del propio host."""
    try:
        ip = ipaddress.ip_address(str(raw or "").strip())
    except Exception:
        return None, "IP inválida"
    if ip.version != 4:
        return None, "sólo se bloquean direcciones IPv4"
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return None, "no se bloquean direcciones privadas, de loopback ni reservadas"
    if str(ip) in host_ips():
        return None, "esa IP es del propio servidor"
    return str(ip), None

def fw_seconds(v):
    try: s = int(v or 0)
    except Exception: s = 0
    return max(0, min(s, 10 * 365 * 86400))  # tope 10 años: nft rechaza timeouts absurdos

def fw_elem(ip, seconds):
    return "%s timeout %ds" % (ip, seconds) if seconds > 0 else ip

def fw_ban(ip, seconds):
    with FW_LOCK:
        st = ensure_fw()
        if not st.get("enabled"): return 503, {"ok": False, **st}
        # Si ya estaba, 'add element' con otro timeout falla o no lo renueva según la
        # versión de nft: se saca primero y se vuelve a poner (misma transacción, nft -f).
        script = "delete element %s %s %s { %s }\nadd element %s %s %s { %s }\n" % (
            FW_FAMILY, FW_TABLE, FW_SET, ip, FW_FAMILY, FW_TABLE, FW_SET, fw_elem(ip, seconds))
        rc, out, err = nft(["-f", "-"], stdin=script)
        if rc != 0:
            # El delete falla si no existía: reintento sólo con el add.
            rc, out, err = nft(["add", "element", FW_FAMILY, FW_TABLE, FW_SET, "{ %s }" % fw_elem(ip, seconds)])
            if rc != 0: return 500, {"ok": False, "error": "nft: %s" % (err or "exit %d" % rc)}
        return 200, {"ok": True, "ip": ip, "seconds": seconds, "enabled": True}

def fw_unban(ip):
    with FW_LOCK:
        st = ensure_fw()
        if not st.get("enabled"): return 503, {"ok": False, **st}
        rc, out, err = nft(["delete", "element", FW_FAMILY, FW_TABLE, FW_SET, "{ %s }" % ip])
        # No estaba en el set = ya está desbloqueada: idempotente, no es error.
        if rc != 0 and "No such file" not in err and "does not exist" not in err:
            return 500, {"ok": False, "error": "nft: %s" % (err or "exit %d" % rc)}
        return 200, {"ok": True, "ip": ip, "enabled": True}

def fw_bans():
    st = ensure_fw()
    if not st.get("enabled"): return {"enabled": False, "bans": [], "motivo": st.get("motivo")}
    rc, out, err = nft(["-j", "list", "set", FW_FAMILY, FW_TABLE, FW_SET])
    if rc != 0: return {"enabled": False, "bans": [], "motivo": "nft: %s" % (err or "exit %d" % rc)}
    bans = []
    try:
        for it in json.loads(out).get("nftables", []):
            s = it.get("set")
            if not s: continue
            for el in s.get("elem", []) or []:
                # Sin timeout viene como string pelado; con timeout como {"elem":{"val","timeout","expires"}}.
                if isinstance(el, str):
                    bans.append({"ip": el, "expires_s": None})
                elif isinstance(el, dict) and "elem" in el:
                    e = el["elem"]; v = e.get("val")
                    if isinstance(v, str):
                        exp = e.get("expires", e.get("timeout"))
                        bans.append({"ip": v, "expires_s": int(exp) if exp is not None else None})
    except Exception as e:
        return {"enabled": True, "bans": [], "motivo": "no se pudo leer el set: %s" % e}
    return {"enabled": True, "bans": bans}

def fw_sync(items):
    """Deja el set exactamente con lo que manda la API (flush + add en una sola
    transacción de nft -f: o entra todo o no cambia nada)."""
    with FW_LOCK:
        st = ensure_fw()
        if not st.get("enabled"): return 503, {"ok": False, **st}
        elems, rechazados = [], []
        for it in items or []:
            if not isinstance(it, dict): continue
            ip, e = fw_valid_ip(it.get("ip"))
            if e: rechazados.append({"ip": it.get("ip"), "error": e}); continue
            elems.append(fw_elem(ip, fw_seconds(it.get("seconds"))))
        script = "flush set %s %s %s\n" % (FW_FAMILY, FW_TABLE, FW_SET)
        if elems:
            script += "add element %s %s %s { %s }\n" % (FW_FAMILY, FW_TABLE, FW_SET, ", ".join(elems))
        rc, out, err = nft(["-f", "-"], t=20, stdin=script)
        if rc != 0: return 500, {"ok": False, "error": "nft: %s" % (err or "exit %d" % rc), "rechazados": rechazados}
        return 200, {"ok": True, "enabled": True, "total": len(elems), "rechazados": rechazados}

def agent_token():
    try: return open(TOKEN_FILE).read().strip()
    except Exception: return os.environ.get("PBXNG_AGENT_TOKEN", "").strip()

def fw_auth(handler):
    """/fw/* toca el firewall del host: exige X-PBXNG-Token si hay token configurado.
    Sin token (instalación vieja sin /etc/pbxng/agent.token) se acepta sólo desde
    redes privadas/loopback, que es de donde llega la API (bridge de docker)."""
    tok = agent_token()
    got = handler.headers.get("X-PBXNG-Token", "") or ""
    if tok:
        return hmac.compare_digest(tok, got)
    try:
        src = ipaddress.ip_address(handler.client_address[0])
        return src.is_private or src.is_loopback
    except Exception:
        return False

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _s(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith("/core"): return self._s(200, {"ok": True, "metrics": metrics(), **core()})
        if self.path.startswith("/net"): return self._s(200, {"ifaces": ifaces(), "kernel_routes": sh("ip route show 2>/dev/null").splitlines(), "managed": load_routes()})
        if self.path.startswith("/fw/"):
            if not fw_auth(self): return self._s(401, {"error": "token inválido"})
            if self.path.startswith("/fw/bans"): return self._s(200, fw_bans())
            return self._s(404, {"error": "not found"})
        self._s(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        try: b = json.loads(self.rfile.read(n) or b"{}")
        except Exception: b = {}
        if self.path.startswith("/fw/"):
            if not fw_auth(self): return self._s(401, {"error": "token inválido"})
            if not isinstance(b, dict): b = {}
            if self.path.startswith("/fw/ban"):
                ip, e = fw_valid_ip(b.get("ip"))
                if e: return self._s(400, {"error": e})
                code, r = fw_ban(ip, fw_seconds(b.get("seconds")))
                return self._s(code, r)
            if self.path.startswith("/fw/unban"):
                ip, e = fw_valid_ip(b.get("ip"))
                if e: return self._s(400, {"error": e})
                code, r = fw_unban(ip)
                return self._s(code, r)
            if self.path.startswith("/fw/sync"):
                items = b.get("bans")
                if not isinstance(items, list): return self._s(400, {"error": "bans debe ser una lista"})
                code, r = fw_sync(items)
                return self._s(code, r)
            return self._s(404, {"error": "not found"})
        if self.path.startswith("/sound"):
            import base64 as _b64, os as _os
            nm = re.sub(r"[^a-zA-Z0-9_-]", "", str(b.get("name","")))[:60]
            if not nm: return self._s(400, {"error": "name requerido"})
            try:
                data = _b64.b64decode(b.get("b64",""))
                d = "/var/lib/asterisk/sounds/custom"; _os.makedirs(d, exist_ok=True)
                open(_os.path.join(d, nm + ".wav"), "wb").write(data)
                return self._s(200, {"ok": True, "ref": "custom/" + nm, "bytes": len(data)})
            except Exception as e: return self._s(500, {"error": str(e)})
        if self.path.startswith("/diag"):
            # Diagnostico de red DESDE el nucleo. El host se valida y se pasa como argumento
            # (nunca por shell): un campo libre que termina en sh -c es una consola remota.
            host = str(b.get("host", "")).strip()
            que = str(b.get("que", "ping")).lower()
            if not re.match(r"^[A-Za-z0-9_.:-]{1,100}$", host):
                return self._s(400, {"error": "host invalido"})
            t0 = time.time()
            if que == "trace":
                cmd = ["traceroute", "-n", "-w", "2", "-q", "1", "-m", "15", host]
            elif que == "sip":
                import socket as _sk
                try: port = int(b.get("port", 5060))
                except Exception: port = 5060
                port = port if 1 <= port <= 65535 else 5060
                ok = False; salida = ""
                try:
                    s = _sk.socket(_sk.AF_INET, _sk.SOCK_STREAM); s.settimeout(4)
                    s.connect((host, port)); ok = True; s.close()
                    salida = "conexion TCP establecida a %s:%d" % (host, port)
                except Exception as e:
                    salida = "sin respuesta TCP en %s:%d (%s)" % (host, port, e.__class__.__name__)
                return self._s(200, {"ok": ok, "que": "sip", "salida": salida, "comando": "tcp connect %s:%d" % (host, port), "ms": int((time.time() - t0) * 1000)})
            else:
                que = "ping"; cmd = ["ping", "-n", "-c", "3", "-W", "2", host]
            try:
                p = subprocess.run(cmd, capture_output=True, text=True, timeout=42)
                out = ((p.stdout or "") + (p.stderr or "")).strip()
                ok = (p.returncode == 0) if que == "ping" else bool(out)
            except FileNotFoundError:
                return self._s(200, {"ok": False, "que": que, "salida": "el comando '%s' no esta instalado en el contenedor" % cmd[0], "comando": " ".join(cmd), "ms": int((time.time() - t0) * 1000)})
            except Exception as e:
                return self._s(200, {"ok": False, "que": que, "salida": str(e), "comando": " ".join(cmd), "ms": int((time.time() - t0) * 1000)})
            return self._s(200, {"ok": ok, "que": que, "salida": out, "comando": " ".join(cmd), "ms": int((time.time() - t0) * 1000)})
        if self.path.startswith("/iface"):
            # Cambiar IP / activar-desactivar una placa EN CALIENTE (no persiste al reiniciar
            # el contenedor). dev y cidr se validan por regex: nunca van sin filtrar al shell.
            act = str(b.get("action", "")).lower()
            dev = str(b.get("dev", ""))
            if not re.match(r"^[a-zA-Z0-9_.@-]{1,24}$", dev):
                return self._s(400, {"error": "interfaz invalida"})
            if act in ("up", "down"):
                out = sh("ip link set %s %s 2>&1" % (dev, act))
                return self._s(200, {"ok": True, "action": act, "dev": dev, "out": out})
            if act in ("addip", "replace", "delip"):
                cidr = str(b.get("cidr", ""))
                if not re.match(r"^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$", cidr):
                    return self._s(400, {"error": "IP/CIDR invalido (ej 192.168.1.50/24)"})
                if act == "replace":
                    sh("ip addr flush dev %s 2>&1" % dev)
                    out = sh("ip addr add %s dev %s 2>&1" % (cidr, dev))
                elif act == "delip":
                    out = sh("ip addr del %s dev %s 2>&1" % (cidr, dev))
                else:
                    out = sh("ip addr add %s dev %s 2>&1" % (cidr, dev))
                sh("ip link set %s up 2>&1" % dev)
                return self._s(200, {"ok": True, "action": act, "dev": dev, "cidr": cidr, "out": out})
            return self._s(400, {"error": "accion invalida"})
        if self.path.startswith("/netmode"):
            # Aplica un plan de modo de red (router/switch) que ARMA el control-plane.
            # Viene como lista de pasos [{desc, cmd:[argv...]}]; se ejecutan en orden y
            # se corta en el primero que falle, informando cual fue. Cambiar el modo
            # puede cortar la gestion: por eso el panel usa commit-confirm con rollback.
            pasos = b.get("pasos") or []
            if not isinstance(pasos, list):
                return self._s(400, {"error": "pasos invalidos"})
            hechos = []
            for p in pasos:
                cmd = p.get("cmd")
                if not isinstance(cmd, list) or not cmd:
                    hechos.append({"desc": p.get("desc"), "ok": False, "error": "comando invalido"})
                    return self._s(200, {"ok": False, "pasos": hechos, "fallo": p.get("desc")})
                try:
                    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                    out = ((r.stdout or "") + (r.stderr or "")).strip()
                    if r.returncode != 0:
                        hechos.append({"desc": p.get("desc"), "ok": False, "error": out or ("exit %d" % r.returncode)})
                        return self._s(200, {"ok": False, "pasos": hechos, "fallo": p.get("desc")})
                    hechos.append({"desc": p.get("desc"), "ok": True, "out": out[:400]})
                except Exception as e:
                    hechos.append({"desc": p.get("desc"), "ok": False, "error": str(e)})
                    return self._s(200, {"ok": False, "pasos": hechos, "fallo": p.get("desc")})
            return self._s(200, {"ok": True, "pasos": hechos})
        if self.path.startswith("/reload"):
            subprocess.run("asterisk -rx 'pjsip reload'", shell=True, timeout=20); return self._s(200, {"ok": True})
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
    if "--ensure-fw" in sys.argv:
        # Lo llama el entrypoint antes de arrancar Asterisk: crea la tabla si falta y
        # sale con 0 siempre (un host sin nftables no tiene que frenar la central).
        st = ensure_fw()
        print("pbxng-fw: " + json.dumps(st, ensure_ascii=False)); sys.exit(0)
    reapply_all()
    st = ensure_fw()
    if not st.get("enabled"):
        print("pbxng-ast-agent: firewall deshabilitado: %s" % st.get("motivo"), file=sys.stderr, flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8092), H).serve_forever()
