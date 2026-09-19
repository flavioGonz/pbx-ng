/* Invariante de las IMAGENES, no de la API: la medicion del nodo (RAM, CPU, uptime) vive en
 * UN solo archivo y los tres agentes la importan de ahi.
 *
 * Que se rompio, medido en una central real: los tres agentes (asterisk :8092, coturn :8091
 * y voz :8080) contestaban mem_total_mb 35948, ncpu 12 y uptime_s 3130369 — IDENTICOS hasta
 * el segundo — mientras el CT del nucleo tenia 8192 MB y el del borde 2048 MB. Esos numeros
 * eran los del hipervisor: adentro de un contenedor /proc/meminfo, /proc/uptime y
 * os.cpu_count() son del kernel de abajo. El panel dibujaba la misma maquina fisica cuatro
 * veces con cuatro nombres distintos, y por eso una tarjeta «TURN · EN LINEA» resultaba
 * creible justo cuando el TURN no servia.
 *
 * Por que una prueba y no solo el arreglo: la funcion estaba copiada cuatro veces (dos de
 * ellas en el MISMO archivo del agente de coturn, y ya diferian entre si). Una copia no
 * avisa cuando se queda vieja; esta prueba si. Es estatica —lee archivos de texto del
 * repo—, no necesita Docker ni Python, y corre con `npm test` desde control-plane/. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');

const COMPARTIDO = 'docker/images/common/pbxng_nodo.py';

/* Los tres agentes: archivo del agente + Dockerfile de su imagen + como referencia el
 * Dockerfile al modulo compartido (la ruta cambia con el contexto de build). */
const AGENTES = [
  { nombre: 'asterisk', agente: 'docker/images/asterisk/pbxng-ast-agent.py',
    dockerfile: 'docker/images/asterisk/Dockerfile', copia: 'images/common/pbxng_nodo.py' },
  { nombre: 'coturn', agente: 'docker/images/coturn/pbxng-turn-agent.py',
    dockerfile: 'docker/images/coturn/Dockerfile', copia: 'images/common/pbxng_nodo.py' },
  { nombre: 'voz', agente: 'voice-service/server.py',
    dockerfile: 'docker/images/voz/Dockerfile', copia: 'docker/images/common/pbxng_nodo.py' },
];

test('la medicion del nodo existe una sola vez y expone metricas_nodo()', () => {
  const m = leer(COMPARTIDO);
  assert.match(m, /^def metricas_nodo\(/m, `${COMPARTIDO} dejo de exponer metricas_nodo()`);
  /* Las tres fuentes que hacen la diferencia entre medir el nodo y medir el hipervisor.
   * Si alguien "simplifica" el modulo sacandolas, volvemos al numero del hipervisor sin
   * que nada falle en el arranque. */
  for (const fuente of ['memory.max', 'memory.current', 'memory.limit_in_bytes',
    'memory.usage_in_bytes', 'inactive_file', 'cpu.max', '/proc/1/stat']) {
    assert.ok(m.includes(fuente),
      `${COMPARTIDO} dejo de leer ${fuente}: sin eso la metrica vuelve a ser la de la maquina de abajo`);
  }
  assert.ok(/origen/.test(m),
    `${COMPARTIDO} dejo de informar el origen de cada valor (cgroup o /proc): sin eso, la proxima ` +
    'vez que un numero no cierre hay que entrar al contenedor para saber quien contesto');
});

test('ningun agente vuelve a medir la maquina por su cuenta', () => {
  /* Lista de lo que NO puede aparecer en un agente. No es estetica: cada una de estas
   * lecturas, adentro de un contenedor, devuelve el hipervisor. */
  const PROHIBIDO = [
    ['/proc/meminfo', 'la RAM del host, no la del nodo (el tope real es el del cgroup)'],
    ['/proc/uptime', 'el uptime del host, no la edad del nodo (va contra el arranque de PID 1)'],
    ['os.cpu_count(', 'los vCPU del host, no la cuota del nodo (va cpu.max)'],
  ];
  for (const a of AGENTES) {
    const txt = leer(a.agente);
    /* Se miran solo las lineas de codigo: los comentarios NOMBRAN estas rutas justamente
     * para explicar por que no se usan, y eso tiene que seguir siendo legal. */
    const codigo = txt.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
      .replace(/"""[\s\S]*?"""/g, '');
    for (const [pat, porque] of PROHIBIDO) {
      assert.ok(!codigo.includes(pat),
        `${a.agente} volvio a leer ${pat}: eso devuelve ${porque}. La medicion va en ${COMPARTIDO}.`);
    }
    assert.match(txt, /from pbxng_nodo import metricas_nodo/,
      `${a.agente} no importa metricas_nodo de ${COMPARTIDO}`);
  }
});

test('las tres imagenes copian el modulo compartido y verifican que se pueda importar', () => {
  for (const a of AGENTES) {
    const df = leer(a.dockerfile);
    assert.ok(df.includes('COPY ' + a.copia + ' /usr/local/lib/pbxng/pbxng_nodo.py'),
      `${a.dockerfile} no copia ${a.copia} a /usr/local/lib/pbxng/: el agente no va a poder importarlo`);
    assert.ok(/import pbxng_nodo/.test(df),
      `${a.dockerfile} perdio el gate de build (python3 -c "… import pbxng_nodo …"): si el modulo ` +
      'falta, se enteraria el agente en produccion en vez del build.');
  }
});

/* La imagen de voz es la unica que construye con contexto en la raiz del repo, y es asi
 * PARA no tener que duplicar el modulo. Si alguien vuelve el contexto a voice-service/, el
 * COPY del compartido falla... pero podria "arreglarse" copiando el archivo al lado, que es
 * exactamente el error que esto previene. */
test('el contexto de build de voz alcanza al modulo compartido', () => {
  const compose = leer('docker/docker-compose.yml');
  const voz = compose.slice(compose.indexOf('\n  voz:'));
  const bloque = voz.slice(0, voz.indexOf('\n  ', voz.indexOf('image:')));
  assert.match(bloque, /context:\s*\.\.\s*$/m,
    'el contexto de build de voz dejo de ser la raiz del repo: desde voice-service/ no se ve ' +
    'docker/images/common/pbxng_nodo.py y la unica salida seria duplicarlo');
  assert.match(bloque, /dockerfile:\s*docker\/images\/voz\/Dockerfile/,
    'la ruta del Dockerfile de voz tiene que ser relativa a la raiz, como su contexto');

  /* Con contexto en la raiz, lo que entra lo decide el .dockerignore. Es lista blanca: si
   * se cae una de las dos re-inclusiones, el COPY no encuentra el archivo. */
  const ign = leer('.dockerignore');
  assert.ok(/^\*$/m.test(ign), '.dockerignore dejo de ser lista blanca (falta el `*` inicial)');
  for (const re of [/^!voice-service$/m, /^!docker$/m, /^!docker\/images$/m, /^!docker\/images\/common$/m]) {
    assert.match(ign, re, `.dockerignore perdio una re-inclusion (${re}) y el contexto de voz queda incompleto`);
  }
});

/* El agente de coturn ya vivio esto: habia una copia en infra/turn/ —fuera del contexto de
 * build, o sea que no era la que se desplegaba— que quedo atras y seguia reportando el TURN
 * como «active» con solo poder ejecutar el binario. Se borro. Esta prueba es para que no
 * vuelva a aparecer en ningun lado del arbol. */
test('cada agente existe una sola vez en el repo', () => {
  const IGNORAR = new Set(['node_modules', '.next', '.git', 'dist', '__pycache__', 'out']);
  const hallados = new Map();
  const BUSCADOS = ['pbxng-ast-agent.py', 'pbxng-turn-agent.py', 'pbxng_nodo.py'];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORAR.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (BUSCADOS.includes(e.name)) {
        const rel = path.relative(RAIZ, p);
        hallados.set(e.name, (hallados.get(e.name) || []).concat(rel));
      }
    }
  })(RAIZ);
  for (const nombre of BUSCADOS) {
    const l = hallados.get(nombre) || [];
    assert.equal(l.length, 1,
      `${nombre} aparece ${l.length} veces (${l.join(', ')}): dos copias del mismo archivo son una ` +
      'que se va a quedar vieja sin que nadie lo note. Dejá una sola y que las imagenes la copien.');
  }
});

/* ---------------------------------------------------------------------------
 * Y la CUARTA implementación: la de la API (`cgroup.js`), que es la del nodo `core`.
 *
 * Acá la copia es inevitable —los agentes son python sin pip y la API es node—, así que
 * el guardián no puede ser «no duplicar». Es esto: las dos implementaciones corren sobre
 * el MISMO árbol de cgroup falso y tienen que dar el MISMO número. Una prueba textual
 * («que el agente no diga /proc/meminfo») no habría agarrado el caso real, que fue
 * aritmética distinta en cada copia.
 * ------------------------------------------------------------------------- */
const os = require('os');
const { execFileSync } = require('child_process');

function arbol(files) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
  for (const [rel, txt] of Object.entries(files)) {
    const p = path.join(raiz, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, txt);
  }
  return raiz;
}

/* Los dos escenarios que importan, uno por versión de cgroup, con el caché de página
 * incluido a propósito: es el que hace que un nodo sano aparezca al 90 %. */
const CASOS = {
  'cgroup v2 · tope de 2 GiB con 1 GiB de caché': {
    'memory.max': String(2 * 1024 ** 3),
    'memory.current': String(1536 * 1024 ** 2),
    'memory.stat': 'anon 1\ninactive_file ' + 1024 * 1024 ** 2 + '\n',
    'cpu.max': '200000 100000',
    'cpuset.cpus.effective': '0-3',
  },
  'cgroup v1 · tope de 4 GiB con 1 GiB de caché': {
    'memory/memory.limit_in_bytes': String(4 * 1024 ** 3),
    'memory/memory.usage_in_bytes': String(2 * 1024 ** 3),
    'memory/memory.stat': 'total_inactive_file ' + 1024 * 1024 ** 3 + '\n',
    'cpu/cpu.cfs_quota_us': '150000',
    'cpu/cpu.cfs_period_us': '100000',
  },
};

test('metricas del nodo: node y python dan el MISMO numero sobre el mismo cgroup', (t) => {
  let python = 'python3';
  try { execFileSync(python, ['-c', 'pass']); } catch (_) { t.skip('sin python3 en este entorno'); return; }

  for (const [nombre, files] of Object.entries(CASOS)) {
    const raiz = arbol(files);
    // node: se recarga el módulo con la raíz apuntando al árbol falso.
    const antes = process.env.PBXNG_CGROUP_ROOT;
    process.env.PBXNG_CGROUP_ROOT = raiz;
    delete require.cache[require.resolve('../cgroup')];
    const js = require('../cgroup');
    const memJs = js.memoria(), cpuJs = js.cpus();
    if (antes === undefined) delete process.env.PBXNG_CGROUP_ROOT; else process.env.PBXNG_CGROUP_ROOT = antes;
    delete require.cache[require.resolve('../cgroup')];

    // python: el módulo compartido de las imágenes, contra el mismo árbol.
    const dirPy = path.join(RAIZ, 'docker/images/common');
    const salida = execFileSync(python, ['-c',
      'import json,sys; sys.path.insert(0,sys.argv[1]); import pbxng_nodo as n; '
      + 'm=n.memoria(); c=n.cpus(); print(json.dumps({"mem":m,"cpu":c}))', dirPy],
    { env: { ...process.env, PBXNG_CGROUP_ROOT: raiz }, encoding: 'utf8' });
    const py = JSON.parse(salida);

    assert.equal(memJs.total_mb, py.mem[0], nombre + ': memoria total');
    assert.equal(memJs.usado_mb, py.mem[1], nombre + ': memoria usada (¿alguien dejó de restar el caché?)');
    assert.equal(Math.round(memJs.pct), Math.round(py.mem[2]), nombre + ': porcentaje de memoria');
    assert.equal(memJs.origen, py.mem[3], nombre + ': las dos tienen que decir de dónde sacaron el dato');
    assert.equal(cpuJs.ncpu, py.cpu[0], nombre + ': núcleos (gana el límite más chico)');
    assert.equal(cpuJs.origen, py.cpu[1], nombre + ': origen del dato de CPU');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});
