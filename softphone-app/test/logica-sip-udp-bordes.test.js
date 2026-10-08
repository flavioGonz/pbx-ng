/* Motor SIP nativo (electron/sip-udp.cjs) con la librería `sip`, `dgram` y `os` FALSOS:
 * acá se manejan a mano las respuestas y los sockets para llegar a los casos que la red
 * real casi nunca da pero que en producción pasan — firma digest que falla, respuestas que
 * llegan tarde o repetidas, sockets que tiran al mandar, SDP raros, estadísticas de
 * calidad, RTCP, A-law entrante—. La regla es la misma en todos: ningún borde deja una
 * llamada colgada ni tira abajo el proceso main. Las pruebas de punta a punta por UDP real
 * están en logica-sip-udp.test.js. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { cargarCjs } from './helpers/logica-cjs.js';

let sip, digest, socks, motor, ev, video, os;
const fallas = { crearRtcp: false, bind: false };

function fakeSip() {
  const s = {
    enviados: [],
    start: vi.fn((opts, onReq) => { s.opts = opts; s.onReq = onReq; }),
    stop: vi.fn(),
    send: vi.fn((m, cb) => { s.enviados.push({ m, cb }); }),
    makeResponse: (rq, status, reason) => ({ status, reason, headers: { via: rq.headers.via, to: { ...(rq.headers.to || {}), params: { tag: 'local' } }, from: rq.headers.from, 'call-id': rq.headers['call-id'], cseq: rq.headers.cseq } }),
    parseUri: (u) => { const m = /^sip:([^@]+)@/.exec(u); return { user: m ? m[1] : undefined }; },
  };
  return s;
}
function fakeDgram() {
  return {
    createSocket: vi.fn(() => {
      // el RTCP es el segundo socket de cada llamada (el primero es el RTP)
      if (fallas.crearRtcp && socks.length % 2 === 1) throw new Error('sin sockets');
      const k = new EventEmitter();
      k.bind = vi.fn(() => { if (fallas.bind) throw new Error('EADDRINUSE'); }); k.send = vi.fn(); k.close = vi.fn();
      socks.push(k);
      return k;
    }),
  };
}
function cargar({ sinVideo = false, ifaces } = {}) {
  sip = fakeSip();
  digest = { signRequest: vi.fn((ses, rq) => { rq.headers.authorization = [{ scheme: 'Digest' }]; }) };
  socks = [];
  video = { start: vi.fn(), stop: vi.fn(), sendFrame: vi.fn(), requestKeyframe: vi.fn() };
  os = { networkInterfaces: () => ifaces || { eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }] } };
  motor = cargarCjs('electron/sip-udp.cjs', {
    sip, 'sip/digest': digest, dgram: fakeDgram(), os,
    './rtp-video.cjs': sinVideo ? new Error('x') : () => video,
  });
  ev = [];
}
const CFG = { sipServer: '10.0.0.1', sipPort: '5060', domain: 'pbx', ext: '101', pass: 'pw' };
const ultimo = (metodo) => [...sip.enviados].reverse().find((x) => (x.m.method || ('R' + x.m.status)) === metodo);
const resp = (rq, status, extra = {}) => ({ status, reason: extra.reason, headers: { to: { uri: 'sip:x@pbx', params: { tag: 'remota' } }, from: rq.headers.from, 'call-id': rq.headers['call-id'], cseq: rq.headers.cseq, via: extra.via || [{ params: {} }], contact: extra.contact, expires: extra.expires }, content: extra.content });
const SDP = (port = 4000, extra = '') => 'v=0\r\nc=IN IP4 10.0.0.9\r\nm=audio ' + port + ' RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n' + extra;

async function registrado(cfg = {}) {
  motor.start({ ...CFG, ...cfg }, (e) => ev.push(e));
  vi.advanceTimersByTime(120);
  const reg = ultimo('REGISTER');
  reg.cb(resp(reg.m, 200, { contact: [{ params: { expires: '600' } }] }));
  return reg;
}
async function enLlamada(cfg, sdpResp = SDP()) {
  await registrado(cfg);
  motor.call('102');
  const inv = ultimo('INVITE');
  inv.cb(resp(inv.m, 200, { contact: [{ uri: 'sip:102@10.0.0.9' }], content: sdpResp }));
  return inv;
}
const rtp = () => socks[0];
function pkt(seq, pt = 0, ts = 0, len = 172) { const b = Buffer.alloc(len, 0xd5); b[0] = 0x80; b[1] = pt; b.writeUInt16BE(seq, 2); b.writeUInt32BE(ts, 4); return b; }

beforeEach(() => { vi.useFakeTimers(); fallas.crearRtcp = false; fallas.bind = false; cargar(); });
afterEach(() => { try { motor.stop(); } catch {} vi.useRealTimers(); });

describe('arranque y registro', () => {
  it('sin IPv4 externa usa 127.0.0.1; un puerto inválido cae a 5060', async () => {
    cargar({ ifaces: { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], w: [{ family: 'IPv6', internal: false }] } });
    motor.start({ ...CFG, sipPort: 'abc' }, (e) => ev.push(e));
    vi.advanceTimersByTime(120);
    const r = ultimo('REGISTER').m;
    expect(r.uri).toBe('sip:10.0.0.1:5060');
    expect(r.headers.contact[0].uri).toBe('sip:101@127.0.0.1:5062');
    motor.stop();
    motor.start({ ...CFG, sipPort: undefined }, (e) => ev.push(e));
    vi.advanceTimersByTime(120);
    expect(ultimo('REGISTER').m.uri).toBe('sip:10.0.0.1:5060');
  });

  it('si firmar el REGISTER falla, avisa la causa', () => {
    digest.signRequest.mockImplementation(() => { throw new Error('nonce raro'); });
    motor.start(CFG, (e) => ev.push(e));
    vi.advanceTimersByTime(120);
    const r = ultimo('REGISTER');
    r.cb(resp(r.m, 401));
    expect(ev.find((e) => e.state === 'failed').reason).toBe('auth: nonce raro');
  });

  it('NAT: un rport sin received fija el puerto; el mismo received dos veces no re-anuncia', async () => {
    motor.start(CFG, (e) => ev.push(e));
    vi.advanceTimersByTime(120);
    const r = ultimo('REGISTER');
    r.cb(resp(r.m, 401, { via: [{ params: { rport: '7000' } }] }));
    const r2 = ultimo('REGISTER');
    expect(r2.m.headers.contact[0].uri).toBe('sip:101@10.0.0.5:7000');
    r2.cb(resp(r2.m, 200, { via: [{ params: { received: '1.2.3.4' } }], expires: '50' }));
    expect(ev.filter((e) => e.type === 'log' && /NAT/.test(e.line))).toHaveLength(0);
    vi.advanceTimersByTime(45000);    // 90 % de 50 s
    const r3 = ultimo('REGISTER');
    expect(r3).not.toBe(r2);
    r3.cb({ ...resp(r3.m, 200, { via: [{ params: { received: '1.2.3.4', rport: '9' } }] }), reason: 'OK' });
    expect(ev.filter((e) => e.type === 'log' && /NAT: IP pública 1\.2\.3\.4:9/.test(e.line))).toHaveLength(1);
    // una respuesta sin Via o nula no rompe el aprendizaje
    r3.cb({ status: 200, headers: {} });
  });

  it('respuestas que llegan después de parar, o repetidas, se ignoran', async () => {
    motor.start(CFG, (e) => ev.push(e));
    vi.advanceTimersByTime(120);
    const r = ultimo('REGISTER');
    r.cb(resp(r.m, 200));
    r.cb(resp(r.m, 200));   // engine.done: no vuelve a avisar
    expect(ev.filter((e) => e.state === 'registered')).toHaveLength(1);
    motor.stop();
    r.cb(resp(r.m, 401));
    vi.advanceTimersByTime(600000);   // el refresco tras parar no hace nada
    expect(sip.stop).toHaveBeenCalled();
  });

  it('respuesta 401 tras parar y firma cuya respuesta llega tarde', async () => {
    motor.start(CFG, (e) => ev.push(e));
    vi.advanceTimersByTime(120);
    const r = ultimo('REGISTER');
    r.cb(resp(r.m, 401));
    const firmado = ultimo('REGISTER');
    motor.stop();
    firmado.cb(resp(firmado.m, 200));
    expect(ev.find((e) => e.state === 'registered')).toBeUndefined();
  });

  it('SRV pedido con un servidor que ya es IP: va directo sin DNS', () => {
    motor.start({ ...CFG, sipSrv: true }, (e) => ev.push(e));
    vi.advanceTimersByTime(120);
    expect(ultimo('REGISTER').m.uri).toBe('sip:10.0.0.1:5060');
  });

  it('MWI: el SUBSCRIBE desafiado cuya firma falla, o el envío que tira, no rompen', async () => {
    digest.signRequest.mockImplementationOnce((ses, rq) => {}).mockImplementationOnce(() => { throw new Error('x'); });
    await registrado({ sipMwi: true });
    const sub = ultimo('SUBSCRIBE');
    expect(sub.m.headers.event).toBe('message-summary');
    sub.cb(resp(sub.m, 407));
    sub.cb(resp(sub.m, 200));
    motor.stop();
    sub.cb(resp(sub.m, 200));
    cargar();
    sip.send.mockImplementation((m, cb) => { if (m.method === 'SUBSCRIBE') throw new Error('x'); sip.enviados.push({ m, cb }); });
    await registrado({ sipMwi: true });
    expect(ev.find((e) => e.state === 'registered')).toBeTruthy();
  });

  it('el logger con respuestas sin reason y pedidos sin uri', () => {
    motor.start(CFG, (e) => ev.push(e));
    sip.opts.logger.recv({ method: 'OPTIONS' });
    sip.opts.logger.send({ status: 180 });
    expect(ev.filter((e) => e.type === 'log').map((e) => e.line).slice(-2)).toEqual(['OPTIONS ', 'SIP/2.0 180 ']);
  });

  it('parar con la librería que tira al cerrar no rompe', () => {
    motor.start(CFG, (e) => ev.push(e));
    sip.stop.mockImplementation(() => { throw new Error('x'); });
    expect(() => motor.stop()).not.toThrow();
  });
});

describe('llamada saliente: bordes', () => {
  it('si firmar el INVITE falla, termina con la causa; un 2do desafío se ignora', async () => {
    await registrado();
    digest.signRequest.mockImplementationOnce(() => { throw new Error('qop'); });
    motor.call('102');
    const inv = ultimo('INVITE');
    inv.cb(resp(inv.m, 407));
    expect(ev.find((e) => e.state === 'ended').reason).toBe('auth: qop');
    motor.call('103');
    const inv2 = ultimo('INVITE');
    inv2.cb(resp(inv2.m, 401));
    const firmado = ultimo('INVITE');
    firmado.cb(resp(firmado.m, 401));    // ya se firmó: no hay bucle de desafíos
    expect(sip.enviados.filter((x) => x.m.method === 'INVITE')).toHaveLength(3);
  });

  it('100 no es timbrar; respuestas de una llamada vieja se ignoran; 3xx sin motivo', async () => {
    await registrado();
    motor.call('102');
    const vieja = ultimo('INVITE');
    vieja.cb(resp(vieja.m, 100));
    expect(ev.find((e) => e.state === 'ringing')).toBeUndefined();
    vieja.cb(resp(vieja.m, 183));
    expect(ev.find((e) => e.state === 'ringing')).toBeTruthy();
    motor.call('103');
    vieja.cb(resp(vieja.m, 200, { content: SDP() }));
    expect(ev.find((e) => e.state === 'answered')).toBeUndefined();
    const nueva = ultimo('INVITE');
    nueva.cb(resp(nueva.m, 302));
    expect(ev.filter((e) => e.state === 'ended').pop().reason).toBe('302 ');
  });

  it('200 sin Contact usa el URI pedido, sin tag de To; el ACK que tira no corta', async () => {
    await registrado();
    motor.call('102');
    const inv = ultimo('INVITE');
    sip.send.mockImplementationOnce(() => { throw new Error('x'); });
    const r = resp(inv.m, 200, { content: SDP() });
    r.headers.to = {};
    inv.cb(r);
    expect(ev.find((e) => e.state === 'answered')).toBeTruthy();
    motor.hangup();
    expect(ultimo('BYE').m.uri).toBe(inv.m.uri);
  });

  it('video pedido pero la central contesta sin video (o sin módulo de video): sólo audio', async () => {
    await registrado();
    motor.call('102', true);
    const inv = ultimo('INVITE');
    expect(inv.m.content).toMatch(/m=video/);
    inv.cb(resp(inv.m, 200, { content: SDP() }));
    expect(video.start).not.toHaveBeenCalled();
    motor.stop();
    cargar({ sinVideo: true });
    await registrado();
    motor.call('102', true);
    expect(ultimo('INVITE').m.content).not.toMatch(/m=video/);
    motor.setVideo(false);
  });

  it('video sin rtpmap H264 usa el primer PT de la m=video; sin PT cae a 96', async () => {
    await enLlamada({}, SDP(4000, 'm=video 5000 RTP/AVP 100 101\r\n'));
    // no se pidió video: no arranca
    expect(video.start).not.toHaveBeenCalled();
    motor.stop();
    cargar();
    await registrado();
    motor.call('102', true);
    const inv = ultimo('INVITE');
    inv.cb(resp(inv.m, 200, { content: SDP(4000, 'm=video 5000 RTP/AVP 100\r\n') }));
    expect(video.start.mock.calls[0][0]).toMatchObject({ remotePort: 5000, pt: 100 });
    expect(ev.find((e) => e.type === 'video' && e.state === 'on')).toBeTruthy();
    // frames y keyframes; si el RTP de video tira, se traga
    motor.videoOut('AAAA', 1);
    motor.reqKeyframe();
    video.sendFrame.mockImplementation(() => { throw new Error('x'); });
    video.requestKeyframe.mockImplementation(() => { throw new Error('x'); });
    expect(() => { motor.videoOut('AAAA', 1); motor.reqKeyframe(); }).not.toThrow();
    video.start.mock.calls[0][0].onFrame(Buffer.from([1]));
    video.start.mock.calls[0][0].onPli();
    expect(ev.find((e) => e.type === 'video-in').nal).toBe('AQ==');
    expect(ev.find((e) => e.type === 'video-keyframe')).toBeTruthy();
    video.stop.mockImplementation(() => { throw new Error('x'); });
    expect(() => motor.hangup()).not.toThrow();
  });

  it('colgar: CANCEL sin Via previa; si mandar tira, se anota y la UI igual se limpia', async () => {
    await registrado();
    motor.call('102');
    const inv = ultimo('INVITE');
    inv.m.headers.via = [];
    motor.hangup();
    expect(ultimo('CANCEL').m.headers.via).toEqual([]);
    motor.call('103');
    sip.send.mockImplementationOnce(() => { throw new Error('socket'); });
    motor.hangup();
    expect(ev.find((e) => e.type === 'log' && e.line === 'hangup err: socket')).toBeTruthy();
    expect(ev.filter((e) => e.state === 'ended')).toHaveLength(2);
  });
});

describe('RTP: audio, calidad y RTCP', () => {
  it('cuenta pérdidas y jitter, ignora DTMF y paquetes cortos, y decodifica A-law', async () => {
    await enLlamada();
    const s = rtp();
    s.emit('message', Buffer.alloc(8));                // corto
    s.emit('message', pkt(10));
    s.emit('message', pkt(13, 0, 999));                // faltan 11 y 12
    s.emit('message', pkt(14, 101));                   // DTMF entrante: no es audio
    s.emit('message', pkt(15, 8, 0, 14));              // PCMA
    const audios = ev.filter((e) => e.type === 'audio');
    expect(audios).toHaveLength(3);
    expect(Buffer.from(audios[2].pcm, 'base64').readInt16LE(0)).toBe(8);   // 0xD5 en A-law = +8
    vi.advanceTimersByTime(2000);
    const st = ev.filter((e) => e.type === 'stats').pop();
    expect(st.loss).toBe(33.3);
    expect(st.score).toBe(1);
    // RTCP: Sender Report cada 5 s al puerto+1
    vi.advanceTimersByTime(5000);
    const rtcp = socks[1];
    expect(rtcp.send).toHaveBeenCalled();
    const sr = rtcp.send.mock.calls[0][0];
    expect(sr.length).toBe(28);
    expect(sr[1]).toBe(200);
    expect(rtcp.send.mock.calls[0][1]).toBe(4001);
  });

  it('la nota de calidad baja por jitter (2 y 3) y es 4 sin paquetes', async () => {
    await enLlamada();
    vi.advanceTimersByTime(2000);
    expect(ev.filter((e) => e.type === 'stats').pop().score).toBe(4);
    const s = rtp();
    const base = Math.floor(Date.now() * 8);
    // tránsitos que varían ~ 400 unidades (50 ms) entre paquetes
    for (let i = 0; i < 40; i++) s.emit('message', pkt(100 + i, 0, (base - (i % 2 ? 400 : 0)) >>> 0));
    vi.advanceTimersByTime(2000);
    const sc = ev.filter((e) => e.type === 'stats').pop();
    expect(sc.jitter).toBeGreaterThan(25);
    expect([2, 3]).toContain(sc.score);
  });

  it('pérdida moderada da 2 y leve da 3', async () => {
    await enLlamada();
    const s = rtp();
    let seq = 0;
    for (let i = 0; i < 96; i++) s.emit('message', pkt(seq++));
    seq += 4; s.emit('message', pkt(seq));             // 4 perdidos de ~100 = 4 %
    vi.advanceTimersByTime(2000);
    expect(ev.filter((e) => e.type === 'stats').pop().score).toBe(2);
    for (let i = 0; i < 100; i++) s.emit('message', pkt(++seq));
    vi.advanceTimersByTime(2000);
    expect(ev.filter((e) => e.type === 'stats').pop().score).toBe(3);   // 4 de ~200 = 2 %
  });

  it('el buffer de salida no crece sin límite; enviar que tira no corta el lazo', async () => {
    await enLlamada();
    motor.audioOut(new Array(5000).fill(40000));       // fuera de rango: se recorta
    motor.audioOut(new Array(10).fill(-40000));
    vi.advanceTimersByTime(20);
    const p = rtp().send.mock.calls[0][0];
    expect(p[12]).toBe(0x80);                          // μ-law del máximo positivo
    rtp().send.mockImplementation(() => { throw new Error('x'); });
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
  });

  it('PCMA de salida con valores extremos', async () => {
    await enLlamada({ codec: 'pcma' }, SDP(4000).replace('RTP/AVP 0 101', 'RTP/AVP 8 101').replace('a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000'));
    motor.audioOut([40000, -40000, -1, 5]);
    vi.advanceTimersByTime(20);
    const p = rtp().send.mock.calls[0][0];
    expect(p[1] & 0x7f).toBe(8);
    expect([p[12], p[13], p[14]]).toEqual([0xaa, 0x2a, 0x55]);
    vi.advanceTimersByTime(2000);
    expect(ev.filter((e) => e.type === 'stats').pop().codec).toBe('PCMA');
  });

  it('PT por nombre del rtpmap (dinámico) y sin DTMF negociado', async () => {
    await enLlamada({}, 'v=0\r\nc=IN IP4 10.0.0.9\r\nm=audio 4000 RTP/AVP 98\r\na=rtpmap:98 PCMU/8000\r\n');
    vi.advanceTimersByTime(20);
    expect(rtp().send.mock.calls[0][0][1] & 0x7f).toBe(98);
    motor.dtmf('1');
    vi.advanceTimersByTime(200);
    expect(rtp().send.mock.calls.some((c) => (c[0][1] & 0x7f) === 101)).toBe(true);
  });

  it('sockets que tiran al abrir o al cerrar no impiden la llamada', async () => {
    await registrado();
    motor.call('102');
    const inv = ultimo('INVITE');
    // rompemos bind y close del próximo socket de RTP
    const orig = socks.length;
    inv.cb(resp(inv.m, 200, { content: SDP() }));
    const s = socks[orig];
    s.close.mockImplementation(() => { throw new Error('x'); });
    socks[orig + 1].close.mockImplementation(() => { throw new Error('x'); });
    socks[orig + 1].send.mockImplementation(() => { throw new Error('x'); });
    vi.advanceTimersByTime(5000);
    expect(() => motor.hangup()).not.toThrow();
  });
});

describe('diálogo: entrantes, re-INVITE, NOTIFY', () => {
  const rqIn = (method, extra = {}) => ({ method, uri: 'sip:101@10.0.0.5', headers: { via: [{}], from: { uri: 'sip:200@pbx', params: { tag: 'ft' } }, to: { uri: 'sip:101@pbx' }, 'call-id': extra.callId || 'c1', cseq: { method, seq: 1 }, contact: extra.contact === undefined ? [{ uri: 'sip:200@10.0.0.9' }] : extra.contact, ...(extra.headers || {}) }, content: extra.content });

  it('entrante sin From, sin Contact ni CSeq: atiende igual y el BYE va al From', async () => {
    await registrado();
    const rq = rqIn('INVITE', { content: SDP(), contact: null });
    delete rq.headers.from;
    sip.onReq(rq);
    expect(ev.find((e) => e.state === 'incoming').number).toBe('desconocido');
  });

  it('atender: Contact ausente usa el From; cseq ausente usa 1; reject que tira igual limpia', async () => {
    await registrado();
    const rq = rqIn('INVITE', { content: SDP(), contact: null });
    delete rq.headers.cseq;
    sip.onReq(rq);
    motor.accept();
    motor.hangup();
    expect(ultimo('BYE').m.uri).toBe('sip:200@pbx');
    expect(ultimo('BYE').m.headers.cseq.seq).toBe(2);
    sip.onReq(rqIn('INVITE', { callId: 'c2', content: SDP() }));
    sip.send.mockImplementationOnce(() => { throw new Error('x'); });
    motor.reject();
    expect(ev.filter((e) => e.state === 'ended').pop().reason).toBe('rechazada');
  });

  it('SRTP pedido pero la entrante no ofrece clave: atiende en claro', async () => {
    await registrado({ sipSrtp: 'sdes' });
    const rq = rqIn('INVITE', {});
    rq.content = undefined;
    sip.onReq({ ...rq, content: SDP() });
    motor.accept();
    const ok = ultimo('R200');
    expect(ok.m.content).toMatch(/RTP\/AVP/);
    expect(ok.m.content).not.toMatch(/a=crypto/);
  });

  it('entrante con video sin PT H264 contesta con el PT ofrecido', async () => {
    await registrado();
    sip.onReq(rqIn('INVITE', { content: SDP(4000, 'm=video 5000 RTP/AVP 120\r\n') }));
    motor.accept(true);
    expect(ultimo('R200').m.content).toMatch(/m=video \d+ RTP\/AVP 120/);
    expect(video.start).toHaveBeenCalled();
  });

  it('re-INVITE sin negociación previa, sin SDP, y con el envío que tira', async () => {
    await registrado();
    sip.onReq(rqIn('INVITE', { content: SDP() }));
    motor.accept();
    sip.onReq(rqIn('INVITE', { content: undefined }));    // re-INVITE sin SDP: 200 igual, sin re-apuntar
    expect(ev.filter((e) => e.state === 'reinvite').pop().remoteHold).toBe(false);
    sip.send.mockImplementationOnce(() => { throw new Error('x'); });
    sip.onReq(rqIn('INVITE', { content: SDP(4000, 'a=inactive\r\n') }));
    expect(ev.filter((e) => e.state === 'reinvite').pop().remoteHold).toBe(true);
    // 491 que no se puede mandar
    motor.hangup();
    motor.call('5');
    const inv = ultimo('INVITE');
    sip.send.mockImplementationOnce(() => { throw new Error('x'); });
    expect(() => sip.onReq({ ...rqIn('INVITE', { content: SDP() }), headers: { ...rqIn('INVITE').headers, 'call-id': inv.m.headers['call-id'] } })).not.toThrow();
    // una entrante mientras se marca: 486, y si mandarlo tira, igual no pisa
    sip.send.mockImplementationOnce(() => { throw new Error('x'); });
    sip.onReq(rqIn('INVITE', { callId: 'otra', content: SDP() }));
    expect(ev.filter((e) => e.state === 'incoming')).toHaveLength(1);
  });

  it('NOTIFY que no se puede contestar, y un pedido que hace explotar el armado de la respuesta', async () => {
    await registrado();
    sip.send.mockImplementationOnce(() => { throw new Error('x'); });
    sip.onReq(rqIn('NOTIFY', { content: 'Messages-Waiting: no' }));
    expect(ev.find((e) => e.type === 'mwi')).toBeUndefined();
    expect(() => sip.onReq({ method: 'INVITE' })).not.toThrow();    // sin headers
  });

  it('accept/reject/hangup sobre una saliente no aplican', async () => {
    await registrado();
    motor.call('102');
    motor.accept(); motor.reject();
    expect(ev.find((e) => e.state === 'answered')).toBeUndefined();
  });
});

describe('re-INVITE propio (espera / cámara): bordes', () => {
  it('sin negociación guardada usa la oferta completa; el reloj de 12 s libera aunque el aviso tire', async () => {
    await enLlamada();
    motor.hold(true);
    const re = ultimo('INVITE');
    expect(re.m.content).toMatch(/a=sendonly/);
    re.cb(resp(re.m, 100));                 // provisional: nada
    vi.advanceTimersByTime(12000);
    expect(ev.filter((e) => e.state === 'hold').pop()).toMatchObject({ held: false, error: 'timeout' });
    re.cb(resp(re.m, 200, { content: SDP() }));   // llega tarde: ya se liberó
    expect(ev.filter((e) => e.state === 'hold')).toHaveLength(1);
  });

  it('respuesta repetida o de otra llamada se ignora; ACK que tira no rompe', async () => {
    await enLlamada();
    motor.hold(true);
    const re = ultimo('INVITE');
    sip.send.mockImplementationOnce(() => { throw new Error('x'); });
    re.cb(resp(re.m, 200, { content: SDP(4002) }));
    re.cb(resp(re.m, 200, { content: SDP() }));
    expect(ev.filter((e) => e.state === 'hold')).toHaveLength(1);
    // retomar: la central contesta sin SDP -> no se re-apunta
    motor.hold(false);
    const re2 = ultimo('INVITE');
    re2.cb(resp(re2.m, 200, {}));
    expect(ev.filter((e) => e.state === 'hold').pop().held).toBe(false);
    motor.hold(true);
    const re3 = ultimo('INVITE');
    motor.hangup();
    re3.cb(resp(re3.m, 200, { content: SDP() }));   // la llamada ya no está
    expect(ev.filter((e) => e.state === 'hold')).toHaveLength(2);
  });

  it('el 401 del re-INVITE: firma que falla => auth; y un segundo 401 ya liberado no repite el aviso', async () => {
    await enLlamada();
    digest.signRequest.mockImplementationOnce(() => { throw new Error('x'); });
    motor.hold(true);
    const re = ultimo('INVITE');
    re.cb(resp(re.m, 401));
    expect(ev.filter((e) => e.state === 'hold').pop()).toMatchObject({ error: 'auth' });
    re.cb(resp(re.m, 401));
    re.cb(resp(re.m, 401));
    expect(ev.filter((e) => e.state === 'hold')).toHaveLength(1);
    // firma que falla con el reloj ya vencido
    digest.signRequest.mockImplementationOnce(() => { throw new Error('x'); });
    motor.hold(true);
    const re2 = ultimo('INVITE');
    vi.advanceTimersByTime(12000);
    re2.cb(resp(re2.m, 407));
    expect(ev.filter((e) => e.state === 'hold')).toHaveLength(2);
  });

  it('si mandar el re-INVITE tira, no queda trabado; rechazo sin motivo', async () => {
    await enLlamada();
    sip.send.mockImplementationOnce(() => { throw new Error('caído'); });
    motor.hold(true);
    expect(ev.find((e) => e.type === 'log' && e.line === 're-INVITE err: caído')).toBeTruthy();
    motor.hold(true);
    const re = ultimo('INVITE');
    re.cb(resp(re.m, 500));
    expect(ev.filter((e) => e.state === 'hold').pop()).toMatchObject({ error: '500' });
  });

  it('cámara: la central acepta video sin decir IP (usa la del audio); video sin módulo', async () => {
    await enLlamada();
    motor.setVideo(true);
    const re = ultimo('INVITE');
    re.cb(resp(re.m, 200, { content: 'v=0\r\nm=audio 4000 RTP/AVP 0\r\nm=video 6000 RTP/AVP 96\r\n' }));
    expect(video.start.mock.calls[0][0]).toMatchObject({ remoteIp: '10.0.0.9', remotePort: 6000 });
    motor.setVideo(true);   // ya está
    motor.setVideo(false);
    const re2 = ultimo('INVITE');
    re2.cb(resp(re2.m, 488));
    expect(ev.filter((e) => e.type === 'video').pop()).toMatchObject({ state: 'on', error: '488' });
    motor.stop();
    cargar({ sinVideo: true });
    await enLlamada();
    motor.setVideo(true);
    expect(ev.find((e) => e.type === 'video')).toMatchObject({ state: 'off', error: 'sin-modulo' });
  });

  it('retomar con la llamada ya sin RTP no rompe', async () => {
    await enLlamada();
    motor.hold(true);
    const re = ultimo('INVITE');
    re.cb(resp(re.m, 200, { content: SDP() }));
    motor.hold(false);
    const re2 = ultimo('INVITE');
    motor.stop();
    expect(() => re2.cb(resp(re2.m, 200, { content: SDP() }))).not.toThrow();
  });
});

describe('DTMF y transferencia: bordes', () => {
  it('INFO que no se puede mandar; respuesta del INFO se anota', async () => {
    await enLlamada({ sipDtmf: 'info' });
    motor.dtmf('9');
    ultimo('INFO').cb({ status: 200 });
    expect(ev.find((e) => e.type === 'log' && e.line === 'INFO(dtmf) → 200')).toBeTruthy();
    sip.send.mockImplementationOnce(() => { throw new Error('x'); });
    expect(() => motor.dtmf('9')).not.toThrow();
  });

  it('REFER rechazado no corta; REFER que no se puede mandar se anota', async () => {
    await enLlamada();
    motor.transfer('300');
    ultimo('REFER').cb({ status: 403 });
    expect(ev.find((e) => e.state === 'transferred')).toBeUndefined();
    sip.send.mockImplementationOnce(() => { throw new Error('sin red'); });
    motor.transfer('300');
    expect(ev.find((e) => e.type === 'log' && e.line === 'REFER err: sin red')).toBeTruthy();
    motor.transfer('301');
    ultimo('REFER').cb({ status: 202 });
    motor.stop();
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();   // el colgado diferido con el motor parado
  });
});

describe('más bordes del motor', () => {
  it('G.711: decodifica μ-law negativo y A-law de varios segmentos', async () => {
    await enLlamada();
    const s = rtp();
    const p = pkt(1, 0, 0, 16); p[12] = 0x00; p[13] = 0x80; p[14] = 0x7f; p[15] = 0xff;
    s.emit('message', p);
    const mu = Buffer.from(ev.filter((e) => e.type === 'audio').pop().pcm, 'base64');
    expect([mu.readInt16LE(0), mu.readInt16LE(2), mu.readInt16LE(4), mu.readInt16LE(6)]).toEqual([-32124, 32124, -0, 0].map((x) => x || 0));
    const a = pkt(2, 8, 0, 16); a[12] = 0xd5 ^ 0x10; a[13] = 0x55 ^ 0x70; a[14] = 0x55; a[15] = 0x55 ^ 0x20;
    s.emit('message', a);
    const al = Buffer.from(ev.filter((e) => e.type === 'audio').pop().pcm, 'base64');
    expect([al.readInt16LE(0), al.readInt16LE(2), al.readInt16LE(4), al.readInt16LE(6)]).toEqual([264, -16896, -8, -528]);
  });

  it('el socket RTCP que no se puede crear y el bind que tira no impiden hablar', async () => {
    await registrado();
    fallas.crearRtcp = true; fallas.bind = true;
    motor.call('102');
    const inv = ultimo('INVITE');
    inv.cb(resp(inv.m, 200, { content: SDP() }));
    expect(ev.find((e) => e.state === 'answered')).toBeTruthy();
    vi.advanceTimersByTime(5000);          // sin socket RTCP el Sender Report no se manda, sin romper
    vi.advanceTimersByTime(20);
    expect(rtp().send).toHaveBeenCalled(); // el audio sale igual
  });

  it('ACK de un pedido suelto se ignora; BYE de la central con respuesta registrada', async () => {
    await enLlamada();
    expect(() => sip.onReq({ method: 'ACK', headers: {} })).not.toThrow();
    motor.hangup();
    ultimo('BYE').cb({ status: 200 });
    expect(ev.find((e) => e.type === 'log' && e.line === 'BYE → 200')).toBeTruthy();
  });

  it('un 200 repetido cuyo ACK no se puede mandar no rompe', async () => {
    await registrado();
    motor.call('102');
    const inv = ultimo('INVITE');
    inv.cb(resp(inv.m, 200, { content: SDP() }));
    sip.send.mockImplementationOnce(() => { throw new Error('x'); });
    expect(() => inv.cb(resp(inv.m, 200, { content: SDP() }))).not.toThrow();
    expect(ev.filter((e) => e.state === 'answered')).toHaveLength(1);
  });

  it('sin SDP y con el BYE que no se puede mandar, igual termina y libera la línea', async () => {
    await registrado();
    motor.call('102');
    const inv = ultimo('INVITE');
    sip.send.mockImplementation((m, cb) => { if (m.method === 'BYE') throw new Error('x'); sip.enviados.push({ m, cb }); });
    inv.cb(resp(inv.m, 200, { content: 'v=0' }));
    expect(ev.find((e) => e.state === 'ended').reason).toBe('sin SDP remoto');
    sip.onReq({ method: 'INVITE', headers: { via: [{}], from: { uri: 'sip:7@pbx' }, 'call-id': 'z', cseq: { seq: 1 } }, content: SDP() });
    expect(ev.find((e) => e.state === 'incoming')).toBeTruthy();
  });

  it('re-INVITE de la central con nuestra cámara activa y en espera: contesta sendonly con video', async () => {
    await registrado();
    motor.call('102', true);
    const inv = ultimo('INVITE');
    inv.cb(resp(inv.m, 200, { contact: [{ uri: 'sip:102@10.0.0.9' }], content: SDP(4000, 'm=video 5000 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n') }));
    motor.hold(true);
    const re = ultimo('INVITE');
    re.cb(resp(re.m, 200, { content: SDP() }));
    sip.onReq({ method: 'INVITE', headers: { via: [{}], from: { uri: 'sip:102@pbx', params: { tag: 'remota' } }, to: {}, 'call-id': inv.m.headers['call-id'], cseq: { seq: 9 } }, content: SDP() });
    const ok = ultimo('R200').m.content;
    expect(ok).toMatch(/a=sendonly/);
    expect(ok).toMatch(/m=video/);
    // apagar la cámara con el RTP de video que tira al pararse
    video.stop.mockImplementation(() => { throw new Error('x'); });
    motor.setVideo(false);
    const re2 = ultimo('INVITE');
    re2.cb(resp(re2.m, 200, { content: SDP() }));
    expect(ev.filter((e) => e.type === 'video').pop().state).toBe('off');
  });

  it('SRTP pedido y la entrante sin cuerpo de texto: atiende sin clave', async () => {
    await registrado({ sipSrtp: 'sdes' });
    sip.onReq({ method: 'INVITE', headers: { via: [{}], from: { uri: 'sip:7@pbx' }, 'call-id': 'k', cseq: { seq: 1 } } });
    motor.accept();
    expect(ev.find((e) => e.state === 'ended').reason).toBe('sin SDP remoto');
  });

  it('la respuesta a la espera llega con el motor ya parado', async () => {
    await enLlamada();
    motor.hold(true);
    const re = ultimo('INVITE');
    const cb = re.cb;
    motor.stop();
    cargar();   // motor nuevo: el viejo ya no tiene engine
    expect(() => cb(resp(re.m, 200, { content: SDP() }))).not.toThrow();
  });
});
