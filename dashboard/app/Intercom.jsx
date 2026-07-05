'use client';
// Pared de video (columna agente + /intercom). Reproduce por MSE (fMP4 sobre
// WebSocket) desde go2rtc → atraviesa el proxy HTTPS sin UDP. stream:{id,label,type,base,src}
import { useEffect, useRef, useState } from 'react';
import { IconVideo, IconVideoOff, IconDeviceCctv, IconBell, IconReload, IconVolume, IconVolumeOff } from '@tabler/icons-react';

function MseTile({ stream }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('connecting'); // connecting | live | error
  const [muted, setMuted] = useState(true);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    const base = stream && stream.base, src = stream && stream.src;
    const video = videoRef.current;
    if (!base || !src || !video || typeof MediaSource === 'undefined') { setStatus('error'); return; }
    let stopped = false, ws = null, sb = null, queue = [];
    setStatus('connecting');
    const ms = new MediaSource();
    video.src = URL.createObjectURL(ms);
    video.muted = true;
    const flush = () => { if (!sb || sb.updating || !queue.length) return; try { sb.appendBuffer(queue.shift()); } catch (e) {} };
    const trim = () => { try { if (sb && sb.buffered.length) { const end = sb.buffered.end(sb.buffered.length - 1); if (video.currentTime < end - 2 || video.currentTime > end) video.currentTime = end - 0.4; if (sb.buffered.start(0) < end - 10 && !sb.updating) sb.remove(0, end - 8); } } catch (e) {} };
    ms.addEventListener('sourceopen', () => {
      const wsUrl = base.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/ws?src=' + encodeURIComponent(src);
      try { ws = new WebSocket(wsUrl); } catch (e) { setStatus('error'); return; }
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const cands = ['avc1.640029', 'avc1.64002A', 'avc1.4d002a', 'avc1.42e01e', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'opus'];
        const codecs = cands.filter(cc => { try { return MediaSource.isTypeSupported('video/mp4; codecs="' + cc + '"') || MediaSource.isTypeSupported('audio/mp4; codecs="' + cc + '"'); } catch (e) { return false; } }).join(',');
        ws.send(JSON.stringify({ type: 'mse', value: codecs }));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (msg.type === 'mse' && msg.value) { try { sb = ms.addSourceBuffer(msg.value); sb.mode = 'segments'; sb.addEventListener('updateend', () => { trim(); flush(); }); setStatus('live'); video.play().catch(() => {}); } catch (e) { setStatus('error'); } }
          else if (msg.type === 'error') { setStatus('error'); }
        } else {
          queue.push(new Uint8Array(ev.data)); if (queue.length > 80) queue = queue.slice(-40); flush();
        }
      };
      ws.onerror = () => { if (!stopped) setStatus('error'); };
      ws.onclose = () => { if (!stopped) setStatus(s => s === 'live' ? 'error' : s === 'connecting' ? 'error' : s); };
    });
    return () => { stopped = true; try { ws && ws.close(); } catch (e) {} try { if (ms.readyState === 'open') ms.endOfStream(); } catch (e) {} try { video.src = ''; } catch (e) {} };
  }, [stream && stream.base, stream && stream.src, gen]);

  const Icon = stream && stream.type === 'intercom' ? IconBell : IconDeviceCctv;
  function toggleMute() { const v = videoRef.current; if (v) { v.muted = !v.muted; setMuted(v.muted); if (!v.muted) v.play().catch(() => {}); } }
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 14, overflow: 'hidden', background: '#0b0f17', flex: 'none' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: status === 'live' ? 'block' : 'none' }} />
      {status === 'connecting' && <div className="ic-skel" style={{ position: 'absolute', inset: 0 }} />}
      {status === 'error' &&
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#8b95a3' }}>
          <IconVideoOff size={28} /><span style={{ fontSize: 12 }}>Sin señal</span>
          <button onClick={() => setGen(g => g + 1)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,.08)', color: '#cdd3db', border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}><IconReload size={13} /> Reintentar</button>
        </div>}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', background: 'linear-gradient(180deg,rgba(0,0,0,.62),transparent)', color: '#fff' }}>
        <Icon size={14} />
        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,.6)' }}>{(stream && stream.label) || 'Dispositivo'}</span>
        {status === 'live' && <button onClick={toggleMute} title={muted ? 'Activar audio' : 'Silenciar'} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', padding: 0 }}>{muted ? <IconVolumeOff size={15} /> : <IconVolume size={15} />}</button>}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, color: status === 'live' ? '#69db7c' : status === 'connecting' ? '#ffd43b' : '#ff8787' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: status === 'live' ? '#40c057' : status === 'connecting' ? '#fab005' : '#fa5252' }} className={status === 'live' ? 'ic-pulse' : ''} />
          {status === 'live' ? 'EN VIVO' : status === 'connecting' ? 'CARGANDO' : 'OFFLINE'}
        </span>
      </div>
    </div>
  );
}

function PlaceholderTile({ hint }) {
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 14, overflow: 'hidden', background: '#0b0f17', border: '1px dashed rgba(255,255,255,.10)', flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#8b95a3', textAlign: 'center', padding: 14 }}>
      <div className="ic-skel" style={{ position: 'absolute', inset: 0, opacity: .5 }} />
      <div style={{ position: 'relative', width: 46, height: 46, borderRadius: 12, background: 'rgba(255,255,255,.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,.08)' }}><IconVideo size={24} style={{ opacity: .7 }} /></div>
      {hint && <div style={{ position: 'relative', fontSize: 12, maxWidth: 260 }}>{hint}</div>}
    </div>
  );
}

export default function Intercom({ streams = [], columns = 1, emptyHint, bare = false }) {
  const wrap = { display: columns > 1 ? 'grid' : 'flex', flexDirection: 'column', gridTemplateColumns: columns > 1 ? `repeat(${columns},1fr)` : undefined, gap: 10, height: bare ? '100%' : undefined };
  return (
    <div style={wrap}>
      <style>{`
        @keyframes icShimmer{0%{background-position:-500px 0}100%{background-position:500px 0}}
        .ic-skel{background:linear-gradient(100deg,#0b0f17 30%,#1a2230 50%,#0b0f17 70%);background-size:1000px 100%;animation:icShimmer 1.3s linear infinite}
        @keyframes icPulse{0%,100%{opacity:1}50%{opacity:.3}}
        .ic-pulse{animation:icPulse 1.4s ease-in-out infinite}
      `}</style>
      {streams.length === 0 ? (
        <>
          <PlaceholderTile hint={emptyHint || 'El video del intercom y las cámaras del cliente aparecerá acá durante la llamada.'} />
          <PlaceholderTile />
        </>
      ) : (
        streams.map((s, i) => <MseTile key={(s.id || i) + ':' + (s.src || '')} stream={s} />)
      )}
    </div>
  );
}
