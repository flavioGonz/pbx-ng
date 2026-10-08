/* Ayudante de las pruebas de Portería, clientes, salas, mapa y click-to-call: monta con el
 * MISMO tema y esquema que app/layout.jsx (así lo que se ve en la prueba es lo que ve el
 * operador), un `fetch` falso con rutas que guarda lo que de verdad viajó, y los dobles de
 * lo que jsdom no trae para la pared de video (MediaSource y WebSocket). */
import { render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { theme } from '../../app/theme';

export function renderP(ui, opts) {
  return render(ui, {
    wrapper: ({ children }) => <MantineProvider theme={theme} defaultColorScheme="dark">{children}</MantineProvider>,
    ...opts,
  });
}

/* `fetch` falso con rutas.
 *   const f = rutasFalsas({ 'GET /clients': [...], 'POST /clients': (cuerpo) => ({ id: 1 }) })
 * - clave "MÉTODO /ruta" sin el prefijo /backend/api; se prueba primero con la query y
 *   después sin ella.
 * - `estado(500, {error})` contesta con ese status; una función recibe (cuerpo, url);
 *   un Error simula la red caída y una Response se devuelve tal cual.
 * - una ruta que no está contesta 404: una pantalla que pide algo inesperado se nota.
 * - `f.llamadas` guarda {metodo, ruta, cuerpo}. */
const ESTADO = Symbol('estado');
export const estado = (status, cuerpo = null) => ({ [ESTADO]: true, status, cuerpo });

export function rutasFalsas(rutas = {}) {
  const llamadas = [];
  const f = async (url, init = {}) => {
    const metodo = (init.method || 'GET').toUpperCase();
    const u = String(url);
    const ruta = u.replace(/^.*\/backend\/api/, '');
    const sinQuery = ruta.split('?')[0];
    let cuerpo = init.body;
    try { if (typeof cuerpo === 'string') cuerpo = JSON.parse(cuerpo); } catch (_) { /* crudo */ }
    llamadas.push({ metodo, ruta, cuerpo });
    let v;
    if ((metodo + ' ' + ruta) in rutas) v = rutas[metodo + ' ' + ruta];
    else if ((metodo + ' ' + sinQuery) in rutas) v = rutas[metodo + ' ' + sinQuery];
    else v = estado(404, { error: 'No encontrado: ' + metodo + ' ' + ruta });
    if (typeof v === 'function') v = await v(cuerpo, u);
    if (v instanceof Error) throw v;
    if (v instanceof Response) return v;      // cuerpo crudo (un HTML de error del proxy)
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

/* ── Dobles de video ─────────────────────────────────────────────────────────
 * MediaSource y WebSocket de mentira, controlados desde la prueba: la prueba decide
 * cuándo abre el caño, qué manda go2rtc y cuándo se corta. */
export function instalarVideoFalso({ soporta = () => true } = {}) {
  const sockets = [];
  const fuentes = [];
  class SourceBufferFalso {
    constructor() { this.updating = false; this.appended = []; this.mode = ''; this.l = {}; this.buffered = { length: 0, start: () => 0, end: () => 0 }; this.removidos = []; }
    addEventListener(n, fn) { this.l[n] = fn; }
    appendBuffer(b) { this.appended.push(b); }
    remove(a, b) { this.removidos.push([a, b]); }
  }
  class MediaSourceFalso {
    constructor() { this.readyState = 'closed'; this.l = {}; this.buffers = []; this.fallarCodec = false; this.terminado = false; fuentes.push(this); }
    addEventListener(n, fn) { this.l[n] = fn; }
    abrir() { this.readyState = 'open'; return this.l.sourceopen && this.l.sourceopen(); }
    addSourceBuffer(tipo) { if (this.fallarCodec) throw new Error('codec'); const sb = new SourceBufferFalso(); sb.tipo = tipo; this.buffers.push(sb); return sb; }
    endOfStream() { this.terminado = true; this.readyState = 'ended'; }
  }
  MediaSourceFalso.isTypeSupported = (t) => soporta(t);
  class WebSocketFalso {
    constructor(url) { this.url = url; this.enviados = []; this.cerrado = false; sockets.push(this); if (WebSocketFalso.romper) throw new Error('sin ws'); }
    send(m) { this.enviados.push(m); }
    close() { this.cerrado = true; }
  }
  WebSocketFalso.romper = false;
  const orig = { MediaSource: globalThis.MediaSource, WebSocket: globalThis.WebSocket, create: URL.createObjectURL };
  globalThis.MediaSource = MediaSourceFalso;
  globalThis.WebSocket = WebSocketFalso;
  URL.createObjectURL = () => 'blob:falso';
  return {
    sockets, fuentes, WebSocketFalso,
    restaurar() {
      globalThis.MediaSource = orig.MediaSource;
      globalThis.WebSocket = orig.WebSocket;
      URL.createObjectURL = orig.create;
    },
  };
}
