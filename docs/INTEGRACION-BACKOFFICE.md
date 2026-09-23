# PBX-NG · Integración bidireccional con un backoffice

Este documento es el **contrato de integración** entre PBX-NG y un software de gestión
backoffice externo. Está escrito para un equipo que **no conoce telefonía ni este producto**:
todo lo que afirma acá está verificado en el código del repositorio, y lo que no se pudo medir
está marcado como tal.

No es documentación de arquitectura (eso es `docs/CONTRATOS.md`) ni el inventario de deuda
(eso es `docs/EVALUACION-2026-09.md`). Acá se define **qué va a existir entre los dos sistemas**:
qué eventos emite la central, qué operaciones acepta, cómo se autentica cada lado, cómo se
entrega un evento cuando el otro lado no está, y cuánto tiempo puede tardar cada cosa.

**Advertencia de lectura.** Una parte importante de lo que sigue **todavía no existe**. Cada
sección separa explícitamente **lo que ya está en el repo** de **lo que hay que construir**,
con esfuerzo estimado. Si una sección no dice "ya existe", asumí que no existe.

---

## 0. Resumen ejecutivo: el estado de hoy

| Pieza del contrato | Estado | Dónde está / qué falta |
|---|---|---|
| Operaciones que el backoffice **ordena** | **Parcial, existe** | `callengine.js` expone dial, hangup, hold, unhold, transfer (a ciegas), park, spy, `calls/live`. Alta/baja de internos, CDR y grabaciones también. |
| Eventos que la central **emite** | **No existe** | 6 `emit()` de socket.io en todo `control-plane/`, ninguno de negocio. No hay `call.started`, `call.ended` ni `recording.ready`. |
| Entrega confiable (cola, reintento, orden) | **No existe** | No hay outbox, no hay reintentos, no hay backoff, no hay acuse. |
| Identidad estable de llamada | **No existe en la API** | `cdr` tiene `uniqueid` y `linkedid`; `GET /api/cdr` devuelve 12 columnas y **ninguna de las dos**. |
| Autenticación de **sistemas** | **No existe** | Sólo JWT de persona (12 h) y token de teléfono (30 d). Cero credenciales de máquina fuera de `/etc/pbxng/agent.token`, que sólo sirve desde loopback. |
| Revocación de credenciales | **No existe** | `auth()` es `jwt.verify` y nada más. Cero `jti`, `token_version`, denylist. |
| Versionado de API | **No existe** | Cero rutas bajo `/api/v1` sobre ~346 registros de ruta. |
| Idempotencia de escrituras | **No existe** | Cero soporte de `Idempotency-Key` en toda la API. |
| Paginación / rango de fechas | **No existe** | `GET /api/cdr` acepta `limit` (tope 500) y `ext`. Sin `from`/`to`, sin cursor. |
| Firma de webhooks salientes | **No existe** | El único saliente configurable es `crm_webhook` de los agentes IA: sin firma, sin timeout, sin reintento. |
| Contrato legible por máquina (OpenAPI) | **No existe** | Deuda ya anotada en `docs/EVALUACION-2026-09.md` §4. |
| Presupuesto de tiempo del camino de la llamada | **No existe** | Cero `CURLOPT`, `curltimeout` o `conntimeout` en todo el repo; no hay `curl.conf`. |

**Esfuerzo total del camino completo: 6 a 9 semanas de un desarrollador.** Las primeras dos
(identidad de llamada + outbox + credencial de sistema) **no se pueden paralelizar**: todo lo
demás cuelga de ellas.

### Deuda que ya estaba anotada (no la contamos como descubrimiento)

- «API pública + webhooks: no existe» — `ROADMAP.md`, tabla de brechas.
- «webhooks/CTI (screen-pop al CRM propio o a uno externo)» y «documentación de API (OpenAPI)
  para integradores» — `docs/EVALUACION-2026-09.md` §4.
- El techo del pool de Postgres compartido con los `CURL()` del dialplan — `docs/CONTRATOS.md` §6.

Lo que este documento agrega sobre eso es **la forma del contrato** y los tres bloqueos de
diseño de la §1, §2 y §3, que hay que resolver **antes** de escribir código.

---

## 1. Regla no negociable: el camino de la llamada nunca espera al backoffice

Esta es la regla de la que depende todo lo demás, y es la que más fácil se rompe por accidente.

**Una llamada telefónica nunca se cae ni se demora porque el backoffice tardó.**

### Lo que hay hoy, medido

- El dialplan ya hace consultas HTTP **bloqueantes** en el camino de la llamada. El paso `wake`
  de `[internal]` (`docker/config/asterisk/extensions.conf:130`) hace
  `Set(WAKE=${CURL(http://@@API_URL@@/api/internal/wake?...)})`: el canal no avanza hasta que ese
  CURL vuelve. Hay otros tres puntos así (DISA y callback en `marcacion.js`, códigos de función
  en `telefonia.js`).
- **Cero apariciones de `CURLOPT`, `curltimeout` o `conntimeout` en todo el repositorio**, y no
  existe `docker/config/asterisk/curl.conf`. Esos CURL corren con el default interno de
  `func_curl`, que **no se pudo verificar desde este repo** (no hay Asterisk en el entorno de
  auditoría).
- Del lado de la API hay un caso vivo del mismo error: `crmLookup()`
  (`control-plane/ai-pipeline.js:133-141`) hace `fetch()` al webhook del CRM **sin `signal` ni
  `AbortSignal.timeout`**, y se lo espera con `await` dentro del turno de una conversación en
  curso (`ai-pipeline.js:204` y `:214`). Medido: `fetch()` de Node v22 contra un servidor que
  acepta la conexión TCP y nunca responde **no aborta a los 90 s**. El que llamó escucha silencio
  y corta; en el CDR la llamada queda como atendida y de duración normal.
- El patrón institucional del repo empuja en la dirección contraria: `internal/disa` está
  diseñado para que **si la API no contesta, el CURL vuelve vacío y la llamada se rechace**.
  Ese *fail-safe* es correcto para un PIN y sería catastrófico para un screen-pop.

### Lo que hay que construir

**Presupuesto duro: 200 ms** para cualquier consulta que el dialplan haga, medidos en Asterisk,
no en la API.

1. **Timeouts explícitos en el dialplan.** `curl.conf` con `conntimeout=1` y `timeout=1` como
   piso global, más `Set(CURLOPT(conntimeout)=1)` / `Set(CURLOPT(timeout)=1)` explícito en cada
   camino. Sin esto, todo lo demás de esta sección es teoría. *(pedido a `telefonia` y
   `empaquetado`)*
2. **El dialplan NUNCA habla con el backoffice.** Le pregunta a PBX-NG
   (`POST /api/internal/lookup`, con el mismo candado de tres llaves que ya usa `internal/disa`,
   ver §7), y PBX-NG contesta **sólo desde una caché local en Postgres** con un SELECT por clave
   primaria. Si la caché no tiene el número, contesta vacío **en el acto** y encola la consulta
   al backoffice por afuera.
3. **Al vencer el presupuesto, la llamada sigue.** El dialplan hace `ExecIf` sobre el resultado,
   nunca `GotoIf` a un rechazo: **vacío significa «sin ficha», jamás «cortá»**. Esta es la
   excepción explícita al *fail-safe* de la DISA y **tiene que quedar escrita en
   `docs/CONTRATOS.md` §2**, porque el próximo que toque el dialplan la va a romper si no la ve.
4. **El screen-pop rico va por socket.io al panel del agente, después.** La pantalla puede tardar
   tres segundos; la llamada no.
5. **Ninguna llamada saliente desde el camino de audio sin timeout explícito.** Regla de
   contrato, escrita, para que el equipo externo no la repita cuando agregue sus integraciones.

**Esfuerzo:** días (los timeouts, horas; la caché y el endpoint de lookup, días).

---

## 2. Identidad de la llamada: `call_id` y `leg_id`

**Bloqueo. Sin esto no hay idempotencia, ni orden, ni conciliación, ni forma de ligar un evento
a una fila del CDR.**

### Lo que hay hoy, medido

- La tabla `cdr` tiene `uniqueid varchar(150)` y `linkedid varchar(150)`
  (`docker/config/initdb/01-schema.sql:568-569`).
- `GET /api/cdr` (`control-plane/recordings.js:276`) devuelve exactamente 12 columnas:
  `start, clid, src, dst, dcontext, duration, billsec, disposition, channel, dstchannel,
  lastapp, lastdata`. **Ninguna de las dos de correlación.**

### La decisión que hay que tomar primero

No es «agregar un campo»: hay que decidir qué es una llamada, y la respuesta cambia el
significado de todos los eventos.

- **`call_id` = `linkedid`.** Sobrevive a transferencias y agrupa las patas `Local/` de la misma
  conversación. Es lo que el backoffice quiere: una llamada, un ticket.
- **`leg_id` = `uniqueid`.** Una pata concreta del canal.
- **Todo evento lleva los dos.**

Sin esto, el equipo externo va a inventar una clave con `src + dst + timestamp`, que colisiona
apenas dos agentes del mismo grupo llaman al mismo número en el mismo segundo.

### Cómo falla hoy, concreto

Entra una llamada, el agente la transfiere, termina. Con `linkedid` eso es **una** llamada; sin
él, el backoffice ve dos filas de CDR sin relación y factura dos veces o descarta una.

### Lo que hay que construir

1. Agregar `uniqueid` y `linkedid` al SELECT de `GET /api/cdr`. **Esfuerzo: horas.**
2. `GET /api/v1/llamadas/:call_id` que devuelva la llamada entera —todas las patas— como una
   sola cosa. **Esfuerzo: días.**
3. `evento_id = sha256(tipo + ':' + call_id + ':' + secuencia)`, determinístico, para que un
   reintento genere **exactamente la misma clave** y el backoffice pueda hacer un UPSERT.

**Publicar en el contrato: la entrega es _at-least-once_, nunca _exactly-once_. El backoffice
DEBE deduplicar por `evento_id`.**

---

## 3. Eventos que emite la central

### Lo que hay hoy, medido

Las **fuentes** ya están y no hay que inventar nada:

- `control-plane/callengine.js:57-63` ya recibe de ARI: `ChannelCreated`, `ChannelStateChange`,
  `ChannelCallerId`, `ChannelConnectedLine`, `ChannelDestroyed`, `EndpointStateChange`,
  `DeviceStateChanged`.
- `control-plane/app.js:2039` y `:2057` ya procesan `DialBegin` y `DialEnd` del AMI, este último
  con `dialstatus`.
- `control-plane/guard.js:392,523` ya dispara `security.ban` y `security.attack`.
- `control-plane/ccreport.js` ya mapea `QueueCallerJoin`, `AgentConnect`, `AgentComplete`,
  `QueueCallerAbandon`, `AgentRingNoAnswer`.

Lo que **no** hay es la cañería. Los 6 `emit()` de socket.io de todo `control-plane/` son
`snapshot` (×2), `sec:ev`, `sec:hist`, `scratch:op`, `scratch:clear`. **Ninguno es un evento de
llamada.**

**El socket.io existente NO sirve como bus de integración**, y conviene decir por qué para que
nadie lo intente:

- Emite un **estado completo** (`snapshot`: extensions + channels + queues), no transiciones
  discretas.
- `broadcast()` hace `if (busy) return` (`app.js:1990`): si hay un snapshot en vuelo, **el
  siguiente se saltea entero**. Un consumidor externo no vería la transición, vería un estado
  nuevo sin saber qué pasó en el medio.
- No tiene número de secuencia, ni replay, ni acuse.
- Exige un JWT de panel para conectarse.

### El catálogo: siete tipos, y sólo siete

**Sobre público, idéntico para todos** (un solo parser del otro lado):

```json
{
  "evento_id": "sha256 determinístico",
  "tipo": "llamada.contestada",
  "version": 1,
  "ts": "2026-09-23T14:32:11.482Z",
  "call_id": "<linkedid>",
  "leg_id": "<uniqueid>",
  "secuencia": 2,
  "datos": { }
}
```

`version` es **por tipo**, no global: así se puede evolucionar un evento sin tocar el resto.

| Tipo | Fuente en el repo | `datos` |
|---|---|---|
| `llamada.entrante` | ARI `ChannelCreated` + AMI `DialBegin` | `origen`, `origen_nombre`, `destino`, `troncal`, `ruta`, `interno_destino` |
| `llamada.contestada` | ARI `ChannelStateChange` a `Up` / `AgentConnect` | `interno`, `agente`, `espera_s` |
| `llamada.terminada` | AMI `Hangup` / `DialEnd` | `disposicion`, `duracion_s`, `habla_s`, `causa_colgado`, `quien_colgo` |
| `llamada.transferida` | ARI | `de_interno`, `a_destino`, `tipo: "ciega"` |
| `grabacion.lista` | indexador de `recordings.js` | `grabacion_id`, `url`, `duracion_s`, `bytes` — **bloqueado, ver §6** |
| `interno.registrado` / `interno.desregistrado` | ARI `EndpointStateChange` | `interno`, `estado` |
| `seguridad.ataque` | `guard.js` | `ips`, `intentos`, `ventana_min`, `pais` |

Notas de diseño que **no** son opcionales:

- **`disposicion` reusa los valores del CDR** (`ANSWERED` / `NO ANSWER` / `BUSY` / `FAILED` /
  `CONGESTION`): ya son el vocabulario de la casa y el backoffice va a cruzar contra el CDR.
- **`interno.registrado` lleva debounce de 5 s.** Un teléfono con red mala hace *flapping* y no
  hay que contarlo cuarenta veces por minuto.
- **`seguridad.ataque` va agregado y con throttle**, copiando el criterio que `alerts.js` ya
  aplica al correo: un ataque real son cientos de baneos y el backoffice no quiere cientos de
  webhooks.
- **Cada tipo se suscribe por separado.** Si el backoffice sólo quiere llamadas terminadas, no le
  mandamos cuarenta eventos de registro por minuto.

**Esfuerzo:** semanas (el catálogo y los emisores; depende de §2 y §4).

---

## 4. Entrega confiable: outbox, reintentos, orden

**Bloqueo. Hoy no existe cola, ni reintento, ni backoff, ni persistencia.**

### Lo que hay hoy, medido

- Lo único parecido a un webhook es `crmLookup()` (`ai-pipeline.js:133`): un POST sin timeout,
  sin reintento, sin firma y sin clave de idempotencia, cuyo error se traga un `catch (_)`.
- `notifyIntegrations()` llama a `sendTelegram` / `sendWhatsapp`, que también van **sin
  `AbortSignal`**. Medido: de 34 llamadas `fetch()` en `control-plane/`, **18 no tienen timeout
  de ningún tipo**. Las otras 16 sí lo tienen: el equipo conoce el patrón, simplemente no está
  aplicado parejo.
- El pool de Postgres es de **10 conexiones** (`PG_POOL_MAX`, `app.js:144`) y es **el mismo** que
  usan los `CURL()` del dialplan. `docs/CONTRATOS.md` §6 ya describe en prosa el escenario en el
  que la DISA empieza a rechazar PINes correctos porque el pool está tomado.

### El precedente que hay que copiar, no reinventar

**`control-plane/ccreport.js:125-200` ya resolvió exactamente este problema** para los eventos de
cola: encolar en memoria sin tocar el pool, volcar en un INSERT multi-fila cada `CC_LOTE_MS`
(2000 ms), de a uno por vez (`volcando`), buffer con tope (`CC_LOTE_TOPE`, 2000 filas) y descarte
con aviso a lo sumo una vez por minuto. **Techo declarado y cumplido: 1 conexión de las 10, 1
adquisición cada 2 s**, pase lo que pase.

La frase de `docs/CONTRATOS.md` —«ninguna pieza nueva puede escribir en la base al ritmo de las
llamadas sin una cota así»— es la regla que hace que esta integración sea posible sin romper la
central. **El outbox debe copiar ese mecanismo literalmente.**

### Lo que hay que construir

1. **Tabla `pbxng_eventos_salida`**: `evento_id` (PK), `tipo`, `call_id`, `secuencia`,
   `payload jsonb`, `creado_at`, `intentos`, `proximo_intento_at`, `estado`, `ultimo_error`.
   La unicidad de `evento_id` la garantiza Postgres, que es lo que Postgres hace bien.
2. **El productor encola en memoria y no toca el pool.** Los handlers de ARI/AMI hacen lo mismo
   que `encolar()` de `ccreport.js:149`. Volcado en INSERT multi-fila cada `EV_LOTE_MS` (2 s),
   tope `EV_LOTE_TOPE` con descarte y aviso en el log una vez por minuto.
3. **Worker separado**, concurrencia 1 por destino, que lee un lote ordenado por
   `(call_id, secuencia)`. **Orden POR LLAMADA, no orden global**: el orden global no escala y
   nadie lo necesita.
4. **Backoff exponencial con jitter**: 1 s, 2 s, 4 s… tope 5 min, máximo 12 intentos (≈1 h).
   **Timeout de 10 s por intento, no negociable.**
5. **Retención**: entregados se borran a los 7 días; no entregados se conservan 72 h y después se
   marcan `vencido` y disparan `alerts.raise('backoffice.cola_vencida')` — el motor de alertas ya
   existe y ya sabe no inundar.
6. **Tope de cola** (`EV_COLA_TOPE`, sugerido 100k filas): al superarlo se descarta el evento
   **más viejo no entregado** y se alerta. **Nunca se frena al productor.**

### Qué pasa cuando el backoffice se cae

Es el caso que decide si esto es entregable, así que conviene dejarlo escrito:

- Los eventos se acumulan en el outbox; **nada se pierde** mientras la cola no venza.
- El worker reintenta con backoff. La central **sigue cursando llamadas sin degradarse**: el
  worker no compite por el pool más allá de su cota.
- A las 72 h los eventos vencen, se marcan y **se alerta**. El modo de falla silencioso y diferido
  es el peor posible para un producto que se entrega a un tercero.
- Al volver, el backoffice recibe el backlog en orden por llamada y **deduplica por `evento_id`**.

**Escribir el techo del outbox en `docs/CONTRATOS.md` §3, igual que se escribió el de
`ccreport`.** *(pedido a `api`, con actualización de contrato)*

**Esfuerzo: semanas.** Es la pieza más grande y la que bloquea todo el sentido «la central avisa».

---

## 5. Operaciones que el backoffice ordena

### Lo que hay hoy, medido

El sentido backoffice → central está **mejor de lo esperado**. `control-plane/callengine.js`
ya expone:

| Ruta | Línea |
|---|---|
| `GET /api/calls/live` | 154 |
| `POST /api/calls/dial` | 157 |
| `POST /api/calls/:id/hangup` | 163 |
| `POST /api/calls/:id/hold` / `/unhold` | 164, 165 |
| `POST /api/calls/transfer` (a ciegas) | 166 |
| `POST /api/calls/park` | 167 |
| `GET` / `POST` / `DELETE /api/calls/spy` | 169-171 |

Más el alta/baja de internos (`POST` / `DELETE /api/endpoints`), la lectura del CDR y de
grabaciones, y el CRM (`/api/clients`).

Y hay un contrato de degradación honesta que **ya está bien hecho y hay que conservar**:
`POST /api/calls/dial` devuelve **503** cuando ARI no está, no un 200 mentiroso, y
`test/calls.test.js` lo fija.

### Lo que falta

**Ninguna escritura es idempotente.** Cero soporte de `Idempotency-Key` en toda la API.

Tres casos medidos y sus consecuencias:

1. `POST /api/calls/dial`: la API origina el canal, la respuesta se pierde por un timeout de red,
   el cliente HTTP del backoffice **reintenta como reintenta cualquier cliente HTTP razonable**.
   Sale un segundo canal. **Dos tramos facturados por una sola intención**, y el destino suena dos
   veces.
2. `POST /api/endpoints` reintentado sobre un id existente cae en el
   `ON CONFLICT (id) DO UPDATE SET password=EXCLUDED.password` de `ps_auths`
   (`app.js:114` y `:698`) y **rota la contraseña SIP de un interno que estaba funcionando**: el
   teléfono se desregistra y el usuario se queda sin línea hasta que alguien reaprovisione.
3. `POST /api/clients` es un INSERT pelado, y `pbxng_clients` **no tiene ninguna restricción
   UNIQUE** (verificado en `docs/db-schema.reference.sql`): cada reintento crea un duplicado que
   nada impide ni detecta después.

**Transferencia atendida** no existe (sólo a ciegas). Ya está anotado como faltante en
`docs/EVALUACION-2026-09.md` §4.

### Lo que hay que construir

1. **`Idempotency-Key` obligatoria en toda escritura de `/api/v1`.** Tabla
   `pbxng_idempotencia (clave PK, client_id, ruta, hash_cuerpo, respuesta jsonb, creado_at)`,
   retención 24 h. Misma clave + mismo cuerpo → se devuelve la respuesta guardada **sin
   re-ejecutar**; misma clave + cuerpo distinto → `409`. **Es una sola pieza de middleware y
   cubre todas las familias de una vez.** **Esfuerzo: días.**
2. **Guarda propia para originar**: rechazar con 409 un originate hacia el mismo `(from, to)` con
   un canal activo de menos de N segundos. Protege también contra un bucle mal escrito del otro
   lado.
3. **Devolver el `call_id` en la respuesta de originar** y aceptar consulta por
   `Idempotency-Key`, para que el backoffice que perdió la respuesta pueda preguntar «¿qué pasó
   con mi pedido?» en vez de reintentar a ciegas.
4. **`POST /api/v1/llamadas/:call_id/transferir` con `tipo: "atendida"`** sobre ARI
   (`bridges.create` + `channels.originate`): el módulo ya hace exactamente eso para la
   supervisión con snoop. **Esfuerzo: semanas.**
5. **Descarga de grabación con enlace firmado de corta vida**, para que el backoffice pueda
   embeberlo en su propia UI sin filtrar la credencial al navegador.

---

## 6. Grabaciones: hoy no se pueden ligar a la llamada

**Bloqueo para el evento `grabacion.lista`.**

### Lo que hay hoy, medido

- El dialplan graba a `pbxng-${EXTEN}-${EPOCH}.wav`
  (`docker/config/asterisk/extensions.conf:142`).
- La tabla `pbxng_recordings` **tiene una columna `linkedid`**
  (`01-schema.sql:1955`) y el INSERT del indexador (`recordings.js:300`) escribe 9 columnas
  y **`linkedid` no está entre ellas**. Cero apariciones de `linkedid` en `recordings.js`.
- La correlación real es una heurística: `WHERE (src=$1 OR dst=$1) AND
  abs(extract(epoch from start) - $2) < 300` (`recordings.js:293`), o sea **±5 minutos por
  extensión**.

### Cómo falla, concreto

Un interno hace tres llamadas entre las 10:00 y las 10:04, las tres grabadas. El indexador
levanta el WAV de la segunda y busca la fila de CDR más cercana dentro de ±300 s. Como el
MixMonitor arranca **después** del Dial, el `EPOCH` del archivo y el `start` del CDR difieren, y
le puede adjudicar el `src`/`dst` de otra llamada. Para el backoffice eso es
**`grabacion.lista` con el `call_id` de otra llamada**: el agente abre la grabación de un reclamo
y escucha otra conversación. En un call center eso es un incidente de privacidad.

### Lo que hay que construir

1. **Meter el id en el nombre del archivo**, que es el único lugar donde Asterisk lo puede poner
   sin ambigüedad: `MixMonitor(pbxng-${EXTEN}-${UNIQUEID}-${EPOCH}.wav,b)`.
   *(pedido a `telefonia`)*
2. El indexador parsea el `uniqueid` del nombre y escribe `linkedid` y `uniqueid` en
   `pbxng_recordings` (la columna ya está). **El regex actual
   `^pbxng-([0-9A-Za-z]+)-(\d+)\.wav$` debe aceptar AMBOS formatos durante la transición**, o el
   indexador deja de ver las grabaciones viejas en silencio.
3. **Decisión explícita sobre el histórico: no hacer backfill.** La heurística de ±300 s no se
   puede mejorar retroactivamente. Marcar las filas viejas con `correlacion: 'heuristica'` y
   exponer ese campo en el contrato, para que el backoffice sepa cuáles no puede confiar. **Ese
   campo vale más que un backfill inventado.**

**Esfuerzo: días.**

---

## 7. Autenticación: los dos sentidos

### 7.1 Backoffice → central (entrante)

**Lo que hay hoy, medido.** Todo lo que emite credenciales emite credenciales de **persona** o de
**teléfono**. `jwt.sign` aparece 4 veces en `control-plane/`:

- `auth.js:213` — sesión de panel, `expiresIn: '12h'`, emitida contra una fila de
  `pbxng_users` con usuario y contraseña de un humano.
- `auth.js:263`, `:334`, `:406` — token de softphone, `scope: 'phone'`, `expiresIn: '30d'`,
  acotado a una extensión.

**No hay un tercer tipo.** La única credencial de máquina es `/etc/pbxng/agent.token`, y
`soloDesdeLaCentral()` (`marcacion.js:134-139`) exige **loopback** y **ausencia de
`X-Forwarded-For` / `X-Real-IP`**: un backoffice en otro host queda afuera **por diseño**, no por
accidente.

Tampoco hay revocación: `auth()` es `jwt.verify` y nada más; cero `jti`, `token_version`,
denylist. Borrar el usuario, bajarle el rol o cambiarle la contraseña **no invalida nada**.

**Cómo falla, concreto.** Día 1 de la integración: el backoffice necesita llamar
`/api/calls/dial`. Hoy sólo puede con un JWT de panel; el de admin vence en 12 h y no hay refresh
token, así que el equipo externo guarda usuario y contraseña de un admin en su configuración.
A partir de ahí:

- Las credenciales de administración de la central viven en la base del backoffice.
- Toda la actividad queda registrada como esa persona: **la auditoría no puede separar «lo hizo
  Juan» de «lo hizo el backoffice»**.
- Cuando esa persona se va y le borran el usuario, el token vigente **sigue funcionando hasta
  12 h** porque no hay denylist, y después la integración se cae sin aviso.
- No se puede cortarle el acceso al backoffice sin dejar afuera también a la persona.
- El token abre **todas** las rutas, incluido `GET /api/backup` (el respaldo completo de la
  central) — porque el RBAC tiene tres roles pensados para personas y lo que no está en la tabla
  cae a `admin`.

**Lo que hay que construir.**

1. **Tabla `pbxng_api_clients`**: `id`, `nombre`, `secret_hash` (bcrypt), `scopes text[]`,
   `enabled`, `creado_at`, `ultimo_uso_at`, `revocado_at`, `rotado_at`.
2. **`Authorization: Bearer pbxng_<id>_<secreto>`**, verificado con `crypto.timingSafeEqual`.
   **El patrón ya está escrito en `tokenOk()` (`marcacion.js:129-133`): se reusa, no se
   reescribe la comparación en tiempo constante.**
3. **`auth()` verifica contra la tabla, no sólo la firma**, para que **revocar sea un UPDATE** y
   tenga efecto en la petición siguiente, no dentro de 12 h.
4. **Scopes, no roles**: `llamadas:leer`, `llamadas:operar`, `internos:administrar`, `cdr:leer`,
   `grabaciones:bajar`, `eventos:suscribir`. **Se agregan a `rbac.js` como un sujeto más
   (`req.client`), respetando el deny-by-default que ya tiene.** No hacer un segundo sistema de
   permisos al lado: la propiedad valiosa de `rbac.js` es que una ruta nueva nace **cerrada**.
5. **Rotación sin corte**: dos secretos vivos a la vez (`secret_hash` + `secret_hash_prev`) con
   ventana de 30 días, y `POST /api/v1/clients/:id/rotate` que devuelve el nuevo **una sola vez**
   — mismo criterio que ya usa `vm_pin` en `POST /api/endpoints`.
6. **Rate limit y cuota por cliente**, con `429` y cabecera `Retry-After`.
   `express-rate-limit` ya es dependencia y ya se usa en el login. **El número se publica en la
   documentación: un límite que el consumidor no conoce no lo puede respetar.**
7. **Auditoría por cliente**: `pbxng_api_audit` con quién (el `client_id`, no una persona), qué y
   con qué `Request-Id`.

**Esfuerzo: días para la credencial y los scopes; la auditoría, días más.**

### 7.2 Central → backoffice (saliente)

PBX-NG firma cada webhook:

```
X-PBXNG-Signature: t=<epoch>,v1=<hmac_sha256(secreto, t + '.' + cuerpo_crudo)>
```

Ventana de 5 minutos contra replay. **Atención al orden del middleware**: hay que capturar el
cuerpo crudo **antes** de `express.json()` (`app.js:206`) o la firma no cierra.

**Regla de montaje que el equipo externo no puede adivinar**: el gate de auth se monta **antes**
de todas las rutas, y el comentario del código documenta que `callengine.js` ya quedó una vez
fuera del gate por registrar rutas demasiado temprano. **Las rutas `/api/v1` tienen que
registrarse después del gate**, o repiten el mismo agujero.

### 7.3 Una trampa abierta hoy, que hay que cerrar antes de entregar

De las cuatro rutas `/api/internal/*` de la allowlist pública, **tres tienen candado real**
(loopback estricto + ausencia de cabecera de proxy + token comparado en tiempo constante) y
**`GET /api/internal/wake` (`app.js:642-645`) no tiene ninguna verificación**: toma
`req.query.ext`, `from` y `name` y llama directo a `notifyIncomingPush()`.

Como el panel proxya `/backend/**` y la API corre con `trust proxy = 1`, cualquiera que llegue al
panel puede hacer sonar una notificación push de llamada entrante en cualquier interno, con el
número y el nombre que quiera. El dedupe es de 6 s por extensión: diez notificaciones falsas por
minuto por interno, sostenidas. *(pedido a `api` y `seguridad`)* **Esfuerzo: horas** — el guardia
ya está escrito y probado en `telefonia.js`, es reusarlo.

---

## 8. Versionado y política de compatibilidad

**Lo que hay hoy, medido.** Cero rutas bajo `/api/v1` o cualquier prefijo de versión.
Cero `X-API-Version` o `Accept-Version`. `docs/CONTRATOS.md` §9 se titula «Versionado» pero
versiona **el producto y las imágenes** (SemVer, `VERSION`, `CHANGELOG.md`, tags, migraciones),
no el contrato HTTP.

Hoy eso no molesta porque el único consumidor es el panel, que se despliega en la misma imagen
que la API. **Deja de ser cierto el día que el consumidor es un sistema de terceros con su propio
ciclo de release.**

**Cómo falla, concreto.** El backoffice depende de que un campo sea un arreglo de texto. Seis
meses después PBX-NG necesita distinguir dos tipos y ese campo pasa a ser un arreglo de objetos.
El despliegue de PBX-NG pasa su CI, el panel se actualiza en el mismo tarro y anda perfecto — y
el backoffice muestra campos vacíos, **sin ningún error HTTP, sin una entrada de log, sin nadie a
quien avisarle**. El síntoma aparece en la mesa de ayuda del otro producto, días después.

**Lo que hay que construir.**

1. **Congelar un subconjunto chico y explícito bajo `/api/v1/`** — no las ~346 rutas: las 20 o 30
   que el backoffice realmente consume (`eventos/suscripciones`, `llamadas`, `internos`, `cdr`,
   `grabaciones`, `clientes`). El resto queda marcado como **interno y sin garantía**, escrito en
   `docs/CONTRATOS.md`.
2. **Política de compatibilidad publicada, en una línea que el equipo externo pueda citar**:
   dentro de `v1` sólo se **agregan** campos opcionales; sacar un campo o cambiarle el tipo exige
   `v2`, con las dos versiones en paralelo durante un plazo (sugerido: 6 meses).
3. **OpenAPI 3.1 del subconjunto v1**, publicado en el repo, y un paso de CI que lo compare
   contra las rutas registradas y **falle si divergen**. Es el mismo chequeo que habría atrapado
   las rutas fantasma que hoy documenta `docs/CONTRATOS.md` §3.
4. **Prueba de contrato en CI**: que renombrar un campo de una respuesta `v1` se ponga rojo acá y
   no en el cliente. Es la única barrera que sobrevive a que el equipo interno rote.

Aunque `v1` sea hoy idéntica a lo que hay, **el prefijo es lo que permite que exista `v2`
después**.

**Esfuerzo: días** (el prefijo y la política); **días más** el OpenAPI y su chequeo.

---

## 9. Lecturas: CDR e historial

**Lo que hay hoy, medido.**

- `GET /api/cdr` acepta exactamente dos parámetros: `limit` (con `Math.min(+limit, 500)`) y `ext`.
  **No hay `from` ni `to`, no hay cursor, no hay `offset`.** Cero paginación en toda la API.
- **La tabla `cdr` no tiene ni un índice ni clave primaria.** Verificado: 33 `CREATE INDEX` en
  `docker/config/initdb/01-schema.sql`, **ninguno sobre `cdr`**, y ninguna de las 19 migraciones
  agrega uno.
- `GET /api/clients/:id/calls` cruza con `regexp_replace(src,'[^0-9]','','g')`: una expresión
  regular por fila, sobre toda la tabla, **garantizado sin índice posible**.

**Cómo falla, concreto.** El backoffice quiere conciliar las llamadas de un día para facturar.
Pide `GET /api/cdr?limit=500` y recibe las últimas 500 — en una central con tráfico, día y medio.
No hay forma de pedir un rango de fechas ni de seguir desde donde quedó: pedir 501 devuelve 500
igual, **porque el `Math.min` recorta en silencio sin avisar que hubo truncamiento**. Si el
backoffice estuvo caído el fin de semana, **las llamadas del viernes ya salieron de la ventana y
no se recuperan por HTTP de ninguna manera**. Se factura de menos y nadie se entera hasta que un
cliente reclama.

Y cada una de esas consultas ocupa **una de las 10 conexiones del pool que comparte con los
`CURL()` del dialplan**: un backoffice poleando el historial dispara exactamente el escenario que
`docs/CONTRATOS.md` §6 describe.

**Lo que hay que construir.**

1. **Migración con `CREATE INDEX CONCURRENTLY`** sobre `cdr`: `(start DESC)`, `(uniqueid)`,
   `(linkedid)`, `(src, start DESC)`, `(dst, start DESC)`. *(pedido a `datos`)*
   Costo medido por el equipo de datos sobre 1M de filas: ~90 MB de índice sobre una tabla de
   200 MB, con la consulta del wallboard pasando de ~140 ms a ~1,4 ms.
2. **`GET /api/v1/cdr?desde=&hasta=&cursor=&limite=`**, con paginación por cursor sobre
   `(start, uniqueid)` —no por offset— y **tope de rango** (sugerido 92 días, que es el criterio
   que `ccreport.js` ya aplica y ya documentó).
3. **Envoltorio único `{items, next_cursor}` y el tope aplicado explícito en la respuesta**, para
   que **un truncamiento nunca sea silencioso**.
4. Para el cruce del CRM: índices de expresión sobre `regexp_replace(...)` o —mejor— una columna
   generada `src_num` / `dst_num` indexada, porque un índice de expresión hay que repetirlo
   idéntico en la consulta y nadie se va a acordar.

**Esfuerzo: horas** los índices; **semanas** la paginación por cursor en todas las lecturas del
contrato.

---

## 10. Caché de clientes para el screen-pop

El diseño de §1 exige una caché local de número → cliente, porque el dialplan no puede esperar al
backoffice. **Esa pieza no existe y la decisión de dónde vive tiene consecuencias que el equipo
externo no puede adivinar.**

**Lo que hay hoy.** El CRM propio (`pbxng_clients`, con `phones text[]`) es **una libreta
manual**: se carga a mano desde la pantalla de clientes. Su búsqueda es un `unnest(phones)` con
`regexp_replace` **sin índice** — justo la consulta que tendría el presupuesto de 200 ms.

**Cómo falla si se reusa tal cual.** Si el backoffice sincroniza contra `pbxng_clients`, el primer
sync masivo pisa o duplica la libreta que el cliente cargó a mano: **`POST /api/clients` no tiene
`ON CONFLICT` de ninguna clase**, así que 5.000 clientes sincronizados sobre 200 cargados a mano
dan 5.200 filas con duplicados y nadie sabe cuál es la buena. Si se hace tabla aparte y nadie lo
dice, el agente ve dos fichas distintas del mismo cliente en la misma pantalla.

**Lo que hay que construir.**

1. **Tabla separada `pbxng_backoffice_clientes`**: `numero_norm` (PK), `cliente_id`, `nombre`,
   `imputacion jsonb`, `sincronizado_at`. **El número ya normalizado y como clave primaria**, así
   el lookup del dialplan es un SELECT por PK, que es lo único que entra en 200 ms de forma
   confiable.
2. Se llena por `POST /api/v1/backoffice/clientes` (lote, idempotente) que **empuja el
   backoffice**, más un `PUT` individual para altas en caliente.
3. `GET /api/clients/lookup` consulta **primero** esta tabla y **después** la libreta propia, y
   devuelve `origen: "backoffice" | "local"` para que el agente sepa qué está mirando.
4. **La libreta manual no se toca.** El módulo de portería y el CRM propio siguen siendo de
   PBX-NG y el backoffice no los pisa. *(pedido a `porteria`; la separación va escrita en
   `docs/CONTRATOS.md` §3)*

**Esfuerzo: días.**

---

## 11. Observabilidad de la integración

**Lo que hay hoy, medido.** `alerts.js` vigila troncales, failover, servicios (db/ari/ami), nodos,
fraude, colas sin agentes y un resumen diario — y **no tiene ninguna regla para la integración**.
`GET /health` reporta `{status, db, db_ms, ari, ami, shutting_down, ts}` y nada más. Métricas
Prometheus están anotadas como faltantes en `docs/EVALUACION-2026-09.md` §4.

Y no hay log de acceso HTTP ni identificador de petición: cero `requestId`, `X-Request-Id`,
`correlation` o `traceId` en todo `control-plane/`. Una petición que devuelve 200 no deja
absolutamente ningún rastro.

**Cómo falla, concreto.** El backoffice cambia su certificado TLS y PBX-NG empieza a fallar todos
los POST. Los eventos se acumulan, el worker reintenta, el log escupe errores — **y nadie mira el
log**. A las 72 h los eventos vencen y se descartan. El cliente lo descubre cuando concilia.
El modo de falla es **silencioso y diferido**, que es el peor para un producto que se entrega a un
tercero. La variante conversacional es igual de mala: «a las 14:32 te mandé el alta del interno y
no apareció» no se puede responder porque no hay forma de saber si la petición llegó, con qué
cuerpo, qué se respondió ni cuánto tardó.

**Lo que hay que construir.**

1. **Middleware de log de acceso con `X-Request-Id`** (~15 líneas, montado antes del gate):
   genera o toma el id, lo deja en `req.id` y en la respuesta, y al `finish` loguea
   `{id, method, path, status, ms, ip, user, api_client}`. **El mismo id viaja como
   `X-Request-Id` en las llamadas salientes al backoffice**, así los dos lados comparten una
   clave. **Esfuerzo: días.**
2. **Regla `backoffice.entrega` en `alerts.js`**, con el throttle y la agregación que el módulo
   ya sabe hacer: se dispara cuando la cola supera N pendientes o cuando hay M minutos sin una
   entrega exitosa habiendo eventos encolados, **y se dispara de nuevo —severidad `info`— cuando
   se recupera**. Es el patrón de dos sentidos que `checkTrunks` y `checkServices` ya usan.
3. **Extender `/health`** con `{backoffice: {pendientes, mas_viejo_s, ultimo_ok_at,
   vencidos_24h}}`: es lo que va a mirar el que atiende el teléfono a las 3 de la mañana.
4. **Pantalla mínima en el panel** con la cola, los últimos errores y un botón de reintento
   manual. Sin eso, el diagnóstico es entrar al contenedor y hacer un SELECT, y **el equipo
   externo no va a tener acceso al contenedor**. *(pedido a `panel`)*

---

## 12. Plan de trabajo

El orden importa: las dos primeras semanas **no se pueden paralelizar** porque todo lo demás
cuelga de ellas.

| Orden | Trabajo | Sección | Esfuerzo | Bloquea a |
|---|---|---|---|---|
| 1 | Identidad de llamada (`call_id` / `leg_id`), `uniqueid`+`linkedid` en el CDR | §2 | horas–días | 3, 4, 6 |
| 2 | Credencial de sistema + scopes en `rbac.js` + revocación | §7.1 | días | 5, 8 |
| 3 | Outbox + worker + backoff + retención | §4 | semanas | catálogo de eventos |
| 4 | Catálogo de 7 eventos y sus emisores | §3 | semanas | — |
| 5 | `Idempotency-Key` (middleware único) | §5 | días | — |
| 6 | `/api/v1` + política de compatibilidad + OpenAPI | §8 | días | — |
| 7 | Timeouts del dialplan + endpoint de lookup + caché | §1, §10 | días | screen-pop |
| 8 | `linkedid` en el nombre del WAV y en `pbxng_recordings` | §6 | días | `grabacion.lista` |
| 9 | Índices de `cdr` + paginación por cursor | §9 | horas–semanas | conciliación |
| 10 | Firma HMAC saliente | §7.2 | días | — |
| 11 | `X-Request-Id`, alertas de entrega, `/health` | §11 | días | soporte |
| 12 | Cerrar `internal/wake` | §7.3 | horas | — |

**Total: 6 a 9 semanas de un desarrollador.**

### Arreglos de higiene que conviene hacer en el camino

No son parte del contrato, pero son patrones que el equipo externo **va a copiar porque son los
que están**:

- **18 de 34 `fetch()` de `control-plane/` no tienen timeout.** Agregar `AbortSignal.timeout()`
  a las 18; hay 16 ejemplos en el mismo repo de cómo se hace. **Esfuerzo: horas.**
- **Los dedupes en memoria se borran enteros** (`if (map.size > 200) map.clear()` en
  `app.js:2032`, `:2049`, `:2067`). Para el outbox, la unicidad la da Postgres; si hace falta una
  caché delante, **que expire por entrada, nunca con un `clear()` global**.

---

## 13. Pruebas que definen si esto está listo

Estas son las pruebas que **deciden la entrega**, no una lista de deseos. Hoy ninguna existe:
medido, **0 de los 20 archivos de `control-plane/test/` menciona una salida HTTP**
(`integration|telegram|whatsapp|crm_webhook|notifyIntegrations`), y **0 abren una conexión
socket.io**.

1. **El backoffice caído una hora.** Con tráfico simulado y un destino que devuelve 500 durante
   60 minutos, verificar al final: (a) ningún evento perdido en el outbox; (b) el pool nunca
   superó **1 conexión ocupada** por el worker —medible con `pg_stat_activity`—; (c) un `CURL()`
   de dialplan contra `/api/internal/disa` siguió respondiendo por debajo del presupuesto durante
   todo el período. **Esta es la prueba que decide si la integración es entregable.**
2. **Degradación cuando el otro lado no responde.** Servidor de prueba que **acepta la conexión
   TCP y nunca contesta** (un rechazo es rápido y no prueba nada): afirmar que `crmLookup()`
   devuelve su frase de degradación en menos de 3 s. **Medido hoy: sigue colgado a los 90 s.**
   Correr en CI para que no se pierda.
3. **Presupuesto del screen-pop.** Con el backoffice respondiendo a 3 s, medir el paso del
   dialplan y comprobar que **la llamada timbra igual**.
4. **Idempotencia de extremo a extremo.** El mismo evento entregado dos veces con el mismo
   `evento_id` se registra una sola vez; el mismo `POST` de originar con la misma
   `Idempotency-Key` produce **una sola llamada** (hoy salen dos).
5. **Idempotencia destructiva del alta de internos.** Reintentar `POST /api/endpoints` sobre un id
   existente **no debe rotar la contraseña SIP**. Hoy la rota.
6. **Orden por llamada.** Emitir entrante → contestada → terminada con el worker reintentando la
   del medio, y verificar que el backoffice no recibe `terminada` antes que `contestada` para el
   mismo `call_id`.
7. **Correlación grabación ↔ llamada.** Un interno hace tres llamadas en cinco minutos con
   grabación prendida; cada `grabacion.lista` debe llevar el `call_id` correcto. **Con el código
   de hoy esta prueba falla por diseño**: sirve como prueba de regresión del arreglo de §6.
8. **Verificación de la firma.** Cuerpo alterado → firma inválida; timestamp de hace 10 minutos →
   rechazado por replay; rotación con los dos secretos vivos → ambas firmas aceptadas durante la
   ventana.
9. **Prueba de contrato del esquema v1.** Falla si una respuesta pierde un campo o le cambia el
   tipo.
10. **Autenticación de sistema.** Un token de servicio revocado deja de funcionar **en la petición
    siguiente**, no dentro de 12 h; sus scopes se aplican de verdad (un token con `cdr:leer`
    recibe 403 en `POST /api/calls/dial`); la actividad queda atribuida al `client_id` y no a una
    persona.
11. **Carga combinada sobre el pool de 10.** N `CURL()` de dialplan concurrentes + el worker de
    eventos + un informe de call center a la vez, midiendo la latencia del `CURL()` en el
    percentil 99. Es la prueba que cierra el riesgo que `docs/CONTRATOS.md` §6 describe en prosa y
    que **nadie ejerció nunca**.

---

## 14. Contradicciones encontradas, sin resolver por decreto

Este documento se armó sobre nueve informes de auditoría independientes. Donde dos se
contradicen, lo decimos en vez de elegir uno.

1. **¿`crmLookup()` es bloqueante o fire-and-forget?** Un informe lo describió como
   *fire-and-forget*. **Verificado en el código: es bloqueante.** `ai-pipeline.js:204` y `:214`
   lo llaman con `await` dentro del turno de conversación, y en `:214` el resultado va directo a
   `speak()`. Este documento usa la versión verificada: **está en el camino de la llamada y no
   tiene timeout.**
2. **¿Cuántas rutas tiene la API?** Los informes dan 352, 350 y 346 registros de ruta, y 346, 272
   y 269 rutas distintas. La diferencia sale del patrón de búsqueda (comillas simples vs dobles,
   si se cuenta `app.use`, si se cuenta path exacto o familia). **Con un grep propio de
   `app.<método>('/api…')` salen 346 registros.** Lo que **no** varía entre los seis conteos, y
   es lo único que importa acá: **cero bajo `/api/v1`**. No hay que resolver el número antes de
   empezar; hay que fijar el subconjunto de §8 y contar ése.
3. **`docs/CONTRATOS.md` §9 se contradice con la migración `0014_salas_reunion.sql` y con la
   propia sección de Salas del mismo documento** (una dice que la migración le pone PIN a las
   salas viejas, la otra que no toca ninguna fila; el archivo de migración confirma la segunda).
   No afecta a esta integración, pero **es el documento que se le va a entregar al equipo externo
   como mapa del producto** y hay que corregirlo. *(trabajo de `docs`, fuera del alcance de este
   archivo)*

---

## 15. Qué no se midió

Honestidad sobre los límites de lo que hay acá:

- **No se corrió Asterisk.** El timeout por defecto de `func_curl`, la precedencia real entre
  dialplan estático y realtime, y el comportamiento del canal ante un CURL colgado se afirman por
  lectura del código y de la documentación de Asterisk, **no por haberlos medido en una central**.
- **No se midió el rendimiento del CDR con volumen real de una instalación productiva.** Los
  números de §9 salen de un banco sintético de 1.000.000 de filas armado durante la auditoría, no
  de datos de un cliente. El `EXPLAIN ANALYZE` sobre un volcado real es parte del trabajo, no de
  este documento.
- **No se probó ninguna entrega de webhook**, porque no hay nada que probar todavía: la cañería
  no existe.
- **No hay ningún número de capacidad defendible.** No existe prueba de carga en el repositorio.
  Cuántas llamadas simultáneas aguanta la central con el worker de eventos corriendo es una
  pregunta abierta, y la prueba 11 de §13 es la que la contesta.

---

## 16. Pedidos a otros agentes

Este documento es del agente `docs` y no toca código. Lo que se desprende de él:

- **`api`**: credencial de sistema y scopes, outbox y worker, `Idempotency-Key`, `/api/v1` y
  OpenAPI, `uniqueid`/`linkedid` en el CDR, paginación por cursor, `X-Request-Id`, cerrar
  `internal/wake`, `AbortSignal.timeout()` en los 18 `fetch()` sin timeout, endpoint
  `/api/internal/lookup` y la caché de clientes.
- **`telefonia`**: `curl.conf` con `conntimeout` y `timeout`, `CURLOPT` explícito en los cuatro
  caminos de CURL del dialplan, `${UNIQUEID}` en el nombre del `MixMonitor`.
- **`datos`**: índices de `cdr` (`start`, `uniqueid`, `linkedid`, `(src,start)`, `(dst,start)`),
  tablas `pbxng_eventos_salida`, `pbxng_api_clients`, `pbxng_idempotencia`,
  `pbxng_backoffice_clientes`, `pbxng_api_audit`.
- **`seguridad`**: guardia de `internal/wake`, revisión de scopes contra el deny-by-default de
  `rbac.js`.
- **`panel`**: pantalla de estado de la cola de eventos con reintento manual.
- **`porteria`**: separación entre la libreta manual de `pbxng_clients` y la caché
  `pbxng_backoffice_clientes`.
- **`docs`** (este agente, trabajo siguiente): escribir en `docs/CONTRATOS.md` la excepción del
  *fail-safe* para el lookup (§1), el techo del outbox (§4), la separación de la caché de
  clientes (§10) y la política de compatibilidad (§8); y corregir la contradicción de §9 sobre la
  migración 0014.
