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

REGLA DE AGREGACION (la misma que POST /api/turn/probe; docs/CONTRATOS.md §3):
con --tcp se prueban los DOS transportes y **alcanza con uno**. La pregunta es si un
softphone detras de un NAT simetrico obtiene un candidato relay, y para eso necesita
uno solo. Si un transporte anda y el otro no, sale 0 con un AVISO que dice a quien
deja afuera. Sale 1 cuando NINGUNO entrega relay: ahi si no hay audio para nadie.
"""
import argparse, hashlib, hmac, os, socket, struct, sys

MAGIC = 0x2112A442
M_BINDING, M_ALLOCATE, M_REFRESH = 0x0001, 0x0003, 0x0004
A_MAPPED_XOR, A_USERNAME, A_MI, A_ERROR, A_REALM, A_NONCE = 0x0020, 0x0006, 0x0008, 0x0009, 0x0014, 0x0015
A_XOR_RELAYED, A_REQ_TRANSPORT, A_LIFETIME = 0x0016, 0x0019, 0x000d

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
    # El `length` de la cabecera lo declara el SERVIDOR: si por lo que sea llega menos
    # de lo que promete, recorrer hasta 20+ln lee fuera del buffer y revienta con un
    # "unpack requires a buffer of 4 bytes" que no le dice nada a nadie. Se acota al
    # largo real y se devuelve lo que se pudo leer: el paso falla por lo que falta,
    # no por una excepcion de Python.
    mtype, ln = struct.unpack(">HH", d[0:4])
    fin, out, i = min(20 + ln, len(d)), {}, 20
    while i + 4 <= fin:
        t, l = struct.unpack(">HH", d[i:i + 4])
        out[t] = d[i + 4:i + 4 + l]
        i += 4 + l + ((4 - l % 4) % 4)
    return mtype, out

def xor_addr(v):
    port = struct.unpack(">H", v[2:4])[0] ^ (MAGIC >> 16)
    ip = bytes(a ^ b for a, b in zip(v[4:8], struct.pack(">I", MAGIC)))
    return f"{socket.inet_ntoa(ip)}:{port}"

def es_privada(ip):
    try: o = [int(x) for x in ip.split(".")]
    except Exception: return False
    if len(o) != 4: return False
    return (o[0] in (0, 10, 127) or (o[0] == 172 and 16 <= o[1] <= 31)
            or (o[0] == 192 and o[1] == 168) or (o[0] == 169 and o[1] == 254))

def relay_inservible(ip):
    """Un relay que ningun cliente puede usar. Que el TURN conteste y autentique NO
    alcanza: lo que se le entrega al navegador es esta direccion. Caso real medido en
    produccion: un coturn escuchando solo en 172.17.0.1 (el bridge de Docker de esa
    maquina) autenticaba perfecto y no le servia a nadie. Eso tiene que salir FALLA."""
    o = ip.split(".")
    if len(o) != 4: return "la direccion del relay no es IPv4"
    try: o = [int(x) for x in o]
    except Exception: return "la direccion del relay no es IPv4"
    if o[0] == 0:   return "el relay anuncia 0.0.0.0: falta external-ip en turnserver.conf"
    if o[0] == 127: return "el relay anuncia loopback (127.x): solo sirve dentro del propio contenedor"
    if o[0] == 169 and o[1] == 254: return "el relay anuncia link-local (169.254.x)"
    return None

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
            # TCP es un flujo, no mensajes: el servidor puede escribir la respuesta en
            # dos writes y un solo recv() devuelve la primera mitad. Con eso, el
            # Allocate firmado --que trae realm, nonce y MESSAGE-INTEGRITY, o sea el
            # mas largo y el candidato natural a llegar partido-- se parseaba truncado
            # y el script declaraba muerto un TURN sano. Hay que acumular hasta tener
            # la cabecera (20 bytes) MAS el `length` que ella declara. Es el mismo
            # acumulador que control-plane/turn.js: las dos herramientas tienen que
            # leer el cable igual para poder dar el mismo veredicto.
            self.s.sendall(msg)
            buf = b""
            while True:
                chunk = self.s.recv(4096)
                if not chunk:
                    raise ConnectionError("el TURN cerro la conexion con la respuesta incompleta "
                                          f"({len(buf)} bytes)")
                buf += chunk
                if len(buf) < 20:
                    continue
                if len(buf) >= 20 + struct.unpack(">H", buf[2:4])[0]:
                    return buf
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
    p.add_argument("--tcp", action="store_true", help="probar tambien TURN sobre TCP (alcanza con que UN transporte entregue relay)")
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

    # proto -> ¿ESE transporte entrega un candidato relay usable? El veredicto final
    # sale de agregar este diccionario con la regla de docs/CONTRATOS.md §3.
    relay_por = {}
    for tcp in ([False, True] if a.tcp else [False]):
        proto = "TCP" if tcp else "UDP"
        relay_por[proto] = False
        try:
            ch = Chan(ip, a.port, tcp)
        except Exception as e:
            bad(f"[{proto}] no conecta a {ip}:{a.port} ({e})")
            warn("      -> port-forward ausente, firewall, o NAT hairpin si probas desde la LAN")
            continue

        # 1) STUN Binding
        try:
            m, at = parse(ch.rt(build(M_BINDING, os.urandom(12))))
            ok(f"[{proto}] STUN responde · te ve como {xor_addr(at[A_MAPPED_XOR])}")
        except Exception as e:
            bad(f"[{proto}] STUN sin respuesta ({e})"); ch.close(); continue

        # 2) Allocate sin credenciales -> 401 + realm/nonce
        try:
            m, at = parse(ch.rt(build(M_ALLOCATE, os.urandom(12), attr(A_REQ_TRANSPORT, b"\x11\x00\x00\x00"))))
        except Exception as e:
            bad(f"[{proto}] Allocate sin respuesta ({e}) — ¿coturn sin lt-cred-mech?"); ch.close(); continue
        code = err_code(at)
        if code != 401 or A_REALM not in at:
            bad(f"[{proto}] esperaba 401+realm y llego {hex(m)} (error {code})"); ch.close(); continue
        realm = at[A_REALM].decode(errors="ignore")
        ok(f"[{proto}] Allocate -> 401 (esperado) · realm='{realm}'")

        # 3) Allocate firmado -> 200 + relay
        key = hashlib.md5(f"{a.user}:{realm}:{a.pwd}".encode()).digest()
        attrs = (attr(A_REQ_TRANSPORT, b"\x11\x00\x00\x00") + attr(A_USERNAME, a.user.encode())
                 + attr(A_REALM, at[A_REALM]) + attr(A_NONCE, at[A_NONCE]))
        try:
            m, at2 = parse(ch.rt(build(M_ALLOCATE, os.urandom(12), attrs, key)))
        except Exception as e:
            bad(f"[{proto}] Allocate firmado sin respuesta ({e})"); ch.close(); continue
        if m == 0x0103 and A_XOR_RELAYED in at2:
            # Devolver la asignacion (Refresh lifetime=0, RFC 8656 §7) por el MISMO canal:
            # un Allocate que sale bien deja una asignacion viva en coturn con su lifetime
            # (600 s por defecto) y puertos de relay reservados. Es mejor esfuerzo: si no
            # llega, vence sola, y por eso no cambia el veredicto.
            try:
                ch.rt(build(M_REFRESH, os.urandom(12),
                            attr(A_LIFETIME, b"\x00\x00\x00\x00") + attr(A_USERNAME, a.user.encode())
                            + attr(A_REALM, at[A_REALM]) + attr(A_NONCE, at[A_NONCE]), key))
            except Exception:
                pass
            rel = xor_addr(at2[A_XOR_RELAYED]); rel_ip = rel.split(":")[0]
            motivo = relay_inservible(rel_ip)
            # Relay privado con un TURN publicado en una IP publica: desde la LAN "anda",
            # desde afuera --que es para lo que existe el TURN-- no llega nadie.
            if not motivo and es_privada(rel_ip) and not es_privada(ip):
                motivo = (f"el relay anuncia una direccion privada ({rel_ip}) y el TURN esta publicado "
                          f"en {ip}: los clientes de afuera no la alcanzan")
            if motivo:
                bad(f"[{proto}] ALLOCATE 200 pero el relay NO SIRVE: {rel} — {motivo}")
                warn("      -> revisa external-ip= en turnserver.conf y el port-forward del rango relay")
            else:
                ok(f"[{proto}] ALLOCATE 200 · relay = {rel}  ->  TURN OK (alcanzable + autenticado)")
                relay_por[proto] = True
        else:
            code = err_code(at2)
            if code in (401, 403):
                bad(f"[{proto}] credenciales RECHAZADAS ({code}) — TURN_USER/TURN_PASS no coinciden con turnserver.conf")
            else:
                bad(f"[{proto}] Allocate fallo: {hex(m)} error={code}")
        ch.close()

    print()
    # ---- Regla de agregacion. LA MISMA que POST /api/turn/probe (control-plane/turn.js,
    # funcion `agregar`), escrita en docs/CONTRATOS.md §3. Alcanza con UN transporte.
    #
    # El porque, que es lo unico que importa: la pregunta que contesta esta herramienta
    # es "¿un softphone detras de un NAT simetrico va a tener audio?". Ese softphone
    # necesita UN candidato relay, no dos; con TURN sobre UDP andando ya lo tiene. La
    # configuracion mas comun de todas --port-forward de 3478/udp y nada mas-- estaba
    # dando exit 1 al final de CADA instalacion, con el cartel "los clientes quedaran
    # sin audio" sobre un TURN sano. Un instalador que grita cuando no pasa nada enseña
    # a ignorar las alarmas, que es peor que no tener alarma.
    # TURN sobre TCP es el plan B para la red que bloquea UDP saliente (hotel, oficina
    # con proxy): sin el, ese cliente puntual queda sin audio, pero el resto anda. O sea
    # MEJORA, no ROMPE --la regla del producto--, asi que sale como aviso y no como falla.
    utilizable = any(relay_por.values())
    if utilizable:
        ok("Veredicto: el TURN entrega candidatos relay. WebRTC va a funcionar detras de NAT simetrico.")
        caidos = [p for p, v in relay_por.items() if not v]
        for p_ in caidos:
            if p_ == "TCP":
                warn("Aviso: TURN sobre TCP no entrega relay. Los clientes en redes que bloquean")
                warn("      UDP saliente van a quedar sin audio; el resto anda. Abri 3478/tcp.")
            else:
                warn("Aviso: TURN sobre UDP no entrega relay y todo el medio va a ir por TCP,")
                warn("      con mas latencia y peor calidad. Abri 3478/udp.")
        return 0
    bad("Veredicto: los clientes NO van a obtener candidato relay. Ver docs/FIREWALL.md")
    return 1

if __name__ == "__main__":
    sys.exit(main())
