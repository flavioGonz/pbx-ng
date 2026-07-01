# PBX-NG — Gotchas / lecciones (síntoma → causa → fix)

La sección más valiosa. Cada entrada es un pozo real ya sufrido. **Leé esto antes de tocar
dialplan, kamailio.cfg, el orden de auth, o de desplegar.**

## Índice
1. [Docker / empaquetado / orquestador](#docker)
2. [Asterisk: dialplan y realtime](#asterisk-dialplan)
3. [Asterisk: NAT, registro, audio](#asterisk-nat)
4. [Kamailio / SBC](#kamailio)
5. [WebRTC / borde único](#webrtc)
6. [Deploy de código (mount/Edit/heredoc)](#deploy-codigo)
7. [Frontend / Next / Mantine](#frontend)
8. [NPM (Nginx Proxy Manager)](#npm)
9. [Voz IA](#voz)
10. [Varios](#varios)

---

## Docker

- **Docker dentro de LXC no arranca** → falta `nesting=1,keyctl=1`. Setear desde el host:
  `pct set <vmid> --features nesting=1,keyctl=1`.
- **Asterisk no descarga** → la URL está en subcarpeta `releases/`:
  `.../pub/telephony/asterisk/releases/asterisk-${VER}.tar.gz`.
- **Asterisk compila pero el runtime no arranca** (`libasteriskssl.so.1` not found) → el
  runtime slim debe copiar también **`/usr/lib/libasterisk*.so`** (además de binario,
  /usr/lib/asterisk, /var/lib/asterisk).
- **OOM al compilar** ("Error 2" matando pjproject) → compilar Asterisk con `make -j2` y
  **AISLADO** (no en paralelo con api+dashboard en 4GB). El orquestador ya lo hace.
- **Dashboard da 500 en todo `/backend/api/*`** → el rewrite usa la env equivocada. Usar
  **`API_URL`** (NO `BACKEND_URL`) en `next.config.js`.
- **Kamailio arranca pero secfilter/otros fallan** ("invalid version 0") → la tabla `version`
  quedó vacía (pg_dump schema-only no trae DATA). Sembrarla:
  `docker/config/initdb/02-seed-version.sql`.
- **Coturn en loop "Restarting (0)"** → el CMD lleva `-o` (daemoniza). Quitarlo.
- **rtpengine (imagen drachtio) falla** `Failed to init websocket listener` sobre iface IPv6
  link-local → PENDIENTE. La PBX funciona sin él para WebRTC en LAN (internos web registran
  directo a Asterisk ws :8088).
- **Orquestador Proxmox — python inline de descubrimiento** no debe usar comillas simples ni
  f-strings con comillas anidadas dentro de `python3 -c '...'`
  (`print(n["node"], free, n.get("maxcpu",0))`). Además: `clear` no-fatal sin TERM;
  `pct create` es local (sin `--node`, todo en el nodo donde corre); saltar VMIDs usados;
  validar storage; autodetectar plantilla.
- **git clone anónimo falla en repo privado** → pasar token en `PBXNG_REPO_URL` o repo público.
  `raw.githubusercontent` cachea ~5min → para la última versión usar la API de contenidos:
  `curl -H "Accept: application/vnd.github.raw" https://api.github.com/repos/OWNER/REPO/contents/PATH?ref=main`.

## Asterisk (dialplan)

- **DIDs / rutas entrantes nunca matchean** → había un catch-all estático `exten => _X.` en
  `[from-trunk]` que sombreaba el `switch => Realtime` (los extens estáticos se evalúan ANTES
  del switch). Fix: `[from-trunk]` solo `switch => Realtime` + handlers i/s.
- **Apps/IVR de 4 dígitos "no existen"** (queues 7001, RG 8001, conf 8500) → el patrón estático
  `_[1-9]XXX` en `[internal]` se evalúa antes del switch/includes y los tapa. Fix: hook prioridad
  2 `GotoIf(DIALPLAN_EXISTS(ivr,${EXTEN},1))` + migrar las apps al contexto `ivr` +
  `include => ivr` en `[from-trunk]`.
- **Audio se corta en WebRTC al reproducir prompts / feature codes** → falta `Answer()+Wait(1)`
  antes de `Playback`. Los feature codes deben ser ESTÁTICOS en `[internal]` (no realtime).
- **Prompts en inglés aunque defaultlanguage=es** → los ES estaban en
  `/usr/share/asterisk/sounds/es` pero `/var/lib/asterisk/sounds/es` estaba vacío. Fix:
  `ln -sfn /usr/share/asterisk/sounds/es /var/lib/asterisk/sounds/es`.

## Asterisk (NAT / registro / audio)

- **Corte al atender WebRTC↔SIP** (suena/atiende/se corta) → `direct_media=yes` (default) hace
  reINVITE a media directa, imposible entre DTLS(WebRTC) y RTP(SIP). Fix: `direct_media='no'`
  en TODOS los ps_endpoints (extensiones + troncales).
- **Audio one-way / qualify Unavailable en SIP** → endpoints transport-udp sin
  `rtp_symmetric/force_rport/rewrite_contact`. Fix: ponerlos en 'yes' (el tel debe re-registrar).
- **Interno remoto por el SBC recibe 404 al REGISTER** (`AOR '' not found for endpoint 'to-sbc'`)
  → el REGISTER llega desde la IP del SBC, y `to-sbc` (troncal) está identificado por IP; con
  `endpoint_identifier_order=ip,username` IP gana. Fix: `[global]
  endpoint_identifier_order=username,ip,anonymous` + `identify_by='username,ip'` en el endpoint.
- **⚠️ `endpoint_identifier_order` SOLO se aplica con `core restart`, NO con reload** — la cadena
  se ordena al cargar el módulo; `pjsip reload`/`module reload res_pjsip.so` no la reordena.
  Fix definitivo: `asterisk -rx 'core restart now'`. (Costó horas; el 404 persistía tras reload.)
- **Interno por VPN da 483 Too Many Hops apuntando al dominio público** → NAT loopback/hairpin
  mal armado o SIP ALG en el MikroTik (marcar la IP pública desde adentro rebota). Fixes:
  IP interna directa (172.26.20.183) en el teléfono, o split-DNS
  (`pbx.ies.com.uy → 172.26.20.183` para clientes VPN), o en el MikroTik desactivar SIP ALG
  (`/ip firewall service-port set sip disabled=yes`) + regla hairpin/masquerade para la subred VPN.
- **Interno remoto en internet directo (CGNAT)** — tres fixes encadenados en kamailio.cfg:
  (1) forzar `set_contact_alias()` en TODO REGISTER externo (sin alias el INVITE entrante no
  vuelve); (2) `record_route()` en la rama de alias (si no, el ACK del 2xx no trae Route);
  (3) descartar ACKs self-loop (`if (uri==myself) exit;`). Robustez futura: Path (RFC 3327).
- **El UVP viejo (fw 4.6) no permite TCP ni outbound-proxy** → solo UDP + esquema alias.

## Kamailio

- **Patrón de edición obligatorio:** backup `.pre-<x>` → `kamailio -c` (valida SINTAXIS,
  NO runtime/lógica) → `systemctl restart` (no reload) → `is-active` + journal → **probar
  registro + llamada real**. Muchos bugs (secfilter invertido, sst sin flag) pasan `-c` RC=0
  y hasta arrancan, pero rompen el servicio.
- **secfilter bloquea TODO lo legítimo y deja pasar scanners** → `secf_check_ua()`/`_ip()`
  devuelven POSITIVO cuando está PERMITIDO. Bloquear con `if (!secf_check_ua()) drop`, NO
  `if (secf_check_ua())`. `-c` no lo cata (es lógico); solo se ve probando registro/llamada.
- **sst falla en mod_init** (`no sst flag set!!`, restart `failed`, `-c` pasa RC=0) → falta
  `setflag(5)` en el INVITE inicial. Quedó `setflag(4); setflag(5); setflag(6); dlg_manage();`.
- **acc no carga** → `log_extra` con espacios; usar `;` (`"src=$fU;dst=$rU;srcip=$si"`).
- **drouting manda internos remotos a la PSTN** → falta el guard `!($ru =~ "alias=")` en la
  rama de saliente. drouting reescribe **$ru** (no $du) en este build. RPC solo `drouting.reload`.
- **483 Too Many Hops en loop** → INVITE a número inexistente con R-URI = IP del propio SBC se
  relaya a sí mismo. `myself` NO matchea 172.26.20.205 (escucha 0.0.0.0 sin alias). Lo que SÍ
  cortó: drop de INVITEs iniciales toll-fraud (`$rU =~ "^[0-9]{14,}$"` → 404 + exit) antes de
  relayar. (Probar el INVITE de test desde OTRO host, no desde el SBC.)
- **pike banea el gateway LAN (172.26.20.1)** → todo el tráfico NATeado llega con esa IP. Fix:
  eximir `src_ip == 172.26.20.0/24` del anti-flood.
- **488 al llamar al teléfono remoto** → la rama de alias forzaba `ICE=force RTP/SAVPF` a todos;
  un UA RTP/AVP plano da 488. Fix: WebRTC solo si el alias trae proto 5/6 (`$ru =~ "~5"`),
  si no rtpengine plano.
- **Crear tablas ANTES de cargar el módulo:** secfilter, drouting, uacreg necesitan su tabla
  + fila en `version` creadas antes del loadmodule o no arranca.
- **`${EXTEN:1}` se lo come bash** en `psql -c "..."` → escribir el SQL a archivo y `psql -f`.
- **Agente sbc-agent falla con la ñ del cfg** → conexión psycopg2 con `client_encoding='UTF8'`.
- **set_advertised_port no parsea** en este build (string error) → omitir (hereda del listen).
  `record_route()` normal NO respeta `set_advertised_address` → usar `record_route_advertised_address`.
- **uac self-register** — vigilar que ninguna fila de `uacreg` apunte el registrar a
  172.26.20.205 (el propio SBC), o generaría REGISTERs a sí mismo cada retry.

## WebRTC

- **Borde único: timbrar al WebRTC (servidor→navegador) falla** con NPM HTTP delante
  (`via_builder(): TCP/TLS connection for WebSocket could not be found`). No hay conexión WS
  1:1 estable que Kamailio reutilice para INICIAR pedidos. Registro y saliente sí funcionan.
  Para borde único real: NPM Stream L4 (TLS→TCP crudo a Kamailio:8088) o Kamailio termina WSS
  directo (:8089 + cert LE). Se **revirtió**: WebRTC directo browser→NPM→Asterisk.
- **Kamailio WS handshake `tcp_read: bad request` LEN 0** → falta `tcp_accept_no_cl=yes` (el GET
  de upgrade no trae Content-Length).
- **REGISTER self-loop en borde único** → `handle_ruri_alias()` corría en TODO request inicial;
  un REGISTER tiene R-URI = el propio SBC → se reescribía a 205 → loop. Fix:
  `if (!is_method("REGISTER") && handle_ruri_alias())`.
- **PWA iOS: indicador rojo mic/cám queda encendido tras colgar** → no se detenían los tracks de
  getUserMedia. Fix: `releaseMedia()` (track.stop() en senders/receivers + sdh.close()) en
  Terminated y hangup.
- **Interno WebRTC dormido "suena pero no atiende"** → el registro WS se cae en background; al
  Dial no hay contacto. Fix: wake&wait (CURL push wake → poll registro → Dial).
- **socket.io cae a polling tras el NPM** → usar transports polling primero; el proyecto corre
  polling-only por detrás del NPM (upgrade WS h2 no prospera estable).

## Deploy de código

- **⚠️ El mount bash `/sessions/.../mnt/` se DESINCRONIZA del editor.** `Write` sincroniza;
  `Edit` NO siempre se refleja del lado bash. Deployar (que lee vía el sandbox bash) sube una
  versión vieja/truncada → build `Unexpected eof`. **Regla:** tras editar, recrear el archivo
  con `cat > file <<'EOF'` o `Write` completo y verificar balance de llaves con `python3 -c`.
  Para `app.js`: regenerar SIEMPRE por heredoc o python str.replace sobre la copia desplegada,
  NUNCA con Edit del harness (trunca cerca de `const server=http...`).
- **No traer archivos grandes con `base64 -w0`** vía pve.run: stdout se trunca (~20KB+) →
  archivo cortado. Editar in-place en el CT, o verificar byte-count (`wc -c` remoto == local)
  antes de editar. El repo `/opt/pbxng-repo` es fuente de recuperación.

## Frontend

- **⚠️ Icono Tabler sin import → pantalla rota** (ReferenceError → React #418/#423). AGREGAR
  SIEMPRE el import de `@tabler/icons-react` al usar un `<IconX/>` nuevo (pasó 4+ veces). Los
  guards `if "IconX" not in s` fallan si el icono ya aparece como USO → chequear contra la
  línea de import, no todo el archivo. `IconVoicemail` NO existe (usar IconMail).
- **JSX/SWC rechaza `>` suelto** en children ("Unexpected token") → usar flechas unicode `→`/`↔`
  (o `&gt;`). En heredoc, `sed 's/->/\xE2\x86\x92/g'`.
- **Build en 2GB:** `NODE_OPTIONS=--max-old-space-size=1600`. Matar `next build`/`npm run build`
  viejos con kill -9 antes de rebuild (NO `pkill node`: mata la API).
- **`version.json` OTA:** re-estampar cada deploy con JSON válido `{"version":"<epoch>"}` por
  base64 (printf con escaping de shell rompe las comillas). Es asset estático (sin rebuild).
- **`e.map is not a function` / 401 en el primer fetch** → el patch de `window.fetch` (Bearer)
  debe correr a NIVEL MÓDULO, no solo en useEffect (los efectos hijos corren antes). Listas
  defensivas con `Array.isArray`.

## NPM

- **NO agregar `proxy_http_version 1.1` al advanced_config** de locations con
  `allow_websocket_upgrade` → NPM ya lo inyecta → "directive is duplicate" → nginx [emerg] →
  se cae TODO el proxy. Verificar `meta.nginx_online` tras cada PUT a proxy-hosts.
- **WS de socket.io se corta a ~60s** → location `/ws` y `/socket.io` necesitan
  `proxy_read_timeout 3600s` + upgrade headers (+ http_version 1.1 donde NO haya
  allow_websocket_upgrade).
- **sw.js "Failed to convert value to Response"** → `caches.match()` devolvía undefined a
  respondWith. Handler solo GET+same-origin, ignora upgrade/ws/socket.io/backend, y
  `.catch(async()=> (await caches.match(req)) || new Response('',{status:504}))`.

## Voz

- **Audio ~2x lento por AudioSocket** → AudioSocket reproduce el TX a 8kHz aunque el canal sea
  slin16 (16k). Fix: bajar TODO el pipeline a **8kHz/slin** (RATE=8000, FRAME_BYTES=320,
  externalMedia format:'slin'); /stt remuestrea 8k→16k para Whisper.
- **Cortes en el TX** → `setTimeout(19)` por frame deriva (underruns). Fix: planificador con
  corrección de deriva `wait = startT + idx*20 - Date.now()`.
- **WAV con header 0xFFFFFFFF (Asterisk reproduce mal)** → ffmpeg debe escribir a archivo .wav
  seekable, NO pipe `-f wav -`.
- **externalMedia: "Channel not found" / canal muere** → registrar la sesión en `pendingByUuid`
  ANTES de crear el externalMedia (Asterisk manda el frame UUID antes de que exista la sesión).
- **Audio entrante no llega** → Asterisk 22 manda frames tipo **0x12** (no solo 0x10) — aceptar ambos.
- **Transferencia IA se corta** → `continueInDialplan` dispara StasisEnd → endSession cuelga.
  Fix: `session.closed=true` ANTES de continueInDialplan (endSession early-return si closed).
- **STT lento / transcribe mal** → whisper `medium` es lento en CPU 4-core int8. Usar `small`
  (`/etc/voz.env VOZ_WHISPER=small` + restart voz).
- **Generación masiva de audios muere al timeout SSH** → lanzar con
  `setsid bash -c "... > log 2>&1" < /dev/null & disown` y consultar progreso por DB.

## Varios

- **Zona horaria del journal:** host UTC-3, CT en UTC (3h adelante) → `journalctl --since
  "N seconds ago"` relativo, no con hora del host.
- **483 = escáneres SIP de fraude** (From `'or''='@...`, destino largo) pegan en el SBC (CT107),
  NO en Asterisk → Fail2Ban (que mira CT103) no los ve; además llegan como 172.26.20.1 (whitelisted).
- **Email SMTP `534-5.7.9 Application-specific password required`** → Gmail/Workspace con 2FA
  necesita App Password (myaccount.google.com/apppasswords). NO es bug de código.
- **Máscara de settings:** el GET de `/api/settings` debe enmascarar
  `key|secret|token|pass|account|credential|p8|private` (para no filtrar el FCM service-account
  ni el .p8) → devuelve `'__SET__'`.
- **DELETE por body, no en path** para IPs/CIDR con `/` (whitelist), y para c2c cleanup evitar
  doble `c.release()`.
