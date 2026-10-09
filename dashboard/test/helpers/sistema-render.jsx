/* Ayudas compartidas por las pruebas de las pantallas de sistema/red/seguridad.
 *
 *  - `renderUI` monta con el MantineProvider y el tema real del panel (app/theme.js): sin
 *    provider, Mantine revienta al montar casi cualquier componente.
 *  - `fakeFetch` reemplaza `fetch` por una tabla de rutas. Así la capa `app/api.js` de
 *    verdad corre entera (armado de URL, JSON, errores con `.status` en español) y la
 *    prueba puede mirar QUÉ se le mandó a la API, que es lo que importa del contrato.
 *
 *  Las rutas se escriben 'MÉTODO /ruta' sin el prefijo /backend/api ('GET /trunks'); las
 *  que no cuelgan de /api van con la URL entera ('GET /backend/health'). Se busca primero
 *  la ruta exacta con query, después sin query. El valor puede ser:
 *    · un objeto/array/string → 200 con ese JSON;
 *    · `res(status, body, headers)` → una respuesta con status a elección;
 *    · una función (req) → cualquiera de las dos anteriores (o una Promise);
 *    · `RED_CAIDA` → el fetch tira, como sin conexión.
 *  Lo que no está en la tabla contesta 404, así un pedido inesperado se nota. */
import { render, configure } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { vi } from 'vitest';
import { theme } from '../../app/theme.js';

/* Estas pantallas montan cientos de nodos de Mantine; con la cobertura prendida y otras
 * suites corriendo en paralelo, el segundo por defecto de `waitFor` queda corto y la
 * prueba falla por lenta, no por mala. */
configure({ asyncUtilTimeout: 4000 });

export function renderUI(ui, { esquema = 'dark', ...opts } = {}) {
  const Envoltura = ({ children }) => <MantineProvider theme={theme} forceColorScheme={esquema}>{children}</MantineProvider>;
  return render(ui, { wrapper: Envoltura, ...opts });
}

export const RED_CAIDA = Symbol('red-caida');

export function res(status, body, headers = {}) {
  return { __res: true, status, body, headers };
}

function aResponse(v) {
  if (v && v.__res) {
    const { status, body, headers } = v;
    if (body instanceof Blob) return new Response(body, { status, headers });
    if (typeof body === 'string') return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
    return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }
  return new Response(JSON.stringify(v === undefined ? null : v), { status: 200, headers: { 'content-type': 'application/json' } });
}

export function fakeFetch(rutas = {}) {
  const llamadas = [];
  const fn = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const corta = u.startsWith('/backend/api') ? u.slice('/backend/api'.length) : u;
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { /* queda texto */ } }
    const req = { method, url: u, path: corta, body, init };
    llamadas.push(req);
    const sinQuery = corta.split('?')[0];
    const k = [`${method} ${corta}`, `${method} ${sinQuery}`].find((x) => Object.prototype.hasOwnProperty.call(rutas, x));
    if (!k) return aResponse(res(404, { error: 'ruta no simulada: ' + method + ' ' + corta }));
    let v = rutas[k];
    if (typeof v === 'function') v = await v(req);
    if (v === RED_CAIDA) throw new TypeError('Failed to fetch');
    return aResponse(v);
  });
  fn.llamadas = llamadas;
  // Atajo para las aserciones: los pedidos a una ruta (sin query) y con método.
  fn.a = (metodo, ruta) => llamadas.filter((c) => c.method === metodo && c.path.split('?')[0] === ruta);
  vi.stubGlobal('fetch', fn);
  return fn;
}

// Deja correr las promesas pendientes (fetch simulado → setState) sin timers falsos.
export const flush = () => new Promise((r) => setTimeout(r, 0));

/* `next/dynamic` de mentira que SÍ carga el módulo (con React.lazy): así la página
 * monta el componente real y su `() => import(...)` cuenta como ejecutado. Uso:
 *   vi.mock('next/dynamic', async () => (await import('./helpers/sistema-render.jsx')).dynamicMock);
 */
import { lazy, Suspense, createElement } from 'react';
export const dynamicMock = {
  default: (loader) => {
    const L = lazy(() => Promise.resolve(loader()).then((m) => ({ default: (m && m.default) || m })));
    return function Dinamico(p) { return createElement(Suspense, { fallback: null }, createElement(L, p)); };
  },
};
