// Sonidos de interfaz + ring/ringback (WebAudio, sin assets).
let ctx = null;
function ac() {
  try { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch (_) {}
  return ctx;
}
let uiOn = true, ringOn = true;
export function setUiSounds(v) { uiOn = !!v; }
export function setRingSounds(v) { ringOn = !!v; }

function blip(freq, dur, type = 'sine', gain = 0.06) {
  const c = ac(); if (!c) return;
  try {
    const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = freq; o.connect(g); g.connect(c.destination);
    const t = c.currentTime; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  } catch (_) {}
}
export function uiClick() { if (uiOn) blip(300, 0.045, 'triangle', 0.045); }
export function uiKey() { if (uiOn) blip(680, 0.055, 'sine', 0.06); }
export function uiToggle() { if (uiOn) blip(520, 0.05, 'sine', 0.05); }

// Cadencia de tono (para ring/ringback): tono(s) `on` seg, silencio `off` seg, en loop.
function cadence(freqs, onSec, offSec, gain) {
  const c = ac(); if (!c) return () => {}; let stopped = false, iv = null;
  const cycle = () => {
    if (stopped) return;
    try {
      const t = c.currentTime, g = c.createGain(); g.connect(c.destination);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.04); g.gain.setValueAtTime(gain, t + onSec - 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + onSec);
      freqs.forEach(f => { const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + onSec + 0.03); });
    } catch (_) {}
  };
  cycle(); iv = setInterval(cycle, (onSec + offSec) * 1000);
  return () => { stopped = true; if (iv) clearInterval(iv); };
}
let rbStop = null, irStop = null;
export function startRingback() { if (!ringOn) return; stopRingback(); rbStop = cadence([440, 480], 1.0, 2.0, 0.05); }
export function stopRingback() { if (rbStop) { rbStop(); rbStop = null; } }
export function startIncomingRing() { if (!ringOn) return; stopIncomingRing(); irStop = cadence([440, 480], 1.2, 0.8, 0.14); }
export function stopIncomingRing() { if (irStop) { irStop(); irStop = null; } }
