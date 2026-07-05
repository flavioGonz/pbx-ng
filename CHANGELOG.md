# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com). Versionado: [SemVer](https://semver.org).

## [1.0.0] - 2026-07-05
### Added
- Empaquetado por **modulos = perfiles de compose = contenedores** (`pbxng-ctl` + reconciliador).
- **Sistema de release**: imagenes versionadas (`docker/release.sh`: build -> tag -> push y/o bundle air-gapped) y **deploy por pull/load** (`docker/deploy.sh` + `docker-compose.release.yml`) — sin `docker cp`.
- **Instalador multi-rol** (`docker/install.sh --role=all|core|edge`): topologia 1 VM o 2 VMs (core en LAN + edge SBC en DMZ), con `edge-join.env` (secretos compartidos) y validacion de conectividad edge->core. Guia en `docs/TOPOLOGY.md`.
- **Migraciones de DB** versionadas (`control-plane/migrate.js` + `control-plane/migrations/`).
- CI de release a GHCR por tag `v*` (`.github/workflows/release.yml`).
- CRM (clientes/personas/espacios/dispositivos) + encuestas; Intercom (go2rtc) protegido tras el proxy.
- Panel de agente (estilo glass), **pausa por cola** (`/api/agent/pause`), self-cam; topologia con host por nodo.
### Changed
- Reconciliacion **repo == produccion** (single source of truth); `control-plane/app.js` del repo estaba truncado y se restauro completo.
### Security
- `/go2rtc/` ya no expone el panel publico (solo `/api/ws`); resto -> 403.
