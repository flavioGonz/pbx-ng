# PBX-NG · Orquestador de despliegue en Proxmox

`pbxng-proxmox.sh` es un orquestador que **crea por sí mismo** todos los
contenedores LXC del stack en un cluster Proxmox VE y los deja corriendo. No
depende de un host concreto: se ejecuta en cualquier nodo quorate y reparte los
componentes por el cluster según los recursos libres.

## Qué hace

1. **Descubre** los nodos online del cluster y su RAM libre.
2. Pregunta la **forma de despliegue**:
   - **Compacto** — 1 contenedor con todo el stack (PBX simple / demo).
   - **Híbrido** — 3 contenedores: `núcleo` / `borde` / `voz` (recomendado).
   - **Separado** — 1 contenedor por componente (aislamiento máximo).
3. Pregunta el **modo de la aplicación**: PBX simple (single-tenant) o
   multi-tenant (SaaS). Se guarda como `TENANT_MODE` en el `.env` de cada CT.
4. Para cada componente, **recomienda el nodo** con más RAM libre y te deja
   elegir otro (ej: poner la voz IA en un nodo más potente).
5. **Crea** los CTs (Debian + Docker con `nesting=1`), **clona** el repo,
   escribe el `.env` (inyectando la IP del núcleo en los servicios que viven en
   otro contenedor) y levanta los **perfiles** de `docker-compose` de cada rol.
6. **Verifica** y guarda el plan en `/etc/pbxng-deploy.plan`.

## Uso

```bash
# En un nodo Proxmox VE 8/9, como root:
curl -fsSLO https://raw.githubusercontent.com/flavioGonz/pbx-ng/main/deploy/pbxng-proxmox.sh
chmod +x pbxng-proxmox.sh
./pbxng-proxmox.sh
```

Es interactivo; los valores por defecto (entre corchetes) son los recomendados.

### Variables opcionales

| Variable | Default | Uso |
|---|---|---|
| `PBXNG_REPO_URL` | `https://github.com/flavioGonz/pbx-ng.git` | Repo a clonar en cada CT |
| `PBXNG_REPO_BRANCH` | `main` | Rama |

## Mapa de roles → perfiles

| Forma | Contenedores | Perfiles docker-compose por CT |
|---|---|---|
| Compacto | `pbxng-all` | `core sbc media ai proxy` |
| Híbrido | `pbxng-core`, `pbxng-edge`, `pbxng-ai` | `core` / `sbc media proxy` / `ai` |
| Separado | `pbxng-core`, `pbxng-sbc`, `pbxng-media`, `pbxng-ai`, `pbxng-proxy` | uno por perfil |

El **núcleo se crea primero** para conocer su IP; los demás CTs la reciben en su
`.env` (`DB_HOST`, `ARI_URL`, `AMI_HOST`, `ASTERISK_HOST`, `REDIS_HOST`) porque
`docker-compose` publica esos puertos en el host del CT.

## Requisitos

- Proxmox VE 8 o 9 (comandos `pct`, `pvesh`, `pveam`), corriendo como root.
- Plantilla LXC Debian 12 disponible en el nodo destino (`pveam download` si falta).
- Red por **DHCP** (default) o estática (asigna IPs secuenciales `/24`).
- Salida a internet en los CTs para instalar Docker y clonar el repo.

## Notas

- **Idempotencia**: el plan queda en `/etc/pbxng-deploy.plan`. Volver a correr el
  script crea CTs nuevos (usa `pvesh get /cluster/nextid`); borrá los anteriores
  con `pct destroy <id>` si querés rehacer.
- **Secretos**: se generan aleatorios (DB/JWT/ARI/AMI) y se comparten entre los
  CTs para que los servicios se entiendan. No se versionan.
- **Producción**: publicá el dominio con TLS/WSS desde el proxy inverso y abrí
  los puertos SIP/RTP/TURN en el firewall/NAT. Rotá los secretos.
