# PBX-NG · Entrega a desarrollo

**Para quién es esto:** gente que programa bien y **no sabe de telefonía ni conoce este
producto**. El objetivo es que en una tarde puedas levantar el entorno, entender por dónde
pasa una llamada y saber qué NO tocar hasta entender por qué está así.

**Qué NO es esto:** no es la auditoría ni el plan de trabajo. Lo que falta para que esto sea
un contrato público —eventos salientes, versionado, credencial de sistema, idempotencia,
paginación— está medido y priorizado en [`AUDITORIA-ENTREGA.md`](AUDITORIA-ENTREGA.md).
Acá se describe **lo que existe hoy**.

**Cómo leer las afirmaciones:** todo lo que dice este documento se puede verificar en el repo
y lleva la ruta al archivo. Donde algo no se midió, lo dice. Donde dos documentos del repo se
contradicen, está anotado en §8 y **no se eligió uno**.

Versión del árbol al escribir esto: `VERSION` = **1.11.0** (el último commit se llama 1.11.1;
ver §8).

---

## 1. Qué es PBX-NG y qué problema resuelve

Es una **central telefónica IP** que se entrega como appliance: una empresa la instala y
desde ahí manejan sus internos (los teléfonos de la oficina), sus troncales (la conexión al
operador telefónico que da salida a la calle) y todo lo que pasa entre esas dos cosas —colas,
IVR, buzón de voz, grabación, reportes—.

El problema real que resuelve no es "hacer sonar un teléfono": eso lo hace Asterisk, que es
software libre y existe hace veinte años. Lo que resuelve PBX-NG es que **un administrador
que no sabe de telefonía pueda configurarla desde un panel web** sin editar archivos de
configuración ni reiniciar nada, y que eso se pueda instalar y actualizar como producto.

Tres cosas que conviene tener claras desde el primer minuto:

- **El camino de la llamada es dinero.** Una ruta saliente mal armada marca a un número
  internacional y lo paga el cliente. Un IVR mal generado deja entrar llamadas que salen a la
  calle. Por eso el código que genera dialplan valida con listas blancas y por eso conviene no
  "simplificarlo".
- **Una llamada no se puede caer porque un sistema externo tardó.** Asterisk es síncrono en el
  camino de señalización: si algo en el medio espera, el que llama escucha silencio.
- **Este producto se va a integrar de forma bidireccional con un backoffice.** La mitad
  "el backoffice ordena" existe hoy (hay API). La mitad "la central avisa" **no está
  construida** —hay 6 `emit()` de socket.io y ninguno es un evento de llamada—. Eso está
  detallado en la auditoría; se menciona acá para que no lo busques.

---

## 2. El mapa mental

### 2.1 Las cuatro piezas

```
     navegador / softphone
              │  HTTPS + WSS
   ┌──────────▼───────────┐
   │  dashboard/          │  Next.js 14 + un proxy propio (server.js) que reenvía
   │  (panel, :3001)      │  /backend, /socket.io, /prov a la API
   └──────────┬───────────┘
              │  HTTP  (/backend/**  ->  /api/**)
   ┌──────────▼───────────┐        ARI  :8088  (REST + WebSocket)
   │  control-plane/      │◄──────────────────────────┐
   │  (API Node, :3000)   │        AMI  :5038  (eventos y acciones)
   └──────────┬───────────┘◄──────────────────────────┤
              │  SQL                                   │
   ┌──────────▼───────────┐                 ┌──────────┴───────────┐
   │  PostgreSQL 16       │◄────────────────┤  Asterisk 22         │
   │  config + CDR        │   realtime      │  chan_pjsip          │
   └──────────────────────┘   (lee solo)    │  + AstDB (local)     │
                                            └──────────────────────┘
                                              5060/5061 SIP · 10000-20000 RTP
```

**Asterisk** es el motor telefónico. Habla SIP con los teléfonos y con el operador, mueve el
audio (RTP), y decide qué hacer con cada llamada leyendo el **dialplan**. Nadie de este equipo
escribe dialplan a mano: lo genera la API.

**El control-plane** (`control-plane/`, Node + Express) es la API. Hace tres cosas distintas
que conviene no confundir:
1. atiende al panel por HTTP (`/api/**`),
2. **escribe en PostgreSQL la configuración que Asterisk va a leer** (esto es el "realtime"),
3. habla con Asterisk en vivo por ARI y AMI para lo que no es configuración (originar una
   llamada, colgarla, escuchar eventos).

**El panel** (`dashboard/`) es Next.js. No habla con Asterisk: habla sólo con la API, y
siempre a través de su propio proxy (`dashboard/server.js`), que es lo que deja la IP real
del cliente como último elemento de `X-Forwarded-For`.

**PostgreSQL** guarda dos cosas que parecen una: la configuración del producto (tablas
`pbxng_*`) y **la configuración que Asterisk lee directamente** (tablas `ps_endpoints`,
`extensions`, `queues`…).

### 2.2 Qué es "realtime" y por qué importa

Asterisk normalmente lee su configuración de archivos `.conf` y hay que recargarlo cuando
cambian. En modo **realtime** (ARA, *Asterisk Realtime Architecture*) lee **filas de una tabla
de PostgreSQL**, en el momento en que las necesita. El mapeo está en
`docker/config/asterisk/extconfig.conf`:

```
ps_endpoints  => pgsql,pbxng,ps_endpoints     ← los internos y las troncales
extensions    => pgsql,pbxng,extensions       ← el dialplan generado
queues        => pgsql,pbxng,queues
voicemail     => pgsql,pbxng,voicemail
```

La consecuencia práctica: **crear un interno desde el panel es un INSERT**, no un reload.
Y **el dialplan generado es la tabla `extensions`**: `(context, exten, priority, app, appdata)`.
Cuando en este documento se dice "la API publica dialplan", quiere decir que escribe filas ahí.

En `docker/config/asterisk/extensions.conf` está la parte **estática** del dialplan (194
líneas, horneada en la imagen) y cada contexto termina con `switch => Realtime`, que es la
línea que le dice a Asterisk "lo que no encontraste acá arriba, buscalo en la tabla".

**Orden de resolución (esto ya causó problemas):** Asterisk resuelve primero las extensiones
propias del contexto —las del archivo—, después los `include`, y recién después el
`switch => Realtime`. O sea que **lo estático le gana a lo realtime**. El propio repo lo sabe:
`extensions.conf:101` tiene un `GotoIf($[${DIALPLAN_EXISTS(ivr,${EXTEN},1)}]?ivr,...)` que es
exactamente el parche de esa precedencia, aplicado a un solo contexto. (Esto se afirma por la
documentación de Asterisk y por ese parche; **no se verificó corriendo un Asterisk**.)

### 2.3 Por qué hay una AstDB además de PostgreSQL

La **AstDB** es la base de datos interna de Asterisk (clave/valor, local, en memoria y disco
del propio Asterisk). Se lee desde el dialplan con `DB(familia/clave)`.

Está ahí por una razón de rendimiento que está escrita en `extensions.conf:93-99`: las
banderas que cambian todo el tiempo —no molestar, desvíos, sígueme, "grabar este interno"— se
consultan **en cada timbrazo**. Hacer una consulta SQL por llamada para eso sería pagar una
consulta por timbrazo. Entonces:

> **PostgreSQL es la fuente de verdad. La AstDB es una copia local para que el dialplan lea
> rápido.** La API vuelca Postgres → AstDB al arrancar (`syncFeatures()` en `telefonia.js`,
> `syncRecFlags()` en `recordings.js`) y en cada cambio.

Esto es una decisión razonable y está bien explicada, pero tiene un costo que conviene conocer:
hay un camino —el usuario marcando un código de función en el teléfono— que escribe la AstDB
**antes** de avisarle a la API. Ver la trampa 6 en §6.

### 2.4 ARI y AMI: por qué son dos cosas

Asterisk expone dos interfaces de control y la API usa las dos. Fallan distinto, así que se
diagnostican distinto. El detalle completo está en [`ARI-AMI.md`](ARI-AMI.md); el resumen:

| | AMI (`:5038`) | ARI (`:8088`) |
|---|---|---|
| Qué es | protocolo de texto, eventos y acciones sueltas | REST + WebSocket, con estado propio |
| Se usa para | escuchar **todo lo que pasa** (`Newchannel`, `Hangup`, `DialBegin`, eventos de cola), disparar acciones puntuales (`MixMonitor`, `Originate`, `QueuePause`), y recargas | control de llamadas con estado: la app Stasis `pbxng`, bridges, el IVR con IA, la lista de canales y endpoints |
| Si se cae | el panel deja de actualizarse en vivo, no se aplican recargas | `/api/calls/dial` devuelve **503** y la presencia queda vacía |

La API **arranca y se queda viva sin Asterisk y sin PostgreSQL** (medido en la auditoría:
`/health` responde `503 degraded` y ARI reintenta con backoff). Eso es a propósito: una API
que no arranca porque falta una dependencia no se puede diagnosticar desde el panel.

---

## 3. Levantar todo de cero

### 3.1 Lo que necesitás instalado

- **Node 20+** (las imágenes usan `node:20-slim`; `npm run lint` de la API pide Node ^20.19 /
  ^22.13 / 24+ por ESLint 10 — la CI usa 22).
- **Docker + Docker Compose** para el stack completo.
- **PostgreSQL 16 instalado** para correr las pruebas de integración de la API
  (`apt install postgresql-16` o `brew install postgresql@16`). **No hace falta que el
  servicio corra**: el arnés de pruebas levanta su propio clúster efímero. Alternativa:
  `PGURL` apuntando a un servidor donde tengas permiso `CREATEDB`.
- Python 3 para `voice-service/` y los scripts.

### 3.2 El camino corto: el stack entero con Docker

```bash
git clone <repo> && cd pbx-ng/docker
./install.sh
```

Es **interactivo**: pregunta el rol, los módulos, el dominio, y genera los secretos en
`docker/.env`. Al terminar deja el stack corriendo e imprime las URLs y los puertos que hay
que abrir en el firewall.

No interactivo:

```bash
./install.sh --role=all --yes --profiles=core,turn --domain=pbx.ejemplo.com --public-ip=<IP>
./install.sh --print-firewall --profiles=core,turn     # sólo mostrar qué abrir, no instala
```

**El modelo de empaquetado, que es lo primero que confunde:** *módulo = perfil de compose =
contenedor*. Un contenedor **existe sólo si su módulo está activo**, y qué está activo vive en
`docker/.env` → `COMPOSE_PROFILES`. Los módulos son `core` (postgres, asterisk, api,
dashboard), `turn` (coturn), `ai` (voz), `intercom` (go2rtc), `proxy` (nginx-proxy-manager).
Desde el panel el interruptor escribe `pbxng_settings.mod_<id>` y un reconciliador (timer de
systemd, cada 20 s) llama a `pbxng-ctl` para que el contenedor exista o no.

```bash
pbxng-ctl status            # perfiles activos + contenedores
pbxng-ctl enable intercom   # agrega el perfil y CREA el contenedor
pbxng-ctl drain [--yes]     # drena Asterisk antes de tocarlo: NO corta llamadas activas
pbxng-ctl backup
```

**Dos avisos sobre el instalador, medidos en la auditoría** (detalle en `AUDITORIA-ENTREGA.md`):

- `--profiles=` **no se valida**. Un typo (`turno` en vez de `turn`) resuelve el stack sin
  coturn, sale con código 0 y no avisa nada. `pbxng-ctl` sí valida; el instalador no.
- El camino `--release` (instalar por imagen en vez de compilar) **no funciona tal cual**:
  nadie escribe `PBXNG_REGISTRY` ni `PBXNG_VERSION` en el `.env`, así que el compose busca
  imágenes que no existen. Para levantar un entorno hoy, usá el camino por defecto (build).

### 3.3 El camino de desarrollo: cada pieza a mano

```bash
# API — necesita un Postgres y (para telefonía real) un Asterisk alcanzables
cd control-plane && npm ci && npm start          # :3000

# Panel — `node server.js` = Next + el proxy propio hacia la API.
# API_URL se lee al arrancar (default http://127.0.0.1:3000), NO en el build.
cd dashboard && npm ci && npm run dev            # :3001
```

La API **no arranca** con `JWT_SECRET` vacío, placeholder o de menos de 16 caracteres
(`app.js:49`). Es a propósito y es el precedente correcto: mejor no arrancar que arrancar
inseguro.

### 3.4 Correr las pruebas

```bash
cd control-plane && npm run lint && npm test
cd dashboard     && npm run lint && npm run build && npm run check:deps
```

`npm test` es `node --test test/*.test.js`: **20 archivos, 158 casos, ~44 s** medidos en la
auditoría (el README dice "~20 s"; ver §8). No son pruebas de mentira: el arnés
(`control-plane/test/helpers/db.js`, 329 líneas) levanta un **PostgreSQL efímero real**,
le aplica `docker/config/initdb/01-schema.sql` + `node migrate.js` —el mismo camino que el
entrypoint del contenedor— y arranca **`app.js` como proceso hijo** con ARI y AMI apuntando a
puertos cerrados. Una base y una API por archivo de prueba.

**La trampa del día uno, y es importante:** si **no hay PostgreSQL**, los 12 archivos de
integración se marcan `skip` y **`npm test` sale con código 0 habiendo corrido ~48 de 158
casos** (medido). Verde en 4 segundos en vez de 44. Es una decisión deliberada, documentada en
`CONTRATOS.md` §10, pero si montás un CI propio y no le agregás el servicio de Postgres, vas a
desplegar sin que una sola ruta se haya ejercitado. **Mirá siempre el conteo, no el color.**

`TEST_API_VERBOSE=1` vuelca el log de la API hija, que es cómo se depura una prueba de
integración que falla sin decir por qué.

Cobertura, para que no te sorprenda: **104 de ~350 rutas Express reciben un request en toda
la suite (29,7 %)**, medido instrumentando un middleware. `recordings.js` y `sipconf.js`
tienen 0; `app.js` tiene 13 de 152. La cobertura de líneas (67 %) engaña: el registro de una
ruta cuenta como línea cubierta aunque el handler nunca corra. El número honesto de `app.js`
es **23,3 % de funciones**.

### 3.5 Lo que NO hay

No hay pruebas fuera de `control-plane/`: **cero** en `dashboard/` (50 páginas), cero en
`softphone-app/`, cero en `voice-service/`, cero en los agentes Python. No hay ningún Asterisk
en el circuito de pruebas: el dialplan se verifica **como filas de la tabla `extensions`**, no
cursando una llamada. No hay OpenAPI. No hay pruebas de carga.

---

## 4. El recorrido de una llamada, de punta a punta

Esta sección es la que más rinde leer con el archivo
`docker/config/asterisk/extensions.conf` abierto al lado.

### 4.1 Vocabulario mínimo

| Palabra | Qué es |
|---|---|
| **Interno** (extensión) | un teléfono de la oficina: el 1001, el 1002. En Asterisk es un *endpoint* PJSIP, una fila de `ps_endpoints` |
| **Troncal** | la conexión al operador telefónico. También es un endpoint PJSIP, pero apunta afuera |
| **Contexto** | un espacio de nombres del dialplan. Una llamada entra a un contexto y sólo ve las extensiones de ese contexto. Es **la** frontera de seguridad del dialplan |
| **DID** | el número público por el que entra una llamada de afuera |
| **Dialplan** | las reglas: "si marcan X en el contexto Y, hacé Z". Filas de `(context, exten, priority, app, appdata)` |
| **CDR** | *Call Detail Record*: una fila por llamada terminada. Es lo que se factura y concilia |
| **AstDB** | la base clave/valor interna de Asterisk (§2.3) |

Los tres contextos que existen (`extensions.conf`):

- **`from-trunk`** — donde aterriza lo que viene de afuera. **No incluye `internal`**, y eso es
  a propósito: si lo incluyera, cualquiera que llame desde la calle podría marcar una ruta
  saliente y salir por la central. Incluye sólo `ivr`.
- **`internal`** — donde viven los internos. Contexto **compartido**: acá publican los códigos
  de función, las rutas salientes, las DISA, los abreviados. Ver la trampa 1.
- **`ivr`** — IVR, colas, grupos de timbrado, voceo, salas. También **compartido**, y este
  **no tiene candado**. Ver la trampa 1.

### 4.2 Llamada de un interno a otro (1001 marca 1002)

Es el camino mejor comentado del repo y el que más enseña. El teléfono 1001 manda un INVITE,
Asterisk lo autentica contra `ps_endpoints` y mete la llamada en el contexto `internal`.
Matchea el patrón `_[1-9]XXX` (`extensions.conf:100`) — nótese: **exactamente 4 dígitos que
empiezan del 1 al 9**. Después, en orden:

1. **¿Hay un IVR con ese número?** `GotoIf($[${DIALPLAN_EXISTS(ivr,${EXTEN},1)}]?ivr,...)`
   — el parche de precedencia de §2.2.
2. **Guardia de bucle.** `__SALTOS` con **doble guion bajo**, que en Asterisk significa
   *heredable*: el contador sobrevive al canal `Local/` que crea el sígueme. Sin el doble
   guion bajo, A con sígueme a B y B con sígueme a A se pasaban la llamada para siempre,
   porque cada canal nuevo nacía con el contador en cero. Está explicado en
   `extensions.conf:106-115` y hay una prueba que lo verifica (`imagen-asterisk.test.js:86`).
3. **No molestar** → `DB(dnd/1002)` → buzón con saludo de ocupado.
4. **Desvío incondicional** → `DB(cfu/1002)` → `Goto(internal, <destino>, 1)`.
5. **Despertar el softphone.** Si el interno no tiene contacto registrado (la PWA está
   cerrada), el dialplan hace `Set(WAKE=${CURL(http://<api>/api/internal/wake?...)})` para que
   la API mande un push, y después **sondea hasta 16 veces con `Wait(0.5)`**: hasta 8 segundos
   esperando a que el teléfono se registre. No hay `Ringing()` antes, así que el que llama
   escucha silencio durante esos 8 s.
6. **Grabación.** Tres `DB(rec/...)` distintas (por destino, por origen, global) deciden si
   arranca `MixMonitor`.
7. **Timbra.** `Dial(PJSIP/1002, ${TIMBRE})`, 25 s por defecto, 15 si hay sígueme.
8. **Según cómo terminó:** ocupado → `cfb`; sin respuesta → `cfnr` y si no hay, **sígueme**;
   todo lo demás → buzón.

El sígueme merece un párrafo porque es la parte que parece rara y no lo es: el destino del
sígueme es un **número externo**, y la única salida a la calle que conoce esta central son las
rutas salientes que `trunks.js` publica **como extensiones del propio contexto `internal`**.
Por eso se marca con `Dial(Local/${DB(fm/${EXTEN})}@internal/n, 45)` en vez de inventar una
troncal ahí: el número se marca *como si lo hubiera marcado el interno*, con su prefijo de
salida y su CallerID. El `/n` mantiene el canal vivo para que el `MixMonitor` que ya arrancó y
el CDR sigan viendo la llamada.

### 4.3 Llamada saliente (1001 marca 0 099123456)

El patrón `_0.` **no está en `extensions.conf`**: es una fila realtime que publicó
`trunks.js` en el contexto `internal` cuando alguien creó la ruta saliente desde el panel.
Esa fila hace `Dial(PJSIP/${EXTEN:1}@<troncal>, ...)` — el `:1` saca el prefijo de salida.

Dos piezas que están muy bien hechas y no conviene tocar:

- **`filasSalida()`** (`trunks.js:358`) genera el **failover**: si la troncal principal no
  contesta, salta a la siguiente. Los saltos son sólo hacia adelante con prioridades
  calculadas, hay un `TOPE` de tiempo total chequeado **antes de cada `Dial`** (para que tres
  troncales no sean tres timeouts encadenados), y un `HangupCauseClear` antes de cada intento
  para que la causa del anterior no se confunda con la del siguiente.
- **`rutaGanadora()` / `matchPatron()`** (`marcacion.js:212-320`) reimplementan el
  `ext_cmp1()` de `pbx.c` de Asterisk para contestar **"¿por CUÁL ruta saldría de verdad este
  número?"**, no "¿alguna matchea?". Esa es la diferencia entre una DISA que *dice* "sólo
  nacional" y una que lo cumple.

### 4.4 Llamada entrante (alguien llama al número de la empresa)

El operador manda el INVITE a la troncal. Asterisk identifica la troncal por IP o por usuario
y mete la llamada en el contexto que dice **`ps_endpoints.context` de esa troncal** — por
defecto `from-trunk`.

En `from-trunk` no hay casi nada estático: `include => ivr`, `switch => Realtime`, y una
extensión `i` que cuelga con `NoOp(DID sin ruta entrante)`. Las rutas entrantes las publica
`trunks.js` como filas realtime, con el DID como `exten`.

Si la ruta tiene **horario**, la fila que se publica evalúa `GotoIfTime` por cada tramo y
salta a `abierto-<did>` o `cerrado-<did>`. El horario y los feriados viven en Postgres y los
administra `telefonia.js`, que le pide a `trunks.js` que regenere las entrantes cuando algo
cambia. El **modo noche** (`DB(nightmode/modo)`) puede forzar cerrado o abierto por encima del
horario.

Desde ahí el destino es un interno, una cola, un IVR, una sala o un buzón.

### 4.5 Dónde está cada cosa

| Quiero entender… | Archivo |
|---|---|
| el camino de interno a interno, buzón, captura, aparcado | `docker/config/asterisk/extensions.conf` (194 líneas, léelo entero) |
| troncales, rutas entrantes y salientes, failover | `control-plane/trunks.js` |
| horarios, feriados, modo noche, desvíos, códigos de función | `control-plane/telefonia.js` |
| DISA, callback, directorio por nombre, abreviados | `control-plane/marcacion.js` |
| colas, IVR, grupos de timbrado, voceo, buzones | `control-plane/apps.js` |
| originar / colgar / transferir / espiar una llamada (ARI) | `control-plane/callengine.js` |
| grabaciones, CDR, indexador | `control-plane/recordings.js` |
| quién puede ocupar una extensión de `internal` | `control-plane/dueno-internal.js` |
| la forma de los errores HTTP | `control-plane/errores.js` |
| la tabla de permisos | `control-plane/rbac.js` |

**El patrón de los módulos** es siempre el mismo:
`module.exports = function init(deps) { …registra rutas en deps.app…; return {…} }`. Reciben
todo por `deps` (nada global) y **se registran en `app.js` después del gate de auth y de
`rbac.middleware`** — Express resuelve en orden, así que un módulo registrado antes del gate
queda sin token ni rol. Ya pasó con `callengine.js`. Cada archivo tiene un encabezado que dice
qué contiene, qué exporta, de qué depende y qué orden de montaje exige: **léelo antes de
tocarlo**, porque explica el porqué, no el qué.

Lo que todavía no se partió en módulos vive en `app.js`: 2.389 líneas, 152 rutas, 18 dominios
distintos. Es donde están `/api/clients` (el CRM), los respaldos, el push, el click-to-call y
también el arranque del proceso. Si buscás algo y no está en la tabla de arriba, está ahí.

---

## 5. Quién es dueño de qué

La regla del proyecto es una sola y está en [`CONTRATOS.md`](CONTRATOS.md) §1: **cada archivo,
tabla y endpoint tiene UN dueño**. El que no es dueño lo consume y, si necesita un cambio, lo
pide. Los "dueños" son roles de trabajo (están descritos como agentes en `.claude/agents/`),
pero la división vale igual para personas.

| Pieza | Directorio | Dueño |
|---|---|---|
| API / control-plane | `control-plane/` | `api` |
| Panel web | `dashboard/` | `panel` |
| Asterisk y dialplan | `docker/config/asterisk/`, `docker/images/asterisk/`, `control-plane/astconf.js` | `telefonia` |
| WebRTC / ICE / TURN / NAT / RTP | `docker/images/coturn/`, `turn.js`, `/api/ice`, `useSoftphone.js` | `medios` |
| Seguridad: baneos, listas, geobloqueo | `guard.js`, `pbxng-ast-agent.py`, `dashboard/app/seguridad/` | `seguridad` |
| Portería y CRM (clientes, porteros RTSP, go2rtc) | `clients`/`spaces`/`devices`/`intercom`/`survey` | `porteria` |
| Empaquetado y operación | `docker/`, `deploy/`, `.github/workflows/`, `VERSION` | `empaquetado` |
| Softphone de escritorio | `softphone-app/` | `softphone` |
| Documentación | `README.md`, `CHANGELOG.md`, `docs/`, manuales | `docs` |

**Una nota honesta sobre esta tabla:** hoy está rota en un punto y conviene saberlo.
`porteria` es dueño de `clients`/`spaces`/`devices`/`survey`, pero ese código vive **adentro de
`app.js`** (líneas 2073-2338), cuyo dueño es `api`. O sea que dos áreas editan el mismo archivo
de 2.389 líneas. La auditoría propone el corte y verifica que el bloque es contiguo y que sus
cuatro funciones auxiliares no se usan en ninguna otra parte del archivo.

Dos reglas de proceso que el equipo aprendió a golpes y que valen para cualquiera que entre:

- **Una pieza sin dueño es una pieza rota.** El TURN estaba repartido entre tres áreas y el
  resultado fue una central anunciando un relay que nadie corría, con siete softphones WebRTC
  configurados contra él. Si algo no está en la tabla, la respuesta no es "lo hace cualquiera":
  es agregar la fila.
- **No se edita el árbol mientras corre un trabajo en paralelo.** Ya pasó: un módulo a medio
  cablear, el revisor lo leyó como bloqueante y otro lo borró. Lo que haya que tocar mientras
  alguien más trabaja se escribe aparte y se integra cuando el árbol queda libre.

---

## 6. Las trampas conocidas

**Esta es la sección más valiosa del documento.** Todo lo que sigue rompió algo de verdad en
este repo, o está medido como que lo va a romper. No son hipótesis.

---

### Trampa 1 — Los contextos compartidos: el que escribe último borra al anterior, en silencio

**Qué pasa.** Publicar dialplan es `setDialplan()`, que es **DELETE + INSERT por (contexto,
extensión)**. Si dos funciones distintas quieren el mismo número en el mismo contexto, la
segunda **borra a la primera y nadie se entera**. No hay error, no hay log, no hay conflicto:
el dialplan de la primera simplemente deja de existir.

Esto ya se pagó: *una DISA publicada en `*97` borraba el buzón de voz, y se descubrió cuando un
usuario se quejó.*

**Cómo está resuelto en `internal`.** Hay un candado: `control-plane/dueno-internal.js`. Tiene
la lista **única** de quién puede ocupar una extensión de `internal` (DISA, callback, directorio
por nombre, abreviados, códigos de función, rutas salientes, salida directa de troncal), y los
**tres** módulos que publican ahí —`marcacion.js`, `telefonia.js`, `trunks.js`— llaman a
`exigirLibre()` antes de escribir (409 si es de otro) y a `borrarPropio()` antes de borrar.

Leé el encabezado de ese archivo, que explica algo que no es obvio: **el candado sólo sirve
cerrado de los dos lados**. Cuando la comprobación vivía dentro de `marcacion.js`, la DISA ya no
podía pisar un código de función, pero publicar el código de función seguía borrando la DISA —el
mismo error en espejo—. Por eso la lista está en un archivo aparte y no duplicada en cada módulo.

**Lo que NO está resuelto, y hay que saberlo antes de tocar `apps.js`:** el contexto **`ivr` es
igual de compartido y no tiene candado**. Ahí publican IVR, colas, grupos de timbrado, voceo,
agentes IA (`apps.js`, 7 escrituras) y salas de reunión (`salas.js`). `salas.js` sólo compara
contra **otras salas**. Reproducido en la auditoría: creás un grupo de timbrado en el 600, creás
una sala en el 600 → el grupo desaparece del dialplan y la tabla sigue diciendo que existe;
después borrás el grupo → se lleva puesto el dialplan de la **sala**. `CONTRATOS.md` §1.1
describe el candado de `internal` en detalle y **no menciona que `ivr` también es compartido**.

**Regla práctica:** antes de escribir una fila en `extensions`, preguntate quién más publica en
ese contexto. Si la respuesta es "alguien más", el camino correcto es extender `dueno-internal.js`,
no agregar un `SELECT` propio.

---

### Trampa 2 — `DB()` exige familia **y** clave, o devuelve vacío para siempre

**Qué pasa.** La función `DB()` del dialplan de Asterisk toma `DB(familia/clave)`. Si la llamás
con un solo segmento —`DB(nightmode)`— **no falla**: devuelve vacío y escribe un WARNING por
llamada. Un `GotoIf` sobre un valor siempre vacío es una rama muerta que parece código vivo.

**Dónde mordió.** El contrato del sprint decía `DB(nightmode)` y se implementó
`DB(nightmode/modo)` desviándose a propósito, porque la forma corta habría dejado **las dos ramas
de modo noche forzado muertas en silencio** (`CHANGELOG.md:627`, que cita el mensaje exacto de
`func_db.c`: *"DB requires an argument, DB(<family>/<key>)"*).

**Regla práctica:** `DB()` **siempre** con familia y clave. Está escrito en `CONTRATOS.md` §
(varias veces, con esas palabras) y en el encabezado de `telefonia.js`. Las familias que usa el
producto hoy: `dnd`, `cfu`, `cfb`, `cfnr`, `fm`, `fmt`, `rec`, `nightmode`, `rutasal`, `sala`,
`salapin`, `salamod`.

Corolario del mismo problema: un `DBPut`/`DBDel` que falla **no tumba el guardado pero tampoco se
debe callar**. Desde 1.11.0 `telefonia.js`, `salas.js` y `recordings.js` registran el error con
familia y clave **y devuelven un aviso al que llamó**. Si agregás una escritura a la AstDB,
seguí ese patrón: si no, la API dice "guardado" y Asterisk sigue con lo de antes.

---

### Trampa 3 — Un módulo de Asterisk que falta no rompe el build; rompe la central

**Qué pasa.** `menuselect` (el sistema de compilación de Asterisk) **deja afuera sin avisar** lo
que no encuentra: si falta una librería `-dev`, el módulo simplemente no se compila y el build
sale verde. Y `modules.conf` tiene dos clases de módulo con consecuencias distintas:

- **`require = <modulo>.so`** — si falta, **Asterisk sale con código 2 al arrancar**. La central
  se queda sin teléfonos. Hoy son siete: `func_curl.so`, `func_uri.so`, `func_db.so`,
  `func_strings.so`, `app_directory.so`, `app_read.so`, `func_hangupcause.so`.
- **el resto** — puede faltar sin dejar a nadie sin teléfono, pero igual tiene que estar.

**Dónde mordió.** `func_hangupcause.so` (que necesita el failover de troncales) estaba en el
`require` y en ninguna verificación. Por eso hoy hay un **gate en el Dockerfile**
(`docker/images/asterisk/Dockerfile:61-69`) que corta el build si falta uno, el entrypoint
vuelve a avisar en el arranque para imágenes viejas, y `imagen-asterisk.test.js` verifica que
las tres listas coincidan.

**Regla práctica, escrita en `modules.conf:10`:** *cada `require =` vive en **tres** lugares que
se mueven juntos* —`modules.conf`, el gate del Dockerfile, el aviso del entrypoint—. El que
agrega uno lo agrega en los tres, o el gate pasa verde sobre una imagen que no levanta. Dos
detalles que ya costaron tiempo y están anotados ahí: **`URIENCODE` vive en `func_uri.so`**, no
en un inexistente `func_uriencode.so`; y **no existe ningún `func_strftime.so`**.

**Lo que hoy falta en esa lista** (medido): `app_page.so` (el voceo) y `app_mixmonitor.so` (la
**grabación**) no están en ninguna de las tres listas. Si un cambio deja `app_mixmonitor.so`
afuera, el build sale verde, Asterisk arranca, los teléfonos registran, las llamadas cursan
— **y la grabación no graba**. Se descubre cuando alguien va a buscar una llamada que necesita.
Al revés, `app_disa.so` está en la lista y **ningún dialplan generado lo usa**: la DISA está
implementada a mano con `Read`/`Playback`/`Dial` en `marcacion.js`.

---

### Trampa 4 — React #185: arreglar un warning de `exhaustive-deps` puede tumbar una pantalla

**Qué pasa.** `const x = Array.isArray(d) ? d : []` (o `d || {}`, o un `.filter()`) devuelve un
objeto **nuevo en cada render**. Si esa variable es dependencia de un `useMemo`/`useEffect` que
termina llamando a un `setState`, la cadena se realimenta y React corta con
«Maximum update depth exceeded» (**#185**). La pantalla queda en blanco.

**Dónde mordió.** Dos veces: en `SbcFlow.jsx` y en `troncales/page.jsx`. Por eso existe
`dashboard/check-deps-inestables.mjs` (`npm run check:deps`), que es una verificación y no un
comentario.

**Por qué es una trampa y no un problema resuelto.** El guardián sólo marca variables con
**fallback literal** (`|| []`, `? x : []`). `troncales/page.jsx:114` declara
`const astTrunks = ownTrunks;` donde `ownTrunks = trunks.filter(...)` — arreglo nuevo por
render, **sin fallback literal, invisible para el guardián**. ESLint sí lo ve y avisa en la
línea 134 que falta esa dependencia. Hoy el código funciona **porque `astTrunks` NO está en las
dependencias**. O sea: *el warning es correcto y el código es correcto a la vez*, y el único que
los concilia es quien lo escribió.

Si agregás `astTrunks` al arreglo de dependencias —que es exactamente lo que sugiere el mensaje
de ESLint— **tumbás `/troncales`**, que es la pantalla desde la que se administran las troncales.
Y `npm run check:deps` va a decir **OK**.

**Regla práctica.** Hay 31 warnings de `exhaustive-deps` en el panel y **no están clasificados**.
La auditoría los separó leyendo uno por uno: **4 tienen riesgo real** si se "arreglan"
(`troncales/page.jsx:134`, los dos de `historial/page.jsx:44`, `wallboard/page.jsx:51`), **1 es
una omisión deliberada** cuyo arreglo sería una regresión (`RecordingPlayer.jsx:93` no incluye
`dark` a propósito: incluirlo recrearía la instancia de wavesurfer al cambiar de tema y cortaría
la reproducción), y **el resto es ruido** (`router` de next/navigation, `setNodes`/`setEdges` de
React Flow — todos estables). **No arregles un `exhaustive-deps` de este panel sin entender en
cuál de las tres categorías cae.**

---

### Trampa 5 — El panel no debe afirmar lo que no midió

**Qué es.** Es un principio de diseño del panel, no un bug, y es de lo mejor que tiene. Está en
`dashboard/app/fmt.js:141`: *«inventar un verde sin haber medido es el bug original»*.

`estadoInfra()` y `estadoNodo()` no devuelven un color: devuelven
`{color, texto, detalle, **medido**}`. Y cuando no se midió, el texto dice **"no se puede
comprobar"** o **"no se pudo medir"** en gris, **nunca un verde de adorno**. Hay hasta un estado
amarillo para "apagado, pero todavía responde": *el interruptor está en OFF y el servicio sigue
contestando, quedó corriendo de antes*.

**De dónde salió.** Del incidente del TURN: el panel mostraba "TURN/STUN" en ON, el contenedor
coturn no existía, y `/api/ice` repartía la dirección de un relay que nadie corría. El toggle
decía la intención; nadie medía la realidad.

**Regla práctica.** Si agregás un indicador de estado al panel, tiene que poder decir "no sé".
Un badge que sólo sabe verde y rojo va a mentir el día que la fuente del dato no responda —y
además vas a diagnosticar el problema equivocado—.

El problema simétrico también existe y está medido: **la API a veces afirma lo que no aplicó**.
`POST /api/parking/apply` y `POST /api/moh/apply` devuelven **200 `{ok:true}` con Asterisk
completamente ausente**: el archivo se escribió, el `module reload` nunca llegó a ningún lado, y
el `GET` posterior lee la base y confirma el cambio. El propio `astconf.js` lo documenta en su
encabezado: *«sin el reload, el panel dice guardado y Asterisk sigue con lo de antes»*. El
contraejemplo correcto está en el mismo repo: `POST /api/calls/dial` devuelve **503** cuando ARI
no está, y hay una prueba que lo fija (`calls.test.js`). **Cuando escribas un endpoint que aplica
algo en Asterisk, copiá el patrón de `calls`, no el de `parking`.**

---

### Trampa 6 — Un desvío puesto desde el teléfono puede revertirse solo

**Qué pasa.** El camino "el usuario marca un código de función en el teléfono" escribe **primero
la AstDB** desde el dialplan y **después** avisa a la API por CURL (`telefonia.js:530-560`). Si
ese CURL no llega —la API reiniciando, colgada, o el token mal— la AstDB queda con el desvío
puesto y Postgres no se entera. El dialplan **no mira el resultado del CURL**: sigue derecho y le
locuta "activado" al usuario.

Y en el arranque siguiente, `syncFeatures()` vuelca Postgres → AstDB y **borra** lo que no está
en Postgres.

**Cómo se ve.** 18:00, el usuario del 1001 marca `*24*099123456` (sígueme al celular) justo
mientras se despliega una versión. El teléfono dice "activado" y locuta el número; el usuario se
va convencido. Las llamadas se desvían bien toda la noche. A la mañana siguiente se reinicia la
API por cualquier motivo, `syncFeatures()` ve `fm` en NULL para el 1001 y hace `astDel`. El
sígueme desaparece. **Nadie lo apagó, no hay log de que se haya borrado nada, y el panel siempre
mostró "sin sígueme"** porque el panel muestra Postgres.

**Por qué el diseño es así igual.** "Postgres es la fuente de verdad" es una decisión defendible
y es la que hace que el panel y el teléfono no se contradigan el resto del tiempo. Lo que no está
escrito en ningún lado es que **el camino del teléfono puede escribir sin llegar a la fuente de
verdad**. Ahora sí.

---

### Trampa 7 — El dialplan hace `CURL()` **bloqueante** y no hay ningún timeout configurado

**Qué pasa.** `${CURL(...)}` en el dialplan es **síncrono**: el canal no avanza hasta que vuelve.
Hay cuatro puntos del camino de la llamada que lo usan: el despertar de softphones
(`extensions.conf:130`), el PIN y el número de la DISA y del callback (`marcacion.js:141`), y el
aviso de cada código de función (`telefonia.js:114`).

Medido: **cero apariciones de `CURLOPT`, `curltimeout` o `conntimeout` en todo el repo**, y no
existe ningún `curl.conf` en `docker/config/asterisk/`. O sea que corren con el default interno
de `func_curl`, que **no se midió** (no hay Asterisk en el entorno de auditoría).

**Por qué importa más de lo que parece.** El diseño está pensado para la API **caída**: el CURL
vuelve vacío y la DISA rechaza la llamada, que es el lado seguro. No está pensado para la API
**lenta** —que es el caso frecuente: el proceso acepta la conexión TCP y no responde—. Ahí no hay
"vuelve vacío": hay un canal bloqueado, sin audio, con una persona del otro lado.

**Y esto es la regla de diseño número uno de la integración con el backoffice:** **el dialplan
nunca le pregunta al backoffice**. Le pregunta a PBX-NG, PBX-NG contesta de su propia caché con
un presupuesto de tiempo duro, y la consulta al sistema externo va **por afuera** del camino de
la llamada. Si tenés que agregar un `${CURL(...)}` nuevo, ponele `CURLOPT(conntimeout)` y
`CURLOPT(timeout)` explícitos y escribí al lado qué pasa cuando vence.

Hay un caso equivalente del lado de Node y ya está medido: `crmLookup()` en `ai-pipeline.js:133`
hace `fetch()` **sin timeout** y se lo espera con `await` dentro del turno de una conversación en
curso. Se verificó que `fetch` de Node 22 contra un servidor que acepta la conexión y no responde
**no aborta a los 90 s**. El resto del proyecto sabe hacerlo bien (19 usos de
`AbortSignal.timeout`); la única que corre con alguien hablando del otro lado es la que no lo
tiene.

---

### Trampa 8 — Hay dos árboles de configuración de Asterisk y uno está viejo

**Qué pasa.** Existen `docker/config/asterisk/` (**el que copia el Dockerfile, el que corre**) e
`infra/asterisk/` (el árbol previo a Docker). Medido: 4 archivos idénticos, **5 distintos** y 5
que sólo existen en `infra/`. `extensions.conf` tiene **87 líneas contra 194**: al de `infra/` le
faltan el aparcado, la captura de llamada, el guardia `__SALTOS` y todo el bloque de
desvíos/DND/sígueme, y su `*97` es la versión vieja **sin el guard por `CHANNEL(endpoint)`** —o
sea, la que permite entrar al buzón de otro poniendo su número en el `From`—. `modules.conf` no
tiene ni uno de los siete `require =`.

El árbol de `infra/` es más corto y está en una ruta de nombre más obvio, así que es el que uno
abre primero. No hay ningún README ahí que diga cuál manda.

**Regla práctica: el que corre es `docker/config/asterisk/`.** Si modificás algo en
`infra/asterisk/`, no llega a ninguna parte.

---

### Trampa 9 — No editar el árbol mientras corre un trabajo en paralelo

Ya está en §5 pero se repite acá porque es de las que cuestan una tarde: un módulo a medio
cablear fue leído como bloqueante por quien revisaba, y otro lo borró. Lo que haya que tocar
mientras alguien más trabaja se escribe aparte y se integra cuando el árbol queda libre.

---

### Lista corta de "no toques esto todavía"

Cosas que están bien resueltas y cuyo rediseño reintroduce un problema que ya se pagó:

| Qué | Por qué |
|---|---|
| `control-plane/rbac.js` | tabla única, **deny-by-default**, primera coincidencia gana. Una ruta nueva agregada sin pensar en permisos queda **cerrada**, no abierta. Es la propiedad que más te conviene cuando entra un equipo que no conoce el producto |
| `control-plane/errores.js` | una sola regla: el cliente recibe `{error}` en castellano y **nunca** un mensaje crudo de Postgres. Traduce SQLSTATE a status con criterio (23505→409, 57014→504). Se usa en 314 lugares |
| el gate de auth de `auth.js:125-158` | deny-by-default con allowlist pública explícita, y cada entrada no obvia tiene escrito **por qué** es pública. Incluye el razonamiento de por qué "red privada" no servía de filtro |
| el guard de `/api/internal/*` | loopback estricto + rechazo si hay cabecera de proxy + token comparado en tiempo constante. Es el modelo a copiar para cualquier integración nueva que llame el dialplan |
| `dueno-internal.js` | el candado del contexto compartido (trampa 1). Extenderlo, no reescribirlo |
| `filasSalida()` de `trunks.js` | el failover de troncales (§4.3) |
| el cierre por `SIGTERM` (`app.js:2346-2382`) | deja de aceptar conexiones, cierra socket.io y ARI/AMI ordenadamente, espera al pool y **fuerza la salida a los 15 s** si algo se traba |
| `asterisk-drain.sh` | entiende que del otro lado hay gente hablando: `core stop gracefully`, espera acotada, y para el contenedor a propósito para que `restart: unless-stopped` no lo reviva aceptando llamadas |
| `migrate.js` | transaccional por archivo, `pg_advisory_lock`, y **sale con 1** para que el contenedor no arranque con esquema viejo |
| `test/helpers/db.js` | el arnés de pruebas. Escribir una prueba nueva cuesta minutos porque esto ya está hecho |

---

## 7. Reglas de la casa

- **El repo es la única fuente de verdad.** Nada se parchea en producción a mano ni con
  `docker cp`: el cambio va al repo → imagen versionada → `deploy.sh`.
- **Cambios de esquema = una migración nueva** `control-plane/migrations/000N_*.sql`. **Una
  migración ya aplicada no se edita, se agrega otra.** Aviso importante: `migrate.js` **calcula
  y guarda un checksum de cada archivo y nunca lo compara** (medido: editar una migración ya
  aplicada y correr `migrate.js` reporta "DB al día", con código de salida 0 y la columna nueva
  inexistente). O sea que la regla hoy la hace cumplir la disciplina, no la herramienta.
- **La config de Asterisk que genera el panel** va al patrón `pbxng.d/` (volumen `asterisk_conf`
  + `#include`), **nunca** editando los `.conf` base.
- **Todo configurable desde el panel.** Nada hardcodeado de una instalación: ni IPs, ni nombres
  de cliente, ni credenciales.
- **Comentarios y textos de UI en español rioplatense**, y explicando el **porqué**, no el qué.
  El repo está lleno de comentarios que cuentan el incidente que motivó una línea; ese estilo es
  la mejor documentación de dominio que hay acá y conviene mantenerlo.
- **Commits en español, imperativo, con el área adelante** (`telefonia: …`, `seguridad: …`).
  Toda entrada relevante va a `CHANGELOG.md`.
- **Antes de terminar:** `node --check` de cada `.js` tocado, `npm run build` si tocaste el
  panel, `bash -n` si tocaste shell.
- **Si tu cambio toca el contrato** (endpoints, roles, eventos de socket, variables, volúmenes,
  quién publica en `internal`), **actualizá `docs/CONTRATOS.md` en el mismo commit**. Un
  contrato que se actualiza "después" miente justo cuando hay varias personas leyéndolo.

---

## 8. Contradicciones entre documentos (sin resolver)

Encontradas al escribir esto, verificadas contra el código. **No se eligió una versión**, porque
cuál se elija cambia lo que ustedes van a leer. Quedan para que las decida el dueño del producto.

1. **`CONTRATOS.md` se contradice consigo mismo sobre la migración 0014.** §9 dice que «le pone
   un PIN al azar a las salas viejas que no tenían»; la sección de Salas del **mismo documento**
   dice, en negrita, que **«la migración 0014 *no* les pone PIN: no toca ninguna fila de
   `pbxng_conferences`»**. El archivo `migrations/0014_salas_reunion.sql` confirma la segunda
   versión y dedica 28 líneas a explicar por qué se sacó ese `UPDATE`. §9 quedó de una versión
   anterior. Importa porque §9 es la sección que vas a leer para contestarle a un cliente
   "¿mis salas viejas quedaron protegidas?".
2. **Cuánto tarda `npm test`.** El README dice «~20 s»; la auditoría lo midió tres veces en
   **~44 s**. No cambia nada operativo, pero si esperás 20 s vas a pensar que algo se colgó.
3. **El instalador y el "todo en un contenedor".** El README (Opción B) dice que «el instalador
   lo ofrece como opción» y `PACKAGING.md` lo llama «`install.sh` opción 2». Verificado: el menú
   de `install.sh` es `1) all` / `2) core`, y **nada construye `Dockerfile.allinone`** (cero
   apariciones de `allinone` en `install.sh` y en los compose). El all-in-one existe como
   Dockerfile y se construye a mano.
4. **Cuántas rutas tiene la API.** `CONTRATOS.md` §3 declara **285**; las nueve auditorías
   midieron entre 269 y 352 según el método (¿se cuenta `app.use`? ¿se colapsan los `:id`?
   ¿se cuentan las rutas fuera de `/api`?). La verificación propia de la auditoría dio **346
   pares método+path únicos bajo `/api`**. Hay que fijar **una** definición y escribirla, porque
   el número de `CONTRATOS` hoy no lo puede reproducir nadie.
5. **`VERSION` dice `1.11.0`, el último commit se llama `1.11.1`, y `CHANGELOG.md` no tiene
   entrada para 1.11.1.** Además el repo **no tiene ni un tag git**, mientras `RELEASE.md:10`
   exige que `VERSION` y el tag `vX.Y.Z` coincidan. O sea que el proceso de release documentado
   nunca se ejecutó como está escrito. Si necesitás saber qué versión es la buena, preguntá: no
   se puede deducir del repo.

Las contradicciones **entre las secciones de la auditoría** (conteos de rutas, de pruebas, de
`catch` vacíos, de `fetch` sin timeout) están listadas en `AUDITORIA-ENTREGA.md` §6, también sin
resolver. Ninguna cambia una conclusión; todas cambian un número.

---

## 9. Dónde seguir leyendo

| Documento | Para qué |
|---|---|
| [`CONTRATOS.md`](CONTRATOS.md) | **el más importante después de éste.** Endpoints por familia, roles y la tabla de permisos, eventos de socket, variables de entorno, volúmenes, migraciones, y quién publica en `internal`. Es el acuerdo que todos respetan |
| [`AUDITORIA-ENTREGA.md`](AUDITORIA-ENTREGA.md) | qué falta para que esto sea un contrato público, medido y priorizado. §4 («lo que está bien y NO hay que tocar») es tan importante como §2 |
| [`ARI-AMI.md`](ARI-AMI.md) | qué depende de ARI y qué de AMI, con el detalle por función |
| [`EVALUACION-2026-09.md`](EVALUACION-2026-09.md) | la deuda que el equipo ya conocía antes de la auditoría |
| [`FIREWALL.md`](FIREWALL.md) | **no es un anexo.** La señalización suele pasar sola; el audio (RTP, UDP en rangos altos) es lo primero que se rompe. Trampas de NAT, port-forward incompleto, hairpin, y cómo leer un error ICE `701` frente a un `401` |
| [`TOPOLOGY.md`](TOPOLOGY.md) | las topologías de despliegue soportadas |
| [`PACKAGING.md`](PACKAGING.md) | módulos, perfiles, contenedores, y cómo reproducir cada job de CI a mano |
| [`RELEASE.md`](../RELEASE.md) | versionado, release y el procedimiento de rollback (con la advertencia de §8.5) |
| [`PLAN-PRUEBAS.md`](PLAN-PRUEBAS.md) | el plan de pruebas |
| [`BRECHA-UCM-XORCOM.md`](BRECHA-UCM-XORCOM.md) | comparación funcional con la competencia: sirve para entender por qué existen varias funciones |
| `.claude/agents/*.md` | qué hace cada rol y cuál es su borde |
| `docs/db-schema.reference.sql` | el esquema de referencia |

Y la recomendación concreta para el primer día: **abrí
`docker/config/asterisk/extensions.conf` y leelo entero.** Son 194 líneas y la mitad son
comentarios que cuentan qué se rompió y por qué la línea de abajo está escrita así. Es el
camino más corto para entender este producto.
