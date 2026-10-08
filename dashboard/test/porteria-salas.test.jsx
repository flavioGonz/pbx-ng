/* Salas de reunión (app/SalasPanel.jsx y app/salas/page.jsx).
 *
 * Qué se fija y por qué:
 *  - RBAC: el supervisor entra a MODERAR (ver quién está, historial, silenciar, expulsar);
 *    crear, editar, borrar, invitar, enlace, ver PIN y «entrar como moderador» son de admin y
 *    ni se dibujan para él. Un botón que sólo sabe dar 403 es peor que no tenerlo.
 *  - Los PIN no viajan en el listado: la tabla dice si hay (Sin PIN / Sin moderador /
 *    Configurado) y el admin los ve pidiendo el detalle. Editar pide el detalle ANTES de
 *    abrir el formulario, si no los PIN saldrían vacíos.
 *  - Guardar avisa si Asterisk no tomó los PIN (la sala sigue con el viejo).
 *  - «Entrar como moderador» abre otra pestaña y sólo avisa «bloqueada» si de verdad lo
 *    estuvo (con 'noopener' window.open siempre da null y el aviso salía siempre).
 *  - El enlace web es una llave: se crea, se cambia y se revoca con confirmación.
 *  - La invitación arma el mismo texto que el correo, con enlace, número externo y PIN.
 *  - En vivo: todos esperando al moderador se dice con todas las letras.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderP, rutasFalsas, estado } from './helpers/porteria-render';

const toast = vi.fn();
let admin = true;
vi.mock('../app/notify', () => ({ toast: (...a) => toast(...a) }));
vi.mock('../app/auth', () => ({ useEsAdmin: () => admin }));
import SalasPanel from '../app/SalasPanel';
import SalasPage from '../app/salas/page';

const SALAS = [
  { name: 'directorio', label: 'Directorio', access_exten: '9001', tiene_pin: true, tiene_pin_mod: true, web: true, video: true,
    agenda_inicio: '2026-11-01T13:00:00Z', agenda_min: 90, abierta: true, participantes: 3, grabar: true },
  { name: 'recepcion', access_exten: '9002', tiene_pin: false, tiene_pin_mod: false, abierta: false },
  { name: 'ventas', label: 'Ventas', access_exten: '9003', tiene_pin: true, tiene_pin_mod: false },
];
const DETALLE = {
  name: 'directorio', label: 'Directorio', access_exten: '9001', pin: '123456', pin_mod: '654321', max_part: 10,
  moh_hasta_moderador: true, anunciar: true, grabar: true, video: true, agenda_inicio: '2026-11-01T13:00:00Z', agenda_min: 90, web_token: 'wt1',
};

function api(extra = {}) {
  return rutasFalsas({ 'GET /salas': SALAS, 'GET /settings': { sala_numero_externo: '0800 1234' }, 'GET /salas/directorio': DETALLE, ...extra });
}
async function montar(f = api(), ui = <SalasPanel />) {
  vi.stubGlobal('fetch', f);
  renderP(ui);
  await screen.findByText('Directorio');
  return f;
}
const filaDe = (texto) => screen.getAllByText(texto, { selector: 'p' })[0].closest('tr');
const cajon = () => within(document.querySelector('.mantine-Drawer-content'));
const botonEn = (raiz, clase) => raiz.querySelector('.tabler-icon-' + clase).closest('button');

beforeEach(() => { toast.mockReset(); admin = true; });
afterEach(() => { vi.useRealTimers(); });

describe('Salas · listado', () => {
  it('muestra cómo se entra, el estado de los PIN, la agenda y quién está adentro', async () => {
    await montar();
    const dir = filaDe('Directorio');
    expect(within(dir).getByText('Configurado')).toBeTruthy();
    expect(within(dir).getByText('Enlace')).toBeTruthy();
    expect(within(dir).getByText('Video')).toBeTruthy();
    expect(within(dir).getByText(/· 90 min/)).toBeTruthy();
    expect(within(dir).getByText('Abierta')).toBeTruthy();
    expect(within(dir).getByText('3 adentro')).toBeTruthy();
    const rec = filaDe('recepcion');
    expect(within(rec).getByText('Sin PIN')).toBeTruthy();
    expect(within(rec).getByText('siempre disponible')).toBeTruthy();
    expect(within(rec).getByText('Cerrada')).toBeTruthy();
    expect(rec.querySelector('.tabler-icon-key')).toBeNull();     // sin PIN no hay qué ver
    expect(within(filaDe('Ventas')).getByText('Sin moderador')).toBeTruthy();
    // Aviso de las salas heredadas sin PIN, nombradas con su número.
    expect(screen.getByText('Hay una sala sin PIN')).toBeTruthy();
    expect(screen.getByText(/recepcion \(9002\)/)).toBeTruthy();
    expect(screen.getByText(/editalas y guardá/)).toBeTruthy();
  });

  it('el supervisor modera pero no administra: sin botones de admin', async () => {
    admin = false;
    const f = await montar(api({ 'GET /salas': [...SALAS, { name: 'b', access_exten: '1' }] }));
    expect(screen.queryByText('Nueva sala')).toBeNull();
    expect(screen.queryByText('Número para entrar desde afuera')).toBeNull();
    expect(screen.getByText('Hay 2 salas sin PIN')).toBeTruthy();
    expect(screen.getByText(/Un administrador puede ponerles PIN/)).toBeTruthy();
    const fila = filaDe('Directorio');
    for (const c of ['door-enter', 'mail', 'link', 'pencil', 'trash', 'key']) expect(fila.querySelector('.tabler-icon-' + c)).toBeNull();
    expect(fila.querySelector('.tabler-icon-eye')).toBeTruthy();
    expect(fila.querySelector('.tabler-icon-history')).toBeTruthy();
    expect(f.de('GET', '/settings').length).toBe(0);
  });

  it('sin salas lo dice según quién mira; un error de la API se avisa', async () => {
    admin = false;
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas': [] }));
    const r = renderP(<SalasPanel />);
    expect(await screen.findByText('Todavía no hay salas de reunión.')).toBeTruthy();
    r.unmount();
    admin = true;
    vi.stubGlobal('fetch', rutasFalsas({ 'GET /salas': estado(500, { error: 'base caída' }), 'GET /settings': {} }));
    renderP(<SalasPanel />);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('base caída', 'bad'));
    expect(screen.getByText(/Creá una y mandá la invitación/)).toBeTruthy();
  });

  it('la página /salas lo monta con encabezado; embebido, el botón va en la tarjeta', async () => {
    await montar(api(), <SalasPage />);
    expect(screen.getByText('Salas de reunión')).toBeTruthy();
    expect(screen.getAllByText('Nueva sala').length).toBe(1);
  });

  it('sin encabezado (embebido en Aplicaciones) el botón Nueva sala sigue estando', async () => {
    await montar(api(), <SalasPanel conEncabezado={false} />);
    expect(screen.queryByText('Salas de reunión')).toBeNull();
    expect(screen.getByText('Nueva sala')).toBeTruthy();
  });
});

describe('Salas · alta y edición', () => {
  it('crear: PIN vacíos los genera la API, el dado propone uno, la agenda se puede quitar', async () => {
    const f = await montar(api({ 'POST /salas': { name: 'nueva', pin: '111111', pin_mod: '222222' } }));
    fireEvent.click(screen.getByText('Nueva sala'));
    expect(await screen.findByText('Nueva sala de reunión')).toBeTruthy();
    expect(screen.getByText('Vacío = se genera uno al azar.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Nombre/), { target: { value: 'nueva' } });
    fireEvent.change(screen.getByLabelText(/^Etiqueta/), { target: { value: 'Temporal' } });
    fireEvent.change(screen.getByLabelText(/^Etiqueta/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/^Número de la sala/), { target: { value: '9010' } });
    fireEvent.change(screen.getByLabelText(/Máximo de participantes/), { target: { value: '12' } });
    // El azar se fija sólo para el dado: Mantine también usa Math.random para sus ids.
    const azar = vi.spyOn(Math, 'random').mockReturnValue(0.000042);
    fireEvent.click(document.querySelectorAll('.tabler-icon-dice')[1].closest('button'));
    azar.mockRestore();
    expect(screen.getByLabelText(/PIN del moderador/).value).toBe('000042');
    fireEvent.change(screen.getByLabelText(/PIN del moderador/), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText(/PIN del moderador/), { target: { value: '000042' } });
    fireEvent.click(document.querySelectorAll('.tabler-icon-dice')[0].closest('button'));
    fireEvent.change(screen.getByLabelText(/PIN de participantes/), { target: { value: '777' } });
    fireEvent.click(screen.getByLabelText(/^Música en espera hasta que entre el moderador/));
    fireEvent.click(screen.getByLabelText(/^Anunciar entradas y salidas/));
    fireEvent.click(screen.getByLabelText(/^Grabar la reunión/));
    fireEvent.click(screen.getByLabelText(/^Video en la sala/));
    // Agenda: la duración se habilita al poner fecha; quitarla la vuelve a deshabilitar.
    expect(screen.getByLabelText(/Duración/).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Cuándo empieza/), { target: { value: '2026-12-01T10:00' } });
    fireEvent.change(screen.getByLabelText(/Duración/), { target: { value: '45' } });
    fireEvent.click(screen.getByText(/Quitar la agenda/));
    expect(screen.getByLabelText(/Duración/).disabled).toBe(true);
    fireEvent.click(screen.getByText('Crear sala'));
    await waitFor(() => expect(f.de('POST', '/salas').length).toBe(1));
    expect(f.de('POST', '/salas')[0].cuerpo).toMatchObject({
      name: 'nueva', label: '', access_exten: '9010', pin: '777', pin_mod: '000042', max_part: 12,
      moh_hasta_moderador: false, anunciar: false, grabar: true, video: true, agenda_inicio: null, agenda_min: null,
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sala «nueva» guardada', 'ok', { description: 'PIN participante 111111 · PIN moderador 222222' }));
    await waitFor(() => expect(screen.queryByText('Nueva sala de reunión')).toBeNull());
  });

  it('con agenda manda la hora en ISO y la duración; max vacío va 0', async () => {
    const f = await montar(api({ 'POST /salas': { name: 'x', label: 'X', pin: '1', pin_mod: '2' } }));
    fireEvent.click(screen.getByText('Nueva sala'));
    await screen.findByText('Nueva sala de reunión');
    fireEvent.change(screen.getByLabelText(/^Nombre/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/Máximo de participantes/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Cuándo empieza/), { target: { value: '2026-12-01T10:00' } });
    fireEvent.change(screen.getByLabelText(/Duración/), { target: { value: '' } });
    fireEvent.click(screen.getByText('Crear sala'));
    await waitFor(() => expect(f.de('POST', '/salas').length).toBe(1));
    const c = f.de('POST', '/salas')[0].cuerpo;
    expect(c.agenda_inicio).toBe(new Date('2026-12-01T10:00').toISOString());
    expect(c.agenda_min).toBe(60);
    expect(c.max_part).toBe(0);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sala «X» guardada', 'ok', expect.any(Object)));
  });

  it('si Asterisk no tomó los PIN lo avisa; un error de la API se muestra y el cajón queda', async () => {
    let resp = { name: 'x', aviso: 'Asterisk no respondió: los PIN nuevos no se aplicaron' };
    const f = await montar(api({ 'POST /salas': () => resp }));
    fireEvent.click(screen.getByText('Nueva sala'));
    await screen.findByText('Nueva sala de reunión');
    fireEvent.click(screen.getByText('Crear sala'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Asterisk no respondió: los PIN nuevos no se aplicaron', 'bad', expect.any(Object)));
    fireEvent.click(screen.getByText('Nueva sala'));
    await screen.findByText('Nueva sala de reunión');
    resp = estado(409, { error: 'Ese número ya lo usa otra cosa' });
    fireEvent.click(screen.getByText('Crear sala'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Ese número ya lo usa otra cosa', 'bad'));
    expect(screen.getByText('Nueva sala de reunión')).toBeTruthy();
    expect(f.de('POST', '/salas').length).toBe(2);
    fireEvent.click(screen.getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByText('Nueva sala de reunión')).toBeNull());
  });

  it('editar pide el detalle con los PIN antes de abrir y guarda con PUT', async () => {
    const f = await montar(api({ 'PUT /salas/directorio': { name: 'directorio', label: 'Directorio', pin: '123456', pin_mod: '654321' } }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'pencil'));
    expect(await screen.findByText('Editar sala')).toBeTruthy();
    expect(screen.getByLabelText(/PIN de participantes/).value).toBe('123456');
    expect(screen.getByLabelText(/PIN del moderador/).value).toBe('654321');
    expect(screen.getByText(/no corta la reunión en curso/)).toBeTruthy();
    expect(screen.getByLabelText(/Cuándo empieza/).value).not.toBe('');
    fireEvent.click(cajon().getByText('Guardar'));
    await waitFor(() => expect(f.de('PUT', '/salas/directorio').length).toBe(1));
    expect(f.de('PUT', '/salas/directorio')[0].cuerpo.agenda_min).toBe(90);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sala «Directorio» guardada', 'ok', expect.any(Object)));
  });

  it('una sala sin duración guardada edita con 60 min; si el detalle falla, no abre', async () => {
    let det = { ...DETALLE, agenda_min: null };
    await montar(api({ 'GET /salas/directorio': () => det }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'pencil'));
    expect(await screen.findByText('Editar sala')).toBeTruthy();
    expect(screen.getByLabelText(/Duración/).value).toBe('60');
    fireEvent.click(screen.getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByText('Editar sala')).toBeNull());
    det = estado(403, { error: 'Sólo admin' });
    fireEvent.click(botonEn(filaDe('Directorio'), 'pencil'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sólo admin', 'bad'));
    expect(screen.queryByText('Editar sala')).toBeNull();
  });

  it('borrar pide confirmación nombrando el número, y avisa', async () => {
    let resp = {};
    const f = await montar(api({ 'DELETE /salas/directorio': () => resp }));
    const conf = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    fireEvent.click(botonEn(filaDe('Directorio'), 'trash'));
    expect(conf.mock.calls[0][0]).toContain('El número 9001 deja de entrar');
    expect(f.de('DELETE', '/salas').length).toBe(0);
    fireEvent.click(botonEn(filaDe('Directorio'), 'trash'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sala borrada', 'info'));
    resp = estado(500, { error: 'no se pudo' });
    fireEvent.click(botonEn(filaDe('recepcion'), 'trash'));
    expect(conf.mock.calls[2][0]).toContain('«recepcion»');
    await waitFor(() => expect(f.de('DELETE', '/salas/recepcion').length).toBe(1));
  });
});

describe('Salas · entrar como moderador', () => {
  it('abre la sala en otra pestaña sin opener y avisa; si el navegador la bloquea, lo dice', async () => {
    let resp = { url: '/sala/wt1?e=ent1' };
    await montar(api({ 'POST /salas/directorio/moderar': () => resp }));
    const ventana = { opener: 'panel' };
    const abrir = vi.spyOn(window, 'open').mockReturnValueOnce(ventana).mockReturnValueOnce(null);
    fireEvent.click(botonEn(filaDe('Directorio'), 'door-enter'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Abriendo la sala como moderador', 'ok'));
    expect(abrir).toHaveBeenCalledWith('/sala/wt1?e=ent1', '_blank');
    expect(ventana.opener).toBeNull();
    fireEvent.click(botonEn(filaDe('Directorio'), 'door-enter'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('El navegador bloqueó la ventana nueva. Permitila y probá otra vez.', 'bad'));
    resp = estado(409, { error: 'La sala está cerrada' });
    fireEvent.click(botonEn(filaDe('Directorio'), 'door-enter'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('La sala está cerrada', 'bad'));
  });
});

describe('Salas · ver PIN', () => {
  it('pide el detalle y muestra los dos PIN; si falla, el motivo', async () => {
    let det = DETALLE;
    await montar(api({ 'GET /salas/directorio': () => det, 'GET /salas/ventas': { pin: '5', pin_mod: null } }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'key'));
    expect(await screen.findByText('123456')).toBeTruthy();
    expect(screen.getByText('654321')).toBeTruthy();
    fireEvent.click(screen.getByText('Cerrar'));
    await waitFor(() => expect(screen.queryByText('123456')).toBeNull());
    fireEvent.click(botonEn(filaDe('Ventas'), 'key'));
    expect(await screen.findByText('—')).toBeTruthy();
    fireEvent.click(screen.getByText('Cerrar'));
    await waitFor(() => expect(screen.queryByText('PIN del moderador')).toBeNull());
    det = estado(403, { error: 'Sólo admin ve los PIN' });
    fireEvent.click(botonEn(filaDe('Directorio'), 'key'));
    expect(await screen.findByText('Sólo admin ve los PIN')).toBeTruthy();
  });
});

describe('Salas · enlace web', () => {
  it('una sala sin enlace lo explica y lo crea', async () => {
    const f = await montar(api({ 'GET /salas/recepcion': { moh_hasta_moderador: false }, 'POST /salas/recepcion/enlace': { token: 'nuevo1' } }));
    fireEvent.click(botonEn(filaDe('recepcion'), 'link'));
    expect(await screen.findByText(/no se puede abrir desde el navegador/)).toBeTruthy();
    fireEvent.click(screen.getByText('Crear el enlace'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Enlace creado', 'ok'));
    expect(screen.getByDisplayValue(window.location.origin + '/sala/nuevo1')).toBeTruthy();
    expect(f.de('POST', '/salas/recepcion/enlace').length).toBe(1);
    expect(screen.queryByText(/música en espera hasta que entre el moderador»/)).toBeNull();
  });

  it('con enlace: QR, aviso de música en espera, cambiarlo y revocarlo con confirmación', async () => {
    let gen = { url: 'https://pbx.ejemplo/sala/otro2' };
    let rev = {};
    const f = await montar(api({ 'POST /salas/directorio/enlace': () => gen, 'DELETE /salas/directorio/enlace': () => rev }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'link'));
    expect(await screen.findByDisplayValue(window.location.origin + '/sala/wt1')).toBeTruthy();
    expect(document.querySelector('svg[height="188"]')).toBeTruthy();
    expect(screen.getByText(/la reunión no arranca nunca/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cambiarlo por uno nuevo'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Enlace nuevo: el anterior dejó de servir', 'ok'));
    expect(screen.getByDisplayValue('https://pbx.ejemplo/sala/otro2')).toBeTruthy();
    gen = estado(500, { error: 'no se pudo rotar' });
    fireEvent.click(screen.getByText('Cambiarlo por uno nuevo'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('no se pudo rotar', 'bad'));
    const conf = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    fireEvent.click(screen.getByText('Revocar'));
    expect(f.de('DELETE', '/salas/directorio/enlace').length).toBe(0);
    rev = estado(500, { error: 'falló' });
    fireEvent.click(screen.getByText('Revocar'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('falló', 'bad'));
    rev = {};
    fireEvent.click(screen.getByText('Revocar'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Enlace revocado', 'info'));
    expect(screen.getByText('Crear el enlace')).toBeTruthy();
    expect(conf).toHaveBeenCalledTimes(3);
  });

  it('si el detalle no se puede leer, deja crear uno igual', async () => {
    await montar(api({ 'GET /salas/directorio': estado(500) }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'link'));
    expect(await screen.findByText('Crear el enlace')).toBeTruthy();
  });
});

describe('Salas · invitar', () => {
  it('arma el texto para copiar con enlace, número externo, PIN y hora', async () => {
    await montar();
    fireEvent.click(botonEn(filaDe('Directorio'), 'mail'));
    expect(await screen.findByText('Invitar a «Directorio»')).toBeTruthy();
    const texto = await screen.findByText(/Te invito a la reunión «Directorio»/);
    expect(texto.textContent).toContain('Entrá desde el navegador: ' + window.location.origin + '/sala/wt1');
    expect(texto.textContent).toContain('O marcá 9001 (desde afuera: 0800 1234) y el PIN 123456');
    expect(texto.textContent).toContain('· 90 min');
    expect(screen.getByText('Copiar la invitación').closest('button').disabled).toBe(false);
  });

  it('sin enlace, sin número externo ni agenda: el texto lo dice igual', async () => {
    await montar(api({ 'GET /settings': estado(500), 'GET /salas/recepcion': {} }));
    fireEvent.click(botonEn(filaDe('recepcion'), 'mail'));
    const texto = await screen.findByText(/Te invito a la reunión «recepcion»/);
    expect(texto.textContent).toBe('Te invito a la reunión «recepcion».\nO marcá 9002\nLa sala está disponible en cualquier momento.');
  });

  it('mientras busca la sala no deja copiar; si el detalle falla queda esperando', async () => {
    await montar(api({ 'GET /salas/ventas': estado(500), 'GET /settings': {} }));
    fireEvent.click(botonEn(filaDe('Ventas'), 'mail'));
    expect(await screen.findByText('Buscando los datos de la sala…')).toBeTruthy();
    expect(screen.getByText('Copiar la invitación').closest('button').disabled).toBe(true);
  });

  it('sin direcciones no manda; manda una por persona y avisa cuántas y cuáles fallaron', async () => {
    let resp = { enviados: ['ana@x.com'], fallados: [] };
    const f = await montar(api({ 'POST /salas/directorio/invitar': () => resp }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'mail'));
    await screen.findByText('Invitar a «Directorio»');
    fireEvent.click(screen.getByText('Enviar invitación'));
    expect(toast).toHaveBeenCalledWith('Poné al menos una dirección', 'bad');
    fireEvent.change(screen.getByLabelText(/^Direcciones/), { target: { value: 'ana@x.com; ;juan@x.com  pedro@x.com' } });
    fireEvent.change(screen.getByLabelText(/^Mensaje/), { target: { value: 'Cierre de mes' } });
    fireEvent.click(screen.getByLabelText(/Invitar como moderador/));
    fireEvent.click(screen.getByText('Enviar invitación'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('1 invitación enviada', 'ok', undefined));
    expect(f.de('POST', '/salas/directorio/invitar')[0].cuerpo).toEqual({
      destinatarios: ['ana@x.com', 'juan@x.com', 'pedro@x.com'], moderador: true, mensaje: 'Cierre de mes',
    });
    await waitFor(() => expect(screen.queryByText('Invitar a «Directorio»')).toBeNull());
    // Ninguna salió: queda abierto y dice cuáles.
    fireEvent.click(botonEn(filaDe('Directorio'), 'mail'));
    await screen.findByText('Invitar a «Directorio»');
    fireEvent.change(screen.getByLabelText(/^Direcciones/), { target: { value: 'a@x, b@x' } });
    resp = { enviados: [], fallados: [{ destino: 'a@x' }, { destino: 'b@x' }] };
    fireEvent.click(screen.getByText('Enviar invitación'));
    await waitFor(() => expect(toast.mock.calls.map((c) => c[0])).toContain('0 invitaciones enviadas'));
    expect(toast).toHaveBeenCalledWith('0 invitaciones enviadas', 'bad', { description: 'No salieron: a@x, b@x' });
    resp = { enviados: ['a', 'b'] };
    fireEvent.click(screen.getByText('Enviar invitación'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('2 invitaciones enviadas', 'ok', undefined));
  });

  it('un error al mandar se muestra; Cancelar cierra', async () => {
    await montar(api({ 'POST /salas/directorio/invitar': estado(502, { error: 'SMTP no configurado' }) }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'mail'));
    await screen.findByText('Invitar a «Directorio»');
    fireEvent.change(screen.getByLabelText(/^Direcciones/), { target: { value: 'a@x' } });
    fireEvent.click(screen.getByText('Enviar invitación'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('SMTP no configurado', 'bad'));
    fireEvent.click(screen.getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByText('Invitar a «Directorio»')).toBeNull());
  });
});

describe('Salas · número para entrar desde afuera', () => {
  it('se carga, sólo deja guardar si cambió, y guarda recortado', async () => {
    let resp = { ok: true };
    const f = await montar(api({ 'POST /settings': () => resp }));
    const campo = await screen.findByDisplayValue('0800 1234');
    const guardar = within(campo.closest('.mantine-Card-root')).getByText('Guardar').closest('button');
    expect(guardar.disabled).toBe(true);
    fireEvent.change(campo, { target: { value: ' 099 123 456 ' } });
    expect(guardar.disabled).toBe(false);
    fireEvent.click(guardar);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Guardado', 'ok'));
    expect(f.de('POST', '/settings')[0].cuerpo).toEqual({ sala_numero_externo: '099 123 456' });
    resp = estado(500, { error: 'no' });
    fireEvent.change(campo, { target: { value: '1' } });
    fireEvent.click(guardar);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('no', 'bad'));
  });

  it('si no se pueden leer los ajustes arranca vacío', async () => {
    await montar(api({ 'GET /settings': estado(500) }));
    expect(await screen.findByText('Número para entrar desde afuera')).toBeTruthy();
    expect(screen.getByPlaceholderText('099 123 456').value).toBe('');
  });
});

describe('Salas · historial', () => {
  it('lista las reuniones con duración, participantes, grabación y fin estimado', async () => {
    const f = await montar(api({
      'GET /salas/directorio/historial': [
        { id: 1, inicio: '2026-10-01T10:00:00Z', fin: '2026-10-01T11:05:00Z', segundos: 3900, grabada: true, pico: 3, fin_estimado: true,
          participantes: [
            { quien: 'Ana', numero: '1001', entro: '2026-10-01T10:00:00Z', segundos: 30, moderador: true },
            { numero: '099111', quien: '099111', segundos: 125, web: true, fin_estimado: true },
            {},
          ] },
        { id: 2, inicio: '2026-10-02T10:00:00Z', fin: null, segundos: 45, participantes: [{ quien: 'Beto' }] },
        { id: 3, inicio: '2026-10-03T10:00:00Z', fin: '2026-10-03T10:00:00Z', segundos: null },
      ],
    }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'history'));
    expect(await screen.findByText(/1 h 5 min · fin estimado · 3 participantes/)).toBeTruthy();
    expect(screen.getByText(/45 s · 1 participante$/)).toBeTruthy();
    expect(screen.getByText(/0 s · 0 participantes/)).toBeTruthy();
    expect(screen.getByText('En curso')).toBeTruthy();
    expect(screen.getByText('3 a la vez')).toBeTruthy();
    expect(f.de('GET', '/salas/directorio/historial')[0].ruta).toBe('/salas/directorio/historial?limite=30');
    fireEvent.click(screen.getByText(/1 h 5 min/));
    expect(await screen.findByText(/la hora de fin es estimada/)).toBeTruthy();
    expect(screen.getByText('Moderador')).toBeTruthy();
    expect(screen.getByText('Web')).toBeTruthy();
    expect(screen.getByText('1001')).toBeTruthy();
    expect(screen.getByText('2 min (est.)')).toBeTruthy();
    expect(screen.getByText('30 s')).toBeTruthy();
  });

  it('sin reuniones lo explica; un error se avisa', async () => {
    await montar(api({ 'GET /salas/directorio/historial': estado(500, { error: 'historial roto' }) }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'history'));
    expect(await screen.findByText(/Todavía no hay reuniones registradas/)).toBeTruthy();
    await waitFor(() => expect(toast).toHaveBeenCalledWith('historial roto', 'bad'));
  });
});

describe('Salas · en vivo', () => {
  const GENTE = [
    { canal: 'PJSIP/1001-1', numero: '1001', nombre: 'Ana', moderador: true, mudo: false },
    { canal: 'PJSIP/1002-1', numero: '1002', mudo: true },
  ];

  it('muestra quién está, silencia, abre el micrófono y expulsa con confirmación', async () => {
    let accion = {};
    const f = await montar(api({
      'GET /salas/directorio/live': { participantes: GENTE, grabando: true },
      'POST /salas/directorio/mute': () => accion, 'POST /salas/directorio/kick': () => accion,
    }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'eye'));
    expect(await screen.findByText('Ana')).toBeTruthy();
    expect(screen.getByText('2 adentro')).toBeTruthy();
    expect(screen.getByText('Grabando')).toBeTruthy();
    expect(screen.getByText('Silenciado')).toBeTruthy();
    const filaAna = screen.getByText('Ana').closest('tr');
    const filaBeto = screen.getAllByText('1002')[0].closest('tr');
    fireEvent.click(botonEn(filaAna, 'microphone-off'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Micrófono silenciado', 'ok'));
    expect(f.de('POST', '/salas/directorio/mute')[0].cuerpo).toEqual({ canal: 'PJSIP/1001-1', mudo: true });
    fireEvent.click(botonEn(filaBeto, 'microphone'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Micrófono abierto', 'ok'));
    expect(f.de('POST', '/salas/directorio/mute')[1].cuerpo).toEqual({ canal: 'PJSIP/1002-1', mudo: false });
    const conf = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    fireEvent.click(botonEn(filaBeto, 'door-exit'));
    expect(conf).toHaveBeenCalledWith('¿Sacar a 1002 de la reunión?');
    expect(f.de('POST', '/salas/directorio/kick').length).toBe(0);
    fireEvent.click(botonEn(filaBeto, 'door-exit'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Se fue de la sala', 'info'));
    expect(f.de('POST', '/salas/directorio/kick')[0].cuerpo).toEqual({ canal: 'PJSIP/1002-1' });
    accion = estado(503, { error: 'Asterisk no contesta' });
    fireEvent.click(botonEn(filaAna, 'microphone-off'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Asterisk no contesta', 'bad'));
    // Actualizar ahora y Cerrar.
    const antes = f.de('GET', '/salas/directorio/live').length;
    fireEvent.click(document.querySelector('.mantine-Drawer-content .tabler-icon-refresh').closest('button'));
    await waitFor(() => expect(f.de('GET', '/salas/directorio/live').length).toBeGreaterThan(antes));
    fireEvent.click(screen.getByText('Cerrar'));
    await waitFor(() => expect(screen.queryByText('Ana')).toBeNull());
  });

  it('todos esperando al moderador se dice claro (una persona y varias)', async () => {
    let live = { participantes: [{ canal: 'c1', esperando: true, numero: '099' }] };
    await montar(api({ 'GET /salas/directorio/live': () => live }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'eye'));
    expect(await screen.findByText(/La persona que está adentro escucha música/)).toBeTruthy();
    expect(screen.getByText(/entre nadie/)).toBeTruthy();
    expect(screen.getByText('Esperando al moderador')).toBeTruthy();
    fireEvent.click(screen.getByText('Cerrar'));
    await waitFor(() => expect(screen.queryByText('Esperando al moderador')).toBeNull());
    live = { participantes: [{ canal: 'c1', esperando: true }, { canal: 'c2', esperando: true, nombre: 'Zoe' }] };
    fireEvent.click(botonEn(filaDe('Directorio'), 'eye'));
    expect(await screen.findByText(/Los 2 que están adentro escuchan música/)).toBeTruthy();
    expect(screen.getByText(/entre ellos/)).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('sin Asterisk lo avisa; sala vacía lo dice; un error se muestra', async () => {
    let live = { participantes: [], ami: false };
    await montar(api({ 'GET /salas/directorio/live': () => live }));
    fireEvent.click(botonEn(filaDe('Directorio'), 'eye'));
    expect(await screen.findByText(/No hay conexión con Asterisk/)).toBeTruthy();
    expect(screen.getByText('No hay nadie en la sala todavía.')).toBeTruthy();
    expect(screen.getByText('0 adentro')).toBeTruthy();
    fireEvent.click(screen.getByText('Cerrar'));
    await waitFor(() => expect(screen.queryByText('0 adentro')).toBeNull());
    live = estado(500, { error: 'live roto' });
    fireEvent.click(botonEn(filaDe('Directorio'), 'eye'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('live roto', 'bad'));
  });
});

describe('Salas · los cajones se cierran con Escape', () => {
  /* Cada cajón es una fila de la tabla de atrás: tiene que poder cerrarse sin buscar el
   * botón (Escape o tocar afuera), y al cerrarse deja de pedir (el en vivo encuesta cada 4 s). */
  it('alta, invitar, enlace, PIN, historial y en vivo', async () => {
    const f = await montar(api({ 'GET /salas/directorio/historial': [], 'GET /salas/directorio/live': { participantes: [] } }));
    const esc = async (titulo) => {
      expect(await screen.findByText(titulo)).toBeTruthy();
      fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByText(titulo)).toBeNull());
    };
    fireEvent.click(screen.getByText('Nueva sala'));
    await esc('Nueva sala de reunión');
    fireEvent.click(botonEn(filaDe('Directorio'), 'mail'));
    await esc('Invitar a «Directorio»');
    fireEvent.click(botonEn(filaDe('Directorio'), 'link'));
    await esc('Enlace de «Directorio»');
    fireEvent.click(botonEn(filaDe('Directorio'), 'key'));
    await esc('PIN de «Directorio»');
    fireEvent.click(botonEn(filaDe('Directorio'), 'history'));
    await esc('Historial de «Directorio»');
    fireEvent.click(botonEn(filaDe('Directorio'), 'eye'));
    await esc('En la sala «Directorio»');
    const vivos = f.de('GET', '/salas/directorio/live').length;
    await new Promise((r) => setTimeout(r, 50));
    expect(f.de('GET', '/salas/directorio/live').length).toBe(vivos);
  });
});
