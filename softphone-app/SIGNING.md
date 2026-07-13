# Firma de código (Authenticode) — PBX-NG Softphone

El instalador `.exe`/`.msi` se puede firmar para que Windows SmartScreen no muestre
la alerta de "editor desconocido". electron-builder firma automáticamente si le pasás
el certificado por **variables de entorno** (nunca se guardan en el repo).

## 1. Conseguir el certificado
Un certificado **Authenticode** (Code Signing) de una CA reconocida
(DigiCert, Sectigo, GlobalSign, etc.). Formato `.pfx`/`.p12` con su clave.
- OV (Organization Validation): más barato, mantiene reputación con el tiempo.
- EV (Extended Validation): reputación inmediata en SmartScreen (suele venir en token HSM).

## 2. Firmar en el build (máquina de release, no en el repo)
```bat
set CSC_LINK=C:\ruta\segura\infratec-codesign.pfx
set CSC_KEY_PASSWORD=********
npm run dist
```
electron-builder toma `CSC_LINK` + `CSC_KEY_PASSWORD` y firma el NSIS y el MSI.
Para EV con token en HSM, usar el flujo de `signtool` con el proveedor del token
(certificateSubjectName / certificateSha1) en vez de CSC_LINK.

## 3. Verificar
```powershell
Get-AuthenticodeSignature ".\release\PBX-NG-Softphone-Setup-<ver>.exe"
```
Debe decir `Valid` y mostrar el firmante = Infratec.

## Notas
- La firma también valida las **auto-actualizaciones**: electron-updater verifica que
  la nueva versión esté firmada por el mismo editor.
- No comitear el `.pfx` ni la contraseña. Usar variables de entorno o un secret store
  del runner de CI.
- `package.json > build.win` ya emite `nsis` + `msi`; no requiere cambios para firmar.
