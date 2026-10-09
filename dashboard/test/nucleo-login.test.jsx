/* La pantalla de ingreso (`app/login/page.jsx`). Es la puerta del panel: si se equivoca,
 * nadie entra. Se fija qué se manda al iniciar sesión, a dónde va cada rol, el cambio de
 * contraseña obligatorio del primer ingreso (con las mismas reglas que la API, para no
 * hacer un viaje en vano), los errores en palabras («No se pudo conectar», el `error` de la
 * API), las solapas de rol sólo si la central es call center, y los botones de descarga
 * del softphone sólo cuando la central de verdad tiene el instalador. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { instalarStorage } from './helpers/nucleo-render.jsx';

vi.mock('../app/PbxLogo.jsx', () => ({ default: () => <i>logo</i> }));
vi.mock('../app/ShaderPuntos.jsx', () => ({ default: () => <i>shader</i> }));
import Login from '../app/login/page.jsx';

let st, rutas, fetchMock, loc;
beforeEach(() => {
  st = instalarStorage();
  loc = { href: '' };
  vi.stubGlobal('location', loc);
  window.location.href = '';
  rutas = {
    '/backend/api/softphone/latest': async () => ({ json: async () => ({ available: false }) }),
    '/backend/api/branding': async () => ({ json: async () => ({ name: 'Central Sur', subtitle: 'Sede', tagline: 'Hola', logo: '' }) }),
    '/backend/api/auth/setup': async () => ({ json: async () => ({ defaultAdmin: false }) }),
    '/backend/api/auth/login': async () => ({ ok: true, json: async () => ({ token: 'jwt1', user: { role: 'admin' } }) }),
    '/backend/api/auth/password': async () => ({ ok: true, json: async () => ({ ok: true }) }),
  };
  fetchMock = vi.fn((u, o) => (rutas[u] ? rutas[u](o) : Promise.reject(new Error('sin ruta'))));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); });

const montar = async () => { const r = render(<Login />); await act(async () => {}); return r; };
const usuario = () => screen.getByPlaceholderText('admin');
const clave = () => document.querySelector('input[autocomplete="current-password"]');
const enviar = async () => { await act(async () => { fireEvent.submit(document.querySelector('form')); }); };
const destino = () => window.location.href;

describe('ingreso', () => {
  it('manda usuario, clave y rol; guarda la sesión y va al inicio del admin', async () => {
    await montar();
    expect(screen.getAllByText('Central Sur').length).toBeGreaterThan(0);
    expect(screen.getByText('Hola')).toBeTruthy();
    fireEvent.change(usuario(), { target: { value: 'ana' } });
    fireEvent.change(clave(), { target: { value: 'secreta1' } });
    await enviar();
    const [, init] = fetchMock.mock.calls.find((c) => c[0] === '/backend/api/auth/login');
    expect(JSON.parse(init.body)).toEqual({ username: 'ana', password: 'secreta1', role: 'admin' });
    expect(st.local.getItem('pbxng_jwt')).toBe('jwt1');
    expect(destino()).toBe('/');
  });

  it.each([['agente', '/agente'], ['supervisor', '/supervisor'], [undefined, '/']])('rol %s va a %s', async (rol, dest) => {
    rutas['/backend/api/auth/login'] = async () => ({ ok: true, json: async () => ({ token: 't', user: rol ? { role: rol } : null }) });
    await montar();
    await enviar();
    expect(destino()).toBe(dest);
  });

  it('credenciales malas: el error de la API; sin texto, «Error»; red caída, «No se pudo conectar»', async () => {
    rutas['/backend/api/auth/login'] = async () => ({ ok: false, json: async () => ({ error: 'Usuario o contraseña incorrectos' }) });
    await montar();
    await enviar();
    expect(screen.getByText('Usuario o contraseña incorrectos')).toBeTruthy();
    expect(st.local.getItem('pbxng_jwt')).toBeNull();
    rutas['/backend/api/auth/login'] = async () => ({ ok: false, json: async () => ({}) });
    await enviar();
    expect(screen.getByText('Error')).toBeTruthy();
    rutas['/backend/api/auth/login'] = async () => { throw new Error('red'); };
    await enviar();
    expect(screen.getByText('No se pudo conectar')).toBeTruthy();
    expect(screen.getByText('Iniciar sesión', { selector: 'button' })).toBeTruthy();
  });

  it('mientras ingresa, el botón queda deshabilitado con «Ingresando…»', async () => {
    let fin;
    rutas['/backend/api/auth/login'] = () => new Promise((r) => { fin = r; });
    await montar();
    await enviar();
    const b = screen.getByText('Ingresando…').closest('button');
    expect(b.disabled).toBe(true);
    await act(async () => { fin({ ok: false, json: async () => ({ error: 'x' }) }); });
  });

  it('mostrar contraseña alterna el tipo del campo', async () => {
    await montar();
    expect(clave().type).toBe('password');
    fireEvent.click(screen.getByLabelText('Mostrar contraseña'));
    expect(clave().type).toBe('text');
    fireEvent.click(screen.getByLabelText('Mostrar contraseña'));
    expect(clave().type).toBe('password');
  });

  it('primer ingreso: muestra la pista admin/admin', async () => {
    rutas['/backend/api/auth/setup'] = async () => ({ json: async () => ({ defaultAdmin: true }) });
    await montar();
    expect(screen.getByText('Primer ingreso:')).toBeTruthy();
  });

  it('branding, setup y descargas caídos no impiden entrar (valores por defecto)', async () => {
    rutas['/backend/api/branding'] = async () => { throw new Error('x'); };
    rutas['/backend/api/auth/setup'] = async () => { throw new Error('x'); };
    rutas['/backend/api/softphone/latest'] = async () => { throw new Error('x'); };
    await montar();
    expect(screen.getAllByText('PBX-NG').length).toBeGreaterThan(0);
    expect(screen.getByText('Central telefónica unificada')).toBeTruthy();
    expect(screen.queryByText('Softphone PBX-NG')).toBeNull();
    expect(screen.queryByText('Agente')).toBeNull();
  });

  it('branding sin nombre ni subtítulo usa los de fábrica; con logo propio lo muestra', async () => {
    rutas['/backend/api/branding'] = async () => ({ json: async () => ({ name: '', subtitle: '', logo: '/l.png' }) });
    await montar();
    expect(screen.getAllByText('PBX-NG').length).toBeGreaterThan(0);
    expect(screen.getByText('Comunicaciones')).toBeTruthy();
    expect(document.querySelectorAll('img[src="/l.png"]')).toHaveLength(2);
  });
});

describe('call center: solapas de rol', () => {
  it('con call center se elige Agente o Supervisor y se manda en el login', async () => {
    rutas['/backend/api/branding'] = async () => ({ json: async () => ({ name: 'CC', callcenter: true }) });
    await montar();
    fireEvent.click(screen.getByText('Agente'));
    expect(screen.getByText(/Panel de agente/)).toBeTruthy();
    expect(screen.getByText('Agente').closest('button').className).toBe('active');
    fireEvent.click(screen.getByText('Supervisor'));
    await enviar();
    expect(JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/backend/api/auth/login')[1].body).role).toBe('supervisor');
  });

  it('si la central deja de ser call center, el rol vuelve a admin', async () => {
    let cc = true;
    rutas['/backend/api/branding'] = async () => ({ json: async () => ({ name: 'CC', callcenter: cc }) });
    const { unmount } = await montar();
    fireEvent.click(screen.getByText('Agente'));
    unmount();
    cc = false;
    await montar();
    expect(screen.getByText(/Panel de administración/)).toBeTruthy();
  });
});

describe('cambio de contraseña obligatorio', () => {
  const nueva = () => document.querySelectorAll('input[autocomplete="new-password"]');
  async function aCambio() {
    rutas['/backend/api/auth/login'] = async () => ({ ok: true, json: async () => ({ must_change: true, token: 'temporal' }) });
    await montar();
    await enviar();
    expect(screen.getByText('Cambiá tu contraseña')).toBeTruthy();
    expect(st.local.getItem('pbxng_jwt')).toBeNull();
  }

  it('valida largo y coincidencia ANTES de pedir nada', async () => {
    await aCambio();
    fireEvent.change(nueva()[0], { target: { value: 'corta' } });
    await enviar();
    expect(screen.getByText('La contraseña debe tener al menos 8 caracteres')).toBeTruthy();
    fireEvent.change(nueva()[0], { target: { value: 'larguisima1' } });
    fireEvent.change(nueva()[1], { target: { value: 'otra-cosa1' } });
    await enviar();
    expect(screen.getByText('Las contraseñas no coinciden')).toBeTruthy();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/backend/api/auth/password')).toBe(false);
  });

  it('guarda con el token temporal (sin pedir la clave actual) y entra', async () => {
    await aCambio();
    fireEvent.change(nueva()[0], { target: { value: 'larguisima1' } });
    fireEvent.change(nueva()[1], { target: { value: 'larguisima1' } });
    await enviar();
    const [, init] = fetchMock.mock.calls.find((c) => c[0] === '/backend/api/auth/password');
    expect(init.headers.Authorization).toBe('Bearer temporal');
    expect(JSON.parse(init.body)).toEqual({ password: 'larguisima1' });
    expect(st.local.getItem('pbxng_jwt')).toBe('temporal');
    expect(destino()).toBe('/');
  });

  it('errores al guardar: el de la API, «Error» o «No se pudo conectar»; mostrar clave en los dos campos', async () => {
    await aCambio();
    const [a, b] = nueva();
    const [ojo1, ojo2] = screen.getAllByLabelText('Mostrar contraseña');
    fireEvent.click(ojo1); fireEvent.click(ojo2);
    expect([a.type, b.type]).toEqual(['text', 'text']);
    fireEvent.click(ojo1); fireEvent.click(ojo2);
    expect([a.type, b.type]).toEqual(['password', 'password']);
    fireEvent.change(a, { target: { value: 'larguisima1' } });
    fireEvent.change(b, { target: { value: 'larguisima1' } });
    rutas['/backend/api/auth/password'] = async () => ({ ok: false, json: async () => ({ error: 'Muy común' }) });
    await enviar();
    expect(screen.getByText('Muy común')).toBeTruthy();
    rutas['/backend/api/auth/password'] = async () => ({ ok: false, json: async () => ({}) });
    await enviar();
    expect(screen.getByText('Error')).toBeTruthy();
    rutas['/backend/api/auth/password'] = async () => { throw new Error('red'); };
    await enviar();
    expect(screen.getByText('No se pudo conectar')).toBeTruthy();
    expect(screen.getByText('Guardar y entrar')).toBeTruthy();
  });
});

describe('descargas del softphone', () => {
  it('Windows y Android con versión y tamaño cuando la central los tiene', async () => {
    rutas['/backend/api/softphone/latest'] = async () => ({ json: async () => ({ available: true, url: '/descargas/softphone/PBX.exe', version: '0.17.0', size: 85 * 1048576, android: { available: true, url: '/descargas/softphone/pbx.apk', version: '1.2', size: 20 * 1048576 } }) });
    await montar();
    expect(screen.getByText('Softphone PBX-NG')).toBeTruthy();
    const win = screen.getByText('Windows').closest('a');
    expect(win.getAttribute('href')).toBe('/descargas/softphone/PBX.exe');
    expect(win.title).toBe('Softphone de escritorio para Windows · v0.17.0 · 85 MB');
    expect(screen.getByText('v0.17.0 · 85 MB')).toBeTruthy();
    const apk = screen.getByText('Android').closest('a');
    expect(apk.title).toBe('Softphone para Android (APK) · v1.2 · 20 MB');
    expect(screen.getByText('v1.2 · 20 MB · APK')).toBeTruthy();
  });

  it('sólo Android, sin versión ni tamaño; sólo Windows sin tamaño', async () => {
    rutas['/backend/api/softphone/latest'] = async () => ({ json: async () => ({ available: false, android: { available: true, url: '/a.apk' } }) });
    const { unmount } = await montar();
    expect(screen.queryByText('Windows')).toBeNull();
    expect(screen.getByText('Android').closest('a').title).toBe('Softphone para Android (APK)');
    expect(screen.getByText('APK · APK')).toBeTruthy();
    unmount();
    rutas['/backend/api/softphone/latest'] = async () => ({ json: async () => ({ available: true, url: '/w.exe', version: '1' }) });
    await montar();
    expect(screen.getByText('v1')).toBeTruthy();
    expect(screen.queryByText('Android')).toBeNull();
  });

  it('respuesta vacía no muestra el bloque', async () => {
    rutas['/backend/api/softphone/latest'] = async () => ({ json: async () => null });
    await montar();
    expect(screen.queryByText('Softphone PBX-NG')).toBeNull();
  });
});
