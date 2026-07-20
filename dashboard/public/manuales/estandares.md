# Estándares y RFCs

Este documento lista los estándares (RFC del IETF y equivalentes) que **PBX-NG implementa**, con qué nivel de cumplimiento y **dónde está la configuración** que los sostiene. Sirve de referencia técnica para integradores, operadores y auditorías: cada fila se puede verificar en el archivo o el módulo que se indica.

PBX-NG es una central de comunicaciones unificadas construida sobre **Asterisk (pila SIP `chan_pjsip`)**, con endpoints en base de datos (realtime), medios RTP/SRTP/DTLS y WebRTC nativo. A diferencia del SBC, la central **sí termina** la señalización: actúa como agente de usuario, registrar y B2BUA, así que cumple los RFC de extremo (PRACK, UPDATE, REFER, suscripciones, buzón), no solo los de tránsito.

## Cómo leer el nivel

| Nivel | Qué significa |
|---|---|
| **Completo** | Implementado y disponible; es el comportamiento estándar de la central. |
| **Opcional** | Soportado; se activa por endpoint/troncal desde el panel (o por realtime). |
| **Parcial** | Soportado por la pila pero no configurado por defecto, o cubierto en parte. |

> **Núcleo cumplido al 100%.** En su configuración de fábrica, PBX-NG cumple de forma completa: **RFC 3261** (SIP UA/registrar/B2BUA), **RFC 3262** (PRACK/100rel), **RFC 3264** (oferta/respuesta SDP), **RFC 3311** (UPDATE), **RFC 3515** (REFER/transferencias), **RFC 6665** (SUBSCRIBE/NOTIFY), **RFC 3842** (MWI/buzón), **RFC 3550/3551** (RTP), **RFC 4733** (DTMF), **RFC 3711 + 4568** (SRTP-SDES), **RFC 5763/5764** (DTLS-SRTP/WebRTC), **RFC 7118** (SIP sobre WebSocket) y **RFC 4028** (Session Timers).

## Señalización SIP

| RFC | Título | Nivel | Dónde está |
|---|---|---|---|
| RFC 3261 | SIP: Session Initiation Protocol (UA, registrar, proxy/B2BUA) | Completo | `chan_pjsip` — `docker/config/asterisk/pjsip.conf` + endpoints realtime |
| RFC 3263 | Locating SIP Servers | Completo | Resolución de `chan_pjsip` (troncales salientes) |
| RFC 3262 | PRACK: respuestas provisionales fiables (100rel) | Completo | `100rel` por endpoint — esquema `pjsip_100rel_values` |
| RFC 3311 | UPDATE | Completo | `chan_pjsip` (re-negociación en diálogo) |
| RFC 3515 / 5589 | REFER / Call Control Transfer (transferencias) | Completo | `res_pjsip_refer` — usado por atención/ciega en el panel |
| RFC 3891 / 3892 | Replaces / Referred-By | Completo | `chan_pjsip` (transferencias asistidas) |
| RFC 3428 | MESSAGE (mensajería SIP) | Parcial | `res_pjsip_messaging` (disponible en la pila) |
| RFC 3581 | Extensión `rport` | Completo | `chan_pjsip` (`rewrite_contact`, respuesta simétrica) |
| RFC 5626 | Client-Initiated Connections (outbound/keepalive) | Parcial | `qualify`/keepalive por endpoint |
| RFC 5627 | GRUU | Parcial | Soportado por `chan_pjsip` (no activado por defecto) |

## Registro, presencia y buzón

| RFC | Título | Nivel | Dónde está |
|---|---|---|---|
| RFC 3261 §10 | Registrar / REGISTER | Completo | `chan_pjsip` (AOR realtime) — endpoints en la base |
| RFC 2617 / 7616 | Autenticación Digest | Completo | Credenciales por endpoint (auth realtime) |
| RFC 6665 (obsoleta 3265) | SUBSCRIBE/NOTIFY (eventos) | Completo | `res_pjsip_pubsub` (BLF, presencia) |
| RFC 4235 | dialog-info (estado de línea, BLF) | Completo | `res_pjsip_exten_state` |
| RFC 3842 | Message Waiting Indication (MWI, buzón) | Completo | `res_pjsip_mwi` + `app_voicemail` |
| RFC 3856 / 3863 | Presencia SIP (PIDF) | Parcial | `res_pjsip_pubsub` (presencia básica) |

## Medios (RTP / SRTP / WebRTC / códecs)

| RFC | Título | Nivel | Dónde está |
|---|---|---|---|
| RFC 3264 | Oferta/Respuesta con SDP | Completo | `chan_pjsip` (negociación de medios) |
| RFC 4566 | SDP | Completo | `chan_pjsip` / `res_pjsip_sdp_rtp` |
| RFC 3550 / 3551 | RTP y perfil de audio/video | Completo | `res_rtp_asterisk` — `docker/config/asterisk/rtp.conf` |
| RFC 4733 | Eventos DTMF (RFC 2833 fuera de banda) | Completo | `dtmf_mode=rfc4733` — esquema `pjsip_dtmf_mode_values` |
| RFC 3389 | Comfort Noise | Parcial | Soportado por `res_rtp_asterisk` |
| RFC 3711 / 4568 | SRTP con SDES (`a=crypto`) | Completo | `media_encryption=sdes` — esquema `pjsip_media_encryption_values` |
| RFC 5763 / 5764 | DTLS-SRTP (WebRTC) | Completo | `media_encryption=dtls` + `dtls_*` — `rtp.conf` / endpoint |
| RFC 8445 | ICE | Completo | `ice_support=yes` (endpoints WebRTC) |
| RFC 8825–8834 | WebRTC | Completo | `transport-ws` (`bind=0.0.0.0:8088`) — `pjsip.conf` |
| RFC 6716 | Opus | Opcional | `codec_opus` (si el códec está habilitado en el endpoint) |
| RFC 7587 | Payload RTP para Opus | Opcional | Junto con `codec_opus` |

> Los códecs **G.711 (µ-law/A-law)**, **G.722** y **GSM** son recomendaciones de la ITU-T, no RFC; PBX-NG los soporta de forma nativa vía `res_format_*`.

## Transporte y seguridad

| RFC | Título | Nivel | Dónde está |
|---|---|---|---|
| RFC 7118 | SIP sobre WebSocket | Completo | `transport-ws` (8088) — `pjsip.conf` + `http.conf` |
| RFC 3261 §26 / RFC 5630 | SIP sobre TLS (`sips`) | Completo | `transport-tls` (`bind=0.0.0.0:5061`, `method=tlsv1_2`) — `pjsip.conf` |
| RFC 5246 | TLS 1.2 | Completo | `method=tlsv1_2` en el transporte TLS |
| RFC 4028 | Session Timers | Completo | `timers` por endpoint (`chan_pjsip`) |

## Identidad (STIR/SHAKEN)

| RFC | Título | Nivel | Dónde está |
|---|---|---|---|
| RFC 8224 / 8225 / 8226 | Identidad autenticada (STIR/SHAKEN) | Parcial | `res_stir_shaken` disponible en Asterisk; la verificación/firma de borde se hace en **SBC-NG** (secsipid) delante de la central |

> **Nota de arquitectura.** En un despliegue con SBC-NG delante, la seguridad de borde (anti-flood, filtro por país, ocultamiento de topología, STIR/SHAKEN, interworking SRTP↔RTP) la resuelve el SBC, y la central se concentra en la lógica de comunicaciones (extensiones, colas, IVR, buzón, grabación). Ver el documento equivalente **"Estándares y RFCs"** del manual de SBC-NG. La versión exacta de Asterisk está en **Sistema → Acerca de**.
