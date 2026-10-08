/* El menú de la cuenta: perfil y foto, cuentas guardadas, diagnóstico y cerrar sesión.
 *
 * Varios operadores comparten el mismo puesto y cambian de interno durante el día: cambiar
 * de cuenta tiene que bajar el motor anterior, levantar el nuevo con SU sesión de central
 * (o ninguna), y cerrar sesión tiene que borrar la clave del interno. El diagnóstico es lo
 * que soporte le pide al cliente: tiene que decir transporte, servidor, ruta de medios y
 * calidad, y exportarse sin tener que dictar nada por teléfono. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { montar, avanzar, ponerSp, estado, store, sesion, mApi, mConfig, CFG_OK, CFG_SIP } from './helpers/pantallas-app.jsx';

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

afterEach(() => { vi.useRealTimers(); delete navigator.clipboard; });

const abrirMenu = () => fireEvent.click(screen.getByTitle('Cuenta'));
const opcion = (t) => { abrirMenu(); fireEvent.click(screen.getByText(t)); };

describe('menú de la cuenta', () => {
  it('muestra el interno, el estado y lleva a cada sección de Ajustes', async () => {
    await montar({ cfg: CFG_OK });
    abrirMenu();
    expect(screen.getByText('sin conectar')).toBeTruthy();
    expect(screen.getAllByText('Interno 2001').length).toBe(2);
    fireEvent.click(screen.getAllByText('Ajustes').find((e) => e.closest('.mp-row')));
    expect(screen.getByText('Registro')).toBeTruthy();
    opcion('Micrófono y auricular');
    expect(screen.getByText('DISPOSITIVOS')).toBeTruthy();
    opcion('Red y TURN');
    expect(screen.getByText('ICE / TURN')).toBeTruthy();
    opcion('Integración con el sistema');
    expect(screen.getByText('INTEGRACIÓN CON EL SISTEMA')).toBeTruthy();
    // tocar afuera lo cierra
    abrirMenu();
    fireEvent.click(document.querySelector('[style*="z-index: 190"]'));
    expect(screen.queryByText('Cerrar sesión')).toBeNull();
  });

  it('registrado dice «En línea» y el QR del menú abre el aprovisionamiento', async () => {
    await montar({ cfg: { ...CFG_OK, name: 'Recepción' }, web: { reg: 'registered', registered: true } });
    abrirMenu();
    expect(screen.getByText('En línea')).toBeTruthy();
    expect(screen.getAllByText('Recepción').length).toBe(2);
    fireEvent.click(screen.getByTitle('Aprovisionar este teléfono por QR'));
    expect(screen.getByText('Configurar por QR')).toBeTruthy();
    fireEvent.click(screen.getByText('✕'));
    expect(screen.queryByText('Configurar por QR')).toBeNull();
    // el del menú lateral también
    fireEvent.click(screen.getByTitle('Configurar por QR'));
    expect(screen.getByText('Configurar por QR', { selector: 'span' })).toBeTruthy();
  });

  it('el botón del menú lateral se resalta al pasar el mouse', async () => {
    await montar({ cfg: CFG_OK });
    const b = screen.getByTitle('Configurar por QR');
    fireEvent.mouseEnter(b);
    expect(b.style.background).not.toBe('none');
    fireEvent.mouseLeave(b);
    expect(b.style.background).toBe('none');
  });

  it('sin cuenta completa muestra «Sin cuenta»', async () => {
    await montar();
    abrirMenu();
    expect(screen.getByText('Sin cuenta')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('perfil y foto', () => {
  it('la foto se sube, se guarda y se quita; el nombre se guarda en la config', async () => {
    await montar({ cfg: CFG_OK });
    opcion('Perfil y foto');
    expect(screen.getByText('Mi perfil')).toBeTruthy();
    const input = document.querySelector('input[type=file]');
    fireEvent.change(input, { target: { files: [] } });
    expect(localStorage.getItem('sp_photo')).toBeNull();
    // FileReader es asíncrono de verdad en jsdom: se espera con timers reales
    vi.useRealTimers();
    fireEvent.change(input, { target: { files: [new File(['abc'], 'yo.png', { type: 'image/png' })] } });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(localStorage.getItem('sp_photo')).toMatch(/^data:image\/png;base64,/);
    expect(document.querySelectorAll('img[src^="data:image/png"]').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Quitar foto'));
    expect(localStorage.getItem('sp_photo')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Tu nombre'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByText('Guardar'));
    expect(mConfig.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Ana' }));
    expect(screen.queryByText('Mi perfil')).toBeNull();
  });

  it('una foto guardada se ve en el avatar; el perfil se cierra con la X o afuera', async () => {
    await montar({ cfg: CFG_OK, foto: 'data:image/png;base64,AAA' });
    expect(document.querySelector('img[src="data:image/png;base64,AAA"]')).toBeTruthy();
    opcion('Perfil y foto');
    fireEvent.click(screen.getByText('Nombre para mostrar'));
    expect(screen.getByText('Mi perfil')).toBeTruthy();
    fireEvent.click(screen.getByText('Mi perfil').parentElement.querySelector('button'));
    expect(screen.queryByText('Mi perfil')).toBeNull();
    opcion('Perfil y foto');
    fireEvent.click(document.querySelector('[style*="z-index: 110"]'));
    expect(screen.queryByText('Mi perfil')).toBeNull();
  });
});

describe('cuentas guardadas', () => {
  const OTRA = { id: '3001@otra.test', label: 'Guardia', cfg: { ...CFG_OK, ext: '3001', domain: 'otra.test' }, api: { base: 'https://otra.test', token: 'tk-otra', user: 'guardia' } };
  const SIN_API = { id: '4001@x.test', label: 'Sin central', cfg: { ...CFG_OK, ext: '4001', domain: 'x.test' } };

  it('sin cuentas lo explica; guardar la actual incluye su sesión de central', async () => {
    await montar({ cfg: CFG_OK, central: true });
    opcion('Cambiar de cuenta');
    expect(screen.getByText(/No hay cuentas guardadas/)).toBeTruthy();
    fireEvent.click(screen.getByText('Guardar la cuenta actual'));
    expect(store.accounts).toEqual([{ id: '2001@pbx.ejemplo.test', label: 'Interno 2001', cfg: expect.objectContaining({ ext: '2001' }), api: { base: 'https://pbx.ejemplo.test', token: 'tok', user: 'operador' } }]);
    expect(screen.getByText('activa')).toBeTruthy();
    expect(screen.getByText('2001@pbx.ejemplo.test · CRM')).toBeTruthy();
    // guardar de nuevo reemplaza, no duplica
    fireEvent.click(screen.getByText('Guardar la cuenta actual'));
    expect(store.accounts.length).toBe(1);
    fireEvent.click(screen.getByTitle('Eliminar'));
    expect(store.accounts).toEqual([]);
  });

  it('una cuenta SIP nativa se identifica por su servidor', async () => {
    await montar({ cfg: { ...CFG_SIP, domain: '', name: 'Nativo' }, sphone: true });
    opcion('Cambiar de cuenta');
    expect(screen.getByText('Guardar la cuenta actual').disabled).toBe(true);
  });

  it('cambiar de cuenta baja el motor, aplica la sesión de la otra y la registra', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, cuentas: [OTRA, SIN_API], sphone: true });
    opcion('Cambiar de cuenta (2)');
    fireEvent.click(screen.getAllByText('Usar')[0]);
    expect(sphone.sipDisconnect).toHaveBeenCalled();
    expect(estado.web.disconnect).toHaveBeenCalled();
    expect(mApi.applySession).toHaveBeenCalledWith({ base: 'https://otra.test', token: 'tk-otra', user: 'guardia' });
    expect(estado.web.connect).toHaveBeenLastCalledWith(expect.objectContaining({ ext: '3001' }));
    expect(store.config.ext).toBe('3001');
    expect(screen.getByText('Voz')).toBeTruthy();
    opcion('Cambiar de cuenta (2)');
    fireEvent.click(screen.getAllByText('Usar')[0]);
    expect(mApi.apiLogout).toHaveBeenCalled();
    expect(screen.queryByText('Voz')).toBeNull();
  });

  it('se cierra con la X o tocando afuera', async () => {
    await montar({ cfg: CFG_OK });
    opcion('Cambiar de cuenta');
    fireEvent.click(screen.getByText(/No hay cuentas guardadas/));
    fireEvent.click(screen.getByText('Cuentas').parentElement.querySelector('button'));
    expect(screen.queryByText('Cuentas')).toBeNull();
    opcion('Cambiar de cuenta');
    fireEvent.click(document.querySelector('[style*="z-index: 110"]'));
    expect(screen.queryByText('Cuentas')).toBeNull();
  });
});

describe('cerrar sesión', () => {
  it('baja los motores, borra interno y clave, y vuelve al login', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true });
    opcion('Cerrar sesión');
    expect(sphone.sipDisconnect).toHaveBeenCalled();
    expect(estado.web.disconnect).toHaveBeenCalled();
    expect(store.config).toMatchObject({ ext: '', pass: '', wss: 'wss://pbx.ejemplo.test/ws' });
    expect(screen.getByText('Conectar a tu central')).toBeTruthy();
  });

  it('aunque el motor falle al bajar, la sesión se cierra', async () => {
    await montar({ cfg: CFG_OK, sphone: { sipDisconnect: vi.fn(() => { throw new Error('x'); }) }, web: { disconnect: vi.fn(() => { throw new Error('y'); }) } });
    opcion('Cerrar sesión');
    expect(screen.getByText('Conectar a tu central')).toBeTruthy();
  });
});

describe('diagnóstico', () => {
  it('sin llamada resume registro, motor y central', async () => {
    await montar({ cfg: CFG_OK });
    await ponerSp({ reg: 'failed', note: 'WebSocket cerrado' });
    opcion('Diagnóstico de la llamada');
    const txt = document.body.textContent;
    expect(txt).toContain('Registrofailed');
    expect(txt).toContain('MotivoWebSocket cerrado');
    expect(txt).toContain('MotorWebRTC (WSS)');
    expect(txt).toContain('Servidorwss://pbx.ejemplo.test/ws');
    expect(txt).toContain('Dominio / Interno' + 'pbx.ejemplo.test / 2001');
    expect(txt).toContain('Sistema (CRM)no conectado');
    expect(txt).toContain('Sin llamada activa');
    expect(txt).toContain('EntornoNavegador');
    fireEvent.click(screen.getByText('Cerrar'));
    expect(screen.queryByText('Exportar log')).toBeNull();
  });

  it('en llamada muestra códec, ruta y métricas; en nativo el transporte y el SRTP', async () => {
    await montar({ cfg: { ...CFG_SIP, sipSrtp: 'sdes', sipTransport: 'tls' }, sphone: true, central: true });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: 1 }, quality: { codec: 'PCMU', candType: 'srflx', rtt: 40, jitter: 3, loss: 0 }, usingRelay: false }, 'nat');
    fireEvent.click(screen.getByTitle('Cuenta'));
    fireEvent.click(screen.getByText('Diagnóstico de la llamada'));
    const txt = document.body.textContent;
    expect(txt).toContain('MotorSIP nativo TLS');
    expect(txt).toContain('Servidor10.0.0.5:5060');
    expect(txt).toContain('SRTPsdes');
    expect(txt).toContain('Sistema (CRM)conectado · operador');
    expect(txt).toContain('Llamada2002');
    expect(txt).toContain('CódecPCMU');
    expect(txt).toContain('Ruta de mediosSTUN (srflx)');
    expect(txt).toContain('RTT / Jitter40 ms / 3 ms');
    expect(txt).toContain('Pérdida0 %');
    expect(txt).toContain('EntornoApp Windows (Electron)');
  });

  it.each([
    ['relay', 'TURN (relay)'], ['prflx', 'peer-reflexive'], ['host', 'directo (host)'], [undefined, '—'],
  ])('ruta %s se lee «%s»', async (ct, txt) => {
    await montar({ cfg: CFG_OK });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: 1 }, quality: ct ? { candType: ct } : null });
    fireEvent.click(screen.getByTitle('Cuenta'));
    fireEvent.click(screen.getByText('Diagnóstico de la llamada'));
    expect(document.body.textContent).toContain('Ruta de medios' + txt);
    expect(document.body.textContent).toContain('RTT / Jitter— / —');
  });

  it('exportar copia al portapapeles y baja un .txt con todo', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    URL.createObjectURL = vi.fn(() => 'blob:diag');
    URL.revokeObjectURL = vi.fn();
    const clic = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await montar({ cfg: CFG_OK, central: true, web: { reg: 'registered', registered: true } });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: 1 }, quality: { codec: 'opus', candType: 'relay', rtt: 80, jitter: 5, loss: 1.5 } });
    fireEvent.click(screen.getByTitle('Cuenta'));
    fireEvent.click(screen.getByText('Diagnóstico de la llamada'));
    fireEvent.click(screen.getByText('Exportar log'));
    const txt = writeText.mock.calls[0][0];
    expect(txt).toMatch(/^PBX-NG Softphone v\d/);
    expect(txt).toContain('Estado: registrado');
    expect(txt).toContain('Transporte: WebRTC');
    expect(txt).toContain('Usuario: operador');
    expect(txt).toContain('Codec: opus');
    expect(txt).toContain('Ruta: TURN (relay)');
    expect(txt).toContain('RTT: 80 ms | Jitter: 5 ms | Perdida: 1.5%');
    expect(txt).toContain('Electron: no (navegador)');
    expect(clic).toHaveBeenCalled();
    await avanzar(2000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diag');
  });

  it('el texto exportado sin llamada y en nativo dice lo que corresponde', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    URL.createObjectURL = undefined;
    await montar({ cfg: { ...CFG_SIP, name: 'Guardia' }, sphone: true });
    await ponerSp({ inCall: true, callInfo: null, quality: {} }, 'nat');
    fireEvent.click(screen.getByTitle('Cuenta'));
    fireEvent.click(screen.getByText('Diagnóstico de la llamada'));
    fireEvent.click(screen.getByText('Exportar log'));
    const txt = writeText.mock.calls[0][0];
    expect(txt).toContain('Transporte: SIP UDP');
    expect(txt).toContain('Servidor: 10.0.0.5:5060');
    expect(txt).toContain('SRTP: none');
    expect(txt).toContain('Nombre: Guardia');
    expect(txt).toContain('Numero: -');
    expect(txt).toContain('Codec: -');
    expect(txt).toContain('RTT: - | Jitter: - | Perdida: -');
    expect(txt).toContain('Base: -');
    expect(txt).toContain('Electron: si');
    // sin portapapeles tampoco explota
    delete navigator.clipboard;
    fireEvent.click(screen.getByText('Exportar log'));
    fireEvent.click(document.querySelector('[style*="z-index: 110"]'));
    expect(screen.queryByText('Exportar log')).toBeNull();
    expect(sesion.base).toBe('');
  });

  it('desde Registro también se abre, y tocar adentro no lo cierra', async () => {
    await montar({ cfg: { ...CFG_OK, wss: '', domain: '' } });
    fireEvent.click(screen.getByText(/Diagnóstico/, { selector: 'button' }));
    fireEvent.click(screen.getByText('Diagnóstico', { selector: 'div' }));
    expect(document.body.textContent).toContain('Servidor—');
    expect(document.body.textContent).toContain('Dominio / Interno— / 2001');
    fireEvent.click(screen.getByText('Diagnóstico', { selector: 'div' }).parentElement.querySelector('button'));
    expect(screen.queryByText('Exportar log')).toBeNull();
  });
});
