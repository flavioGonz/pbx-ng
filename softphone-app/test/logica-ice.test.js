/* Servidores ICE (src/ice.js). La regla que se fija acá: el relay lo dice la CENTRAL
 * (/api/ice), lo cargado a mano es sólo plan C. Visto en producción: un aparato con un
 * TURN viejo guardado se quedaba sin audio detrás de NAT mientras la central estaba
 * perfecta. También el probador ICE, que es lo que el operador mira para saber si el
 * TURN autentica (401 => credencial vieja) o directamente no responde. */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import './helpers/logica-storage.js';

let ice, api;
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  delete window.sphone;
  api = await import('../src/api.js');
  ice = await import('../src/ice.js');
});
afterEach(() => { vi.useRealTimers(); });

const ok = (j) => ({ ok: true, status: 200, json: async () => j });

describe('baseDeLaCentral', () => {
  it('prioriza la sesión de API, después el WSS y por último el dominio', () => {
    expect(ice.baseDeLaCentral({ domain: 'http://pbx.ej' })).toBe('https://pbx.ej');
    expect(ice.baseDeLaCentral({ wss: 'wss://w.ej/ws', domain: 'd' })).toBe('https://w.ej');
    api.setApiBase('https://api.ej');
    expect(ice.baseDeLaCentral({ wss: 'wss://w.ej/ws' })).toBe('https://api.ej');
    api.setApiBase('');
    expect(ice.baseDeLaCentral()).toBe('');
  });
});

describe('refrescarIce', () => {
  it('sin central conocida no pregunta', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    expect(await ice.refrescarIce({})).toEqual({ ok: false, error: 'todavía no sé cuál es la central' });
    expect(f).not.toHaveBeenCalled();
  });

  it('guarda la lista de la central y la usa por encima de lo manual', async () => {
    const lista = [{ urls: 'turn:relay.ej', username: 'u', credential: 'c' }];
    vi.stubGlobal('fetch', vi.fn(async () => ok({ iceServers: lista, origen: 'coturn' })));
    const r = await ice.refrescarIce({ domain: 'pbx.ej' });
    expect(r).toEqual({ ok: true, origen: 'coturn', n: 1 });
    const ef = ice.iceEfectivos({ stun: 'stun.viejo' });
    expect(ef.fuente).toBe('central');
    expect(ef.lista).toEqual(lista);
    expect(ef.origen).toBe('coturn');
    expect(ef.at).toBeGreaterThan(0);
    expect(ice.iceServersFrom({})).toEqual(lista);
    expect(JSON.parse(localStorage.getItem('sp_ice_central')).iceServers).toEqual(lista);
  });

  it('una respuesta vacía NO pisa la lista buena', async () => {
    localStorage.setItem('sp_ice_central', JSON.stringify({ iceServers: [{ urls: 'stun:a' }], origen: '', at: 5 }));
    vi.stubGlobal('fetch', vi.fn(async () => ok({ iceServers: [], motivo: 'sin TURN' })));
    expect(await ice.refrescarIce({ domain: 'd' })).toEqual({ ok: false, error: 'sin TURN' });
    vi.stubGlobal('fetch', vi.fn(async () => ok(null)));
    expect(await ice.refrescarIce({ domain: 'd' })).toEqual({ ok: false, error: 'la central no tiene relay configurado' });
    const ef = ice.iceEfectivos({});
    expect(ef).toEqual({ lista: [{ urls: 'stun:a' }], fuente: 'central', origen: '', at: 5 });
  });

  it('sin origen en la respuesta queda vacío; sin "at" en el caché queda 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ iceServers: [{ urls: 'stun:x' }] })));
    expect(await ice.refrescarIce({ domain: 'd' })).toEqual({ ok: true, origen: '', n: 1 });
  });

  it('si la central no contesta devuelve el error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await ice.refrescarIce({ domain: 'd' })).toEqual({ ok: false, error: 'offline' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'crudo'; })); // eslint-disable-line no-throw-literal
    expect(await ice.refrescarIce({ domain: 'd' })).toEqual({ ok: false, error: 'crudo' });
  });

  it('un caché corrupto o sin "at" se maneja', async () => {
    localStorage.setItem('sp_ice_central', '{x');
    expect(ice.iceEfectivos({}).fuente).toBe('ninguna');
    vi.resetModules();
    localStorage.setItem('sp_ice_central', JSON.stringify({ iceServers: [{ urls: 'stun:a' }] }));
    const ice2 = await import('../src/ice.js');
    expect(ice2.iceEfectivos({}).at).toBe(0);
  });

  it('si no se puede escribir el caché igual responde ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ iceServers: [{ urls: 'stun:x' }] })));
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('lleno'); });
    expect((await ice.refrescarIce({ domain: 'd' })).ok).toBe(true);
  });
});

describe('lista manual (plan C)', () => {
  it('arma STUN y TURN con prefijos y agrega TCP si no se indicó transporte', () => {
    const ef = ice.iceEfectivos({ stun: 'a.ej:3478, stun:b.ej', turn: 'relay.ej:3478', turnUser: 'u', turnPass: 'p' });
    expect(ef.fuente).toBe('manual');
    expect(ef.lista).toEqual([
      { urls: 'stun:a.ej:3478' }, { urls: 'stun:b.ej' },
      { urls: ['turn:relay.ej:3478', 'turn:relay.ej:3478?transport=tcp'], username: 'u', credential: 'p' },
    ]);
  });

  it('respeta turns: y un transport explícito; sin usuario no hay TURN', () => {
    expect(ice.iceServersFrom({ turn: 'turns:r:5349?transport=tcp', turnUser: 'u', turnPass: 'p' }))
      .toEqual([{ urls: ['turns:r:5349?transport=tcp'], username: 'u', credential: 'p' }]);
    expect(ice.iceEfectivos({ turn: 'r', turnUser: '' })).toEqual({ lista: [], fuente: 'ninguna', origen: '', at: 0 });
    expect(ice.iceEfectivos().fuente).toBe('ninguna');
  });
});

/* RTCPeerConnection falso: el test decide qué candidatos y errores aparecen. */
class FakePC {
  constructor(cfg) { FakePC.last = this; this.cfg = cfg; this.closed = false; }
  createDataChannel() {}
  createOffer() { return FakePC.offer ? FakePC.offer() : Promise.resolve({ sdp: 'x' }); }
  setLocalDescription() { return Promise.resolve(); }
  close() { this.closed = true; if (FakePC.closeThrows) throw new Error('x'); }
}

describe('testIce', () => {
  beforeEach(() => { FakePC.offer = null; FakePC.closeThrows = false; vi.stubGlobal('RTCPeerConnection', FakePC); });
  const cfgTurn = { stun: 's.ej', turn: 'r.ej', turnUser: 'u', turnPass: 'p' };

  it('relay y srflx => ok, con IP pública y del relay', async () => {
    const p = ice.testIce(cfgTurn);
    const pc = FakePC.last;
    expect(pc.cfg.iceServers.length).toBe(2);
    pc.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host' } });
    pc.onicecandidate({ candidate: { candidate: 'candidate:2 1 udp 1 200.1.1.1 5000 typ srflx', type: 'srflx' } });
    pc.onicecandidate({ candidate: { candidate: 'x', type: 'srflx', address: '200.9.9.9' } });
    pc.onicecandidate({ candidate: { candidate: 'candidate:3 1 udp 1 1.2.3.4 5000 typ relay' } });
    pc.onicecandidate({ candidate: { candidate: 'candidate:4 1 udp 1 5.6.7.8 5000 typ relay' } });
    pc.onicecandidate({ candidate: {} });
    pc.onicecandidate({ candidate: null });
    const r = await p;
    expect(r.state).toBe('ok');
    expect(r).toMatchObject({ host: 1, srflx: 2, relay: 2, publicIp: '200.1.1.1', relayIp: '1.2.3.4', turnConfigured: true, stunConfigured: true, fuente: 'manual' });
    expect(pc.closed).toBe(true);
  });

  it('error 401 del TURN corta enseguida como turn-auth', async () => {
    const p = ice.testIce(cfgTurn);
    FakePC.last.onicecandidateerror({ errorCode: 401, errorText: 'Unauthorized', url: 'turn:r.ej' });
    const r = await p;
    expect(r.state).toBe('turn-auth');
    expect(r.errors).toEqual(['401 Unauthorized (turn:r.ej)']);
  });

  it('fin de candidatos sin relay pero con 401 anotado => turn-auth; sin 401 => turn-unreachable', async () => {
    let p = ice.testIce(cfgTurn);
    FakePC.last.onicecandidateerror({ errorcode: 701, errortext: 'unauthorized-ish' });
    FakePC.last.onicecandidateerror({});
    FakePC.last.onicecandidateerror(null);
    FakePC.last.onicecandidate({ candidate: null });
    expect((await p).state).toBe('turn-auth');
    p = ice.testIce(cfgTurn);
    FakePC.last.onicecandidateerror({ errorText: 'timeout' });
    FakePC.last.onicecandidate({ candidate: null });
    const r = await p;
    expect(r.state).toBe('turn-unreachable');
    expect(r.errors).toEqual(['timeout']);
  });

  it('sin TURN configurado => no-turn', async () => {
    const p = ice.testIce({ stun: 's' });
    FakePC.last.onicecandidate({ candidate: null });
    const r = await p;
    expect(r.state).toBe('no-turn');
    expect(r.turnConfigured).toBe(false);
  });

  it('timeout: sin relay => turn-unreachable / no-turn; con relay => ok', async () => {
    vi.useFakeTimers();
    let p = ice.testIce(cfgTurn, 100);
    vi.advanceTimersByTime(100);
    expect((await p).state).toBe('turn-unreachable');
    p = ice.testIce({}, 100);
    vi.advanceTimersByTime(100);
    expect((await p).state).toBe('no-turn');
    p = ice.testIce(cfgTurn, 100);
    FakePC.last.onicecandidate({ candidate: { type: 'relay', candidate: '' } });
    vi.advanceTimersByTime(100);
    expect((await p).state).toBe('ok');
  });

  it('si RTCPeerConnection no se puede crear => error', async () => {
    vi.stubGlobal('RTCPeerConnection', function () { throw new Error('sin webrtc'); });
    const r = await ice.testIce(cfgTurn);
    expect(r.state).toBe('error');
    expect(r.errors).toEqual(['sin webrtc']);
  });

  it('si createOffer falla (promesa o tirando) => error; el close que explota no importa', async () => {
    FakePC.offer = () => Promise.reject(new Error('offer'));
    FakePC.closeThrows = true;
    let r = await ice.testIce(cfgTurn);
    expect(r.state).toBe('error');
    expect(r.errors).toEqual(['offer']);
    FakePC.offer = () => { throw 'sin'; }; // eslint-disable-line no-throw-literal
    r = await ice.testIce(cfgTurn);
    expect(r.state).toBe('error');
    expect(r.errors).toEqual(['sin']);
  });

  it('detecta TURN/STUN con urls como array (lista de la central)', async () => {
    localStorage.setItem('sp_ice_central', JSON.stringify({ iceServers: [{ urls: ['turn:a'] }, { urls: 'stun:b' }, {}], origen: 'c', at: 1 }));
    const p = ice.testIce({});
    FakePC.last.onicecandidate({ candidate: null });
    const r = await p;
    expect(r).toMatchObject({ turnConfigured: true, stunConfigured: true, fuente: 'central', origen: 'c' });
  });
});
