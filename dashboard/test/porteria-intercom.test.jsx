/* La pared de video de Portería (app/Intercom.jsx).
 *
 * Qué se fija acá y por qué le importa al operador:
 *  - Una cámara que no responde NO cuelga el recuadro: a los 12 s pasa a «Sin señal» con el
 *    motivo y un botón de reintentar. Sin ese reloj el tile quedaba en «CARGANDO» para siempre.
 *  - El caño a go2rtc lleva la entrada de un solo uso (`t=`) cuando la API la da, y se abre
 *    igual sin ella (instalaciones con go2rtc publicado por afuera).
 *  - Salir de la pantalla CIERRA el WebSocket: el video es pesado y una pared olvidada en
 *    tres pestañas es tráfico y CPU del appliance para nadie.
 *  - Cada falla dice por qué (sin canal, códec, go2rtc cortó, error de go2rtc).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import Intercom from '../app/Intercom';
import { renderP, rutasFalsas, instalarVideoFalso, estado } from './helpers/porteria-render';

let video;
beforeEach(() => {
  video = instalarVideoFalso();
  window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});
afterEach(() => { video.restaurar(); vi.useRealTimers(); });

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function abrirCaño(i = 0) {
  await act(async () => { await video.fuentes[i].abrir(); });
  return video.sockets[video.sockets.length - 1];
}

describe('Intercom · sin dispositivos', () => {
  it('muestra el recuadro de espera con la pista por defecto', () => {
    renderP(<Intercom />);
    expect(screen.getByText(/aparecerá acá durante la llamada/)).toBeTruthy();
  });
  it('usa la pista que le pasa la pantalla y arma la grilla con varias columnas', () => {
    renderP(<Intercom streams={[]} columns={2} bare emptyHint="Agregá un portero" />);
    expect(screen.getByText('Agregá un portero')).toBeTruthy();
    const pared = screen.getByText('Agregá un portero').parentElement.parentElement;
    expect(pared.style.display).toBe('grid');
    expect(pared.style.gridTemplateColumns).toBe('repeat(2,1fr)');
    expect(pared.style.height).toBe('100%');
  });
});

describe('Intercom · un portero en vivo', () => {
  it('pide la entrada, abre el WebSocket con ella, negocia códecs y pasa a EN VIVO', async () => {
    const f = rutasFalsas({ 'GET /intercom/ticket': { ticket: 'abc 1' } });
    vi.stubGlobal('fetch', f);
    renderP(<Intercom streams={[{ id: 7, label: 'Puerta calle', type: 'intercom', base: 'https://central.local/camaras/', src: 'cli_7' }]} />);
    expect(screen.getByText('CARGANDO')).toBeTruthy();
    expect(screen.getByText('Puerta calle')).toBeTruthy();
    const ws = await abrirCaño();
    expect(f.llamadas[0].ruta).toBe('/intercom/ticket?src=cli_7');
    expect(ws.url).toBe('wss://central.local/camaras/api/ws?src=cli_7&t=abc%201');
    act(() => ws.onopen());
    const neg = JSON.parse(ws.enviados[0]);
    expect(neg.type).toBe('mse');
    expect(neg.value).toContain('avc1.640029');
    // go2rtc contesta con el tipo: se crea el buffer y el recuadro pasa a vivo.
    act(() => ws.onmessage({ data: JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' }) }));
    expect(screen.getByText('EN VIVO')).toBeTruthy();
    const sb = video.fuentes[0].buffers[0];
    expect(sb.mode).toBe('segments');
    // Los segmentos binarios se encolan y se apenden de a uno.
    act(() => ws.onmessage({ data: new Uint8Array([1, 2, 3]).buffer }));
    expect(sb.appended.length).toBe(1);
    sb.updating = true;
    act(() => ws.onmessage({ data: new Uint8Array([4]).buffer }));
    expect(sb.appended.length).toBe(1);
    // Con más de 80 en cola se descartan los viejos en vez de crecer sin techo.
    for (let i = 0; i < 85; i++) ws.onmessage({ data: new Uint8Array([i]).buffer });
    sb.updating = false;
    // Al terminar un append: se recorta lo viejo y se manda el siguiente.
    sb.buffered = { length: 1, start: () => 0, end: () => 30 };
    act(() => sb.l.updateend());
    expect(sb.removidos[0]).toEqual([0, 22]);
    expect(sb.appended.length).toBe(2);
    // Un mensaje de texto que no es JSON se ignora sin romper nada.
    act(() => ws.onmessage({ data: 'no-json' }));
    expect(screen.getByText('EN VIVO')).toBeTruthy();
  });

  it('el botón de audio alterna silenciar / activar', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /intercom/ticket': { ticket: 't' } }));
    renderP(<Intercom streams={[{ id: 1, label: 'Cam', type: 'camera', base: 'http://x', src: 's' }]} />);
    const ws = await abrirCaño();
    act(() => ws.onmessage({ data: JSON.stringify({ type: 'mse', value: 'video/mp4' }) }));
    fireEvent.click(screen.getByTitle('Activar audio'));
    expect(screen.getByTitle('Silenciar')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Silenciar'));
    expect(screen.getByTitle('Activar audio')).toBeTruthy();
  });

  it('sin entrada (la API no la da o falla) abre el caño igual, sin `t=`', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /intercom/ticket': estado(403, { error: 'no' }) }));
    renderP(<Intercom streams={[{ id: 1, label: 'Cam', base: 'http://x/', src: 's1' }]} />);
    const ws = await abrirCaño();
    expect(ws.url).toBe('ws://x/api/ws?src=s1');
  });

  it('si el pedido de entrada se cae por red, también abre sin ella', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('red'))));
    renderP(<Intercom streams={[{ id: 1, label: 'Cam', base: 'http://x', src: 's1' }]} />);
    const ws = await abrirCaño();
    expect(ws.url).toBe('ws://x/api/ws?src=s1');
  });

  it('sin dirección configurada usa el /camaras del propio equipo', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /intercom/ticket': {} }));
    renderP(<Intercom streams={[{ id: 1, label: 'Cam', src: 's1' }]} />);
    const ws = await abrirCaño();
    expect(ws.url).toBe(window.location.origin.replace(/^http/, 'ws') + '/camaras/api/ws?src=s1');
  });
});

describe('Intercom · degradar en vez de colgarse', () => {
  it('una cámara que no responde pasa a «Sin señal» a los 12 s, con el motivo', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /intercom/ticket': { ticket: 't' } }));
    renderP(<Intercom streams={[{ id: 1, label: 'Lenta', base: 'http://x', src: 's' }]} />);
    expect(screen.getByText('CARGANDO')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(12000); });
    expect(screen.getByText('Sin señal')).toBeTruthy();
    expect(screen.getByText('OFFLINE')).toBeTruthy();
    expect(screen.getByText('la cámara no respondió en 12 segundos')).toBeTruthy();
  });

  it('Reintentar vuelve a abrir el caño y el primer motivo no se pisa con otro', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /intercom/ticket': { ticket: 't' } }));
    renderP(<Intercom streams={[{ id: 1, label: 'Cam', base: 'http://x', src: 's' }]} />);
    const ws = await abrirCaño();
    act(() => ws.onmessage({ data: JSON.stringify({ type: 'error', value: 'dial tcp: i/o timeout' }) }));
    act(() => ws.onclose());
    expect(screen.getByText('dial tcp: i/o timeout')).toBeTruthy();
    fireEvent.click(screen.getByText('Reintentar'));
    expect(ws.cerrado).toBe(true);
    expect(screen.getByText('CARGANDO')).toBeTruthy();
    expect(video.fuentes.length).toBe(2);
  });

  it('error de go2rtc sin texto, caída del socket y códec no soportado dicen su motivo', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /intercom/ticket': { ticket: 't' } }));
    const s = [
      { id: 1, label: 'A', base: 'http://x', src: 'a' },
      { id: 2, label: 'B', base: 'http://x', src: 'b' },
      { id: 3, label: 'C', base: 'http://x', src: 'c' },
    ];
    renderP(<Intercom streams={s} columns={3} />);
    const a = await abrirCaño(0);
    const b = await abrirCaño(1);
    video.fuentes[2].fallarCodec = true;
    const c = await abrirCaño(2);
    act(() => a.onmessage({ data: JSON.stringify({ type: 'error' }) }));
    act(() => b.onerror());
    act(() => c.onmessage({ data: JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="hev"' }) }));
    expect(screen.getByText('go2rtc no pudo abrir el stream')).toBeTruthy();
    expect(screen.getByText('no se pudo conectar con go2rtc')).toBeTruthy();
    expect(screen.getByText('el navegador no soporta el códec de esta cámara')).toBeTruthy();
  });

  it('si no se puede crear el WebSocket queda en Sin señal', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /intercom/ticket': { ticket: 't' } }));
    video.WebSocketFalso.romper = true;
    renderP(<Intercom streams={[{ id: 1, label: 'Cam', base: 'http://x', src: 's' }]} />);
    await abrirCaño();
    expect(screen.getByText('Sin señal')).toBeTruthy();
  });

  it('un dispositivo sin canal asignado lo dice, sin abrir nada', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderP(<Intercom streams={[{ id: 1, label: 'Sin canal', base: 'http://x' }]} />);
    expect(screen.getByText('el dispositivo no tiene canal asignado')).toBeTruthy();
    expect(video.fuentes.length).toBe(0);
  });

  it('un navegador sin MediaSource lo dice en el recuadro', () => {
    video.restaurar();
    const prev = globalThis.MediaSource;
    delete globalThis.MediaSource;
    renderP(<Intercom streams={[{ id: 1, src: 's' }]} />);
    expect(screen.getByText('el navegador no puede reproducir este video')).toBeTruthy();
    expect(screen.getByText('Dispositivo')).toBeTruthy();
    globalThis.MediaSource = prev;
    video = instalarVideoFalso();
  });

  it('isTypeSupported que explota no impide negociar el resto', async () => {
    video.restaurar();
    video = instalarVideoFalso({ soporta: (t) => { if (t.includes('opus')) throw new Error('x'); return t.includes('avc1.42e01e'); } });
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /intercom/ticket': { ticket: 't' } }));
    renderP(<Intercom streams={[{ id: 1, label: 'Cam', base: 'http://x', src: 's' }]} />);
    const ws = await abrirCaño();
    act(() => ws.onopen());
    expect(JSON.parse(ws.enviados[0]).value).toBe('avc1.42e01e');
  });
});

describe('Intercom · cerrar al salir', () => {
  it('desmontar cierra el WebSocket y termina el MediaSource', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /intercom/ticket': { ticket: 't' } }));
    const { unmount } = renderP(<Intercom streams={[{ id: 1, label: 'Cam', base: 'http://x', src: 's' }]} />);
    const ws = await abrirCaño();
    unmount();
    expect(ws.cerrado).toBe(true);
    expect(video.fuentes[0].terminado).toBe(true);
    // Un evento tardío del socket ya cerrado no toca un componente desmontado.
    ws.onclose();
  });

  it('si se desmonta mientras espera la entrada, no llega a abrir el socket', async () => {
    let soltar;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { soltar = r; })));
    const { unmount } = renderP(<Intercom streams={[{ id: 1, label: 'Cam', base: 'http://x', src: 's' }]} />);
    let p;
    act(() => { p = video.fuentes[0].abrir(); });
    unmount();
    soltar(new Response(JSON.stringify({ ticket: 'x' }), { status: 200 }));
    await act(async () => { await p; });
    await flush();
    expect(video.sockets.length).toBe(0);
  });
});
