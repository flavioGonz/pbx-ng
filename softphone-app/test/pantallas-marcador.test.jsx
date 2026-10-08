/* El marcador y las llamadas recientes: lo que el operador tiene delante todo el día.
 *
 * Fija que marcar mande el número limpio al motor (y tonos DTMF), que el buscador sugiera
 * internos de la agenda con su estado en vivo, que el historial venga de la central cuando
 * hay sesión (y del aparato si no), y que la ficha de una llamada encuentre su grabación.
 * Un número mal armado o una lista que dice «Sin llamadas» cuando sí las hay es tiempo
 * perdido en cada turno. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { montar, avanzar, ponerSp, estado, mApi, mSounds, CFG_OK, irA } from './helpers/pantallas-app.jsx';

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

afterEach(() => { vi.useRealTimers(); delete document.startViewTransition; });

const buscador = () => screen.getByPlaceholderText('Ingresá nombre o número');
const tecla = (k) => screen.getAllByText(k).find((e) => e.parentElement && e.parentElement.className === 'ph-key').parentElement;
const HOY = new Date('2026-10-08T11:30:00').getTime();
const VIEJA = new Date('2026-09-24T15:12:00').getTime();

describe('arranque con cuenta guardada', () => {
  it('registra solo, muestra el interno y el estado en la cabecera', async () => {
    await montar({ cfg: CFG_OK });
    expect(estado.web.connect).toHaveBeenCalledWith(expect.objectContaining({ ext: '2001' }));
    expect(screen.getByText('Interno 2001')).toBeTruthy();
    expect(screen.getByText(/2001 · sin conectar/)).toBeTruthy();
    expect(screen.getByText('Sin TURN')).toBeTruthy();
    await ponerSp({ reg: 'connecting' });
    expect(screen.getByText(/conectando…/)).toBeTruthy();
    await ponerSp({ reg: 'registered', registered: true });
    expect(screen.getByText(/2001 · en línea/)).toBeTruthy();
  });

  it('un motivo de falla largo se recorta en la cabecera', async () => {
    await montar({ cfg: { ...CFG_OK, name: 'Recepción' } });
    await ponerSp({ reg: 'failed', note: 'x'.repeat(60) });
    expect(screen.getByText('Recepción')).toBeTruthy();
    expect(screen.getByText(/error de registro/)).toBeTruthy();
    expect(screen.getByText(new RegExp('^· x{46}…$'))).toBeTruthy();
  });

  it('el buscador toma el foco al quedar libre el marcador', async () => {
    await montar({ cfg: CFG_OK });
    await avanzar(150);
    expect(document.activeElement).toBe(buscador());
  });
});

describe('teclado y botones de llamar', () => {
  it('cada tecla suena, manda DTMF y se suma al número; borrar quita la última', async () => {
    await montar({ cfg: CFG_OK });
    fireEvent.click(tecla('2'));
    fireEvent.click(tecla('0'));
    fireEvent.click(tecla('#'));
    expect(mSounds.uiKey).toHaveBeenCalledTimes(3);
    expect(estado.web.sendDtmf).toHaveBeenCalledWith('#');
    expect(buscador().value).toBe('20#');
    fireEvent.click(screen.getByTitle('Borrar'));
    expect(buscador().value).toBe('20');
  });

  it('sin registro no se puede llamar; registrado llama y limpia el número', async () => {
    await montar({ cfg: CFG_OK });
    fireEvent.change(buscador(), { target: { value: '2002' } });
    expect(screen.getByTitle('Llamar').disabled).toBe(true);
    expect(screen.getByTitle('Videollamada').disabled).toBe(true);
    await ponerSp({ reg: 'registered', registered: true });
    fireEvent.click(screen.getByTitle('Llamar'));
    expect(estado.web.placeCall).toHaveBeenCalledWith('2002', false);
    await avanzar(0);
    expect(buscador().value).toBe('');
    fireEvent.change(buscador(), { target: { value: ' 2003 ' } });
    fireEvent.click(screen.getByTitle('Videollamada'));
    expect(estado.web.placeCall).toHaveBeenLastCalledWith('2003', true);
  });

  it('un número vacío no dispara la llamada', async () => {
    await montar({ cfg: CFG_OK, web: { reg: 'registered', registered: true } });
    fireEvent.click(screen.getByTitle('Llamar'));
    fireEvent.keyDown(buscador(), { key: 'Enter' });
    expect(estado.web.placeCall).not.toHaveBeenCalled();
  });

  it('el buscador descarta caracteres que no se marcan y Enter llama', async () => {
    await montar({ cfg: CFG_OK, web: { reg: 'registered', registered: true } });
    fireEvent.change(buscador(), { target: { value: '09$9(1)' } });
    expect(buscador().value).toBe('0991');
    fireEvent.keyDown(buscador(), { key: 'x' });
    expect(estado.web.placeCall).not.toHaveBeenCalled();
    fireEvent.keyDown(buscador(), { key: 'Enter' });
    expect(estado.web.placeCall).toHaveBeenCalledWith('0991', false);
  });

  it('el cambio de sección usa la transición de vista cuando existe', async () => {
    const vt = vi.fn((cb) => cb());
    document.startViewTransition = vt;
    await montar({ cfg: CFG_OK });
    irA('Contactos');
    expect(vt).toHaveBeenCalled();
    expect(screen.getByText(/Conectá el sistema PBX-NG/)).toBeTruthy();
    // si la transición falla, igual se cambia de sección
    document.startViewTransition = () => { throw new Error('no'); };
    irA('Llamadas');
    expect(buscador()).toBeTruthy();
  });
});

describe('sugerencias de la agenda', () => {
  const agenda = [
    { ext: '2002', name: 'Ana Pérez' },
    { number: '2003', cn: 'Bruno' },
    { exten: '2004', callerid: 'Carla' },
    { ext: '2005', name: 'Diego' },
    { ext: '2006' },
  ];
  async function conAgenda() {
    mApi.directory.mockResolvedValue(agenda);
    mApi.presence.mockResolvedValue({ 2002: 'NOT_INUSE', 2003: 'InUse', 2004: 'ringing', 2005: 'unavailable' });
    await montar({ cfg: CFG_OK, central: true, web: { reg: 'registered', registered: true } });
    await avanzar(0);
  }

  it('busca por número o por nombre, con el estado de cada interno', async () => {
    await conAgenda();
    fireEvent.change(buscador(), { target: { value: '200' } });
    expect(screen.getByText('Ana Pérez')).toBeTruthy();
    expect(screen.getByText('Bruno')).toBeTruthy();
    expect(screen.getByText('Carla')).toBeTruthy();
    // el teclado se esconde mientras hay sugerencias
    expect(screen.queryByText('PQRS')).toBeNull();
    fireEvent.change(buscador(), { target: { value: 'bru' } });
    expect(screen.queryByText('Ana Pérez')).toBeNull();
    expect(screen.getByText('Bruno')).toBeTruthy();
  });

  it('elegir una sugerencia la pone en el buscador; Enter llama a la primera', async () => {
    await conAgenda();
    fireEvent.change(buscador(), { target: { value: 'ana' } });
    fireEvent.click(screen.getByText('Ana Pérez'));
    expect(buscador().value).toBe('2002');
    fireEvent.change(buscador(), { target: { value: 'car' } });
    fireEvent.keyDown(buscador(), { key: 'Enter' });
    expect(estado.web.placeCall).toHaveBeenCalledWith('2004', false);
  });

  it('cada sugerencia tiene llamar y video sin abrirla', async () => {
    await conAgenda();
    fireEvent.change(buscador(), { target: { value: 'die' } });
    const fila = screen.getByText('Diego').closest('.dd-row');
    fireEvent.click(fila.querySelector('[title=Video]'));
    expect(estado.web.placeCall).toHaveBeenCalledWith('2005', true);
    fireEvent.click(fila.querySelector('[title=Llamar]'));
    expect(estado.web.placeCall).toHaveBeenLastCalledWith('2005', false);
    expect(buscador().value).toBe('die');
  });

  it('la presencia se vuelve a pedir cada 8 s', async () => {
    await conAgenda();
    const antes = mApi.presence.mock.calls.length;
    await avanzar(8000);
    expect(mApi.presence.mock.calls.length).toBe(antes + 1);
  });

  it('si la agenda no llega, no hay sugerencias y queda el teclado', async () => {
    mApi.directory.mockRejectedValue(new Error('403'));
    mApi.presence.mockRejectedValue(new Error('403'));
    await montar({ cfg: CFG_OK, central: true });
    await avanzar(0);
    fireEvent.change(buscador(), { target: { value: 'a' } });
    expect(screen.getByText('PQRS')).toBeTruthy();
  });
});

describe('recientes del aparato', () => {
  const hist = [
    { number: '2002', dir: 'out', dur: 65, t: HOY, video: true },
    { number: '099123', dir: 'in', missed: true, dur: 0, t: VIEJA },
    { number: '2010', name: 'Portería', dir: 'in', dur: 5, t: HOY },
  ];

  it('vacío dice «Sin llamadas»', async () => {
    await montar({ cfg: CFG_OK });
    expect(screen.getByText('Sin llamadas')).toBeTruthy();
    expect(screen.queryByText('Borrar')).toBeNull();
  });

  it('lista sentido, duración y fecha corta; «Borrar» limpia el historial', async () => {
    await montar({ cfg: CFG_OK, web: { hist } });
    expect(screen.getByText('1:05')).toBeTruthy();
    expect(screen.getByText('No establecido')).toBeTruthy();
    expect(screen.getAllByText('11:30').length).toBe(2);
    expect(screen.getByText('24/9 15:12')).toBeTruthy();
    expect(screen.getByText('Portería')).toBeTruthy();
    expect(screen.getByTitle('con video')).toBeTruthy();
    fireEvent.click(screen.getByText('Borrar'));
    expect(estado.web.clearHist).toHaveBeenCalled();
  });

  it('los botones de la fila llaman sin abrir la ficha', async () => {
    await montar({ cfg: CFG_OK, web: { hist } });
    const fila = screen.getAllByText('099123')[0].closest('.ph-row');
    fireEvent.click(fila.querySelector('[title=Videollamada]'));
    expect(estado.web.placeCall).toHaveBeenCalledWith('099123', true);
    fireEvent.click(fila.querySelector('[title=Llamar]'));
    expect(estado.web.placeCall).toHaveBeenLastCalledWith('099123', false);
    expect(screen.queryByText('Grabación')).toBeNull();
  });

  it('la ficha de una llamada sin central pide conectar para escuchar grabaciones', async () => {
    await montar({ cfg: CFG_OK, web: { hist } });
    fireEvent.click(screen.getAllByText('2002')[0].closest('.ph-row'));
    expect(screen.getByText('Saliente · Video')).toBeTruthy();
    expect(screen.getByText(/Conectá el sistema \(Ajustes\)/)).toBeTruthy();
    expect(mApi.matchRecording).not.toHaveBeenCalled();
    // el clic adentro no la cierra; afuera sí
    fireEvent.click(screen.getByText('Grabación'));
    expect(screen.getByText('Saliente · Video')).toBeTruthy();
    fireEvent.click(screen.getByText('Llamar', { selector: 'button' }));
    expect(estado.web.placeCall).toHaveBeenCalledWith('2002', false);
    expect(screen.queryByText('Saliente · Video')).toBeNull();
  });

  it('la ficha muestra «Perdida» y «Entrante», y se cierra con la X o tocando afuera', async () => {
    await montar({ cfg: CFG_OK, web: { hist } });
    fireEvent.click(screen.getAllByText('099123')[0].closest('.ph-row'));
    expect(screen.getByText('Perdida')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    fireEvent.click(screen.getByText('Video', { selector: 'button' }));
    expect(estado.web.placeCall).toHaveBeenCalledWith('099123', true);
    fireEvent.click(screen.getByText('Portería').closest('.ph-row'));
    expect(screen.getByText('Entrante')).toBeTruthy();
    const wrap = screen.getByText('Entrante').closest('[style*="z-index: 110"]');
    fireEvent.click(wrap);
    expect(screen.queryByText('Entrante')).toBeNull();
    fireEvent.click(screen.getByText('Portería').closest('.ph-row'));
    fireEvent.click(screen.getByText('Entrante').parentElement.parentElement.querySelector('button'));
    expect(screen.queryByText('Entrante')).toBeNull();
  });
});

describe('recientes de la central', () => {
  const cdr = [
    { src: '2001', dst: '2002', disposition: 'ANSWERED', billsec: 30, start: '2026-10-08T11:30:00' },
    { src: '099', dst: '2001', disposition: 'NO ANSWER', billsec: 0, start: '2026-10-08T11:00:00' },
    { src: '2001', dst: '', disposition: 'FAILED', start: '2026-10-08T10:00:00' },
  ];

  it('con sesión el historial sale del CDR y marca las perdidas', async () => {
    mApi.cdr.mockResolvedValue(cdr);
    await montar({ cfg: CFG_OK, central: true, web: { hist: [{ number: 'local', dir: 'out', dur: 1, t: HOY }] } });
    await avanzar(0);
    expect(mApi.cdr).toHaveBeenCalledWith('2001', 120);
    expect(screen.getByText('· servidor')).toBeTruthy();
    expect(screen.queryByText('local')).toBeNull();
    expect(screen.getByText('0:30')).toBeTruthy();
    const perdida = screen.getAllByText('099')[0];
    expect(perdida.style.color).toBe('rgb(235, 76, 70)');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('si el CDR falla vuelve al historial del aparato', async () => {
    mApi.cdr.mockRejectedValue(new Error('500'));
    await montar({ cfg: CFG_OK, central: true, web: { hist: [{ number: 'local', dir: 'out', dur: 1, t: HOY }] } });
    await avanzar(0);
    expect(screen.getAllByText('local').length).toBeGreaterThan(0);
  });

  it('un CDR que no es lista se toma como vacío', async () => {
    mApi.cdr.mockResolvedValue({ error: 'raro' });
    await montar({ cfg: CFG_OK, central: true });
    await avanzar(0);
    expect(screen.getByText('Sin llamadas')).toBeTruthy();
  });

  it('la ficha busca la grabación con origen, destino y hora de inicio', async () => {
    mApi.cdr.mockResolvedValue(cdr);
    mApi.matchRecording.mockResolvedValue({ id: 'rec-1' });
    const { container } = await montar({ cfg: CFG_OK, central: true });
    await avanzar(0);
    fireEvent.click(screen.getAllByText('2002')[0].closest('.ph-row'));
    expect(screen.getByText('Buscando grabación…')).toBeTruthy();
    await avanzar(0);
    const t = new Date('2026-10-08T11:30:00').getTime();
    expect(mApi.matchRecording).toHaveBeenCalledWith('2001', '2002', Math.floor((t - 30000) / 1000));
    expect(mApi.recordingAudioUrl).toHaveBeenCalledWith('rec-1');
    expect(container.querySelector('audio[controls]').getAttribute('src')).toBe('blob:grabacion');
  });

  it('entrante sin grabación, o con error, dice que no hay', async () => {
    mApi.cdr.mockResolvedValue(cdr);
    await montar({ cfg: CFG_OK, central: true });
    await avanzar(0);
    fireEvent.click(screen.getAllByText('099')[0].closest('.ph-row'));
    await avanzar(0);
    expect(mApi.matchRecording).toHaveBeenCalledWith('099', '2001', expect.any(Number));
    expect(screen.getByText('Sin grabación para esta llamada.')).toBeTruthy();
    fireEvent.click(screen.getByText('Sin grabación para esta llamada.').closest('[style*="z-index: 110"]'));
    mApi.matchRecording.mockResolvedValue({ id: 'r2' });
    mApi.recordingAudioUrl.mockResolvedValue('');
    fireEvent.click(screen.getAllByText('099')[0].closest('.ph-row'));
    await avanzar(0);
    expect(screen.getByText('Sin grabación para esta llamada.')).toBeTruthy();
    fireEvent.click(screen.getByText('Sin grabación para esta llamada.').closest('[style*="z-index: 110"]'));
    mApi.matchRecording.mockRejectedValue(new Error('caído'));
    fireEvent.click(screen.getAllByText('099')[0].closest('.ph-row'));
    await avanzar(0);
    expect(screen.getByText('Sin grabación para esta llamada.')).toBeTruthy();
  });
});
