/* Proceso main de Electron (electron/main.cjs), cargado con un `electron` falso. Fija lo
 * que el operador ve del lado del sistema operativo: una sola instancia, tel:/sip:/pbxng://
 * que marcan o aprovisionan, la ventana que se esconde a la bandeja en vez de cerrarse,
 * los atajos globales, el puente HTTP sin CORS hacia la central, el puente IPC al motor SIP
 * nativo, la config CIFRADA con safeStorage (nunca en claro en disco), el OTA contra la
 * central (con GitHub de respaldo), el widget de llamada que aparece solo al timbrar con la
 * ventana escondida, y la prueba de cámara antes de guardarla. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { cargarCjs } from './helpers/logica-cjs.js';
import { electronFalso } from './helpers/logica-electron.js';
const require = createRequire(import.meta.url);

let tmp, E, sipNat, g2local, onvif, updater, restaurar, wsCreados;

class WSFalso extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 1; this.send = vi.fn(); this.close = vi.fn(); wsCreados.push(this); }
}

function montar({ empaquetado = false, lock = true, cifrado = true, sinSip = false, sinG2 = false, sinOnvif = false, sinUpdater = false, sinWs = false, argv } = {}) {
  E = electronFalso({ empaquetado, lock, userData: tmp, cifrado });
  sipNat = { start: vi.fn(() => ({ ok: true })), stop: vi.fn(), call: vi.fn(), accept: vi.fn(), videoOut: vi.fn(), reqKeyframe: vi.fn(), reject: vi.fn(), hangup: vi.fn(), setMuted: vi.fn(), audioOut: vi.fn(), dtmf: vi.fn(), transfer: vi.fn(), hold: vi.fn(), setVideo: vi.fn() };
  g2local = { asegurar: vi.fn(async () => ({ ok: true, base: 'http://127.0.0.1:1984' })), estado: vi.fn(() => ({ disponible: true })), parar: vi.fn() };
  onvif = { descubrir: vi.fn(async (ms) => [{ ms }]), perfiles: vi.fn(async () => [{ rtsp: 'rtsp://x' }]) };
  updater = Object.assign(new EventEmitter(), { setFeedURL: vi.fn(), checkForUpdates: vi.fn(async () => {}), quitAndInstall: vi.fn() });
  wsCreados = [];
  if (argv) process.argv = argv;
  const mocks = {
    electron: E.electron,
    'electron-updater': sinUpdater ? new Error('x') : { autoUpdater: updater },
    ws: sinWs ? new Error('x') : WSFalso,
    './sip-udp.cjs': sinSip ? new Error('x') : sipNat,
    './go2rtc-local.cjs': sinG2 ? new Error('sin go2rtc') : (deps) => { g2local.deps = deps; return g2local; },
    './onvif.cjs': sinOnvif ? new Error('sin onvif') : onvif,
  };
  ({ restaurar } = cargarCjs('electron/main.cjs', mocks, { mantener: true }));
  return E;
}
async function listo() { E.app.arrancar(); await new Promise((r) => setTimeout(r, 0)); return E.ventanas[0]; }

const argvOrig = process.argv;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'main-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.SP_DEV_URL;
});
afterEach(() => {
  restaurar && restaurar();
  process.argv = argvOrig;
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('arranque y ventana', () => {
  it('una sola instancia: si ya hay otra, sale sin abrir nada', async () => {
    montar({ lock: false });
    expect(E.app.quit).toHaveBeenCalled();
    E.app.arrancar();
    await new Promise((r) => setTimeout(r, 0));
    expect(E.ventanas).toHaveLength(0);
  });

  it('crea la ventana aislada (preload, sin nodeIntegration), la bandeja y los atajos', async () => {
    montar({ argv: ['electron', '.'] });
    const w = await listo();
    expect(w.opts.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false });
    expect(w.opts.webPreferences.preload).toMatch(/preload\.cjs$/);
    expect(w.opts.show).toBe(false);
    expect(w.loadFile.mock.calls[0][0]).toMatch(/dist[\\/]index\.html$/);
    expect(E.app.setAsDefaultProtocolClient.mock.calls.map((c) => c[0])).toEqual(['tel', 'sip', 'callto', 'pbxng']);
    expect(E.bandejas[0].setToolTip).toHaveBeenCalledWith('PBX-NG Softphone v9.9.9');
    expect(Object.keys(E.atajos)).toEqual(['CommandOrControl+Shift+A', 'CommandOrControl+Shift+H', 'CommandOrControl+Shift+M']);
    expect(E.electron.app.commandLine.appendSwitch).toHaveBeenCalledWith('autoplay-policy', 'no-user-gesture-required');
    // aparece recién en ready-to-show; en desarrollo abre las herramientas
    expect(w.visible).toBe(false);
    w.emit('ready-to-show');
    expect(w.visible).toBe(true);
    expect(w.webContents.openDevTools).toHaveBeenCalled();
  });

  it('con SP_DEV_URL en desarrollo carga el servidor de Vite', async () => {
    process.env.SP_DEV_URL = 'http://localhost:5173';
    montar();
    const w = await listo();
    expect(w.loadURL).toHaveBeenCalledWith('http://localhost:5173');
  });

  it('permisos: micrófono/cámara/notificaciones sí, el resto no', async () => {
    montar();
    const w = await listo();
    const ses = w.webContents.session;
    const pedir = ses.setPermissionRequestHandler.mock.calls[0][0];
    const cb = vi.fn();
    pedir(null, 'microphone', cb); pedir(null, 'geolocation', cb);
    expect(cb.mock.calls).toEqual([[true], [false]]);
    const chequear = ses.setPermissionCheckHandler.mock.calls[0][0];
    expect(chequear(null, 'camera')).toBe(true);
    expect(chequear(null, 'midi')).toBe(false);
    expect(ses.setDevicePermissionHandler.mock.calls[0][0]()).toBe(true);
  });

  it('cerrar la ventana la esconde a la bandeja; al salir de verdad, no', async () => {
    montar();
    const w = await listo();
    w.visible = true;
    const e = { preventDefault: vi.fn() };
    w.emit('close', e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(w.visible).toBe(false);
    E.app.emit('before-quit');
    const e2 = { preventDefault: vi.fn() };
    w.emit('close', e2);
    expect(e2.preventDefault).not.toHaveBeenCalled();
    expect(sipNat.stop).toHaveBeenCalled();
    expect(g2local.parar).toHaveBeenCalled();
    E.app.emit('will-quit');
    expect(E.electron.globalShortcut.unregisterAll).toHaveBeenCalled();
    E.app.emit('window-all-closed');   // queda en bandeja: no sale
    expect(E.app.quit).not.toHaveBeenCalled();
  });

  it('arrancado con --hidden (inicio con Windows) no se muestra; did-finish-load también revela', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    montar({ empaquetado: true, argv: ['softphone.exe', '--hidden'] });
    E.app.arrancar(); await Promise.resolve(); await Promise.resolve();
    const w = E.ventanas[0];
    w.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(300);
    expect(w.visible).toBe(false);
    expect(w.webContents.openDevTools).not.toHaveBeenCalled();
  });

  it('certificados internos se aceptan (go2rtc/API con self-signed)', () => {
    montar();
    const e = { preventDefault: vi.fn() }, cb = vi.fn();
    E.app.emit('certificate-error', e, null, 'https://x', 'ERR', {}, cb);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(true);
  });
});

describe('tel:, sip: y pbxng://', () => {
  it('un tel: que llega antes de la ventana se marca al aparecer; pbxng:// aprovisiona', async () => {
    montar();
    const e = { preventDefault: vi.fn() };
    E.app.emit('open-url', e, 'tel:+598 (99) 123-456');
    E.app.emit('open-url', e, 'pbxng://prov#abc');
    const w = await listo();
    w.emit('ready-to-show');
    expect(w.webContents.send).toHaveBeenCalledWith('dial', '+59899123-456');
    expect(w.webContents.send).toHaveBeenCalledWith('provision', 'pbxng://prov#abc');
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('segunda instancia con sip:/callto: marca y trae la ventana (aunque esté minimizada)', async () => {
    montar();
    const w = await listo();
    w.minimizado = true;
    E.app.emit('second-instance', {}, ['x', 'sip:200@pbx.test']);
    expect(w.webContents.send).toHaveBeenCalledWith('dial', '200@pbx.test');
    expect(w.visible).toBe(true);
    expect(w.isMinimized()).toBe(false);
    E.app.emit('second-instance', {}, ['x', 'pbxng://prov#zz']);
    expect(w.webContents.send).toHaveBeenCalledWith('provision', 'pbxng://prov#zz');
    w.webContents.send.mockClear();
    E.app.emit('second-instance', {}, ['x', 'callto:']);   // vacío: no marca
    E.app.emit('second-instance', {}, ['x', 'otra-cosa']);
    E.app.emit('second-instance', {}, null);
    expect(w.webContents.send).not.toHaveBeenCalled();
  });

  it('los argumentos del arranque también marcan', async () => {
    montar({ argv: ['softphone.exe', 'tel:101'] });
    const w = await listo();
    expect(w.webContents.send).toHaveBeenCalledWith('dial', '101');
  });
});

describe('bandeja, atajos y sistema', () => {
  it('menú de la bandeja: abrir, iniciar con Windows, herramientas y salir', async () => {
    montar();
    const w = await listo();
    const menu = E.bandejas[0].setContextMenu.mock.calls[0][0];
    menu.find((i) => i.label === 'Abrir').click();
    expect(w.visible).toBe(true);
    menu.find((i) => i.label === 'Iniciar con Windows').click({ checked: true });
    expect(E.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, args: ['--hidden'] });
    expect(E.bandejas[0].setContextMenu).toHaveBeenCalledTimes(2);
    menu.find((i) => i.label === 'Herramientas de desarrollo').click();
    expect(w.webContents.openDevTools).toHaveBeenCalled();
    expect(menu.find((i) => /v9\.9\.9/.test(i.label || '')).enabled).toBe(false);
    menu.find((i) => i.label === 'Salir').click();
    expect(E.app.quit).toHaveBeenCalled();
    w.visible = false;
    E.bandejas[0].emit('click');
    expect(w.visible).toBe(true);
  });

  it('atajos globales: atender trae la ventana; colgar y mute avisan al renderer', async () => {
    montar();
    const w = await listo();
    E.atajos['CommandOrControl+Shift+A']();
    E.atajos['CommandOrControl+Shift+H']();
    E.atajos['CommandOrControl+Shift+M']();
    expect(w.webContents.send.mock.calls.filter((c) => c[0] === 'hotkey').map((c) => c[1])).toEqual(['answer', 'hangup', 'mute']);
    expect(w.visible).toBe(true);
  });

  it('al despertar la PC o desbloquear avisa para re-registrar', async () => {
    montar();
    const w = await listo();
    E.electron.powerMonitor.emit('resume');
    E.electron.powerMonitor.emit('suspend');
    E.electron.powerMonitor.emit('unlock-screen');
    expect(w.webContents.send.mock.calls.filter((c) => c[0] === 'sys-event').map((c) => c[1])).toEqual(['resume', 'suspend', 'resume']);
  });
});

describe('puente HTTP hacia la central (sin CORS)', () => {
  let srv, base, ultimo;
  beforeEach(async () => {
    srv = http.createServer((rq, rs) => {
      let b = ''; rq.on('data', (d) => { b += d; }); rq.on('end', () => {
        ultimo = { method: rq.method, url: rq.url, headers: rq.headers, body: b };
        if (rq.url.startsWith('/json')) { rs.writeHead(201, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ ok: 1 })); }
        if (rq.url === '/texto') { rs.writeHead(502); return rs.end('Bad gateway <html>'); }
        if (rq.url === '/audio') { rs.writeHead(200, { 'content-type': 'audio/wav' }); return rs.end(Buffer.from([1, 2, 3])); }
        if (rq.url === '/bin') { rs.writeHead(200); return rs.end(Buffer.from([9])); }
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + srv.address().port;
    montar();
  });
  afterEach(() => srv.close());

  it('manda método, cuerpo JSON y Bearer; devuelve status y json', async () => {
    const r = await E.invocar('sp-api', { method: 'POST', url: base + '/json?x=1', body: { a: 1 }, token: 'T' });
    expect(r).toEqual({ status: 201, json: { ok: 1 }, text: undefined });
    expect(ultimo.method).toBe('POST');
    expect(ultimo.url).toBe('/json?x=1');
    expect(ultimo.headers.authorization).toBe('Bearer T');
    expect(JSON.parse(ultimo.body)).toEqual({ a: 1 });
    expect(ultimo.headers['content-length']).toBe('7');
  });

  it('una respuesta que no es JSON devuelve el texto recortado; cuerpo string va tal cual', async () => {
    const r = await E.invocar('sp-api', { method: 'PUT', url: base + '/texto', body: 'crudo', headers: { 'X-A': 'b' } });
    expect(r).toEqual({ status: 502, json: null, text: 'Bad gateway <html>' });
    expect(ultimo.body).toBe('crudo');
    expect(ultimo.headers['x-a']).toBe('b');
    await E.invocar('sp-api', { url: base + '/texto' });
    expect(ultimo.method).toBe('GET');
    expect(ultimo.headers.authorization).toBeUndefined();
  });

  it('binario en base64 con su tipo (grabaciones, buzón)', async () => {
    expect(await E.invocar('sp-api-blob', { url: base + '/audio' })).toEqual({ status: 200, b64: Buffer.from([1, 2, 3]).toString('base64'), type: 'audio/wav' });
    expect((await E.invocar('sp-api-blob', { url: base + '/bin' })).type).toBe('application/octet-stream');
  });

  it('errores: URL inválida, conexión rechazada y timeout', async () => {
    expect((await E.invocar('sp-api', { url: 'no-url' })).error).toBeTruthy();
    expect((await E.invocar('sp-api', { url: 'http://127.0.0.1:1/x' })).error).toMatch(/ECONNREFUSED/);
    const colgado = http.createServer(() => {});
    await new Promise((r) => colgado.listen(0, '127.0.0.1', r));
    const orig = http.request;
    vi.spyOn(http, 'request').mockImplementation((o, cb) => orig.call(http, { ...o, timeout: 30 }, cb));
    expect(await E.invocar('sp-api', { url: 'http://127.0.0.1:' + colgado.address().port + '/' })).toEqual({ error: 'timeout' });
    colgado.closeAllConnections(); colgado.close();
  });

  it('https usa el módulo https (con certificados internos)', async () => {
    const https = require('https');
    const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
    const spy = vi.spyOn(https, 'request').mockImplementation(() => { setTimeout(() => req.emit('error', new Error('cert')), 0); return req; });
    expect(await E.invocar('sp-api', { url: 'https://pbx.test/backend/api/x' })).toEqual({ error: 'cert' });
    expect(spy.mock.calls[0][0]).toMatchObject({ hostname: 'pbx.test', port: 443, rejectUnauthorized: false });
  });
});

describe('puente al motor SIP nativo', () => {
  it('cada canal llega al motor, y los eventos vuelven al canal correcto', async () => {
    montar();
    const w = await listo();
    expect(await E.invocar('sipnat-connect', { ext: '1' })).toEqual({ ok: true });
    const onEvt = sipNat.start.mock.calls[0][1];
    onEvt({ type: 'audio', pcm: 'AAA' });
    onEvt({ type: 'video-in', nal: 'NNN' });
    onEvt({ type: 'reg', state: 'registered' });
    expect(w.webContents.send).toHaveBeenCalledWith('sipnat-audio', 'AAA');
    expect(w.webContents.send).toHaveBeenCalledWith('sipnat-video', 'NNN');
    expect(w.webContents.send).toHaveBeenCalledWith('sipnat-event', { type: 'reg', state: 'registered' });
    await E.invocar('sipnat-call', '102', true);
    await E.invocar('sipnat-accept', false);
    await E.invocar('sipnat-reject');
    await E.invocar('sipnat-hangup');
    await E.invocar('sipnat-mute', true);
    await E.invocar('sipnat-dtmf', '5');
    await E.invocar('sipnat-transfer', '300');
    await E.invocar('sipnat-hold', 1);
    await E.invocar('sipnat-setvideo', 0);
    await E.invocar('sipnat-video-keyframe');
    await E.invocar('sipnat-disconnect');
    E.emitir('sipnat-video-out', 'B64', 90);
    E.emitir('sipnat-audio-out', Buffer.from(new Int16Array([1, -2, 3]).buffer).toString('base64'));
    expect(sipNat.call).toHaveBeenCalledWith('102', true);
    expect(sipNat.accept).toHaveBeenCalledWith(false);
    expect(sipNat.hold).toHaveBeenCalledWith(true);
    expect(sipNat.setVideo).toHaveBeenCalledWith(false);
    expect(sipNat.videoOut).toHaveBeenCalledWith('B64', 90);
    expect([...sipNat.audioOut.mock.calls[0][0]]).toEqual([1, -2, 3]);
    for (const f of ['reject', 'hangup', 'reqKeyframe', 'stop']) expect(sipNat[f]).toHaveBeenCalled();
    expect(sipNat.setMuted).toHaveBeenCalledWith(true);
    expect(sipNat.dtmf).toHaveBeenCalledWith('5');
    expect(sipNat.transfer).toHaveBeenCalledWith('300');
  });

  it('si el motor tira, el IPC contesta igual; sin ventana los eventos se descartan', async () => {
    montar();
    for (const k of Object.keys(sipNat)) sipNat[k].mockImplementation(() => { throw new Error('x'); });
    for (const c of ['sipnat-disconnect', 'sipnat-call', 'sipnat-accept', 'sipnat-video-keyframe', 'sipnat-reject', 'sipnat-hangup', 'sipnat-mute', 'sipnat-dtmf', 'sipnat-transfer', 'sipnat-hold', 'sipnat-setvideo']) {
      expect(await E.invocar(c)).toEqual({ ok: true });
    }
    expect(() => { E.emitir('sipnat-video-out', 'x', 1); E.emitir('sipnat-audio-out', 'AAAA'); }).not.toThrow();
    sipNat.start.mockImplementation((cfg, cb) => { cb({ type: 'reg' }); return { ok: true }; });
    expect(await E.invocar('sipnat-connect', {})).toEqual({ ok: true });
  });

  it('sin el motor empaquetado, conectar lo dice y el resto no rompe', async () => {
    montar({ sinSip: true });
    expect(await E.invocar('sipnat-connect', {})).toEqual({ error: 'motor SIP no disponible' });
    expect(await E.invocar('sipnat-call', '1')).toEqual({ ok: true });
    expect(() => E.emitir('sipnat-audio-out', 'AAAA')).not.toThrow();
  });
});

describe('video: proxy go2rtc, go2rtc local, ONVIF y prueba de cámara', () => {
  it('proxy WebSocket: abre con Origin y token, reenvía mensajes, manda y cierra', async () => {
    montar();
    const w = await listo();
    const r = await E.invocar('go2rtc-open', { url: 'wss://pbx/api/ws?src=c1', origin: 'https://pbx', token: 'T' });
    const ws = wsCreados[0];
    expect(ws.opts.headers).toEqual({ Origin: 'https://pbx', Authorization: 'Bearer T' });
    ws.emit('open');
    ws.emit('message', Buffer.from([1, 2]), true);
    ws.emit('message', Buffer.from('{"type":"mse"}'), false);
    ws.emit('error', new Error('reset'));
    const msgs = w.webContents.send.mock.calls.filter((c) => c[0] === 'go2rtc-msg').map((c) => c[1]);
    expect(msgs).toEqual([{ id: r.id, ev: 'open' }, { id: r.id, ev: 'bin', b64: 'AQI=' }, { id: r.id, ev: 'text', data: '{"type":"mse"}' }, { id: r.id, ev: 'error', msg: 'reset' }]);
    E.emitir('go2rtc-send', { id: r.id, data: 'hola' });
    expect(ws.send).toHaveBeenCalledWith('hola');
    ws.readyState = 0;
    E.emitir('go2rtc-send', { id: r.id, data: 'no' });
    E.emitir('go2rtc-send', null);
    expect(ws.send).toHaveBeenCalledTimes(1);
    E.emitir('go2rtc-close', r.id);
    expect(ws.close).toHaveBeenCalled();
    ws.emit('close');
    expect(w.webContents.send).toHaveBeenLastCalledWith('go2rtc-msg', { id: r.id, ev: 'close' });
    E.emitir('go2rtc-close', 999);
    const r2 = await E.invocar('go2rtc-open', { url: 'ws://x' });
    expect(wsCreados[1].opts.headers).toEqual({});
    expect(r2.id).toBe(r.id + 1);
    expect(await E.invocar('go2rtc-open', null)).toHaveProperty('error');
  });

  it('sin ws empaquetado, el proxy y la prueba de cámara lo dicen', async () => {
    montar({ sinWs: true });
    expect(await E.invocar('go2rtc-open', { url: 'ws://x' })).toEqual({ error: 'ws no disponible' });
    expect(await E.invocar('camara-probar', 'rtsp://x')).toEqual({ ok: false, motivo: 'ws no disponible' });
  });

  it('go2rtc local y ONVIF pasan por el main (descubrir entre 2 y 8 s)', async () => {
    montar();
    expect(await E.invocar('g2local-asegurar', [{ id: 'a' }])).toEqual({ ok: true, base: 'http://127.0.0.1:1984' });
    g2local.asegurar.mockRejectedValueOnce(new Error('boom'));
    expect(await E.invocar('g2local-asegurar', [])).toEqual({ ok: false, motivo: 'boom' });
    g2local.asegurar.mockRejectedValueOnce({});
    expect(await E.invocar('g2local-asegurar', [])).toEqual({ ok: false, motivo: 'error' });
    expect(await E.invocar('g2local-estado')).toEqual({ disponible: true });
    expect(await E.invocar('g2local-parar')).toEqual({ ok: true });
    g2local.parar.mockImplementation(() => { throw new Error('x'); });
    expect(await E.invocar('g2local-parar')).toEqual({ ok: true });
    expect(await E.invocar('onvif-descubrir', 100)).toEqual({ ok: true, equipos: [{ ms: 2000 }] });
    expect(await E.invocar('onvif-descubrir', 99999)).toEqual({ ok: true, equipos: [{ ms: 8000 }] });
    expect(await E.invocar('onvif-descubrir', 'x')).toEqual({ ok: true, equipos: [{ ms: 4000 }] });
    onvif.descubrir.mockRejectedValueOnce(new Error('red'));
    expect(await E.invocar('onvif-descubrir')).toEqual({ ok: false, motivo: 'red' });
    expect(await E.invocar('onvif-perfiles', { xaddr: 'x' })).toEqual({ ok: true, perfiles: [{ rtsp: 'rtsp://x' }] });
    await E.invocar('onvif-perfiles');
    expect(onvif.perfiles).toHaveBeenLastCalledWith({});
    onvif.perfiles.mockRejectedValueOnce({});
    expect(await E.invocar('onvif-perfiles', {})).toEqual({ ok: false, motivo: 'error' });
    // el logger del go2rtc local sólo escribe en desarrollo
    g2local.deps.log({ a: 1 }, 'hola');
    expect(console.log).toHaveBeenCalledWith('[g2local]', 'hola', '{"a":1}');
  });

  it('sin go2rtc ni ONVIF empaquetados lo dicen', async () => {
    montar({ sinG2: true, sinOnvif: true });
    expect((await E.invocar('g2local-asegurar', [])).motivo).toMatch(/no disponible/);
    expect(await E.invocar('g2local-estado')).toEqual({ disponible: false, corriendo: false, base: null });
    expect(await E.invocar('g2local-parar')).toEqual({ ok: true });
    expect((await E.invocar('onvif-descubrir')).motivo).toMatch(/no disponible/);
    expect((await E.invocar('onvif-perfiles')).motivo).toMatch(/no disponible/);
    expect((await E.invocar('camara-probar', 'rtsp://x')).motivo).toMatch(/no disponible/);
  });

  describe('probar una cámara antes de guardarla', () => {
    beforeEach(() => montar());
    const probar = async (accion) => {
      const p = E.invocar('camara-probar', 'rtsp://u:p@cam/1');
      await new Promise((r) => setTimeout(r, 0));
      const ws = wsCreados[wsCreados.length - 1];
      accion(ws);
      return p;
    };

    it('ok con más de 20 KB de video, dice el códec y no deja el stream de prueba', async () => {
      const r = await probar((ws) => {
        ws.emit('open');
        expect(JSON.parse(ws.send.mock.calls[0][0]).type).toBe('mse');
        ws.emit('message', Buffer.from('{"type":"mse","value":"avc1.640029"}'), false);
        ws.emit('message', Buffer.from('no json'), false);
        ws.emit('message', Buffer.alloc(15000), true);
        ws.emit('message', { byteLength: 6000 }, true);
      });
      expect(r).toEqual({ ok: true, codec: 'avc1.640029', bytes: 21000 });
      expect(wsCreados[0].url).toMatch(/^ws:\/\/127\.0\.0\.1:1984\/api\/ws\?src=prueba_/);
      expect(g2local.asegurar.mock.calls[0][0][0].rtsp).toBe('rtsp://u:p@cam/1');
      /* El go2rtc no queda vivo con la URL de prueba (que lleva la clave de la cámara). */
      expect(g2local.parar).toHaveBeenCalled();
      expect(g2local.asegurar).toHaveBeenCalledTimes(1);
    });

    it('la cámara rechaza, corta o da error de conexión', async () => {
      expect(await probar((ws) => ws.emit('message', Buffer.from('{"type":"error","value":"401 Unauthorized"}'), false))).toEqual({ ok: false, motivo: '401 Unauthorized' });
      expect(await probar((ws) => ws.emit('message', Buffer.from('{"type":"error"}'), false))).toEqual({ ok: false, motivo: 'la cámara rechazó la conexión' });
      expect(await probar((ws) => ws.emit('close'))).toEqual({ ok: false, motivo: 'la cámara cortó la conexión' });
      expect(await probar((ws) => ws.emit('error', new Error('ECONNREFUSED')))).toEqual({ ok: false, motivo: 'ECONNREFUSED' });
      expect(await probar((ws) => ws.emit('error', null))).toEqual({ ok: false, motivo: 'error de conexión' });
    });

    it('sin video en 12 s avisa qué revisar', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const p = E.invocar('camara-probar', 'rtsp://x');
      await vi.advanceTimersByTimeAsync(12000);
      expect(await p).toEqual({ ok: false, motivo: 'la cámara no entregó video en 12 s (¿clave, canal o códec?)' });
    });

    it('si go2rtc no levanta, o el WebSocket no se puede crear, lo dice', async () => {
      g2local.asegurar.mockResolvedValueOnce({ ok: false, motivo: 'sin binario' });
      expect(await E.invocar('camara-probar', 'rtsp://x')).toEqual({ ok: false, motivo: 'sin binario' });
      g2local.asegurar.mockRejectedValueOnce(new Error('explotó'));
      expect(await E.invocar('camara-probar')).toEqual({ ok: false, motivo: 'explotó' });
      g2local.asegurar.mockRejectedValueOnce({});
      expect(await E.invocar('camara-probar')).toEqual({ ok: false, motivo: 'error' });
    });
  });
});

describe('actualizaciones (OTA contra la central)', () => {
  it('al arrancar usa el feed guardado; los eventos del updater llegan a la pantalla', async () => {
    fs.writeFileSync(path.join(tmp, 'sp-update-feed.json'), JSON.stringify({ url: 'https://pbx/descargas/softphone/' }));
    montar();
    const w = await listo();
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'https://pbx/descargas/softphone/', useMultipleRangeRequest: false });
    expect(updater.autoDownload).toBe(true);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();   // en desarrollo no chequea solo
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.2.3' });
    updater.emit('update-not-available');
    updater.emit('error', new Error('404'));
    updater.emit('download-progress', { percent: 41.6 });
    updater.emit('download-progress', null);
    updater.emit('update-downloaded', { version: '1.2.3' });
    const st = w.webContents.send.mock.calls.filter((c) => c[0] === 'update-status').map((c) => c[1]);
    expect(st).toEqual([{ state: 'checking' }, { state: 'available', version: '1.2.3' }, { state: 'none' }, { state: 'error', msg: '404' }, { state: 'downloading', percent: 42 }, { state: 'downloading', percent: 0 }, { state: 'downloaded', version: '1.2.3' }]);
  });

  it('sin feed guardado cae a GitHub; set-feed lo guarda y en producción chequea', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    montar({ empaquetado: true });
    await listo();
    expect(updater.setFeedURL.mock.calls[0][0].url).toBe('https://github.com/flavioGonz/pbx-ng/releases/latest/download/');
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6 * 3600 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    const r = await E.invocar('update-set-feed', ' https://central/descargas/softphone/ ');
    expect(r).toEqual({ ok: true, url: 'https://central/descargas/softphone/' });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'sp-update-feed.json'), 'utf8')).url).toBe('https://central/descargas/softphone/');
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(await E.invocar('update-set-feed', '')).toEqual({ ok: true, url: 'https://github.com/flavioGonz/pbx-ng/releases/latest/download/' });
    updater.setFeedURL.mockImplementation(() => { throw new Error('feed'); });
    expect((await E.invocar('update-set-feed', 'x')).ok).toBe(false);
  });

  it('chequear e instalar a pedido; errores al renderer', async () => {
    montar();
    const w = await listo();
    expect(await E.invocar('update-check')).toEqual({ ok: true });
    updater.checkForUpdates.mockRejectedValueOnce(new Error('sin red'));
    await E.invocar('update-check');
    expect(w.webContents.send).toHaveBeenCalledWith('update-status', { state: 'error', msg: 'sin red' });
    updater.checkForUpdates.mockRejectedValueOnce({});
    await E.invocar('update-check');
    expect(w.webContents.send).toHaveBeenLastCalledWith('update-status', { state: 'error', msg: 'error' });
    expect(await E.invocar('update-install')).toEqual({ ok: true });
    expect(updater.quitAndInstall).toHaveBeenCalled();
  });

  it('sin electron-updater: chequear avisa, el feed no se aplica', async () => {
    montar({ sinUpdater: true });
    const w = await listo();
    expect(await E.invocar('update-check')).toEqual({ ok: false });
    expect(w.webContents.send).toHaveBeenCalledWith('update-status', { state: 'error', msg: 'updater no disponible' });
    expect((await E.invocar('update-set-feed', 'x')).ok).toBe(false);
    expect(await E.invocar('update-install')).toEqual({ ok: true });
  });
});

describe('config cifrada (safeStorage / DPAPI)', () => {
  it('guarda cifrado en userData y lo devuelve descifrado', async () => {
    montar();
    expect(await E.invocar('secure-available')).toBe(true);
    expect(await E.invocar('secure-load')).toBeNull();     // todavía no hay archivo
    expect(await E.invocar('secure-save', '{"pass":"secreta"}')).toEqual({ ok: true });
    const enDisco = fs.readFileSync(path.join(tmp, 'sp-secure.bin'), 'utf8');
    expect(enDisco).toBe('ENC:{"pass":"secreta"}');
    expect(await E.invocar('secure-load')).toBe('{"pass":"secreta"}');
    await E.invocar('secure-save');
    expect(await E.invocar('secure-load')).toBe('');
  });

  it('sin cifrado disponible NO guarda en claro', async () => {
    montar({ cifrado: false });
    expect(await E.invocar('secure-save', 'x')).toEqual({ ok: false });
    expect(fs.existsSync(path.join(tmp, 'sp-secure.bin'))).toBe(false);
    expect(await E.invocar('secure-load')).toBeNull();
    E.electron.safeStorage.isEncryptionAvailable.mockImplementation(() => { throw new Error('x'); });
    expect(await E.invocar('secure-available')).toBe(false);
    expect(await E.invocar('secure-load')).toBeNull();
    expect(await E.invocar('secure-save', 'x')).toEqual({ error: 'x' });
  });
});

describe('controles de ventana y temblor', () => {
  it('minimizar, cerrar y cambiar tamaño centrado', async () => {
    montar();
    const w = await listo();
    E.emitir('win-minimize'); E.emitir('win-close');
    E.emitir('win-size', { w: 400.4, h: 700.6 });
    E.emitir('win-size', { w: 0 });
    expect(w.minimize).toHaveBeenCalled();
    expect(w.close).toHaveBeenCalled();
    expect(w.setSize).toHaveBeenCalledWith(400, 701);
    expect(w.setSize).toHaveBeenCalledTimes(1);
    expect(w.center).toHaveBeenCalled();
  });

  it('el temblor de llamada entrante vibra y vuelve a su lugar; se corta solo al minuto', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval'] });
    montar();
    E.emitir('win-shake', true);   // sin ventana: nada
    E.app.arrancar(); await Promise.resolve(); await Promise.resolve();
    const w = E.ventanas[0];
    E.emitir('win-shake', true);
    E.emitir('win-shake', true);   // ya está temblando
    vi.advanceTimersByTime(55);
    expect(w.pos).not.toEqual([100, 200]);
    E.emitir('win-shake', false);
    expect(w.pos).toEqual([100, 200]);
    E.emitir('win-shake', true);
    vi.advanceTimersByTime(60000);
    expect(w.pos).toEqual([100, 200]);
    const p = [...w.pos];
    vi.advanceTimersByTime(500);
    expect(w.pos).toEqual(p);
    E.emitir('win-shake', false);
  });
});

describe('widget de llamada (mini)', () => {
  it('mostrarlo a pedido esconde la ventana grande y la vuelve a mostrar al cerrarlo', async () => {
    montar();
    const w = await listo();
    w.visible = true;
    E.emitir('mini-state', { active: true, number: '200' });
    await E.invocar('mini-show', true);
    const mini = E.ventanas[1];
    expect(mini.opts).toMatchObject({ x: 1600, y: 872, alwaysOnTop: true, frame: false });
    expect(mini.loadFile.mock.calls[0][0]).toMatch(/mini\.html$/);
    expect(mini.visible).toBe(true);
    expect(mini.webContents.send).toHaveBeenCalledWith('mini-state', { active: true, number: '200' });
    expect(w.visible).toBe(false);
    E.emitir('mini-ready');
    expect(mini.webContents.send).toHaveBeenCalledTimes(2);   // el widget recién abierto pide el estado
    E.emitir('mini-data', { contactos: [] });
    expect(mini.webContents.send).toHaveBeenLastCalledWith('mini-data', { contactos: [] });
    await E.invocar('mini-show', false);
    expect(mini.visible).toBe(false);
    expect(w.visible).toBe(true);
    await E.invocar('mini-show', true);   // reusa el mismo widget
    expect(E.ventanas).toHaveLength(2);
    mini.emit('closed');
    await E.invocar('mini-show', true);
    expect(E.ventanas).toHaveLength(3);
  });

  it('timbrando con la ventana escondida, el widget aparece solo (sin robar foco) y se va al terminar', async () => {
    montar();
    const w = await listo();
    w.visible = false;
    E.emitir('mini-state', { active: true, incoming: true, number: '300' });
    const mini = E.ventanas[1];
    expect(mini.visible).toBe(true);
    expect(mini.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    E.emitir('mini-state', { active: true, incoming: true });   // ya visible: no lo recrea
    E.emitir('mini-state', { active: false });
    expect(mini.visible).toBe(false);
    expect(w.visible).toBe(false);   // la grande no la escondimos nosotros: no se muestra
    // con la ventana a la vista no aparece
    w.visible = true;
    E.emitir('mini-state', { active: true, incoming: true });
    expect(mini.visible).toBe(false);
  });

  it('acciones: restaurar, atender con video (trae la ventana) y el resto al renderer', async () => {
    montar();
    const w = await listo();
    w.visible = false;
    await E.invocar('mini-show', true);
    const mini = E.ventanas[1];
    E.emitir('mini-action', 'mute');
    expect(w.webContents.send).toHaveBeenLastCalledWith('mini-action', { a: 'mute', v: undefined });
    E.emitir('mini-action', { a: 'dial', v: '101' });
    expect(w.webContents.send).toHaveBeenLastCalledWith('mini-action', { a: 'dial', v: '101' });
    E.emitir('mini-action', { a: 'accept-video' });
    expect(mini.visible).toBe(false);
    expect(w.visible).toBe(true);
    await E.invocar('mini-show', true);
    E.emitir('mini-action', 'restore');
    expect(mini.visible).toBe(false);
    expect(w.visible).toBe(true);
  });

  it('el widget crece hacia arriba y se acota entre 88 y 560 px', async () => {
    montar();
    await listo();
    E.emitir('mini-size', 300);    // sin widget: nada
    await E.invocar('mini-show', true);
    const mini = E.ventanas[1];
    E.emitir('mini-size', 300);
    expect(mini.bounds).toEqual({ x: 10, y: 328, width: 300, height: 300 });
    E.emitir('mini-size', 5000);
    expect(mini.bounds.height).toBe(560);
    E.emitir('mini-size', null);
    expect(mini.bounds.height).toBe(88);
    mini.destruida = true;
    E.emitir('mini-size', 300);
    expect(mini.bounds.height).toBe(88);
    E.app.emit('before-quit');
    expect(mini.destruida).toBe(true);
  });

  it('sin pantalla conocida el widget nace igual; showInactive que falla cae a show', async () => {
    montar();
    const w = await listo();
    delete E.electron.screen;
    const orig = E.electron.BrowserWindow.prototype.showInactive;
    E.electron.BrowserWindow.prototype.showInactive = function () { throw new Error('x'); };
    w.visible = false;
    E.emitir('mini-state', { active: true, incoming: true });
    const mini = E.ventanas[1];
    expect(mini.opts.x).toBeUndefined();
    expect(mini.visible).toBe(true);
    E.electron.BrowserWindow.prototype.showInactive = orig;
  });
});

/* Electron tira excepciones raras cuando una ventana se está destruyendo (cerrando la app,
 * reinicio de Windows): ningún canal IPC puede dejar escapar una, porque en el main un
 * error sin atrapar es el diálogo de "A JavaScript error occurred". */
describe('robustez del main', () => {
  it('antes de que exista la ventana, los canales que le escriben no rompen', async () => {
    montar();
    sipNat.start.mockImplementation((cfg, cb) => { cb({ type: 'audio', pcm: 'x' }); return { ok: true }; });
    await E.invocar('sipnat-connect', {});
    const r = await E.invocar('go2rtc-open', { url: 'ws://x' });
    wsCreados[0].emit('open');
    expect(r.id).toBeGreaterThan(0);
    await E.invocar('update-check');
    updater.checkForUpdates.mockRejectedValueOnce(new Error('x'));
    await E.invocar('update-check');
    for (const c of ['win-minimize', 'win-close', 'win-shake']) E.emitir(c, true);
    E.emitir('win-size', { w: 1, h: 1 });
    E.emitir('mini-action', 'mute');
    E.emitir('mini-action', 'restore');
    E.emitir('mini-ready');
    E.emitir('mini-data', {});
    await E.invocar('mini-show', false);
    E.app.emit('second-instance', {}, ['x']);
    E.atajos['x'] = null;
    expect(E.ventanas).toHaveLength(0);
  });

  it('con la ventana rota (todo tira), ningún canal deja escapar la excepción', async () => {
    montar();
    const w = await listo();
    const tira = () => { throw new Error('destruida'); };
    w.webContents.send = vi.fn(tira);
    for (const m of ['minimize', 'close', 'setSize', 'setPosition', 'isVisible']) w[m] = tira;
    w.webContents.openDevTools = tira;
    const onEvt = (await E.invocar('sipnat-connect', {}), sipNat.start.mock.calls[0][1]);
    expect(() => { onEvt({ type: 'audio' }); onEvt({ type: 'reg' }); }).not.toThrow();
    await E.invocar('go2rtc-open', { url: 'ws://x' });
    const ws = wsCreados[0];
    ws.send = tira; ws.close = tira;
    ws.emit('open');
    ws.emit('message', null, true);              // Buffer.from(null) tira: se traga
    E.emitir('go2rtc-send', { id: 1, data: 'x' });
    E.emitir('go2rtc-close', 1);
    updater.emit('checking-for-update');
    updater.checkForUpdates.mockRejectedValueOnce(new Error('x'));
    expect(await E.invocar('update-check')).toEqual({ ok: true });
    updater.quitAndInstall.mockImplementation(tira);
    expect(await E.invocar('update-install')).toEqual({ ok: true });
    E.emitir('win-minimize'); E.emitir('win-close'); E.emitir('win-size', { w: 1, h: 1 });
    E.emitir('win-shake', true); E.emitir('win-shake', false);
    E.electron.powerMonitor.emit('resume');
    const menu = E.bandejas[0].setContextMenu.mock.calls[0][0];
    menu.find((i) => i.label === 'Herramientas de desarrollo').click();
    // el widget también roto
    await E.invocar('mini-show', true);
    const mini = E.ventanas[1];
    for (const m of ['hide', 'show', 'showInactive', 'setAlwaysOnTop', 'getBounds', 'isVisible', 'isDestroyed', 'destroy']) mini[m] = tira;
    mini.webContents.send = tira;
    E.emitir('mini-state', { active: true, incoming: true });
    E.emitir('mini-state', { active: false });
    E.emitir('mini-ready'); E.emitir('mini-data', {}); E.emitir('mini-size', 200);
    E.emitir('mini-action', 'restore'); E.emitir('mini-action', { a: 'accept-video' });
    expect(await E.invocar('mini-show', true)).toEqual({ ok: true });
    expect(await E.invocar('mini-show', false)).toEqual({ ok: true });
    sipNat.stop.mockImplementation(tira); g2local.parar.mockImplementation(tira);
    expect(() => E.app.emit('before-quit')).not.toThrow();
  });

  it('temblor con el widget a la vista: vibra el widget, no la ventana', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval'] });
    montar();
    E.app.arrancar(); await Promise.resolve(); await Promise.resolve();
    const w = E.ventanas[0];
    await E.invocar('mini-show', true);
    const mini = E.ventanas[1];
    mini.pos = [5, 5];
    E.emitir('win-shake', true);
    vi.advanceTimersByTime(55);
    expect(mini.pos).not.toEqual([5, 5]);
    expect(w.pos).toEqual([100, 200]);
    mini.setPosition = () => { throw new Error('x'); };
    vi.advanceTimersByTime(110);
    vi.advanceTimersByTime(60000);   // el reloj de seguridad corta aunque setPosition tire
    E.emitir('win-shake', true);
    E.emitir('win-shake', false);
  });

  it('empaquetado sin SP_DEBUG: no abre herramientas ni escribe log del go2rtc local', async () => {
    montar({ empaquetado: true, argv: ['x'] });
    const w = await listo();
    w.emit('ready-to-show');
    expect(w.webContents.openDevTools).not.toHaveBeenCalled();
    g2local.deps.log({}, 'x');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('SP_DEBUG=1 en producción sí abre herramientas; sin go2rtc el log de carga lo dice', async () => {
    process.env.SP_DEBUG = '1';
    try {
      montar({ empaquetado: true, sinG2: true, sinOnvif: true, argv: ['x'] });
      const w = await listo();
      w.emit('ready-to-show');
      expect(w.webContents.openDevTools).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('[g2local] no disponible:', 'sin go2rtc');
      expect(console.log).toHaveBeenCalledWith('[onvif] no disponible:', 'sin onvif');
    } finally { delete process.env.SP_DEBUG; }
  });

  it('un feed guardado roto cae a GitHub; si no se puede escribir el feed igual se aplica', async () => {
    fs.writeFileSync(path.join(tmp, 'sp-update-feed.json'), '{roto');
    montar({ empaquetado: true });
    await listo();
    expect(updater.setFeedURL.mock.calls[0][0].url).toMatch(/github\.com/);
    fs.rmSync(tmp, { recursive: true, force: true });   // userData desaparecida
    updater.checkForUpdates.mockImplementation(() => { throw new Error('x'); });
    expect((await E.invocar('update-set-feed', 'https://c/')).ok).toBe(true);
    fs.mkdirSync(tmp);
  });

  it('el chequeo periódico y el del arranque toleran que el updater tire', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    montar({ empaquetado: true });
    updater.checkForUpdates.mockImplementation(() => { throw new Error('x'); });
    await listo();
    expect(() => vi.advanceTimersByTime(6 * 3600 * 1000)).not.toThrow();
  });

  it('registrar los protocolos o el powerMonitor que fallan no impiden arrancar', async () => {
    montar();
    E.app.setAsDefaultProtocolClient.mockImplementation(() => { throw new Error('x'); });
    E.electron.powerMonitor.on = () => { throw new Error('x'); };
    const w = await listo();
    w.webContents.session.setDevicePermissionHandler = () => { throw new Error('x'); };
    expect(E.ventanas).toHaveLength(1);
  });

  it('la prueba de cámara tolera un WebSocket que no se puede crear o cerrar', async () => {
    montar();
    const Orig = WSFalso;
    restaurar();
    ({ restaurar } = cargarCjs('electron/main.cjs', { electron: E.electron, ws: function () { throw new Error('ws roto'); }, './go2rtc-local.cjs': () => g2local, './sip-udp.cjs': sipNat, './onvif.cjs': onvif, 'electron-updater': { autoUpdater: updater } }, { mantener: true }));
    expect(await E.invocar('camara-probar', 'rtsp://x')).toEqual({ ok: false, motivo: 'ws roto' });
    void Orig;
    /* Si parar el motor tira, la prueba igual contesta. */
    g2local.asegurar.mockImplementation(async () => ({ ok: true, base: 'http://h' }));
    g2local.parar.mockImplementation(() => { throw new Error('x'); });
    expect((await E.invocar('camara-probar', 'rtsp://x')).ok).toBe(false);
  });
});
