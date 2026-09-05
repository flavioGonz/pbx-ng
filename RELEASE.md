# PBX-NG · Guia de Release (appliance on-prem)

**Regla de oro:** todo cambio se hace en el repo → se construye una **imagen versionada** → se
despliega por `pull`/`load`. **No** se vuelve a parchar contenedores con `docker cp`. El repo es
la unica fuente de verdad.

## Versionado (SemVer)
`MAJOR.MINOR.PATCH` en el archivo `VERSION`.
- **PATCH**: fixes que no cambian API/DB. **MINOR**: features compatibles. **MAJOR**: rupturas.
- El numero de `VERSION` y el tag git `vX.Y.Z` deben coincidir.

## Cortar un release
1. Actualizar `CHANGELOG.md` (seccion nueva) y `VERSION`.
2. Commit + tag: `git commit -am "release X.Y.Z" && git tag vX.Y.Z && git push --tags`.
3. **CI** (`.github/workflows/release.yml`) construye y publica las imagenes en GHCR
   (`ghcr.io/<org>/pbx-ng/<svc>:X.Y.Z`). *(o localmente: `cd docker && ./release.sh --push`)*.
4. Para sitios **sin internet**: `cd docker && ./release.sh --bundle` genera en `dist/`:
   - `pbxng-X.Y.Z-images.tar.gz` — las imagenes (`docker load`).
   - `pbxng-X.Y.Z.tar.gz` — compose de release + scripts + config + migraciones.

## Imagenes que se construyen
`asterisk, api, dashboard, coturn, voz` (las de terceros —postgres, redis, go2rtc, npm— se usan
pinneadas, no se construyen). Kamailio, rtpengine y wsbridge ya no forman parte de PBX-NG: son
imagenes de **SBC-NG**, que se releasea y licencia aparte.

## Instalar / actualizar en un cliente
Copiar `docker/` (o el bundle) al host. Tener `docker/.env` con secretos (ver `.env.example`) y
`COMPOSE_PROFILES` con los modulos contratados (ej. `core,turn,intercom`).

**Con registry (online):**
```
cd docker
export PBXNG_REGISTRY=ghcr.io/<org>/pbx-ng PBXNG_VERSION=X.Y.Z
export COMPOSE_PROFILES=core,turn,intercom
./deploy.sh
```
**Air-gapped (offline):**
```
cd docker
export PBXNG_VERSION=X.Y.Z COMPOSE_PROFILES=core,turn,intercom
./deploy.sh --images=/ruta/pbxng-X.Y.Z-images.tar.gz
```
`deploy.sh` carga/pull las imagenes, corre **migraciones** de DB, drena Asterisk si el `up`
lo va a recrear (pide confirmacion si hay llamadas; `--yes` para no preguntar) y hace `up -d`
(sin build). Si las migraciones fallan, corta ahi con exit 1 y no toca nada.

## Migraciones de DB
- Los cambios de schema NUEVOS van como `control-plane/migrations/000N_descripcion.sql`.
- Nunca editar una migracion ya aplicada; agregar otra.
- Las corre **el arranque del contenedor de la API** (`docker-entrypoint.sh` → `node migrate.js`
  → `node app.js`), registrando en `pbxng_schema_migrations`; si una falla la API no arranca.
  `deploy.sh` las corre ademas antes del `up -d` (`run --rm --no-deps --entrypoint node api
  migrate.js`) para que un esquema roto frene el deploy con el error a la vista.
- Desde 1.5.0 ningun modulo crea tablas ni columnas en runtime (`0009_schema_runtime.sql`
  formalizo lo que antes hacia `app.js` al importar): todo cambio de esquema es una migracion.

## Verificacion post-deploy (obligatoria)
Un deploy "verde" no garantiza audio. Antes de entregar:
```
cd docker && ./install.sh --print-firewall --profiles=$COMPOSE_PROFILES   # que abrir
../scripts/check-turn.py --env .env --tcp                                  # TURN real
```
`check-turn.py` hace STUN Binding + TURN Allocate firmado: si devuelve **ALLOCATE 200 · relay**,
los clientes WebRTC detras de NAT simetrico van a tener audio. Si no, ver `docs/FIREWALL.md`.
El mismo diagnostico esta en el panel (Configuracion -> WebRTC / TURN -> "Diagnostico ICE en vivo")
y en el softphone de escritorio (Ajustes -> Red).

## Softphone de escritorio (release aparte)
`softphone-app/` versiona por su cuenta (`softphone-app/package.json`) y se publica con
`npm run dist` (Electron Builder -> NSIS `.exe` + `.msi` en `softphone-app/release/`), o por CI
(`.github/workflows/softphone.yml`). No forma parte de las imagenes Docker del appliance.

## Rollback
Volver a desplegar la version anterior: `export PBXNG_VERSION=X.Y.(Z-1); ./deploy.sh`.
(Las migraciones NO se revierten automaticamente: escribir una migracion correctiva si hace falta.)

## Ediciones (licenciamiento) — mapea a perfiles
- **Core**: `core` (PBX + WebRTC basico).
- **Pro**: `core,turn` (TURN propio para WebRTC tras NAT).
- **Enterprise**: `core,turn,ai,intercom` (IVR IA + video intercom + multi-tenant).
El cliente solo levanta los perfiles contratados; el resto de contenedores ni existen.
**SBC-NG** (borde SIP, LCR, troncales del operador) se licencia aparte: en cualquier edicion se
conecta desde el modulo «Conexion a SBC-NG» del panel, que no levanta contenedores.
