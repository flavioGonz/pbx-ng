# Publicar una versión del teléfono en una central

Cada central de PBX-NG sirve SUS propios instaladores en `https://<central>/descargas/softphone/`,
y el botón del login muestra lo que haya ahí. No hay tienda de aplicaciones ni descarga desde
Internet de por medio: una central on-prem tiene que poder repartir el teléfono aunque no
tenga salida a Internet.

## Dónde viven los archivos

`docker/softphone/` en el host, montado en `/app/softphone` dentro del contenedor `api`.
Es una carpeta del host **a propósito**: publicar una versión nueva es dejar el archivo ahí.
No hay que reconstruir la imagen ni reiniciar nada; el endpoint relee el directorio en cada
pedido. Si la carpeta está vacía, el botón del login simplemente no aparece.

## Windows

Tres archivos, tal como los deja electron-builder:

    PBX-NG-Softphone-Setup-<version>.exe
    PBX-NG-Softphone-Setup-<version>.exe.blockmap
    latest.yml

`latest.yml` es además el feed de actualización automática (electron-updater): el teléfono ya
instalado se actualiza contra su propia central, sin pasar por GitHub.

Para construirlo en Linux hace falta wine (`wine64` + `wine32:i386`, este último es
imprescindible: sin él falla al escribir los metadatos del .exe):

    cd softphone-app && npm run build && npx electron-builder --win nsis --publish never

## Android (APK)

Un solo archivo, y la versión se lee del nombre:

    pbxng-softphone-<version>.apk

El APK es la misma aplicación web dentro de Capacitor —el mismo `dist/` que usa Electron—,
así que no hay dos aplicaciones que mantener. El servidor NO viene fijo adentro: se aprovisiona
como en el escritorio (QR o carga manual), que es lo que permite usar el mismo APK en todas
las centrales.

    cd softphone-app && npm run build && npx cap sync android
    cd android && PBXNG_KEYSTORE=<ruta.jks> PBXNG_KEYSTORE_PASS=<clave> PBXNG_KEY_ALIAS=<alias> \
      ./gradlew assembleRelease
    # queda en android/app/build/outputs/apk/release/app-release.apk

**La clave de firma no está en el repositorio y no puede perderse**: Android se niega a
actualizar una aplicación firmada con otra clave. Si se pierde, la única salida es desinstalar
y volver a instalar en cada teléfono.

Subir la versión: `versionName` y `versionCode` en `android/app/build.gradle` (el código es un
entero que sólo puede subir; `0.6.0` → `60`).

## Verificar que quedó publicado

    curl -s http://127.0.0.1:3000/api/softphone/latest

Tiene que listar la versión de Windows arriba y el APK en `android`.
