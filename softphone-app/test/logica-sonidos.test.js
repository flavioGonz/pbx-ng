/* Sonidos de interfaz y timbres (src/sounds.js) y animaciones (src/anim.js). El timbre
 * entrante y el ringback tienen que poder apagarse desde Ajustes y, sobre todo, DEJAR de
 * sonar cuando la llamada se atiende o corta: un ring que sigue sonando es el reclamo
 * clásico. Sin AudioContext (navegador raro) no tiene que romper nada. */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

function fakeCtx() {
  const osc = [];
  const ctx = {
    state: 'suspended', currentTime: 0, destination: {},
    resume: vi.fn(),
    createOscillator: vi.fn(() => { const o = { frequency: {}, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }; osc.push(o); return o; }),
    createGain: vi.fn(() => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() })),
  };
  return { ctx, osc };
}

let s, f;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  f = fakeCtx();
  window.AudioContext = vi.fn(() => f.ctx);
  s = await import('../src/sounds.js');
});
afterEach(() => { vi.useRealTimers(); delete window.AudioContext; delete window.webkitAudioContext; });

describe('sonidos de interfaz', () => {
  it('click, tecla y toggle tocan un tono cada uno y reanudan el contexto suspendido', () => {
    s.uiClick(); s.uiKey(); s.uiToggle();
    expect(f.osc.map((o) => o.frequency.value)).toEqual([300, 680, 520]);
    expect(f.osc[0].type).toBe('triangle');
    expect(f.ctx.resume).toHaveBeenCalled();
    expect(window.AudioContext).toHaveBeenCalledTimes(1);
  });

  it('apagados desde Ajustes no suenan', () => {
    s.setUiSounds(false);
    s.uiClick(); s.uiKey(); s.uiToggle();
    expect(f.osc).toHaveLength(0);
    s.setUiSounds(true);
    s.uiKey();
    expect(f.osc).toHaveLength(1);
  });

  it('sin AudioContext no rompe', async () => {
    vi.resetModules();
    delete window.AudioContext;
    const s2 = await import('../src/sounds.js');
    expect(() => { s2.uiClick(); s2.startRingback(); s2.stopRingback(); }).not.toThrow();
  });

  it('si el oscilador explota, se traga el error', () => {
    f.ctx.createOscillator = () => { throw new Error('x'); };
    expect(() => { s.uiClick(); s.startIncomingRing(); vi.advanceTimersByTime(2000); s.stopIncomingRing(); }).not.toThrow();
  });
});

describe('timbres', () => {
  it('el ringback repite cada 3 s (1 s tono + 2 s silencio) hasta que se para', () => {
    s.startRingback();
    expect(f.osc.length).toBe(2);   // 440 + 480
    vi.advanceTimersByTime(3000);
    expect(f.osc.length).toBe(4);
    s.stopRingback();
    vi.advanceTimersByTime(9000);
    expect(f.osc.length).toBe(4);
    s.stopRingback(); // doble stop no rompe
  });

  it('el ring entrante repite cada 2 s y arrancarlo de nuevo no duplica', () => {
    s.startIncomingRing();
    s.startIncomingRing();
    expect(f.osc.length).toBe(4);
    vi.advanceTimersByTime(2000);
    expect(f.osc.length).toBe(6);    // un solo ciclo vivo, no dos
    s.stopIncomingRing();
    vi.advanceTimersByTime(4000);
    expect(f.osc.length).toBe(6);
  });

  it('con los timbres apagados no suena nada', () => {
    s.setRingSounds(false);
    s.startRingback(); s.startIncomingRing();
    expect(f.osc).toHaveLength(0);
  });

  it('usa webkitAudioContext si es lo único que hay', async () => {
    vi.resetModules();
    delete window.AudioContext;
    window.webkitAudioContext = vi.fn(() => ({ ...f.ctx, state: 'running' }));
    const s2 = await import('../src/sounds.js');
    s2.uiClick();
    expect(window.webkitAudioContext).toHaveBeenCalled();
  });
});

describe('animaciones (gsap)', () => {
  it('cada helper anima el elemento y no hace nada con null', async () => {
    const gsap = { fromTo: vi.fn(), from: vi.fn(), timeline: vi.fn(), context: vi.fn() };
    const tl = { from: vi.fn(() => tl) };
    gsap.timeline.mockReturnValue(tl);
    const revert = vi.fn();
    gsap.context.mockImplementation((fn) => { fn(); return { revert }; });
    vi.doMock('gsap', () => ({ gsap }));
    const a = await import('../src/anim.js');
    const el = { children: [1, 2] };
    a.gEnter(el); a.gPop(el); a.gModal(el); a.gStagger(el);
    a.gEnter(null); a.gPop(null); a.gModal(null); a.gStagger(null);
    expect(gsap.fromTo).toHaveBeenCalledTimes(3);
    expect(gsap.from).toHaveBeenCalledWith([1, 2], expect.objectContaining({ stagger: 0.045 }));
    const stop = a.gSplash(el);
    expect(tl.from).toHaveBeenCalledTimes(3);
    stop();
    expect(revert).toHaveBeenCalled();
    expect(typeof a.gSplash(null)).toBe('function');
    a.gSplash(null)();
    vi.doUnmock('gsap');
  });
});
