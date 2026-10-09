/* ============================================================================
 *  IA & Voz › Nube: la clave y los modelos del proveedor (ProveedoresNube) y el banco
 *  de pruebas de voces de la nube (VocesNube).
 *
 *  Lo que se fija:
 *   - la clave se guarda y NUNCA vuelve al panel (sólo «guardada»); el estado de la cuenta
 *     dice si una llamada que entre AHORA se puede atender (con crédito, clave rechazada,
 *     sin clave…) y se puede volver a probar a mano;
 *   - los modelos se separan en «voz a voz» (los que puede usar un agente) y el resto, y
 *     si la cuenta no lista ninguno se explica dónde se habilita;
 *   - las voces se filtran por país y por texto, se escuchan con el MISMO texto para poder
 *     comparar (otra vez la misma = parar) y la estrella fija la voz por defecto.
 *  Es plata y es lo que oye quien llama: una clave que se muestra, o una voz que se fija
 *  sin avisar que falló, son problemas de cliente.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());

import { apiMock, notifyMock, resetNucleo } from './helpers/nucleo-render.jsx';
import { renderTel, stubFetch, escribir } from './helpers/telefonia-render.jsx';
import ProveedoresNube from '../app/ProveedoresNube.jsx';
import VocesNube from '../app/VocesNube.jsx';

let play;
beforeEach(() => {
  resetNucleo();
  play = vi.fn(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => 'blob:audio');
});
afterEach(() => { vi.unstubAllGlobals(); });

/* ─────────────────────────── VocesNube ─────────────────────────── */
const VOCES = {
  default: 'es-UY-MateoNeural',
  edge: [
    { key: 'es-UY-ValentinaNeural', label: 'Valentina' },
    { key: 'es-UY-MateoNeural', label: 'Mateo' },
    { key: 'es-AR-ElenaNeural', label: 'Elena' },
    { key: 'es-XX-RaroNeural', label: 'Raro' },
    { key: 'cosa-rara', label: 'Sin formato' },
  ],
};
const tarjeta = (nombre) => screen.getByText(nombre).closest('.mantine-Box-root, div[style*="cursor"]');

describe('VocesNube', () => {
  it('sin voces (la API no contesta) lo dice; el contador queda en 0', async () => {
    apiMock.fallar('GET /voz/voices', 502, 'sin internet');
    apiMock.fallar('GET /voz/config', 502, 'sin internet');
    renderTel(<VocesNube />);
    expect(screen.getByText('…')).toBeTruthy();
    expect(await screen.findByText('No hay voces que coincidan.')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('filtra por Uruguay / Latinoamérica / todas y por texto; marca la voz por defecto y el género', async () => {
    apiMock.responder('GET /voz/voices', VOCES);
    apiMock.responder('GET /voz/config', { default_voice: 'es-UY-ValentinaNeural' });
    renderTel(<VocesNube />);
    expect(await screen.findByText('Valentina')).toBeTruthy();
    expect(screen.getByText('🇺🇾 Uruguay (2)')).toBeTruthy();
    expect(screen.queryByText('Elena')).toBeNull();
    expect(screen.getByText('Uruguay · femenina')).toBeTruthy();
    expect(screen.getByText('Uruguay · masculina')).toBeTruthy();
    // La de la config manda sobre el default de la lista: Valentina sin estrella para fijar, Mateo con.
    await waitFor(() => expect(within(tarjeta('Valentina')).queryAllByRole('button')).toHaveLength(0));
    fireEvent.click(screen.getByText('🌎 Latinoamérica'));
    expect(screen.getByText('Elena')).toBeTruthy();
    expect(screen.getByText('Argentina · femenina')).toBeTruthy();
    expect(screen.getByText('XX · masculina')).toBeTruthy();
    expect(screen.getByText('Sin formato')).toBeTruthy();
    expect(screen.queryByText('Valentina')).toBeNull();
    fireEvent.click(screen.getByText('Todas'));
    escribir(screen.getByPlaceholderText('Buscar…'), 'argentina');
    expect(screen.getByText('Elena')).toBeTruthy();
    expect(screen.queryByText('Mateo')).toBeNull();
    escribir(screen.getByPlaceholderText('Buscar…'), 'zzz');
    expect(screen.getByText('No hay voces que coincidan.')).toBeTruthy();
  });

  it('escuchar pide el audio con el texto de prueba; tocar la misma la para; terminar también', async () => {
    apiMock.responder('GET /voz/voices', VOCES);
    apiMock.responder('GET /voz/config', {});
    apiMock.responder('POST /voz/test', { blob: async () => new Blob(['RIFF']) });
    const { container } = renderTel(<VocesNube />);
    await screen.findByText('Valentina');
    escribir(screen.getByPlaceholderText('Texto de prueba'), 'Buen día');
    await act(async () => { fireEvent.click(screen.getByText('Valentina')); });
    await waitFor(() => expect(play).toHaveBeenCalled());
    const pedido = apiMock.llamadasA('POST /voz/test')[0];
    expect(pedido.body).toEqual({ text: 'Buen día', voice: 'es-UY-ValentinaNeural' });
    expect(pedido.opts.raw).toBe(true);
    expect(container.querySelector('audio').src).toBe('blob:audio');
    // Parar con el botón de la barra (sólo existe mientras algo suena).
    const detener = () => screen.getByPlaceholderText('Texto de prueba').closest('.mantine-Group-root').querySelector('button');
    expect(detener()).toBeTruthy();
    fireEvent.click(detener());
    expect(detener()).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText('Mateo')); });
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    // Tocar la que suena = parar.
    fireEvent.click(screen.getByText('Mateo'));
    expect(apiMock.llamadasA('POST /voz/test')).toHaveLength(2);
    expect(detener()).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText('Mateo')); });
    await waitFor(() => expect(apiMock.llamadasA('POST /voz/test')).toHaveLength(3));
    expect(detener()).toBeTruthy();
    fireEvent(container.querySelector('audio'), new Event('ended'));
    expect(detener()).toBeNull();
  });

  it('si no se puede generar el audio, avisa; si el navegador no deja reproducir, no rompe', async () => {
    apiMock.responder('GET /voz/voices', VOCES);
    apiMock.responder('GET /voz/config', {});
    apiMock.fallar('POST /voz/test', 503, 'TTS caído');
    renderTel(<VocesNube />);
    await screen.findByText('Valentina');
    await act(async () => { fireEvent.click(screen.getByText('Valentina')); });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No se pudo generar el audio', 'bad', { description: 'TTS caído' }));
    apiMock.responder('POST /voz/test', { blob: async () => new Blob(['x']) });
    play.mockImplementation(() => Promise.reject(new Error('autoplay')));
    await act(async () => { fireEvent.click(screen.getByText('Mateo')); });
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(notifyMock.toast).toHaveBeenCalledTimes(1);
  });

  it('la estrella fija la voz por defecto de la central; si falla, lo dice', async () => {
    apiMock.responder('GET /voz/voices', VOCES);
    apiMock.responder('GET /voz/config', {});
    let falla = false;
    apiMock.responder('POST /voz/config', () => { if (falla) throw new Error('Sólo admin'); return {}; });
    renderTel(<VocesNube />);
    await screen.findByText('Valentina');
    fireEvent.click(within(tarjeta('Valentina')).getByRole('button'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Voz por defecto: Valentina', 'ok'));
    expect(apiMock.llamadasA('POST /voz/config')[0].body).toEqual({ default_voice: 'es-UY-ValentinaNeural' });
    expect(apiMock.llamadasA('POST /voz/test')).toHaveLength(0);   // fijar no reproduce
    falla = true;
    fireEvent.click(within(tarjeta('Mateo')).getByRole('button'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No se pudo fijar la voz', 'bad', { description: 'Sólo admin' }));
  });

  it('una lista sin voces de Uruguay no muestra el contador en la solapa', async () => {
    apiMock.responder('GET /voz/voices', {});
    apiMock.responder('GET /voz/config', null);
    renderTel(<VocesNube />);
    expect(await screen.findByText('🇺🇾 Uruguay')).toBeTruthy();
  });
});

/* ─────────────────────────── ProveedoresNube ─────────────────────────── */
describe('ProveedoresNube', () => {
  function nube(extra = {}) {
    return stubFetch({
      'GET /settings': { openai_api_key: '__SET__', realtime_url: 'https://proxy.x' },
      'GET /ai-agents/modelos': { ok: true, total: 40, modelos: ['gpt-realtime', 'gpt-live-1', 'gpt-4o-mini-tts', 'whisper-1'] },
      'GET /ai-agents/live': { salud: { estado: 'ok', que: 'La cuenta puede atender', probado_con: 'gpt-realtime-mini', ts: '2026-10-08T10:00:00Z' } },
      ...extra,
    });
  }

  it('con clave y salud OK: «Puede atender», separa voz a voz del resto, y nunca muestra la clave', async () => {
    nube();
    renderTel(<ProveedoresNube />);
    expect(await screen.findByText('Puede atender')).toBeTruthy();
    expect(screen.getByPlaceholderText('•••••••••• (guardada)')).toBeTruthy();
    expect(screen.getByLabelText('Clave de API').value).toBe('');
    expect(screen.getByDisplayValue('https://proxy.x')).toBeTruthy();
    expect(await screen.findByText('gpt-realtime')).toBeTruthy();
    expect(screen.getByText('gpt-live-1')).toBeTruthy();
    expect(screen.getByText('OTROS DE AUDIO (2)')).toBeTruthy();
    expect(screen.getByText(/De 40 en la cuenta/)).toBeTruthy();
    expect(screen.getByText('La cuenta puede atender')).toBeTruthy();
    expect(screen.getByText(/Probado con gpt-realtime-mini/)).toBeTruthy();
  });

  it('cada estado de la cuenta tiene su rótulo; el arreglo sugerido se muestra', async () => {
    const casos = [
      [{ estado: 'sin_saldo', que: 'Sin crédito', arreglo: 'Cargá crédito en OpenAI' }, 'Sin crédito'],
      [{ estado: 'clave', que: 'x' }, 'Clave rechazada'],
      [{ estado: 'sin_clave', que: 'x' }, 'Sin clave'],
      [{ estado: 'raro', que: 'x', ts: 0 }, 'Con problemas'],
    ];
    for (const [salud, rotulo] of casos) {
      nube({ 'GET /ai-agents/live': { salud } });
      const { unmount } = renderTel(<ProveedoresNube />);
      expect(await screen.findByText(rotulo, { selector: '.mantine-Badge-label' })).toBeTruthy();
      if (salud.arreglo) expect(screen.getByText('Cargá crédito en OpenAI')).toBeTruthy();
      unmount();
    }
  });

  it('sin clave ni salud: «Sin clave», y si la cuenta no lista modelos de voz explica dónde se habilita', async () => {
    nube({
      'GET /settings': {},
      'GET /ai-agents/modelos': { ok: true, total: 3, modelos: [] },
      'GET /ai-agents/live': {},
    });
    renderTel(<ProveedoresNube />);
    expect(await screen.findByText(/Tu cuenta no lista ninguno/)).toBeTruthy();
    expect(screen.getByText('Sin clave', { selector: '.mantine-Badge-label' })).toBeTruthy();
    expect(screen.getByPlaceholderText('sk-...')).toBeTruthy();
    expect(screen.queryByText(/OTROS DE AUDIO/)).toBeNull();
    expect(screen.getByText('¿La cuenta puede atender una llamada?')).toBeTruthy();
  });

  it('con clave pero sin salud medida: «Clave cargada»; si el proveedor no contesta los modelos, lo dice', async () => {
    nube({ 'GET /ai-agents/modelos': { ok: false, error: 'clave inválida' }, 'GET /ai-agents/live': () => { throw new Error('red'); } });
    renderTel(<ProveedoresNube />);
    expect(await screen.findByText('clave inválida')).toBeTruthy();
    expect(screen.getByText('Clave cargada')).toBeTruthy();
  });

  it('con la red caída: modelos «no se pudo consultar» y la pantalla sigue en pie', async () => {
    stubFetch({ 'GET /settings': () => { throw new Error('red'); }, 'GET /ai-agents/modelos': () => { throw new Error('red'); }, 'GET /ai-agents/live': () => { throw new Error('red'); } });
    renderTel(<ProveedoresNube />);
    expect(await screen.findByText('no se pudo consultar')).toBeTruthy();
  });

  it('un error sin texto de los modelos muestra el genérico', async () => {
    nube({ 'GET /ai-agents/modelos': { ok: false } });
    renderTel(<ProveedoresNube />);
    expect(await screen.findByText('No se pudo consultar.')).toBeTruthy();
  });

  it('guardar la clave la manda una vez, limpia el campo y vuelve a preguntar los modelos', async () => {
    let falla = false;
    const f = nube({ 'POST /settings': () => (falla ? { error: 'x' } : {}) });
    renderTel(<ProveedoresNube />);
    await screen.findByText('gpt-realtime');
    const clave = screen.getByLabelText('Clave de API');
    const [guardarClave, guardarBase] = screen.getAllByRole('button', { name: 'Guardar' });
    expect(guardarClave.disabled).toBe(true);
    escribir(clave, 'sk-nueva');
    fireEvent.click(guardarClave);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Guardado', 'ok'));
    expect(f.de('POST /settings')[0].body).toEqual({ openai_api_key: 'sk-nueva' });
    await waitFor(() => expect(clave.value).toBe(''));
    await waitFor(() => expect(f.de('GET /ai-agents/modelos')).toHaveLength(2));
    escribir(screen.getByDisplayValue('https://proxy.x'), '');
    fireEvent.click(guardarBase);
    await waitFor(() => expect(f.de('POST /settings')).toHaveLength(2));
    expect(f.de('POST /settings')[1].body).toEqual({ realtime_url: '' });
    falla = true;
    fireEvent.click(guardarBase);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No se pudo guardar', 'bad'));
  });

  it('guardar sin red avisa que no se pudo', async () => {
    nube({ 'POST /settings': () => { throw new Error('red'); } });
    renderTel(<ProveedoresNube />);
    await screen.findByText('gpt-realtime');
    fireEvent.click(screen.getAllByRole('button', { name: 'Guardar' })[1]);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No se pudo guardar', 'bad'));
  });

  it('«Revisar ahora» prueba la cuenta en el momento; «volver a preguntar» recarga los modelos', async () => {
    let n = 0;
    const f = nube({ 'POST /ai-agents/salud': () => { n++; if (n === 1) return { estado: 'sin_saldo', que: 'Sin crédito en la cuenta', arreglo: 'Cargá saldo' }; throw new Error('red'); } });
    renderTel(<ProveedoresNube />);
    await screen.findByText('Puede atender');
    fireEvent.click(screen.getByRole('button', { name: 'Revisar ahora' }));
    expect(await screen.findByText('Sin crédito en la cuenta')).toBeTruthy();
    expect(screen.getByText('Cargá saldo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revisar ahora' }));
    await waitFor(() => expect(f.de('POST /ai-agents/salud')).toHaveLength(2));
    expect(screen.getByText('Sin crédito en la cuenta')).toBeTruthy();
    const refrescar = screen.getByText('Modelos de tu cuenta').closest('.mantine-Card-root').querySelector('button');
    fireEvent.click(refrescar);
    await waitFor(() => expect(f.de('GET /ai-agents/modelos')).toHaveLength(2));
  });
});
