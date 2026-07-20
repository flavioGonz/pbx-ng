// ============================================================================
//  Video para el modo SIP nativo (Etapa 2) — WebCodecs en el renderer.
//
//  Salida (cámara → red):  getUserMedia(video) → MediaStreamTrackProcessor →
//    VideoEncoder(H.264, Annex-B) → cuadros codificados → main (sipVideoOut) → RTP.
//  Entrada (red → pantalla): main (onSipVideo, Annex-B) → VideoDecoder →
//    VideoFrame → se dibuja en un <canvas> cuyo captureStream() alimenta el <video>.
//
//  H.264 en formato Annex-B: los keyframes llevan SPS/PPS en banda, así el decoder
//  arranca sin `description`. Si llega delta antes del primer keyframe, pedimos PLI.
// ============================================================================

function u8ToB64(u8) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(bin);
}
function b64ToU8(b64) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
// ¿el access unit trae un IDR (NAL type 5) o parámetros (7/8)? → es keyframe
function esKeyframe(u8) {
  for (let i = 0; i + 4 < u8.length; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && ((u8[i + 2] === 1) || (u8[i + 2] === 0 && u8[i + 3] === 1))) {
      const p = u8[i + 2] === 1 ? i + 3 : i + 4;
      const t = u8[p] & 0x1f;
      if (t === 5 || t === 7) return true;
      if (t === 1) return false;
    }
  }
  return false;
}

const CODECS = ['avc1.42e01f', 'avc1.42001f', 'avc1.4d401f'];

export function createNativeVideo({ sendFrame, requestKeyframe, width = 640, height = 480, fps = 20, bitrate = 800000 }) {
  let enc = null, dec = null, camStream = null, reader = null, running = false;
  let canvas = null, cctx = null, capStream = null;
  let needKey = false, decReady = false, lastKeyReq = 0, tsCounter = 0;

  async function pickEncoderCodec() {
    for (const c of CODECS) {
      try {
        const cfg = { codec: c, width, height, bitrate, framerate: fps, avc: { format: 'annexb' }, latencyMode: 'realtime' };
        if (window.VideoEncoder && VideoEncoder.isConfigSupported) {
          const s = await VideoEncoder.isConfigSupported(cfg);
          if (s && s.supported) return c;
        } else return c;
      } catch (_) {}
    }
    return CODECS[0];
  }

  async function startLocal(deviceId) {
    if (!window.VideoEncoder || !window.MediaStreamTrackProcessor) { console.warn('[video] WebCodecs no disponible'); return null; }
    camStream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { ideal: deviceId }, width, height, frameRate: fps } : { width, height, frameRate: fps },
      audio: false,
    });
    const codec = await pickEncoderCodec();
    enc = new VideoEncoder({
      output: (chunk) => {
        try {
          const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf);
          const ts90 = Math.round((chunk.timestamp / 1e6) * 90000) >>> 0;   // µs → 90 kHz
          sendFrame(u8ToB64(buf), ts90);
        } catch (_) {}
      },
      error: (e) => { try { console.error('[video] encoder', e); } catch (_) {} },
    });
    enc.configure({ codec, width, height, bitrate, framerate: fps, avc: { format: 'annexb' }, latencyMode: 'realtime' });

    const track = camStream.getVideoTracks()[0];
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    running = true;
    let n = 0;
    (async () => {
      while (running) {
        let res; try { res = await reader.read(); } catch (_) { break; }
        if (res.done) break;
        const frame = res.value;
        try {
          if (enc && enc.state === 'configured') {
            const key = needKey || (n % (fps * 2) === 0);   // keyframe pedido, o uno cada ~2 s
            needKey = false; n++;
            enc.encode(frame, { keyFrame: key });
          }
        } catch (_) {}
        try { frame.close(); } catch (_) {}
      }
    })();
    return camStream;
  }

  function startRemote() {
    canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    cctx = canvas.getContext('2d');
    capStream = canvas.captureStream(fps);
    dec = new VideoDecoder({
      output: (frame) => {
        try {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
          cctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        } catch (_) {}
        try { frame.close(); } catch (_) {}
      },
      error: (e) => { try { console.warn('[video] decoder', e); } catch (_) {} pedirKey(); },
    });
    try { dec.configure({ codec: 'avc1.42e01f', optimizeForLatency: true }); } catch (_) { try { dec.configure({ codec: 'avc1.42001f' }); } catch (_) {} }
    return capStream;
  }

  function pedirKey() {
    const now = Date.now();
    if (now - lastKeyReq < 800) return;   // no floodear PLI
    lastKeyReq = now;
    try { requestKeyframe && requestKeyframe(); } catch (_) {}
  }

  // Annex-B (base64) desde el main → decoder
  function onNal(b64) {
    if (!dec) return;
    let data; try { data = b64ToU8(b64); } catch (_) { return; }
    const key = esKeyframe(data);
    if (!decReady) { if (!key) { pedirKey(); return; } decReady = true; }
    try {
      dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (tsCounter += 33333), data }));
    } catch (_) { decReady = false; pedirKey(); }
  }

  function forceKeyframe() { needKey = true; }   // el otro lado pidió un IDR

  function stop() {
    running = false;
    try { reader && reader.cancel(); } catch (_) {}
    try { enc && enc.state !== 'closed' && enc.close(); } catch (_) {}
    try { dec && dec.state !== 'closed' && dec.close(); } catch (_) {}
    try { camStream && camStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { capStream && capStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    enc = dec = camStream = reader = canvas = cctx = capStream = null;
    decReady = false; needKey = false; tsCounter = 0;
  }

  return {
    startLocal, startRemote, onNal, forceKeyframe, stop,
    getLocalStream: () => camStream,
    getRemoteStream: () => capStream,
  };
}
