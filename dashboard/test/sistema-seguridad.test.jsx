/* ============================================================================
 *  Seguridad (SOC): el mapa de ataques (globo 3D y su respaldo plano) y la pantalla
 *  /seguridad con sus cuatro solapas.
 *
 *  Lo que se fija: que el globo caiga solo al mapa plano si el navegador no tiene WebGL
 *  (un SOC en negro no sirve); que el aviso de ataque señale al país de la IP más
 *  insistente; que banear una IP o un país pida confirmación y mande exactamente lo que
 *  la API espera; que la lista blanca se saque por query (un DELETE con body lo pierden
 *  algunos proxies); que sólo un admin vea los botones que cambian algo; y que un
 *  firewall que no aplica los bloqueos se grite arriba de todo —«bloqueada» en la base
 *  y abierta en el host es la peor mentira posible en esta pantalla.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { renderUI, fakeFetch, res } from './helpers/sistema-render.jsx';

// Pantallas pesadas: con cobertura y suites en paralelo, 5 s no siempre alcanzan.
vi.setConfig({ testTimeout: 20000 });

const promesas = [];
vi.mock('../app/notify', () => ({
  toast: vi.fn(),
  /* Como sileo: el error se muestra en el toast. Devuelve un «thenable» que rechaza sólo
   * si alguien lo espera (confirmarBan lo hace para dejar el modal abierto); así los que
   * no esperan no dejan un rechazo sin manejar. */
  toastPromise: vi.fn((p, o) => {
    const fin = Promise.resolve(p).then(
      (d) => { promesas.push(['ok', typeof o.success === 'function' ? o.success(d) : o.success]); return { d }; },
      (e) => { promesas.push(['error', typeof o.error === 'function' ? o.error(e) : o.error]); return { e }; });
    return { then: (ok, mal) => fin.then((r) => ('e' in r ? (mal ? mal(r.e) : Promise.reject(r.e)) : (ok ? ok(r.d) : r.d))) };
  }),
}));
const estado = { admin: true, socket: null, romperImport: false, romperGlobo: false, opts: null, destruidos: 0 };
vi.mock('../app/useLive', () => ({ getSocket: () => estado.socket, useLive: () => ({ snap: null, connected: false }) }));
vi.mock('../app/auth', () => ({ useEsAdmin: () => estado.admin }));
vi.mock('cobe', () => ({
  get default() {
    if (estado.romperImport) throw new Error('sin cobe');
    return (canvas, opts) => {
      if (estado.romperGlobo) throw new Error('sin WebGL');
      estado.opts = opts;
      return { destroy: () => { estado.destruidos++; if (estado.romperDestroy) throw new Error('contexto WebGL perdido'); } };
    };
  },
}));

import { toast } from '../app/notify';
import AttackMap from '../app/AttackMap.jsx';
import AttackGlobe from '../app/AttackGlobe.jsx';
import Seguridad from '../app/seguridad/page.jsx';

const toasts = () => toast.mock.calls.map((c) => [c[0], c[1]]);

function socketFalso() {
  const h = {};
  return {
    connected: true,
    on: (ev, fn) => { (h[ev] = h[ev] || []).push(fn); },
    off: (ev, fn) => { h[ev] = (h[ev] || []).filter((x) => x !== fn); },
    emit: () => {},
    disparar: (ev, d) => act(() => { (h[ev] || []).slice().forEach((fn) => fn(d)); }),
    oyentes: (ev) => (h[ev] || []).length,
  };
}

/* jsdom no trae PointerEvent: sin esto, `clientX` llega undefined al arrastrar el globo. */
if (!window.PointerEvent) window.PointerEvent = class extends MouseEvent {};

beforeEach(() => {
  toast.mockClear(); promesas.length = 0;
  Object.assign(estado, { admin: true, socket: null, romperImport: false, romperGlobo: false, romperDestroy: false, opts: null, destruidos: 0 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('AttackMap — mapa plano', () => {
  it('pone un punto por país conocido (ignora los que no sabe ubicar) y muestra los KPIs', () => {
    const { container } = renderUI(<AttackMap paises={[{ cc: 'cn', pais: 'China', n: 10 }, { cc: 'US', n: 1 }, { cc: 'XX', n: 3 }, {}]} kpis={{ bloqueados: 7, ultimas_24h: 3, paises: 2, fallos_24h: 40, permanentes: 1 }} />);
    expect(screen.getByText('2 orígenes')).toBeTruthy();
    expect(screen.getByText('Mapa de ataques en vivo')).toBeTruthy();
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.queryByText('Sin ataques localizados todavía.')).toBeNull();
    expect(container.querySelectorAll('polygon').length).toBeGreaterThan(5);
    expect(container.querySelectorAll('[style*="cursor: help"]')).toHaveLength(2);
  });

  it('sin países (o con props nulas) dice que todavía no hay ataques localizados', () => {
    renderUI(<AttackMap paises={null} kpis={null} titulo="Otro título" />);
    expect(screen.getByText('Otro título')).toBeTruthy();
    expect(screen.getByText('Sin ataques localizados todavía.')).toBeTruthy();
    expect(screen.getAllByText('0')).toHaveLength(5);
  });

  it('el tooltip de cada punto dice país y golpes (en singular si es uno)', async () => {
    const { container } = renderUI(<AttackMap paises={[{ cc: 'BR', n: 1 }]} />);
    fireEvent.mouseEnter(container.querySelector('[style*="cursor: help"]'));
    await waitFor(() => expect(screen.getByText('BR · 1 golpe')).toBeTruthy());
  });
});

describe('AttackGlobe — globo 3D', () => {
  const PAISES = [{ cc: 'RU', pais: 'Rusia', n: 20 }, { cc: 'cn', n: 5 }, { cc: 'ZZ', n: 1 }];

  it('arma el globo con un marcador por atacante, la central y el muro geográfico', async () => {
    renderUI(<AttackGlobe paises={PAISES} geoblock={{ modo: 'bloquear', paises: [{ cc: 'RU' }, { cc: 'IR', nombre: 'Irán' }, { cc: 'QQ' }] }} kpis={{ bloqueados: 3 }} />);
    await waitFor(() => expect(estado.opts).toBeTruthy());
    // central + 2 atacantes + 1 país del muro (RU ataca: gana el rojo, no se duplica)
    expect(estado.opts.markers).toHaveLength(4);
    expect(estado.opts.dark).toBe(1);
    expect(screen.getByText('2 orígenes')).toBeTruthy();
    expect(screen.getByText('2 vetados')).toBeTruthy();   // RU e IR; QQ no se sabe ubicar
    expect(screen.getByText('RU · 20')).toBeTruthy();
    expect(screen.getByText('CN · 5')).toBeTruthy();
  });

  it('en cada cuadro gira el planeta, ubica banderas y traza la línea hacia la central', async () => {
    const { container } = renderUI(<AttackGlobe paises={[{ cc: 'BR', n: 2 }, { cc: 'AR', n: 1 }, { cc: 'JP', n: 1 }]} />);
    await waitFor(() => expect(estado.opts).toBeTruthy());
    const state = {};
    const lienzo = container.querySelector('canvas');
    // Arrastre: mientras se arrastra no gira solo; al soltar vuelve a girar.
    fireEvent.pointerMove(lienzo, { clientX: 10 });   // sin arrastre no hace nada
    fireEvent.pointerDown(lienzo, { clientX: 100 });
    fireEvent.pointerMove(lienzo, { clientX: 300 });
    estado.opts.onRender(state);
    const phiArrastre = state.phi;
    estado.opts.onRender(state);
    expect(state.phi).toBe(phiArrastre);
    fireEvent.pointerUp(lienzo);
    estado.opts.onRender(state);
    expect(state.phi).toBeGreaterThan(phiArrastre);
    fireEvent.pointerLeave(lienzo);
    // Recorremos una vuelta entera: cada bandera queda visible en algún momento.
    const vistas = new Set();
    for (let i = 0; i < 40; i++) {
      fireEvent.pointerDown(lienzo, { clientX: 0 });
      fireEvent.pointerMove(lienzo, { clientX: i * 32 });
      estado.opts.onRender(state);
      container.querySelectorAll('[data-cc]').forEach((el) => { if (el.style.opacity === '1') vistas.add(el.dataset.cc); });
    }
    fireEvent.pointerUp(lienzo);
    expect([...vistas].sort()).toEqual(['AR', 'BR', 'JP']);
    const trazos = [...container.querySelectorAll('path[d]')].map((p) => p.getAttribute('d'));
    expect(trazos.some((d) => /^M [\d.-]+ [\d.-]+ Q /.test(d))).toBe(true);
    expect(state.width).toBeGreaterThan(0);
  });

  it('bajo ataque marca al país de la IP más insistente y lo dice en el mapa', async () => {
    const { container } = renderUI(<AttackGlobe paises={[{ cc: 'RU', n: 9 }, { cc: 'CN', n: 2 }]}
      bloqueos={[null, { ip: '1.1.1.1', cc: 'cn' }, { ip: '6.6.6.6', cc: 'RU' }]}
      ataque={{ activo: true, top_ip: '6.6.6.6', golpes_min: 120 }} />);
    expect(screen.getByText('BAJO ATAQUE')).toBeTruthy();
    expect(screen.getByText('120/min · 6.6.6.6')).toBeTruthy();
    expect(container.querySelectorAll('path[filter="url(#agBrasa)"]')).toHaveLength(2);
    const ru = container.querySelector('[data-cc="RU"]');
    expect(ru.style.background).toMatch(/229, 52, 42|#e5342a/);
  });

  it('ataque sin IP conocida muestra la cantidad de IPs; ataque inactivo no se muestra', () => {
    const { unmount } = renderUI(<AttackGlobe paises={[{ cc: 'RU', n: 1 }]} ataque={{ activo: true, ips: 14, golpes_min: 30 }} />);
    expect(screen.getByText('30/min · 14 IPs')).toBeTruthy();
    unmount();
    renderUI(<AttackGlobe ataque={{ activo: false }} geoblock={{ modo: 'permitir', paises: [{ cc: 'UY' }] }} />);
    expect(screen.queryByText('BAJO ATAQUE')).toBeNull();
    expect(screen.getByText('1 permitidos')).toBeTruthy();
    expect(screen.getByText('Sin ataques en curso.')).toBeTruthy();
  });

  it('países sin cantidad cuentan como un golpe; un ataque de una IP sin bloqueo no marca culpable', async () => {
    const { container } = renderUI(<AttackGlobe paises={[{ cc: 'RU' }, { cc: 'US', n: 3 }]} bloqueos={[{ ip: '1.1.1.1', cc: 'US' }]}
      ataque={{ activo: true, top_ip: '9.9.9.9', golpes_min: 5 }} />, { esquema: 'light' });
    expect(screen.getByText('RU · 1')).toBeTruthy();
    expect(screen.getByText('5/min · 9.9.9.9')).toBeTruthy();
    expect(container.querySelectorAll('path[filter="url(#agBrasa)"]')).toHaveLength(0);
    await waitFor(() => expect(estado.opts).toBeTruthy());
    expect(estado.opts.markers[1].size).toBeCloseTo(0.03 + (1 / 3) * 0.045);
  });

  it('el mapa plano también cuenta como un golpe al país sin cantidad', () => {
    const { container } = renderUI(<AttackMap paises={[{ cc: 'RU' }, { cc: 'US', n: 2 }]} />);
    expect(container.querySelectorAll('[style*="cursor: help"]')).toHaveLength(2);
  });

  it('un globo que falla al destruirse no rompe el desmontaje', async () => {
    const { unmount } = renderUI(<AttackGlobe paises={[{ cc: 'RU', n: 1 }]} />);
    await waitFor(() => expect(estado.opts).toBeTruthy());
    window.devicePixelRatio = 0;
    estado.destruidos = 0;
    const r = renderUI(<AttackGlobe paises={[{ cc: 'CN', n: 1 }]} />);
    await waitFor(() => expect(estado.opts.devicePixelRatio).toBe(1));
    window.devicePixelRatio = 1;
    estado.romperDestroy = true;
    expect(() => { unmount(); r.unmount(); }).not.toThrow();
    expect(estado.destruidos).toBe(2);
  });

  it('en tema claro usa el globo para fondo claro y sin datos lo dice', async () => {
    renderUI(<AttackGlobe paises={null} bloqueos={null} kpis={null} />, { esquema: 'light' });
    await waitFor(() => expect(estado.opts).toBeTruthy());
    expect(estado.opts.dark).toBe(0);
    expect(estado.opts.markers).toHaveLength(1);
    expect(screen.getByText('Sin ataques localizados todavía.')).toBeTruthy();
  });

  it('si el navegador no tiene WebGL (o no carga cobe), cae al mapa plano', async () => {
    estado.romperGlobo = true;
    const { container, unmount } = renderUI(<AttackGlobe paises={[{ cc: 'RU', n: 1 }]} />);
    await waitFor(() => expect(container.querySelectorAll('polygon').length).toBeGreaterThan(0));
    expect(container.querySelector('canvas')).toBeNull();
    unmount();
    estado.romperGlobo = false; estado.romperImport = true;
    const r2 = renderUI(<AttackGlobe />);
    await waitFor(() => expect(r2.container.querySelectorAll('polygon').length).toBeGreaterThan(0));
  });

  it('al desmontar destruye el globo; si se desmonta antes de cargar, no lo crea', async () => {
    const { unmount } = renderUI(<AttackGlobe paises={[{ cc: 'RU', n: 1 }]} />);
    await waitFor(() => expect(estado.opts).toBeTruthy());
    unmount();
    expect(estado.destruidos).toBe(1);
    estado.opts = null;
    const r = renderUI(<AttackGlobe />);
    r.unmount();
    await new Promise((x) => setTimeout(x, 10));
    expect(estado.opts).toBeNull();
  });
});

/* ───────────────────────── la pantalla /seguridad ───────────────────────── */

const ahora = Date.now();
const iso = (s) => new Date(ahora + s * 1000).toISOString();
function bloqueosMuchos(n) {
  return Array.from({ length: n }, (_, i) => ({ ip: `10.9.${Math.floor(i / 250)}.${i % 250}`, cc: 'BR', country: 'Brasil', reason: 'clave errada', hits: 1, expires_at: iso(7200) }));
}
const SOC = {
  kpis: { bloqueados: 5, ultimas_24h: 2, paises: 2, fallos_24h: 9, permanentes: 1 },
  enforcement: { nft: true },
  top_paises: [{ pais: 'Rusia', cc: 'RU', n: 4 }, { pais: 'Desconocido', n: 1 }],
  top_atacantes: [{ ip: '6.6.6.6', cc: 'RU', hits: 30, country: 'Rusia', isp: 'OVH SAS' }, { ip: '7.7.7.7', cc: 'zz9', hits: 2, permanent: true }],
  bloqueos: [
    { ip: '6.6.6.6', cc: 'RU', country: 'Rusia', isp: 'OVH SAS', reason: 'flood de REGISTER', hits: 30, blocked_at: iso(-60), expires_at: iso(30) },
    { ip: '7.7.7.7', reason: 'lista negra (manual)', permanent: true, note: 'proveedor', hits: 2 },
    { ip: '8.8.8.8', cc: 'US', isp: 'Raro Hosting', reason: 'sipvicious', expires_at: iso(1800) },
    { ip: '9.9.9.9', reason: 'clave inválida', expires_at: iso(5400) },
    { ip: '1.0.0.1', reason: 'cuenta inexistente', expires_at: iso(3 * 86400) },
    { ip: '1.0.0.2', reason: 'ACL del endpoint', expires_at: iso(-10) },
    { ip: '1.0.0.3', reason: 'país vetado', expires_at: iso(7200) },
    { ip: '1.0.0.4', reason: 'otra cosa' },
  ],
  eventos: [
    { id: 1, kind: 'bloqueo', severity: 'crit', detail: { ip: '6.6.6.6', cc: 'RU', pais: 'Rusia', motivo: 'flood' }, created_at: iso(-30) },
    { id: 2, kind: 'raro', severity: 'xx', detail: 'texto plano', created_at: iso(-20) },
    { id: 3, kind: 'ajustes', detail: { country: 'Chile', msg: 'cambiaron los umbrales' }, created_at: iso(-10) },
    { id: 4, kind: 'motor', detail: null, created_at: iso(-5) },
  ],
};
const rutasBase = (extra = {}) => ({
  'GET /security': SOC,
  'GET /security/settings': { max_fallos: 5, ventana_s: 60, ban_s: 3600, ban_permanente_tras: 3, unidentified_count: 5, unidentified_period: 60, unidentified_prune: 300, escaneres: true, alertar: false },
  'GET /security/whitelist': [{ ip: '200.1.1.0/24', note: 'sucursal' }, { ip: '201.0.0.1', reason: 'proveedor SIP', country: 'UY' }, { ip: '201.0.0.2' }],
  'GET /security/geoblock': { modo: 'bloquear', paises: [{ cc: 'CN', nombre: 'China' }, { cc: 'XK', nombre: 'Kosovo' }] },
  ...extra,
});
const solapa = (n) => fireEvent.click(screen.getByRole('tab', { name: n }));

describe('/seguridad — Centro de operaciones', () => {
  it('muestra el SOC: países, línea de tiempo, insistentes y bloqueos con su motivo y vencimiento', async () => {
    // Reloj quieto en `ahora`: así «en 2 h» es exacto y no «en 2.0 h» por unos milisegundos.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ahora);
    fakeFetch(rutasBase());
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getAllByText('6.6.6.6').length).toBeGreaterThan(1));
    expect(screen.getByText('firewall activo · nftables')).toBeTruthy();
    expect(screen.getByText('Desconocido')).toBeTruthy();
    expect(screen.getByText('texto plano')).toBeTruthy();
    expect(screen.getByText('cambiaron los umbrales')).toBeTruthy();
    expect(screen.getByText('Chile')).toBeTruthy();
    expect(screen.getByText('PJSIP')).toBeTruthy();
    expect(screen.getByText('raro')).toBeTruthy();
    // Vencimientos legibles: segundos, minutos, horas, días, vencido, permanente, sin dato.
    expect(screen.getByText(/^en \d+ s$/)).toBeTruthy();
    expect(screen.getByText('en 30 min')).toBeTruthy();
    expect(screen.getByText('en 1.5 h')).toBeTruthy();
    expect(screen.getByText('en 2 h')).toBeTruthy();
    expect(screen.getByText('en 3 d')).toBeTruthy();
    expect(screen.getByText('venciendo')).toBeTruthy();
    expect(screen.getAllByText('permanente').length).toBeGreaterThan(0);
    // ISP conocido con logo y ficha en ipinfo; desconocido con ícono; sin ISP, guion.
    const enlace = screen.getAllByText('OVH SAS').map((e) => e.closest('a')).find(Boolean);
    expect(enlace.getAttribute('href')).toBe('https://ipinfo.io/6.6.6.6');
    expect(document.querySelector('img[src*="favicons?domain=ovh.com"]')).toBeTruthy();
    expect(screen.getByText('Raro Hosting')).toBeTruthy();
    // Las banderas rotas se esconden en vez de mostrar el ícono de imagen rota.
    const img = document.querySelector('img[src="https://flagcdn.com/ru.svg"][alt="RU"]');
    fireEvent.error(img);
    expect(img.style.visibility).toBe('hidden');
    const logo = document.querySelector('img[src*="favicons"]');
    fireEvent.error(logo);
    expect(logo.style.display).toBe('none');
  });

  it('el buscador filtra por IP, país o ISP, y sin coincidencias muestra la central tranquila', async () => {
    fakeFetch(rutasBase());
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByPlaceholderText('Buscar IP, país o ISP…')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText('8.8.8.8').length).toBe(1));
    fireEvent.change(screen.getByPlaceholderText('Buscar IP, país o ISP…'), { target: { value: 'ovh' } });
    expect(screen.queryByText('8.8.8.8')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Buscar IP, país o ISP…'), { target: { value: 'nada que ver' } });
    expect(screen.getByText('Ninguna IP bloqueada')).toBeTruthy();
  });

  it('desbloquear suelta la IP del firewall y relee; un error se muestra', async () => {
    let falla = false;
    const f = fakeFetch(rutasBase({ 'POST /security/unblock': () => (falla ? res(500, { error: 'agente caído' }) : { ok: true }) }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getAllByText('9.9.9.9').length).toBe(1));
    const fila = screen.getByText('9.9.9.9').closest('tr');
    fireEvent.click(within(fila).getByRole('button'));
    await waitFor(() => expect(promesas).toContainEqual(['ok', '9.9.9.9 desbloqueada']));
    expect(f.a('POST', '/security/unblock')[0].body).toEqual({ ip: '9.9.9.9' });
    falla = true;
    fireEvent.click(within(fila).getByRole('button'));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'agente caído']));
  });

  it('banear una IP o un país entero pide confirmación y manda lo que la API espera', async () => {
    let falla = false;
    const f = fakeFetch(rutasBase({
      'POST /security/block': () => (falla ? res(500, { error: 'nft caído' }) : { ok: true }),
      'POST /security/geoblock/add': { ok: true },
    }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText('Los más insistentes')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText('6.6.6.6').length).toBeGreaterThan(1));
    const insistentes = screen.getByText('Los más insistentes').closest('.mantine-Card-root');
    fireEvent.click(within(insistentes).getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Bloquear esta IP')).toBeTruthy());
    expect(screen.getByText('Rusia · OVH SAS')).toBeTruthy();
    // Cancelar no manda nada.
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Bloquear esta IP')).toBeNull());
    fireEvent.click(within(insistentes).getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Bloquear esta IP')).toBeTruthy());
    falla = true;
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear IP' }));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'nft caído']));
    expect(screen.getByText('Bloquear esta IP')).toBeTruthy();   // queda abierto para reintentar
    falla = false;
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear IP' }));
    await waitFor(() => expect(promesas).toContainEqual(['ok', '6.6.6.6 bloqueada en el firewall']));
    expect(f.a('POST', '/security/block')[1].body).toEqual({ ip: '6.6.6.6', permanent: true, reason: 'baneo manual (desde SOC)' });
    await waitFor(() => expect(screen.queryByText('Bloquear esta IP')).toBeNull());
    // País entero.
    const paises = screen.getByText('De dónde vienen los ataques').closest('.mantine-Card-root');
    fireEvent.click(within(paises).getByRole('button'));
    await waitFor(() => expect(screen.getByText('Bloquear el país entero')).toBeTruthy());
    expect(screen.getByText('código RU')).toBeTruthy();
    fireEvent.keyDown(screen.getByText('Bloquear el país entero'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Bloquear el país entero')).toBeNull());
    fireEvent.click(within(paises).getByRole('button'));
    await waitFor(() => expect(screen.getByText('Bloquear el país entero')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear país' }));
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Rusia agregado al filtro por país']));
    expect(f.a('POST', '/security/geoblock/add')[0].body).toEqual({ cc: 'RU', nombre: 'Rusia' });
  });

  it('sin permisos de admin no aparecen los botones que cambian algo', async () => {
    estado.admin = false;
    fakeFetch(rutasBase());
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getAllByText('6.6.6.6').length).toBeGreaterThan(1));
    expect(within(screen.getByText('De dónde vienen los ataques').closest('.mantine-Card-root')).queryAllByRole('button')).toHaveLength(0);
    expect(within(screen.getByText('Bloqueos activos').closest('.mantine-Card-root')).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('tab', { name: 'Ajustes de la central' })).toBeNull();
  });

  it('pagina bloqueos de a 25 y eventos de a 15, y no se sale de rango al filtrar', async () => {
    const eventos = Array.from({ length: 20 }, (_, i) => ({ id: i, kind: 'fallo', severity: 'warn', detail: { texto: 'evento ' + i }, created_at: iso(-i) }));
    fakeFetch(rutasBase({ 'GET /security': { ...SOC, bloqueos: bloqueosMuchos(60), eventos } }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText('Mostrando 1–25 de 60')).toBeTruthy());
    expect(screen.getByText('evento 0')).toBeTruthy();
    expect(screen.queryByText('evento 16')).toBeNull();
    const tl = screen.getByText('Línea de tiempo de seguridad').closest('.mantine-Card-root');
    fireEvent.click(within(tl).getByRole('button', { name: '2' }));
    expect(screen.getByText('evento 16')).toBeTruthy();
    const bl = screen.getByText('Bloqueos activos').closest('.mantine-Card-root');
    fireEvent.click(within(bl).getByRole('button', { name: '3' }));
    expect(screen.getByText('Mostrando 51–60 de 60')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Buscar IP, país o ISP…'), { target: { value: '10.9.0.1' } });
    expect(screen.queryByText(/^Mostrando/)).toBeNull();
    expect(screen.getByText('10.9.0.1')).toBeTruthy();
  });

  it('casos de borde del SOC: bloqueo sin motivo, IP insistente sin país ni ISP, fallos al banear un país', async () => {
    const f = fakeFetch(rutasBase({
      'GET /security': { top_paises: [{ pais: 'Rusia', cc: 'RU', n: 2 }], top_atacantes: [{ ip: '3.3.3.3', hits: 1 }], bloqueos: [{ ip: '3.3.3.3' }] },
      'POST /security/geoblock/add': res(500, { error: 'geo caído' }),
      'POST /security/block': { ok: true },
    }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText('Bloqueo genérico')).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThan(1);
    const insistentes = screen.getByText('Los más insistentes').closest('.mantine-Card-root');
    fireEvent.click(within(insistentes).getByRole('button'));
    await waitFor(() => expect(screen.getByText('Bloquear esta IP')).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThan(2);   // sin país ni ISP en el modal
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear IP' }));
    await waitFor(() => expect(promesas).toContainEqual(['ok', '3.3.3.3 bloqueada en el firewall']));
    const paises = screen.getByText('De dónde vienen los ataques').closest('.mantine-Card-root');
    await waitFor(() => expect(screen.queryByText('Bloquear esta IP')).toBeNull());
    fireEvent.click(within(paises).getByRole('button'));
    await waitFor(() => expect(screen.getByText('Bloquear el país entero')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear país' }));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'geo caído']));
    expect(screen.getByText('Bloquear el país entero')).toBeTruthy();
    expect(f.a('POST', '/security/geoblock/add')).toHaveLength(1);
  });

  it('si la pantalla se cierra con un pedido en vuelo, la respuesta tardía no toca nada', async () => {
    let soltar;
    fakeFetch(rutasBase({ 'GET /security': () => new Promise((r) => { soltar = r; }) }));
    const { unmount } = renderUI(<Seguridad />);
    await waitFor(() => expect(soltar).toBeTruthy());
    unmount();
    await act(async () => { soltar(SOC); });
    expect(screen.queryByText('Bloqueos activos')).toBeNull();
  });

  it('SOC vacío: sin países, sin eventos, sin insistentes, sin bloqueos', async () => {
    fakeFetch(rutasBase({ 'GET /security': {} }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText('Sin bloqueos todavía. Bien: nadie insistió lo suficiente.')).toBeTruthy());
    expect(screen.getByText('Sin eventos de seguridad todavía.')).toBeTruthy();
    expect(screen.getByText('Nadie golpeando ahora mismo.')).toBeTruthy();
    expect(screen.getByText('Ninguna IP bloqueada')).toBeTruthy();
  });

  it('si la API de seguridad falla, lo dice en vez de quedar cargando', async () => {
    fakeFetch(rutasBase({ 'GET /security': res(500, 'texto que no es JSON') }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText('No se pudo leer el estado de seguridad: texto que no es JSON')).toBeTruthy());
  });

  it('un error sin cuerpo dice el código HTTP', async () => {
    fakeFetch(rutasBase({ 'GET /security': res(503, '') }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText('No se pudo leer el estado de seguridad: HTTP 503')).toBeTruthy());
  });

  it('firewall sin aplicar: avisa arriba si falta nftables o si el agente no responde', async () => {
    fakeFetch(rutasBase({ 'GET /security': { enforcement: { nft: false, agente: true, motivo: 'nft: command not found' } } }));
    const { unmount } = renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText('sin nftables')).toBeTruthy());
    expect(screen.getByText('Los bloqueos se registran pero no se aplican en el firewall')).toBeTruthy();
    expect(screen.getByText('nft: command not found')).toBeTruthy();
    unmount();
    fakeFetch(rutasBase({ 'GET /security': { enforcement: { nft: false, agente: false } } }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText('agente sin respuesta')).toBeTruthy());
    expect(screen.getByText(/El agente de Asterisk no responde\./)).toBeTruthy();
  });

  it('el agente que no responde con motivo y nftables sin motivo también se explican', async () => {
    fakeFetch(rutasBase({ 'GET /security': { enforcement: { nft: false, agente: false, motivo: 'ECONNREFUSED' } } }));
    const { unmount } = renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText('ECONNREFUSED')).toBeTruthy());
    unmount();
    fakeFetch(rutasBase({ 'GET /security': { enforcement: { nft: false, agente: true } } }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getByText(/nftables no está disponible en el host de Asterisk\./)).toBeTruthy());
  });

  it('un evento del socket refresca el SOC una sola vez por ráfaga; el reloj de 8 s pausa con la pestaña oculta', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = socketFalso();
    estado.socket = s;
    let n = 0;
    const f = fakeFetch(rutasBase({ 'GET /security': () => ({ ...SOC, kpis: { bloqueados: ++n } }) }));
    const { unmount } = renderUI(<Seguridad />);
    await waitFor(() => expect(f.a('GET', '/security')).toHaveLength(1));
    s.disparar('sec:ev', {}); s.disparar('sec:ev', {}); s.disparar('sec:ev', {});
    await act(async () => { vi.advanceTimersByTime(1600); });
    await waitFor(() => expect(f.a('GET', '/security')).toHaveLength(2));
    await act(async () => { vi.advanceTimersByTime(8000); });
    await waitFor(() => expect(f.a('GET', '/security')).toHaveLength(3));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { vi.advanceTimersByTime(16000); });
    expect(f.a('GET', '/security')).toHaveLength(3);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    s.disparar('sec:ev', {});
    unmount();
    expect(s.oyentes('sec:ev')).toBe(0);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(f.a('GET', '/security')).toHaveLength(3);
  });

  it('si el refresco trae lo mismo no repinta, y un payload que no se puede serializar igual se muestra', async () => {
    // Mismo JSON dos veces: la segunda no cambia el estado (la prueba es que no rompe y sigue igual).
    const texto = JSON.stringify(SOC);
    const f = fakeFetch(rutasBase({ 'GET /security': res(200, texto) }));
    const s = socketFalso();
    estado.socket = s;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getAllByText('6.6.6.6').length).toBeGreaterThan(1));
    s.disparar('sec:ev', {});
    await act(async () => { vi.advanceTimersByTime(1600); });
    await waitFor(() => expect(f.a('GET', '/security')).toHaveLength(2));
    expect(screen.getAllByText('6.6.6.6').length).toBeGreaterThan(1);
    // Un JSON.stringify que tira (no pasa con datos de la API, pero el código lo contempla).
    const orig = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((v, ...r) => { if (v && v.kpis) throw new Error('circular'); return orig(v, ...r); });
    s.disparar('sec:ev', {});
    await act(async () => { vi.advanceTimersByTime(1600); });
    await waitFor(() => expect(f.a('GET', '/security')).toHaveLength(3));
    expect(screen.getAllByText('6.6.6.6').length).toBeGreaterThan(1);
  });
});

describe('/seguridad — Ajustes de la central', () => {
  it('carga los umbrales, guarda sólo si hubo cambios y aplica a PJSIP', async () => {
    let fallaApply = false;
    const f = fakeFetch(rutasBase({ 'PUT /security/settings': { ok: true }, 'POST /security/apply': () => (fallaApply ? res(500, { error: 'pjsip no recarga' }) : { ok: true }) }));
    renderUI(<Seguridad />);
    solapa('Ajustes de la central');
    await waitFor(() => expect(screen.getByText('Defensa de la central')).toBeTruthy());
    const guardar = screen.getByRole('button', { name: 'Guardar' });
    expect(guardar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Fallos permitidos'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('…en esta ventana (s)'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('Duración del bloqueo (s)'), { target: { value: '7200' } });
    fireEvent.change(screen.getByLabelText('Permanente tras N bloqueos'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Pedidos sin identificar'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('…en este período (s)'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Limpieza (s)'), { target: { value: '600' } });
    fireEvent.click(screen.getByRole('switch', { name: /Bloquear escáneres a la primera/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Avisar por correo/ }));
    expect(guardar.disabled).toBe(false);
    fireEvent.click(guardar);
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Guardado. Los límites de PJSIP entran al aplicar.']));
    expect(f.a('PUT', '/security/settings')[0].body).toEqual({ max_fallos: 8, ventana_s: 120, ban_s: 7200, ban_permanente_tras: 0, unidentified_count: 9, unidentified_period: 30, unidentified_prune: 600, escaneres: false, alertar: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar' }).disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Umbrales aplicados']));
    fallaApply = true;
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'pjsip no recarga']));
  });

  it('un guardado rechazado lo dice; si no se pueden leer los ajustes, también', async () => {
    fakeFetch(rutasBase({ 'PUT /security/settings': res(400, { error: 'ventana inválida' }) }));
    const { unmount } = renderUI(<Seguridad />);
    solapa('Ajustes de la central');
    await waitFor(() => expect(screen.getByLabelText('Fallos permitidos')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Fallos permitidos'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'ventana inválida']));
    unmount();
    fakeFetch(rutasBase({ 'GET /security/settings': res(403, { error: 'Solo administradores' }) }));
    renderUI(<Seguridad />);
    solapa('Ajustes de la central');
    await waitFor(() => expect(screen.getByText('No se pudieron leer los ajustes: Solo administradores')).toBeTruthy());
  });
});

describe('/seguridad — Listas negra y blanca', () => {
  it('lista negras (permanentes del SOC) y blancas, y agrega a cada una', async () => {
    const f = fakeFetch(rutasBase({ 'POST /security/block': { ok: true }, 'POST /security/whitelist': { ok: true } }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getAllByText('6.6.6.6').length).toBeGreaterThan(1));
    solapa('Listas negras/blancas');
    await waitFor(() => expect(screen.getByText('200.1.1.0/24')).toBeTruthy());
    expect(screen.getByText('sucursal')).toBeTruthy();
    expect(screen.getByText('proveedor SIP · UY')).toBeTruthy();
    expect(within(screen.getByText('201.0.0.2').closest('tr')).getByText('—')).toBeTruthy();
    expect(screen.getByText('proveedor')).toBeTruthy();   // la nota del permanente
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    expect(toasts()).toContainEqual(['Falta la IP', 'warn']);
    // Negra: con nota y sin nota (motivo por defecto).
    fireEvent.change(screen.getByLabelText('IP o red'), { target: { value: ' 5.5.5.5 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(promesas).toContainEqual(['ok', '5.5.5.5 bloqueada en el firewall']));
    expect(f.a('POST', '/security/block')[0].body).toEqual({ ip: '5.5.5.5', permanent: true, reason: 'lista negra (manual)' });
    await waitFor(() => expect(screen.getByLabelText('IP o red').value).toBe(''));
    // Blanca.
    fireEvent.click(screen.getByText('Blanca'));
    expect(screen.getByText(/Nunca se bloquea, aunque falle la clave mil veces/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('IP o red'), { target: { value: '190.0.0.0/16' } });
    fireEvent.change(screen.getByLabelText('Nota'), { target: { value: ' oficina ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(promesas).toContainEqual(['ok', '190.0.0.0/16 con pase libre']));
    expect(f.a('POST', '/security/whitelist')[0].body).toEqual({ ip: '190.0.0.0/16', note: 'oficina' });
    fireEvent.change(screen.getByLabelText('IP o red'), { target: { value: '1.1.1.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(f.a('POST', '/security/whitelist')).toHaveLength(2));
    expect(f.a('POST', '/security/whitelist')[1].body).toEqual({ ip: '1.1.1.1' });
    fireEvent.click(screen.getByText('Negra'));
    fireEvent.change(screen.getByLabelText('IP o red'), { target: { value: '4.4.4.4' } });
    fireEvent.change(screen.getByLabelText('Nota'), { target: { value: 'spam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(f.a('POST', '/security/block')).toHaveLength(2));
    expect(f.a('POST', '/security/block')[1].body.reason).toBe('spam');
  });

  it('sacar de la blanca va por query (no body); sacar de la negra desbloquea; errores al toast', async () => {
    let falla = false;
    const f = fakeFetch(rutasBase({
      'DELETE /security/whitelist': () => (falla ? res(500, { error: 'no se pudo' }) : { ok: true }),
      'POST /security/unblock': () => (falla ? res(500, { error: 'no se soltó' }) : { ok: true }),
      'POST /security/block': res(400, { error: 'IP inválida' }),
      'POST /security/whitelist': res(400, { error: 'CIDR inválido' }),
    }));
    renderUI(<Seguridad />);
    await waitFor(() => expect(screen.getAllByText('6.6.6.6').length).toBeGreaterThan(1));
    solapa('Listas negras/blancas');
    await waitFor(() => expect(screen.getByText('200.1.1.0/24')).toBeTruthy());
    fireEvent.click(within(screen.getByText('200.1.1.0/24').closest('tr')).getByRole('button'));
    await waitFor(() => expect(promesas).toContainEqual(['ok', '200.1.1.0/24 vuelve a estar sujeta a bloqueo']));
    const del = f.a('DELETE', '/security/whitelist')[0];
    expect(del.path).toBe('/security/whitelist?ip=200.1.1.0%2F24');
    expect(del.body).toBeUndefined();
    fireEvent.click(within(screen.getByText('7.7.7.7').closest('tr')).getByRole('button'));
    await waitFor(() => expect(promesas).toContainEqual(['ok', '7.7.7.7 desbloqueada']));
    falla = true;
    fireEvent.click(within(screen.getByText('200.1.1.0/24').closest('tr')).getByRole('button'));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'no se pudo']));
    fireEvent.click(within(screen.getByText('7.7.7.7').closest('tr')).getByRole('button'));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'no se soltó']));
    fireEvent.change(screen.getByLabelText('IP o red'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'IP inválida']));
    fireEvent.click(screen.getByText('Blanca'));
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'CIDR inválido']));
  });

  it('listas vacías lo dicen; sin admin no hay formulario ni botones; error de lectura se muestra', async () => {
    estado.admin = false;
    fakeFetch(rutasBase({ 'GET /security': {}, 'GET /security/whitelist': null }));
    const { unmount } = renderUI(<Seguridad />);
    solapa('Listas negras/blancas');
    await waitFor(() => expect(screen.getByText('La lista negra está vacía: hoy no hay bloqueos permanentes.')).toBeTruthy());
    expect(screen.getByText(/Nadie tiene pase libre/)).toBeTruthy();
    expect(screen.queryByText('Agregar a una lista')).toBeNull();
    unmount();
    fakeFetch(rutasBase({ 'GET /security/whitelist': res(500, { error: 'tabla rota' }) }));
    renderUI(<Seguridad />);
    solapa('Listas negras/blancas');
    await waitFor(() => expect(screen.getByText('No se pudo leer la lista blanca: tabla rota')).toBeTruthy());
  });
});

describe('/seguridad — Filtro por país', () => {
  it('muestra los países, agrega y quita, cambia a lista blanca y guarda-y-aplica', async () => {
    let fallaApply = false;
    const f = fakeFetch(rutasBase({ 'PUT /security/geoblock': { ok: true }, 'POST /security/geoblock/apply': () => (fallaApply ? res(500, { error: 'nft' }) : { ok: true }) }));
    renderUI(<Seguridad />);
    solapa('Filtro por país');
    await waitFor(() => expect(screen.getByText('Kosovo')).toBeTruthy());
    expect(screen.getByText('China')).toBeTruthy();   // fuera del catálogo: usa el nombre guardado
    expect(screen.getByText(/Toda IP de los países de la lista se bloquea/)).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText('Agregar país a bloquear')[0]);
    fireEvent.click(await screen.findByRole('option', { name: /Rusia/ }));
    await waitFor(() => expect(screen.getByText('Rusia')).toBeTruthy());
    // Quitar China.
    fireEvent.click(within(screen.getByText('China').closest('.mantine-Badge-root')).getByRole('button'));
    // (China vuelve a aparecer, pero como opción del desplegable, no como país elegido)
    expect([...document.querySelectorAll('.mantine-Badge-root')].some((x) => x.textContent === 'China')).toBe(false);
    fireEvent.click(screen.getByText('Lista blanca — permitir solo estos'));
    expect(screen.getByText(/Todo el resto se bloquea/)).toBeTruthy();
    expect(screen.getAllByLabelText('Agregar país permitido').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar y aplicar' }));
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Filtro por país aplicado']));
    expect(f.a('PUT', '/security/geoblock')[0].body).toEqual({ paises: [{ cc: 'XK', nombre: 'Kosovo' }, { cc: 'RU', nombre: 'Rusia' }], modo: 'permitir' });
    expect(f.a('POST', '/security/geoblock/apply')).toHaveLength(1);
    fallaApply = true;
    fireEvent.click(screen.getByRole('button', { name: 'Guardar y aplicar' }));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'nft']));
  });

  it('sin países lo dice según el modo; sin admin no se edita; error de lectura se muestra', async () => {
    estado.admin = false;
    fakeFetch(rutasBase({ 'GET /security/geoblock': {} }));
    const { unmount } = renderUI(<Seguridad />);
    solapa('Filtro por país');
    await waitFor(() => expect(screen.getByText('Ningún país bloqueado.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Guardar y aplicar' })).toBeNull();
    unmount();
    // Sin admin los países se ven pero no se pueden quitar; uno fuera del catálogo y sin
    // nombre se muestra con su código.
    fakeFetch(rutasBase({ 'GET /security/geoblock': { paises: [{ cc: 'CN' }, { cc: 'QQ' }] } }));
    const r1 = renderUI(<Seguridad />);
    solapa('Filtro por país');
    await waitFor(() => expect(screen.getByText('QQ')).toBeTruthy());
    expect(within(screen.getByText('China').closest('.mantine-Badge-root')).queryByRole('button')).toBeNull();
    r1.unmount();
    estado.admin = true;
    fakeFetch(rutasBase({ 'GET /security/geoblock': { modo: 'permitir', paises: [] } }));
    const r2 = renderUI(<Seguridad />);
    solapa('Filtro por país');
    await waitFor(() => expect(screen.getByText(/Ningún país permitido todavía/)).toBeTruthy());
    r2.unmount();
    fakeFetch(rutasBase({ 'GET /security/geoblock': res(500, { error: 'geo roto' }) }));
    renderUI(<Seguridad />);
    solapa('Filtro por país');
    await waitFor(() => expect(screen.getByText('No se pudo leer el filtro por país: geo roto')).toBeTruthy());
  });
});
