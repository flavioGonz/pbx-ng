# PBX-NG — Arquitectura

## Índice
1. [Componentes y contenedores](#componentes-y-contenedores)
2. [Puertos](#puertos)
3. [Flujo de una llamada](#flujo-de-una-llamada)
4. [Realtime ARA (extconfig / sorcery / res_pgsql)](#realtime-ara)
5. [Esquema de base de datos (74 tablas)](#esquema-de-base-de-datos)
6. [Topología de red](#topologia-de-red)
7. [Borde único vs registro directo a Asterisk](#borde-unico-vs-registro-directo)

---

## Componentes y contenedores

Despliegue vivo de referencia (cluster Proxmox "ies-cluster", todo en pve01; pve03
corre EventOS prod, no tocar). Cada CT es LXC unprivileged, Debian 12, `nesting=1`,
`onboot=1`. Las IPs son las del laboratorio IES; en un despliegue nuevo se re-asignan.

| CT | Hostname | IP (IES) | Rol | Software |
|----|----------|----------|-----|----------|
| 103 | pbxng-asterisk | 172.26.20.183 | Núcleo de conmutación | Asterisk 22.10.0 (de fuente) + agentes (ast :8092, rec :8089, f2b, prompt) + Fail2Ban |
| 104 | pbxng-db | 172.26.20.184 | Datos | PostgreSQL (15 en IES / 16 objetivo) + Redis 7 |
| 105 | pbxng-app | 172.26.20.185 | Control plane + UI | Node 20 (API :3000) + Next.js (dashboard :3001) + repo `/opt/pbxng-repo` |
| 106 | pbxng-turn | 172.26.20.204 | TURN/STUN WebRTC | Coturn 4.6.x + agente :8091 |
| 107 | pbxng-sbc | 172.26.20.205 | SBC de borde | Kamailio 5.6.3 + rtpengine (userspace) + agente (DB-queue) |
| 108 | pbxng-voz | 172.26.20.219 | Voz IA | FastAPI :8080 (Piper TTS + faster-whisper STT + Edge-TTS) |

DB "pbxng" en PostgreSQL. Dominio público del laboratorio: **pbx.ies.com.uy**
(DNS 200.40.182.246), publicado por **Nginx Proxy Manager (NPM)** en 172.26.20.17:81
con cert Let's Encrypt (termina TLS/WSS).

En el empaquetado Docker cada rol es un servicio del compose con perfiles
(core/sbc/media/ai/proxy). Postgres+Redis+API+dashboard corren en red bridge;
asterisk/kamailio/coturn/rtpengine corren en `network_mode: host` (SIP/RTP necesitan red real).

## Puertos

| Servicio | Puerto | Notas |
|----------|--------|-------|
| Asterisk SIP UDP | 5060 | transport-udp (teléfonos SIP físicos, troncal to-sbc) |
| Asterisk SIP TCP | 5060 | transport-tcp |
| Asterisk SIP TLS | 5061 | transport-tls (cert self-signed en /etc/asterisk/keys) |
| Asterisk WS | 8088 | transport-ws (WebRTC; NPM /ws → aquí) |
| Asterisk ARI/HTTP | 8088 | http.conf; ARI user pbxng |
| Asterisk AMI | 5038 | user pbxng-ami, permit LAN |
| Asterisk RTP | 10000-20000 | rango RTP (verificar rango exacto en rtp.conf) |
| AudioSocket (IVR IA) | 9092 | Asterisk se conecta como cliente a CT105:9092 |
| PostgreSQL | 5432 | publicado para que asterisk/kamailio (host-net) lo alcancen |
| API Node | 3000 | Express + Socket.io |
| Dashboard Next | 3001 | next start |
| Kamailio SIP UDP | 5060 | borde de troncales |
| Kamailio SIP TCP | 5060 | listener agregado (para futuros UA TCP) |
| Kamailio WS | 8088 | listener WS de borde único (inofensivo, revertido) |
| Kamailio JSONRPC/xhttp | (finicky) | gestión real va por cola en DB, no por RPC HTTP |
| rtpengine ng | 127.0.0.1:2223 | control desde Kamailio |
| rtpengine CLI | 127.0.0.1:9900 | rtpengine-ctl |
| rtpengine media | 30000-40000 | rango RTP relay (forward público para media externa) |
| Coturn TURN/STUN | 3478 | udp+tcp |
| Coturn relay | 49152-65535 | rango de relay |
| Coturn CLI | 127.0.0.1:5766 | telnet (cli-password) |
| Voz IA | 8080 | FastAPI /tts /stt /health /admin |
| Agente Asterisk | 8092 | /core /net /route (X-PBXNG-Token) |
| Agente rec (grabaciones) | 8089 | sirve los .wav + /vm (X-PBXNG-Token) |
| Agente TURN | 8091 | health/config/restart/test (X-PBXNG-Token) |

Puertos que el usuario port-forwardea públicos (router MikroTik): SIP UDP 5060 → Kamailio,
rango media rtpengine 30000-40000, TURN 3478 udp+tcp + relay 49152-65535 → Coturn.

## Flujo de una llamada

**Interno ↔ interno (WebRTC / SIP):** ambos registrados en Asterisk; dialplan `[internal]`
patrón `_[1-9]XXX` → `Dial(PJSIP/${EXTEN})`. No pasa por Kamailio ni Coturn (salvo NAT
simétrico, donde Coturn relaya el RTP del navegador).

**Interno WebRTC dormido (PWA en background) — "wake & wait":** si `PJSIP_DIAL_CONTACTS`
está vacío → CURL a `/api/internal/wake` (Web Push despierta la PWA) → espera el registro
(re-chequea cada 0.5s, máx ~8s) → `Dial`. Ver `features.md`.

**Saliente a PSTN:** interno marca `0<numero>` → dialplan `[internal] _0.` →
`Dial(PJSIP/${EXTEN:1}@to-sbc)`. El endpoint `to-sbc` (troncal Asterisk↔SBC) manda el
INVITE a Kamailio; en Kamailio `do_routing("0")` (drouting/LCR) elige operador con
failover (`t_on_failure(OUTBOUND_FAILOVER)` reintenta el siguiente gateway ante 486/408/5xx),
aplica topology hiding y manipulación SIP, ancla media en rtpengine y relaya al operador.

**Entrante desde operador:** operador → Kamailio (dispatcher/ruteo) → Asterisk contexto
`[from-trunk]` (solo `switch => Realtime` + handlers i/s) → la ruta entrante realtime
matchea el DID → destino tipado (interno / IVR / cola / app).

**Convención Rutas vs Operadores:** la "Ruta saliente" (Asterisk) SIEMPRE manda al SBC
(`@to-sbc`); el operador + normalización del número los decide el SBC (Operadores/LCR).
No duplicar strip/prepend de formato de carrier en la ruta. Ver `operations.md`.

## Realtime ARA

Asterisk Realtime Architecture sobre PostgreSQL. Archivos clave en CT103 `/etc/asterisk`:

- **`res_pgsql.conf`** — credenciales de la DB pbxng (host, user, pass, dbname).
- **`extconfig.conf`** — mapea familias a la DB. Incluye: `ps_endpoints`, `ps_auths`,
  `ps_aors`, `ps_domain_aliases`, `ps_endpoint_id_ips`, `ps_contacts`, `ps_registrations`
  (pjsip realtime), `extensions => pgsql` (dialplan realtime), `queues`/`queue_members`
  (ACD realtime), `voicemail` (buzón realtime).
- **`sorcery.conf`** — declara el realtime de pjsip (los objetos pjsip vienen de la DB).
- **Transportes** (udp/tcp/tls/ws) quedan ESTÁTICOS en `pjsip.conf` `[global]`+`[transport-*]`
  (los transportes no van a realtime). `[global] endpoint_identifier_order=username,ip,anonymous`.

El dialplan es **híbrido**: contextos estáticos en `extensions.conf` (`[internal]`,
`[from-trunk]`, `[ivr]`, `[c2c]`) con `switch => Realtime` al final; los extens de apps,
IVR, rutas entrantes/salientes se generan como filas realtime en la tabla `extensions`.
**Los extens estáticos se evalúan ANTES del switch realtime** — de ahí varios gotchas
(catch-all `_X.` que sombrea DIDs, patrón `_[1-9]XXX` que tapa access-extens de 4 dígitos).
Ver `gotchas.md`.

## Esquema de base de datos

El `pg_dump --schema-only` de la DB pbxng viva = **74 tablas**, tres grupos.
Se cargan por `docker/config/initdb/01-schema.sql`; `02-seed-version.sql` siembra la tabla
`version` (Kamailio chequea versiones de sus tablas; schema-only las deja vacías y falla).

**1) Realtime de Asterisk (ps_*, ARA):**
- `ps_endpoints` (internos, troncales; + columnas custom `pbxng_kind` extension|trunk,
  `pbxng_record` bool), `ps_auths`, `ps_aors`, `ps_contacts`, `ps_domain_aliases`,
  `ps_endpoint_id_ips`, `ps_registrations`.
- `extensions` (dialplan realtime), `queues`, `queue_members`, `voicemail`.

**2) Tablas de la aplicación (`pbxng_*`):** (lista representativa, verificar el total exacto)
- Telefonía/ruteo: `pbxng_trunks` (+ kind, adv_config jsonb, kam_config jsonb),
  `pbxng_outbound_routes`, `pbxng_inbound_routes`, `pbxng_ivr` (+ flow jsonb),
  `pbxng_ivr_options`, `pbxng_ai_agents`, `pbxng_queues`, `pbxng_conferences`,
  `pbxng_ringgroups`, `pbxng_paging`, `pbxng_mailboxes`, `pbxng_directory` (ext,name).
- WebRTC/PWA/click-to-call: `pbxng_enroll`, `pbxng_click2call`, `pbxng_c2c_sessions`,
  `pbxng_contacts` (algunos en localStorage), `pbxng_call_geo`.
- Push: `pbxng_push_subs` (webpush), `pbxng_push_devices` (FCM/APNs RFC 8599).
- Teléfonos físicos: `pbxng_phones` (auto-provisioning).
- Grabaciones/audio: `pbxng_recordings` (+ transcript, analysis jsonb, peaks jsonb),
  `pbxng_rec_config`, `pbxng_prompts` (audios custom BYTEA), `pbxng_sysprompts` (voz del
  sistema, 107 prompts, audio BYTEA).
- Seguridad: `pbxng_fail2ban` (+ bans jsonb, config jsonb), `pbxng_f2b_whitelist`,
  `pbxng_fail2ban_cmd`.
- SBC: `pbxng_sbc` (estado en vivo), `pbxng_sbc_cmd` (cola de comandos), `pbxng_sbc_routes`
  (rutas estáticas multi-WAN), `pbxng_sip_capture` (SIP debug ring-buffer),
  `pbxng_sip_manip` (manipulación SIP por operador).
- Config/sistema: `pbxng_users` (bcrypt), `pbxng_settings` (keys gated: openai/fcm/apns/
  smtp/voz/branding/módulos), `pbxng_email_config`, `pbxng_integrations` (telegram/whatsapp),
  `pbxng_ep_backup` (backups de endpoint reversibles).

**3) Tablas de Kamailio:** `version` (¡sembrar!), `dispatcher`, `uacreg` (uac self-register),
`secfilter` (+ su fila en version), `dr_gateways`/`dr_rules`/`dr_gw_lists`/`dr_groups`
(drouting/LCR + sus filas en version), y las que use el build (location, etc. — muchas
vacías en el diseño actual porque el ruteo va por dispatcher/drouting).

## Topología de red

```
                     Internet (200.40.182.246)
                            │
                  ┌─────────┴─────────┐
                  │  MikroTik router   │  (port-forward: 5060→Kamailio, 3478+relay→Coturn,
                  │  (NAT / SIP ALG off)│   30000-40000→rtpengine; hairpin/split-DNS para VPN)
                  └─────────┬─────────┘
        ┌───────────────────┼────────────────────────┐
        │                   │                         │
   Navegador WebRTC   Teléfono SIP / troncal      Teléfono LAN
        │ WSS 443           │ SIP 5060 UDP             │ SIP directo
        ▼                   ▼                          ▼
   ┌─────────┐        ┌───────────┐              ┌────────────┐
   │   NPM   │ /ws    │ Kamailio  │  to-sbc      │  Asterisk  │
   │ (TLS)   ├───────►│  (SBC)    ├─────────────►│  (CT103)   │
   └────┬────┘  8088  │  CT107    │◄─────────────┤            │
        │ / /socket.io└─────┬─────┘   from-trunk └─────┬──────┘
        ▼                   │ rtpengine (RTP relay)    │ ARA realtime
   Dashboard+API            │                          ▼
   (CT105 3001/3000)   Coturn (CT106, TURN     PostgreSQL+Redis (CT104)
                       WebRTC RTP relay) ──────► Asterisk (media WebRTC)
                                                 Voz IA (CT108) ↔ Asterisk (AudioSocket)
```

- **Coturn** relaya el RTP de WebRTC (browser ↔ Asterisk). **rtpengine** (en el SBC) ancla
  el RTP de las **troncales**. Son motores de media DISTINTOS, no se conectan entre sí.
- El socket.io del dashboard pasa por NPM `/socket.io` con upgrade headers +
  `proxy_http_version 1.1` + `proxy_read_timeout 3600s`. En la práctica corre
  **polling-only** por detrás del NPM (el upgrade WS h2 no prospera de forma estable).

## Borde único vs registro directo

**Diseño VIGENTE:** WebRTC directo (browser → NPM `/ws` → Asterisk :8088); el SBC Kamailio
solo protege/enruta troncales. Internos LAN comunes registran directo a Asterisk
(172.26.20.183:5060). Internos SIP **remotos** (por internet/VPN) pueden entrar por el SBC.

**"Borde único" (intentado y REVERTIDO):** pasar TODO el SIP (incluido WebRTC) por Kamailio.
Patrón: browser → WSS 443 (NPM) → Kamailio plain WS :8088 → Asterisk plain SIP; rtpengine
bridea DTLS-SRTP/ICE (browser) ↔ RTP/AVP plano (Asterisk). Registro y saliente funcionaban,
pero **timbrar al WebRTC (servidor→navegador) falla**: con NPM (proxy HTTP) delante no hay
conexión WS 1:1 estable que Kamailio pueda reutilizar para INICIAR un pedido hacia el cliente
(`via_builder(): TCP/TLS connection for WebSocket could not be found`). Para borde único real
habría que cambiar transporte: (A) NPM Stream L4 (TLS→TCP crudo a Kamailio:8088) o
(B) Kamailio termina WSS directo (tls+ws :8089 con cert LE) — ambas abren un puerto público.
El usuario eligió revertir. El listener WS:8088 y el fix REGISTER quedaron en kamailio.cfg
(inofensivos). Detalle completo en `gotchas.md`.
