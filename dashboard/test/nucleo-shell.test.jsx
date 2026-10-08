/* El armazón del panel (`app/shell.jsx`): el menú lateral y el cartel de «base de datos
 * sin respuesta». Se fija QUÉ ve cada rol (el supervisor sólo lo que SUP_OK le deja, el
 * admin todo, nadie mientras no se sabe quién entró), que un módulo apagado se lleve sus
 * ítems, que las pantallas de pantalla completa (/phone, /login…) no traigan el menú, y que
 * el aviso de base caída salga del snapshot con el socket vivo y de /backend/health sin él. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { renderConMantine, authMock, instalarStorage } from './helpers/nucleo-render.jsx';

const nav = vi.hoisted(() => ({ path: '/' }));
const live = vi.hoisted(() => ({ snap: null, connected: false }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
// Con forwardRef como el Link real: el Tooltip del modo riel le pasa una ref.
vi.mock('next/link', async () => { const { forwardRef } = await import('react'); return { default: forwardRef(({ href, children, ...p }, ref) => <a ref={ref} href={href} {...p}>{children}</a>) }; });
vi.mock('../app/useLive.js', () => ({ useLive: () => live }));
vi.mock('../app/auth.jsx', async () => (await import('./helpers/nucleo-render.jsx')).authModuleMock());
vi.mock('../app/NightMode.jsx', () => ({ NightModeChip: () => <span>chip-noche</span> }));
vi.mock('../app/PbxLogo.jsx', () => ({ default: () => <span>logo-pbx</span> }));

import Shell from '../app/shell.jsx';

let fetchMock, st, respuestas;
beforeEach(() => {
  nav.path = '/';
  live.snap = null; live.connected = true;
  authMock.reset();
  authMock.user = { role: 'admin', name: 'Ana', username: 'ana' };
  st = instalarStorage({ pbxng_jwt: 'jwt' });
  respuestas = {
    '/backend/api/modules': { ok: true, status: 200, json: async () => ({}) },
    '/backend/api/branding': { ok: true, status: 200, json: async () => ({ name: 'Central Uno', subtitle: 'Sede', logo: '' }) },
    '/backend/health': { ok: true, status: 200, json: async () => ({ db: true }) },
  };
  fetchMock = vi.fn(async (u) => respuestas[u] || { ok: false, status: 404, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const montar = async (children = <p>contenido</p>) => {
  const r = renderConMantine(<Shell>{children}</Shell>);
  await act(async () => {});
  return r;
};
const links = () => screen.queryAllByRole('link', { hidden: true }).map((a) => a.getAttribute('href'));

describe('pantallas sin menú', () => {
  it.each(['/phone', '/enroll/x', '/call/t', '/sala/1', '/agente', '/supervisor', '/login'])('%s se dibuja sola', async (p) => {
    nav.path = p;
    await montar();
    expect(screen.getByText('contenido')).toBeTruthy();
    expect(screen.queryByText('Cerrar sesión')).toBeNull();
    expect(links()).toEqual([]);
  });
});

describe('menú por rol', () => {
  it('admin ve el Resumen y todos los grupos; abre por defecto el grupo de la ruta activa', async () => {
    nav.path = '/troncales';
    await montar();
    expect(links()).toContain('/');
    for (const g of ['Telefonía', 'Aplicaciones', 'Portería', 'Operación', 'Sistema', 'Mantenimiento']) expect(screen.getAllByText(g).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Troncales' }).getAttribute('data-active')).toBe('true');
    expect(screen.queryByRole('link', { name: 'Panel de supervisión' })).toBeNull();
    expect(screen.getByText('chip-noche')).toBeTruthy();
    expect(screen.getByText('Central Uno')).toBeTruthy();
    expect(document.title).toBe('Central Uno');
  });

  it('supervisor: sólo SUP_OK más el link de vuelta a su panel, nada de configuración', async () => {
    authMock.user = { role: 'supervisor', name: 'Sole' };
    nav.path = '/cdr';
    await montar();
    const l = links();
    expect(l).toContain('/supervisor');
    expect(l).toEqual(expect.arrayContaining(['/cdr', '/reportes', '/wallboard', '/monitor', '/salas']));
    for (const prohibido of ['/', '/troncales', '/usuarios', '/respaldos', '/mapa', '/telefonos']) expect(l).not.toContain(prohibido);
    expect(screen.queryByText('Sistema')).toBeNull();
  });

  it('agente: ningún ítem (no tiene pantallas en este shell) ni chip de modo noche', async () => {
    authMock.user = { role: 'agente' };
    nav.path = '/x';
    await montar();
    expect(links()).toEqual([]);
    expect(screen.queryByText('chip-noche')).toBeNull();
  });

  it('mientras no se sabe quién entró: esqueleto, sin ítems; sin sesión (null): ni lo uno ni lo otro', async () => {
    authMock.user = undefined;
    nav.path = '/x';
    const { container, rerender } = await montar();
    expect(links()).toEqual([]);
    expect(container.querySelectorAll('.mantine-Skeleton-root').length).toBe(9);
    authMock.user = null;
    rerender(<Shell><p>contenido</p></Shell>);
    expect(container.querySelectorAll('.mantine-Skeleton-root').length).toBe(0);
    expect(screen.getByText('Admin')).toBeTruthy();
    expect(screen.queryByText('chip-noche')).toBeNull();
  });

  it('un módulo apagado se lleva sus ítems y, si el grupo queda vacío, el grupo', async () => {
    respuestas['/backend/api/modules'] = { ok: true, json: async () => ({ intercom: false, sbc: false, ai: true }) };
    nav.path = '/sistema';
    await montar();
    await waitFor(() => expect(screen.queryByText('Portería')).toBeNull());
    expect(links()).not.toContain('/sbc');
    expect(links()).toContain('/ia-voz');
  });

  it('sin JWT de panel no pide los módulos; si fallan, quedan todos visibles', async () => {
    st.local.removeItem('pbxng_jwt');
    nav.path = '/x';
    await montar();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/backend/api/modules')).toBe(false);
    st.local.setItem('pbxng_jwt', 'j');
    respuestas['/backend/api/modules'] = { ok: false, status: 500, json: async () => ({}) };
    await montar();
    expect(screen.getAllByText('Portería').length).toBeGreaterThan(0);
  });

  it('localStorage bloqueado o red caída en módulos/branding no rompen el menú', async () => {
    st.local.getItem = () => { throw new Error('bloqueado'); };
    fetchMock.mockImplementation(async () => { throw new Error('red'); });
    nav.path = '/x';
    await montar();
    expect(screen.getByText('PBX-NG')).toBeTruthy();
    expect(screen.getByText('Comunicaciones')).toBeTruthy();
  });
});

describe('interacción', () => {
  it('acordeón: abrir un grupo cierra el otro; volver a tocarlo lo cierra', async () => {
    vi.useFakeTimers();
    nav.path = '/troncales';
    await montar();
    const cab = (label) => screen.getAllByText(label)[0];
    const colapsoDe = (label) => cab(label).closest('.mantine-UnstyledButton-root, button').nextElementSibling;
    expect(colapsoDe('Telefonía').getAttribute('aria-hidden')).toBe('false');
    fireEvent.click(cab('Sistema'));
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(colapsoDe('Sistema').getAttribute('aria-hidden')).toBe('false');
    expect(colapsoDe('Telefonía').getAttribute('aria-hidden')).toBe('true');
    window.HTMLElement.prototype.scrollIntoView = () => { throw new Error('x'); };
    fireEvent.click(cab('Sistema'));
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(colapsoDe('Sistema').getAttribute('aria-hidden')).toBe('true');
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('sin ruta activa en ningún grupo abre Telefonía', async () => {
    nav.path = '/';
    await montar();
    expect(screen.getByRole('link', { name: 'Resumen' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('link', { name: 'Extensiones', hidden: true })).toBeTruthy();
  });

  it('contraer el menú lo deja en riel (con tooltips), lo recuerda y se puede expandir', async () => {
    nav.path = '/troncales';
    await montar();
    fireEvent.click(screen.getByText('Troncales').closest('nav').querySelector('button.mantine-ActionIcon-root'));
    expect(st.local.getItem('pbxng_rail')).toBe('1');
    expect(screen.queryByText('Central Uno')).toBeNull();
    expect(screen.queryByText('Telefonía')).toBeNull();
    expect(links()).toContain('/troncales');
    const botones = document.querySelectorAll('nav button.mantine-ActionIcon-root');
    fireEvent.click(botones[0]);
    expect(st.local.getItem('pbxng_rail')).toBe('0');
    expect(screen.getByText('Telefonía')).toBeTruthy();
  });

  it('arranca en riel si quedó guardado; guardar con storage roto no rompe', async () => {
    st.local.setItem('pbxng_rail', '1');
    nav.path = '/x';
    await montar();
    expect(screen.queryByText('Telefonía')).toBeNull();
    st.local.setItem = () => { throw new Error('lleno'); };
    fireEvent.click(document.querySelectorAll('nav button.mantine-ActionIcon-root')[0]);
    expect(screen.getByText('Telefonía')).toBeTruthy();
  });

  it('logo propio del branding y el botón de tema alterna claro/oscuro', async () => {
    respuestas['/backend/api/branding'] = { json: async () => ({ name: '', subtitle: 's', logo: '/logo.png' }) };
    nav.path = '/x';
    await montar();
    expect(document.querySelector('img[src="/logo.png"]')).toBeTruthy();
    const tema = () => [...document.querySelectorAll('nav button.mantine-ActionIcon-root')].at(-1);
    fireEvent.click(tema());
    await act(async () => {});
    fireEvent.click(tema());
    expect(tema()).toBeTruthy();
  });

  it('el menú de usuario muestra el usuario y cierra sesión', async () => {
    nav.path = '/x';
    await montar();
    expect(screen.getByText('Ana')).toBeTruthy();
    fireEvent.click(screen.getByText('Ana'));
    await waitFor(() => expect(screen.getByText('ana')).toBeTruthy());
    fireEvent.click(screen.getByText('Cerrar sesión'));
    expect(authMock.logout).toHaveBeenCalled();
  });

  it('usuario sin nombre ni username: «A», «Admin» y «sesión»', async () => {
    authMock.user = { role: 'admin' };
    nav.path = '/x';
    await montar();
    fireEvent.click(screen.getByText('Admin'));
    await waitFor(() => expect(screen.getByText('sesión')).toBeTruthy());
  });
});

describe('estado de conexión y base de datos', () => {
  it('socket vivo: «En vivo», y el cartel depende de health.db del snapshot', async () => {
    live.connected = true; live.snap = { health: { db: false } };
    nav.path = '/x';
    const { rerender } = await montar();
    expect(screen.getByText('En vivo')).toBeTruthy();
    expect(screen.getByText('Base de datos sin respuesta')).toBeTruthy();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/backend/health')).toBe(false);
    live.snap = { health: { db: true } };
    rerender(<Shell><p>contenido</p></Shell>);
    expect(screen.queryByText('Base de datos sin respuesta')).toBeNull();
    live.snap = { calls: [] };
    rerender(<Shell><p>contenido</p></Shell>);
    expect(screen.queryByText('Base de datos sin respuesta')).toBeNull();
  });

  it('socket caído: «Offline» y se pregunta a /backend/health (503 o db:false = caída) cada 30 s', async () => {
    vi.useFakeTimers();
    live.connected = false;
    respuestas['/backend/health'] = { status: 503, json: async () => { throw new Error('html'); } };
    nav.path = '/x';
    const { unmount } = await montar();
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.getByText('Base de datos sin respuesta')).toBeTruthy();
    respuestas['/backend/health'] = { status: 200, json: async () => ({ db: true }) };
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.queryByText('Base de datos sin respuesta')).toBeNull();
    respuestas['/backend/health'] = { status: 200, json: async () => ({ db: false }) };
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText('Base de datos sin respuesta')).toBeTruthy();
    fetchMock.mockImplementation(async () => { throw new Error('api caída'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText('Base de datos sin respuesta')).toBeTruthy();
    const n = fetchMock.mock.calls.length;
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(fetchMock.mock.calls.length).toBe(n);
  });

  it('una respuesta de health que llega tras desmontar se ignora', async () => {
    live.connected = false;
    let fin;
    fetchMock.mockImplementation((u) => (u === '/backend/health' ? new Promise((r) => { fin = r; }) : Promise.resolve({ ok: false, json: async () => ({}) })));
    nav.path = '/x';
    const { unmount } = await montar();
    unmount();
    await act(async () => { fin({ status: 503, json: async () => ({}) }); });
    expect(screen.queryByText('Base de datos sin respuesta')).toBeNull();
  });

  it('una pantalla que revienta deja el menú en pie', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Rota() { throw new Error('pantalla rota'); }
    nav.path = '/troncales';
    await montar(<Rota />);
    expect(screen.getByText('pantalla rota')).toBeTruthy();
    expect(within(document.querySelector('nav')).getByText('Troncales')).toBeTruthy();
  });
});
