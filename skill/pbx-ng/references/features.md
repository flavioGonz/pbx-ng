# PBX-NG — Inventario de features

## Índice
1. [Telefonía núcleo](#telefonia-nucleo)
2. [WebRTC / PWA softphone](#webrtc-pwa)
3. [IVR (visual + IA)](#ivr)
4. [Click-to-Call público](#click-to-call)
5. [Push RFC 8599](#push)
6. [Auto-provisioning de teléfonos](#autoprovision)
7. [Grabaciones + transcripción](#grabaciones)
8. [Voz del sistema](#voz-sistema)
9. [SBC avanzado + multi-WAN](#sbc)
10. [Seguridad y observabilidad](#seguridad-obs)
11. [Geo / mapa](#geo)
12. [Integraciones](#integraciones)
13. [Roadmap / pendientes](#roadmap)

---

## Telefonía núcleo

- **Internos** (WebRTC o SIP), CRUD por `/internos` y API `/api/endpoints` (+ estado
  registrado/en llamada/desconectado, IP+RTT de `pjsip show contacts`, columna Vía
  Directo/SBC/WebRTC, nombre de `pbxng_directory`).
- **Troncales** (`/troncales`, editor avanzado por secciones): mode register|ip, transport
  udp/tcp/tls, codecs, DTMF, NAT, direct_media, callerid, qualify, DIDs + canales, logo,
  gateway/ruta. `kind` asterisk (pjsip) | kamailio (por el SBC).
- **Rutas** entrantes (`/rutas-entrantes`, por DID → destino tipado) y salientes
  (`/rutas-salientes`, siempre `@to-sbc`). Ver `operations.md` (Rutas vs Operadores).
- **Colas/ACD** (app_queue realtime, `pbxng_queues`, agentes online/offline, estrategias,
  wallboard TV-ready).
- **Conferencias** (ConfBridge, PIN opcional), **Ring Groups** (Dial multi con &),
  **Paging/Intercom** (app Page), **Buzón de voz** (voicemail realtime, `*97/*98`, buzón
  visual en la PWA).
- **CDR/Historial** (`/historial`, tipos de llamada, export CSV, link a grabación, la tabla
  cdr usa columna `start`). Monitor de llamadas en vivo (ChanSpy: Escuchar/Susurrar/Irrumpir).
- **Feature codes** estáticos: `*43` eco, `*44` prueba audio ES, `*65` SayDigits, `*97/*98`
  voicemail, 600 alias.
- **Transferencia** ciega y atendida (REFER/Replaces), **conferencia a 3** (ARI bridge),
  **screen share / file share / scratchpad** en videollamada, **DND** + PiP.

## WebRTC / PWA

- Softphone WebRTC (SIP.js) en el dashboard y como **PWA `/phone`** instalable (standalone,
  estilo iOS, tabs Llamadas/Contactos/Teclado/Ajustes). Login SIP propio (no requiere login
  admin). Registro vía `wss://<dominio>/ws` → Asterisk :8088.
- Tonos DTMF (Web Audio + envío en llamada), ringtone+vibración en entrante, ringback,
  historial local, contactos (CRUD localStorage + búsqueda), presencia (punto verde/gris),
  estados hold/transfer/grabar, OTA auto-update (sw.js + /version.json), captura GPS opt-in.
- **Enrollment por QR** (`/enroll?token=`, canje 24h) + escaneo QR para login (jsqr, iOS).
- **wake & wait** para internos WebRTC dormidos (push wake → espera registro → Dial).
- ICE: STUN + TURN (Coturn). direct_media=no, DTLS-SRTP, ICE, rtcp_mux.

## IVR

- **IVR visual (React Flow)** `IvrDesigner.jsx` — nodos entry/option por dígito, inspector,
  subida de audio, `flow jsonb` para reedición. Destinos: extension/ringgroup/queue/voicemail/
  ivr/ai/hangup. Ruta `/ivr/nuevo` y `/ivr/[id]`. Dialplan realtime en contexto `ivr`.
- **IVR conversacional IA (STT→LLM→TTS)** — ARI externalMedia + AudioSocket (:9092), bridge
  mixing. STT: Vosk (offline) / faster-whisper (neural CT108) / Whisper (OpenAI). TTS: espeak
  (demo) / Piper (neural) / Edge-TTS (LatAm) / tts-1 (OpenAI). Providers: demo (offline sin key)
  / neural (voz_url) / openai (si `openai_api_key` en settings). Function-calling:
  `transfer_call`, `crm_lookup` (POST a webhook). `ruleLLM` rutea por keywords. Página
  `/ai-agents` (fusionada con Voz en `/ia-voz`). Agente demo "Recepción IA" exten 7700.

## Click-to-Call

- Clientes externos llaman por WebRTC desde el navegador **sin registrarse**. Página pública
  `/call/[token]` (reusa useSoftphone, pide nombre/geo opcional, endpoint guest efímero `c2c<hex>`
  TTL 40min en contexto `c2c`). Admin `/click-to-call` (CRUD + QR + copiar URL). Rate-limit
  6/5min por IP. El nombre del visitante → CALLERID(name).

## Push

- **RFC 8599** multi-proveedor: web push (VAPID, PWA) + FCM HTTP v1 (JWT RS256) + APNs HTTP/2
  (JWT ES256, apns-push-type=voip). `push-providers.js`. Tabla `pbxng_push_devices`
  (`UNIQUE(provider,prid)`), parsea `pn-provider/pn-prid/pn-param` del `ps_contacts.uri`.
  Sin credenciales → no rompe (devuelve 0). fan-out en `sendPushToExt` (disparado en AMI
  DialBegin). Credenciales gated en `pbxng_settings`. Página `/notificaciones`.

## Auto-provisioning

- Teléfonos físicos por MAC. `GET /prov/<mac>.cfg` (Yealink, `#!version` key=value) y
  `GET /prov/cfg<mac>.xml` (Grandstream, P-codes en CDATA). Tabla `pbxng_phones`. Crea endpoint
  SIP/UDP (direct_media=no, NAT). Token opcional (`prov_token`). DHCP opción 66 → URL de
  provisioning. Página `/telefonos`. Rewrite `/prov` en next.config.js.

## Grabaciones

- Automática por interno (switch en `/internos`) + global (toggle). AstDB familia `rec`
  (`rec/<ext>`, `rec/_ALL_`), MixMonitor condicional en el dialplan (opción b = solo si se
  puentea). rec-agent CT103 registra en `pbxng_recordings`, sube a NAS/S3 (boto3), sirve por
  :8089. **Player con waveform** (`RecordingPlayer.jsx`, WaveSurfer CDN, light+dark, velocidades)
  como fila expandible en `/historial` y `/grabaciones`. **MiniWave** (SVG de barras RMS por fila).
- **Transcripción offline (STT)**: baja WAV → CT108 `/stt` (faster-whisper) → `transcript` +
  `analysis jsonb` (sentimiento heurístico ES, keywords, wpm, conflicto). Botón "Transcribir y
  analizar". Pendiente: diarización (requiere MixMonitor dual-channel), LLM para resumen.

## Voz del sistema

- Pack de 107 prompts (buzón/números/errores/conferencias/colas + dígitos) con **una sola voz
  coherente** (Edge-TTS es-UY Valentina). Tabla `pbxng_sysprompts` (audio BYTEA). Agente CT103
  reversible (backup `es-orig/`, borra los `.gsm/.g722` que compiten con el .wav). UI `/voz` tab
  "Audios del sistema" (generar todos / solo dígitos / restaurar). Gestor de audios/prompts custom
  (`pbxng_prompts`, sube WAV → base64 → BYTEA, sync a `/var/lib/asterisk/sounds/custom`).

## SBC

- Consola `/sbc` (React Flow full-bleed + tabs): Monitoreo (sparklines req/s, sesiones, mem),
  Seguridad (secfilter), Dispatcher, **Operadores** (LCR/drouting: gateways + reglas + estado por
  OPTIONS), **Manipulación SIP**, Red (multi-WAN: interfaces + rutas estáticas del kernel +
  administradas), rtpengine (KPIs + flujos en vivo), TURN (Coturn), SIP debug, Módulos
  (module-manager con estado vivo), Troncales, Extensiones remotas.
- SBC estilo AudioCodes (etapas reversibles): dialog+SST (anti-zombi), acc (accounting),
  secfilter, drouting/LCR + failover, topology hiding, manipulación SIP por operador, health
  OPTIONS. Ver `components.md` (Kamailio) y `gotchas.md`.
- **SIP debug visual** (tipo sngrep): captura HEP (Asterisk) + tcpdump (SBC) → `pbxng_sip_capture`,
  tabla tipo Wireshark + ladder SVG en drawer, glosario que explica cada mensaje, agrupar por
  Call-ID, indicador de audio, export.
- **Multi-WAN**: rutas estáticas `ip route` (reaplicadas cada loop), cada ruta = nodo Gateway en
  la topología. Consola TURN (Coturn): monitor + sesiones + config + restart + test.

## Seguridad y observabilidad

- Panel `/seguridad` sobre Fail2Ban (banderas flagcdn, intentos por IP, tiempos de ban, política
  por jail, whitelist configurable, ban manual, geo). Ver `operations.md`.
- Auth JWT deny-by-default, gestión de usuarios (`/usuarios`, roles admin/operator/viewer — RBAC
  aún no aplicado). Tokens de agentes. Watchdog de agentes. Headers de seguridad en el proxy.

## Geo

- Captura GPS opt-in en la PWA (toggle Ajustes), POST `/api/geo/report` (público). Página `/mapa`
  (Leaflet CDN, tiles OSM, marcadores circleMarker azul entrante/violeta saliente + círculo de
  precisión, filtro 24h/7d/30d). Nota privacidad: consentimiento legal.

## Integraciones

- Email SMTP por empresa (nodemailer, envío de QR de enrollment). Telegram (bot) y WhatsApp
  (openwa REST) para llamadas perdidas (`pbxng_integrations`, disparo en AMI DialEnd
  NOANSWER/BUSY/...). CRM webhook (function-calling IA). NPM (cert, publicar dominio) vía skill
  `ies-nginx-proxy`.

## Roadmap / pendientes

- **rtpengine en Docker** (imagen drachtio) — falla el listener WS sobre IPv6 link-local
  (`Failed to init websocket listener`). La PBX funciona sin él para WebRTC LAN. **Prioritario.**
- **Multi-tenant real + RBAC** — hoy single-tenant efectivo; todo user autenticado = admin.
  Agregar `requireRole('admin')`, role en el JWT, aislamiento por tenant.
- **TURN-NG** (task 224) — TURNS 5349 TLS/DTLS + cert LE, cred efímeras REST time-limited,
  cuotas/max-bps, métricas Prometheus. Hoy Coturn básico (3478, no-tls/no-dtls, cred fija).
- **HA** — mover el estado en memoria de la API a Redis para multi-instancia; failover de CTs.
- **Borde único WebRTC real** — requiere NPM Stream L4 o Kamailio WSS directo (abrir puerto
  público). Revertido por ahora.
- **Seguridad**: rotar secretos hardcodeados (VAPID privada filtrada), JWT/SIP a cookies/efímeros,
  bind de agentes a iface mgmt + firewall, jail Fail2Ban sobre Kamailio, MikroTik masquerade
  restringido a WAN (para banear IP real).
- **Modularizar `app.js`** (~1900 líneas monolítico) en config/services/routes.
- **Codec opus HD** (instalar codec_opus para interop opus↔G711).
- **Diarización** de grabaciones (MixMonitor dual-channel) + LLM para resumen.
- **Push nativo** (FCM/APNs listos; falta app nativa; hoy solo web push activo).
- **Ruteo entrante por DID en vivo** (mostrar a qué DID llaman) ligado a rutas-entrantes.
