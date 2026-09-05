# PBX-NG · Empaquetado y despliegue

Modelo único: **MÓDULO = PERFIL de compose = CONTENEDOR(es)**. Un contenedor
existe **solo si su módulo está activo**. El estado activo vive en
`docker/.env` → `COMPOSE_PROFILES`.

## Módulos

| Módulo | Perfil | Contenedor(es) | Función |
|---|---|---|---|
| core | `core` | postgres, asterisk, api, dashboard | Núcleo (siempre) |
| turn | `turn` | coturn | TURN/STUN para WebRTC |
| ai | `ai` | voz | IVR con IA (TTS/STT) |
| intercom | `intercom` | go2rtc | Video RTSP (intercom/cámaras) |
| proxy | `proxy` | npm | Reverse proxy TLS/WSS (opcional) |

Las **grabaciones** son una función del `core` (no un contenedor): Asterisk
graba con MixMonitor en el volumen compartido `recordings`, y la API las lee/
reproduce/indexa directo (sin proceso extra).

El módulo **`sbc` («Conexión a SBC-NG»)** es lógico, sin perfil ni contenedor:
solo administra la troncal `to-sbc` y las rutas hacia un
[SBC-NG](https://github.com/flavioGonz/SBC-NG) externo (otro producto, con su
propio empaquetado). Viene apagado por defecto; la migración 0007 lo enciende en
instalaciones que ya tenían `to-sbc`. Kamailio, rtpengine y wsbridge ya no se
empaquetan acá.

## Formas de desplegar

1. **Single-VM** (todo en un host) → `docker/install.sh`
   - Roles `all` (core+turn+ai+intercom, default) o `core` (solo núcleo; `--turn-ip=`
     si coturn vive en otro host). Escribe `COMPOSE_PROFILES` en `.env` →
     `docker compose up -d`.
   - Instala `pbxng-ctl` + el reconciliador.
2. **Proxmox multi-LXC** → `deploy/pbxng-proxmox.sh`
   - Formas: compacto (1 CT) / núcleo + acceso (2 CTs: LAN + TURN/proxy en DMZ,
     recomendado) / núcleo + voz / separado (core, turn, ai, intercom, proxy) / custom.
   - Crea los LXC, instala Docker, clona el repo, escribe `.env` con `COMPOSE_PROFILES`
     por rol e instala `pbxng-ctl` + reconciliador en cada CT.
3. **All-in-one** (1 contenedor, demo) → `install.sh` opción 2.

## Por dónde se entra al panel

- **Con el perfil `proxy` en el mismo compose** (`install.sh` con NPM, forma compacta de Proxmox):
  se entra por `https://<dominio>` (443, NPM → `http://dashboard:3001` por la red bridge). El
  instalador escribe `DASHBOARD_BIND=127.0.0.1`: `:3001` **no** queda accesible desde la LAN, así
  nadie puede saltear a NPM y falsificar la IP del rate limit del login con un `X-Forwarded-For`.
- **Sin proxy**: `http://<ip>:3001` directo (`DASHBOARD_BIND=0.0.0.0`); el panel arma él mismo el
  `X-Forwarded-For` con la IP del socket.
- **Con NPM en otro host/CT** (formas 2 y 4 de Proxmox, o un nginx externo): `DASHBOARD_BIND=0.0.0.0`
  + `DASHBOARD_TRUST_PROXY=1` (si no, la API vería la IP del proxy para todos los usuarios y el
  límite de 50 fallos/10 min por IP bloquearía a toda la empresa) y restringir `:3001` a la IP del
  proxy por firewall. `pbxng-proxmox.sh` lo escribe solo; con un proxy propio va a mano en `.env`.
- La API (`:3000`) y Postgres (`:5432`) escuchan sólo en `127.0.0.1` del host, en todas las formas.

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
está activo. Módulos con contenedor: `turn`, `ai`, `intercom`. El toggle de
`sbc` (Conexión a SBC-NG) no pasa por el reconciliador: solo habilita la página
Sistema → SBC-NG (conexión) y la API `/api/sbc-link`.

> Requisito para el toggle de intercom en el panel: agregar `'intercom'` a
> `MODULE_IDS` en `control-plane/app.js` (hoy: sbc, turn, voz, clicktocall,
> push, autoprov, ai). El reconciliador ya mapea `mod_intercom`.

## Notas
- go2rtc se publica al navegador vía el reverse proxy en `/go2rtc/` (WS/MSE).
  Protegerlo con auth (ver revisión de código): hoy queda accesible.
- El `.env` no se versiona; los secretos se generan en la instalación.
