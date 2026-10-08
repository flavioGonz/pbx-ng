/* Click-to-Call público (app/click-to-call/page.jsx).
 *
 * Qué se fija: el ABM de enlaces manda a la API lo que el operador cargó (POST al crear,
 * PUT al editar, DELETE sólo después de confirmar), no deja guardar sin nombre ni destino,
 * el QR apunta a la URL pública /call/<token> del propio equipo, y una respuesta que no es
 * una lista (un 403 o un 500 con {error}) deja la pantalla vacía en vez de romperla: era
 * una pantalla en blanco para el supervisor que entraba sin permiso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderP, rutasFalsas, estado } from './helpers/porteria-render';

const toast = vi.fn();
vi.mock('../app/notify', () => ({ toast: (...a) => toast(...a) }));
import Click2Call from '../app/click-to-call/page';

const ENLACES = [
  { id: 1, name: 'Ventas', dest_type: 'queue', dest_value: '600', enabled: true, token: 'tok1', intro: 'Hola' },
  { id: 2, name: 'Raro', dest_type: 'otro', dest_value: '9', enabled: false, token: 'tok2' },
];

beforeEach(() => { toast.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('Click-to-Call · listado', () => {
  it('lista los enlaces con destino, estado y URL pública', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /c2c': ENLACES }));
    renderP(<Click2Call />);
    expect(await screen.findByText('Ventas')).toBeTruthy();
    expect(screen.getByText('Cola 600')).toBeTruthy();
    expect(screen.getByText('otro 9')).toBeTruthy();       // tipo desconocido: se muestra crudo
    expect(screen.getByText('Activo')).toBeTruthy();
    expect(screen.getByText('Inactivo')).toBeTruthy();
    expect(screen.getByText('/call/tok1')).toBeTruthy();
  });

  it('sin enlaces muestra cómo crear uno', async () => {
    const f = rutasFalsas({ 'GET /c2c': [] });
    vi.stubGlobal('fetch', f);
    renderP(<Click2Call />);
    await waitFor(() => expect(f.llamadas.length).toBe(1));
    expect(screen.getByText(/Sin enlaces/)).toBeTruthy();
  });

  it('una respuesta que no es lista (403 con {error}) no rompe la pantalla', async () => {
    const f = rutasFalsas({ 'GET /c2c': estado(403, { error: 'No tenés permiso' }) });
    vi.stubGlobal('fetch', f);
    renderP(<Click2Call />);
    await waitFor(() => expect(f.llamadas.length).toBe(1));
    await act(async () => {});
    expect(screen.getByText(/Sin enlaces/)).toBeTruthy();
  });

  it('una caída de red tampoco', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('red'))));
    renderP(<Click2Call />);
    await act(async () => {});
    expect(screen.getByText(/Sin enlaces/)).toBeTruthy();
  });

  it('recarga cada 30 s sólo con la pestaña visible, y deja de hacerlo al salir', async () => {
    vi.useFakeTimers();
    const f = rutasFalsas({ 'GET /c2c': [] });
    vi.stubGlobal('fetch', f);
    const { unmount } = renderP(<Click2Call />);
    await act(async () => {});
    expect(f.llamadas.length).toBe(1);
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.llamadas.length).toBe(2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.llamadas.length).toBe(2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    unmount();
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(f.llamadas.length).toBe(2);
  });
});

describe('Click-to-Call · alta, edición y baja', () => {
  it('no deja crear sin nombre ni destino', async () => {
    const f = rutasFalsas({ 'GET /c2c': [] });
    vi.stubGlobal('fetch', f);
    renderP(<Click2Call />);
    fireEvent.click(screen.getByText('Nuevo enlace'));
    fireEvent.click(await screen.findByText('Crear enlace'));
    expect(toast).toHaveBeenCalledWith('Nombre y destino son obligatorios', 'bad');
    expect(f.de('POST', '/c2c').length).toBe(0);
  });

  it('crear manda POST con lo cargado y cierra el cajón', async () => {
    const f = rutasFalsas({ 'GET /c2c': [], 'POST /c2c': { id: 9 } });
    vi.stubGlobal('fetch', f);
    renderP(<Click2Call />);
    fireEvent.click(screen.getByText('Nuevo enlace'));
    fireEvent.change(await screen.findByLabelText(/Nombre del enlace/), { target: { value: 'Soporte' } });
    fireEvent.change(screen.getByLabelText(/^Destino/), { target: { value: '1001' } });
    const tipo = screen.getAllByLabelText('Tipo de destino').find((e) => e.tagName === 'INPUT');
    fireEvent.click(tipo);
    await waitFor(() => expect(document.getElementById(tipo.getAttribute('aria-controls'))).toBeTruthy());
    fireEvent.click(within(document.getElementById(tipo.getAttribute('aria-controls'))).getByRole('option', { name: 'Agente IA', hidden: true }));
    fireEvent.change(screen.getByLabelText('Texto de bienvenida'), { target: { value: 'Te atendemos' } });
    fireEvent.click(screen.getByLabelText('Solicitar geolocalización'));
    fireEvent.click(screen.getByLabelText('Habilitar video'));
    fireEvent.click(screen.getByLabelText('Pedir nombre del cliente'));
    fireEvent.click(screen.getByLabelText('Enlace activo'));
    fireEvent.click(screen.getByText('Crear enlace'));
    await waitFor(() => expect(f.de('POST', '/c2c').length).toBe(1));
    expect(f.de('POST', '/c2c')[0].cuerpo).toMatchObject({
      name: 'Soporte', dest_type: 'ai', dest_value: '1001', intro: 'Te atendemos',
      collect_geo: true, video: true, require_name: false, enabled: false,
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Enlace creado', 'ok'));
  });

  it('un error de la API se muestra y el cajón queda abierto', async () => {
    const f = rutasFalsas({ 'GET /c2c': ENLACES, 'PUT /c2c/1': estado(400, { error: 'destino inválido' }) });
    vi.stubGlobal('fetch', f);
    renderP(<Click2Call />);
    fireEvent.click(await screen.findByText('Ventas'));
    expect(await screen.findByText('Editar enlace')).toBeTruthy();
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Error: destino inválido', 'bad'));
    expect(f.de('PUT', '/c2c/1')[0].cuerpo).toMatchObject({ id: 1, name: 'Ventas', dest_value: '600' });
  });

  it('editar con éxito manda PUT y avisa', async () => {
    const f = rutasFalsas({ 'GET /c2c': ENLACES, 'PUT /c2c/1': { id: 1 } });
    vi.stubGlobal('fetch', f);
    renderP(<Click2Call />);
    await screen.findByText('Ventas');
    fireEvent.click(document.querySelectorAll('.tabler-icon-edit')[0].closest('button'));
    fireEvent.click(await screen.findByText('Guardar'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Enlace actualizado', 'ok'));
  });

  it('si la red se cae al guardar lo dice', async () => {
    const f = rutasFalsas({ 'GET /c2c': ENLACES, 'PUT /c2c/1': new Error('red') });
    vi.stubGlobal('fetch', f);
    renderP(<Click2Call />);
    fireEvent.click(await screen.findByText('Ventas'));
    fireEvent.click(await screen.findByText('Guardar'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Error: red', 'bad'));
  });

  it('Cancelar cierra el cajón sin pedir nada', async () => {
    const f = rutasFalsas({ 'GET /c2c': [] });
    vi.stubGlobal('fetch', f);
    renderP(<Click2Call />);
    fireEvent.click(screen.getByText('Nuevo enlace'));
    fireEvent.click(await screen.findByText('Cancelar'));
    expect(f.llamadas.every((l) => l.metodo === 'GET')).toBe(true);
  });

  it('borrar pide confirmación; sin confirmar no manda nada', async () => {
    const f = rutasFalsas({ 'GET /c2c': ENLACES, 'DELETE /c2c/1': {} });
    vi.stubGlobal('fetch', f);
    const conf = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderP(<Click2Call />);
    await screen.findByText('Ventas');
    const tacho = () => document.querySelectorAll('.tabler-icon-trash')[0].closest('button');
    fireEvent.click(tacho());
    expect(conf).toHaveBeenCalledWith('¿Eliminar el enlace Ventas?');
    expect(f.de('DELETE', '/c2c').length).toBe(0);
    fireEvent.click(tacho());
    await waitFor(() => expect(f.de('DELETE', '/c2c/1').length).toBe(1));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Enlace eliminado', 'info'));
  });
});

describe('Click-to-Call · QR', () => {
  it('el QR y el enlace apuntan a /call/<token> del propio equipo', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /c2c': ENLACES }));
    renderP(<Click2Call />);
    await screen.findByText('Ventas');
    fireEvent.click(document.querySelectorAll('.tabler-icon-qrcode')[0].closest('button'));
    expect(await screen.findByText('QR · Ventas')).toBeTruthy();
    const url = window.location.origin + '/call/tok1';
    expect(screen.getByDisplayValue(url)).toBeTruthy();
    expect(screen.getByText('Abrir página de llamada').closest('a').getAttribute('href')).toBe(url);
  });
});

describe('Click-to-Call · cajones', () => {
  it('el de edición y el del QR se cierran con Escape', async () => {
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /c2c': ENLACES }));
    renderP(<Click2Call />);
    await screen.findByText('Ventas');
    const esc = async (titulo) => {
      expect(await screen.findByText(titulo)).toBeTruthy();
      fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByText(titulo)).toBeNull());
    };
    fireEvent.click(screen.getByText('Nuevo enlace'));
    await esc('Nuevo enlace Click-to-Call');
    fireEvent.click(document.querySelectorAll('.tabler-icon-qrcode')[0].closest('button'));
    await esc('QR · Ventas');
  });
});
