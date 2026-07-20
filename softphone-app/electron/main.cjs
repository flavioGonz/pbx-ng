// PBX-NG Softphone · proceso principal Electron
// Splash + bandeja + autostart + protocolo tel:/sip: + hotkeys + single-instance +
// notif + auto-update + puente HTTP (CORS) + motor SIP nativo (UDP/TCP/TLS).
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, ipcMain, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
let autoUpdater = null; try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}

const isDev = !app.isPackaged;
const DEBUG = isDev || process.env.SP_DEBUG === '1';
let win = null, splash = null, tray = null, pendingDial = null, pendingProv = null;

function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function dialFromArgs(argv) {
  const list = argv || [];
  const prov = list.find(x => /^pbxng:\/\//i.test(String(x)));
  if (prov) { if (win && win.webContents) { win.webContents.send('provision', String(prov)); showWin(); } else pendingProv = String(prov); return; }
  const a = list.find(x => /^(tel:|sip:|callto:)/i.test(String(x)));
  if (!a) return;
  const num = String(a).replace(/^(tel:|sip:|callto:)/i, '').replace(/[^\d*#+a-zA-Z@.:-]/g, '');
  if (!num) return;
  if (win && win.webContents) { win.webContents.send('dial', num); showWin(); }
  else pendingDial = num;
}

// ---- puente HTTP (sin CORS) ----
function httpRequest(opts, wantBinary) {
  return new Promise((resolve) => {
    try {
      const u = new URL(opts.url);
      const lib = u.protocol === 'http:' ? http : https;
      const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
      const body = opts.body != null ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
      if (body) headers['Content-Length'] = Buffer.byteLength(body);
      const req = lib.request({ method: opts.method || 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers, rejectUnauthorized: false, timeout: 15000 }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (wantBinary) return resolve({ status: res.statusCode, b64: buf.toString('base64'), type: res.headers['content-type'] || 'application/octet-stream' });
          let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) { json = null; }
          resolve({ status: res.statusCode, json, text: json == null ? buf.toString('utf8').slice(0, 500) : undefined });
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
      req.on('error', (e) => resolve({ error: e.message }));
      if (body) req.write(body);
      req.end();
    } catch (e) { resolve({ error: e.message }); }
  });
}
ipcMain.handle('sp-api', (_e, opts) => httpRequest(opts, false));
ipcMain.handle('sp-api-blob', (_e, opts) => httpRequest(opts, true));

// ---- motor SIP nativo (UDP/TCP/TLS) + llamadas + audio RTP ----
let sipNat = null; try { sipNat = require('./sip-udp.cjs'); } catch (_) {}
function sipEvt(evt) { try { if (!win) return; if (evt && evt.type === 'audio') win.webContents.send('sipnat-audio', evt.pcm); else if (evt && evt.type === 'video-in') win.webContents.send('sipnat-video', evt.nal); else win.webContents.send('sipnat-event', evt); } catch (_) {} }
ipcMain.handle('sipnat-connect', (_e, cfg) => { if (!sipNat) return { error: 'motor SIP no disponible' }; return sipNat.start(cfg, sipEvt); });
ipcMain.handle('sipnat-disconnect', () => { try { sipNat && sipNat.stop(); } catch (_) {} return { ok: true }; });
ipcMain.handle('sipnat-call', (_e, num, video) => { try { sipNat && sipNat.call(num, video); } catch (_) {} return { ok: true }; });
ipcMain.handle('sipnat-accept', (_e, video) => { try { sipNat && sipNat.accept(video); } catch (_) {} return { ok: true }; });
ipcMain.on('sipnat-video-out', (_e, b64, ts) => { try { sipNat && sipNat.videoOut(b64, ts); } catch (_) {} });
ipcMain.handle('sipnat-video-keyframe', () => { try { sipNat && sipNat.reqKeyframe(); } catch (_) {} return { ok: true }; });
ipcMain.handle('sipnat-reject', () => { try { sipNat && sipNat.reject(); } catch (_) {} return { ok: true }; });
ipcMain.handle('sipnat-hangup', () => { try { sipNat && sipNat.hangup(); } catch (_) {} return { ok: true }; });
ipcMain.handle('sipnat-mute', (_e, m) => { try { sipNat && sipNat.setMuted(m); } catch (_) {} return { ok: true }; });
ipcMain.on('sipnat-audio-out', (_e, b64) => { try { if (!sipNat) return; const buf = Buffer.from(b64, 'base64'); const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2); sipNat.audioOut(pcm); } catch (_) {} });
ipcMain.handle('sipnat-dtmf', (_e, d) => { try { sipNat && sipNat.dtmf(d); } catch (_) {} return { ok: true }; });
ipcMain.handle('sipnat-transfer', (_e, t) => { try { sipNat && sipNat.transfer(t); } catch (_) {} return { ok: true }; });

// ---- proxy WebSocket para go2rtc (MSE) — evita el bloqueo por Origin/auth desde file:// ----
let WS = null; try { WS = require('ws'); } catch (_) {}
const g2 = new Map(); let g2id = 0;
ipcMain.handle('go2rtc-open', (_e, opts) => {
  if (!WS) return { error: 'ws no disponible' };
  try {
    const id = ++g2id;
    const headers = {};
    if (opts && opts.origin) headers['Origin'] = opts.origin;
    if (opts && opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
    const ws = new WS(opts.url, { headers, rejectUnauthorized: false, handshakeTimeout: 12000 });
    g2.set(id, ws);
    const send = (m) => { try { win && win.webContents.send('go2rtc-msg', Object.assign({ id }, m)); } catch (_) {} };
    ws.on('open', () => send({ ev: 'open' }));
    ws.on('message', (data, isBinary) => { try { if (isBinary) send({ ev: 'bin', b64: Buffer.from(data).toString('base64') }); else send({ ev: 'text', data: data.toString() }); } catch (_) {} });
    ws.on('close', () => { g2.delete(id); send({ ev: 'close' }); });
    ws.on('error', (err) => send({ ev: 'error', msg: err && err.message }));
    return { id };
  } catch (e) { return { error: e.message }; }
});
ipcMain.on('go2rtc-send', (_e, m) => { const ws = g2.get(m && m.id); if (ws && ws.readyState === 1) { try { ws.send(m.data); } catch (_) {} } });
ipcMain.on('go2rtc-close', (_e, id) => { const ws = g2.get(id); if (ws) { try { ws.close(); } catch (_) {} } g2.delete(id); });

// ---- auto-update visible ----
let updaterWired = false;
function wireUpdater() {
  if (!autoUpdater || updaterWired) return; updaterWired = true;
  const send = (m) => { try { win && win.webContents.send('update-status', m); } catch (_) {} };
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => send({ state: 'available', version: i && i.version }));
  autoUpdater.on('update-not-available', () => send({ state: 'none' }));
  autoUpdater.on('error', (e) => send({ state: 'error', msg: e && e.message }));
  autoUpdater.on('download-progress', (pr) => send({ state: 'downloading', percent: Math.round((pr && pr.percent) || 0) }));
  autoUpdater.on('update-downloaded', (i) => send({ state: 'downloaded', version: i && i.version }));
}
ipcMain.handle('update-check', async () => { try { if (!autoUpdater) { win && win.webContents.send('update-status', { state: 'error', msg: 'updater no disponible' }); return { ok: false }; } await autoUpdater.checkForUpdates(); } catch (e) { try { win && win.webContents.send('update-status', { state: 'error', msg: (e && e.message) || 'error' }); } catch (_) {} } return { ok: true }; });
ipcMain.handle('update-install', () => { try { app.__quitting = true; autoUpdater && autoUpdater.quitAndInstall(); } catch (_) {} return { ok: true }; });
// ---- controles de ventana (frameless) ----
ipcMain.on('win-minimize', () => { try { win && win.minimize(); } catch (_) {} });
ipcMain.on('win-close', () => { try { win && win.close(); } catch (_) {} }); // el handler 'close' lo esconde a bandeja
ipcMain.on('win-size', (_e, sz) => { try { if (win && sz && sz.w && sz.h) { win.setResizable(true); win.setSize(Math.round(sz.w), Math.round(sz.h)); win.center(); win.setResizable(false); } } catch (_) {} });
let shakeIv = null, shakeHome = null, shakeWin = null;
ipcMain.on('win-shake', (_e, on) => {
  try {
    if (on) {
      if (shakeIv) return;
      const target = (mini && !mini.isDestroyed() && mini.isVisible()) ? mini : win; // si estás en mini, vibra el mini
      if (!target) return;
      shakeWin = target; const p = target.getPosition(); shakeHome = { x: p[0], y: p[1] }; let n = 0;
      shakeIv = setInterval(() => { if (!shakeWin || !shakeHome) return; const dx = [0, 2, 0, -2, 1, -1][n % 6], dy = [1, -1, 2, 0, -2, 0][n % 6]; try { shakeWin.setPosition(shakeHome.x + dx, shakeHome.y + dy); } catch (_) {} n++; }, 55); }
    else { if (shakeIv) { clearInterval(shakeIv); shakeIv = null; } if (shakeWin && shakeHome) { try { shakeWin.setPosition(shakeHome.x, shakeHome.y); } catch (_) {} } shakeHome = null; shakeWin = null; }
  } catch (_) {}
});

// ---- almacén cifrado de config (DPAPI vía safeStorage) ----
const securePath = () => path.join(app.getPath('userData'), 'sp-secure.bin');
ipcMain.handle('secure-available', () => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } });
ipcMain.handle('secure-load', () => { try { if (!safeStorage.isEncryptionAvailable()) return null; const p = securePath(); if (!fs.existsSync(p)) return null; return safeStorage.decryptString(fs.readFileSync(p)); } catch (_) { return null; } });
ipcMain.handle('secure-save', (_e, data) => { try { if (!safeStorage.isEncryptionAvailable()) return { ok: false }; fs.writeFileSync(securePath(), safeStorage.encryptString(String(data || ''))); return { ok: true }; } catch (e) { return { error: e.message }; } });

// ---- mini-widget flotante de llamada (always-on-top) ----
let mini = null, miniState = null, mainHiddenByMini = false;
function createMini() {
  if (mini) return mini;
  let x, y;
  try { const { screen } = require('electron'); const wa = screen.getPrimaryDisplay().workAreaSize; x = wa.width - 304; y = wa.height - 158; } catch (_) {}
  mini = new BrowserWindow({
    width: 284, height: 132, x, y, frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false, backgroundColor: '#00000000', maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  mini.loadFile(path.join(__dirname, 'mini.html'));
  mini.on('closed', () => { mini = null; });
  return mini;
}
function hideMini() { try { mini && mini.hide(); } catch (_) {} if (mainHiddenByMini) { mainHiddenByMini = false; showWin(); } }
ipcMain.on('mini-state', (_e, st) => {
  miniState = st;
  try { mini && mini.webContents.send('mini-state', st); } catch (_) {}
});
ipcMain.on('mini-ready', () => { try { mini && miniState && mini.webContents.send('mini-state', miniState); } catch (_) {} });
ipcMain.handle('mini-show', (_e, on) => {
  try {
    if (on) {
      createMini();
      try { mini.showInactive(); } catch (_) { mini.show(); }
      try { mini.setAlwaysOnTop(true, 'floating'); } catch (_) {}
      if (miniState) { try { mini.webContents.send('mini-state', miniState); } catch (_) {} }
      if (win && win.isVisible()) { mainHiddenByMini = true; win.hide(); }
    } else hideMini();
  } catch (_) {}
  return { ok: true };
});
ipcMain.on('mini-action', (_e, m) => {
  try {
    const act = (m && typeof m === 'object') ? m.a : m;
    const val = (m && typeof m === 'object') ? m.v : undefined;
    if (act === 'restore') { try { mini && mini.hide(); } catch (_) {} mainHiddenByMini = false; showWin(); return; }
    if (win) win.webContents.send('mini-action', { a: act, v: val });
    // estas acciones necesitan la ventana grande
    if (act === 'accept-video' || act === 'dial' || act === 'devices') { try { mini && mini.hide(); } catch (_) {} mainHiddenByMini = false; showWin(); }
  } catch (_) {}
});

const MEDIA_PERMS = ['media', 'microphone', 'camera', 'audioCapture', 'videoCapture', 'notifications', 'display-capture'];

function createSplash() {
  splash = new BrowserWindow({
    width: 340, height: 300, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, center: true, skipTaskbar: true, backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { v: app.getVersion() } });
  splash.on('closed', () => { splash = null; });
}

function createWindow() {
  win = new BrowserWindow({
    width: 920, height: 640, resizable: false, maximizable: false, fullscreenable: false, show: false, frame: false,
    backgroundColor: '#0b1220', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  if (isDev && process.env.SP_DEV_URL) win.loadURL(process.env.SP_DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(MEDIA_PERMS.includes(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => MEDIA_PERMS.includes(perm));
  try { ses.setDevicePermissionHandler(() => true); } catch (_) {}

  const reveal = () => {
    if (pendingDial) { win.webContents.send('dial', pendingDial); pendingDial = null; }
    if (pendingProv) { win.webContents.send('provision', pendingProv); pendingProv = null; }
    if (splash) { setTimeout(() => { try { splash && splash.close(); } catch (_) {} }, 400); }
    if (!process.argv.includes('--hidden')) showWin();
    if (DEBUG) { try { win.webContents.openDevTools({ mode: 'detach' }); } catch (_) {} }
  };
  win.once('ready-to-show', reveal);
  win.webContents.on('did-finish-load', () => setTimeout(reveal, 300));
  win.on('close', (e) => { if (!app.__quitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip('PBX-NG Softphone v' + app.getVersion());
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: showWin },
    { type: 'separator' },
    { label: 'Iniciar con Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => { app.setLoginItemSettings({ openAtLogin: mi.checked, args: ['--hidden'] }); rebuild(); } },
    { label: 'Herramientas de desarrollo', click: () => { if (win) { showWin(); try { win.webContents.openDevTools({ mode: 'detach' }); } catch (_) {} } } },
    { type: 'separator' },
    { label: 'PBX-NG Softphone v' + app.getVersion(), enabled: false },
    { label: 'Salir', click: () => { app.__quitting = true; app.quit(); } },
  ]));
  rebuild();
  tray.on('click', showWin);
}

function registerShortcuts() {
  const send = (a) => { if (win && win.webContents) win.webContents.send('hotkey', a); };
  globalShortcut.register('CommandOrControl+Shift+A', () => { showWin(); send('answer'); });
  globalShortcut.register('CommandOrControl+Shift+H', () => send('hangup'));
  globalShortcut.register('CommandOrControl+Shift+M', () => send('mute'));
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// tolerar certificados internos/self-signed (go2rtc/API por HTTPS interno)
app.on('certificate-error', (e, _wc, _url, _err, _cert, cb) => { e.preventDefault(); cb(true); });

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', (_e, argv) => { showWin(); dialFromArgs(argv); });
  app.on('open-url', (e, url) => { e.preventDefault(); dialFromArgs([url]); });
  app.on('before-quit', () => { app.__quitting = true; try { sipNat && sipNat.stop(); } catch (_) {} try { mini && mini.destroy(); } catch (_) {} });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* queda en bandeja */ });
  app.whenReady().then(() => {
    try { ['tel', 'sip', 'callto', 'pbxng'].forEach(p => app.setAsDefaultProtocolClient(p)); } catch (_) {}
    createSplash(); createWindow(); createTray(); registerShortcuts();
    // Re-registro automático: al despertar la PC o volver la red
    try {
      const sys = (e) => { try { win && win.webContents.send('sys-event', e); } catch (_) {} };
      powerMonitor.on('resume', () => sys('resume'));
      powerMonitor.on('suspend', () => sys('suspend'));
      powerMonitor.on('unlock-screen', () => sys('resume'));
    } catch (_) {}
    dialFromArgs(process.argv);
    wireUpdater(); if (autoUpdater && !isDev) { try { autoUpdater.checkForUpdates(); } catch (_) {} }
  });
}
