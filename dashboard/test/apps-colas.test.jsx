/* Colas de atención (Aplicaciones → Colas) y el editor completo de una cola.
 *
 * Fija lo que el supervisor ve y lo que la central recibe: las colas EN VIVO salen del
 * snapshot del socket (no de un poll), su configuración se cruza por nombre para mostrar
 * REC/bienvenida/descanso, sumar o quitar un agente pega en la ruta correcta con la
 * extensión escapada, y el editor manda la cola entera (POST al crear, PUT al editar).
 * También las rutas /aplicaciones y /aplicaciones/<tab>, incluida la redirección de la
 * solapa vieja de IA, que si no caía en Colas y parecía que la pantalla había cambiado. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderNG, fetchFalso, estado, diferido } from './helpers/apps-render.jsx';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: {} }));
const notify = vi.hoisted(() => ({ toast: vi.fn() }));
const vivo = vi.hoisted(() => ({ snap: null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace: nav.replace }), useParams: () => nav.params }));
vi.mock('../app/notify', () => notify);
vi.mock('../app/useLive', () => ({ useLive: () => ({ snap: vivo.snap, connected: true }) }));
// Las otras solapas son de otras áreas: acá sólo importa que se elija la correcta.
vi.mock('../app/CrudPanel', () => ({ default: (p) => <div>crud {p.title} {p.fetchUrl} {p.deleteUrl({ name: 'x y' })}</div> }));
vi.mock('../app/SalasPanel', () => ({ default: (p) => <div>salas encabezado={String(p.conEncabezado)}</div> }));
vi.mock('../app/BuzonesPanel', () => ({ default: () => <div>buzones</div> }));
vi.mock('../app/FeatureCodes', () => ({ default: () => <div>codigos</div> }));

import QueuePanel from '../app/QueuePanel';
import QueueEditor from '../app/QueueEditor';
import AplicacionesTab from '../app/AplicacionesTab';
import Aplicaciones from '../app/aplicaciones/page';
import AplicacionesSolapa from '../app/aplicaciones/[tab]/page';

// Mantine en jsdom es lento (sobre todo con cobertura y archivos en paralelo): margen holgado.
vi.setConfig({ testTimeout: 30000 });

const LIVE = [
  { name: 'ventas', label: 'Ventas (vivo)', agents_online: 1, agents_total: 2, access_exten: '8001', strategy: 'ringall', timeout: 15, members: [{ ext: '1001', status: 'online' }, { ext: '1002', status: 'offline' }] },
  { name: 'soporte', agents_online: 0, agents_total: 0, access_exten: '8002', strategy: 'rara', timeout: 20 },
];
const CFG = [
  { name: 'ventas', label: 'Ventas', record: true, welcome_ref: 'q-ventas', welcome_text: 'Hola', wrapuptime: 10, access_exten: '8001', strategy: 'rrmemory', timeout: 25, max_wait: 120, timeout_dest: 'ext', timeout_value: '1005', maxlen: 5 },
];

const boton = (cont, icono) => [...cont.querySelectorAll('.tabler-icon-' + icono)].map((i) => i.closest('button')).find(Boolean);
const elegir = async (label, opcion) => {
  fireEvent.click(screen.getByRole('textbox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: opcion }));
};

let f;
beforeEach(() => {
  nav.replace.mockReset(); notify.toast.mockReset(); nav.params = {};
  vivo.snap = { queues: LIVE };
  f = fetchFalso({
    'GET /queues': CFG,
    'GET /voz/voices': { edge: [{ key: 'es-AR-Elena', label: 'Elena' }], installed: [{ key: 'piper-ar' }, { key: 'piper-x', label: 'Piper X' }] },
    'GET /ai-agents': [{ id: 1, name: 'Sol', exten: '9001', enabled: true }, { id: 2, name: 'Luna', exten: '9002', enabled: false }],
    'DELETE /queues/ventas': null,
    'POST /queues/ventas/members': {},
    'DELETE /queues/ventas/members/1002': null,
    'POST /queues': { name: 'nueva' },
    'PUT /queues/ventas': { name: 'ventas' },
  });
  vi.stubGlobal('fetch', f);
  vi.stubGlobal('confirm', vi.fn(() => true));
  URL.createObjectURL = vi.fn(() => 'blob:q');
  window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});

describe('QueuePanel', () => {
  it('cruza el estado en vivo con la configuración: etiqueta, insignias y resumen de desborde', async () => {
    renderNG(<QueuePanel />);
    expect(await screen.findByText('Ventas')).toBeTruthy();
    expect(screen.getByText('1/2 agentes')).toBeTruthy();
    expect(screen.getByText('REC')).toBeTruthy();
    expect(screen.getByText('Bienvenida')).toBeTruthy();
    expect(screen.getByText('10s')).toBeTruthy();
    expect(screen.getByText(/Acceso 8001 · Round-robin · timbrado 25s · espera máx 120s → ext 1005 · máx 5 en cola/)).toBeTruthy();
    // la cola sin configuración cargada muestra lo que trae el snapshot (estrategia cruda incluida)
    expect(screen.getByText('soporte')).toBeTruthy();
    expect(screen.getByText(/Acceso 8002 · rara · timbrado 20s/)).toBeTruthy();
    expect(screen.getByText('Sin agentes')).toBeTruthy();
    expect(screen.getByText('1001')).toBeTruthy();
  });

  it('sin colas en vivo lo dice; si la configuración no carga, avisa', async () => {
    vivo.snap = null;
    vi.stubGlobal('fetch', fetchFalso({ 'GET /queues': estado(500, { error: 'Base caída' }), 'GET /voz/voices': estado(500) }));
    renderNG(<QueuePanel />);
    expect(screen.getByText('Sin colas.')).toBeTruthy();
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Base caída', 'bad'));
  });

  it('suma un agente con Enter o con el botón (ignora vacío) y limpia el campo', async () => {
    renderNG(<QueuePanel />);
    await screen.findByText('Ventas');
    const [campo] = screen.getAllByPlaceholderText('Extensión (ej 1002)');
    fireEvent.click(screen.getAllByRole('button', { name: 'Agregar agente' })[0]);
    expect(f.de('POST', '/queues/ventas/members').length).toBe(0);
    fireEvent.change(campo, { target: { value: ' 1003 ' } });
    fireEvent.keyDown(campo, { key: 'a' });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Agente 1003 agregado', 'ok'));
    expect(f.de('POST', '/queues/ventas/members')[0].cuerpo).toEqual({ ext: '1003' });
    expect(campo.value).toBe('');
  });

  it('si la central rechaza el agente lo muestra y deja lo escrito', async () => {
    f = fetchFalso({ 'GET /queues': CFG, 'GET /voz/voices': {}, 'POST /queues/soporte/members': estado(404, { error: 'No existe el interno' }) });
    vi.stubGlobal('fetch', f);
    renderNG(<QueuePanel />);
    await screen.findByText('Ventas');
    const campo = screen.getAllByPlaceholderText('Extensión (ej 1002)')[1];
    fireEvent.change(campo, { target: { value: '7777' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Agregar agente' })[1]);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No existe el interno', 'bad'));
    expect(campo.value).toBe('7777');
  });

  it('quita un agente desde su pastilla, y avisa si falla', async () => {
    const { container } = renderNG(<QueuePanel />);
    await screen.findByText('Ventas');
    const quitar = container.querySelectorAll('.mantine-Pill-remove');
    fireEvent.click(quitar[1]);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Agente quitado', 'info'));
    expect(f.de('DELETE', '/queues/ventas/members/1002').length).toBe(1);
    fireEvent.click(quitar[0]);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No encontrado: DELETE /queues/ventas/members/1001', 'bad'));
  });

  it('borra una cola con confirmación y recarga la configuración; si cancela no pasa nada', async () => {
    const { container } = renderNG(<QueuePanel />);
    await screen.findByText('Ventas');
    confirm.mockReturnValueOnce(false);
    fireEvent.click(boton(container, 'trash'));
    expect(f.de('DELETE', '/queues').length).toBe(0);
    fireEvent.click(boton(container, 'trash'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('Cola eliminada', 'info'));
    await waitFor(() => expect(f.de('GET', '/queues').length).toBe(2));
    // la segunda cola no existe en la API: el 404 se muestra
    fireEvent.click([...container.querySelectorAll('.tabler-icon-trash')][1].closest('button'));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No encontrado: DELETE /queues/soporte', 'bad'));
  });

  it('abre el editor con la configuración de la cola, o sólo con el nombre si no hay', async () => {
    const { container } = renderNG(<QueuePanel />);
    await screen.findByText('Ventas');
    fireEvent.click(boton(container, 'edit'));
    expect(await screen.findByText('Cola Ventas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Cola Ventas')).toBeNull());
    fireEvent.click([...container.querySelectorAll('.tabler-icon-edit')][1].closest('button'));
    expect(await screen.findByText('Cola soporte')).toBeTruthy();
  });

  it('«Nueva cola» abre el editor vacío; al crear recarga la lista y pasa las voces de los dos motores', async () => {
    renderNG(<QueuePanel />);
    await screen.findByText('Ventas');
    fireEvent.click(screen.getByRole('button', { name: /Nueva cola/ }));
    expect(await screen.findByText('Un número que reparte las llamadas entre varios agentes')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Anuncios/ }));
    fireEvent.click(screen.getByPlaceholderText('Voz'));
    expect(await screen.findByRole('option', { name: 'Elena' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'piper-ar' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Piper X' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Crear cola/ }));
    await waitFor(() => expect(f.de('POST', '/queues').length).toBe(1));
    await waitFor(() => expect(f.de('GET', '/queues').length).toBe(2));
  });
});

describe('QueueEditor', () => {
  it('al crear manda los valores de fábrica más lo que se cargó', async () => {
    const onClose = vi.fn(); const onSaved = vi.fn();
    renderNG(<QueueEditor opened onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByRole('textbox', { name: /^Nombre/ }), { target: { value: 'ventas2' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Etiqueta/ }), { target: { value: 'Ventas 2' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Número de acceso/ }), { target: { value: '8003' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Música en espera/ }), { target: { value: 'jazz' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Timbrado del agente/ }), { target: { value: '30' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Reintento/ }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('switch', { name: /Grabar llamadas/ }));
    expect(screen.getByRole('textbox', { name: /^Valor del destino/ }).disabled).toBe(true);
    await elegir('Destino', 'Buzón de voz');
    fireEvent.change(screen.getByRole('textbox', { name: /^Valor del destino/ }), { target: { value: '1001' } });
    await elegir('Estrategia', 'Aleatoria');
    fireEvent.click(screen.getByRole('button', { name: /Crear cola/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(f.de('POST', '/queues')[0].cuerpo).toMatchObject({
      name: 'ventas2', label: 'Ventas 2', access_exten: '8003', musiconhold: 'jazz', timeout: 30, retry: 0, record: true,
      timeout_dest: 'voicemail', timeout_value: '1001', strategy: 'random', joinempty: 'yes', periodic_announce_frequency: 60,
    });
    expect(onSaved).toHaveBeenCalledWith({ name: 'nueva' });
    expect(notify.toast).toHaveBeenCalledWith('Cola Ventas 2 guardada', 'ok');
  });

  it('al editar el nombre queda fijo y guarda con PUT; un rechazo deja el cajón abierto', async () => {
    const onClose = vi.fn();
    f = fetchFalso({ 'GET /ai-agents': [], 'PUT /queues/ventas%20x': estado(400, { error: 'Acceso duplicado' }) });
    vi.stubGlobal('fetch', f);
    renderNG(<QueueEditor opened queue={{ name: 'ventas x' }} onClose={onClose} />);
    expect(screen.getByRole('textbox', { name: /^Nombre/ }).disabled).toBe(true);
    expect(screen.getByText('Cola ventas x')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios/ }));
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No se pudo guardar: Acceso duplicado', 'bad'));
    expect(f.de('PUT', '/queues/ventas%20x')[0].cuerpo).toEqual({ name: 'ventas x' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('guardar sin onSaved igual cierra', async () => {
    const onClose = vi.fn();
    renderNG(<QueueEditor opened queue={{ name: 'ventas', label: 'Ventas' }} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(notify.toast).toHaveBeenCalledWith('Cola Ventas guardada', 'ok');
  });

  it('Anuncios: escucha la bienvenida sintetizada con la voz elegida y avisa si falla', async () => {
    let n = 0;
    f = fetchFalso({ 'GET /ai-agents': [], 'POST /queues/preview-announce': () => (n++ ? estado(503, { error: 'Voz apagada' }) : new Response(new Blob(['w']), { status: 200, headers: { 'content-type': 'audio/wav' } })) });
    vi.stubGlobal('fetch', f);
    const { container } = renderNG(<QueueEditor opened queue={{ name: 'v', welcome_text: 'Hola', voice: 'es-AR' }} onClose={vi.fn()} voices={[{ value: 'es-AR', label: 'AR' }]} />);
    fireEvent.click(screen.getByRole('tab', { name: /Anuncios/ }));
    // sin texto en el periódico no se pide nada
    const [bienvenida, periodico] = [...container.ownerDocument.querySelectorAll('.tabler-icon-player-play')].map((i) => i.closest('button'));
    fireEvent.click(periodico);
    expect(f.de('POST', '/queues/preview-announce').length).toBe(0);
    await act(async () => { fireEvent.click(bienvenida); });
    await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(f.de('POST', '/queues/preview-announce')[0].cuerpo).toEqual({ text: 'Hola', voice: 'es-AR' });
    fireEvent.change(screen.getByPlaceholderText(/Todos nuestros asesores/), { target: { value: 'Espere' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Cada cuántos segundos/ }), { target: { value: '45' } });
    fireEvent.change(screen.getByPlaceholderText(/Bienvenido a Infratec/), { target: { value: 'Hola de nuevo' } });
    fireEvent.click(periodico);
    await waitFor(() => expect(notify.toast).toHaveBeenCalledWith('No se pudo generar el audio: Voz apagada', 'bad'));
    await elegir('Anunciar la posición', 'Solo hasta el límite');
    await elegir('Anunciar el tiempo de espera', 'Una sola vez');
    fireEvent.click(screen.getByPlaceholderText('Voz'));
    fireEvent.click(await screen.findByRole('option', { name: 'AR' }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios/ }));
    await waitFor(() => expect(f.llamadas.some((l) => l.metodo === 'PUT')).toBe(true));
    expect(f.de('PUT', '/queues/v')[0].cuerpo).toMatchObject({ periodic_text: 'Espere', periodic_announce_frequency: 45, welcome_text: 'Hola de nuevo', announce_position: 'limit', announce_holdtime: 'once' });
  });

  it('Avanzado: los selectores de comportamiento viajan con su valor de Asterisk', async () => {
    renderNG(<QueueEditor opened queue={{ name: 'ventas' }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Avanzado/ }));
    await elegir('Entrar a la cola cuando no hay agentes', 'Estricto: tampoco si están todos en pausa');
    await elegir('Pausar al agente que no atiende', 'Sí, en todas sus colas');
    fireEvent.change(screen.getByRole('textbox', { name: /^SLA objetivo/ }), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios/ }));
    await waitFor(() => expect(f.de('PUT', '/queues/ventas').length).toBe(1));
    expect(f.de('PUT', '/queues/ventas')[0].cuerpo).toMatchObject({ joinempty: 'strict', autopause: 'all', servicelevel: 20 });
  });

  it('Agente IA: mientras busca lo dice; elige agente, modo, tope de simultáneas y a quién escalar', async () => {
    const d = diferido();
    f = fetchFalso({ 'GET /ai-agents': () => d.promise, 'PUT /queues/ventas': {} });
    vi.stubGlobal('fetch', f);
    renderNG(<QueueEditor opened queue={{ name: 'ventas', ia_agente_id: 2 }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Agente IA/ }));
    expect(screen.getByText('Buscando agentes…')).toBeTruthy();
    await act(async () => { d.resolve([{ id: 1, name: 'Sol', exten: '9001', enabled: true }, { id: 2, name: 'Luna', exten: '9002', enabled: false }]); });
    expect(await screen.findByDisplayValue('Luna (9002) · deshabilitado')).toBeTruthy();
    await elegir('Agente', 'Sol (9001)');
    await elegir('Modo', /Desborde/);
    fireEvent.change(screen.getByRole('textbox', { name: /^Llamadas simultáneas/ }), { target: { value: '50' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Escalar a/ }), { target: { value: '1001' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios/ }));
    await waitFor(() => expect(f.de('PUT', '/queues/ventas').length).toBe(1));
    // el tope de simultáneas es también el tope de gasto: nunca más de 10
    expect(f.de('PUT', '/queues/ventas')[0].cuerpo).toMatchObject({ ia_agente_id: 1, ia_modo: 'desborde', ia_simultaneas: 10, ia_escalar_a: '1001' });
  });

  it('Agente IA: limpiar el agente lo deja en null, y con 0 simultáneas queda en 1', async () => {
    renderNG(<QueueEditor opened queue={{ name: 'ventas', ia_agente_id: 1 }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Agente IA/ }));
    await screen.findByDisplayValue('Sol (9001)');
    const limpiar = document.querySelector('.mantine-CloseButton-root, .mantine-Input-section button');
    fireEvent.click(limpiar);
    fireEvent.change(screen.getByRole('textbox', { name: /^Llamadas simultáneas/ }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios/ }));
    await waitFor(() => expect(f.de('PUT', '/queues/ventas').length).toBe(1));
    expect(f.de('PUT', '/queues/ventas')[0].cuerpo).toMatchObject({ ia_agente_id: null, ia_simultaneas: 1 });
  });

  it('Agente IA: sin agentes (o si la lista falla) explica dónde se crean', async () => {
    vi.stubGlobal('fetch', fetchFalso({ 'GET /ai-agents': estado(500) }));
    renderNG(<QueueEditor opened queue={{ name: 'x' }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Agente IA/ }));
    expect(await screen.findByText(/Todavía no hay ningún agente de IA/)).toBeTruthy();
  });

  it('Agente IA: una respuesta que no es lista también cuenta como «sin agentes»', async () => {
    vi.stubGlobal('fetch', fetchFalso({ 'GET /ai-agents': { error: 'raro' } }));
    renderNG(<QueueEditor opened queue={{ name: 'x' }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Agente IA/ }));
    expect(await screen.findByText(/Todavía no hay ningún agente de IA/)).toBeTruthy();
  });

  it('cerrado no pide agentes; si se cierra antes de que lleguen no los pisa', async () => {
    const d = diferido();
    f = fetchFalso({ 'GET /ai-agents': () => d.promise });
    vi.stubGlobal('fetch', f);
    const { rerender } = renderNG(<QueueEditor opened={false} onClose={vi.fn()} />);
    expect(f.llamadas.length).toBe(0);
    rerender(<QueueEditor opened onClose={vi.fn()} />);
    expect(f.de('GET', '/ai-agents').length).toBe(1);
    rerender(<QueueEditor opened={false} onClose={vi.fn()} />);
    await act(async () => { d.reject(new Error('tarde')); });
    expect(notify.toast).not.toHaveBeenCalled();
  });

  it('si el agente llega después de cerrar, se descarta', async () => {
    const d = diferido();
    vi.stubGlobal('fetch', fetchFalso({ 'GET /ai-agents': () => d.promise }));
    const { rerender } = renderNG(<QueueEditor opened onClose={vi.fn()} />);
    rerender(<QueueEditor opened={false} onClose={vi.fn()} />);
    await act(async () => { d.resolve([{ id: 1, name: 'A', exten: '1', enabled: true }]); });
    rerender(<QueueEditor opened onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Agente IA/ }));
    expect(screen.getByText('Buscando agentes…')).toBeTruthy();
  });
});

describe('Aplicaciones (rutas y solapas)', () => {
  it('/aplicaciones muestra Colas', async () => {
    renderNG(<Aplicaciones />);
    expect(await screen.findByText('Ventas')).toBeTruthy();
  });

  it('cada clave de solapa monta su pantalla, y una desconocida cae en Colas', () => {
    const casos = [['rg', 'crud Ring Groups /ringgroups /ringgroups/x y'], ['paging', 'crud Paging / Intercom /paging /paging/x y'], ['conf', 'salas encabezado=false'], ['vm', 'buzones'], ['codes', 'codigos']];
    for (const [tab, texto] of casos) {
      const { unmount } = renderNG(<AplicacionesTab tab={tab} />);
      expect(screen.getByText(texto)).toBeTruthy();
      unmount();
    }
    renderNG(<AplicacionesTab tab="cualquiera" />);
    expect(screen.getByRole('button', { name: /Nueva cola/ })).toBeTruthy();
  });

  it('/aplicaciones/ai redirige a IA & Voz sin pintar Colas; las demás pintan su solapa', () => {
    nav.params = { tab: 'ai' };
    const { unmount } = renderNG(<AplicacionesSolapa />);
    expect(nav.replace).toHaveBeenCalledWith('/ia-voz');
    expect(screen.queryByRole('button', { name: /Nueva cola/ })).toBeNull();
    unmount();
    nav.params = { tab: 'vm' };
    renderNG(<AplicacionesSolapa />);
    expect(screen.getByText('buzones')).toBeTruthy();
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });
});
