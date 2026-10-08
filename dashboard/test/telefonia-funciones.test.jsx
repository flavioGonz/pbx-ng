/* ============================================================================
 *  Funciones de telefonía (/funciones): aparcado, captura, música en espera y el
 *  catálogo de códigos de función (FeatureCodes).
 *
 *  Lo que se fija:
 *   - aparcado: se guarda lo que se ve, «Aplicar» no festeja si Asterisk devolvió error,
 *     y la tabla de plazas dice quién espera y cuánto le falta para volver a timbrar;
 *   - captura: cada interno guarda su grupo (o «sin grupo») sólo si cambió;
 *   - música en espera: crear, borrar (con confirmación), subir y borrar audios, aplicar;
 *   - códigos: se agrupan por tema (y lo desconocido cae en «Otros»), el código se edita
 *     y se guarda con Enter o con el botón, un código vacío no se guarda y vuelve al
 *     anterior, y reinstalar / quitar del plan pasan por la API con su aviso.
 *  Son los atajos que la gente marca desde el teléfono: si el panel dice «guardado» y la
 *  central no lo tomó, el *21 deja de desviar y nadie sabe por qué.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../app/api.js', async () => (await import('./helpers/nucleo-render.jsx')).apiModuleMock());
vi.mock('../app/notify.js', async () => (await import('./helpers/nucleo-render.jsx')).notifyModuleMock());

import { apiMock, notifyMock, resetNucleo } from './helpers/nucleo-render.jsx';
import { renderTel, escribir, toastPromiseQueEjecuta } from './helpers/telefonia-render.jsx';
import Funciones from '../app/funciones/page.jsx';
import FeatureCodes from '../app/FeatureCodes.jsx';

let avisos;
beforeEach(() => {
  resetNucleo();
  avisos = [];
  notifyMock.toastPromise = toastPromiseQueEjecuta(avisos);
  vi.stubGlobal('confirm', vi.fn(() => true));
});
const tab = (n) => fireEvent.click(screen.getByRole('tab', { name: n }));

describe('Aparcado', () => {
  const cfg = { parkext: '700', desde: 701, hasta: 720, parkingtime: 45, comebacktoorigin: true };

  it('si no se puede leer la configuración, avisa y no dibuja el formulario', async () => {
    apiMock.fallar('GET /parking', 500, 'Asterisk no contesta');
    renderTel(<Funciones />);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Asterisk no contesta', 'bad'));
    expect(screen.queryByText('Aplicar en Asterisk')).toBeNull();
  });

  it('explica cómo se usa, guarda lo editado y aplica (sin festejar un error de Asterisk)', async () => {
    apiMock.responder('GET /parking', cfg);
    apiMock.responder('PUT /parking', {});
    let r = { error: 'parking.conf inválido' };
    apiMock.responder('POST /parking/apply', () => r);
    renderTel(<Funciones />);
    expect(await screen.findByText('20 plaza(s): 701–720')).toBeTruthy();
    escribir(screen.getByLabelText(/Número para aparcar/), '800');
    escribir(screen.getByLabelText('Primera plaza'), '801');
    escribir(screen.getByLabelText('Última plaza'), '');
    escribir(screen.getByLabelText(/Tiempo de espera/), '60');
    fireEvent.click(screen.getByLabelText('Vuelve a quien la aparcó'));
    expect(screen.getByText('0 plaza(s): 801–')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(apiMock.llamadasA('PUT /parking')).toHaveLength(1));
    expect(apiMock.llamadasA('PUT /parking')[0].body).toEqual({ parkext: '800', desde: 801, hasta: '', parkingtime: 60, comebacktoorigin: false });
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: 'Guardado (aplicá para que Asterisk lo tome)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar en Asterisk' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'parking.conf inválido' }));
    r = { ok: true };
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar en Asterisk' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: 'Aparcado activo' }));
  });

  it('si guardar falla, el aviso trae el motivo', async () => {
    apiMock.responder('GET /parking', cfg);
    apiMock.fallar('PUT /parking', 400, 'Rango inválido');
    renderTel(<Funciones />);
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'Rango inválido' }));
  });

  it('las plazas: quién espera, quién la aparcó y cuánto falta; se actualizan y se ocultan', async () => {
    apiMock.responder('GET /parking', cfg);
    apiMock.responder('GET /parking/lots', { total: 4, ocupadas: 3, plazas: [
      { plaza: 701, libre: false, nombre: 'Juan', numero: '099111', aparcada_por: '1001', restante: 30 },
      { plaza: 702, libre: false, numero: '099222', restante: null },
      { plaza: 703, libre: false },
      { plaza: 704, libre: true },
    ] });
    renderTel(<Funciones />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver plazas ocupadas' }));
    expect(await screen.findByText('Juan')).toBeTruthy();
    expect(screen.getByText('099111')).toBeTruthy();
    expect(screen.getByText('30 s')).toBeTruthy();
    expect(screen.getByText('099222')).toBeTruthy();
    expect(screen.getByText('desconocido')).toBeTruthy();
    expect(screen.getByText('3 ocupada(s)')).toBeTruthy();
    expect(screen.getByText('1 libre(s)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar plazas' }));
    await waitFor(() => expect(apiMock.llamadasA('GET /parking/lots')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar' }));
    expect(screen.queryByText('Juan')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ver plazas ocupadas' })).toBeTruthy();
  });

  it('sin llamadas aparcadas lo dice; si la consulta de plazas falla, avisa', async () => {
    apiMock.responder('GET /parking', cfg);
    apiMock.responder('GET /parking/lots', { total: 2, ocupadas: 0 });
    const { unmount } = renderTel(<Funciones />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver plazas ocupadas' }));
    expect(await screen.findByText(/Ninguna llamada aparcada ahora/)).toBeTruthy();
    unmount();
    apiMock.fallar('GET /parking/lots', 502, 'AMI caído');
    renderTel(<Funciones />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver plazas ocupadas' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('AMI caído', 'bad'));
  });

  it('un rango sin datos da cero plazas', async () => {
    apiMock.responder('GET /parking', { parkext: '700' });
    renderTel(<Funciones />);
    expect(await screen.findByText(/^1 plaza\(s\)/)).toBeTruthy();
  });
});

describe('Captura', () => {
  it('cada interno guarda su grupo sólo si cambió; vacío = «sin grupo»', async () => {
    apiMock.responder('GET /parking', null);
    apiMock.responder('GET /pickup-groups', [{ ext: '1001', named_pickup_group: 'ventas' }, { ext: '1002' }]);
    apiMock.responder('PUT /pickup-groups/1001', {});
    apiMock.responder('PUT /pickup-groups/1002', {});
    renderTel(<Funciones />);
    tab('Captura');
    expect(await screen.findByDisplayValue('ventas')).toBeTruthy();
    const filaDe = (ext) => screen.getByText(ext).closest('tr');
    const btn = within(filaDe('1001')).getByRole('button', { name: 'Guardar' });
    expect(btn.disabled).toBe(true);
    escribir(within(filaDe('1001')).getByPlaceholderText('sin grupo'), '');
    fireEvent.click(btn);
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: '1001: grupo "sin grupo"' }));
    escribir(within(filaDe('1002')).getByPlaceholderText('sin grupo'), 'recepcion');
    fireEvent.click(within(filaDe('1002')).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: '1002: grupo "recepcion"' }));
    expect(apiMock.llamadasA('PUT /pickup-groups/1002')[0].body).toEqual({ grupo: 'recepcion' });
  });

  it('si no se pueden leer los grupos avisa y queda la tabla vacía; un error al guardar se muestra', async () => {
    apiMock.fallar('GET /pickup-groups', 500, 'Base caída');
    renderTel(<Funciones />);
    tab('Captura');
    expect(await screen.findByText('No hay internos todavía.')).toBeTruthy();
    expect(notifyMock.toast).toHaveBeenCalledWith('Base caída', 'bad');
  });

  it('el error del PUT llega al aviso', async () => {
    apiMock.responder('GET /pickup-groups', [{ ext: '1003', named_pickup_group: '' }]);
    apiMock.fallar('PUT /pickup-groups/1003', 400, 'Nombre inválido');
    renderTel(<Funciones />);
    tab('Captura');
    escribir(await screen.findByPlaceholderText('sin grupo'), 'a b');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'Nombre inválido' }));
  });
});

describe('Música en espera', () => {
  it('lista las clases con sus audios; crea (con Enter o botón), borra con confirmación y aplica', async () => {
    apiMock.responder('GET /moh', [{ nombre: 'ventas', sort: 'random', archivos: ['a.wav', 'b.wav'] }, { nombre: 'vacia', sort: 'alpha' }]);
    apiMock.responder('POST /moh', {});
    apiMock.responder('DELETE /moh/vacia', {});
    apiMock.responder('DELETE /moh/ventas/audio/a.wav', {});
    let r = { clases: 3 };
    apiMock.responder('POST /moh/apply', () => r);
    renderTel(<Funciones />);
    tab('Música en espera');
    expect(await screen.findByText('2 audio(s) · orden: random')).toBeTruthy();
    expect(screen.getByText('Sin audios todavía.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nueva clase' }));
    expect(apiMock.llamadasA('POST /moh')).toHaveLength(0);   // sin nombre no se crea
    const nombre = screen.getByPlaceholderText(/Nombre de la clase/);
    escribir(nombre, ' soporte ');
    fireEvent.keyDown(nombre, { key: 'a' });
    fireEvent.keyDown(nombre, { key: 'Enter' });
    await waitFor(() => expect(apiMock.llamadasA('POST /moh')[0].body).toEqual({ nombre: 'soporte' }));
    await waitFor(() => expect(nombre.value).toBe(''));
    const tarjeta = (n) => screen.getByText(n).closest('.mantine-Card-root');
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(within(tarjeta('vacia')).getAllByRole('button').at(-1));
    expect(apiMock.llamadasA('DELETE /moh/vacia')).toHaveLength(0);
    fireEvent.click(within(tarjeta('vacia')).getAllByRole('button').at(-1));
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: 'Clase borrada' }));
    fireEvent.click(screen.getByText('a.wav').closest('.mantine-Badge-root').querySelector('button'));
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: 'Audio borrado' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar en Asterisk' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: 'Aplicado: 3 clase(s)' }));
    r = null;
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar en Asterisk' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: 'Aplicado: 0 clase(s)' }));
    r = { error: 'módulo no cargado' };
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar en Asterisk' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'módulo no cargado' }));
  });

  it('subir un audio lo manda como data URL con su nombre', async () => {
    apiMock.responder('GET /moh', [{ nombre: 'ventas', sort: 'random', archivos: [] }]);
    apiMock.responder('POST /moh/ventas/audio', {});
    const { container } = renderTel(<Funciones />);
    tab('Música en espera');
    await screen.findByText('Sin audios todavía.');
    const input = container.ownerDocument.querySelector('input[type=file]');
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['RIFF'], 'tema.wav', { type: 'audio/wav' })] } }); });
    await waitFor(() => expect(apiMock.llamadasA('POST /moh/ventas/audio')).toHaveLength(1));
    const body = apiMock.llamadasA('POST /moh/ventas/audio')[0].body;
    expect(body.filename).toBe('tema.wav');
    expect(body.data).toMatch(/^data:audio\/wav;base64,/);
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: 'Audio subido (aplicá para que suene)' }));
  });

  it('cada operación que falla deja su motivo en el aviso (crear, borrar, subir, borrar audio); elegir sin archivo no hace nada', async () => {
    apiMock.responder('GET /moh', [{ nombre: 'ventas', sort: 'random', archivos: ['a.wav'] }]);
    apiMock.fallar('POST /moh', 409, 'ya existe');
    apiMock.fallar('DELETE /moh/ventas', 500, 'no se pudo borrar');
    apiMock.fallar('POST /moh/ventas/audio', 413, 'archivo muy grande');
    apiMock.fallar('DELETE /moh/ventas/audio/a.wav', 404, 'no está');
    const { container } = renderTel(<Funciones />);
    tab('Música en espera');
    await screen.findByText('a.wav');
    escribir(screen.getByPlaceholderText(/Nombre de la clase/), 'ventas');
    fireEvent.click(screen.getByRole('button', { name: 'Nueva clase' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'ya existe' }));
    const borrarClase = within(screen.getByText('ventas', { selector: 'p' }).closest('.mantine-Card-root')).getAllByRole('button').filter((b) => !b.closest('.mantine-Badge-root')).at(-1);
    fireEvent.click(borrarClase);
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'no se pudo borrar' }));
    fireEvent.click(screen.getByText('a.wav').closest('.mantine-Badge-root').querySelector('button'));
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'no está' }));
    const input = container.ownerDocument.querySelector('input[type=file]');
    await act(async () => { fireEvent.change(input, { target: { files: [] } }); });
    expect(apiMock.llamadasA('POST /moh/ventas/audio')).toHaveLength(0);
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'big.wav', { type: 'audio/wav' })] } }); });
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'archivo muy grande' }));
  });

  it('sin clases invita a crear una; si la lista falla, avisa', async () => {
    apiMock.fallar('GET /moh', 500, 'sin acceso al directorio');
    renderTel(<Funciones />);
    tab('Música en espera');
    expect(await screen.findByText(/Sin clases propias/)).toBeTruthy();
    expect(notifyMock.toast).toHaveBeenCalledWith('sin acceso al directorio', 'bad');
  });
});

describe('Códigos de función', () => {
  const catalogo = [
    { accion: 'dnd_on', code: '*78', enabled: true },
    { accion: 'cfu_set', code: '_*21*.', enabled: true },
    { code: '*43', installed: true },                         // API vieja: sin `accion`
    { accion: 'nuevo_x', code: '*55', name: 'Algo nuevo', descripcion: 'de la API', enabled: false },
    { code: '' },
  ];

  it('agrupa por tema, rotula lo conocido y manda lo desconocido a «Otros»', async () => {
    apiMock.responder('GET /featurecodes', catalogo);
    renderTel(<Funciones />);
    tab('Códigos de función');
    expect(await screen.findByText('No molestar: prender')).toBeTruthy();
    expect(screen.getByText('Desvío incondicional')).toBeTruthy();
    expect(screen.getByText('+destino#')).toBeTruthy();
    expect(screen.getByText('Prueba de eco')).toBeTruthy();
    expect(screen.getByText('Algo nuevo')).toBeTruthy();
    expect(screen.getByText('de la API')).toBeTruthy();
    expect(screen.getByText('Otros')).toBeTruthy();
    expect(screen.queryByText('Modo noche')).toBeNull();   // tema sin filas no se muestra
  });

  it('editar un código: filtra caracteres, guarda con Enter o con el botón y recarga', async () => {
    apiMock.responder('GET /featurecodes', catalogo.slice(0, 1));
    apiMock.responder('PUT /featurecodes', {});
    renderTel(<FeatureCodes />);
    const input = await screen.findByLabelText('Código de No molestar: prender');
    const guardar = screen.getByRole('button', { name: 'Guardar' });
    expect(guardar.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });   // sin cambios no hace nada
    escribir(input, '*7 8ñ');
    expect(input.value).toBe('*78');
    escribir(input, '*80');
    fireEvent.keyDown(input, { key: 'x' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(apiMock.llamadasA('PUT /featurecodes')).toHaveLength(1));
    expect(apiMock.llamadasA('PUT /featurecodes')[0].body).toEqual({ accion: 'dnd_on', code: '*80', enabled: true });
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Código guardado: *80', 'ok'));
    expect(apiMock.llamadasA('GET /featurecodes')).toHaveLength(2);
    escribir(input, '*81');
    fireEvent.click(guardar);
    await waitFor(() => expect(apiMock.llamadasA('PUT /featurecodes')).toHaveLength(2));
  });

  it('un código vacío no se guarda y vuelve al anterior; apagar manda enabled=false; el error de la API se muestra', async () => {
    apiMock.responder('GET /featurecodes', catalogo.slice(0, 1));
    apiMock.fallar('PUT /featurecodes', 409, 'Código repetido');
    renderTel(<FeatureCodes />);
    const input = await screen.findByLabelText('Código de No molestar: prender');
    escribir(input, '');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('El código no puede quedar vacío', 'bad'));
    await waitFor(() => expect(input.value).toBe('*78'));
    expect(apiMock.llamadasA('PUT /featurecodes')).toHaveLength(0);
    const sw = screen.getByRole('switch');
    fireEvent.click(sw);
    await waitFor(() => expect(notifyMock.toast).toHaveBeenCalledWith('Código repetido', 'bad'));
    expect(apiMock.llamadasA('PUT /featurecodes')[0].body).toEqual({ accion: 'dnd_on', code: '*78', enabled: false });
    await waitFor(() => expect(sw.checked).toBe(true));
  });

  it('reinstalar y quitar del plan pasan por la API; quitar pide confirmación', async () => {
    apiMock.responder('GET /featurecodes', []);
    apiMock.responder('POST /featurecodes/install', {});
    apiMock.fallar('POST /featurecodes/uninstall', 500, 'AMI caído');
    renderTel(<FeatureCodes />);
    expect(await screen.findByText(/Sin códigos en el catálogo/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reinstalar todos' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: 'Códigos instalados' }));
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Quitar del plan' }));
    expect(apiMock.llamadasA('POST /featurecodes/uninstall')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Quitar del plan' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'AMI caído' }));
    apiMock.fallar('POST /featurecodes/install', 500, 'sin dialplan');
    fireEvent.click(screen.getByRole('button', { name: 'Reinstalar todos' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: false, msg: 'sin dialplan' }));
    apiMock.responder('POST /featurecodes/uninstall', {});
    fireEvent.click(screen.getByRole('button', { name: 'Quitar del plan' }));
    await waitFor(() => expect(avisos).toContainEqual({ ok: true, msg: 'Códigos quitados' }));
  });

  it('si el catálogo no se puede leer lo dice (y no muestra el «sin códigos»); una respuesta rara cuenta como vacía', async () => {
    apiMock.fallar('GET /featurecodes', 403, 'No tenés permiso para esta acción');
    const { unmount } = renderTel(<FeatureCodes />);
    expect(await screen.findByText('No se pudo leer el catálogo')).toBeTruthy();
    expect(screen.queryByText(/Sin códigos en el catálogo/)).toBeNull();
    unmount();
    apiMock.responder('GET /featurecodes', { no: 'lista' });
    renderTel(<FeatureCodes />);
    expect(await screen.findByText(/Sin códigos en el catálogo/)).toBeTruthy();
  });
});
