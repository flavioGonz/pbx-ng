const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sphone', {
  isElectron: true,
  onDial: (cb) => ipcRenderer.on('dial', (_e, num) => cb(num)),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  api: (opts) => ipcRenderer.invoke('sp-api', opts),
  apiBlob: (opts) => ipcRenderer.invoke('sp-api-blob', opts),
  // motor SIP nativo: registro + llamadas + audio
  sipConnect: (cfg) => ipcRenderer.invoke('sipnat-connect', cfg),
  sipDisconnect: () => ipcRenderer.invoke('sipnat-disconnect'),
  sipCall: (num, video) => ipcRenderer.invoke('sipnat-call', num, video),
  sipAccept: (video) => ipcRenderer.invoke('sipnat-accept', video),
  sipReject: () => ipcRenderer.invoke('sipnat-reject'),
  sipHangup: () => ipcRenderer.invoke('sipnat-hangup'),
  sipMute: (m) => ipcRenderer.invoke('sipnat-mute', m),
  sipDtmf: (d) => ipcRenderer.invoke('sipnat-dtmf', d),
  sipTransfer: (t) => ipcRenderer.invoke('sipnat-transfer', t),
  sipAudioOut: (b64) => ipcRenderer.send('sipnat-audio-out', b64),
  sipVideoOut: (b64, ts) => ipcRenderer.send('sipnat-video-out', b64, ts),        // Annex-B (base64) → main
  sipVideoKeyframe: () => ipcRenderer.invoke('sipnat-video-keyframe'),             // pedir IDR al otro lado
  onSipEvent: (cb) => ipcRenderer.on('sipnat-event', (_e, evt) => cb(evt)),
  onSipAudio: (cb) => ipcRenderer.on('sipnat-audio', (_e, pcm) => cb(pcm)),
  onSipVideo: (cb) => ipcRenderer.on('sipnat-video', (_e, nal) => cb(nal)),        // Annex-B (base64) del otro lado
  onProvision: (cb) => ipcRenderer.on('provision', (_e, url) => cb(url)),
  // config cifrada (safeStorage/DPAPI)
  secureAvailable: () => ipcRenderer.invoke('secure-available'),
  secureLoad: () => ipcRenderer.invoke('secure-load'),
  secureSave: (data) => ipcRenderer.invoke('secure-save', data),
  // auto-update visible
  onUpdate: (cb) => { const h = (_e, m) => cb(m); ipcRenderer.on('update-status', h); return () => ipcRenderer.removeListener('update-status', h); },
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  // controles de ventana (frameless)
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winClose: () => ipcRenderer.send('win-close'),
  winSize: (w, h) => ipcRenderer.send('win-size', { w, h }),
  winShake: (on) => ipcRenderer.send('win-shake', on),
  // mini-widget de llamada
  miniShow: (on) => ipcRenderer.invoke('mini-show', on),
  miniState: (st) => ipcRenderer.send('mini-state', st),
  miniAction: (a, v) => ipcRenderer.send('mini-action', { a, v }),
  miniReady: () => ipcRenderer.send('mini-ready'),
  onMiniState: (cb) => { const h = (_e, st) => cb(st); ipcRenderer.on('mini-state', h); return () => ipcRenderer.removeListener('mini-state', h); },
  onMiniAction: (cb) => { const h = (_e, a) => cb(a); ipcRenderer.on('mini-action', h); return () => ipcRenderer.removeListener('mini-action', h); },
  onSysEvent: (cb) => { const h = (_e, e) => cb(e); ipcRenderer.on('sys-event', h); return () => ipcRenderer.removeListener('sys-event', h); },
  // proxy go2rtc (MSE) por el main
  go2rtcOpen: (opts) => ipcRenderer.invoke('go2rtc-open', opts),
  go2rtcSend: (id, data) => ipcRenderer.send('go2rtc-send', { id, data }),
  go2rtcClose: (id) => ipcRenderer.send('go2rtc-close', id),
  onGo2rtcMsg: (cb) => { const h = (_e, m) => cb(m); ipcRenderer.on('go2rtc-msg', h); return () => ipcRenderer.removeListener('go2rtc-msg', h); },
});
