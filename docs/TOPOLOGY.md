# PBX-NG · Topologías de despliegue e instalación por rol

PBX-NG se empaqueta por **módulos = perfiles de compose = contenedores**. Un mismo
paquete se instala con distintos **roles** según la topología del cliente.

El borde SIP (Kamailio + rtpengine, seguridad perimetral, LCR, troncales del operador)
**no forma parte de PBX-NG**: es [SBC-NG](https://github.com/flavioGonz/SBC-NG), otro
producto. PBX-NG funciona completo sin él; si se lo pone adelante, se conecta desde el
módulo «Conexión a SBC-NG» del panel (Sistema → SBC-NG (conexión)).

## Roles

| Rol    | Zona | Contenedores (perfiles)                                            | Expone a Internet |
|--------|------|--------------------------------------------------------------------|-------------------|
| `all`  | —    | `core,turn,ai,intercom` (+`proxy` opcional). Default.              | según proxy       |
| `core` | LAN  | `core` = Postgres, Asterisk, API, Dashboard (+ai,intercom)         | No                |

`core` es para cuando el TURN (y, si se quiere, el proxy) viven en otro host: se le pasa
`--turn-ip=<IP_DEL_TURN>` y la central reparte esas credenciales ICE a los clientes. No
existe un rol de borde: cada host de PBX-NG tiene **su propia base y sus propios
secretos**, y no se comparte nada con un SBC-NG.

## Topología recomendada (2 CTs: núcleo + acceso)

```
   Internet
      │  443(WSS) 3478/5349(TURN) 49152-65535/UDP
      ▼
 ┌─────────────┐   pata WAN (DMZ)
 │   ACCESO    │  coturn (TURN/STUN) · Nginx Proxy Manager (TLS, /ws → Asterisk :8088)
 │  (DMZ)      │
 └─────┬───────┘   pata LAN
       │  443/WSS proxeado a Dashboard/API/Asterisk WS
       ▼
 ┌─────────────┐          ┌──────────────────────────────┐
 │   NÚCLEO    │◄─ SIP ──►│  SBC-NG (opcional, aparte)   │ → operador
 │  (LAN)      │  + RTP   │  troncal to-sbc, LAN only    │
 └─────────────┘          └──────────────────────────────┘
   Asterisk · API · Dashboard · Postgres (+voz, go2rtc)
```

- **WebRTC sin SBC**: el softphone entra por WSS `https://dominio/ws`; el proxy reenvía
  `/ws` a Asterisk `:8088`, ICE usa STUN + el TURN propio (coturn) y DTLS-SRTP lo
  termina Asterisk.
- **Troncales del operador y teléfonos remotos** hablan directo con Asterisk
  (5060/5061 + RTP 10000-20000) **o**, si hay SBC-NG, entran por él y llegan al núcleo
  por la troncal `to-sbc` en la LAN. En ese caso Asterisk no se expone al WAN.
- El proxy puede ir en el CT de acceso, en el núcleo (`all`) o en una VM aparte.

## Instalación — 1 host (SOHO / demo o núcleo completo)
```bash
cd /opt/pbx-ng/docker
./install.sh --role=all      # o simplemente ./install.sh y elegí "all"
```
Levanta `core,turn,ai,intercom` (más `proxy` si lo elegís), genera secretos e instala
`pbxng-ctl` + el reconciliador.

## Instalación — núcleo con TURN en otro host

Requisitos: Docker + plugin `docker compose`, y el repo en `/opt/pbx-ng`.

### 1) TURN / proxy (en la DMZ)
Cualquier host con coturn sirve; con el instalador:
```bash
cd /opt/pbx-ng/docker
./install.sh --profiles=turn,proxy --public-ip=<IP_WAN> --domain=pbx.cliente.com
```

### 2) NÚCLEO (en la LAN)
```bash
cd /opt/pbx-ng/docker
./install.sh --role=core \
  --public-ip=<IP_WAN> --domain=pbx.cliente.com \
  --turn-ip=<IP_LAN_DEL_TURN>
```
`--turn-ip` deja `TURN_HOST` apuntando al coturn externo; `TURN_PASS` tiene que ser la
misma en los dos `.env`.

### Modo interactivo
`./install.sh` sin flags pregunta el rol y el resto. Flags para automatización:
`--role=`, `--profiles=`, `--turn-ip=`, `--public-ip=`, `--domain=`, `--tenant=`,
`--release`, `--yes`, `--print-firewall`.

## Conectar un SBC-NG (opcional)

Con el SBC-NG ya instalado (ver su documentación), en el panel de PBX-NG:
Configuración → Módulos → encender **«Conexión a SBC-NG»**, y en Sistema → **SBC-NG
(conexión)** cargar IP/host, puerto, transporte (UDP/TCP/TLS), contexto, códecs y la URL
del panel del SBC. Al guardar se crea/actualiza la troncal fija `to-sbc` (endpoint pjsip
identificado por IP) y, si no había rutas salientes, la ruta «0 + número → SBC-NG».
«Desconectar» borra la troncal y las rutas que salían por ella. Por API:
`GET/POST/DELETE /api/sbc-link`.

Con el módulo encendido el SBC-NG aparece en la topología como nodo externo con estado
medido (puerto SIP) y las rutas salientes nuevas salen por él; apagado, la central no
menciona ningún borde. En instalaciones que ya tenían la troncal `to-sbc`, la migración
0007 lo deja encendido.

## Firewall (imprescindible en más de un host)

**Acceso → Internet (entrante):** 443 (+80 ACME) al proxy; 3478 UDP+TCP, 5349 y
49152-65535/UDP al TURN. Nada más.

**Núcleo → Internet (entrante):** solo si no hay SBC-NG y hay troncales del operador o
teléfonos remotos: 5060/5061 y 10000-20000/UDP a Asterisk. Si hay SBC-NG adelante, el
SIP/RTP público se expone en el SBC-NG y el núcleo no publica nada.

**SBC-NG → Núcleo (LAN):** permitir desde la IP del SBC-NG hacia Asterisk `5060` y el
rango RTP `10000-20000/UDP`. Postgres, AMI y ARI **no** se comparten: cada producto tiene
su base.

**Núcleo:** Postgres 5432, AMI 5038 y ARI 8088 solo locales al host (o al proxy, para
`/ws`). Detalle en `FIREWALL.md`.

## Actualización

Con el sistema de release (ver `RELEASE.md`): en cada host, `docker/deploy.sh` hace
`pull`/`load` de las imágenes versionadas + migraciones + `up -d`. Nunca `docker cp`.
El SBC-NG se actualiza por su cuenta, con su propio release.

## Escalado / HA

Con SBC-NG adelante, su *dispatcher* puede balancear hacia **varios Asterisk core**.
Objetivo: 1 SBC-NG (o par HA con VIP) + N núcleos; el SBC-NG queda como única cara
pública para SIP. El acceso WebRTC (TURN + proxy) escala aparte.

## Apéndice · Provisionar en Proxmox (automatizado)

El orquestador **`deploy/pbxng-proxmox.sh`** crea y aprovisiona los LXC de una, corriendo
**en un nodo Proxmox** (usa `pct`/`pvesh`/`pveam`). Formas de despliegue:

1. **Compacto**: 1 CT con todo (`all`).
2. **Núcleo + acceso** (recomendado): 2 CTs. `pbxng-core` en la LAN (`core,ai,intercom`)
   y `pbxng-access` en la DMZ (`turn,proxy`), con doble NIC opcional.
3. **Núcleo + voz**: 2 CTs, el servicio de voz IA separado.
4. **Separado**: un CT por módulo (core, turn, ai, intercom, proxy).
5. **Personalizado**: elegís qué va en cada CT.

```bash
# --- en el nodo Proxmox, como root ---
git clone https://github.com/flavioGonz/pbx-ng.git
bash pbx-ng/deploy/pbxng-proxmox.sh
#   Forma de despliegue -> 2) Núcleo + acceso
#   ¿DMZ con NIC separada? -> s  (te pide el bridge WAN + IP/gw del CT de acceso)
```

Qué hace la forma 2:
- Crea **`pbxng-core`** (DB, Asterisk, API, Dashboard, voz, go2rtc) en el bridge LAN. Como el
  proxy vive en el otro CT, su `.env` lleva `DASHBOARD_BIND=0.0.0.0` y `DASHBOARD_TRUST_PROXY=1`
  (el panel confía en el `X-Forwarded-For` de NPM); conviene restringir `:3001` a la IP del CT de acceso.
- Crea **`pbxng-access`** (coturn + NPM). Si activás DMZ, le agrega una **segunda NIC**
  (`eth1`) hacia el bridge WAN/DMZ, dejando `eth0` en la LAN para hablar con el núcleo.
- Escribe el `.env` de cada CT con las IPs cruzadas (el núcleo apunta `TURN_HOST` al
  acceso; el proxy apunta al dashboard/API/Asterisk WS del núcleo). Cada CT tiene sus
  secretos; solo `TURN_PASS` se repite en los dos.
- Instala Docker, clona el repo, levanta los perfiles de cada rol y deja `pbxng-ctl` + el reconciliador.
- Al final imprime la **nota de firewall** (qué abrir al WAN y qué permitir entre CTs).

> Alternativa manual (sin Proxmox / otra virtualización): creá los hosts vos mismo y usá
> el instalador (`install.sh --role=core --turn-ip=…` en el núcleo, `--profiles=turn,proxy`
> en el acceso). El orquestador de arriba es el camino recomendado en Proxmox. El SBC-NG,
> si lo hay, se despliega con su propio instalador.
