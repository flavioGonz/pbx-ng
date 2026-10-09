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
/* UNA sola ventana al arrancar. Antes habia dos: una ventana `splash.html` de 340x300 que
 * se abria enseguida, y despues la ventana grande con el splash que dibuja la propia app
 * (el de `src/App.jsx`). O sea, dos pantallas de carga distintas, una chica y una grande,
 * una atras de la otra. Se retira la chica: la grande ya hace el trabajo, y la ventana
 * principal nace con `show: false` y recien aparece en `ready-to-show`, asi que no hay
 * destello blanco ni marco vacio.
 *
 * Lo que se paga: en una maquina lenta pasan uno o dos segundos entre el doble clic y la
 * ventana, sin nada en pantalla. Es el precio de no mostrar un marco vacio antes de tiempo,
 * y es lo que recomienda Electron para esto. */
let win = null, tray = null, pendingDial = null, pendingProv = null;

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
ipcMain.handle('sipnat-hold', (_e, on) => { try { sipNat && sipNat.hold(!!on); } catch (_) {} return { ok: true }; });
ipcMain.handle('sipnat-setvideo', (_e, on) => { try { sipNat && sipNat.setVideo(!!on); } catch (_) {} return { ok: true }; });

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

/* ---- go2rtc PROPIO, para las camaras cargadas a mano en este telefono ----
 * Chromium no reproduce rtsp://, y una camara que el usuario cargo aca no esta publicada
 * en ningun go2rtc. La app trae el suyo y lo levanta en loopback por demanda; de ahi en
 * adelante el camino es el mismo que el de una camara de la central y lo atiende el mismo
 * proxy de arriba. Ver electron/go2rtc-local.cjs para el por que de cada decision. */
let g2local = null;
try {
  g2local = require('./go2rtc-local.cjs')({
    app,
    log: (campos, msg) => { if (DEBUG) { try { console.log('[g2local]', msg, JSON.stringify(campos)); } catch (_) {} } },
  });
} catch (e) { if (DEBUG) console.log('[g2local] no disponible:', e && e.message); }
ipcMain.handle('g2local-asegurar', async (_e, cams) => {
  if (!g2local) return { ok: false, motivo: 'motor de video local no disponible en esta version' };
  try { return await g2local.asegurar(cams); } catch (e) { return { ok: false, motivo: (e && e.message) || 'error' }; }
});
ipcMain.handle('g2local-estado', () => (g2local ? g2local.estado() : { disponible: false, corriendo: false, base: null }));
ipcMain.handle('g2local-parar', () => { try { g2local && g2local.parar(); } catch (_) {} return { ok: true }; });

/* ---- ONVIF: encontrar camaras en la red y sacarles la URL RTSP ----
 * El que agrega la camara esta parado al lado de la camara, en su misma LAN; la central
 * casi nunca ve esa red, y el descubrimiento es multicast, que no cruza routers. Por eso
 * esto corre aca y no en la central. Ver electron/onvif.cjs. */
let onvif = null; try { onvif = require('./onvif.cjs'); } catch (e) { if (DEBUG) console.log('[onvif] no disponible:', e && e.message); }
ipcMain.handle('onvif-descubrir', async (_e, ms) => {
  if (!onvif) return { ok: false, motivo: 'descubrimiento no disponible en esta version' };
  try {
    const r = await onvif.descubrir(Math.min(8000, Math.max(2000, parseInt(ms, 10) || 4000)));
    /* Las interfaces van a la pantalla: «no contesto ninguna» es una respuesta muy
     * distinta si se pregunto por la placa que esta en la red de las camaras que si no se
     * pregunto por ninguna, y el usuario no tiene otra forma de distinguirlas. */
    return { ok: true, equipos: r.equipos || [], interfaces: r.interfaces || [] };
  } catch (e) { return { ok: false, motivo: (e && e.message) || 'error' }; }
});
ipcMain.handle('onvif-perfiles', async (_e, o) => {
  if (!onvif) return { ok: false, motivo: 'ONVIF no disponible en esta version' };
  try { return { ok: true, perfiles: await onvif.perfiles(o || {}) }; }
  catch (e) { return { ok: false, motivo: (e && e.message) || 'error' }; }
});

/* ---- Clientes del aparato: exportar e importar en Excel ----
 * El dialogo de archivo y el disco son del proceso principal; el renderer sólo manda las
 * filas o pide que le lean un archivo. Escribir el .xlsx desde el renderer significaria
 * meter el armador de ZIP en el bundle de la pantalla, que no es donde vive. */
let xlsx = null; try { xlsx = require('./xlsx.cjs'); } catch (e) { if (DEBUG) console.log('[xlsx] no disponible:', e && e.message); }
ipcMain.handle('clientes-exportar', async (_e, o) => {
  if (!xlsx) return { ok: false, motivo: 'exportación no disponible en esta versión' };
  try {
    const { dialog } = require('electron');
    const r = await dialog.showSaveDialog(win, {
      title: 'Exportar clientes',
      defaultPath: (o && o.nombre) || 'clientes-softphone.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelado: true };
    fs.writeFileSync(r.filePath, xlsx.escribir((o && o.filas) || [], 'Clientes'));
    return { ok: true, ruta: r.filePath };
  } catch (e) { return { ok: false, motivo: (e && e.message) || 'error' }; }
});
ipcMain.handle('clientes-importar', async () => {
  if (!xlsx) return { ok: false, motivo: 'importación no disponible en esta versión' };
  try {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(win, {
      title: 'Importar clientes', properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, cancelado: true };
    return { ok: true, filas: xlsx.leer(fs.readFileSync(r.filePaths[0])), ruta: r.filePaths[0] };
  } catch (e) { return { ok: false, motivo: (e && e.message) || 'no se pudo leer el archivo' }; }
});

/* ---- Probar una URL de camara ANTES de guardarla ----
 * Se prueba con el MISMO go2rtc que despues la va a mostrar, y se espera a que entregue
 * video de verdad. Un `connect()` al 554 contestaria que si en una camara con la clave mal
 * o con el canal equivocado: lo unico que prueba algo es que salgan bytes de video. */
ipcMain.handle('camara-probar', async (_e, rtsp) => {
  if (!g2local) return { ok: false, motivo: 'motor de video local no disponible en esta version' };
  const id = 'prueba_' + Date.now().toString(36);
  try {
    const r = await g2local.asegurar([{ id, rtsp: String(rtsp || '') }]);
    if (!r.ok) return { ok: false, motivo: r.motivo };
    if (!WS) return { ok: false, motivo: 'ws no disponible' };
    const url = r.base.replace(/^http/, 'ws') + '/api/ws?src=' + encodeURIComponent(id);
    const res = await new Promise((resolver) => {
      let bytes = 0, codec = '', ws;
      const cerrar = (salida) => { try { ws && ws.close(); } catch (_) {} resolver(salida); };
      /* 12 s: una camara lenta o con mucha latencia tarda, y cortar antes seria decirle al
       * tecnico que la camara no sirve cuando el que no espero fue el programa. */
      const t = setTimeout(() => cerrar({ ok: false, motivo: 'la cámara no entregó video en 12 s (¿clave, canal o códec?)' }), 12000);
      try { ws = new WS(url, { handshakeTimeout: 8000 }); } catch (e) { clearTimeout(t); return resolver({ ok: false, motivo: e.message }); }
      ws.binaryType = 'arraybuffer';
      ws.on('open', () => ws.send(JSON.stringify({ type: 'mse', value: 'avc1.640029,avc1.64002A,avc1.4d002a,avc1.42e01e,hvc1.1.6.L153.B0,mp4a.40.2,opus' })));
      ws.on('message', (d, bin) => {
        if (!bin) { try { const m = JSON.parse(d.toString()); if (m.type === 'mse' && m.value) codec = m.value; if (m.type === 'error') { clearTimeout(t); cerrar({ ok: false, motivo: String(m.value || 'la cámara rechazó la conexión') }); } } catch (_) {} return; }
        bytes += d.length || d.byteLength || 0;
        /* Con 20 KB ya hay imagen de verdad, no sólo cabeceras. */
        if (bytes > 20000) { clearTimeout(t); cerrar({ ok: true, codec, bytes }); }
      });
      ws.on('error', (e) => { clearTimeout(t); cerrar({ ok: false, motivo: (e && e.message) || 'error de conexión' }); });
      ws.on('close', () => { clearTimeout(t); cerrar({ ok: false, motivo: 'la cámara cortó la conexión' }); });
    });
    return res;
  } catch (e) { return { ok: false, motivo: (e && e.message) || 'error' }; }
  finally {
    /* La prueba NO deja su stream levantado: la lista de camaras vivas la manda la
     * pantalla, y al volver a pedirla el go2rtc arranca sin el de prueba. Se para el
     * motor (antes se llamaba `asegurar([])`, que con la lista vacia vuelve sin hacer
     * nada: el go2rtc quedaba vivo con la URL de prueba, clave incluida). */
    try { g2local.parar(); } catch (_) {}
  }
});

// ---- auto-update visible ----
/* Feed OTA: la central a la que esta aprovisionado el softphone publica su propio
 * instalador y latest.yml en https://<central>/descargas/softphone/ (lo sirve la API).
 * Asi cada cliente actualiza contra SU central, sin Internet ni GitHub. Si todavia no
 * hay central (app recien instalada), se usa GitHub Releases como respaldo.
 * El feed elegido se recuerda en userData para que el chequeo del arranque ya lo use. */
const FEED_FALLBACK = 'https://github.com/flavioGonz/pbx-ng/releases/latest/download/';
const feedPath = () => path.join(app.getPath('userData'), 'sp-update-feed.json');
function loadFeed() { try { return JSON.parse(fs.readFileSync(feedPath(), 'utf8')).url || ''; } catch (_) { return ''; } }
function applyFeed(url) {
  if (!autoUpdater) return false;
  const u = String(url || '').trim() || FEED_FALLBACK;
  try { autoUpdater.setFeedURL({ provider: 'generic', url: u, useMultipleRangeRequest: false }); autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true; return true; } catch (e) { console.error('[updater] feed', e.message); return false; }
}
ipcMain.handle('update-set-feed', (_e, url) => {
  const u = String(url || '').trim();
  try { fs.writeFileSync(feedPath(), JSON.stringify({ url: u, at: Date.now() })); } catch (_) {}
  const ok = applyFeed(u);
  if (ok && !isDev) { try { autoUpdater.checkForUpdates(); } catch (_) {} }
  return { ok, url: u || FEED_FALLBACK };
});
let updaterWired = false;
function wireUpdater() {
  if (!autoUpdater || updaterWired) return; updaterWired = true;
  applyFeed(loadFeed());
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
      /* Reloj de seguridad: si por lo que sea nadie manda el «apagá» —la ventana cambió,
       * la llamada se atendió desde el widget— el temblor se corta solo. Una ventana que
       * vibra sin llamada es de las cosas más desconcertantes que puede hacer un
       * programa. */
      setTimeout(() => { if (shakeIv) { clearInterval(shakeIv); shakeIv = null; if (shakeWin && shakeHome) { try { shakeWin.setPosition(shakeHome.x, shakeHome.y); } catch (_) {} } shakeHome = null; shakeWin = null; } }, 60000);
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
  try { const { screen } = require('electron'); const wa = screen.getPrimaryDisplay().workAreaSize; x = wa.width - 320; y = wa.height - 168; } catch (_) {}
  mini = new BrowserWindow({
    width: 300, height: 128, x, y, frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false, backgroundColor: '#00000000', maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  mini.loadFile(path.join(__dirname, 'mini.html'));
  mini.on('closed', () => { mini = null; });
  return mini;
}
function hideMini() { try { mini && mini.hide(); } catch (_) {} if (mainHiddenByMini) { mainHiddenByMini = false; showWin(); } }
/* Timbrado con la ventana escondida: el widget SALE SOLO.
 *
 * Antes, con el softphone minimizado a la barra de tareas, una llamada entrante no se veia
 * en ninguna parte: sonaba el tono y habia que ir a buscar la ventana. Ahora el widget
 * aparece en la esquina con el nombre y los tres botones —rechazar, atender, atender con
 * video—, y se va solo cuando la llamada termina. No robamos el foco (`showInactive`):
 * si el usuario esta escribiendo en otra cosa, sigue escribiendo. */
let miniPorTimbre = false;
function ventanaALaVista() { try { return !!(win && win.isVisible() && !win.isMinimized()); } catch (_) { return false; } }
function miniVisible() { try { return !!(mini && !mini.isDestroyed() && mini.isVisible()); } catch (_) { return false; } }
function miniAutomatico(st) {
  const timbra = !!(st && st.active && st.incoming);
  if (timbra && !ventanaALaVista() && !miniVisible()) {
    createMini();
    try { mini.showInactive(); } catch (_) { try { mini.show(); } catch (_) {} }
    try { mini.setAlwaysOnTop(true, 'floating'); } catch (_) {}
    try { mini.webContents.send('mini-state', st); } catch (_) {}
    /* A proposito NO se toca `mainHiddenByMini`: la ventana grande no la escondimos
     * nosotros, asi que al cerrarse el widget no hay que volver a mostrarla. */
    miniPorTimbre = true;
  }
  if (!(st && st.active) && miniPorTimbre) { miniPorTimbre = false; try { mini && !mini.isDestroyed() && mini.hide(); } catch (_) {} }
}
ipcMain.on('mini-state', (_e, st) => {
  miniState = st;
  try { mini && mini.webContents.send('mini-state', st); } catch (_) {}
  miniAutomatico(st);
});
ipcMain.on('mini-ready', () => { try { mini && miniState && mini.webContents.send('mini-state', miniState); } catch (_) {} });
ipcMain.handle('mini-show', (_e, on) => {
  try {
    if (on) {
      createMini();
      try { mini.showInactive(); } catch (_) { mini.show(); }
      try { mini.setAlwaysOnTop(true, 'floating'); } catch (_) {}
      if (miniState) { try { mini.webContents.send('mini-state', miniState); } catch (_) {} }
      miniPorTimbre = false;
      if (win && win.isVisible()) { mainHiddenByMini = true; win.hide(); }
    } else hideMini();
  } catch (_) {}
  return { ok: true };
});
/* Lo que la ventana grande le contesta al widget (contactos, dispositivos). */
ipcMain.on('mini-data', (_e, d) => { try { mini && !mini.isDestroyed() && mini.webContents.send('mini-data', d); } catch (_) {} });
/* El widget crece y se achica solo: con el teclado abierto necesita alto, y cuando se
 * cierra vuelve a ser una tira. Se mueve el BORDE DE ARRIBA y no el de abajo, para que
 * no se meta debajo de la barra de tareas al crecer. */
ipcMain.on('mini-size', (_e, alto) => {
  try {
    if (!mini || mini.isDestroyed()) return;
    const h = Math.max(88, Math.min(560, Math.round(alto || 0)));
    const b = mini.getBounds();
    mini.setBounds({ x: b.x, y: b.y + (b.height - h), width: b.width, height: h });
  } catch (_) {}
});
ipcMain.on('mini-action', (_e, m) => {
  try {
    const act = (m && typeof m === 'object') ? m.a : m;
    const val = (m && typeof m === 'object') ? m.v : undefined;
    if (act === 'restore') { try { mini && mini.hide(); } catch (_) {} mainHiddenByMini = false; showWin(); return; }
    if (win) win.webContents.send('mini-action', { a: act, v: val });
    // estas acciones necesitan la ventana grande
    /* `dial` y `devices` ya no traen la ventana grande: el widget resuelve el teclado y
     * la elección de micrófono adentro. Queda sólo el video, que sí necesita pantalla. */
    if (act === 'accept-video') { miniPorTimbre = false; try { mini && mini.hide(); } catch (_) {} mainHiddenByMini = false; showWin(); }
  } catch (_) {}
});

const MEDIA_PERMS = ['media', 'microphone', 'camera', 'audioCapture', 'videoCapture', 'notifications', 'display-capture'];

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
  /* El go2rtc local se mata ACA y no sólo en `will-quit`: un hijo huerfano sigue
   * tirandole RTSP a las camaras del cliente despues de cerrar la app. */
  app.on('before-quit', () => { app.__quitting = true; try { sipNat && sipNat.stop(); } catch (_) {} try { g2local && g2local.parar(); } catch (_) {} try { mini && mini.destroy(); } catch (_) {} });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* queda en bandeja */ });
  app.whenReady().then(() => {
    try { ['tel', 'sip', 'callto', 'pbxng'].forEach(p => app.setAsDefaultProtocolClient(p)); } catch (_) {}
    createWindow(); createTray(); registerShortcuts();
    // Re-registro automático: al despertar la PC o volver la red
    try {
      const sys = (e) => { try { win && win.webContents.send('sys-event', e); } catch (_) {} };
      powerMonitor.on('resume', () => sys('resume'));
      powerMonitor.on('suspend', () => sys('suspend'));
      powerMonitor.on('unlock-screen', () => sys('resume'));
    } catch (_) {}
    dialFromArgs(process.argv);
    wireUpdater();
    if (autoUpdater && !isDev) {
      try { autoUpdater.checkForUpdates(); } catch (_) {}
      // y cada 6 horas mientras la app viva (el softphone queda abierto dias)
      setInterval(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 6 * 3600 * 1000);
    }
  });
}
