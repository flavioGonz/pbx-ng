// SRTP AES_CM_128_HMAC_SHA1_80 (RFC 3711) + claves SDES (RFC 4568), con node crypto.
// Perfil único: AES_CM_128_HMAC_SHA1_80 (master 16B key + 14B salt = 30B → base64 40 chars).
const crypto = require('crypto');

function aesCmKeystream(key, iv, n) { const c = crypto.createCipheriv('aes-128-ctr', key, iv); return Buffer.concat([c.update(Buffer.alloc(n)), c.final()]); }

// Derivación de claves de sesión (RFC 3711 §4.3), key_derivation_rate=0
function deriveKeys(master30) {
  const mk = master30.slice(0, 16), ms = master30.slice(16, 30);
  const kdf = (label, len) => { const iv = Buffer.alloc(16); ms.copy(iv, 0, 0, 14); iv[7] ^= label; return aesCmKeystream(mk, iv, len); };
  return { ke: kdf(0x00, 16), ka: kdf(0x01, 20), ks: kdf(0x02, 14) };
}

function srtpIv(ks, ssrc, index) {
  const iv = Buffer.alloc(16); ks.copy(iv, 0, 0, 14);
  iv[4] ^= (ssrc >>> 24) & 0xff; iv[5] ^= (ssrc >>> 16) & 0xff; iv[6] ^= (ssrc >>> 8) & 0xff; iv[7] ^= ssrc & 0xff;
  const hi = Math.floor(index / 0x100000000), lo = index >>> 0;
  iv[8] ^= (hi >>> 8) & 0xff; iv[9] ^= hi & 0xff;
  iv[10] ^= (lo >>> 24) & 0xff; iv[11] ^= (lo >>> 16) & 0xff; iv[12] ^= (lo >>> 8) & 0xff; iv[13] ^= lo & 0xff;
  return iv;
}
function authTag(ka, data, roc) { const h = crypto.createHmac('sha1', ka); h.update(data); const r = Buffer.alloc(4); r.writeUInt32BE(roc >>> 0, 0); h.update(r); return h.digest().slice(0, 10); }

// ctx: { roc, lastSeq }
function protect(pkt, keys, ctx) {
  const seq = pkt.readUInt16BE(2), ssrc = pkt.readUInt32BE(8);
  if (ctx.lastSeq != null && seq < ctx.lastSeq && (ctx.lastSeq - seq) > 32768) ctx.roc = (ctx.roc + 1) >>> 0;
  ctx.lastSeq = seq;
  const index = ctx.roc * 0x10000 + seq;
  const header = pkt.slice(0, 12), payload = pkt.slice(12);
  const iv = srtpIv(keys.ks, ssrc, index);
  const c = crypto.createCipheriv('aes-128-ctr', keys.ke, iv);
  const enc = Buffer.concat([c.update(payload), c.final()]);
  const body = Buffer.concat([header, enc]);
  return Buffer.concat([body, authTag(keys.ka, body, ctx.roc)]);
}
function unprotect(srtp, keys, ctx) {
  if (srtp.length < 22) return null;
  const body = srtp.slice(0, srtp.length - 10), tag = srtp.slice(srtp.length - 10);
  const seq = body.readUInt16BE(2), ssrc = body.readUInt32BE(8);
  // estimación de ROC (RFC 3711 §3.3.1, simplificada)
  let roc = ctx.roc || 0;
  if (ctx.lastSeq != null) { if (seq < ctx.lastSeq && (ctx.lastSeq - seq) > 32768) roc = (roc + 1) >>> 0; else if (seq > ctx.lastSeq && (seq - ctx.lastSeq) > 32768 && roc > 0) roc = (roc - 1) >>> 0; }
  const expect = authTag(keys.ka, body, roc);
  if (!crypto.timingSafeEqual(expect, tag)) return null; // auth falla → descartar
  ctx.roc = roc; ctx.lastSeq = seq;
  const index = roc * 0x10000 + seq;
  const header = body.slice(0, 12), enc = body.slice(12);
  const iv = srtpIv(keys.ks, ssrc, index);
  const c = crypto.createDecipheriv('aes-128-ctr', keys.ke, iv);
  const dec = Buffer.concat([c.update(enc), c.final()]);
  return Buffer.concat([header, dec]);
}

function newMasterB64() { return crypto.randomBytes(30).toString('base64'); }
function keysFromB64(b64) { try { const m = Buffer.from(b64, 'base64'); if (m.length < 30) return null; return deriveKeys(m.slice(0, 30)); } catch (_) { return null; } }
// parsea "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:BASE64|..." → base64 de la master
function parseCrypto(sdp) { const m = String(sdp || '').match(/a=crypto:\d+\s+AES_CM_128_HMAC_SHA1_80\s+inline:([A-Za-z0-9+/=]+)/i); return m ? m[1] : null; }
function cryptoLine(masterB64, tag) { return 'a=crypto:' + (tag || 1) + ' AES_CM_128_HMAC_SHA1_80 inline:' + masterB64; }

module.exports = { deriveKeys, keysFromB64, protect, unprotect, newMasterB64, parseCrypto, cryptoLine };
