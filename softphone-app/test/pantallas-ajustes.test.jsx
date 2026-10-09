/* Ajustes: registro (WebRTC y SIP nativo), dispositivos, red/TURN, integración con la
 * central, preferencias y actualizaciones.
 *
 * Es donde se arregla todo lo que no anda, así que cada pantalla tiene que decir la verdad:
 * qué servidor y transporte se van a usar, si el TURN contestó y con qué candidatos, por
 * qué no se pudo entrar a la central (no es lo mismo «no llego» que «clave incorrecta»), y
 * en qué está el buscador de actualizaciones. Las preferencias tienen que sobrevivir a un
 * reinicio y el feed OTA tiene que apuntar a la central, no al respaldo de GitHub. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { montar, avanzar, ponerSp, estado, store, mApi, mIce, mSounds, mUseSip, mConfig, mQrcode, CFG_OK, CFG_SIP, irA } from './helpers/pantallas-app.jsx';

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

const solapa = (t) => fireEvent.click(screen.getByText(t, { selector: 'button' }));
const lbl = (t) => screen.getByText(t, { selector: 'div' }).parentElement;
async function ajustes(opts = {}, sub) {
  const r = await montar({ cfg: CFG_OK, ...opts });
  irA('Ajustes');
  await avanzar(0);
  if (sub) solapa(sub);
  return r;
}

describe('registro', () => {
  it('WebRTC: edita servidor, respaldo y credenciales; «Conectar» reinicia el motor', async () => {
    const { sphone } = await ajustes({ sphone: true });
    const wss = lbl('Servidor WebSocket (ws:// o wss://)').querySelector('input');
    fireEvent.change(wss, { target: { value: 'wss://nueva.test/ws' } });
    fireEvent.change(lbl('WSS de respaldo (failover, opcional)').querySelector('input'), { target: { value: 'wss://b.test/ws' } });
    fireEvent.change(lbl('Contraseña').querySelector('input'), { target: { value: 'otra' } });
    fireEvent.click(screen.getByText('Conectar'));
    expect(mConfig.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ wss: 'wss://nueva.test/ws', wssBackup: 'wss://b.test/ws', pass: 'otra' }));
    expect(sphone.sipDisconnect).toHaveBeenCalled();
    expect(estado.web.disconnect).toHaveBeenCalled();
    await avanzar(260);
    expect(estado.web.connect).toHaveBeenLastCalledWith(expect.objectContaining({ wss: 'wss://nueva.test/ws' }));
    await ponerSp({ reg: 'registered', registered: true });
    expect(screen.getByText('Reconectar')).toBeTruthy();
  });

  it('el códec WebRTC se puede forzar', async () => {
    await ajustes();
    const sel = lbl('Códec de audio').querySelector('select');
    expect(sel.value).toBe('auto');
    fireEvent.change(sel, { target: { value: 'g722' } });
    const forzar = screen.getByText('Forzar este códec').parentElement.parentElement.querySelector('button');
    expect(forzar.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(forzar);
    expect(forzar.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('Conectar'));
    expect(store.config).toMatchObject({ codec: 'g722', codecForce: true });
  });

  it('SIP nativo fuera de Electron avisa y no cambia', async () => {
    const alerta = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await ajustes();
    fireEvent.click(screen.getByText('SIP UDP/TCP/TLS'));
    expect(alerta).toHaveBeenCalledWith(expect.stringMatching(/solo funciona en la app de Windows/));
    expect(screen.queryByText('Transporte')).toBeNull();
  });

  it('SIP nativo: transporte, SRTP, DTMF, TLS, SRV y MWI van a la config', async () => {
    await ajustes({ sphone: true });
    fireEvent.click(screen.getByText('SIP UDP/TCP/TLS'));
    fireEvent.change(lbl('Servidor SIP (host o IP)').querySelector('input'), { target: { value: '10.0.0.5' } });
    fireEvent.change(lbl('Transporte').querySelector('select'), { target: { value: 'tls' } });
    fireEvent.change(lbl('Cifrado de medios (SRTP)').querySelector('select'), { target: { value: 'sdes' } });
    expect(screen.getByText(/Recomendado con transporte/)).toBeTruthy();
    fireEvent.change(lbl('DTMF').querySelector('select'), { target: { value: 'info' } });
    for (const t of ['Validar certificado TLS', 'Descubrir servidor (DNS SRV)', 'Mensajes en espera (MWI por SIP)']) {
      fireEvent.click(screen.getByText(t).parentElement.parentElement.querySelector('button'));
    }
    // en nativo sólo hay G.711: un Opus guardado se muestra como Auto
    const codec = lbl('Códec de audio').querySelector('select');
    expect(Array.from(codec.options).map((o) => o.value)).toEqual(['auto', 'pcmu', 'pcma']);
    fireEvent.change(codec, { target: { value: 'pcmu' } });
    expect(screen.getAllByText(/Se ofrece sólo G.711 µ-law/).length).toBeGreaterThan(0);
    fireEvent.change(codec, { target: { value: 'pcma' } });
    expect(screen.getAllByText(/Se ofrece sólo G.711 A-law/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Conectar'));
    expect(store.config).toMatchObject({ transport: 'sip', sipServer: '10.0.0.5', sipTransport: 'tls', sipSrtp: 'sdes', sipDtmf: 'info', tlsVerify: true, sipSrv: true, sipMwi: true, codec: 'pcma' });
    fireEvent.click(screen.getByText('WebRTC (WSS/WS)'));
    expect(screen.queryByText('Transporte')).toBeNull();
  });

  it('SIP nativo: un Opus guardado se ofrece como Auto, y el registro muestra el motivo y el log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { sphone } = await ajustes({ sphone: true, cfg: { ...CFG_SIP, codec: 'opus' } });
    expect(lbl('Códec de audio').querySelector('select').value).toBe('auto');
    fireEvent.click(screen.getByText('Conectar'));
    await avanzar(260);
    expect(sphone.sipConnect).toHaveBeenCalled();
    for (let i = 0; i < 10; i++) await sphone.emitir('sip', { type: 'log', dir: i % 2 ? 'in' : 'out', line: 'línea ' + i });
    await sphone.emitir('sip', { type: 'log', dir: 'x', line: 'SIP/2.0 401 Unauthorized' });
    await sphone.emitir('sip', { type: 'log', dir: 'in', line: 'SIP/2.0 200 OK' });
    await sphone.emitir('sip', null);
    await sphone.emitir('sip', { type: 'otro' });
    expect(log).toHaveBeenCalledWith('[sip]', 'in', 'SIP/2.0 200 OK');
    // quedan las últimas 9
    expect(screen.queryByText('→ línea 2')).toBeNull();
    expect(screen.getByText('← línea 3')).toBeTruthy();
    expect(screen.getByText('· SIP/2.0 401 Unauthorized').style.color).toBe('rgb(255, 154, 154)');
    expect(screen.getByText('← SIP/2.0 200 OK').style.color).toBe('rgb(140, 230, 166)');
    await sphone.emitir('sip', { type: 'reg', state: 'failed', reason: '408 sin respuesta' });
    expect(screen.getByText('✗ 408 sin respuesta')).toBeTruthy();
    await sphone.emitir('sip', { type: 'reg', state: 'failed' });
    expect(screen.getByText('✗ 408 sin respuesta')).toBeTruthy();
    await sphone.emitir('sip', { type: 'reg', state: 'registered' });
    expect(screen.queryByText(/408 sin respuesta/)).toBeNull();
    expect(screen.getByText(/2001 · en línea/)).toBeTruthy();
    // reconectar en nativo limpia el log viejo
    fireEvent.click(screen.getByText('Reconectar'));
    expect(screen.queryByText('← SIP/2.0 200 OK')).toBeNull();
  });
});

describe('dispositivos', () => {
  it('lista micrófonos, cámaras y salidas; elegir la salida la aplica ya', async () => {
    await ajustes({}, 'Dispositivos');
    expect(mUseSip.listDevices).toHaveBeenCalledWith();
    const mic = lbl('Micrófono').querySelector('select');
    expect(Array.from(mic.options).map((o) => o.textContent)).toEqual(['Predeterminado', 'Micrófono (2- DM30 RGB USB Microphone) (352f:0106)', 'Micrófono']);
    fireEvent.change(mic, { target: { value: 'm2' } });
    expect(mUseSip.setDevPref).toHaveBeenCalledWith('mic', 'm2');
    expect(estado.web.applySpeaker).not.toHaveBeenCalled();
    fireEvent.change(lbl('Altavoz / Salida').querySelector('select'), { target: { value: 's1' } });
    expect(estado.web.applySpeaker).toHaveBeenCalledWith('s1');
    fireEvent.change(lbl('Cámara').querySelector('select'), { target: { value: 'c1' } });
    expect(mUseSip.setDevPref).toHaveBeenCalledWith('cam', 'c1');
    fireEvent.change(document.querySelector('input[type=range]'), { target: { value: '0.5' } });
    expect(estado.web.setVolume).toHaveBeenCalledWith(0.5);
  });
});

describe('red y TURN', () => {
  it('sin nada configurado dice «TURN off»; probar muestra los candidatos', async () => {
    await ajustes({}, 'Red / TURN');
    expect(screen.getByText('TURN off')).toBeTruthy();
    expect(screen.getByText('sin configurar')).toBeTruthy();
    expect(screen.getByText('sin llamada activa')).toBeTruthy();
    fireEvent.change(lbl('TURN').querySelector('input'), { target: { value: 'turn:t.test:3478' } });
    fireEvent.change(lbl('TURN clave').querySelector('input'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Probar TURN ahora'));
    expect(mConfig.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ turn: 'turn:t.test:3478', turnPass: 'x' }));
    expect(screen.getByText('Probando…')).toBeTruthy();
    expect(screen.getByText('Probando TURN…')).toBeTruthy();
    expect(screen.getAllByText('…').length).toBe(2);
    await avanzar(0);
    expect(mIce.refrescarIce).toHaveBeenCalled();
    expect(mIce.testIce).toHaveBeenCalled();
    expect(screen.getByText('TURN operativo')).toBeTruthy();
    expect(screen.getByText('alcanzable y autenticado')).toBeTruthy();
    expect(screen.getByText('TURN listo')).toBeTruthy();
    expect(screen.getAllByText('1 ✓').length).toBe(2);   // relay y srflx
    expect(screen.getByText('200.1.1.1')).toBeTruthy();
    expect(screen.getByText('200.2.2.2')).toBeTruthy();
    expect(screen.getByText('340 ms')).toBeTruthy();
  });

  it('con la llamada pasando por relay lo dice en los dos lados', async () => {
    await ajustes({}, 'Red / TURN');
    fireEvent.click(screen.getByText('Actualizar desde la central'));
    await avanzar(0);
    await ponerSp({ inCall: true, usingRelay: true, callInfo: { number: '1', since: 1 } });
    expect(screen.getByText('TURN en uso', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('la llamada pasa por relay')).toBeTruthy();
    expect(screen.getByText('por TURN (relay)')).toBeTruthy();
    await ponerSp({ usingRelay: false });
    expect(screen.getByText('directo (P2P / STUN)')).toBeTruthy();
    expect(screen.getByText('Medios directos')).toBeTruthy();
    await ponerSp({ usingRelay: null });
    expect(screen.getByText('negociando…')).toBeTruthy();
  });

  it.each([
    [{ state: 'turn-auth', errors: ['401'] }, 'central', 'Credenciales rechazadas', 'la central dio esta credencial y el relay la rechazó (401)', 'TURN: auth falló'],
    [{ state: 'turn-auth' }, 'manual', 'Credenciales rechazadas', 'usuario/clave inválidos (401): probá actualizar desde la central', 'TURN: auth falló'],
    [{ state: 'turn-unreachable', errors: ['a', 'b', 'c', 'd'] }, 'manual', 'TURN no responde', 'no llegó candidato relay', 'TURN no responde'],
  ])('resultado %j con ICE %s', async (res, fuente, titulo, sub, chip) => {
    mIce.testIce.mockResolvedValue(res);
    mIce.iceEfectivos.mockReturnValue({ lista: [{ urls: ['turn:t.test'] }], fuente });
    await ajustes({}, 'Red / TURN');
    expect(screen.getByText('Sin probar')).toBeTruthy();
    fireEvent.click(screen.getByText('Probar TURN ahora'));
    await avanzar(0);
    expect(screen.getAllByText(titulo).length).toBeGreaterThan(0);
    expect(screen.getByText(sub)).toBeTruthy();
    expect(screen.getAllByText(chip).length).toBeGreaterThan(0);
    if (fuente === 'manual') expect(screen.getByText(/Usando el respaldo manual/)).toBeTruthy();
    if (res.errors && res.errors.length > 3) expect(screen.queryByText('✕ d')).toBeNull();
  });

  it('si la prueba explota se ve el error y no queda girando', async () => {
    mIce.testIce.mockRejectedValueOnce(new Error('RTCPeerConnection no existe')).mockRejectedValueOnce('texto');
    mIce.iceEfectivos.mockReturnValue({ lista: [{ urls: 'stun:s.test' }], fuente: 'central' });
    await ajustes({}, 'Red / TURN');
    fireEvent.click(screen.getByText('Probar TURN ahora'));
    await avanzar(0);
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText('✕ RTCPeerConnection no existe')).toBeTruthy();
    expect(screen.getAllByText('TURN no responde').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Probar TURN ahora'));
    await avanzar(0);
    expect(screen.getByText('✕ texto')).toBeTruthy();
  });

  it('si la central no da el ICE el error queda a la vista', async () => {
    mIce.refrescarIce.mockResolvedValueOnce({ ok: false, error: 'la central no contestó /ice' }).mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    await ajustes({}, 'Red / TURN');
    await avanzar(1300);
    expect(screen.getByText('la central no contestó /ice')).toBeTruthy();
    fireEvent.click(screen.getByText('Probar TURN ahora'));
    await avanzar(0);
    expect(screen.queryByText('la central no contestó /ice')).toBeNull();
  });

  it('un TURN con usuario y clave guardados se anuncia «sin probar» en la cabecera', async () => {
    await montar({ cfg: { ...CFG_OK, turn: 'turn:t', turnUser: 'u', turnPass: 'p' } });
    expect(screen.getByText('TURN sin probar')).toBeTruthy();
  });
});

describe('integración con la central', () => {
  const campos = () => ({
    base: lbl('URL del sistema').querySelector('input'),
    user: lbl('Usuario del panel').querySelector('input'),
    pass: lbl('Contraseña del panel').querySelector('input'),
  });

  it('propone la URL a partir del WSS y al conectar apunta las actualizaciones ahí', async () => {
    const { sphone } = await ajustes({ sphone: true }, 'Sistema');
    const c = campos();
    expect(c.base.placeholder).toBe('https://pbx.ejemplo.test');
    fireEvent.change(c.user, { target: { value: ' operador ' } });
    fireEvent.change(c.pass, { target: { value: 'clave' } });
    fireEvent.keyDown(c.pass, { key: 'a' });
    fireEvent.keyDown(c.pass, { key: 'Enter' });
    expect(screen.getByText('Conectando…')).toBeTruthy();
    await avanzar(0);
    expect(mApi.apiLogin).toHaveBeenCalledWith('https://pbx.ejemplo.test', 'operador', 'clave');
    expect(screen.getByText('Conectado al sistema ✓')).toBeTruthy();
    expect(sphone.updateSetFeed).toHaveBeenLastCalledWith('https://pbx.ejemplo.test/descargas/softphone/');
    expect(screen.getByText('conectado')).toBeTruthy();
    expect(screen.getByText('Voz')).toBeTruthy();
  });

  it('distingue clave incorrecta, central que responde y central inalcanzable', async () => {
    mApi.apiLogin
      .mockResolvedValueOnce({ ok: false, error: 'Usuario o contraseña incorrectos' })
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 401' })
      .mockResolvedValueOnce({ ok: false, error: 'Failed to fetch' })
      .mockRejectedValueOnce(new Error('JSON roto'))
      .mockRejectedValueOnce(null);
    mApi.iceDeLaCentral.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('DNS'));
    await ajustes({}, 'Sistema');
    fireEvent.change(campos().base, { target: { value: ' https://otra.test ' } });
    const conectar = () => { fireEvent.click(screen.getByText('Conectar al sistema')); return avanzar(0); };
    await conectar();
    expect(screen.getByText('No se pudo conectar: Usuario o contraseña incorrectos')).toBeTruthy();
    expect(mApi.iceDeLaCentral).not.toHaveBeenCalled();
    await conectar();
    expect(mApi.iceDeLaCentral).toHaveBeenCalledWith('https://otra.test');
    expect(screen.getByText('No se pudo conectar: HTTP 401 (la central responde, así que es el usuario o la contraseña)')).toBeTruthy();
    await conectar();
    expect(screen.getByText('No se pudo conectar: no se llega a la central desde esta red: Failed to fetch')).toBeTruthy();
    await conectar();
    expect(screen.getByText('No se pudo conectar: JSON roto')).toBeTruthy();
    await conectar();
    expect(screen.getByText('No se pudo conectar: error inesperado').style.color).toBe('rgb(235, 76, 70)');
  });

  it('sin WSS no hay URL propuesta', async () => {
    await montar({ cfg: { ...CFG_SIP }, sphone: true });
    irA('Ajustes');
    solapa('Sistema');
    expect(campos().base.placeholder).toBe('https://pbx01.tu-dominio');
    fireEvent.click(screen.getByText('Conectar al sistema'));
    await avanzar(0);
    expect(mApi.apiLogin).toHaveBeenCalledWith('', '', '');
  });

  it('desconectar borra lo prestado por la central y saca Voz', async () => {
    mApi.vmList.mockResolvedValue([]);
    await montar({ cfg: CFG_OK, central: true });
    irA('Voz');
    irA('Ajustes');
    solapa('Sistema');
    expect(screen.getByText('operador')).toBeTruthy();
    fireEvent.click(screen.getByText('Desconectar'));
    expect(mApi.apiLogout).toHaveBeenCalled();
    expect(screen.queryByText('Voz')).toBeNull();
    expect(screen.getByText('Conectar al sistema')).toBeTruthy();
  });

  it('sin central, la solapa Voz abierta vuelve sola al marcador', async () => {
    mApi.vmList.mockResolvedValue([]);
    await montar({ cfg: CFG_OK, central: true });
    irA('Voz');
    await avanzar(0);
    expect(screen.getByText('No tenés mensajes de voz.')).toBeTruthy();
    irA('Ajustes');
    solapa('Sistema');
    fireEvent.click(screen.getByText('Desconectar'));
    irA('Llamadas');
    expect(screen.getByPlaceholderText('Ingresá nombre o número')).toBeTruthy();
  });

  it('aprovisionar otro teléfono genera el QR del interno pedido', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mApi.provision.mockResolvedValueOnce({ prov_url: 'https://pbx/enroll?token=abc' });
    await ajustes({ central: true }, 'Sistema');
    fireEvent.click(screen.getByText('Aprovisionar teléfono (QR)'));
    const ext = screen.getByPlaceholderText('Interno (ej. 2001)');
    expect(screen.getByText('Generar').disabled).toBe(true);
    fireEvent.change(ext, { target: { value: '20a05' } });
    expect(ext.value).toBe('2005');
    fireEvent.keyDown(ext, { key: 'x' });
    fireEvent.keyDown(ext, { key: 'Enter' });
    expect(screen.getByText('…')).toBeTruthy();
    await avanzar(0);
    expect(mApi.provision).toHaveBeenCalledWith('2005');
    expect(mQrcode.default.toDataURL).toHaveBeenCalledWith('https://pbx/enroll?token=abc', expect.objectContaining({ width: 260 }));
    expect(screen.getByAltText('QR').getAttribute('src')).toBe('data:image/png;base64,QR');
    fireEvent.click(screen.getByText('Copiar enlace'));
    expect(writeText).toHaveBeenCalledWith('https://pbx/enroll?token=abc');
    delete navigator.clipboard;
    fireEvent.click(screen.getByText('Copiar enlace'));   // sin portapapeles no explota
    fireEvent.click(screen.getByText('Aprovisionar teléfono'));
    expect(screen.getByText('Aprovisionar teléfono')).toBeTruthy();
    fireEvent.click(screen.getByText('Aprovisionar teléfono').parentElement.querySelector('button'));
    expect(screen.queryByText('Aprovisionar teléfono')).toBeNull();
  });

  it('los errores de aprovisionamiento se muestran tal cual', async () => {
    mApi.provision.mockResolvedValueOnce({ error: 'requiere admin' }).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('caída')).mockRejectedValueOnce('texto');
    await ajustes({ central: true }, 'Sistema');
    fireEvent.click(screen.getByText('Aprovisionar teléfono (QR)'));
    fireEvent.change(screen.getByPlaceholderText('Interno (ej. 2001)'), { target: { value: '9' } });
    const gen = async () => { fireEvent.click(screen.getByText('Generar')); await avanzar(0); };
    await gen(); expect(screen.getByText('requiere admin')).toBeTruthy();
    await gen(); expect(screen.getByText('no se pudo generar')).toBeTruthy();
    await gen(); expect(screen.getByText('caída')).toBeTruthy();
    await gen(); expect(screen.getByText('texto')).toBeTruthy();
    fireEvent.click(document.querySelector('[style*="z-index: 110"]'));
    expect(screen.queryByText('texto')).toBeNull();
  });
});

describe('preferencias', () => {
  it('cada interruptor se guarda y los sonidos se aplican', async () => {
    await ajustes({}, 'Preferencias');
    const t = (txt) => screen.getByText(txt).parentElement.parentElement.querySelector('button');
    fireEvent.click(t('No molestar (DND)'));
    fireEvent.click(t('Auto-atender'));
    fireEvent.click(t('Timbre de llamada'));
    fireEvent.click(t('Sonidos de interfaz'));
    expect(JSON.parse(localStorage.getItem('sp_prefs2'))).toEqual({ dnd: true, autoAnswer: true, ring: false, showIntercom: true, soundsUi: false });
    expect(mSounds.setUiSounds).toHaveBeenLastCalledWith(false);
    expect(mSounds.setRingSounds).toHaveBeenLastCalledWith(false);
    fireEvent.click(t('Mostrar Intercom'));
    expect(screen.queryByText('Intercom')).toBeNull();
    // sin Electron no hay fila de actualizaciones
    expect(screen.queryByText('Actualizaciones')).toBeNull();
  });

  it('esconder Intercom estando en Intercom vuelve al marcador', async () => {
    await montar({ cfg: CFG_OK });
    irA('Intercom');
    expect(screen.getByText('Cámaras y porteros')).toBeTruthy();
    irA('Ajustes');
    solapa('Preferencias');
    fireEvent.click(screen.getByText('Mostrar Intercom').parentElement.parentElement.querySelector('button'));
    expect(screen.queryByText('Intercom')).toBeNull();
  });

  it('las actualizaciones muestran cada estado y «Buscar» consulta la central', async () => {
    const { sphone } = await ajustes({ sphone: true, central: true }, 'Preferencias');
    expect(sphone.updateSetFeed).toHaveBeenCalledWith('https://pbx.ejemplo.test/descargas/softphone/');
    fireEvent.click(screen.getByText('Buscar'));
    expect(sphone.updateCheck).toHaveBeenCalled();
    expect(screen.getByText('Buscando…')).toBeTruthy();
    expect(screen.getByText('Buscar').disabled).toBe(true);
    await sphone.emitir('update', { state: 'available', version: '0.21.0' });
    expect(screen.getByText('Hay una version nueva: v0.21.0 · bajando…')).toBeTruthy();
    await sphone.emitir('update', { state: 'available' });
    expect(screen.getByText('Hay una version nueva: v? · bajando…')).toBeTruthy();
    await sphone.emitir('update', { state: 'downloading', percent: 42 });
    expect(screen.getByText('Bajando… 42%')).toBeTruthy();
    await sphone.emitir('update', { state: 'downloading' });
    expect(screen.getByText('Bajando… 0%')).toBeTruthy();
    await sphone.emitir('update', { state: 'downloaded', version: '0.21.0' });
    expect(screen.getByText('v0.21.0 lista: se instala al cerrar')).toBeTruthy();
    fireEvent.click(screen.getByText('Instalar y reiniciar'));
    expect(sphone.updateInstall).toHaveBeenCalled();
    await sphone.emitir('update', { state: 'downloaded' });
    expect(screen.getByText('v lista: se instala al cerrar')).toBeTruthy();
    await sphone.emitir('update', { state: 'error', msg: 'feed 404' });
    expect(screen.getByText('No se pudo consultar: feed 404')).toBeTruthy();
    await sphone.emitir('update', { state: 'error' });
    expect(screen.getByText('No se pudo consultar: error')).toBeTruthy();
    await sphone.emitir('update', { state: 'none' });
    expect(screen.getByText('Estas al dia.')).toBeTruthy();
    // el «estás al día» se va solo
    await avanzar(5000);
    expect(screen.queryByText('Estas al dia.')).toBeNull();
    await sphone.emitir('update', { state: 'raro' });
    expect(screen.getByText('Buscar').disabled).toBe(false);
  });

  it('si main no responde a buscar o instalar, la fila sigue en pie', async () => {
    const { sphone } = await ajustes({ sphone: { updateCheck: vi.fn(() => { throw new Error('x'); }), updateInstall: vi.fn(() => { throw new Error('x'); }) } }, 'Preferencias');
    fireEvent.click(screen.getByText('Buscar'));
    expect(screen.getByText('Buscando…')).toBeTruthy();
    await sphone.emitir('update', { state: 'downloaded', version: '1' });
    fireEvent.click(screen.getByText('Instalar y reiniciar'));
    expect(screen.getByText('Instalar y reiniciar')).toBeTruthy();
  });

  it('sin central el feed sale del WSS; sin ninguno de los dos no se toca', async () => {
    let r = await montar({ cfg: CFG_OK, sphone: true });
    expect(r.sphone.updateSetFeed).toHaveBeenCalledWith('https://pbx.ejemplo.test/descargas/softphone/');
    r.unmount();
    r = await montar({ cfg: CFG_SIP, sphone: true });
    expect(r.sphone.updateSetFeed).not.toHaveBeenCalled();
    r.unmount();
    r = await montar({ cfg: CFG_OK, sphone: { updateSetFeed: undefined } });
    expect(screen.getByText('Recientes')).toBeTruthy();
    r.unmount();
    await montar({ cfg: CFG_OK, sphone: { updateSetFeed: vi.fn(() => { throw new Error('ipc'); }) } });
    expect(screen.getByText('Recientes')).toBeTruthy();
  });
});

describe('reconexión automática', () => {
  it('al volver de suspensión y al recuperar la red vuelve a registrar', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true });
    const antes = estado.web.connect.mock.calls.length;
    await sphone.emitir('sys', 'lock');
    await sphone.emitir('sys', 'resume');
    await avanzar(1800);
    expect(sphone.sipDisconnect).toHaveBeenCalled();
    expect(estado.web.connect.mock.calls.length).toBe(antes + 1);
    window.dispatchEvent(new Event('online'));
    await avanzar(900);
    expect(estado.web.connect.mock.calls.length).toBe(antes + 2);
  });

  it('sin cuenta completa no intenta nada', async () => {
    await montar({ sphone: true });
    window.dispatchEvent(new Event('online'));
    await avanzar(900);
    expect(estado.web.connect).not.toHaveBeenCalled();
  });

  it('si el WSS principal falla prueba una vez con el de respaldo', async () => {
    await montar({ cfg: { ...CFG_OK, wssBackup: 'wss://respaldo.test/ws' } });
    await ponerSp({ reg: 'failed' });
    expect(estado.web.connect).toHaveBeenLastCalledWith(expect.objectContaining({ wss: 'wss://respaldo.test/ws', wssBackup: 'wss://pbx.ejemplo.test/ws' }));
    expect(store.config.wss).toBe('wss://respaldo.test/ws');
    const n = estado.web.connect.mock.calls.length;
    await ponerSp({ reg: 'connecting' });
    await ponerSp({ reg: 'failed' });
    expect(estado.web.connect.mock.calls.length).toBe(n);
    // registrado, se vuelve a habilitar el failover para la próxima caída
    await ponerSp({ reg: 'registered', registered: true });
    await ponerSp({ reg: 'failed', registered: false });
    expect(estado.web.connect.mock.calls.length).toBe(n + 1);
  });

  it('en SIP nativo no hay failover de WSS', async () => {
    await montar({ cfg: { ...CFG_SIP, wssBackup: 'wss://respaldo.test/ws' }, sphone: true });
    await ponerSp({ reg: 'failed' }, 'web');
    expect(estado.web.connect).not.toHaveBeenCalled();
  });

  it('al desmontar se dejan de escuchar los eventos del sistema', async () => {
    const { sphone, unmount } = await montar({ cfg: CFG_OK, sphone: true });
    unmount();
    expect(sphone.handlers.sys).toBeUndefined();
  });
});
