/* IA & Voz › Agentes: la lista de agentes IA, el registro de lo que hicieron y el cajón de
 * alta/edición (Identidad → Cerebro → Herramientas → Derivaciones).
 *
 * Se fija lo que decide si un agente atiende bien o mal: que cambiar de proveedor deje
 * modelo y voz coherentes (un voz-a-voz con `gpt-4o-mini` se guardaba y no hablaba), que
 * un modelo retirado no se ofrezca, que la prueba de conexión diga POR QUÉ falló, que los
 * candados del portón se vean, que el registro aísle los rechazos, y que un error de la API
 * se muestre en vez de tumbar la pantalla (antes un 403 dejaba la lista en `{error}` y
 * la página reventaba en `.filter`). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderNG, fetchFalso, estado } from './helpers/apps-render.jsx';

const notify = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../app/notify', () => notify);

import AiAgents from '../app/ai-agents/page';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

const AHORA = Date.now();
const AGENTES = [
  { id: 1, name: 'Portería', exten: '7700', provider: 'openai-realtime', model: 'gpt-live-1', voice: 'marin', enabled: true },
  { id: 2, name: 'Demo local', exten: '7701', provider: 'demo', voice: 'es_AR-daniela', enabled: false },
];
const ACCIONES = [
  { id: 1, ts: AHORA - 60000, llamante: '099111', herramienta: 'abrir_porton', resultado: 'abierto', motivo: 'visita a la 402' },
  { id: 2, ts: AHORA - 120000, herramienta: 'abrir_porton', resultado: 'rechazado', razon: 'fuera de horario' },
  { id: 3, ts: AHORA - 180000, llamante: '099222', herramienta: 'transferir', resultado: '' },
];
const CATALOGO = [
  { id: 'consultar_unidad', riesgo: 'lee', titulo: 'Consultar unidad', ayuda: 'Busca quién vive' },
  { id: 'transferir', riesgo: 'actua', titulo: 'Transferir', ayuda: 'Pasa la llamada' },
  { id: 'abrir_porton', riesgo: 'abre', titulo: 'Abrir', ayuda: '' },
];
const rutas = (extra = {}) => ({
  'GET /ai-agents': AGENTES,
  'GET /ai-agents/live': { salud: { estado: 'ok' } },
  'GET /voz/voices': { installed: [{ key: 'es_AR-daniela' }], edge: [{ key: 'es-UY-ValentinaNeural', label: 'Valentina' }] },
  'GET /ai-agents/herramientas': CATALOGO,
  'GET /ai-agents/acciones': ACCIONES,
  'GET /ai-agents/modelos': { ok: true, modelos: ['gpt-live-1', 'gpt-realtime-2.1'], razonamiento: ['gpt-5.1', 'gpt-6-sol', 'gpt-5-nano'] },
  'POST /ai-agents': { id: 9 },
  'PUT /ai-agents/1': {},
  'DELETE /ai-agents/1': null,
  ...extra,
});

let f;
beforeEach(() => {
  notify.toast.mockReset();
  f = fetchFalso(rutas());
  vi.stubGlobal('fetch', f);
  vi.stubGlobal('confirm', vi.fn(() => true));
  URL.createObjectURL = vi.fn(() => 'blob:voz');
  window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});
afterEach(() => { vi.useRealTimers(); });

const nuevo = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Nuevo agente/ }));
  return screen.findByText('Un interno que atiende y conversa');
};
const solapa = (n) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(n) }));
const elegir = async (label, opcion) => {
  fireEvent.click(screen.getByRole('textbox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: opcion }));
};

describe('lista y registro', () => {
  it('lista los agentes con dónde corren, modelo y estado; el resumen los cuenta', async () => {
    renderNG(<AiAgents />);
    expect(screen.getByText('Cargando agentes…')).toBeTruthy();
    expect(await screen.findByText('Portería')).toBeTruthy();
    expect(screen.getByText('2 agentes · 1 activo · 1 en la nube')).toBeTruthy();
    const fila = (n) => screen.getByText(n).closest('tr');
    expect(fila('Portería').textContent).toMatch(/7700.*Nube.*gpt-live-1.*marin.*Atiende/);
    expect(fila('Demo local').textContent).toMatch(/Local.*Vosk \+ reglas.*Apagado/);
    expect(screen.getByText(/Para que atienda una/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('Buscar…')).toBeNull();
  });

  it('con más de 4 agentes aparece el buscador (nombre, interno o modelo)', async () => {
    const muchos = [1, 2, 3, 4, 5].map((i) => ({ id: i, name: 'Agente ' + i, exten: '77' + i, provider: i === 5 ? 'openai' : 'demo', model: i === 5 ? 'gpt-4o' : null, enabled: true }));
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents': muchos })));
    renderNG(<AiAgents />);
    const buscar = await screen.findByPlaceholderText('Buscar…');
    expect(screen.getByText('5 agentes · 5 activos · 1 en la nube')).toBeTruthy();
    fireEvent.change(buscar, { target: { value: 'agente 3' } });
    expect(screen.getByText('Agente 3')).toBeTruthy();
    expect(screen.queryByText('Agente 1')).toBeNull();
    fireEvent.change(buscar, { target: { value: '774' } });
    expect(screen.getByText('Agente 4')).toBeTruthy();
    fireEvent.change(buscar, { target: { value: 'GPT-4O' } });
    expect(screen.getByText('Agente 5')).toBeTruthy();
    expect(screen.queryByText('Agente 4')).toBeNull();
  });

  it('sin agentes invita a crear el primero; si la API falla lo dice y no se cae', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents': [], 'GET /ai-agents/acciones': [] })));
    const a = renderNG(<AiAgents />);
    expect(await screen.findByText('Todavía no hay agentes')).toBeTruthy();
    expect(screen.getByText('0 agentes · 0 activos · 0 en la nube')).toBeTruthy();
    expect(await screen.findByText('Todavía no hay acciones registradas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Crear el primero/ }));
    expect(await screen.findByText('Un interno que atiende y conversa')).toBeTruthy();
    a.unmount();
    vi.stubGlobal('fetch', fetchFalso({ 'GET /ai-agents': estado(403, { error: 'Sólo administradores' }), 'GET /ai-agents/live': estado(500), 'GET /voz/voices': estado(500), 'GET /ai-agents/herramientas': estado(500, { error: 'catálogo caído' }), 'GET /ai-agents/acciones': estado(500) }));
    renderNG(<AiAgents />);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Sólo administradores', 'bad'));
    expect(notify.toast).toHaveBeenCalledWith('catálogo caído', 'bad');
    expect(await screen.findByText('Todavía no hay agentes')).toBeTruthy();
    expect(screen.getByText('Sin acciones todavía')).toBeTruthy();
  });

  it('un solo agente: «1 agente · 1 activo»; respuestas que no son lista cuentan como vacías', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents': [AGENTES[0]], 'GET /ai-agents/acciones': { raro: 1 }, 'GET /ai-agents/herramientas': { raro: 1 }, 'GET /ai-agents/live': null, 'GET /voz/voices': null })));
    renderNG(<AiAgents />);
    expect(await screen.findByText('1 agente · 1 activo · 1 en la nube')).toBeTruthy();
    expect(screen.getByText('Todavía no hay acciones registradas')).toBeTruthy();
  });

  it('el banner del proveedor: salud mala lo muestra, salud ok lo saca, y sin salud usa el último problema', async () => {
    const reciente = new Date(AHORA - 3600000).toISOString();
    let n = 0;
    const vivos = [
      { salud: { estado: 'sin_saldo', que: 'La cuenta de OpenAI no tiene saldo', arreglo: 'Cargá crédito', ts: reciente } },
      { salud: { estado: 'ok' } },
      { problema: { que: 'Modelo inexistente', arreglo: 'Revisá el modelo', ts: reciente } },
      { salud: { estado: 'sin_clave' }, problema: { que: 'Viejo', arreglo: '-', ts: '2020-01-01' } },
    ];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents/live': () => vivos[Math.min(n++, 3)] })));
    renderNG(<AiAgents />);
    expect(await screen.findByText('La cuenta de OpenAI no tiene saldo')).toBeTruthy();
    expect(screen.getByText(/Cargá crédito · detectado/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(30000); });
    await waitFor(() => expect(screen.queryByText('La cuenta de OpenAI no tiene saldo')).toBeNull());
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(await screen.findByText('Modelo inexistente')).toBeTruthy();
    // se puede cerrar a mano
    fireEvent.click(screen.getByText('Modelo inexistente').closest('.mantine-Alert-root').querySelector('.mantine-Alert-closeButton'));
    expect(screen.queryByText('Modelo inexistente')).toBeNull();
    // un problema de hace más de un día no se muestra
    await act(async () => { vi.advanceTimersByTime(30000); });
    await waitFor(() => expect(n).toBeGreaterThanOrEqual(4));
    expect(screen.queryByText('Viejo')).toBeNull();
  });

  it('con la pestaña oculta el refresco de 30 s no pide nada', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderNG(<AiAgents />);
    await screen.findByText('Portería');
    const antes = f.de('GET', '/ai-agents/live').length;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.de('GET', '/ai-agents/live').length).toBe(antes);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await act(async () => { vi.advanceTimersByTime(30000); });
    await waitFor(() => expect(f.de('GET', '/ai-agents/live').length).toBe(antes + 1));
  });

  it('el registro cuenta aperturas y rechazos, filtra por rechazos y por herramienta', async () => {
    renderNG(<AiAgents />);
    expect(await screen.findByText('3 últimas · 1 apertura · 1 rechazada')).toBeTruthy();
    expect(screen.getByText('fuera de horario')).toBeTruthy();
    expect(screen.getByText('visita a la 402')).toBeTruthy();
    expect(screen.getByText('099111')).toBeTruthy();
    const filas = () => [...document.querySelectorAll('tbody tr')].filter((tr) => tr.textContent.includes('abrir_porton') || tr.textContent.includes('transferir'));
    expect(filas().length).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'Rechazos' }));
    expect(filas().length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Rechazos' }));
    fireEvent.click(screen.getByPlaceholderText('Toda herramienta'));
    fireEvent.click(await screen.findByRole('option', { name: 'transferir' }));
    expect(filas().length).toBe(1);
    expect(filas()[0].textContent).toMatch(/—.*—$/);
    fireEvent.click(screen.getByRole('button', { name: 'Rechazos' }));
    expect(screen.getByText('Ningún rechazo')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Actualizar'));
    await waitFor(() => expect(f.de('GET', '/ai-agents/acciones').length).toBe(2));
  });

  it('una sola acción: singular y sin rechazos', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents/acciones': [{ id: 9, ts: AHORA, herramienta: 'x', resultado: 'abrió' }] })));
    renderNG(<AiAgents />);
    expect(await screen.findByText('1 última · 1 apertura')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Toda herramienta')).toBeNull();
  });

  it('borrar pide confirmación; un rechazo de la API ya no dice «eliminado»', async () => {
    renderNG(<AiAgents />);
    const fila = (await screen.findByText('Portería')).closest('tr');
    confirm.mockReturnValueOnce(false);
    fireEvent.click(fila.querySelector('.tabler-icon-trash').closest('button'));
    expect(f.de('DELETE', '/ai-agents').length).toBe(0);
    fireEvent.click(fila.querySelector('.tabler-icon-trash').closest('button'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Agente eliminado', 'info'));
    fireEvent.click(screen.getByText('Demo local').closest('tr').querySelector('.tabler-icon-trash').closest('button'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No encontrado: DELETE /ai-agents/2', 'bad'));
    expect(notify.toast).not.toHaveBeenCalledWith('Agente eliminado', 'info', expect.anything());
  });
});

describe('alta y edición', () => {
  it('no guarda sin nombre ni acceso; crea con los valores de fábrica de voz a voz', async () => {
    renderNG(<AiAgents />);
    await nuevo();
    solapa('Cerebro');
    fireEvent.click(screen.getByRole('button', { name: /Crear agente/ }));
    expect(notify.toast).toHaveBeenCalledWith('El nombre y el número de acceso son obligatorios', 'bad');
    expect(screen.getByRole('textbox', { name: /Nombre/ })).toBeTruthy();      // volvió a Identidad
    fireEvent.change(screen.getByRole('textbox', { name: /Nombre/ }), { target: { value: 'Recepción' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Número de acceso/ }), { target: { value: '7702' } });
    expect(screen.getByText('Atiende marcando 7702')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: /Sin grabar/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Atiende llamadas/ }));
    expect(screen.getByRole('switch', { name: 'Apagado' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('switch')[0]);                         // el ON/OFF del encabezado
    fireEvent.click(screen.getByRole('button', { name: /Crear agente/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Agente creado · marcá 7702', 'ok'));
    expect(f.de('POST', '/ai-agents')[0].cuerpo).toMatchObject({ name: 'Recepción', exten: '7702', provider: 'openai-realtime', model: 'gpt-live-1', voice: 'marin', record: true, enabled: true });
    await waitFor(() => expect(screen.queryByText('Atiende marcando 7702')).toBeNull());
  });

  it('editar desde la fila guarda con PUT; un error queda en el cajón', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'PUT /ai-agents/1': () => (n++ ? {} : estado(409, { error: 'El interno 7700 ya existe' })) }));
    vi.stubGlobal('fetch', f);
    renderNG(<AiAgents />);
    fireEvent.click(await screen.findByText('Portería'));
    expect(await screen.findByText('Atiende marcando 7700')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Error: El interno 7700 ya existe', 'bad'));
    expect(screen.getByText('Atiende marcando 7700')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Agente actualizado', 'ok'));
    expect(f.de('PUT', '/ai-agents/1')[1].cuerpo).toMatchObject({ id: 1, name: 'Portería' });
    // el lápiz también abre, y Cancelar cierra
    fireEvent.click(screen.getByText('Demo local').closest('tr').querySelector('.tabler-icon-edit').closest('button'));
    expect(await screen.findByText('Atiende marcando 7701')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Atiende marcando 7701')).toBeNull());
  });

  it('un agente sin nombre se titula «Editar agente»; Escape cierra el cajón', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents': [{ id: 5, name: '', exten: '7', provider: 'openai', enabled: true }] })));
    renderNG(<AiAgents />);
    fireEvent.click((await screen.findAllByText('7'))[0].closest('tr'));
    expect(await screen.findByText('Editar agente')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Editar agente')).toBeNull());
  });

  it('Cerebro: cambiar de proveedor deja modelo y voz coherentes', async () => {
    renderNG(<AiAgents />);
    await nuevo();
    fireEvent.click(screen.getByRole('button', { name: /Siguiente: Cerebro/ }));
    // voz a voz: modelos de la cuenta, sin los retirados
    expect(await screen.findByText('Los 2 que sirve tu cuenta')).toBeTruthy();
    expect(screen.getAllByText(/se paga por minuto/i).length).toBe(2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Voz' }), { target: { value: 'cedar' } });
    // a tres pasos: el modelo realtime se cambia por uno de texto
    await elegir('Proveedor', /OpenAI en tres pasos/);
    expect(screen.getByRole('textbox', { name: 'Modelo' }).value).toBe('gpt-4o-mini (rápido/económico)');
    await elegir('Modelo', /gpt-4o \(máxima/);
    await elegir('Voz', 'Onyx');
    // de vuelta a voz a voz: el modelo de texto no sirve → el primero de la lista; la voz no es de RT → marin
    await elegir('Proveedor', /OpenAI voz a voz/);
    expect(screen.getByRole('textbox', { name: 'Modelo' }).value).toBe('gpt-live-1');
    expect(screen.getByRole('textbox', { name: 'Voz' }).value).toBe('marin');
    // demo: voces del servidor y aviso de «sin costo»
    await elegir('Proveedor', /Demo/);
    expect(screen.getByText(/Todo adentro del fierro/)).toBeTruthy();
    expect(screen.getByText('Sin costo: corre en tu servidor')).toBeTruthy();
    // IA externa: pide backend y token
    await elegir('Proveedor', /IA externa/);
    fireEvent.change(screen.getByRole('textbox', { name: /URL del backend/ }), { target: { value: 'http://asistente:3100' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Token compartido/ }), { target: { value: 'tok' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Destino de agentes/ }), { target: { value: '600' } });
    expect(screen.queryByRole('textbox', { name: 'Modelo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /← Identidad/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /Nombre/ }), { target: { value: 'X' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Número de acceso/ }), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Crear agente/ }));
    await waitFor(() => expect(f.de('POST', '/ai-agents').length).toBe(1));
    expect(f.de('POST', '/ai-agents')[0].cuerpo).toMatchObject({ provider: 'ia-externa', externo_url: 'http://asistente:3100', externo_token: 'tok', agentes_exten: '600' });
  });

  it('Cerebro: pasar a voz a voz respeta un modelo y una voz que ya son de voz a voz', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents': [{ id: 3, name: 'Viejo', exten: '7703', provider: 'demo', model: 'gpt-realtime-2.1', voice: 'cedar', enabled: true }] })));
    renderNG(<AiAgents />);
    fireEvent.click(await screen.findByText('Viejo'));
    solapa('Cerebro');
    await elegir('Proveedor', /OpenAI voz a voz/);
    expect(screen.getByRole('textbox', { name: 'Modelo' }).value).toBe('gpt-realtime-2.1');
    expect(screen.getByRole('textbox', { name: 'Voz' }).value).toBe('cedar');
  });

  it('Cerebro: el desplegable de proveedores dice dónde corre cada uno', async () => {
    renderNG(<AiAgents />);
    await nuevo();
    solapa('Cerebro');
    fireEvent.click(screen.getByRole('textbox', { name: 'Proveedor' }));
    const op = await screen.findByRole('option', { name: /Demo/ });
    expect(op.textContent).toContain('Sin clave ni internet');
    expect(op.querySelector('.pbxng-ico')).toBeTruthy();
  });

  it('Cerebro: la descripción del modelo dice si la cuenta no sirve ninguno o si no se pudo consultar', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents/modelos': { ok: true, modelos: [] } })));
    const a = renderNG(<AiAgents />);
    await nuevo(); solapa('Cerebro');
    expect(await screen.findByText('Tu cuenta no sirve ninguno de voz a voz')).toBeTruthy();
    a.unmount();
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents/modelos': estado(500) })));
    renderNG(<AiAgents />);
    await nuevo(); solapa('Cerebro');
    expect(await screen.findByText('No se pudo consultar tu cuenta')).toBeTruthy();
  });

  it('Cerebro: antes de saber qué modelos sirve la cuenta, sugiere los conocidos', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({ 'GET /ai-agents/modelos': () => new Promise(() => {}) })));
    renderNG(<AiAgents />);
    fireEvent.click(await screen.findByText('Demo local'));
    solapa('Cerebro');
    await elegir('Proveedor', /OpenAI voz a voz/);
    expect(screen.getByText('gpt-live o gpt-realtime')).toBeTruthy();
  });

  it('Cerebro: probar la conexión muestra tiempos y lo que dijo, o el porqué del fallo', async () => {
    let n = 0;
    const respuestas = [
      { ok: true, abrio_ms: 320, primer_audio_ms: 900, texto: ' Hola, portería. ', api: 'ga' },
      { ok: false, error: 'invalid_model', intentos: [{ intento: 'ga' }, { intento: 'beta' }], eventos: { 'session.created': 1, error: 2 }, endpoint: 'wss://api' },
      estado(502, { error: 'sin salida a internet' }),
      { ok: true, abrio_ms: 1, primer_audio_ms: 2 },
      { ok: false },
      null,
    ];
    f = fetchFalso(rutas({ 'POST /ai-agents/probar': () => respuestas[n++] }));
    vi.stubGlobal('fetch', f);
    renderNG(<AiAgents />);
    fireEvent.click(await screen.findByText('Portería'));
    solapa('Cerebro');
    const probar = () => fireEvent.click(screen.getByRole('button', { name: /Probar conexión/ }));
    probar();
    expect(await screen.findByText('El modelo contestó. Ya se puede marcar 7700.')).toBeTruthy();
    expect(screen.getByText(/Sesión en 320 ms · primer audio en 900 ms/)).toBeTruthy();
    expect(screen.getByText('Dijo: «Hola, portería.»')).toBeTruthy();
    expect(f.de('POST', '/ai-agents/probar')[0].cuerpo).toEqual({ model: 'gpt-live-1', voice: 'marin' });
    expect(notify.toast).toHaveBeenCalledWith('El modelo contestó: ya se puede marcar 7700', 'ok');
    probar();
    expect(await screen.findByText('invalid_model')).toBeTruthy();
    expect(screen.getByText('Se probaron 2 modos: ga · beta')).toBeTruthy();
    expect(screen.getByText('El proveedor mandó: session.created, error ×2')).toBeTruthy();
    expect(screen.getByText('wss://api')).toBeTruthy();
    expect(notify.toast).toHaveBeenCalledWith('La prueba falló', 'bad');
    probar();
    expect(await screen.findByText('sin salida a internet')).toBeTruthy();
    probar();
    expect(await screen.findByText(/Sesión en 1 ms/)).toBeTruthy();
    expect(screen.queryByText(/^Dijo:/)).toBeNull();
    probar();
    expect(await screen.findByText('falló sin decir por qué')).toBeTruthy();
    // cambiar el modelo invalida la prueba anterior
    fireEvent.change(screen.getByRole('textbox', { name: 'Modelo' }), { target: { value: '' } });
    expect(screen.queryByText('falló sin decir por qué')).toBeNull();
    expect(screen.getByRole('button', { name: /Probar conexión/ }).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Modelo' }), { target: { value: 'gpt-live-1' } });
    probar();
    expect(await screen.findByText('falló sin decir por qué')).toBeTruthy();
  });

  it('Cerebro (demo): escuchar la voz elegida sintetiza el saludo; si falla, avisa', async () => {
    let n = 0;
    f = fetchFalso(rutas({ 'POST /voz/test': () => (n++ ? estado(503, { error: 'Piper apagado' }) : new Response(new Blob(['w']), { status: 200 })) }));
    vi.stubGlobal('fetch', f);
    renderNG(<AiAgents />);
    fireEvent.click(await screen.findByText('Demo local'));
    solapa('Cerebro');
    const escuchar = () => fireEvent.click(document.querySelector('.mantine-Drawer-content .tabler-icon-player-play').closest('button'));
    escuchar();
    await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(f.de('POST', '/voz/test')[0].cuerpo).toEqual({ text: 'Hola, esta es la voz del agente.', voice: 'es_AR-daniela' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Saludo inicial' }), { target: { value: 'Buen día' } });
    escuchar();
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No se pudo generar el audio', 'bad', { description: 'Piper apagado' }));
    expect(f.de('POST', '/voz/test')[1].cuerpo.text).toBe('Buen día');
    await elegir('Voz', 'Valentina');
    fireEvent.change(screen.getByRole('textbox', { name: /Instrucciones/ }), { target: { value: 'Sé breve' } });
  });

  it('Cerebro: silencios — encender pone los tiempos de fábrica y apagar los vuelve a cero', async () => {
    renderNG(<AiAgents />);
    fireEvent.click(await screen.findByText('Portería'));
    solapa('Cerebro');
    fireEvent.click(screen.getByRole('switch', { name: /Apagado: la llamada queda abierta/ }));
    expect(screen.getByRole('textbox', { name: /Sigue ahí/ }).value).toBe('5 s');
    expect(screen.getByRole('textbox', { name: /Despedida y corte/ }).value).toBe('8 s');
    // apagar vuelve todo a cero y esconde los campos
    fireEvent.click(screen.getByRole('switch', { name: /La central consulta/ }));
    expect(screen.queryByRole('textbox', { name: /Sigue ahí/ })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /Apagado: la llamada queda abierta/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /Sigue ahí/ }), { target: { value: '7' } });
    fireEvent.change(screen.getAllByRole('textbox', { name: /Segunda consulta/ })[0], { target: { value: '4' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Despedida y corte/ }), { target: { value: '9' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Primera consulta' }), { target: { value: '¿Sigue ahí?' } });
    fireEvent.change(screen.getAllByRole('textbox', { name: /Segunda consulta/ })[1], { target: { value: '¿Hola?' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Despedida$/ }), { target: { value: 'Chau' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(f.de('PUT', '/ai-agents/1').length).toBe(1));
    expect(f.de('PUT', '/ai-agents/1')[0].cuerpo).toMatchObject({ inact1_s: 7, inact2_s: 4, cierre_s: 9, inact1_text: '¿Sigue ahí?', inact2_text: '¿Hola?', despedida_text: 'Chau' });
  });

  it('Herramientas: consultar sin webhook avisa; el portón muestra sus candados; el razonador no ofrece retirados', async () => {
    renderNG(<AiAgents />);
    fireEvent.click(await screen.findByText('Portería'));
    fireEvent.click(screen.getByRole('button', { name: /Siguiente: Cerebro/ }));
    fireEvent.click(screen.getByRole('button', { name: /Siguiente: Herramientas/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Consultar unidad/ }));
    expect(screen.getByText(/Sin webhook del CRM configurado/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: /Transferir/ }));
    // portón
    fireEvent.click(screen.getAllByRole('switch', { name: 'Apagado' })[0]);
    expect(screen.getByRole('switch', { name: 'El agente puede abrir' })).toBeTruthy();
    const verif = screen.getByRole('switch', { name: /Exigir verificación previa/ });
    expect(verif.checked).toBe(true);
    fireEvent.click(verif);
    fireEvent.change(screen.getByRole('textbox', { name: /Ventana horaria/ }), { target: { value: '07:00-22:00' } });
    expect(screen.getByRole('textbox', { name: /Tope por hora/ }).value).toBe('3');
    fireEvent.change(screen.getByRole('textbox', { name: /Tope por hora/ }), { target: { value: '5' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Tono/ }), { target: { value: '#' } });
    await elegir('Cómo abre', 'URL de un relé');
    fireEvent.change(screen.getByRole('textbox', { name: /URL del relé/ }), { target: { value: 'http://rele/abrir' } });
    // el modelo que razona: el retirado gpt-5.1 no se ofrece
    fireEvent.click(screen.getByRole('textbox', { name: 'Modelo que razona' }));
    expect(await screen.findByRole('option', { name: 'gpt-6-sol' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'gpt-5.1' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'gpt-5-nano' }));
    expect(screen.getByText('Los que sirve tu cuenta')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Siguiente: Derivaciones/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ventas' }), { target: { value: '1001' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Soporte' }), { target: { value: '1002' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Por defecto' }), { target: { value: '1003' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Webhook del CRM' }), { target: { value: 'https://crm/lookup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(f.de('PUT', '/ai-agents/1').length).toBe(1));
    expect(f.de('PUT', '/ai-agents/1')[0].cuerpo).toMatchObject({
      sales_exten: '1001', support_exten: '1002', default_exten: '1003', crm_webhook: 'https://crm/lookup',
      herramientas: {
        consultar_unidad: { on: true }, transferir: { on: true },
        abrir_porton: { on: true, exigir_verificacion: false, ventana: '07:00-22:00', max_por_hora: 5, dtmf: '#', modo: 'webhook', url: 'http://rele/abrir' },
        delegacion: { model: 'gpt-5-nano' },
      },
    });
  });

  it('Herramientas: un agente viejo con gpt-5.1 guardado razona con el reemplazo; sin catálogo de la cuenta, sugerencias', async () => {
    vi.stubGlobal('fetch', fetchFalso(rutas({
      'GET /ai-agents': [{ ...AGENTES[0], herramientas: { transferir: { on: true }, delegacion: { model: 'gpt-5.1' } } }],
      'GET /ai-agents/modelos': { ok: false },
      'GET /ai-agents/herramientas': [CATALOGO[1]],
    })));
    renderNG(<AiAgents />);
    fireEvent.click(await screen.findByText('Portería'));
    solapa('Herramientas');
    expect(screen.getByRole('textbox', { name: 'Modelo que razona' }).value).toBe('gpt-6-sol');
    expect(screen.getByText('Sugerencias')).toBeTruthy();
    // sin herramientas que lean ni portón en el catálogo, esos bloques no aparecen
    expect(screen.queryByText('Consultar datos')).toBeNull();
    expect(screen.queryByText('Abrir el portón')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /← Cerebro/ }));
    expect(screen.getByText('Con qué piensa y habla')).toBeTruthy();
    solapa('Derivaciones');
    fireEvent.click(screen.getByRole('button', { name: /← Herramientas/ }));
    expect(screen.getByText('Caja del backoffice')).toBeTruthy();
  });

  it('Herramientas: la caja del backoffice muestra lo declarado, lo descartado y por qué', async () => {
    let n = 0;
    const respuestas = [
      { ok: true, ms: 120, herramientas: [{ nombre: 'bo_reserva', parametros: ['unidad', 'fecha'] }, { nombre: 'bo_ping', parametros: [] }], descartes: [{ nombre: 'abrir_porton', razon: 'pisa una herramienta de la central' }], aviso: 'Respuesta lenta' },
      { ok: false, ms: 50, herramientas: [] },
      estado(504, { error: 'el backoffice no contestó' }),
    ];
    f = fetchFalso(rutas({ 'POST /ai-agents/probar-backoffice': () => respuestas[n++] }));
    vi.stubGlobal('fetch', f);
    renderNG(<AiAgents />);
    fireEvent.click(await screen.findByText('Portería'));
    solapa('Herramientas');
    const caja = screen.getByText('Caja del backoffice').closest('.mantine-Card-root');
    fireEvent.click(caja.querySelector('input[role="switch"]'));
    expect(screen.getByRole('switch', { name: /El agente usa también las herramientas del backoffice/ })).toBeTruthy();
    const probar = screen.getByRole('button', { name: /Probar el backoffice/ });
    expect(probar.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: /URL del backoffice/ }), { target: { value: 'https://gestion/api/ia' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Secreto compartido/ }), { target: { value: 's3cr3t' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Tope de respuesta/ }), { target: { value: '2000' } });
    fireEvent.click(probar);
    expect(await screen.findByText('Declaradas al modelo')).toBeTruthy();
    expect(f.de('POST', '/ai-agents/probar-backoffice')[0].cuerpo).toEqual({ url: 'https://gestion/api/ia', token: 's3cr3t', tope_ms: 2000 });
    expect(screen.getByText('bo_reserva').parentElement.textContent).toBe('bo_reserva (unidad, fecha)');
    expect(screen.getByText('bo_ping').parentElement.textContent).toBe('bo_ping');
    expect(screen.getByText('Descartadas (1)')).toBeTruthy();
    expect(screen.getByText(/pisa una herramienta de la central/)).toBeTruthy();
    expect(screen.getByText('Respuesta lenta')).toBeTruthy();
    expect(screen.getByText('120 ms en publicar el catálogo')).toBeTruthy();
    expect(notify.toast).toHaveBeenCalledWith('El backoffice publicó 2 herramienta(s)', 'ok');
    fireEvent.click(probar);
    expect(await screen.findByText(/no quedó ninguna herramienta usable/)).toBeTruthy();
    expect(notify.toast).toHaveBeenCalledWith('El backoffice no publicó nada usable', 'bad');
    fireEvent.click(probar);
    expect(await screen.findByText('el backoffice no contestó')).toBeTruthy();
  });
});
