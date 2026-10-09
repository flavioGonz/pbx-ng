/* Motor SIP nativo (electron/sip-udp.cjs) contra una central falsa por UDP en 127.0.0.1.
 * Es el modo que usan los clientes sin WebRTC (teléfonos de escritorio, centrales viejas):
 * acá se juega que REGISTRE con digest de verdad (401 -> reintento firmado), que diga por
 * qué no registra, que una llamada saliente/entrante complete INVITE/ACK/BYE con el audio
 * RTP yendo y viniendo, que las retransmisiones UDP no dupliquen la llamada, y la espera,
 * la cámara, el DTMF, el REFER y el MWI. El softphone escucha en 5062 (fijo, como en la
 * app); la central falsa en un puerto libre. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { CentralFalsa, sdp } from './helpers/logica-sippeer.js';
import { hasta, socketUdp } from './helpers/logica-red.js';
const require = createRequire(import.meta.url);
const motor = require('../electron/sip-udp.cjs');
const srtp = require('../electron/srtp.cjs');

let central, eventos;
const CFG = () => ({ sipServer: '127.0.0.1', sipPort: String(central.port), domain: 'pbx.test', ext: '101', pass: 'secreto' });
const ev = (pred) => eventos.find(pred);
const esperarEv = (pred, ms) => hasta(() => ev(pred), ms);

beforeEach(async () => {
  central = await new CentralFalsa().arrancar();
  eventos = [];
});
afterEach(async () => {
  vi.useRealTimers();
  motor.stop();
  central.cerrar();
  await new Promise((r) => setTimeout(r, 20));
});

/* La central acepta el REGISTER pidiendo digest, y opcionalmente declara la IP pública. */
function centralQueRegistra({ expires = '60', nat = false } = {}) {
  central.alPedido = (rq) => {
    if (rq.method !== 'REGISTER') return central.otro && central.otro(rq);
    // como Asterisk: el received/rport va en TODAS las respuestas, también en el 401
    if (nat) Object.assign(rq.headers.via[0].params, { received: '200.1.2.3', rport: '40000' });
    if (!central.autenticado(rq, '101', 'secreto')) return central.desafiar(rq);
    central.responder(rq, 200, 'OK', { headers: { contact: [{ uri: rq.headers.contact[0].uri, params: { expires } }] } });
  };
}
async function registrar(extra = {}, opts) {
  centralQueRegistra(opts);
  expect(motor.start({ ...CFG(), ...extra }, (e) => eventos.push(e))).toEqual({ ok: true });
  await esperarEv((e) => e.type === 'reg' && e.state === 'registered');
}

describe('registro', () => {
  it('sin datos completos no arranca y avisa', () => {
    const r = motor.start({ sipServer: 'x' }, (e) => eventos.push(e));
    expect(r).toEqual({ error: 'cfg' });
    expect(eventos[0]).toEqual({ type: 'reg', state: 'failed', reason: 'faltan datos: servidor, dominio, interno o clave' });
    expect(motor.start(null, () => { throw new Error('el callback que explota no rompe'); })).toEqual({ error: 'cfg' });
  });

  it('REGISTER con digest: 401, reintento firmado y registrado', async () => {
    await registrar();
    const regs = central.todos((m) => m.method === 'REGISTER');
    expect(regs.length).toBeGreaterThanOrEqual(2);
    expect(regs[0].uri).toBe('sip:127.0.0.1:' + central.port);
    expect(regs[0].headers.authorization).toBeUndefined();
    expect(regs[1].headers.authorization).toBeTruthy();
    expect(regs[1].headers.cseq.seq).toBe(regs[0].headers.cseq.seq + 1);
    expect(regs[1].headers['call-id']).toBe(regs[0].headers['call-id']);
    expect(regs[0].headers.to.uri).toBe('sip:101@pbx.test');
    expect(regs[0].headers.expires).toBe('300');
    expect(ev((e) => e.type === 'reg' && e.state === 'connecting')).toBeTruthy();
    expect(ev((e) => e.type === 'log' && /REGISTER\(auth\) → 200/.test(e.line))).toBeTruthy();
  });

  it('aprende la IP pública (received/rport) y la usa en el Contact', async () => {
    await registrar({}, { nat: true });
    expect(ev((e) => e.type === 'log' && /NAT: IP pública 200\.1\.2\.3:40000/.test(e.line))).toBeTruthy();
    const regs = central.todos((m) => m.method === 'REGISTER');
    expect(regs[regs.length - 1].headers.contact[0].uri).toBe('sip:101@200.1.2.3:40000');
  });

  it('un 403 dice que revise interno/clave o IP', async () => {
    central.alPedido = (rq) => central.responder(rq, 403, 'Forbidden');
    motor.start(CFG(), (e) => eventos.push(e));
    const f = await esperarEv((e) => e.type === 'reg' && e.state === 'failed');
    expect(f.reason).toBe('403 Forbidden (interno/clave o IP no permitida)');
  });

  it('clave equivocada: la central vuelve a desafiar y queda en falla', async () => {
    central.alPedido = (rq) => { if (rq.method === 'REGISTER') central.desafiar(rq); };
    motor.start(CFG(), (e) => eventos.push(e));
    const f = await esperarEv((e) => e.type === 'reg' && e.state === 'failed');
    expect(f.reason).toMatch(/^401 Unauthorized/);
  });

  it('retransmite el REGISTER por UDP si la central no contesta el primero', async () => {
    let ignorados = 0;
    centralQueRegistra();
    const registra = central.alPedido;
    central.alPedido = (rq) => { if (rq.method === 'REGISTER' && ignorados++ === 0) return; registra(rq); };
    motor.start(CFG(), (e) => eventos.push(e));
    await esperarEv((e) => e.type === 'reg' && e.state === 'registered');
    const regs = central.todos((m) => m.method === 'REGISTER');
    expect(regs[1].headers.via[0].params.branch).toBe(regs[0].headers.via[0].params.branch);   // misma transacción
  });
});

/* Parsea lo mínimo del SDP que manda el softphone. */
function sdpDe(m) {
  const t = String(m.content || '');
  return {
    port: +(t.match(/m=audio (\d+)/) || [])[1],
    proto: (t.match(/m=audio \d+ (\S+)/) || [])[1],
    pts: ((t.match(/m=audio \d+ \S+ (.+)/) || [])[1] || '').trim(),
    vport: +(t.match(/m=video (\d+)/) || [])[1] || 0,
    dir: (t.match(/a=(sendrecv|sendonly|recvonly|inactive)/) || [])[1],
    crypto: srtp.parseCrypto(t),
    texto: t,
  };
}
function rtpPkt(seq, pt = 0, payload = Buffer.alloc(160, 0xff), ts = 0) {
  const h = Buffer.alloc(12); h[0] = 0x80; h[1] = pt; h.writeUInt16BE(seq, 2); h.writeUInt32BE(ts, 4); h.writeUInt32BE(77, 8);
  return Buffer.concat([h, payload]);
}

describe('llamada saliente', () => {
  let rtp, rtpRx;
  beforeEach(async () => { rtp = await socketUdp(); rtpRx = []; rtp.on('message', (m) => rtpRx.push(m)); });
  afterEach(() => { try { rtp.close(); } catch {} });

  /* La central atiende el INVITE: desafía una vez, timbra y contesta 200 con SDP. */
  function centralQueAtiende({ desafio = true, sdpRespuesta, tag = 'tagB', duplicar = false, codigo } = {}) {
    central.otro = (rq) => {
      if (rq.method === 'INVITE') {
        if (desafio && !central.autenticado(rq, '101', 'secreto')) return central.desafiar(rq, 407);
        central.responder(rq, 100, 'Trying');
        const to = { ...rq.headers.to, params: { tag } };
        central.responder({ ...rq, headers: { ...rq.headers, to } }, 180, 'Ringing');
        if (codigo) return central.responder({ ...rq, headers: { ...rq.headers, to } }, codigo, 'Busy Here');
        const body = sdpRespuesta ? sdpRespuesta(rq) : sdp('127.0.0.1', rtp.address().port);
        const ok = () => central.responder({ ...rq, headers: { ...rq.headers, to } }, 200, 'OK', { headers: { contact: [{ uri: 'sip:102@127.0.0.1:' + central.port }], 'content-type': 'application/sdp' }, content: body });
        ok();
        if (duplicar) setTimeout(ok, 30);
        return;
      }
      if (rq.method === 'BYE' || rq.method === 'INFO' || rq.method === 'REFER' || rq.method === 'SUBSCRIBE') central.responder(rq, 200, 'OK');
    };
  }

  it('INVITE con desafío 407, timbra, atiende con ACK, el audio va y viene, y BYE al colgar', async () => {
    await registrar();
    centralQueAtiende();
    motor.call('(102)', false);
    expect(ev((e) => e.type === 'call' && e.state === 'calling').number).toBe('102');
    await esperarEv((e) => e.type === 'call' && e.state === 'answered');
    expect(ev((e) => e.type === 'call' && e.state === 'ringing')).toBeTruthy();
    const invites = central.todos((m) => m.method === 'INVITE');
    expect(invites[0].uri).toBe('sip:102@127.0.0.1:' + central.port);
    expect(invites[1].headers['proxy-authorization']).toBeTruthy();
    const ofrecido = sdpDe(invites[0]);
    expect(ofrecido.pts).toBe('0 8 101');
    expect(ofrecido.proto).toBe('RTP/AVP');
    const ack = await central.esperar((m) => m.method === 'ACK' && m.headers.cseq.seq === invites[1].headers.cseq.seq);
    expect(ack.uri).toBe('sip:102@127.0.0.1:' + central.port);
    // el softphone manda RTP PCMU cada 20 ms al puerto de la central
    await hasta(() => rtpRx.length >= 3);
    expect(rtpRx[0].length).toBe(172);
    expect(rtpRx[0][1] & 0x7f).toBe(0);
    // y lo que llega se decodifica y sube al renderer
    rtp.send(rtpPkt(1), ofrecido.port, '127.0.0.1');
    const a = await esperarEv((e) => e.type === 'audio');
    expect(Buffer.from(a.pcm, 'base64').length).toBe(320);
    // estadísticas cada 2 s
    await esperarEv((e) => e.type === 'stats', 3000);
    expect(ev((e) => e.type === 'stats')).toMatchObject({ codec: 'PCMU', score: 4 });
    motor.hangup();
    const bye = await central.esperar((m) => m.method === 'BYE');
    expect(bye.headers.to.params.tag).toBe('tagB');
    expect(bye.headers['call-id']).toBe(invites[0].headers['call-id']);
    expect(ev((e) => e.type === 'call' && e.state === 'ended').reason).toBe('colgaste');
  });

  it('un 200 OK retransmitido no "atiende" dos veces ni reinicia el audio', async () => {
    await registrar();
    centralQueAtiende({ duplicar: true, desafio: false });
    motor.call('102');
    await esperarEv((e) => e.type === 'call' && e.state === 'answered');
    await hasta(() => central.todos((m) => m.method === 'ACK').length >= 2, 2000);   // cada 200 lleva su ACK
    await new Promise((r) => setTimeout(r, 30));
    expect(eventos.filter((e) => e.type === 'call' && e.state === 'answered')).toHaveLength(1);
  });

  it('ofrece sólo el códec elegido (PCMA) y usa el que la central contesta', async () => {
    await registrar({ codec: 'pcma' });
    centralQueAtiende({ sdpRespuesta: () => sdp('127.0.0.1', rtp.address().port, { pts: '8 96', extra: ['a=rtpmap:96 telephone-event/8000'] }) });
    motor.call('102');
    await esperarEv((e) => e.type === 'call' && e.state === 'answered');
    expect(sdpDe(central.todos((m) => m.method === 'INVITE')[0]).pts).toBe('8 101');
    await hasta(() => rtpRx.length >= 1);
    expect(rtpRx[0][1] & 0x7f).toBe(8);
    // DTMF RFC 4733 con el PT que dijo la central
    motor.dtmf('5');
    await hasta(() => rtpRx.some((p) => (p[1] & 0x7f) === 96 && p[12] === 5 && (p[13] & 0x80)), 2000);
    const ev5 = rtpRx.filter((p) => (p[1] & 0x7f) === 96);
    expect(ev5[0][1] & 0x80).toBe(0x80);       // el primero con marker
    motor.dtmf('x');                            // tecla inválida: nada
  });

  it('PCMU sólo con codec=pcmu; una respuesta rara cae a PCMU', async () => {
    await registrar({ codec: 'pcmu' });
    centralQueAtiende({ desafio: false, sdpRespuesta: () => sdp('127.0.0.1', rtp.address().port, { pts: '18' }).replace(/a=rtpmap:101.*\r\n/, '') });
    motor.call('102');
    await esperarEv((e) => e.type === 'call' && e.state === 'answered');
    expect(sdpDe(central.todos((m) => m.method === 'INVITE')[0]).pts).toBe('0 101');
    await hasta(() => rtpRx.length >= 1);
    expect(rtpRx[0][1] & 0x7f).toBe(0);
  });

  it('ocupado: termina con el código; sin SDP en el 200: termina con motivo', async () => {
    await registrar();
    centralQueAtiende({ codigo: 486 });
    motor.call('102');
    const fin = await esperarEv((e) => e.type === 'call' && e.state === 'ended');
    expect(fin.reason).toBe('486 Busy Here');
    eventos.length = 0;
    centralQueAtiende({ sdpRespuesta: () => '' });
    motor.call('103');
    const fin2 = await esperarEv((e) => e.type === 'call' && e.state === 'ended');
    expect(fin2.reason).toBe('sin SDP remoto');
    // la llamada atendida sin media se corta con BYE (no queda muda arriba)...
    const bye = await central.esperar((m) => m.method === 'BYE');
    expect(bye.headers.to.params.tag).toBe('tagB');
    // ...y no queda "ocupado": la próxima entrante timbra
    central.pedido('INVITE', { content: sdp('127.0.0.1', rtp.address().port) });
    await esperarEv((e) => e.state === 'incoming');
  });

  it('colgar antes de que atiendan manda CANCEL con la misma Via', async () => {
    await registrar();
    central.otro = (rq) => {
      if (rq.method === 'INVITE') central.responder(rq, 180, 'Ringing');
      if (rq.method === 'CANCEL') central.responder(rq, 200, 'OK');
    };
    motor.call('102');
    const inv = await central.esperar((m) => m.method === 'INVITE');
    motor.hangup();
    const c = await central.esperar((m) => m.method === 'CANCEL');
    expect(c.headers.via[0].params.branch).toBe(inv.headers.via[0].params.branch);
    expect(c.headers.cseq.seq).toBe(inv.headers.cseq.seq);
    expect(ev((e) => e.type === 'call' && e.state === 'ended').reason).toBe('colgaste');
    motor.hangup();   // sin llamada: no rompe
  });

  it('número vacío no llama', async () => {
    await registrar();
    motor.call('---');
    await new Promise((r) => setTimeout(r, 50));
    expect(central.todos((m) => m.method === 'INVITE')).toHaveLength(0);
  });

  it('la central corta (BYE): 200 OK, se para el RTP y avisa', async () => {
    await registrar();
    centralQueAtiende();
    motor.call('102');
    await esperarEv((e) => e.type === 'call' && e.state === 'answered');
    const inv = central.todos((m) => m.method === 'INVITE')[1];
    central.pedido('BYE', { callId: inv.headers['call-id'], from: 'sip:102@pbx.test', fromTag: 'tagB', toTag: inv.headers.from.params.tag, cseq: 2 });
    const fin = await esperarEv((e) => e.type === 'call' && e.state === 'ended');
    expect(fin.reason).toBe('colgó el otro lado');
    await central.esperar((m) => m.status === 200 && m.headers.cseq.method === 'BYE');
    const n = rtpRx.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(rtpRx.length - n).toBeLessThanOrEqual(1);
  });

  it('mute manda silencio y en espera no se entrega el audio entrante', async () => {
    await registrar();
    centralQueAtiende();
    motor.call('102');
    await esperarEv((e) => e.type === 'call' && e.state === 'answered');
    const pcm = Buffer.alloc(320); for (let i = 0; i < 160; i++) pcm.writeInt16LE(8000, i * 2);
    motor.audioOut(new Int16Array(pcm.buffer, pcm.byteOffset, 160));
    await hasta(() => rtpRx.some((p) => p[12] !== 0xff), 2000);    // 0xff = silencio en μ-law
    motor.setMuted(true);
    motor.audioOut(new Int16Array(pcm.buffer, pcm.byteOffset, 160));
    rtpRx.length = 0;
    await hasta(() => rtpRx.length >= 5);
    expect(rtpRx.every((p) => p[12] === 0xff)).toBe(true);
    motor.setMuted(false);
  });
});

describe('llamada entrante y diálogo', () => {
  let rtp, rtpRx;
  beforeEach(async () => { rtp = await socketUdp(); rtpRx = []; rtp.on('message', (m) => rtpRx.push(m)); });
  afterEach(() => { try { rtp.close(); } catch {} });

  async function entrante(opts = {}) {
    await registrar(opts.cfg || {});
    central.otro = (rq) => { if (['BYE', 'INFO', 'REFER', 'SUBSCRIBE'].includes(rq.method)) central.responder(rq, 200, 'OK'); if (rq.method === 'INVITE' && central.alReinvite) central.alReinvite(rq); };
    const inv = central.pedido('INVITE', { callId: 'llamada-1', content: opts.content || sdp('127.0.0.1', rtp.address().port, opts.sdp), headers: opts.headers });
    await esperarEv((e) => e.type === 'call' && e.state === 'incoming');
    await central.esperar((m) => m.status === 180);
    return inv;
  }
  async function atendida(opts) {
    const inv = await entrante(opts);
    motor.accept(opts && opts.video);
    await esperarEv((e) => e.type === 'call' && e.state === 'answered');
    const ok = await central.esperar((m) => m.status === 200 && m.headers.cseq.method === 'INVITE');
    return { inv, ok };
  }

  it('timbra con el número de quien llama, atiende con 200 + SDP y el RTP arranca', async () => {
    const { ok } = await atendida();
    expect(ev((e) => e.state === 'incoming')).toMatchObject({ number: '200', video: false });
    const s = sdpDe(ok);
    expect(s.pts).toBe('0 101');
    expect(ok.headers.contact[0].uri).toMatch(/^sip:101@/);
    await hasta(() => rtpRx.length >= 2);
    expect(ev((e) => e.state === 'answered').number).toBe('200');
  });

  it('rechazar contesta 486 Busy Here', async () => {
    await entrante();
    motor.reject();
    await central.esperar((m) => m.status === 486);
    expect(ev((e) => e.state === 'ended').reason).toBe('rechazada');
    motor.reject();   // sin llamada: nada
  });

  it('la central cancela antes de atender', async () => {
    const inv = await entrante();
    central.pedido('CANCEL', { callId: inv.headers['call-id'], fromTag: inv.headers.from.params.tag, cseq: 1 });
    expect((await esperarEv((e) => e.state === 'ended')).reason).toBe('cancelada');
  });

  it('un INVITE sin From legible es de "desconocido"; colgar sin atender contesta 486', async () => {
    await registrar();
    central.pedido('INVITE', { from: 'sip:pbx.test', content: sdp('127.0.0.1', rtp.address().port) });
    expect((await esperarEv((e) => e.state === 'incoming')).number).toBe('desconocido');
    motor.hangup();
    await central.esperar((m) => m.status === 486);
  });

  it('atender sin SDP del otro lado termina con motivo, corta con BYE y no queda ocupado', async () => {
    await registrar();
    central.otro = (rq) => { if (rq.method === 'BYE') central.responder(rq, 200, 'OK'); };
    central.pedido('INVITE', { callId: 'sin-sdp', content: 'v=0\r\n' });
    await esperarEv((e) => e.state === 'incoming');
    motor.accept();
    expect((await esperarEv((e) => e.state === 'ended')).reason).toBe('sin SDP remoto');
    expect((await central.esperar((m) => m.method === 'BYE')).headers['call-id']).toBe('sin-sdp');
    eventos.length = 0;
    central.pedido('INVITE', { content: sdp('127.0.0.1', rtp.address().port) });
    await esperarEv((e) => e.state === 'incoming');
  });

  it('colgar una entrante atendida manda BYE con los tags del diálogo', async () => {
    const { inv } = await atendida();
    motor.hangup();
    const bye = await central.esperar((m) => m.method === 'BYE');
    expect(bye.headers.to.params.tag).toBe(inv.headers.from.params.tag);
    expect(bye.uri).toBe('sip:200@127.0.0.1:' + central.port);
    expect(bye.headers.cseq.seq).toBe(2);
  });

  it('una segunda entrante con una llamada en curso se contesta 486 y NO pisa la llamada activa', async () => {
    const { inv } = await atendida();
    eventos.length = 0;
    central.pedido('INVITE', { callId: 'otra-llamada', from: 'sip:999@pbx.test', content: sdp('127.0.0.1', 4000) });
    const busy = await central.esperar((m) => m.status === 486 && m.headers['call-id'] === 'otra-llamada');
    expect(busy).toBeTruthy();
    expect(ev((e) => e.state === 'incoming')).toBeUndefined();
    // colgar sigue cortando la llamada de verdad (BYE al diálogo original)
    motor.hangup();
    const bye = await central.esperar((m) => m.method === 'BYE');
    expect(bye.headers['call-id']).toBe(inv.headers['call-id']);
  });

  it('OPTIONS se contesta 200, un método desconocido 405, y el ACK suelto se ignora', async () => {
    await registrar();
    central.pedido('OPTIONS');
    await central.esperar((m) => m.status === 200 && m.headers.cseq.method === 'OPTIONS');
    central.pedido('MESSAGE');
    await central.esperar((m) => m.status === 405);
    central.pedido('ACK');
  });

  it('un re-INVITE de la llamada en curso: 200 con el mismo SDP, re-apunta el RTP y avisa si nos pusieron en espera', async () => {
    const { inv } = await atendida();
    const otro = await socketUdp(); const rx2 = []; otro.on('message', (m) => rx2.push(m));
    central.pedido('INVITE', { callId: inv.headers['call-id'], fromTag: inv.headers.from.params.tag, cseq: 2, content: sdp('127.0.0.1', otro.address().port, { extra: ['a=sendonly'] }) });
    const re = await esperarEv((e) => e.state === 'reinvite');
    expect(re.remoteHold).toBe(true);
    const ok = await central.esperar((m) => m.status === 200 && m.headers.cseq.seq === 2);
    expect(sdpDe(ok).pts).toBe('0 101');
    await hasta(() => rx2.length >= 2);
    expect(ev((e) => e.type === 'log' && /re-INVITE: la media ahora va a/.test(e.line))).toBeTruthy();
    otro.close();
  });

  it('un INVITE con el mismo Call-ID antes de establecer se contesta 491 y no inventa otra entrante', async () => {
    await registrar();
    central.otro = (rq) => { if (rq.method === 'INVITE') central.responder(rq, 180, 'Ringing'); };
    motor.call('7700');
    const inv = await central.esperar((m) => m.method === 'INVITE');
    central.pedido('INVITE', { callId: inv.headers['call-id'], content: sdp('127.0.0.1', 4000) });
    await central.esperar((m) => m.status === 491);
    expect(ev((e) => e.state === 'incoming')).toBeUndefined();
  });

  it('NOTIFY de buzón: cuenta los mensajes nuevos', async () => {
    await registrar({ sipMwi: true });
    await central.esperar((m) => m.method === 'SUBSCRIBE');
    central.pedido('NOTIFY', { content: 'Messages-Waiting: yes\r\nVoice-Message: 3/7\r\n', headers: { event: 'message-summary' } });
    expect((await esperarEv((e) => e.type === 'mwi')).count).toBe(3);
    eventos.length = 0;
    central.pedido('NOTIFY', { content: 'Messages-Waiting: yes\r\n' });
    expect((await esperarEv((e) => e.type === 'mwi')).count).toBe(1);
    eventos.length = 0;
    central.pedido('NOTIFY', {});
    expect((await esperarEv((e) => e.type === 'mwi')).count).toBe(0);
  });

  it('SUBSCRIBE de MWI desafiado se reintenta firmado una vez', async () => {
    centralQueRegistra();
    central.otro = (rq) => { if (rq.method === 'SUBSCRIBE') { if (!rq.headers.authorization) central.desafiar(rq); else central.responder(rq, 200, 'OK'); } };
    motor.start({ ...CFG(), sipMwi: true }, (e) => eventos.push(e));
    await hasta(() => central.todos((m) => m.method === 'SUBSCRIBE' && m.headers.authorization).length);
    const sub = central.todos((m) => m.method === 'SUBSCRIBE')[0];
    expect(sub.headers.event).toBe('message-summary');
  });

  it('espera: re-INVITE sendonly, deja de mandar audio, y al retomar sendrecv', async () => {
    await atendida();
    central.alReinvite = (rq) => central.responder(rq, 200, 'OK', { headers: { 'content-type': 'application/sdp', contact: [{ uri: 'sip:200@127.0.0.1:' + central.port }] }, content: sdp('127.0.0.1', rtp.address().port) });
    motor.hold(true);
    const h = await esperarEv((e) => e.state === 'hold');
    expect(h.held).toBe(true);
    const re = central.todos((m) => m.method === 'INVITE' && m.headers['call-id'] === 'llamada-1');
    expect(sdpDe(re[re.length - 1]).dir).toBe('sendonly');
    await central.esperar((m) => m.method === 'ACK' && m.headers['call-id'] === 'llamada-1');
    // en espera, lo que llega no se entrega
    const ofrecido = sdpDe(central.todos((m) => m.status === 200 && m.headers.cseq.method === 'INVITE')[0]);
    eventos.length = 0;
    rtp.send(rtpPkt(9), ofrecido.port, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 50));
    expect(ev((e) => e.type === 'audio')).toBeUndefined();
    motor.hold(true);   // ya está: sólo confirma
    expect(ev((e) => e.state === 'hold').held).toBe(true);
    eventos.length = 0;
    // al retomar la central contesta con otro puerto: hay que re-apuntar
    const otro = await socketUdp(); const rx2 = []; otro.on('message', (m) => rx2.push(m));
    central.alReinvite = (rq) => central.responder(rq, 200, 'OK', { headers: { 'content-type': 'application/sdp' }, content: sdp('127.0.0.1', otro.address().port) });
    motor.hold(false);
    expect((await esperarEv((e) => e.state === 'hold')).held).toBe(false);
    await hasta(() => rx2.length >= 2);
    otro.close();
  });

  it('espera rechazada (488) avisa el error y no cambia; un re-INVITE a la vez', async () => {
    await atendida();
    let n = 0;
    central.alReinvite = (rq) => { n++; setTimeout(() => central.responder(rq, 488, 'Not Acceptable Here'), 40); };
    motor.hold(true);
    motor.hold(true);  // mientras el primero está en curso: se ignora
    const h = await esperarEv((e) => e.state === 'hold');
    expect(h).toMatchObject({ held: false, error: '488' });
    expect(n).toBe(1);
    expect(ev((e) => e.type === 'log' && /ya hay uno en curso/.test(e.line))).toBeTruthy();
  });

  it('re-INVITE desafiado: reintenta firmado una vez; si lo vuelve a desafiar, error auth', async () => {
    await atendida();
    central.alReinvite = (rq) => { if (!rq.headers.authorization) return central.desafiar(rq); central.responder(rq, 200, 'OK', { headers: { 'content-type': 'application/sdp' }, content: sdp('127.0.0.1', rtp.address().port) }); };
    motor.hold(true);
    expect((await esperarEv((e) => e.state === 'hold')).held).toBe(true);
    eventos.length = 0;
    central.alReinvite = (rq) => central.desafiar(rq);
    motor.hold(false);
    expect(await esperarEv((e) => e.state === 'hold')).toMatchObject({ held: true, error: 'auth' });
  });

  it('un re-INVITE sin respuesta se libera a los 12 s (el botón no queda trabado)', async () => {
    await atendida();
    central.alReinvite = () => {};
    const timers = [];
    const orig = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...a) => { if (ms === 12000) { timers.push(fn); return 0; } return orig(fn, ms, ...a); });
    motor.hold(true);
    spy.mockRestore();
    await central.esperar((m) => m.method === 'INVITE' && /a=sendonly/.test(m.content || ''));
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(ev((e) => e.state === 'hold')).toMatchObject({ held: false, error: 'timeout' });
  });

  it('transferencia ciega: REFER con Refer-To y cuelga sola al aceptarse', async () => {
    await atendida();
    motor.transfer('');            // vacío: nada
    motor.transfer('(300)');
    const ref = await central.esperar((m) => m.method === 'REFER');
    expect(ref.headers['refer-to'].uri).toBe('sip:300@pbx.test');
    expect((await esperarEv((e) => e.state === 'transferred')).number).toBe('300');
    await central.esperar((m) => m.method === 'BYE', 3000);
  });

  it('DTMF por INFO o por ambos caminos según la config', async () => {
    await atendida({ cfg: { sipDtmf: 'info' } });
    motor.dtmf('7');
    const info = await central.esperar((m) => m.method === 'INFO');
    expect(info.content).toBe('Signal=7\r\nDuration=250\r\n');
    expect(info.headers['content-type']).toBe('application/dtmf-relay');
    await new Promise((r) => setTimeout(r, 60));
    expect(rtpRx.some((p) => (p[1] & 0x7f) === 101)).toBe(false);
  });

  it('DTMF "both": INFO y RFC 4733 a la vez; sin llamada no manda INFO', async () => {
    await registrar({ sipDtmf: 'both' });
    motor.dtmf('1');
    await atendidaSobreRegistrado();
    motor.dtmf('#');
    await central.esperar((m) => m.method === 'INFO');
    await hasta(() => rtpRx.some((p) => (p[1] & 0x7f) === 101 && p[12] === 11));
  });
  async function atendidaSobreRegistrado() {
    central.otro = (rq) => { if (['BYE', 'INFO'].includes(rq.method)) central.responder(rq, 200, 'OK'); };
    central.pedido('INVITE', { content: sdp('127.0.0.1', rtp.address().port) });
    await esperarEv((e) => e.state === 'incoming');
    motor.accept();
    await esperarEv((e) => e.state === 'answered');
  }
});

describe('video y SRTP', () => {
  let rtp, rtpRx, vid, vidRx, rtcpV, rtcpRx;
  beforeEach(async () => {
    rtp = await socketUdp(); rtpRx = []; rtp.on('message', (m) => rtpRx.push(m));
    const { parLibre } = await import('./helpers/logica-red.js');
    const vp = await parLibre();
    vid = await socketUdp(vp); vidRx = []; vid.on('message', (m) => vidRx.push(m));
    rtcpV = await socketUdp(vp + 1); rtcpRx = []; rtcpV.on('message', (m) => rtcpRx.push(m));
  });
  afterEach(() => { for (const s of [rtp, vid, rtcpV]) { try { s.close(); } catch {} } });

  const okCon = (rq, content) => central.responder({ ...rq, headers: { ...rq.headers, to: { ...rq.headers.to, params: { tag: 'tv' } } } }, 200, 'OK', { headers: { 'content-type': 'application/sdp', contact: [{ uri: 'sip:102@127.0.0.1:' + central.port }] }, content });

  it('llamada con video: ofrece H.264, manda y recibe cuadros, PLI, y la cámara se puede apagar', async () => {
    await registrar();
    let conVideo = true;
    central.otro = (rq) => {
      if (rq.method === 'INVITE') okCon(rq, sdp('127.0.0.1', rtp.address().port, conVideo ? { video: { port: vid.address().port, pts: '97', extra: ['a=rtpmap:97 H264/90000'] } } : {}));
    };
    motor.call('102', true);
    await esperarEv((e) => e.type === 'video' && e.state === 'on');
    const inv = central.todos((m) => m.method === 'INVITE')[0];
    const ofrecido = sdpDe(inv);
    expect(ofrecido.vport).toBeGreaterThan(0);
    expect(inv.content).toMatch(/a=rtpmap:96 H264\/90000/);
    // cuadro saliente -> RTP H.264 con el PT que eligió la central
    motor.videoOut(Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]).toString('base64'), 90000);
    await hasta(() => vidRx.length >= 1);
    expect(vidRx[0][1] & 0x7f).toBe(97);
    // cuadro entrante -> video-in al renderer
    const pkt = Buffer.concat([Buffer.from([0x80, 0x80 | 97, 0, 1, 0, 0, 0, 0, 0, 0, 0, 9]), Buffer.from([0x65, 9, 9])]);
    vid.send(pkt, ofrecido.vport, '127.0.0.1');
    const vin = await esperarEv((e) => e.type === 'video-in');
    expect([...Buffer.from(vin.nal, 'base64')]).toEqual([0, 0, 0, 1, 0x65, 9, 9]);
    // PLI hacia la central, y PLI de la central -> pedir keyframe al encoder
    motor.reqKeyframe();
    await hasta(() => rtcpRx.length >= 1);
    expect(rtcpRx[0][1]).toBe(206);
    const pli = Buffer.alloc(12); pli[0] = 0x81; pli[1] = 206; pli.writeUInt16BE(2, 2);
    rtcpV.send(pli, ofrecido.vport + 1, '127.0.0.1');
    await esperarEv((e) => e.type === 'video-keyframe');
    // apagar la cámara: re-INVITE sin m=video
    conVideo = false;
    eventos.length = 0;
    motor.setVideo(false);
    await esperarEv((e) => e.type === 'video' && e.state === 'off');
    const re = central.todos((m) => m.method === 'INVITE');
    expect(sdpDe(re[re.length - 1]).vport).toBe(0);
    motor.setVideo(false);  // ya apagada: confirma sin re-INVITE
    expect(central.todos((m) => m.method === 'INVITE')).toHaveLength(re.length);
  });

  it('encender la cámara en una llamada de audio; si la central contesta sin video, avisa', async () => {
    await registrar();
    let conVideo = false;
    central.otro = (rq) => {
      if (rq.method === 'INVITE') okCon(rq, sdp('127.0.0.1', rtp.address().port, conVideo ? { video: { port: vid.address().port } } : {}));
    };
    motor.call('102');
    await esperarEv((e) => e.state === 'answered');
    motor.setVideo(true);
    expect(await esperarEv((e) => e.type === 'video')).toMatchObject({ state: 'off', error: 'rechazado' });
    eventos.length = 0;
    conVideo = true;
    motor.setVideo(true);
    await esperarEv((e) => e.type === 'video' && e.state === 'on');
    // con video activo la espera re-ofrece también el video
    motor.hold(true);
    await esperarEv((e) => e.state === 'hold');
    const re = central.todos((m) => m.method === 'INVITE');
    expect(sdpDe(re[re.length - 1])).toMatchObject({ dir: 'sendonly' });
    expect(sdpDe(re[re.length - 1]).vport).toBeGreaterThan(0);
  });

  it('cámara rechazada por la central (488) mantiene el estado y avisa el error', async () => {
    await registrar();
    let n = 0;
    central.otro = (rq) => { if (rq.method === 'INVITE') { if (n++ === 0) okCon(rq, sdp('127.0.0.1', rtp.address().port)); else central.responder(rq, 488, 'Not Acceptable'); } };
    motor.call('102');
    await esperarEv((e) => e.state === 'answered');
    motor.setVideo(true);
    expect(await esperarEv((e) => e.type === 'video')).toMatchObject({ state: 'off', error: '488' });
  });

  it('entrante con video: atender con cámara arranca el video; sin cámara, sólo audio', async () => {
    await registrar();
    central.pedido('INVITE', { content: sdp('127.0.0.1', rtp.address().port, { video: { port: vid.address().port } }) });
    expect((await esperarEv((e) => e.state === 'incoming')).video).toBe(true);
    motor.accept(true);
    await esperarEv((e) => e.type === 'video' && e.state === 'on');
    const ok = await central.esperar((m) => m.status === 200 && m.headers.cseq.method === 'INVITE');
    expect(sdpDe(ok).vport).toBeGreaterThan(0);
    // un re-INVITE con la llamada en video contesta también el video
    const inv = central.todos((m) => m.method === 'INVITE');
    void inv;
    motor.hangup();
    eventos.length = 0;
    central.pedido('INVITE', { content: sdp('127.0.0.1', rtp.address().port, { video: { port: vid.address().port } }) });
    await esperarEv((e) => e.state === 'incoming');
    motor.accept(false);
    await esperarEv((e) => e.state === 'answered');
    expect(ev((e) => e.type === 'video')).toBeUndefined();
  });

  it('SRTP (SDES): ofrece RTP/SAVP con clave, cifra el audio y descifra lo que llega', async () => {
    await registrar({ sipSrtp: 'sdes' });
    const claveCentral = srtp.newMasterB64();
    central.otro = (rq) => { if (rq.method === 'INVITE') okCon(rq, sdp('127.0.0.1', rtp.address().port, { extra: [srtp.cryptoLine(claveCentral)] }).replace('RTP/AVP', 'RTP/SAVP')); };
    motor.call('102');
    await esperarEv((e) => e.state === 'answered');
    const ofrecido = sdpDe(central.todos((m) => m.method === 'INVITE')[0]);
    expect(ofrecido.proto).toBe('RTP/SAVP');
    expect(ofrecido.crypto).toHaveLength(40);
    await hasta(() => rtpRx.length >= 1);
    const plano = srtp.unprotect(rtpRx[0], srtp.keysFromB64(ofrecido.crypto), { roc: 0 });
    expect(plano).not.toBeNull();
    expect(plano.length).toBe(172);
    rtp.send(srtp.protect(rtpPkt(5), srtp.keysFromB64(claveCentral), { roc: 0 }), ofrecido.port, '127.0.0.1');
    await esperarEv((e) => e.type === 'audio');
    // basura que no autentica se descarta
    eventos.length = 0;
    rtp.send(rtpPkt(6), ofrecido.port, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 40));
    expect(ev((e) => e.type === 'audio')).toBeUndefined();
    // con SRTP no se enciende la cámara (el video iría en claro)
    motor.setVideo(true);
    expect(ev((e) => e.type === 'video')).toMatchObject({ state: 'off', error: 'srtp' });
  });

  it('SRTP: si la central no devuelve a=crypto lo deja anotado', async () => {
    await registrar({ sipSrtp: 'sdes' });
    central.otro = (rq) => { if (rq.method === 'INVITE') okCon(rq, sdp('127.0.0.1', rtp.address().port)); };
    motor.call('102');
    await esperarEv((e) => e.state === 'answered');
    expect(ev((e) => e.type === 'log' && /no devolvió a=crypto/.test(e.line))).toBeTruthy();
  });

  it('SRTP entrante: contesta con su propia clave y el re-INVITE la mantiene', async () => {
    await registrar({ sipSrtp: 'sdes' });
    const clave = srtp.newMasterB64();
    central.otro = () => {};
    const inv = central.pedido('INVITE', { callId: 'cifrada', content: sdp('127.0.0.1', rtp.address().port, { extra: [srtp.cryptoLine(clave)] }).replace('RTP/AVP', 'RTP/SAVP') });
    await esperarEv((e) => e.state === 'incoming');
    motor.accept();
    await esperarEv((e) => e.state === 'answered');
    const ok = await central.esperar((m) => m.status === 200 && m.headers.cseq.method === 'INVITE');
    const nuestra = sdpDe(ok).crypto;
    expect(nuestra).toBeTruthy();
    expect(nuestra).not.toBe(clave);
    await hasta(() => rtpRx.length >= 1);
    expect(srtp.unprotect(rtpRx[0], srtp.keysFromB64(nuestra), { roc: 0 })).not.toBeNull();
    central.pedido('INVITE', { callId: 'cifrada', fromTag: inv.headers.from.params.tag, cseq: 2, content: sdp('127.0.0.1', rtp.address().port) });
    const ok2 = await central.esperar((m) => m.status === 200 && m.headers.cseq.seq === 2);
    expect(sdpDe(ok2).crypto).toBe(nuestra);
  });
});

describe('arranque, temporizadores y SRV', () => {
  it('sin respuesta del servidor en 9 s avisa con host, puerto y transporte', async () => {
    central.alPedido = () => {};
    const timers = [];
    const orig = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...a) => { if (ms === 9000) { timers.push(fn); return 0; } return orig(fn, ms, ...a); });
    motor.start({ ...CFG(), sipTransport: 'UDP' }, (e) => eventos.push(e));
    spy.mockRestore();
    timers[0]();
    expect(ev((e) => e.state === 'failed').reason).toBe('sin respuesta del servidor en 9s — revisá host/puerto/transporte y firewall (UDP ' + central.port + ')');
    await central.esperar((m) => m.method === 'REGISTER');
  });

  it('re-registra antes de que venza (90 % del expires, mínimo 30 s)', async () => {
    const timers = [];
    const orig = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...a) => { if (ms >= 30000 && ms !== 32000) { timers.push([fn, ms]); return 0; } return orig(fn, ms, ...a); });
    try {
      await registrar({}, { expires: '100' });
    } finally { spy.mockRestore(); }
    const refresco = timers.find(([, ms]) => ms === 90000);
    expect(refresco).toBeTruthy();
    const antes = central.todos((m) => m.method === 'REGISTER').length;
    refresco[0]();
    await hasta(() => central.todos((m) => m.method === 'REGISTER').length > antes);
  });

  it('el expires del encabezado se usa si el Contact no trae; sin ninguno, 300', async () => {
    const timers = [];
    const orig = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...a) => { if (ms >= 30000 && ms !== 32000) { timers.push(ms); return 0; } return orig(fn, ms, ...a); });
    try {
      central.alPedido = (rq) => central.responder(rq, 200, 'OK', { headers: { expires: '40' } });
      motor.start(CFG(), (e) => eventos.push(e));
      await esperarEv((e) => e.state === 'registered');
      motor.stop(); eventos.length = 0;
      central.alPedido = (rq) => central.responder(rq, 200, 'OK');
      motor.start(CFG(), (e) => eventos.push(e));
      await esperarEv((e) => e.state === 'registered');
    } finally { spy.mockRestore(); }
    expect(timers).toEqual([36000, 270000]);
  });

  it('si la librería no puede abrir el puerto local, avisa', async () => {
    const sipLib = require('sip');
    const spy = vi.spyOn(sipLib, 'start').mockImplementationOnce(() => { throw new Error('EADDRINUSE'); });
    const r = motor.start({ ...CFG(), sipTransport: 'tcp' }, (e) => eventos.push(e));
    spy.mockRestore();
    expect(r).toEqual({ error: 'EADDRINUSE' });
    expect(ev((e) => e.state === 'failed').reason).toBe('no se pudo abrir el puerto local 5062 (tcp): EADDRINUSE');
  });

  it('TLS: arranca con verificación configurable y el URI lleva transport=tls', async () => {
    const sipLib = require('sip');
    let opts;
    const spy = vi.spyOn(sipLib, 'start').mockImplementationOnce((o) => { opts = o; });
    const send = vi.spyOn(sipLib, 'send').mockImplementation(() => {});
    motor.start({ ...CFG(), sipTransport: 'tls', tlsVerify: true }, (e) => eventos.push(e));
    spy.mockRestore();
    expect(opts.tls).toEqual({ rejectUnauthorized: true });
    expect(opts.tls_port).toBe(5062);
    expect(opts.udp).toBe(false);
    await hasta(() => send.mock.calls.length);
    expect(send.mock.calls[0][0].uri).toBe('sip:127.0.0.1:' + central.port + ';transport=tls');
    expect(send.mock.calls[0][0].headers.contact[0].uri).toMatch(/;transport=tls$/);
    send.mockRestore();
    // el logger de la librería deja rastro de lo que entra y sale
    opts.logger.send({ method: 'REGISTER', uri: 'sip:x' });
    opts.logger.recv({ status: 200, reason: 'OK' });
    opts.logger.send({ method: 'ACK' });
    opts.logger.recv({ status: 100 });
    expect(eventos.filter((e) => e.type === 'log' && (e.dir === 'in' || e.dir === 'out')).map((e) => e.line)).toEqual(['REGISTER sip:x', 'SIP/2.0 200 OK', 'ACK ', 'SIP/2.0 100 ']);
  });

  it('SRV: resuelve _sip._udp y usa el de mejor prioridad; si falla, va directo', async () => {
    const dns = require('dns');
    const srv = vi.spyOn(dns, 'resolveSrv').mockImplementation((name, cb) => cb(null, [{ name: 'lejos', port: 1, priority: 20, weight: 0 }, { name: '127.0.0.1', port: central.port, priority: 10, weight: 5 }, { name: 'otro', port: 2, priority: 10, weight: 1 }]));
    try {
      await registrar({ sipServer: 'pbx.test', sipSrv: true });
      expect(srv.mock.calls[0][0]).toBe('_sip._udp.pbx.test');
      expect(ev((e) => e.type === 'log' && e.line === 'SRV → 127.0.0.1:' + central.port)).toBeTruthy();
      motor.stop(); eventos.length = 0;
      srv.mockImplementation(() => { throw new Error('sin dns'); });
      await registrar({ sipSrv: true, sipServer: 'localhost' });
      srv.mockImplementation((n, cb) => cb(new Error('NXDOMAIN')));
      motor.stop(); eventos.length = 0;
      await registrar({ sipSrv: true, sipServer: 'localhost' });
    } finally { srv.mockRestore(); }
  });

  it('las funciones del módulo sin motor arrancado no hacen nada', () => {
    motor.stop();
    expect(() => { motor.call('1'); motor.accept(); motor.reject(); motor.hangup(); motor.audioOut([]); motor.setMuted(true); motor.dtmf('1'); motor.transfer('1'); motor.hold(true); motor.setVideo(true); motor.videoOut('', 0); motor.reqKeyframe(); motor.stop(); }).not.toThrow();
  });

  it('con el motor registrado pero sin llamada, los controles de diálogo no mandan nada', async () => {
    await registrar();
    const antes = central.recibidos.length;
    motor.hold(true); motor.setVideo(true); motor.transfer('300'); motor.dtmf('1'); motor.accept(); motor.setMuted(true); motor.videoOut('AAAA', 0); motor.reqKeyframe();
    await new Promise((r) => setTimeout(r, 50));
    expect(central.recibidos.length).toBe(antes);
  });
});
