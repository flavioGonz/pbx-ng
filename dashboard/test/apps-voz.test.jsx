/* Consola de voz (/voz y las solapas «Motor local», «Nube», «Audios del sistema» y
 * «Logs» de IA & Voz) y la pantalla IA & Voz que las agrupa.
 *
 * Es la respuesta a «¿el portero sigue hablando si se corta internet?» y «¿con qué voz
 * suena la central?». Se fija: el estado del contenedor (en línea o no, con su URL),
 * escuchar una voz baja el audio por la capa de API, fijar la voz por defecto y
 * borrar/instalar voces piden confirmación y pegan en la ruta correcta, los audios del
 * sistema se generan en tandas de 8 con progreso, y cada solapa de IA & Voz monta lo suyo. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { renderNG, fetchFalso, estado, diferido } from './helpers/apps-render.jsx';

const notify = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../app/notify', () => notify);

import VozConsole from '../app/voz/page';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

const VOZ = { ok: true, latency_ms: 12, whisper: 'small', default_voice: 'es-UY-ValentinaNeural', metrics: { uptime_s: 3700, ncpu: 4, cpu_pct: 20, mem_pct: 40, mem_used_mb: 512, mem_total_mb: 2048 }, stats: { tts: 10, tts_avg_ms: 300, stt: 3, stt_avg_ms: 900 } };
const VOCES = {
  default: 'es_ES-davefx',
  installed: [{ key: 'es_AR-daniela', size_mb: 60 }, { key: 'es_ES-davefx' }],
  catalog: [{ key: 'es_AR-daniela', label: 'Daniela (AR)', installed: true }, { key: 'es_MX-ald', label: 'Ald (MX)', installed: false }],
  edge: [{ key: 'es-UY-ValentinaNeural', label: 'Valentina (femenina)' }, { key: 'es-UY-MateoNeural', label: 'Mateo' }, { key: 'es-AR-ElenaNeural', label: 'Elena' }, { key: 'es-XX-RaroNeural', label: 'Raro' }, { key: 'rara', label: 'Sin formato' }],
};
const SYS = Array.from({ length: 10 }, (_, i) => ({ name: 'digits/' + i, text: 'número ' + i, category: i < 9 ? 'digitos' : 'buzon', has_audio: i < 2, deployed_at: i === 0 ? '2026-10-01' : null }));
const rutas = (extra = {}) => ({
  'GET /voz': VOZ,
  'GET /voz/voices': VOCES,
  'GET /voz/config': { whisper: 'small', default_voice: 'es-UY-ValentinaNeural', models: ['tiny', 'small'] },
  'GET /settings': { voz_url: 'http://voz:8000', voz_length_scale: '1.1' },
  'GET /sysprompts': SYS,
  'GET /voz/logs': { logs: 'arrancó piper' },
  'POST /voz/test': () => new Response(new Blob(['w']), { status: 200 }),
  'POST /voz/config': {},
  'POST /settings': {},
  'POST /voz/restart': {},
  'POST /voz/voices/install': {},
  'DELETE /voz/voices/es_AR-daniela': null,
  'POST /sysprompts/seed': {},
  'POST /sysprompts/generate': {},
  'POST /sysprompts/revert': {},
  'PUT /sysprompts/digits%2F1': {},
  'GET /sysprompts/test/digits%2F0': () => new Response(new Blob(['w']), { status: 200 }),
  ...extra,
});

let f;
beforeEach(() => {
  notify.toast.mockReset();
  f = fetchFalso(rutas());
  vi.stubGlobal('fetch', f);
  URL.createObjectURL = vi.fn(() => 'blob:voz');
  window.HTMLMediaElement.prototype.play = vi.fn(function () { this.dispatchEvent(new Event('play')); return Promise.resolve(); });
  window.HTMLMediaElement.prototype.pause = vi.fn(function () { this.dispatchEvent(new Event('pause')); });
});
afterEach(() => { vi.useRealTimers(); });

const confirmar = async (etiqueta) => fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: etiqueta }));
/* OJO: VoiceCard se define DENTRO del render de VozConsole, así que cada render la vuelve a
 * montar y un nodo guardado queda viejo: siempre se busca de nuevo justo antes del clic. */
const tarjeta = (titulo) => screen.getAllByText(titulo).map((e) => e.closest('.mantine-Card-root')).find((c) => c && c.style.cursor === 'pointer');

describe('Motor local', () => {
  it('muestra el estado del contenedor, sus métricas y la configuración guardada', async () => {
    renderNG(<VozConsole section="local" />);
    expect(await screen.findByText('En línea · 12ms')).toBeTruthy();
    expect(screen.getByText('1h 1m')).toBeTruthy();
    expect(screen.getByText('10 · 300ms')).toBeTruthy();
    expect(screen.getByText('3 · 900ms')).toBeTruthy();
    expect(screen.getByText('512/2048MB')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'URL del servicio' }).value).toBe('http://voz:8000'));
    expect(screen.getByText(/corre <b>|corre en tu servidor|en tu servidor/)).toBeTruthy();
    expect(screen.getByText('Ald (MX)')).toBeTruthy();
    expect(screen.getByText('Instalada')).toBeTruthy();
  });

  it('sin servicio: «Sin conexión» y el aviso con la URL configurada', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /voz': estado(502), 'GET /voz/config': estado(500, { error: 'cfg caída' }), 'GET /settings': estado(500, { error: 'settings caída' }), 'GET /voz/voices': estado(500, { error: 'voces caídas' }), 'GET /sysprompts': estado(500, { error: 'sys caído' }) })));
    renderNG(<VozConsole section="engine" />);
    expect(await screen.findByText('Sin conexión')).toBeTruthy();
    expect(screen.getByText(/No se pudo contactar el servicio de voz en/)).toBeTruthy();
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('cfg caída', 'bad'));
    expect(notify.toast).toHaveBeenCalledWith('settings caída', 'bad');
    expect(notify.toast).toHaveBeenCalledWith('voces caídas', 'bad');
    expect(notify.toast).toHaveBeenCalledWith('sys caído', 'bad');
  });

  it('un servicio que contesta sin métricas no suma puntos al gráfico; valores por defecto en cero', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /voz': { ok: true, latency_ms: 3 }, 'GET /settings': {} })));
    renderNG(<VozConsole section="engine" />);
    expect(await screen.findByText('En línea · 3ms')).toBeTruthy();
    expect(screen.getAllByText('0 · 0ms').length).toBe(2);
    expect(screen.getByText('0/0MB')).toBeTruthy();
  });

  it('guarda URL y velocidad; un error lo dice', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'POST /settings': () => (n++ ? estado(500, { error: 'no' }) : {}) }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="engine" />);
    const urlIn = await screen.findByRole('textbox', { name: 'URL del servicio' });
    await waitFor(() => expect(urlIn.value).toBe('http://voz:8000'));
    fireEvent.change(urlIn, { target: { value: 'http://voz2:8000' } });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    fireEvent.click(screen.getAllByRole('button', { name: /^Guardar$/ })[0]);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Guardado', 'ok'));
    expect(f.de('POST', '/settings')[0].cuerpo).toEqual({ voz_url: 'http://voz2:8000', voz_length_scale: '1.15' });
    fireEvent.click(screen.getAllByRole('button', { name: /^Guardar$/ })[0]);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Error: no', 'bad'));
  });

  it('aplicar el motor pide confirmación (reinicia) y manda modelo y voz; cancelar no manda nada', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'POST /voz/config': () => (n++ ? estado(500, { error: 'falló' }) : {}) }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="engine" />);
    await screen.findByText('En línea · 12ms');
    fireEvent.click(screen.getByRole('textbox', { name: /Modelo Whisper/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'tiny' }));
    fireEvent.click(screen.getByRole('textbox', { name: /Voz por defecto/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Mateo' }));
    fireEvent.click(screen.getByRole('button', { name: /Aplicar y reiniciar/ }));
    expect(await screen.findByText('Aplicar configuración del motor')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Aplicar configuración del motor')).toBeNull());
    expect(f.de('POST', '/voz/config').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /Aplicar y reiniciar/ }));
    await confirmar('Aplicar y reiniciar');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Aplicado · reiniciando servicio…', 'ok'));
    expect(f.de('POST', '/voz/config')[0].cuerpo).toEqual({ whisper: 'tiny', default_voice: 'es-UY-MateoNeural' });
    fireEvent.click(screen.getByRole('button', { name: /Aplicar y reiniciar/ }));
    // Escape cierra el modal sin confirmar
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Aplicar configuración del motor')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Aplicar y reiniciar/ }));
    await confirmar('Aplicar y reiniciar');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Error: falló', 'bad'));
  });

  it('reiniciar el servicio confirma, avisa y recarga a los 6 s; si falla lo dice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    f = fetchFalso(rutas({ 'POST /voz/restart': () => (n++ ? estado(500, { error: 'docker caído' }) : {}) }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="engine" />);
    await screen.findByText('En línea · 12ms');
    fireEvent.click(screen.getByRole('button', { name: /Reiniciar servicio/ }));
    await confirmar('Reiniciar');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Reiniciando servicio…', 'info'));
    const antes = f.de('GET', '/voz/voices').length;
    await act(async () => { vi.advanceTimersByTime(6100); });
    await waitFor(() => expect(f.de('GET', '/voz/voices').length).toBe(antes + 1));
    fireEvent.click(screen.getByRole('button', { name: /Reiniciar servicio/ }));
    await confirmar('Reiniciar');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('docker caído', 'bad'));
  });

  it('el botón Recargar vuelve a pedir estado y voces', async () => {
    renderNG(<VozConsole section="local" />);
    await screen.findByText('En línea · 12ms');
    fireEvent.click(screen.getByRole('button', { name: /Recargar/ }));
    await waitFor(() => expect(f.de('GET', '/voz/voices').length).toBe(2));
  });

  it('borrar una voz Piper confirma y la borra (la de por defecto no se puede); instalar del catálogo también confirma', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'DELETE /voz/voices/es_AR-daniela': () => (n++ ? estado(409, { error: 'en uso' }) : null), 'POST /voz/voices/install': estado(500, { error: 'sin internet' }) }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="local" />);
    await waitFor(() => expect(tarjeta('es_AR-daniela').textContent).toContain('60 MB'));
    // la voz por defecto no se puede borrar
    expect(tarjeta('es_ES-davefx').querySelector('.tabler-icon-trash').closest('button').disabled).toBe(true);
    fireEvent.click(tarjeta('es_AR-daniela').querySelector('.tabler-icon-trash').closest('button'));
    expect(await screen.findByText(/Se eliminará la voz «es_AR-daniela»/)).toBeTruthy();
    await confirmar('Eliminar');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Voz eliminada', 'info'));
    fireEvent.click(tarjeta('es_AR-daniela').querySelector('.tabler-icon-trash').closest('button'));
    await confirmar('Eliminar');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('en uso', 'bad'));
    fireEvent.click(screen.getByRole('button', { name: /^Instalar$/ }));
    await confirmar('Instalar');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Error: sin internet', 'bad'));
    expect(f.de('POST', '/voz/voices/install')[0].cuerpo).toEqual({ key: 'es_MX-ald' });
  });

  it('instalar con éxito avisa y recarga la lista', async () => {
    renderNG(<VozConsole section="local" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Instalar$/ }));
    await confirmar('Instalar');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Voz instalada', 'ok'));
    await waitFor(() => expect(f.de('GET', '/voz/voices').length).toBe(2));
  });

  it('sin voces instaladas lo dice', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /voz/voices': {} })));
    renderNG(<VozConsole section="local" />);
    expect(await screen.findByText('Ninguna voz Piper instalada.')).toBeTruthy();
  });
});

describe('Nube y estudio de voz', () => {
  it('voces uruguayas y de la región, con bandera, país y género', async () => {
    renderNG(<VozConsole section="nube" />);
    const vale = await waitFor(() => tarjeta('Valentina'));
    expect(vale.textContent).toMatch(/🇺🇾Valentina.*default.*Uruguay · femenina/);
    expect(tarjeta('Mateo').textContent).toContain('Uruguay · masculina');
    expect(tarjeta('Elena').textContent).toMatch(/🇦🇷.*Argentina · femenina/);
    expect(tarjeta('Raro').textContent).toMatch(/🌐.*XX · masculina/);
    expect(tarjeta('Sin formato').textContent).toContain('🌐');
  });

  it('sin voces uruguayas lo dice', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /voz/voices': { edge: [] } })));
    renderNG(<VozConsole section="nube" />);
    expect(await screen.findByText('No hay voces uruguayas en el catálogo del servicio.')).toBeTruthy();
  });

  it('tocar una voz la sintetiza con el texto de prueba, el avatar habla, y tocarla de nuevo la detiene', async () => {
    const { container } = renderNG(<VozConsole section="nube" />);
    await waitFor(() => tarjeta('Mateo'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Texto de prueba' }), { target: { value: 'Probando' } });
    fireEvent.click(tarjeta('Mateo'));
    await waitFor(() => expect(screen.getByText('🔊 Hablando · Mateo')).toBeTruthy());
    expect(f.de('POST', '/voz/test')[0].cuerpo).toEqual({ text: 'Probando', voice: 'es-UY-MateoNeural' });
    expect(container.querySelector('.av-mouth')).toBeTruthy();
    expect(container.querySelectorAll('.av-eq').length).toBe(5);
    fireEvent.click(tarjeta('Mateo'));
    await waitFor(() => expect(screen.getByText('Sin reproducir')).toBeTruthy());
    // termina sola
    fireEvent.click(tarjeta('Elena'));
    await waitFor(() => expect(screen.getByText('🔊 Hablando · Elena')).toBeTruthy());
    fireEvent(container.querySelector('audio'), new Event('ended'));
    await waitFor(() => expect(screen.getByText('Sin reproducir')).toBeTruthy());
    // «Detener» corta lo que suena
    fireEvent.click(screen.getByRole('button', { name: /Reproducir/ }));
    await waitFor(() => expect(screen.getByText(/Hablando · es-UY-ValentinaNeural/)).toBeTruthy());
    expect(f.de('POST', '/voz/test')[2].cuerpo.voice).toBe('es-UY-ValentinaNeural');
    fireEvent.click(screen.getByRole('button', { name: /Detener/ }));
    await waitFor(() => expect(screen.getByText('Sin reproducir')).toBeTruthy());
  });

  it('si la síntesis falla avisa y no queda «reproduciendo»', async () => {
    f = fetchFalso(rutas({ 'POST /voz/test': estado(503, { error: 'Edge sin internet' }), 'GET /voz/config': { whisper: 'small' } }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="nube" />);
    await waitFor(() => tarjeta('Mateo'));
    await waitFor(() => expect(f.de('GET', '/settings').length).toBe(1));
    fireEvent.click(tarjeta('Mateo'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Error generando audio', 'bad', { description: 'Edge sin internet' }));
    expect(screen.getByText('Sin reproducir')).toBeTruthy();
    // sin voz por defecto configurada, el estudio usa la uruguaya
    fireEvent.click(screen.getByRole('button', { name: /Reproducir/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledTimes(2));
    expect(f.de('POST', '/voz/test')[1].cuerpo.voice).toBe('es-UY-ValentinaNeural');
  });

  it('la estrella fija la voz por defecto; si falla avisa igual que la cambió en pantalla', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'POST /voz/config': () => (n++ ? estado(500, { error: 'no' }) : {}) }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="nube" />);
    await waitFor(() => tarjeta('Mateo'));
    await waitFor(() => expect(f.de('GET', '/voz/config').length).toBe(1));
    fireEvent.click(tarjeta('Mateo').querySelector('.tabler-icon-star').closest('button'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Voz por defecto: es-UY-MateoNeural', 'ok'));
    expect(f.de('POST', '/voz/config')[0].cuerpo).toEqual({ whisper: 'small', default_voice: 'es-UY-MateoNeural' });
    expect(f.de('POST', '/voz/test').length).toBe(0);                     // la estrella no reproduce
    fireEvent.click(tarjeta('Elena').querySelector('.tabler-icon-star').closest('button'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Error al fijar la voz', 'bad', { description: 'no' }));
  });
});

describe('Audios del sistema', () => {
  it('lista con estado de cada audio, filtra, escucha y guarda el texto al salir del campo', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'PUT /sysprompts/digits%2F1': () => (n++ ? estado(500, { error: 'no guardó' }) : {}), 'GET /sysprompts/test/digits%2F1': estado(404, { error: 'sin audio' }) }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="sys" />);
    expect(await screen.findByText('2 / 10 con voz')).toBeTruthy();
    const fila = (n) => screen.getByText(n).closest('tr');
    expect(fila('digits/0').textContent).toContain('activo');
    expect(fila('digits/1').textContent).toContain('generado');
    expect(fila('digits/2').textContent).toContain('original');
    expect(fila('digits/2').querySelector('.tabler-icon-volume').closest('button').disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Buscar…'), { target: { value: 'NÚMERO 9' } });
    expect(document.querySelectorAll('tbody tr').length).toBe(1);
    fireEvent.change(screen.getByPlaceholderText('Buscar…'), { target: { value: 'digits/1' } });
    expect(document.querySelectorAll('tbody tr').length).toBe(1);
    fireEvent.change(screen.getByPlaceholderText('Buscar…'), { target: { value: '' } });
    fireEvent.click(fila('digits/0').querySelector('.tabler-icon-volume').closest('button'));
    await waitFor(() => expect(f.llamadas.some((l) => l.ruta.startsWith('/sysprompts/test/digits%2F0?t='))).toBe(true));
    await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled());
    fireEvent.click(fila('digits/1').querySelector('.tabler-icon-volume').closest('button'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('sin audio', 'bad'));
    const texto = fila('digits/1').querySelector('input');
    fireEvent.blur(texto, { target: { value: 'uno' } });
    await waitFor(() => expect(f.de('PUT', '/sysprompts/digits%2F1')[0].cuerpo).toEqual({ text: 'uno' }));
    fireEvent.blur(texto, { target: { value: 'uno!' } });
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('no guardó', 'bad'));
  });

  it('generar todos va en tandas de 8 con progreso; sólo dígitos y regenerar uno mandan sus nombres', async () => {
    const tandas = [];
    let soltar;
    f = fetchFalso(rutas({ 'POST /sysprompts/generate': (b) => { tandas.push(b); if (tandas.length === 1) return new Promise((r) => { soltar = r; }); return tandas.length === 2 ? estado(500, { error: 'tanda caída' }) : {}; } }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="sys" />);
    await screen.findByText('2 / 10 con voz');
    fireEvent.click(screen.getByRole('button', { name: /Generar todos/ }));
    expect(await screen.findByText(/Se generarán y desplegarán todos los audios del sistema con la voz es-UY-ValentinaNeural/)).toBeTruthy();
    await confirmar('Generar todos');
    expect(await screen.findByText('Generando 0 / 10…')).toBeTruthy();
    await act(async () => { soltar({}); });
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Audios generados con es-UY-ValentinaNeural', 'ok'));
    expect(notify.toast).toHaveBeenCalledWith('tanda caída', 'bad');
    expect(tandas.map((t) => t.names.length)).toEqual([8, 2]);
    expect(tandas[0].voice).toBe('es-UY-ValentinaNeural');
    // cambiar la voz del sistema y generar sólo los dígitos
    fireEvent.click(screen.getByRole('textbox', { name: 'Voz del sistema' }));
    fireEvent.click(await screen.findByRole('option', { name: 'es_AR-daniela' }));
    fireEvent.click(screen.getByRole('button', { name: /Solo dígitos/ }));
    await confirmar('Generar dígitos');
    await waitFor(() => expect(tandas.length).toBe(4));
    expect(tandas[2]).toEqual({ voice: 'es_AR-daniela', names: SYS.slice(0, 8).map((x) => x.name) });
    expect(tandas[3].names).toEqual(['digits/8']);
    fireEvent.click(screen.getByText('digits/3').closest('tr').querySelector('.tabler-icon-refresh').closest('button'));
    await confirmar('Regenerar');
    await waitFor(() => expect(tandas.length).toBe(5));
    expect(tandas[4].names).toEqual(['digits/3']);
  });

  it('restaurar originales confirma y recarga la lista un rato después; si falla lo dice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    f = fetchFalso(rutas({ 'POST /sysprompts/revert': () => (n++ ? estado(500, { error: 'no restauró' }) : {}) }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="sys" />);
    await screen.findByText('2 / 10 con voz');
    fireEvent.click(screen.getByRole('button', { name: /Restaurar originales/ }));
    await confirmar('Restaurar originales');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Restaurando originales…', 'info'));
    expect(f.de('POST', '/sysprompts/revert')[0].cuerpo).toEqual({ names: [] });
    const antes = f.de('GET', '/sysprompts').length;
    await act(async () => { vi.advanceTimersByTime(1600); });
    await waitFor(() => expect(f.de('GET', '/sysprompts').length).toBe(antes + 1));
    fireEvent.click(screen.getAllByRole('button', { name: /Restaurar originales/ })[0]);
    await confirmar('Restaurar originales');
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('no restauró', 'bad'));
  });

  it('sin catálogo ofrece cargarlo; generar todos sin nada no manda nada', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'GET /sysprompts': () => (n++ ? SYS.slice(0, 1) : { no: 'lista' }), 'POST /sysprompts/seed': () => (n > 2 ? estado(500, { error: 'seed caído' }) : {}) }));
    vi.stubGlobal('fetch', f);
    renderNG(<VozConsole section="sys" />);
    expect(await screen.findByText('0 / 0 con voz')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Generar todos/ }));
    await confirmar('Generar todos');
    expect(f.de('POST', '/sysprompts/generate').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cargar catálogo' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Catálogo cargado', 'ok'));
    expect(await screen.findByText('1 / 1 con voz')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cargar catálogo' })).toBeNull();
  });

  it('si cargar el catálogo falla lo dice', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /sysprompts': [], 'POST /sysprompts/seed': estado(500, { error: 'seed caído' }) })));
    renderNG(<VozConsole section="sys" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar catálogo' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('seed caído', 'bad'));
  });
});

describe('Logs y pantalla completa', () => {
  it('logs: invita a cargar, carga y muestra; un error se avisa', async () => {
    let n = 0;
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /voz/logs': () => [{ logs: 'arrancó piper' }, {}, estado(500, { error: 'sin logs' })][n++] })));
    renderNG(<VozConsole section="logs" />);
    expect(screen.getByText(/Tocá «Cargar logs»/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Cargar logs/ }));
    expect(await screen.findByText('arrancó piper')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Cargar logs/ }));
    expect(await screen.findByText(/Tocá «Cargar logs»/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Cargar logs/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('sin logs', 'bad'));
  });

  it('una sección desconocida o vieja («voices») cae en el panel de voces', async () => {
    const a = renderNG(<VozConsole section="inventada" />);
    expect(await screen.findByText('Catálogo Piper (descargar para uso offline)')).toBeTruthy();
    expect(screen.getByText('Voces uruguayas')).toBeTruthy();
    a.unmount();
    renderNG(<VozConsole section="voices" />);
    expect(await screen.findByText('Otras de Latinoamérica · Edge (online)')).toBeTruthy();
  });

  it('/voz (sin sección): encabezado con estado y solapas', async () => {
    renderNG(<VozConsole />);
    expect(await screen.findByText('Procesamiento de Voz IA')).toBeTruthy();
    expect(await screen.findByText('En línea · 12ms')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Recargar/ }));
    await waitFor(() => expect(f.de('GET', '/voz/voices').length).toBe(2));
    fireEvent.click(screen.getByRole('tab', { name: /Audios del sistema/ }));
    expect(await screen.findByText('Voz coherente en toda la central')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Motor/ }));
    expect(screen.getByText('Monitoreo del servicio')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Logs/ }));
    expect(screen.getByText('Logs del servicio')).toBeTruthy();
  });

  it('/voz sin servicio muestra «Sin conexión» en el encabezado', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /voz': { ok: false } })));
    renderNG(<VozConsole />);
    await waitFor(() => expect(screen.getAllByText('Sin conexión').length).toBe(1));
  });
});
