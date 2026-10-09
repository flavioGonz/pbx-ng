/* useSipNative (src/useSipNative.js): el hook del modo SIP nativo. La señalización y el
 * RTP viven en el main; acá se fija el puente del renderer: los eventos del main mueven el
 * estado (registro, llamando, timbrando, atendida, fin con historial y perdidas), el audio
 * del micrófono sale como PCM 8 kHz y el que llega se reproduce (con volumen y sin acumular
 * latencia), y espera/cámara NO cambian el botón hasta que la central contesta: un botón
 * encendido que miente es peor que uno que tarda. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import './helpers/logica-storage.js';

const motorVideo = { startRemote: vi.fn(), startLocal: vi.fn(async () => {}), stop: vi.fn(), forceKeyframe: vi.fn(), onNal: vi.fn(), getRemoteStream: vi.fn(() => 'remoto'), getLocalStream: vi.fn(() => 'local') };
let videoOpts = null;
vi.mock('../src/video-native.js', () => ({ createNativeVideo: (o) => { videoOpts = o; return motorVideo; } }));

let useSipNative, sp, cb, procesadores, ctx;
function fakeCtx() {
  procesadores = [];
  return {
    state: 'suspended', sampleRate: 16000, currentTime: 0, destination: { d: 1 },
    resume: vi.fn(async () => {}), close: vi.fn(),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createScriptProcessor: vi.fn(() => { const p = { connect: vi.fn(), disconnect: vi.fn() }; procesadores.push(p); return p; }),
    createGain: vi.fn(() => ({ gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() })),
    createOscillator: vi.fn(() => ({ frequency: {}, connect: vi.fn(), start: vi.fn(), stop: vi.fn() })),
    createMediaStreamDestination: vi.fn(() => ({ stream: { id: 'msd' } })),
  };
}
let micTrack, gum;
beforeEach(async () => {
  localStorage.clear();
  cb = {};
  sp = {
    onSipEvent: (f) => { cb.evt = f; }, onSipAudio: (f) => { cb.audio = f; }, onSipVideo: (f) => { cb.video = f; },
    sipConnect: vi.fn(), sipDisconnect: vi.fn(), sipCall: vi.fn(), sipAccept: vi.fn(), sipReject: vi.fn(), sipHangup: vi.fn(),
    sipMute: vi.fn(), sipDtmf: vi.fn(), sipSetVideo: vi.fn(), sipHold: vi.fn(), sipTransfer: vi.fn(), sipAudioOut: vi.fn(),
    sipVideoOut: vi.fn(), sipVideoKeyframe: vi.fn(),
  };
  window.sphone = sp;
  ctx = fakeCtx();
  window.AudioContext = vi.fn(() => ctx);
  micTrack = { stop: vi.fn() };
  gum = vi.fn(async () => ({ getTracks: () => [micTrack] }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum, enumerateDevices: vi.fn(async () => []) } });
  for (const k of Object.keys(motorVideo)) motorVideo[k].mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  ({ useSipNative } = await import('../src/useSipNative.js'));
});
afterEach(() => { vi.useRealTimers(); delete window.sphone; });

const evento = (e) => act(() => { cb.evt(e); });
function montar() {
  const h = renderHook(() => useSipNative());
  return h;
}
async function atendida(h, el) {
  h.result.current.audioRef.current = el === undefined ? { srcObject: null, volume: 0, play: vi.fn(async () => {}), setSinkId: vi.fn(async () => {}), muted: true } : el;
  evento({ type: 'call', state: 'calling', number: '102' });
  await act(async () => { cb.evt({ type: 'call', state: 'answered' }); await new Promise((r) => setTimeout(r, 0)); });
}

describe('registro', () => {
  it('conectar pide al main y los eventos de registro mueven el estado', () => {
    const h = montar();
    act(() => h.result.current.connect({ ext: '101' }));
    expect(h.result.current.reg).toBe('connecting');
    expect(sp.sipConnect).toHaveBeenCalledWith({ ext: '101' });
    evento({ type: 'reg', state: 'registered' });
    expect(h.result.current.registered).toBe(true);
    act(() => h.result.current.disconnect());
    expect(sp.sipDisconnect).toHaveBeenCalled();
    expect(h.result.current.reg).toBe('idle');
    evento(null);   // evento vacío: se ignora
  });

  it('sin el puente de Electron, conectar falla y nada explota', () => {
    window.sphone = {};
    const h = montar();
    act(() => h.result.current.connect({}));
    expect(h.result.current.reg).toBe('failed');
    act(() => { h.result.current.disconnect(); h.result.current.reject(); h.result.current.hangup(); h.result.current.accept(); h.result.current.toggleMute(); h.result.current.sendDtmf('1'); h.result.current.transfer('1'); h.result.current.toggleHold(); h.result.current.toggleVideo(); });
    expect(h.result.current.muted).toBe(true);
    delete window.sphone;
    const h2 = montar();
    act(() => h2.result.current.connect({}));
    expect(h2.result.current.reg).toBe('failed');
  });

  it('el mismo contrato que useSip (para intercambiarlos en App.jsx)', () => {
    const r = montar().result.current;
    for (const k of ['attended', 'heldInfo', 'conf', 'usingRelay']) expect(r[k] == null || r[k] === false).toBe(true);
    for (const k of ['attendedCall', 'completeAttended', 'cancelAttended', 'switchLine', 'conference']) expect(r[k]()).toBeUndefined();
    expect(r.getRemoteAudioStream()).toBeNull();
    expect(r.getRemoteStream()).toBeNull();
    expect(r.getLocalStream()).toBeNull();
  });
});

describe('llamadas', () => {
  it('saliente: llamando, timbrando, atendida (abre el micrófono) y al cortar queda en el historial', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    localStorage.setItem('sp_dev_mic', 'mic9');
    const h = montar();
    await act(async () => { expect(await h.result.current.placeCall(102, true)).toEqual({ ok: true }); });
    expect(sp.sipCall).toHaveBeenCalledWith('102', true);
    evento({ type: 'call', state: 'calling', number: '102' });
    expect(h.result.current.note).toBe('Llamando…');
    expect(h.result.current.inCall).toBe(true);
    evento({ type: 'call', state: 'ringing' });
    expect(h.result.current.note).toBe('Timbrando…');
    await atendida(h);
    expect(h.result.current.call).toBe('answered');
    expect(h.result.current.callInfo.since).toBe(1_000_000);
    expect(gum).toHaveBeenCalledWith({ audio: { deviceId: { ideal: 'mic9' } } });
    expect(ctx.resume).toHaveBeenCalled();
    expect(h.result.current.audioRef.current.srcObject).toEqual({ id: 'msd' });
    expect(h.result.current.getRemoteAudioStream()).toEqual({ id: 'msd' });
    evento({ type: 'stats', score: 3, loss: 2, jitter: 30 });
    expect(h.result.current.quality).toEqual({ score: 3, loss: 2, jitter: 30, rtt: null, codec: null, candType: null });
    vi.setSystemTime(1_065_000);
    evento({ type: 'call', state: 'ended', reason: 'colgó el otro lado' });
    expect(h.result.current.call).toBeNull();
    expect(h.result.current.quality).toBeNull();
    expect(h.result.current.note).toBe('colgó el otro lado');
    expect(h.result.current.hist[0]).toMatchObject({ dir: 'out', number: '102', dur: 65, missed: false });
    expect(micTrack.stop).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
  });

  it('entrante no atendida queda como perdida; con video lo avisa', () => {
    const h = montar();
    evento({ type: 'call', state: 'incoming', number: '300', video: true });
    expect(h.result.current.incoming.remoteIdentity.uri.user).toBe('300');
    expect(h.result.current.incomingVideo).toBe(true);
    evento({ type: 'call', state: 'ended' });
    expect(h.result.current.hist[0]).toMatchObject({ dir: 'in', number: '300', dur: 0, missed: true });
    expect(h.result.current.incomingVideo).toBe(false);
    expect(h.result.current.note).toBe('');
  });

  it('atender, rechazar, colgar, DTMF (con tono local) y transferir van al main', () => {
    const h = montar();
    evento({ type: 'call', state: 'incoming', number: '300' });
    act(() => h.result.current.accept(1));
    expect(sp.sipAccept).toHaveBeenCalledWith(true);
    act(() => h.result.current.reject());
    expect(sp.sipReject).toHaveBeenCalled();
    expect(h.result.current.incoming).toBeNull();
    act(() => h.result.current.hangup());
    expect(sp.sipHangup).toHaveBeenCalled();
    act(() => h.result.current.sendDtmf(5));
    act(() => h.result.current.sendDtmf('x'));
    expect(sp.sipDtmf).toHaveBeenCalledWith('5');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);   // 770 + 1336 Hz
    h.result.current.transfer('400');
    expect(sp.sipTransfer).toHaveBeenCalledWith('400');
  });

  it('una "answered" sin "calling" previo igual arma la llamada; el fin sin llamada no anota nada', async () => {
    const h = montar();
    evento({ type: 'call', state: 'ended' });
    expect(h.result.current.hist).toEqual([]);
    await act(async () => { cb.evt({ type: 'call', state: 'answered', number: '9' }); await new Promise((r) => setTimeout(r, 0)); });
    expect(h.result.current.callInfo).toMatchObject({ dir: 'out', number: '9' });
  });

  it('mute pide al main y cambia el estado', () => {
    const h = montar();
    act(() => h.result.current.toggleMute());
    expect(sp.sipMute).toHaveBeenCalledWith(true);
    expect(h.result.current.muted).toBe(true);
  });
});

describe('audio', () => {
  it('el micrófono sale downsampleado a 8 kHz en PCM 16 bits', async () => {
    const h = montar();
    await atendida(h);
    const cap = procesadores[0];
    const entrada = new Float32Array(1024).fill(0.5); entrada[0] = 2; entrada[1] = -2;
    cap.onaudioprocess({ inputBuffer: { getChannelData: () => entrada } });
    const b64 = sp.sipAudioOut.mock.calls[0][0];
    const i16 = new Int16Array(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    expect(i16.length).toBe(512);              // 16 kHz -> 8 kHz
    expect(i16[0]).toBe(32767);                // recorta en 1
    expect(i16[2]).toBe(Math.floor(0.5 * 0x7fff));
    const ds = new Float32Array(4);
    ctx.sampleRate = 8000;
    cap.onaudioprocess({ inputBuffer: { getChannelData: () => ds } });   // misma tasa: copia
    ctx.sampleRate = 16000;
    delete sp.sipAudioOut;
    cap.onaudioprocess({ inputBuffer: { getChannelData: () => entrada } });
  });

  it('el audio que llega se upsamplea con volumen, se reproduce y no acumula latencia', async () => {
    localStorage.setItem('sp_volume', '0.5');
    const h = montar();
    await atendida(h);
    expect(h.result.current.volume).toBe(0.5);
    const pcm = new Int16Array([16384, -16384, 0, 16384]);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
    cb.audio(b64);
    const play = procesadores[1];
    const out = new Float32Array(10);
    play.onaudioprocess({ outputBuffer: { getChannelData: () => out } });
    expect(out[0]).toBeCloseTo(0.25);           // 0.5 * 0.5
    expect(out[1]).toBeCloseTo(0);              // interpolado
    expect(out[2]).toBeCloseTo(-0.25);
    expect(out[9]).toBe(0);                     // se vació: silencio
    // con mucho atraso (> 1 s) se recorta a medio segundo
    const largo = new Int16Array(9000);
    const b64l = btoa(String.fromCharCode(...new Uint8Array(largo.buffer)));
    cb.audio(b64l); cb.audio(b64l);
    const grande = new Float32Array(40000);
    play.onaudioprocess({ outputBuffer: { getChannelData: () => grande } });
    expect(grande.filter((x, i) => i > 26000 && x === 0).length).toBeGreaterThan(0);
    cb.audio('%%%');   // basura: no rompe
  });

  it('sin llamada el audio entrante se descarta; volumen acotado y guardado', async () => {
    const h = montar();
    cb.audio('AAAA');
    act(() => h.result.current.setVolume(7));
    expect(h.result.current.volume).toBe(1);
    act(() => h.result.current.setVolume(-1));
    expect(localStorage.getItem('sp_volume')).toBe('0');
  });

  it('si el <audio> no arranca (autoplay), sale directo por la placa', async () => {
    const h = montar();
    await atendida(h, { play: vi.fn(async () => { throw new Error('NotAllowed'); }) });
    expect(procesadores[1].connect).toHaveBeenCalledWith(ctx.destination);
    const h2 = montar();
    await atendida(h2, null);
    expect(procesadores[3].connect).toHaveBeenCalledWith(ctx.destination);
  });

  it('sin micrófono no se cae: lo registra', async () => {
    gum.mockRejectedValueOnce(new Error('NotFound'));
    const h = montar();
    await atendida(h);
    expect(console.error).toHaveBeenCalledWith('[sipnat] audio', expect.any(Error));
    ctx.state = 'running';
  });
});

describe('espera, cámara y altavoz', () => {
  it('la espera se pide y el estado lo mueve la respuesta de la central', () => {
    const h = montar();
    act(() => h.result.current.toggleHold());
    expect(sp.sipHold).toHaveBeenCalledWith(true);
    expect(h.result.current.held).toBe(false);
    evento({ type: 'call', state: 'hold', held: true });
    expect(h.result.current.held).toBe(true);
    evento({ type: 'call', state: 'hold', held: true, error: '488' });
    expect(h.result.current.note).toBe('No se pudo poner en espera (488)');
    evento({ type: 'call', state: 'reinvite', remoteHold: true });
    expect(h.result.current.note).toBe('El otro lado te puso en espera');
    evento({ type: 'call', state: 'reinvite', remoteHold: false });
    expect(h.result.current.note).toBe('');
    evento({ type: 'call', state: 'reinvite' });
  });

  it('cámara: se pide; al confirmarse arranca el video y lo apaga al cortar', async () => {
    localStorage.setItem('sp_dev_cam', 'cam3');
    const h = montar();
    act(() => h.result.current.toggleVideo());
    expect(sp.sipSetVideo).toHaveBeenCalledWith(true);
    expect(h.result.current.videoOn).toBe(false);
    await act(async () => { cb.evt({ type: 'video', state: 'on' }); await new Promise((r) => setTimeout(r, 0)); });
    expect(h.result.current.videoOn).toBe(true);
    expect(motorVideo.startRemote).toHaveBeenCalled();
    expect(motorVideo.startLocal).toHaveBeenCalledWith('cam3');
    expect(h.result.current.getRemoteStream()).toBe('remoto');
    expect(h.result.current.getLocalStream()).toBe('local');
    // los cuadros codificados y el pedido de keyframe van al main
    videoOpts.sendFrame('B64', 90);
    videoOpts.requestKeyframe();
    expect(sp.sipVideoOut).toHaveBeenCalledWith('B64', 90);
    expect(sp.sipVideoKeyframe).toHaveBeenCalled();
    cb.video('NAL');
    expect(motorVideo.onNal).toHaveBeenCalledWith('NAL');
    evento({ type: 'video-keyframe' });
    expect(motorVideo.forceKeyframe).toHaveBeenCalled();
    await act(async () => { cb.evt({ type: 'video', state: 'on' }); });   // ya arrancado: no duplica
    expect(motorVideo.startRemote).toHaveBeenCalledTimes(1);
    evento({ type: 'call', state: 'ended' });
    expect(motorVideo.stop).toHaveBeenCalled();
    expect(h.result.current.videoOn).toBe(false);
  });

  it('cámara rechazada: dice por qué (llamada cifrada o el otro lado no quiso)', () => {
    const h = montar();
    evento({ type: 'video', state: 'off', error: 'srtp' });
    expect(h.result.current.note).toBe('La cámara no se puede encender en una llamada cifrada');
    evento({ type: 'video', state: 'off', error: 'rechazado' });
    expect(h.result.current.note).toBe('El otro lado no aceptó video');
    evento({ type: 'video', state: 'off', error: 'otro' });
    expect(h.result.current.note).toBe('El otro lado no aceptó video');
  });

  it('si el motor de video falla al arrancar, lo registra', async () => {
    motorVideo.startLocal.mockRejectedValueOnce(new Error('sin cámara'));
    montar();
    await act(async () => { cb.evt({ type: 'video', state: 'on' }); await new Promise((r) => setTimeout(r, 0)); });
    expect(console.error).toHaveBeenCalledWith('[sipnat] video', expect.any(Error));
    delete sp.sipVideoOut; delete sp.sipVideoKeyframe;
    expect(() => { videoOpts.sendFrame('x', 1); videoOpts.requestKeyframe(); }).not.toThrow();
  });

  it('altavoz: busca el parlante por nombre o vuelve al auricular; respeta el elegido', async () => {
    const devs = [{ kind: 'audiooutput', deviceId: 'default', label: 'Default' }, { kind: 'audiooutput', deviceId: 'ear', label: 'Auricular' }, { kind: 'audiooutput', deviceId: 'spk', label: 'Altavoz' }];
    navigator.mediaDevices.enumerateDevices.mockResolvedValue(devs);
    const h = montar();
    const el = { setSinkId: vi.fn(async () => {}), play: vi.fn(async () => {}), muted: true };
    h.result.current.audioRef.current = el;
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('spk');
    expect(h.result.current.speaker).toBe(true);
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('ear');
    navigator.mediaDevices.enumerateDevices.mockResolvedValue([{ kind: 'audiooutput', deviceId: 'default' }, { kind: 'audiooutput', deviceId: 'hp' }]);
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('hp');
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('default');
    navigator.mediaDevices.enumerateDevices.mockResolvedValue([]);
    el.setSinkId.mockClear();
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).not.toHaveBeenCalled();
    localStorage.setItem('sp_dev_speaker', 'elegido');
    await act(async () => { await h.result.current.toggleSpeaker(); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('elegido');
    await act(async () => { await h.result.current.applySpeaker('x'); await h.result.current.applySpeaker(''); });
    expect(el.setSinkId).toHaveBeenLastCalledWith('default');
    el.setSinkId.mockRejectedValue(new Error('x'));
    await act(async () => { await h.result.current.applySpeaker('x'); await h.result.current.toggleSpeaker(); });
    h.result.current.audioRef.current = { muted: true, play: () => Promise.reject(new Error('x')) };
    await act(async () => { await h.result.current.toggleSpeaker(); });
    h.result.current.audioRef.current = null;
    await act(async () => { await h.result.current.toggleSpeaker(); await h.result.current.applySpeaker('x'); });
  });
});

describe('historial', () => {
  it('carga lo guardado, tolera basura y se borra', () => {
    localStorage.setItem('sp_hist', '[{"number":"1"}]');
    const h = montar();
    expect(h.result.current.hist).toEqual([{ number: '1' }]);
    act(() => h.result.current.clearHist());
    expect(h.result.current.hist).toEqual([]);
    localStorage.setItem('sp_hist', '{x');
    expect(montar().result.current.hist).toEqual([]);
  });
});

describe('robustez ante fallas de costado', () => {
  it('con localStorage bloqueado el hook monta igual (volumen 1, historial en memoria)', () => {
    const orig = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } }, configurable: true, writable: true });
    try {
      const h = montar();
      expect(h.result.current.volume).toBe(1);
      evento({ type: 'call', state: 'incoming', number: '1' });
      evento({ type: 'call', state: 'ended' });
      expect(h.result.current.hist[0].missed).toBe(true);
      act(() => h.result.current.setVolume(0.2));
      expect(h.result.current.volume).toBe(0.2);
    } finally { Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true, writable: true }); }
  });

  it('si el puente del main tira en cada llamada, los botones no rompen', async () => {
    for (const k of Object.keys(sp)) if (k.startsWith('sip')) sp[k] = vi.fn(() => { throw new Error('ipc'); });
    const h = montar();
    await act(async () => { expect(await h.result.current.placeCall('1')).toEqual({ ok: true }); });
    expect(() => act(() => {
      h.result.current.accept(); h.result.current.reject(); h.result.current.hangup(); h.result.current.toggleMute();
      h.result.current.sendDtmf('1'); h.result.current.toggleVideo(); h.result.current.toggleHold(); h.result.current.transfer('2'); h.result.current.disconnect();
    })).not.toThrow();
    await act(async () => { cb.evt({ type: 'video', state: 'on' }); await new Promise((r) => setTimeout(r, 0)); });
    expect(() => { videoOpts.sendFrame('x', 1); videoOpts.requestKeyframe(); }).not.toThrow();
  });

  it('motor de video que tira al pedir keyframe, al recibir NAL o al pararse', async () => {
    const h = montar();
    evento({ type: 'video-keyframe' });   // sin video: nada
    cb.video('x');
    await act(async () => { cb.evt({ type: 'video', state: 'on' }); await new Promise((r) => setTimeout(r, 0)); });
    motorVideo.forceKeyframe.mockImplementationOnce(() => { throw new Error('x'); });
    motorVideo.onNal.mockImplementationOnce(() => { throw new Error('x'); });
    motorVideo.stop.mockImplementationOnce(() => { throw new Error('x'); });
    evento({ type: 'video-keyframe' });
    cb.video('x');
    evento({ type: 'video', state: 'off' });
    expect(h.result.current.videoOn).toBe(false);
  });

  it('consola rota: los errores de audio y video se tragan igual', async () => {
    console.error.mockImplementation(() => { throw new Error('consola'); });
    gum.mockRejectedValueOnce(new Error('mic'));
    motorVideo.startLocal.mockRejectedValueOnce(new Error('cam'));
    const h = montar();
    await atendida(h);
    await act(async () => { cb.evt({ type: 'video', state: 'on' }); await new Promise((r) => setTimeout(r, 0)); });
    expect(h.result.current.call).toBe('answered');
  });

  it('cortar con un audio que falla al cerrarse no deja la llamada colgada', async () => {
    const h = montar();
    await atendida(h);
    procesadores[0].disconnect.mockImplementation(() => { throw new Error('x'); });
    procesadores[1].disconnect.mockImplementation(() => { throw new Error('x'); });
    micTrack.stop.mockImplementation(() => { throw new Error('x'); });
    ctx.close.mockImplementation(() => { throw new Error('x'); });
    evento({ type: 'call', state: 'ended' });
    expect(h.result.current.call).toBeNull();
  });

  it('con webkitAudioContext (y contexto ya activo) también hay audio y tono', async () => {
    delete window.AudioContext;
    ctx.state = 'running';
    window.webkitAudioContext = vi.fn(() => ctx);
    const h = montar();
    await atendida(h);
    act(() => h.result.current.sendDtmf('#'));
    expect(window.webkitAudioContext).toHaveBeenCalledTimes(2);
    expect(ctx.resume).not.toHaveBeenCalled();
    delete window.webkitAudioContext;
  });

  it('muestras faltantes cuentan como silencio al convertir', async () => {
    const h = montar();
    await atendida(h);
    const cap = procesadores[0];
    const entrada = [undefined, 0.5, undefined, 0.5];
    cap.onaudioprocess({ inputBuffer: { getChannelData: () => entrada } });
    const i16 = new Int16Array(Uint8Array.from(atob(sp.sipAudioOut.mock.calls[0][0]), (c) => c.charCodeAt(0)).buffer);
    expect([...i16]).toEqual([0, 0]);
    // un solo valor entrante: la interpolación no lee fuera del buffer
    cb.audio(btoa(String.fromCharCode(...new Uint8Array(new Int16Array([0]).buffer))));
    const out = new Float32Array(2);
    procesadores[1].onaudioprocess({ outputBuffer: { getChannelData: () => out } });
    expect([...out]).toEqual([0, 0]);
  });
});
