<div align="center">

# PBX-NG

**Plataforma de comunicaciones unificadas (UCaaS) de nueva generación**
Asterisk 22 · WebRTC · SBC Kamailio · IVR con IA · PWA softphone · Multi-WAN

</div>

---

PBX-NG es una central telefónica IP profesional, "todo-terreno" y lista para la nube: une la telefonía VoIP clásica (chan_pjsip) con tecnologías web modernas (WebRTC) para llamar desde el navegador, el móvil o un teléfono físico, con un **SBC** (Session Border Controller) propio al frente que aporta seguridad perimetral, enrutamiento por operador (LCR) con failover, manipulación SIP avanzada y ocultamiento de topología.

Todo se administra desde un **dashboard web** en tiempo real.

## Índice

- [Arquitectura](#arquitectura)
- [Características](#características)
- [Instalación](#instalación)
- [Configuración](#configuración)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Operación y mantenimiento](#operación-y-mantenimiento)
- [Seguridad](#seguridad)
- [Roadmap](#roadmap)

## Arquitectura

Diseño modular; cada servicio es independiente y puede correr en su propio contenedor/host.

```
                 Internet
                    │
        ┌───────────┴───────────┐
        │  Nginx Proxy Manager  │  TLS/WSS (Let's Encrypt)
        └───────────┬───────────┘
                    │
   ┌────────────┬───┴────┬─────────────┐
   │            │        │             │
┌──▼──┐   ┌─────▼────┐ ┌─▼────┐   ┌────▼─────┐
│ SBC │   │ Dashboard│ │ API  │   │  TURN    │
│Kamai│   │ Next.js  │ │Node  │   │ Coturn   │
│lio +│   └──────────┘ │ARI/  │   └──────────┘
│rtpe │◄───────────────┤AMI   │
│ngine│                └──┬───┘
└──┬──┘                   │
   │      ┌───────────────┼───────────────┐
   ▼      ▼               ▼               ▼
┌──────────────┐   ┌────────────┐   ┌──────────┐
│  Asterisk 22 │   │ PostgreSQL │   │  Voz IA  │
│  chan_pjsip  │◄──┤ Realtime   │   │ TTS/STT  │
│  (Realtime)  │   │ + CDR      │   └──────────┘
└──────────────┘   │ + Redis    │
                   └────────────┘
```

### Componentes y puertos

| Servicio | Rol | Puertos |
|---|---|---|
| **Asterisk 22** | Núcleo PBX (chan_pjsip, realtime ARA, transcoding) | 5060 UDP/TCP, 5061 TLS, 8088 WS, 10000-20000 RTP |
| **PostgreSQL 16** | Config realtime + CDR + datos de la app | 5432 |
| **Redis** | Caché / sesiones | 6379 |
| **Control Plane (API)** | Node/Express, ARI+AMI, Socket.io, JWT | 3000 |
| **Dashboard** | Next.js (admin + softphone WebRTC + PWA) | 3001 |
| **SBC (Kamailio 5.6)** | Borde SIP: seguridad, LCR, manipulación SIP | 5060, 8088 WS |
| **rtpengine** | Relay/anclaje de medios, aislamiento de RTP | 30000-40000 |
| **Coturn (TURN/STUN)** | Traversía NAT para WebRTC | 3478, 49152-65535 |
| **Voz IA** | TTS (Piper/Edge) + STT (faster-whisper) | 8080 |
| **Nginx Proxy Manager** | Terminación TLS/WSS + certificados | 80, 443, 81 |

## Características

**Telefonía y WebRTC**
- Internos WebRTC (navegador/PWA, sin plugins) y SIP físicos (Yealink, Grandstream, Cisco).
- Softphone PWA instalable con push RFC 8599 (FCM/APNs), ringtone, transferencia, conferencia, DND, PiP.
- Códecs: Opus, G.711 (ulaw/alaw), G.722; video VP8/H264; SRTP/DTLS en WebRTC.
- Click-to-Call público por link/QR (sin registro), con geolocalización.

**SBC (estilo AudioCodes)**
- LCR / enrutamiento por operador con **failover** automático.
- **Salud de operadores** por OPTIONS keepalive (UP/DOWN en vivo).
- **Manipulación SIP** avanzada por operador (reescribe From/PPI/PAI/Diversion/headers) con presets compatibles.
- Topology hiding, Session Timers (anti-zombi), accounting en el borde.
- Anti-flood (pike), lista de bloqueo (secfilter), auto-ban.

**Aplicaciones**
- IVR visual (React Flow) + **IVR conversacional con IA** (STT→LLM→TTS).
- Colas/ACD, conferencias, grupos de timbrado, buzón visual, paging.
- Grabación por interno o global (local/NAS/S3) con transcripción y análisis.
- Auto-aprovisionamiento de teléfonos por MAC (Yealink/Grandstream).
- Rutas entrantes (DID) y salientes, dialplan realtime, wallboard TV-ready, mapa de llamadas.

**Operación**
- Dashboard en tiempo real (Socket.io + AMI), topología animada con salud.
- Fail2Ban con geolocalización de ataques, gestión de bloqueos.
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

El instalador es **interactivo**: te pregunta la topología, qué servicios levantar (núcleo / SBC / media / IA / proxy), el dominio y genera los secretos automáticamente en `.env`. Al terminar deja el stack corriendo y te muestra las URLs.

### Opción B — Docker, todo en un contenedor (demo/pruebas)

Para levantar rápido en un solo contenedor (no recomendado para producción). El instalador lo ofrece como opción; usa `Dockerfile.allinone`.

### Opción C — Bare-metal / LXC (sin Docker)

Instalación nativa sobre Debian/Ubuntu (o contenedores LXC en Proxmox), un servicio por host. Ver [`docs/`](docs/) para la guía paso a paso de cada componente.

### Opción D — Orquestador Proxmox (crea los contenedores solo)

Para un cluster **Proxmox VE**: un script que corre en cualquier nodo y **crea
por sí mismo** todos los LXC del stack, preguntando la forma de despliegue
(compacto / híbrido / separado), el modo de la app (PBX simple o multi-tenant) y
**dónde ubicar cada componente** (recomienda el nodo con más RAM libre). Cada
contenedor corre Docker y levanta sus perfiles.

```bash
# En un nodo Proxmox, como root:
curl -fsSLO https://raw.githubusercontent.com/flavioGonz/pbx-ng/main/deploy/pbxng-proxmox.sh
chmod +x pbxng-proxmox.sh && ./pbxng-proxmox.sh
```

Ver [`deploy/`](deploy/) para el detalle (mapa de roles→perfiles, red, requisitos).

## Configuración

- **Secretos**: nunca se versionan. El instalador genera `.env` con contraseñas y JWT aleatorios. Claves de OpenAI (IVR IA), FCM/APNs (push nativo) y SMTP se cargan **cifradas desde el panel** (no en `.env`).
- **Variables clave** (`.env`): `DOMAIN`, `DB_PASS`, `JWT_SECRET`, `PUBLIC_IP`, `VAPID_*`. Ver [`.env.example`](.env.example).
- **Primer acceso**: el dashboard corre en `:3001`; publicá el dominio con TLS/WSS vía Nginx Proxy Manager (`:81`).

## Estructura del repositorio

```
control-plane/     API Node/Express (ARI+AMI, Socket.io, auth JWT)
dashboard/         Frontend Next.js (admin + softphone + PWA)
voice-service/     Microservicio de voz IA (Piper TTS + faster-whisper STT)
docker/            docker-compose, install.sh interactivo, imágenes
deploy/            orquestador de despliegue en Proxmox (pbxng-proxmox.sh)
docs/              Documentación por componente
scripts/           Utilidades (sync-and-push, etc.)
```

## Operación y mantenimiento

- **Servicios**: cada componente corre bajo systemd (bare-metal) o como contenedor (Docker), con `Restart=always`.
- **Watchdog**: un timer detecta agentes colgados (por heartbeat) y los reinicia solos.
- **Backups**: se recomienda `pg_dump` periódico de la base `pbxng` (config + CDR).
- **Logs**: dashboard `journalctl`, SBC en `/var/log`, watchdog en `/var/log/pbxng-watchdog.log`.

## Seguridad

Defensa en capas:

- **API**: autenticación **deny-by-default** (todo `/api` requiere JWT salvo una allowlist pública explícita).
- **SBC**: anti-flood (pike), lista de bloqueo gestionable (secfilter), auto-ban, ocultamiento de topología, cifrado TLS/SRTP.
- **Fail2Ban** sobre logs PJSIP con geolocalización y gestión de bloqueos/lista blanca.
- **Agentes internos** protegidos por token compartido; comandos de sistema con validación (sin `shell=True`).
- **Recomendado en producción**: rotar todos los secretos, activar TLS en teléfonos, y RBAC multi-tenant.

## Roadmap

- TURN TLS/DTLS (5349) + credenciales efímeras.
- Alta disponibilidad (estado en Redis, multi-instancia de la API).
- Multi-tenant + RBAC (modo elegible en la instalación; RBAC en curso).
- Observabilidad (Prometheus/Grafana, métricas de calidad de llamada).
- STIR/SHAKEN, T.38 fax, SIP TLS para teléfonos.

---

<div align="center">
Hecho con foco en robustez, seguridad y compatibilidad universal de dispositivos.
</div>
