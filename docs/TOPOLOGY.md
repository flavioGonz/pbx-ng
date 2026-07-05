# PBX-NG · Topologías de despliegue e instalación por rol

PBX-NG se empaqueta por **módulos = perfiles de compose = contenedores**. Un mismo
paquete se instala con distintos **roles** según la topología del cliente.

## Roles

| Rol    | Zona | Contenedores (perfiles)                                   | Expone a Internet |
|--------|------|-----------------------------------------------------------|-------------------|
| `all`  | —    | core (+sbc,turn,ai,intercom,proxy opcionales)             | según proxy       |
| `core` | LAN  | `core` = Postgres, Redis, Asterisk, API, Dashboard (+ai,intercom) | No           |
| `edge` | DMZ  | `sbc` = Kamailio, rtpengine, wsbridge · `turn` = coturn   | Sí (SIP/TURN/WSS) |

`core` y `edge` comparten **una sola base de datos y las credenciales de Asterisk**:
el `core` los genera y el `edge` los recibe vía `edge-join.env`.

## Topología recomendada (2 VMs)

```
   Internet
      │  443(WSS) 5060(SIP) 3478(TURN)
      ▼
 ┌─────────────┐   pata WAN (DMZ)
 │   EDGE      │  Kamailio · rtpengine · wsbridge · coturn
 │  (DMZ)      │
 └─────┬───────┘   pata LAN
       │  SIP 5060 · RTP · DB 5432 · AMI 5038 · ARI 8088   (solo desde el edge)
       ▼
 ┌─────────────┐
 │   CORE      │  Asterisk · API · Dashboard · Postgres · Redis
 │  (LAN)      │  (sin IP pública)
 └─────────────┘
```

- **Asterisk nunca se expone a Internet.** El edge (SBC) es la única cara pública.
- **rtpengine ancla el media** en el borde: el RTP no llega directo a Asterisk.
- Reverse proxy (TLS/WSS) en el edge o en una VM aparte; publica 443 → dashboard/API/`/ws`.

## Instalación — 2 VMs

Requisitos en cada VM: Docker + plugin `docker compose`, y el repo en `/opt/pbx-ng`.

### 1) CORE (primero, en la LAN)
```bash
cd /opt/pbx-ng/docker
./install.sh --role=core \
  --public-ip=<IP_WAN> --domain=pbx.cliente.com \
  --edge-ip=<IP_LAN_DEL_EDGE>          # opcional; se puede setear después
```
Genera secretos, levanta el core y escribe **`edge-join.env`** (permisos 600) con la
IP del core + credenciales compartidas.

### 2) Copiar el join al EDGE
```bash
scp /opt/pbx-ng/docker/edge-join.env root@<IP_EDGE>:/opt/pbx-ng/docker/
```

### 3) EDGE (en la DMZ)
```bash
cd /opt/pbx-ng/docker
./install.sh --role=edge --join=edge-join.env --public-ip=<IP_WAN>
```
Valida que llega al core (5432/5038/8088), configura `sbc,turn` apuntando al core y levanta.

### Modo interactivo
`./install.sh` sin flags pregunta el rol y el resto. Los flags son para automatización.

## Instalación — 1 VM (SOHO / demo)
```bash
cd /opt/pbx-ng/docker
./install.sh --role=all      # o simplemente ./install.sh y elegí "all"
```

## Firewall (imprescindible en 2 VMs)

**Edge → Internet (entrante):** 5060/5061 (SIP), 3478 + rango relay TURN, 443 (WSS vía proxy). Nada más.

**Edge → Core (LAN):** permitir solo desde la IP del edge hacia el core:
`5432` (Postgres), `5038` (AMI), `8088` (ARI), `5060` (SIP interno) y el rango RTP.

**Core:** sin puertos al WAN. Postgres 5432 **solo** accesible desde el edge (regla por IP).

> Nota de seguridad: la DB del core queda alcanzable desde la DMZ. Restringila por IP
> y usá una contraseña fuerte (el instalador la genera). Endurecer con usuario de DB de
> menor privilegio para Kamailio es una mejora recomendada.

## Actualización

Con el sistema de release (ver `RELEASE.md`): en cada VM, `docker/deploy.sh` hace
`pull`/`load` de las imágenes versionadas + migraciones + `up -d`. Nunca `docker cp`.

## Escalado / HA

Kamailio (edge) con *dispatcher* puede balancear hacia **varios Asterisk core**.
Objetivo: 1 edge (o par HA con VIP) + N cores. El edge sigue siendo la única cara pública.

## Apéndice · Provisionar las 2 VMs en Proxmox

Dos LXC (Debian/Ubuntu) con Docker. Idea de red: **dos bridges** — uno LAN (interno) y
uno DMZ/WAN. El `core` va solo en el bridge LAN; el `edge` es **doble NIC** (DMZ + LAN).

```bash
# --- en el nodo Proxmox ---
# CORE (solo LAN)
pct create 210 <template> --hostname pbxng-core \
  --net0 name=eth0,bridge=vmbr-lan,ip=10.0.0.10/24,gw=10.0.0.1 \
  --cores 4 --memory 4096 --rootfs local-lvm:20 --features nesting=1 --unprivileged 1 --onboot 1
# EDGE (DMZ + LAN)
pct create 211 <template> --hostname pbxng-edge \
  --net0 name=eth0,bridge=vmbr-dmz,ip=<IP_WAN>/24,gw=<GW_WAN> \
  --net1 name=eth1,bridge=vmbr-lan,ip=10.0.0.20/24 \
  --cores 2 --memory 2048 --rootfs local-lvm:12 --features nesting=1 --unprivileged 1 --onboot 1
pct start 210; pct start 211
```

En cada CT: instalar Docker + `docker compose`, `git clone` del repo en `/opt/pbx-ng`, y
correr el instalador por rol (sección "Instalación — 2 VMs"). El `edge-join.env` se copia
del core al edge con `pct push`/`scp`.

> El orquestador `deploy/pbxng-proxmox.sh` automatiza el descubrimiento del cluster y la
> creación de CTs. La automatización end-to-end de esta topología de 2 VMs (core+edge con
> doble NIC y el join) usando ese orquestador es el siguiente paso planificado; hoy los CTs
> se crean con los comandos de arriba y el alta se completa con `install.sh --role=…`.
