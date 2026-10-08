/* Una "central" SIP falsa sobre UDP en 127.0.0.1 para probar electron/sip-udp.cjs de
 * verdad: recibe lo que manda el softphone, contesta lo que la prueba le diga (con desafío
 * digest real) y también puede originar pedidos (INVITE entrante, BYE, re-INVITE...).
 * Usa el parser/serializador de la misma librería `sip` que usa el softphone, pero sólo
 * sus funciones puras: el stack de transporte es el del softphone. */
import { createRequire } from 'node:module';
import dgram from 'node:dgram';
import { hasta } from './logica-red.js';
const require = createRequire(import.meta.url);
const sip = require('sip');
const digest = require('sip/digest');

let n = 0;
const rnd = () => Date.now().toString(36) + (++n);

export class CentralFalsa {
  constructor() { this.recibidos = []; this.alPedido = null; this.alRespuesta = null; this.auth = { realm: 'pbx.test' }; }

  async arrancar() {
    this.sock = dgram.createSocket('udp4');
    await new Promise((r) => this.sock.bind(0, '127.0.0.1', r));
    this.port = this.sock.address().port;
    this.sock.on('message', (buf, rinfo) => {
      let m; try { m = sip.parse(buf.toString()); } catch { return; }
      if (!m) return;
      m._rinfo = rinfo;
      this.recibidos.push(m);
      try {
        if (m.method) { if (this.alPedido) this.alPedido(m); }
        else if (this.alRespuesta) this.alRespuesta(m);
      } catch (e) { this.error = e; }
    });
    return this;
  }

  cerrar() { try { this.sock.close(); } catch {} }

  enviar(msg, rinfo) {
    const s = sip.stringify(msg);
    this.sock.send(Buffer.from(s), rinfo.port, rinfo.address);
  }

  /* Responder a un pedido recibido. `ext` = { headers, content }. */
  responder(rq, status, reason, ext) {
    const rs = sip.makeResponse(rq, status, reason, ext);
    this.enviar(rs, rq._rinfo);
    return rs;
  }

  /* 401 con desafío digest de verdad. */
  desafiar(rq, status = 401) {
    const rs = sip.makeResponse(rq, status, status === 407 ? 'Proxy Authentication Required' : 'Unauthorized');
    rs.headers.to = { ...rq.headers.to, params: { ...(rq.headers.to.params || {}) } };
    digest.challenge(this.auth, rs);
    this.enviar(rs, rq._rinfo);
  }

  autenticado(rq, user, password) {
    const h = rq.headers.authorization || rq.headers['proxy-authorization'];
    if (!h) return false;
    this.auth.proxy = !!rq.headers['proxy-authorization'];
    return digest.authenticateRequest(this.auth, rq, { user, password });
  }

  /* Arma un pedido "de la central" hacia el softphone (que escucha en 5062). */
  pedido(method, { callId = rnd(), from = 'sip:200@pbx.test', fromTag = rnd(), to = 'sip:101@pbx.test', toTag, cseq = 1, content, headers = {} } = {}) {
    const rq = {
      method, uri: 'sip:101@127.0.0.1:5062', version: '2.0',
      headers: {
        via: [{ version: '2.0', protocol: 'UDP', host: '127.0.0.1', port: this.port, params: { branch: 'z9hG4bK' + rnd(), rport: null } }],
        to: { uri: to, params: toTag ? { tag: toTag } : {} },
        from: { uri: from, params: { tag: fromTag } },
        'call-id': callId, cseq: { method, seq: cseq },
        contact: [{ uri: 'sip:200@127.0.0.1:' + this.port }],
        'max-forwards': 70,
        ...headers,
      },
    };
    if (content) { rq.content = content; rq.headers['content-type'] = 'application/sdp'; }
    this.enviar(rq, { address: '127.0.0.1', port: 5062 });
    return rq;
  }

  async esperar(pred, ms = 4000) { return hasta(() => this.recibidos.find(pred), ms); }
  todos(pred) { return this.recibidos.filter(pred); }
}

export function sdp(ip, port, { pts = '0 101', extra = [], video } = {}) {
  const l = ['v=0', 'o=- 1 1 IN IP4 ' + ip, 's=-', 'c=IN IP4 ' + ip, 't=0 0', 'm=audio ' + port + ' RTP/AVP ' + pts, 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', ...extra];
  if (video) l.push('m=video ' + video.port + ' RTP/AVP ' + (video.pts || '96'), ...(video.extra || ['a=rtpmap:96 H264/90000']));
  return l.join('\r\n') + '\r\n';
}
