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

## Apéndice · Provisionar las 2 VMs en Proxmox (automatizado)

El orquestador **`deploy/pbxng-proxmox.sh`** crea y aprovisiona las dos LXC de una,
corriendo **en un nodo Proxmox** (usa `pct`/`pvesh`/`pveam`). Elegí la forma **6) Dos VMs**:

```bash
# --- en el nodo Proxmox, como root ---
git clone https://github.com/flavioGonz/pbx-ng.git
bash pbx-ng/deploy/pbxng-proxmox.sh
#   Forma de despliegue -> 6) Dos VMs (núcleo LAN + borde SBC DMZ)
#   ¿DMZ con NIC separada? -> s  (te pide el bridge WAN + IP/gw del borde)
```

Qué hace la forma 6:
- Crea **`pbxng-core`** (perfiles `core intercom`; DB, Redis, Asterisk, API, Dashboard) en el bridge LAN.
- Crea **`pbxng-edge`** (perfiles `sbc turn proxy`; Kamailio + rtpengine + TURN + NPM). Si activás DMZ, le agrega una **segunda NIC** (`eth1`) hacia el bridge WAN/DMZ, dejando `eth0` en la LAN para hablar con el núcleo.
- Genera los **secretos una sola vez** y escribe el `.env` de cada CT con las IPs cruzadas (el borde apunta `DB_HOST`/`ASTERISK_HOST` al núcleo; el núcleo apunta `SBC_HOST`/`TURN_HOST`/`MEDIA_HOST` al borde).
- Instala Docker, clona el repo, levanta los perfiles de cada rol y deja `pbxng-ctl` + el reconciliador.
- Al final imprime la **nota de firewall** (qué abrir al WAN y qué restringir del núcleo al borde).

> Alternativa manual (sin Proxmox / otra virtualización): creá dos VMs vos mismo y usá el
> instalador por rol (sección "Instalación — 2 VMs") con `install.sh --role=core|edge` y el
> `edge-join.env`. El orquestador de arriba es el camino recomendado en Proxmox.
