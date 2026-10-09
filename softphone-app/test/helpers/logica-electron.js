/* Un `electron` falso para cargar electron/main.cjs sin abrir Electron: guarda los
 * handlers IPC, las ventanas creadas y los eventos de app para que la prueba los dispare. */
import { vi } from 'vitest';
import { EventEmitter } from 'node:events';

export function electronFalso({ empaquetado = false, lock = true, userData = '/tmp', cifrado = true } = {}) {
  const handlers = {}, oyentes = {}, ventanas = [], bandejas = [], atajos = {};
  const appEv = new EventEmitter();
  let listo;
  const whenReady = new Promise((r) => { listo = r; });
  const app = {
    isPackaged: empaquetado,
    getPath: vi.fn(() => userData),
    getVersion: () => '9.9.9',
    commandLine: { appendSwitch: vi.fn() },
    on: (ev, fn) => appEv.on(ev, fn),
    emit: (ev, ...a) => appEv.emit(ev, ...a),
    requestSingleInstanceLock: () => lock,
    quit: vi.fn(),
    whenReady: () => whenReady,
    arrancar: () => listo(),
    setAsDefaultProtocolClient: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
  };
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.visible = false; this.minimizado = false; this.destruida = false;
      this.pos = [100, 200]; this.bounds = { x: 10, y: 500, width: 300, height: 128 };
      this.webContents = Object.assign(new EventEmitter(), {
        send: vi.fn(), openDevTools: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn() },
      });
      for (const m of ['loadURL', 'loadFile', 'focus', 'minimize', 'setResizable', 'setSize', 'center', 'setAlwaysOnTop', 'close']) this[m] = vi.fn();
      ventanas.push(this);
    }
    isMinimized() { return this.minimizado; }
    restore() { this.minimizado = false; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destruida; }
    destroy() { this.destruida = true; }
    getPosition() { return this.pos; }
    setPosition(x, y) { this.pos = [x, y]; }
    getBounds() { return { ...this.bounds }; }
    setBounds(b) { this.bounds = b; }
  }
  class Tray extends EventEmitter {
    constructor(img) { super(); this.img = img; this.setToolTip = vi.fn(); this.setContextMenu = vi.fn(); bandejas.push(this); }
  }
  const electron = {
    app, BrowserWindow, Tray,
    Menu: { buildFromTemplate: (t) => t },
    globalShortcut: { register: vi.fn((k, fn) => { atajos[k] = fn; }), unregisterAll: vi.fn() },
    nativeImage: { createFromPath: (p) => ({ p }) },
    ipcMain: {
      handle: (c, fn) => { handlers[c] = fn; },
      on: (c, fn) => { oyentes[c] = fn; },
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => cifrado),
      encryptString: (s) => Buffer.from('ENC:' + s),
      decryptString: (b) => String(b).replace(/^ENC:/, ''),
    },
    powerMonitor: new EventEmitter(),
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 } }) },
  };
  return {
    electron, app, handlers, oyentes, ventanas, bandejas, atajos,
    invocar: (c, ...a) => handlers[c]({ sender: {} }, ...a),
    emitir: (c, ...a) => oyentes[c]({ sender: {} }, ...a),
  };
}
