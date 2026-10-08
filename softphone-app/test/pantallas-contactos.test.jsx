/* Contactos, favoritos, supervisión y buzón de voz: lo que el softphone trae de la central
 * cuando hay sesión.
 *
 * Sin sesión estas pantallas tienen que decir qué falta y llevar a Ajustes, no quedar en
 * blanco. Con sesión, cada acción tiene que pegarle al endpoint correcto con el interno
 * correcto (supervisar con el modo pedido, escuchar/borrar/transcribir el mensaje que se
 * tocó) y mostrar el error de la central cuando lo hay, porque un «no pasa nada» al tocar
 * «Escuchar» es indistinguible de un softphone colgado. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { montar, avanzar, estado, mApi, CFG_OK, irA } from './helpers/pantallas-app.jsx';

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

const AGENDA = [
  { ext: '2002', name: 'Ana Pérez', status: 'online', webrtc: true },
  { ext: '2003', name: 'Bruno', status: 'in_call' },
  { ext: '2004', status: 'offline' },
];
async function conCentral(opts = {}) {
  mApi.directory.mockResolvedValue(opts.agenda || AGENDA);
  const r = await montar({ cfg: CFG_OK, central: true, ...opts });
  await avanzar(0);
  return r;
}

describe('contactos', () => {
  it('sin sesión invita a conectar el sistema y lleva a Ajustes', async () => {
    await montar({ cfg: CFG_OK });
    irA('Contactos');
    expect(screen.getByText('Conectá el sistema PBX-NG')).toBeTruthy();
    fireEvent.click(screen.getByText('Ir a Ajustes'));
    expect(screen.getByText('Ajustes', { selector: 'div' })).toBeTruthy();
  });

  it('mientras la agenda no llega dice «Cargando…»', async () => {
    mApi.directory.mockReturnValue(new Promise(() => {}));
    await montar({ cfg: CFG_OK, central: true });
    irA('Contactos');
    expect(screen.getByText('Cargando…')).toBeTruthy();
  });

  it('una agenda vacía, o que no es lista, dice «Sin contactos»', async () => {
    await conCentral({ agenda: { error: 'raro' } });
    irA('Contactos');
    expect(screen.getByText('Sin contactos')).toBeTruthy();
  });

  it('lista internos con su estado y deja llamar o hacer video', async () => {
    await conCentral();
    irA('Contactos');
    expect(screen.getByText('3 internos')).toBeTruthy();
    expect(screen.getByText('2002 · WebRTC')).toBeTruthy();
    expect(screen.getByText('en línea')).toBeTruthy();
    expect(screen.getByText('en llamada')).toBeTruthy();
    expect(screen.getByText('offline')).toBeTruthy();
    fireEvent.click(screen.getByText('Bruno'));
    expect(estado.web.placeCall).toHaveBeenCalledWith('2003', false);
    // llamar lleva al marcador, donde se ve la llamada
    expect(screen.getByPlaceholderText('Ingresá nombre o número')).toBeTruthy();
    irA('Contactos');
    const fila = screen.getByText('Ana Pérez').closest('.ph-row');
    const video = fila.querySelectorAll('button')[2];
    fireEvent.click(video);
    expect(estado.web.placeCall).toHaveBeenLastCalledWith('2002', true);
    irA('Contactos');
    fireEvent.click(screen.getByText('Ana Pérez').closest('.ph-row').querySelectorAll('button')[3]);
    expect(estado.web.placeCall).toHaveBeenLastCalledWith('2002', false);
  });

  it('el buscador filtra por nombre o interno y se limpia con la cruz', async () => {
    await conCentral();
    irA('Contactos');
    const q = screen.getByPlaceholderText('Buscar por nombre o interno…');
    fireEvent.change(q, { target: { value: 'ANA' } });
    expect(screen.queryByText('Bruno')).toBeNull();
    fireEvent.change(q, { target: { value: '2004' } });
    expect(screen.getAllByText('2004').length).toBeGreaterThan(0);
    fireEvent.change(q, { target: { value: 'zzz' } });
    expect(screen.getByText('Sin resultados')).toBeTruthy();
    fireEvent.click(screen.getByText('×'));
    expect(q.value).toBe('');
    expect(screen.getByText('Bruno')).toBeTruthy();
  });

  it('los favoritos se marcan, se guardan y se llaman desde arriba', async () => {
    await conCentral();
    irA('Contactos');
    const estrella = screen.getByText('Bruno').closest('.ph-row').querySelector('[title=Favorito]');
    expect(estrella.textContent).toBe('☆');
    fireEvent.click(estrella);
    expect(estrella.textContent).toBe('★');
    expect(JSON.parse(localStorage.getItem('sp_favs'))).toEqual(['2003']);
    expect(screen.getByText('FAVORITOS')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Llamar a Bruno'));
    expect(estado.web.placeCall).toHaveBeenCalledWith('2003', false);
    fireEvent.click(estrella);
    expect(screen.queryByText('FAVORITOS')).toBeNull();
  });

  it('un favorito que ya no está en la agenda se muestra por su número', async () => {
    await conCentral({ favs: ['2999'] });
    irA('Contactos');
    expect(screen.getByTitle('Llamar a 2999')).toBeTruthy();
  });

  it('favoritos guardados corruptos no rompen la pantalla', async () => {
    await conCentral({ favsCrudos: '[roto' });
    irA('Contactos');
    expect(screen.queryByText('FAVORITOS')).toBeNull();
    expect(screen.getByText('Bruno')).toBeTruthy();
  });
});

describe('supervisar una llamada', () => {
  async function abrirSupervisar() {
    await conCentral();
    irA('Contactos');
    fireEvent.click(screen.getByText('Ana Pérez').closest('.ph-row').querySelector('[title=Supervisar]'));
  }

  it('pide a la central escuchar con el interno propio y el del agente, y se cierra solo', async () => {
    await abrirSupervisar();
    expect(screen.getByText('Ana Pérez · 2002')).toBeTruthy();
    fireEvent.click(screen.getByText(/Escuchar/));
    expect(screen.getByText('Originando…')).toBeTruthy();
    await avanzar(0);
    expect(mApi.spyCall).toHaveBeenCalledWith('2001', '2002', 'listen');
    expect(screen.getByText(/Atendé la llamada entrante/)).toBeTruthy();
    await avanzar(1800);
    expect(screen.queryByText('Supervisar', { selector: 'div' })).toBeNull();
  });

  it('susurrar e irrumpir mandan su modo; el error de la central se muestra', async () => {
    mApi.spyCall.mockResolvedValueOnce({ error: 'sin permiso' }).mockRejectedValueOnce(new Error('caída'));
    await abrirSupervisar();
    fireEvent.click(screen.getByText(/Susurrar/));
    await avanzar(0);
    expect(mApi.spyCall).toHaveBeenCalledWith('2001', '2002', 'whisper');
    expect(screen.getByText('Error: sin permiso')).toBeTruthy();
    fireEvent.click(screen.getByText(/Irrumpir/));
    await avanzar(0);
    expect(mApi.spyCall).toHaveBeenLastCalledWith('2001', '2002', 'barge');
    expect(screen.getByText('Error: caída')).toBeTruthy();
    // tocar adentro no cierra; afuera sí
    fireEvent.click(screen.getByText(/La central te va a llamar/));
    expect(screen.getByText('Error: caída')).toBeTruthy();
    fireEvent.click(document.querySelector('[style*="z-index: 110"]'));
    expect(screen.queryByText('Error: caída')).toBeNull();
  });
});

describe('buzón de voz', () => {
  const MSGS = [
    { id: 'm1', folder: 'INBOX', callerid: '"Ana" <2002>', duration: 12, origtime: new Date('2026-10-08T09:15:00').getTime() / 1000 },
    { msgid: 'm2', folder: 'Old', from: '099', date: 'ayer' },
    { msg_id: 'm3', caller: '2004', time: '10:00' },
    { cid: '2005' },
    {},
  ];

  it('sin sesión no hay solapa de Voz', async () => {
    await montar({ cfg: CFG_OK });
    expect(screen.queryByText('Voz')).toBeNull();
    expect(screen.queryByText('Mensajes de voz')).toBeNull();
  });

  it('lista los mensajes, cuenta los nuevos y los marca en el menú', async () => {
    mApi.vmList.mockResolvedValue(MSGS);
    await conCentral();
    expect(mApi.vmList).toHaveBeenCalledWith('2001');
    // el contador de no leídos aparece en el menú y en el acceso del marcador
    const botonVoz = screen.getAllByText('Voz').find((e) => e.parentElement.tagName === 'BUTTON').parentElement;
    expect(botonVoz.textContent).toBe('4Voz');
    expect(screen.getByText('Mensajes de voz').parentElement.textContent).toBe('Mensajes de voz4');
    fireEvent.click(screen.getByText('Mensajes de voz'));
    expect(screen.getByText('5 · 4 nuevos')).toBeTruthy();
    expect(screen.getByText('"Ana" <2002>')).toBeTruthy();
    expect(screen.getByText('12s · 09:15')).toBeTruthy();
    expect(screen.getByText('ayer')).toBeTruthy();
    expect(screen.getByText('desconocido')).toBeTruthy();
    expect(screen.getAllByText('Nuevo').length).toBe(4);
    fireEvent.click(screen.getByText('"Ana" <2002>').parentElement.parentElement.querySelector('[title=Llamar]'));
    expect(estado.web.placeCall).toHaveBeenCalledWith('2002', false);
  });

  it('acepta la respuesta como { messages } o { msgs } y una falla como lista vacía', async () => {
    mApi.vmList.mockResolvedValueOnce({ msgs: [] }).mockResolvedValueOnce({ messages: [MSGS[0]] }).mockResolvedValue({});
    await conCentral();
    irA('Voz');
    await avanzar(0);
    expect(screen.getByText('"Ana" <2002>')).toBeTruthy();
    irA('Llamadas');
    await avanzar(0);
    irA('Voz');
    await avanzar(0);
    expect(screen.getByText('No tenés mensajes de voz.')).toBeTruthy();
    mApi.vmList.mockRejectedValue(new Error('x'));
    irA('Llamadas'); await avanzar(0); irA('Voz'); await avanzar(0);
    expect(screen.getByText('No tenés mensajes de voz.')).toBeTruthy();
  });

  it('mientras carga dice «Cargando…»', async () => {
    mApi.vmList.mockReturnValue(new Promise(() => {}));
    await conCentral();
    irA('Voz');
    expect(screen.getByText('Cargando…')).toBeTruthy();
  });

  it('escuchar trae el audio y lo marca leído; borrar lo quita', async () => {
    mApi.vmList.mockResolvedValue([MSGS[0], MSGS[1]]);
    const { container } = await conCentral();
    irA('Voz');
    await avanzar(0);
    fireEvent.click(screen.getAllByText('▶ Escuchar')[0]);
    await avanzar(0);
    expect(mApi.vmAudioUrl).toHaveBeenCalledWith('2001', 'INBOX', 'm1');
    expect(mApi.vmRead).toHaveBeenCalledWith('2001', 'INBOX', 'm1');
    expect(container.querySelector('audio[controls][src="blob:vm"]')).toBeTruthy();
    const llamadas = mApi.vmList.mock.calls.length;
    fireEvent.click(screen.getAllByTitle('Eliminar')[1]);
    await avanzar(0);
    expect(mApi.vmDel).toHaveBeenCalledWith('2001', 'Old', 'm2');
    expect(mApi.vmList.mock.calls.length).toBeGreaterThan(llamadas);
  });

  it('si no hay audio o la central falla, el botón queda como estaba', async () => {
    mApi.vmList.mockResolvedValue([MSGS[0]]);
    mApi.vmAudioUrl.mockResolvedValueOnce('').mockRejectedValueOnce(new Error('x'));
    mApi.vmDel.mockRejectedValueOnce(new Error('x'));
    await conCentral();
    irA('Voz');
    await avanzar(0);
    fireEvent.click(screen.getByText('▶ Escuchar'));
    await avanzar(0);
    expect(mApi.vmRead).toHaveBeenCalled();
    fireEvent.click(screen.getByText('▶ Escuchar'));
    await avanzar(0);
    expect(screen.getByText('▶ Escuchar')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Eliminar'));
    await avanzar(0);
    expect(screen.getByText('"Ana" <2002>')).toBeTruthy();
  });

  it('transcribir muestra el texto, el vacío, o el error de la central', async () => {
    mApi.vmList.mockResolvedValue([MSGS[0], MSGS[1], MSGS[2], MSGS[3]]);
    mApi.vmTranscribe
      .mockImplementationOnce(() => new Promise((r) => setTimeout(() => r({ transcript: ' Hola, soy Ana ', analysis: { summary: 's' } }), 50)))
      .mockResolvedValueOnce({ transcript: '  ' })
      .mockResolvedValueOnce({ error: 'sin motor de IA' })
      .mockRejectedValueOnce(new Error('caída'));
    await conCentral();
    irA('Voz');
    await avanzar(0);
    const botones = () => screen.getAllByText('Transcribir');
    fireEvent.click(botones()[0]);
    expect(screen.getByText('Transcribiendo…')).toBeTruthy();
    await avanzar(60);
    expect(screen.getByText('Hola, soy Ana')).toBeTruthy();
    expect(mApi.vmTranscribe).toHaveBeenCalledWith('2001', 'INBOX', 'm1');
    fireEvent.click(botones()[0]);
    await avanzar(0);
    expect(screen.getByText('(sin texto reconocido)')).toBeTruthy();
    fireEvent.click(botones()[0]);
    await avanzar(0);
    expect(screen.getByText('✕ sin motor de IA')).toBeTruthy();
    fireEvent.click(botones()[0]);
    await avanzar(0);
    expect(screen.getByText('✕ caída')).toBeTruthy();
  });

  it('una respuesta vacía de la transcripción se muestra como error', async () => {
    mApi.vmList.mockResolvedValue([MSGS[0]]);
    mApi.vmTranscribe.mockResolvedValueOnce(null);
    await conCentral();
    irA('Voz');
    await avanzar(0);
    fireEvent.click(screen.getByText('Transcribir'));
    await avanzar(0);
    expect(screen.getByText('✕ no se pudo transcribir')).toBeTruthy();
  });
});
