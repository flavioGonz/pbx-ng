/* Ayudantes de las pruebas de telefonía del panel (troncales, rutas, internos, horarios…).
 *
 * Por qué no alcanza con `nucleo-render.jsx`: varias pantallas de telefonía todavía le
 * pegan a `fetch('/backend/api/...')` directo (TrunkEditor, Dialplan, Teléfonos, la nube
 * de IA) y no pasan por `app/api.js`. Para esas hace falta un `fetch` falso con la MISMA
 * forma que la Response real (`ok`, `status`, `headers.get`, `json()`), y que deje
 * preguntar después qué se mandó. Para las que sí usan `app/api.js` se usa el doble de
 * núcleo (apiMock), así todo el equipo prueba contra el mismo contrato.
 *
 * Además Mantine se monta con `env="test"`: sin transiciones ni portales, el cajón
 * (DrawerNG) aparece en el acto y las opciones de un Select se pueden clickear sin esperar
 * animaciones. Es lo que hace a estas pruebas deterministas. */
import { vi } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { theme } from '../../app/theme.js';

export function renderTel(ui, opts = {}) {
  const Wrapper = ({ children }) => (
    <MantineProvider theme={theme} env="test" defaultColorScheme="light">{children}</MantineProvider>
  );
  return render(ui, { wrapper: Wrapper, ...opts });
}

/* Respuesta con la forma mínima de `Response` que usan las pantallas y `app/api.js`. */
export function respuesta(status, body) {
  const esTexto = typeof body === 'string';
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? (esTexto ? 'text/plain' : 'application/json') : null) },
    json: async () => { if (esTexto) throw new SyntaxError('no es JSON'); return body; },
    text: async () => (esTexto ? body : JSON.stringify(body)),
    blob: async () => new Blob([esTexto ? body : JSON.stringify(body ?? '')]),
  };
}

/**
 * fetch falso. `rutas` es { 'GET /trunks': valor | (req) => valor }. La clave puede ir sin
 * método (cualquiera) y con o sin query. El valor puede ser:
 *   - un objeto/arreglo → 200 con ese JSON;
 *   - { __status, __body } → ese status y ese cuerpo;
 *   - una función (req) → lo que devuelva (mismas reglas); si TIRA, el fetch se rechaza
 *     (simula red caída).
 * Sin ruta: 404 {error:'sin mock'}. Devuelve el vi.fn con `.pedidos` = [{method, path, body}].
 */
export function stubFetch(rutas = {}) {
  const pedidos = [];
  const fn = vi.fn(async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const path = String(url).replace(/^\/backend\/api/, '');
    let body = init.body;
    try { body = typeof body === 'string' ? JSON.parse(body) : body; } catch (_) { /* queda texto */ }
    const req = { method, path, body };
    pedidos.push(req);
    const sinQuery = path.split('?')[0];
    const clave = [method + ' ' + path, path, method + ' ' + sinQuery, sinQuery].find((k) => k in rutas);
    if (!clave) return respuesta(404, { error: 'sin mock' });
    let v = rutas[clave];
    if (typeof v === 'function') v = await v(req);
    if (v && typeof v === 'object' && '__status' in v) return respuesta(v.__status, v.__body);
    return respuesta(200, v);
  });
  fn.pedidos = pedidos;
  fn.de = (clave) => {
    const m = /^([A-Z]+)\s+(.*)$/.exec(clave);
    return pedidos.filter((p) => (m ? p.method === m[1] && p.path === m[2] : p.path === clave));
  };
  vi.stubGlobal('fetch', fn);
  return fn;
}

/* toastPromise que, a diferencia del doble de núcleo, SÍ ejecuta los textos de éxito y de
 * error: varias pantallas arman el mensaje con una función (`(e) => e.message`) y eso es
 * justo lo que ve el operador. Devuelve la promesa original (rechazada si falló). */
export function toastPromiseQueEjecuta(registro = []) {
  return vi.fn((p, o = {}) => Promise.resolve(p).then(
    (d) => { registro.push({ ok: true, msg: typeof o.success === 'function' ? o.success(d) : o.success }); return d; },
    (e) => { registro.push({ ok: false, msg: typeof o.error === 'function' ? o.error(e) : o.error }); },
  ));
}

/* Elegir una opción de un Select/MultiSelect de Mantine por el texto visible. */
export function elegir(input, textoOpcion) {
  fireEvent.click(input);
  /* Con env="test" las listas de TODOS los Select quedan en el DOM: se busca en la de este
   * input (aria-controls) para no clickear la opción homónima de otro. */
  const lista = input.getAttribute('aria-controls') && document.getElementById(input.getAttribute('aria-controls'));
  const opciones = lista ? within(lista).getAllByRole('option', { hidden: true }) : screen.getAllByRole('option', { hidden: true });
  const opcion = opciones.find((o) => o.textContent.trim() === textoOpcion);
  if (!opcion) throw new Error('No está la opción «' + textoOpcion + '»');
  fireEvent.click(opcion);
}

/* El <input> de un campo por su etiqueta. Un Select de Mantine comparte la etiqueta con su
 * lista de opciones, así que `getByLabelText` encuentra dos cosas: acá se queda con el input. */
export function campo(etiqueta) {
  const el = screen.getAllByLabelText(etiqueta).find((x) => x.tagName === 'INPUT' || x.tagName === 'TEXTAREA');
  if (!el) throw new Error('No está el campo «' + etiqueta + '»');
  return el;
}

/* Cambiar un input de texto como lo haría el usuario. */
export function escribir(el, valor) { fireEvent.change(el, { target: { value: valor } }); }

export const dentro = within;
export const tick = () => new Promise((r) => setTimeout(r, 0));
