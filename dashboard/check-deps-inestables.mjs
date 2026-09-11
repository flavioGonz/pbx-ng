#!/usr/bin/env node
/* Busca el error #185 antes de que llegue al navegador.
 *
 * El síntoma es siempre el mismo: `const x = Array.isArray(d) ? d : []` (o `d || {}`)
 * devuelve un objeto NUEVO en cada render; si esa variable es dependencia de un
 * useMemo/useEffect que termina llamando a un setState, la cadena se realimenta y React
 * corta con «Maximum update depth exceeded» (#185). Pasó en SbcFlow.jsx y volvió a pasar
 * en troncales/page.jsx: por eso es una verificación y no un comentario.
 *
 * Conservador a propósito: sólo marca variables con fallback literal `[]`/`{}` que NO
 * estén envueltas en useMemo/useState/useRef y que aparezcan en un arreglo de
 * dependencias. Si algo queda mal marcado, envolverlo en useMemo es la respuesta correcta.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = 'app';
const archivos = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(p)) archivos.push(p);
  }
})(RAIZ);

const FALLBACK = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?!use(Memo|State|Ref|Callback)\b).*(\?\s*[^;]*:\s*(\[\]|\{\})|\|\|\s*(\[\]|\{\}))\s*;/;
const hallazgos = [];

for (const f of archivos) {
  const src = readFileSync(f, 'utf8');
  const lineas = src.split('\n');
  const sospechosas = new Map();               // nombre -> nº de línea
  lineas.forEach((l, i) => {
    const m = FALLBACK.exec(l);
    if (m) sospechosas.set(m[1], i + 1);
  });
  if (!sospechosas.size) continue;
  // Dependencias: todo lo que va entre `}, [` y `])`, que es como cierran los hooks.
  for (const dep of src.matchAll(/\}\s*,\s*\[([^\]]*)\]\s*\)/g)) {
    const nombres = dep[1].split(',').map((x) => x.trim().split(/[.?[\s]/)[0]).filter(Boolean);
    const linea = src.slice(0, dep.index).split('\n').length;
    for (const n of nombres) {
      if (sospechosas.has(n)) {
        hallazgos.push({ f, decl: sospechosas.get(n), uso: linea, n });
      }
    }
  }
}

if (!hallazgos.length) {
  console.log('OK: ninguna dependencia de hook apunta a un objeto recreado en cada render');
  process.exit(0);
}
console.error('Dependencias inestables (riesgo de React #185):\n');
for (const h of hallazgos) {
  console.error(`  ${h.f}:${h.decl}  «${h.n}» se recrea en cada render y se usa como dependencia en la línea ${h.uso}`);
}
console.error('\nArreglo: envolver la declaración en useMemo(() => ..., [origen]).');
process.exit(1);
