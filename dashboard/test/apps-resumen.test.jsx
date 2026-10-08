/* Resumen (la home del panel): lo primero que mira el operador.
 *
 * Se fija que los números grandes salgan del snapshot del socket (no de un poll), que las
 * llamadas en curso tengan su cronómetro y su estado, que el cartel rojo de «componente
 * caído» aparezca SÓLO si la caída se sostiene 6 s (un parpadeo no alarma) y se vaya apenas
 * vuelve, que «todavía no sé» no se pinte como caído, y que la pantalla no pida a la API
 * lo que no muestra (el /asterisk/core que se encuestaba sin usarse). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { renderNG, fetchFalso, estado } from './helpers/apps-render.jsx';

const vivo = vi.hoisted(() => ({ snap: null, connected: true }));
vi.mock('../app/useLive', () => ({ useLive: () => ({ snap: vivo.snap, connected: vivo.connected }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...p }) => <a href={href} {...p}>{children}</a> }));
// El globo usa WebGL (cobe) y es de otra área: acá sólo importa qué datos recibe.
vi.mock('../app/AttackGlobe', () => ({ default: (p) => <div data-testid="globo">{p.titulo}|{p.paises.length}|{p.bloqueos.length}|{String(p.geoblock)}|{p.ataque ? 'ataque' : 'tranquilo'}</div> }));
vi.mock('../app/Slot', () => ({ default: ({ value }) => <span>{value == null ? '' : String(value)}</span> }));

import Resumen from '../app/page';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

const OV = { nodes: [{ id: 'nodo2' }, { id: 'core', cpu_pct: 37, ncpu: 4, load: 0.5, mem_total_mb: 1000, mem_used_mb: 900, disk: { used: 90, total: 100 } }], storage: { db: { ok: true, bytes: 2048 } } };
const TRUNKS = [{ name: 'antel', status: 'online' }, { name: 'sbc1', status: 'sbc' }, { name: 'movistar', status: 'offline' }, { name: 'claro', status: 'unknown' }, { name: 'otra', status: 'online' }];
const TOPO = { componentes: [{ id: 'asterisk', estado: 'ok' }, { id: 'db', estado: 'ok' }, { id: 'proxy', estado: 'ok' }], nodes: { asterisk: '10.0.0.2', db: '10.0.0.3', npm: '10.0.0.4' }, bordes_externos: [] };
const SOC = { kpis: { bloqueados: 3, fallos_24h: 12 }, top_paises: [{ cc: 'CN' }], bloqueos: [{ ip: 'x' }, { ip: 'y' }], geoblock: { on: true } };
const TURN = { deseado: true, corriendo: true, host: 'turn.local', origen: 'propio' };

const rutas = (extra = {}) => ({
  'GET /system/overview': OV, 'GET /trunks': TRUNKS, 'GET /system': { components: [] }, 'GET /topology': TOPO,
  'GET /security': SOC, 'GET /turn/estado': TURN, ...extra,
});
const AHORA = new Date('2026-10-08T12:00:00Z').getTime();
const SNAP = {
  channels: [
    { id: 'c1', caller: '1001', connected: '099123456', state: 'Up', started: new Date(AHORA - 65000).toISOString() },
    { id: 'c2', ext: '1002', state: 'Ringing', started: new Date(AHORA + 5000).toISOString() },
    { id: 'c3', state: 'Ring' },
    { id: 'c4', caller: '1004', state: 'Dialing', started: new Date(AHORA - 90000 * 1000).toISOString() },
    { id: 'c5', caller: '1005' },
  ],
  extensions: [{ id: 1, status: 'online', webrtc: true }, { id: 2, status: 'online' }, { id: 3, status: 'offline' }],
  queues: [{ name: 'ventas' }],
  health: { ari: true, ami: true, db: true },
};

let f;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: AHORA });
  vivo.snap = SNAP; vivo.connected = true;
  f = fetchFalso(rutas());
  vi.stubGlobal('fetch', f);
});
afterEach(() => { vi.useRealTimers(); });

const kpi = (label) => screen.getByText(label).closest('.mantine-Card-root');

describe('Resumen', () => {
  it('KPIs del socket, recursos de /system/overview y troncales por estado', async () => {
    renderNG(<Resumen />);
    expect(screen.getByText('En vivo')).toBeTruthy();
    expect(kpi('Llamadas activas').textContent).toContain('5');
    expect(kpi('Llamadas activas').textContent).toContain('1 cola');
    expect(kpi('Extensiones en línea').textContent).toContain('de 3 · 1 WebRTC');
    await waitFor(() => expect(kpi('Troncales activas').textContent).toContain('1 caída'));
    expect(kpi('Troncales activas').textContent).toMatch(/^2/);
    await waitFor(() => expect(kpi('IP bloqueadas').textContent).toContain('12 intentos en 24 h'));
    expect(screen.getByTestId('globo').textContent).toBe('Ataques en vivo|1|2|[object Object]|tranquilo');
    await waitFor(() => expect(screen.getAllByText('90%').length).toBe(2));   // disco y memoria
    expect(screen.getByText('2.0 KB')).toBeTruthy();                           // base de datos
    expect(screen.getByText('CPU (4 cores)')).toBeTruthy();
    expect(screen.getByText('load 0.50')).toBeTruthy();
    expect(screen.getByText('Vía SBC-NG')).toBeTruthy();
    expect(screen.getByText('Sin registrar').nextSibling?.textContent ?? screen.getByText('Sin registrar').closest('.mantine-Group-root').parentElement.textContent).toBeTruthy();
    expect(screen.getByText('antel')).toBeTruthy();
    expect(screen.queryByText('otra')).toBeNull();                             // sólo las primeras 4
    expect(screen.getByText('5 total')).toBeTruthy();
    // lo que no se muestra no se pide
    expect(f.llamadas.some((l) => l.ruta.startsWith('/asterisk/core'))).toBe(false);
    expect(f.llamadas.some((l) => l.ruta.startsWith('/metrics'))).toBe(false);
  });

  it('llamadas en curso: estado, quién con quién y un cronómetro que corre', async () => {
    renderNG(<Resumen />);
    const fila = (t) => screen.getByText(t).closest('[style*="border-bottom"]');
    expect(fila('099123456').textContent).toContain('En conversación');
    await waitFor(() => expect(fila('099123456').textContent).toContain('01:05'));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(fila('099123456').textContent).toContain('01:07');
    expect(fila('1002').textContent).toMatch(/Timbrando—$/);            // empezó "en el futuro": sin reloj
    expect(screen.getAllByText('Timbrando').length).toBe(2);
    expect(fila('1004').textContent).toMatch(/Dialing—$/);              // más de un día: sin reloj
    expect(fila('1005').textContent).toContain('En curso');
    expect(screen.getByText('?')).toBeTruthy();
  });

  it('sin llamadas ni datos: estados vacíos, «Conectando…» y nada en rojo antes de medir', async () => {
    vivo.snap = null; vivo.connected = false;
    vi.stubGlobal('fetch', fetchFalso({ 'GET /system/overview': { nodes: [{ id: 'core', cpu_pct: null }] }, 'GET /trunks': estado(500), 'GET /system': estado(500), 'GET /topology': estado(500), 'GET /security': estado(500), 'GET /turn/estado': estado(500) }));
    renderNG(<Resumen />);
    expect(screen.getByText('Conectando…')).toBeTruthy();
    expect(screen.getByText('Ninguna llamada en este momento.')).toBeTruthy();
    expect(screen.getByText('Sin troncales configuradas.')).toBeTruthy();
    expect(kpi('IP bloqueadas').textContent).toContain('0 intentos en 24 h');
    expect(screen.getAllByText('Midiendo…').length).toBe(4);
    expect(screen.queryByText('Caído')).toBeNull();
    expect(screen.getByText('load —')).toBeTruthy();
    expect(screen.getByText('CPU (? cores)')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(7000); });
    expect(screen.queryByText(/componente caído/)).toBeNull();
    expect(screen.getByText('CPU').previousSibling.textContent).toBe('—');  // CPU sin dato
  });

  it('una caída sostenida 6 s levanta el cartel; un parpadeo no; se va apenas vuelve', async () => {
    vivo.snap = { ...SNAP, health: { ari: false, ami: true, db: true } };
    const { rerender } = renderNG(<Resumen />);
    await waitFor(() => expect(screen.getAllByText('Caído').length).toBe(1));
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText(/componente caído/)).toBeNull();
    // vuelve antes de los 6 s: nunca hubo cartel
    vivo.snap = SNAP; rerender(<Resumen />);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText(/componente caído/)).toBeNull();
    // ahora se cae y se sostiene
    vivo.snap = { ...SNAP, health: { ari: false, ami: true, db: true } }; rerender(<Resumen />);
    act(() => { vi.advanceTimersByTime(6100); });
    expect(screen.getByText('Hay un componente caído')).toBeTruthy();
    expect(screen.getByText(/\(10\.0\.0\.2\) — no responde/)).toBeTruthy();
    vivo.snap = SNAP; rerender(<Resumen />);
    expect(screen.queryByText(/componente caído/)).toBeNull();
  });

  it('varios caídos medidos: topología, proxy por /system, TURN privado y un SBC-NG externo', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({
      'GET /topology': { componentes: [{ id: 'asterisk', estado: 'ok' }, { id: 'db', estado: 'caido' }], nodes: {}, bordes_externos: [{ nombre: 'borde1', estado: 'caido', host: '1.2.3.4', motivo: 'sin respuesta' }, { nombre: 'borde2', estado: 'ok', host: '5.6.7.8' }] },
      'GET /system': { components: [{ name: 'Proxy NPM', status: 'down' }] },
      'GET /turn/estado': { deseado: true, corriendo: false, host: 'turn.local', origen: 'propio', motivo: 'candidato privado' },
      'GET /security': { kpis: {}, ataque: { pais: 'CN' } },
      'GET /trunks': [{ name: 'a', status: 'offline' }, { name: 'b', status: 'offline' }],
    })));
    renderNG(<Resumen />);
    await waitFor(() => expect(screen.getAllByText('Caído').length).toBe(4));
    // los pedidos terminan de llegar en distinto orden: se da margen de sobra a la ventana de 6 s
    act(() => { vi.advanceTimersByTime(6100); });
    act(() => { vi.advanceTimersByTime(6100); });
    expect(screen.getByText('Hay 4 componentes caídos')).toBeTruthy();
    expect(screen.getByText(/— encendido, pero el servicio no responde — candidato privado/)).toBeTruthy();
    expect(screen.getByText(/\(1\.2\.3\.4\) — sin respuesta/)).toBeTruthy();
    expect(screen.getByText(/es otro producto/)).toBeTruthy();
    expect(screen.getByText('SBC-NG (borde2)')).toBeTruthy();
    expect(kpi('IP bloqueadas').textContent).toContain('Ataque en curso');
    expect(kpi('Troncales activas').textContent).toContain('2 caídas');
    expect(screen.getByTestId('globo').textContent).toContain('ataque');
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);              // sin IP medida
  });

  it('el proxy sin medición de topología se juzga por /system; un TURN de otro lado que responde está bien', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({
      'GET /topology': { componentes: [], nodes: {} },
      'GET /system': { components: [{ name: 'Proxy NPM', status: 'up' }] },
      'GET /turn/estado': { local: false, corriendo: true },
      'GET /system/overview': { nodes: [{ id: 'core', cpu_pct: 5 }] },
    })));
    vivo.snap = { ...SNAP, extensions: [{ id: 1, status: 'online' }], queues: [{}, {}] };
    renderNG(<Resumen />);
    await waitFor(() => expect(screen.getAllByText('Operativo').length).toBe(4));
    expect(screen.getByText('Relay de medios (TURN)').nextSibling.textContent).toBe('—');
    expect(kpi('Llamadas activas').textContent).toContain('2 colas');
    expect(kpi('Extensiones en línea').textContent).toContain('de 1');
    expect(screen.getAllByText('0%').length).toBe(2);
  });

  it('el proxy sin dato en ningún lado no opina; sin /system todavía, espera', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /topology': { componentes: [{ id: 'asterisk', estado: 'ok' }] }, 'GET /system': {} })));
    renderNG(<Resumen />);
    await waitFor(() => expect(screen.getAllByText('Operativo').length).toBe(4));
  });

  it('la serie de CPU/memoria suma un punto por medición y descarta las de CPU nula', async () => {
    let n = 0;
    const serie = [{ id: 'core', cpu_pct: 10, mem_total_mb: 100, mem_used_mb: 50 }, { id: 'core', cpu_pct: null }, { id: 'core', cpu_pct: 120, mem_total_mb: 100, mem_used_mb: 10 }];
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /system/overview': () => ({ nodes: [serie[Math.min(n++, 2)]] }) })));
    const { container } = renderNG(<Resumen />);
    await waitFor(() => expect(container.querySelector('path[stroke="#4f7fd9"]').getAttribute('d')).toMatch(/^M0\.0 /));
    const d1 = container.querySelector('path[stroke="#4f7fd9"]').getAttribute('d');
    await act(async () => { vi.advanceTimersByTime(30000); });
    await act(async () => { vi.advanceTimersByTime(30000); });
    await waitFor(() => expect(container.querySelector('path[stroke="#4f7fd9"]').getAttribute('d')).not.toBe(d1));
    // 2 puntos (10 y 120 topeado en 100), no 3: la medición nula no dibuja un valle
    const d = container.querySelector('path[stroke="#4f7fd9"]').getAttribute('d');
    expect(d.split(' L').length).toBe(2);
    expect(d).toContain('L320.0 4.0');
  });
});
