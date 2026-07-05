# PBX-NG · Empaquetado y despliegue

Modelo único: **MÓDULO = PERFIL de compose = CONTENEDOR(es)**. Un contenedor
existe **solo si su módulo está activo**. El estado activo vive en
`docker/.env` → `COMPOSE_PROFILES`.

## Módulos

| Módulo | Perfil | Contenedor(es) | Función |
|---|---|---|---|
| core | `core` | postgres, redis, asterisk, api, dashboard | Núcleo (siempre) |
| sbc | `sbc` | kamailio, rtpengine, wsbridge | SBC / troncales WebRTC |
| turn | `turn` | coturn | TURN/STUN para WebRTC |
| ai | `ai` | voz | IVR con IA (TTS/STT) |
| intercom | `intercom` | go2rtc | Video RTSP (intercom/cámaras) |
| proxy | `proxy` | npm | Reverse proxy TLS/WSS (opcional) |

Las **grabaciones** son una función del `core` (no un contenedor): Asterisk
graba con MixMonitor en el volumen compartido `recordings`, y la API las lee/
reproduce/indexa directo (sin proceso extra).

## Formas de desplegar

1. **Single-VM** (todo en un host) → `docker/install.sh`
   - Elegís módulos → escribe `COMPOSE_PROFILES` en `.env` → `docker compose up -d`.
   - Instala `pbxng-ctl` + el reconciliador.
2. **Proxmox multi-LXC** → `deploy/pbxng-proxmox.sh`
   - Formas: compacto (1 CT) / standalone (2) / híbrido (3) / separado (1 por módulo) / custom.
   - Crea los LXC, instala Docker, clona el repo, escribe `.env` con `COMPOSE_PROFILES`
     por rol e instala `pbxng-ctl` + reconciliador en cada CT.
3. **All-in-one** (1 contenedor, demo) → `install.sh` opción 2.

## pbxng-ctl (módulos = contenedores)

```
pbxng-ctl status                 # perfiles activos + contenedores
pbxng-ctl enable  intercom       # agrega el perfil y CREA go2rtc
pbxng-ctl disable intercom       # DESTRUYE go2rtc y saca el perfil
pbxng-ctl up | down | ps
pbxng-ctl reconcile              # sincroniza contenedores <-> COMPOSE_PROFILES
```

## Activar/desactivar desde el panel

El dashboard (Módulos) escribe `pbxng_settings.mod_<id>` (1/0). El
**reconciliador** (`pbxng-reconciler.timer`, cada 20 s) lee esas claves y llama
a `pbxng-ctl enable/disable` para que el contenedor exista solo si el módulo
está activo. Módulos con contenedor: `sbc`, `turn`, `ai`, `intercom`.

> Requisito para el toggle de intercom en el panel: agregar `'intercom'` a
> `MODULE_IDS` en `control-plane/app.js` (hoy: sbc, turn, voz, clicktocall,
> push, autoprov, ai, wsbridge). El reconciliador ya mapea `mod_intercom`.

## Notas
- go2rtc se publica al navegador vía el reverse proxy en `/go2rtc/` (WS/MSE).
  Protegerlo con auth (ver revisión de código): hoy queda accesible.
- El `.env` no se versiona; los secretos se generan en la instalación.
