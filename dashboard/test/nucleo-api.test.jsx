/* La capa de acceso a la API (`app/api.js`). Es la única puerta de las 46 pantallas
 * hacia el backend, así que lo que se fija acá lo hereda todo el panel: la URL que se
 * arma, el JSON que se manda, y sobre todo el ERROR que llega a la pantalla — con
 * `.status` y un mensaje en español listo para un toast, nunca «Error: undefined» ni una
 * tabla vacía sin explicación. También el encuestado (`usePoll`): que pare con la pestaña
 * oculta es lo que evita que diez pestañas abiertas le peguen a la central sin nadie
 * mirando. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { api, apiGet, apiPost, apiPut, apiDel, mensajeStatus, usePoll, useApi, BASE } from '../app/api.js';

const json = (status, data, extra = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (extra.ct ?? 'application/json') : null) },
  json: extra.json || (async () => data),
  text: extra.text || (async () => (typeof data === 'string' ? data : JSON.stringify(data))),
});

let fetchMock;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('api(): cómo se arma el pedido', () => {
  it('antepone /backend/api y acepta la ruta con o sin barra', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: 1 }));
    expect(BASE).toBe('/backend/api');
    expect(await api('trunks')).toEqual({ ok: 1 });
    await api('/trunks');
    await api();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/backend/api/trunks', '/backend/api/trunks', '/backend/api/']);
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'GET', headers: {} });
  });

  it('un objeto viaja como JSON con Content-Type, salvo que quien llama ponga el suyo', async () => {
    fetchMock.mockResolvedValue(json(200, null));
    await apiPost('/users', { a: 1 });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
    await apiPut('/users/1', { a: 2 }, { headers: { 'Content-Type': 'application/merge-patch+json' } });
    expect(fetchMock.mock.calls[1][1].headers['Content-Type']).toBe('application/merge-patch+json');
  });

  it('FormData, Blob, URLSearchParams, binarios y strings van tal cual', async () => {
    fetchMock.mockResolvedValue(json(200, null));
    const fd = new FormData(); const blob = new Blob(['x']); const qs = new URLSearchParams('a=1');
    const buf = new ArrayBuffer(2); const u8 = new Uint8Array(2);
    for (const b of [fd, blob, qs, buf, u8, 'texto']) await api('/x', { method: 'POST', body: b });
    fetchMock.mock.calls.forEach((c, i) => {
      expect(c[1].body).toBe([fd, blob, qs, buf, u8, 'texto'][i]);
      expect(c[1].headers['Content-Type']).toBeUndefined();
    });
  });

  it('null/undefined no mandan body; DELETE puede llevarlo; signal se pasa', async () => {
    fetchMock.mockResolvedValue(json(200, null));
    const ctrl = new AbortController();
    await apiGet('/a', { signal: ctrl.signal });
    await apiDel('/b', null);
    await apiDel('/c', { ids: [1] });
    expect(fetchMock.mock.calls[0][1].signal).toBe(ctrl.signal);
    expect('body' in fetchMock.mock.calls[1][1]).toBe(false);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'DELETE', body: '{"ids":[1]}' });
  });
});

describe('api(): qué devuelve', () => {
  it('204 y 205 son null aunque digan JSON', async () => {
    fetchMock.mockResolvedValueOnce(json(204, { x: 1 })).mockResolvedValueOnce(json(205, { x: 1 }));
    expect(await api('/a')).toBeNull();
    expect(await api('/a')).toBeNull();
  });
  it('JSON roto es null en vez de reventar', async () => {
    fetchMock.mockResolvedValue(json(200, null, { json: async () => { throw new SyntaxError('x'); } }));
    expect(await api('/a')).toBeNull();
  });
  it('texto plano llega envuelto como {error} (recortado a 300) y vacío es null', async () => {
    fetchMock.mockResolvedValueOnce(json(200, 'x'.repeat(400), { ct: 'text/plain' }));
    expect((await api('/a')).error).toHaveLength(300);
    fetchMock.mockResolvedValueOnce(json(200, '', { ct: '' }));
    expect(await api('/a')).toBeNull();
    fetchMock.mockResolvedValueOnce(json(200, '', { ct: 'text/plain', text: async () => { throw new Error('x'); } }));
    expect(await api('/a')).toBeNull();
  });
  it('raw: true devuelve la Response para bajar audios y descargas con el token', async () => {
    const r = json(200, null, { ct: 'audio/wav' });
    fetchMock.mockResolvedValue(r);
    expect(await api('/rec/1', { raw: true })).toBe(r);
  });
});

describe('api(): errores', () => {
  it('usa el `error` de la API cuando viene, y conserva status y data', async () => {
    fetchMock.mockResolvedValue(json(409, { error: 'La extensión 101 ya existe' }));
    const e = await api('/x').catch((x) => x);
    expect(e.message).toBe('La extensión 101 ya existe');
    expect(e.status).toBe(409);
    expect(e.data).toEqual({ error: 'La extensión 101 ya existe' });
  });
  it('sin `error` usable, cae al mensaje por status', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: '   ' }));
    expect((await api('/x').catch((x) => x)).message).toBe('No tenés permiso para esta acción');
    fetchMock.mockResolvedValueOnce(json(502, null, { ct: 'text/html', text: async () => '' }));
    const e = await api('/x').catch((x) => x);
    expect([e.message, e.status]).toEqual(['Error del servidor', 502]);
  });
  it('mensajeStatus cubre los conocidos, los 5xx y el resto', () => {
    expect([400, 401, 404, 409, 429].map(mensajeStatus)).toEqual(['Datos inválidos', 'Sesión vencida', 'No encontrado', 'Ya existe', 'Demasiados intentos']);
    expect(mensajeStatus(503)).toBe('Error del servidor');
    expect(mensajeStatus(418)).toBe('No se pudo completar la operación');
  });
  it('red caída: status 0 y «Sin conexión con el servidor», con la causa adentro', async () => {
    const causa = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(causa);
    const e = await api('/x').catch((x) => x);
    expect([e.message, e.status, e.causa]).toEqual(['Sin conexión con el servidor', 0, causa]);
  });
  it('un AbortError se propaga tal cual (no es un error para mostrar)', async () => {
    const ab = Object.assign(new Error('abort'), { name: 'AbortError' });
    fetchMock.mockRejectedValue(ab);
    await expect(api('/x')).rejects.toBe(ab);
    fetchMock.mockRejectedValue(null);
    expect((await api('/x').catch((x) => x)).status).toBe(0);
  });
});

describe('usePoll', () => {
  const ocultar = (v) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
  afterEach(() => ocultar(false));

  it('carga una vez sin intervalo y expone data/cargando', async () => {
    fetchMock.mockResolvedValue(json(200, [1, 2]));
    const { result } = renderHook(() => usePoll('/lista'));
    expect(result.current.cargando).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual([1, 2]));
    expect(result.current.cargando).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sin path o deshabilitado no pide nada y deja el inicial', async () => {
    const { result } = renderHook(() => usePoll(null, 1000, { inicial: [] }));
    const r2 = renderHook(() => usePoll('/x', 1000, { enabled: false }));
    expect(result.current).toMatchObject({ data: [], cargando: false });
    expect(r2.result.current.cargando).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('repite cada `ms`, pausa con la pestaña oculta y recarga al volver', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(json(200, { n: 1 }));
    const { unmount } = renderHook(() => usePoll('/m', 3000, { headers: { X: '1' } }));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ X: '1' });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    ocultar(true);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    ocultar(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('un ciclo con la pestaña oculta no programa el siguiente', async () => {
    vi.useFakeTimers();
    ocultar(true);
    fetchMock.mockResolvedValue(json(200, 1));
    renderHook(() => usePoll('/m', 1000));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('el error queda en `error` y recargar() vuelve a pedir y lo limpia', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: 'se cayó' })).mockResolvedValueOnce(json(200, 'ok', { ct: 'text/plain' }));
    const { result } = renderHook(() => usePoll('/x'));
    await waitFor(() => expect(result.current.error && result.current.error.message).toBe('se cayó'));
    act(() => result.current.recargar());
    await waitFor(() => expect(result.current.data).toEqual({ error: 'ok' }));
    expect(result.current.error).toBeNull();
  });

  it('desmontar con un pedido en vuelo lo aborta y no toca el estado', async () => {
    let resolver;
    fetchMock.mockImplementation((_u, init) => new Promise((res, rej) => {
      resolver = res;
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })));
    }));
    const { result, unmount } = renderHook(() => usePoll('/lento', 1000));
    const signal = fetchMock.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(result.current.data).toBeNull();
    resolver(json(200, 1));
  });

  it('una respuesta que llega después de desmontar (sin abort) se descarta, sea éxito o error', async () => {
    const pend = [];
    fetchMock.mockImplementation(() => new Promise((res) => pend.push(res)));
    const a = renderHook(() => usePoll('/a'));
    const b = renderHook(() => usePoll('/b'));
    a.unmount(); b.unmount();
    await act(async () => { pend[0](json(200, 1)); pend[1](json(500, {})); });
    expect(a.result.current.data).toBeNull();
    expect(b.result.current.error).toBeNull();
  });

  it('un AbortError de la red con el hook vivo no se muestra como error', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('a'), { name: 'AbortError' }));
    const { result } = renderHook(() => usePoll('/x'));
    await waitFor(() => expect(result.current.cargando).toBe(false));
    expect(result.current.error).toBeNull();
  });
});

describe('useApi', () => {
  it('carga una vez, recarga con recargar() y si cambian las deps', async () => {
    fetchMock.mockResolvedValue(json(200, { v: 1 }));
    const { result, rerender } = renderHook(({ d }) => useApi('/x', [d]), { initialProps: { d: 1 } });
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));
    act(() => result.current.recargar());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    rerender({ d: 2 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(result.current.cargando).toBe(false);
  });
  it('sin path no pide; un error queda en `error`; un abort no', async () => {
    const vacio = renderHook(() => useApi(null));
    expect(vacio.result.current.cargando).toBe(false);
    fetchMock.mockResolvedValueOnce(json(404, {}));
    const r = renderHook(() => useApi('/no'));
    await waitFor(() => expect(r.result.current.error && r.result.current.error.status).toBe(404));
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('a'), { name: 'AbortError' }));
    const r2 = renderHook(() => useApi('/ab'));
    await waitFor(() => expect(r2.result.current.cargando).toBe(false));
    expect(r2.result.current.error).toBeNull();
  });
  it('desmontar antes de la respuesta la descarta', async () => {
    let res;
    fetchMock.mockImplementation(() => new Promise((r) => { res = r; }));
    const { result, unmount } = renderHook(() => useApi('/x'));
    unmount();
    await act(async () => { res(json(200, 1)); });
    expect(result.current.data).toBeNull();
  });
});
