/* Aprovisionamiento (src/prov.js): el QR / deep-link pbxng://prov#... y el link de
 * enrolado https://central/enroll?token=... Es la manera en que un operador deja andando
 * un softphone sin tipear credenciales; un payload mal leído es un aparato que no
 * registra, y un mensaje de error confuso es una llamada a soporte. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encodeProv, decodeProv, parseEnroll, resolveEnroll } from '../src/prov.js';

beforeEach(() => { delete window.sphone; });

describe('encodeProv / decodeProv', () => {
  it('ida y vuelta conserva los campos, con acentos, y descarta lo vacío o desconocido', () => {
    const link = encodeProv({ ext: '101', domain: 'pbx', name: 'Recepción ñ', pass: '', otro: 'x', wss: 'wss://pbx/ws' });
    expect(link.startsWith('pbxng://prov#')).toBe(true);
    expect(link.split('#')[1]).not.toMatch(/[+/=]/);   // base64url: viaja en una URL sin escapar
    const d = decodeProv(link);
    expect(d).toEqual({ ext: '101', domain: 'pbx', name: 'Recepción ñ', wss: 'wss://pbx/ws', transport: 'webrtc' });
  });

  it('encodeProv sin cfg da un payload vacío', () => {
    expect(decodeProv(encodeProv(null))).toBeNull();
  });

  it('acepta JSON plano, la forma pbxng://prov sin # y base64url suelto', () => {
    expect(decodeProv('{"ext":1,"domain":"d","sipServer":"s"}')).toEqual({ ext: '1', domain: 'd', sipServer: 's', transport: 'sip' });
    const b64 = encodeProv({ ext: '2', domain: 'd' }).split('#')[1];
    expect(decodeProv('pbxng://prov' + b64).ext).toBe('2');
    expect(decodeProv(b64).transport).toBe('webrtc');
    expect(decodeProv('{"ext":"3","domain":"d","transport":"sip"}').transport).toBe('sip');
  });

  it('sin interno o dominio, o basura, devuelve null', () => {
    expect(decodeProv('{"ext":"1"}')).toBeNull();
    expect(decodeProv('%%%')).toBeNull();
    expect(decodeProv()).toBeNull();
  });
});

describe('parseEnroll', () => {
  it('extrae base y token del link del panel', () => {
    expect(parseEnroll(' https://pbx.cliente.com/enroll?token=ab.C-1 ')).toEqual({ base: 'https://pbx.cliente.com', token: 'ab.C-1' });
    expect(parseEnroll('http://10.0.0.1:3000/enroll?x=1&token=zz')).toEqual({ base: 'http://10.0.0.1:3000', token: 'zz' });
    expect(parseEnroll('https://pbx/otra?token=a')).toBeNull();
    expect(parseEnroll(null)).toBeNull();
  });
});

describe('resolveEnroll', () => {
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });

  it('no es un link de enrolado: null', async () => {
    expect(await resolveEnroll('hola')).toBeNull();
  });

  it('usa prov_url de la central nueva por el proxy del panel', async () => {
    const f = vi.fn(async () => ok({ prov_url: encodeProv({ ext: '9', domain: 'd' }) }));
    vi.stubGlobal('fetch', f);
    const p = await resolveEnroll('https://pbx/enroll?token=T');
    expect(p.ext).toBe('9');
    expect(f.mock.calls[0][0]).toBe('https://pbx/backend/api/enroll/T');
  });

  it('central vieja: arma la config con STUN del propio host, probando /api si el proxy falla', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(ok({ ext: 101, password: 'pw', server: 'pbx.ej:8089' }));
    vi.stubGlobal('fetch', f);
    const p = await resolveEnroll('https://pbx/enroll?token=T');
    expect(f.mock.calls[1][0]).toBe('https://pbx/api/enroll/T');
    expect(p).toEqual({ transport: 'webrtc', domain: 'pbx.ej:8089', ext: '101', pass: 'pw', wss: 'wss://pbx.ej:8089/ws', stun: 'stun:pbx.ej:3478' });
  });

  it('central vieja sin server ni password usa el host del link', async () => {
    window.sphone = { api: vi.fn(async () => ({ status: 200, json: { ext: '5' } })) };
    const p = await resolveEnroll('https://h.ej/enroll?token=T');
    expect(p.domain).toBe('h.ej');
    expect(p.pass).toBe('');
    expect(window.sphone.api).toHaveBeenCalledWith({ method: 'GET', url: 'https://h.ej/backend/api/enroll/T' });
  });

  it('token expirado da un mensaje claro', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ error: 'token expirado' })));
    await expect(resolveEnroll('https://pbx/enroll?token=T')).rejects.toThrow('El link de enrolamiento expiró. Pedí uno nuevo.');
    vi.stubGlobal('fetch', vi.fn(async () => ok({ error: 'token usado' })));
    await expect(resolveEnroll('https://pbx/enroll?token=T')).rejects.toThrow('token usado');
  });

  it('respuestas vacías o sin datos útiles terminan en error genérico', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(null)));
    await expect(resolveEnroll('https://pbx/enroll?token=T')).rejects.toThrow('No se pudo canjear el token de enrolamiento.');
    vi.stubGlobal('fetch', vi.fn(async () => ok({ prov_url: 'basura' })));
    await expect(resolveEnroll('https://pbx/enroll?token=T')).rejects.toThrow('No se pudo canjear');
  });

  it('errores del main: de red y de HTTP', async () => {
    window.sphone = { api: async () => ({ error: 'ENOTFOUND' }) };
    await expect(resolveEnroll('https://pbx/enroll?token=T')).rejects.toThrow('ENOTFOUND');
    window.sphone = { api: async () => ({ status: 500 }) };
    await expect(resolveEnroll('https://pbx/enroll?token=T')).rejects.toThrow('HTTP 500');
    window.sphone = { api: async () => null };
    await expect(resolveEnroll('https://pbx/enroll?token=T')).rejects.toThrow('HTTP ?');
  });
});
