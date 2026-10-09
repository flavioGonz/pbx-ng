/* Ayudante de las pruebas de las pantallas de "aplicaciones" (IVR, colas, IA, reportes…):
 * monta con el MISMO tema y esquema que app/layout.jsx para que Mantine no se queje y lo
 * que se ve en la prueba sea lo que ve el operador. */
import { render, configure } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { theme } from '../../app/theme';

/* Con cobertura y varios archivos en paralelo, el segundo de espera por defecto de
 * `findBy`/`waitFor` alcanza justo: se estira para que las pruebas no sean frágiles. */
configure({ asyncUtilTimeout: 5000 });

export function renderNG(ui, { esquema = 'dark', ...opts } = {}) {
  return render(ui, {
    wrapper: ({ children }) => <MantineProvider theme={theme} defaultColorScheme={esquema} forceColorScheme={esquema} env="test">{children}</MantineProvider>,
    ...opts,
  });
}

/* Respuesta de `api()` diferida: la prueba decide cuándo y con qué se resuelve. */
export function diferido() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* Error con la forma que tira app/api.js (status + mensaje en español). */
export function errApi(message, status = 500) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* `fetch` falso con rutas: se usa la capa REAL de app/api.js (así se prueba lo que de verdad
 * viaja: método, ruta y cuerpo) y se contesta según una tabla.
 *   const f = fetchFalso({ 'GET /ivr': [...], 'DELETE /ivr/3': {}, 'POST /x': (cuerpo, url) => ... })
 * - la clave es "MÉTODO /ruta-sin-/backend/api" (la query string se ignora al buscar, salvo
 *   que exista una clave con la query exacta).
 * - un valor `estado(500, {error})` contesta con ese status.
 * - un valor función recibe (cuerpo, url, init) y devuelve el valor (o una promesa).
 * - `f.llamadas` guarda {metodo, ruta, cuerpo} de cada pedido. */
const ESTADO = Symbol('estado');
export const estado = (status, cuerpo = null) => ({ [ESTADO]: true, status, cuerpo });

export function fetchFalso(rutas = {}) {
  const llamadas = [];
  const f = async (url, init = {}) => {
    const metodo = (init.method || 'GET').toUpperCase();
    const u = String(url);
    const ruta = u.replace(/^.*\/backend\/api/, '');
    const sinQuery = ruta.split('?')[0];
    let cuerpo = init.body;
    try { if (typeof cuerpo === 'string') cuerpo = JSON.parse(cuerpo); } catch (_) { /* texto crudo */ }
    llamadas.push({ metodo, ruta, cuerpo, url: u });
    let v;
    if ((metodo + ' ' + ruta) in rutas) v = rutas[metodo + ' ' + ruta];
    else if ((metodo + ' ' + sinQuery) in rutas) v = rutas[metodo + ' ' + sinQuery];
    else if (u in rutas) v = rutas[u];
    else v = estado(404, { error: 'No encontrado: ' + metodo + ' ' + ruta });
    if (typeof v === 'function') v = await v(cuerpo, u, init);
    if (v instanceof Error) throw v;
    if (v instanceof Response) return v;
    if (v && v[ESTADO]) {
      return new Response(v.cuerpo === null ? null : JSON.stringify(v.cuerpo), { status: v.status, headers: { 'content-type': 'application/json' } });
    }
    if (v === undefined || v === null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.llamadas = llamadas;
  f.de = (metodo, prefijo) => llamadas.filter((l) => l.metodo === metodo && l.ruta.startsWith(prefijo));
  return f;
}
