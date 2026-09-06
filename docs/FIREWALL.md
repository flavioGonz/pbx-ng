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
| `443` | TCP | HTTPS + **WSS** (softphone WebRTC) vía reverse proxy; el proxy reenvía `/ws` a Asterisk `:8088` | proxy / core | **Sí** |
| `80` | TCP | HTTP (solo para el reto ACME de Let's Encrypt) | proxy | Sí si usás LE |
| `3478` | **UDP y TCP** | STUN/TURN (coturn) | `turn` | **Sí para WebRTC tras NAT** |
| `5349` | TCP | TURNS (TURN sobre TLS) — redes corporativas que solo dejan salir 443/TLS | `turn` | Recomendado |
| `49152-65535` | UDP | **Rango relay del TURN** (el RTP que pasa por coturn) | `turn` | **Sí, junto con 3478** |
| `5060` | UDP/TCP | SIP de Asterisk — **solo** si hay troncales del operador o teléfonos remotos hablando directo con la central | core | Sí si hay SIP directo |
| `5061` | TCP | SIP TLS de Asterisk (mismo caso) | core | Opcional |
| `10000-20000` | UDP | RTP de Asterisk — va junto con 5060/5061, mismo caso | core | Sí si hay SIP directo |

> **Con SBC-NG adelante** (otro producto), el SIP/RTP público se expone en el SBC-NG
> (ver su documentación) y la central **no publica** 5060/5061 ni 10000-20000: solo
> necesita LAN hacia él. WebRTC (443 + TURN) sigue siendo cosa de PBX-NG en los dos casos.

> **El error más común**: abrir `3478` y olvidar el rango `49152-65535/UDP`. El
> cliente obtiene el candidato relay (el Allocate funciona por 3478) pero después
> el audio no fluye, porque el RTP viaja por el puerto relay que el coturn asignó.
> Los dos van juntos, siempre.

> **Segundo error más común**: abrir `3478/UDP` y no `3478/TCP`. Muchas redes
> corporativas bloquean UDP saliente; en esas el navegador necesita `?transport=tcp`.

### Qué NO se publica nunca

| Puerto | Servicio | Quién debe alcanzarlo |
|---|---|---|
| `5432` | PostgreSQL | solo el core: escucha en `127.0.0.1` del host (lo necesita Asterisk, host network); no se comparte con nadie, tampoco con SBC-NG |
| `3000` | API control-plane | solo `127.0.0.1` del host (Asterisk) y el panel por la red interna; nadie más |
| `3001` | Dashboard | el proxy (con NPM en el mismo compose queda en `127.0.0.1`); si el proxy está en otro host, solo la IP del proxy (`DASHBOARD_TRUST_PROXY=1`) |
| `5038` | Asterisk AMI | solo la API. nftables lo deja pasar **sólo desde redes privadas** (§1.2) |
| `8088` | Asterisk ARI/WS | solo la API y el proxy (para `/ws`). nftables lo deja pasar **sólo desde redes privadas** (§1.2); el proxy tiene IP privada, así que WebRTC sigue andando |
| `8091` / `8092` | Agentes internos (turn-agent, ast-agent) | solo la API, con token (`8092`: todo `POST` y los `GET` `/net`, `/route`, `/fw/bans`; `/core` y `/metrics` abiertos porque no exponen secretos; sin `agent.token` acepta desde redes privadas, ver §1.1) |
| `81` | Nginx Proxy Manager (admin) | solo LAN / VPN |

### 1.1 La tabla `inet pbxng` de nftables (bloqueo de IPs del módulo Seguridad)

Desde 1.6.0 el bloqueo de atacantes SIP que decide **Sistema → Seguridad** no lo hace
Asterisk ni un fail2ban: lo hace **nftables en el kernel del host**. Como el contenedor de
Asterisk corre en `network_mode: host` con `cap_add: NET_ADMIN`, su agente
(`pbxng-ast-agent.py`, rutas `/fw/*`) crea y administra esta tabla, y las reglas viven en
el host aunque el contenedor se reinicie:

```
table inet pbxng {
    set banned {
        type ipv4_addr
        flags timeout          # cada elemento puede vencer solo; sin timeout = permanente
    }
    chain input {
        type filter hook input priority -10; policy accept;
        ip saddr @banned drop
    }
}
```

Qué hay que saber para convivir con ella:

- **Hook `input`, prioridad -10**: corta el tráfico **dirigido al host** (Asterisk y coturn
  corren en `network_mode: host`: SIP 5060/5061, RTP, 3478, y también ssh o cualquier otro
  servicio del host) *antes* que `filter` (prioridad 0), o sea antes que UFW/firewalld/
  iptables-nft. Lo que Docker reenvía a contenedores en bridge (el panel `:3001`, NPM 80/443)
  pasa por el hook `forward`, no por `input`: una IP baneada por SIP sigue pudiendo pegarle
  al proxy web (el rate limit del login es otra capa).
- **Policy accept**: la tabla no cierra nada por sí sola. Sacarla (`nft delete table inet
  pbxng`) deja el host como estaba; el agente la vuelve a crear en el próximo `/fw/*` o
  reinicio del contenedor (`ensure_fw()` es idempotente y **nunca borra** el set).
- **Sólo IPv4**, y el agente rechaza (`400`) IPs privadas, loopback, link-local, multicast,
  reservadas y las del propio host: no podés dejarte afuera desde el panel.
- **Fuente de verdad = la base** (`pbxng_blocked`). La API manda el set completo con
  `POST /fw/sync` al arrancar y cada 5 min, así que un `nft flush set` a mano se revierte
  solo; para soltar una IP usá el panel (o `POST /api/security/unblock`).
- Si tu firewall del host usa `nft flush ruleset` en su arranque (algunos scripts de
  firewalld/UFW lo hacen), la tabla desaparece hasta el próximo sync; el panel lo muestra
  como «sin nftables» o «firewall activo» según el momento. Conviene que ese script no borre
  tablas ajenas o que se ejecute antes de levantar el compose.
- Requisitos: kernel con `nf_tables` (cualquier 4.x+ estándar de Debian/Ubuntu) y el
  `cap_add: NET_ADMIN` que ambos compose ya le dan a Asterisk. Si `nft` no puede hablar con
  el kernel (típico: un contenedor LXC sin permiso para nf_tables), el agente responde `503`,
  la central arranca igual y el panel avisa «los bloqueos se registran pero no se aplican».

Ver cómo está:

```bash
nft list table inet pbxng                 # tabla completa
nft list set inet pbxng banned            # IPs bloqueadas con el tiempo que les queda
nft list chain inet pbxng input           # UNA sola línea "ip saddr @banned drop" + las 3 de gestión (§1.2)
```

### 1.2 ARI/WS `8088` y AMI `5038`: sólo desde redes privadas (reglas `pbxng-mgmt`)

Asterisk corre en `network_mode: host` y `http.conf` tiene `bindaddr=0.0.0.0` **a la
fuerza**: la API vive en un contenedor bridge y llega al ARI por la IP LAN del host
(`ASTERISK_HOST`), así que atarlo a `127.0.0.1` la dejaría afuera; y ponerle TLS sin un
certificado real no protege nada (el WSS del softphone lo termina el proxy). ARI (`ari.conf`,
`http.conf`) no tiene ACL propia como el AMI. Lo que sí se puede hacer es decidir en el kernel
quién llega al puerto: el mismo agente que administra `inet pbxng` agrega en la chain `input`
tres reglas marcadas con `comment "pbxng-mgmt"`:

```
set mgmt_allow  { type ipv4_addr; flags interval; elements = { 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } }
set mgmt_allow6 { type ipv6_addr; flags interval; elements = { ::1, fc00::/7, fe80::/10 } }
chain input {
    ...
    ip saddr @mgmt_allow  tcp dport { 8088, 5038 } accept comment "pbxng-mgmt"
    ip6 saddr @mgmt_allow6 tcp dport { 8088, 5038 } accept comment "pbxng-mgmt"
    tcp dport { 8088, 5038 } drop comment "pbxng-mgmt"
}
```

- **Qué sigue andando**: la API (bridge de docker, `172.17-31.x`, dentro de `172.16/12`),
  un proxy NPM en otra máquina de la LAN, el SBC-NG si hiciera falta, cualquier VPN con
  direccionamiento privado. Los navegadores WebRTC entran a `8088` **siempre** a través del
  proxy (`443 → /ws`), y el proxy tiene IP privada: no se corta ninguna llamada.
- **Qué se corta**: publicar `8088` o `5038` crudos a internet (por error o por un
  port-forward viejo). Aunque alguien lo haga, el ARI con usuario/clave y el AMI no quedan al
  alcance de cualquiera.
- **Es configurable** con `/etc/pbxng/fw.json` (volumen `certs`, lo escribe el administrador
  a mano; opcional, sin el archivo aplican los valores de arriba):

  ```json
  { "ari_public": false, "mgmt_allow": ["100.64.0.0/10", "2001:db8:1::/48"] }
  ```

  `ari_public: true` **no pone** las reglas (y las saca si estaban, en el próximo arranque o
  `/fw/*`); `mgmt_allow` **suma** redes a los sets (CGNAT, un rango público propio, una VPN
  con IPv6). Un valor que no parsea se ignora. Los sets se reconcilian en cada `ensure_fw()`
  (flush + add en una transacción), así que editar el archivo y reiniciar el contenedor (o
  esperar el próximo `/fw/sync` de la API, cada 5 min) alcanza.
- `python3 pbxng-ast-agent.py --print-fw` imprime el ruleset declarativo equivalente (sirve
  para `nft -c -f` y para comparar con `nft list table inet pbxng`); no se aplica con `nft -f`
  porque duplicaría reglas en cada arranque, el agente las agrega sólo si faltan.
- Si tu proxy o tu API llegan desde una IP **pública** (rol `core` con proxy en un VPS, por
  ejemplo), agregá esa red en `mgmt_allow` o poné `ari_public: true` **y** restringí `8088`
  en tu propio firewall; el panel no se entera de esta configuración, la lee sólo el agente.
- **Cambio de comportamiento al actualizar a 1.7.0**: las redes CGNAT/VPN que no son RFC 1918
  —Tailscale y similares usan `100.64.0.0/10`; WireGuard u OpenVPN con un rango público
  propio— **no** están en el set base. Un administrador que hoy llega a ARI (`8088`) o al AMI
  (`5038`) por esa vía queda afuera en cuanto arranca la imagen nueva, hasta que escriba esa
  red en `mgmt_allow` de `fw.json` (y reinicie el contenedor o espere el próximo `/fw/sync`).
  Conviene dejar el archivo escrito **antes** de actualizar. El agente (`8092`) no está en
  esta regla: `GET /core` sigue abierto desde cualquier origen que llegue al host; restringilo
  en el firewall del host si el host tiene IP pública.

### Interno (LAN): core ↔ SBC-NG

Si hay un SBC-NG adelante, necesita llegar al core (y nada más que eso):

| Desde | Hacia | Puerto |
|---|---|---|
| SBC-NG | core | `5060/UDP+TCP` (SIP de Asterisk, troncal `to-sbc`) |
| SBC-NG | core | `10000-20000/UDP` (RTP de Asterisk) |

Postgres, AMI y ARI **no** se comparten con el SBC-NG: cada producto tiene su propia
base y sus secretos. El módulo «Conexión a SBC-NG» mide el puerto SIP del SBC-NG desde
el core, así que el core también tiene que poder salir hacia el SIP del SBC-NG.

Si el TURN y el proxy viven en otro host (rol `core` + `--turn-ip=`), el proxy necesita
llegar al core por `3000`, `3001` y `8088` (WSS `/ws`); el coturn no necesita nada del core.
Si ese proxy no tiene IP privada, sumá su red en `mgmt_allow` de `/etc/pbxng/fw.json` (§1.2), si no
nftables le corta el `8088`.

---

## 2. Reglas de NAT (dst-nat) — la lógica

Todo lo que se publica al WAN debe apuntar al contenedor correcto:

| Tráfico | → destino |
|---|---|
| `80,443/TCP` | IP del **reverse proxy** (NPM) |
| `3478/UDP`, `3478/TCP`, `5349/TCP`, `49152-65535/UDP` | IP del **coturn** (`turn`) |
| `5060,5061` + `10000-20000/UDP` | IP de **Asterisk** (core) — solo sin SBC-NG; con SBC-NG, a la IP del SBC-NG según su doc |

Además el coturn necesita conocer su IP pública. En `.env`:

```
PUBLIC_IP=<IP_WAN>        # o el FQDN publicado
```

que se materializa en `turnserver.conf` como:

```
external-ip=<IP_WAN>/<IP_LAN_DEL_TURN>
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
  to-addresses=<IP_TURN> comment="Coturn hairpin UDP"
/ip firewall nat add chain=dstnat action=dst-nat protocol=tcp dst-port=3478 \
  dst-address-type=local src-address=<LAN/24> dst-address=!<IP_ROUTER> \
  to-addresses=<IP_TURN> comment="Coturn hairpin TCP"
/ip firewall nat add chain=dstnat action=dst-nat protocol=udp dst-port=49152-65535 \
  dst-address-type=local src-address=<LAN/24> dst-address=!<IP_ROUTER> \
  to-addresses=<IP_TURN> comment="TURN relay hairpin"
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

Lo mismo, gráfico y desde el navegador del usuario: **Panel → Configuración → WebRTC / TURN →
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

- [ ] `443/TCP` publicado al reverse proxy (WSS del softphone, `/ws` → Asterisk `:8088`).
- [ ] `3478/UDP` **y** `3478/TCP` al coturn.
- [ ] `49152-65535/UDP` al coturn (rango relay). **Sin esto no hay audio por TURN.**
- [ ] `5060` (+`5061`) y `10000-20000/UDP` a Asterisk, **solo** si hay troncales del operador o teléfonos remotos directos a la central. Con SBC-NG adelante, eso se publica en el SBC-NG.
- [ ] `PUBLIC_IP` correcta en `.env` → `external-ip=<publica>/<privada>` en coturn.
- [ ] `TURN_PASS` rotada (no `pbxng-turn-changeme`) y, si el coturn corre en otro host, **la misma** en los dos `.env`.
- [ ] Postgres `5432`, AMI `5038` y ARI `8088` sin publicar (ni al SBC-NG). `nft list chain inet pbxng input` muestra las tres reglas `pbxng-mgmt` (o hay un `fw.json` con `ari_public: true` a propósito, §1.2).
- [ ] `nft list table inet pbxng` existe en el host y **Sistema → Seguridad** muestra «firewall activo · nftables» (si no, revisá `nf_tables` / `NET_ADMIN`, §1.1).
- [ ] Con SBC-NG: desde su IP, permitido `5060` y `10000-20000/UDP` hacia el core.
- [ ] `scripts/check-turn.py` da **ALLOCATE 200 · relay = …** desde fuera de la LAN.
- [ ] (Opcional) Hairpin resuelto, para que el diagnóstico también dé verde desde adentro.
