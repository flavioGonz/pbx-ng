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
- [Firewall y NAT (requisito)](#firewall-y-nat-requisito)
- [Softphone de escritorio (Windows)](#softphone-de-escritorio-windows)
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
| **Coturn (TURN/STUN)** | Traversía NAT para WebRTC | 3478 **UDP y TCP**, 5349 (TLS), 49152-65535 UDP (relay) |
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
- **Buzón de voz activado por defecto** en cada interno (PIN inicial = número de interno, `*97` para escucharlo), con MWI vía SUBSCRIBE/NOTIFY y buzón visual en el softphone.
- **Audios de la central en español rioplatense (voz uruguaya)**: los 326 prompts de Asterisk (buzón, números, fechas, colas, conferencias, directorio, agentes) generados con el TTS propio. Se regeneran con otra voz en un comando: `scripts/gen-sounds.py --voice es-UY-MateoNeural`.
- Auto-aprovisionamiento de teléfonos por MAC (Yealink/Grandstream).
- Rutas entrantes (DID) y salientes, dialplan realtime, wallboard TV-ready, mapa de llamadas.

**Operación**
- Dashboard en tiempo real (Socket.io + AMI), topología animada con salud.
- **Diagnóstico ICE/TURN en vivo**: el panel (SBC → TURN) y el softphone levantan una `RTCPeerConnection` real y muestran los candidatos que juntan — verde solo si el TURN está *alcanzable y autenticado*, y si el RTP de la llamada va **por TURN** o **directo**.
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

El instalador es **interactivo**: te pregunta la topología, qué **módulos** levantar, el dominio y genera los secretos automáticamente en `.env`. Al terminar deja el stack corriendo y te muestra las URLs.

**Modelo de empaquetado (importante): módulo = perfil de compose = contenedor.** Un contenedor existe **solo si su módulo está activo**. El estado activo vive en `docker/.env` → `COMPOSE_PROFILES`. Módulos:

| Módulo | Perfil | Contenedor(es) | Función |
|---|---|---|---|
| core | `core` | postgres, redis, asterisk, api, dashboard | Núcleo (siempre) |
| sbc | `sbc` | kamailio, rtpengine, wsbridge | SBC / troncales WebRTC |
| turn | `turn` | coturn | TURN/STUN para WebRTC |
| ai | `ai` | voz | IVR con IA (TTS/STT) |
| intercom | `intercom` | go2rtc | Video RTSP (intercom/cámaras) |
| proxy | `proxy` | npm | Reverse proxy TLS/WSS (opcional) |

Las **grabaciones** son función del `core` (volumen compartido `recordings`), no un contenedor aparte. Detalle completo en [`docs/PACKAGING.md`](docs/PACKAGING.md).

### Instalación por rol (1 VM o 2 VMs)

El instalador es **multi-rol**. En una sola máquina o repartido en dos VMs (núcleo en la LAN, borde SBC en la DMZ):

```bash
# SOHO / demo — todo en una VM
./install.sh --role=all

# 2 VMs — primero el CORE (LAN); genera edge-join.env con los secretos compartidos
./install.sh --role=core --public-ip=<IP_WAN> --domain=pbx.cliente.com --edge-ip=<IP_LAN_EDGE>

# copiar el join al edge:  scp docker/edge-join.env root@<IP_EDGE>:/opt/pbx-ng/docker/
# luego, en el EDGE (DMZ):
./install.sh --role=edge --join=edge-join.env --public-ip=<IP_WAN>
```

`core` genera y comparte credenciales; `edge` las consume vía `edge-join.env`, valida la conectividad al core (Postgres/AMI/ARI) y levanta solo `sbc,turn`. Arquitectura, firewall y pasos completos en [`docs/TOPOLOGY.md`](docs/TOPOLOGY.md).

### Actualización por imagen (sin `docker cp`)

Los despliegues comerciales usan **imágenes versionadas**: `docker/release.sh` construye y publica (o empaqueta para air-gapped) y `docker/deploy.sh` actualiza por `pull`/`load` + migraciones. Proceso, versionado (SemVer) y rollback en [`RELEASE.md`](RELEASE.md).

**Activar/desactivar módulos** (crea/destruye sus contenedores):

```bash
pbxng-ctl status                 # perfiles activos + contenedores
pbxng-ctl enable  intercom       # agrega el perfil y CREA go2rtc
pbxng-ctl disable intercom       # DESTRUYE go2rtc y saca el perfil
pbxng-ctl reconcile              # sincroniza contenedores <-> COMPOSE_PROFILES
```

Desde el **panel** (Módulos), el toggle escribe `pbxng_settings.mod_<id>` y un reconciliador (systemd timer, cada 20 s) llama a `pbxng-ctl` para que el contenedor exista solo si el módulo está activo. El instalador deja `pbxng-ctl` y el reconciliador instalados.

### Opción B — Docker, todo en un contenedor (demo/pruebas)

Para levantar rápido en un solo contenedor (no recomendado para producción). El instalador lo ofrece como opción; usa `Dockerfile.allinone`.

### Opción C — Bare-metal / LXC (sin Docker)

Instalación nativa sobre Debian/Ubuntu (o contenedores LXC en Proxmox), un servicio por host. Ver [`docs/`](docs/) para la guía paso a paso de cada componente.

### Opción D — Orquestador Proxmox (crea los contenedores solo)

Para un cluster **Proxmox VE**: un script que corre en cualquier nodo y **crea
por sí mismo** todos los LXC del stack, preguntando la forma de despliegue
(compacto / standalone / híbrido / separado / personalizado), el modo de la app (PBX simple o multi-tenant) y
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
| `443` (y `80` para ACME) | TCP | HTTPS + **WSS** del softphone WebRTC (vía reverse proxy) |
| `5060` / `5061` | UDP+TCP / TCP | SIP hacia Kamailio (troncales y teléfonos físicos) |
| `30000-40000` | UDP | RTP de rtpengine (medios de troncales SIP) |
| `3478` | **UDP y TCP** | STUN/TURN (coturn) — los dos, muchas redes bloquean UDP saliente |
| `49152-65535` | UDP | **Rango relay del TURN** — sin esto el candidato relay se obtiene pero **no hay audio** |
| `5349` | TCP | TURNS (TURN sobre TLS), recomendado para redes corporativas |

Nunca se publican: `5432` (Postgres), `6379` (Redis), `3000`/`3001` (API/panel), `5038` (AMI),
`8088` (ARI), `8091`/`8092` (agentes), `81` (admin del proxy).

El instalador **imprime la lista exacta** según los módulos activos y al terminar **verifica el
TURN de verdad** (STUN Binding → Allocate 401 → Allocate firmado → candidato relay):

```bash
./install.sh --print-firewall --profiles=core,sbc,turn   # solo mostrar qué abrir
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
- **Primer acceso**: el dashboard corre en `:3001`; publicá el dominio con TLS/WSS vía Nginx Proxy Manager (`:81`).

## Estructura del repositorio

```
control-plane/     API Node/Express (ARI+AMI, Socket.io, auth JWT) + migraciones
dashboard/         Frontend Next.js (admin + softphone web + paneles agente/supervisor)
softphone-app/     Softphone standalone (Vite+React+SIP.js) -> PWA + Electron/Windows
voice-service/     Microservicio de voz IA (Piper TTS + faster-whisper STT)
docker/            docker-compose, install.sh multi-rol, release.sh/deploy.sh, pbxng-ctl
deploy/            orquestador de despliegue en Proxmox (pbxng-proxmox.sh)
docs/              FIREWALL.md · TOPOLOGY.md · PACKAGING.md · schema de referencia
scripts/           check-turn.py (sonda TURN real), verify-pbxng.sh, sync-and-push.sh
```

## Operación y mantenimiento

- **Servicios**: cada componente corre bajo systemd (bare-metal) o como contenedor (Docker), con `Restart=always`.
- **Watchdog**: un timer detecta agentes colgados (por heartbeat) y los reinicia solos.
- **Backups**: se recomienda `pg_dump` periódico de la base `pbxng` (config + CDR).
- **Logs**: dashboard `journalctl`, SBC en `/var/log`, watchdog en `/var/log/pbxng-watchdog.log`.
- **Verificación**: `scripts/verify-pbxng.sh` (estado del stack) y `scripts/check-turn.py` (TURN real: STUN + Allocate + candidato relay). El panel expone el mismo diagnóstico en SBC → TURN.

## Seguridad

Defensa en capas:

- **API**: autenticación **deny-by-default** (todo `/api` requiere JWT salvo una allowlist pública explícita).
- **SBC**: anti-flood (pike), lista de bloqueo gestionable (secfilter), auto-ban, ocultamiento de topología, cifrado TLS/SRTP.
- **Fail2Ban** sobre logs PJSIP con geolocalización y gestión de bloqueos/lista blanca.
- **Agentes internos** protegidos por token compartido; comandos de sistema con validación (sin `shell=True`).
- **Recomendado en producción**: rotar todos los secretos, activar TLS en teléfonos, y RBAC multi-tenant.

## Roadmap

- TURN TLS (5349/TURNS) por defecto + credenciales efímeras (REST API de coturn).
- Alta disponibilidad (estado en Redis, multi-instancia de la API).
- Multi-tenant + RBAC (modo elegible en la instalación; RBAC en curso).
- Observabilidad (Prometheus/Grafana, métricas de calidad de llamada).
- STIR/SHAKEN, T.38 fax, SIP TLS para teléfonos.

---

<div align="center">
Hecho con foco en robustez, seguridad y compatibilidad universal de dispositivos.
</div>
