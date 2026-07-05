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
`asterisk, api, dashboard, kamailio, wsbridge, coturn, voz` (las de terceros —postgres, redis,
rtpengine, go2rtc, npm— se usan pinneadas, no se construyen).

## Instalar / actualizar en un cliente
Copiar `docker/` (o el bundle) al host. Tener `docker/.env` con secretos (ver `.env.example`) y
`COMPOSE_PROFILES` con los modulos contratados (ej. `core,sbc,turn,intercom`).

**Con registry (online):**
```
cd docker
export PBXNG_REGISTRY=ghcr.io/<org>/pbx-ng PBXNG_VERSION=X.Y.Z
export COMPOSE_PROFILES=core,sbc,turn,intercom
./deploy.sh
```
**Air-gapped (offline):**
```
cd docker
export PBXNG_VERSION=X.Y.Z COMPOSE_PROFILES=core,sbc,turn,intercom
./deploy.sh --images=/ruta/pbxng-X.Y.Z-images.tar.gz
```
`deploy.sh` carga/pull las imagenes, corre **migraciones** de DB y hace `up -d` (sin build).

## Migraciones de DB
- Los cambios de schema NUEVOS van como `control-plane/migrations/000N_descripcion.sql`.
- Nunca editar una migracion ya aplicada; agregar otra.
- `deploy.sh` las corre solo (`node migrate.js`), registrando en `pbxng_schema_migrations`.

## Rollback
Volver a desplegar la version anterior: `export PBXNG_VERSION=X.Y.(Z-1); ./deploy.sh`.
(Las migraciones NO se revierten automaticamente: escribir una migracion correctiva si hace falta.)

## Ediciones (licenciamiento) — mapea a perfiles
- **Core**: `core` (PBX + WebRTC basico).
- **Pro**: `core,sbc,turn` (SBC/anti-fraude + TURN + troncales WebRTC).
- **Enterprise**: `core,sbc,turn,ai,intercom` (IVR IA + video intercom + multi-tenant).
El cliente solo levanta los perfiles contratados; el resto de contenedores ni existen.
