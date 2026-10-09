/* ============================================================================
 *  CrudPanel: la tabla genérica de configuración (rutas entrantes y salientes, y lo
 *  que se arme con ella).
 *
 *  Lo que se fija: que la tabla muestre lo que contesta la API (o el texto de vacío, o
 *  el de «sin resultados» al buscar); que crear mande POST a `createUrl` y editar mande
 *  PUT a `editUrl(fila)` con la fila ya cargada en el cajón; que una API vieja sin PUT
 *  (404/405) se explique como tal y no como un dato mal escrito; que borrar pida
 *  confirmación y avise si falla; y que las solapas (`grupos`) repartan los campos.
 *  Es la pantalla con la que el operador arma el ruteo: si el POST va a otra ruta o el
 *  error se traga, la llamada entra a cualquier lado y nadie se entera.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());

import { apiMock, notifyMock, resetNucleo, errorApi } from './helpers/nucleo-render.jsx';
import { renderTel, escribir } from './helpers/telefonia-render.jsx';
import CrudPanel from '../app/CrudPanel.jsx';

const columnas = [
  { key: 'did', label: 'DID', mono: true },
  { key: 'name', label: 'Nombre' },
  { key: 'dest', label: 'Destino', render: (r) => <b>→ {r.dest}</b> },
];
const campos = [
  { name: 'did', label: 'DID', required: true },
  { name: 'tipo', label: 'Tipo', type: 'select', data: [{ value: 'interno', label: 'Interno' }, { value: 'ivr', label: 'IVR' }] },
  { name: 'nota', label: 'Nota', type: 'textarea', placeholder: 'algo' },
  { name: 'activo', label: 'Activo', type: 'switch' },
  { name: 'clave', label: 'Clave', type: 'password' },
];

function montar(props = {}) {
  return renderTel(
    <CrudPanel title="Rutas entrantes" subtitle="DID → destino" fetchUrl="/routes/inbound" createUrl="/routes/inbound"
      idKey="id" deleteUrl={(r) => '/routes/inbound/' + r.id} columns={columnas} fields={campos} {...props} />,
  );
}

beforeEach(() => {
  resetNucleo();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('CrudPanel', () => {
  it('pinta las filas de la API, con render propio y — para lo vacío', async () => {
    apiMock.responder('GET /routes/inbound', [{ id: 1, did: '59824000000', name: null, dest: '1001' }]);
    montar();
    expect(await screen.findByText('59824000000')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('→ 1001')).toBeTruthy();
    expect(screen.getByText('DID → destino')).toBeTruthy();
  });

  it('sin registros muestra el texto de vacío; buscando sin coincidencias, «Sin resultados»', async () => {
    apiMock.responder('GET /routes/inbound', [{ id: 1, did: '111', name: 'Ventas', dest: '1' }]);
    montar({ emptyText: 'Nada cargado.' });
    await screen.findByText('111');
    escribir(screen.getByPlaceholderText('Buscar'), 'vent');
    expect(screen.getByText('Ventas')).toBeTruthy();
    escribir(screen.getByPlaceholderText('Buscar'), 'zzz');
    expect(screen.getByText('Sin resultados.')).toBeTruthy();
  });

  it('una respuesta que no es lista se trata como vacío y el error de la API sale en un toast', async () => {
    apiMock.fallar('GET /routes/inbound', 500, 'Base caída');
    montar({ emptyText: 'Nada cargado.' });
    expect(await screen.findByText('Nada cargado.')).toBeTruthy();
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Base caída', 'bad'));
  });

  it('crear manda POST a createUrl con lo cargado en el cajón y recarga', async () => {
    apiMock.responder('GET /routes/inbound', []);
    apiMock.responder('POST /routes/inbound', { id: 9 });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /Nuevo/ }));
    expect(screen.getByText('Nuevo · Rutas entrantes')).toBeTruthy();
    escribir(screen.getByLabelText(/^DID/), '2400');
    escribir(screen.getByPlaceholderText('algo'), 'nota libre');
    escribir(screen.getByLabelText('Clave'), 's3cr3t');
    fireEvent.click(screen.getByLabelText('Activo'));
    fireEvent.click(screen.getByRole('button', { name: 'Crear' }));
    await waitFor(() => expect(apiMock.llamadasA('POST /routes/inbound')).toHaveLength(1));
    expect(apiMock.llamadasA('POST /routes/inbound')[0].body).toEqual({ did: '2400', nota: 'nota libre', clave: 's3cr3t', activo: false });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Rutas entrantes creado', 'ok'));
    expect(apiMock.llamadasA('GET /routes/inbound').length).toBeGreaterThanOrEqual(2);
  });

  it('si falla el alta, el error va al toast con el mensaje de la API', async () => {
    apiMock.responder('GET /routes/inbound', []);
    apiMock.fallar('POST /routes/inbound', 409, 'Ese DID ya existe');
    montar({ title: undefined });
    fireEvent.click(await screen.findByRole('button', { name: /Nuevo/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Crear' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Error: Ese DID ya existe', 'bad', undefined));
  });

  it('editar abre el cajón con la fila (rowToForm) y guarda con PUT a editUrl', async () => {
    apiMock.responder('GET /routes/inbound', [{ id: 4, did: '777', name: 'Soporte', dest: '1002', tipo: 'ivr' }]);
    apiMock.responder('PUT /routes/inbound/4', {});
    const rowToForm = vi.fn((r) => ({ ...r, did: r.did + '0' }));
    const { container } = montar({ editUrl: (r) => '/routes/inbound/' + r.id, rowToForm });
    await screen.findByText('777');
    // El lápiz es la primera acción de la fila.
    const acciones = container.querySelectorAll('tbody button');
    fireEvent.click(acciones[0]);
    expect(rowToForm).toHaveBeenCalled();
    expect(screen.getByText('Editar · Rutas entrantes')).toBeTruthy();
    expect(screen.getByLabelText(/^DID/).value).toBe('7770');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(apiMock.llamadasA('PUT /routes/inbound/4')).toHaveLength(1));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Rutas entrantes guardado', 'ok'));
  });

  it('editar sin rowToForm copia la fila; una API vieja sin PUT (405) se explica como tal', async () => {
    apiMock.responder('GET /routes/inbound', [{ id: 4, did: '777', name: 'Soporte', dest: '1002' }]);
    apiMock.fallar('PUT /routes/inbound/4', 405, 'Method Not Allowed');
    const { container } = montar({ editUrl: (r) => '/routes/inbound/' + r.id });
    await screen.findByText('777');
    fireEvent.click(container.querySelectorAll('tbody button')[0]);
    expect(screen.getByLabelText(/^DID/).value).toBe('777');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith(
      'Esta versión de la API todavía no permite editar acá', 'bad',
      { description: 'Actualizá la central o borrá y volvé a crear el registro.' }));
    // Cancelar cierra el cajón.
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Editar · Rutas entrantes')).toBeNull());
  });

  it('borrar pide confirmación: si se cancela no se pide nada; si se confirma, DELETE y aviso', async () => {
    apiMock.responder('GET /routes/inbound', [{ id: 3, did: '555', name: 'x', dest: '1' }]);
    apiMock.responder('DELETE /routes/inbound/3', null);
    const { container } = montar();
    await screen.findByText('555');
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(container.querySelector('tbody button'));
    expect(apiMock.llamadasA('DELETE /routes/inbound/3')).toHaveLength(0);
    fireEvent.click(container.querySelector('tbody button'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Eliminado', 'info'));
  });

  it('si el borrado falla (403), el operador ve el motivo', async () => {
    apiMock.responder('GET /routes/inbound', [{ id: 3, did: '555', name: 'x', dest: '1' }]);
    apiMock.fallar('DELETE /routes/inbound/3', 403, 'No tenés permiso para esta acción');
    const { container } = montar();
    await screen.findByText('555');
    fireEvent.click(container.querySelector('tbody button'));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('No tenés permiso para esta acción', 'bad'));
  });

  it('sin título el aviso dice «Registro creado»; la búsqueda tolera celdas vacías y los íconos de columna', async () => {
    apiMock.responder('GET /routes/inbound', [{ id: 1, did: '900', name: null, dest: '1' }]);
    apiMock.responder('POST /routes/inbound', {});
    montar({ title: undefined, columns: [{ key: 'nota', label: 'Nota', icon: <i>ico</i> }, ...columnas] });
    await screen.findByText('900');
    expect(screen.getByText('ico')).toBeTruthy();
    escribir(screen.getByPlaceholderText('Buscar'), '900');
    expect(screen.getByText('900')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Nuevo/ }));
    expect(screen.getAllByText('Nuevo').length).toBe(2);   // el botón y el título del cajón
    fireEvent.click(screen.getByRole('button', { name: 'Crear' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Registro creado', 'ok'));
  });

  it('con grupos reparte los campos en solapas, con y sin texto de ayuda', async () => {
    apiMock.responder('GET /routes/inbound', []);
    const fields = [
      { name: 'did', label: 'Número', grupo: 'a' },
      { name: 'dest', label: 'Destino final', grupo: 'b' },
    ];
    montar({ fields, icon: <span>ic</span>, grupos: [
      { value: 'a', label: 'Entrada', ayuda: 'Lo que llega' },
      { value: 'b', label: 'Salida' },
    ] });
    fireEvent.click(await screen.findByRole('button', { name: /Nuevo/ }));
    expect(screen.getByText('Lo que llega')).toBeTruthy();
    expect(screen.getByLabelText('Número')).toBeTruthy();
    expect(screen.queryByLabelText('Destino final')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Salida' }));
    expect(screen.getByLabelText('Destino final')).toBeTruthy();
  });
});
