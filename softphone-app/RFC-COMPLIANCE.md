# PBX-NG Softphone — Auditoría de cumplimiento RFC (todo terreno)

**Versión auditada:** v0.3.1 · **Fecha:** 2026-07-10
**Alcance:** el softphone tiene **dos motores**:
- **WebRTC** (`src/useSip.js`, sobre **SIP.js 0.21.2**) — el camino "moderno".
- **SIP nativo** (`electron/sip-udp.cjs` + `electron/srtp.cjs`) — el camino "legacy/todo terreno" (solo en la app Windows/Electron).

Leyenda: ✅ completo · ⚠️ parcial · ❌ no implementado · N/A no aplica.

---

## 1. Señalización SIP

| RFC | Tema | WebRTC | SIP nativo | Notas |
|-----|------|:------:|:----------:|-------|
| **3261** | SIP core (REGISTER/INVITE/ACK/BYE/CANCEL, diálogos, transacciones) | ✅ | ✅ | Nativo maneja diálogo completo (localTag/remoteTag/remoteTarget/CSeq) capturado del 200 OK. |
| **3261 / 2617 / 7616** | Autenticación Digest (MD5, realm, nonce) | ✅ | ✅ | Nativo usa `sip/digest` (MD5). Falta SHA-256 (7616) — raro en centrales legacy. |
| **3581** | `rport` + `received` (NAT en la señalización) | ✅ | ✅ | Nativo aprende IP/puerto públicos por Via received/rport. |
| **7118** | SIP sobre WebSocket (WS/WSS) | ✅ | N/A | Base del modo WebRTC. |
| **3263** | Localización de servidores SIP (NAPTR/SRV) | ⚠️ | ✅ | **SRV agregado en nativo (v0.3.2, toggle)**: `_sip._transporte.dominio`. NAPTR aún no. |
| **3515** | REFER (transferencia) | ✅ | ✅ | Transfer ciega+atendida en WebRTC; **REFER ciega agregada en nativo (v0.3.2)**. |
| **3891 / 3892** | Replaces / Referred-By (transfer atendida robusta) | ⚠️ | ❌ | WebRTC vía SIP.js; nativo no. |
| **6665** | SUBSCRIBE/NOTIFY (presencia/BLF/MWI por SIP) | ❌ | ⚠️ | **MWI (message-summary) agregado en nativo (v0.3.2, toggle)**; BLF/presencia sigue por API. |
| **3311** | UPDATE | ⚠️ | ❌ | SIP.js lo soporta; nativo no. |

## 2. Medios — SDP, RTP, códecs

| RFC | Tema | WebRTC | SIP nativo | Notas |
|-----|------|:------:|:----------:|-------|
| **4566** | SDP | ✅ | ✅ | Nativo arma SDP a mano (audio, rtpmap, ptime). |
| **3264** | Offer/Answer | ✅ | ✅ | |
| **3550 / 3551** | RTP/RTCP + payloads estáticos | ✅ | ✅ | **RTCP Sender Reports agregados en nativo (v0.3.2)** en rtpPort+1 (excepto con SRTP). |
| **G.711 (PCMU/PCMA)** | Códecs base | ✅ | ✅ | Nativo negocia µ-law **y** A-law (encoders ITU propios). |
| **G.722 (7231/RFC3551 pt9)** | Banda ancha | ✅ (browser) | ❌ | Nativo: solo G.711. |
| **Opus (6716/7587)** | Códec moderno | ✅ (browser) | ❌ | Nativo: solo G.711. |
| **3556 / ptime** | Parámetros de medios | ✅ | ✅ | |

## 3. DTMF

| RFC | Tema | WebRTC | SIP nativo | Notas |
|-----|------|:------:|:----------:|-------|
| **4733 (ex 2833)** | DTMF como RTP telephone-event | ✅ | ✅ | Nativo declara `telephone-event/8000` payload **101** y envía eventos RFC4733. WebRTC vía `insertDTMF`. |
| **2976 / INFO** | DTMF por SIP INFO (fallback legacy) | ❌ | ✅ | **DTMF INFO agregado en nativo (v0.3.2)**: modo rfc4733/info/both en Ajustes. |
| **DTMF in-band** | Tonos en el propio audio | ✅* | ✅* | Se reproduce un tono local; el in-band real depende del códec. |

## 4. Seguridad de medios y transporte

| RFC | Tema | WebRTC | SIP nativo | Notas |
|-----|------|:------:|:----------:|-------|
| **3711** | SRTP (AES_CM_128_HMAC_SHA1_80, ROC) | ✅ (DTLS) | ✅ (SDES) | `electron/srtp.cjs`: KDF, AES-128-CTR, HMAC-SHA1-80, manejo de ROC. Round-trip verificado. |
| **4568** | SDES (llaves SRTP en el SDP, `a=crypto`, RTP/SAVP) | N/A | ✅ | Nativo: opción "SRTP · SDES". Recomendado con transporte **TLS**. |
| **5763 / 5764** | DTLS-SRTP | ✅ | ❌ | Obligatorio en WebRTC (lo hace Chromium). Nativo usa SDES, no DTLS. |
| **3261 (SIPS/TLS)** | Señalización cifrada | ✅ (WSS) | ✅ (TLS) | Nativo TLS + **validación de certificado configurable (v0.3.2)**. |
| **8879 / cert** | Validación de certificados | ⚠️ | ⚠️→✅ | Nativo: toggle **Validar certificado TLS (v0.3.2)**. El puente HTTP de la API del panel sigue tolerante (LAN). |

## 5. NAT / conectividad

| RFC | Tema | WebRTC | SIP nativo | Notas |
|-----|------|:------:|:----------:|-------|
| **8445 (ICE)** | ICE | ✅ | ❌ | WebRTC full (host/srflx/relay). Nativo usa RTP simétrico + rport en vez de ICE. |
| **5389 (STUN)** | STUN | ✅ | ❌ | |
| **5766 / 8656 (TURN)** | TURN (relay) | ✅ | ❌ | Con detección de "en uso" (candidate relay). Nativo no. |
| **RTP simétrico** | NAT de medios sin ICE | N/A | ✅ | Nativo aprende el origen del RTP entrante y responde ahí. |

## 6. Video

| Tema | WebRTC | SIP nativo | Notas |
|------|:------:|:----------:|-------|
| Videollamada (VP8/VP9/H264 por browser) | ✅ | ❌ | Video solo en modo WebRTC. Nativo es solo audio. |

---

## Resumen ejecutivo

**El softphone es efectivamente "todo terreno"** combinando los dos motores:
- **Moderno (WebRTC):** cumple de forma robusta lo esperado hoy — SIP sobre WSS, DTLS-SRTP, ICE/STUN/TURN, Opus/G.722, DTMF RFC4733, video, transferencia REFER, hold re-INVITE.
- **Legacy (SIP nativo UDP/TCP/TLS):** cubre el registro y las llamadas con G.711 (µ-law/A-law), DTMF RFC4733, SRTP-SDES y NAT por rport/RTP simétrico — suficiente para centrales tradicionales.

### Gaps priorizados (recomendaciones)
1. **RTCP en modo nativo (RFC 3550)** — hoy solo se envía RTP. Agregar RTCP sender/receiver reports mejora estadísticas de calidad y compatibilidad con equipos estrictos. *(medio)*
2. **DTMF por SIP INFO (fallback)** — para centrales muy viejas que no aceptan RFC4733. *(bajo–medio)*
3. **REFER en modo nativo (RFC 3515)** — habilitar transferencia en SIP nativo. *(medio)*
4. **G.722 / Opus en nativo** — banda ancha en el camino legacy. *(bajo, requiere encoders)*
5. **Validación de certificados TLS para producción pública** — hoy se aceptan self-signed. *(alto si sale de LAN)*
6. **SUBSCRIBE/NOTIFY (MWI/BLF por SIP)** — hoy va por la API del panel; agregar SIP nativo daría independencia del panel. *(bajo)*
7. **NAPTR/SRV (RFC 3263)** — descubrimiento automático de servidores. *(bajo)*

Ninguno de estos gaps impide operar; son mejoras de robustez/compatibilidad. Los estándares "core" (3261, 3264/4566, 3550/3551 G.711, 4733, 3711/4568 SRTP, WSS/TLS, ICE/STUN/TURN en WebRTC) **están cubiertos**.
