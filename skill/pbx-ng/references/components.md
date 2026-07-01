# PBX-NG — Componentes en detalle

## Índice
1. [Asterisk](#asterisk)
2. [Kamailio (SBC)](#kamailio-sbc)
3. [rtpengine](#rtpengine)
4. [Coturn (TURN/STUN)](#coturn)
5. [Control plane (API Node)](#control-plane-api-node)
6. [Dashboard (Next.js)](#dashboard-nextjs)
7. [Voz IA (CT108)](#voz-ia)
8. [Agentes por contenedor](#agentes-por-contenedor)

---

## Asterisk

**Versión:** 22.10.0 LTS, compilada desde fuente (pjproject/jansson bundled; res_srtp,
res_pjsip, res_config_pgsql, cdr_pgsql). Base Debian 12.

**Realtime pjsip (ARA):** endpoints/auth/aor/contact/registrations viven en la DB
(tablas `ps_*`). Ver `architecture.md` (extconfig/sorcery/res_pgsql). Los transportes son
estáticos en `pjsip.conf`: `transport-udp` (5060), `transport-tcp` (5060),
`transport-tls` (5061, cert self-signed en `/etc/asterisk/keys/pbxng.crt|key`),
`transport-ws` (8088, WebRTC). `[global] endpoint_identifier_order=username,ip,anonymous`.

**Perfiles de endpoint:**
- WebRTC: `transport-ws, webrtc=yes, dtls_auto_generate_cert=yes, ice_support=yes,
  use_avpf=yes, media_encryption=dtls, media_use_received_transport=yes, rtcp_mux=yes`,
  `direct_media=no`, allow ulaw/g722; NAT: `rtp_symmetric/force_rport/rewrite_contact=yes`.
- SIP físico: `transport-udp, direct_media=no, rtp_symmetric/force_rport/rewrite_contact=yes`,
  allow ulaw,alaw,g722.
- **direct_media=no es obligatorio** para WebRTC↔SIP (si no, reINVITE a media directa
  imposible entre DTLS y RTP → corte al atender). Ver `gotchas.md`.

**Dialplan (extensions.conf, contextos estáticos + switch Realtime):**
- `[internal]` patrón `_[1-9]XXX`: wake&wait (CONTACTS vacío → CURL wake → poll registro →
  Dial), hook IVR `GotoIf(DIALPLAN_EXISTS(ivr,...))`, grabación condicional (DOREC + MixMonitor
  opción b), feature codes estáticos (`*43` eco, `*44` prueba audio ES, `*65` SayDigits,
  `*97/*98` voicemail) con `Answer()+Wait(1)` antes de Playback. Ruta saliente `_0.` →
  `Dial(PJSIP/${EXTEN:1}@to-sbc)`.
- `[from-trunk]`: SOLO `switch => Realtime` + handlers `i`/`s` → Hangup + `include => ivr`.
  Sin catch-all `_X.` (sombreaba los DIDs realtime).
- `[ivr]`: `switch => Realtime` (apps, colas, conf, ring groups, paging, IVR, agentes IA).
- `[c2c]`: `switch => Realtime` (guests efímeros de click-to-call).

**ARI** (http 8088, user pbxng) — usado por el pipeline de IA (`externalMedia`, bridges,
Stasis) y por el monitor de llamadas. **AMI** (5038, user pbxng-ami, permit LAN) — Originate
(ChanSpy, conferencia), DBPut/DBDel (flags de grabación en AstDB familia `rec`), Command.
**CDR** a PostgreSQL (`cdr_pgsql`; la tabla usa columna `start`, no `calldate`).

**Sonidos ES:** los prompts es viven en `/usr/share/asterisk/sounds/es` (symlink desde
`/var/lib/asterisk/sounds/es`). `defaultlanguage=es`. `format_g722.so` NO está compilado
(los `.g722` no se leen) → se usan `.gsm/.wav` + codec_g722. La voz del sistema puede
regenerarse con una sola voz coherente (Edge-TTS es-UY) — ver `features.md`.

**Transcoding:** `core show translation` traduce ulaw/alaw/g722/gsm/g726/slin (nativos).
opus NO transcodifica (falta codec_opus) → WebRTC usa ulaw/g722. g729 pass-through-only.

## Kamailio (SBC)

**Versión:** 5.6.3 (USE_TLS ok). Rol: borde de troncales (protección + LCR + media relay).
Config: `/etc/kamailio/kamailio.cfg` + `/etc/kamailio/dispatcher.list`.

**Patrón de edición OBLIGATORIO:** backup `.pre-<x>` → editar → `kamailio -c` (valida
SINTAXIS, NO runtime/lógica) → `systemctl restart` (NO reload para muchos cambios) →
`systemctl is-active` + journal → **probar registro + llamada real** (muchos bugs son
lógicos/runtime y solo se ven así). Rollback = copiar el backup + restart.

**Módulos cargados:** tm tmx sl rr pv maxfwd textops siputils xlog sanity ctl **dispatcher
nathelper pike htable rtpengine websocket db_postgres uac** jsonrpcs xhttp kex corex +
**dialog acc sst secfilter drouting**. Markers de config del feature-engine:
`#=== PBXNG-MODS START/END ===`, `#=== PBXNG-ROUTE START/END ===`,
`#=== PBXNG-SIPMANIP START/END ===`. Flags de mensaje: 2=dispatcher, 4=dialog, 5=sst, 6=acc.

**Funciones por etapa (todas reversibles, estilo AudioCodes):**
- **dispatcher** — set 1 = Asterisk (camino de llamada), set 2 = operadores (OPTIONS
  keepalive, flag 8 DST_PROBING + `ds_probing_mode=3` + `ds_ping_reply_codes` con
  2xx/403/404/405/480/486). Estado por `flags.charAt(0)` (A up / I down / P probing).
- **pike + htable ipban** — anti-flood; exime LAN (`src_ip != 172.26.20.0/24`) para no
  banear el gateway NATeado.
- **dialog + SST** — anti-zombi server-side (`dlg_flag=4, default_timeout=7200`,
  `sst min_se=90, reject_to_small=0, sst_flag=5`). **sst EXIGE `setflag(5)` en el INVITE
  inicial** o falla en mod_init (`no sst flag set!!`), cosa que `kamailio -c` no cata.
- **acc** — accounting (`log_flag=6, log_extra="src=$fU;dst=$rU;srcip=$si"` con `;`, no espacios).
- **secfilter** — filtro por blacklist/whitelist (tabla PG `secfilter` + fila en `version`).
  `secf_check_ua()`/`secf_check_ip()` devuelven POSITIVO cuando está PERMITIDO → bloquear con
  `if (!secf_check_ua()) drop`, NO al revés. Tipos: 0=UA 1=país 2=dominio 3=IP 4=usuario 5=dst.
- **drouting / LCR** — tablas `dr_gateways/dr_rules/dr_gw_lists/dr_groups` (+ filas en `version`).
  Saliente: `if (INVITE && !has_totag() && src_ip==Asterisk && !($ru =~ "alias="))
  { do_routing("0"); t_on_failure(OUTBOUND_FAILOVER); ... }`. **Guard `!($ru =~ "alias=")`
  crítico** (si no, INVITEs a internos remotos con alias= caen a la PSTN). En este build
  drouting reescribe **$ru** (no $du). `failure_route` usa `use_next_gw()` ante 486/408/5xx.
- **topology hiding (TOPOHIDE)** — solo en la pata saliente a operador:
  `set_advertised_address("<PUBLIC_IP>")`, `record_route_advertised_address(...)`
  (record_route normal NO respeta advertised), quita User-Agent/X-AST-Orig-Host/P-hint.
  `set_advertised_port` NO parsea en este build (omitir).
- **manipulación SIP (SIPMANIP)** — motor configurable (tabla `pbxng_sip_manip`), reescribe
  headers en la pata saliente. Un route con solo comentario = body vacío → poner `return;`.
- **rtpengine** — ancla RTP de troncales (ver abajo). WebRTC NO pasa por Kamailio.

**Alias/NAT para teléfonos remotos:** `set_contact_alias()` en REGISTER externo;
`handle_ruri_alias()` en la rama de entrega a UA registrado; `record_route()` en esa rama;
descarte de self-loop (`if (uri==myself) exit;`). Para un interno común remoto por el SBC,
Asterisk debe identificarlo por **username** (no IP): `endpoint_identifier_order=username,ip`
+ `identify_by='username,ip'` en el endpoint. Robustez futura: Path (RFC 3327). Ver `gotchas.md`.

**Gestión desde la app:** el RPC HTTP/xhttp de Kamailio es finicky → el canal es
**PostgreSQL**: agente CT107 `/opt/pbxng-sbc-agent.py` (systemd, psycopg2) vuelca kamcmd a
la tabla `pbxng_sbc` cada 6s y ejecuta comandos de `pbxng_sbc_cmd` (reload, unban, ban,
add_target/del_target, secf_reload, dr_reload, sipmanip_apply, route_add/del, cfg_save, etc.).
Conexión con `client_encoding='UTF8'` (la ñ del cfg rompe si no).

## rtpengine

En repos Debian bookworm (`apt install rtpengine`, v10.5.x). LXC sin módulo kernel →
**modo userspace** (`table = -1`). Config CT107 `/etc/rtpengine/rtpengine.conf`:
`interface=<interna>!<publica>` (para NAT), `listen-ng=127.0.0.1:2223`,
`listen-cli=127.0.0.1:9900`, `port-min/max=30000-40000`. `/etc/default/rtpengine-daemon`:
`RUN_RTPENGINE=yes`. Integrado en Kamailio: `rtpengine_manage()` en INVITE inicial + re-INVITE,
`rtpengine_delete()` en BYE. Direction-aware para borde único: hacia Asterisk plano
(`ICE=remove RTP/AVP`), hacia browser (`ICE=force RTP/SAVPF`). En Docker la imagen drachtio
falla el listener WS sobre IPv6 link-local (pendiente; ver `gotchas.md`).

## Coturn

**Coturn ≠ rtpengine** (motores de media distintos). CT106, turnserver 4.6.x.
`/etc/turnserver.conf`: `realm <dominio>`, listening 3478, relay 49152-65535,
`user=pbxng:<TURN_PASS>` (lt-cred-mech estático), `external-ip <publica>/<interna>`,
CLI habilitado (`cli-password`, `cli-ip=127.0.0.1`) para listar sesiones.
Cuotas: `total-quota=200, stale-nonce=600, no-loopback-peers, no-multicast-peers`
(NO `user-quota`: la cred es compartida). Es el ICE server del softphone. Pendiente:
TURNS 5349 TLS/DTLS + cred efímeras REST + métricas (task 224). En Docker: entrypoint
resuelve tokens; **CMD sin `-o`**.

## Control plane (API Node)

`/opt/pbxng-api/app.js` (~1900 líneas, monolítico) + `ai-pipeline.js` + `push-providers.js`
+ `ai/vosk_stt.py`. Node 20 + Express, servicio `pbxng-api` :3000.

- **Auth deny-by-default:** gate `app.use('/api', (req,res,next)=> isPublicApi(req)?next():auth(...))`
  ANTES de las rutas. `PUBLIC_API` = allowlist regex de las rutas realmente públicas
  (login, branding, enroll/:token, recordings audio/peaks/transcript, prompts audio,
  push vapid/subscribe/register, calls record/conference [PWA], directory, presence,
  internal/wake, c2c public, geo/report, vm). Cualquier ruta nueva nace PROTEGIDA.
  `isPublicApi` usa `(req.baseUrl||'')+req.path` (montado en '/api', `req.path` viene sin prefijo).
- **JWT** (12h, `JWT_SECRET`), bcrypt para users. Seed `admin` (cambiar). **Falta RBAC**
  (todo user autenticado = admin).
- **ARI + AMI** helpers; **Socket.io** broadcast de snapshot {health,extensions,channels,queues}
  cada 3s + ante eventos AMI. Sala `state` (autenticados) vs `scratch` (relay pizarra sin JWT).
- **Proxies a agentes:** `/api/asterisk/*` (CT103:8092), `/api/turn/*` (CT106:8091),
  `/api/voz/*` (CT108:8080), `/api/sbc/*` (cola DB). Mandan `X-PBXNG-Token`
  (`/etc/pbxng/agent.token`).
- **Patch de fetch en el front** agrega Bearer a `/backend`; el socket recibe el token en
  el handshake.

**REGLA:** `app.js` se regenera SIEMPRE por heredoc completo o python str.replace sobre la
copia desplegada, NUNCA con Edit parcial del harness (trunca). Ver `gotchas.md`.

## Dashboard (Next.js)

`/opt/pbxng-dashboard`, Next 14 (app router, JS, CSS + Mantine 7 + @tabler/icons-react),
servicio `pbxng-dashboard` :3001. AppShell (sidebar Operación/Telefonía/Sistema), CrudPanel
genérico, React Flow (@xyflow/react) para topología/SBC/IVR designer, SIP.js para el softphone.

- **Rewrites (next.config.js):** `/backend/:path* → ${API_URL}/:path*`, `/ws → Asterisk:8088`,
  `/socket.io → API:3000`, `/prov → API`. **Usar `API_URL`** (no BACKEND_URL). Headers de
  seguridad (X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, CSP).
- **PWA `/phone`** (softphone SIP.js, standalone, sin AppShell): PWA instalable
  (manifest, sw.js, OTA por /version.json). Login SIP propio (no requiere login admin).
- **Build:** `NODE_OPTIONS=--max-old-space-size=1600` en 2GB. `version.json` se re-estampa
  cada deploy (JSON válido por base64). Iconos Tabler: agregar SIEMPRE el import del icono
  usado (si no, ReferenceError → React #418/#423, pantalla rota).

## Voz IA

CT108, FastAPI `/opt/voz/server.py` :8080. `/tts` {text,voice,rate,format} → PCM slin
(Piper es_MX o Edge-TTS LatAm → sox/ffmpeg a 8k), `/stt` PCM {rate} → texto (faster-whisper,
modelo `small` por CPU), `/health` (metrics + stats), capa `/admin` (logs, restart, voices
install/delete, config → `/etc/voz.env` + restart). Pipeline consumidor: `ai-pipeline.js`
(prioridad OpenAI > neural > demo espeak/Vosk). Transporte a Asterisk = AudioSocket
(CT105:9092). Ver `features.md` (IVR IA) y `gotchas.md` (rate 8k, wav seekable, pacing TX).

## Agentes por contenedor

Cada CT infra corre un agente que el control plane orquesta. Todos exigen `X-PBXNG-Token`
(`/etc/pbxng/agent.token`, chmod 600) salvo `/tts`/`/stt` de voz (abiertos para el pipeline).

| Agente | CT | Canal | Función |
|--------|----|----|---------|
| pbxng-ast | 103 | HTTP :8092 | /core (estado núcleo), /net (ifaces+rutas), /route (add/del persistidas) |
| pbxng-rec-agent | 103 | HTTP :8089 | registra grabaciones, sirve .wav, sube a NAS/S3, /vm |
| pbxng-f2b-agent | 103 | DB | Fail2Ban → pbxng_fail2ban + whitelist + comandos |
| pbxng-prompt-agent | 103 | DB | despliega audios del sistema (pbxng_sysprompts) reversible |
| pbxng-turn | 106 | HTTP :8091 | health/config/restart/test de Coturn |
| pbxng-sbc-agent | 107 | DB (cola) | vuelca kamcmd/tcpdump/net a pbxng_sbc; ejecuta comandos |
| voz.service | 108 | HTTP :8080 | el servicio ES el agente (FastAPI + /admin) |

**Pitfall agente Asterisk:** NO usar pipes dentro de `asterisk -rx 'cmd | head'` (Asterisk
los rechaza) → filtrar en Python. **Watchdog:** systemd timer (CT103+CT107) detecta cuelgues
por heartbeat (`updated_at` stale) y reinicia; drop-ins `Restart=always`. Ver `operations.md`.
