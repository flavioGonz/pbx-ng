/* Integración con la API de PBX-NG (src/api.js). Fija qué se le manda a la central
 * (método, URL bajo /backend/api, token Bearer) por los dos caminos —el main de Electron
 * para saltear CORS y fetch directo en la PWA— y, sobre todo, cómo se traducen los
 * errores: un 403 tiene que llegar como error con mensaje, no como "lista vacía", y el
 * login tiene que decir en criollo por qué no entró en vez de dejar «Conectando…». */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import './helpers/logica-storage.js';
import * as api from '../src/api.js';

function resp(status, json, extra = {}) {
  return { status, ok: status < 400, json: async () => { if (json === undefined) throw new Error('no json'); return json; }, ...extra };
}

beforeEach(() => {
  localStorage.clear();
  delete window.sphone;
});

describe('sesión', () => {
  it('guarda base, token y usuario y sabe si está conectada', () => {
    expect(api.apiConnected()).toBe(false);
    api.applySession({ base: 'https://pbx', token: 't1', user: 'ana' });
    expect(api.getApiBase()).toBe('https://pbx');
    expect(api.getToken()).toBe('t1');
    expect(api.getApiUser()).toBe('ana');
    expect(api.apiConnected()).toBe(true);
    api.apiLogout();
    expect(api.getToken()).toBe('');
    expect(api.apiConnected()).toBe(false);
  });

  it('applySession sin datos no pisa nada', () => {
    api.applySession({ base: 'https://a' });
    api.applySession({});
    expect(api.getApiBase()).toBe('https://a');
    api.setApiBase('');
    expect(api.getApiBase()).toBe('');
  });

  it('si localStorage explota, los getters devuelven vacío', () => {
    const orig = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } }, configurable: true, writable: true });
    try {
      expect(api.getApiBase()).toBe('');
      expect(api.getToken()).toBe('');
      expect(api.getApiUser()).toBe('');
      expect(() => api.setApiBase('x')).not.toThrow();
      expect(() => api.apiLogout()).not.toThrow();
      expect(() => api.applySession({ base: 'b', token: 't', user: 'u' })).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true, writable: true });
    }
  });

  it('baseFromWss deriva http/https del WSS', () => {
    expect(api.baseFromWss('wss://pbx.ej:8089/ws')).toBe('https://pbx.ej:8089');
    expect(api.baseFromWss('ws://10.0.0.1/ws')).toBe('http://10.0.0.1');
    expect(api.baseFromWss('no es url')).toBe('');
  });
});

describe('llamadas por fetch (PWA)', () => {
  beforeEach(() => api.applySession({ base: 'https://pbx/', token: 'tok' }));

  it('GET con Bearer bajo /backend/api', async () => {
    const f = vi.fn(async () => resp(200, [{ ext: '1' }]));
    vi.stubGlobal('fetch', f);
    const d = await api.directory();
    expect(d).toEqual([{ ext: '1' }]);
    const [url, opt] = f.mock.calls[0];
    expect(url).toBe('https://pbx/backend/api/directory');
    expect(opt.method).toBe('GET');
    expect(opt.headers.Authorization).toBe('Bearer tok');
    expect(opt.body).toBeUndefined();
  });

  it('POST manda el cuerpo en JSON', async () => {
    const f = vi.fn(async () => resp(200, { ok: true }));
    vi.stubGlobal('fetch', f);
    await api.recordCall('101', 'start');
    expect(f.mock.calls[0][0]).toBe('https://pbx/backend/api/calls/record');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ ext: '101', action: 'start' });
  });

  it('un 401 borra el token y avisa sesión vencida', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(401, {})));
    await expect(api.presence()).rejects.toThrow('sesión vencida');
    expect(api.getToken()).toBe('');
  });

  it('un 403 sin mensaje dice que falta permiso, con status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(403, undefined)));
    const e = await api.clients().catch((x) => x);
    expect(e.message).toBe('tu usuario no tiene permiso para esto');
    expect(e.status).toBe(403);
  });

  it('un error con cuerpo usa el mensaje del servidor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(500, { message: 'se rompió' })));
    await expect(api.clientsFull()).rejects.toThrow('se rompió');
    vi.stubGlobal('fetch', vi.fn(async () => resp(502, {})));
    await expect(api.clientsFull()).rejects.toThrow('el servidor respondió 502');
  });

  it('sin token no manda Authorization', async () => {
    api.apiLogout();
    const f = vi.fn(async () => resp(200, {}));
    vi.stubGlobal('fetch', f);
    await api.provision();
    expect(f.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(f.mock.calls[0][0]).toBe('https://pbx/backend/api/provision?ext=');
  });

  it('arma bien las URLs de cada endpoint (codificando parámetros)', async () => {
    const f = vi.fn(async () => resp(200, {}));
    vi.stubGlobal('fetch', f);
    const casos = [
      [() => api.clientsLookup('09 1'), 'GET', '/clients/lookup?number=09%201'],
      [() => api.clientsLookup(), 'GET', '/clients/lookup?number='],
      [() => api.clientDetail('a/b'), 'GET', '/clients/a%2Fb'],
      [() => api.clientCreate({ name: 'x' }), 'POST', '/clients'],
      [() => api.clientStreams('5'), 'GET', '/intercom/streams?client=5'],
      [() => api.clientDeviceAdd('5', { label: 'c' }), 'POST', '/clients/5/devices'],
      [() => api.abrirRele('d1', 2), 'POST', '/devices/d1/rele'],
      [() => api.intercomTicket('cam 1'), 'GET', '/intercom/ticket?src=cam%201'],
      [() => api.recordings(), 'GET', '/recordings'],
      [() => api.spyCall('100', '101', 'whisper'), 'POST', '/calls/spy'],
      [() => api.matchRecording('1', '2', 99), 'GET', '/recordings/match?from=1&to=2&ts=99'],
      [() => api.matchRecording(), 'GET', '/recordings/match?from=&to=&ts='],
      [() => api.vmList('101'), 'GET', '/vm?ext=101'],
      [() => api.vmDel('101', 'INBOX', 'm1'), 'POST', '/vm/del'],
      [() => api.vmRead('101', 'INBOX', 'm1'), 'POST', '/vm/read'],
      [() => api.vmTranscribe('101', 'INBOX', 'm1'), 'POST', '/vm/transcribe'],
      [() => api.provision('101'), 'GET', '/provision?ext=101'],
      [() => api.cdr('101'), 'GET', '/cdr?ext=101&limit=100'],
      [() => api.cdr(undefined, 5), 'GET', '/cdr?ext=&limit=5'],
    ];
    for (const [fn, m, p] of casos) {
      f.mockClear();
      await fn();
      expect(f.mock.calls[0][1].method).toBe(m);
      expect(f.mock.calls[0][0]).toBe('https://pbx/backend/api' + p);
    }
    f.mockClear();
    await api.abrirRele('d1', 2);
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ rele: 2 });
  });
});

describe('llamadas por el main de Electron', () => {
  beforeEach(() => api.applySession({ base: 'https://pbx', token: 'tok' }));

  it('pasa método, url, cuerpo y token al main', async () => {
    const sp = vi.fn(async () => ({ status: 200, json: { ok: 1 } }));
    window.sphone = { api: sp };
    expect(await api.vmDel('1', 'INBOX', 'x')).toEqual({ ok: 1 });
    expect(sp).toHaveBeenCalledWith({ method: 'POST', url: 'https://pbx/backend/api/vm/del', body: { ext: '1', folder: 'INBOX', id: 'x' }, token: 'tok' });
  });

  it('error de red, 401 y 403 se traducen', async () => {
    window.sphone = { api: async () => ({ error: 'ECONNREFUSED' }) };
    await expect(api.directory()).rejects.toThrow('ECONNREFUSED');
    window.sphone = { api: async () => ({ status: 403, json: { error: 'solo admin' } }) };
    const e = await api.directory().catch((x) => x);
    expect(e.message).toBe('solo admin');
    expect(e.status).toBe(403);
    window.sphone = { api: async () => ({ status: 401 }) };
    await expect(api.directory()).rejects.toThrow('sesión vencida');
    expect(api.getToken()).toBe('');
  });
});

describe('apiLogin', () => {
  it('valida la URL antes de llamar', async () => {
    expect(await api.apiLogin('', 'a', 'b')).toEqual({ error: 'falta la URL del sistema' });
    expect((await api.apiLogin('pbx.ej', 'a', 'b')).error).toMatch(/https:\/\//);
  });

  it('login correcto guarda token y usuario', async () => {
    const f = vi.fn(async () => resp(200, { token: 'T', user: { name: 'Ana' } }));
    vi.stubGlobal('fetch', f);
    const r = await api.apiLogin(' https://pbx/ ', 'ana', 'pw');
    expect(r).toEqual({ ok: true, user: { name: 'Ana' } });
    expect(f.mock.calls[0][0]).toBe('https://pbx/backend/api/auth/login');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ username: 'ana', password: 'pw' });
    expect(api.getToken()).toBe('T');
    expect(api.getApiUser()).toBe('ana');
  });

  it('respuesta sin token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { error: 'raro' })));
    expect(await api.apiLogin('https://pbx', 'a', 'b')).toEqual({ error: 'raro' });
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, null)));
    expect(await api.apiLogin('https://pbx', 'a', 'b')).toEqual({ error: 'el sistema no devolvió una sesión' });
  });

  it('traduce cada falla a un mensaje para el operador', async () => {
    const casos = [
      [{ status: 401 }, 'usuario o contraseña incorrectos'],
      [{ status: 404, json: {} }, 'esa URL responde, pero no es el panel de una central PBX-NG'],
      [{ status: 429, json: {} }, 'demasiados intentos seguidos: la central te frenó unos minutos'],
      [{ status: 403, json: { error: 'bloqueado' } }, 'bloqueado'],
      [{ error: 'getaddrinfo ENOTFOUND pbx' }, 'no se encontró ese servidor: revisá la URL'],
      [{ error: 'connect ECONNREFUSED' }, 'el servidor no acepta la conexión desde esta red'],
      [{ error: 'timeout' }, 'el servidor no contestó a tiempo'],
      [{ error: 'otra cosa' }, 'otra cosa'],
      [{ status: 500, json: {} }, 'el servidor respondió 500'],
    ];
    for (const [r, msg] of casos) {
      window.sphone = { api: async () => r };
      expect((await api.apiLogin('https://pbx', 'a', 'b')).error).toBe(msg);
    }
  });

  it('una excepción sin mensaje dice que no se pudo conectar', async () => {
    window.sphone = { api: async () => { throw null; } }; // eslint-disable-line no-throw-literal
    expect((await api.apiLogin('https://pbx', 'a', 'b')).error).toBe('no se pudo conectar');
  });

  it('si fetch tira un 401 crudo (sin status) igual dice credenciales', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(401, {})));
    // el 401 del fetch sale como "sesión vencida" sin status: tiene que traducirse igual
    expect((await api.apiLogin('https://pbx', 'a', 'b')).error).toBe('usuario o contraseña incorrectos');
  });
});

describe('iceDeLaCentral (pública)', () => {
  it('sin central conocida falla con mensaje', async () => {
    await expect(api.iceDeLaCentral()).rejects.toThrow(/falta la URL del panel/);
  });

  it('usa la base pasada o la de la sesión, por fetch sin token', async () => {
    const f = vi.fn(async () => resp(200, { iceServers: [] }));
    vi.stubGlobal('fetch', f);
    await api.iceDeLaCentral('https://c/');
    expect(f.mock.calls[0][0]).toBe('https://c/backend/api/ice');
    expect(f.mock.calls[0][1].headers.Authorization).toBeUndefined();
    api.setApiBase('https://s');
    await api.iceDeLaCentral();
    expect(f.mock.calls[1][0]).toBe('https://s/backend/api/ice');
  });

  it('errores por fetch y por el main', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(500, undefined)));
    await expect(api.iceDeLaCentral('https://c')).rejects.toThrow('el servidor respondió 500');
    window.sphone = { api: async () => ({ error: 'ETIMEDOUT' }) };
    await expect(api.iceDeLaCentral('https://c')).rejects.toThrow('ETIMEDOUT');
    window.sphone = { api: async () => ({ status: 404, json: null }) };
    await expect(api.iceDeLaCentral('https://c')).rejects.toThrow('el servidor respondió 404');
    window.sphone = { api: async (o) => ({ status: 200, json: { url: o.url } }) };
    expect(await api.iceDeLaCentral('https://c')).toEqual({ url: 'https://c/backend/api/ice' });
  });
});

describe('audio de grabaciones y buzón', () => {
  beforeEach(() => {
    api.applySession({ base: 'https://pbx', token: 'tok' });
    URL.createObjectURL = vi.fn(() => 'blob:x');
  });

  it('por el main arma un blob con el tipo recibido', async () => {
    const apiBlob = vi.fn(async () => ({ b64: btoa('RIFF'), type: 'audio/mpeg' }));
    window.sphone = { apiBlob };
    expect(await api.recordingAudioUrl(7)).toBe('blob:x');
    expect(apiBlob).toHaveBeenCalledWith({ method: 'GET', url: 'https://pbx/backend/api/recordings/7/audio', token: 'tok' });
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('audio/mpeg');
    expect(blob.size).toBe(4);
    expect(await api.vmAudioUrl('101', '', 'm1')).toBe('blob:x');
    expect(apiBlob.mock.calls[1][0].url).toBe('https://pbx/backend/api/vm/audio?ext=101&folder=INBOX&id=m1');
  });

  it('por el main sin tipo usa audio/wav; con error devuelve vacío', async () => {
    window.sphone = { apiBlob: async () => ({ b64: btoa('a') }) };
    await api.recordingAudioUrl(1);
    await api.vmAudioUrl('1', 'Old', '2');
    expect(URL.createObjectURL.mock.calls[0][0].type).toBe('audio/wav');
    expect(URL.createObjectURL.mock.calls[1][0].type).toBe('audio/wav');
    window.sphone = { apiBlob: async () => ({ error: 'x' }) };
    expect(await api.recordingAudioUrl(1)).toBe('');
    expect(await api.vmAudioUrl('1', 'INBOX', '2')).toBe('');
  });

  it('por fetch con Bearer, y vacío si no es ok', async () => {
    const f = vi.fn(async () => resp(200, null, { blob: async () => new Blob(['x']) }));
    vi.stubGlobal('fetch', f);
    expect(await api.recordingAudioUrl(3)).toBe('blob:x');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(await api.vmAudioUrl('1', 'INBOX', '2')).toBe('blob:x');
    api.apiLogout();
    vi.stubGlobal('fetch', vi.fn(async () => resp(404, null)));
    expect(await api.recordingAudioUrl(3)).toBe('');
    expect(await api.vmAudioUrl('1', 'INBOX', '2')).toBe('');
  });
});
