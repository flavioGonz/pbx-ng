/* ============================================================================
 *  PBX-NG · Una llamada de mentira para el pipeline de IA (ai-pipeline.js).
 *
 *  Asterisk es un ARI falso más el lado cliente del AudioSocket, que habla el protocolo
 *  de tramas (0x01 UUID, 0x10 audio, 0x00 fin): «crea» el canal de medios, se conecta al
 *  servidor del pipeline y le manda audio. Lo usan ai-pipeline.test.js y
 *  ia-externa-llamada.test.js.
 * ==========================================================================*/
'use strict';
const net = require('net');
const { EventEmitter } = require('events');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 4000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { const v = await fn(); if (v) return v; await dormir(25); }
  return fn();
}
function puertoLibre() {
  return new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
}
function asteriskFalso() {
  const ari = { colgados: [], dtmf: [], medios: [], puentes: [] };
  ari.Bridge = () => {
    const b = { canales: [], destruido: false, async create(o) { b.tipo = o.type; }, async addChannel({ channel }) { b.canales.push(channel); }, async destroy() { b.destruido = true; } };
    ari.puentes.push(b);
    return b;
  };
  ari.channels = {
    async externalMedia(o) {
      const m = { id: 'em-' + ari.medios.length, o, recibido: [], socket: null };
      ari.medios.push(m);
      if (ari.falloMedios) throw new Error('externalMedia falló');
      const [host, port] = o.external_host.split(':');
      const s = net.connect({ host, port: Number(port) });
      m.socket = s;
      let buf = Buffer.alloc(0);
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 3) { const len = buf.readUInt16BE(1); if (buf.length < 3 + len) break; m.recibido.push(buf.slice(3, 3 + len)); buf = buf.slice(3 + len); }
      });
      s.on('error', () => {});
      const uuid = Buffer.from((ari.uuidOtro || o.data).replace(/-/g, ''), 'hex');
      const h = Buffer.from([0x01, 0, 16]);
      await new Promise((ok) => s.once('connect', ok));
      s.write(Buffer.concat([h, uuid]));
      return { id: m.id };
    },
    async hangup({ channelId }) { ari.colgados.push(channelId); if (ari.falloColgar) throw new Error('500'); },
    async sendDTMF(o) { ari.dtmf.push(o); },
    async list() { return ari.lista || []; },
  };
  return ari;
}
/* El canal del que llama. */
function canal(numero = '099123456') {
  const c = new EventEmitter();
  Object.assign(c, {
    id: 'ch-' + Math.random().toString(36).slice(2), caller: { number: numero }, respondido: false, colgado: false, derivado: null, vars: {},
    async answer() { c.respondido = true; },
    async hangup() { c.colgado = true; if (c.falloColgar) throw new Error(c.falloColgar); },
    async continueInDialplan(o) { if (c.falloDerivar) throw new Error('no'); c.derivado = o; },
    async setChannelVar({ variable, value }) { if (c.falloVar) throw new Error('var'); c.vars[variable] = value; },
  });
  return c;
}
/* Audio del llamante: tramas de 20 ms con un nivel dado (0 = silencio). */
function hablar(m, tramas = 20, nivel = 3000) {
  for (let i = 0; i < tramas; i++) {
    const pcm = Buffer.alloc(320);
    for (let j = 0; j < 160; j++) pcm.writeInt16LE(j % 2 ? nivel : -nivel, j * 2);
    m.socket.write(Buffer.concat([Buffer.from([0x10, 0x01, 0x40]), pcm]));
  }
}
const audioDe = (m) => m.recibido.reduce((n, b) => n + b.length, 0);

module.exports = { dormir, hasta, puertoLibre, asteriskFalso, canal, hablar, audioDe };
