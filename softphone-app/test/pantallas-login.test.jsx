/* La puerta de entrada del softphone: el splash, el formulario «Conectar a tu central», la
 * verificación paso a paso y el aprovisionamiento por QR o por enlace.
 *
 * Es la primera pantalla que ve un operador recién instalado, y casi siempre la ve sin
 * nadie al lado. Si el botón queda habilitado con datos a medias, si la verificación se
 * queda girando para siempre o si el motivo del rechazo no aparece, la llamada a soporte
 * es segura. Acá se fija que cada camino termine en algo que se entienda. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { montar, avanzar, avanzarDe, ponerSp, estado, store, sesion, mConfig, mSounds, CFG_OK, CFG_SIP, mApi } from './helpers/pantallas-app.jsx';

vi.mock('../src/useSip.js', async () => (await import('./helpers/pantallas-app.jsx')).mUseSip);
vi.mock('../src/useSipNative.js', async () => (await import('./helpers/pantallas-app.jsx')).mUseSipNative);
vi.mock('../src/config.js', async () => (await import('./helpers/pantallas-app.jsx')).mConfig);
vi.mock('../src/api.js', async () => (await import('./helpers/pantallas-app.jsx')).mApi);
vi.mock('../src/prov.js', async () => (await import('./helpers/pantallas-app.jsx')).mProv);
vi.mock('../src/ice.js', async () => (await import('./helpers/pantallas-app.jsx')).mIce);
vi.mock('../src/sounds.js', async () => (await import('./helpers/pantallas-app.jsx')).mSounds);
vi.mock('../src/anim.js', async () => (await import('./helpers/pantallas-app.jsx')).mAnim);
vi.mock('qrcode', async () => (await import('./helpers/pantallas-app.jsx')).mQrcode);
vi.mock('jsqr', async () => (await import('./helpers/pantallas-app.jsx')).mJsqr);

afterEach(() => { vi.useRealTimers(); });

const campo = (ph) => screen.getAllByPlaceholderText(ph)[0];
const escribir = (el, v) => fireEvent.change(el, { target: { value: v } });
function completarWebrtc(container) {
  escribir(campo('wss://tu-pbx/ws'), 'wss://pbx.ejemplo.test/ws');
  escribir(campo('tu-pbx.com'), 'pbx.ejemplo.test');
  escribir(campo('2001'), '2001');
  escribir(container.querySelector('input[type=password]'), 'clave-de-prueba');
}

describe('splash', () => {
  it('muestra la versión real del paquete y se va solo a los 3 s', async () => {
    await montar({ saltarSplash: false });
    expect(screen.getAllByText(/^v\d+\.\d+\.\d+$/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Conectar a tu central')).toBeNull();
    await avanzar(3200);
    expect(screen.getByText('Conectar a tu central')).toBeTruthy();
  });
});

describe('formulario de conexión (WebRTC)', () => {
  it('no deja conectar con datos a medias y arranca con todo completo', async () => {
    const { container } = await montar({ sphone: true });
    const btn = screen.getByText('Conectar y verificar');
    expect(btn.disabled).toBe(true);
    // la ventana pide el tamaño chico del login
    expect(window.sphone.winSize).toHaveBeenCalledWith(920, 560);
    completarWebrtc(container);
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(screen.getByText('Verificando conexión…')).toBeTruthy();
    expect(mConfig.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ wss: 'wss://pbx.ejemplo.test/ws', ext: '2001' }));
    // el motor arranca un instante después de bajar el anterior
    expect(estado.web.connect).not.toHaveBeenCalled();
    await avanzar(260);
    expect(estado.web.connect).toHaveBeenCalledWith(expect.objectContaining({ domain: 'pbx.ejemplo.test' }));
  });

  it('recorre los pasos, espera el registro real y entra a la app', async () => {
    const { container } = await montar({ sphone: true });
    completarWebrtc(container);
    fireEvent.click(screen.getByText('Conectar y verificar'));
    await avanzarDe(800, 3);
    // en el paso de registro se queda esperando aunque pase el tiempo
    await avanzar(5000);
    expect(screen.getByText('Verificando conexión…')).toBeTruthy();
    await ponerSp({ reg: 'registered', registered: true });
    await avanzar(500);
    await avanzar(800);
    expect(screen.getByText('¡Conectado!')).toBeTruthy();
    expect(screen.getByText(/Interno 2001 en línea · WebRTC/)).toBeTruthy();
    await avanzar(1700);
    expect(screen.queryByText('¡Conectado!')).toBeNull();
    expect(screen.getByText('Recientes')).toBeTruthy();
    expect(window.sphone.winSize).toHaveBeenLastCalledWith(920, 640);
  });

  it('si la central rechaza el registro dice por qué y deja volver a los datos', async () => {
    const { container } = await montar();
    completarWebrtc(container);
    fireEvent.click(screen.getByText('Conectar y verificar'));
    await ponerSp({ reg: 'failed', note: '401 no autorizado' });
    expect(screen.getByText('No se pudo conectar')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('401 no autorizado');
    fireEvent.click(screen.getByText('Volver a los datos'));
    expect(screen.getByText('Conectar a tu central')).toBeTruthy();
  });

  it('sin motivo de la central muestra uno genérico', async () => {
    const { container } = await montar();
    completarWebrtc(container);
    fireEvent.click(screen.getByText('Conectar y verificar'));
    await ponerSp({ reg: 'failed', note: '' });
    expect(screen.getByRole('alert').textContent).toMatch(/No se pudo registrar/);
  });

  it('si el registro tarda más de 15 s corta la espera con un error', async () => {
    const { container } = await montar();
    completarWebrtc(container);
    fireEvent.click(screen.getByText('Conectar y verificar'));
    await avanzarDe(800, 3);
    await avanzar(15000);
    expect(screen.getByRole('alert').textContent).toMatch(/Tardó demasiado/);
  });

  it('Enter con datos a medias explica qué falta', async () => {
    await montar();
    const dom = campo('tu-pbx.com');
    fireEvent.keyDown(dom, { key: 'a' });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.keyDown(dom, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('Completá los datos obligatorios.');
  });

  it('cambiar el interno borra el nombre heredado del interno anterior', async () => {
    const { container } = await montar({ cfg: { ...CFG_OK, ext: '', name: 'Ana' } });
    escribir(campo('2001'), '2002');
    fireEvent.click(screen.getByText('Conectar y verificar'));
    expect(mConfig.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ ext: '2002', name: '' }));
    expect(container).toBeTruthy();
  });

  it('el códec se elige y, si no es Auto, se puede forzar', async () => {
    const { container } = await montar();
    expect(screen.queryByText(/Forzar \(ofrecer sólo este códec\)/)).toBeNull();
    fireEvent.click(screen.getByText('Opus'));
    const chk = container.querySelector('input[type=checkbox]');
    expect(chk.checked).toBe(false);
    fireEvent.click(chk);
    expect(chk.checked).toBe(true);
    completarWebrtc(container);
    fireEvent.click(screen.getByText('Conectar y verificar'));
    expect(mConfig.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ codec: 'opus', codecForce: true }));
  });

  it('SIP nativo fuera de Electron avisa en vez de cambiar', async () => {
    await montar();
    const alerta = vi.spyOn(window, 'alert').mockImplementation(() => {});
    fireEvent.click(screen.getByText('SIP nativo'));
    expect(alerta).toHaveBeenCalledWith(expect.stringMatching(/solo funciona en la app de Windows/));
    expect(screen.queryByText('Servidor SIP (host o IP)')).toBeNull();
  });
});

describe('formulario de conexión (SIP nativo)', () => {
  it('pide servidor y puerto, ofrece sólo G.711 y registra por el puente', async () => {
    const { container, sphone } = await montar({ sphone: true });
    fireEvent.click(screen.getByText('SIP nativo'));
    expect(screen.getAllByText('Servidor SIP (host o IP)').length).toBeGreaterThan(0);
    expect(screen.queryByText('Opus')).toBeNull();
    fireEvent.click(screen.getByText('G.711 µ'));
    expect(screen.getAllByText(/Se ofrece sólo G.711 µ-law/).length).toBe(2); // login y Ajustes
    fireEvent.click(screen.getByText('G.711 A'));
    expect(screen.getAllByText(/Se ofrece sólo G.711 A-law/).length).toBe(2);
    escribir(campo('192.168.1.10'), '10.0.0.5');
    escribir(campo('tu-pbx.com'), 'pbx.ejemplo.test');
    escribir(campo('2001'), '2001');
    escribir(container.querySelector('input[type=password]'), 'x');
    fireEvent.click(screen.getByText('Conectar y verificar'));
    expect(screen.getByText('SIP UDP')).toBeTruthy();
    expect(screen.getByText('10.0.0.5:5060')).toBeTruthy();
    await avanzar(260);
    expect(sphone.sipConnect).toHaveBeenCalledWith(expect.objectContaining({ transport: 'sip', codec: 'pcma' }));
    // el estado del registro llega como evento del proceso main
    await sphone.emitir('sip', { type: 'log', dir: 'out', line: 'REGISTER sip:pbx' });
    await sphone.emitir('sip', { type: 'reg', state: 'failed', reason: '403 Forbidden' });
    expect(screen.getByRole('alert').textContent).toBe('403 Forbidden');
  });

  it('el registro nativo exitoso lleva a «Conectado» con la etiqueta SIP', async () => {
    const { sphone } = await montar({ sphone: true, cfg: { ...CFG_SIP, pass: '' } });
    fireEvent.click(screen.getByText('Conectar y verificar')); // falta la clave: deshabilitado
    expect(screen.queryByText('Verificando conexión…')).toBeNull();
    fireEvent.change(document.querySelector('input[type=password]'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Conectar y verificar'));
    await avanzarDe(800, 3);
    await sphone.emitir('sip', { type: 'reg', state: 'registered' });
    await avanzar(500); await avanzar(800);
    expect(screen.getByText(/en línea · SIP$/)).toBeTruthy();
  });

  it('con el motor nativo ausente el registro queda en falla', async () => {
    const sph = { sipConnect: undefined };
    await montar({ sphone: sph, cfg: CFG_SIP });
    // arrancó solo porque la config estaba completa, pero no hay motor que lo atienda
    expect(screen.getAllByText(/error de registro/).length).toBeGreaterThan(0);
  });
});

describe('aprovisionamiento', () => {
  it('el QR del login abre el diálogo y un código pegado configura todo', async () => {
    const { sphone } = await montar({ sphone: true });
    fireEvent.click(screen.getByTitle('Configurar por QR / código de aprovisionamiento'));
    expect(mSounds.uiClick).toHaveBeenCalled();
    expect(screen.getByText('Configurar por QR')).toBeTruthy();
    fireEvent.click(screen.getByText('Pegar código'));
    const prov = { wss: 'wss://otra.test/ws', domain: 'otra.test', ext: '3001', pass: 'p', apiBase: 'https://otra.test', apiToken: 'tk' };
    fireEvent.change(screen.getByPlaceholderText('https://pbx.tu-dominio.com/enroll?token=...'), { target: { value: 'pbxng://prov#' + JSON.stringify(prov) } });
    await avanzar(0);
    fireEvent.click(screen.getByText('Configurar'));
    expect(mApi.applySession).toHaveBeenCalledWith({ base: 'https://otra.test', token: 'tk' });
    expect(sphone.updateSetFeed).toHaveBeenCalledWith('https://otra.test/descargas/softphone/');
    // la config guardada no lleva la sesión de la central adentro
    const guardada = store.config;
    expect(guardada.ext).toBe('3001');
    expect(guardada.apiToken).toBeUndefined();
    expect(guardada.transport).toBe('webrtc');
    expect(screen.queryByText('Configurar por QR')).toBeNull();
    await avanzar(260);
    expect(estado.web.connect).toHaveBeenCalledWith(expect.objectContaining({ ext: '3001', name: '' }));
    expect(screen.getByText('Recientes')).toBeTruthy();
  });

  it('un enlace pbxng:// abierto desde el sistema también aprovisiona', async () => {
    const { sphone } = await montar({ sphone: true });
    await sphone.emitir('provision', 'pbxng://prov#' + JSON.stringify({ transport: 'sip', sipServer: '10.1.1.1', domain: 'd', ext: '5', pass: 'p', name: 'Recepción' }));
    expect(store.config).toMatchObject({ transport: 'sip', name: 'Recepción' });
    await avanzar(260);
    expect(sphone.sipConnect).toHaveBeenCalled();
    // un enlace que no es de aprovisionamiento no hace nada
    mConfig.saveConfig.mockClear();
    await sphone.emitir('provision', 'https://cualquier.cosa');
    expect(mConfig.saveConfig).not.toHaveBeenCalled();
  });

  it('aprovisionar sin sesión de central conserva el transporte que ya había', async () => {
    await montar({ cfg: { ...DEFSIP() } });
    sesion.base = '';
    fireEvent.click(screen.getByTitle('Configurar por QR / código de aprovisionamiento'));
    fireEvent.click(screen.getByText('Pegar código'));
    fireEvent.change(screen.getByPlaceholderText('https://pbx.tu-dominio.com/enroll?token=...'), { target: { value: 'pbxng://prov#' + JSON.stringify({ apiBase: 'https://solo-base.test', ext: '9' }) } });
    fireEvent.click(screen.getByText('Configurar'));
    expect(store.config.transport).toBe('sip');
    expect(mApi.applySession).toHaveBeenCalledWith({ base: 'https://solo-base.test', token: undefined });
  });
});

function DEFSIP() { return { transport: 'sip' }; }

describe('barra de la ventana (Electron)', () => {
  it('minimizar, cerrar y modo mini mandan la orden a main', async () => {
    const { sphone } = await montar({ sphone: true });
    const mini = screen.getAllByTitle('Modo mini (flotante)')[0];
    fireEvent.mouseEnter(mini); fireEvent.mouseLeave(mini);
    fireEvent.click(mini);
    expect(sphone.miniShow).toHaveBeenCalledWith(true);
    const min = screen.getAllByTitle('Minimizar')[0];
    fireEvent.mouseEnter(min); fireEvent.mouseLeave(min);
    fireEvent.click(min);
    expect(sphone.winMinimize).toHaveBeenCalled();
    const cerrar = screen.getAllByTitle('Cerrar')[0];
    fireEvent.mouseEnter(cerrar);
    expect(cerrar.style.background).toBe('rgb(235, 76, 70)');
    fireEvent.mouseLeave(cerrar);
    expect(cerrar.style.background).toBe('none');
    fireEvent.click(cerrar);
    expect(sphone.winClose).toHaveBeenCalled();
    // la barra clara (fuera del login) también tiene sus botones
    const todos = screen.getAllByTitle('Minimizar');
    fireEvent.mouseEnter(todos[todos.length - 1]); fireEvent.mouseLeave(todos[todos.length - 1]);
    const ms = screen.getAllByTitle('Modo mini (flotante)');
    fireEvent.mouseEnter(ms[ms.length - 1]); fireEvent.mouseLeave(ms[ms.length - 1]);
    const cs = screen.getAllByTitle('Cerrar');
    fireEvent.mouseEnter(cs[cs.length - 1]); fireEvent.mouseLeave(cs[cs.length - 1]);
    expect(cs[cs.length - 1].style.background).toBe('none');
  });

  it('si miniShow explota no rompe la ventana', async () => {
    await montar({ sphone: { miniShow: vi.fn(() => { throw new Error('x'); }) } });
    fireEvent.click(screen.getAllByTitle('Modo mini (flotante)')[0]);
    expect(screen.getByText('Conectar a tu central')).toBeTruthy();
  });

  it('las cuentas guardadas se ofrecen desde el login', async () => {
    await montar({ cuentas: [{ id: '2001@pbx', label: 'Recepción', cfg: CFG_OK, api: {} }] });
    fireEvent.click(screen.getByTitle('Cuentas guardadas'));
    expect(screen.getByText('Cuentas')).toBeTruthy();
    expect(screen.getByText('Recepción')).toBeTruthy();
  });
});
