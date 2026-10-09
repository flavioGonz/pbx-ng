/* Ficha de cliente (app/clientes/[id]/page.jsx).
 *
 * Es la pantalla donde el técnico carga un portero parado al lado de la puerta, y la que el
 * supervisor abre para ver qué pasó con un cliente. Se fija:
 *  - La URL RTSP se muestra ENMASCARADA (como viene de la API) y al editar un portero el
 *    campo de URL va vacío: mandar vacío es «no la toques», así guardar otra cosa no borra
 *    la clave de la cámara.
 *  - Lo del portero (interno, modo de apertura, relés) se manda sólo si el tipo es portero,
 *    y el formulario pide lo que cada modo necesita (DTMF/código: un código por relé; HTTP:
 *    dirección y credenciales, con la clave nunca precargada).
 *  - «Abrir» desde la ficha abre una puerta de verdad: pide confirmación y no se ofrece en
 *    modo DTMF (sin llamada el tono no tiene por dónde viajar).
 *  - «Probar» dice si la cámara responde y por qué no.
 *  - Historial con la grabación que corresponde a cada llamada, intervenciones y mapa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderP, rutasFalsas, estado } from './helpers/porteria-render';

const toast = vi.fn();
const push = vi.fn();
vi.mock('../app/notify', () => ({ toast: (...a) => toast(...a) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useParams: () => ({ id: '1' }) }));
vi.mock('../app/Intercom', () => ({
  default: ({ streams, columns }) => <div data-testid="pared" data-cols={columns}>{streams.map((s) => s.src).join(',')}</div>,
}));
vi.mock('../app/RecordingPlayer', () => ({ default: ({ src, label }) => <div data-testid="player">{src}|{label}</div> }));
vi.mock('../app/Slot', () => ({ default: ({ value }) => <span>{String(value)}</span> }));
import ClienteFicha from '../app/clientes/[id]/page';

const FICHA = {
  id: 1, name: 'Edificio Rambla', doc: '21', address: 'Rambla 1234', phones: ['099111', '2900', '2901', '2902'], notes: 'ojo perro',
  persons: [{ id: 7, name: 'Ana', relation: 'portera', doc: '123', valid_until: '2027-01-01' }, { id: 8, name: 'Beto' }],
  spaces: [{ id: 4, name: 'Apto 101', kind: 'depto' }, { id: 5, name: 'Cochera' }],
  devices: [
    { id: 9, label: 'Portero calle', type: 'intercom', rtsp_url: 'rtsp://***@10.0.0.5/1', rtsp_set: true, ext: '5001', rele_modo: 'http',
      rele_cfg: { marca: 'akuvox', host: '10.0.0.5', user: 'admin', pass_set: true, reles: [{ nombre: 'Puerta', num: 1 }, { num: 2 }] } },
    { id: 10, label: 'Portero fondo', type: 'intercom', rtsp_url: '', ext: null, rele_modo: 'dtmf', rele_cfg: { reles: [{ nombre: 'Reja', codigo: '#' }] } },
    { id: 11, label: 'Cochera', type: 'camera', rtsp_url: 'rtsp://***@10.0.0.6/1', rtsp_set: true, enabled: false },
    { id: 12, label: 'Portero raro', type: 'intercom', rele_modo: 'otro', rele_cfg: null },
  ],
};
const LLAMADAS = [
  { start: '2026-03-01T10:00:00Z', src: '099111', dst: '600', duration: 60, billsec: 75, disposition: 'ANSWERED' },
  { start: '2026-03-01T11:00:00Z', src: '2900', dst: null, duration: 0, billsec: 0, disposition: 'NO ANSWER' },
  { start: null, src: null, dst: '600', billsec: null, disposition: 'BUSY' },
];
const GRABACIONES = [
  { id: 'r1', ext: '600', started_at: '2026-03-01T10:00:02Z' },
  { id: 'r2', ext: '999', started_at: '2026-03-01T11:00:02Z' },
  { id: 'r3', ext: '2900' },
];
const INTER = {
  items: [
    { id: 1, created_at: '2026-03-01T10:05:00Z', ext: '600', caller: '099111', answers: { Motivo: 'Corte de luz', Resultado: 'Resuelto', Satisfaccion: 4, Comentario: 'bien' } },
    { id: 2, created_at: null, answers: { resultado: 'Pendiente' } },
    { id: 3, answers: null },
  ],
};

function api(extra = {}) {
  return rutasFalsas({
    'GET /clients/1': FICHA,
    'GET /intercom/streams': { streams: [{ src: 'c1_9' }, { src: 'c1_11' }] },
    'GET /clients/1/calls': LLAMADAS,
    'GET /clients/1/interventions': INTER,
    'GET /recordings': GRABACIONES,
    ...extra,
  });
}

async function montar(f = api()) {
  vi.stubGlobal('fetch', f);
  renderP(<ClienteFicha />);
  await screen.findByDisplayValue('Rambla 1234');
  return f;
}
const solapa = (texto) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(texto) }));
const boton = (clase, i = 0, raiz = document) => raiz.querySelectorAll('.tabler-icon-' + clase)[i].closest('button');
async function elegirEn(input, opcion) {
  fireEvent.click(input);
  await waitFor(() => expect(document.getElementById(input.getAttribute('aria-controls'))).toBeTruthy());
  fireEvent.click(within(document.getElementById(input.getAttribute('aria-controls'))).getByRole('option', { name: opcion, hidden: true }));
}

beforeEach(() => { toast.mockReset(); push.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('Ficha · carga', () => {
  it('mientras carga muestra el spinner; si el cliente no existe, lo dice y deja volver', async () => {
    const f = rutasFalsas({ 'GET /clients/1': estado(404), 'GET /intercom/streams': [], 'GET /clients/1/calls': estado(500), 'GET /clients/1/interventions': estado(500), 'GET /recordings': estado(500) });
    vi.stubGlobal('fetch', f);
    const { container } = renderP(<ClienteFicha />);
    expect(container.querySelector('.mantine-Loader-root')).toBeTruthy();
    expect(await screen.findByText(/Cliente no encontrado/)).toBeTruthy();
    fireEvent.click(screen.getByText('Volver'));
    expect(push).toHaveBeenCalledWith('/clientes');
  });

  it('encabezado con nombre, hasta tres teléfonos, flujos en vivo y los indicadores', async () => {
    await montar();
    expect(screen.getAllByText('Edificio Rambla').length).toBeGreaterThan(0);
    expect(screen.getByText('2901')).toBeTruthy();
    expect(screen.queryByText('2902')).toBeNull();
    expect(screen.getByText('2 en vivo')).toBeTruthy();
    const kpi = (k) => screen.getByText(k, { selector: 'p' }).parentElement.textContent;
    expect(kpi('Llamadas')).toBe('3Llamadas');
    expect(kpi('Atendidas')).toBe('1Atendidas');
    expect(kpi('Perdidas')).toBe('2Perdidas');
    expect(kpi('Minutos')).toBe('1Minutos');
    expect(kpi('Dispositivos')).toBe('4Dispositivos');
    expect(kpi('Intervenciones')).toBe('3Intervenciones');
    fireEvent.click(boton('arrow-left'));
    expect(push).toHaveBeenCalledWith('/clientes');
  });

  it('un cliente sin nada y respuestas rotas no rompen la ficha', async () => {
    vi.stubGlobal('fetch', rutasFalsas({
      'GET /clients/1': { id: 1 }, 'GET /intercom/streams': estado(500), 'GET /clients/1/calls': { x: 1 },
      'GET /clients/1/interventions': estado(500), 'GET /recordings': { x: 1 },
    }));
    renderP(<ClienteFicha />);
    expect(await screen.findByText('Cliente', { selector: 'p' })).toBeTruthy();
    solapa('Personas');
    expect(screen.getByText('Nadie autorizado todavía.')).toBeTruthy();
    expect(screen.getByText('Sin espacios cargados.')).toBeTruthy();
    solapa('Dispositivos');
    expect(screen.getByText(/Sin porteros ni cámaras/)).toBeTruthy();
    expect(screen.getByText(/Agregá un dispositivo con URL RTSP/)).toBeTruthy();
    solapa('Historial');
    expect(screen.getByText('Todavía no hay llamadas asociadas.')).toBeTruthy();
    solapa('Intervenciones');
    expect(screen.getByText('Sin intervenciones registradas.')).toBeTruthy();
    solapa('Mapa');
    expect(screen.getByText(/Cargá la dirección en la pestaña Datos/)).toBeTruthy();
    expect(screen.getByText('Ubicar en el mapa').closest('button').disabled).toBe(true);
  });
});

describe('Ficha · datos del cliente', () => {
  it('guardar manda la ficha editada y recarga; si falla lo dice', async () => {
    let falla = false;
    const f = await montar(api({ 'PUT /clients/1': () => (falla ? estado(500) : { id: 1 }) }));
    expect(screen.getByDisplayValue('099111, 2900, 2901, 2902')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Rambla SA' } });
    fireEvent.change(screen.getByLabelText('Documento'), { target: { value: '22' } });
    fireEvent.change(screen.getByLabelText(/Teléfonos/), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/^Dirección/), { target: { value: 'Otra 2' } });
    fireEvent.change(screen.getByLabelText('Notas'), { target: { value: '' } });
    expect(screen.getByText('RS')).toBeTruthy();
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Ficha guardada', 'ok'));
    expect(f.de('PUT', '/clients/1')[0].cuerpo).toEqual({ name: 'Rambla SA', doc: '22', address: 'Otra 2', phones: '1', notes: '' });
    await waitFor(() => expect(f.de('GET', '/clients/1').filter((l) => l.ruta === '/clients/1').length).toBe(2));
    falla = true;
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('No se pudo guardar', 'bad'));
  });

  it('eliminar el cliente pide confirmación y vuelve a la lista', async () => {
    const f = await montar(api({ 'DELETE /clients/1': {} }));
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(boton('trash'));
    expect(f.de('DELETE', '/clients/1').length).toBe(0);
    fireEvent.click(boton('trash'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/clientes'));
    expect(f.de('DELETE', '/clients/1').length).toBe(1);
    expect(toast).toHaveBeenCalledWith('Cliente eliminado', 'info');
  });
});

describe('Ficha · personas y espacios', () => {
  it('lista, agrega (sin nombre no manda) y saca', async () => {
    const f = await montar(api({ 'POST /clients/1/persons': {}, 'DELETE /persons/8': {}, 'POST /clients/1/spaces': {}, 'DELETE /spaces/5': {} }));
    solapa('Personas');
    expect(screen.getByText(/portera · 123 · vence 2027-01-01/)).toBeTruthy();
    expect(screen.getByText(/· depto/)).toBeTruthy();
    const [agPersona, agEspacio] = screen.getAllByText('Agregar');
    fireEvent.click(agPersona); fireEvent.click(agEspacio);
    expect(f.llamadas.some((l) => l.metodo === 'POST')).toBe(false);
    fireEvent.change(screen.getByPlaceholderText('Nombre'), { target: { value: 'Carla' } });
    fireEvent.change(screen.getByPlaceholderText('Vínculo'), { target: { value: 'hija' } });
    fireEvent.change(screen.getByPlaceholderText('Documento'), { target: { value: '9' } });
    fireEvent.click(agPersona);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Persona autorizada', 'ok'));
    expect(f.de('POST', '/clients/1/persons')[0].cuerpo).toEqual({ name: 'Carla', doc: '9', relation: 'hija', valid_until: '' });
    fireEvent.change(screen.getByPlaceholderText('Nombre / unidad'), { target: { value: 'Apto 2' } });
    fireEvent.change(screen.getByPlaceholderText('Tipo'), { target: { value: 'local' } });
    fireEvent.click(agEspacio);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Espacio agregado', 'ok'));
    expect(f.de('POST', '/clients/1/spaces')[0].cuerpo).toEqual({ name: 'Apto 2', kind: 'local' });
    // tachos: 0 = cliente, 1-2 personas, 3-4 espacios
    fireEvent.click(boton('trash', 2));
    await waitFor(() => expect(f.de('DELETE', '/persons/8').length).toBe(1));
    fireEvent.click(boton('trash', 4));
    await waitFor(() => expect(f.de('DELETE', '/spaces/5').length).toBe(1));
  });
});

describe('Ficha · porteros y cámaras', () => {
  it('lista con la URL enmascarada, el interno y cómo abre cada portero', async () => {
    await montar();
    solapa('Dispositivos');
    expect(screen.getByTestId('pared').textContent).toBe('c1_9,c1_11');
    expect(screen.getByTestId('pared').getAttribute('data-cols')).toBe('2');
    expect(screen.getByText('2 flujo(s) en vivo')).toBeTruthy();
    expect(screen.getByText('rtsp://***@10.0.0.5/1')).toBeTruthy();
    expect(screen.queryByText(/admin/)).toBeNull();
    expect(screen.getAllByText('sin URL RTSP').length).toBe(2);
    expect(screen.getByText(/interno 5001 · 2 relé\(s\) · HTTP al portero/)).toBeTruthy();
    expect(screen.getByText(/sin interno: no se lo puede llamar · 1 relé\(s\) · tono en la llamada/)).toBeTruthy();
    expect(screen.getByText(/0 relé\(s\) · otro/)).toBeTruthy();
    expect(screen.getByText('deshabilitado')).toBeTruthy();
    // Abrir sólo se ofrece donde puede andar sin llamada: los 2 relés HTTP, no el DTMF.
    expect(document.querySelectorAll('.tabler-icon-lock').length).toBe(2 + 1); // + el candado del aviso
  });

  it('un portero sin modo de apertura lo dice y no ofrece abrir', async () => {
    await montar(api({ 'GET /clients/1': { ...FICHA, devices: [{ id: 20, label: 'Simple', type: 'intercom', ext: '5002' }] } }));
    solapa('Dispositivos');
    expect(screen.getByText(/interno 5002 · sin apertura configurada/)).toBeTruthy();
    expect(document.querySelectorAll('.tabler-icon-lock').length).toBe(1); // sólo el del aviso
  });

  it('Probar dice si la cámara responde, con los códecs, o por qué no', async () => {
    let r = { ok: true, codecs: ['H264', 'PCMA'] };
    await montar(api({ 'POST /devices/9/test': () => r, 'POST /devices/10/test': estado(500), 'POST /devices/11/test': () => ({ ok: false, motivo: '401 Unauthorized' }) }));
    solapa('Dispositivos');
    fireEvent.click(boton('plug-connected', 0));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('La cámara responde', 'ok', { description: 'H264 · PCMA' }));
    expect(screen.getByText('responde')).toBeTruthy();
    r = { ok: true };
    fireEvent.click(boton('plug-connected', 0));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('La cámara responde', 'ok', { description: undefined }));
    fireEvent.click(boton('plug-connected', 1));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('La cámara no responde', 'bad', { description: 'no se pudo consultar a la central' }));
    fireEvent.click(boton('plug-connected', 2));
    await waitFor(() => expect(screen.getByText('401 Unauthorized')).toBeTruthy());
    expect(screen.getAllByText('no responde').length).toBe(2);
  });

  it('Abrir pide confirmación, abre de verdad y dice si no abrió', async () => {
    let resp = estado(200, { nombre: 'Puerta principal' });
    const f = await montar(api({ 'POST /devices/9/rele': () => resp }));
    solapa('Dispositivos');
    const conf = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const abrir = (i) => fireEvent.click(boton('lock', i + 1));
    abrir(0);
    expect(conf).toHaveBeenCalledWith('Esto ABRE «Puerta» de verdad, no es una simulación. ¿Seguir?');
    expect(f.de('POST', '/devices/9/rele').length).toBe(0);
    conf.mockReturnValue(true);
    abrir(0);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Abierto: Puerta principal', 'ok'));
    expect(f.de('POST', '/devices/9/rele')[0].cuerpo).toEqual({ rele: 0 });
    // Un relé sin nombre se nombra por su número.
    resp = estado(200, {});
    abrir(1);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Abierto: relé 2', 'ok'));
    expect(conf).toHaveBeenLastCalledWith('Esto ABRE «relé 2» de verdad, no es una simulación. ¿Seguir?');
    resp = estado(502, { error: 'el portero no contestó' });
    abrir(0);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('No abrió: el portero no contestó', 'bad'));
    resp = new Response('<html>', { status: 503 });
    abrir(0);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('No abrió: 503', 'bad'));
    resp = new Error('sin red');
    abrir(0);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('No abrió: sin red', 'bad'));
  });

  it('agregar un portero lo manda al cliente y refresca la pared un rato después', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let flujos = { streams: [{ src: 'c1_9' }, { src: 'c1_11' }] };
    const f = await montar(api({ 'POST /clients/1/devices': { id: 13 }, 'GET /intercom/streams': () => flujos }));
    solapa('Dispositivos');
    const agregar = screen.getByText('Agregar');
    fireEvent.click(agregar);
    expect(f.de('POST', '/clients/1/devices').length).toBe(0);
    fireEvent.change(screen.getByPlaceholderText('Etiqueta'), { target: { value: 'Cam patio' } });
    fireEvent.change(screen.getByPlaceholderText('rtsp://usuario:clave@ip:554/stream'), { target: { value: 'rtsp://u:p@h/1' } });
    const tipo = screen.getAllByRole('textbox', { hidden: true }).find((e) => e.value === 'Portero' && !e.closest('label'));
    await elegirEn(tipo, 'Cámara');
    fireEvent.click(agregar);
    await waitFor(() => expect(f.de('POST', '/clients/1/devices').length).toBe(1));
    expect(f.de('POST', '/clients/1/devices')[0].cuerpo).toEqual({ label: 'Cam patio', type: 'camera', rtsp_url: 'rtsp://u:p@h/1' });
    expect(toast).toHaveBeenCalledWith('Dispositivo agregado', 'ok', { description: 'Tarda unos segundos en aparecer el video.' });
    const antes = f.de('GET', '/intercom/streams').length;
    flujos = { streams: [{ src: 'c1_9' }, { src: 'c1_11' }, { src: 'c1_13' }] };
    await act(async () => { vi.advanceTimersByTime(1600); });
    await waitFor(() => expect(f.de('GET', '/intercom/streams').length).toBe(antes + 1));
    // La recarga entiende la misma forma que la carga inicial ({streams}): la pared no queda en negro.
    await waitFor(() => expect(screen.getByTestId('pared').textContent).toBe('c1_9,c1_11,c1_13'));
  });

  it('sacar un portero pide confirmación y avisa', async () => {
    const f = await montar(api({ 'DELETE /devices/11': {} }));
    solapa('Dispositivos');
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const tacho = () => boton('trash', 3);
    fireEvent.click(tacho());
    expect(f.de('DELETE', '/devices/11').length).toBe(0);
    fireEvent.click(tacho());
    await waitFor(() => expect(f.de('DELETE', '/devices/11').length).toBe(1));
    expect(toast).toHaveBeenCalledWith('Dispositivo eliminado', 'info');
  });

  it('editar un portero HTTP: la clave no se precarga, URL vacía = no tocarla, y se manda todo lo del portero', async () => {
    const f = await montar(api({ 'PUT /devices/9': { id: 9 } }));
    solapa('Dispositivos');
    fireEvent.click(boton('pencil', 0));
    const nuevaUrl = screen.getByLabelText(/Nueva URL RTSP/);
    expect(nuevaUrl.value).toBe('');
    expect(nuevaUrl.getAttribute('placeholder')).toBe('rtsp://***@10.0.0.5/1');
    expect(screen.getByText('Dejalo vacío para conservar la que ya está cargada')).toBeTruthy();
    const clave = screen.getByLabelText(/Clave/);
    expect(clave.value).toBe('');
    expect(clave.getAttribute('type')).toBe('password');
    expect(screen.getByText('Hay una guardada')).toBeTruthy();
    expect(screen.getByText(/abre <b>sin llamada<\/b>|sin llamada/)).toBeTruthy();
    // El interno sólo acepta dígitos, * y #; cambiarlo avisa.
    fireEvent.change(screen.getByLabelText(/Interno/), { target: { value: '50a0*2' } });
    expect(screen.getByLabelText(/Interno/).value).toBe('500*2');
    expect(screen.getByText(/Cambiar el interno vale/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Dirección/), { target: { value: '10.0.0.7' } });
    fireEvent.change(screen.getByLabelText(/^Usuario/), { target: { value: 'op' } });
    fireEvent.change(clave, { target: { value: 's3creta' } });
    await elegirEn(screen.getAllByLabelText(/Marca/).find((e) => e.tagName === 'INPUT'), 'Hikvision');
    // Relés: renombrar, cambiar número (basura = 1), agregar y sacar.
    const nombres = screen.getAllByPlaceholderText('Nombre (Puerta, Portón…)');
    fireEvent.change(nombres[1], { target: { value: 'Portón' } });
    fireEvent.change(screen.getAllByPlaceholderText('Nº relé')[1], { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Agregar relé'));
    expect(screen.getAllByPlaceholderText('Nº relé')[2].value).toBe('3');
    fireEvent.click(boton('trash', 0, screen.getByText('Agregar relé').closest('.mantine-Card-root')));
    fireEvent.change(screen.getByLabelText('Etiqueta'), { target: { value: 'Portero calle 2' } });
    fireEvent.click(screen.getByLabelText('Habilitado'));
    fireEvent.change(nuevaUrl, { target: { value: 'rtsp://n:c@10.0.0.5/2' } });
    fireEvent.click(screen.getAllByText('Guardar').find((b) => b.closest('.mantine-Card-root')));
    await waitFor(() => expect(f.de('PUT', '/devices/9').length).toBe(1));
    expect(f.de('PUT', '/devices/9')[0].cuerpo).toEqual({
      label: 'Portero calle 2', type: 'intercom', enabled: false, rtsp_url: 'rtsp://n:c@10.0.0.5/2',
      ext: '500*2', rele_modo: 'http',
      rele_cfg: { marca: 'hikvision', host: '10.0.0.7', user: 'op', pass_set: true, pass: 's3creta', reles: [{ nombre: 'Portón', num: 1 }, { nombre: 'Puerta', num: 3 }] },
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Dispositivo guardado', 'ok'));
    await waitFor(() => expect(screen.queryByLabelText(/Nueva URL RTSP/)).toBeNull());
  });

  it('editar un portero DTMF: código por relé, cambiar a código de dialplan y quitar la apertura', async () => {
    const f = await montar(api({ 'PUT /devices/10': estado(500) }));
    solapa('Dispositivos');
    fireEvent.click(boton('pencil', 1));
    expect(screen.getByText('Todavía no tiene URL cargada')).toBeTruthy();
    expect(screen.getByText(/estando en la llamada/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Tono (ej. #)'), { target: { value: '*' } });
    fireEvent.click(screen.getByText('Agregar relé'));
    expect(screen.getAllByPlaceholderText('Tono (ej. #)')[1].value).toBe('');
    const modo = screen.getAllByLabelText(/Cómo abre/).find((e) => e.tagName === 'INPUT');
    await elegirEn(modo, 'Código de función del dialplan');
    expect(screen.getByText(/la lógica de la puerta queda en el dialplan/)).toBeTruthy();
    expect(screen.getAllByPlaceholderText('Código (ej. *71)').length).toBe(2);
    // Sacar todos los relés: avisa que el botón de abrir no va a aparecer.
    fireEvent.click(boton('trash', 0, screen.getByText('Agregar relé').closest('.mantine-Card-root')));
    fireEvent.click(boton('trash', 0, screen.getByText('Agregar relé').closest('.mantine-Card-root')));
    expect(screen.getByText(/Sin relés: el botón de abrir no va a aparecer/)).toBeTruthy();
    fireEvent.click(screen.getAllByText('Guardar').find((b) => b.closest('.mantine-Card-root')));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('No se pudo guardar el dispositivo', 'bad'));
    expect(f.de('PUT', '/devices/10')[0].cuerpo).toMatchObject({ rtsp_url: '', ext: '', rele_modo: 'codigo', rele_cfg: { reles: [] } });
    // El formulario sigue abierto para corregir. Quitar el modo esconde los relés.
    fireEvent.click(modo.parentElement.querySelector('button'));
    await waitFor(() => expect(screen.queryByText('Agregar relé')).toBeNull());
    fireEvent.click(screen.getByText('Cancelar'));
    expect(screen.queryByLabelText(/Nueva URL RTSP/)).toBeNull();
  });

  it('editar una cámara no manda nada de portero; pasarla a portero muestra sus campos; sin etiqueta no guarda', async () => {
    const f = await montar(api({ 'PUT /devices/11': { id: 11 }, 'PUT /devices/12': { id: 12 } }));
    solapa('Dispositivos');
    fireEvent.click(boton('pencil', 2));
    expect(screen.queryByText('Portero', { selector: 'p' })).toBeNull();
    expect(screen.getByLabelText('Habilitado').checked).toBe(false);
    fireEvent.click(screen.getAllByText('Guardar').find((b) => b.closest('.mantine-Card-root')));
    await waitFor(() => expect(f.de('PUT', '/devices/11').length).toBe(1));
    expect(f.de('PUT', '/devices/11')[0].cuerpo).toEqual({ label: 'Cochera', type: 'camera', enabled: false, rtsp_url: '' });
    // Portero sin cfg: arranca con akuvox y sin relés; vaciar la etiqueta no deja guardar.
    await waitFor(() => expect(screen.queryByLabelText(/Nueva URL RTSP/)).toBeNull());
    fireEvent.click(boton('pencil', 3));
    fireEvent.change(screen.getByLabelText('Etiqueta'), { target: { value: '' } });
    fireEvent.click(screen.getAllByText('Guardar').find((b) => b.closest('.mantine-Card-root')));
    expect(f.de('PUT', '/devices/12').length).toBe(0);
    fireEvent.change(screen.getByLabelText('Etiqueta'), { target: { value: 'P' } });
    const modo = screen.getAllByLabelText(/Cómo abre/).find((e) => e.tagName === 'INPUT');
    await elegirEn(modo, 'HTTP al portero (Akuvox / Hikvision)');
    expect(screen.getByText('Todavía no tiene')).toBeTruthy();
    fireEvent.click(screen.getByText('Agregar relé'));
    expect(screen.getAllByPlaceholderText('Nº relé')[0].value).toBe('1');
    fireEvent.click(screen.getAllByText('Guardar').find((b) => b.closest('.mantine-Card-root')));
    await waitFor(() => expect(f.de('PUT', '/devices/12').length).toBe(1));
    expect(f.de('PUT', '/devices/12')[0].cuerpo.rele_cfg).toEqual({ marca: 'akuvox', reles: [{ nombre: 'Puerta', num: 1 }] });
  });

  it('cambiar el tipo en edición: de portero a cámara saca los campos del portero', async () => {
    const f = await montar(api({ 'PUT /devices/9': { id: 9 } }));
    solapa('Dispositivos');
    fireEvent.click(boton('pencil', 0));
    const tipo = screen.getAllByLabelText('Tipo').find((e) => e.tagName === 'INPUT');
    await elegirEn(tipo, 'Cámara');
    expect(screen.queryByLabelText(/Interno/)).toBeNull();
    fireEvent.click(screen.getAllByText('Guardar').find((b) => b.closest('.mantine-Card-root')));
    await waitFor(() => expect(f.de('PUT', '/devices/9').length).toBe(1));
    expect(f.de('PUT', '/devices/9')[0].cuerpo).toEqual({ label: 'Portero calle', type: 'camera', enabled: true, rtsp_url: '' });
  });
});

describe('Ficha · historial e intervenciones', () => {
  it('cada llamada con su resultado y la grabación que le corresponde, que se abre y se cierra', async () => {
    await montar();
    solapa('Historial');
    expect(screen.getByText('1m 15s')).toBeTruthy();
    expect(screen.getAllByText('0s').length).toBe(2);
    expect(screen.getByText('Atendida')).toBeTruthy();
    expect(screen.getAllByText('Sin respuesta').length).toBe(2);
    // Sólo la primera tiene grabación (misma extensión, dentro de la ventana).
    expect(screen.getAllByText('Escuchar').length).toBe(1);
    fireEvent.click(screen.getByText('Escuchar'));
    expect(screen.getByTestId('player').textContent).toBe('/backend/api/recordings/r1/audio|099111  →  600');
    fireEvent.click(screen.getByText('Cerrar'));
    expect(screen.queryByTestId('player')).toBeNull();
  });

  it('las intervenciones muestran motivo, resultado, satisfacción y el resto de las respuestas', async () => {
    await montar();
    solapa('Intervenciones');
    expect(screen.getByText('Corte de luz')).toBeTruthy();
    expect(screen.getByText('Resuelto')).toBeTruthy();
    expect(screen.getByText('Pendiente')).toBeTruthy();
    expect(screen.getAllByText('Intervención').length).toBe(2);
    expect(screen.getByText(/099111/, { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Comentario:')).toBeTruthy();
    expect(screen.queryByText('Motivo:')).toBeNull();
    expect(document.querySelector('.mantine-Rating-root')).toBeTruthy();
  });
});

describe('Ficha · mapa', () => {
  it('sin coordenadas permite ubicar; si la API no encuentra la dirección lo explica', async () => {
    const f = await montar(api({ 'POST /clients/1/geocode': estado(404) }));
    solapa('Mapa');
    expect(screen.getByText('Todavía no ubicamos este cliente en el mapa.')).toBeTruthy();
    fireEvent.click(screen.getByText('Ubicar en el mapa'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('No se pudo ubicar la dirección', 'bad', expect.any(Object)));
    expect(f.de('POST', '/clients/1/geocode').length).toBe(1);
  });

  it('ubicar con éxito recarga la ficha y dibuja el mapa con Leaflet de la central', async () => {
    let ficha = FICHA;
    let proxima = { ...FICHA, lat: -34.9, lon: -56.1 };
    const f = await montar(api({
      'GET /clients/1': () => ficha,
      'POST /clients/1/geocode': () => { ficha = proxima; return { lat: ficha.lat, lon: ficha.lon, display: 'Rambla 1234, Montevideo' }; },
    }));
    solapa('Mapa');
    fireEvent.click(screen.getByText('Ubicar en el mapa'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Ubicación encontrada', 'ok', { description: 'Rambla 1234, Montevideo' }));
    expect(await screen.findByText('Volver a ubicar')).toBeTruthy();
    const js = document.querySelector('script[src="/vendor/leaflet/leaflet.js"]');
    expect(js).toBeTruthy();
    expect(document.querySelector('link[href="/vendor/leaflet/leaflet.css"]')).toBeTruthy();
    const mapa = { setView: vi.fn(() => mapa), invalidateSize: vi.fn() };
    const marcador = { addTo: () => marcador, bindPopup: () => marcador, openPopup: vi.fn() };
    window.L = {
      map: vi.fn(() => mapa),
      tileLayer: vi.fn(() => ({ addTo: () => {} })),
      marker: vi.fn(() => marcador),
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => { js.onload(); });
    await waitFor(() => expect(window.L.map).toHaveBeenCalled());
    expect(mapa.setView).toHaveBeenCalledWith([-34.9, -56.1], 16);
    expect(window.L.marker).toHaveBeenCalledWith([-34.9, -56.1]);
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(mapa.invalidateSize).toHaveBeenCalled();
    // Volver a ubicar mueve el mismo mapa en vez de crear otro.
    f.llamadas.length = 0;
    proxima = { ...FICHA, lat: -34.8, lon: -56.0, name: '' };
    fireEvent.click(screen.getByText('Volver a ubicar'));
    await waitFor(() => expect(mapa.setView).toHaveBeenCalledWith([-34.8, -56.0], 16));
    expect(window.L.map).toHaveBeenCalledTimes(1);
    delete window.L;
  });
});
