# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com). Versionado: [SemVer](https://semver.org).

## [1.0.0] - 2026-07-05
### Added
- Empaquetado por **modulos = perfiles de compose = contenedores** (`pbxng-ctl` + reconciliador).
- **Sistema de release**: imagenes versionadas (`docker/release.sh`: build -> tag -> push y/o bundle air-gapped) y **deploy por pull/load** (`docker/deploy.sh` + `docker-compose.release.yml`) — sin `docker cp`.
- **Instalador multi-rol** (`docker/install.sh --role=all|core|edge`): topologia 1 VM o 2 VMs (core en LAN + edge SBC en DMZ), con `edge-join.env` (secretos compartidos) y validacion de conectividad edge->core. Guia en `docs/TOPOLOGY.md`.
- **Orquestador Proxmox** (`deploy/pbxng-proxmox.sh`): nueva forma **6) Dos VMs** (núcleo LAN + borde SBC en DMZ con **doble NIC** opcional), crea/aprovisiona ambas LXC con secretos compartidos e IPs cruzadas + nota de firewall.
- **Migraciones de DB** versionadas (`control-plane/migrate.js` + `control-plane/migrations/`).
- CI de release a GHCR por tag `v*` (`.github/workflows/release.yml`).
- CRM (clientes/personas/espacios/dispositivos) + encuestas; Intercom (go2rtc) protegido tras el proxy.
- Panel de agente (estilo glass), **pausa por cola** (`/api/agent/pause`), self-cam; topologia con host por nodo.
### Changed
- Reconciliacion **repo == produccion** (single source of truth); `control-plane/app.js` del repo estaba truncado y se restauro completo.
### Security
- `/go2rtc/` ya no expone el panel publico (solo `/api/ws`); resto -> 403.
- **Secretos por-deployment**: `install.sh` genera TODOS los secretos (DB, JWT, ARI, AMI, TURN, TURN_CLI, admin) con `openssl`, detecta y **regenera valores débiles/placeholder** (bug: antes `has()` dejaba pasar `cambia_esta_clave`), preflight que **aborta** si queda algo débil, `.env` con `chmod 600`, y clave inicial de `admin` generada (must_change en 1er login) via `ADMIN_DEFAULT_PASS`.
- `.env.example` ahora trae los secretos **vacíos** (nada débil se versiona).
- Compose: credenciales de **TURN requeridas** (`${TURN_PASS:?}` / `${TURN_CLI_PASS:?}`) — sin default adivinable; falla fuerte si no están. TURN_PASS es secreto **compartido** core↔edge (via `edge-join.env`).
- Compose: **Redis ya no publica** el puerto 6379 al host (era accesible sin auth).
