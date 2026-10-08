/* Lo que todas las pruebas del panel necesitan. jsdom no trae matchMedia ni
 * ResizeObserver, y Mantine los usa al montar casi cualquier componente. */
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

/* `waitFor`/`findBy*` esperan 1 s por defecto: con la cobertura prendida y la máquina
 * cargada (o el runner del CI) una pantalla de Mantine a veces tarda más y la prueba se
 * cae sin que nada esté roto. */
configure({ asyncUtilTimeout: 5000 });

if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  });
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || vi.fn();

/* Node 25+ trae su propio `localStorage` global, que tapa al de jsdom y sin
 * --localstorage-file queda inservible: cualquier pantalla que lee el token reventaba.
 * Si el que hay no funciona, se pone uno en memoria (por prueba se limpia abajo). */
function storageAnda(s) { try { return !!s && typeof s.getItem === 'function'; } catch (_) { return false; } }
function memoria() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => { m.clear(); },
  };
}
for (const nombre of ['localStorage', 'sessionStorage']) {
  let actual; try { actual = globalThis[nombre]; } catch (_) { actual = null; }
  if (!storageAnda(actual)) {
    const s = memoria();
    Object.defineProperty(globalThis, nombre, { value: s, configurable: true, writable: true });
    if (typeof window !== 'undefined' && window !== globalThis) Object.defineProperty(window, nombre, { value: s, configurable: true, writable: true });
  }
}

afterEach(() => cleanup());
