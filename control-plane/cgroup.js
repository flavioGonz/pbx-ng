/* ============================================================================
 *  Métricas del NODO (contenedor/CT) para la API, no del hipervisor de abajo.
 *
 *  POR QUÉ EXISTE ESTE ARCHIVO
 *  ---------------------------
 *  `sysmon.js` armaba la tarjeta del núcleo con `os.totalmem()`, `os.cpus().length` y
 *  `os.uptime()`. Adentro de un contenedor esos tres son del KERNEL DEL HOST —libuv lee
 *  `/proc`, que no está namespaced—, así que el nodo `core` informaba la máquina de
 *  abajo: 35948 MB y 12 vCPU donde el CT tenía 8192 MB, y 36 días de uptime para un
 *  contenedor reiniciado esa mañana. Es EXACTAMENTE el mismo bug que se corrigió en los
 *  tres agentes python (`docker/images/common/pbxng_nodo.py`), en el cuarto nodo.
 *
 *  Y era el peor de los cuatro: el Resumen arma sus tarjetas de CPU, memoria y uptime
 *  —y la serie del gráfico— a partir de este nodo. Además, mientras los cuatro mentían
 *  igual, la red de seguridad del panel (`metricasClonadas()`, que agrupa nodos con
 *  métricas idénticas) los agarraba a todos; al arreglar los otros tres, el único que
 *  seguía mintiendo quedó con una firma única y sin nadie que lo delatara.
 *
 *  POR QUÉ UNA COPIA EN OTRO LENGUAJE
 *  ----------------------------------
 *  La regla del repo es que dos copias del mismo archivo son una que se va a quedar
 *  vieja. Acá la copia es inevitable —los agentes son python sin pip y la API es node—,
 *  así que el guardián no es «no duplicar» sino una prueba que corre LAS DOS
 *  implementaciones sobre el MISMO árbol de cgroup falso y exige el mismo número:
 *  `control-plane/test/metricas-nodo.test.js`. El día que alguien toque una sola, se
 *  pone roja.
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const os = require('os');

/* Raíz del cgroup tal como la ve el contenedor. Configurable SÓLO para poder probar
 * contra árboles de prueba; en producción no se toca. */
const CGROUP = process.env.PBXNG_CGROUP_ROOT || '/sys/fs/cgroup';

/* Por encima de esto un «límite» no es un límite: cgroup v1 escribe 0x7FFFFFFFFFFFF000
 * (~8 EiB) cuando no hay tope, y v2 escribe la palabra `max`. */
const SIN_TOPE = 2 ** 53;

const leer = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return null; } };
const entero = (p) => { const t = leer(p); if (t === null) return null; const n = parseInt(String(t).split(/\s+/)[0], 10); return Number.isFinite(n) ? n : null; };
/* Archivos tipo `clave valor` por línea (memory.stat de v1 y v2). */
function pares(p) {
  const out = {};
  for (const ln of String(leer(p) || '').split('\n')) {
    const q = ln.trim().split(/\s+/);
    if (q.length >= 2) { const n = parseInt(q[1], 10); if (Number.isFinite(n)) out[q[0]] = n; }
  }
  return out;
}
function meminfo() {
  const out = {};
  for (const ln of String(leer('/proc/meminfo') || '').split('\n')) {
    const q = ln.split(':');
    if (q.length === 2) { const n = parseInt(q[1].trim().split(/\s+/)[0], 10); if (Number.isFinite(n)) out[q[0]] = n; }
  }
  return out;
}

/**
 * Memoria del NODO: { total_mb, usado_mb, pct, origen }.
 * Orden: cgroup v2 → cgroup v1 → /proc/meminfo. El fallback a /proc NO es un bug: es el
 * caso legítimo de correr sin contenedor (instalación con systemd), donde /proc sí es la
 * máquina. Por eso el origen viaja con el valor.
 *
 * El detalle que arruina el número si se omite: `memory.current` incluye el CACHÉ DE
 * PÁGINA. Sin restarle `inactive_file`, un proceso que leyó archivos aparece al 90 % y el
 * panel pinta una alarma que no existe; ese caché el kernel lo tira antes de matar nada.
 */
function memoria() {
  const lim = leer(CGROUP + '/memory.max');
  if (lim !== null && lim !== 'max') {
    const tope = parseInt(lim, 10);
    if (Number.isFinite(tope) && tope > 0 && tope < SIN_TOPE) {
      const cur = entero(CGROUP + '/memory.current');
      if (cur !== null) {
        const usado = Math.max(0, cur - (pares(CGROUP + '/memory.stat').inactive_file || 0));
        return { total_mb: Math.round(tope / 1048576), usado_mb: Math.round(usado / 1048576),
          pct: Math.round((usado * 1000) / tope) / 10, origen: 'cgroup v2 (memory.max)' };
      }
    }
  }
  const tope1 = entero(CGROUP + '/memory/memory.limit_in_bytes');
  if (tope1 && tope1 < SIN_TOPE) {
    const cur = entero(CGROUP + '/memory/memory.usage_in_bytes');
    if (cur !== null) {
      const st = pares(CGROUP + '/memory/memory.stat');
      // v1 expone las dos: `total_*` incluye los cgroups hijos, que es lo que queremos.
      const cache = st.total_inactive_file !== undefined ? st.total_inactive_file : (st.inactive_file || 0);
      const usado = Math.max(0, cur - cache);
      return { total_mb: Math.round(tope1 / 1048576), usado_mb: Math.round(usado / 1048576),
        pct: Math.round((usado * 1000) / tope1) / 10, origen: 'cgroup v1 (memory.limit_in_bytes)' };
    }
  }
  const m = meminfo();
  const tot = m.MemTotal || 0;
  if (!tot) return { total_mb: null, usado_mb: null, pct: null, origen: 'desconocido' };
  const usado = tot - (m.MemAvailable || 0);
  return { total_mb: Math.round(tot / 1024), usado_mb: Math.round(usado / 1024),
    pct: Math.round((usado * 1000) / tot) / 10, origen: '/proc/meminfo (sin tope de cgroup)' };
}

/* Cuenta CPUs de una lista tipo "0-3,8": es como Proxmox aplica `cores` a un CT. */
function cuentaCpuset(txt) {
  if (!txt) return null;
  let n = 0;
  for (const tramo of String(txt).split(',')) {
    const t = tramo.trim();
    if (!t) continue;
    if (t.includes('-')) {
      const [a, b] = t.split('-', 2).map((x) => parseInt(x, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      n += b - a + 1;
    } else n += 1;
  }
  return n || null;
}

/**
 * CPUs del NODO: { ncpu, origen }.
 * Dos formas de limitar y las dos cuentan: la CUOTA (`cpu.max` / `cpu.cfs_quota_us`, que
 * es lo que Proxmox escribe con `cpulimit` y Docker con `--cpus`) y el CPUSET (`cores`,
 * que ata el CT a N núcleos). Si están las dos manda la más chica, que es la que el nodo
 * siente. `os.cpus().length` queda último: es el dato del hipervisor.
 */
function cpus() {
  const cands = [];
  const v2 = leer(CGROUP + '/cpu.max');
  if (v2) {
    const p = v2.split(/\s+/);
    if (p.length === 2 && p[0] !== 'max') {
      const q = parseInt(p[0], 10), per = parseInt(p[1], 10);
      if (q > 0 && per > 0) cands.push({ ncpu: Math.max(1, Math.round(q / per)), origen: 'cgroup v2 (cpu.max)' });
    }
  }
  const q1 = entero(CGROUP + '/cpu/cpu.cfs_quota_us'), per1 = entero(CGROUP + '/cpu/cpu.cfs_period_us');
  if (q1 && q1 > 0 && per1 && per1 > 0) cands.push({ ncpu: Math.max(1, Math.round(q1 / per1)), origen: 'cgroup v1 (cpu.cfs_quota_us)' });
  for (const [p, org] of [[CGROUP + '/cpuset.cpus.effective', 'cgroup v2 (cpuset)'], [CGROUP + '/cpuset/cpuset.cpus', 'cgroup v1 (cpuset)']]) {
    const n = cuentaCpuset(leer(p));
    if (n) cands.push({ ncpu: n, origen: org });
  }
  if (cands.length) { cands.sort((a, b) => a.ncpu - b.ncpu); return cands[0]; }
  return { ncpu: os.cpus().length || 1, origen: 'os.cpus() (sin cgroup)' };
}

/**
 * Uptime del NODO: { uptime_s, origen }. La edad del nodo, no la de la máquina.
 * El panel escribe «activo hace …» y quiere decir «hace cuánto que ESTE nodo está
 * levantado». `/proc/uptime` adentro de un contenedor es el del host, así que se calcula
 * contra el arranque de PID 1 (campo 22 de `/proc/1/stat`, en ticks desde el boot).
 * Si el resultado no cierra —negativo, o mayor que el propio uptime— es que `/proc/uptime`
 * YA venía del contenedor (lxcfs se lo monta encima a los CT de Proxmox) y ese valor ya es
 * el que buscamos: la incoherencia es la señal de que alguien hizo el trabajo antes.
 */
function uptime() {
  const up = parseFloat(String(leer('/proc/uptime') || '').split(/\s+/)[0]);
  if (!Number.isFinite(up)) return { uptime_s: Math.round(os.uptime()), origen: 'os.uptime() (sin /proc)' };
  const stat = leer('/proc/1/stat');
  if (stat) {
    // El `comm` de PID 1 puede traer espacios y paréntesis: se corta por el ÚLTIMO `)`.
    const cola = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ticks = parseInt(cola[19], 10);          // campo 22 del stat = índice 19 tras el comm
    const hz = 100;                                 // USER_HZ es 100 en Linux/x86
    if (Number.isFinite(ticks)) {
      const edad = up - ticks / hz;
      if (edad >= 0 && edad <= up) return { uptime_s: Math.round(edad), origen: 'PID 1 (/proc/1/stat)' };
    }
  }
  return { uptime_s: Math.round(up), origen: '/proc/uptime' };
}

/**
 * Uso de CPU del NODO, en %: { cpu_pct, origen }.
 *
 * `os.cpus()` devuelve los tiempos de los núcleos DEL HOST: adentro de un contenedor, el
 * porcentaje que sale de ahí es lo ocupado que está el hipervisor, no este nodo. Con 12
 * núcleos abajo y 2 arriba, un nodo con sus dos núcleos al tope mostraba ~17 % y parecía
 * ocioso; y al revés, el vecino de al lado compilando le pintaba la barra a éste.
 *
 * El cgroup lleva el acumulado propio: `cpu.stat` → `usage_usec` (v2) o `cpuacct.usage`
 * en nanosegundos (v1). Con dos lecturas y el reloj de pared sale el uso real, dividido
 * por los núcleos del nodo. Necesita una medición previa, así que la primera llamada
 * devuelve null —el panel ya sabe dibujar «sin dato»— en vez de inventar un 0.
 */
let _prevCpu = null;
function cpuPct(ncpu) {
  const ahora = Date.now();
  let usec = null, origen = '';
  const v2 = pares(CGROUP + '/cpu.stat').usage_usec;
  if (v2 !== undefined) { usec = v2; origen = 'cgroup v2 (cpu.stat)'; }
  else {
    const ns = entero(CGROUP + '/cpu/cpuacct.usage');
    if (ns !== null) { usec = Math.round(ns / 1000); origen = 'cgroup v1 (cpuacct.usage)'; }
  }
  if (usec === null) return { cpu_pct: null, origen: 'sin cgroup: no se mide el uso del nodo' };

  const prev = _prevCpu;
  _prevCpu = { t: ahora, usec };
  if (!prev || ahora <= prev.t) return { cpu_pct: null, origen };
  const n = ncpu || cpus().ncpu || 1;
  const pct = ((usec - prev.usec) / ((ahora - prev.t) * 1000 * n)) * 100;
  return { cpu_pct: Math.max(0, Math.min(100, Math.round(pct))), origen };
}

module.exports = { memoria, cpus, uptime, cpuPct, cuentaCpuset, CGROUP };
