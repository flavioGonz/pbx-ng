// Probador ICE/TURN real: levanta una RTCPeerConnection y observa qué candidatos junta.
// relay > 0  => el TURN respondió Y autenticó (si las credenciales fueran malas, da 401 y no hay relay).
// srflx > 0  => el STUN funciona (y nos da la IP pública).
export function iceServersFrom(cfg) {
  const list = [];
  if (cfg.stun) list.push({ urls: cfg.stun });
  if (cfg.turn && cfg.turnUser && cfg.turnPass) {
    list.push({ urls: cfg.turn, username: cfg.turnUser, credential: cfg.turnPass });
    if (!/transport=/i.test(cfg.turn)) list.push({ urls: cfg.turn + '?transport=tcp', username: cfg.turnUser, credential: cfg.turnPass });
  }
  return list;
}

export function testIce(cfg, timeoutMs = 7000) {
  const res = { state: 'testing', host: 0, srflx: 0, relay: 0, publicIp: '', relayIp: '', errors: [], turnConfigured: !!(cfg.turn && cfg.turnUser && cfg.turnPass), stunConfigured: !!cfg.stun, ms: 0 };
  const t0 = Date.now();
  return new Promise((resolve) => {
    let pc = null, finished = false;
    const finish = (state) => {
      if (finished) return; finished = true;
      res.state = state; res.ms = Date.now() - t0;
      try { pc && pc.close(); } catch (_) {}
      resolve(res);
    };
    try { pc = new RTCPeerConnection({ iceServers: iceServersFrom(cfg), iceTransportPolicy: 'all' }); }
    catch (e) { res.errors.push(String(e && e.message || e)); return finish('error'); }

    const tmr = setTimeout(() => finish(res.relay > 0 ? 'ok' : (res.turnConfigured ? 'turn-unreachable' : 'no-turn')), timeoutMs);

    pc.onicecandidate = (e) => {
      if (!e.candidate) { clearTimeout(tmr); return finish(res.relay > 0 ? 'ok' : (res.turnConfigured ? (res.errors.some(x => /401|403|unauthor/i.test(x)) ? 'turn-auth' : 'turn-unreachable') : 'no-turn')); }
      const c = e.candidate;
      const parts = String(c.candidate || '').split(' ');
      const typ = c.type || (String(c.candidate || '').match(/ typ (\w+)/) || [])[1];
      const addr = c.address || parts[4] || '';
      if (typ === 'host') res.host++;
      else if (typ === 'srflx') { res.srflx++; if (!res.publicIp) res.publicIp = addr; }
      else if (typ === 'relay') { res.relay++; if (!res.relayIp) res.relayIp = addr; }
    };
    pc.onicecandidateerror = (e) => {
      const code = e && (e.errorCode || e.errorcode);
      const txt = (e && (e.errorText || e.errortext)) || '';
      const url = (e && e.url) || '';
      if (code || txt) res.errors.push((code ? code + ' ' : '') + txt + (url ? ' (' + url + ')' : ''));
      if (code === 401 || code === 403) { clearTimeout(tmr); finish('turn-auth'); }
    };
    try {
      pc.createDataChannel('probe');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => { res.errors.push(String(e && e.message || e)); clearTimeout(tmr); finish('error'); });
    } catch (e) { res.errors.push(String(e && e.message || e)); clearTimeout(tmr); finish('error'); }
  });
}
