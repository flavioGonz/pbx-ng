/* RTP de video H.264 del modo SIP nativo (electron/rtp-video.cjs), probado de punta a
 * punta por UDP en 127.0.0.1: empaquetado RFC 6184 (NAL simple, FU-A para los cuadros
 * grandes, STAP-A al recibir), reensamblado exacto del cuadro y el pedido de keyframe
 * (PLI) por RTCP. Un FU-A mal armado es imagen rota o congelada en el portero. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { parLibre, hasta, socketUdp } from './helpers/logica-red.js';
const require = createRequire(import.meta.url);
const createVideoRtp = require('../electron/rtp-video.cjs');

const abiertos = [];
afterEach(() => { while (abiertos.length) { try { abiertos.pop().stop(); } catch {} } });

async function par() {
  const pa = await parLibre(), pb = await parLibre();
  const recibidos = [], plis = [];
  const log = vi.fn();
  const A = createVideoRtp({ log }), B = createVideoRtp();
  A.start({ remoteIp: '127.0.0.1', remotePort: pb, localPort: pa, pt: 97, onFrame: (au) => recibidos.push(['A', au]), onPli: () => plis.push('A') });
  B.start({ remoteIp: '127.0.0.1', remotePort: pa, localPort: pb, onFrame: (au) => recibidos.push(['B', au]), onPli: () => plis.push('B') });
  abiertos.push(A, B);
  return { A, B, pa, pb, recibidos, plis, log };
}
const SC = Buffer.from([0, 0, 0, 1]);

describe('splitNals', () => {
  it('parte Annex-B con start codes de 3 y 4 bytes e ignora basura inicial', () => {
    const { splitNals } = createVideoRtp();
    const b = Buffer.from([9, 9, 0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0, 0, 0, 1, 0x65, 4]);
    expect(splitNals(b).map((x) => [...x])).toEqual([[0x67, 1, 2], [0x68, 3], [0x65, 4]]);
    expect(splitNals(Buffer.from([1, 2, 3]))).toEqual([]);
  });
});

describe('ida y vuelta por UDP', () => {
  it('un cuadro con varios NAL chicos llega idéntico, con el PT y el marker al final', async () => {
    const { A, recibidos, log } = await par();
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('pt 97'));
    const au = Buffer.concat([SC, Buffer.from([0x67, 1, 2, 3]), SC, Buffer.from([0x68, 4]), SC, Buffer.from([0x65, 5, 6, 7])]);
    A.sendFrame(au, 90000);
    const [, got] = await hasta(() => recibidos.find((r) => r[0] === 'B'));
    expect(got.equals(au)).toBe(true);
  });

  it('un NAL grande se fragmenta en FU-A y se reensambla exacto', async () => {
    const { A, recibidos } = await par();
    const nal = Buffer.alloc(4000); nal[0] = 0x65; for (let i = 1; i < nal.length; i++) nal[i] = i & 0xff;
    A.sendFrame(new Uint8Array(Buffer.concat([SC, nal])), 1);
    const [, got] = await hasta(() => recibidos.find((r) => r[0] === 'B'));
    expect(got.equals(Buffer.concat([SC, nal]))).toBe(true);
  });

  it('PLI: pedir keyframe le avisa al otro lado', async () => {
    const { A, B, plis } = await par();
    A.requestKeyframe();
    B.requestKeyframe();
    await hasta(() => plis.length === 2);
    expect(plis.sort()).toEqual(['A', 'B']);
  });

  it('recibe STAP-A, ignora paquetes cortos, FU-A sin inicio y RTCP que no es PLI', async () => {
    const { pb, recibidos, plis } = await par();
    const s = await socketUdp();
    const hdr = (marker) => { const h = Buffer.alloc(12); h[0] = 0x80; h[1] = 96 | (marker ? 0x80 : 0); return h; };
    const stap = Buffer.concat([hdr(true), Buffer.from([24, 0, 2, 0x67, 1, 0, 1, 0x68, 0, 9, 1])]); // el último tamaño se pasa
    s.send(Buffer.alloc(12), pb, '127.0.0.1');
    s.send(Buffer.concat([hdr(false), Buffer.from([28, 0x05, 1, 2])]), pb, '127.0.0.1');   // FU-A medio, sin S
    s.send(Buffer.concat([hdr(false), Buffer.from([0])]), pb, '127.0.0.1');               // tipo 0: se ignora
    s.send(stap, pb, '127.0.0.1');
    const rr = Buffer.alloc(8); rr[0] = 0x80; rr[1] = 201; rr.writeUInt16BE(1, 2);
    const fir = Buffer.alloc(12); fir[0] = 0x84; fir[1] = 206; fir.writeUInt16BE(2, 2);
    const cero = Buffer.alloc(4); cero[1] = 200; // largo 0 => avanza 4
    s.send(Buffer.concat([rr, fir, cero]), pb + 1, '127.0.0.1');
    const [, got] = await hasta(() => recibidos.find((r) => r[0] === 'B'));
    expect([...got]).toEqual([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68]);
    await new Promise((r) => setTimeout(r, 30));
    expect(plis).toEqual([]);
    s.close();
  });
});

describe('ciclo de vida', () => {
  it('sin arrancar o después de parar no manda nada ni rompe', async () => {
    const v = createVideoRtp();
    expect(() => { v.sendFrame(Buffer.from([0, 0, 0, 1, 0x65]), 0); v.requestKeyframe(); v.stop(); }).not.toThrow();
    const p = await parLibre();
    v.start({ remoteIp: '127.0.0.1', remotePort: p, localPort: p });
    v.sendFrame(Buffer.from([1, 2, 3]), 0);    // sin NAL: no manda
    v.start({ remoteIp: '127.0.0.1', remotePort: p, localPort: p });  // re-arranque cierra el anterior
    v.stop(); v.stop();
  });

  it('los callbacks que explotan no tiran abajo el socket', async () => {
    const pa = await parLibre(), pb = await parLibre();
    const A = createVideoRtp(), B = createVideoRtp();
    let n = 0;
    A.start({ remoteIp: '127.0.0.1', remotePort: pb, localPort: pa });
    B.start({ remoteIp: '127.0.0.1', remotePort: pa, localPort: pb, onFrame: () => { n++; throw new Error('x'); }, onPli: () => { n++; throw new Error('x'); } });
    abiertos.push(A, B);
    A.sendFrame(Buffer.from([0, 0, 1, 0x65, 1]), 0);
    A.requestKeyframe();
    await hasta(() => n === 2);
    A.sendFrame(Buffer.from([0, 0, 1, 0x41, 1]), 0);
    await hasta(() => n === 3);
  });

  it('un puerto ocupado no hace explotar el arranque', async () => {
    const p = await parLibre();
    const ocup = await socketUdp(p);
    const v = createVideoRtp();
    expect(() => v.start({ remoteIp: '127.0.0.1', remotePort: p, localPort: p })).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    v.stop(); ocup.close();
  });
});

describe('robustez de los sockets', () => {
  it('puertos inválidos, envíos que tiran y cierres que tiran no rompen', async () => {
    const v = createVideoRtp();
    // bind con puerto fuera de rango tira de forma sincrónica: se traga
    v.start({ remoteIp: '127.0.0.1', remotePort: 70000, localPort: -10 });
    v.sendFrame(Buffer.from([0, 0, 1, 0x65, 1]), 0);   // send a puerto inválido: se traga
    v.requestKeyframe();
    const dgram = require('dgram');
    const real = dgram.createSocket;
    vi.spyOn(dgram, 'createSocket').mockImplementation((...a) => { const s = real.apply(dgram, a); s.close = () => { throw new Error('x'); }; return s; });
    v.start({ remoteIp: '127.0.0.1', remotePort: 1, localPort: -10 });
    expect(() => v.stop()).not.toThrow();
    vi.restoreAllMocks();
  });
});
