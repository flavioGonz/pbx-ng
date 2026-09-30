# Proposal

## Why

El instalador del softphone se compila con un workflow de GitHub Actions que sólo se
dispara con un tag `softphone-v*`, y copiarlo a la central es un paso aparte. Como los dos
pasos son manuales y nada avisa cuando faltan, el 28/09 dos commits quedaron sin compilar y
la central siguió sirviendo 0.16.0 durante dos días: el softphone mostraba «versión actual
0.16.0» y el OTA decía, con razón, que estaba al día. El usuario no tiene forma de
distinguir «no hay nada nuevo» de «nadie compiló lo nuevo».

## What Changes

- El tag `softphone-v<version>` se crea solo cuando cambia `version` en
  `softphone-app/package.json` en `main`, así compilar deja de depender de que alguien se
  acuerde de taguear.
- El workflow, después de publicar el GitHub Release, entrega el instalador, su
  `.blockmap` y el `latest.yml` al feed OTA de cada central registrada.
- La central expone qué versión está sirviendo y desde cuándo, para que se pueda ver que
  quedó atrás sin tener que mirar timestamps de archivos por SSH.
- **BREAKING** no hay: el feed OTA sigue con el mismo formato de electron-updater y un
  softphone viejo sigue actualizándose igual.

## Capabilities

### New Capabilities

- `distribucion-softphone` — cómo llega a la máquina del usuario la versión que se acaba
  de commitear: qué se compila, qué publica la central y cuándo se considera atrasada.

### Modified Capabilities

Ninguna. El comportamiento del softphone en llamada no cambia.

## Impact

- `.github/workflows/softphone.yml` — disparador nuevo y paso de entrega.
- `docker/fetch-softphone.sh` — hoy sólo trae el instalador al armar una imagen de la
  central; pasa a poder invocarse solo para el softphone.
- `control-plane/app.js` — `/api/softphone/latest` agrega desde cuándo está publicada esa
  versión (el dato ya existe, no se expone).
- Operación: la carpeta `docker/softphone/` de cada central deja de llenarse a mano.
