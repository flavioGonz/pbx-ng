'use client';
/* Capa de acceso a la API del panel — el único lugar donde se arma la URL, se decide
 * el Content-Type, se parsea el JSON y se convierte un status HTTP en un Error con
 * mensaje en español. Antes había ~265 `fetch('/backend/api/...')` sueltos: cada
 * pantalla resolvía a su manera el `r.ok`, y la mayoría directamente lo ignoraba (un
 * 500 se veía como "Error: undefined" o como una tabla vacía sin explicación).
 *
 * Lo que esta capa NO hace, porque ya lo hace el parche global de `window.fetch` en
 * `app/auth.jsx`: mandar el `Authorization: Bearer`, redirigir a /login ante 401 y
 * mostrar el toast de permiso ante 403. Acá sólo se NORMALIZA el resultado (JSON o
 * Response cruda) y el error (`e.status` + `e.message` listo para un toast).
 *
 *   const d = await apiGet('/trunks');
 *   try { await apiPost('/users', form); } catch (e) { toast(e.message, 'bad'); }
 *   const { data, error, cargando, recargar } = usePoll('/metrics', 3000);
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/* El panel nunca habla directo con :3000 (CONTRATOS §2/§8): `dashboard/server.js`
 * proxya /backend a la API dejando la IP real en X-Forwarded-For. */
export const BASE = '/backend/api';

/* Mensaje por defecto cuando la API no mandó `{error}` (un 502 del proxy, un HTML de
 * error, una respuesta vacía). Si mandó `error`, ese gana: está escrito para el usuario. */
const POR_STATUS = {
  400: 'Datos inválidos',
  401: 'Sesión vencida',
  403: 'No tenés permiso para esta acción',
  404: 'No encontrado',
  409: 'Ya existe',
  429: 'Demasiados intentos',
};
export function mensajeStatus(status) {
  if (POR_STATUS[status]) return POR_STATUS[status];
  if (status >= 500) return 'Error del servidor';
  return 'No se pudo completar la operación';
}

const esCuerpoCrudo = (b) =>
  (typeof FormData !== 'undefined' && b instanceof FormData) ||
  (typeof Blob !== 'undefined' && b instanceof Blob) ||
  (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) ||
  (typeof ArrayBuffer !== 'undefined' && (b instanceof ArrayBuffer || ArrayBuffer.isView(b)));

// El body puede no ser JSON (404 del proxy, 502 con HTML): que eso no tape el status real.
async function cuerpo(r) {
  const ct = r.headers.get('content-type') || '';
  if (r.status === 204 || r.status === 205) return null;
  if (ct.includes('application/json')) { try { return await r.json(); } catch (_) { return null; } }
  try { const t = await r.text(); return t ? { error: t.slice(0, 300) } : null; } catch (_) { return null; }
}

function errorDe(status, data) {
  const msg = data && typeof data.error === 'string' && data.error.trim() ? data.error : mensajeStatus(status);
  const e = new Error(msg);
  e.status = status;
  e.data = data;
  return e;
}

/**
 * api(path, {method, body, signal, raw, headers})
 * - `path` con o sin barra inicial ('trunks' y '/trunks' son lo mismo).
 * - `body` objeto → JSON + Content-Type automático; FormData/Blob/string van tal cual.
 * - devuelve el JSON parseado (null si no hay cuerpo), o la Response con `raw: true`.
 * - si !r.ok tira un Error con `.status` y `.message` en español (`data.error` si vino).
 */
export async function api(path, opts = {}) {
  const { method = 'GET', body, signal, raw = false, headers } = opts;
  const p = String(path || '');
  const url = BASE + (p.startsWith('/') ? p : '/' + p);
  const init = { method, headers: { ...(headers || {}) } };
  if (signal) init.signal = signal;
  if (body !== undefined && body !== null) {
    if (typeof body === 'object' && !esCuerpoCrudo(body)) {
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    } else {
      init.body = body;
    }
  }

  let r;
  try {
    r = await fetch(url, init);
  } catch (e) {
    /* Un AbortController que cancela (desmontaje, búsqueda con freno) no es un error
     * para mostrar: se propaga tal cual para que quien llama lo ignore por `e.name`. */
    if (e && e.name === 'AbortError') throw e;
    const err = new Error('Sin conexión con el servidor');
    err.status = 0;
    err.causa = e;
    throw err;
  }

  if (!r.ok) throw errorDe(r.status, await cuerpo(r));
  if (raw) return r;             // audio, descargas: la maneja quien llama
  return await cuerpo(r);
}

export const apiGet = (path, opts) => api(path, { ...opts, method: 'GET' });
export const apiPost = (path, body, opts) => api(path, { ...opts, method: 'POST', body });
export const apiPut = (path, body, opts) => api(path, { ...opts, method: 'PUT', body });
export const apiDel = (path, body, opts) => api(path, { ...opts, method: 'DELETE', body });

/**
 * usePoll(path, ms, opts) → { data, error, cargando, recargar }
 * - `ms` 0 (o sin valor) = una sola carga, sin repetir.
 * - cancela el pedido en vuelo al desmontar (AbortController).
 * - **pausa mientras la pestaña está en segundo plano** y recarga al volver: hasta
 *   ahora todas las pantallas seguían pidiendo con el navegador minimizado, y una
 *   central con 10 pestañas abiertas le pegaba a la API sin que nadie mirara.
 * - opts: { enabled, inicial, ...resto } — el resto va a `api()` (headers, raw…).
 */
export function usePoll(path, ms = 0, opts = {}) {
  const { enabled = true, inicial = null, ...resto } = opts;
  const [data, setData] = useState(inicial);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(!!(enabled && path));
  const [n, setN] = useState(0);
  const recargar = useCallback(() => setN((x) => x + 1), []);
  // Por referencia: si no, un objeto literal en opts reiniciaría el poll en cada render.
  const restoRef = useRef(resto);
  restoRef.current = resto;

  useEffect(() => {
    if (!enabled || !path) { setCargando(false); return; }
    let vivo = true;
    let timer = null;
    let ctrl = null;
    const parar = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const pedir = async () => {
      ctrl = new AbortController();
      try {
        const d = await api(path, { ...restoRef.current, signal: ctrl.signal });
        if (!vivo) return;
        setData(d); setError(null);
      } catch (e) {
        if (!vivo || (e && e.name === 'AbortError')) return;
        setError(e);
      } finally {
        if (vivo) setCargando(false);
      }
    };
    const programar = () => { parar(); if (ms > 0 && vivo && !document.hidden) timer = setTimeout(ciclo, ms); };
    const ciclo = async () => { await pedir(); programar(); };
    const onVis = () => { if (document.hidden) parar(); else ciclo(); };
    ciclo();
    if (ms > 0) document.addEventListener('visibilitychange', onVis);
    return () => {
      vivo = false; parar();
      document.removeEventListener('visibilitychange', onVis);
      if (ctrl) ctrl.abort();
    };
  }, [path, ms, enabled, n]);

  return { data, error, cargando, recargar };
}

/**
 * useApi(path, deps) → { data, error, cargando, recargar }
 * Una sola carga (se repite si cambia `path` o algo de `deps`). Es `usePoll` con ms 0.
 */
export function useApi(path, deps = []) {
  const [k, setK] = useState(0);
  const recargar = useCallback(() => setK((x) => x + 1), []);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(!!path);

  useEffect(() => {
    if (!path) { setCargando(false); return; }
    let vivo = true;
    const ctrl = new AbortController();
    setCargando(true);
    api(path, { signal: ctrl.signal })
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e) => { if (vivo && !(e && e.name === 'AbortError')) setError(e); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, k, ...deps]);

  return { data, error, cargando, recargar };
}
