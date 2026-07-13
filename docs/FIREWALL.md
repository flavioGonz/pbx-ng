# PBX-NG · Firewall y NAT (requisito de instalación)

Este documento es **parte de los requisitos de instalación**, no un anexo. Una PBX
puede registrar internos perfectamente y aun así dejar llamadas **sin audio** si el
NAT/firewall no está bien: la señalización (SIP/WSS) va por TCP y suele pasar sola,
pero el **audio (RTP)** viaja por UDP en rangos altos y es lo primero que se rompe.

Regla mental: **un puerto abierto de menos = una llamada muda.**

---

## 1. Matriz de puertos

### Qué se publica a Internet (WAN → PBX)

Solo estos. Nada más.

| Puerto | Proto | Servicio | Rol/VM | ¿Obligatorio? |
|---|---|---|---|---|
| `443` | TCP | HTTPS + **WSS** (softphone WebRTC) vía reverse proxy | proxy / core | **Sí** |
| `80` | TCP | HTTP (solo para el reto ACME de Let's Encrypt) | proxy | Sí si usás LE |
| `5060` | UDP/TCP | SIP hacia Kamailio (troncales SIP y teléfonos físicos remotos) | edge (`sbc`) | Sí si hay SIP clásico |
| `5061` | TCP | SIP TLS | edge (`sbc`) | Opcional |
| `3478` | **UDP y TCP** | STUN/TURN (coturn) | edge (`turn`) | **Sí para WebRTC tras NAT** |
| `5349` | TCP | TURNS (TURN sobre TLS) — redes corporativas que solo dejan salir 443/TLS | edge (`turn`) | Recomendado |
| `49152-65535` | UDP | **Rango relay del TURN** (el RTP que pasa por coturn) | edge (`turn`) | **Sí, junto con 3478** |
| `30000-40000` | UDP | RTP de rtpengine (medios de troncales SIP) | edge (`sbc`) | Sí si hay troncales SIP |
| `10000-20000` | UDP | RTP de Asterisk — **solo** si Asterisk habla directo al WAN (topología de 1 VM sin SBC) | core | Depende |

> **El error más común**: abrir `3478` y olvidar el rango `49152-65535/UDP`. El
> cliente obtiene el candidato relay (el Allocate funciona por 3478) pero después
> el audio no fluye, porque el RTP viaja por el puerto relay que el coturn asignó.
> Los dos van juntos, siempre.

> **Segundo error más común**: abrir `3478/UDP` y no `3478/TCP`. Muchas redes
> corporativas bloquean UDP saliente; en esas el navegador necesita `?transport=tcp`.

### Qué NO se publica nunca

| Puerto | Servicio | Quién debe alcanzarlo |
|---|---|---|
| `5432` | PostgreSQL | solo el core y (en 2 VMs) **la IP del edge** |
| `6379` | Redis | solo el core (no publica al host) |
| `3000` | API control-plane | solo el proxy |
| `3001` | Dashboard | solo el proxy |
| `5038` | Asterisk AMI | solo el core/edge |
| `8088` | Asterisk ARI/WS | solo el core/edge |
| `8091` / `8092` | Agentes internos (turn-agent, ast-agent) | solo la API, con token |
| `81` | Nginx Proxy Manager (admin) | solo LAN / VPN |

### Interno (LAN): core ↔ edge

En topología de 2 VMs, el edge (DMZ) necesita llegar al core:

| Desde | Hacia | Puerto |
|---|---|---|
| edge | core | `5432/TCP` (Postgres realtime) |
| edge | core | `5038/TCP` (AMI) |
| edge | core | `8088/TCP` (ARI/WS) |

El `install.sh --role=edge` valida esos tres antes de desplegar.

---

## 2. Reglas de NAT (dst-nat) — la lógica

Todo lo que se publica al WAN debe apuntar al contenedor correcto:

| Tráfico | → destino |
|---|---|
| `80,443/TCP` | IP del **reverse proxy** (NPM) |
| `5060,5061` + `30000-40000/UDP` | IP del **edge** (Kamailio + rtpengine) |
| `3478/UDP`, `3478/TCP`, `49152-65535/UDP` | IP del **edge** (coturn) |

Además el coturn necesita conocer su IP pública. En `.env`:

```
PUBLIC_IP=<IP_WAN>        # o el FQDN publicado
```

que se materializa en `turnserver.conf` como:

```
external-ip=<IP_WAN>/<IP_LAN_DEL_EDGE>
```

Ese formato `publica/privada` es **imprescindible** detrás de NAT: le dice al coturn
que anuncie la IP pública en los candidatos pero escuche en la privada. Si falta, el
cliente recibe un candidato relay con una IP interna, inalcanzable desde Internet.

---

## 3. NAT hairpin (loopback) — la trampa

Un cliente **dentro de la LAN** que resuelve el FQDN público obtiene la IP pública y
le pega a su propio router. Si el router no hace *hairpin*, ese paquete muere: no
llega al servidor, aunque el port-forward exista y funcione perfecto desde Internet.

Síntoma típico: **desde afuera todo anda; desde la oficina, el TURN da timeout o
"connection refused"** y el diagnóstico ICE del panel muestra `701 Failed to
establish connection`.

Hairpin necesita **dos** piezas, y casi siempre falta la primera:

1. Que la regla **dst-nat matchee tráfico que nace en la LAN** (no solo el que entra
   por la WAN).
2. Un **src-nat/masquerade** de vuelta, para que el servidor responda al router y no
   directo al cliente (o el cliente descarta la respuesta por venir de otra IP).

### Caso real (MikroTik): el `in-interface` que rompe el hairpin

```
chain=dstnat action=dst-nat to-addresses=192.168.99.17 protocol=udp
  dst-address-type=local in-interface=all-ppp dst-port=3478
```

`in-interface=all-ppp` hace que la regla **solo** matchee lo que entra por el PPPoE.
El paquete del navegador de la oficina entra por el bridge LAN → no matchea → el
router lo rechaza. Como ya está `dst-address-type=local` (que de por sí limita a las
IPs del propio router), la solución es simplemente **quitar el `in-interface`**:

```
/ip firewall nat set [find comment~"Coturn|TURN"] !in-interface
```

Y el src-nat de vuelta (regla "NAT Loopback"):

```
/ip firewall nat add chain=srcnat action=masquerade \
  src-address=192.168.99.0/24 dst-address=!192.168.99.1 comment="NAT Loopback"
```

Alternativa si no querés tocar las reglas existentes — agregar las espejo para LAN:

```
/ip firewall nat add chain=dstnat action=dst-nat protocol=udp dst-port=3478 \
  dst-address-type=local src-address=<LAN/24> dst-address=!<IP_ROUTER> \
  to-addresses=<IP_EDGE> comment="Coturn hairpin UDP"
/ip firewall nat add chain=dstnat action=dst-nat protocol=tcp dst-port=3478 \
  dst-address-type=local src-address=<LAN/24> dst-address=!<IP_ROUTER> \
  to-addresses=<IP_EDGE> comment="Coturn hairpin TCP"
/ip firewall nat add chain=dstnat action=dst-nat protocol=udp dst-port=49152-65535 \
  dst-address-type=local src-address=<LAN/24> dst-address=!<IP_ROUTER> \
  to-addresses=<IP_EDGE> comment="TURN relay hairpin"
```

> Ojo con el rango `49152-65535/UDP`: es amplio. Si el router escucha algo en un
> puerto alto (WireGuard, por ejemplo) y un cliente LAN lo alcanza por la IP pública,
> quedaría redirigido. Acotá el rango del coturn (`min-port`/`max-port`) si te molesta.

**¿Es obligatorio el hairpin?** No para llamar: los clientes internos tienen camino
directo y ICE ni va a usar el TURN. Sí para que el **diagnóstico** del panel sea
veraz desde la LAN, y para clientes en VPN o en redes internas segmentadas.

---

## 4. Verificación (no confíes en "el servicio está activo")

Que coturn esté `active` no dice nada: el port-forward puede estar mal, la IP externa
mal anunciada o la credencial no coincidir. Verificá lo que hace un navegador de verdad:

```bash
# Sonda real: STUN Binding + TURN Allocate (401 -> firmado -> 200 con relay)
scripts/check-turn.py --host pbx.cliente.com --user pbxng --pass '<TURN_PASS>' --tcp

# o tomando las credenciales del .env del deployment
scripts/check-turn.py --env docker/.env --tcp
```

Salida esperada:

```
  OK   [UDP] STUN responde · te ve como 200.1.2.3:55485
  OK   [UDP] Allocate -> 401 (esperado) · realm='pbx.cliente.com'
  OK   [UDP] ALLOCATE 200 · relay = 200.1.2.3:58942  ->  TURN OK (alcanzable + autenticado)
```

Si aparece un **candidato relay**, el TURN está alcanzable **y** autenticado — es
exactamente la condición que necesita un cliente WebRTC.

Lo mismo, gráfico y desde el navegador del usuario: **Panel → SBC → TURN →
"Diagnóstico ICE en vivo"**, y en el softphone de escritorio **Ajustes → Red**.
Ambos levantan una `RTCPeerConnection` real y muestran los candidatos que juntan.

---

## 5. Cómo leer los errores de ICE

| Código | Qué significa | Dónde mirar |
|---|---|---|
| **701** `Failed to establish connection` | El Allocate ni llegó: nada escuchando, puerto no redirigido, firewall, o **hairpin** si probás desde la LAN | port-forward `3478` UDP **y** TCP; `in-interface` de la regla dst-nat |
| **401 / 403** | El TURN contestó pero **rechazó las credenciales** | `TURN_USER`/`TURN_PASS` del `.env` vs `user=` del `turnserver.conf`; recordá que el API se las reparte a los clientes por `/api/ice` |
| **300** `Try Alternate` | Redirección del server | `alt-server` en coturn |
| Relay OK pero **audio mudo** | El Allocate funciona pero el RTP no vuelve | falta el rango relay `49152-65535/UDP`, o `external-ip` mal seteada |
| Sin candidatos **srflx** | El STUN no responde | `3478/UDP` bloqueado de salida en la red del cliente |

Recordá el orden de ICE: **host > srflx > relay**. El TURN es el último recurso —
solo entra cuando no hay camino directo (NAT simétrico en ambas puntas, firewall que
corta UDP, 4G restrictivo). Que coturn muestre **0 sesiones activas** con llamadas
internas andando es lo normal, no un síntoma.

---

## 6. Checklist de instalación

- [ ] `443/TCP` publicado al reverse proxy (WSS del softphone).
- [ ] `5060` (+`5061`) y `30000-40000/UDP` al edge, si hay troncales/teléfonos SIP.
- [ ] `3478/UDP` **y** `3478/TCP` al edge.
- [ ] `49152-65535/UDP` al edge (rango relay). **Sin esto no hay audio por TURN.**
- [ ] `PUBLIC_IP` correcta en `.env` → `external-ip=<publica>/<privada>` en coturn.
- [ ] `TURN_PASS` rotada (no `pbxng-turn-changeme`) y **la misma** en el `.env` del core y del edge.
- [ ] Postgres `5432` accesible **solo** desde la IP del edge.
- [ ] `scripts/check-turn.py` da **ALLOCATE 200 · relay = …** desde fuera de la LAN.
- [ ] (Opcional) Hairpin resuelto, para que el diagnóstico también dé verde desde adentro.
