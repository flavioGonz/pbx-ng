/* Piezas chicas del proceso main de Electron: el preload (el contrato window.sphone que
 * usa todo el renderer: si un canal IPC cambia de nombre, el botón no hace nada y nadie
 * se entera), la carga del motor SIP sin la librería `sip` (tiene que decir por qué no
 * registra en vez de explotar), y el go2rtc local (sólo en 127.0.0.1, puerto efímero, se
 * reinicia cuando cambia la lista de cámaras y no queda huérfano). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { cargarCjs } from './helpers/logica-cjs.js';
const require = createRequire(import.meta.url);

describe('preload: window.sphone', () => {
  function cargar() {
    const ipc = { on: vi.fn(), invoke: vi.fn(async (...a) => a), send: vi.fn(), removeListener: vi.fn() };
    let api = null;
    cargarCjs('../electron/preload.cjs', { electron: { contextBridge: { exposeInMainWorld: (n, o) => { expect(n).toBe('sphone'); api = o; } }, ipcRenderer: ipc } });
    return { api, ipc };
  }

  it('cada función invoca su canal IPC con los argumentos', async () => {
    const { api, ipc } = cargar();
    expect(api.isElectron).toBe(true);
    const invocaciones = [
      ['api', ['o'], 'sp-api', ['o']], ['apiBlob', ['o'], 'sp-api-blob', ['o']],
      ['sipConnect', ['c'], 'sipnat-connect', ['c']], ['sipDisconnect', [], 'sipnat-disconnect', []],
      ['sipCall', ['1', true], 'sipnat-call', ['1', true]], ['sipAccept', [false], 'sipnat-accept', [false]],
      ['sipReject', [], 'sipnat-reject', []], ['sipHangup', [], 'sipnat-hangup', []],
      ['sipMute', [true], 'sipnat-mute', [true]], ['sipDtmf', ['5'], 'sipnat-dtmf', ['5']],
      ['sipTransfer', ['9'], 'sipnat-transfer', ['9']], ['sipHold', [1], 'sipnat-hold', [true]],
      ['sipSetVideo', [0], 'sipnat-setvideo', [false]], ['sipVideoKeyframe', [], 'sipnat-video-keyframe', []],
      ['secureAvailable', [], 'secure-available', []], ['secureLoad', [], 'secure-load', []], ['secureSave', ['d'], 'secure-save', ['d']],
      ['updateCheck', [], 'update-check', []], ['updateInstall', [], 'update-install', []], ['updateSetFeed', ['u'], 'update-set-feed', ['u']],
      ['miniShow', [true], 'mini-show', [true]], ['g2localAsegurar', [[1]], 'g2local-asegurar', [[1]]],
      ['g2localEstado', [], 'g2local-estado', []], ['g2localParar', [], 'g2local-parar', []],
      ['onvifDescubrir', [3000], 'onvif-descubrir', [3000]], ['onvifPerfiles', [{}], 'onvif-perfiles', [{}]],
      ['clientesExportar', [{ filas: [] }], 'clientes-exportar', [{ filas: [] }]], ['clientesImportar', [], 'clientes-importar', []],
      ['camaraProbar', ['rtsp://x'], 'camara-probar', ['rtsp://x']], ['go2rtcOpen', [{}], 'go2rtc-open', [{}]],
    ];
    for (const [fn, args, canal, esperado] of invocaciones) {
      ipc.invoke.mockClear();
      await api[fn](...args);
      expect(ipc.invoke).toHaveBeenCalledWith(canal, ...esperado);
    }
    const envios = [
      ['sipAudioOut', ['b'], 'sipnat-audio-out', ['b']], ['sipVideoOut', ['b', 9], 'sipnat-video-out', ['b', 9]],
      ['winMinimize', [], 'win-minimize', []], ['winClose', [], 'win-close', []], ['winSize', [3, 4], 'win-size', [{ w: 3, h: 4 }]],
      ['winShake', [true], 'win-shake', [true]], ['miniState', [{ a: 1 }], 'mini-state', [{ a: 1 }]],
      ['miniAction', ['accept', 1], 'mini-action', [{ a: 'accept', v: 1 }]], ['miniReady', [], 'mini-ready', []],
      ['miniData', ['d'], 'mini-data', ['d']], ['miniSize', [200], 'mini-size', [200]],
      ['go2rtcSend', [1, 'x'], 'go2rtc-send', [{ id: 1, data: 'x' }]], ['go2rtcClose', [1], 'go2rtc-close', [1]],
    ];
    for (const [fn, args, canal, esperado] of envios) {
      ipc.send.mockClear();
      api[fn](...args);
      expect(ipc.send).toHaveBeenCalledWith(canal, ...esperado);
    }
  });

  it('los on* entregan el dato sin el evento, y los que devuelven función se desuscriben', () => {
    const { api, ipc } = cargar();
    const simples = [['onDial', 'dial'], ['onHotkey', 'hotkey'], ['onSipEvent', 'sipnat-event'], ['onSipAudio', 'sipnat-audio'], ['onSipVideo', 'sipnat-video'], ['onProvision', 'provision']];
    for (const [fn, canal] of simples) {
      const cb = vi.fn();
      api[fn](cb);
      const [c, h] = ipc.on.mock.calls[ipc.on.mock.calls.length - 1];
      expect(c).toBe(canal);
      h({ sender: 1 }, 'dato');
      expect(cb).toHaveBeenCalledWith('dato');
    }
    const conBaja = [['onUpdate', 'update-status'], ['onMiniState', 'mini-state'], ['onMiniAction', 'mini-action'], ['onMiniData', 'mini-data'], ['onSysEvent', 'sys-event'], ['onGo2rtcMsg', 'go2rtc-msg']];
    for (const [fn, canal] of conBaja) {
      const cb = vi.fn();
      const baja = api[fn](cb);
      const [c, h] = ipc.on.mock.calls[ipc.on.mock.calls.length - 1];
      expect(c).toBe(canal);
      h({}, 'x');
      expect(cb).toHaveBeenCalledWith('x');
      baja();
      expect(ipc.removeListener).toHaveBeenLastCalledWith(canal, h);
    }
  });
});

describe('motor SIP sin la librería sip empaquetada', () => {
  it('dice qué falta en vez de explotar, y sin srtp/video igual carga', () => {
    const m = cargarCjs('../electron/sip-udp.cjs', { sip: new Error('Cannot find module sip'), 'sip/digest': new Error('x'), './srtp.cjs': new Error('x'), './rtp-video.cjs': new Error('x') });
    const ev = [];
    expect(m.start({ sipServer: 's', ext: '1', pass: 'p', domain: 'd' }, (e) => ev.push(e))).toEqual({ error: 'no-sip-lib' });
    expect(ev[0].reason).toBe('librería SIP no disponible (require(sip): Cannot find module sip). Corré npm install y reconstruí.');
  });

  it('si sólo falta sip/digest también lo dice', () => {
    const m = cargarCjs('../electron/sip-udp.cjs', { 'sip/digest': new Error('sin digest') });
    const ev = [];
    m.start({ sipServer: 's', ext: '1', pass: 'p', domain: 'd' }, (e) => ev.push(e));
    expect(ev[0].reason).toMatch(/require\(sip\/digest\): sin digest/);
  });
});

describe('go2rtc local', () => {
  let tmp, cp, hijos, servidores;
  afterEach(() => { vi.restoreAllMocks(); delete process.resourcesPath; for (const s of servidores || []) { try { s.close(); } catch {} } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  /* spawn falso: "go2rtc" abre de verdad el puerto que dice su yaml, como el real. */
  function preparar({ abre = true, binario = true, empaquetado = false } = {}) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g2l-'));
    hijos = []; servidores = [];
    cp = require('child_process');
    vi.spyOn(cp, 'spawn').mockImplementation((bin, args, opts) => {
      const h = new EventEmitter();
      h.stdout = new EventEmitter(); h.stderr = new EventEmitter();
      h.kill = vi.fn(() => { h.emit('exit', null, 'SIGTERM'); });
      h.bin = bin; h.args = args; h.opts = opts;
      hijos.push(h);
      if (abre) {
        const yaml = fs.readFileSync(args[1], 'utf8');
        const port = +yaml.match(/listen: '127\.0\.0\.1:(\d+)'/)[1];
        const s = net.createServer((c) => c.destroy()); s.listen(port, '127.0.0.1'); servidores.push(s);
      }
      return h;
    });
    const existe = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => (/go2rtc(\.exe)?$/.test(String(p)) ? binario : existe(p)));
    if (empaquetado) process.resourcesPath = tmp;
    const log = vi.fn();
    const app = { isPackaged: empaquetado, getPath: () => tmp };
    const g = cargarCjs('../electron/go2rtc-local.cjs')({ app, log });
    return { g, log };
  }

  it('sin cámaras o sin binario lo dice', async () => {
    const { g } = preparar({ binario: false });
    expect(await g.asegurar([])).toEqual({ ok: false, motivo: 'no hay cámaras locales que mostrar' });
    expect(await g.asegurar([{ id: 'a' }, null])).toMatchObject({ ok: false });
    expect((await g.asegurar([{ id: 'a', rtsp: 'rtsp://x' }])).motivo).toMatch(/no trae el motor de video/);
    expect(g.estado()).toEqual({ disponible: false, corriendo: false, base: null });
  });

  it('levanta go2rtc sólo en loopback, con la config escapada y permisos 600', async () => {
    const { g, log } = preparar();
    const r = await g.asegurar([{ id: 'cam1', rtsp: "rtsp://u:p'a#s@10.0.0.5/1" }]);
    expect(r.ok).toBe(true);
    expect(r.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const h = hijos[0];
    expect(h.args[0]).toBe('-c');
    expect(h.args).not.toContain('-d');
    const yaml = fs.readFileSync(h.args[1], 'utf8');
    expect(yaml).toContain("  cam1: 'rtsp://u:p''a#s@10.0.0.5/1'");
    expect(yaml).toContain("listen: '127.0.0.1:");
    expect(yaml).toContain("rtsp:\n  listen: ''");
    if (process.platform !== 'win32') expect(fs.statSync(h.args[1]).mode & 0o777).toBe(0o600);
    expect(g.estado()).toMatchObject({ disponible: true, corriendo: true, base: r.base });
    h.stderr.emit('data', Buffer.from('  linea de log  '));
    expect(log).toHaveBeenCalledWith({ linea: 'linea de log' }, 'go2rtc local');
  });

  it('con la misma lista reusa el proceso; si cambia, lo reinicia', async () => {
    const { g } = preparar();
    const a = [{ id: 'a', rtsp: 'rtsp://1' }, { id: 'b', rtsp: 'rtsp://2' }];
    const r1 = await g.asegurar(a);
    const r2 = await g.asegurar([...a].reverse());
    expect(r2.base).toBe(r1.base);
    expect(hijos).toHaveLength(1);
    await g.asegurar([{ id: 'c', rtsp: 'rtsp://3' }]);
    expect(hijos).toHaveLength(2);
    expect(hijos[0].kill).toHaveBeenCalled();
  });

  it('dos pedidos simultáneos con la misma lista levantan un solo proceso', async () => {
    const { g } = preparar();
    const l = [{ id: 'a', rtsp: 'rtsp://1' }];
    const [r1, r2] = await Promise.all([g.asegurar(l), g.asegurar(l)]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(hijos).toHaveLength(1);
  });

  it('si go2rtc no abre el puerto, lo mata y lo dice', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { g } = preparar({ abre: false });
    const p = g.asegurar([{ id: 'a', rtsp: 'rtsp://1' }]);
    // que el reloj "corra" más rápido: esperarApi mira Date.now()
    const t0 = Date.now();
    const iv = setInterval(() => vi.setSystemTime(Date.now() + 2000), 20);
    const r = await p;
    clearInterval(iv);
    vi.useRealTimers();
    expect(Date.now()).toBeGreaterThan(0); void t0;
    expect(r).toEqual({ ok: false, motivo: 'go2rtc no abrió su puerto' });
    expect(hijos[0].kill).toHaveBeenCalled();
  });

  it('parar mata el proceso (y SIGKILL a los 3 s por las dudas); un exit propio limpia el estado', async () => {
    const { g, log } = preparar();
    await g.asegurar([{ id: 'a', rtsp: 'rtsp://1' }]);
    vi.useFakeTimers();
    const h = hijos[0];
    g.parar();
    vi.advanceTimersByTime(3000);
    vi.useRealTimers();
    expect(h.kill).toHaveBeenCalledWith('SIGKILL');
    expect(g.estado().corriendo).toBe(false);
    g.parar();   // dos veces no rompe
    await g.asegurar([{ id: 'b', rtsp: 'rtsp://2' }]);
    hijos[1].emit('error', new Error('EACCES'));
    expect(log).toHaveBeenCalledWith({ err: 'EACCES' }, 'go2rtc local: no se pudo ejecutar');
    hijos[1].emit('exit', 1, null);
    expect(g.estado().corriendo).toBe(false);
  });

  it('empaquetado busca el binario en resources/go2rtc', async () => {
    const { g } = preparar({ empaquetado: true });
    await g.asegurar([{ id: 'a', rtsp: 'rtsp://1' }]);
    expect(hijos[0].bin).toBe(path.join(tmp, 'go2rtc', process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc'));
  });

  it('un kill que explota no impide seguir; un existsSync que explota cuenta como sin binario', async () => {
    const { g } = preparar();
    await g.asegurar([{ id: 'a', rtsp: 'rtsp://1' }]);
    hijos[0].kill.mockImplementation(() => { throw new Error('ESRCH'); });
    expect(() => g.parar()).not.toThrow();
    fs.existsSync.mockImplementation(() => { throw new Error('x'); });
    expect(g.estado().disponible).toBe(false);
  });
});

describe('go2rtc local: bordes', () => {
  let tmp2;
  afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch {} });

  function base({ abre = true, sinStderr = false, killTira = false } = {}) {
    tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'g2b-'));
    const hijos = [], servidores = [];
    const cp = require('child_process');
    vi.spyOn(cp, 'spawn').mockImplementation((bin, args) => {
      const h = new EventEmitter();
      h.stdout = sinStderr ? null : new EventEmitter(); h.stderr = sinStderr ? null : new EventEmitter();
      h.kill = vi.fn(() => { if (killTira) throw new Error('ESRCH'); });
      hijos.push(h);
      if (abre) { const port = +fs.readFileSync(args[1], 'utf8').match(/127\.0\.0\.1:(\d+)/)[1]; const s = net.createServer((c) => c.destroy()); s.listen(port, '127.0.0.1'); servidores.push(s); }
      return h;
    });
    const existe = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => (/go2rtc(\.exe)?$/.test(String(p)) ? true : existe(p)));
    const g = cargarCjs('electron/go2rtc-local.cjs')({ app: { isPackaged: false, getPath: () => tmp2 } });   // sin log
    return { g, hijos, cerrar: () => servidores.forEach((s) => s.close()) };
  }

  it('en Windows busca go2rtc.exe; sin stdout/stderr y sin logger arranca igual', async () => {
    const plat = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const { g, cerrar } = base({ sinStderr: true });
      const r = await g.asegurar([{ id: 'a', rtsp: 'rtsp://1' }]);
      expect(r.ok).toBe(true);
      expect(require('child_process').spawn.mock.calls[0][0]).toMatch(/go2rtc\.exe$/);
      g.parar(); cerrar();
    } finally { Object.defineProperty(process, 'platform', plat); }
  });

  it('un pedido que llega mientras otro arranca con OTRA lista espera y después reinicia', async () => {
    const { g, hijos, cerrar } = base();
    const p1 = g.asegurar([{ id: 'a', rtsp: 'rtsp://1' }]);
    const p2 = g.asegurar([{ id: 'b', rtsp: 'rtsp://2' }]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(hijos).toHaveLength(2);
    g.parar(); cerrar();
  });

  it('si el arranque en curso falla, el que esperaba lo intenta de nuevo; kill que tira en la falla', async () => {
    const { g, hijos } = base({ abre: false, killTira: true });
    const reloj = vi.spyOn(Date, 'now');
    let t = 0; reloj.mockImplementation(() => (t += 5000));
    const p1 = g.asegurar([{ id: 'a', rtsp: 'rtsp://1' }]);
    const p2 = g.asegurar([{ id: 'a', rtsp: 'rtsp://1' }]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ ok: false, motivo: 'go2rtc no abrió su puerto' });
    expect(r2.ok).toBe(false);
    expect(hijos.length).toBe(2);
  });

  it('el SIGKILL de respaldo que tira no rompe; un error sin mensaje tiene texto', async () => {
    const { g, hijos, cerrar } = base();
    await g.asegurar([{ id: 'a', rtsp: 'rtsp://1' }]);
    hijos[0].kill.mockImplementation((sig) => { if (sig === 'SIGKILL') throw new Error('x'); });
    vi.useFakeTimers();
    g.parar();
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    vi.useRealTimers();
    cerrar();
    const cp = require('child_process');
    cp.spawn.mockImplementation(() => { throw {}; });   // eslint-disable-line no-throw-literal
    expect(await g.asegurar([{ id: 'z', rtsp: 'rtsp://9' }])).toEqual({ ok: false, motivo: 'no se pudo levantar el motor de video' });
    expect(await g.asegurar()).toEqual({ ok: false, motivo: 'no hay cámaras locales que mostrar' });
  });
});
