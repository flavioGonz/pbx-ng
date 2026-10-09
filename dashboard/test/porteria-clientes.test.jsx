/* Libreta de clientes (app/clientes/page.jsx) y Portería · video de clientes
 * (app/intercom/page.jsx).
 *
 * Qué se fija:
 *  - La lista de clientes es la que alimenta el screen-pop del agente: el buscador encuentra
 *    por nombre y por teléfono, los totales suman lo que dice cada fila, y una respuesta
 *    rota de la API deja la tabla vacía con su explicación, no la pantalla caída.
 *  - «Nuevo cliente» crea y lleva a la ficha; la encuesta post-llamada se edita y se manda
 *    entera, y si la API no la guardó lo dice (antes avisaba «guardada» igual).
 *  - En Portería, asociar un portero manda etiqueta, tipo y URL RTSP al cliente correcto,
 *    la URL que se lista es la que viene ENMASCARADA de la API (nunca se arma acá), y la
 *    vista previa sólo abre los flujos del cliente que se está mirando.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderP, rutasFalsas, estado } from './helpers/porteria-render';

const toast = vi.fn();
const push = vi.fn();
vi.mock('../app/notify', () => ({ toast: (...a) => toast(...a) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
/* La pared de video tiene su propia prueba: acá sólo importa QUÉ flujos le llegan. */
vi.mock('../app/Intercom', () => ({
  default: ({ streams, columns, emptyHint }) => (
    <div data-testid="pared" data-cols={columns}>{streams.length ? streams.map((s) => s.src).join(',') : emptyHint}</div>
  ),
}));
import ClientesList from '../app/clientes/page';
import IntercomAdmin from '../app/intercom/page';

const CLIENTES = [
  { id: 1, name: 'Edificio Rambla', doc: 'RUT 21', phones: ['099111222', '29001234'], persons: 3, spaces: 2, devices: 1, intercoms: 1, cameras: 2 },
  { id: 2, name: 'Casa López', phones: [], persons: 0, spaces: 0, devices: 0 },
  { id: 3, name: null, persons: 1 },
];

beforeEach(() => { toast.mockReset(); push.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

/* Elegir en un Select de Mantine: se abre el desplegable de ESE campo (aria-controls) y
 * se toca la opción por su texto. */
async function elegirEn(input, opcion) {
  fireEvent.click(input);
  await waitFor(() => expect(document.getElementById(input.getAttribute('aria-controls'))).toBeTruthy());
  const lista = document.getElementById(input.getAttribute('aria-controls'));
  fireEvent.click(within(lista).getByRole('option', { name: opcion, hidden: true }));
}
const elegir = (label, opcion) => elegirEn(screen.getAllByLabelText(label).find((e) => e.tagName === 'INPUT'), opcion);

describe('Clientes · lista', () => {
  it('muestra cada cliente con sus contadores y los totales de arriba', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /clients': CLIENTES, 'GET /survey/fields': [] }));
    renderP(<ClientesList />);
    expect(await screen.findByText('Edificio Rambla')).toBeTruthy();
    expect(screen.getByText('099111222, 29001234')).toBeTruthy();
    expect(screen.getByText(/RUT 21/)).toBeTruthy();
    expect(screen.getByText('ER')).toBeTruthy();       // iniciales
    expect(screen.getByText('?')).toBeTruthy();        // cliente sin nombre
    const autorizados = screen.getByText('Autorizados', { selector: 'p' }).parentElement;
    expect(within(autorizados).getByText('4')).toBeTruthy();
  });

  it('el buscador filtra por nombre (sin mayúsculas) y por teléfono', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /clients': CLIENTES, 'GET /survey/fields': [] }));
    renderP(<ClientesList />);
    await screen.findByText('Edificio Rambla');
    const q = screen.getByPlaceholderText('Buscar cliente…');
    fireEvent.change(q, { target: { value: 'lópez' } });
    expect(screen.queryByText('Edificio Rambla')).toBeNull();
    expect(screen.getByText('Casa López')).toBeTruthy();
    fireEvent.change(q, { target: { value: '2900' } });
    expect(screen.getByText('Edificio Rambla')).toBeTruthy();
    fireEvent.change(q, { target: { value: 'zzz' } });
    expect(screen.getByText(/No hay clientes/)).toBeTruthy();
  });

  it('una respuesta que no es lista deja la tabla vacía con su explicación', async () => {
    const f = rutasFalsas({ 'GET /clients': estado(403, { error: 'no' }), 'GET /survey/fields': estado(500) });
    vi.stubGlobal('fetch', f);
    renderP(<ClientesList />);
    await waitFor(() => expect(f.llamadas.length).toBe(2));
    expect(screen.getByText(/No hay clientes/)).toBeTruthy();
  });

  it('tocar una fila o la flecha lleva a la ficha; Recargar vuelve a pedir', async () => {
    const f = rutasFalsas({ 'GET /clients': CLIENTES, 'GET /survey/fields': [] });
    vi.stubGlobal('fetch', f);
    renderP(<ClientesList />);
    fireEvent.click(await screen.findByText('Casa López'));
    expect(push).toHaveBeenCalledWith('/clientes/2');
    fireEvent.click(document.querySelectorAll('.tabler-icon-chevron-right')[0].closest('button'));
    expect(push).toHaveBeenLastCalledWith('/clientes/1');
    expect(push).toHaveBeenCalledTimes(2);   // la flecha no dispara además la fila
    fireEvent.click(document.querySelector('.tabler-icon-refresh').closest('button'));
    await waitFor(() => expect(f.de('GET', '/clients').length).toBe(2));
  });

  it('Nuevo cliente lo crea y abre su ficha; si la API falla, no navega', async () => {
    let falla = false;
    const f = rutasFalsas({ 'GET /clients': [], 'GET /survey/fields': [], 'POST /clients': () => (falla ? estado(500) : { id: 42 }) });
    vi.stubGlobal('fetch', f);
    renderP(<ClientesList />);
    fireEvent.click(screen.getByText('Nuevo cliente'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/clientes/42'));
    expect(f.de('POST', '/clients')[0].cuerpo).toEqual({ name: 'Nuevo cliente' });
    falla = true;
    fireEvent.click(screen.getByText('Nuevo cliente'));
    await waitFor(() => expect(f.de('POST', '/clients').length).toBe(2));
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('Clientes · encuesta post-llamada', () => {
  it('agrega, edita, convierte en lista y borra campos, y guarda la lista entera', async () => {
    const f = rutasFalsas({
      'GET /clients': [], 'GET /survey/fields': [{ id: 5, label: 'Motivo', ftype: 'text', options: [], required: true }],
      'PUT /survey/fields': { ok: true },
    });
    vi.stubGlobal('fetch', f);
    renderP(<ClientesList />);
    fireEvent.click(screen.getByText('Encuesta post-llamada'));
    expect(await screen.findByDisplayValue('Motivo')).toBeTruthy();
    fireEvent.click(screen.getByText('Campo'));
    const etiquetas = screen.getAllByLabelText('Etiqueta');
    expect(etiquetas.length).toBe(2);
    fireEvent.change(etiquetas[1], { target: { value: 'Resultado' } });
    // Pasarlo a lista muestra el campo de opciones, que se separa por coma y se limpia.
    const tipos = screen.getAllByLabelText('Tipo').filter((e) => e.tagName === 'INPUT');
    await elegirEn(tipos[1], 'Lista');
    fireEvent.change(await screen.findByLabelText('Opciones (coma)'), { target: { value: 'Resuelto, , Pendiente ' } });
    fireEvent.click(screen.getAllByLabelText('Obligatorio')[1]);
    // Borrar el primero.
    fireEvent.click(document.querySelectorAll('.tabler-icon-trash')[0].closest('button'));
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(f.de('PUT', '/survey/fields').length).toBe(1));
    expect(f.de('PUT', '/survey/fields')[0].cuerpo).toEqual([
      { label: 'Resultado', ftype: 'select', options: ['Resuelto', 'Pendiente'], required: true },
    ]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Encuesta guardada', 'ok'));
  });

  it('si la API no guarda la encuesta, lo dice en vez de festejar', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /clients': [], 'GET /survey/fields': [], 'PUT /survey/fields': estado(500) }));
    renderP(<ClientesList />);
    fireEvent.click(screen.getByText('Encuesta post-llamada'));
    fireEvent.click(await screen.findByText('Guardar'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('No se pudo guardar la encuesta', 'bad'));
    expect(toast).not.toHaveBeenCalledWith('Encuesta guardada', 'ok');
  });
});

describe('Portería · video de clientes', () => {
  const DETALLE = {
    id: 1, name: 'Edificio Rambla',
    devices: [
      { id: 10, label: 'Portero calle', type: 'intercom', rtsp_url: 'rtsp://***@10.0.0.5/1' },
      { id: 11, label: 'Cochera', type: 'camera', rtsp_url: '' },
    ],
  };

  it('muestra totales de porteros y cámaras, y filtra por nombre o teléfono', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /clients': CLIENTES }));
    renderP(<IntercomAdmin />);
    expect(await screen.findByText('Edificio Rambla')).toBeTruthy();
    const porteros = screen.getByText('Porteros', { selector: 'p' }).parentElement;
    expect(within(porteros).getByText('1')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Buscar cliente…'), { target: { value: '099' } });
    expect(screen.queryByText('Casa López')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Buscar cliente…'), { target: { value: 'nadie' } });
    expect(screen.getByText(/No hay clientes/)).toBeTruthy();
  });

  it('una lista rota no rompe la pantalla; Recargar vuelve a pedir', async () => {
    const f = rutasFalsas({ 'GET /clients': estado(500) });
    vi.stubGlobal('fetch', f);
    renderP(<IntercomAdmin />);
    await waitFor(() => expect(f.llamadas.length).toBe(1));
    expect(screen.getByText(/No hay clientes/)).toBeTruthy();
    fireEvent.click(document.querySelector('.tabler-icon-refresh').closest('button'));
    await waitFor(() => expect(f.llamadas.length).toBe(2));
  });

  it('Gestionar abre el cajón con los dispositivos enmascarados y sólo los flujos de ese cliente', async () => {
    const f = rutasFalsas({
      'GET /clients': CLIENTES, 'GET /clients/1': DETALLE,
      'GET /intercom/streams': [{ id: 10, src: 'cli1_portero' }, { id: 11, src: 'cli1_cochera' }],
    });
    vi.stubGlobal('fetch', f);
    renderP(<IntercomAdmin />);
    fireEvent.click((await screen.findAllByText('Gestionar'))[0]);
    expect(await screen.findByText('Portero calle')).toBeTruthy();
    expect(screen.getByText('rtsp://***@10.0.0.5/1')).toBeTruthy();
    expect(screen.getByText('sin URL RTSP')).toBeTruthy();
    expect(screen.getByText('Asociados (2)')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('pared').textContent).toBe('cli1_portero,cli1_cochera'));
    expect(f.de('GET', '/intercom/streams')[0].ruta).toBe('/intercom/streams?client=1');
    expect(screen.getByText('2 flujo(s) activos')).toBeTruthy();
    // Columnas de la vista previa.
    expect(screen.getByTestId('pared').getAttribute('data-cols')).toBe('2');
    fireEvent.click(screen.getByRole('radio', { name: '1' }));
    expect(screen.getByTestId('pared').getAttribute('data-cols')).toBe('1');
    // Actualizar vuelve a pedir los flujos.
    fireEvent.click(screen.getByText('Actualizar'));
    await waitFor(() => expect(f.de('GET', '/intercom/streams').length).toBe(2));
  });

  it('un cliente sin dispositivos invita a asociar uno; flujos que no son lista se ignoran', async () => {
    vi.stubGlobal('fetch', rutasFalsas({
      'GET /clients': CLIENTES, 'GET /clients/2': { id: 2, name: 'Casa López' }, 'GET /intercom/streams': { error: 'x' },
    }));
    renderP(<IntercomAdmin />);
    fireEvent.click(await screen.findByText('Casa López'));
    expect(await screen.findByText(/Sin dispositivos/)).toBeTruthy();
    expect(screen.getByText(/Sin flujos/)).toBeTruthy();
  });

  it('asociar manda el portero al cliente, limpia el formulario y refresca la vista previa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = rutasFalsas({
      'GET /clients': CLIENTES, 'GET /clients/1': DETALLE, 'GET /intercom/streams': [],
      'POST /clients/1/devices': { id: 12 },
    });
    vi.stubGlobal('fetch', f);
    renderP(<IntercomAdmin />);
    fireEvent.click((await screen.findAllByText('Gestionar'))[0]);
    await screen.findByText('Portero calle');
    // Sin etiqueta no se manda nada.
    fireEvent.click(screen.getByText('Asociar'));
    expect(f.de('POST', '/clients/1/devices').length).toBe(0);
    fireEvent.change(screen.getByLabelText('Etiqueta'), { target: { value: 'Cam patio' } });
    await elegir('Tipo', 'Cámara');
    fireEvent.change(screen.getByLabelText('URL RTSP'), { target: { value: 'rtsp://u:p@10.0.0.9/2' } });
    fireEvent.click(screen.getByText('Asociar'));
    await waitFor(() => expect(f.de('POST', '/clients/1/devices').length).toBe(1));
    expect(f.de('POST', '/clients/1/devices')[0].cuerpo).toEqual({ label: 'Cam patio', type: 'camera', rtsp_url: 'rtsp://u:p@10.0.0.9/2' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Dispositivo asociado', 'ok'));
    expect(screen.getByLabelText('Etiqueta').value).toBe('');
    // go2rtc tarda en levantar el flujo nuevo: se refresca la vista previa un rato después.
    const antes = f.de('GET', '/intercom/streams').length;
    await act(async () => { vi.advanceTimersByTime(1300); });
    await waitFor(() => expect(f.de('GET', '/intercom/streams').length).toBe(antes + 1));
  });

  it('sacar un dispositivo manda DELETE y recarga el detalle', async () => {
    const f = rutasFalsas({
      'GET /clients': CLIENTES, 'GET /clients/1': DETALLE, 'GET /intercom/streams': [], 'DELETE /devices/11': {},
    });
    vi.stubGlobal('fetch', f);
    renderP(<IntercomAdmin />);
    fireEvent.click((await screen.findAllByText('Gestionar'))[0]);
    await screen.findByText('Cochera');
    fireEvent.click(document.querySelectorAll('.tabler-icon-trash')[1].closest('button'));
    await waitFor(() => expect(f.de('DELETE', '/devices/11').length).toBe(1));
    await waitFor(() => expect(f.de('GET', '/clients/1').length).toBe(2));
  });

  it('cerrar el cajón lo saca de la vista', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /clients': CLIENTES, 'GET /clients/1': DETALLE, 'GET /intercom/streams': [] }));
    renderP(<IntercomAdmin />);
    fireEvent.click((await screen.findAllByText('Gestionar'))[0]);
    await screen.findByText('Portero calle');
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Asociar dispositivo')).toBeNull());
  });
});
