# SBC-NG y PBX-NG · dos productos, un contrato

**Estado:** propuesta aprobada · monorepo · base propia por producto · primero el corte, después las features
**Fecha:** 14 de julio de 2026

---

## 1. Por qué separarlos

El SBC ya es un producto: hace anti-fraude, bloqueo de IPs, gateway WebRTC, TURN y anclaje de
medios. Eso lo compra gente que **ya tiene central** —un 3CX, un FreePBX, un Issabel, un Asterisk
viejo, un Grandstream— y que no la va a cambiar. Hoy no podemos venderles nada, porque el SBC no
arranca sin la PBX.

Al revés también: hay instalaciones chicas que no necesitan borde (todo en LAN, sin teletrabajo) y
hoy igual les montamos un SBC porque el producto lo asume.

**Dos productos autónomos** cubren los dos mercados, y la suite completa sigue existiendo como la
instalación conjunta.

## 2. Dónde están pegados hoy (el diagnóstico honesto)

No están pegados por SIP —eso ya está limpio—: están pegados **por la base de datos**.

| Acople | Qué pasa hoy | Dónde |
|---|---|---|
| **Base compartida** | El agente del SBC se conecta con `psycopg2` a la Postgres de la PBX. | `infra/sbc/pbxng-sbc-agent.py` |
| **Tablas del SBC en la base de la PBX** | `dispatcher`, `secfilter`, `htable`, `location`. | schema de PBX-NG |
| **Bus de comandos por tabla** | La PBX le deja "recados" al SBC insertando filas en `pbxng_sbc_cmd`; el agente hace polling. | `pbxng_sbc_cmd` |
| **API del SBC dentro de la API de la PBX** | 27 endpoints `/api/sbc/*`. | `control-plane/app.js` |
| **Panel del SBC dentro del panel de la PBX** | `SbcConsole.jsx`, `SbcFlow.jsx`. | `dashboard/app/` |
| **rtpengine pide su config a la API de la PBX** | El loop del contenedor consulta `/api/sbc/rtpengine/effective` en el core. | imagen de kamailio |
| **Config renderizada por el instalador de la PBX** | `kamailio.cfg` con `@@PUBLIC_IP@@`, realm, dominio. | `docker/config/kamailio/` |

Mientras el acople siga siendo la base, **ninguno de los dos se puede versionar, licenciar ni
vender por separado**.

## 3. El contrato entre los dos productos

Sólo tres cosas. Todo lo demás es interno de cada producto.

| Plano | Qué viaja | Protocolo |
|---|---|---|
| **Señalización** | INVITE, REGISTER, OPTIONS, BYE… | SIP (RFC 3261) sobre UDP/TCP/TLS |
| **Medios** | Audio y video | RTP / SRTP (RFC 3550, 3711), anclados en rtpengine |
| **Gestión** | Alta de troncal, ruteo, seguridad, estado, métricas | **API norte** REST de SBC-NG, con token |

### 3.1 API norte de SBC-NG (borrador)

```
POST /api/v1/attach            # una central se registra como destino: {name, sip_uri, secret}
GET  /api/v1/status            # salud, versión, licencia, uptime
GET  /api/v1/metrics           # cps, llamadas activas, RTP pps, bloqueos
GET  /api/v1/trunks            # troncales con el operador
POST /api/v1/trunks            # alta/edición
POST /api/v1/trunks/:id/test   # OPTIONS + captura + diagnóstico
GET  /api/v1/routes            # LCR / dispatcher
GET  /api/v1/security/blocked  # IPs bloqueadas (con país e ISP)
POST /api/v1/security/unblock
GET  /api/v1/registrations     # quién está registrado a través del SBC
GET  /api/v1/capture/:callid   # diálogo SIP + pcap
```

PBX-NG pasa a ser **un cliente más** de esta API: la topología, el Resumen y el panel del SBC
consumen esto, no la base.

## 4. El corte, en cuatro fases

### Fase 1 · Independencia de datos (lo que desbloquea todo)

1. **Postgres propio de SBC-NG** (`sbcng`): mudar `dispatcher`, `secfilter`, `htable`, `location`,
   `pbxng_sbc_cmd` → `sbc_*`.
2. **Migraciones propias** del SBC (su `migrations/`, su `VERSION`).
3. El agente deja de hablar con la base de la PBX. Punto.

### Fase 2 · Control-plane propio

4. Servicio nuevo `sbc-ng/control-plane` (Node, mismo stack) con la **API norte** y su auth.
5. Mudar los 27 `/api/sbc/*` de la PBX a ese servicio. El agente pasa a ser parte del SBC (o
   desaparece: el control-plane habla directo con Kamailio por RPC y con rtpengine por ng).
6. **Muere `pbxng_sbc_cmd`**: los comandos son llamadas HTTP.
7. rtpengine toma su config del control-plane del SBC, no del de la PBX.

### Fase 3 · Panel propio e instalador propio

8. `SbcConsole` + `SbcFlow` salen del dashboard de la PBX → panel de SBC-NG (Next, mismo diseño).
9. En la suite, PBX-NG **embebe** el panel del SBC con SSO (o simplemente enlaza).
10. `sbc-ng/install.sh` + `docker-compose.yml` + imágenes + release propios.
11. PBX-NG aprende a vivir **sin** SBC (Asterisk directo o detrás de un SBC ajeno).

### Fase 4 · Lo que lo hace un SBC profesional

12. **Transcoding** en rtpengine (G.711 ↔ G.722 ↔ Opus ↔ G.729). Es lo que permite meter WebRTC
    contra operadores que sólo hablan G.729.
13. **Interworking SRTP ↔ RTP** y **DTMF** (RFC 4733 ↔ inband ↔ SIP INFO).
14. **Topology hiding** y normalización de cabeceras.
15. **CAC**: límite de llamadas simultáneas por troncal y por cliente.
16. **Multi-tenant**: varios clientes en el mismo SBC, cada uno con su realm, sus reglas y sus
    métricas. Es lo que lo hace vendible a un mayorista.
17. **HEP/Homer** para captura centralizada.
18. **Módulo de test de troncal**: OPTIONS + captura + semáforo por etapa + sugerencias.

## 5. Estructura del monorepo

```
/sbc-ng
  control-plane/        # API norte + lógica del SBC
  dashboard/            # panel propio
  docker/               # compose, imágenes (kamailio, rtpengine, coturn, wsbridge)
  migrations/
  install.sh
  VERSION · CHANGELOG.md
/pbx-ng
  control-plane/        # más liviano: ya no administra el SBC
  dashboard/
  docker/
  migrations/
  install.sh
  VERSION · CHANGELOG.md
/suite
  install.sh            # instala los dos y hace el attach solo
  docker-compose.yml
/docs
```

Cada producto versiona por su cuenta; la suite declara qué par de versiones certifica.

## 6. Riesgos y cómo los tapamos

| Riesgo | Mitigación |
|---|---|
| Romper Infratec (que está en producción) | El corte se hace en una instalación de laboratorio. Infratec migra recién con un `migrate` probado y con respaldo de las dos bases. |
| Dos bases = dos respaldos | El instalador de la suite arma el backup de las dos en un solo comando. |
| Duplicar código (auth, JWT, UI) | Un paquete `common/` compartido en el monorepo (auth, estilos, componentes). |
| El cliente que hoy tiene todo junto | Se sigue instalando junto. La separación es interna: el usuario final no se entera. |

## 7. Definiciones tomadas

- **Monorepo** con dos productos (se pueden separar después sin dolor).
- **Postgres propia por producto** (independencia total).
- **Primero el corte, después las features** (no construir sobre el acople).
