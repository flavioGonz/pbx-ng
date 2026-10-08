/* Ayudante compartido de las pruebas del panel (dueño: agente panel / núcleo).
 *
 * Qué resuelve: casi todas las pantallas cuelgan de tres módulos del núcleo —`app/api.js`
 * (pedidos), `app/auth.jsx` (quién mira) y `app/notify.js` (toasts)— y de Mantine. Cada
 * prueba de pantalla necesita reemplazarlos por dobles que se puedan programar ("si piden
 * GET /trunks, devolvé esto"; "si piden POST /users, fallá con 403") y después preguntar
 * QUÉ se mandó. Este archivo es ese doble, uno solo para todo el equipo, así nadie arma
 * su propio `fetch` falso con un contrato distinto al real.
 *
 * API ESTABLE (no cambiar firmas; sólo agregar):
 *
 *   // 1) en el archivo de prueba, ANTES de importar la pantalla:
 *   vi.mock('../app/api.js',    async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
 *   vi.mock('../app/auth.jsx',  async () => (await import('./helpers/nucleo-render.jsx')).authModuleMock());
 *   vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());
 *   import { apiMock, authMock, notifyMock, renderConMantine, errorApi } from './helpers/nucleo-render.jsx';
 *
 *   // 2) programar respuestas:
 *   apiMock.responder('GET /trunks', [{ id: 1 }]);           // método + ruta exacta
 *   apiMock.responder('/metrics', { cpu: 3 });                // cualquier método
 *   apiMock.responder('POST /users', ({ body }) => ({ id: 9, ...body }));  // función
 *   apiMock.responder(/^\/cdr\?/, []);                        // regex sobre la ruta
 *   apiMock.fallar('DELETE /users/3', 403, 'Sin permiso');    // rechaza con errorApi()
 *
 *   // 3) preguntar:
 *   apiMock.llamadas            // [{ method, path, body, opts }] en orden
 *   apiMock.llamadasA('POST /users')  // filtradas por la misma clave que responder()
 *   authMock.user = { role: 'supervisor' };  // lo que devuelve useAuth()/useEsAdmin()
 *   notifyMock.toast            // vi.fn: expect(notifyMock.toast).toHaveBeenCalledWith('Guardado', 'ok')
 *
 *   // 4) limpiar (en beforeEach): resetNucleo()
 *
 *   // 5) localStorage: con Node 25+ el global de Node lo tapa y queda undefined.
 *   const { local } = instalarStorage({ pbxng_jwt: 'x' });   // en beforeEach
 *
 * Rutas: se normalizan con barra inicial ('trunks' === '/trunks') igual que `api()` real.
 * Sin respuesta programada, el pedido se resuelve con `null` (la pantalla ve «vacío», no
 * explota) y queda registrado igual. `usePoll`/`useApi` hacen UNA carga por montaje y otra
 * por cada `recargar()` o cambio de `path`; no programan timers (el encuestado de verdad
 * lo prueba `test/nucleo-api.test.js` contra el módulo real). */
import { vi } from 'vitest';
import { useCallback, useEffect, useState } from 'react';
import { render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { theme } from '../../app/theme.js';

const norm = (p) => { const s = String(p || ''); return s.startsWith('/') ? s : '/' + s; };

/** Error con la misma forma que tira `api()` real: `.status`, `.message`, `.data`. */
export function errorApi(status = 500, mensaje = 'Error del servidor', data) {
  const e = new Error(mensaje);
  e.status = status;
  e.data = data === undefined ? { error: mensaje } : data;
  return e;
}

function coincide(clave, method, path) {
  if (clave instanceof RegExp) return clave.test(path) || clave.test(method + ' ' + path);
  const m = /^([A-Z]+)\s+(.*)$/.exec(clave);
  if (m) return m[1] === method && norm(m[2]) === path;
  return norm(clave) === path;
}

export const apiMock = {
  llamadas: [],
  rutas: [],
  responder(clave, valor) { this.rutas.unshift({ clave, valor }); return this; },
  fallar(clave, status = 500, mensaje, data) {
    return this.responder(clave, () => { throw errorApi(status, mensaje || (status >= 500 ? 'Error del servidor' : 'No se pudo completar la operación'), data); });
  },
  llamadasA(clave) { return this.llamadas.filter((c) => coincide(clave, c.method, c.path)); },
  reset() { this.llamadas = []; this.rutas = []; },
  async resolver(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const p = norm(path);
    const llamada = { method, path: p, body: opts.body, opts };
    this.llamadas.push(llamada);
    const r = this.rutas.find((x) => coincide(x.clave, method, p));
    if (!r) return null;
    const v = typeof r.valor === 'function' ? await r.valor(llamada) : r.valor;
    if (v instanceof Error) throw v;
    return v;
  },
};

function useCarga(path, { enabled = true, inicial = null } = {}, extra = []) {
  const [data, setData] = useState(inicial);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(!!(enabled && path));
  const [n, setN] = useState(0);
  const recargar = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    if (!enabled || !path) { setCargando(false); return undefined; }
    let vivo = true;
    apiMock.resolver(path, { method: 'GET' })
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e) => { if (vivo) setError(e); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, n, ...extra]);
  return { data, error, cargando, recargar };
}

/** Fábrica para `vi.mock('…/app/api.js', …)`. Comparte estado con `apiMock`. */
export function apiModuleMock() {
  const api = vi.fn((path, opts) => apiMock.resolver(path, opts));
  return {
    BASE: '/backend/api',
    mensajeStatus: (s) => ({ 400: 'Datos inválidos', 401: 'Sesión vencida', 403: 'No tenés permiso para esta acción', 404: 'No encontrado', 409: 'Ya existe', 429: 'Demasiados intentos' }[s] || (s >= 500 ? 'Error del servidor' : 'No se pudo completar la operación')),
    api,
    apiGet: vi.fn((p, o) => apiMock.resolver(p, { ...o, method: 'GET' })),
    apiPost: vi.fn((p, b, o) => apiMock.resolver(p, { ...o, method: 'POST', body: b })),
    apiPut: vi.fn((p, b, o) => apiMock.resolver(p, { ...o, method: 'PUT', body: b })),
    apiDel: vi.fn((p, b, o) => apiMock.resolver(p, { ...o, method: 'DELETE', body: b })),
    usePoll: (path, _ms, opts) => useCarga(path, opts),
    useApi: (path, deps = []) => useCarga(path, {}, deps),
  };
}

export const authMock = {
  user: { id: 1, username: 'admin', role: 'admin' },
  setUser: vi.fn(),
  logout: vi.fn(),
  reset() { this.user = { id: 1, username: 'admin', role: 'admin' }; this.setUser = vi.fn(); this.logout = vi.fn(); },
};

/** Fábrica para `vi.mock('…/app/auth.jsx', …)`. `authMock.user` decide el rol. */
export function authModuleMock() {
  const esAdmin = (u) => !!u && u.role === 'admin';
  return {
    SUP_OK: ['/cdr', '/reportes', '/wallboard', '/monitor', '/salas'],
    AuthProvider: ({ children }) => children,
    useAuth: () => ({ user: authMock.user, setUser: authMock.setUser }),
    esAdmin,
    useEsAdmin: () => esAdmin(authMock.user),
    logout: (...a) => authMock.logout(...a),
  };
}

export const notifyMock = {
  toast: vi.fn(),
  notifyCall: vi.fn(),
  toastPromise: vi.fn((p) => p),
  dismiss: vi.fn(),
  reset() { this.toast = vi.fn(); this.notifyCall = vi.fn(); this.toastPromise = vi.fn((p) => p); this.dismiss = vi.fn(); },
};

/** Fábrica para `vi.mock('…/app/notify.js', …)`. */
export function notifyModuleMock() {
  return {
    toast: (...a) => notifyMock.toast(...a),
    notifyCall: (...a) => notifyMock.notifyCall(...a),
    toastPromise: (...a) => notifyMock.toastPromise(...a),
    dismiss: (...a) => notifyMock.dismiss(...a),
    toastFill: () => '#161d2c',
  };
}

/** Deja los tres dobles como recién creados. Llamalo en `beforeEach`. */
export function resetNucleo() { apiMock.reset(); authMock.reset(); notifyMock.reset(); }

/** Envoltorio con el MISMO tema que `app/layout.jsx` (oscuro por defecto).
 *  `env="test"` es lo que recomienda Mantine para pruebas: sin transiciones ni portales,
 *  así un menú, un modal o un cajón se ven en el DOM apenas se abren. */
export function ConMantine({ children, colorScheme = 'dark' }) {
  return <MantineProvider theme={theme} env="test" defaultColorScheme={colorScheme} forceColorScheme={colorScheme}>{children}</MantineProvider>;
}

/** `render()` de Testing Library dentro de Mantine. Devuelve lo mismo que `render`,
 *  y su `rerender` también envuelve. */
export function renderConMantine(ui, opts = {}) {
  const { colorScheme, ...resto } = opts;
  const Wrapper = ({ children }) => <ConMantine colorScheme={colorScheme}>{children}</ConMantine>;
  return render(ui, { wrapper: Wrapper, ...resto });
}

/** Espera a que se vacíe la cola de promesas (útil tras un click que dispara un pedido). */
export const flush = () => new Promise((r) => setTimeout(r, 0));


/** Un Storage en memoria con la misma interfaz que `localStorage`.
 *  Por qué existe: con Node 25+ el `localStorage` global es el de Node (webstorage), que
 *  sin `--localstorage-file` queda `undefined` y TAPA al de jsdom; cualquier pantalla que
 *  lea el token revienta con «Cannot read properties of undefined». */
export function memoriaStorage(inicial = {}) {
  let m = new Map(Object.entries(inicial).map(([k, v]) => [k, String(v)]));
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => { m = new Map(); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/** Instala `localStorage` y `sessionStorage` en memoria (con vi.stubGlobal: se deshacen
 *  con `vi.unstubAllGlobals()`). Devuelve `{ local, session }` para sembrar o mirar. */
export function instalarStorage(inicial = {}) {
  const local = memoriaStorage(inicial);
  const session = memoriaStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  return { local, session };
}
