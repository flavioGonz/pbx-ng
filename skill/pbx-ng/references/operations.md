# PBX-NG — Operaciones

## Índice
1. [Convención Rutas vs Operadores](#rutas-vs-operadores)
2. [Watchdog de agentes](#watchdog)
3. [Seguridad (Fail2Ban)](#seguridad-fail2ban)
4. [Tokens de agentes y secretos](#tokens-y-secretos)
5. [Backups](#backups)
6. [Branding](#branding)
7. [Modularidad](#modularidad)
8. [Logs y depuración](#logs)
9. [Workflow de repo/deploy](#workflow-repo)

---

## Rutas vs Operadores

Dos capas del saliente, **no deben duplicar lógica**:

- **Capa 1 "Rutas salientes"** (Asterisk, tabla `pbxng_outbound_routes` → dialplan
  `[internal]`): decide el patrón de marcado y manda la llamada AL SBC. Real hoy:
  `_0.` → `Dial(PJSIP/${EXTEN:1}@to-sbc)`. El endpoint `POST /api/routes/outbound` **fuerza
  `@to-sbc`** sin importar la troncal elegida (guarda `trunk='to-sbc'`); la UI `/rutas`
  quitó el selector de troncal. strip/prepend solo para el prefijo de salida (ej. quitar el 0),
  NO para formato de carrier.
- **Capa 2 "Operadores"** (SBC, drouting/LCR): elige operador con failover + salud y normaliza
  al formato del carrier.

Las 2 troncales de proveedor sembradas (190.64.60.10/.17, `kind=kamailio`, `do_register=f`)
son DEMO (responden OPTIONS = alcanzable ≠ con servicio). La topología refleja **salud real**:
troncal `kind=kamailio` toma estado del OPTIONS keepalive (dispatcher set 2) → caída = nodo
rojo animado + "CAÍDO".

## Watchdog

Problema de raíz: un agente puede **colgarse** (proceso vivo, CPU alta, sin trabajar);
`Restart=on-failure` no lo reinicia (no crashea). Solución: watchdog por heartbeat.

- systemd timer `pbxng-watchdog.timer` (OnUnitActiveSec=60) → `pbxng-watchdog.service`
  (oneshot) → `/opt/pbxng-watchdog.sh`. Loguea a `/var/log/pbxng-watchdog.log`.
- **CT103** chequea: F2B (`pbxng_fail2ban.updated_at` fresco <90s, refresca cada 15s →
  restart pbxng-f2b-agent), ast-agent `:8092/core` 200, rec-agent `:8089/vm/list` 200.
  Drop-ins `Restart=always` para f2b y rec agents.
- **CT107** chequea: `pbxng_sbc.updated_at` fresco (<75s, sbc-agent cada 6s → restart
  pbxng-sbc-agent) + kamailio active → restart kamailio.
- Heartbeats útiles: `pbxng_fail2ban.updated_at` (15s), `pbxng_sbc.updated_at` (6s).
- Vive en los CTs, NO en el repo git. CT106/CT108 ya tienen `Restart=always` + HTTP.

## Seguridad (Fail2Ban)

CT103, 1 jail: **asterisk** (maxretry=5, findtime=600, bantime=3600), sobre
`/var/log/asterisk/security`. Panel `/seguridad`.

- Agente `/opt/pbxng-f2b-agent.py` (cada 15s): estado por jail, detalle por IP desde
  `/var/lib/fail2ban/fail2ban.sqlite3` tabla `bips`, config del jail, aplica whitelist
  (`addignoreip` + `unbanip` cada ciclo, sobrevive reinicios de Asterisk), procesa comandos
  (`ban`/`unban`/`wl_del`).
- Tablas: `pbxng_fail2ban` (+bans,+config jsonb), `pbxng_f2b_whitelist` (semilla 127.0.0.1 +
  **172.26.20.0/24**, evita auto-baneo del proxy/gateway LAN), `pbxng_fail2ban_cmd`.
- UI: banderas por **flagcdn** (no emoji), KPIs, política por jail + ban manual, whitelist
  CRUD, orígenes por país, tabla de bloqueadas (intentos, expira en, desbloquear). Geo por
  ip-api.com (batch, cache).
- **Limitación real:** el `dst-nat` + `masquerade` del MikroTik hacen que TODO el tráfico
  entrante al SBC aparezca como `172.26.20.1` (LAN confiable) → scanners externos se saltean
  pike/ban por IP. Fail2Ban solo mira Asterisk (CT103), no Kamailio (CT107). Fix correcto:
  restringir el `masquerade` general del MikroTik a `out-interface=<WAN>` (preservar IP real).
  Pendiente: jail sobre Kamailio o panel de amenazas SIP desde `pbxng_sip_capture`.

## Tokens y secretos

- **Agentes HTTP** exigen `X-PBXNG-Token` (`/etc/pbxng/agent.token`, chmod 600, en
  CT103/105/106/108). El control plane lo manda en astFwd/turnFwd/vozFwd y fetches a :8089.
  `/tts`/`/stt` de voz quedan abiertos (los usa el pipeline/Asterisk). **CT106 NO tiene curl**
  (testear desde CT105 hacia :8091).
- **Secretos hardcodeados** (fallbacks en app.js + agentes, en el repo GitHub) → rotar:
  `JWT_SECRET`, DB pass, ARI, AMI, VAPID privada (regenerar la filtrada), coturn CLI.
  Objetivo: fail-fast (sin literales) + `.env`.
- **Pendientes de seguridad** (medio/bajo): RBAC (`requireRole('admin')`; hoy todo user
  autenticado = admin), JWT en localStorage → cookie HttpOnly, SIP pass plaintext en
  localStorage → efímeros, TURN cred estática → efímeras, SSRF en fetch a URLs de settings,
  handler de error central (no filtrar internals), rate-limit al login, `trust proxy`+`req.ip`.
- **Modularidad recomendada:** `app.js` monolítico → split (config fail-fast, migrations
  versionadas, middleware/auth+errors, services/, routes/ por dominio con públicos explícitos).

## Backups

- **Base:** `pg_dump` de la DB pbxng. El schema-only + la DATA de la tabla `version` es lo
  que alimenta `docker/config/initdb/`. Para un backup real de datos: `pg_dump pbxng` completo.
- **Grabaciones:** en CT103 `/var/spool/asterisk/monitor/*.wav`; el rec-agent puede subirlas a
  NAS (shutil.copy) o S3/MinIO (boto3 con endpoint_url). `retain_local` controla si borra local.
- **Configs de Asterisk/Kamailio/Coturn:** versionadas en el repo (`infra/*` histórico,
  `docker/config/*` tokenizado). Los cambios en CT103/107 se pulsan al repo a mano.
- **Reversibilidad:** endpoints respaldados en `pbxng_ep_backup`; configs de kamailio con
  backups `.pre-<x>`; voz del sistema con `es-orig/` + marker `.bak`.

## Branding

Configuración → Branding (`BrandingPanel.jsx`). Settings `brand_name/brand_subtitle/
brand_tagline/brand_logo` (dataURL). `GET /api/branding` es **público** (lo necesita el login,
registrado antes del auth). Aplica a sidebar (logo+título), login (logo+nombre+tagline) y
`document.title`.

## Modularidad

Configuración → Módulos (`ModulesPanel.jsx`). Settings `mod_<id>` (sbc, turn, voz, ai,
clicktocall, push, autoprov; default '1'). `GET/POST /api/modules`. POST además controla el
**servicio** de infra: turn → agente `/service` (systemctl coturn), sbc → cola `svc_start/stop`
(systemctl kamailio); voz/ai/etc = solo UI-gate. Núcleo (Asterisk/DB/API) SIEMPRE activo.
Gating en sidebar (shell.jsx MOD_MAP) y en topología (SbcFlow oculta nodos+edges).

## Logs

- **Asterisk:** `/var/log/asterisk/full`, `security`; CLI `asterisk -rx '...'`.
- **Kamailio:** journal (`journalctl -u kamailio`); estado por `kamcmd`; SIP debug visual en
  `/sbc` (captura HEP en Asterisk + tcpdump en SBC → `pbxng_sip_capture`, ladder tipo Wireshark).
- **Pitfall de zona horaria:** host pve01 en UTC-3, journal de los CT en **UTC** (3h adelante).
  `journalctl --since "N seconds ago"` (relativo), no con hora del host.
- **483 Too Many Hops** = escáneres SIP de fraude / o loop de Kamailio; pegan en el SBC, no en
  Asterisk (Fail2Ban no los ve). Ver `gotchas.md`.

## Workflow repo

- Monorepo `github.com/flavioGonz/pbx-ng` (rama main). Código vivo en `/opt/pbxng-api` +
  `/opt/pbxng-dashboard`; repo espejo en `/opt/pbxng-repo` (CT105). Deploy key ed25519 en
  CT105 `/root/.ssh/pbxng_deploy`.
- **Al terminar CADA feature:** `pct exec 105 -- bash /opt/pbxng-repo/scripts/sync-and-push.sh
  "feat: ..."`. Re-sincroniza control-plane + dashboard, **sanea secretos conocidos** y ABORTA
  si detecta un secreto sin sanear (excluye `scripts/` del saneo). Los configs de
  `infra/asterisk/` no los re-sincroniza el script (viven en CT103, pulsar a mano).
- El clon del usuario `C:\Users\usuario\Claude\Projects\PBX-NG` se actualiza con `git pull`.
