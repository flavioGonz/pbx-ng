/* Intercom: las cámaras y porteros de cada cliente, en vivo, y las acciones del portero
 * (hablarle y abrirle) pegadas a su imagen.
 *
 * El visor (MseTile) es fMP4 sobre WebSocket contra go2rtc —el de la central o el propio
 * de la app— y tiene que terminar SIEMPRE en algo que se lea: «EN VIVO», «Sin señal» con
 * un botón para reintentar, o «Guardada en este teléfono» con el motivo. Nunca un
 * rectángulo negro. La entrada de un solo uso tiene que viajar en la URL (el WebSocket no
 * manda cabeceras) y una cámara del go2rtc propio no tiene que pedirle nada a la central.
 * El relé por DTMF sólo puede abrir con la llamada en curso: el tono viaja por ese audio. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { montar, avanzar, ponerSp, estado, mApi, CFG_OK, irA } from './helpers/pantallas-app.jsx';

vi.mock('../src/useSip.js', async () => (await import('./helpers/pantallas-app.jsx')).mUseSip);
vi.mock('../src/useSipNative.js', async () => (await import('./helpers/pantallas-app.jsx')).mUseSipNative);
vi.mock('../src/config.js', async () => (await import('./helpers/pantallas-app.jsx')).mConfig);
vi.mock('../src/api.js', async () => (await import('./helpers/pantallas-app.jsx')).mApi);
vi.mock('../src/prov.js', async () => (await import('./helpers/pantallas-app.jsx')).mProv);
vi.mock('../src/ice.js', async () => (await import('./helpers/pantallas-app.jsx')).mIce);
vi.mock('../src/sounds.js', async () => (await import('./helpers/pantallas-app.jsx')).mSounds);
vi.mock('../src/anim.js', async () => (await import('./helpers/pantallas-app.jsx')).mAnim);
vi.mock('qrcode', async () => (await import('./helpers/pantallas-app.jsx')).mQrcode);
vi.mock('jsqr', async () => (await import('./helpers/pantallas-app.jsx')).mJsqr);

/* ── MediaSource y WebSocket de mentira ─────────────────────────────────── */
let fuentes = [], sockets = [];
class FakeSB {
  constructor(mime) { this.mime = mime; this.mode = ''; this.updating = false; this.oyentes = {}; this.appendBuffer = vi.fn(); this.remove = vi.fn(); this.buffered = { length: 1, start: () => 0, end: () => 20 }; }
  addEventListener(k, f) { this.oyentes[k] = f; }
}
class FakeMS {
  constructor() { this.oyentes = {}; this.readyState = 'open'; this.endOfStream = vi.fn(); this.sbs = []; this.falla = false; fuentes.push(this); }
  addEventListener(k, f) { this.oyentes[k] = f; }
  addSourceBuffer(m) { if (FakeMS.romper) throw new Error('codec'); const sb = new FakeSB(m); this.sbs.push(sb); return sb; }
  static isTypeSupported(t) { if (t.includes('opus')) throw new Error('raro'); return t.includes('avc1.640029') || t.includes('mp4a.40.2'); }
}
class FakeWS {
  constructor(url) { if (FakeWS.romper) throw new Error('no'); this.url = url; this.send = vi.fn(); this.close = vi.fn(); sockets.push(this); }
}
beforeEach(() => {
  fuentes = []; sockets = []; FakeMS.romper = false; FakeWS.romper = false;
  globalThis.MediaSource = FakeMS; window.MediaSource = FakeMS;
  globalThis.WebSocket = FakeWS; window.WebSocket = FakeWS;
  URL.createObjectURL = vi.fn(() => 'blob:ms');
});
afterEach(() => { vi.useRealTimers(); delete globalThis.MediaSource; delete window.MediaSource; });

const CLIENTES = [{ id: 'c1', name: 'Casa Pérez' }, { id: 'c2', name: 'Bar Zeta' }];
const CAM = { id: 'd1', label: 'Frente', type: 'camera', src: 'frente', base: 'http://g2.test/' };
async function intercom({ streams = [CAM], sphone, central = true, clientes } = {}) {
  mApi.clients.mockResolvedValue(CLIENTES);
  mApi.clientStreams.mockResolvedValue(streams);
  const r = await montar({ cfg: CFG_OK, central, sphone, clientes });
  irA('Intercom');
  await avanzar(0);
  return r;
}
async function elegir(nombre) { fireEvent.click(screen.getByText(nombre)); await avanzar(0); }
const enAct = (fn) => act(async () => { fn(); });
const abrirFuente = async (i = 0) => { await enAct(() => fuentes[i].oyentes.sourceopen()); await avanzar(0); };
const msj = (ws, data) => enAct(() => ws.onmessage({ data }));

describe('lista de clientes con cámaras', () => {
  it('mientras la central no contesta dice «Cargando…»', async () => {
    mApi.clients.mockReturnValue(new Promise(() => {}));
    await montar({ cfg: CFG_OK, central: true });
    irA('Intercom');
    expect(screen.getByText('Cargando…')).toBeTruthy();
  });

  it('si la central niega la lista lo dice, en vez de «no hay nada»', async () => {
    mApi.clients.mockRejectedValue(new Error('403 sin permiso'));
    await montar({ cfg: CFG_OK, central: true });
    irA('Intercom');
    await avanzar(0);
    expect(screen.getByText('No se pudo leer la lista: 403 sin permiso')).toBeTruthy();
  });

  it('un error sin mensaje usa uno genérico; una lista rara se toma vacía', async () => {
    mApi.clients.mockRejectedValueOnce({}).mockResolvedValueOnce({ raro: 1 });
    await montar({ cfg: CFG_OK, central: true });
    irA('Intercom');
    await avanzar(0);
    expect(screen.getByText('No se pudo leer la lista: no se pudo leer la lista')).toBeTruthy();
  });

  it('sin clientes con cámaras explica dónde cargarlas', async () => {
    await montar({ cfg: CFG_OK });
    irA('Intercom');
    expect(screen.getByText(/Ningún cliente tiene cámaras todavía/)).toBeTruthy();
  });

  it('busca por nombre y pide las cámaras del elegido', async () => {
    await intercom({ clientes: [{ id: 'loc_x', name: 'Sin cámaras', devices: [] }] });
    expect(screen.queryByText('Sin cámaras')).toBeNull();
    expect(screen.getByText('Elegí un cliente para ver sus cámaras/porteros en vivo.')).toBeTruthy();
    const q = screen.getByPlaceholderText('Buscar cliente…');
    fireEvent.change(q, { target: { value: 'zeta' } });
    expect(screen.queryByText('Casa Pérez')).toBeNull();
    fireEvent.change(q, { target: { value: 'nada' } });
    expect(screen.getByText('Sin resultados')).toBeTruthy();
    fireEvent.change(q, { target: { value: '' } });
    fireEvent.click(screen.getByText('Casa Pérez'));
    expect(screen.getAllByText('Cargando…').length).toBeGreaterThan(0);
    await avanzar(0);
    expect(mApi.clientStreams).toHaveBeenCalledWith('c1');
    expect(screen.getByText('Frente')).toBeTruthy();
    fireEvent.click(screen.getByText('Refrescar'));
    await avanzar(0);
    expect(mApi.clientStreams).toHaveBeenCalledTimes(2);
  });

  it('si las cámaras no llegan lo dice; si no hay, también', async () => {
    mApi.clients.mockResolvedValue(CLIENTES);
    mApi.clientStreams.mockRejectedValueOnce(new Error('go2rtc caído')).mockRejectedValueOnce({}).mockResolvedValueOnce(null);
    await montar({ cfg: CFG_OK, central: true });
    irA('Intercom');
    await avanzar(0);
    await elegir('Casa Pérez');
    expect(screen.getByText('No se pudieron leer las cámaras: go2rtc caído')).toBeTruthy();
    await elegir('Bar Zeta');
    expect(screen.getByText('No se pudieron leer las cámaras: no se pudieron leer las cámaras')).toBeTruthy();
    await elegir('Casa Pérez');
    expect(screen.getByText('Este cliente no tiene dispositivos.')).toBeTruthy();
  });
});

describe('visor por WebSocket (navegador)', () => {
  it('pide una entrada de un solo uso, negocia el códec y pasa a EN VIVO', async () => {
    const { container } = await intercom();
    await elegir('Casa Pérez');
    expect(screen.getByText('CARGANDO')).toBeTruthy();
    await abrirFuente();
    expect(mApi.intercomTicket).toHaveBeenCalledWith('frente');
    const ws = sockets[0];
    expect(ws.url).toBe('ws://g2.test/api/ws?src=frente&t=tk1');
    expect(ws.binaryType).toBe('arraybuffer');
    await enAct(() => ws.onopen());
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: 'mse', value: 'avc1.640029,mp4a.40.2' });
    await msj(ws, 'no es json');
    await msj(ws, JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' }));
    await avanzar(0);
    expect(screen.getByText('EN VIVO')).toBeTruthy();
    const sb = fuentes[0].sbs[0];
    expect(sb.mode).toBe('segments');
    await msj(ws, new Uint8Array([1, 2, 3]).buffer);
    expect(sb.appendBuffer).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    // al terminar un segmento recorta lo viejo y pasa al siguiente
    const video = container.querySelector('video');
    sb.updating = true;
    await msj(ws, new Uint8Array([4]).buffer);
    expect(sb.appendBuffer).toHaveBeenCalledTimes(1);
    sb.updating = false;
    await enAct(() => sb.oyentes.updateend());
    expect(video.currentTime).toBeCloseTo(19.6);
    expect(sb.remove).toHaveBeenCalledWith(0, 12);
    expect(sb.appendBuffer).toHaveBeenCalledTimes(2);
    // el audio arranca muteado y se prende con el botón
    expect(video.muted).toBe(true);
    const parlante = screen.getByText('Frente').parentElement.querySelector('button');
    fireEvent.click(parlante);
    expect(video.muted).toBe(false);
    fireEvent.click(parlante);
    expect(video.muted).toBe(true);
  });

  it('la cola no crece sin límite si el buffer está ocupado y un append fallido no rompe', async () => {
    await intercom();
    await elegir('Casa Pérez');
    await abrirFuente();
    const ws = sockets[0];
    await msj(ws, JSON.stringify({ type: 'mse', value: 'v' }));
    const sb = fuentes[0].sbs[0];
    sb.updating = true;
    for (let i = 0; i < 90; i++) await msj(ws, new Uint8Array([i]).buffer);
    sb.updating = false;
    sb.appendBuffer.mockImplementation(() => { throw new Error('QuotaExceeded'); });
    await enAct(() => sb.oyentes.updateend());
    expect(sb.appendBuffer).toHaveBeenCalledTimes(1);
    // un buffer roto tampoco tumba el recorte
    sb.buffered = null;
    await expect(enAct(() => sb.oyentes.updateend())).resolves.toBeUndefined();
  });

  it('un error de go2rtc o un corte pasan a «Sin señal» y Reintentar abre otra conexión', async () => {
    await intercom();
    await elegir('Casa Pérez');
    await abrirFuente();
    const ws = sockets[0];
    await msj(ws, JSON.stringify({ type: 'error', value: 'no stream' }));
    await avanzar(0);
    expect(screen.getByText('Sin señal')).toBeTruthy();
    expect(screen.getByText('OFFLINE')).toBeTruthy();
    expect(screen.getByText('http://g2.test/ · frente')).toBeTruthy();
    fireEvent.click(screen.getByText(/Reintentar/));
    await avanzar(0);
    expect(ws.close).toHaveBeenCalled();
    expect(fuentes[0].endOfStream).toHaveBeenCalled();
    expect(fuentes.length).toBe(2);
    await abrirFuente(1);
    const ws2 = sockets[1];
    await msj(ws2, JSON.stringify({ type: 'mse', value: 'v' }));
    await avanzar(0);
    await enAct(() => ws2.onclose());
    await avanzar(0);
    expect(screen.getByText('Sin señal')).toBeTruthy();
    fireEvent.click(screen.getByText(/Reintentar/));
    await abrirFuente(2);
    await enAct(() => sockets[2].onerror());
    await avanzar(0);
    expect(screen.getByText('Sin señal')).toBeTruthy();
    // un cierre con el visor ya en error no cambia nada
    await enAct(() => sockets[2].onclose());
    expect(screen.getByText('Sin señal')).toBeTruthy();
  });

  it('sin entrada de la central igual intenta, y un códec que no se puede abrir es «Sin señal»', async () => {
    mApi.intercomTicket.mockRejectedValueOnce(new Error('x'));
    FakeMS.romper = true;
    await intercom();
    await elegir('Casa Pérez');
    await abrirFuente();
    expect(sockets[0].url).toBe('ws://g2.test/api/ws?src=frente');
    await msj(sockets[0], JSON.stringify({ type: 'mse', value: 'raro' }));
    await avanzar(0);
    expect(screen.getByText('Sin señal')).toBeTruthy();
  });

  it('si el navegador no deja abrir el WebSocket queda en «Sin señal»', async () => {
    FakeWS.romper = true;
    mApi.intercomTicket.mockResolvedValueOnce({});
    await intercom();
    await elegir('Casa Pérez');
    await abrirFuente();
    expect(screen.getByText('Sin señal')).toBeTruthy();
  });

  it('una cámara sin go2rtc o sin MediaSource no intenta conectar', async () => {
    await intercom({ streams: [{ id: 'd9', label: '', type: 'intercom' }] });
    await elegir('Casa Pérez');
    expect(screen.getByText('Sin señal')).toBeTruthy();
    expect(screen.getByText('sin go2rtc_url · ?')).toBeTruthy();
    expect(screen.getByText('Dispositivo')).toBeTruthy();
    expect(fuentes.length).toBe(0);
  });

  it('al salir de la pantalla se corta la conexión aunque la entrada llegue tarde', async () => {
    let soltar;
    mApi.intercomTicket.mockImplementationOnce(() => new Promise((r) => { soltar = r; }));
    const { unmount } = await intercom();
    await elegir('Casa Pérez');
    await enAct(() => fuentes[0].oyentes.sourceopen());
    fuentes[0].readyState = 'closed';
    unmount();
    soltar({ ticket: 'tarde' });
    await avanzar(0);
    expect(sockets.length).toBe(0);
  });
});

describe('visor por el puente de Electron', () => {
  function puente(extra = {}) {
    return {
      go2rtcOpen: vi.fn(() => Promise.resolve({ id: 'k1' })), go2rtcSend: vi.fn(), go2rtcClose: vi.fn(),
      ...extra,
    };
  }

  it('abre por main con el origen y el token, y traduce los mensajes', async () => {
    const { sphone } = await intercom({ sphone: puente() });
    await elegir('Casa Pérez');
    await abrirFuente();
    expect(sphone.go2rtcOpen).toHaveBeenCalledWith({ url: 'ws://g2.test/api/ws?src=frente&t=tk1', origin: 'http://g2.test', token: 'tok' });
    const enviar = (m) => sphone.emitir('go2rtc', m);
    await enviar(null);
    await enviar({ id: 'otro', ev: 'open' });
    expect(sphone.go2rtcSend).not.toHaveBeenCalled();
    await enviar({ id: 'k1', ev: 'open' });
    expect(sphone.go2rtcSend).toHaveBeenCalledWith('k1', expect.stringContaining('"type":"mse"'));
    await enviar({ id: 'k1', ev: 'text', data: JSON.stringify({ type: 'mse', value: 'v' }) });
    expect(screen.getByText('EN VIVO')).toBeTruthy();
    await enviar({ id: 'k1', ev: 'bin', b64: btoa(String.fromCharCode(0, 1, 2)) });
    expect(fuentes[0].sbs[0].appendBuffer).toHaveBeenCalledWith(new Uint8Array([0, 1, 2]));
    await enviar({ id: 'k1', ev: 'raro' });
    await enviar({ id: 'k1', ev: 'close' });
    expect(screen.getByText('Sin señal')).toBeTruthy();
    fireEvent.click(screen.getByText(/Reintentar/));
    await avanzar(0);
    expect(sphone.go2rtcClose).toHaveBeenCalledWith('k1');
    expect(sphone.handlers.go2rtc).toBeUndefined();
  });

  it('si main no puede abrir, «Sin señal» y queda registrado en la consola', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await intercom({ sphone: puente({ go2rtcOpen: vi.fn().mockResolvedValueOnce({ error: 'ECONNREFUSED' }).mockResolvedValueOnce(null) }) });
    await elegir('Casa Pérez');
    await abrirFuente();
    expect(screen.getByText('Sin señal')).toBeTruthy();
    expect(warn).toHaveBeenCalledWith('[go2rtc]', 'ECONNREFUSED');
    fireEvent.click(screen.getByText(/Reintentar/));
    await abrirFuente(1);
    expect(warn).toHaveBeenLastCalledWith('[go2rtc]', null);
  });

  it('una base inválida abre igual, sin origen; si se sale antes de la respuesta no se suscribe', async () => {
    let soltar;
    const { sphone, unmount } = await intercom({
      streams: [{ ...CAM, base: 'nada' }],
      sphone: puente({ go2rtcOpen: vi.fn(() => new Promise((r) => { soltar = r; })) }),
    });
    await elegir('Casa Pérez');
    await abrirFuente();
    expect(sphone.go2rtcOpen).toHaveBeenCalledWith(expect.objectContaining({ origin: '' }));
    unmount();
    soltar({ id: 'k9' });
    await avanzar(0);
    expect(sphone.onGo2rtcMsg).not.toHaveBeenCalled();
  });

  it('un error de main después de cortar no cambia nada', async () => {
    const { sphone } = await intercom({ sphone: puente({ go2rtcClose: vi.fn(() => { throw new Error('x'); }) }) });
    await elegir('Casa Pérez');
    await abrirFuente();
    await sphone.emitir('go2rtc', { id: 'k1', ev: 'error' });
    expect(screen.getByText('Sin señal')).toBeTruthy();
    fireEvent.click(screen.getByText(/Reintentar/));
    await avanzar(0);
    expect(screen.getByText('CARGANDO')).toBeTruthy();
  });
});

describe('cámaras guardadas en este teléfono', () => {
  const LOCAL = { id: 'loc_a', name: 'Almacén', devices: [{ id: 'loc_d1', label: 'Puerta', type: 'intercom', rtsp: 'rtsp://u:p@10.0.0.9/1' }] };

  it('en la PWA dice que hace falta el softphone de escritorio y enmascara la clave', async () => {
    await montar({ cfg: CFG_OK, clientes: [LOCAL] });
    irA('Intercom');
    await elegir('Almacén');
    expect(screen.getAllByText('de este teléfono').length).toBeGreaterThan(0);
    expect(screen.getByText('Guardada en este teléfono')).toBeTruthy();
    expect(screen.getByText(/hace falta el softphone de escritorio/)).toBeTruthy();
    expect(screen.getByText('rtsp://···@10.0.0.9/1')).toBeTruthy();
    expect(screen.getByText('LOCAL')).toBeTruthy();
    expect(mApi.clientStreams).not.toHaveBeenCalled();
    // un cliente local no se sube: no hay botón
    expect(screen.queryByText('Subir a la central')).toBeNull();
  });

  it('en Electron levanta el go2rtc propio y lo mira sin pedir entrada a la central', async () => {
    const { sphone } = await montar({ cfg: CFG_OK, central: true, clientes: [LOCAL], sphone: { go2rtcOpen: vi.fn(() => Promise.resolve({ id: 'k' })), go2rtcSend: vi.fn(), go2rtcClose: vi.fn() } });
    irA('Intercom');
    await avanzar(0);
    await elegir('Almacén');
    expect(sphone.g2localAsegurar).toHaveBeenCalledWith([{ id: 'loc_d1', rtsp: 'rtsp://u:p@10.0.0.9/1' }]);
    await abrirFuente();
    expect(mApi.intercomTicket).not.toHaveBeenCalled();
    expect(sphone.go2rtcOpen).toHaveBeenCalledWith(expect.objectContaining({ url: 'ws://127.0.0.1:1984/api/ws?src=loc_d1' }));
  });

  it('si el go2rtc propio no arranca, se lee el motivo', async () => {
    await montar({ cfg: CFG_OK, clientes: [LOCAL], sphone: { g2localAsegurar: vi.fn().mockResolvedValueOnce({ ok: false, motivo: 'falta el binario de go2rtc' }) } });
    irA('Intercom');
    await elegir('Almacén');
    expect(screen.getByText('falta el binario de go2rtc')).toBeTruthy();
  });

  it.each([
    [() => Promise.resolve(null), 'no se pudo abrir el video'],
    [() => Promise.reject(new Error('spawn EACCES')), 'spawn EACCES'],
    [() => Promise.reject({}), 'no se pudo abrir el video'],
  ])('falla del go2rtc propio (%#) muestra «%s»', async (impl, txt) => {
    await montar({ cfg: CFG_OK, clientes: [LOCAL], sphone: { g2localAsegurar: vi.fn(impl) } });
    irA('Intercom');
    await elegir('Almacén');
    expect(screen.getByText(txt)).toBeTruthy();
  });

  it('una respuesta tardía del go2rtc propio después de salir se descarta', async () => {
    let soltar, fallar;
    const g = vi.fn().mockImplementationOnce(() => new Promise((r) => { soltar = r; })).mockImplementationOnce(() => new Promise((_, j) => { fallar = j; }));
    await montar({ cfg: CFG_OK, clientes: [LOCAL, { id: 'loc_b', name: 'Bodega', devices: [{ id: 'loc_d2', label: 'Patio', rtsp: 'rtsp://10.0.0.8/1' }] }], sphone: { g2localAsegurar: g } });
    irA('Intercom');
    await elegir('Almacén');
    await elegir('Bodega');
    soltar({ ok: true, base: 'http://x' });
    await avanzar(0);
    irA('Llamadas');
    fallar(new Error('tarde'));
    await avanzar(0);
    expect(g).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('tarde')).toBeNull();
  });
});

describe('portero: llamar y abrir', () => {
  const PORTERO = { ...CAM, id: 'p1', label: 'Portero', type: 'intercom', ext: '2010', reles: [{ i: 1, nombre: 'Portón' }, { i: 2, nombre: 'Peatonal' }] };

  it('«Llamar» marca al portero con video', async () => {
    await intercom({ streams: [PORTERO], central: true });
    await montarYElegir();
    fireEvent.click(screen.getByText(/Llamar · 2010/));
    expect(estado.web.placeCall).toHaveBeenCalledWith('2010', true);
  });

  it('abrir por la central confirma con el nombre del relé y el aviso se va solo', async () => {
    mApi.abrirRele.mockResolvedValueOnce({ nombre: 'Portón abierto' }).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('relé sin respuesta')).mockRejectedValueOnce({});
    await intercom({ streams: [PORTERO] });
    await montarYElegir();
    fireEvent.click(screen.getByText('🔓 Portón'));
    expect(screen.getByText('Abriendo…')).toBeTruthy();
    await avanzar(0);
    expect(mApi.abrirRele).toHaveBeenCalledWith('p1', 1);
    expect(screen.getByText('✓ Portón abierto')).toBeTruthy();
    await avanzar(4000);
    expect(screen.queryByText('✓ Portón abierto')).toBeNull();
    fireEvent.click(screen.getByText('🔓 Peatonal'));
    await avanzar(0);
    expect(screen.getByText('✓ Abierto')).toBeTruthy();
    fireEvent.click(screen.getByText('🔓 Peatonal'));
    await avanzar(0);
    expect(screen.getByText('relé sin respuesta')).toBeTruthy();
    fireEvent.click(screen.getByText('🔓 Peatonal'));
    await avanzar(0);
    expect(screen.getByText('no se pudo abrir')).toBeTruthy();
  });

  it('un relé por tono sin llamada está apagado y lo explica', async () => {
    await intercom({ streams: [{ ...PORTERO, ext: undefined, rele_modo: 'dtmf' }] });
    await montarYElegir();
    const b = screen.getByText('🔓 Portón');
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Este portero abre con tono: hay que estar en la llamada');
    expect(screen.queryByText(/Llamar ·/)).toBeNull();
  });

  it('con la llamada en curso manda el tono que dice la central, tecla por tecla', async () => {
    mApi.abrirRele.mockResolvedValue({ modo: 'dtmf', dtmf: '1#', nombre: 'Portón' });
    await intercom({ streams: [{ ...PORTERO, rele_modo: 'dtmf' }] });
    await montarYElegir();
    await ponerSp({ inCall: true, callInfo: { number: '2010', since: Date.now() } });
    estado.web.sendDtmf.mockImplementationOnce(() => { throw new Error('canal'); });
    fireEvent.click(screen.getByText('🔓 Portón'));
    await avanzar(0);
    expect(estado.web.sendDtmf).toHaveBeenCalledWith('1');
    await avanzar(120);
    expect(estado.web.sendDtmf).toHaveBeenLastCalledWith('#');
    await avanzar(120);
    expect(screen.getByText('✓ Portón')).toBeTruthy();
  });

  it('si la central pide tono y no hay llamada, avisa en vez de fallar callado', async () => {
    mApi.abrirRele.mockResolvedValue({ modo: 'dtmf', dtmf: '1' });
    await intercom({ streams: [PORTERO] });
    await montarYElegir();
    fireEvent.click(screen.getByText('🔓 Portón'));
    await avanzar(0);
    expect(screen.getByText('Para abrir con tono hay que estar en la llamada')).toBeTruthy();
    expect(estado.web.sendDtmf).not.toHaveBeenCalled();
  });
});

async function montarYElegir() { await elegir('Casa Pérez'); }

describe('preferencia «Mostrar Intercom»', () => {
  it('apagada saca la solapa del menú', async () => {
    await montar({ cfg: CFG_OK, prefs: { showIntercom: false } });
    expect(screen.queryByText('Intercom')).toBeNull();
  });
});
