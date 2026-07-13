/* Sonda ICE/TURN real: levanta una RTCPeerConnection y observa que candidatos junta.
   relay > 0  => el TURN respondio Y autentico (credenciales malas => 401 y no hay relay).
   srflx > 0  => el STUN funciona (y nos da la IP publica). */
export async function fetchIceServers() {
  try { const r = await fetch('/backend/api/ice'); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d.iceServers) ? d.iceServers : []; } catch (_) { return []; }
}
export function probeIce(iceServers, timeoutMs = 7000) {
  const hasTurn = (iceServers || []).some((s) => /^turns?:/i.test(String(s.urls || s.url || '')) && s.username);
  const res = { state: 'testing', host: 0, srflx: 0, relay: 0, publicIp: '', relayIp: '', errors: [], turnConfigured: hasTurn, ms: 0 };
  const t0 = Date.now();
  return new Promise((resolve) => {
    let pc = null, done = false;
    const finish = (state) => { if (done) return; done = true; res.state = state; res.ms = Date.now() - t0; try { pc && pc.close(); } catch (_) {} resolve(res); };
    try { pc = new RTCPeerConnection({ iceServers: iceServers || [], iceTransportPolicy: 'all' }); }
    catch (e) { res.errors.push(String(e && e.message || e)); return finish('error'); }
    const verdict = () => res.relay > 0 ? 'ok' : (res.turnConfigured ? (res.errors.some((x) => /401|403|unauthor/i.test(x)) ? 'turn-auth' : 'turn-unreachable') : 'no-turn');
    const tmr = setTimeout(() => finish(verdict()), timeoutMs);
    pc.onicecandidate = (e) => {
      if (!e.candidate) { clearTimeout(tmr); return finish(verdict()); }
      const c = e.candidate, parts = String(c.candidate || '').split(' ');
      const typ = c.type || (String(c.candidate || '').match(/ typ (\w+)/) || [])[1];
      const addr = c.address || parts[4] || '';
      if (typ === 'host') res.host++;
      else if (typ === 'srflx') { res.srflx++; if (!res.publicIp) res.publicIp = addr; }
      else if (typ === 'relay') { res.relay++; if (!res.relayIp) res.relayIp = addr; }
    };
    pc.onicecandidateerror = (e) => {
      const code = e && (e.errorCode || e.errorcode), txt = (e && (e.errorText || e.errortext)) || '', url = (e && e.url) || '';
      if (code || txt) res.errors.push((code ? code + ' ' : '') + txt + (url ? ' (' + url + ')' : ''));
      if (code === 401 || code === 403) { clearTimeout(tmr); finish('turn-auth'); }
    };
    try { pc.createDataChannel('probe'); pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => { res.errors.push(String(e && e.message || e)); clearTimeout(tmr); finish('error'); }); }
    catch (e) { res.errors.push(String(e && e.message || e)); clearTimeout(tmr); finish('error'); }
  });
}
