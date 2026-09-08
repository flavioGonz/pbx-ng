<div align="center">

# PBX-NG

**Plataforma de comunicaciones unificadas (UCaaS) de nueva generación**
Asterisk 22 · WebRTC · IVR con IA · PWA softphone · Multi-WAN · Borde opcional con SBC-NG

[![Versión](https://img.shields.io/github/v/tag/flavioGonz/pbx-ng?label=versi%C3%B3n&sort=semver)](https://github.com/flavioGonz/pbx-ng/tags)
[![Release (GHCR)](https://github.com/flavioGonz/pbx-ng/actions/workflows/release.yml/badge.svg)](https://github.com/flavioGonz/pbx-ng/actions/workflows/release.yml)
[![Softphone](https://github.com/flavioGonz/pbx-ng/actions/workflows/softphone.yml/badge.svg)](https://github.com/flavioGonz/pbx-ng/actions/workflows/softphone.yml)
![Asterisk 22](https://img.shields.io/badge/Asterisk-22_LTS-orange)
![Next.js 14](https://img.shields.io/badge/Next.js-14-black)
![Node 20+](https://img.shields.io/badge/Node-20%2B-339933)

</div>

---

PBX-NG es una central telefónica IP profesional, "todo-terreno" y lista para la nube: une la telefonía VoIP clásica (chan_pjsip) con tecnologías web modernas (WebRTC) para llamar desde el navegador, el móvil o un teléfono físico. Internos, WebRTC y troncales del operador van directo a Asterisk; no necesita ningún componente adicional para operar.

Todo se administra desde un **dashboard web** en tiempo real.

> **PBX-NG es la central.** El borde SIP (seguridad perimetral, LCR, troncales del operador, manipulación SIP,
> anclaje de medios, bridge WebRTC de cliente) es **[SBC-NG](https://github.com/flavioGonz/SBC-NG)**, un producto aparte
> que se licencia por separado. PBX-NG funciona **con o sin** SBC-NG adelante; cuando lo hay, se conecta desde el módulo
> «Conexión a SBC-NG» del panel. Ver [`docs/SBC-NG-SPLIT.md`](docs/SBC-NG-SPLIT.md).

## Índice

- [Arquitectura](#arquitectura)
- [Características](#características)
- [Instalación](#instalación)
- [Firewall y NAT (requisito)](#firewall-y-nat-requisito)
- [Softphone de escritorio (Windows)](#softphone-de-escritorio-windows)
- [Configuración](#configuración)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Desarrollo](#desarrollo)
- [Versionado y releases](#versionado-y-releases)
- [Operación y mantenimiento](#operación-y-mantenimiento)
- [Seguridad](#seguridad)
- [Productos relacionados](#productos-relacionados)
- [Roadmap y changelog](#roadmap-y-changelog)

## Arquitectura

Diseño modular; cada servicio es independiente y puede correr en su propio contenedor/host. El borde SIP no forma parte de PBX-NG: si hace falta, va **SBC-NG** (otro producto) delante de Asterisk.

```
                 Internet
                    │
        ┌───────────┴───────────┐        ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
        │  Nginx Proxy Manager  │          SBC-NG (otro producto,
        │  TLS/WSS (LE), /ws    │        │ opcional): Kamailio +     │
        └───────────┬───────────┘          rtpengine, LCR, troncales
                    │                    │ del operador, wsbridge    │
        ┌───────────┼───────────┐        └ ─ ─ ─ ─ ─ ┬ ─ ─ ─ ─ ─ ─ ─ ┘
        │           │           │                    │ SIP 5060 + RTP
  ┌─────▼────┐ ┌────▼─────┐ ┌───▼──────┐             │ (troncal to-sbc)
  │ Dashboard│ │   API    │ │  TURN    │             │
  │ Next.js  │ │ Node     │ │ Coturn   │             │
  └──────────┘ │ ARI/AMI  │ └──────────┘             │
               └────┬─────┘                          │
                    │                                │
   ┌────────────────┼───────────────┐                │
   ▼                ▼               ▼                │
┌──────────────┐ ┌────────────┐ ┌──────────┐         │
│  Asterisk 22 │ │ PostgreSQL │ │  Voz IA  │         │
│  chan_pjsip  │◄┤ Realtime   │ │ TTS/STT  │         │
│  (Realtime)  │ │ + CDR      │ └──────────┘         │
│  WSS :8088   │ │            │                      │
└──────▲───────┘ └────────────┘                      │
       └─────────────────────────────────────────────┘
       Sin SBC-NG: internos, WebRTC y troncales del operador
       van directo a Asterisk (5060/5061 + RTP 10000-20000)
```

### Componentes y puertos

| Servicio | Rol | Puertos |
|---|---|---|
| **Asterisk 22** | Núcleo PBX (chan_pjsip, realtime ARA, transcoding) | 5060 UDP/TCP, 5061 TLS, 8088 WS, 10000-20000 RTP |
| **PostgreSQL 16** | Config realtime + CDR + datos de la app | 5432 (solo `127.0.0.1` del host) |
| **Control Plane (API)** | Node/Express, ARI+AMI, Socket.io, JWT, RBAC | 3000 (solo `127.0.0.1` del host) |
| **Dashboard** | Next.js + proxy propio hacia la API (`server.js`); admin + softphone WebRTC + PWA | 3001 (`127.0.0.1` si NPM corre en el mismo compose) |
| **Coturn (TURN/STUN)** | Traversía NAT para WebRTC | 3478 **UDP y TCP**, 5349 (TLS), 49152-65535 UDP (relay) |
| **Voz IA** | TTS (Piper/Edge) + STT (faster-whisper) | 8080 |
| **Nginx Proxy Manager** | Terminación TLS/WSS + certificados | 80, 443, 81 |

> **SBC-NG (opcional, producto aparte)**: Kamailio + rtpengine con panel propio. No corre dentro de PBX-NG; se conecta
> por la troncal `to-sbc` (SIP hacia Asterisk 5060 + RTP 10000-20000) y sus puertos públicos se documentan en
> [su repo](https://github.com/flavioGonz/SBC-NG).

## Características

**Telefonía y WebRTC**
- Internos WebRTC (navegador/PWA, sin plugins) y SIP físicos (Yealink, Grandstream, Cisco).
- Softphone PWA instalable con push RFC 8599 (FCM/APNs), ringtone, transferencia, conferencia, DND, PiP.
- Códecs: Opus, G.711 (ulaw/alaw), G.722; video VP8/H264; SRTP/DTLS en WebRTC.
- Click-to-Call público por link/QR (sin registro), con geolocalización.

**Borde opcional con SBC-NG**

La seguridad perimetral, el LCR con failover, la salud de operadores, la manipulación SIP y el ocultamiento de topología viven en **[SBC-NG](https://github.com/flavioGonz/SBC-NG)**, un producto aparte. PBX-NG lo integra con el módulo «Conexión a SBC-NG» (Sistema → SBC-NG (conexión)): se carga IP/host, puerto, transporte (UDP/TCP/TLS), contexto, códecs y la URL del panel del SBC, y la central crea sola la troncal `to-sbc` y la ruta saliente «0 + número → SBC-NG». Con el módulo encendido, el SBC-NG aparece en la topología como nodo externo con estado medido; apagado, la central no menciona ningún borde.

**Aplicaciones**
- IVR visual (React Flow) + **IVR conversacional con IA** (STT→LLM→TTS).
- Colas/ACD, conferencias, grupos de timbrado, buzón visual, paging.
- Grabación por interno o global (local/NAS/S3) con transcripción y análisis.
- **Buzón de voz activado por defecto** en cada interno (PIN inicial = número de interno, `*97` para escucharlo), con MWI vía SUBSCRIBE/NOTIFY y buzón visual en el softphone.
- **Audios de la central en español rioplatense (voz uruguaya)**: los 326 prompts de Asterisk (buzón, números, fechas, colas, conferencias, directorio, agentes) generados con el TTS propio. Se regeneran con otra voz en un comando: `scripts/gen-sounds.py --voice es-UY-MateoNeural`.
- Auto-aprovisionamiento de teléfonos por MAC (Yealink/Grandstream).
- Rutas entrantes (DID) y salientes, dialplan realtime, wallboard TV-ready, mapa de llamadas.

**Operación**
- Dashboard en tiempo real (Socket.io + AMI), topología animada con salud.
- **Diagnóstico ICE/TURN en vivo**: el panel (Configuración → WebRTC / TURN) y el softphone levantan una `RTCPeerConnection` real y muestran los candidatos que juntan — verde solo si el TURN está *alcanzable y autenticado*, y si el RTP de la llamada va **por TURN** o **directo**.
- **Centro de seguridad (SOC)**: eventos de seguridad de Asterisk en vivo, bloqueo automático de IPs en nftables del host (vía el agente de Asterisk), geolocalización con mapa, lista blanca, filtro por país y alertas por correo.
- Watchdog de agentes (auto-recuperación de cuelgues).

## Instalación

### Requisitos

- **Docker + Docker Compose** (opción recomendada), o un host Debian/Ubuntu (bare-metal / LXC).
- Un dominio apuntando al servidor y puertos SIP/RTP/TURN abiertos.
- 2+ vCPU y 4+ GB RAM para el stack completo (más si vas a transcodificar muchas llamadas).

### Modos de la aplicación

En la instalación se elige el **modo**, que la app respeta en toda la UI y el ruteo:

- **PBX simple (single-tenant)** — una sola empresa, panel plano, sin gestión de
  inquilinos. Es lo recomendado para una central única o una *virtual appliance*.
- **Multi-tenant (SaaS)** — varias empresas aisladas (contextos PJSIP separados,
  branding y numeración por inquilino). Para ofrecer PBX como servicio.

El modo se guarda como `TENANT_MODE` (`single` | `multi`) en el `.env`. El esquema
de base de datos es *tenant-ready* en ambos casos: en modo simple todo usa un
inquilino por defecto, sin duplicar esquema.

### Opción A — Docker, un contenedor por servicio (recomendado)

Es la topología de producción: cada servicio corre aislado y escala por separado.

```bash
git clone https://github.com/flavioGonz/pbx-ng.git
cd pbx-ng/docker
./install.sh
```

El instalador es **interactivo**: te pregunta la topología, qué **módulos** levantar, el dominio y genera los secretos automáticamente en `.env`. Al terminar deja el stack corriendo y te muestra las URLs.

**Modelo de empaquetado (importante): módulo = perfil de compose = contenedor.** Un contenedor existe **solo si su módulo está activo**. El estado activo vive en `docker/.env` → `COMPOSE_PROFILES`. Módulos:

| Módulo | Perfil | Contenedor(es) | Función |
|---|---|---|---|
| core | `core` | postgres, asterisk, api, dashboard | Núcleo (siempre) |
| turn | `turn` | coturn | TURN/STUN para WebRTC |
| ai | `ai` | voz | IVR con IA (TTS/STT) |
| intercom | `intercom` | go2rtc | Video RTSP (intercom/cámaras) |
| proxy | `proxy` | npm | Reverse proxy TLS/WSS (opcional) |

Las **grabaciones** son función del `core` (volumen compartido `recordings`), no un contenedor aparte. El módulo `sbc` («Conexión a SBC-NG») es **lógico**: no levanta ningún contenedor, solo administra la troncal `to-sbc` y las rutas hacia un SBC-NG externo; viene apagado por defecto. Detalle completo en [`docs/PACKAGING.md`](docs/PACKAGING.md).

### Instalación por rol

El instalador tiene dos **roles**: `all` (todo en un host: `core,turn,ai,intercom`, es el default) y `core` (solo el núcleo, para cuando TURN, voz o intercom viven en otro host):

```bash
# SOHO / demo — todo en una VM
./install.sh --role=all

# Solo el núcleo; el coturn corre en otro host (por ejemplo, en la DMZ)
./install.sh --role=core --turn-ip=<IP_DEL_TURN> --public-ip=<IP_WAN> --domain=pbx.cliente.com
```

Flags disponibles: `--role=`, `--profiles=`, `--turn-ip=`, `--public-ip=`, `--domain=`, `--tenant=`, `--release`, `--yes` y `--print-firewall`. Sin flags, el instalador pregunta todo. Cada host tiene su propia base y sus propios secretos; no se comparte nada entre el núcleo y un SBC-NG. Topologías y pasos completos en [`docs/TOPOLOGY.md`](docs/TOPOLOGY.md).

### Actualización por imagen (sin `docker cp`)

Los despliegues comerciales usan **imágenes versionadas**: `docker/release.sh` construye y publica (o empaqueta para air-gapped) y `docker/deploy.sh` actualiza por `pull`/`load` + migraciones. Proceso, versionado (SemVer) y rollback en [`RELEASE.md`](RELEASE.md).

**Activar/desactivar módulos** (crea/destruye sus contenedores):

```bash
pbxng-ctl status                 # perfiles activos + contenedores
pbxng-ctl enable  intercom       # agrega el perfil y CREA go2rtc
pbxng-ctl disable intercom       # DESTRUYE go2rtc y saca el perfil
pbxng-ctl reconcile              # sincroniza contenedores <-> COMPOSE_PROFILES
pbxng-ctl backup [--keep=N]      # respaldo ahora (mismo camino que el cron y el planificador)
pbxng-ctl drain [--yes]          # drena Asterisk antes de tocarlo (no corta llamadas activas)
```

Desde 1.5.0 el stack se cuida solo: healthcheck en los 8 servicios (`docker compose ps` dice `healthy` de verdad; el de la API pega a `/health/ready`, que responde 503 sin base), límite de memoria por contenedor (`MEM_*` en `.env`), rotación de logs, cierre ordenado de la API por `SIGTERM`, migraciones que corren al arrancar el contenedor de la API (si fallan, no arranca) y drenado de Asterisk antes de recrearlo (`pbxng-ctl`/`deploy.sh` piden confirmación si hay llamadas, salvo `--yes`). Respaldo diario automático a las 03:00 desde la propia API (Sistema → Respaldos), con cron del host opcional. Detalle en [`docs/PACKAGING.md`](docs/PACKAGING.md) y [`docker/README.md`](docker/README.md).

Desde el **panel** (Módulos), el toggle escribe `pbxng_settings.mod_<id>` y un reconciliador (systemd timer, cada 20 s) llama a `pbxng-ctl` para que el contenedor exista solo si el módulo está activo. El instalador deja `pbxng-ctl` y el reconciliador instalados.

### Opción B — Docker, todo en un contenedor (demo/pruebas)

Para levantar rápido en un solo contenedor (no recomendado para producción). El instalador lo ofrece como opción; usa `Dockerfile.allinone`.

### Opción C — Bare-metal / LXC (sin Docker)

Instalación nativa sobre Debian/Ubuntu (o contenedores LXC en Proxmox), un servicio por host. Ver [`docs/`](docs/) para la guía paso a paso de cada componente.

### Opción D — Orquestador Proxmox (crea los contenedores solo)

Para un cluster **Proxmox VE**: un script que corre en cualquier nodo y **crea
por sí mismo** todos los LXC del stack, preguntando la forma de despliegue
(compacto / núcleo + acceso / núcleo + voz / separado / personalizado), el modo de la app (PBX simple o multi-tenant) y
**dónde ubicar cada componente** (recomienda el nodo con más RAM libre). Cada
contenedor corre Docker y levanta sus perfiles.

```bash
# En un nodo Proxmox, como root:
curl -fsSLO https://raw.githubusercontent.com/flavioGonz/pbx-ng/main/deploy/pbxng-proxmox.sh
chmod +x pbxng-proxmox.sh && ./pbxng-proxmox.sh
```

Ver [`deploy/`](deploy/) para el detalle (mapa de roles→perfiles, red, requisitos).

## Firewall y NAT (requisito)

**No es un anexo: sin esto hay llamadas mudas.** La señalización (SIP/WSS) suele pasar
sola; el audio (RTP, UDP en rangos altos) es lo primero que se rompe.

Hacia Internet se publica **solo** esto:

| Puerto | Proto | Para qué |
|---|---|---|
| `443` (y `80` para ACME) | TCP | HTTPS + **WSS** del softphone WebRTC (vía reverse proxy, que reenvía `/ws` a Asterisk :8088) |
| `3478` | **UDP y TCP** | STUN/TURN (coturn) — los dos, muchas redes bloquean UDP saliente |
| `49152-65535` | UDP | **Rango relay del TURN** — sin esto el candidato relay se obtiene pero **no hay audio** |
| `5349` | TCP | TURNS (TURN sobre TLS), recomendado para redes corporativas |
| `5060` / `5061` | UDP+TCP / TCP | SIP de Asterisk — **solo** si hay troncales del operador o teléfonos remotos hablando directo con la central |
| `10000-20000` | UDP | RTP de Asterisk — va junto con 5060/5061, en el mismo caso |

Si hay un **SBC-NG** adelante, el SIP/RTP público se expone en el SBC-NG (ver su documentación) y la central solo
necesita LAN hacia él: no se publican 5060/5061 ni 10000-20000.

Nunca se publican a Internet: `5432` (Postgres) y `3000` (API) escuchan **solo en `127.0.0.1` del host**
(los necesita Asterisk, que corre en host network; desde 1.4.0 no hay Redis en el stack), `3001` (panel: va
detrás del proxy; con NPM en el mismo compose queda en loopback), `5038` (AMI) y `8088` (ARI) —desde
1.7.0 el propio agente de Asterisk los **restringe a redes privadas con nftables** (`pbxng-mgmt`; si un
admin llega por Tailscale/VPN con rango no RFC 1918, `/etc/pbxng/fw.json` con `mgmt_allow`, ver
[`docs/FIREWALL.md`](docs/FIREWALL.md) §1.2)—, `8091`/`8092` (agentes), `81` (admin del proxy).

El instalador **imprime la lista exacta** según los módulos activos y al terminar **verifica el
TURN de verdad** (STUN Binding → Allocate 401 → Allocate firmado → candidato relay):

```bash
./install.sh --print-firewall --profiles=core,turn       # solo mostrar qué abrir
scripts/check-turn.py --env docker/.env --tcp            # verificar el TURN a mano
```

Trampas frecuentes (port-forward incompleto, `external-ip` mal seteada, **NAT hairpin**, cómo
leer los errores ICE `701` vs `401`) y recetas de router: **[`docs/FIREWALL.md`](docs/FIREWALL.md)**.

## Softphone de escritorio (Windows)

Además del softphone WebRTC embebido en el panel y de la PWA, el repo trae un **softphone
standalone** (`softphone-app/`) que se instala como aplicación de escritorio y **registra
contra cualquier PBX**, no solo PBX-NG:

- **Doble motor**: WebRTC (WSS, SIP.js) o **SIP nativo** (UDP/TCP/TLS, RTP/SRTP propio) para
  centrales que no exponen WebSocket.
- G.711 µ/A, DTMF RFC 4733 / SIP INFO, SDES-SRTP, REFER (transferencia ciega), DNS SRV, MWI,
  RTCP y estadísticas de calidad reales.
- Ventana sin bordes, **mini-widget flotante** de llamada, re-registro al despertar el equipo,
  buzón visual, CRM screen-pop, provisioning remoto por QR/`pbxng://`, config **cifrada** (DPAPI),
  auto-update y diagnóstico ICE/TURN en vivo.
- Empaquetado con Electron Builder (instalador NSIS en español, `.exe` + `.msi`).

```bash
cd softphone-app
npm install
npm run dev        # desarrollo (Vite)
npm run electron   # ventana de escritorio
npm run dist       # instalador Windows en release/
```

## Configuración

- **Secretos**: nunca se versionan. El instalador genera `.env` con contraseñas y JWT aleatorios. Claves de OpenAI (IVR IA), FCM/APNs (push nativo) y SMTP se cargan **cifradas desde el panel** (no en `.env`).
- **Variables clave** (`.env`): `DOMAIN`, `DB_PASS`, `JWT_SECRET`, `PUBLIC_IP`, `VAPID_*`. Ver [`.env.example`](.env.example).
- **Primer acceso**: el dashboard corre en `:3001`; publicá el dominio con TLS/WSS vía Nginx Proxy Manager (`:81`). Con el perfil `proxy` en el mismo compose el instalador ata `:3001` a `127.0.0.1` (`DASHBOARD_BIND`) y se entra por 443; si el proxy está en otro host, `DASHBOARD_TRUST_PROXY=1` y restringí `:3001` a su IP por firewall. La API **no arranca** con `JWT_SECRET` vacío, placeholder o de menos de 16 caracteres.
- **Diagnóstico**: la API loguea en JSON (`{ts, level, mod, msg}`); `LOG_LEVEL=debug` para ver más, `LOG_FORMAT=text` para leer a mano. `GET /health` responde `503 {status:'degraded', db:false}` cuando Postgres no contesta (los monitores externos deben esperar eso). Variables y contrato en [`docs/CONTRATOS.md`](docs/CONTRATOS.md) §3 y §6.
- **Roles** (desde 1.4.0): `admin` (todo), `supervisor` (operación y call center, sin configuración del sistema) y `agente` (su panel y su extensión). El rol por defecto al crear usuarios es `agente`; contraseñas de 8+ caracteres. Tabla completa de permisos en [`docs/CONTRATOS.md`](docs/CONTRATOS.md) §2.

## Estructura del repositorio

```
control-plane/     API Node/Express (ARI+AMI, Socket.io, auth JWT) + migraciones
dashboard/         Frontend Next.js (admin + softphone web + paneles agente/supervisor)
softphone-app/     Softphone standalone (Vite+React+SIP.js) -> PWA + Electron/Windows
voice-service/     Microservicio de voz IA (Piper TTS + faster-whisper STT)
docker/            docker-compose, install.sh multi-rol, release.sh/deploy.sh, pbxng-ctl
deploy/            orquestador de despliegue en Proxmox (pbxng-proxmox.sh)
docs/              FIREWALL.md · TOPOLOGY.md · PACKAGING.md · schema de referencia
scripts/           check-turn.py (sonda TURN real), verify-pbxng.sh, gen-sounds.py (audios es-UY)
.github/workflows/ ci.yml (lint + tests + build en PR/main) · release.yml (imágenes a GHCR por tag v*, depende de ci) · softphone.yml (instalador Windows)
VERSION · CHANGELOG.md · RELEASE.md · ROADMAP.md
```

Los videos de fondo del login (`*.mp4`) **no se versionan** (viven en disco / en la imagen de branding), igual que `.env`, backups y modelos de voz.

## Desarrollo

Requisitos: **Node 20+** (las imágenes usan `node:20-slim`; `npm run lint` de la API pide Node ^20.19 / ^22.13 / 24+ por ESLint 10, la CI usa 22), Docker para el stack completo, Python 3 para `voice-service/` y los scripts. Para las pruebas de integración de la API, un PostgreSQL 16 instalado (`apt install postgresql-16` o `brew install postgresql@16`; no hace falta que el servicio corra) o `PGURL` apuntando a un servidor con permiso `CREATEDB`.

```bash
# API (control plane) — necesita un Postgres y un Asterisk alcanzables (ver .env.example)
cd control-plane && npm ci && npm start                 # :3000

# Dashboard — `node server.js` (Next + proxy propio a la API: /backend, /socket.io, /prov, /descargas/softphone).
# API_URL se lee al arrancar (por defecto http://127.0.0.1:3000), no en el build.
cd dashboard && npm ci && npm run dev                   # :3001 (NODE_ENV=development, con HMR)
npm run build                                           # verifica que compila antes de commitear

# Softphone de escritorio
cd softphone-app && npm ci && npm run dev
```

Red de seguridad (desde 1.7.0; contrato en [`docs/CONTRATOS.md`](docs/CONTRATOS.md) §10):

```bash
# API: lint (0 errores obligatorio) y pruebas
cd control-plane && npm run lint && npm test
#   npm test = node --test test/*.test.js, ~20 s: guard.test.js (mocks) + auth/rbac/users/trunks/sbc-link/calls
#   (integración: levantan la API real contra un Postgres efímero con 01-schema.sql + migrate.js; sin Postgres
#   a mano se marcan skip con el motivo). TEST_API_VERBOSE=1 vuelca el log de la API hija.

# Panel: lint y build (next build corre el lint y corta por errores; los exhaustive-deps son avisos)
cd dashboard && npm run lint && npm run build
```

La CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) corre eso mismo en cada PR y push a `main` —jobs `api`
(con `postgres:16-alpine`), `dashboard`, `compose` (paridad y `config -q` de ambos compose) y `shell` (`bash -n`,
`py_compile`)— y es la puerta de `release.yml`: un tag con la CI roja no construye ni publica imágenes. Cómo
reproducir cada job a mano: [`docs/PACKAGING.md`](docs/PACKAGING.md) §CI.

Reglas de la casa:

- **El repo es la única fuente de verdad.** Nada se parchea en producción a mano ni con `docker cp`: el cambio va al repo → imagen versionada → `deploy.sh`.
- **Cambios de esquema** = una migración nueva `control-plane/migrations/000N_*.sql` (el runner es `migrate.js`, transaccional por archivo). `docker/config/initdb/01-schema.sql` es el esquema canónico para bases *nuevas* y se regenera en cada release mayor.
- **Config de Asterisk generada por el panel** va al patrón `pbxng.d/` (volumen `asterisk_conf` + `#include`), nunca editando los `.conf` base.
- **Todo configurable desde el panel** (producto final): sin valores hardcodeados ni ediciones de `.env` para operar.
- Commits en español, imperativo, con el área adelante (`topologia: ...`, `seguridad: ...`, `docs(manual): ...`). Toda entrada relevante va a `CHANGELOG.md`.
- Dependencias: se actualizan **dentro de la misma mayor** con lockfile regenerado y `npm run build` verde; los saltos de mayor (Next 15+, React 19, Mantine 8+, Express 5) se planifican aparte porque tienen cambios incompatibles.

## Versionado y releases

- `VERSION` + [`CHANGELOG.md`](CHANGELOG.md) siguen **SemVer** / *Keep a Changelog*.
- Un tag `vX.Y.Z` dispara [`release.yml`](.github/workflows/release.yml), que construye y publica las 5 imágenes
  `ghcr.io/flaviogonz/pbx-ng/<asterisk|api|dashboard|coturn|voz>:X.Y.Z` (Asterisk compila desde fuente: ~15–50 min).
  Las de terceros (postgres, go2rtc, npm) se usan pinneadas. Kamailio/rtpengine/wsbridge ya no se construyen acá: son de SBC-NG.
- `docker/release.sh --bundle` genera el paquete *air-gapped* (`dist/pbxng-<ver>-images.tar.gz`) para clientes sin acceso a Internet.
- En el host destino, `docker/deploy.sh` hace `pull`/`load` → migraciones → `up -d`. Rollback = desplegar la versión anterior. Detalle en [`RELEASE.md`](RELEASE.md).
- El tag `softphone-vX.Y.Z` publica el instalador Windows del softphone ([`softphone.yml`](.github/workflows/softphone.yml)).

## Operación y mantenimiento

- **Servicios**: cada componente corre bajo systemd (bare-metal) o como contenedor (Docker), con `Restart=always`.
- **Watchdog**: un timer detecta agentes colgados (por heartbeat) y los reinicia solos.
- **Backups**: se recomienda `pg_dump` periódico de la base `pbxng` (config + CDR).
- **Logs**: dashboard `journalctl`, watchdog en `/var/log/pbxng-watchdog.log`.
- **Verificación**: `scripts/verify-pbxng.sh` (estado del stack) y `scripts/check-turn.py` (TURN real: STUN + Allocate + candidato relay). El panel expone el mismo diagnóstico en Configuración → WebRTC / TURN.

## Seguridad

Defensa en capas:

- **API**: autenticación **deny-by-default** (todo `/api` requiere JWT salvo una allowlist pública explícita) y **RBAC por método+ruta** (`control-plane/rbac.js`, lo que no figura es solo `admin`; un agente solo opera su propia extensión). Rate limit en login y token de softphone (10 fallos/10 min por IP+usuario y 50 por IP, con la IP real que arma el proxy del panel), `helmet`, bcrypt asíncrono, arranque abortado sin `JWT_SECRET` real.
- **Enrolamiento y softphone**: el enlace/QR es de un solo uso (2 min de gracia) y entrega un token de alcance `phone` (nunca una sesión de panel); el socket.io exige JWT (panel o softphone) también para la pizarra.
- **Red**: Postgres y API solo en loopback del host; el panel en loopback cuando NPM corre en el mismo compose. Sin Redis. ARI (`8088`) y AMI (`5038`) sólo desde redes privadas (nftables, desde 1.7.0).
- **Panel** (desde 1.8.0): **CSP completa** con `script-src` (más `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` y `Permissions-Policy`) en toda respuesta de Next; `connect-src 'self'` porque la API, el socket y el SIP van por el mismo origen. Un solo punto de acceso a la API (`dashboard/app/api.js`), así que el token viaja también en las descargas y los audios, que antes se pedían por URL directa y sin `Authorization`. El socket no se abre sin JWT.
- **Borde**: TLS (5061) y DTLS-SRTP los termina Asterisk. Anti-flood, listas de bloqueo, auto-ban y ocultamiento de topología en el perímetro los aporta SBC-NG, si se lo pone adelante.
- **Anti fuerza bruta SIP real** (`control-plane/guard.js`, desde 1.6.0): los eventos de seguridad de Asterisk (`res_security_log`, por AMI) alimentan un contador por IP; el bloqueo lo aplica **nftables en el host** (tabla `inet pbxng`, `docs/FIREWALL.md` §1.1) a través del agente del contenedor de Asterisk. Lista blanca por IP/CIDR, geo-bloqueo por país, `unidentified_request_*` de PJSIP desde el panel, y la pantalla dice si el firewall está aplicando de verdad.
- **Agentes internos** protegidos por token compartido (`X-PBXNG-Token`; desde 1.7.0 en todo `POST` y en los `GET` de configuración del agente de Asterisk, sólo `/core` y `/metrics` quedan abiertos); comandos de sistema con validación (`ip route`, `nft` por `argv`, sin `shell=True`). El buzón propio (`*97`) se identifica por el endpoint PJSIP que autenticó, no por el caller ID que manda el teléfono.
- **Recomendado en producción**: rotar todos los secretos, activar TLS en teléfonos, y no exponer `:3001` sin proxy fuera de la LAN (el aislamiento multi-tenant real sigue pendiente, ver `docs/EVALUACION-2026-09.md` 3.10).

## Productos relacionados

| Producto | Qué es | Repo |
|---|---|---|
| **SBC-NG** | Session Border Controller (Kamailio + rtpengine) con panel propio; opcional delante de PBX-NG | [flavioGonz/SBC-NG](https://github.com/flavioGonz/SBC-NG) |
| **Softphone PBX-NG** | Cliente de escritorio Windows / PWA, registra contra cualquier PBX | [`softphone-app/`](softphone-app/) |

## Roadmap y changelog

- Estado real del producto y brechas priorizadas: [`ROADMAP.md`](ROADMAP.md).
- Historial de cambios por versión: [`CHANGELOG.md`](CHANGELOG.md).

---

<div align="center">
Hecho con foco en robustez, seguridad y compatibilidad universal de dispositivos.
</div>
