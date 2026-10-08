/* Una llamada de punta a punta, vista desde la ventana grande: entra, timbra, se atiende,
 * se habla, se transfiere o se corta, y al final queda el resumen de calidad.
 *
 * Es lo que el operador hace cincuenta veces por día. Se fija que cada botón llegue al
 * motor (y no a otro), que el aviso de entrante suene y haga temblar la ventana sólo
 * cuando corresponde, que «No molestar» y «Auto-atender» hagan lo que prometen, que la
 * ficha del cliente aparezca al timbrar, y que el widget flotante y las teclas rápidas
 * manejen la misma llamada que la ventana. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { montar, avanzar, ponerSp, estado, entrante, mApi, mSounds, mUseSip, CFG_OK, CFG_SIP, streamCon } from './helpers/pantallas-app.jsx';

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

afterEach(() => { vi.useRealTimers(); delete window.Notification; delete globalThis.Notification; });

const REG = { reg: 'registered', registered: true };
const titulo = (t) => screen.getByTitle(t);

function notificaciones(permiso) {
  const creadas = [];
  function N(t, o) { creadas.push({ t, o }); }
  N.permission = permiso;
  N.requestPermission = vi.fn();
  window.Notification = N; globalThis.Notification = N;
  return creadas;
}

describe('llamada entrante', () => {
  it('pide permiso de notificaciones una vez si nunca se contestó', async () => {
    notificaciones('default');
    await montar({ cfg: CFG_OK });
    expect(window.Notification.requestPermission).toHaveBeenCalled();
  });

  it('avisa, timbra, hace temblar la ventana y se atiende desde la pantalla', async () => {
    const avisos = notificaciones('granted');
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true, web: REG });
    await ponerSp({ incoming: entrante('2050') });
    expect(avisos).toEqual([{ t: 'Llamada entrante', o: { body: '2050' } }]);
    expect(mSounds.startIncomingRing).toHaveBeenCalled();
    expect(sphone.winShake).toHaveBeenCalledWith(true);
    expect(screen.getByText('Llamada entrante')).toBeTruthy();
    expect(sphone.miniState).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, incoming: true, number: '2050', ext: '2001', registered: true }));
    fireEvent.click(titulo('Atender'));
    expect(estado.web.accept).toHaveBeenCalledWith(false);
    fireEvent.click(titulo('Atender con video'));
    expect(estado.web.accept).toHaveBeenLastCalledWith(true);
    fireEvent.click(titulo('Rechazar'));
    expect(estado.web.reject).toHaveBeenCalled();
    // al atender se apagan el tono y el temblor aunque siga marcada como entrante
    mSounds.stopIncomingRing.mockClear();
    await ponerSp({ callInfo: { number: '2050', since: Date.now() } });
    expect(mSounds.stopIncomingRing).toHaveBeenCalled();
    expect(sphone.winShake).toHaveBeenLastCalledWith(false);
  });

  it('una videollamada entrante se anuncia como tal; sin número dice «desconocido»', async () => {
    const avisos = notificaciones('granted');
    await montar({ cfg: CFG_OK });
    await ponerSp({ incoming: { remoteIdentity: {} }, incomingVideo: true });
    expect(avisos[0]).toEqual({ t: 'Videollamada entrante', o: { body: 'desconocido' } });
    expect(screen.getByText('desconocido')).toBeTruthy();
  });

  it('en SIP nativo no se ofrece atender con video', async () => {
    await montar({ cfg: CFG_SIP, sphone: true });
    await ponerSp({ incoming: entrante('2050') }, 'nat');
    expect(screen.queryByTitle('Atender con video')).toBeNull();
    fireEvent.click(titulo('Atender'));
    expect(estado.nat.accept).toHaveBeenCalledWith(false);
  });

  it('la ficha del CRM aparece al timbrar, con los autorizados', async () => {
    mApi.clientsLookup.mockResolvedValue({ id: 'c1', name: 'Casa Pérez', address: 'Av. Siempre Viva 742', persons: [{ name: 'Ana' }, { name: 'Beto' }, { name: 'Caro' }, { name: 'Dani' }] });
    const { sphone } = await montar({ cfg: CFG_OK, central: true, sphone: true });
    await ponerSp({ incoming: entrante('099111') });
    await avanzar(0);
    expect(mApi.clientsLookup).toHaveBeenCalledWith('099111');
    expect(screen.getByText('Casa Pérez (099111)')).toBeTruthy();
    expect(screen.getByText('CRM')).toBeTruthy();
    expect(screen.getByText('Av. Siempre Viva 742')).toBeTruthy();
    expect(screen.getByText('Ana, Beto, Caro…', { exact: false })).toBeTruthy();
    expect(sphone.miniState).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Casa Pérez' }));
    // al cortar la ficha se olvida
    await ponerSp({ incoming: null });
    expect(screen.queryByText('Casa Pérez (099111)')).toBeNull();
  });

  it('sin central la ficha sale de los clientes guardados en el aparato', async () => {
    await montar({ cfg: CFG_OK, clientes: [{ id: 'loc_1', name: 'Garaje Sur', phones: ['2070'], devices: [] }] });
    await ponerSp({ incoming: entrante('2070') });
    expect(screen.getByText('Garaje Sur (2070)')).toBeTruthy();
    expect(mApi.clientsLookup).not.toHaveBeenCalled();
  });

  it('si la central no lo conoce o falla, sirve el cliente del aparato', async () => {
    mApi.clientsLookup.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('caída'));
    await montar({ cfg: CFG_OK, central: true, clientes: [{ id: 'loc_1', name: 'Garaje Sur', phones: ['2070'], devices: [] }] });
    await ponerSp({ incoming: entrante('2070') });
    await avanzar(0);
    expect(screen.getByText('Garaje Sur (2070)')).toBeTruthy();
    await ponerSp({ incoming: null });
    await ponerSp({ incoming: entrante('2070') });
    await avanzar(0);
    expect(screen.getByText('Garaje Sur (2070)')).toBeTruthy();
  });

  it('un número que no está en ningún lado no muestra ficha', async () => {
    mApi.clientsLookup.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('x'));
    await montar({ cfg: CFG_OK, central: true });
    await ponerSp({ incoming: entrante('555') });
    await avanzar(0);
    expect(screen.queryByText('CRM')).toBeNull();
    await ponerSp({ incoming: null });
    await ponerSp({ incoming: entrante('556') });
    await avanzar(0);
    expect(screen.queryByText('CRM')).toBeNull();
  });
});

describe('preferencias que actúan sobre la entrante', () => {
  it('«No molestar» rechaza sin timbrar', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true, prefs: { dnd: true } });
    await ponerSp({ incoming: entrante('2050') });
    expect(estado.web.reject).toHaveBeenCalled();
    expect(mSounds.startIncomingRing).not.toHaveBeenCalled();
    expect(sphone.winShake).not.toHaveBeenCalledWith(true);
  });

  it('«Auto-atender» contesta pasado poco más de un segundo', async () => {
    await montar({ cfg: CFG_OK, prefs: { autoAnswer: true } });
    await ponerSp({ incoming: entrante('2050') });
    await avanzar(1000);
    expect(estado.web.accept).not.toHaveBeenCalled();
    await avanzar(300);
    expect(estado.web.accept).toHaveBeenCalledWith(false);
  });

  it('con el timbre apagado no suena ni el entrante ni el de llamada saliente', async () => {
    await montar({ cfg: CFG_OK, prefs: { ring: false } });
    await ponerSp({ incoming: entrante('2050') });
    expect(mSounds.startIncomingRing).not.toHaveBeenCalled();
    await ponerSp({ incoming: null, inCall: true, callInfo: { number: '2002', since: 0 } });
    expect(mSounds.startRingback).not.toHaveBeenCalled();
    expect(mSounds.setRingSounds).toHaveBeenCalledWith(false);
  });

  it('preferencias guardadas corruptas no rompen el arranque', async () => {
    await montar({ cfg: CFG_OK, prefsCrudas: '{no es json' });
    expect(screen.getByText('Recientes')).toBeTruthy();
  });
});

describe('llamada saliente y en curso', () => {
  it('mientras timbra suena el ringback y se puede cortar', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true, web: REG });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: 0 } });
    expect(mSounds.startRingback).toHaveBeenCalled();
    expect(screen.getByText('Timbrando')).toBeTruthy();
    fireEvent.click(titulo('Cortar'));
    expect(estado.web.hangup).toHaveBeenCalled();
    await ponerSp({ note: 'Ocupado' });
    expect(screen.getByText('Ocupado')).toBeTruthy();
    expect(sphone.miniState).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, incoming: false, number: '2002' }));
  });

  it('la barra de la llamada maneja micrófono, altavoz, espera, cámara y teclado', async () => {
    await montar({ cfg: CFG_OK, web: REG });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: Date.now() }, usingRelay: true, quality: { score: 3 } });
    expect(screen.getByText('TURN')).toBeTruthy();
    fireEvent.click(titulo('Micrófono'));
    expect(estado.web.toggleMute).toHaveBeenCalled();
    fireEvent.click(titulo('Altavoz'));
    expect(estado.web.toggleSpeaker).toHaveBeenCalled();
    fireEvent.click(titulo('En espera'));
    expect(estado.web.toggleHold).toHaveBeenCalled();
    fireEvent.click(titulo('Cámara web'));
    expect(estado.web.toggleVideo).toHaveBeenCalled();
    fireEvent.click(titulo('Teclado'));
    const tecla5 = document.querySelectorAll('.cs-tecla')[4];
    fireEvent.click(tecla5);
    expect(estado.web.sendDtmf).toHaveBeenCalledWith('5');
    // en llamada las teclas no se suman al buscador del marcador
    expect(screen.getByPlaceholderText('Ingresá nombre o número').value).toBe('');
    fireEvent.click(titulo('Terminar la llamada'));
    expect(estado.web.hangup).toHaveBeenCalled();
    await ponerSp({ held: true });
    expect(screen.getAllByText('En espera').length).toBeGreaterThan(0);
  });

  it('transferir abre el diálogo: ciega, atendida, Enter y cancelar', async () => {
    await montar({ cfg: CFG_OK, web: REG });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: Date.now() } });
    fireEvent.click(titulo('Transferir'));
    const campo = screen.getByPlaceholderText('Interno o número');
    expect(screen.getByText('Ciega').disabled).toBe(true);
    fireEvent.change(campo, { target: { value: '20a03' } });
    expect(campo.value).toBe('2003');
    fireEvent.click(screen.getByText('Ciega'));
    expect(estado.web.transfer).toHaveBeenCalledWith('2003');
    expect(screen.queryByText('Transferir llamada')).toBeNull();

    fireEvent.click(titulo('Transferir'));
    fireEvent.change(screen.getByPlaceholderText('Interno o número'), { target: { value: '2004' } });
    fireEvent.click(screen.getByText('Atendida'));
    expect(estado.web.attendedCall).toHaveBeenCalledWith('2004');

    fireEvent.click(titulo('Transferir'));
    // el número del intento anterior no queda escrito
    expect(screen.getByPlaceholderText('Interno o número').value).toBe('');
    fireEvent.keyDown(screen.getByPlaceholderText('Interno o número'), { key: 'Enter' });
    expect(screen.getByText('Transferir llamada')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Interno o número'), { target: { value: '2005' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Interno o número'), { key: 'Enter' });
    expect(estado.web.transfer).toHaveBeenLastCalledWith('2005');

    fireEvent.click(titulo('Transferir'));
    fireEvent.click(screen.getByText('Transferir llamada'));      // adentro: no cierra
    fireEvent.click(screen.getByText('Cancelar'));
    expect(screen.queryByText('Transferir llamada')).toBeNull();
    fireEvent.click(titulo('Transferir'));
    fireEvent.click(document.querySelector('.call-overlay'));
    expect(screen.queryByText('Transferir llamada')).toBeNull();
  });

  it('con una consulta en curso, transferir no abre otro diálogo y la barra deja completar', async () => {
    await montar({ cfg: CFG_OK, web: REG });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: Date.now() }, attended: { number: '2003', state: 'calling' } });
    expect(screen.getByText('llamando…', { exact: false })).toBeTruthy();
    fireEvent.click(titulo('Transferir'));
    expect(screen.queryByText('Transferir llamada')).toBeNull();
    fireEvent.click(screen.getByText('Completar'));
    expect(estado.web.completeAttended).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancelar'));
    expect(estado.web.cancelAttended).toHaveBeenCalled();
    await ponerSp({ attended: { number: '2003', state: 'talking' } });
    expect(document.body.textContent).toContain('Consultando a 2003 · en línea');
    await ponerSp({ attended: { number: '2003', state: 'terminada' } });
    expect(document.body.textContent).toContain('Consultando a 2003 · terminada');
  });

  it('la otra línea en espera se cambia o se une; la conferencia se anuncia', async () => {
    await montar({ cfg: CFG_OK, web: REG });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: Date.now() }, heldInfo: { number: '2009' }, conf: true });
    expect(screen.getByText(/2009 en espera/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cambiar'));
    expect(estado.web.switchLine).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Unir'));
    expect(estado.web.conference).toHaveBeenCalled();
    expect(screen.getByText('● Conferencia activa')).toBeTruthy();
  });

  it('«Más» graba la llamada (con central) e invita a la conferencia', async () => {
    mApi.recordCall.mockResolvedValueOnce({}).mockResolvedValueOnce({ error: 'no' }).mockRejectedValueOnce(new Error('x'));
    vi.spyOn(window, 'prompt').mockReturnValueOnce(' 2011 ').mockReturnValueOnce('  ');
    await montar({ cfg: CFG_OK, web: REG, central: true });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: Date.now() } });
    fireEvent.click(titulo('Más'));
    const grabar = screen.getByText('Grabar la llamada');
    fireEvent.mouseEnter(grabar); fireEvent.mouseLeave(grabar);
    fireEvent.click(grabar);
    await avanzar(0);
    expect(mApi.recordCall).toHaveBeenCalledWith('2001', 'start');
    fireEvent.click(titulo('Más'));
    fireEvent.click(screen.getByText('Grabando…'));
    await avanzar(0);
    // la central contestó con error: sigue grabando
    expect(mApi.recordCall).toHaveBeenLastCalledWith('2001', 'stop');
    fireEvent.click(titulo('Más'));
    fireEvent.click(screen.getByText('Grabando…'));
    await avanzar(0);
    fireEvent.click(titulo('Más'));
    expect(screen.getByText('Grabando…')).toBeTruthy();
    fireEvent.click(screen.getByText('Invitar a la llamada'));
    expect(estado.web.attendedCall).toHaveBeenCalledWith('2011');
    fireEvent.click(titulo('Más'));
    fireEvent.click(screen.getByText('Invitar a la llamada'));
    expect(estado.web.attendedCall).toHaveBeenCalledTimes(1);
    // tocar afuera del menú lo cierra
    fireEvent.click(titulo('Más'));
    fireEvent.click(document.querySelector('.cs-mas-fuera'));
    expect(screen.queryByText('Invitar a la llamada')).toBeNull();
    // el teclado cierra el menú y viceversa
    fireEvent.click(titulo('Más'));
    fireEvent.click(titulo('Teclado'));
    expect(screen.queryByText('Invitar a la llamada')).toBeNull();
    // al cortar se apaga la marca de grabación
    await ponerSp({ inCall: false, callInfo: null });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: Date.now() } });
    fireEvent.click(titulo('Más'));
    expect(screen.getByText('Grabar la llamada')).toBeTruthy();
  });

  it('con una consulta ya en curso «Invitar» no abre otra', async () => {
    const pr = vi.spyOn(window, 'prompt');
    await montar({ cfg: CFG_OK, web: REG });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: Date.now() }, attended: { number: '2003', state: 'talking' } });
    fireEvent.click(titulo('Más'));
    expect(screen.queryByText('Grabar la llamada')).toBeNull();   // sin central no se graba
    fireEvent.click(screen.getByText('Invitar a la llamada'));
    expect(pr).not.toHaveBeenCalled();
  });

  it('en SIP nativo «Más» no ofrece invitar', async () => {
    await montar({ cfg: CFG_SIP, sphone: true, central: true });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: Date.now() } }, 'nat');
    fireEvent.click(titulo('Más'));
    expect(screen.getByText('Grabar la llamada')).toBeTruthy();
    expect(screen.queryByText('Invitar a la llamada')).toBeNull();
  });
});

describe('fin de la llamada', () => {
  async function hablarYCortar(calidades, extra = {}) {
    await montar({ cfg: CFG_OK, web: REG });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: Date.now() }, usingRelay: extra.relay ?? null });
    for (const q of calidades) await ponerSp({ quality: q });
    await avanzar(10000);
    await ponerSp({ inCall: false, callInfo: null });
  }

  it('muestra «Llamada finalizada» con la duración y se va sola', async () => {
    await hablarYCortar([{ score: 4, codec: 'opus' }], { relay: true });
    expect(screen.getAllByText('Llamada finalizada').length).toBeGreaterThan(0);
    expect(screen.getByText('Duración 0:10')).toBeTruthy();
    await avanzar(1600);
    expect(document.querySelector('.cs-sale')).toBeTruthy();
    await avanzar(200);
    expect(document.querySelector('.cs-raiz')).toBeNull();
  });

  it('el resumen dice la calidad, el códec y si pasó por TURN; se cierra solo o con la X', async () => {
    await hablarYCortar([{ score: 4, codec: 'opus' }, { score: 3 }], { relay: true });
    expect(screen.getByText('Llamada finalizada · 0:10')).toBeTruthy();
    expect(screen.getByText('Excelente')).toBeTruthy();
    expect(screen.getByText('opus · TURN')).toBeTruthy();
    const toast = screen.getByText('Excelente').closest('.menu-pop');
    fireEvent.click(toast.querySelector('button'));
    expect(screen.queryByText('Excelente')).toBeNull();
  });

  it.each([
    [[{ score: 3 }], 'Buena'],
    [[{ score: 2 }], 'Regular'],
    [[{ score: 1 }], 'Mala'],
    [[], 'sin datos'],
  ])('calidad %j se lee «%s»', async (qs, txt) => {
    await hablarYCortar(qs);
    expect(screen.getByText(txt)).toBeTruthy();
    expect(screen.getByText('audio')).toBeTruthy();
    await avanzar(9000);
    expect(screen.queryByText(txt)).toBeNull();
  });

  it('una llamada que nunca se atendió termina sin resumen de calidad', async () => {
    await montar({ cfg: CFG_OK, web: REG });
    await ponerSp({ inCall: true, callInfo: { number: '2002', since: 0 } });
    await ponerSp({ inCall: false, callInfo: null });
    expect(screen.getByText('Llamada finalizada')).toBeTruthy();
    expect(screen.queryByText(/Llamada finalizada ·/)).toBeNull();
    // si entra otra mientras se muestra el final, el final se corta
    await ponerSp({ incoming: entrante('2050') });
    expect(screen.getByText('Llamada entrante')).toBeTruthy();
  });
});

describe('teclas rápidas, enlaces tel: y widget flotante', () => {
  it('las teclas rápidas atienden, cortan, rechazan y silencian', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true });
    await sphone.emitir('hotkey', 'answer');
    await sphone.emitir('hotkey', 'hangup');
    await sphone.emitir('hotkey', 'mute');
    expect(estado.web.accept).not.toHaveBeenCalled();
    expect(estado.web.hangup).not.toHaveBeenCalled();
    expect(estado.web.toggleMute).not.toHaveBeenCalled();
    await ponerSp({ incoming: entrante('2050') });
    await sphone.emitir('hotkey', 'answer');
    expect(estado.web.accept).toHaveBeenCalled();
    await sphone.emitir('hotkey', 'hangup');
    expect(estado.web.reject).toHaveBeenCalled();
    await ponerSp({ incoming: null, inCall: true, callInfo: { number: '1', since: 1 } });
    await sphone.emitir('hotkey', 'hangup');
    expect(estado.web.hangup).toHaveBeenCalled();
    await sphone.emitir('hotkey', 'mute');
    expect(estado.web.toggleMute).toHaveBeenCalled();
  });

  it('un tel: abierto desde el sistema marca; vacío sólo vuelve al marcador', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true });
    await sphone.emitir('dial', '');
    expect(estado.web.placeCall).not.toHaveBeenCalled();
    await sphone.emitir('dial', '2002');
    expect(estado.web.placeCall).toHaveBeenCalledWith('2002', false);
  });

  it('el widget maneja la llamada en curso y la entrante', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true });
    await sphone.emitir('mini', 'mute');
    await sphone.emitir('mini', { a: 'hold' });
    await sphone.emitir('mini', 'hangup');
    await sphone.emitir('mini', 'accept');
    await sphone.emitir('mini', 'accept-video');
    await sphone.emitir('mini', 'reject');
    await sphone.emitir('mini', { a: 'volume', v: 0.4 });
    await sphone.emitir('mini', { a: 'volume', v: 'fuerte' });
    await sphone.emitir('mini', null);
    expect(estado.web.toggleMute).toHaveBeenCalled();
    expect(estado.web.toggleHold).toHaveBeenCalled();
    expect(estado.web.hangup).toHaveBeenCalled();
    expect(estado.web.accept.mock.calls).toEqual([[false], [true]]);
    expect(estado.web.reject).toHaveBeenCalled();
    expect(estado.web.setVolume.mock.calls).toEqual([[0.4]]);
  });

  it('«hold» desde el widget no rompe si el motor no sabe poner en espera', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true, web: { toggleHold: undefined } });
    await sphone.emitir('mini', 'hold');
    expect(screen.getByText('Recientes')).toBeTruthy();
  });

  it('el widget abre el marcador o los dispositivos de la ventana grande', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true });
    await sphone.emitir('mini', 'devices');
    expect(screen.getByText('DISPOSITIVOS')).toBeTruthy();
    await sphone.emitir('mini', 'dial');
    await avanzar(250);
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Ingresá nombre o número'));
  });

  it('el widget busca en la agenda y marca lo elegido', async () => {
    mApi.directory.mockResolvedValue([{ ext: '2002', name: 'Ana' }, { number: '2003', cn: 'Bruno' }, { exten: '3000', callerid: 'Carla' }, { name: 'Sin número' }]);
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true, central: true });
    await avanzar(0);
    await sphone.emitir('mini', { a: 'buscar', v: '200' });
    expect(sphone.miniData).toHaveBeenLastCalledWith({ tipo: 'sug', items: [{ n: '2002', nm: 'Ana' }, { n: '2003', nm: 'Bruno' }] });
    await sphone.emitir('mini', { a: 'buscar', v: 'CAR' });
    expect(sphone.miniData).toHaveBeenLastCalledWith({ tipo: 'sug', items: [{ n: '3000', nm: 'Carla' }] });
    await sphone.emitir('mini', { a: 'buscar', v: '  ' });
    expect(sphone.miniData).toHaveBeenLastCalledWith({ tipo: 'sug', items: [] });
    await sphone.emitir('mini', { a: 'marcar', v: ' ' });
    expect(estado.web.placeCall).not.toHaveBeenCalled();
    await sphone.emitir('mini', { a: 'marcar', v: ' 2002 ' });
    expect(estado.web.placeCall).toHaveBeenCalledWith('2002', false);
  });

  it('el widget pide los dispositivos y cambia micrófono y altavoz', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true });
    await sphone.emitir('mini', 'medios');
    expect(sphone.miniData).toHaveBeenLastCalledWith({
      tipo: 'medios',
      mics: [{ id: 'm1', l: 'Micrófono (2- DM30 RGB USB Microphone)' }, { id: 'm2', l: 'Micrófono' }],
      spks: [{ id: 's1', l: 'Parlantes' }],
      mic: '', spk: '', permiso: true,
    });
    await sphone.emitir('mini', { a: 'set-mic', v: 'm2' });
    await avanzar(70);
    expect(mUseSip.setDevPref).toHaveBeenCalledWith('mic', 'm2');
    expect(sphone.miniData).toHaveBeenLastCalledWith(expect.objectContaining({ mic: 'm2' }));
    await sphone.emitir('mini', { a: 'set-spk', v: 's1' });
    await avanzar(70);
    expect(estado.web.applySpeaker).toHaveBeenCalledWith('s1');
    expect(sphone.miniData).toHaveBeenLastCalledWith(expect.objectContaining({ spk: 's1' }));
  });

  it('si leer dispositivos falla, el widget recibe la última lista conocida', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, sphone: true });
    await avanzar(0);
    mUseSip.listDevices.mockRejectedValueOnce(new Error('sin permiso'));
    await sphone.emitir('mini', 'medios');
    await avanzar(0);
    expect(sphone.miniData).toHaveBeenLastCalledWith(expect.objectContaining({ tipo: 'medios', mics: expect.any(Array) }));
    // sin mics ni parlantes en la lista y sin permiso
    mUseSip.listDevices.mockResolvedValueOnce({ permiso: false });
    await sphone.emitir('mini', 'medios');
    await avanzar(0);
    expect(sphone.miniData).toHaveBeenLastCalledWith(expect.objectContaining({ mics: [], spks: [], permiso: false }));
  });

  it('enchufar un dispositivo vuelve a leer la lista', async () => {
    const oyentes = {};
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { addEventListener: (k, f) => { oyentes[k] = f; }, removeEventListener: vi.fn() } });
    const { unmount } = await montar({ cfg: CFG_OK });
    const antes = mUseSip.listDevices.mock.calls.length;
    oyentes.devicechange();
    expect(mUseSip.listDevices.mock.calls.length).toBe(antes + 1);
    unmount();
    expect(navigator.mediaDevices.removeEventListener).toHaveBeenCalledWith('devicechange', oyentes.devicechange);
    delete navigator.mediaDevices;
  });
});

describe('video y cámaras durante la llamada', () => {
  it('con video del otro lado lo conecta a la pantalla y a la miniatura propia', async () => {
    const remoto = streamCon('live');
    const propio = streamCon('live');
    const remoteVideoRef = { current: null }, localVideoRef = { current: null };
    await montar({ cfg: CFG_OK, web: { ...REG, remoteVideoRef, localVideoRef, getRemoteStream: () => remoto, getLocalStream: () => propio } });
    await ponerSp({ inCall: true, videoOn: true, callInfo: { number: '2002', since: Date.now() } });
    await avanzar(800);
    expect(remoteVideoRef.current.srcObject).toBe(remoto);
    expect(localVideoRef.current.srcObject).toBe(propio);
    expect(document.querySelector('.cs-modo-video')).toBeTruthy();
  });

  it('el portero sin video muestra la cámara del cliente y se puede volver a la llamada', async () => {
    mApi.clientsLookup.mockResolvedValue({ id: 'c1', name: 'Casa', devices: [{ id: 'd1', label: 'Frente', src: 'frente', base: 'http://g2.test' }, { id: 'd2', label: 'Garaje', src: 'garaje', base: 'http://g2.test' }] });
    await montar({ cfg: CFG_OK, central: true, web: { ...REG, getRemoteStream: () => streamCon('live', true) } });
    await ponerSp({ inCall: true, videoOn: true, callInfo: { number: '2010', since: Date.now() } });
    await avanzar(0);
    await avanzar(0);
    const main = document.querySelector('.cs-fuente-main');
    expect(main.textContent).toMatch(/Frente/);
    // sin MediaSource el visor dice «Sin señal» en vez de quedar en negro
    expect(screen.getAllByText('Sin señal').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTitle('Ver «Garaje» en grande'));
    expect(document.querySelector('.cs-fuente-main').textContent).toMatch(/Garaje/);
    fireEvent.click(screen.getByTitle('Ver «2010» en grande'.replace('2010', 'Casa')));
    expect(document.querySelector('.cs-fuente-main .cs-video-remoto')).toBeTruthy();
  });

  it('una entrante que anuncia video no enciende las cámaras del cliente', async () => {
    mApi.clientsLookup.mockResolvedValue({ id: 'c1', name: 'Casa', devices: [{ id: 'd1', label: 'Frente', src: 'frente', base: 'http://g2.test' }] });
    await montar({ cfg: CFG_OK, central: true });
    await ponerSp({ incoming: entrante('2010'), incomingVideo: true });
    await avanzar(0);
    expect(document.querySelector('.cs-fuente')).toBeNull();
    await ponerSp({ incomingVideo: false });
    expect(document.querySelector('.cs-fuente')).toBeTruthy();
    // el portero no trae video: aunque se vea la cámara, el rótulo no promete una videollamada
    const caja = document.querySelector('.cs-video-entrante');
    expect(caja.textContent).toContain('Llamada entrante');
    expect(caja.textContent).not.toContain('Videollamada');
    // atender sigue a mano encima de la imagen
    fireEvent.click(document.querySelector('.cs-video-entrante [title=Atender]'));
    expect(estado.web.accept).toHaveBeenCalledWith(false);
  });
});
