/* Piezas chicas del armazón del panel: las redes de contención de errores, el aviso de
 * versión nueva, el registro del service worker, el cajón de configuración, el
 * encabezado de página y la mini forma de onda de las grabaciones. Cada una decide algo
 * que el operador ve: que un error de UNA pantalla no deje el panel en blanco, que la
 * actualización NO corte una llamada en curso, que una grabación muda diga «sin audio». */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { renderConMantine } from './helpers/nucleo-render.jsx';

const nav = vi.hoisted(() => ({ path: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
vi.mock('sileo', () => ({ Toaster: (p) => <div data-testid="toaster" data-pos={p.position} /> }));
vi.mock('slot-text/react', () => ({ SlotText: ({ text }) => <b data-testid="slot">{text}</b> }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete window.__pbxInCall; delete window.__pbxReloadPending; });

describe('error.jsx y ErrorBoundary', () => {
  it('error.jsx muestra el mensaje, reintenta el segmento y ofrece recargar', async () => {
    const { default: ErrorPagina } = await import('../app/error.jsx');
    const reset = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    renderConMantine(<ErrorPagina error={new Error('x.map no es función')} reset={reset} />);
    expect(screen.getByText('Algo se rompió en esta pantalla')).toBeTruthy();
    expect(screen.getByText('x.map no es función')).toBeTruthy();
    fireEvent.click(screen.getByText('Reintentar'));
    expect(reset).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Recargar'));
    expect(reload).toHaveBeenCalled();
  });

  it('error.jsx sin mensaje usa el texto del error, o «Error desconocido»', async () => {
    const { default: ErrorPagina } = await import('../app/error.jsx');
    vi.stubGlobal('location', { reload: () => { throw new Error('no'); } });
    const { unmount } = renderConMantine(<ErrorPagina error="cadena" reset={() => {}} />);
    expect(screen.getByText('cadena')).toBeTruthy();
    fireEvent.click(screen.getByText('Recargar'));
    unmount();
    renderConMantine(<ErrorPagina reset={() => {}} />);
    expect(screen.getByText('Error desconocido')).toBeTruthy();
  });

  it('ErrorBoundary atrapa el error, deja el resto vivo, y se rearma al cambiar de ruta o reintentar', async () => {
    const { default: ErrorBoundary } = await import('../app/ErrorBoundary.jsx');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const control = { romper: true };
    function Pantalla() { if (control.romper) throw new Error('undefined.map'); return <p>pantalla ok</p>; }
    const ui = (k) => <><nav>menú</nav><ErrorBoundary resetKey={k}><Pantalla /></ErrorBoundary></>;
    const { rerender } = renderConMantine(ui('/a'));
    expect(screen.getByText('undefined.map')).toBeTruthy();
    expect(screen.getByText('menú')).toBeTruthy();
    expect(err.mock.calls.some((c) => c[0] === '[pbxng] error de render:')).toBe(true);
    rerender(ui('/a'));
    expect(screen.getByText('undefined.map')).toBeTruthy();
    control.romper = false;
    rerender(ui('/b'));
    expect(screen.getByText('pantalla ok')).toBeTruthy();
    control.romper = true;
    rerender(ui('/c'));
    control.romper = false;
    fireEvent.click(screen.getByText('Reintentar'));
    expect(screen.getByText('pantalla ok')).toBeTruthy();
  });

  it('ErrorBoundary: recargar, error sin mensaje y consola que falla', async () => {
    const { default: ErrorBoundary } = await import('../app/ErrorBoundary.jsx');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    function Tira() { throw null; }  // eslint-disable-line no-throw-literal
    renderConMantine(<><nav>menú</nav><ErrorBoundary><Tira /></ErrorBoundary></>);
    expect(screen.getByText('Error desconocido')).toBeTruthy();
    expect(screen.getByText('menú')).toBeTruthy();
    fireEvent.click(screen.getByText('Recargar'));
    expect(reload).toHaveBeenCalled();
    vi.stubGlobal('location', { reload: () => { throw new Error('x'); } });
    fireEvent.click(screen.getByText('Recargar'));
    const inst = new ErrorBoundary({});
    console.error.mockImplementation(() => { throw new Error('consola rota'); });
    expect(() => inst.componentDidCatch(new Error('e'), null)).not.toThrow();
    // Un objeto que se imprime vacío: último recurso del mensaje.
    inst.state = { error: { message: '', toString: () => '' } };
    renderConMantine(inst.render());
    expect(screen.getAllByText('Error desconocido').length).toBe(2);
  });
});

describe('piezas de presentación', () => {
  it('loading y Skeletons muestran el mismo loader', async () => {
    const { default: Loading } = await import('../app/loading.jsx');
    const S = await import('../app/Skeletons.jsx');
    const { container } = renderConMantine(<><Loading /><S.TableSkeleton /><S.CardsSkeleton /><S.CardSkeleton /></>);
    expect(screen.getByText('Cargando…')).toBeTruthy();
    expect(container.querySelectorAll('.mantine-Loader-root').length).toBe(4);
  });

  it('PageHeader: título, subtítulo, ícono y acciones opcionales', async () => {
    const { default: PageHeader } = await import('../app/PageHeader.jsx');
    const { container, rerender } = renderConMantine(<PageHeader title="Troncales" subtitle="SIP" icon={<i>ico</i>} right={<button>Nueva</button>} color="teal" />);
    expect(screen.getByText('Troncales')).toBeTruthy();
    expect(screen.getByText('SIP')).toBeTruthy();
    expect(screen.getByText('ico')).toBeTruthy();
    expect(screen.getByText('Nueva')).toBeTruthy();
    expect(container.querySelector('.pbx-acc-bar').style.background).toContain('teal');
    rerender(<PageHeader title="Solo" />);
    expect(screen.queryByText('SIP')).toBeNull();
    expect(screen.queryByText('Nueva')).toBeNull();
  });

  it('Slot: texto plano en el primer render (igual al HTML del servidor) y animado después', async () => {
    const { default: Slot } = await import('../app/Slot.jsx');
    const { renderToString } = await import('react-dom/server');
    expect(renderToString(<Slot value={42} />)).toContain('42');
    expect(renderToString(<Slot value={42} />)).not.toContain('data-testid');
    render(<Slot value={7} />);
    expect(screen.getByTestId('slot').textContent).toBe('7');
    render(<Slot value={null} style={{ color: 'red' }} />);
    expect(screen.getAllByTestId('slot')[1].textContent).toBe('');
  });

  it('DesktopToaster: uno solo para el panel, ninguno en la PWA /phone', async () => {
    const { default: DesktopToaster } = await import('../app/desktoptoaster.jsx');
    nav.path = '/troncales';
    const { rerender } = render(<DesktopToaster />);
    expect(screen.getByTestId('toaster').dataset.pos).toBe('top-center');
    nav.path = '/phone';
    rerender(<DesktopToaster />);
    expect(screen.queryByTestId('toaster')).toBeNull();
    nav.path = null;
    rerender(<DesktopToaster />);
    expect(screen.getByTestId('toaster')).toBeTruthy();
  });

  it('theme: el color primario y la tipografía del panel', async () => {
    const { theme } = await import('../app/theme.js');
    expect(theme.primaryColor).toBe('pbx');
    expect(theme.colors.pbx).toHaveLength(10);
  });
});

describe('MiniWave', () => {
  it('pide los picos de la grabación y los dibuja como barras', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ peaks: [0, 50, 100] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { default: MiniWave } = await import('../app/MiniWave.jsx');
    const { container } = render(<MiniWave recId={9} w={30} h={10} />);
    expect(container.querySelector('div').style.width).toBe('30px');
    await waitFor(() => expect(container.querySelectorAll('rect').length).toBe(3));
    expect(fetchMock).toHaveBeenCalledWith('/backend/api/recordings/9/peaks');
    expect(container.querySelectorAll('rect')[0].getAttribute('height')).toBe('2');
  });

  it('grabación muda, sin picos o con error: «sin audio»', async () => {
    const { default: MiniWave } = await import('../app/MiniWave.jsx');
    for (const impl of [async () => ({ json: async () => ({ peaks: [1], silent: true }) }), async () => ({ json: async () => ({}) }), async () => { throw new Error('red'); }]) {
      vi.stubGlobal('fetch', vi.fn(impl));
      const { unmount } = render(<MiniWave recId={1} />);
      await waitFor(() => expect(screen.getByText('sin audio')).toBeTruthy());
      unmount();
    }
  });

  it('desmontar antes de la respuesta no actualiza nada', async () => {
    let ok, ko;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise((r) => { ok = r; })).mockImplementationOnce(() => new Promise((_, r) => { ko = r; })));
    const { default: MiniWave } = await import('../app/MiniWave.jsx');
    const a = render(<MiniWave recId={1} />);
    const b = render(<MiniWave recId={2} />);
    a.unmount(); b.unmount();
    await act(async () => { ok({ json: async () => ({ peaks: [1] }) }); ko(new Error('x')); });
    expect(document.querySelector('rect')).toBeNull();
  });
});

describe('DrawerNG y BloqueNG', () => {
  it('con varias solapas muestra la activa y avisa el cambio; el pie queda fijo', async () => {
    const { default: DrawerNG } = await import('../app/DrawerNG.jsx');
    const onSolapa = vi.fn();
    const solapas = [{ value: 'gral', label: 'General', contenido: <p>contenido general</p> }, { value: 'av', label: 'Avanzado', contenido: <p>contenido avanzado</p> }];
    const { rerender } = renderConMantine(<DrawerNG opened onClose={() => {}} titulo="Troncal 1" subtitulo="sip.proveedor" icono={<i>ic</i>} estado={<span>registrada</span>} solapas={solapas} onSolapa={onSolapa} pie={<button>Guardar</button>} />);
    expect(screen.getByText('Troncal 1')).toBeTruthy();
    expect(screen.getByText('sip.proveedor')).toBeTruthy();
    expect(screen.getByText('registrada')).toBeTruthy();
    expect(screen.getByText('contenido general')).toBeTruthy();
    expect(screen.getByText('Guardar')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Avanzado' }));
    expect(onSolapa).toHaveBeenCalledWith('av');
    rerender(<DrawerNG opened onClose={() => {}} titulo="Troncal 1" solapas={solapas} solapa="av" />);
    expect(screen.getByText('contenido avanzado')).toBeTruthy();
    expect(screen.queryByText('Guardar')).toBeNull();
  });

  it('con una sola solapa (o ninguna) no dibuja la barra de solapas', async () => {
    const { default: DrawerNG } = await import('../app/DrawerNG.jsx');
    const { rerender } = renderConMantine(<DrawerNG opened onClose={() => {}} titulo="X" solapas={[{ value: 'a', label: 'A', contenido: <p>único</p> }]} />);
    expect(screen.getByText('único')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    rerender(<DrawerNG opened onClose={() => {}} titulo="Vacío" />);
    expect(screen.getByText('Vacío')).toBeTruthy();
  });

  it('BloqueNG: título, ayuda e ícono opcionales', async () => {
    const { BloqueNG } = await import('../app/DrawerNG.jsx');
    const { rerender } = renderConMantine(<BloqueNG titulo="Códecs" ayuda="El orden importa" icon={<i>i</i>} derecha={<b>der</b>}><p>hijo</p></BloqueNG>);
    expect(screen.getByText('El orden importa')).toBeTruthy();
    expect(screen.getByText('der')).toBeTruthy();
    rerender(<BloqueNG titulo="Sin ayuda"><p>hijo</p></BloqueNG>);
    expect(screen.queryByText('El orden importa')).toBeNull();
    expect(screen.getByText('hijo')).toBeTruthy();
    rerender(<BloqueNG titulo="Ayuda sin ícono" ayuda="a"><p>h</p></BloqueNG>);
    expect(screen.getByText('a')).toBeTruthy();
  });
});

describe('UpdateBanner: versión nueva sin cortar llamadas', () => {
  let versiones, reload, fetchMock;
  const ocultar = (v) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
  beforeEach(() => {
    vi.useFakeTimers();
    versiones = ['1.0'];
    reload = vi.fn();
    vi.stubGlobal('location', { reload });
    fetchMock = vi.fn(async () => ({ json: async () => ({ version: versiones.length > 1 ? versiones.shift() : versiones[0] }) }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => ocultar(false));

  async function montar() {
    const { default: UpdateBanner } = await import('../app/UpdateBanner.jsx');
    const r = render(<UpdateBanner />);
    await act(async () => {});
    return r;
  }

  it('la primera versión es la de referencia; sin cambios no aparece nada', async () => {
    await montar();
    expect(fetchMock.mock.calls[0][0]).toMatch(/^\/version\.json\?ts=\d+$/);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Nueva versión disponible')).toBeNull();
  });

  it('versión nueva: aviso con cuenta regresiva y se aplica sola (limpia cachés y activa el SW nuevo)', async () => {
    const del = vi.fn(async () => true);
    vi.stubGlobal('caches', { keys: async () => ['a', 'b'], delete: del });
    const post = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistrations: async () => [{ waiting: { postMessage: post } }, { waiting: null }] } });
    versiones = ['1.0', '1.1'];
    await montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText('Nueva versión disponible')).toBeTruthy();
    expect(screen.getByText('Se aplicará en 8s')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('Se aplicará en 5s')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(del).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith({ type: 'skipWaiting' });
    expect(reload).toHaveBeenCalled();
    expect(screen.getByText('Actualizando…')).toBeTruthy();
    delete navigator.serviceWorker;
  });

  it('con una llamada en curso la cuenta se queda en 8 hasta que termine', async () => {
    versiones = ['1.0', '2.0'];
    window.__pbxInCall = true;
    await montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000 + 20000); });
    expect(screen.getByText('Se aplicará en 8s')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('el botón aplica ya, una sola vez, aunque fallen cachés, SW y reload', async () => {
    vi.stubGlobal('caches', { keys: async () => { throw new Error('x'); } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistrations: async () => { throw new Error('y'); } } });
    reload.mockImplementation(() => { throw new Error('z'); });
    versiones = ['1', '2'];
    await montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    fireEvent.click(screen.getByText('Actualizar'));
    await act(async () => {});
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText('…').disabled).toBe(true);
    delete navigator.serviceWorker;
  });

  it('con la pestaña oculta no consulta; al volver sí. Errores y versión nula se ignoran', async () => {
    const r = await montar();
    ocultar(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    ocultar(false);
    fetchMock.mockImplementationOnce(async () => { throw new Error('red'); });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    fetchMock.mockImplementationOnce(async () => ({ json: async () => ({}) }));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Nueva versión disponible')).toBeNull();
    let fin;
    fetchMock.mockImplementationOnce(() => new Promise((res) => { fin = res; }));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    r.unmount();
    await act(async () => { fin({ json: async () => ({ version: '9' }) }); });
  });
});

describe('RegisterSW', () => {
  let sw, reg, nw, reload;
  beforeEach(() => {
    vi.useFakeTimers();
    reload = vi.fn();
    vi.stubGlobal('location', { reload });
    nw = { state: 'installing', h: {}, addEventListener(ev, f) { this.h[ev] = f; }, postMessage: vi.fn() };
    reg = { update: vi.fn(async () => {}), installing: nw, h: {}, addEventListener(ev, f) { this.h[ev] = f; } };
    sw = { h: {}, controller: {}, register: vi.fn(async () => reg), getRegistration: vi.fn(async () => reg), addEventListener(ev, f) { (this.h[ev] ||= []).push(f); } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
  });
  afterEach(() => { delete navigator.serviceWorker; });

  async function montar() {
    const { default: RegisterSW } = await import('../app/registersw.jsx');
    const r = render(<RegisterSW />);
    await act(async () => {});
    return r;
  }

  it('registra /sw.js, busca actualización enseguida y cada minuto', async () => {
    const { container } = await montar();
    expect(container.innerHTML).toBe('');
    expect(sw.register).toHaveBeenCalledWith('/sw.js');
    expect(reg.update).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(reg.update).toHaveBeenCalledTimes(2);
  });

  it('un SW nuevo instalado con uno viejo controlando recibe skipWaiting', async () => {
    await montar();
    reg.h.updatefound();
    nw.state = 'installed'; nw.h.statechange();
    expect(nw.postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' });
    nw.postMessage.mockImplementation(() => { throw new Error('x'); });
    expect(() => nw.h.statechange()).not.toThrow();
    nw.state = 'activating'; nw.postMessage.mockClear(); nw.h.statechange();
    expect(nw.postMessage).not.toHaveBeenCalled();
    reg.installing = null;
    expect(() => reg.h.updatefound()).not.toThrow();
  });

  it('cuando el SW nuevo toma control recarga UNA vez; con llamada en curso lo deja pendiente', async () => {
    await montar();
    window.__pbxInCall = true;
    sw.h.controllerchange[0]();
    expect(reload).not.toHaveBeenCalled();
    expect(window.__pbxReloadPending).toBe(true);
    window.__pbxInCall = false;
    sw.h.message[0]({ data: { type: 'otro' } });
    sw.h.message[0]({});
    expect(reload).not.toHaveBeenCalled();
    sw.h.message[0]({ data: { type: 'sw-activated' } });
    sw.h.controllerchange[0]();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reload que falla no rompe; al volver a la pestaña re-chequea; desmontar suelta el listener', async () => {
    reload.mockImplementation(() => { throw new Error('x'); });
    const r = await montar();
    expect(() => sw.h.controllerchange[0]()).not.toThrow();
    reg.update.mockClear();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(reg.update).toHaveBeenCalledTimes(1);
    sw.getRegistration.mockResolvedValueOnce(null);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    sw.getRegistration.mockRejectedValueOnce(new Error('x'));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    r.unmount();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(sw.getRegistration).toHaveBeenCalledTimes(3);
  });

  it('si el registro falla o update falla, no explota', async () => {
    reg.update.mockRejectedValue(new Error('offline'));
    await montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    sw.register.mockRejectedValueOnce(new Error('x'));
    await montar();
    expect(sw.register).toHaveBeenCalledTimes(2);
  });

  it('sin soporte de service worker no hace nada', async () => {
    delete navigator.serviceWorker;
    const { default: RegisterSW } = await import('../app/registersw.jsx');
    expect(() => render(<RegisterSW />)).not.toThrow();
  });
});

describe('layout raíz', () => {
  it('arma html/es con Mantine oscuro y el AuthProvider envolviendo al shell', async () => {
    vi.doMock('../app/shell.jsx', () => ({ default: ({ children }) => children }));
    vi.doMock('../app/auth.jsx', () => ({ AuthProvider: ({ children }) => children }));
    vi.doMock('../app/registersw.jsx', () => ({ default: () => null }));
    vi.doMock('../app/UpdateBanner.jsx', () => ({ default: () => null }));
    const mod = await import('../app/layout.jsx');
    expect(mod.metadata.title).toBe('PBX-NG · Panel');
    expect(mod.viewport.themeColor).toBe('#0d1117');
    const arbol = mod.default({ children: <p>hijo</p> });
    expect(arbol.type).toBe('html');
    expect(arbol.props.lang).toBe('es');
    const body = arbol.props.children[1];
    expect(body.type).toBe('body');
    expect(body.props.children.props.defaultColorScheme).toBe('dark');
    vi.doUnmock('../app/shell.jsx'); vi.doUnmock('../app/auth.jsx'); vi.doUnmock('../app/registersw.jsx'); vi.doUnmock('../app/UpdateBanner.jsx');
  });
});
