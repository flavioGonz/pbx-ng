/* ============================================================================
 *  Red, TURN e inventario: modo router/switch, placas del núcleo con su diagnóstico,
 *  origen del TURN y su sonda, consola del coturn, registro de seguridad en vivo y la
 *  pantalla de Sistema.
 *
 *  Lo que se fija: que un cambio de red se muestre ANTES de aplicarse y quede con su
 *  reloj de rollback (si el operador pierde el panel, la central vuelve sola); que lo
 *  medido no se confunda con lo pedido (un TURN que no entrega relay sale en rojo con el
 *  motivo, y un 409 del PUT no cambia nada pero ofrece «cambiar igual»); que una caída
 *  de agente se avise una sola vez y no un toast por vuelta de encuesta; y que el
 *  inventario no presente como propios los números de la máquina de abajo.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { renderUI, fakeFetch, res, RED_CAIDA } from './helpers/sistema-render.jsx';

const promesas = [];
vi.mock('../app/notify', () => ({
  toast: vi.fn(),
  toastPromise: vi.fn((p, o) => {
    const fin = Promise.resolve(p).then(
      (d) => promesas.push(['ok', typeof o.success === 'function' ? o.success(d) : o.success]),
      (e) => promesas.push(['error', typeof o.error === 'function' ? o.error(e) : o.error]));
    return fin;
  }),
}));
const live = { snap: null, connected: false, socket: null };
vi.mock('../app/useLive', () => ({ useLive: () => live, getSocket: () => live.socket, useEstados: () => ({}) }));
vi.mock('../app/RoutesPanel', () => ({ default: ({ scope }) => <div>rutas de {scope}</div> }));
vi.mock('../app/Slot', () => ({ default: ({ value }) => <span>{value}</span> }));
vi.mock('../app/iceProbe', () => ({ fetchIceServers: vi.fn(), probeIce: vi.fn() }));

import { toast } from '../app/notify';
import { fetchIceServers, probeIce } from '../app/iceProbe';
import LiveLog from '../app/LiveLog.jsx';
import TurnConsole from '../app/TurnConsole.jsx';
import NetMode from '../app/NetMode.jsx';
import AstNet from '../app/AstNet.jsx';
import TurnOrigen from '../app/TurnOrigen.jsx';
import SystemOverview from '../app/SystemOverview.jsx';
import Sistema from '../app/sistema/page.jsx';
import Red from '../app/red/page.jsx';

// Pantallas pesadas: con cobertura y suites en paralelo, 5 s no siempre alcanzan.
vi.setConfig({ testTimeout: 20000 });

const toasts = () => toast.mock.calls.map((c) => [c[0], c[1]]);

function socketFalso(conectado = true) {
  const h = {};
  const s = {
    connected: conectado,
    emitidos: [],
    on: (ev, fn) => { (h[ev] = h[ev] || []).push(fn); },
    off: (ev, fn) => { h[ev] = (h[ev] || []).filter((x) => x !== fn); },
    emit: (ev, d) => s.emitidos.push([ev, d]),
    disparar: (ev, d) => act(() => { (h[ev] || []).slice().forEach((fn) => fn(d)); }),
    oyentes: (ev) => (h[ev] || []).length,
  };
  return s;
}

beforeEach(() => { toast.mockClear(); promesas.length = 0; live.snap = null; live.connected = false; live.socket = null; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('LiveLog — registro de seguridad en vivo', () => {
  it('sin socket (sin sesión) queda escuchando sin romper', () => {
    renderUI(<LiveLog />);
    expect(screen.getByText('conectando…')).toBeTruthy();
    expect(screen.getByText('Escuchando la central…')).toBeTruthy();
  });

  it('entra a la sala, pinta historial y eventos, filtra, pausa y sale al desmontar', async () => {
    const s = socketFalso(true);
    live.socket = s;
    const { unmount } = renderUI(<LiveLog />);
    expect(s.emitidos).toContainEqual(['sec:join', undefined]);
    expect(screen.getByText('en vivo')).toBeTruthy();
    s.disparar('sec:hist', 'no es array');
    s.disparar('sec:hist', [
      { t: 1, tipo: 'auth', sev: 'warn', ip: '1.2.3.4', cuenta: '1001', texto: 'clave errada' },
      { t: 2, tipo: 'ban', sev: 'crit', ip: '5.6.7.8', texto: 'bloqueada' },
    ]);
    expect(screen.getByText('clave errada')).toBeTruthy();
    expect(screen.getByText('1001')).toBeTruthy();
    expect(screen.getByText(/2 eventos/)).toBeTruthy();
    s.disparar('sec:ev', { t: 3, tipo: 'ok', sev: 'info', texto: 'registro correcto' });
    s.disparar('sec:ev', { t: 4, tipo: 'raro', texto: 'tipo desconocido' });
    s.disparar('sec:ev', null);
    expect(screen.getByText('registro correcto')).toBeTruthy();
    expect(screen.getByText('raro')).toBeTruthy();
    // Filtro por tipo: sólo bans; otro clic en la misma pastilla lo saca.
    fireEvent.click(screen.getByText('Bans'));
    expect(screen.queryByText('clave errada')).toBeNull();
    expect(screen.getByText('bloqueada')).toBeTruthy();
    fireEvent.click(screen.getByText('Bans'));
    expect(screen.getByText('clave errada')).toBeTruthy();
    fireEvent.click(screen.getByText('Flood'));
    expect(screen.getByText('Sin eventos de este tipo.')).toBeTruthy();
    fireEvent.click(screen.getByText('Todos'));
    // Pausa: lo que llega mientras tanto no se agrega.
    const [pausa, limpiar] = screen.getAllByRole('button').filter((b) => !b.textContent);
    fireEvent.click(pausa);
    s.disparar('sec:ev', { t: 5, tipo: 'acl', texto: 'en pausa' });
    expect(screen.queryByText('en pausa')).toBeNull();
    fireEvent.click(pausa);
    s.disparar('sec:ev', { t: 6, tipo: 'acl', texto: 'de nuevo' });
    expect(screen.getByText('de nuevo')).toBeTruthy();
    fireEvent.click(limpiar);
    expect(screen.getByText(/0 eventos/)).toBeTruthy();
    // Desconexión y reconexión: vuelve a pedir la sala.
    s.disparar('disconnect');
    expect(screen.getByText('conectando…')).toBeTruthy();
    s.disparar('connect');
    expect(s.emitidos.filter((e) => e[0] === 'sec:join')).toHaveLength(2);
    unmount();
    expect(s.emitidos).toContainEqual(['sec:leave', undefined]);
    expect(s.oyentes('sec:ev')).toBe(0);
  });

  it('si el socket no estaba conectado, no pide la sala hasta conectar ni sale al desmontar', () => {
    const s = socketFalso(false);
    live.socket = s;
    const { unmount } = renderUI(<LiveLog />);
    expect(s.emitidos).toEqual([]);
    s.disparar('sec:ev', { t: 1, tipo: 'geo', sev: 'warn', texto: 'país vetado' });
    expect(screen.getByText(/1 evento$/)).toBeTruthy();
    unmount();
    expect(s.emitidos).toEqual([]);
  });
});

describe('TurnConsole — consola del coturn', () => {
  const TURN = { active: 'active', tls: true, dtls: false, realm: 'pbx.x', listening_port: 3478, min_port: 49152, max_port: 65535, external_ip: '1.2.3.4', user_name: 'pbx', metrics: { load: 0.2, mem_used_mb: 50, mem_total_mb: 512 }, sessions: [{ id: 's1', user: 'pbx', realm: 'pbx.x', proto: 'UDP', addr: '9.9.9.9:5000' }, { id: 's2' }] };

  it('muestra el estado, la sonda ICE con relay, y guarda la configuración sin pisar la clave', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchIceServers.mockResolvedValue([{ urls: 'turn:x', username: 'u' }]);
    probeIce.mockResolvedValue({ state: 'ok', host: 2, srflx: 1, relay: 1, publicIp: '1.2.3.4', relayIp: '1.2.3.4', errors: [] });
    const f = fakeFetch({ 'GET /turn': TURN, 'POST /turn/config': { ok: true } });
    renderUI(<TurnConsole />);
    expect(screen.getByText('Cargando estado de Turn-NG…')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Turn-NG Server')).toBeTruthy());
    expect(screen.getByText('Operativo')).toBeTruthy();
    expect(screen.getByText('TLS: sí')).toBeTruthy();
    expect(screen.getByText('DTLS: no')).toBeTruthy();
    expect(screen.getByText('9.9.9.9:5000')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('TURN alcanzable y autenticado')).toBeTruthy());
    expect(screen.getAllByText('1 ✓')).toHaveLength(2);   // relay y srflx
    expect(screen.getByLabelText('Realm').value).toBe('pbx.x');
    fireEvent.change(screen.getByLabelText('Realm'), { target: { value: 'otro.x' } });
    fireEvent.change(screen.getByLabelText('IP externa'), { target: { value: '5.5.5.5' } });
    fireEvent.change(screen.getByLabelText('Usuario TURN'), { target: { value: 'nuevo' } });
    fireEvent.change(screen.getByLabelText('Puerto de señalización'), { target: { value: '3479' } });
    fireEvent.change(screen.getByLabelText('Relay puerto mínimo'), { target: { value: '40000' } });
    fireEvent.change(screen.getByLabelText('Relay puerto máximo'), { target: { value: '41000' } });
    fireEvent.click(screen.getByText('Guardar y aplicar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Configuración aplicada (Turn-NG reiniciado)', 'ok']));
    expect(f.a('POST', '/turn/config')[0].body).toEqual({ realm: 'otro.x', listening_port: '3479', min_port: '40000', max_port: '41000', external_ip: '5.5.5.5', user_name: 'nuevo' });
    // Con clave: se manda y el aviso recuerda recargar los softphones; después se vacía.
    fireEvent.change(screen.getByLabelText('Contraseña TURN'), { target: { value: 'clave' } });
    fireEvent.click(screen.getByText('Guardar y aplicar'));
    await waitFor(() => expect(f.a('POST', '/turn/config')).toHaveLength(2));
    expect(f.a('POST', '/turn/config')[1].body.user_password).toBe('clave');
    await waitFor(() => expect(toasts().some((t) => /recargar los softphones/.test(t[0]))).toBe(true));
    expect(screen.getByLabelText('Contraseña TURN').value).toBe('');
    const n = f.a('GET', '/turn').length;
    await act(async () => { vi.advanceTimersByTime(900); });
    await waitFor(() => expect(f.a('GET', '/turn').length).toBeGreaterThan(n));
  });

  it('reiniciar, probar y ver logs muestran lo que contestó el agente, y sus errores', async () => {
    fetchIceServers.mockResolvedValue([]);
    let falla = false;
    fakeFetch({
      'GET /turn': { active: 'failed' },
      'POST /turn/restart': () => (falla ? res(500, { error: 'no reinicia' }) : { ok: false }),
      'POST /turn/test': () => (falla ? res(502, {}) : { ok: true, code: 0 }),
      'GET /turn/logs': () => (falla ? res(500, { error: 'sin logs' }) : { log: 'linea de log' }),
      'POST /turn/config': res(400, { error: 'puerto inválido' }),
    });
    renderUI(<TurnConsole />);
    await waitFor(() => expect(screen.getByText('Caído')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Error en la sonda')).toBeTruthy());
    expect(screen.getByText('El backend no devolvió servidores ICE (/api/ice)')).toBeTruthy();
    expect(screen.getByText('No hay sesiones TURN activas en este momento.')).toBeTruthy();
    fireEvent.click(screen.getByText('Reiniciar Turn-NG'));
    await waitFor(() => expect(toasts()).toContainEqual(['No se pudo reiniciar', 'bad']));
    fireEvent.click(screen.getByText('Probar TURN'));
    await waitFor(() => expect(screen.getByText('{"ok":true,"code":0}')).toBeTruthy());
    fireEvent.click(screen.getByText('Ver logs'));
    await waitFor(() => expect(screen.getByText('linea de log')).toBeTruthy());
    fireEvent.click(screen.getByText('Guardar y aplicar'));
    await waitFor(() => expect(toasts()).toContainEqual(['No se pudo guardar: puerto inválido', 'bad']));
    falla = true;
    fireEvent.click(screen.getByText('Reiniciar Turn-NG'));
    await waitFor(() => expect(toasts()).toContainEqual(['no reinicia', 'bad']));
    fireEvent.click(screen.getByText('Probar TURN'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error del servidor', 'bad']));
    expect(screen.getByText('Error del servidor')).toBeTruthy();
    fireEvent.click(screen.getByText('Ver logs'));
    await waitFor(() => expect(toasts()).toContainEqual(['sin logs', 'bad']));
  });

  it('cada veredicto de la sonda ICE tiene su título y su explicación', async () => {
    fetchIceServers.mockResolvedValue([{ urls: 'stun:x' }]);
    const casos = [
      [{ state: 'turn-auth', host: 1, srflx: 0, relay: 0, errors: ['401 Unauthorized'] }, 'Credenciales rechazadas (401)', 'el coturn contestó pero rechazó usuario/clave'],
      [{ state: 'turn-unreachable', host: 1, srflx: 2, relay: 0, errors: [] }, 'TURN no responde', /ningún candidato relay/],
      [{ state: 'no-turn', srflx: 0, relay: 0 }, 'Sin TURN configurado', /sonda ICE real/],
      [{ state: 'raro' }, 'Sin probar', /sonda ICE real/],
    ];
    fakeFetch({ 'GET /turn': TURN });
    for (const [r, titulo, sub] of casos) {
      probeIce.mockResolvedValueOnce(r);
      const { unmount } = renderUI(<TurnConsole />);
      await waitFor(() => expect(screen.getByText(titulo)).toBeTruthy());
      expect(screen.getByText(sub)).toBeTruthy();
      unmount();
    }
    // «Probar ahora» vuelve a correr la sonda y mientras tanto dice «Probando…».
    let soltar;
    probeIce.mockResolvedValueOnce({ state: 'ok', relay: 1, srflx: 1, host: 1 });
    renderUI(<TurnConsole />);
    await waitFor(() => expect(screen.getByText('TURN alcanzable y autenticado')).toBeTruthy());
    probeIce.mockImplementationOnce(() => new Promise((r) => { soltar = r; }));
    fireEvent.click(screen.getByText('Probar ahora'));
    await waitFor(() => expect(screen.getByText('Probando…')).toBeTruthy());
    expect(screen.getAllByText('…').length).toBe(2);
    await act(async () => { soltar({ state: 'no-turn', relay: 0, srflx: 0 }); });
    await waitFor(() => expect(screen.getByText('Sin TURN configurado')).toBeTruthy());
  });

  it('si el agente TURN no contesta, lo dice en vez de quedar cargando', async () => {
    fetchIceServers.mockResolvedValue([]);
    fakeFetch({ 'GET /turn': res(502, {}) });
    renderUI(<TurnConsole />);
    await waitFor(() => expect(screen.getByText(/No se pudo contactar el agente TURN/)).toBeTruthy());
  });

  it('el botón de refrescar relee el estado', async () => {
    fetchIceServers.mockResolvedValue([]);
    const f = fakeFetch({ 'GET /turn': { active: 'active' } });
    renderUI(<TurnConsole />);
    await waitFor(() => expect(screen.getByText('Operativo')).toBeTruthy());
    fireEvent.click(screen.getByText('Operativo').closest('.mantine-Group-root').querySelector('button'));
    await waitFor(() => expect(f.a('GET', '/turn')).toHaveLength(2));
    expect(screen.getAllByText('-').length).toBeGreaterThan(2);
  });
});

describe('NetMode — modo router/switch con rollback', () => {
  const MODO = { cfg: { modo: 'router', wan_if: 'eth0', lan_if: 'eth1', nat: true, forward: false }, interfaces: [{ name: 'eth0' }, { dev: 'eth1' }, {}] };

  it('muestra el modo actual, deja elegir placas y ver el plan antes de aplicar', async () => {
    const f = fakeFetch({ 'GET /net/mode': MODO, 'POST /net/mode/plan': { pasos: [{ desc: 'Activar NAT', texto: 'nft add ...' }] }, 'PUT /net/mode': { ok: true } });
    renderUI(<NetMode />);
    expect(screen.getByText('Cargando red…')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('ROUTER')).toBeTruthy());
    expect(screen.getByText('WAN eth0')).toBeTruthy();
    expect(screen.getByText('NAT')).toBeTruthy();
    // Interruptores de NAT y forward cambian la configuración que se guarda.
    fireEvent.click(screen.getByRole('switch', { name: /NAT/ }));
    fireEvent.click(screen.getByRole('switch', { name: /ip_forward/ }));
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Guardado (todavía no se aplicó)']));
    expect(f.a('PUT', '/net/mode')[0].body).toMatchObject({ modo: 'router', nat: false, forward: true });
    fireEvent.click(screen.getByText('Ver el plan'));
    await waitFor(() => expect(screen.getByText('Lo que se va a ejecutar')).toBeTruthy());
    expect(screen.getByText('nft add ...')).toBeTruthy();
    // Elegir la placa LAN desde el desplegable.
    fireEvent.click(screen.getAllByLabelText('Placa LAN (hacia la red interna)')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'eth0' }));
    fireEvent.click(screen.getAllByLabelText('Placa WAN (hacia internet)')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'eth1' }));
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(f.a('PUT', '/net/mode')).toHaveLength(2));
    expect(f.a('PUT', '/net/mode')[1].body).toMatchObject({ wan_if: 'eth1', lan_if: 'eth0' });
  });

  it('pasar a switch explica el puente; un plan vacío dice «Sin pasos»', async () => {
    fakeFetch({ 'GET /net/mode': { cfg: { modo: 'router' } }, 'POST /net/mode/plan': {} });
    renderUI(<NetMode />);
    await waitFor(() => expect(screen.getByText('ROUTER')).toBeTruthy());
    expect(screen.getByText('WAN ?')).toBeTruthy();
    fireEvent.click(screen.getByText('Switch'));
    expect(screen.getByText('SWITCH')).toBeTruthy();
    expect(screen.getByText('br0')).toBeTruthy();
    expect(screen.getByText('switch (puente)')).toBeTruthy();
    fireEvent.click(screen.getByText('Ver el plan'));
    await waitFor(() => expect(screen.getByText('Sin pasos.')).toBeTruthy());
    fireEvent.click(screen.getByText('Router'));
    expect(screen.getByText('ROUTER')).toBeTruthy();
  });

  it('aplicar abre la confirmación con el plan; cancelar NO deja abierto el cajón del plan', async () => {
    const f = fakeFetch({ 'GET /net/mode': MODO, 'POST /net/mode/plan': { pasos: [{ desc: 'Paso 1', texto: 'ip link' }] } });
    renderUI(<NetMode />);
    await waitFor(() => expect(screen.getByText('ROUTER')).toBeTruthy());
    fireEvent.click(screen.getByText('Aplicar modo'));
    await waitFor(() => expect(screen.getByText('Se van a ejecutar 1 paso(s)')).toBeTruthy());
    expect(screen.getByText('Aplicar modo ROUTER')).toBeTruthy();
    expect(screen.getByText('Con NAT (enmascara la LAN al salir) · sin ruteo entre placas')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByText('Aplicar modo ROUTER')).toBeNull());
    expect(screen.queryByText('Lo que se va a ejecutar')).toBeNull();
    expect(f.a('POST', '/net/mode/apply')).toHaveLength(0);
  });

  it('si no se puede traer el plan, avisa y no deja el modal abierto a ciegas', async () => {
    fakeFetch({ 'GET /net/mode': { cfg: { modo: 'switch', bridge: 'br9' } }, 'POST /net/mode/plan': res(500, { error: 'agente caído' }) });
    renderUI(<NetMode />);
    await waitFor(() => expect(screen.getByText('SWITCH')).toBeTruthy());
    fireEvent.click(screen.getByText('Aplicar modo'));
    await waitFor(() => expect(toasts()).toContainEqual(['agente caído', 'bad']));
    await waitFor(() => expect(screen.queryByText('Aplicar modo SWITCH')).toBeNull());
    fireEvent.click(screen.getByText('Ver el plan'));
    await waitFor(() => expect(toasts().filter((t) => t[0] === 'agente caído')).toHaveLength(2));
  });

  it('aplicar arranca el reloj de rollback; confirmar lo deja fijo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ahora = Date.now();
    let pendiente = null;
    const f = fakeFetch({
      'GET /net/mode': () => ({ cfg: { modo: 'switch' }, pendiente }),
      'POST /net/mode/plan': { pasos: [{ desc: 'Puente', texto: 'ip link add br0' }] },
      'POST /net/mode/apply': () => { pendiente = { vence: ahora + 120000 }; return { confirmar_antes_de: ahora + 120000 }; },
      'POST /net/mode/confirm': () => { pendiente = null; return { ok: true }; },
    });
    renderUI(<NetMode />);
    await waitFor(() => expect(screen.getByText('SWITCH')).toBeTruthy());
    fireEvent.click(screen.getByText('Aplicar modo'));
    await waitFor(() => expect(screen.getByText('Puente en capa 2 (br0)')).toBeTruthy());
    fireEvent.click(screen.getByText('Aplicar modo switch'));
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Aplicado: confirmá antes de que venza el plazo']));
    expect(f.a('POST', '/net/mode/apply')[0].body).toEqual({ confirmar: true, cfg: { modo: 'switch' }, rollback_seg: 120 });
    await waitFor(() => expect(screen.getByText('Cambio aplicado, falta confirmar')).toBeTruthy());
    expect(screen.queryByText('Lo que se va a ejecutar')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/1[01]\d s/)).toBeTruthy();
    expect(screen.getByText('Aplicar modo').closest('button').disabled).toBe(true);
    fireEvent.click(screen.getByText('Confirmar'));
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Confirmado: el modo quedó fijo']));
    await waitFor(() => expect(screen.queryByText('Cambio aplicado, falta confirmar')).toBeNull());
  });

  it('volver atrás revierte; si vence el plazo sin confirmar, relee el modo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ahora = Date.now();
    let pendiente = { vence: ahora + 2000 };
    const f = fakeFetch({
      'GET /net/mode': () => ({ cfg: { modo: 'router' }, pendiente }),
      'POST /net/mode/revert': res(500, { error: 'no pudo volver' }),
    });
    renderUI(<NetMode />);
    await waitFor(() => expect(screen.getByText('Cambio aplicado, falta confirmar')).toBeTruthy());
    fireEvent.click(screen.getByText('Volver atrás'));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'no pudo volver']));
    pendiente = null;
    const n = f.a('GET', '/net/mode').length;
    await act(async () => { vi.advanceTimersByTime(3000); });
    await waitFor(() => expect(f.a('GET', '/net/mode').length).toBeGreaterThan(n));
    await waitFor(() => expect(screen.queryByText('Cambio aplicado, falta confirmar')).toBeNull());
  });

  it('los fallos de guardar, aplicar y confirmar se muestran con el mensaje de la API; Escape cierra el plan', async () => {
    let pendiente = null;
    fakeFetch({
      'GET /net/mode': () => ({ cfg: { modo: 'router' }, pendiente }),
      'PUT /net/mode': res(400, { error: 'placa inexistente' }),
      'POST /net/mode/plan': { pasos: [{ desc: 'x', texto: 'y' }] },
      'POST /net/mode/apply': res(409, { error: 'ya hay un cambio pendiente' }),
      'POST /net/mode/confirm': res(410, { error: 'el plazo venció' }),
    });
    const { unmount } = renderUI(<NetMode />);
    await waitFor(() => expect(screen.getByText('ROUTER')).toBeTruthy());
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'placa inexistente']));
    fireEvent.click(screen.getByText('Ver el plan'));
    await waitFor(() => expect(screen.getByText('Lo que se va a ejecutar')).toBeTruthy());
    fireEvent.keyDown(screen.getByText('Lo que se va a ejecutar'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Lo que se va a ejecutar')).toBeNull());
    fireEvent.click(screen.getByText('Aplicar modo'));
    await waitFor(() => expect(screen.getByText('Aplicar modo router')).toBeTruthy());
    fireEvent.keyDown(screen.getByText('Aplicar modo router'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Aplicar modo router')).toBeNull());
    fireEvent.click(screen.getByText('Aplicar modo'));
    await waitFor(() => expect(screen.getByText('Aplicar modo router')).toBeTruthy());
    fireEvent.click(screen.getByText('Aplicar modo router'));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'ya hay un cambio pendiente']));
    unmount();
    pendiente = { vence: Date.now() + 60000 };
    renderUI(<NetMode />);
    await waitFor(() => expect(screen.getByText('Confirmar')).toBeTruthy());
    fireEvent.click(screen.getByText('Confirmar'));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'el plazo venció']));
  });

  it('volver atrás que anda saca el aviso; si la carga falla, lo avisa', async () => {
    let pendiente = { vence: Date.now() + 60000 };
    fakeFetch({ 'GET /net/mode': () => ({ cfg: { modo: 'router' }, pendiente }), 'POST /net/mode/revert': () => { pendiente = null; return { ok: true }; } });
    const { unmount } = renderUI(<NetMode />);
    await waitFor(() => expect(screen.getByText('Cambio aplicado, falta confirmar')).toBeTruthy());
    fireEvent.click(screen.getByText('Volver atrás'));
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Se volvió al modo anterior']));
    await waitFor(() => expect(screen.queryByText('Cambio aplicado, falta confirmar')).toBeNull());
    unmount();
    fakeFetch({ 'GET /net/mode': res(403, {}) });
    renderUI(<NetMode />);
    await waitFor(() => expect(toasts()).toContainEqual(['No tenés permiso para esta acción', 'bad']));
  });
});

describe('AstNet — placas del núcleo y diagnóstico', () => {
  const NET = {
    ifaces: [
      { name: 'eth0', state: 'UP', addrs: ['10.0.0.5/24', 'fe80::1'] },
      { name: 'eth1', state: 'DOWN', addrs: [] },
      { name: 'eth2', state: 'UP', addrs: ['fe80::2'] },
      { name: 'eth3' },
    ],
    kernel_routes: ['default via 10.0.0.1 dev eth0', 'default via 10.0.0.1 dev eth0', '10.0.0.0/24 dev eth0'],
  };

  it('dibuja el switch con las placas y su enlace, y la lista con sus direcciones', async () => {
    fakeFetch({ 'GET /asterisk/net': NET });
    const { container } = renderUI(<AstNet />);
    await waitFor(() => expect(screen.getByText('2/4 con enlace')).toBeTruthy());
    expect(screen.getByText('rutas de asterisk')).toBeTruthy();
    expect(screen.getAllByText('10.0.0.5/24').length).toBe(1);
    expect(screen.getByText('10.0.0.5')).toBeTruthy();       // IP primaria en el dibujo
    expect(screen.getAllByText('sin dirección').length).toBe(2);
    expect(screen.getAllByText('DOWN').length).toBe(3);   // eth1 en dibujo y tarjeta, eth3 (sin estado) en el dibujo
    // Seleccionar un puerto en el dibujo y deseleccionarlo.
    const puertos = container.querySelectorAll('svg g[transform]');
    fireEvent.click(puertos[0]);
    expect(container.querySelector('svg rect[opacity=".14"]')).toBeTruthy();
    fireEvent.click(puertos[0]);
    expect(container.querySelector('svg rect[opacity=".14"]')).toBeNull();
    fireEvent.click(screen.getByText('eth1', { selector: 'p' }).closest('.mantine-Card-root'));
    expect(container.querySelector('svg rect[opacity=".14"]')).toBeTruthy();
    // La ruta por defecto aparece como atajo del diagnóstico (una sola vez).
    expect(screen.getAllByText('10.0.0.1')).toHaveLength(1);
  });

  it('sin datos del agente lo dice, y avisa la caída una sola vez por más que siga fallando', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let falla = true;
    const f = fakeFetch({ 'GET /asterisk/net': () => (falla ? res(502, { error: 'agente caído' }) : { ifaces: [] }) });
    renderUI(<AstNet />);
    await waitFor(() => expect(toasts()).toContainEqual(['agente caído', 'bad']));
    expect(screen.getByText('Sin datos del agente (CT:8092).')).toBeTruthy();
    expect(screen.getByText('0/0 con enlace')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(30000); });
    await waitFor(() => expect(f.a('GET', '/asterisk/net')).toHaveLength(2));
    expect(toasts().filter((t) => t[0] === 'agente caído')).toHaveLength(1);
    falla = false;
    await act(async () => { vi.advanceTimersByTime(30000); });
    await waitFor(() => expect(f.a('GET', '/asterisk/net')).toHaveLength(3));
    falla = true;
    await act(async () => { vi.advanceTimersByTime(30000); });
    await waitFor(() => expect(toasts().filter((t) => t[0] === 'agente caído')).toHaveLength(2));
  });

  it('cambiar IP valida el CIDR, agrega o reemplaza en caliente y avisa errores', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let falla = false;
    const f = fakeFetch({ 'GET /asterisk/net': NET, 'POST /asterisk/iface': () => (falla ? res(500, { error: 'ip ocupada' }) : { ok: true }) });
    renderUI(<AstNet />);
    await waitFor(() => expect(screen.getByText('2/4 con enlace')).toBeTruthy());
    const tarjeta = screen.getByText('eth0', { selector: 'p' }).closest('.mantine-Card-root');
    fireEvent.click(within(tarjeta).getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Cambiar IP · eth0')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Nueva IP / CIDR'), { target: { value: '10.0.0.9' } });
    fireEvent.click(screen.getByText('Aplicar'));
    expect(toasts()).toContainEqual(['Escribí una IP/CIDR válida (ej 192.168.1.50/24)', 'bad']);
    expect(f.a('POST', '/asterisk/iface')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Nueva IP / CIDR'), { target: { value: ' 10.0.0.9/24 ' } });
    expect(screen.getByText(/Se AGREGA la IP como secundaria/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: /Reemplazar la IP actual/ }));
    expect(screen.getByText(/Vas a BORRAR las IP actuales/)).toBeTruthy();
    falla = true;
    fireEvent.click(screen.getByText('Aplicar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error: ip ocupada', 'bad']));
    falla = false;
    fireEvent.click(screen.getByText('Aplicar'));
    await waitFor(() => expect(toasts()).toContainEqual(['IP aplicada en eth0 (en caliente)', 'ok']));
    expect(f.a('POST', '/asterisk/iface')[1].body).toEqual({ action: 'replace', dev: 'eth0', cidr: '10.0.0.9/24' });
    await waitFor(() => expect(screen.queryByText('Cambiar IP · eth0')).toBeNull());
    const n = f.a('GET', '/asterisk/net').length;
    await act(async () => { vi.advanceTimersByTime(900); });
    await waitFor(() => expect(f.a('GET', '/asterisk/net').length).toBe(n + 1));
    // Abrir y cancelar no manda nada.
    fireEvent.click(within(tarjeta).getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Cambiar IP · eth0')).toBeTruthy());
    fireEvent.click(screen.getByText('Cancelar'));
    await waitFor(() => expect(screen.queryByText('Cambiar IP · eth0')).toBeNull());
  });

  it('activar/desactivar una placa pide confirmación y manda la acción correcta', async () => {
    let falla = false;
    const f = fakeFetch({ 'GET /asterisk/net': NET, 'POST /asterisk/iface': () => (falla ? res(500, { error: 'no baja' }) : { ok: true }) });
    renderUI(<AstNet />);
    await waitFor(() => expect(screen.getByText('2/4 con enlace')).toBeTruthy());
    const t0 = screen.getByText('eth0', { selector: 'p' }).closest('.mantine-Card-root');
    fireEvent.click(within(t0).getAllByRole('button')[1]);
    await waitFor(() => expect(screen.getByText('Desactivar eth0')).toBeTruthy());
    expect(screen.getByText(/vas a perder el acceso/)).toBeTruthy();
    falla = true;
    fireEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    await waitFor(() => expect(toasts()).toContainEqual(['Error: no baja', 'bad']));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Desactivar eth0')).toBeNull());
    falla = false;
    const t1 = screen.getByText('eth1', { selector: 'p' }).closest('.mantine-Card-root');
    fireEvent.click(within(t1).getAllByRole('button')[1]);
    await waitFor(() => expect(screen.getByText('Activar eth1')).toBeTruthy());
    expect(screen.getByText('Se levanta la interfaz (ip link set up).')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activar' }));
    await waitFor(() => expect(toasts()).toContainEqual(['Activada eth1', 'info']));
    expect(f.a('POST', '/asterisk/iface').map((c) => c.body)).toEqual([{ action: 'down', dev: 'eth0' }, { action: 'up', dev: 'eth1' }]);
    await waitFor(() => expect(screen.queryByText('Activar eth1')).toBeNull());
    // Ahora desactivar con éxito.
    fireEvent.click(within(t0).getAllByRole('button')[1]);
    await waitFor(() => expect(screen.getByText('Desactivar eth0')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    await waitFor(() => expect(toasts()).toContainEqual(['Desactivada eth0', 'info']));
  });

  it('el diagnóstico corre ping → SIP → traceroute y pinta cada resultado en su fila', async () => {
    const f = fakeFetch({
      'GET /asterisk/net': NET,
      'POST /asterisk/diag': (req) => {
        if (req.body.que === 'ping') return { ok: true, salida: '3 paquetes, 0% pérdida\nrtt 1ms', ms: 12 };
        if (req.body.que === 'sip') return res(500, { error: 'sin OPTIONS' });
        return { ok: false, comando: 'traceroute', salida: 'traceroute to x\n 1  10.0.0.1  1 ms\n 2  8.8.8.8  9 ms' };
      },
    });
    renderUI(<AstNet />);
    await waitFor(() => expect(screen.getByText('2/4 con enlace')).toBeTruthy());
    expect(screen.getByText(/Escribí un destino y tocá/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Diagnosticar' }));
    expect(toasts()).toContainEqual(['Escribí un host o una IP', 'bad']);
    fireEvent.click(screen.getByText('10.0.0.1'));
    expect(screen.getByLabelText('Host o IP').value).toBe('10.0.0.1');
    fireEvent.change(screen.getByLabelText('Puerto SIP'), { target: { value: '5080' } });
    fireEvent.keyDown(screen.getByLabelText('Host o IP'), { key: 'a' });
    fireEvent.keyDown(screen.getByLabelText('Host o IP'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Ping (ICMP)')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('3 paquetes, 0% pérdida')).toBeTruthy());
    expect(screen.getByText('12ms')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('sin OPTIONS')).toBeTruthy());
    expect(screen.getByText('sin respuesta')).toBeTruthy();
    expect(screen.getByText('Alcance SIP :5080')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/2 +8\.8\.8\.8/)).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText(/1 +10\.0\.0\.1 +1 ms/)).toBeTruthy();
    expect(f.a('POST', '/asterisk/diag').map((c) => c.body)).toEqual([
      { host: '10.0.0.1', que: 'ping', port: 5080 }, { host: '10.0.0.1', que: 'sip', port: 5080 }, { host: '10.0.0.1', que: 'trace', port: 5080 },
    ]);
  });

  it('un ping sin respuesta es informativo (hay redes que filtran ICMP) y el traceroute OK no tiene saltos', async () => {
    let soltarTrace;
    fakeFetch({
      'GET /asterisk/net': { ifaces: [] },
      'POST /asterisk/diag': (req) => {
        if (req.body.que === 'ping') return { ok: false };
        if (req.body.que === 'sip') return { ok: true, salida: '', ms: 0 };
        return new Promise((r) => { soltarTrace = () => r({ ok: true }); });
      },
    });
    renderUI(<AstNet />);
    fireEvent.change(screen.getByLabelText('Host o IP'), { target: { value: 'pbx.x' } });
    fireEvent.change(screen.getByLabelText('Puerto SIP'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Diagnosticar' }));
    await waitFor(() => expect(screen.getByText('trazando la ruta salto a salto…')).toBeTruthy());
    expect(screen.getByText('Alcance SIP :5060')).toBeTruthy();
    expect(screen.getAllByText('OK')).toHaveLength(1);
    await act(async () => { soltarTrace(); });
    await waitFor(() => expect(screen.getAllByText('OK')).toHaveLength(2));
    expect(screen.queryByText('trazando la ruta salto a salto…')).toBeNull();
  });
});

describe('TurnOrigen — de dónde sale el TURN y si sirve', () => {
  const CFG = {
    origen: 'propio',
    propio: { host: '', puerto: 3478, host_efectivo: '200.1.1.1', usuario: 'pbx', tiene_clave: true },
    sbc: { disponible: true, host: 'sbc.x', usuario: 'edge', puerto: 3479, tiene_clave: true },
    externo: { urls: 'turn:t.x:3478', usuario: 'ext', tiene_clave: false },
    stun_url: '',
    efectivo: { stun: ['stun:200.1.1.1:3478'] },
  };
  const EST = { origen: 'propio', host: '200.1.1.1', puerto: 3478, deseado: true, corriendo: true, relay: '200.1.1.1:50000' };

  it('pinta lo medido arriba y guarda sólo el bloque del origen elegido', async () => {
    const f = fakeFetch({ 'GET /turn/origen': CFG, 'GET /turn/estado': EST, 'PUT /turn/origen': { efectivo: { usable: true }, verificacion: { ok: true } } });
    renderUI(<TurnOrigen />);
    expect(screen.getByText('Leyendo la configuración de TURN…')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Estado real del TURN')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('200.1.1.1:3478')).toBeTruthy());
    expect(screen.getByText('encendido y respondiendo')).toBeTruthy();
    expect(screen.getByText('200.1.1.1:50000')).toBeTruthy();
    expect(screen.getByText('sí')).toBeTruthy();
    expect(screen.getByText('usuario: pbx')).toBeTruthy();
    expect(screen.getByText('clave cargada')).toBeTruthy();
    expect(screen.getByLabelText('Host público del coturn').getAttribute('placeholder')).toBe('200.1.1.1');
    fireEvent.change(screen.getByLabelText('Host público del coturn'), { target: { value: 'turn.pbx.x' } });
    fireEvent.change(screen.getByLabelText('Puerto'), { target: { value: '3480' } });
    fireEvent.change(screen.getByLabelText('STUN (opcional)'), { target: { value: 'stun:s.x:3478' } });
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(toasts()).toContainEqual(['Origen del TURN guardado y verificado: entrega candidato relay', 'ok']));
    expect(f.a('PUT', '/turn/origen')[0].body).toEqual({ origen: 'propio', stun_url: 'stun:s.x:3478', propio_host: 'turn.pbx.x', propio_puerto: 3480 });
  });

  it('pasar al SBC-NG y a externo manda sus credenciales (la clave sólo si se escribió)', async () => {
    // El servidor devuelve lo último guardado, como la API real: si no, el recargado
    // después de guardar devolvería el origen viejo al formulario.
    let guardado = CFG;
    const f = fakeFetch({ 'GET /turn/origen': () => guardado, 'GET /turn/estado': null, 'PUT /turn/origen': (req) => { guardado = { ...CFG, origen: req.body.origen }; return { efectivo: {} }; } });
    renderUI(<TurnOrigen />);
    await waitFor(() => expect(screen.getByText('midiendo…')).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    fireEvent.click(screen.getByRole('radio', { name: /Del SBC-NG/ }));
    expect(screen.getByLabelText('Host del TURN del SBC-NG').value).toBe('sbc.x');
    expect(screen.getByText('enlace activo')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Usuario TURN del SBC-NG'), { target: { value: 'edge2' } });
    fireEvent.change(screen.getByLabelText('Puerto'), { target: { value: '3490' } });
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(toasts()).toContainEqual(['Origen del TURN guardado', 'ok']));
    expect(f.a('PUT', '/turn/origen')[0].body).toEqual({ origen: 'sbc', stun_url: '', sbc_usuario: 'edge2', sbc_puerto: 3490 });
    fireEvent.change(screen.getByLabelText('Clave TURN del SBC-NG'), { target: { value: 'k1' } });
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(f.a('PUT', '/turn/origen')).toHaveLength(2));
    expect(f.a('PUT', '/turn/origen')[1].body.sbc_clave).toBe('k1');
    fireEvent.click(screen.getByRole('radio', { name: /Externo/ }));
    expect(screen.getByText('Todavía no hay clave guardada')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('URL(s) del TURN externo'), { target: { value: 'turns:t.y:5349' } });
    fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'u' } });
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(f.a('PUT', '/turn/origen')).toHaveLength(3));
    expect(f.a('PUT', '/turn/origen')[2].body).toEqual({ origen: 'externo', stun_url: '', externo_urls: 'turns:t.y:5349', externo_usuario: 'u' });
    fireEvent.change(screen.getByLabelText('Clave'), { target: { value: 'k2' } });
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(f.a('PUT', '/turn/origen')).toHaveLength(4));
    expect(f.a('PUT', '/turn/origen')[3].body.externo_clave).toBe('k2');
  });

  it('el guardado repite el motivo cuando el origen no es utilizable, forzado o con aviso', async () => {
    let r = { efectivo: { usable: false, motivo: 'sin host' } };
    fakeFetch({ 'GET /turn/origen': CFG, 'GET /turn/estado': EST, 'PUT /turn/origen': () => r });
    renderUI(<TurnOrigen />);
    await waitFor(() => expect(screen.getByText('Guardar origen')).toBeTruthy());
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(toasts()).toContainEqual(['Guardado, pero el origen no está utilizable: sin host', 'bad']));
    r = { efectivo: { usable: false } };
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(toasts()).toContainEqual(['Guardado, pero el origen no está utilizable: sin motivo', 'bad']));
    r = { forzado: true };
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(toasts().some((t) => /SIN verificar/.test(t[0]))).toBe(true));
    r = { verificacion: { ok: true, aviso: 'relay por TCP no' } };
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(toasts()).toContainEqual(['Origen del TURN guardado y verificado · relay por TCP no', 'bad']));
    r = null;
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(toasts()).toContainEqual(['Origen del TURN guardado', 'ok']));
  });

  it('un 409 no cambia nada: muestra la medición que lo rechazó y ofrece cambiar igual', async () => {
    let forzar = false;
    const f = fakeFetch({
      'GET /turn/origen': CFG, 'GET /turn/estado': EST,
      'PUT /turn/origen': (req) => (req.body.forzar ? { forzado: true } : res(409, { error: 'El TURN nuevo no entrega relay', verificacion: {
        ok: false, veredicto: 'relay privado 172.17.0.2',
        udp: { ok: false, proto: 'UDP', host: 't.x', puerto: 3478, pasos: [{ paso: 'Binding', ok: true, detalle: 'contestó' }, { paso: 'Allocate', ok: false, detalle: 'relay privado' }], relay: '172.17.0.2:5000', mapped: '1.1.1.1:1', host_ip: '9.9.9.9', veredicto: 'privado' },
        tcp: { ok: true, proto: 'TCP', host: 't.x', puerto: 3478 },
      } })),
    });
    renderUI(<TurnOrigen />);
    await waitFor(() => expect(screen.getByText('Guardar origen')).toBeTruthy());
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(screen.getByText('No se cambió nada: el TURN nuevo no entrega candidato relay')).toBeTruthy());
    expect(screen.getByText('El TURN nuevo no entrega relay')).toBeTruthy();
    expect(screen.getByText('TURN NO utilizable')).toBeTruthy();
    expect(screen.getByText('relay privado 172.17.0.2')).toBeTruthy();
    expect(screen.getByText('UDP · t.x:3478')).toBeTruthy();
    expect(screen.getAllByText('FALLA')).toHaveLength(2);   // insignia del UDP y la nota de abajo
    expect(screen.getByText('172.17.0.2:5000')).toBeTruthy();
    expect(screen.getByText('Allocate')).toBeTruthy();
    expect(toasts()).toEqual([]);
    // «Corregir los datos» cierra el aviso; «Cambiar igual» manda forzar.
    fireEvent.click(screen.getByText('Corregir los datos'));
    expect(screen.queryByText('Cambiar igual')).toBeNull();
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(screen.getByText('Cambiar igual')).toBeTruthy());
    fireEvent.click(screen.getByText('Cambiar igual'));
    await waitFor(() => expect(toasts().some((t) => /SIN verificar/.test(t[0]))).toBe(true));
    expect(f.a('PUT', '/turn/origen')[2].body.forzar).toBe(true);
    expect(forzar).toBe(false);
  });

  it('otros errores del PUT van a un toast', async () => {
    fakeFetch({ 'GET /turn/origen': CFG, 'GET /turn/estado': EST, 'PUT /turn/origen': res(409, { error: 'otro conflicto' }) });
    renderUI(<TurnOrigen />);
    await waitFor(() => expect(screen.getByText('Guardar origen')).toBeTruthy());
    fireEvent.click(screen.getByText('Guardar origen'));
    await waitFor(() => expect(toasts()).toContainEqual(['otro conflicto', 'bad']));
  });

  it('«Probar» corre la sonda del origen efectivo y muestra los dos intercambios', async () => {
    let falla = false;
    const f = fakeFetch({
      'GET /turn/origen': { ...CFG, origen: undefined, sbc: { disponible: false }, efectivo: { usable: false } },
      'GET /turn/estado': { deseado: false, corriendo: false, origen: 'externo' },
      'POST /turn/probe': () => (falla ? res(500, { error: 'sonda rota' }) : { ok: true, veredicto: 'relay público OK', udp: { ok: true, proto: 'UDP', host: 'h', puerto: 1, relay: '200.0.0.1:1', pasos: [{ paso: 'Allocate', ok: true, detalle: 'ok' }] }, tcp: null }),
    });
    renderUI(<TurnOrigen />);
    await waitFor(() => expect(screen.getByText('El origen configurado no está utilizable')).toBeTruthy());
    expect(screen.getByText('sin host configurado')).toBeTruthy();
    expect(screen.getAllByText('Externo (otro proveedor)')).toHaveLength(2);   // el radio y el «Origen» medido
    expect(screen.getAllByText('apagado')).toHaveLength(2);   // insignia e interruptor
    expect(screen.getByText('sin enlace activo')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Del SBC-NG/ }).disabled).toBe(true);
    fireEvent.click(screen.getByText('Probar'));
    await waitFor(() => expect(screen.getByText('TURN utilizable')).toBeTruthy());
    expect(screen.getAllByText('relay público OK').length).toBe(1);
    expect(f.a('POST', '/turn/probe')[0].body).toBeUndefined();
    const est = f.a('GET', '/turn/estado').length;
    expect(est).toBeGreaterThanOrEqual(2);
    falla = true;
    fireEvent.click(screen.getByText('Probar'));
    await waitFor(() => expect(toasts()).toContainEqual(['sonda rota', 'bad']));
    expect(screen.queryByText('Resultado de la prueba')).toBeNull();
    fireEvent.click(screen.getByText('Refrescar'));
    await waitFor(() => expect(f.a('GET', '/turn/estado').length).toBeGreaterThan(est + 1));
  });

  it('con el SBC elegido y sin enlace, avisa que hay que conectarlo primero', async () => {
    fakeFetch({ 'GET /turn/origen': { origen: 'sbc', sbc: { disponible: false } }, 'GET /turn/estado': { deseado: true, corriendo: false, motivo: 'sin enlace' } });
    renderUI(<TurnOrigen />);
    await waitFor(() => expect(screen.getByText(/No hay un enlace a SBC-NG activo/)).toBeTruthy());
    expect(screen.getByText('sin enlace')).toBeTruthy();
    expect(screen.getByText('no')).toBeTruthy();
    expect(screen.getByLabelText('Host del TURN del SBC-NG').value).toBe('');
  });

  it('si no se puede leer la configuración, lo dice', async () => {
    fakeFetch({ 'GET /turn/origen': res(403, {}), 'GET /turn/estado': null });
    renderUI(<TurnOrigen />);
    await waitFor(() => expect(screen.getByText('No se pudo leer el origen del TURN')).toBeTruthy());
  });
});

describe('SystemOverview y la pantalla de Sistema', () => {
  const NODOS = {
    nodes: [
      { id: 'core', name: 'núcleo', role: 'core', host: '10.0.0.2', ncpu: 4, cpu_pct: 95, load: 1.234, mem_pct: 80, mem_used_mb: 2048, mem_total_mb: 4096, uptime_s: 100, disk: { pct: 90, used: 9e9, total: 1e10, free: 1e9 }, services: ['asterisk', 'api'], ifaces: [{ name: 'eth0', addrs: ['10.0.0.2/24'], state: 'UP', rx_bytes: 2048, tx_bytes: 1024 }] },
      { id: 'ai', name: 'ia', role: 'ai', cpu_pct: 55, mem_pct: 30, disk: { pct: 20, used: 1, total: 5, free: 4 }, ifaces: [{ name: 'lo' }] },
      { id: 'edge', name: 'borde', role: 'edge', ok: false, motivo: 'agente sin respuesta' },
      { id: 'x', name: 'raro', role: 'otro', cpu_pct: 10 },
    ],
    storage: { disk: { pct: 90, total: 1e10, used: 9e9, free: 1e9 }, recordings: { bytes: 5e8, files: 10 }, voicemail: { bytes: 1e6, files: 2 }, db: { ok: true, bytes: 2e7, cdr: 100, conns: 3 } },
  };

  it('pinta cada nodo con sus barras, avisa caídos y discos llenos, y lista las placas', () => {
    renderUI(<SystemOverview data={NODOS} />);
    expect(screen.getByText(/No se pudo medir borde: su agente no contestó/)).toBeTruthy();
    expect(screen.getByText('núcleo (90%)')).toBeTruthy();
    expect(screen.getByText('10.0.0.2 · 4 vCPU')).toBeTruthy();
    expect(screen.getByText('carga 1.23')).toBeTruthy();
    expect(screen.getByText('2.0 / 4.0 GB')).toBeTruthy();
    expect(screen.getByText('agente sin respuesta')).toBeTruthy();
    expect(screen.getByText('asterisk')).toBeTruthy();
    expect(screen.getByText('activo hace 0h 1m')).toBeTruthy();
    expect(screen.getByText('no reportado')).toBeTruthy();
    expect(screen.getByText('10.0.0.2/24')).toBeTruthy();
    expect(screen.getByText('UP')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('Grabaciones')).toBeTruthy();
    expect(screen.queryByText('Estos nodos están reportando la misma máquina')).toBeNull();
  });

  it('nodos que reportan la misma máquina se marcan y no muestran CPU/memoria/uptime como propios', () => {
    const gemelo = { mem_total_mb: 35000, ncpu: 12, uptime_s: 3110400, cpu_pct: 5, mem_pct: 40, mem_used_mb: 14000 };
    renderUI(<SystemOverview data={{ nodes: [{ id: 'a', name: 'A', role: 'core', host: 'h', ...gemelo }, { id: 'b', name: 'B', role: 'edge', ...gemelo }] }} />);
    expect(screen.getByText('Estos nodos están reportando la misma máquina')).toBeTruthy();
    expect(screen.getByText(/A · B devuelven la misma/)).toBeTruthy();
    expect(screen.getAllByText('uptime: no se pudo medir')).toHaveLength(2);
    expect(screen.getAllByText('no es de este nodo')).toHaveLength(4);
    expect(screen.getByText('h')).toBeTruthy();   // sin «· 12 vCPU»
    expect(screen.getByText('Sin datos de interfaces.')).toBeTruthy();
  });

  it('sin nodos dice que está leyendo, o el error si lo hubo; sin storage pone guiones', () => {
    const { unmount } = renderUI(<SystemOverview data={null} />);
    expect(screen.getByText('Leyendo el inventario de nodos…')).toBeTruthy();
    expect(screen.getAllByText('—')).toHaveLength(3);
    unmount();
    renderUI(<SystemOverview data={null} error={new Error('sin API')} />);
    expect(screen.getByText('No se pudo leer el inventario de nodos: sin API')).toBeTruthy();
  });

  it('sin `data` encuesta por su cuenta /system/overview', async () => {
    const f = fakeFetch({ 'GET /system/overview': { nodes: [{ id: 'n', name: 'solo', cpu_pct: 10 }], storage: { db: { ok: false } } } });
    renderUI(<SystemOverview />);
    await waitFor(() => expect(screen.getByText('solo')).toBeTruthy());
    expect(f.a('GET', '/system/overview')).toHaveLength(1);
  });

  it('la pantalla de Sistema muestra el motor, sus transportes y módulos, y le pasa el inventario', async () => {
    live.snap = { health: { ami: true, ari: true }, channels: [{}, {}, {}], extensions: [{}] };
    const f = fakeFetch({ 'GET /system/overview': NODOS, 'GET /asterisk/core': { version: 'Asterisk 22', uptime: 'System uptime: 2 días', transports: [{ id: 'udp', proto: 'udp' }, { id: 'x' }], modules: { res_pjsip: true, chan_sip: false } } });
    renderUI(<Sistema />);
    await waitFor(() => expect(screen.getAllByText('Asterisk 22')).toHaveLength(2));
    expect(screen.getByText('2 días')).toBeTruthy();
    expect(screen.getByText('AMI')).toBeTruthy();
    expect(screen.getByText('ARI')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('udp · UDP')).toBeTruthy();
    expect(screen.getByText('chan_sip: no')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('núcleo').length).toBeGreaterThan(0));
    expect(f.a('GET', '/system/overview')).toHaveLength(1);   // un solo pedido: SystemOverview no encuesta
  });

  it('si el motor no contestó, lo dice una vez arriba', async () => {
    fakeFetch({ 'GET /system/overview': res(500, { error: 'ov caído' }), 'GET /asterisk/core': res(502, { error: 'motor sin respuesta' }) });
    renderUI(<Sistema />);
    await waitFor(() => expect(screen.getByText('No se pudo consultar el motor de Asterisk')).toBeTruthy());
    expect(screen.getByText('motor sin respuesta')).toBeTruthy();
    expect(screen.getByText('Sin AMI')).toBeTruthy();
    expect(screen.getByText('Sin ARI')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('No se pudo leer el inventario de nodos: ov caído')).toBeTruthy());
  });

  it('la pantalla de Red arma modo de red y placas', async () => {
    fakeFetch({ 'GET /net/mode': { cfg: { modo: 'router' } }, 'GET /asterisk/net': { ifaces: [] } });
    renderUI(<Red />);
    expect(screen.getByText('Red del núcleo')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Modo de red del núcleo')).toBeTruthy());
    expect(screen.getByText('Switch del núcleo')).toBeTruthy();
  });
});
