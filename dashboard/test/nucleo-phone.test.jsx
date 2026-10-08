/* La PWA del teléfono (`app/phone/page.jsx`): lo que un interno usa en el celular. Se fija
 * lo que la persona ve y toca: el ingreso (con extensión o con QR), el marcador, los
 * recientes y el buzón (que se baja CON el token, no con un <audio src> que daría 401), el
 * directorio con presencia, los contactos propios, el Intercom (sólo si hay porteros), los
 * ajustes (push, ubicación, gestos, no molestar), la pantalla de llamada con sus controles
 * (que se apagan hasta que la llamada está establecida), la transferencia ciega, atendida y
 * la conferencia, y la llamada que llega por una notificación push antes que el INVITE. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { instalarStorage } from './helpers/nucleo-render.jsx';
import { crearSpFalso, instalarMedios } from './helpers/nucleo-sip.js';

const spRef = vi.hoisted(() => ({ sp: null }));
vi.mock('../app/useSoftphone.js', () => ({ useSoftphone: () => spRef.sp }));
vi.mock('../app/Scratchpad.jsx', () => ({ default: ({ room, onClose }) => <div>pizarra {room}<button onClick={onClose}>cerrar pizarra</button></div> }));
vi.mock('../app/Intercom.jsx', () => ({ default: ({ streams }) => <div>pared {streams.map((s) => s.name).join(',')}</div> }));
const push = vi.hoisted(() => ({ soportado: true, estado: 'off', enablePush: null, disablePush: null, testPush: null }));
vi.mock('../app/push.js', () => ({
  pushSupported: () => push.soportado,
  pushStatus: () => Promise.resolve(push.estado),
  enablePush: (...a) => push.enablePush(...a),
  disablePush: (...a) => push.disablePush(...a),
  testPush: (...a) => push.testPush(...a),
}));
const qr = vi.hoisted(() => ({ dato: null }));
vi.mock('jsqr', () => ({ default: () => (qr.dato ? { data: qr.dato } : null) }));

import Phone from '../app/phone/page.jsx';

let st, rutas, fetchMock, medios, swHandlers;
beforeEach(() => {
  st = instalarStorage();
  medios = instalarMedios();
  spRef.sp = crearSpFalso();
  push.soportado = true; push.estado = 'off';
  push.enablePush = vi.fn(async () => true); push.disablePush = vi.fn(async () => {}); push.testPush = vi.fn(async () => {});
  qr.dato = null;
  rutas = {
    '/version.json': async () => ({ json: async () => ({ version: '2.3.4' }) }),
    '/backend/api/directory': async () => ({ json: async () => [{ ext: '101', name: 'Yo', status: 'online' }, { ext: '102', name: 'Ana Gómez', status: 'online' }, { ext: '103', status: 'in_call' }, { ext: '104', name: 'Zoe', status: 'offline' }, { ext: '105', name: 'Raro', status: 'away' }] }),
    '/backend/api/vm': async () => ({ json: async () => [] }),
    '/backend/api/intercom/clients': async () => ({ ok: false, status: 403, json: async () => ({}) }),
  };
  fetchMock = vi.fn((u, o) => {
    const k = Object.keys(rutas).find((r) => u === r || u.startsWith(r + '?'));
    return k ? rutas[k](o, u) : Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  swHandlers = {};
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    addEventListener: (ev, f) => { swHandlers[ev] = f; }, removeEventListener: vi.fn(), getRegistration: vi.fn(async () => ({ update: vi.fn(async () => {}) })),
  } });
});
// cleanup() primero: desmontar suelta el listener del service worker, que tiene que existir.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); delete navigator.serviceWorker; delete navigator.geolocation; delete navigator.vibrate; delete navigator.mediaDevices; });

const montar = async () => { const r = render(<Phone />); await act(async () => {}); return r; };
const tab = (n) => fireEvent.click([...document.querySelectorAll('.ph-tab')][['llamadas', 'contactos', 'teclado', ...(document.querySelectorAll('.ph-tab').length === 5 ? ['intercom'] : []), 'ajustes'].indexOf(n)]);
const tecla = (k) => [...document.querySelectorAll('.ph-key')].find((b) => b.querySelector('span') && b.querySelector('span').textContent === k);
const flash = () => document.body.textContent;
const ctl = (label) => [...document.querySelectorAll('button.ph-key')].find((b) => b.lastChild && b.lastChild.textContent === label);
const titulo = (t) => screen.getByText(t, { selector: 'div' });

describe('ingreso', () => {
  it('sin registro pide extensión y clave; conectar con o sin video', async () => {
    spRef.sp = crearSpFalso({ reg: 'idle', creds: null });
    await montar();
    expect(screen.getByText('Iniciá sesión con tu extensión')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Extensión (ej 9100)'), { target: { value: '9100' } });
    fireEvent.change(screen.getByPlaceholderText('Contraseña SIP'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText('Habilitar video'));
    fireEvent.click(screen.getByText('Conectar'));
    expect(spRef.sp.connect).toHaveBeenCalledWith('9100', 'x', true);
    spRef.sp.connect.mockRejectedValueOnce(new Error('401'));
    fireEvent.click(screen.getByText('Conectar'));
  });

  it('conectando lo dice en el título y en el botón', async () => {
    spRef.sp = crearSpFalso({ reg: 'connecting', creds: null });
    await montar();
    expect(screen.getAllByText('Conectando…')).toHaveLength(2);
  });

  it('QR: abre la cámara, lee el código, canjea el token y conecta', async () => {
    spRef.sp = crearSpFalso({ reg: 'idle', creds: null });
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
    const rafs = [];
    vi.stubGlobal('requestAnimationFrame', (f) => { rafs.push(f); return rafs.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage() {}, getImageData: () => ({ data: [], width: 1, height: 1 }) }));
    rutas['/backend/api/enroll/abc'] = async () => ({ json: async () => ({ ext: '120', password: 'pq' }) });
    await montar();
    fireEvent.click(screen.getByText('Escanear QR'));
    await act(async () => {});
    expect(screen.getByText('Apuntá al código QR')).toBeTruthy();
    expect(medios.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' } });
    const v = document.querySelector('video');
    Object.defineProperty(v, 'readyState', { value: 4 }); Object.defineProperty(v, 'videoWidth', { value: 10 }); Object.defineProperty(v, 'videoHeight', { value: 10 });
    await act(async () => { rafs.shift()(); });
    qr.dato = 'https://pbx/enroll?token=abc';
    await act(async () => { rafs.shift()(); });
    await act(async () => {});
    expect(spRef.sp.connect).toHaveBeenCalledWith('120', 'pq', false);
    expect(screen.queryByText('Apuntá al código QR')).toBeNull();
  });

  it('QR inválido, ilegible o sin cámara: avisa', async () => {
    spRef.sp = crearSpFalso({ reg: 'idle', creds: null });
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => { throw new Error('x'); });
    const rafs = [];
    vi.stubGlobal('requestAnimationFrame', (f) => { rafs.push(f); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage() {}, getImageData: () => ({ data: [], width: 1, height: 1 }) }));
    rutas['/backend/api/enroll/plano'] = async () => ({ json: async () => ({ error: 'vencido' }) });
    await montar();
    fireEvent.click(screen.getByText('Escanear QR'));
    await act(async () => {});
    const v = document.querySelector('video');
    Object.defineProperty(v, 'readyState', { value: 4 }); Object.defineProperty(v, 'videoWidth', { value: 10 }); Object.defineProperty(v, 'videoHeight', { value: 10 });
    qr.dato = 'plano';
    await act(async () => { rafs.shift()(); });
    await act(async () => {});
    expect(flash()).toContain('QR inválido o expirado');
    rutas['/backend/api/enroll/roto'] = async () => { throw new Error('red'); };
    fireEvent.click(screen.getByText('Escanear QR'));
    await act(async () => {});
    const v2 = document.querySelector('video');
    Object.defineProperty(v2, 'readyState', { value: 4 }); Object.defineProperty(v2, 'videoWidth', { value: 10 }); Object.defineProperty(v2, 'videoHeight', { value: 10 });
    qr.dato = 'roto';
    await act(async () => { rafs.at(-1)(); });
    await act(async () => {});
    expect(flash()).toContain('No se pudo leer el QR');
    medios.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('NotAllowed'));
    fireEvent.click(screen.getByText('Escanear QR'));
    await act(async () => {});
    expect(flash()).toContain('No se pudo abrir la cámara');
    fireEvent.click(screen.getByText('Escanear QR'));
    await act(async () => {});
    fireEvent.click(document.querySelector('video').parentElement.querySelector('button'));
    expect(screen.queryByText('Apuntá al código QR')).toBeNull();
  });
});

describe('marcador y recientes', () => {
  it('muestra la extensión en línea, marca y llama por audio o video, y borra', async () => {
    await montar();
    expect(flash()).toContain('Extensión 101 · en línea');
    ['3', '0', '0'].forEach((k) => fireEvent.click(tecla(k)));
    expect(spRef.sp.tone).toHaveBeenCalledWith('3');
    expect(screen.getByText('300')).toBeTruthy();
    const verde = [...document.querySelectorAll('button')].find((b) => b.style.background.includes('3ddc6a'));
    fireEvent.click(verde);
    expect(spRef.sp.placeCall).toHaveBeenCalledWith('300', false);
    fireEvent.click(verde.previousElementSibling);
    expect(spRef.sp.placeCall).toHaveBeenLastCalledWith('300', true);
    fireEvent.click(verde.nextElementSibling);
    expect(screen.getByText('30')).toBeTruthy();
    fireEvent.click(verde.nextElementSibling); fireEvent.click(verde.nextElementSibling);
    fireEvent.click(verde.previousElementSibling);
    expect(spRef.sp.placeCall).toHaveBeenCalledTimes(2);
  });

  it('recientes: perdidas en rojo, nombre del contacto, y volver a llamar', async () => {
    st.local.setItem('pbxng_contacts', JSON.stringify([{ id: 1, name: 'Mamá', number: '099' }]));
    spRef.sp = crearSpFalso({ hist: [{ dir: 'in', number: '099', start: Date.now(), missed: true }, { dir: 'in', number: '200', start: Date.now() }, { dir: 'out', number: '300', start: Date.now() }] });
    await montar();
    tab('llamadas');
    expect(screen.getByText('Mamá')).toBeTruthy();
    expect(screen.getByText('Perdida')).toBeTruthy();
    expect(screen.getByText('Entrante')).toBeTruthy();
    expect(screen.getByText('Saliente')).toBeTruthy();
    fireEvent.click(screen.getByText('300'));
    expect(spRef.sp.placeCall).toHaveBeenCalledWith('300', undefined);
    tab('llamadas');
    fireEvent.click(screen.getByText('200').closest('div[style*="cursor: pointer"]').querySelector('button'));
    expect(spRef.sp.placeCall).toHaveBeenLastCalledWith('200', undefined);
  });

  it('sin llamadas: «Sin llamadas todavía.» y buzón vacío', async () => {
    await montar();
    tab('llamadas');
    expect(screen.getByText('Sin llamadas todavía.')).toBeTruthy();
    expect(screen.getByText('Sin mensajes')).toBeTruthy();
  });
});

describe('buzón de voz', () => {
  const VM = [{ id: 'm1', folder: 'INBOX', new: true, callerid: '"Ana" <102>', origtime: 1790000000, duration: 12 }, { id: 'm2', folder: 'Old', duration: 3 }];

  it('cuenta los nuevos, lista los mensajes y los consulta cada 20 s con la pantalla prendida', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    rutas['/backend/api/vm'] = async () => ({ json: async () => VM });
    await montar();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/backend/api/vm?ext=101')).toBe(true);
    tab('llamadas');
    expect(screen.getByText('1 nuevo(s) - 2 mensaje(s)')).toBeTruthy();
    const n = fetchMock.mock.calls.filter((c) => c[0].startsWith('/backend/api/vm?')).length;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { vi.advanceTimersByTime(20000); });
    expect(fetchMock.mock.calls.filter((c) => c[0].startsWith('/backend/api/vm?')).length).toBe(n);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    await act(async () => { vi.advanceTimersByTime(20000); });
    expect(fetchMock.mock.calls.filter((c) => c[0].startsWith('/backend/api/vm?')).length).toBe(n + 1);
  });

  it('escuchar baja el audio por fetch (con token) y lo reproduce del blob; borrar lo saca', async () => {
    rutas['/backend/api/vm'] = async () => ({ json: async () => VM });
    rutas['/backend/api/vm/audio'] = async () => ({ ok: true, blob: async () => new Blob(['x']) });
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:vm1'), revokeObjectURL: vi.fn() });
    const { unmount } = await montar();
    tab('llamadas');
    fireEvent.click(screen.getByText('Buzon de voz'));
    expect(screen.getByText('"Ana" <102>')).toBeTruthy();
    expect(screen.getByText('nuevo')).toBeTruthy();
    expect(screen.getByText('Desconocido')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getAllByText('▶ Escuchar')[0]); });
    expect(fetchMock.mock.calls.some((c) => c[0] === '/backend/api/vm/audio?ext=101&folder=INBOX&id=m1')).toBe(true);
    expect(document.querySelector('audio[src="blob:vm1"]')).toBeTruthy();
    fireEvent.click(document.querySelectorAll('button')[[...document.querySelectorAll('button')].findIndex((b) => b.textContent === '' && b.style.borderRadius === '50%' && b.closest('div[style*="border-radius: 12px"]'))]);
    await act(async () => {});
    const del = fetchMock.mock.calls.find((c) => c[0] === '/backend/api/vm/del');
    expect(JSON.parse(del[1].body)).toEqual({ ext: '101', folder: 'INBOX', id: 'm1' });
    expect(screen.queryByText('"Ana" <102>')).toBeNull();
    fireEvent.click(screen.getByText('‹ Volver'));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:vm1');
  });

  it('audio que no baja muestra «No se pudo cargar»; borrar sin red igual lo saca de la lista', async () => {
    rutas['/backend/api/vm'] = async () => ({ json: async () => VM });
    let fin;
    rutas['/backend/api/vm/audio'] = () => new Promise((r) => { fin = r; });
    rutas['/backend/api/vm/del'] = async () => { throw new Error('red'); };
    await montar();
    tab('llamadas');
    fireEvent.click(screen.getByText('Buzon de voz'));
    await act(async () => { fireEvent.click(screen.getAllByText('▶ Escuchar')[1]); });
    expect(screen.getByText('Cargando…')).toBeTruthy();
    fireEvent.click(screen.getByText('Cargando…'));
    await act(async () => { fin({ ok: false }); });
    expect(screen.getByText('No se pudo cargar')).toBeTruthy();
    const filas = document.querySelectorAll('div[style*="border-radius: 12px"] button');
    await act(async () => { fireEvent.click(filas[0]); });
    expect(screen.queryByText('"Ana" <102>')).toBeNull();
  });

  it('respuesta rara o caída del buzón: lista vacía, sin romper', async () => {
    rutas['/backend/api/vm'] = async () => ({ json: async () => ({ error: 'x' }) });
    await montar();
    tab('llamadas');
    fireEvent.click(screen.getByText('Buzon de voz'));
    expect(screen.getByText('No tenes mensajes de voz.')).toBeTruthy();
    rutas['/backend/api/vm'] = async () => { throw new Error('red'); };
    spRef.sp = { ...spRef.sp, creds: null };
    await montar();
  });
});

describe('contactos', () => {
  it('directorio: sin uno mismo, en línea primero, presencia y llamar por audio o video', async () => {
    await montar();
    tab('contactos');
    await act(async () => {});
    const filas = [...document.querySelectorAll('div[style*="cursor: pointer"]')].filter((d) => d.textContent.includes(' · 10'));
    const textos = filas.map((f) => f.textContent);
    expect(textos).toHaveLength(4);
    expect(textos.join()).not.toContain('Yo');
    expect(textos.at(-1)).toContain('Zoe');
    expect(screen.getByText('En línea · 102')).toBeTruthy();
    expect(screen.getByText('En llamada · 103')).toBeTruthy();
    expect(screen.getByText('Desconectado · 105')).toBeTruthy();
    fireEvent.click(filas.find((f) => f.textContent.includes('Ana Gómez')));
    expect(spRef.sp.placeCall).toHaveBeenCalledWith('102', undefined);
    tab('contactos');
    const f2 = [...document.querySelectorAll('div[style*="cursor: pointer"]')].find((d) => d.textContent.includes('Zoe'));
    fireEvent.click(f2.querySelectorAll('button')[0]);
    expect(spRef.sp.placeCall).toHaveBeenLastCalledWith('104', true);
    tab('contactos');
    fireEvent.click([...document.querySelectorAll('div[style*="cursor: pointer"]')].find((d) => d.textContent.includes('Zoe')).querySelectorAll('button')[1]);
    expect(spRef.sp.placeCall).toHaveBeenLastCalledWith('104', undefined);
    tab('contactos');
    fireEvent.change(screen.getByPlaceholderText('Buscar'), { target: { value: 'zzz' } });
    expect(screen.getByText('Sin extensiones en el directorio.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Buscar'), { target: { value: '10' } });
    expect(screen.queryByText('Sin extensiones en el directorio.')).toBeNull();
  });

  it('el directorio se refresca cada 30 s (no con la pantalla apagada); respuesta rara = vacío', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await montar();
    const n = () => fetchMock.mock.calls.filter((c) => c[0] === '/backend/api/directory').length;
    expect(n()).toBe(1);
    rutas['/backend/api/directory'] = async () => ({ json: async () => ({ no: 'lista' }) });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(n()).toBe(2);
    tab('contactos');
    expect(screen.getByText('Sin extensiones en el directorio.')).toBeTruthy();
    rutas['/backend/api/directory'] = async () => { throw new Error('red'); };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(n()).toBe(2);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('mis contactos: agregar (ordenados), buscar, llamar y borrar; quedan guardados', async () => {
    await montar();
    tab('contactos');
    fireEvent.click(screen.getByText('Mis contactos'));
    expect(screen.getByText('Agregá tu primer contacto con +')).toBeTruthy();
    const agregar = (name, number) => {
      fireEvent.click(titulo('Contactos').parentElement.querySelector('button'));
      fireEvent.change(screen.getByPlaceholderText('Nombre'), { target: { value: name } });
      fireEvent.change(screen.getByPlaceholderText('Número / extensión'), { target: { value: number } });
      fireEvent.click(screen.getByText('Guardar'));
    };
    agregar('Zulema', '555');
    agregar('Ana Gómez', '102');
    expect(JSON.parse(st.local.getItem('pbxng_contacts')).map((c) => c.name)).toEqual(['Ana Gómez', 'Zulema']);
    expect(screen.getByText('En línea · 102')).toBeTruthy();
    expect(screen.getByText('555')).toBeTruthy();
    fireEvent.click(titulo('Contactos').parentElement.querySelector('button'));
    fireEvent.click(screen.getByText('Guardar'));
    expect(screen.getByText('Nuevo contacto')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancelar'));
    fireEvent.click(titulo('Contactos').parentElement.querySelector('button'));
    fireEvent.click(screen.getByText('Nuevo contacto').parentElement);
    expect(screen.getByText('Nuevo contacto')).toBeTruthy();
    fireEvent.click(screen.getByText('Nuevo contacto').parentElement.parentElement);
    expect(screen.queryByText('Nuevo contacto')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Buscar'), { target: { value: 'zul' } });
    expect(screen.queryByText('Ana Gómez')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Buscar'), { target: { value: 'xyz' } });
    expect(screen.getByText('Sin resultados.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Buscar'), { target: { value: '55' } });
    const fila = screen.getByText('Zulema').closest('div[style*="cursor: pointer"]');
    fireEvent.click(fila.querySelectorAll('button')[0]);
    expect(spRef.sp.placeCall).toHaveBeenCalledWith('555', true);
    tab('contactos'); fireEvent.click(screen.getByText('Mis contactos'));
    fireEvent.click(screen.getByText('Zulema').closest('div[style*="cursor: pointer"]').querySelectorAll('button')[1]);
    expect(spRef.sp.placeCall).toHaveBeenLastCalledWith('555', undefined);
    tab('contactos'); fireEvent.click(screen.getByText('Mis contactos'));
    fireEvent.click(screen.getByText('Zulema').closest('div[style*="cursor: pointer"]').querySelectorAll('button')[2]);
    expect(JSON.parse(st.local.getItem('pbxng_contacts')).map((c) => c.name)).toEqual(['Ana Gómez']);
    fireEvent.click(screen.getByText('Directorio'));
  });

  it('contactos guardados corruptos arrancan vacíos', async () => {
    st.local.setItem('pbxng_contacts', '{mal');
    await montar();
    tab('contactos');
    fireEvent.click(screen.getByText('Mis contactos'));
    expect(screen.getByText('Agregá tu primer contacto con +')).toBeTruthy();
  });
});

describe('intercom', () => {
  it('sin clientes con porteros la pestaña no aparece', async () => {
    rutas['/backend/api/intercom/clients'] = async () => ({ ok: true, json: async () => [] });
    await montar();
    expect(document.querySelectorAll('.ph-tab')).toHaveLength(4);
  });

  it('con clientes: lista, elige uno y muestra su pared de video; volver y refrescar', async () => {
    rutas['/backend/api/intercom/clients'] = async () => ({ ok: true, json: async () => [{ id: 7, name: 'Edificio Sol' }] });
    rutas['/backend/api/intercom/streams'] = async () => ({ ok: true, json: async () => [{ name: 'Puerta' }] });
    await montar();
    expect(document.querySelectorAll('.ph-tab')).toHaveLength(5);
    tab('intercom');
    fireEvent.click(screen.getByText('Edificio Sol'));
    await act(async () => {});
    expect(fetchMock.mock.calls.some((c) => c[0] === '/backend/api/intercom/streams?client=7')).toBe(true);
    expect(screen.getByText('pared Puerta')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Edificio Sol')[0].parentElement.querySelector('button'));
    expect(titulo('Intercom')).toBeTruthy();
    await act(async () => { fireEvent.click(titulo('Intercom').parentElement.querySelector('button')); });
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/backend/api/intercom/clients').length).toBe(2);
  });

  it('errores: sin permiso, error de la API, cliente sin dispositivos, red caída', async () => {
    let lista = [{ id: 1, name: 'A' }];
    rutas['/backend/api/intercom/clients'] = async () => ({ ok: true, json: async () => lista });
    rutas['/backend/api/intercom/streams'] = async () => ({ ok: false, status: 403, json: async () => { throw new Error('html'); } });
    await montar();
    tab('intercom');
    fireEvent.click(screen.getByText('A'));
    await act(async () => {});
    expect(screen.getByText('tu usuario no tiene permiso para ver estas cámaras')).toBeTruthy();
    rutas['/backend/api/intercom/streams'] = async () => ({ ok: false, status: 500, json: async () => ({ error: 'go2rtc caído' }) });
    fireEvent.click(screen.getAllByText('A')[0].parentElement.querySelector('button'));
    fireEvent.click(screen.getByText('A'));
    await act(async () => {});
    expect(screen.getByText('go2rtc caído')).toBeTruthy();
    rutas['/backend/api/intercom/streams'] = async () => ({ ok: false, status: 502, json: async () => ({}) });
    fireEvent.click(screen.getAllByText('A')[0].parentElement.querySelector('button'));
    fireEvent.click(screen.getByText('A'));
    await act(async () => {});
    expect(screen.getByText('error 502')).toBeTruthy();
    rutas['/backend/api/intercom/streams'] = async () => ({ ok: true, json: async () => ({}) });
    fireEvent.click(screen.getAllByText('A')[0].parentElement.querySelector('button'));
    fireEvent.click(screen.getByText('A'));
    await act(async () => {});
    expect(screen.getByText('Este cliente no tiene dispositivos.')).toBeTruthy();
    rutas['/backend/api/intercom/streams'] = async () => { throw new Error(''); };
    fireEvent.click(screen.getAllByText('A')[0].parentElement.querySelector('button'));
    fireEvent.click(screen.getByText('A'));
    await act(async () => {});
    expect(screen.getByText('no se pudieron leer las cámaras')).toBeTruthy();
    fireEvent.click(screen.getAllByText('A')[0].parentElement.querySelector('button'));
    rutas['/backend/api/intercom/clients'] = async () => ({ ok: false, status: 403, json: async () => null });
    await act(async () => { fireEvent.click(titulo('Intercom').parentElement.querySelector('button')); });
    expect(screen.getByText('tu usuario no tiene permiso para ver los porteros')).toBeTruthy();
    rutas['/backend/api/intercom/clients'] = async () => ({ ok: false, status: 500, json: async () => ({ error: 'db' }) });
    await act(async () => { fireEvent.click(titulo('Intercom').parentElement.querySelector('button')); });
    expect(screen.getByText('db')).toBeTruthy();
    rutas['/backend/api/intercom/clients'] = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await act(async () => { fireEvent.click(titulo('Intercom').parentElement.querySelector('button')); });
    expect(screen.getByText('error 500')).toBeTruthy();
    rutas['/backend/api/intercom/clients'] = async () => { throw new Error(''); };
    await act(async () => { fireEvent.click(titulo('Intercom').parentElement.querySelector('button')); });
    expect(screen.getByText('no se pudo leer la lista')).toBeTruthy();
    lista = [];
    rutas['/backend/api/intercom/clients'] = async () => ({ ok: true, json: async () => ({ x: 1 }) });
    await act(async () => { fireEvent.click(titulo('Intercom').parentElement.querySelector('button')); });
    expect(screen.getByText('No hay clientes con porteros o cámaras asociados.')).toBeTruthy();
  });

  it('mientras cargan, lo dice', async () => {
    rutas['/backend/api/intercom/clients'] = async () => ({ ok: true, json: async () => [{ id: 1, name: 'A' }] });
    rutas['/backend/api/intercom/streams'] = () => new Promise(() => {});
    await montar();
    tab('intercom');
    fireEvent.click(screen.getByText('A'));
    expect(screen.getByText('Cargando cámaras…')).toBeTruthy();
    rutas['/backend/api/intercom/clients'] = () => new Promise(() => {});
    fireEvent.click(screen.getAllByText('A')[0].parentElement.querySelector('button'));
    fireEvent.click(titulo('Intercom').parentElement.querySelector('button'));
    expect(screen.getByText('Cargando…')).toBeTruthy();
  });
});

describe('ajustes', () => {
  it('datos de la cuenta, versión publicada y probar tono', async () => {
    await montar();
    tab('ajustes');
    expect(screen.getByText('En línea')).toBeTruthy();
    expect(screen.getByText('No')).toBeTruthy();
    expect(screen.getByText('localhost')).toBeTruthy();
    expect(screen.getByText('2.3.4')).toBeTruthy();
    fireEvent.click(screen.getByText('Probar tono'));
    expect(spRef.sp.tone).toHaveBeenCalledWith('5');
    fireEvent.click(screen.getByText('Cerrar sesión'));
    expect(spRef.sp.disconnect).toHaveBeenCalled();
  });

  it('versión ilegible muestra guion; con video lo dice', async () => {
    rutas['/version.json'] = async () => { throw new Error('x'); };
    spRef.sp = crearSpFalso({ creds: { ext: '101', video: true } });
    await montar();
    tab('ajustes');
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('Sí')).toBeTruthy();
    rutas['/version.json'] = async () => ({ json: async () => ({}) });
    await montar();
  });

  it('buscar actualizaciones limpia cachés, actualiza el SW y recarga', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const del = vi.fn(async () => true);
    vi.stubGlobal('caches', { keys: async () => ['a'], delete: del });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, hostname: 'localhost', search: '', pathname: '/phone', reload });
    await montar();
    tab('ajustes');
    await act(async () => { fireEvent.click(screen.getByText('Buscar actualizaciones')); });
    expect(del).toHaveBeenCalledWith('a');
    expect(flash()).toContain('Buscando actualización…');
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(reload).toHaveBeenCalled();
    vi.stubGlobal('caches', undefined);
    navigator.serviceWorker.getRegistration.mockRejectedValue(new Error('x'));
    reload.mockImplementation(() => { throw new Error('x'); });
    await act(async () => { fireEvent.click(screen.getByText('Buscar actualizaciones')); });
    await act(async () => { vi.advanceTimersByTime(3000); });
  });

  it('push: activar, probar y desactivar; si falla, «No se pudo activar»', async () => {
    await montar();
    tab('ajustes');
    const toggle = () => screen.getByText('Notificaciones push').parentElement.querySelector('button');
    await act(async () => { fireEvent.click(toggle()); });
    expect(push.enablePush).toHaveBeenCalledWith('101');
    expect(flash()).toContain('Notificaciones activadas');
    await act(async () => { fireEvent.click(screen.getByText('Probar notificación')); });
    expect(push.testPush).toHaveBeenCalledWith('101');
    expect(flash()).toContain('Notificación de prueba enviada');
    push.testPush.mockRejectedValueOnce(new Error('x'));
    await act(async () => { fireEvent.click(screen.getByText('Probar notificación')); });
    await act(async () => { fireEvent.click(toggle()); });
    expect(push.disablePush).toHaveBeenCalled();
    expect(flash()).toContain('Notificaciones desactivadas');
    push.enablePush.mockRejectedValueOnce(new Error('denegado'));
    await act(async () => { fireEvent.click(toggle()); });
    expect(flash()).toContain('No se pudo activar');
  });

  it('push: no disponible o bloqueadas; con permiso ya dado se activa sola al registrarse', async () => {
    push.estado = 'unsupported';
    const a = await montar();
    tab('ajustes');
    expect(screen.getByText('No disponible')).toBeTruthy();
    a.unmount();
    push.estado = 'denied';
    const b = await montar();
    tab('ajustes');
    expect(screen.getByText('Bloqueadas')).toBeTruthy();
    b.unmount();
    push.estado = 'off';
    vi.stubGlobal('Notification', { permission: 'granted' });
    await montar();
    expect(push.enablePush).toHaveBeenCalledWith('101');
    tab('ajustes');
    expect(screen.getByText('Probar notificación')).toBeTruthy();
    push.enablePush.mockRejectedValueOnce(new Error('x'));
    await montar();
  });

  it('ubicación: apagar y prender (pidiendo permiso), recordado en el dispositivo', async () => {
    navigator.geolocation = { getCurrentPosition: vi.fn((ok) => ok({})) };
    await montar();
    expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled();
    tab('ajustes');
    const geo = () => screen.getByText('Compartir ubicación en llamadas').parentElement.querySelector('button');
    fireEvent.click(geo());
    expect(st.local.getItem('pbxng_geo')).toBe('0');
    expect(flash()).toContain('Ubicación desactivada');
    fireEvent.click(geo());
    expect(st.local.getItem('pbxng_geo')).toBe('1');
    expect(flash()).toContain('Ubicación activada');
    fireEvent.click(geo());
    navigator.geolocation.getCurrentPosition.mockImplementation((_ok, ko) => ko(new Error('denegado')));
    fireEvent.click(geo());
    expect(flash()).toContain('Permití la ubicaci');
    fireEvent.click(geo());
    delete navigator.geolocation;
    fireEvent.click(geo());
    expect(st.local.getItem('pbxng_geo')).toBe('1');
  });

  it('gestos: prender pide permiso de movimiento (iOS); negado no prende; apagar', async () => {
    st.local.setItem('pbxng_gest', '0');
    vi.stubGlobal('DeviceMotionEvent', { requestPermission: vi.fn(async () => 'denied') });
    await montar();
    tab('ajustes');
    const g = () => screen.getByText('Gestos (boca abajo: silenciar / rechazar)').parentElement.querySelector('button');
    await act(async () => { fireEvent.click(g()); });
    expect(flash()).toContain('Permiso de movimiento denegado');
    expect(st.local.getItem('pbxng_gest')).toBe('0');
    DeviceMotionEvent.requestPermission.mockResolvedValueOnce('granted');
    await act(async () => { fireEvent.click(g()); });
    expect(st.local.getItem('pbxng_gest')).toBe('1');
    expect(flash()).toContain('Gestos activados');
    await act(async () => { fireEvent.click(g()); });
    expect(flash()).toContain('Gestos desactivados');
    DeviceMotionEvent.requestPermission.mockRejectedValueOnce(new Error('x'));
    await act(async () => { fireEvent.click(g()); });
    expect(st.local.getItem('pbxng_gest')).toBe('1');
  });

  it('no molestar: lo marca arriba y rechaza las entrantes', async () => {
    const { rerender } = await montar();
    tab('ajustes');
    fireEvent.click(screen.getByText('No molestar (rechaza entrantes)').parentElement.querySelector('button'));
    expect(st.local.getItem('pbxng_dnd')).toBe('1');
    expect(flash()).toContain('· No molestar');
    expect(flash()).toContain('No molestar activado');
    spRef.sp = { ...spRef.sp, incoming: { remoteIdentity: { uri: { user: '9' } } } };
    rerender(<Phone />);
    expect(spRef.sp.rejectIncoming).toHaveBeenCalled();
    fireEvent.click(screen.getByText('No molestar (rechaza entrantes)').parentElement.querySelector('button'));
    expect(st.local.getItem('pbxng_dnd')).toBe('0');
  });

  it('storage bloqueado al arrancar no rompe: valores por defecto', async () => {
    st.local.getItem = () => { throw new Error('bloqueado'); };
    navigator.geolocation = { getCurrentPosition: vi.fn() };
    await montar();
    expect(flash()).toContain('Extensión 101 · en línea');
    expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalled();
  });
});

describe('pantalla de llamada', () => {
  it('saliente sonando: número, «Llamando…», controles apagados y colgar', async () => {
    spRef.sp = crearSpFalso({ call: 'Establishing', callInfo: { dir: 'out', number: '300' } });
    await montar();
    expect(screen.getByText('Llamando…')).toBeTruthy();
    expect(ctl('En espera').disabled).toBe(true);
    expect(ctl('Grabar').disabled).toBe(true);
    fireEvent.click(ctl('Silenciar'));
    expect(spRef.sp.toggleMute).toHaveBeenCalled();
    fireEvent.click(ctl('Altavoz'));
    expect(spRef.sp.toggleSpeaker).toHaveBeenCalled();
    fireEvent.click([...document.querySelectorAll('.ph-key')].find((b) => b.style.background === 'rgb(255, 59, 48)'));
    expect(spRef.sp.hangup).toHaveBeenCalled();
    fireEvent.click(tecla('1'));
    expect(screen.queryByText('1', { selector: 'div' })).toBeNull();
  });

  it('entrante sin atender y videollamada entrante', async () => {
    spRef.sp = crearSpFalso({ call: 'Initial', callInfo: { dir: 'in', number: '2001' } });
    const { rerender } = await montar();
    expect(screen.getByText('Entrante…')).toBeTruthy();
    spRef.sp = { ...spRef.sp, callInfo: { dir: 'in', number: '2001', video: true } };
    rerender(<Phone />);
    expect(screen.getByText('Videollamada entrante…')).toBeTruthy();
  });

  it('establecida: reloj, calidad, REC, archivo, controles, grabar y teclado DTMF', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(1_000_000);
    spRef.sp = crearSpFalso({ call: 'Established', callInfo: { dir: 'out', number: '300', since: 1_000_000 - 61_000 }, quality: { score: 2, rtt: 250, loss: 4 }, recording: true, filePlaying: { name: 'musica.mp3' }, speaker: true, muted: true });
    await montar();
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.getByText('01:01')).toBeTruthy();
    expect(screen.getByTitle('Calidad: Regular · 250 ms · 4% pérdida')).toBeTruthy();
    expect(screen.getByText('REC')).toBeTruthy();
    expect(screen.getByText('musica.mp3')).toBeTruthy();
    fireEvent.click(ctl('En espera'));
    expect(spRef.sp.toggleHold).toHaveBeenCalled();
    await act(async () => { fireEvent.click(ctl('Grabar')); });
    expect(flash()).toContain('Grabación detenida');
    spRef.sp.toggleRecord.mockResolvedValueOnce({ error: 'x' });
    await act(async () => { fireEvent.click(ctl('Grabar')); });
    expect(flash()).toContain('No se pudo grabar');
    fireEvent.click(ctl('Detener'));
    expect(spRef.sp.stopFile).toHaveBeenCalled();
    fireEvent.click(ctl('Teclado'));
    fireEvent.click([...document.querySelectorAll('.ph-key')].find((b) => b.textContent === '#' && b.style.width === '62px'));
    expect(spRef.sp.tone).toHaveBeenCalledWith('#');
    fireEvent.click([...document.querySelectorAll('.ph-key')].find((b) => b.style.width === '64px' && b.style.background.includes('255, 255, 255')));
    expect(screen.getByText('Transferir')).toBeTruthy();
  });

  it('grabar sin grabación previa avisa «Grabando llamada»; en espera y sin calidad', async () => {
    spRef.sp = crearSpFalso({ call: 'Established', held: true, callInfo: { number: '300' }, quality: { score: 9 } });
    await montar();
    expect(screen.getByText('En espera')).toBeTruthy();
    expect(screen.getByText('Reanudar')).toBeTruthy();
    expect(screen.getByTitle('Calidad:')).toBeTruthy();
    await act(async () => { fireEvent.click(ctl('Grabar')); });
    expect(flash()).toContain('Grabando llamada');
  });

  it('compartir un archivo: elegirlo lo manda a la llamada; sin archivo no hace nada; error visible', async () => {
    spRef.sp = crearSpFalso({ call: 'Established', callInfo: { number: '300' } });
    await montar();
    const input = document.querySelector('input[type=file]');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(ctl('Archivo'));
    expect(click).toHaveBeenCalled();
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'tema.mp3')] } }); });
    expect(spRef.sp.shareFile).toHaveBeenCalled();
    expect(flash()).toContain('Compartiendo tema.mp3');
    spRef.sp.shareFile.mockResolvedValueOnce({ error: 'este navegador no permite compartir archivos' });
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'b.mp3')] } }); });
    expect(flash()).toContain('este navegador no permite compartir archivos');
    await act(async () => { fireEvent.change(input, { target: { files: [] } }); });
    expect(spRef.sp.shareFile).toHaveBeenCalledTimes(2);
  });

  it('transferir: ciega, atendida y conferencia a 3, con su aviso de éxito o error', async () => {
    spRef.sp = crearSpFalso({ call: 'Established', callInfo: { number: '300' } });
    rutas['/backend/api/calls/conference'] = async () => ({ json: async () => ({ ok: true }) });
    await montar();
    const abrir = (n) => { fireEvent.click(ctl('Transferir')); fireEvent.change(screen.getByPlaceholderText('Destino (ej 9102)'), { target: { value: n } }); };
    fireEvent.click(ctl('Transferir'));
    expect(screen.getByText('Ciega').disabled).toBe(true);
    fireEvent.click(screen.getByText('Transferir o conferenciar'));
    fireEvent.click(screen.getByText('Transferir o conferenciar').parentElement.parentElement);
    expect(screen.queryByText('Transferir o conferenciar')).toBeNull();
    abrir('102');
    await act(async () => { fireEvent.click(screen.getByText('Ciega')); });
    expect(spRef.sp.transfer).toHaveBeenCalledWith('102');
    expect(flash()).toContain('Transferida a 102');
    spRef.sp.transfer.mockResolvedValueOnce(false);
    abrir('103');
    await act(async () => { fireEvent.click(screen.getByText('Ciega')); });
    expect(flash()).toContain('No se pudo transferir');
    abrir('104');
    await act(async () => { fireEvent.click(screen.getByText('Atendida')); });
    expect(flash()).toContain('Consultando a 104…');
    spRef.sp.attendedCall.mockResolvedValueOnce(false);
    abrir('105');
    await act(async () => { fireEvent.click(screen.getByText('Atendida')); });
    expect(flash()).toContain('No se pudo consultar');
    abrir('106');
    await act(async () => { fireEvent.click(screen.getByText('Conferencia a 3')); });
    expect(JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/backend/api/calls/conference')[1].body)).toEqual({ ext: '101', third: '106' });
    expect(flash()).toContain('Sumando a 106 a la conferencia');
    rutas['/backend/api/calls/conference'] = async () => { throw new Error('red'); };
    abrir('107');
    await act(async () => { fireEvent.click(screen.getByText('Conferencia a 3')); });
    expect(flash()).toContain('No se pudo conferenciar');
  });

  it('consulta de la atendida: completar sólo cuando atendió; cancelar', async () => {
    spRef.sp = crearSpFalso({ call: 'Established', callInfo: { number: '300' }, attended: { number: '400', state: 'calling' } });
    const { rerender } = await montar();
    expect(screen.getByText('Consulta')).toBeTruthy();
    expect(screen.getByText('Llamando…')).toBeTruthy();
    const [ok, cancel] = screen.getByText('Consulta').parentElement.parentElement.querySelectorAll('button');
    expect(ok.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(spRef.sp.cancelAttended).toHaveBeenCalled();
    spRef.sp = { ...spRef.sp, attended: { number: '400', state: 'talking' } };
    rerender(<Phone />);
    expect(screen.getByText('En línea — listo para transferir')).toBeTruthy();
    fireEvent.click(screen.getByText('Consulta').parentElement.parentElement.querySelector('button'));
    expect(spRef.sp.completeAttended).toHaveBeenCalled();
  });

  it('videollamada: pantalla completa, controles que se esconden solos, PiP, pantalla y pizarra', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    spRef.sp = crearSpFalso({ call: 'Established', callInfo: { number: '300', video: true }, creds: { ext: '101' } });
    await montar();
    expect(screen.getByText('Mini')).toBeTruthy();
    const v = document.querySelector('video');
    spRef.sp.remoteVideoRef.current = v;
    v.requestPictureInPicture = vi.fn(async () => {});
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
    await act(async () => { fireEvent.click(ctl('Mini')); });
    expect(v.requestPictureInPicture).toHaveBeenCalled();
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: v });
    document.exitPictureInPicture = vi.fn(async () => {});
    await act(async () => { fireEvent.click(ctl('Mini')); });
    expect(document.exitPictureInPicture).toHaveBeenCalled();
    delete document.pictureInPictureElement;
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: false });
    await act(async () => { fireEvent.click(ctl('Mini')); });
    spRef.sp.remoteVideoRef.current = null;
    await act(async () => { fireEvent.click(ctl('Mini')); });
    await act(async () => { fireEvent.click(ctl('Pantalla')); });
    expect(spRef.sp.shareScreen).toHaveBeenCalled();
    spRef.sp.shareScreen.mockResolvedValueOnce({ error: 'la llamada no tiene video' });
    await act(async () => { fireEvent.click(ctl('Pantalla')); });
    expect(flash()).toContain('la llamada no tiene video');
    spRef.sp.shareScreen.mockResolvedValueOnce({ error: 'cancelado' });
    await act(async () => { fireEvent.click(ctl('Pantalla')); });
    fireEvent.click(ctl('Pizarra'));
    expect(screen.getByText('pizarra 101-300')).toBeTruthy();
    fireEvent.click(screen.getByText('cerrar pizarra'));
    act(() => { vi.advanceTimersByTime(4600); });
    expect(screen.queryByText('Mini')).toBeNull();
    fireEvent.click(document.querySelector('video').parentElement);
    expect(screen.getByText('Mini')).toBeTruthy();
    fireEvent.click(document.querySelector('video').parentElement);
    expect(screen.queryByText('Mini')).toBeNull();
  });

  it('videollamada compartiendo pantalla muestra «Dejar pantalla»; PiP que falla no rompe', async () => {
    spRef.sp = crearSpFalso({ call: 'Established', sharing: true, callInfo: { number: '300', video: true } });
    await montar();
    expect(screen.getByText('Dejar pantalla')).toBeTruthy();
    const v = document.querySelector('video');
    spRef.sp.remoteVideoRef.current = v;
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
    v.requestPictureInPicture = vi.fn(async () => { throw new Error('x'); });
    await act(async () => { fireEvent.click(ctl('Mini')); });
    expect(v.requestPictureInPicture).toHaveBeenCalled();
  });
});

describe('llamada entrante', () => {
  it('pantalla completa con quien llama; atender, video o rechazar', async () => {
    spRef.sp = crearSpFalso({ incoming: { remoteIdentity: { uri: { user: '2001' } } }, incomingVideo: true });
    await montar();
    expect(screen.getByText('Videollamada entrante')).toBeTruthy();
    expect(screen.getByText('2001')).toBeTruthy();
    fireEvent.click(screen.getByText('Video').previousElementSibling);
    expect(spRef.sp.acceptIncoming).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText('Audio').previousElementSibling);
    expect(spRef.sp.acceptIncoming).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByText('Rechazar').previousElementSibling);
    expect(spRef.sp.rejectIncoming).toHaveBeenCalled();
  });

  it('sin identidad dice «Llamada»; audio dice «Aceptar»', async () => {
    spRef.sp = crearSpFalso({ incoming: {} });
    await montar();
    expect(screen.getByText('Llamada entrante')).toBeTruthy();
    expect(screen.getByText('Llamada')).toBeTruthy();
    expect(screen.getByText('Aceptar')).toBeTruthy();
  });

  it('desde la notificación (?incall=): suena, aceptar espera al INVITE y lo atiende solo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const replace = vi.spyOn(history, 'replaceState');
    vi.stubGlobal('location', { ...window.location, hostname: 'localhost', search: '?incall=2001', pathname: '/phone' });
    window.__uiInteracted = true;
    navigator.vibrate = vi.fn();
    const { rerender } = await montar();
    expect(replace).toHaveBeenCalledWith(null, '', '/phone');
    expect(screen.getByText('Llamada entrante…')).toBeTruthy();
    expect(navigator.vibrate).toHaveBeenCalledWith([500, 250, 500, 250, 700]);
    expect(medios.osciladores.length).toBe(1);
    act(() => { vi.advanceTimersByTime(2600); });
    expect(medios.osciladores.length).toBe(2);
    fireEvent.click(screen.getByText('Aceptar').previousElementSibling);
    expect(screen.getByText('Conectando…')).toBeTruthy();
    spRef.sp = { ...spRef.sp, incoming: { remoteIdentity: { uri: { user: '2001' } } } };
    rerender(<Phone />);
    act(() => { vi.advanceTimersByTime(150); });
    expect(spRef.sp.acceptIncoming).toHaveBeenCalled();
    expect(navigator.vibrate).toHaveBeenLastCalledWith(0);
  });

  it('pendiente sin INVITE en 35 s queda como perdida y se puede cerrar; rechazarlo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('location', { ...window.location, hostname: 'localhost', search: '?incall=', pathname: '/phone' });
    vi.stubGlobal('AudioContext', undefined);
    await montar();
    expect(screen.getByText('Llamada')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(35000); });
    expect(screen.getByText('Llamada perdida')).toBeTruthy();
    fireEvent.click(screen.getByText('Llamada perdida').parentElement.nextElementSibling.querySelector('button'));
    expect(screen.queryByText('Llamada perdida')).toBeNull();
    await act(async () => { swHandlers.message({ data: { kind: 'incoming', from: '777' } }); });
    expect(screen.getByText('777')).toBeTruthy();
    fireEvent.click(screen.getByText('Rechazar').previousElementSibling);
    expect(spRef.sp.rejectIncoming).toHaveBeenCalled();
    expect(screen.queryByText('777')).toBeNull();
  });

  it('aceptar el pendiente cuando ya llegó el INVITE lo atiende directo', async () => {
    await montar();
    await act(async () => { swHandlers.message({ data: { kind: 'incoming' } }); });
    expect(screen.getByText('Llamada')).toBeTruthy();
    spRef.sp.incoming = { x: 1 };
    fireEvent.click(screen.getByText('Aceptar').previousElementSibling);
    expect(spRef.sp.acceptIncoming).toHaveBeenCalled();
  });

  it('mensajes del service worker: rechazar desde la notificación, autoaceptar, y acciones', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { rerender } = await montar();
    await act(async () => { swHandlers.message({ data: { kind: 'incoming', decline: true } }); });
    expect(spRef.sp.rejectIncoming).toHaveBeenCalledTimes(1);
    await act(async () => { swHandlers.message({ data: { kind: 'incoming', from: '55', autoAccept: true } }); });
    spRef.sp = { ...spRef.sp, incoming: { remoteIdentity: { uri: { user: '55' } } } };
    rerender(<Phone />);
    act(() => { vi.advanceTimersByTime(150); });
    expect(spRef.sp.acceptIncoming).toHaveBeenCalledTimes(1);
    await act(async () => { swHandlers.message({ data: { kind: 'push-action', action: 'answer' } }); });
    await act(async () => { swHandlers.message({ data: { kind: 'push-action', action: 'reject' } }); });
    await act(async () => { swHandlers.message({ data: { kind: 'push-action', action: 'otra' } }); });
    await act(async () => { swHandlers.message({ data: { kind: 'otra' } }); });
    await act(async () => { swHandlers.message({}); });
    expect(spRef.sp.acceptIncoming).toHaveBeenCalledTimes(2);
    expect(spRef.sp.rejectIncoming).toHaveBeenCalledTimes(2);
  });

  it('no molestar rechaza también el pendiente de la notificación', async () => {
    st.local.setItem('pbxng_dnd', '1');
    await montar();
    await act(async () => { swHandlers.message({ data: { kind: 'incoming', from: '9' } }); });
    expect(spRef.sp.rejectIncoming).toHaveBeenCalled();
    expect(screen.queryByText('Llamada entrante…')).toBeNull();
  });

  it('gesto boca abajo: rechaza la entrante, o silencia la llamada en curso', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    window.__uiInteracted = true;
    navigator.vibrate = vi.fn();
    spRef.sp = crearSpFalso({ incoming: { remoteIdentity: { uri: { user: '1' } } } });
    const { rerender } = await montar();
    const mover = (z) => act(() => { const e = new Event('devicemotion'); e.accelerationIncludingGravity = z === null ? null : { z }; window.dispatchEvent(e); });
    mover(null); mover(-9);
    vi.setSystemTime(10_800);
    mover(-9);
    expect(spRef.sp.rejectIncoming).toHaveBeenCalled();
    expect(navigator.vibrate).toHaveBeenCalledWith(120);
    expect(flash()).toContain('Llamada rechazada (boca abajo)');
    mover(9);
    spRef.sp = { ...spRef.sp, incoming: null, call: 'Established', callInfo: { number: '3' } };
    rerender(<Phone />);
    mover(-9);
    vi.setSystemTime(12_000);
    mover(-9);
    expect(spRef.sp.toggleMute).toHaveBeenCalled();
    expect(navigator.vibrate).toHaveBeenLastCalledWith(60);
    mover(9); mover(-9);
    vi.setSystemTime(13_000);
    spRef.sp = { ...spRef.sp, muted: true };
    rerender(<Phone />);
    mover(-9);
    expect(spRef.sp.toggleMute).toHaveBeenCalledTimes(1);
  });
});
