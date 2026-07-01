---
name: pbx-ng
description: >-
  Conocimiento completo del proyecto PBX-NG, una PBX/UCaaS cloud construida sobre
  Asterisk 22 + realtime PostgreSQL (ARA), softphone WebRTC/PWA, SBC Kamailio 5.6.3
  estilo AudioCodes, TURN Coturn, IVR visual e IVR conversacional con IA (STT/LLM/TTS),
  y un control plane Node + dashboard Next.js. USAR SIEMPRE que haya que trabajar,
  desplegar, operar, depurar o EXTENDER PBX-NG: crear/editar internos, troncales,
  rutas, IVR, colas, grabaciones, push, click-to-call, auto-provisioning; tocar el
  dialplan de Asterisk, la config de Kamailio o Coturn, el realtime pgsql, la API/dashboard;
  empaquetar/desplegar por Docker o el orquestador Proxmox; o resolver problemas de
  registro SIP, NAT, audio one-way, WebRTC, SBC, seguridad/Fail2Ban. Contiene la
  arquitectura probada, las decisiones de diseño y sobre todo los GOTCHAS reales del
  despliegue vivo (IES cluster) y del empaquetado Docker.
---

# PBX-NG — PBX/UCaaS cloud sobre Asterisk

## Resumen ejecutivo

PBX-NG es una central telefónica IP (UCaaS) para pymes/medianas, escala objetivo
100-500 internos y 30-150 llamadas simultáneas. Arranca **single-tenant** y evoluciona
hacia multi-tenant. Todo el estado telefónico vive en **PostgreSQL realtime (ARA)**:
Asterisk lee endpoints, aor, auth, dialplan, colas y voicemail de la base, y la aplicación
los administra por API. El código real es un **monorepo** (`github.com/flavioGonz/pbx-ng`)
y se despliega de dos formas equivalentes: los **contenedores LXC vivos** del cluster
Proxmox IES (histórico) y las **imágenes Docker reproducibles + orquestador Proxmox**
(empaquetado nuevo, extraído de los CTs vivos y tokenizado sin secretos).

Piezas principales:

- **Asterisk 22.10.0** (compilado de fuente, pjsip + realtime pgsql + cdr_pgsql + srtp).
  Núcleo de conmutación, dialplan, colas, conferencias, buzón, WebRTC (transport-ws).
- **PostgreSQL 16 + Redis** — realtime ARA (ps_* + tablas de app + tablas de Kamailio),
  74 tablas en total.
- **Control plane Node/Express** (`app.js`, ~1900 líneas) — CRUD de todo, ARI+AMI,
  Socket.io en vivo, auth JWT deny-by-default, proxies a los agentes por contenedor.
- **Dashboard Next.js 14 + Mantine 7** — panel de administración; softphone/PWA `/phone`
  (SIP.js) instalable; páginas por dominio (WebRTC, internos, troncales, IVR, SBC, etc.).
- **Kamailio 5.6.3 (SBC de borde)** — protege y enruta las **troncales** de operador:
  dispatcher, drouting/LCR + failover, secfilter, dialog+SST, rtpengine (relay RTP),
  manipulación SIP + topology hiding, health por OPTIONS.
- **Coturn (TURN/STUN)** — ICE server del WebRTC (relay cuando hay NAT simétrico).
- **Voz IA (CT108)** — microservicio FastAPI: TTS neural (Piper es_MX + Edge-TTS LatAm)
  y STT (faster-whisper), consumido por el pipeline de IVR conversacional.
- **Agentes por contenedor** — cada CT infra expone un agente HTTP/DB-queue que el
  control plane orquesta (Asterisk :8092, TURN :8091, Voz :8080, SBC vía cola en DB).

**Decisión de diseño clave:** WebRTC va **directo** browser → WSS 443 (Nginx Proxy Manager)
→ Asterisk ws :8088; el SBC Kamailio se usa **solo para troncales** (y opcionalmente
teléfonos SIP remotos). Se intentó "borde único" (todo por Kamailio) y se **revirtió**
(timbrar al WebRTC servidor→navegador falla con NPM HTTP delante). Ver `gotchas.md`.

## Mapa de navegación (cuándo leer cada reference)

Los references están en `references/`. Leé el que corresponda antes de tocar esa área;
**siempre** revisá `gotchas.md` antes de cambiar dialplan, kamailio.cfg, el orden de auth
o de desplegar, porque ahí están las trampas que ya costaron tiempo.

| Reference | Leelo cuando… |
|---|---|
| `architecture.md` | Necesites el mapa de componentes, puertos, IPs, el esquema de las 74 tablas, cómo funciona el realtime ARA (extconfig/sorcery/res_pgsql), y la topología de red / borde único vs registro directo. |
| `deployment.md` | Vayas a desplegar: docker-compose (`install.sh`), el orquestador Proxmox (`deploy/pbxng-proxmox.sh`, sus 5 formas + single/multi), o el appliance. Cubre requisitos (nesting, plantilla, storage), `.env`/secretos, cómo buildean las imágenes y el flujo paso a paso. |
| `components.md` | Trabajes en un componente puntual: Asterisk (pjsip realtime, ARI/AMI/CDR/módulos), Kamailio (dispatcher/drouting/secfilter/dialog/rtpengine/manipulación SIP + tokens de config), Coturn, rtpengine, API Node, dashboard Next, Voz IA. Incluye los Dockerfiles y qué genera cada entrypoint desde ENV. |
| `operations.md` | Operes lo desplegado: watchdog de agentes, seguridad (Fail2Ban, tokens de agentes, secretos, rotación), backups (pg_dump), branding, modularidad, logs, y la convención Rutas vs Operadores. |
| `gotchas.md` | **Siempre.** Todos los pitfalls/lecciones reales (memorias + sesión Docker) con síntoma → causa → fix. Es la sección más valiosa. |
| `features.md` | Quieras el inventario completo de features (WebRTC/PWA, click-to-call, push RFC 8599, auto-provisioning, IVR visual + IA, grabaciones + transcripción, colas/ACD, conferencias, geo/mapa, wallboard, SBC avanzado, multi-WAN, SIP debug, etc.) y el roadmap/pendientes. |

## Quickstart para otra IA

1. **Ubicá el código vivo, no el mount.** El código real vive en los contenedores:
   API + dashboard en CT105 (`/opt/pbxng-api/app.js`, `/opt/pbxng-dashboard`), agentes
   en CT103/106/107/108. El repo `/opt/pbxng-repo` (CT105) y el clon del usuario en
   `C:\Users\usuario\Claude\Projects\PBX-NG` son copias versionadas (pueden estar detrás
   del vivo). El empaquetado Docker/orquestador está en el repo bajo `docker/` y `deploy/`.

2. **Para levantar de cero:** usá el empaquetado. En un host único →
   `docker/install.sh` (interactivo). En un cluster Proxmox → `deploy/pbxng-proxmox.sh`
   (orquestador que crea los LXC, instala Docker y arranca el compose). Ver `deployment.md`.
   Requisito ineludible de Docker-en-LXC: `nesting=1,keyctl=1`.

3. **Para entender el flujo de una llamada:** WebRTC interno ↔ interno va por Asterisk
   directo. Saliente a PSTN: interno → dialplan `_0.` → `Dial(@to-sbc)` → Kamailio elige
   operador por LCR/drouting con failover. Entrante: operador → Kamailio → Asterisk
   `from-trunk` → ruta entrante por DID → destino (interno/IVR/cola/app). Ver `architecture.md`.

4. **Antes de tocar algo sensible:** Asterisk realtime + dialplan → leé `components.md`
   (sección Asterisk) y `gotchas.md` (dialplan estático vs realtime, `endpoint_identifier_order`
   solo con `core restart`, direct_media=no para WebRTC↔SIP). Kamailio → leé la sección
   SBC de `components.md` y el patrón obligatorio de edición (backup `.pre-<x>` + `kamailio -c`
   + `systemctl restart` + verificar con llamada real). Deploy → `gotchas.md` (make -j2 aislado,
   API_URL vs BACKEND_URL, sembrar tabla `version`, coturn sin `-o`).

5. **Regla de oro de despliegue de código:** al escribir archivos de la app (`app.js`,
   componentes React, agentes), preferí `Write` completo o `cat > file <<'EOF'` en el CT;
   verificá byte-count / balance de llaves; NUNCA confíes en que un `Edit` parcial llegó
   intacto al lado bash (el mount se desincroniza). Ver `gotchas.md` (pitfall pull/mount).

6. **Convenciones de estilo del proyecto:** todo en español; sin emojis en la UI
   (banderas por flagcdn, iconos Tabler — agregar SIEMPRE el import del icono que uses);
   secretos nunca en código (van en `pbxng_settings` o `.env`); cada feature nueva se
   commitea con el script de sync/push que sanea secretos.

> Si un dato no está en las fuentes con certeza, este skill lo marca "(verificar)".
> Nunca inventes IPs, contraseñas ni claves: usá los placeholders indicados.
