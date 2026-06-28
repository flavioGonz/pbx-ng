# PBX-NG · Despliegue con Docker

Stack completo de la plataforma en contenedores, con instalador interactivo.

## Requisitos
- Docker Engine + plugin `docker compose`
- Para SIP/RTP/TURN: el host debe exponer los puertos (Asterisk/Kamailio/Coturn usan `network_mode: host`).

## Instalación rápida
```bash
cd docker
./install.sh
```
El script pregunta el modo (todo en uno / elegir servicios / solo núcleo), crea `.env` y levanta los contenedores.

## Servicios (perfiles)
| Perfil | Contenedores | Para qué |
|--------|--------------|----------|
| core   | postgres, redis, asterisk, api, dashboard | Núcleo PBX |
| sbc    | kamailio, rtpengine | Borde SIP (SBC) |
| media  | coturn | TURN/STUN WebRTC |
| ai     | voz | TTS/STT (IVR con IA) |
| proxy  | npm | Reverse proxy + TLS |

Separado o junto: cada perfil se puede levantar en hosts distintos (ajustando `.env` con las IPs) o todos juntos en un solo host.

## Manual
```bash
docker compose --profile core --profile sbc up -d --build   # núcleo + SBC
docker compose --profile ai up -d                            # solo IA de voz
docker compose ps
docker compose logs -f api
```

## Notas
- `images/asterisk`, `images/kamailio`, `images/voz` son contextos de build (Dockerfiles a completar según versiones).
- `config/` monta las configuraciones (asterisk, kamailio, coturn).
- Producción: cambiá `DB_PASS` y `JWT_SECRET`, y configurá el certificado en NPM.
