/* Video del modo SIP nativo (src/video-native.js): WebCodecs H.264 Annex-B entre la cámara
 * y el main. Lo que importa para el operador: el decoder no arranca con un delta (pide un
 * keyframe, sin inundar de PLI), se manda un keyframe cada ~2 s o cuando el otro lado lo
 * pide, y al cortar se apaga la cámara (la lucecita no puede quedar prendida). */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createNativeVideo } from '../src/video-native.js';

const b64 = (arr) => btoa(String.fromCharCode(...arr));
const IDR = [0, 0, 0, 1, 0x65, 1, 2, 3];
const SPS = [0, 0, 1, 0x67, 9, 9, 9, 9];
const DELTA = [0, 0, 0, 1, 0x41, 1, 2, 3];
const RARO = [0, 0, 1, 0x06, 1, 2, 3, 4];   // SEI: ni key ni delta explícito

let pendiente = null;
let encoders, decoders, chunks, frames, readerQueue, camTrack, capTrack, ctx2d;

class FakeEncoder {
  constructor(o) { this.o = o; this.state = 'unconfigured'; this.encode = vi.fn(); encoders.push(this); }
  configure(c) { this.cfg = c; this.state = FakeEncoder.sinConfigurar ? 'unconfigured' : 'configured'; }
  close() { this.state = 'closed'; }
}
class FakeDecoder {
  constructor(o) { this.o = o; this.state = 'unconfigured'; this.decode = vi.fn(); decoders.push(this); }
  configure(c) { if (FakeDecoder.failFirst && !this.tried) { this.tried = true; throw new Error('no'); } this.cfg = c; this.state = 'configured'; }
  close() { this.state = 'closed'; }
}
class FakeChunk { constructor(o) { Object.assign(this, o); chunks.push(this); } }

beforeEach(() => {
  encoders = []; decoders = []; chunks = []; frames = []; readerQueue = [];
  FakeDecoder.failFirst = false; FakeEncoder.sinConfigurar = false; pendiente = null;
  camTrack = { stop: vi.fn() }; capTrack = { stop: vi.fn() };
  ctx2d = { drawImage: vi.fn() };
  window.VideoEncoder = FakeEncoder;
  globalThis.VideoEncoder = FakeEncoder;
  window.VideoDecoder = FakeDecoder; globalThis.VideoDecoder = FakeDecoder;
  globalThis.EncodedVideoChunk = FakeChunk;
  const reader = {
    read: vi.fn(() => new Promise((res, rej) => { const n = readerQueue.shift(); if (n === 'esperar') { pendiente = res; return; } if (!n) return res({ done: true }); if (n === 'err') return rej(new Error('x')); res(n); })),
    cancel: vi.fn(),
  };
  window.MediaStreamTrackProcessor = function () { return { readable: { getReader: () => reader } }; };
  globalThis.MediaStreamTrackProcessor = window.MediaStreamTrackProcessor;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getVideoTracks: () => [camTrack], getTracks: () => [camTrack] })) } });
  HTMLCanvasElement.prototype.getContext = () => ctx2d;
  HTMLCanvasElement.prototype.captureStream = () => ({ getTracks: () => [capTrack] });
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of ['VideoEncoder', 'VideoDecoder', 'MediaStreamTrackProcessor']) { delete window[k]; delete globalThis[k]; }
  delete globalThis.EncodedVideoChunk;
});

const frame = () => { const f = { close: vi.fn() }; frames.push(f); return { done: false, value: f }; };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('salida (cámara -> red)', () => {
  it('sin WebCodecs avisa y no abre la cámara', async () => {
    delete window.VideoEncoder;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = createNativeVideo({ sendFrame: vi.fn() });
    expect(await v.startLocal()).toBeNull();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('elige el primer códec soportado, codifica con keyframe al inicio y cada 2 s, y cierra los cuadros', async () => {
    FakeEncoder.isConfigSupported = vi.fn(async (c) => ({ supported: c.codec === 'avc1.42001f' }));
    for (let i = 0; i < 41; i++) readerQueue.push(frame());
    const v = createNativeVideo({ sendFrame: vi.fn(), fps: 20 });
    const st = await v.startLocal('cam1');
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { ideal: 'cam1' }, width: 640, height: 480, frameRate: 20 }, audio: false });
    expect(v.getLocalStream()).toBe(st);
    const enc = encoders[0];
    expect(enc.cfg.codec).toBe('avc1.42001f');
    expect(enc.cfg.avc).toEqual({ format: 'annexb' });
    await flush(); await flush();
    const keys = enc.encode.mock.calls.map((c) => c[1].keyFrame);
    expect(keys.length).toBe(41);
    expect(keys[0]).toBe(true);
    expect(keys[1]).toBe(false);
    expect(keys[40]).toBe(true);           // n=40 = 2 s a 20 fps
    expect(frames.every((f) => f.close.mock.calls.length === 1)).toBe(true);
    delete FakeEncoder.isConfigSupported;
  });

  it('forceKeyframe hace que el próximo cuadro salga como keyframe', async () => {
    const v = createNativeVideo({ sendFrame: vi.fn() });
    readerQueue.push(frame(), frame(), 'esperar');
    await v.startLocal();
    await flush(); await flush();
    const e = encoders[0];
    expect(e.encode.mock.calls.map((c) => c[1].keyFrame)).toEqual([true, false]);
    v.forceKeyframe();               // el otro lado pidió un IDR (PLI/FIR)
    pendiente(frame());
    await flush(); await flush();
    expect(e.encode.mock.calls[2][1].keyFrame).toBe(true);
    v.stop();
  });

  it('el encoder entrega el cuadro en base64 con timestamp a 90 kHz', async () => {
    const send = vi.fn();
    const v = createNativeVideo({ sendFrame: send });
    await v.startLocal();
    const out = encoders[0].o.output;
    out({ byteLength: 3, timestamp: 1e6, copyTo: (b) => b.set([1, 2, 3]) });
    expect(send).toHaveBeenCalledWith(btoa('\x01\x02\x03'), 90000);
    out({ byteLength: 1, timestamp: 0, copyTo: () => { throw new Error('x'); } });
    expect(send).toHaveBeenCalledTimes(1);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    encoders[0].o.error(new Error('enc'));
    expect(err).toHaveBeenCalled();
  });

  it('isConfigSupported que explota o dice que no: cae al primer códec', async () => {
    FakeEncoder.isConfigSupported = vi.fn(async () => { throw new Error('x'); });
    await createNativeVideo({ sendFrame: vi.fn() }).startLocal();
    expect(encoders[0].cfg.codec).toBe('avc1.42e01f');
    FakeEncoder.isConfigSupported = vi.fn(async () => null);
    await createNativeVideo({ sendFrame: vi.fn() }).startLocal();
    expect(encoders[1].cfg.codec).toBe('avc1.42e01f');
    delete FakeEncoder.isConfigSupported;
  });

  it('un error de lectura corta el lazo; un encoder no configurado no codifica; encode que explota no corta', async () => {
    readerQueue.push(frame(), 'err');
    const v = createNativeVideo({ sendFrame: vi.fn() });
    await v.startLocal();
    encoders[0].encode.mockImplementation(() => { throw new Error('x'); });
    await flush(); await flush();
    expect(frames[0].close).toHaveBeenCalled();
    FakeEncoder.sinConfigurar = true;
    const v2 = createNativeVideo({ sendFrame: vi.fn() });
    readerQueue.push(frame());
    await v2.startLocal();
    await flush(); await flush();
    expect(encoders[1].encode).not.toHaveBeenCalled();
  });
});

describe('entrada (red -> pantalla)', () => {
  it('sin decoder (no arrancó) ignora los NAL', () => {
    const v = createNativeVideo({ sendFrame: vi.fn() });
    expect(() => v.onNal(b64(IDR))).not.toThrow();
    expect(v.getRemoteStream()).toBeNull();
  });

  it('un delta antes del primer keyframe pide PLI (sin inundar) y no decodifica', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const req = vi.fn();
    const v = createNativeVideo({ sendFrame: vi.fn(), requestKeyframe: req });
    const st = v.startRemote();
    expect(v.getRemoteStream()).toBe(st);
    v.onNal(b64(DELTA));
    v.onNal(b64(DELTA));
    v.onNal(b64(RARO));
    expect(req).toHaveBeenCalledTimes(1);
    vi.setSystemTime(11000);
    v.onNal(b64(DELTA));
    expect(req).toHaveBeenCalledTimes(2);
    expect(decoders[0].decode).not.toHaveBeenCalled();
    v.onNal('%%%');   // base64 inválido: se ignora
  });

  it('con keyframe (IDR o SPS) arranca y después acepta deltas con timestamp creciente', () => {
    const v = createNativeVideo({ sendFrame: vi.fn(), requestKeyframe: vi.fn() });
    v.startRemote();
    expect(decoders[0].cfg.codec).toBe('avc1.42e01f');
    v.onNal(b64(SPS));
    v.onNal(b64(DELTA));
    v.onNal(b64(IDR));
    expect(chunks.map((c) => c.type)).toEqual(['key', 'delta', 'key']);
    expect(chunks.map((c) => c.timestamp)).toEqual([33333, 66666, 99999]);
  });

  it('si decode explota vuelve a esperar keyframe y pide uno', () => {
    vi.useFakeTimers(); vi.setSystemTime(50000);
    const req = vi.fn(() => { throw new Error('ipc'); });
    const v = createNativeVideo({ sendFrame: vi.fn(), requestKeyframe: req });
    v.startRemote();
    decoders[0].decode.mockImplementationOnce(() => { throw new Error('x'); });
    v.onNal(b64(IDR));
    expect(req).toHaveBeenCalledTimes(1);
    vi.setSystemTime(60000);
    v.onNal(b64(DELTA));        // de nuevo exige keyframe
    expect(req).toHaveBeenCalledTimes(2);
  });

  it('si el códec principal no se puede configurar usa el alternativo', () => {
    FakeDecoder.failFirst = true;
    createNativeVideo({ sendFrame: vi.fn() }).startRemote();
    expect(decoders[0].cfg.codec).toBe('avc1.42001f');
  });

  it('dibuja cada cuadro ajustando el canvas al tamaño real y lo cierra; error del decoder pide keyframe', () => {
    vi.useFakeTimers(); vi.setSystemTime(90000);
    const req = vi.fn();
    const v = createNativeVideo({ sendFrame: vi.fn(), requestKeyframe: req });
    v.startRemote();
    const fr = { displayWidth: 320, displayHeight: 240, close: vi.fn() };
    decoders[0].o.output(fr);
    expect(ctx2d.drawImage).toHaveBeenCalledWith(fr, 0, 0, 320, 240);
    expect(fr.close).toHaveBeenCalled();
    decoders[0].o.output({ displayWidth: 320, displayHeight: 240, close: () => { throw new Error('x'); } });
    ctx2d.drawImage.mockImplementation(() => { throw new Error('x'); });
    decoders[0].o.output({ displayWidth: 320, displayHeight: 240, close: vi.fn() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    decoders[0].o.error(new Error('dec'));
    expect(req).toHaveBeenCalledTimes(1);
  });
});

describe('stop', () => {
  it('apaga la cámara, el canvas, el encoder y el decoder, y se puede llamar dos veces', async () => {
    const v = createNativeVideo({ sendFrame: vi.fn() });
    v.startRemote();
    await v.startLocal();
    v.stop();
    expect(camTrack.stop).toHaveBeenCalled();
    expect(capTrack.stop).toHaveBeenCalled();
    expect(encoders[0].state).toBe('closed');
    expect(decoders[0].state).toBe('closed');
    expect(v.getLocalStream()).toBeNull();
    expect(() => v.stop()).not.toThrow();
  });
});

describe('robustez del video', () => {
  it('encode que tira desde el primer cuadro, close que tira y consola rota no cortan el lazo', async () => {
    const v = createNativeVideo({ sendFrame: vi.fn() });
    const malo = { close: vi.fn(() => { throw new Error('x'); }) };
    readerQueue.push({ done: false, value: malo }, frame());
    const orig = FakeEncoder.prototype.configure;
    FakeEncoder.prototype.configure = function (c) { orig.call(this, c); this.encode = vi.fn(() => { throw new Error('enc'); }); };
    await v.startLocal();
    await flush(); await flush();
    FakeEncoder.prototype.configure = orig;
    expect(encoders[0].encode).toHaveBeenCalledTimes(2);
    expect(frames[0].close).toHaveBeenCalled();
    vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('consola'); });
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('consola'); });
    expect(() => encoders[0].o.error(new Error('e'))).not.toThrow();
    v.startRemote();
    expect(() => decoders[0].o.error(new Error('d'))).not.toThrow();
  });

  it('si ningún códec del decoder se puede configurar, no explota', () => {
    const orig = FakeDecoder.prototype.configure;
    FakeDecoder.prototype.configure = () => { throw new Error('no'); };
    expect(() => createNativeVideo({ sendFrame: vi.fn() }).startRemote()).not.toThrow();
    FakeDecoder.prototype.configure = orig;
  });

  it('parar con piezas que tiran o ya cerradas no rompe', async () => {
    const v = createNativeVideo({ sendFrame: vi.fn() });
    v.startRemote();
    await v.startLocal();
    encoders[0].state = 'closed';
    decoders[0].state = 'closed';
    camTrack.stop.mockImplementation(() => { throw new Error('x'); });
    capTrack.stop.mockImplementation(() => { throw new Error('x'); });
    expect(() => v.stop()).not.toThrow();
    const v2 = createNativeVideo({ sendFrame: vi.fn() });
    v2.startRemote();
    await v2.startLocal();
    encoders[1].close = () => { throw new Error('x'); };
    decoders[1].close = () => { throw new Error('x'); };
    expect(() => v2.stop()).not.toThrow();
  });
});
