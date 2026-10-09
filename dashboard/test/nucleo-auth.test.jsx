/* Sesión y permisos del panel (`app/auth.jsx`). Dos piezas que el operador nunca ve pero
 * sufre si fallan: el parche global de `fetch` (pone el token, manda a /login ante un 401
 * y avisa UNA vez ante un 403) y el `AuthProvider`, que decide a qué pantalla se queda
 * cada rol. Un error acá es un agente mirando la configuración, un supervisor rebotado de
 * una pantalla que el menú le ofrece, o una lluvia de toasts iguales. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { instalarStorage } from './helpers/nucleo-render.jsx';

const nav = { path: '/', replace: vi.fn() };
vi.mock('next/navigation', () => ({ usePathname: () => nav.path, useRouter: () => ({ replace: nav.replace }) }));
const toast = vi.fn();
vi.mock('../app/notify.js', () => ({ toast: (...a) => toast(...a) }));

const resp = (status, body) => ({
  status, ok: status < 300,
  json: async () => body,
  clone() { return { json: async () => { if (body instanceof Error) throw body; return body; } }; },
});

let orig, loc, st;
async function cargar() {
  vi.resetModules();
  return import('../app/auth.jsx');
}
beforeEach(() => {
  orig = vi.fn();
  window.fetch = orig;
  loc = { pathname: '/', href: '' };
  vi.stubGlobal('location', loc);
  st = instalarStorage();
  nav.path = '/'; nav.replace = vi.fn();
  toast.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('parche de fetch', () => {
  it('pone el Bearer de la sesión de panel sólo en /backend; si no hay, el del softphone', async () => {
    await cargar();
    orig.mockResolvedValue(resp(200, {}));
    localStorage.setItem('pbxng_phone_jwt', 'tel');
    await window.fetch('/backend/api/x', { headers: { A: '1' } });
    expect(orig.mock.calls[0][1].headers).toEqual({ A: '1', Authorization: 'Bearer tel' });
    localStorage.setItem('pbxng_jwt', 'panel');
    await window.fetch({ url: '/backend/api/y' });
    expect(orig.mock.calls[1][1].headers.Authorization).toBe('Bearer panel');
    await window.fetch('/version.json');
    expect(orig.mock.calls[2][1]).toEqual({});
  });

  it('sin token no inventa cabecera, y una URL rara no rompe el pedido', async () => {
    await cargar();
    orig.mockResolvedValue(resp(200, {}));
    await window.fetch('/backend/api/x');
    expect(orig.mock.calls[0][1].headers).toEqual({});
    await window.fetch(null);
    expect(orig).toHaveBeenCalledTimes(2);
    st.local.getItem = () => { throw new Error('bloqueado'); };
    await window.fetch('/backend/api/z', { headers: { B: '2' } });
    expect(orig.mock.calls[2][1]).toEqual({ headers: { B: '2' } });
  });

  it('401 en una pantalla del panel borra la sesión y manda a /login', async () => {
    await cargar();
    localStorage.setItem('pbxng_jwt', 'vieja');
    loc.pathname = '/troncales';
    orig.mockResolvedValue(resp(401, {}));
    await window.fetch('/backend/api/x');
    expect(localStorage.getItem('pbxng_jwt')).toBeNull();
    expect(loc.href).toBe('/login');
  });

  it.each(['/login', '/phone', '/enroll/abc', '/call/tok', '/sala/1'])('401 en %s no redirige (tienen su propio manejo)', async (p) => {
    await cargar();
    localStorage.setItem('pbxng_jwt', 'x');
    loc.pathname = p;
    orig.mockResolvedValue(resp(401, {}));
    await window.fetch('/backend/api/x');
    expect(loc.href).toBe('');
    expect(localStorage.getItem('pbxng_jwt')).toBe('x');
  });

  it('403 avisa con el `error` de la API, una sola vez cada 3 s, y deja el body intacto', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100000);
    await cargar();
    const r = resp(403, { error: 'Sólo administradores' });
    orig.mockResolvedValue(r);
    expect(await window.fetch('/backend/api/x')).toBe(r);
    await window.fetch('/backend/api/x');
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sólo administradores', 'bad'));
    expect(toast).toHaveBeenCalledTimes(1);
    vi.setSystemTime(104000);
    orig.mockResolvedValue(resp(403, { error: 5 }));
    await window.fetch('/backend/api/x');
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(toast).toHaveBeenLastCalledWith('No tenés permiso para esta acción', 'bad');
  });

  it('403 con body ilegible o sin clone() igual avisa con el mensaje genérico', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(200000);
    await cargar();
    orig.mockResolvedValue(resp(403, new Error('no es json')));
    await window.fetch('/x');
    await waitFor(() => expect(toast).toHaveBeenCalledWith('No tenés permiso para esta acción', 'bad'));
    vi.setSystemTime(300000);
    orig.mockResolvedValue({ status: 403, clone() { throw new Error('ya leído'); } });
    await window.fetch('/x');
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('el parche se aplica una sola vez aunque el provider monte varias veces', async () => {
    const { AuthProvider } = await cargar();
    const parcheado = window.fetch;
    nav.path = '/login';
    render(<AuthProvider><i /></AuthProvider>);
    render(<AuthProvider><i /></AuthProvider>);
    expect(window.fetch).toBe(parcheado);
  });
});

describe('AuthProvider: quién se queda dónde', () => {
  function Ver({ useAuth, out }) { out.v = useAuth(); return null; }
  async function montar(path, me) {
    const mod = await cargar();
    nav.path = path;
    if (me !== undefined) orig.mockResolvedValue(me instanceof Error ? Promise.reject(me) : resp(me ? 200 : 401, me ? { user: me } : {}));
    const out = {};
    const r = render(<mod.AuthProvider><Ver useAuth={mod.useAuth} out={out} /></mod.AuthProvider>);
    return { out, r, mod };
  }

  it.each(['/phone', '/login', '/enroll/x', '/call/x', '/sala/x'])('%s es pública: user null y sin pedir /auth/me', async (p) => {
    const { out } = await montar(p);
    expect(out.v.user).toBeNull();
    expect(orig).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('sin token manda a /login', async () => {
    const { out } = await montar('/troncales');
    expect(nav.replace).toHaveBeenCalledWith('/login');
    expect(out.v.user).toBeNull();
  });

  it('token vencido (/auth/me falla) lo borra y manda a /login', async () => {
    localStorage.setItem('pbxng_jwt', 't');
    await montar('/troncales', null);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login'));
    expect(localStorage.getItem('pbxng_jwt')).toBeNull();
  });

  it('agente fuera de /agente va a /agente; dentro se queda y ve su sesión', async () => {
    localStorage.setItem('pbxng_jwt', 't');
    await montar('/troncales', { role: 'agente' });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/agente'));
    nav.replace = vi.fn();
    const { out } = await montar('/agente/cola', { role: 'agente', username: 'ana' });
    await waitFor(() => expect(out.v.user && out.v.user.username).toBe('ana'));
    expect(nav.replace).not.toHaveBeenCalled();
    expect(orig.mock.calls[0][0]).toBe('/backend/api/auth/me');
  });

  it('supervisor: se queda en las pantallas SUP_OK y vuelve a /supervisor desde las demás', async () => {
    localStorage.setItem('pbxng_jwt', 't');
    for (const p of ['/cdr', '/reportes/x', '/supervisor']) {
      nav.replace = vi.fn();
      const { out } = await montar(p, { role: 'supervisor' });
      await waitFor(() => expect(out.v.user).toBeTruthy());
      expect(nav.replace).not.toHaveBeenCalled();
    }
    nav.replace = vi.fn();
    await montar('/cdrx', { role: 'supervisor' });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/supervisor'));
  });

  it('admin en /agente o /supervisor va al inicio; en otra pantalla se queda', async () => {
    localStorage.setItem('pbxng_jwt', 't');
    await montar('/supervisor', { role: 'admin' });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/'));
    nav.replace = vi.fn();
    const { out } = await montar('/troncales', { role: 'admin' });
    await waitFor(() => expect(out.v.user).toBeTruthy());
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('una sesión sin `user` no rompe ni redirige', async () => {
    localStorage.setItem('pbxng_jwt', 't');
    const mod = await cargar();
    nav.path = '/x';
    orig.mockResolvedValue(resp(200, {}));
    const out = {};
    render(<mod.AuthProvider><Ver useAuth={mod.useAuth} out={out} /></mod.AuthProvider>);
    await waitFor(() => expect(out.v.user).toBeUndefined());
    await act(async () => {});
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe('helpers de rol', () => {
  it('esAdmin es prudente: mientras no se sabe quién es, no es admin', async () => {
    const { esAdmin, SUP_OK } = await cargar();
    expect(esAdmin(undefined)).toBe(false);
    expect(esAdmin(null)).toBe(false);
    expect(esAdmin({ role: 'supervisor' })).toBe(false);
    expect(esAdmin({ role: 'admin' })).toBe(true);
    expect(SUP_OK).toContain('/salas');
  });
  it('useAuth fuera del provider devuelve {}, y useEsAdmin lee el contexto', async () => {
    const { useAuth, useEsAdmin, AuthProvider } = await cargar();
    const out = {};
    function A() { out.auth = useAuth(); out.admin = useEsAdmin(); return null; }
    render(<A />);
    expect(out.auth).toEqual({});
    expect(out.admin).toBe(false);
    localStorage.setItem('pbxng_jwt', 't');
    nav.path = '/x';
    orig.mockResolvedValue(resp(200, { user: { role: 'admin' } }));
    render(<AuthProvider><A /></AuthProvider>);
    await waitFor(() => expect(out.admin).toBe(true));
  });
  it('logout borra la sesión y va a /login', async () => {
    const { logout } = await cargar();
    localStorage.setItem('pbxng_jwt', 't');
    logout();
    expect(localStorage.getItem('pbxng_jwt')).toBeNull();
    expect(loc.href).toBe('/login');
  });
});
