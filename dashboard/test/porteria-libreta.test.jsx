/* Libreta de clientes en cajón (app/ClientesLibreta.jsx).
 *
 * OJO: hoy ningún archivo del panel la importa (la reemplazaron /clientes y la ficha
 * /clientes/[id]); queda informada como código muerto. Mientras exista, se fija que haga lo
 * que promete: ABM de cliente, personas, espacios y dispositivos contra la API correcta,
 * borrar sólo con confirmación, la URL RTSP que se lista es la que viene enmascarada de la
 * API, y el editor de encuesta manda la lista entera.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderP, rutasFalsas, estado } from './helpers/porteria-render';

const toast = vi.fn();
vi.mock('../app/notify', () => ({ toast: (...a) => toast(...a) }));
import ClientesLibreta from '../app/ClientesLibreta';

const LISTA = [
  { id: 1, name: 'Edificio Rambla', phones: ['099111'], persons: 2, spaces: 1, devices: 1 },
  { id: 2, name: 'Casa López', persons: 0, spaces: 0, devices: 0 },
  { id: 3 },
];
const FICHA = {
  id: 1, name: 'Edificio Rambla', doc: '21', address: 'Rambla 1', phones: ['099111', '2900'], notes: 'n',
  persons: [{ id: 7, name: 'Ana', relation: 'portera', doc: '123', valid_until: '2027-01-01' }, { id: 8, name: 'Beto' }],
  spaces: [{ id: 4, name: 'Apto 101', kind: 'depto' }, { id: 5, name: 'Cochera' }],
  devices: [{ id: 9, label: 'Portero', type: 'intercom', rtsp_url: 'rtsp://***@10.0.0.5/1', go2rtc_src: 'c1_9' }, { id: 6, label: 'Cam', type: 'camera', go2rtc_src: 'c1_6' }],
};

function api(extra = {}) {
  return rutasFalsas({
    'GET /clients': LISTA, 'GET /survey/fields': [{ id: 1, label: 'Motivo', ftype: 'select', options: ['A'], required: false }],
    'GET /clients/1': FICHA, ...extra,
  });
}

beforeEach(() => { toast.mockReset(); });

async function abrirFicha(f) {
  vi.stubGlobal('fetch', f);
  renderP(<ClientesLibreta opened onClose={() => {}} />);
  fireEvent.click(await screen.findByText('Edificio Rambla'));
  await screen.findByDisplayValue('Rambla 1');
}

describe('ClientesLibreta', () => {
  it('cerrada no pide nada; abierta lista y filtra por nombre o teléfono', async () => {
    const f = api();
    vi.stubGlobal('fetch', f);
    const { rerender } = renderP(<ClientesLibreta opened={false} onClose={() => {}} />);
    expect(f.llamadas.length).toBe(0);
    rerender(<ClientesLibreta opened onClose={() => {}} />);
    expect(await screen.findByText('Edificio Rambla')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Buscar cliente…'), { target: { value: '099' } });
    expect(screen.queryByText('Casa López')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Buscar cliente…'), { target: { value: 'nada' } });
    expect(screen.getByText(/Sin clientes/)).toBeTruthy();
  });

  it('respuestas rotas dejan la libreta vacía', async () => {
    const f = rutasFalsas({ 'GET /clients': estado(500), 'GET /survey/fields': estado(500) });
    vi.stubGlobal('fetch', f);
    renderP(<ClientesLibreta opened onClose={() => {}} />);
    await waitFor(() => expect(f.llamadas.length).toBe(2));
    expect(screen.getByText(/Sin clientes/)).toBeTruthy();
  });

  it('abre la ficha, la edita y la guarda con los teléfonos como texto', async () => {
    const f = api({ 'PUT /clients/1': { id: 1 } });
    await abrirFicha(f);
    expect(screen.getByDisplayValue('099111, 2900')).toBeTruthy();
    expect(screen.getByText('rtsp://***@10.0.0.5/1 · src: c1_9')).toBeTruthy();
    expect(screen.getByText('sin URL · src: c1_6')).toBeTruthy();
    expect(screen.getByText(/portera · 123 · vence 2027-01-01/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Rambla SA' } });
    fireEvent.change(screen.getByLabelText('Documento'), { target: { value: '22' } });
    fireEvent.change(screen.getByLabelText(/Teléfonos/), { target: { value: '1, 2' } });
    fireEvent.change(screen.getByLabelText('Dirección'), { target: { value: 'Otra 2' } });
    fireEvent.change(screen.getByLabelText('Notas'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Guardado', 'ok'));
    expect(f.de('PUT', '/clients/1')[0].cuerpo).toEqual({ name: 'Rambla SA', doc: '22', address: 'Otra 2', phones: '1, 2', notes: 'x' });
  });

  it('un cliente que no se pudo traer no abre ficha; uno sin datos abre con campos vacíos', async () => {
    const f = rutasFalsas({ 'GET /clients': LISTA, 'GET /survey/fields': [], 'GET /clients/2': estado(404), 'GET /clients/3': { id: 3 }, 'PUT /clients/3': estado(500) });
    vi.stubGlobal('fetch', f);
    renderP(<ClientesLibreta opened onClose={() => {}} />);
    fireEvent.click(await screen.findByText('Casa López'));
    await waitFor(() => expect(f.de('GET', '/clients/2').length).toBe(1));
    expect(screen.queryByText('Guardar')).toBeNull();
    fireEvent.click(document.querySelectorAll('.mantine-Card-root')[2]);
    expect(await screen.findByText('Personas autorizadas (0)')).toBeTruthy();
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(f.de('PUT', '/clients/3').length).toBe(1));
    expect(toast).not.toHaveBeenCalled();
  });

  it('crea un cliente nuevo y lo abre', async () => {
    const f = api({ 'POST /clients': { id: 1 } });
    vi.stubGlobal('fetch', f);
    renderP(<ClientesLibreta opened onClose={() => {}} />);
    await screen.findByText('Edificio Rambla');
    fireEvent.click(document.querySelector('.tabler-icon-plus').closest('button'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Cliente creado', 'ok'));
    expect(f.de('POST', '/clients')[0].cuerpo).toEqual({ name: 'Nuevo cliente' });
    expect(await screen.findByDisplayValue('Rambla 1')).toBeTruthy();
  });

  it('si crear falla, no avisa nada falso', async () => {
    const f = api({ 'POST /clients': estado(500) });
    vi.stubGlobal('fetch', f);
    renderP(<ClientesLibreta opened onClose={() => {}} />);
    await screen.findByText('Edificio Rambla');
    fireEvent.click(document.querySelector('.tabler-icon-plus').closest('button'));
    await waitFor(() => expect(f.de('POST', '/clients').length).toBe(1));
    expect(toast).not.toHaveBeenCalled();
  });

  it('borrar el cliente pide confirmación', async () => {
    const f = api({ 'DELETE /clients/1': {} });
    await abrirFicha(f);
    const conf = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const tacho = () => screen.getByText('Guardar').closest('.mantine-Group-root').parentElement.querySelector('.tabler-icon-trash').closest('button');
    fireEvent.click(tacho());
    expect(f.de('DELETE', '/clients/1').length).toBe(0);
    fireEvent.click(tacho());
    await waitFor(() => expect(f.de('DELETE', '/clients/1').length).toBe(1));
    expect(conf).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Eliminado', 'ok'));
  });

  it('agrega y saca personas, espacios y dispositivos (sin nombre no manda nada)', async () => {
    const f = api({
      'POST /clients/1/persons': {}, 'DELETE /persons/7': {},
      'POST /clients/1/spaces': {}, 'DELETE /spaces/4': {},
      'POST /clients/1/devices': {}, 'DELETE /devices/9': {},
    });
    await abrirFicha(f);
    const agregar = screen.getAllByText('Agregar');
    // Vacíos: nada viaja.
    agregar.forEach((b) => fireEvent.click(b));
    expect(f.llamadas.filter((l) => l.metodo === 'POST').length).toBe(0);

    fireEvent.change(screen.getAllByPlaceholderText('Nombre')[0], { target: { value: 'Carla' } });
    fireEvent.change(screen.getByPlaceholderText('Vínculo'), { target: { value: 'hija' } });
    fireEvent.change(screen.getAllByPlaceholderText('Documento')[0], { target: { value: '9' } });
    fireEvent.click(agregar[0]);
    await waitFor(() => expect(f.de('POST', '/clients/1/persons').length).toBe(1));
    expect(f.de('POST', '/clients/1/persons')[0].cuerpo).toEqual({ name: 'Carla', doc: '9', relation: 'hija', valid_until: '' });

    fireEvent.change(screen.getByPlaceholderText('Nombre / unidad'), { target: { value: 'Apto 2' } });
    fireEvent.change(screen.getByPlaceholderText('Tipo'), { target: { value: 'depto' } });
    fireEvent.click(agregar[1]);
    await waitFor(() => expect(f.de('POST', '/clients/1/spaces').length).toBe(1));
    expect(f.de('POST', '/clients/1/spaces')[0].cuerpo).toEqual({ name: 'Apto 2', kind: 'depto' });

    fireEvent.change(screen.getByPlaceholderText('Etiqueta'), { target: { value: 'Portón' } });
    fireEvent.change(screen.getByPlaceholderText('rtsp://usuario:pass@ip:554/stream'), { target: { value: 'rtsp://u:p@h/1' } });
    const tipo = screen.getAllByRole('textbox', { hidden: true }).find((e) => e.value === 'Cámara');
    fireEvent.click(tipo);
    await waitFor(() => expect(document.getElementById(tipo.getAttribute('aria-controls'))).toBeTruthy());
    fireEvent.click(within(document.getElementById(tipo.getAttribute('aria-controls'))).getByRole('option', { name: 'Intercom', hidden: true }));
    fireEvent.click(agregar[2]);
    await waitFor(() => expect(f.de('POST', '/clients/1/devices').length).toBe(1));
    expect(f.de('POST', '/clients/1/devices')[0].cuerpo).toEqual({ label: 'Portón', type: 'intercom', rtsp_url: 'rtsp://u:p@h/1' });

    // Los tachos de cada fila (el primero es el del cliente).
    const tachos = () => Array.from(document.querySelectorAll('.tabler-icon-trash')).map((i) => i.closest('button'));
    fireEvent.click(tachos()[1]);
    await waitFor(() => expect(f.de('DELETE', '/persons/7').length).toBe(1));
    fireEvent.click(tachos()[3]);
    await waitFor(() => expect(f.de('DELETE', '/spaces/4').length).toBe(1));
    fireEvent.click(tachos()[5]);
    await waitFor(() => expect(f.de('DELETE', '/devices/9').length).toBe(1));
  });

  it('el editor de encuesta agrega, edita, borra y guarda la lista entera', async () => {
    const f = api({ 'PUT /survey/fields': { ok: true } });
    vi.stubGlobal('fetch', f);
    renderP(<ClientesLibreta opened onClose={() => {}} />);
    await screen.findByText('Edificio Rambla');
    fireEvent.click(screen.getByText('Encuesta'));
    expect(await screen.findByDisplayValue('Motivo')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Opciones (separadas por coma)'), { target: { value: 'A, B,' } });
    fireEvent.click(screen.getByText('Campo'));
    fireEvent.change(screen.getAllByLabelText('Etiqueta')[1], { target: { value: 'Nota' } });
    const tipos = screen.getAllByLabelText('Tipo').filter((e) => e.tagName === 'INPUT');
    fireEvent.click(tipos[1]);
    await waitFor(() => expect(document.getElementById(tipos[1].getAttribute('aria-controls'))).toBeTruthy());
    fireEvent.click(within(document.getElementById(tipos[1].getAttribute('aria-controls'))).getByRole('option', { name: 'Puntaje 1-5', hidden: true }));
    fireEvent.click(screen.getAllByLabelText('Obligatorio')[1]);
    fireEvent.click(screen.getByText('Campo'));
    fireEvent.click(document.querySelectorAll('.tabler-icon-trash')[2].closest('button'));
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(f.de('PUT', '/survey/fields').length).toBe(1));
    expect(f.de('PUT', '/survey/fields')[0].cuerpo).toEqual([
      { id: 1, label: 'Motivo', ftype: 'select', options: ['A', 'B'], required: false },
      { label: 'Nota', ftype: 'rating', options: [], required: true },
    ]);
    expect(toast).toHaveBeenCalledWith('Encuesta guardada', 'ok');
  });
});
