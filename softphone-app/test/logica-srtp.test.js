/* SRTP del modo SIP nativo (electron/srtp.cjs): AES_CM_128_HMAC_SHA1_80 con claves SDES.
 * Es lo que hace que una llamada "cifrada" lo esté de verdad. Se fija contra el vector
 * de derivación de claves del RFC 3711 (B.3), ida y vuelta protect/unprotect, que un
 * paquete alterado o con la clave equivocada se DESCARTE (no se reproduzca basura), y el
 * manejo del ROC cuando el número de secuencia da la vuelta. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const srtp = require('../electron/srtp.cjs');

const hex = (h) => Buffer.from(h.replace(/\s+/g, ''), 'hex');

function rtp(seq, ssrc = 0xdeadbeef, payload = Buffer.from('hola mundo, audio de prueba')) {
  const h = Buffer.alloc(12); h[0] = 0x80; h[1] = 0; h.writeUInt16BE(seq, 2); h.writeUInt32BE(1234, 4); h.writeUInt32BE(ssrc, 8);
  return Buffer.concat([h, payload]);
}

describe('derivación de claves (RFC 3711 apéndice B.3)', () => {
  it('coincide con el vector del RFC', () => {
    const master = Buffer.concat([hex('E1F97A0D3E018BE0D64FA32C06DE4139'), hex('0EC675AD498AFEEBB6960B3AABE6')]);
    const k = srtp.deriveKeys(master);
    expect(k.ke.toString('hex').toUpperCase()).toBe('C61E7A93744F39EE10734AFE3FF7A087');
    expect(k.ks.toString('hex').toUpperCase()).toBe('30CBBC08863D8C85D49DB34A9AE1');
    expect(k.ka.toString('hex').toUpperCase()).toBe('CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4');
  });
});

describe('protect / unprotect', () => {
  const b64 = srtp.newMasterB64();
  const keys = srtp.keysFromB64(b64);

  it('la clave nueva son 30 bytes en base64 (40 caracteres)', () => {
    expect(b64).toHaveLength(40);
    expect(Buffer.from(b64, 'base64')).toHaveLength(30);
  });

  it('ida y vuelta: cifra el payload, agrega 10 bytes de tag, y descifra igual', () => {
    const p = rtp(100);
    const s = srtp.protect(p, keys, { roc: 0 });
    expect(s.length).toBe(p.length + 10);
    expect(s.slice(0, 12).equals(p.slice(0, 12))).toBe(true);     // cabecera en claro
    expect(s.slice(12, p.length).equals(p.slice(12))).toBe(false); // payload cifrado
    const ctx = { roc: 0 };
    expect(srtp.unprotect(s, keys, ctx).equals(p)).toBe(true);
    expect(ctx.lastSeq).toBe(100);
  });

  it('un bit alterado o la clave equivocada hacen fallar la autenticación', () => {
    const s = srtp.protect(rtp(5), keys, { roc: 0 });
    const mal = Buffer.from(s); mal[15] ^= 1;
    expect(srtp.unprotect(mal, keys, { roc: 0 })).toBeNull();
    const otra = srtp.keysFromB64(srtp.newMasterB64());
    expect(srtp.unprotect(s, otra, { roc: 0 })).toBeNull();
    const tag = Buffer.from(s); tag[tag.length - 1] ^= 0xff;
    expect(srtp.unprotect(tag, keys, { roc: 0 })).toBeNull();
  });

  it('un paquete más corto que cabecera+tag se descarta', () => {
    expect(srtp.unprotect(Buffer.alloc(21), keys, {})).toBeNull();
  });

  it('el ROC sube cuando la secuencia da la vuelta, en los dos extremos', () => {
    const tx = { roc: 0 }, rx = { roc: 0 };
    const a = srtp.protect(rtp(65535), keys, tx);
    const b = srtp.protect(rtp(0), keys, tx);
    expect(tx.roc).toBe(1);
    expect(srtp.unprotect(a, keys, rx)).not.toBeNull();
    expect(srtp.unprotect(b, keys, rx).equals(rtp(0))).toBe(true);
    expect(rx.roc).toBe(1);
  });

  it('un paquete atrasado de antes de la vuelta se autentica con el ROC anterior', () => {
    const tx = { roc: 0 };
    const viejo = srtp.protect(rtp(65530), keys, tx);
    const nuevo = srtp.protect(rtp(3), keys, tx);
    const rx = { roc: 0 };
    srtp.unprotect(srtp.protect(rtp(65529), keys, { roc: 0 }), keys, rx);
    expect(srtp.unprotect(nuevo, keys, rx)).not.toBeNull();
    expect(rx.roc).toBe(1);
    expect(srtp.unprotect(viejo, keys, rx).equals(rtp(65530))).toBe(true);
    expect(rx.roc).toBe(0);
  });

  it('el ROC del contexto sin inicializar arranca en 0', () => {
    const s = srtp.protect(rtp(9), keys, { roc: 0 });
    expect(srtp.unprotect(s, keys, {})).not.toBeNull();
  });
});

describe('SDES en el SDP', () => {
  it('keysFromB64 rechaza claves cortas o inválidas', () => {
    expect(srtp.keysFromB64('AAAA')).toBeNull();
    expect(srtp.keysFromB64(null)).toBeNull();
  });

  it('cryptoLine y parseCrypto son inversas', () => {
    const b64 = srtp.newMasterB64();
    const l = srtp.cryptoLine(b64);
    expect(l).toBe('a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' + b64);
    expect(srtp.cryptoLine(b64, 3)).toMatch(/^a=crypto:3 /);
    expect(srtp.parseCrypto('v=0\r\n' + l + '|2^20|1:32\r\n')).toBe(b64);
    expect(srtp.parseCrypto('a=crypto:1 AES_CM_128_HMAC_SHA1_32 inline:xx')).toBeNull();
    expect(srtp.parseCrypto()).toBeNull();
  });
});
