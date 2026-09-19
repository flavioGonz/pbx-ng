#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Metricas del NODO (contenedor/CT), no del hipervisor de abajo.

POR QUE EXISTE ESTE ARCHIVO
---------------------------
Los tres agentes de PBX-NG (asterisk :8092, coturn :8091 y el motor de voz :8080) median
la maquina leyendo `/proc/meminfo`, `/proc/uptime` y `os.cpu_count()` directo. Adentro de un
contenedor esos tres archivos son del KERNEL DEL HOST: no estan namespaced. El resultado
medido en una central real fue que los tres agentes contestaban el MISMO numero hasta el
segundo (35948 MB, 12 vCPU, 36 dias de uptime) —los del hipervisor—, mientras el nucleo
tenia 8192 MB y el borde 2048 MB. El panel dibujaba la misma maquina fisica cuatro veces
con cuatro nombres distintos, y por eso una tarjeta «TURN · EN LINEA» resultaba creible
justo cuando el TURN no servia: si los numeros de un nodo son los de otro, ninguna tarjeta
esta diciendo nada sobre ese nodo.

Lo unico que salia bien era el disco, porque `statvfs` se mide sobre el sistema de archivos
propio y ese SI es del contenedor.

POR QUE UNA SOLA COPIA
----------------------
La funcion estaba triplicada (cuatro veces, contando que el agente de coturn tenia dos
copias en el mismo archivo). En este mismo release ya se borro una copia podrida de un
agente —`infra/turn/pbxng-turn-agent.py`, que seguia diciendo «active» con solo poder
ejecutar el binario—, asi que la regla quedo escrita: dos copias del mismo archivo son una
que se va a quedar vieja sin que nadie lo note. Este modulo es el unico lugar donde vive la
medicion; las tres imagenes lo copian a /usr/local/lib/pbxng/ y lo importan. Si alguien
vuelve a escribir /proc/meminfo en un agente, `control-plane/test/metricas-nodo.test.js`
se pone rojo.

SOLO stdlib: los agentes de asterisk y coturn corren en imagenes sin pip.
"""
import os
import time

# Raiz del cgroup tal como la ve el contenedor. Se deja configurable por variable de
# entorno unicamente para poder probar el modulo contra arboles de prueba; en produccion
# nunca se toca (nada hardcodeado de una instalacion, pero tampoco magia).
CGROUP = os.environ.get("PBXNG_CGROUP_ROOT", "/sys/fs/cgroup")

# Por encima de esto un "limite" de cgroup no es un limite: cgroup v1 escribe
# 0x7FFFFFFFFFFFF000 (~8 EiB) cuando no hay tope, y v2 escribe la palabra "max".
_SIN_TOPE = 1 << 53


def _leer(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return None


def _entero(path):
    txt = _leer(path)
    if txt is None:
        return None
    try:
        return int(txt.split()[0])
    except Exception:
        return None


def _pares(path):
    """Archivos tipo `clave valor` por linea (memory.stat de cgroup v1 y v2)."""
    d = {}
    txt = _leer(path)
    for ln in (txt or "").splitlines():
        p = ln.split()
        if len(p) >= 2:
            try:
                d[p[0]] = int(p[1])
            except Exception:
                pass
    return d


def _meminfo():
    d = {}
    try:
        with open("/proc/meminfo") as f:
            for ln in f:
                p = ln.split(":")
                if len(p) == 2:
                    try:
                        d[p[0]] = int(p[1].strip().split()[0])   # kB
                    except Exception:
                        pass
    except Exception:
        pass
    return d


# ---------------------------------------------------------------------------
# Memoria
# ---------------------------------------------------------------------------
def memoria():
    """(total_mb, usado_mb, pct, origen) del NODO.

    Orden: cgroup v2 -> cgroup v1 -> /proc/meminfo. El fallback a /proc no es un bug, es
    el caso legitimo de correr sin contenedor (instalacion con systemd): ahi /proc SI es
    la maquina. Por eso el origen viaja con el valor.

    El detalle que arruina el numero si se omite: `memory.current` incluye el CACHE DE
    PAGINA (todo lo que el nodo leyo de disco alguna vez). Sin restarle `inactive_file` un
    Asterisk recien arrancado que leyo sus sonidos aparece al 90% de RAM y el panel pinta
    una alarma que no existe. `inactive_file` es cache reclamable: el kernel lo tira antes
    de matar nada, asi que no es memoria usada.
    """
    # --- cgroup v2 ---
    lim = _leer(CGROUP + "/memory.max")
    if lim is not None:
        tope = None
        if lim != "max":
            try:
                tope = int(lim)
            except Exception:
                tope = None
        if tope and tope < _SIN_TOPE:
            cur = _entero(CGROUP + "/memory.current")
            if cur is not None:
                cache = _pares(CGROUP + "/memory.stat").get("inactive_file", 0)
                usado = max(0, cur - cache)
                return (round(tope / 1048576.0), round(usado / 1048576.0),
                        round(usado * 100.0 / tope, 1), "cgroup v2 (memory.max)")

    # --- cgroup v1 ---
    tope = _entero(CGROUP + "/memory/memory.limit_in_bytes")
    if tope and tope < _SIN_TOPE:
        cur = _entero(CGROUP + "/memory/memory.usage_in_bytes")
        if cur is not None:
            st = _pares(CGROUP + "/memory/memory.stat")
            # v1 expone las dos: total_* incluye los cgroups hijos, que es lo que queremos.
            cache = st.get("total_inactive_file", st.get("inactive_file", 0))
            usado = max(0, cur - cache)
            return (round(tope / 1048576.0), round(usado / 1048576.0),
                    round(usado * 100.0 / tope, 1), "cgroup v1 (memory.limit_in_bytes)")

    # --- sin cgroup o sin tope: la maquina de abajo ---
    mem = _meminfo()
    tot = mem.get("MemTotal", 0)
    disp = mem.get("MemAvailable", 0)
    if not tot:
        return (None, None, None, "desconocido")
    usado = tot - disp
    return (round(tot / 1024.0), round(usado / 1024.0),
            round(usado * 100.0 / tot, 1), "/proc/meminfo (sin tope de cgroup)")


# ---------------------------------------------------------------------------
# CPU
# ---------------------------------------------------------------------------
def _cpuset(txt):
    """Cuenta CPUs de una lista tipo "0-3,8": es como Proxmox aplica `cores` a un CT."""
    if not txt:
        return None
    n = 0
    for tramo in txt.split(","):
        tramo = tramo.strip()
        if not tramo:
            continue
        if "-" in tramo:
            try:
                a, b = tramo.split("-", 1)
                n += int(b) - int(a) + 1
            except Exception:
                return None
        else:
            n += 1
    return n or None


def cpus():
    """(ncpu, origen) del NODO.

    Dos formas distintas de limitar y las dos cuentan: la CUOTA (`cpu.max` /
    `cpu.cfs_quota_us`, que es lo que Proxmox escribe con `cpulimit` y Docker con
    `--cpus`) y el CPUSET (`cores`, que ata el CT a N nucleos). Si estan las dos, manda
    la mas chica, que es la que el nodo va a sentir. `os.cpu_count()` queda ultimo: es el
    dato del hipervisor y devolvia 12 en un CT de 2.
    """
    cands = []

    # cuota v2: "<cuota> <periodo>" o "max <periodo>"
    v2 = _leer(CGROUP + "/cpu.max")
    if v2:
        p = v2.split()
        if len(p) == 2 and p[0] != "max":
            try:
                q, per = int(p[0]), int(p[1])
                if q > 0 and per > 0:
                    cands.append((max(1, int(round(q / float(per)))), "cgroup v2 (cpu.max)"))
            except Exception:
                pass

    # cuota v1
    q = _entero(CGROUP + "/cpu/cpu.cfs_quota_us")
    per = _entero(CGROUP + "/cpu/cpu.cfs_period_us")
    if q and q > 0 and per and per > 0:
        cands.append((max(1, int(round(q / float(per)))), "cgroup v1 (cpu.cfs_quota_us)"))

    # cpuset (v2 y v1)
    for path, org in ((CGROUP + "/cpuset.cpus.effective", "cgroup v2 (cpuset)"),
                      (CGROUP + "/cpuset/cpuset.cpus", "cgroup v1 (cpuset)")):
        n = _cpuset(_leer(path))
        if n:
            cands.append((n, org))

    if cands:
        cands.sort(key=lambda c: c[0])
        return cands[0]
    return (os.cpu_count() or 1, "os.cpu_count() (sin cgroup)")


# ---------------------------------------------------------------------------
# Uptime
# ---------------------------------------------------------------------------
def uptime():
    """(segundos, origen): la edad del NODO, no la de la maquina.

    El panel escribe «activo hace …» abajo de cada tarjeta, y lo que quiere decir es
    «hace cuanto que este nodo esta levantado». `/proc/uptime` adentro de un contenedor es
    el uptime del host (36 dias en la central medida, para un contenedor reiniciado esa
    manana), asi que se calcula contra el arranque de PID 1: campo 22 de `/proc/1/stat`
    (`starttime`, en ticks desde el boot del host) restado al uptime del host.

    Si el resultado no cierra —negativo o mayor que el propio uptime— es que /proc/uptime
    ya venia del contenedor (lxcfs se lo monta encima a los CT de Proxmox) y entonces ese
    valor YA es el que buscamos: se devuelve tal cual. La incoherencia es justamente la
    senal de que alguien ya hizo el trabajo.
    """
    up = None
    try:
        up = float((_leer("/proc/uptime") or "").split()[0])
    except Exception:
        up = None

    try:
        stat = _leer("/proc/1/stat") or ""
        # El comm de PID 1 va entre parentesis y puede traer espacios: se corta por el
        # ultimo ')' antes de partir por espacios, o los campos se corren.
        cola = stat[stat.rindex(")") + 1:].split()
        starttime = int(cola[19])                      # campo 22 global = indice 19 acá
        hz = os.sysconf("SC_CLK_TCK") or 100
        if up is not None:
            edad = up - starttime / float(hz)
            if 0 <= edad <= up:
                return (int(edad), "PID 1 (/proc/1/stat)")
    except Exception:
        pass

    # Segunda opcion: la fecha de creacion de /proc/1. Sirve cuando /proc/1/stat no se
    # puede leer (hardening) pero el directorio si.
    try:
        edad = time.time() - os.stat("/proc/1").st_mtime
        if 0 <= edad and (up is None or edad <= up):
            return (int(edad), "PID 1 (/proc/1)")
    except Exception:
        pass

    if up is not None:
        return (int(up), "/proc/uptime")
    return (None, "desconocido")


# ---------------------------------------------------------------------------
# Disco y carga
# ---------------------------------------------------------------------------
def disco(punto="/"):
    """Este SI era correcto desde el principio: statvfs mide el sistema de archivos del
    contenedor, no el del host. Se deja acá para que los tres agentes informen lo mismo."""
    try:
        st = os.statvfs(punto)
        tot = st.f_blocks * st.f_frsize
        libre = st.f_bavail * st.f_frsize
        return (tot, tot - libre, libre,
                round((tot - libre) * 100.0 / tot, 1) if tot else 0, "statvfs(%s)" % punto)
    except Exception:
        return (None, None, None, None, "desconocido")


def carga():
    """loadavg no tiene equivalente por cgroup: es del kernel, o sea del host. Se informa
    igual porque sirve para ver presion general, pero el `cpu_pct` se normaliza con el
    ncpu del NODO —no con el del hipervisor—, que es lo que hace que el porcentaje deje de
    ser un adorno: 4 de carga sobre 2 vCPU es 100%, no 33%."""
    try:
        return float((_leer("/proc/loadavg") or "").split()[0])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# API publica
# ---------------------------------------------------------------------------
def metricas_nodo(punto_disco="/", con_disco=True):
    """Dict listo para el JSON del agente. Mantiene EXACTAMENTE las claves que ya
    consumen `control-plane/sysmon.js` y el panel (`mem_total_mb`, `mem_used_mb`,
    `mem_pct`, `ncpu`, `load`, `cpu_pct`, `uptime_s`, `disk_*`) y agrega `origen`, que
    dice de donde salio cada numero (cgroup o /proc). Eso ultimo no es decoracion: la
    proxima vez que un valor no cierre, se ve en un solo vistazo cual de los dos contesto
    sin tener que entrar al contenedor.
    """
    m = {}
    origen = {}

    tot, usado, pct, org = memoria()
    if tot is not None:
        m["mem_total_mb"] = tot
        m["mem_used_mb"] = usado
        m["mem_pct"] = pct
    origen["mem"] = org

    n, org = cpus()
    m["ncpu"] = n
    origen["cpu"] = org

    ld = carga()
    if ld is not None:
        m["load"] = ld
        m["cpu_pct"] = round(min(100.0, ld * 100.0 / max(1, n)), 1)
    origen["load"] = "/proc/loadavg (del host: no hay loadavg por cgroup)"

    up, org = uptime()
    if up is not None:
        m["uptime_s"] = up
    origen["uptime"] = org

    if con_disco:
        dtot, dusado, dlibre, dpct, org = disco(punto_disco)
        if dtot is not None:
            m["disk_total"] = dtot
            m["disk_used"] = dusado
            m["disk_free"] = dlibre
            m["disk_pct"] = dpct
        origen["disk"] = org

    m["origen"] = origen
    return m


if __name__ == "__main__":
    import json
    print(json.dumps(metricas_nodo(), indent=2, sort_keys=True))
