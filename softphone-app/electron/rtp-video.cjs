'use strict';
// ============================================================================
//  PBX-NG Softphone · RTP de video H.264 para el modo SIP nativo (Etapa 1).
//
//  El renderer codifica la cámara a H.264 con WebCodecs y nos manda los cuadros
//  en Annex-B (NAL units con start-code 00 00 00 01). Acá los empaquetamos en
//  RTP según RFC 6184 (single-NAL + FU-A para los NAL grandes), y del lado de
//  recepción reensamblamos los FU-A en un cuadro Annex-B completo que el renderer
//  decodifica. Reloj RTP de video = 90 kHz. Marker bit = fin de cuadro.
//
//  RTCP: mandamos/recibimos por rtpPort+1. Si el otro lado nos pide un keyframe
//  (PLI, PT=206 FMT=1), avisamos al encoder para que emita un IDR.
//
//  Nota: Etapa 1 = RTP/AVP en claro (sin SRTP). El video cifrado (SDES) queda
//  para una etapa siguiente.
// ============================================================================
const dgram = require('dgram');

const MTU = 1400;                       // payload RTP máximo antes de fragmentar (FU-A)
const START = Buffer.from([0, 0, 0, 1]); // start-code Annex-B

// Parte un buffer Annex-B en NAL units (sin el start-code).
function splitNals(buf) {
  const nals = [];
  let i = 0;
  const n = buf.length;
  // encuentra el primer start-code
  function scAt(p) {
    if (p + 3 < n && buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 0 && buf[p + 3] === 1) return 4;
    if (p + 2 < n && buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1) return 3;
    return 0;
  }
  // salta al primer start-code
  while (i < n && !scAt(i)) i++;
  while (i < n) {
    const sc = scAt(i);
    if (!sc) { i++; continue; }
    const start = i + sc;
    let j = start;
    while (j < n && !scAt(j)) j++;
    if (j > start) nals.push(buf.slice(start, j));
    i = j;
  }
  return nals;
}

module.exports = function createVideoRtp(opts) {
  const log = (opts && opts.log) || (() => {});
  let st = null;

  function start(o) {
    stop();
    const sock = dgram.createSocket('udp4');
    const rtcp = dgram.createSocket('udp4');
    st = {
      sock, rtcp,
      remoteIp: o.remoteIp, remotePort: o.remotePort,
      localPort: o.localPort, pt: o.pt || 96,
      ssrc: (Math.random() * 0xffffffff) >>> 0,
      seq: Math.floor(Math.random() * 0xffff),
      onFrame: o.onFrame || (() => {}),
      onPli: o.onPli || (() => {}),
      // reensamblado
      asm: null, asmType: 0, asmNri: 0,
      frame: [],           // NAL units (con start-code) acumulados del access unit
    };

    sock.on('error', () => {});
    sock.on('message', (msg) => { try { onRtp(msg); } catch (_) {} });
    try { sock.bind(o.localPort); } catch (_) {}

    rtcp.on('error', () => {});
    rtcp.on('message', (msg) => { try { onRtcp(msg); } catch (_) {} });
    try { rtcp.bind(o.localPort + 1); } catch (_) {}

    log('info', 'RTP video H.264 pt ' + st.pt + ' → ' + o.remoteIp + ':' + o.remotePort);
  }

  function stop() {
    if (!st) return;
    try { st.sock.close(); } catch (_) {}
    try { st.rtcp.close(); } catch (_) {}
    st = null;
  }

  // -------- envío: Annex-B (un access unit) -> RTP --------
  function sendFrame(annexB, ts90) {
    if (!st) return;
    const nals = splitNals(Buffer.isBuffer(annexB) ? annexB : Buffer.from(annexB));
    if (!nals.length) return;
    for (let k = 0; k < nals.length; k++) {
      const nal = nals[k];
      const lastNal = k === nals.length - 1;
      if (nal.length + 12 <= MTU) {
        sendPacket(nal, ts90, lastNal);           // single NAL unit
      } else {
        // FU-A: parte el NAL (menos su header) en fragmentos
        const hdr = nal[0];
        const f_nri = hdr & 0xe0;                  // F + NRI
        const type = hdr & 0x1f;
        const fuInd = f_nri | 28;                  // FU-A
        let off = 1;
        const body = nal.slice(1);
        const chunk = MTU - 14;                    // 12 RTP + 2 FU
        let idx = 0;
        while (idx < body.length) {
          const piece = body.slice(idx, idx + chunk);
          const isFirst = idx === 0;
          const isLast = idx + piece.length >= body.length;
          let fuHdr = type;
          if (isFirst) fuHdr |= 0x80;              // S
          if (isLast) fuHdr |= 0x40;               // E
          const pl = Buffer.concat([Buffer.from([fuInd, fuHdr]), piece]);
          sendPacket(pl, ts90, lastNal && isLast, true);
          idx += piece.length;
        }
        void off;
      }
    }
  }

  // marker=true en el último paquete del cuadro. raw=true si ya es payload (FU-A).
  function sendPacket(payload, ts90, marker, raw) {
    const pkt = Buffer.alloc(12 + payload.length);
    pkt[0] = 0x80;
    pkt[1] = (st.pt & 0x7f) | (marker ? 0x80 : 0);
    pkt.writeUInt16BE(st.seq & 0xffff, 2);
    pkt.writeUInt32BE(ts90 >>> 0, 4);
    pkt.writeUInt32BE(st.ssrc >>> 0, 8);
    payload.copy(pkt, 12);
    st.seq = (st.seq + 1) & 0xffff;
    try { st.sock.send(pkt, st.remotePort, st.remoteIp); } catch (_) {}
  }

  // -------- recepción: RTP -> Annex-B (access unit completo) --------
  function onRtp(msg) {
    if (msg.length < 13) return;
    const marker = (msg[1] & 0x80) !== 0;
    const payload = msg.slice(12);
    const nalType = payload[0] & 0x1f;

    if (nalType >= 1 && nalType <= 23) {
      // single NAL unit
      st.frame.push(START, payload);
    } else if (nalType === 28) {
      // FU-A
      const fuHdr = payload[1];
      const start = (fuHdr & 0x80) !== 0;
      const end = (fuHdr & 0x40) !== 0;
      const origType = fuHdr & 0x1f;
      if (start) {
        const nalHdr = (payload[0] & 0xe0) | origType;
        st.asm = [Buffer.from([nalHdr])];
      }
      if (st.asm) st.asm.push(payload.slice(2));
      if (end && st.asm) {
        st.frame.push(START, Buffer.concat(st.asm));
        st.asm = null;
      }
    } else if (nalType === 24) {
      // STAP-A (NALs agregados): [16b size][NAL]...
      let p = 1;
      while (p + 2 <= payload.length) {
        const sz = payload.readUInt16BE(p); p += 2;
        if (p + sz > payload.length) break;
        st.frame.push(START, payload.slice(p, p + sz)); p += sz;
      }
    }

    if (marker && st.frame.length) {
      const au = Buffer.concat(st.frame);
      st.frame = [];
      try { st.onFrame(au); } catch (_) {}
    }
  }

  // -------- RTCP: detectar PLI (pedido de keyframe) --------
  function onRtcp(msg) {
    let off = 0;
    while (off + 4 <= msg.length) {
      const pt = msg[off + 1];
      const len = (msg.readUInt16BE(off + 2) + 1) * 4;
      if (pt === 206) {                     // PSFB
        const fmt = msg[off] & 0x1f;
        if (fmt === 1) { try { st.onPli(); } catch (_) {} } // PLI
      }
      off += len || 4;
    }
  }

  // Pedirle al otro lado un keyframe (PLI saliente).
  function requestKeyframe() {
    if (!st) return;
    const buf = Buffer.alloc(12);
    buf[0] = 0x81; buf[1] = 206; buf.writeUInt16BE(2, 2);
    buf.writeUInt32BE(st.ssrc >>> 0, 4);
    buf.writeUInt32BE((st.remoteSsrc || 0) >>> 0, 8);
    try { st.rtcp.send(buf, st.remotePort + 1, st.remoteIp); } catch (_) {}
  }

  return { start, stop, sendFrame, requestKeyframe, splitNals };
};
