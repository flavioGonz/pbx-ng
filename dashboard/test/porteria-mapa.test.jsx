/* Mapa de llamadas (app/mapa/page.jsx).
 *
 * Qué se fija: Leaflet se carga de la propia central (/vendor/leaflet, no de un CDN: una
 * central sin salida a internet quedaba con el mapa en blanco), se dibuja UN marcador por
 * extensión con su última ubicación, tocar el marcador abre el historial de esa extensión
 * con la dirección de cada llamada, y el refresco es cada 30 s sólo con la pestaña visible
 * (dos pedidos pesados por vuelta: no tienen que correr en una pestaña olvidada).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderP, rutasFalsas } from './helpers/porteria-render';

function leafletFalso() {
  const L = { marcadores: [], mapas: [], tiles: [] };
  L.map = vi.fn(() => {
    const m = { setView: vi.fn(() => m), removeLayer: vi.fn(), fitBounds: vi.fn(() => { if (L.romperBounds) throw new Error('x'); }) };
    L.mapas.push(m); return m;
  });
  L.tileLayer = vi.fn((url) => { const t = { url, addTo: () => t }; L.tiles.push(t); return t; });
  L.layerGroup = vi.fn(() => { const g = { addTo: () => g, clearLayers: vi.fn() }; L.grupo = g; return g; });
  L.divIcon = vi.fn((o) => o);
  L.marker = vi.fn((pos, o) => { const mk = { pos, icon: o.icon, addTo: () => mk, on: (ev, fn) => { mk[ev] = fn; } }; L.marcadores.push(mk); return mk; });
  return L;
}

const AHORA = 1767225600; // segundos
const PUNTOS = [
  { ext: '1001', lat: -34.9, lng: -56.1, ts: AHORA - 100 },
  { ext: '1001', lat: -34.8, lng: -56.2, ts: AHORA },          // la más nueva de 1001 gana
  { ext: '1001', lat: -34.7, lng: -56.3, ts: AHORA - 500 },
  { ext: '1002', lat: -34.95, lng: -56.15, ts: AHORA - 50 },
  { ext: '1003', lat: null, lng: null, ts: AHORA },             // sin coordenadas: no va
  { lat: -34, lng: -56, ts: AHORA },                            // sin extensión: no va
];
const CDR = [
  { src: '1001', dst: '099123', start: '2026-01-01T10:00:00Z', billsec: 75, disposition: 'ANSWERED' },
  { src: '2000', dst: '1001', start: '2026-01-01T11:00:00Z', billsec: 5, disposition: 'NO ANSWER' },
  { src: '1001', dst: '', start: '2026-01-01T12:00:00Z', billsec: 0, disposition: 'RARO' },
  { src: '1001', dst: '3', start: '2026-01-01T12:00:00Z', billsec: null, disposition: null },
  { src: '7', dst: '8', start: '2026-01-01T12:00:00Z', billsec: 1, disposition: 'BUSY' },
];

/* Un solo Leaflet falso para todo el archivo: el módulo guarda la promesa de carga (se
 * carga una vez por pestaña, como en el navegador), así que se limpia entre pruebas en vez
 * de reemplazarlo. */
let Mapa;
const L = leafletFalso();
beforeEach(() => { L.marcadores.length = 0; L.mapas.length = 0; L.tiles.length = 0; L.romperBounds = false; });
afterEach(() => { vi.useRealTimers(); delete window.L; });

describe('Mapa · carga de Leaflet', () => {
  it('pide Leaflet a /vendor/leaflet de la central y dibuja los marcadores cuando carga', async () => {
    Mapa = (await import('../app/mapa/page')).default;
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /geo': PUNTOS, 'GET /cdr': CDR }));
    renderP(<Mapa />);
    const js = document.querySelector('script[src="/vendor/leaflet/leaflet.js"]');
    expect(js).toBeTruthy();
    expect(document.querySelector('link[href="/vendor/leaflet/leaflet.css"]')).toBeTruthy();
    window.L = L;
    await act(async () => { js.onload(); });
    await waitFor(() => expect(L.marcadores.length).toBe(2));
    expect(L.mapas[0].setView).toHaveBeenCalledWith([-34.9011, -56.1645], 11);
    // El mapa arranca en el tema del panel (oscuro).
    expect(L.tiles.some((t) => t.url.includes('dark_all'))).toBe(true);
    // Un marcador por extensión, en la ubicación más nueva.
    const m1001 = L.marcadores.find((m) => m.icon.html.includes('>1001<'));
    expect(m1001.pos).toEqual([-34.8, -56.2]);
    expect(L.mapas[0].fitBounds).toHaveBeenCalled();
    expect(screen.getByText('2')).toBeTruthy();
  });
});

describe('Mapa · con Leaflet ya cargado', () => {
  it('tocar un marcador abre el historial de esa extensión, con entrantes y salientes', async () => {
    window.L = L;
    const f = rutasFalsas({ 'GET /geo': PUNTOS, 'GET /cdr': CDR });
    vi.stubGlobal('fetch', f);
    renderP(<Mapa />);
    await waitFor(() => expect(L.marcadores.length).toBe(2));
    await waitFor(() => expect(f.de('GET', '/cdr').length).toBe(1));
    expect(f.de('GET', '/geo')[0].ruta).toBe('/geo?hours=168&limit=500');
    const m1001 = L.marcadores.find((m) => m.icon.html.includes('>1001<'));
    act(() => m1001.click());
    expect(screen.getByText('Extensión 1001')).toBeTruthy();
    expect(screen.getByText(/Últ. ubicación/)).toBeTruthy();
    expect(screen.getByText('099123')).toBeTruthy();
    expect(screen.getByText('2000')).toBeTruthy();
    expect(screen.getByText(/Atendida/)).toBeTruthy();
    expect(screen.getByText(/Sin respuesta/)).toBeTruthy();
    expect(screen.getByText(/RARO/)).toBeTruthy();
    expect(screen.getByText('1m 15s')).toBeTruthy();
    expect(screen.getAllByText('0s').length).toBe(2);
    expect(screen.queryByText('8')).toBeNull();               // llamada ajena: no aparece
    // Cerrar el panel.
    fireEvent.click(document.querySelector('.mantine-CloseButton-root'));
    expect(screen.queryByText('Extensión 1001')).toBeNull();
  });

  it('una extensión sin llamadas lo dice', async () => {
    window.L = L;
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /geo': PUNTOS, 'GET /cdr': [] }));
    renderP(<Mapa />);
    await waitFor(() => expect(L.marcadores.length).toBe(2));
    act(() => L.marcadores.find((m) => m.icon.html.includes('>1002<')).click());
    expect(screen.getByText('Sin llamadas registradas.')).toBeTruthy();
  });

  it('sin ubicaciones avisa de dónde salen, y respuestas raras no rompen nada', async () => {
    window.L = L;
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /geo': { error: 'x' }, 'GET /cdr': { error: 'y' } }));
    renderP(<Mapa />);
    expect(await screen.findByText(/Sin ubicaciones aún/)).toBeTruthy();
    expect(L.mapas[0].fitBounds).not.toHaveBeenCalled();
  });

  it('una caída de red deja el mapa vacío sin explotar', async () => {
    window.L = L;
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('red'))));
    renderP(<Mapa />);
    expect(await screen.findByText(/Sin ubicaciones aún/)).toBeTruthy();
  });

  it('si fitBounds falla (puntos degenerados) el mapa sigue', async () => {
    window.L = L;
    L.romperBounds = true;
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /geo': PUNTOS, 'GET /cdr': [] }));
    renderP(<Mapa />);
    await waitFor(() => expect(L.marcadores.length).toBe(2));
    expect(screen.getByText('Mapa de llamadas')).toBeTruthy();
  });

  it('cambiar la ventana de tiempo vuelve a pedir con esas horas; Actualizar pide de nuevo', async () => {
    window.L = L;
    const f = rutasFalsas({ 'GET /geo': [], 'GET /cdr': [] });
    vi.stubGlobal('fetch', f);
    renderP(<Mapa />);
    await waitFor(() => expect(f.de('GET', '/geo').length).toBe(1));
    fireEvent.click(screen.getByText('24 h'));
    await waitFor(() => expect(f.de('GET', '/geo').some((l) => l.ruta.startsWith('/geo?hours=24&'))).toBe(true));
    const antes = f.de('GET', '/geo').length;
    fireEvent.click(document.querySelector('.tabler-icon-refresh').closest('button'));
    await waitFor(() => expect(f.de('GET', '/geo').length).toBe(antes + 1));
  });

  it('refresca cada 30 s con la pestaña visible y no con la pestaña oculta', async () => {
    vi.useFakeTimers();
    window.L = L;
    const f = rutasFalsas({ 'GET /geo': [], 'GET /cdr': [] });
    vi.stubGlobal('fetch', f);
    const { unmount } = renderP(<Mapa />);
    await act(async () => {});
    const n = f.de('GET', '/geo').length;
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.de('GET', '/geo').length).toBe(n + 1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.de('GET', '/geo').length).toBe(n + 1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    unmount();
  });
});

describe('Mapa · Leaflet que no carga', () => {
  it('si el script falla, el panel queda en pie (sin mapa, sin excepción)', async () => {
    vi.resetModules();
    const M = (await import('../app/mapa/page')).default;
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /geo': [], 'GET /cdr': [] }));
    renderP(<M />);
    const scripts = document.querySelectorAll('script[src="/vendor/leaflet/leaflet.js"]');
    await act(async () => { scripts[scripts.length - 1].onerror(new Event('error')); });
    expect(screen.getByText('Mapa de llamadas')).toBeTruthy();
    expect(screen.queryByText(/Sin ubicaciones aún/)).toBeNull();
  });
});
