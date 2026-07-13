# PBX-NG Softphone (genérico)

Softphone **WebRTC** que registra contra **cualquier PBX que ofrezca internos WebRTC**
(SIP sobre WSS). Una sola base de código → **PWA** (móvil) y, envuelto en Electron, **app de Windows**.

No está atado a PBX-NG: en **Configuración** se cargan los datos de registro remoto
(WSS, dominio SIP, interno, clave, STUN/TURN).

## Stack
- Vite + React + [SIP.js](https://sipjs.com) (`src/useSip.js` = hook SIP genérico parametrizado).
- `vite-plugin-pwa` (manifest + service worker, instalable).
- Config persistente en `localStorage` (`src/config.js`).

## Desarrollo
```bash
npm install
npm run dev        # http://localhost:5180  (WebRTC/getUserMedia exige HTTPS o localhost)
npm run build      # -> dist/  (PWA lista para servir por HTTPS)
npm run preview
```

## Uso
1. Abrí la app → **Configuración**.
2. Completá: **Servidor WSS** (`wss://tu-pbx/ws`), **Dominio SIP**, **Interno/usuario**, **Contraseña**; opcional STUN/TURN.
3. **Conectar** → queda registrado y listo para llamar/recibir.

Funciones v1: registro, marcador, llamada saliente/entrante con ring + vibración, mute, DTMF en llamada, historial local.

## Pendiente (roadmap)
- Empaquetado **Electron** (bandeja + autostart, handler `tel:`/`sip:`, hotkeys globales, notif+ring, auto-update, instalador .exe).
- Hold/transfer, selección de dispositivos (mic/altavoz), video opcional, push para móvil.

## Notas
- **HTTPS obligatorio** para WebRTC/micrófono (salvo `localhost`). Serví el `dist/` detrás de TLS.
- iOS PWA: el ring en segundo plano es limitado (requiere push); Android funciona bien.

## App de Windows (Electron)
Empaqueta la misma `dist/` como app de escritorio con instalador `.exe`.

```bash
npm install
npm run dist          # -> release/PBX-NG Softphone Setup x.y.z.exe   (electron-builder, target NSIS)
# desarrollo rápido:
npm run build && npm run electron
```
Incluye: bandeja + "Iniciar con Windows", protocolo `tel:`/`sip:`/`callto:` (click-to-call),
hotkeys globales (Ctrl+Shift+A atender · H colgar · M mute), instancia única, notificaciones
de entrante y **auto-update** por GitHub Releases (config `build.publish` en package.json).

> El `.exe` se construye en Windows (o Linux+wine). En CI se puede automatizar con electron-builder.

### .exe vs .msi
`npm run dist` genera **ambos** en `release/`: el `.exe` (NSIS, instalación individual + auto-update)
y el `.msi` (despliegue empresarial por GPO/Intune/SCCM, per-machine). El target MSI usa WiX
(electron-builder lo resuelve en Windows).

### Troubleshooting build en Windows
Si `npm run dist` falla en `winCodeSign` con *"Cannot create symbolic link ... privilegio requerido"*:
es porque electron-builder extrae symlinks (para firma) y Windows los bloquea sin permiso.
- La app igual queda armada en `release/win-unpacked/PBX-NG Softphone.exe` (portable, corre sin instalar).
- Para generar los instaladores: **activá el Modo de desarrollador** (Configuración → Para desarrolladores)
  o corré la terminal **como Administrador**, y reintentá `npm run dist`.
- En CI (runner Windows de GitHub) no ocurre — usar el workflow `softphone-win`.
