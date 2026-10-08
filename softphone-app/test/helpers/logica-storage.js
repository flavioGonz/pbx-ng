/* localStorage en memoria para las pruebas de lógica. Node 26 trae su propio
 * `localStorage` global (vacío si no se le pasa --localstorage-file) y tapa al de jsdom,
 * así que el código del softphone veía `undefined`. Se instala uno mínimo y completo. */
export function instalarStorage() {
  const datos = new Map();
  const s = {
    getItem: (k) => (datos.has(String(k)) ? datos.get(String(k)) : null),
    setItem: (k, v) => { datos.set(String(k), String(v)); },
    removeItem: (k) => { datos.delete(String(k)); },
    clear: () => datos.clear(),
    key: (i) => Array.from(datos.keys())[i] ?? null,
    get length() { return datos.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
  if (typeof window !== 'undefined' && window !== globalThis) {
    Object.defineProperty(window, 'localStorage', { value: s, configurable: true, writable: true });
  }
  return s;
}
instalarStorage();
