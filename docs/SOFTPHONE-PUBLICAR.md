# Publicar una versión del teléfono en una central

**El camino normal no tiene pasos manuales.** Subís `version` en
`softphone-app/package.json`, eso llega a `main`, y de ahí en adelante:

    version nueva en main  →  CI compila  →  publica el Release  →  la central lo baja sola

La central consulta el Release cada N horas y deja los archivos donde el login y el
actualizador los leen. No hay que copiar nada por SSH ni reconstruir ninguna imagen.

Lo que sigue es para entender ese camino, y para los dos casos en que no alcanza.

## Que la central se lo traiga sola

Panel → **Softphone** → «Instalador que reparte esta central». Ahí se ve qué versión
reparte, desde cuándo, y el resultado del último intento.

Nace **apagado**. Prender una salida a internet periódica en el equipo telefónico de un
cliente es una decisión de quien administra esa central, no algo que llega con una
actualización. Se prende con el interruptor «Traer sola la versión nueva»; el repositorio y
cada cuántas horas revisar están al lado. «Buscar ahora» espera el resultado de verdad:
bajar 85 MB tarda, y el que aprieta el botón quiere saber si quedó.

**Es pull, no push**: la central sale a buscar, nadie le entrega nada. Las centrales están
detrás de NAT, y para que CI les entregue algo habría que publicar un endpoint de
administración en cada PBX con una credencial de larga vida en los secretos del repo — a
cambio de no consultar una URL.

Si no se llega a GitHub, la central **sigue repartiendo la versión que ya tiene** y lo dice
en esa misma pantalla. No es una falla de la central: es el caso normal de una red sin
salida.

## La central sin salida a internet

Panel → **Softphone** → «Subir a mano». Se eligen **juntos** el `.exe`, su `.blockmap` y el
`latest.yml` del Release.

Van en una sola subida porque el `latest.yml` se escribe **al final**: suelto, manda a los
softphones ya instalados a buscar un instalador que todavía no terminó de subir.

## Si hay código de softphone sin publicar

Cuando llegan commits a `softphone-app/` sin que nadie suba la `version`, la corrida de
`softphone-win` queda con un **warning** que dice cuántos commits no están en ningún
instalador, y los lista. Ese es exactamente el caso que el 28/09 dejó dos días a la gente
bajando una versión vieja mientras el actualizador informaba —con razón— que estaba al día.

## Dónde viven los archivos

`docker/softphone/` en el host, montado en `/app/softphone` dentro del contenedor `api`.
Es una carpeta del host **a propósito**: publicar una versión es dejar el archivo ahí. No
hay que reconstruir la imagen ni reiniciar nada; el endpoint relee el directorio en cada
pedido. Si la carpeta está vacía, el botón del login simplemente no aparece.

Se conserva la **versión anterior** además de la actual: si la nueva sale mal, el que
todavía no actualizó puede bajar la que le andaba sin esperar un release de arreglo.

Y por debajo de **600 MB libres** no se baja nada. Dejar sin espacio el disco de una central
corta llamadas, graba mal y rompe Postgres; una versión del softphone no vale eso.

## Windows

Tres archivos, tal como los deja electron-builder:

    PBX-NG-Softphone-Setup-<version>.exe
    PBX-NG-Softphone-Setup-<version>.exe.blockmap
    latest.yml

`latest.yml` es además el feed de actualización automática (electron-updater): el teléfono ya
instalado se actualiza contra su propia central, sin pasar por GitHub.

El instalador lleva adentro **go2rtc** (~19 MB), el mismo motor de video que corre en la
central. Es lo que permite que una cámara RTSP cargada a mano en el teléfono se pueda mirar
sin central. No está commiteado: lo baja `softphone-app/scripts/fetch-go2rtc.sh` durante el
build, con la versión fijada y el SHA-256 escrito al lado.

Para construirlo en Linux hace falta wine (`wine64` + `wine32:i386`, este último es
imprescindible: sin él falla al escribir los metadatos del .exe):

    cd softphone-app && npm run go2rtc && npm run build && npx electron-builder --win nsis --publish never


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
