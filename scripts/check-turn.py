#!/usr/bin/env python3
"""
PBX-NG · check-turn — verificacion REAL del STUN/TURN (RFC 5389 / 8656).

No mira "si el servicio esta arriba": hace lo mismo que hace un navegador cuando
junta candidatos ICE.

  1. STUN Binding Request      -> ¿el server contesta? ¿cual es mi IP publica?
  2. TURN Allocate (sin auth)  -> debe responder 401 con realm + nonce
  3. TURN Allocate (firmado)   -> 200 OK con XOR-RELAYED-ADDRESS = candidato relay

Si el paso 3 da 200, el TURN esta **alcanzable Y autenticado**: es exactamente la
condicion que hace que un cliente WebRTC obtenga un candidato 'relay'.

Uso:
    ./check-turn.py --host pbx.cliente.com --user pbxng --pass SECRETO
    ./check-turn.py --host 1.2.3.4 --port 3478 --user pbxng --pass SECRETO --tcp
    ./check-turn.py --env ../docker/.env          # toma TURN_USER/TURN_PASS/DOMAIN

Salida: 0 = OK, 1 = fallo (con el diagnostico y que revisar).
"""
import argparse, hashlib, hmac, os, socket, struct, sys

MAGIC = 0x2112A442
M_BINDING, M_ALLOCATE = 0x0001, 0x0003
A_MAPPED_XOR, A_USERNAME, A_MI, A_ERROR, A_REALM, A_NONCE = 0x0020, 0x0006, 0x0008, 0x0009, 0x0014, 0x0015
A_XOR_RELAYED, A_REQ_TRANSPORT = 0x0016, 0x0019

C = dict(g="\033[1;32m", r="\033[1;31m", y="\033[1;33m", c="\033[1;36m", n="\033[0m")
def ok(m):   print(f"{C['g']}  OK   {m}{C['n']}")
def bad(m):  print(f"{C['r']}  FAIL {m}{C['n']}")
def warn(m): print(f"{C['y']}  ...  {m}{C['n']}")
def hdr(m):  print(f"{C['c']}{m}{C['n']}")

def attr(t, v):
    return struct.pack(">HH", t, len(v)) + v + b"\x00" * ((4 - len(v) % 4) % 4)

def build(mtype, tid, attrs=b"", key=None):
    if key is None:
        return struct.pack(">HHI", mtype, len(attrs), MAGIC) + tid + attrs
    head = struct.pack(">HHI", mtype, len(attrs) + 24, MAGIC) + tid   # +24 = attr MESSAGE-INTEGRITY
    mi = hmac.new(key, head + attrs, hashlib.sha1).digest()
    return head + attrs + attr(A_MI, mi)

def parse(d):
    mtype, ln = struct.unpack(">HH", d[0:4])
    out, i = {}, 20
    while i < 20 + ln:
        t, l = struct.unpack(">HH", d[i:i + 4])
        out[t] = d[i + 4:i + 4 + l]
        i += 4 + l + ((4 - l % 4) % 4)
    return mtype, out

def xor_addr(v):
    port = struct.unpack(">H", v[2:4])[0] ^ (MAGIC >> 16)
    ip = bytes(a ^ b for a, b in zip(v[4:8], struct.pack(">I", MAGIC)))
    return f"{socket.inet_ntoa(ip)}:{port}"

def err_code(a):
    if A_ERROR not in a:
        return None
    b = a[A_ERROR]
    return b[2] * 100 + b[3]

class Chan:
    """UDP o TCP, misma interfaz simple."""
    def __init__(self, ip, port, tcp=False, timeout=5):
        self.tcp = tcp
        if tcp:
            self.s = socket.create_connection((ip, port), timeout)
        else:
            self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.s.settimeout(timeout)
            self.addr = (ip, port)
    def rt(self, msg):
        if self.tcp:
            self.s.sendall(msg)
            d = self.s.recv(4096)
        else:
            self.s.sendto(msg, self.addr)
            d, _ = self.s.recvfrom(4096)
        return d
    def close(self):
        try: self.s.close()
        except Exception: pass

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host"); p.add_argument("--port", type=int, default=3478)
    p.add_argument("--user"); p.add_argument("--pass", dest="pwd")
    p.add_argument("--tcp", action="store_true", help="probar TURN sobre TCP (ademas de UDP)")
    p.add_argument("--env", help="leer TURN_USER/TURN_PASS/DOMAIN/PUBLIC_IP de un .env")
    a = p.parse_args()

    if a.env and os.path.isfile(a.env):
        env = {}
        for line in open(a.env, encoding="utf-8", errors="ignore"):
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.strip().split("=", 1); env[k] = v
        a.host = a.host or env.get("DOMAIN") or env.get("PUBLIC_IP")
        a.user = a.user or env.get("TURN_USER"); a.pwd = a.pwd or env.get("TURN_PASS")
    if not (a.host and a.user and a.pwd):
        print("Faltan --host/--user/--pass (o un --env valido)"); return 2

    try:
        ip = socket.gethostbyname(a.host)
    except Exception as e:
        bad(f"DNS: no resuelve {a.host} ({e})"); return 1
    hdr(f"== TURN check · {a.host} ({ip}):{a.port} · user={a.user} ==")

    rc = 0
    for tcp in ([False, True] if a.tcp else [False]):
        proto = "TCP" if tcp else "UDP"
        try:
            ch = Chan(ip, a.port, tcp)
        except Exception as e:
            bad(f"[{proto}] no conecta a {ip}:{a.port} ({e})")
            warn("      -> port-forward ausente, firewall, o NAT hairpin si probas desde la LAN")
            rc = 1; continue

        # 1) STUN Binding
        try:
            m, at = parse(ch.rt(build(M_BINDING, os.urandom(12))))
            ok(f"[{proto}] STUN responde · te ve como {xor_addr(at[A_MAPPED_XOR])}")
        except Exception as e:
            bad(f"[{proto}] STUN sin respuesta ({e})"); ch.close(); rc = 1; continue

        # 2) Allocate sin credenciales -> 401 + realm/nonce
        try:
            m, at = parse(ch.rt(build(M_ALLOCATE, os.urandom(12), attr(A_REQ_TRANSPORT, b"\x11\x00\x00\x00"))))
        except Exception as e:
            bad(f"[{proto}] Allocate sin respuesta ({e}) — ¿coturn sin lt-cred-mech?"); ch.close(); rc = 1; continue
        code = err_code(at)
        if code != 401 or A_REALM not in at:
            bad(f"[{proto}] esperaba 401+realm y llego {hex(m)} (error {code})"); ch.close(); rc = 1; continue
        realm = at[A_REALM].decode(errors="ignore")
        ok(f"[{proto}] Allocate -> 401 (esperado) · realm='{realm}'")

        # 3) Allocate firmado -> 200 + relay
        key = hashlib.md5(f"{a.user}:{realm}:{a.pwd}".encode()).digest()
        attrs = (attr(A_REQ_TRANSPORT, b"\x11\x00\x00\x00") + attr(A_USERNAME, a.user.encode())
                 + attr(A_REALM, at[A_REALM]) + attr(A_NONCE, at[A_NONCE]))
        try:
            m, at2 = parse(ch.rt(build(M_ALLOCATE, os.urandom(12), attrs, key)))
        except Exception as e:
            bad(f"[{proto}] Allocate firmado sin respuesta ({e})"); ch.close(); rc = 1; continue
        if m == 0x0103 and A_XOR_RELAYED in at2:
            ok(f"[{proto}] ALLOCATE 200 · relay = {xor_addr(at2[A_XOR_RELAYED])}  ->  TURN OK (alcanzable + autenticado)")
        else:
            code = err_code(at2)
            if code in (401, 403):
                bad(f"[{proto}] credenciales RECHAZADAS ({code}) — TURN_USER/TURN_PASS no coinciden con turnserver.conf")
            else:
                bad(f"[{proto}] Allocate fallo: {hex(m)} error={code}")
            rc = 1
        ch.close()

    print()
    if rc == 0:
        ok("Veredicto: el TURN entrega candidatos relay. WebRTC va a funcionar detras de NAT simetrico.")
    else:
        bad("Veredicto: los clientes NO van a obtener candidato relay. Ver docs/FIREWALL.md")
    return rc

if __name__ == "__main__":
    sys.exit(main())
