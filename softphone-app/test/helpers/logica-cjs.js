/* Cargar un .cjs de Electron con algunos `require` reemplazados. vi.mock no alcanza al
 * `require` nativo de un CommonJS, así que se intercepta Module._load mientras se carga
 * (y, si se pide, mientras dure la prueba, para los require perezosos). Un valor Error en
 * el mapa hace que ese require falle, como cuando falta un módulo en el empaquetado. */
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* Las rutas se dan relativas a la raíz de softphone-app (p. ej. 'electron/main.cjs'). */
const req = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'));

export function cargarCjs(ruta, mocks = {}, { mantener = false } = {}) {
  const abs = req.resolve('./' + ruta.replace(/^(\.\.\/)+/, ''));
  delete req.cache[abs];
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      const m = mocks[request];
      if (m instanceof Error) throw m;
      return m;
    }
    return orig.call(this, request, ...rest);
  };
  const restaurar = () => { Module._load = orig; };
  let mod;
  try { mod = req(abs); } finally { if (!mantener) restaurar(); }
  return mantener ? { mod, restaurar } : mod;
}
