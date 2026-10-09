/* ============================================================================
 *  Pantallas de administración: Certificados TLS, Respaldos, Configuración, Llamadas
 *  en vivo (supervisión), Notificaciones Push, Usuarios y Manuales.
 *
 *  Lo que se fija: que cada operación con consecuencias (emitir un certificado, restaurar
 *  la central, borrar un usuario, irrumpir en una llamada) mande exactamente lo que el
 *  contrato pide y se pueda cancelar; que restaurar exija escribir RESTAURAR y muestre
 *  antes qué trae el archivo; que la descarga de un respaldo vaya CON el token (un
 *  `<a href>` bajaba un 401 disfrazado de archivo); que la solapa «Integraciones» de
 *  Configuración muestre de verdad Telegram y WhatsApp; y que cada error de la API llegue
 *  al operador con su motivo en vez de tragarse.
 * ==========================================================================*/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { renderUI, fakeFetch, res, RED_CAIDA, flush } from './helpers/sistema-render.jsx';

// Pantallas pesadas: con cobertura y suites en paralelo, 5 s no siempre alcanzan.
vi.setConfig({ testTimeout: 20000 });

const promesas = [];
vi.mock('../app/notify', () => ({
  toast: vi.fn(),
  // Como sileo: el error queda en el toast, y sólo rechaza para quien lo espera.
  toastPromise: vi.fn((p, o) => {
    const fin = Promise.resolve(p).then(
      (d) => { promesas.push(['ok', typeof o.success === 'function' ? o.success(d) : o.success]); return { d }; },
      (e) => { promesas.push(['error', typeof o.error === 'function' ? o.error(e) : o.error]); return { e }; });
    return { then: (ok, mal) => fin.then((r) => ('e' in r ? (mal ? mal(r.e) : Promise.reject(r.e)) : (ok ? ok(r.d) : r.d))) };
  }),
}));
const live = { snap: null, connected: false };
vi.mock('../app/useLive', () => ({ useLive: () => live, getSocket: () => null }));
vi.mock('../app/Slot', () => ({ default: ({ value }) => <span>{value}</span> }));
vi.mock('../app/CortarLlamada', () => ({ default: ({ id }) => <button type="button">Cortar {id}</button> }));
// Los paneles de las solapas de Configuración tienen sus propias pruebas.
vi.mock('../app/ModulesPanel', () => ({ default: () => <div>panel de módulos</div> }));
vi.mock('../app/BrandingPanel', () => ({ default: () => <div>panel de marca</div> }));
vi.mock('../app/ProxyPanel', () => ({ default: () => <div>panel de proxy</div> }));
vi.mock('../app/AlertsPanel', () => ({ default: () => <div>panel de alertas</div> }));
vi.mock('../app/TurnConsole', () => ({ default: () => <div>consola coturn</div> }));
vi.mock('../app/TurnOrigen', () => ({ default: () => <div>origen del turn</div> }));
vi.mock('../app/SipPanel', () => ({ default: () => <div>panel sip</div> }));

import { toast } from '../app/notify';
import Certificados from '../app/certificados/page.jsx';
import Respaldos from '../app/respaldos/page.jsx';
import Configuracion from '../app/configuracion/page.jsx';
import Monitor from '../app/monitor/page.jsx';
import Notificaciones from '../app/notificaciones/page.jsx';
import Usuarios from '../app/usuarios/page.jsx';
import Manuales from '../app/manuales/page.jsx';

const toasts = () => toast.mock.calls.map((c) => [c[0], c[1]]);

/* Un localStorage en memoria por prueba: el de jsdom no siempre está disponible con
 * Node 22+, y así cada prueba arranca sin la extensión de supervisor de la anterior. */
function memoria() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
beforeEach(() => {
  toast.mockClear(); promesas.length = 0; live.snap = null; live.connected = false;
  vi.stubGlobal('localStorage', memoria());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/* ─────────────────────────── Certificados TLS ─────────────────────────── */
describe('Certificados TLS', () => {
  const ACME = { config: { domain: 'pbx.x.com', email: 'ti@x.com', method: 'http', proveedores: [{ id: 'dns_cf', label: 'Cloudflare', vars: ['CF_Token', 'CF_Account_ID'] }], tiene_dns_creds: true }, cert: { emitido: true, cn: 'pbx.x.com', dias_restantes: 60, vence: '2026-12-07' } };

  it('muestra el certificado vigente y guarda la configuración HTTP-01', async () => {
    const f = fakeFetch({ 'GET /acme': ACME, 'POST /acme/config': { ok: true } });
    renderUI(<Certificados />);
    await waitFor(() => expect(screen.getByText('60 días')).toBeTruthy());
    expect(screen.getAllByText('pbx.x.com').length).toBeGreaterThan(0);
    expect(screen.getByText(/vence el/)).toBeTruthy();
    expect(screen.getByText('Re-emitir certificado')).toBeTruthy();
    expect(screen.getByText('http://pbx.x.com/.well-known/acme-challenge/…')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Dominio'), { target: { value: ' pbx.y.com ' } });
    fireEvent.click(screen.getByText('Guardar configuración'));
    await waitFor(() => expect(toasts()).toContainEqual(['Configuración guardada.', 'ok']));
    expect(f.a('POST', '/acme/config')[0].body).toEqual({ domain: 'pbx.y.com', email: 'ti@x.com', method: 'http', dns_provider: '' });
  });

  it('valida dominio y email antes de guardar', async () => {
    const f = fakeFetch({ 'GET /acme': {}, 'POST /acme/config': res(400, { error: 'dominio inválido' }) });
    renderUI(<Certificados />);
    await waitFor(() => expect(screen.getByText('Sin certificado')).toBeTruthy());
    expect(screen.getByText('http://tu-dominio/.well-known/acme-challenge/…')).toBeTruthy();
    fireEvent.click(screen.getByText('Guardar configuración'));
    expect(toasts()).toContainEqual(['Ingresá el dominio (ej: pbx.tuempresa.com).', 'bad']);
    fireEvent.change(screen.getByLabelText('Dominio'), { target: { value: 'pbx.z' } });
    fireEvent.click(screen.getByText('Guardar configuración'));
    expect(toasts()).toContainEqual(['Ingresá el email de la cuenta ACME.', 'bad']);
    expect(f.a('POST', '/acme/config')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Email de la cuenta ACME'), { target: { value: 'a@b' } });
    fireEvent.click(screen.getByText('Guardar configuración'));
    await waitFor(() => expect(toasts()).toContainEqual(['dominio inválido', 'bad']));
  });

  it('DNS-01 pide el proveedor y manda sólo las credenciales escritas', async () => {
    const f = fakeFetch({ 'GET /acme': ACME, 'POST /acme/config': { ok: true } });
    renderUI(<Certificados />);
    await waitFor(() => expect(screen.getByText('60 días')).toBeTruthy());
    fireEvent.click(screen.getByText('DNS-01 (API del DNS)'));
    expect(screen.getByText('DNS-01 · detrás de NAT o proxy')).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText('Proveedor de DNS')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Cloudflare' }));
    await waitFor(() => expect(screen.getByLabelText('CF_Token')).toBeTruthy());
    expect(screen.getByLabelText('CF_Token').getAttribute('placeholder')).toMatch(/guardada/);
    fireEvent.change(screen.getByLabelText('CF_Token'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByText('Guardar configuración'));
    await waitFor(() => expect(f.a('POST', '/acme/config')).toHaveLength(1));
    expect(f.a('POST', '/acme/config')[0].body).toEqual({ domain: 'pbx.x.com', email: 'ti@x.com', method: 'dns', dns_provider: 'dns_cf', dns_creds: { CF_Token: 'tok' } });
  });

  it('emitir y renovar muestran la salida de acme.sh, abierta si falló', async () => {
    let r = { ok: false, error: 'el puerto 80 no contesta', salida: 'acme.sh: timeout' };
    const f = fakeFetch({ 'GET /acme': { config: { domain: 'pbx.x' }, cert: { emitido: false } }, 'POST /acme/issue': () => r, 'POST /acme/renew': { ok: true, salida: 'renovado' } });
    renderUI(<Certificados />);
    const emitir = () => screen.getByRole('button', { name: 'Emitir certificado' });
    await waitFor(() => expect(emitir()).toBeTruthy());
    fireEvent.click(emitir());
    await waitFor(() => expect(toasts()).toContainEqual(['el puerto 80 no contesta', 'bad']));
    expect(screen.getByText('acme.sh: timeout')).toBeTruthy();
    expect(screen.getByText('Ocultar salida de acme.sh')).toBeTruthy();
    fireEvent.click(screen.getByText('Ocultar salida de acme.sh'));
    expect(screen.getByText('Ver salida de acme.sh')).toBeTruthy();
    r = { ok: false };
    fireEvent.click(emitir());
    await waitFor(() => expect(toasts()).toContainEqual(['No se pudo emitir el certificado.', 'bad']));
    r = { ok: true };
    fireEvent.click(emitir());
    await waitFor(() => expect(toasts()).toContainEqual(['Certificado emitido correctamente.', 'ok']));
    expect(f.a('POST', '/acme/issue')).toHaveLength(3);
  });

  it('renovar un certificado activo; y los estados de salud según los días que quedan', async () => {
    const casos = [[5, '5 días'], [20, '20 días'], [0, 'Vencido'], [undefined, '—']];
    for (const [dias, txt] of casos) {
      fakeFetch({ 'GET /acme': { config: {}, cert: { emitido: true, dias_restantes: dias } }, 'POST /acme/renew': { ok: true, salida: 'renovado ok' } });
      const { unmount } = renderUI(<Certificados />);
      await waitFor(() => expect(screen.getByText(txt)).toBeTruthy());
      expect(screen.getByText('Certificado activo')).toBeTruthy();
      if (dias === 5) {
        fireEvent.click(screen.getByText('Renovar ahora'));
        await waitFor(() => expect(toasts()).toContainEqual(['Certificado renovado.', 'ok']));
        expect(screen.getByText('Ver salida de acme.sh')).toBeTruthy();
      }
      unmount();
    }
  });

  it('a quien no es administrador le dice que la pantalla es sólo para administradores', async () => {
    fakeFetch({ 'GET /acme': res(403, { error: 'Requiere rol administrador' }) });
    const { unmount } = renderUI(<Certificados />);
    await waitFor(() => expect(screen.getByText('Sólo administradores')).toBeTruthy());
    unmount();
    fakeFetch({ 'GET /acme': res(403, '') });
    const r2 = renderUI(<Certificados />);
    await waitFor(() => expect(screen.getByText('Sólo administradores')).toBeTruthy());
    r2.unmount();
    fakeFetch({ 'GET /acme': res(500, 'no es json') });
    renderUI(<Certificados />);
    await waitFor(() => expect(toasts()).toContainEqual(['no es json', 'bad']));
  });

  it('un error al emitir por red se avisa', async () => {
    fakeFetch({ 'GET /acme': {}, 'POST /acme/issue': res(502, { error: 'sin agente' }) });
    renderUI(<Certificados />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Emitir certificado' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Emitir certificado' }));
    await waitFor(() => expect(toasts()).toContainEqual(['sin agente', 'bad']));
  });
});

/* ─────────────────────────── Respaldos ─────────────────────────── */
describe('Respaldos', () => {
  const LISTA = { respaldos: [{ nombre: 'pbxng-2026-10-01.tar.gz', creado: '2026-10-01T03:00:00Z', bytes: 5 * 1048576 }] };
  const PROG = { enabled: true, hour: 4, keep: 7, last_run: '2026-10-07T04:00:00Z', last_ok: true };

  it('lista respaldos y crea uno nuevo con nota y grabaciones', async () => {
    const f = fakeFetch({ 'GET /backup': LISTA, 'GET /backup/schedule': PROG, 'POST /backup': { nombre: 'x', bytes: 2048 } });
    renderUI(<Respaldos />);
    await waitFor(() => expect(screen.getByText('pbxng-2026-10-01.tar.gz')).toBeTruthy());
    expect(screen.getByText('5.0 MB')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Nota \(opcional\)/), { target: { value: 'antes del cambio' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Incluir las grabaciones/ }));
    fireEvent.click(screen.getByText('Crear respaldo'));
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Respaldo creado · 2.0 KB']));
    expect(f.a('POST', '/backup')[0].body).toEqual({ grabaciones: true, nota: 'antes del cambio' });
    await waitFor(() => expect(screen.getByPlaceholderText(/Nota \(opcional\)/).value).toBe(''));
  });

  it('si crear falla, la nota no se pierde y el error se muestra', async () => {
    fakeFetch({ 'GET /backup': { respaldos: [] }, 'GET /backup/schedule': res(404, {}), 'POST /backup': res(507, { error: 'disco lleno' }) });
    renderUI(<Respaldos />);
    await waitFor(() => expect(screen.getByText('Todavía no hay respaldos')).toBeTruthy());
    expect(screen.getByText('No disponible en esta versión.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Nota \(opcional\)/), { target: { value: 'nota' } });
    fireEvent.click(screen.getByText('Crear respaldo'));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'disco lleno']));
    expect(screen.getByPlaceholderText(/Nota \(opcional\)/).value).toBe('nota');
  });

  it('descarga con el token (pedido por la API) y avisa si falla', async () => {
    let falla = false;
    const f = fakeFetch({ 'GET /backup': LISTA, 'GET /backup/schedule': PROG, 'GET /backup/pbxng-2026-10-01.tar.gz/archivo': () => (falla ? res(401, {}) : res(200, new Blob(['tgz']))) });
    URL.createObjectURL = vi.fn(() => 'blob:r'); URL.revokeObjectURL = vi.fn();
    const clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicks.push(this.download); });
    renderUI(<Respaldos />);
    await waitFor(() => expect(screen.getByText('pbxng-2026-10-01.tar.gz')).toBeTruthy());
    const fila = screen.getByText('pbxng-2026-10-01.tar.gz').closest('tr');
    fireEvent.click(within(fila).getAllByRole('button')[0]);
    await waitFor(() => expect(clicks).toEqual(['pbxng-2026-10-01.tar.gz']));
    expect(f.a('GET', '/backup/pbxng-2026-10-01.tar.gz/archivo')).toHaveLength(1);
    falla = true;
    fireEvent.click(within(fila).getAllByRole('button')[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['No se pudo descargar', 'bad']));
  });

  it('borrar pide la baja a la API y relee', async () => {
    let falla = false;
    const f = fakeFetch({ 'GET /backup': LISTA, 'GET /backup/schedule': PROG, 'DELETE /backup/pbxng-2026-10-01.tar.gz': () => (falla ? res(500, {}) : { ok: true }) });
    renderUI(<Respaldos />);
    await waitFor(() => expect(screen.getByText('pbxng-2026-10-01.tar.gz')).toBeTruthy());
    const fila = screen.getByText('pbxng-2026-10-01.tar.gz').closest('tr');
    fireEvent.click(within(fila).getAllByRole('button')[2]);
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'pbxng-2026-10-01.tar.gz borrado']));
    await waitFor(() => expect(f.a('GET', '/backup')).toHaveLength(2));
    falla = true;
    fireEvent.click(within(fila).getAllByRole('button')[2]);
    await waitFor(() => expect(promesas).toContainEqual(['error', 'Error del servidor']));
  });

  it('restaurar muestra qué trae el archivo y sólo procede escribiendo RESTAURAR', async () => {
    const MANIF = { creado: '2026-10-01T03:00:00Z', host: 'central-a', postgres: '16', nota: 'antes del cambio', compatible: { ok: true }, partes: [{ id: 'db', desc: 'Base', archivo: true, bytes: 1024 }, { id: 'grab', desc: 'Grabaciones', omitida: 'no se pidieron' }, { id: 'tls', desc: 'Certificados', ausente: true }, { id: 'x', desc: 'Otra' }] };
    const f = fakeFetch({ 'GET /backup': LISTA, 'GET /backup/schedule': PROG, 'GET /backup/pbxng-2026-10-01.tar.gz/inspeccionar': MANIF, 'POST /backup/pbxng-2026-10-01.tar.gz/restaurar': { restauradas: ['db', 'conf'] } });
    renderUI(<Respaldos />);
    await waitFor(() => expect(screen.getByText('pbxng-2026-10-01.tar.gz')).toBeTruthy());
    fireEvent.click(within(screen.getByText('pbxng-2026-10-01.tar.gz').closest('tr')).getAllByRole('button')[1]);
    await waitFor(() => expect(screen.getByText('Restaurar la central')).toBeTruthy());
    expect(screen.getByText('central-a')).toBeTruthy();
    expect(screen.getByText('“antes del cambio”')).toBeTruthy();
    expect(screen.getByText('(1.0 KB)')).toBeTruthy();
    expect(screen.getByText('(no se pidieron)')).toBeTruthy();
    expect(screen.getByText('(no estaba en el origen)')).toBeTruthy();
    expect(screen.getByText('(sin datos)')).toBeTruthy();
    const boton = screen.getByRole('button', { name: 'Restaurar ahora' });
    expect(boton.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('RESTAURAR'), { target: { value: 'restaurar' } });
    expect(boton.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('RESTAURAR'), { target: { value: 'RESTAURAR' } });
    expect(boton.disabled).toBe(false);
    fireEvent.click(boton);
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Restaurado: db, conf. Reiniciá los servicios.']));
    expect(f.a('POST', '/backup/pbxng-2026-10-01.tar.gz/restaurar')[0].body).toEqual({ confirmar: true });
    await waitFor(() => expect(screen.queryByText('Restaurar la central')).toBeNull());
  });

  it('un respaldo incompatible no ofrece restaurar; fallar la inspección o la restauración se avisa', async () => {
    let manif = { compatible: { ok: false, motivo: 'versión de esquema más nueva' } };
    fakeFetch({
      'GET /backup': LISTA, 'GET /backup/schedule': PROG,
      'GET /backup/pbxng-2026-10-01.tar.gz/inspeccionar': () => manif,
      'POST /backup/pbxng-2026-10-01.tar.gz/restaurar': res(500, { error: 'pg_restore falló' }),
    });
    renderUI(<Respaldos />);
    await waitFor(() => expect(screen.getByText('pbxng-2026-10-01.tar.gz')).toBeTruthy());
    const restaurarBtn = () => within(screen.getByText('pbxng-2026-10-01.tar.gz').closest('tr')).getAllByRole('button')[1];
    fireEvent.click(restaurarBtn());
    await waitFor(() => expect(screen.getByText('Este respaldo no se puede restaurar acá')).toBeTruthy());
    expect(screen.getByText('versión de esquema más nueva')).toBeTruthy();
    expect(screen.queryByPlaceholderText('RESTAURAR')).toBeNull();
    fireEvent.keyDown(screen.getByText('Restaurar la central'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Restaurar la central')).toBeNull());
    manif = {};
    fireEvent.click(restaurarBtn());
    await waitFor(() => expect(screen.getByPlaceholderText('RESTAURAR')).toBeTruthy());
    expect(screen.getAllByText('—')).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText('RESTAURAR'), { target: { value: 'RESTAURAR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar ahora' }));
    await waitFor(() => expect(promesas).toContainEqual(['error', 'pg_restore falló']));
    expect(screen.getByText('Restaurar la central')).toBeTruthy();   // queda abierto
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Restaurar la central')).toBeNull());
    manif = res(404, { error: 'no existe el archivo' });
    fireEvent.click(restaurarBtn());
    await waitFor(() => expect(toasts()).toContainEqual(['no existe el archivo', 'bad']));
  });

  it('subir sólo acepta .tar.gz y lo manda crudo', async () => {
    let falla = false;
    const f = fakeFetch({ 'GET /backup': { respaldos: [] }, 'GET /backup/schedule': PROG, 'POST /backup/subir/mio.tar.gz': () => (falla ? res(400, { error: 'firma inválida' }) : { ok: true }) });
    const { container } = renderUI(<Respaldos />);
    await waitFor(() => expect(screen.getByText('Todavía no hay respaldos')).toBeTruthy());
    const input = container.querySelector('input[type=file]');
    fireEvent.change(input, { target: { files: [new File(['x'], 'foto.png')] } });
    expect(toasts()).toContainEqual(['Tiene que ser un .tar.gz de PBX-NG', 'bad']);
    const archivo = new File(['tgz'], 'mio.tar.gz');
    fireEvent.change(input, { target: { files: [archivo] } });
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Respaldo subido y verificado']));
    const pedido = f.a('POST', '/backup/subir/mio.tar.gz')[0];
    expect(pedido.init.headers['Content-Type']).toBe('application/octet-stream');
    expect(pedido.init.body).toBe(archivo);
    falla = true;
    fireEvent.change(input, { target: { files: [new File(['tgz'], 'mio.tar.gz')] } });
    await waitFor(() => expect(promesas).toContainEqual(['error', 'firma inválida']));
  });

  it('el respaldo programado guarda sólo si cambió algo y explica la última corrida', async () => {
    let prog = { ...PROG };
    const f = fakeFetch({ 'GET /backup': { respaldos: [] }, 'GET /backup/schedule': () => prog, 'POST /backup/schedule': (req) => { prog = { ...prog, ...req.body }; return prog; } });
    renderUI(<Respaldos />);
    await waitFor(() => expect(screen.getByText('Activo')).toBeTruthy());
    expect(screen.getByText(/correcta/)).toBeTruthy();
    const guardar = screen.getByRole('button', { name: 'Guardar programación' });
    expect(guardar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Hora'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Conservar'), { target: { value: '10' } });
    expect(guardar.disabled).toBe(false);
    fireEvent.click(guardar);
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Respaldo programado todos los días a las 05:00']));
    expect(f.a('POST', '/backup/schedule')[0].body).toEqual({ enabled: true, hour: 5, keep: 10 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar programación' }).disabled).toBe(true));
    fireEvent.click(screen.getByRole('switch', { name: 'Hacer un respaldo todos los días' }));
    expect(screen.getByLabelText('Hora').disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar programación' }));
    await waitFor(() => expect(promesas).toContainEqual(['ok', 'Respaldo programado desactivado']));
  });

  it('última corrida fallida, sin resultado o inexistente; valores raros caen a los de fábrica', async () => {
    const casos = [
      [{ enabled: false, last_run: '2026-10-07T04:00:00Z', last_ok: false }, /falló/],
      [{ enabled: true, hour: 'x', keep: null, last_run: '2026-10-07T04:00:00Z' }, /sin resultado/],
      [null, /Todavía no corrió ninguno/],
    ];
    for (const [prog, re] of casos) {
      fakeFetch({ 'GET /backup': { respaldos: [] }, 'GET /backup/schedule': prog, 'POST /backup/schedule': res(400, { error: 'hora inválida' }) });
      const { unmount } = renderUI(<Respaldos />);
      await waitFor(() => expect(screen.getByText(re)).toBeTruthy());
      if (prog && prog.hour === 'x') {
        expect(screen.getByLabelText('Hora').value).toBe('3:00');
        expect(screen.getByLabelText('Conservar').value).toBe('14');
        fireEvent.change(screen.getByLabelText('Hora'), { target: { value: '' } });
        fireEvent.change(screen.getByLabelText('Conservar'), { target: { value: '' } });
        fireEvent.change(screen.getByLabelText('Conservar'), { target: { value: '9' } });
        fireEvent.click(screen.getByRole('button', { name: 'Guardar programación' }));
        await waitFor(() => expect(promesas).toContainEqual(['error', 'hora inválida']));
      }
      unmount();
    }
  });

  it('si la programación no se puede leer, ofrece reintentar; la lista caída se avisa', async () => {
    let falla = true;
    const f = fakeFetch({ 'GET /backup': res(500, { error: 'sin disco' }), 'GET /backup/schedule': () => (falla ? res(500, { error: 'cron roto' }) : PROG) });
    renderUI(<Respaldos />);
    await waitFor(() => expect(toasts()).toContainEqual(['cron roto', 'bad']));
    expect(toasts()).toContainEqual(['sin disco', 'bad']);
    falla = false;
    fireEvent.click(screen.getByText('Reintentar'));
    await waitFor(() => expect(screen.getByText('Activo')).toBeTruthy());
    expect(f.a('GET', '/backup/schedule')).toHaveLength(2);
  });

  it('las fechas que no se pueden mostrar quedan como vinieron', async () => {
    const orig = Date.prototype.toLocaleString;
    vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (...a) { if (a[1] && a[1].dateStyle) throw new RangeError('x'); return orig.apply(this, a); });
    fakeFetch({ 'GET /backup': { respaldos: [{ nombre: 'a.tar.gz', creado: 'ayer', bytes: 1 }] }, 'GET /backup/schedule': null });
    renderUI(<Respaldos />);
    await waitFor(() => expect(screen.getByText('ayer')).toBeTruthy());
  });
});

/* ─────────────────────────── Configuración ─────────────────────────── */
describe('Configuración', () => {
  const RUTAS = (extra = {}) => ({
    'GET /system': { asterisk: '22.1', components: [{ group: 'Núcleo', name: 'Asterisk', detail: 'ok', status: 'ok' }, { group: 'Núcleo', name: 'Redis', status: 'raro' }, { group: 'Borde', name: 'SBC', status: 'down' }] },
    'GET /email/config': [{ tenant_id: 1, name: 'Acme', host: 'smtp.acme', port: 465, enabled: true, has_password: true }, { tenant_id: 2 }],
    'GET /prompts': [{ id: 7, name: 'bienvenida', format: 'wav', bytes: 20480, synced_at: '2026-10-01' }, { id: 8, name: 'cola', format: 'gsm' }],
    'GET /integrations': [{ type: 'telegram', configured: true, enabled: true, chat_id: '-100' }, { type: 'whatsapp', has_apikey: true, url: 'http://wa', to: '598@c.us' }],
    ...extra,
  });
  const solapa = (n) => fireEvent.click(screen.getByRole('tab', { name: n }));

  it('muestra los componentes por grupo con su estado', async () => {
    renderUI(<Configuracion />);   // sin fetch simulado todavía: arranca cargando
    fakeFetch(RUTAS());
    const r = renderUI(<Configuracion />);
    await waitFor(() => expect(screen.getByText(/Asterisk 22\.1/)).toBeTruthy());
    expect(screen.getByRole('tab', { name: 'Núcleo' })).toBeTruthy();
    expect(screen.getByText('Activo')).toBeTruthy();
    expect(screen.getByText('raro')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Borde' }));
    await waitFor(() => expect(screen.getByText('Caído')).toBeTruthy());
    fireEvent.click(screen.getAllByText('Recargar')[1]);
    expect(r).toBeTruthy();
  });

  it('abre la solapa pedida por ?tab= y monta los paneles de cada solapa', async () => {
    window.history.pushState({}, '', '/configuracion?tab=webrtc');
    fakeFetch(RUTAS());
    renderUI(<Configuracion />);
    await waitFor(() => expect(screen.getByText('origen del turn')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Servidor coturn' }));
    await waitFor(() => expect(screen.getByText('consola coturn')).toBeTruthy());
    for (const [t, txt] of [['Módulos', 'panel de módulos'], ['Branding', 'panel de marca'], ['Proxy / TLS', 'panel de proxy'], ['SIP', 'panel sip'], ['Alertas', 'panel de alertas']]) {
      solapa(t);
      await waitFor(() => expect(screen.getByText(txt)).toBeTruthy());
    }
    window.history.pushState({}, '', '/');
  });

  it('la solapa Integraciones muestra Telegram y WhatsApp y guarda, prueba y prende cada uno', async () => {
    let falla = false;
    const f = fakeFetch(RUTAS({
      'PUT /integrations/telegram': () => (falla ? res(500, { error: 'token inválido' }) : { ok: true }),
      'PUT /integrations/whatsapp': { ok: true },
      'POST /integrations/telegram/test': () => (falla ? res(502, { error: 'bot bloqueado' }) : { ok: true }),
    }));
    renderUI(<Configuracion />);
    solapa('Integraciones');
    await waitFor(() => expect(screen.getByText('Telegram')).toBeTruthy());
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Chat ID').value).toBe('-100'));
    expect(screen.getByLabelText('Destinatario').value).toBe('598@c.us');
    expect(screen.getByLabelText('API key').getAttribute('placeholder')).toMatch(/guardada/);
    fireEvent.change(screen.getByLabelText('Token del bot'), { target: { value: '123:ABC' } });
    fireEvent.change(screen.getByLabelText('Chat ID'), { target: { value: '-200' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Guardar' })[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['Integración guardada', 'ok']));
    expect(f.a('PUT', '/integrations/telegram')[0].body).toEqual({ token: '123:ABC', chat_id: '-200', enabled: true });
    await waitFor(() => expect(screen.getByLabelText('Token del bot').value).toBe(''));
    fireEvent.change(screen.getByLabelText('URL de la API openwa'), { target: { value: 'http://wa2' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'k' } });
    fireEvent.change(screen.getByLabelText('Destinatario'), { target: { value: '1@c.us' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Guardar' })[1]);
    await waitFor(() => expect(f.a('PUT', '/integrations/whatsapp')).toHaveLength(1));
    expect(f.a('PUT', '/integrations/whatsapp')[0].body).toEqual({ url: 'http://wa2', apikey: 'k', to: '1@c.us', enabled: undefined });
    fireEvent.click(screen.getAllByRole('button', { name: 'Probar' })[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['Mensaje de prueba enviado', 'ok']));
    expect(screen.getAllByRole('button', { name: 'Probar' })[1].disabled).toBe(true);
    // Interruptores: guardan solos y releen.
    fireEvent.click(screen.getAllByRole('switch')[1]);
    await waitFor(() => expect(f.a('PUT', '/integrations/whatsapp')).toHaveLength(2));
    expect(f.a('PUT', '/integrations/whatsapp')[1].body).toEqual({ enabled: true });
    falla = true;
    fireEvent.click(screen.getAllByRole('switch')[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['token inválido', 'bad']));
    fireEvent.click(screen.getAllByRole('button', { name: 'Guardar' })[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['Error al guardar', 'bad']));
    fireEvent.click(screen.getAllByRole('button', { name: 'Probar' })[0]);
    await waitFor(() => expect(toasts()).toContainEqual(['Falló: bot bloqueado', 'bad']));
  });

  it('email por empresa: elige empresa, edita SMTP, guarda y prueba', async () => {
    let falla = false;
    const f = fakeFetch(RUTAS({ 'POST /email/config': () => (falla ? res(400, { error: 'host vacío' }) : { ok: true }), 'POST /email/test': () => (falla ? res(502, { error: 'SMTP 535' }) : { ok: true }) }));
    renderUI(<Configuracion />);
    solapa('Email por empresa');
    await waitFor(() => expect(screen.getByLabelText('Servidor SMTP').value).toBe('smtp.acme'));
    expect(screen.getByLabelText('Contraseña').getAttribute('placeholder')).toMatch(/guardada/);
    fireEvent.change(screen.getByLabelText('Servidor SMTP'), { target: { value: 'smtp.gmail.com' } });
    fireEvent.change(screen.getByLabelText('Puerto'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'u@x' } });
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'app-pass' } });
    fireEvent.change(screen.getByLabelText('Remitente (From)'), { target: { value: 'PBX <n@x>' } });
    fireEvent.click(screen.getByRole('switch', { name: 'SSL/TLS directo (465)' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Email activo' }));
    fireEvent.click(screen.getByText('Guardar email'));
    await waitFor(() => expect(toasts()).toContainEqual(['Email guardado', 'ok']));
    expect(f.a('POST', '/email/config')[0].body).toMatchObject({ tenant_id: '1', host: 'smtp.gmail.com', port: 587, username: 'u@x', password: 'app-pass', from_addr: 'PBX <n@x>', secure: true, enabled: false });
    // Probar sin destinatario no hace nada; con destinatario manda.
    const probar = screen.getByRole('button', { name: 'Probar' });
    expect(probar.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('probar enviando a…'), { target: { value: 'yo@x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    await waitFor(() => expect(toasts()).toContainEqual(['Email de prueba enviado', 'ok']));
    expect(f.a('POST', '/email/test')[0].body).toEqual({ tenant_id: '1', to: 'yo@x' });
    // Cambiar a la otra empresa (sin config todavía).
    fireEvent.click(screen.getAllByLabelText('Empresa')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Empresa 2' }));
    await waitFor(() => expect(screen.getByLabelText('Servidor SMTP').value).toBe(''));
    falla = true;
    fireEvent.click(screen.getByText('Guardar email'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error al guardar', 'bad']));
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    await waitFor(() => expect(toasts()).toContainEqual(['Error: SMTP 535', 'bad']));
  });

  it('audios: sube uno con nombre saneado, lo reproduce al primer clic y lo borra confirmando', async () => {
    let falla = false;
    const f = fakeFetch(RUTAS({
      'POST /prompts': () => (falla ? res(413, {}) : { name: 'hola_mundo' }),
      'GET /prompts/7/audio': () => (falla ? res(404, {}) : res(200, new Blob(['RIFF']))),
      'DELETE /prompts/7': () => (falla ? res(403, {}) : { ok: true }),
    }));
    URL.createObjectURL = vi.fn(() => 'blob:audio'); URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const confirmar = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmar);
    const { container, unmount } = renderUI(<Configuracion />);
    solapa('Audios');
    await waitFor(() => expect(screen.getByText('custom/bienvenida')).toBeTruthy());
    expect(screen.getByText('20 KB')).toBeTruthy();
    expect(screen.getByText('Sincronizando…')).toBeTruthy();
    // Sube con nombre escrito (saneado a minúsculas y sin símbolos).
    fireEvent.change(screen.getByPlaceholderText('nombre (ej: bienvenida)'), { target: { value: 'Hola Mundo!' } });
    const input = container.querySelector('input[type=file]');
    fireEvent.change(input, { target: { files: [new File(['RIFF'], 'saludo.WAV', { type: 'audio/wav' })] } });
    await waitFor(() => expect(toasts()).toContainEqual(['Audio hola_mundo subido', 'ok']));
    const subida = f.a('POST', '/prompts')[0].body;
    expect(subida.name).toBe('holamundo');
    expect(subida.format).toBe('wav');
    expect(typeof subida.data).toBe('string');
    // Sin nombre usa el del archivo; un nombre que queda vacío se rechaza.
    fireEvent.change(input, { target: { files: [new File(['x'], '%%%.wav')] } });
    expect(toasts()).toContainEqual(['Poné un nombre válido', 'bad']);
    falla = true;
    fireEvent.change(input, { target: { files: [new File(['x'], 'otro.gsm')] } });
    await waitFor(() => expect(toasts()).toContainEqual(['Error al subir', 'bad']));
    expect(f.a('POST', '/prompts')[1].body).toMatchObject({ name: 'otro', format: 'gsm' });
    // Reproducir: el primer clic baja el audio con el token; si falla, avisa.
    const audio = container.querySelector('audio');
    fireEvent.click(audio.parentElement);
    await waitFor(() => expect(toasts()).toContainEqual(['No se pudo cargar el audio', 'bad']));
    falla = false;
    fireEvent.click(audio.parentElement);
    await waitFor(() => expect(audio.getAttribute('src')).toBe('blob:audio'));
    fireEvent.canPlay(audio);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    fireEvent.click(audio.parentElement);   // ya cargado: no vuelve a pedir
    expect(f.a('GET', '/prompts/7/audio')).toHaveLength(2);
    // Borrar: cancelado no hace nada; confirmado borra; un 403 no dice «eliminado».
    confirmar.mockReturnValueOnce(false);
    const fila = screen.getByText('custom/bienvenida').closest('tr');
    fireEvent.click(within(fila).getAllByRole('button').pop());
    expect(f.a('DELETE', '/prompts/7')).toHaveLength(0);
    fireEvent.click(within(fila).getAllByRole('button').pop());
    await waitFor(() => expect(toasts()).toContainEqual(['Audio eliminado', 'info']));
    falla = true;
    fireEvent.click(within(screen.getByText('custom/bienvenida').closest('tr')).getAllByRole('button').pop());
    await waitFor(() => expect(toasts()).toContainEqual(['No tenés permiso para esta acción', 'bad']));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audio');
  });

  it('cada carga que falla avisa; respuestas que no son listas no rompen', async () => {
    fakeFetch({ 'GET /system': res(500, { error: 'sistema caído' }), 'GET /email/config': res(500, { error: 'email caído' }), 'GET /prompts': res(500, { error: 'prompts caídos' }), 'GET /integrations': res(500, { error: 'integraciones caídas' }) });
    const { unmount } = renderUI(<Configuracion />);
    await waitFor(() => expect(toasts().map((t) => t[0])).toEqual(expect.arrayContaining(['sistema caído', 'email caído', 'prompts caídos', 'integraciones caídas'])));
    unmount();
    fakeFetch({ 'GET /system': {}, 'GET /email/config': {}, 'GET /prompts': {}, 'GET /integrations': {} });
    renderUI(<Configuracion />);
    solapa('Email por empresa');
    await waitFor(() => expect(screen.getByText('Cargando empresas…')).toBeTruthy());
    solapa('Audios');
    await waitFor(() => expect(screen.getByText('Sin audios personalizados. Subí uno para empezar.')).toBeTruthy());
    solapa('Integraciones');
    await waitFor(() => expect(screen.getByLabelText('Chat ID').value).toBe(''));
  });
});

/* ─────────────────────────── Llamadas en vivo ─────────────────────────── */
describe('Llamadas en vivo (supervisión)', () => {
  const SNAP = { channels: [
    { id: 'c1', name: 'PJSIP/1001-0001', connected: '099123', state: 'Up' },
    { id: 'c2', name: 'PJSIP/trunk-0002', caller: '1001', state: 'Up' },   // la otra pata (no repite)
    { id: 'c3', name: 'PJSIP/1002-0003', state: 'Ring' },
    { id: 'c4', name: 'Local/x' },
    { id: 'c5' },
  ] };

  it('agrupa canales en llamadas, muestra KPIs y espera el snapshot', () => {
    const { unmount } = renderUI(<Monitor />);
    expect(screen.getByText('Cargando…')).toBeTruthy();
    unmount();
    live.snap = SNAP; live.connected = true;
    renderUI(<Monitor />);
    expect(screen.getByText('3 llamadas en curso')).toBeTruthy();
    expect(screen.getByText('En vivo')).toBeTruthy();
    expect(screen.getByText('099123')).toBeTruthy();
    expect(screen.getByText('Ring')).toBeTruthy();
    expect(screen.getAllByText('Hablando')).toHaveLength(2);
    expect(screen.getByText('Cortar c1')).toBeTruthy();
  });

  it('sin llamadas lo dice', () => {
    live.snap = { channels: [] };
    renderUI(<Monitor />);
    expect(screen.getByText('No hay llamadas activas en este momento.')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('supervisar: recuerda la extensión del supervisor y manda el modo elegido', async () => {
    live.snap = SNAP;
    localStorage.setItem('pbxng_sup_ext', '2000');
    let falla = false;
    const f = fakeFetch({ 'POST /calls/spy': () => (falla ? res(403, {}) : { ok: true }) });
    renderUI(<Monitor />);
    await waitFor(() => expect(screen.getByPlaceholderText('Tu extensión (supervisor)').value).toBe('2000'));
    fireEvent.click(screen.getAllByText('Supervisar')[0]);
    await waitFor(() => expect(screen.getByText('Supervisar extensión 1001')).toBeTruthy());
    expect(screen.getByText('Sonará tu extensión 2000 y se conectará a la llamada')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Tu extensión \(supervisor\)/), { target: { value: ' 2001 ' } });
    fireEvent.click(screen.getByText('Susurrar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Llamando a tu extensión 2001…', 'ok']));
    expect(f.a('POST', '/calls/spy')[0].body).toEqual({ sup: '2001', target: '1001', mode: 'whisper' });
    expect(localStorage.getItem('pbxng_sup_ext')).toBe('2001');
    await waitFor(() => expect(screen.queryByText('Supervisar extensión 1001')).toBeNull());
    falla = true;
    fireEvent.click(screen.getAllByText('Supervisar')[1]);
    await waitFor(() => expect(screen.getByText('Irrumpir')).toBeTruthy());
    fireEvent.click(screen.getByText('Irrumpir'));
    await waitFor(() => expect(toasts()).toContainEqual(['No tenés permiso para esta acción', 'bad']));
    expect(f.a('POST', '/calls/spy')[1].body.mode).toBe('barge');
  });

  it('sin extensión no deja elegir modo; una extensión en blanco se rechaza; Escape cierra', async () => {
    live.snap = SNAP;
    fakeFetch({});
    renderUI(<Monitor />);
    fireEvent.click(screen.getAllByText('Supervisar')[0]);
    await waitFor(() => expect(screen.getByText('Escuchar')).toBeTruthy());
    expect(screen.getByText('Escuchar').closest('button').disabled).toBe(true);
    expect(screen.getByText('Sonará tu extensión — y se conectará a la llamada')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Tu extensión (supervisor)'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Escuchar'));
    expect(toasts()).toContainEqual(['Indicá tu extensión', 'bad']);
    fireEvent.keyDown(screen.getByText('Escuchar'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Supervisar extensión 1001')).toBeNull());
  });

  it('sin localStorage (navegador bloqueado) igual funciona', async () => {
    live.snap = SNAP;
    const roto = () => { throw new Error('bloqueado'); };
    vi.stubGlobal('localStorage', { getItem: roto, setItem: roto });
    fakeFetch({ 'POST /calls/spy': { ok: true } });
    renderUI(<Monitor />);
    fireEvent.change(screen.getByPlaceholderText('Tu extensión (supervisor)'), { target: { value: '3000' } });
    fireEvent.click(screen.getAllByText('Supervisar')[0]);
    await waitFor(() => expect(screen.getByText('Escuchar')).toBeTruthy());
    fireEvent.click(screen.getByText('Escuchar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Llamando a tu extensión 3000…', 'ok']));
  });
});

/* ─────────────────────────── Notificaciones Push ─────────────────────────── */
describe('Notificaciones Push', () => {
  const DEV = { vapid: true, webpush: [{ n: 3 }, { n: 2 }, {}], devices: [{ id: 1, ext: '1001', provider: 'fcm', prid_head: 'abc', ua: 'Pixel', updated_at: '2026-10-01T10:00:00Z' }, { id: 2, ext: '1002', provider: 'apns', prid_head: 'def' }, { id: 3, ext: '1003', provider: 'otro', prid_head: 'ghi' }], status: { fcm: true, apns: false } };
  const SET = { apns_key_id: 'KEY1', apns_team_id: 'TEAM', apns_topic: 'com.x.voip', apns_prod: '1' };

  it('muestra suscripciones, credenciales y dispositivos', async () => {
    fakeFetch({ 'GET /push/devices': DEV, 'GET /settings': SET });
    renderUI(<Notificaciones />);
    await waitFor(() => expect(screen.getByText('5')).toBeTruthy());
    expect(screen.getByText('VAPID activo')).toBeTruthy();
    expect(screen.getByText('Credencial: configurado')).toBeTruthy();
    expect(screen.getByText('Credencial: sin configurar')).toBeTruthy();
    expect(screen.getAllByText('1 dispositivo(s) registrados')).toHaveLength(2);
    expect(screen.getByText('FCM')).toBeTruthy();
    expect(screen.getByText('APNs')).toBeTruthy();
    expect(screen.getByText('otro')).toBeTruthy();
    expect(screen.getByText('Pixel')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Key ID').value).toBe('KEY1'));
    expect(screen.getByRole('switch', { name: /Producción/ }).checked).toBe(true);
  });

  it('guarda FCM sólo con JSON válido y APNs sin pisar la clave si no se escribió', async () => {
    let falla = false;
    const f = fakeFetch({ 'GET /push/devices': {}, 'GET /settings': { apns_key_id: '__SET__' }, 'POST /settings': () => (falla ? { error: 'x' } : { ok: true }) });
    renderUI(<Notificaciones />);
    await waitFor(() => expect(screen.getByText('Aún no hay dispositivos nativos (FCM/APNs) registrados. La PWA usa Web Push.')).toBeTruthy());
    expect(screen.getByLabelText('Key ID').value).toBe('');
    const fcm = screen.getByPlaceholderText(/service_account/);
    fireEvent.change(fcm, { target: { value: '{ roto' } });
    fireEvent.click(screen.getByText('Guardar FCM'));
    await waitFor(() => expect(toasts()).toContainEqual(['El JSON del service account no es válido', 'bad']));
    fireEvent.change(fcm, { target: { value: '{"type":"service_account"}' } });
    fireEvent.click(screen.getByText('Guardar FCM'));
    await waitFor(() => expect(toasts()).toContainEqual(['Guardado', 'ok']));
    expect(f.a('POST', '/settings')[0].body).toEqual({ fcm_service_account: '{"type":"service_account"}' });
    await waitFor(() => expect(fcm.value).toBe(''));
    fireEvent.change(screen.getByLabelText('Key ID'), { target: { value: 'K2' } });
    fireEvent.change(screen.getByLabelText('Team ID'), { target: { value: 'T2' } });
    fireEvent.change(screen.getByLabelText('Topic (bundle .voip)'), { target: { value: 'com.y.voip' } });
    fireEvent.click(screen.getByText('Guardar APNs'));
    await waitFor(() => expect(f.a('POST', '/settings')).toHaveLength(2));
    expect(f.a('POST', '/settings')[1].body).toEqual({ apns_key_id: 'K2', apns_team_id: 'T2', apns_topic: 'com.y.voip', apns_prod: '0' });
    fireEvent.change(screen.getByLabelText(/Clave de firma \.p8/), { target: { value: '-----BEGIN' } });
    fireEvent.click(screen.getByRole('switch', { name: /Producción/ }));
    falla = true;
    fireEvent.click(screen.getByText('Guardar APNs'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error al guardar', 'bad']));
    expect(f.a('POST', '/settings')[2].body).toMatchObject({ apns_key_p8: '-----BEGIN', apns_prod: '1' });
  });

  it('prueba de envío por extensión dice cuántas salieron; sin red no rompe la pantalla', async () => {
    let r = { sent: 2 };
    const f = fakeFetch({ 'GET /push/devices': RED_CAIDA, 'GET /settings': RED_CAIDA, 'POST /push/test': () => r, 'POST /settings': RED_CAIDA });
    renderUI(<Notificaciones />);
    await flush();
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Probar envío' }).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Extensión a probar'), { target: { value: '1001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probar envío' }));
    await waitFor(() => expect(toasts()).toContainEqual(['Enviadas 2 notificación(es)', 'ok']));
    expect(f.a('POST', '/push/test')[0].body).toEqual({ ext: '1001' });
    r = {};
    fireEvent.click(screen.getByRole('button', { name: 'Probar envío' }));
    await waitFor(() => expect(toasts()).toContainEqual(['Enviadas 0 notificación(es)', 'info']));
    r = RED_CAIDA;
    fireEvent.click(screen.getByRole('button', { name: 'Probar envío' }));
    await waitFor(() => expect(toasts()).toContainEqual(['Error', 'bad']));
    fireEvent.click(screen.getByText('Guardar APNs'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error al guardar', 'bad']));
  });

  it('recarga a mano y cada 30 s sólo con la pestaña visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = fakeFetch({ 'GET /push/devices': {}, 'GET /settings': {} });
    renderUI(<Notificaciones />);
    await waitFor(() => expect(f.a('GET', '/push/devices')).toHaveLength(1));
    fireEvent.click(screen.getByText('Recargar'));
    await waitFor(() => expect(f.a('GET', '/push/devices')).toHaveLength(2));
    await act(async () => { vi.advanceTimersByTime(30000); });
    await waitFor(() => expect(f.a('GET', '/push/devices')).toHaveLength(3));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.a('GET', '/push/devices')).toHaveLength(3);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });
});

/* ─────────────────────────── Usuarios ─────────────────────────── */
describe('Usuarios', () => {
  const USERS = [{ id: 1, username: 'admin', name: 'Administrador', role: 'admin', created_at: '2026-01-01' }, { id: 2, username: 'ana', name: 'Ana', role: 'supervisor' }, { id: 3, username: 'beto', role: 'agente' }, { id: 4, username: 'viejo', role: 'operator' }];

  it('lista cuentas con su rol (los roles viejos se ven crudos) y busca', async () => {
    fakeFetch({ 'GET /users': USERS });
    renderUI(<Usuarios />);
    await waitFor(() => expect(screen.getByText('4 cuentas')).toBeTruthy());
    expect(screen.getByText('Supervisor')).toBeTruthy();
    expect(screen.getByText('Agente')).toBeTruthy();
    expect(screen.getByText('operator')).toBeTruthy();
    // admin no se puede borrar: sólo tiene el botón de clave.
    expect(within(screen.getByText('admin').closest('tr')).getAllByRole('button')).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText('Buscar usuario'), { target: { value: 'AN' } });
    expect(screen.queryByText('beto')).toBeNull();
    expect(screen.getByText('ana')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Buscar usuario'), { target: { value: 'zzz' } });
    expect(screen.getByText('Sin resultados.')).toBeTruthy();
  });

  it('sin usuarios (o respuesta rara) lo dice', async () => {
    fakeFetch({ 'GET /users': { error: 'x' } });
    renderUI(<Usuarios />);
    await waitFor(() => expect(screen.getByText('Sin usuarios.')).toBeTruthy());
  });

  it('crear exige clave de 8 y por defecto crea agentes; un admin muestra el aviso', async () => {
    let falla = false;
    const f = fakeFetch({ 'GET /users': USERS, 'POST /users': (req) => (falla ? res(409, { error: 'ya existe' }) : (req.body.username === 'carla' ? { created: 'carla' } : null)) });
    renderUI(<Usuarios />);
    await waitFor(() => expect(screen.getByText('4 cuentas')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo usuario' }));
    await waitFor(() => expect(screen.getByText('Crear usuario')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^Usuario/), { target: { value: 'carla' } });
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Carla' } });
    fireEvent.change(screen.getByLabelText(/^Contraseña/), { target: { value: 'corta' } });
    fireEvent.click(screen.getByText('Crear usuario'));
    expect(toasts()).toContainEqual(['La contraseña debe tener al menos 8 caracteres', 'bad']);
    fireEvent.change(screen.getByLabelText(/^Contraseña/), { target: { value: 'larga1234' } });
    fireEvent.click(screen.getByText('Crear usuario'));
    await waitFor(() => expect(toasts()).toContainEqual(['Usuario carla creado', 'ok']));
    expect(f.a('POST', '/users')[0].body).toEqual({ role: 'agente', username: 'carla', name: 'Carla', password: 'larga1234' });
    await waitFor(() => expect(f.a('GET', '/users')).toHaveLength(2));
    // Otro, eligiendo administrador.
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo usuario' }));
    await waitFor(() => expect(screen.getByLabelText(/^Usuario/).value).toBe(''));
    fireEvent.change(screen.getByLabelText(/^Usuario/), { target: { value: 'dani' } });
    fireEvent.change(screen.getByLabelText(/^Contraseña/), { target: { value: 'larga1234' } });
    fireEvent.click(screen.getAllByLabelText('Rol')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Administrador' }));
    await waitFor(() => expect(screen.getByText(/Un administrador puede cambiar troncales/)).toBeTruthy());
    fireEvent.click(screen.getByText('Crear usuario'));
    await waitFor(() => expect(toasts()).toContainEqual(['Usuario dani creado', 'ok']));
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo usuario' }));
    await waitFor(() => expect(screen.getByText('Crear usuario')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^Contraseña/), { target: { value: 'larga1234' } });
    falla = true;
    fireEvent.click(screen.getByText('Crear usuario'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error: ya existe', 'bad']));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByText('Crear usuario')).toBeNull());
  });

  it('cambiar contraseña y borrar (confirmando) llaman a la API correcta', async () => {
    let falla = false;
    const f = fakeFetch({ 'GET /users': USERS, 'POST /users/2/password': () => (falla ? res(500, { error: 'no' }) : { ok: true }), 'DELETE /users/3': () => (falla ? res(403, {}) : { ok: true }) });
    const confirmar = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmar);
    renderUI(<Usuarios />);
    await waitFor(() => expect(screen.getByText('4 cuentas')).toBeTruthy());
    fireEvent.click(within(screen.getByText('ana').closest('tr')).getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Cuenta ana')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Nueva contraseña/), { target: { value: '123' } });
    fireEvent.click(screen.getByText('Actualizar'));
    expect(toasts()).toContainEqual(['La contraseña debe tener al menos 8 caracteres', 'bad']);
    fireEvent.change(screen.getByLabelText(/Nueva contraseña/), { target: { value: 'nueva12345' } });
    fireEvent.click(screen.getByText('Actualizar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Contraseña actualizada', 'ok']));
    expect(f.a('POST', '/users/2/password')[0].body).toEqual({ password: 'nueva12345' });
    await waitFor(() => expect(screen.queryByText('Cuenta ana')).toBeNull());
    falla = true;
    fireEvent.click(within(screen.getByText('ana').closest('tr')).getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Cuenta ana')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Nueva contraseña/), { target: { value: 'nueva12345' } });
    fireEvent.click(screen.getByText('Actualizar'));
    await waitFor(() => expect(toasts()).toContainEqual(['Error: no', 'bad']));
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancelar' }).pop());
    await waitFor(() => expect(screen.queryByText('Cuenta ana')).toBeNull());
    // Borrar.
    const borrar = () => fireEvent.click(within(screen.getByText('beto').closest('tr')).getAllByRole('button')[1]);
    confirmar.mockReturnValueOnce(false);
    borrar();
    expect(f.a('DELETE', '/users/3')).toHaveLength(0);
    expect(confirmar).toHaveBeenCalledWith('¿Eliminar el usuario beto?');
    borrar();
    await waitFor(() => expect(toasts()).toContainEqual(['Error: No tenés permiso para esta acción', 'bad']));
    falla = false;
    borrar();
    await waitFor(() => expect(toasts()).toContainEqual(['Usuario eliminado', 'info']));
  });
});

/* ─────────────────────────── Manuales ─────────────────────────── */
describe('Manuales', () => {
  const INDEX = { manuals: [{ id: 'admin', title: 'Manual del administrador', subtitle: 'Todo', audience: 'TI', accent: '#7048e8', icon: '📘' }, { id: 'agente', title: 'Manual del agente', audience: 'Agentes', accent: '#12b886', icon: '🎧' }] };
  const MD = '# Admin\n![Pantalla de inicio](img/inicio.png)\n![](img/troncales.png)\n';

  function rutas(extra = {}) {
    return {
      'GET /manuales/index.json': INDEX,
      'GET /manuales/admin.md': res(200, MD),
      'GET /manuales/agente.md': RED_CAIDA,
      'GET /manuales/img-list': { cargadas: ['inicio.png'] },
      ...extra,
    };
  }

  it('lista los manuales con sus enlaces y cuenta las capturas cargadas', async () => {
    fakeFetch(rutas());
    renderUI(<Manuales />);
    await waitFor(() => expect(screen.getByText('Manual del administrador')).toBeTruthy());
    expect(screen.getByText('Dirigido a: TI')).toBeTruthy();
    expect(screen.getAllByText('Abrir manual')[0].closest('a').getAttribute('href')).toBe('/manuales/admin.html');
    expect(screen.getAllByText('PDF')[0].closest('a').getAttribute('href')).toBe('/manuales/admin.html?print=1');
    expect(screen.getAllByText('Markdown')[0].closest('a').hasAttribute('download')).toBe(true);
    await waitFor(() => expect(screen.getAllByText('1 / 2')).toHaveLength(2));   // total y el del manual
    expect(screen.getByText('0 / 0')).toBeTruthy();   // el del agente no tiene capturas (md caído)
    expect(screen.getByText('cargada')).toBeTruthy();
    expect(screen.getByText('pendiente')).toBeTruthy();
    expect(screen.getByAltText('Pantalla de inicio').getAttribute('src')).toBe('/backend/api/manuales/img/inicio.png?v=0');
    expect(screen.getByText('Clic y Ctrl+V para pegar')).toBeTruthy();
  });

  it('sin índice ni lista de cargadas no rompe', async () => {
    fakeFetch({ 'GET /manuales/index.json': RED_CAIDA, 'GET /manuales/img-list': RED_CAIDA });
    renderUI(<Manuales />);
    await waitFor(() => expect(screen.getByText('0 / 0')).toBeTruthy());
    expect(screen.getByText('Cargar capturas')).toBeTruthy();
  });

  it('pegar, arrastrar o elegir una imagen la sube con su nombre; quitarla la saca', async () => {
    let falla = null;
    const f = fakeFetch(rutas({
      'POST /manuales/img/troncales.png': () => (falla ? falla : { ok: true }),
      'DELETE /manuales/img/inicio.png': () => (falla ? falla : { ok: true }),
    }));
    vi.stubGlobal('Image', class { constructor() { this.width = 3600; this.height = 1800; } set src(_v) { setTimeout(() => this.onload(), 0); } });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,CHICA');
    const { container } = renderUI(<Manuales />);
    await waitFor(() => expect(screen.getByText('troncales.png')).toBeTruthy());
    const zona = screen.getByText('troncales.png').closest('.mantine-Card-root');
    const area = zona.querySelector('[tabindex="0"]');
    const png = new File(['png'], 'cap.png', { type: 'image/png' });
    // Pegar algo que no es imagen no hace nada; pegar una imagen la sube achicada.
    fireEvent.paste(area, { clipboardData: { items: [{ type: 'text/plain' }] } });
    fireEvent.paste(area, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => png }] } });
    await waitFor(() => expect(toasts()).toContainEqual(['Cargada: troncales.png', 'ok']));
    expect(f.a('POST', '/manuales/img/troncales.png')[0].body).toEqual({ data: 'data:image/png;base64,CHICA' });
    await waitFor(() => expect(screen.getAllByText('2 / 2')).toHaveLength(2));
    // Arrastrar un archivo que no es imagen.
    fireEvent.dragOver(area);
    fireEvent.drop(area, { dataTransfer: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } });
    expect(toasts()).toContainEqual(['Eso no es una imagen', 'bad']);
    fireEvent.drop(area, { dataTransfer: { files: [] } });
    // Un 413 del proxy viene en HTML: el mensaje igual se entiende.
    falla = res(413, '<html>too large</html>');
    fireEvent.drop(area, { dataTransfer: { files: [png] } });
    await waitFor(() => expect(toasts()).toContainEqual(['La imagen es demasiado grande para subirla.', 'bad']));
    // Elegir archivo con el botón.
    falla = res(418, '');
    const input = zona.querySelector('input[type=file]');
    fireEvent.change(input, { target: { files: [png] } });
    await waitFor(() => expect(toasts()).toContainEqual(['El servidor respondió 418.', 'bad']));
    fireEvent.change(input, { target: { files: [] } });
    falla = { error: 'nombre inválido' };   // 200 con {error}: también es un error
    fireEvent.click(within(zona).getByText('Archivo'));
    fireEvent.change(input, { target: { files: [png] } });
    await waitFor(() => expect(toasts()).toContainEqual(['nombre inválido', 'bad']));
    // Quitar la que estaba cargada.
    falla = null;
    const zonaInicio = screen.getByText('inicio.png').closest('.mantine-Card-root');
    fireEvent.click(zonaInicio.querySelector('[tabindex="0"]'));   // cargada: el clic no abre el selector
    fireEvent.click(within(zonaInicio).getAllByRole('button').pop());
    await waitFor(() => expect(f.a('DELETE', '/manuales/img/inicio.png')).toHaveLength(1));
    await waitFor(() => expect(within(zonaInicio).getByText('pendiente')).toBeTruthy());
    expect(container).toBeTruthy();
  });

  it('quitar con error lo avisa; una imagen chica o ilegible se sube tal cual', async () => {
    const f = fakeFetch(rutas({ 'POST /manuales/img/troncales.png': { ok: true }, 'DELETE /manuales/img/inicio.png': res(403, {}) }));
    let ilegible = false;
    vi.stubGlobal('Image', class { constructor() { this.width = 800; this.height = 600; } set src(_v) { setTimeout(() => (ilegible ? this.onerror() : this.onload()), 0); } });
    renderUI(<Manuales />);
    await waitFor(() => expect(screen.getByText('inicio.png')).toBeTruthy());
    const zonaInicio = screen.getByText('inicio.png').closest('.mantine-Card-root');
    fireEvent.click(within(zonaInicio).getAllByRole('button').pop());
    await waitFor(() => expect(toasts()).toContainEqual(['No tenés permiso para editar los manuales.', 'bad']));
    const area = screen.getByText('troncales.png').closest('.mantine-Card-root').querySelector('[tabindex="0"]');
    const png = new File(['png'], 'cap.png', { type: 'image/png' });
    fireEvent.drop(area, { dataTransfer: { files: [png] } });
    await waitFor(() => expect(f.a('POST', '/manuales/img/troncales.png')).toHaveLength(1));
    expect(f.a('POST', '/manuales/img/troncales.png')[0].body.data).toMatch(/^data:image\/png;base64,/);
    ilegible = true;
    fireEvent.drop(area, { dataTransfer: { files: [png] } });
    await waitFor(() => expect(f.a('POST', '/manuales/img/troncales.png')).toHaveLength(2));
  });

  it('si el archivo no se puede leer, lo dice', async () => {
    fakeFetch(rutas());
    const Orig = window.FileReader;
    vi.stubGlobal('FileReader', class { readAsDataURL() { setTimeout(() => this.onerror(new Event('error')), 0); } });
    renderUI(<Manuales />);
    await waitFor(() => expect(screen.getByText('troncales.png')).toBeTruthy());
    const area = screen.getByText('troncales.png').closest('.mantine-Card-root').querySelector('[tabindex="0"]');
    fireEvent.drop(area, { dataTransfer: { files: [new File(['png'], 'cap.png', { type: 'image/png' })] } });
    await waitFor(() => expect(toasts()).toContainEqual(['No se pudo leer el archivo.', 'bad']));
    expect(Orig).toBeTruthy();
  });

  it('los demás códigos conocidos del servidor también tienen su mensaje', async () => {
    let r = res(401, '');
    fakeFetch(rutas({ 'POST /manuales/img/troncales.png': () => r }));
    vi.stubGlobal('Image', class { constructor() { this.width = 10; this.height = 10; } set src(_v) { setTimeout(() => this.onload(), 0); } });
    renderUI(<Manuales />);
    await waitFor(() => expect(screen.getByText('troncales.png')).toBeTruthy());
    const area = screen.getByText('troncales.png').closest('.mantine-Card-root').querySelector('[tabindex="0"]');
    const png = new File(['png'], 'cap.png', { type: 'image/png' });
    fireEvent.drop(area, { dataTransfer: { files: [png] } });
    await waitFor(() => expect(toasts()).toContainEqual(['Se venció la sesión. Volvé a entrar al panel.', 'bad']));
    r = res(502, '');
    fireEvent.drop(area, { dataTransfer: { files: [png] } });
    await waitFor(() => expect(toasts()).toContainEqual(['El backend no respondió. Revisá que el servicio esté arriba.', 'bad']));
  });
});
