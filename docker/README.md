# PBX-NG · Despliegue con Docker

El instalador interactivo te pregunta la **topología** y levanta el stack.

```bash
cd docker
./install.sh
```

## Topologías

1. **Un contenedor por servicio** (recomendado, producción)
   Usa `docker-compose.yml` con perfiles: `core` (DB/Asterisk/API/Dashboard), `turn` (Coturn), `ai` (Voz), `intercom` (go2rtc), `proxy` (Nginx Proxy Manager). Cada servicio aislado y escalable. `docker-compose.release.yml` es su espejo por imagen (sin `build:`).

2. **Todo en un contenedor** (experimental, demos)
   `Dockerfile.allinone` corre todo el stack con supervisord en un único contenedor. Rápido para probar; no recomendado en producción.

3. **Bare-metal / LXC** (sin Docker)
   Instalación nativa por componente (ver `docs/`).

## Perfiles (compose)

```bash
docker compose --profile core --profile turn up -d --build
```

## Configuración

`.env` se genera automáticamente con secretos aleatorios (o copiá `.env.example`). Las claves de OpenAI/FCM/APNs/SMTP se cargan cifradas desde el panel, no en `.env`.

## URLs

- Dashboard: `http://localhost:3001`
- API: `http://127.0.0.1:3000` (solo loopback del host; el panel la consume por `/backend`)
- Nginx Proxy Manager: `http://localhost:81` (admin@example.com / changeme)
