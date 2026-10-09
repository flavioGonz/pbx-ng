/* Piezas visuales compartidas: iconos animados, logo, fondo WebGL del login, insignia de
 * estado en vivo de un interno, botón «Cortar» y el reproductor de grabaciones.
 *
 * Lo que importa de cada una para el operador:
 *  · los iconos se mueven SÓLO si la cosa está viva (el movimiento es información);
 *  · la insignia de estado no puede decir «Registrado» de un interno desconectado, y la
 *    marca (DND, pausa, desvío) gana cuando el interno está libre;
 *  · «Cortar» pregunta a QUIÉN corta antes de cortar, y dice si hubo que forzar;
 *  · el reproductor baja el audio CON token (no por URL pelada), muestra el error si no
 *    puede, y la transcripción viaja por la capa de API;
 *  · el fondo WebGL no rompe el login si no hay WebGL y se frena con la pestaña oculta. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, render } from '@testing-library/react';
import { MantineProvider, useMantineColorScheme } from '@mantine/core';
import { renderNG, fetchFalso, estado, diferido } from './helpers/apps-render.jsx';
import { theme } from '../app/theme';

const notify = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../app/notify', () => notify);

import { IcoOnda, IcoCerebro, IcoNube, IcoServidor, IcoAgente } from '../app/IaIcons';
import * as NG from '../app/IconosNG';
import NotifyIconDef, { NotifyIcon, COLORS } from '../app/NotifyIcons';
import PbxLogo from '../app/PbxLogo';
import EstadoVivo, { EstiloLatido, resolverEstado, textoEstado } from '../app/EstadoVivo';
import CortarLlamada from '../app/CortarLlamada';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { notify.toast.mockReset(); });

describe('iconos de IA & Voz', () => {
  it('se animan sólo con `activo` e inyectan su CSS una única vez', () => {
    const { container } = render(<div>
      <IcoOnda activo /><IcoCerebro /><IcoNube activo size={30} /><IcoServidor /><IcoAgente activo />
    </div>);
    const svgs = container.querySelectorAll('svg.pbxng-ico');
    expect([...svgs].map((s) => s.getAttribute('data-activo'))).toEqual(['1', '0', '1', '0', '1']);
    expect(svgs[2].getAttribute('width')).toBe('30');
    expect(document.querySelectorAll('#pbxng-ia-iconos').length).toBe(1);
    render(<IcoOnda />);
    expect(document.querySelectorAll('#pbxng-ia-iconos').length).toBe(1);
  });
});

describe('iconos de los cajones (IconosNG)', () => {
  it('apagados son dibujos quietos; encendidos llevan la clase que los anima', () => {
    const { container, rerender } = render(<div>
      <NG.IcoRegistro /><NG.IcoGrabar /><NG.IcoQr /><NG.IcoTroncal /><NG.IcoLatencia nivel={0} />
      <NG.IcoPersona /><NG.IcoConexion /><NG.IcoDesvio /><NG.IcoLlave />
    </div>);
    expect(container.querySelector('.ng-vivo, .ng-onda, .ng-late, .ng-barrido, .ng-flujo')).toBeNull();
    expect([...container.querySelectorAll('line')].slice(-3).map((l) => l.getAttribute('opacity'))).toEqual(['0.25', '0.25', '0.25']);
    rerender(<div>
      <NG.IcoRegistro vivo s={30} /><NG.IcoGrabar vivo /><NG.IcoQr vivo /><NG.IcoTroncal vivo /><NG.IcoLatencia />
    </div>);
    expect(container.querySelector('.ng-vivo').getAttribute('width')).toBe('30');
    expect(container.querySelectorAll('.ng-onda').length).toBe(4);
    expect(container.querySelector('.ng-late')).toBeTruthy();
    expect(container.querySelector('.ng-barrido')).toBeTruthy();
    expect(container.querySelector('.ng-flujo').getAttribute('stroke-dasharray')).toBe('2 3');
    expect([...container.querySelectorAll('line')].slice(-3).map((l) => l.getAttribute('opacity'))).toEqual(['1', '1', '1']);
  });
});

describe('iconos de notificación', () => {
  it('cada tipo tiene su dibujo y su color; uno desconocido cae en «info»', () => {
    const tipos = ['success', 'error', 'warning', 'loading', 'action', 'ring', 'talking', 'waiting', 'hangup', 'agent', 'security', 'info'];
    const dibujos = tipos.map((k) => {
      const { container, unmount } = render(<NotifyIcon kind={k} />);
      const html = container.innerHTML; unmount();
      return html;
    });
    expect(new Set(dibujos).size).toBe(tipos.length);
    const { container } = render(<NotifyIconDef kind="loading" />);
    expect(container.querySelector('.pbx-nico-spin')).toBeTruthy();
    expect(container.querySelector('circle').getAttribute('stroke')).toBe(COLORS.info);
    const otro = render(<NotifyIcon kind="raro" />);
    expect(otro.container.innerHTML).toBe(dibujos[dibujos.length - 1]);
    const porDefecto = render(<NotifyIcon />);
    expect(porDefecto.container.innerHTML).toBe(dibujos[dibujos.length - 1]);
  });
});

describe('PbxLogo', () => {
  it('anima por defecto, puede ir quieto y con el nombre al lado', () => {
    const a = render(<PbxLogo />);
    expect(a.container.querySelector('.pbxlogo-vivo')).toBeTruthy();
    expect(screen.queryByText('PBX-NG')).toBeNull();
    a.unmount();
    const b = render(<PbxLogo animado={false} texto size={50} color="#000000" />);
    expect(b.container.querySelector('.pbxlogo-vivo')).toBeNull();
    expect(screen.getByText('PBX-NG').style.fontSize).toBe('22px');
    expect(b.container.querySelector('stop:last-child').getAttribute('stop-color')).toBe('#000000');
    expect(screen.getByRole('img', { name: 'PBX-NG' })).toBeTruthy();
  });
});

describe('EstadoVivo', () => {
  it('resolverEstado: desconectado gana siempre y las marcas sólo cuentan registrado', () => {
    expect(resolverEstado(null, { act: 'en_llamada', dnd: true })).toMatchObject({ registrado: null, act: 'desconectado', dnd: false, desvio: null, colas: [] });
    expect(resolverEstado({ status: 'online', channels: 2 }, null)).toMatchObject({ act: 'en_llamada', enLlamada: true });
    expect(resolverEstado({ status: 'in_call' }, { act: 'timbrando', colas: ['v'], desvio: 'ocupado', desvio_a: '1002' })).toMatchObject({ timbrando: true, desvio: 'ocupado', desvioA: '1002', colas: ['v'] });
    expect(resolverEstado({ status: 'online' }, { act: 'en_espera' }).enLlamada).toBe(true);
  });

  it('textoEstado arma una línea con las marcas', () => {
    expect(textoEstado({ status: 'offline' })).toBe('Desconectado');
    expect(textoEstado({ status: 'online' }, {})).toBe('Registrado');
    expect(textoEstado({ status: 'online' }, { act: 'en_llamada', dnd: true, pausa: true, desvio: 'x' })).toBe('En llamada · DND · pausado · desvío a ?');
    expect(textoEstado({ status: 'online' }, { act: 'otro', desvio: 'x', desvio_a: '1005' })).toBe('Registrado · desvío a 1005');
  });

  it('libre: la marca reemplaza a «Registrado» (DND > pausa > desvío)', () => {
    const casos = [
      [{}, 'Registrado'],
      [{ dnd: true, pausa: true }, 'No molestar'],
      [{ pausa: true, pausa_motivo: 'almuerzo', colas: ['ventas', 'soporte'] }, 'Pausado'],
      [{ pausa: true }, 'Pausado'],
      [{ desvio: 'sigueme', desvio_a: '1009' }, 'Sígueme'],
      [{ desvio: 'nuevo' }, 'Desviado'],
    ];
    for (const [st, txt] of casos) {
      const { unmount } = renderNG(<EstadoVivo e={{ status: 'online' }} st={st} />);
      expect(screen.getByText(txt)).toBeTruthy();
      unmount();
    }
  });

  it('ocupado: la actividad manda y las marcas van como insignias chicas al lado', () => {
    renderNG(<><EstiloLatido /><EstadoVivo e={{ status: 'online' }} st={{ act: 'en_llamada_timbrando', dnd: true, pausa: true, pausa_motivo: 'baño', desvio: 'incondicional', desvio_a: '1003' }} size="lg" /></>);
    expect(screen.getByText('En llamada + otra')).toBeTruthy();
    expect(screen.getByText('DND')).toBeTruthy();
    expect(screen.getByText('Pausa')).toBeTruthy();
    expect(screen.getByText('1003')).toBeTruthy();
    expect(document.querySelector('style').textContent).toContain('pbxng-latido');
  });

  it('desvío sin destino y pausa sin motivo se muestran igual; timbrando late; actividad desconocida cae en desconectado', () => {
    const a = renderNG(<EstadoVivo e={{ status: 'online' }} st={{ act: 'timbrando', pausa: true, desvio: 'raro' }} />);
    expect(screen.getByText('Timbrando')).toBeTruthy();
    expect(screen.getByText('desvío')).toBeTruthy();
    expect(a.container.innerHTML).toContain('pbxng-latido 1s');
    a.unmount();
    renderNG(<EstadoVivo e={{ status: 'online' }} st={{ act: 'inventado' }} />);
    expect(screen.getByText('Desconectado')).toBeTruthy();
  });
});

describe('CortarLlamada', () => {
  let f;
  beforeEach(() => {
    f = fetchFalso({ 'POST /calls/canal%2F1/hangup': { via: 'ari' }, 'POST /calls/c2/hangup': { via: 'ami' }, 'POST /calls/c3/hangup': estado(404, { error: 'La llamada ya terminó' }), 'POST /calls/c4/hangup': null });
    vi.stubGlobal('fetch', f);
  });

  it('sin id no se puede cortar', () => {
    renderNG(<CortarLlamada />);
    expect(screen.getByRole('button', { name: 'Cortar' }).disabled).toBe(true);
  });

  it('pregunta a quién corta; cancelar no corta nada', async () => {
    renderNG(<CortarLlamada id="canal/1" quien="1001" canal="PJSIP/1001-0001" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cortar' }));
    expect(await screen.findByText('Cortar la llamada de 1001')).toBeTruthy();
    expect(screen.getByText('PJSIP/1001-0001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Cortar la llamada de 1001')).toBeNull());
    // Escape también cierra sin cortar
    fireEvent.click(screen.getByRole('button', { name: 'Cortar' }));
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Cortar la llamada de 1001')).toBeNull());
    expect(f.llamadas.length).toBe(0);
  });

  it('corta con el id escapado, avisa y llama a onHecho', async () => {
    const onHecho = vi.fn();
    renderNG(<CortarLlamada id="canal/1" quien="1001" onHecho={onHecho} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cortar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cortar llamada' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Llamada cortada', 'ok'));
    expect(f.de('POST', '/calls/canal%2F1/hangup').length).toBe(1);
    expect(onHecho).toHaveBeenCalled();
  });

  it('si hubo que forzarla por AMI lo dice; sin onHecho no rompe', async () => {
    renderNG(<CortarLlamada id="c2" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cortar' }));
    expect(await screen.findByText('Cortar la llamada de este canal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cortar llamada' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Llamada cortada (hubo que forzarla)', 'ok'));
  });

  it('una respuesta vacía también es «cortada»; un error queda en el modal', async () => {
    const a = renderNG(<CortarLlamada id="c4" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cortar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cortar llamada' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Llamada cortada', 'ok'));
    a.unmount();
    renderNG(<CortarLlamada id="c3" quien="1002" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cortar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cortar llamada' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('La llamada ya terminó', 'bad'));
    expect(screen.getByText('Cortar la llamada de 1002')).toBeTruthy();
  });
});

/* ── Fondo WebGL ─────────────────────────────────────────────────────────── */
function glFalso({ compila = true, enlaza = true } = {}) {
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, BLEND: 8, SRC_ALPHA: 9, ONE_MINUS_SRC_ALPHA: 10, TRIANGLES: 11,
    uniformes: {},
  };
  for (const m of ['createShader', 'shaderSource', 'compileShader', 'deleteShader', 'createProgram', 'attachShader', 'linkProgram', 'useProgram', 'createBuffer', 'bindBuffer', 'bufferData', 'enableVertexAttribArray', 'vertexAttribPointer', 'enable', 'blendFunc', 'viewport', 'drawArrays']) gl[m] = vi.fn(() => ({}));
  gl.getShaderParameter = vi.fn(() => compila);
  gl.getProgramParameter = vi.fn(() => enlaza);
  gl.getAttribLocation = vi.fn(() => 0);
  gl.getUniformLocation = vi.fn((p, n) => n);
  for (const m of ['uniform1f', 'uniform2f', 'uniform3fv']) gl[m] = vi.fn((loc, ...v) => { gl.uniformes[loc] = v.length === 1 ? v[0] : v; });
  const perder = vi.fn();
  gl.getExtension = vi.fn(() => ({ loseContext: perder }));
  gl.perder = perder;
  return gl;
}

describe('ShaderPuntos', () => {
  let ShaderPuntos; let raf; let reducido;
  beforeEach(async () => {
    ShaderPuntos = (await import('../app/ShaderPuntos')).default;
    raf = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb) => { raf.push(cb); return raf.length; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    reducido = false;
    vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({ matches: reducido && q.includes('reduced'), media: q, addEventListener() {}, removeEventListener() {} }));
  });
  afterEach(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });

  const ctx = (gl) => vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => gl);

  it('sin WebGL queda el fondo liso (y no explota si getContext tira)', () => {
    ctx(null);
    const a = render(<ShaderPuntos fondo="#123456" />);
    expect(a.container.querySelector('canvas').style.background).toBe('rgb(18, 52, 86)');
    a.unmount();
    HTMLCanvasElement.prototype.getContext.mockImplementation(() => { throw new Error('nope'); });
    render(<ShaderPuntos />);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('si el shader no compila o el programa no enlaza, no dibuja', () => {
    const g1 = glFalso({ compila: false }); ctx(g1);
    const a = render(<ShaderPuntos />);
    expect(g1.deleteShader).toHaveBeenCalled();
    expect(g1.linkProgram).not.toHaveBeenCalled();
    a.unmount();
    const g2 = glFalso({ enlaza: false }); ctx(g2);
    render(<ShaderPuntos />);
    expect(g2.useProgram).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('dibuja en bucle, sigue al puntero, se frena con la pestaña oculta y limpia al desmontar', () => {
    const gl = glFalso(); ctx(gl);
    const { unmount, container } = render(<ShaderPuntos colorA="#ff0000" colorB="nada" />);
    expect(gl.uniformes.uColA).toEqual([1, 0, 0]);
    expect(gl.uniformes.uColB).toEqual([0.62, 0.71, 1.0]);
    expect(gl.uniformes.uPaso).toBe(21);
    raf.shift()(1000);
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(gl.uniformes.uT).toBe(1);
    expect(gl.uniformes.uMouse).toEqual([-1, -1]);
    container.querySelector('canvas').getBoundingClientRect = () => ({ left: 10, top: 20, height: 100, width: 100 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 40 }));
    raf.shift()(2000);
    expect(gl.uniformes.uMouse).toEqual([20, 80]);
    window.dispatchEvent(new Event('pointerleave'));
    raf.shift()(3000);
    expect(gl.uniformes.uMouse).toEqual([-1, -1]);
    // pestaña oculta: se corta el bucle; el cuadro que ya estaba pedido no dibuja
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cancelAnimationFrame).toHaveBeenCalled();
    const antes = gl.drawArrays.mock.calls.length;
    raf.shift()(4000);
    expect(gl.drawArrays.mock.calls.length).toBe(antes);
    // vuelve: retoma
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(raf.length).toBe(1);
    // volver a "visible" estando vivo no duplica el bucle
    document.dispatchEvent(new Event('visibilitychange'));
    expect(raf.length).toBe(1);
    unmount();
    expect(gl.perder).toHaveBeenCalled();
  });

  it('con «reducir movimiento» pinta un único cuadro, y lo repinta al cambiar de tamaño', () => {
    reducido = true;
    let alMedir;
    vi.stubGlobal('ResizeObserver', class { constructor(cb) { alMedir = cb; } observe() {} disconnect() {} });
    const gl = glFalso(); ctx(gl);
    render(<ShaderPuntos />);
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    alMedir();
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);
    // ni al volver la pestaña arranca el bucle
    document.dispatchEvent(new Event('visibilitychange'));
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('sin ResizeObserver mide con `resize`; si matchMedia falla, anima igual', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    window.matchMedia.mockImplementation(() => { throw new Error('viejo'); });
    const gl = glFalso(); ctx(gl);
    gl.getExtension = vi.fn(() => { throw new Error('sin extensión'); });
    const add = vi.spyOn(window, 'addEventListener');
    const rem = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<ShaderPuntos />);
    expect(add.mock.calls.some(([ev]) => ev === 'resize')).toBe(true);
    expect(requestAnimationFrame).toHaveBeenCalled();
    window.dispatchEvent(new Event('resize'));
    expect(gl.viewport).toHaveBeenCalledTimes(2);
    unmount();
    expect(rem.mock.calls.some(([ev]) => ev === 'resize')).toBe(true);
  });

  it('con devicePixelRatio alto lo topea en 2 y redimensiona el lienzo', () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const gl = glFalso(); ctx(gl);
    vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(50);
    render(<ShaderPuntos />);
    expect(gl.uniformes.uPix).toBe(2);
    expect(gl.uniformes.uRes).toEqual([200, 100]);
  });
});

/* ── Reproductor de grabaciones ─────────────────────────────────────────── */
function wsFalso() {
  const inst = { h: {}, on: vi.fn((ev, cb) => { inst.h[ev] = cb; }), getDuration: () => 65, playPause: vi.fn(), setPlaybackRate: vi.fn(), setVolume: vi.fn(), setOptions: vi.fn(), destroy: vi.fn() };
  const WS = { create: vi.fn((o) => { WS.opts = o; return inst; }), inst };
  return WS;
}
const audioOk = () => new Response(new Blob(['RIFF']), { status: 200, headers: { 'content-type': 'audio/wav' } });

function ConTema({ children }) {
  return <MantineProvider theme={theme} defaultColorScheme="dark" env="test">{children}<Cambiar /></MantineProvider>;
}
function Cambiar() { const { setColorScheme } = useMantineColorScheme(); return <button type="button" onClick={() => setColorScheme('light')}>claro</button>; }

describe('RecordingPlayer', () => {
  let RecordingPlayer; let f;
  beforeEach(async () => {
    RecordingPlayer = (await import('../app/RecordingPlayer')).default;
    f = fetchFalso({ '/backend/api/recordings/7/audio': audioOk, '/backend/api/recordings/8/audio': estado(401) });
    vi.stubGlobal('fetch', f);
    URL.createObjectURL = vi.fn(() => 'blob:rec');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => { delete window.WaveSurfer; });

  it('baja el audio con fetch (token del parche) y arma la onda y la descarga con el blob', async () => {
    const WS = wsFalso(); window.WaveSurfer = WS;
    const { container, unmount } = render(<RecordingPlayer src="/backend/api/recordings/7/audio" label="Grab 7" />, { wrapper: ConTema });
    await waitFor(() => expect(WS.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:rec' })));
    expect(f.llamadas[0].url).toBe('/backend/api/recordings/7/audio');
    expect(WS.opts.waveColor).toBe('#3d4d68');
    const bajar = container.querySelector('a[download]');
    expect(bajar.getAttribute('href')).toBe('blob:rec');
    expect(bajar.getAttribute('download')).toBe('Grab 7.wav');
    expect(screen.getByText('Grab 7')).toBeTruthy();
    await act(async () => { WS.inst.h.ready(); });
    expect(screen.getByText('01:05')).toBeTruthy();
    await act(async () => { WS.inst.h.timeupdate(12.7); WS.inst.h.play(); });
    expect(screen.getByText('00:12')).toBeTruthy();
    expect(container.querySelector('.tabler-icon-player-pause')).toBeTruthy();
    await act(async () => { WS.inst.h.pause(); });
    expect(container.querySelector('.tabler-icon-player-play')).toBeTruthy();
    await act(async () => { WS.inst.h.play(); WS.inst.h.finish(); });
    expect(container.querySelector('.tabler-icon-player-play')).toBeTruthy();
    fireEvent.click(container.querySelector('.tabler-icon-player-play').closest('button'));
    expect(WS.inst.playPause).toHaveBeenCalled();
    fireEvent.click(screen.getByText('1.5x'));
    expect(WS.inst.setPlaybackRate).toHaveBeenCalledWith(1.5, true);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });
    expect(WS.inst.setVolume).toHaveBeenCalledWith(0.99);
    // cambiar a claro recolorea la onda sin rearmarla
    fireEvent.click(screen.getByRole('button', { name: 'claro' }));
    await waitFor(() => expect(WS.inst.setOptions).toHaveBeenCalledWith({ waveColor: '#b9c6da', cursorColor: '#1e293b' }));
    unmount();
    expect(WS.inst.destroy).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:rec');
  });

  it('si la onda falla se ve el error y el botón queda deshabilitado; los controles no explotan sin instancia', async () => {
    const WS = wsFalso(); window.WaveSurfer = WS;
    WS.inst.playPause.mockImplementation(() => { throw new Error('x'); });
    WS.inst.setPlaybackRate.mockImplementation(() => { throw new Error('x'); });
    WS.inst.setVolume.mockImplementation(() => { throw new Error('x'); });
    WS.inst.destroy.mockImplementation(() => { throw new Error('x'); });
    WS.inst.setOptions.mockImplementation(() => { throw new Error('x'); });
    const { container, unmount } = render(<RecordingPlayer src="/backend/api/recordings/7/audio" download={false} />, { wrapper: ConTema });
    await waitFor(() => expect(WS.create).toHaveBeenCalled());
    fireEvent.click(container.querySelector('.tabler-icon-player-play').closest('button'));
    fireEvent.click(screen.getByText('2x'));
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });
    fireEvent.click(screen.getByRole('button', { name: 'claro' }));
    expect(container.querySelector('a[download]')).toBeNull();
    await act(async () => { WS.inst.h.error(); });
    expect(screen.getByText('No se pudo cargar el audio.')).toBeTruthy();
    expect(container.querySelector('.tabler-icon-player-play').closest('button').disabled).toBe(true);
    unmount();
  });

  it('sin acceso al audio (401) la descarga queda sin enlace; sin src no pide nada', async () => {
    const WS = wsFalso(); window.WaveSurfer = WS;
    const a = render(<RecordingPlayer src="/backend/api/recordings/8/audio" />, { wrapper: ConTema });
    await waitFor(() => expect(f.llamadas.length).toBe(1));
    await waitFor(() => expect(WS.create).toHaveBeenCalled());
    expect(a.container.querySelector('a[download]').getAttribute('href')).toBeNull();
    expect(a.container.querySelector('a[download]').getAttribute('download')).toBe('grabacion.wav');
    a.unmount();
    render(<RecordingPlayer />, { wrapper: ConTema });
    expect(f.llamadas.length).toBe(1);
  });

  it('si se desmonta antes de que llegue el audio, no crea un blob huérfano', async () => {
    const d = diferido();
    vi.stubGlobal('fetch', vi.fn(() => d.promise));
    window.WaveSurfer = wsFalso();
    const { unmount } = render(<RecordingPlayer src="/x" />, { wrapper: ConTema });
    unmount();
    await act(async () => { d.resolve(audioOk()); });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    const d2 = diferido();
    vi.stubGlobal('fetch', vi.fn(() => d2.promise));
    const b = render(<RecordingPlayer src="/y" />, { wrapper: ConTema });
    b.unmount();
    await act(async () => { d2.reject(new Error('corte')); });
  });

  it('muestra la transcripción guardada con su análisis', async () => {
    window.WaveSurfer = wsFalso();
    f = fetchFalso({ 'GET /recordings/5/transcript': { transcript: 'hola qué tal', analysis: { sentiment: 'negativo', conflict: true, keywords: ['precio', 'baja'], words: 120, wpm: 140, flags: ['insulto'] } } });
    vi.stubGlobal('fetch', f);
    render(<RecordingPlayer recId={5} />, { wrapper: ConTema });
    expect(await screen.findByText('hola qué tal')).toBeTruthy();
    expect(screen.getByText('Negativo')).toBeTruthy();
    expect(screen.getByText('Posible discusion')).toBeTruthy();
    expect(screen.getByText('precio')).toBeTruthy();
    expect(screen.getByText('120 palabras - 140 ppm')).toBeTruthy();
    expect(screen.getByText('insulto')).toBeTruthy();
  });

  it('sin transcripción ofrece transcribir; el resultado (o el error) se muestra', async () => {
    window.WaveSurfer = wsFalso();
    const d = diferido();
    let n = 0;
    f = fetchFalso({
      'GET /recordings/6/transcript': { transcript: null },
      'POST /recordings/6/transcribe': () => { n++; if (n === 1) return d.promise; if (n === 2) return { analysis: { sentiment: 'otro' } }; if (n === 3) return estado(502, { error: 'Whisper caído' }); return null; },
    });
    vi.stubGlobal('fetch', f);
    render(<RecordingPlayer recId={6} />, { wrapper: ConTema });
    await waitFor(() => expect(f.de('GET', '/recordings/6/transcript').length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: /Transcribir y analizar/ }));
    expect(await screen.findByText('Transcribiendo con Whisper...')).toBeTruthy();
    await act(async () => { d.resolve({ transcript: 'buen día', analysis: { sentiment: 'positivo', keywords: [] } }); });
    expect(await screen.findByText('buen día')).toBeTruthy();
    expect(screen.getByText('Positivo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Reanalizar/ }));
    expect(await screen.findByText('(sin habla detectada)')).toBeTruthy();
    expect(screen.getByText('Neutral')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Reanalizar/ }));
    expect(await screen.findByText('No se pudo transcribir: Whisper caído')).toBeTruthy();
    expect(screen.queryByText('Neutral')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reanalizar/ }));
    expect(await screen.findByText('(sin habla detectada)')).toBeTruthy();
  });

  it('si la transcripción guardada llega tarde o falla, no rompe', async () => {
    window.WaveSurfer = wsFalso();
    const d = diferido();
    vi.stubGlobal('fetch', fetchFalso({ 'GET /recordings/9/transcript': () => d.promise, 'GET /recordings/10/transcript': estado(404) }));
    const a = render(<RecordingPlayer recId={9} />, { wrapper: ConTema });
    a.unmount();
    await act(async () => { d.resolve({ transcript: 'tarde' }); });
    render(<RecordingPlayer recId={10} />, { wrapper: ConTema });
    expect(await screen.findByRole('button', { name: /Transcribir y analizar/ })).toBeTruthy();
  });

  it('carga wavesurfer desde la central (no de un CDN) y, si el script no carga, lo dice', async () => {
    vi.resetModules();
    const RP = (await import('../app/RecordingPlayer')).default;
    const a = render(<RP />, { wrapper: ConTema });
    const s = document.head.querySelector('script[src="/vendor/wavesurfer/wavesurfer.min.js"]');
    expect(s).toBeTruthy();
    const WS = wsFalso();
    window.WaveSurfer = WS;
    await act(async () => { s.onload(); });
    expect(WS.create).toHaveBeenCalled();
    a.unmount();
    s.remove();
    delete window.WaveSurfer;
    vi.resetModules();
    const RP2 = (await import('../app/RecordingPlayer')).default;
    render(<RP2 />, { wrapper: ConTema });
    const s2 = document.head.querySelector('script[src="/vendor/wavesurfer/wavesurfer.min.js"]');
    await act(async () => { s2.onerror(new Event('error')); });
    expect(await screen.findByText('No se pudo cargar el audio.')).toBeTruthy();
    s2.remove();
  });

  it('si el componente se desmonta antes de que cargue wavesurfer, no crea la onda', async () => {
    const d = diferido();
    const WS = wsFalso();
    window.WaveSurfer = WS;
    const { unmount } = render(<RecordingPlayer />, { wrapper: ConTema });
    unmount();
    await act(async () => { await Promise.resolve(); d.resolve(); });
    expect(WS.create).not.toHaveBeenCalled();
  });
});
