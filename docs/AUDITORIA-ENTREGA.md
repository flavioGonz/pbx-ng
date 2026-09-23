# Auditoría de entrega — PBX-NG

**Fecha:** 2026-09-23 · **Versión auditada:** `VERSION` = 1.11.0 (último commit: `b4f20e9 "1.11.1: …"`)
**Motivo:** el producto se entrega a un equipo de desarrollo externo —el del proveedor de un
software de gestión backoffice (Horizon)— que **no conoce telefonía ni este producto**, y PBX-NG
se va a integrar con ese backoffice de forma **bidireccional**: la central avisa lo que pasa y el
backoffice le ordena cosas.

**Cómo se hizo:** nueve auditorías paralelas por área (api, backend, panel, telefonía, seguridad,
datos, despliegue, pruebas, integración). **No se tocó código.** Todo lo que afirma este documento
se midió corriendo comandos sobre el repo, o se dice explícitamente que no se midió.

**Cómo leerlo:** §1 es el veredicto. §2 es lo único que hay que discutir antes de entregar. §3 es
el detalle por área. **§4 es tan importante como §2**: lo que está bien y no hay que tocar —un
equipo nuevo rompe lo que no entiende—. §5 es el plan. §6 son las contradicciones que encontramos
entre secciones, sin resolver, para que las decida el dueño.

---

## 1. El estado en una página

### Los números

| Qué | Medido |
|---|---|
| Superficie HTTP | **346 pares método+path únicos bajo `/api`** (361 registros `app.<método>(` en `control-plane/*.js`) |
| Rutas versionadas (`/api/v1`) | **0** |
| Concentración | `app.js`: 2.389 líneas, 152 registros de ruta, 18 dominios, 63 funciones de nivel superior |
| Módulos | 36 archivos `.js`, ~14.990 líneas; 13 de 45 archivos exponen HTTP |
| Pruebas | **158 casos, 20 archivos, 0 fallos, ~44 s**, integración real contra PostgreSQL efímero |
| Cobertura de rutas | **104 de 350 rutas Express reciben un request (29,7 %)** — medido instrumentando un middleware |
| Cobertura de funciones en `app.js` | **23,3 %** (55,8 % de líneas: el número de líneas engaña, el registro de ruta cuenta como cubierto) |
| Lint | ESLint 0 errores, 15 avisos; `next lint` 0 errores, 32 warnings |
| `npm audit` | 4 moderadas, 0 altas, 0 críticas (las 4 de `ari-client`, sin arreglo por npm) |
| Eventos de negocio salientes | **0** (6 `emit()` de socket.io, ninguno de llamada) |
| Índices sobre la tabla `cdr` | **0** (ni clave primaria) |
| Claves foráneas / CHECK en 101 tablas | **5 FK, 0 CHECK** |
| Agentes HTTP del producto con autenticación | **1 de 4** |
| Pruebas fuera de `control-plane/` | **0** (panel, softphone, voice-service, agentes Python) |
| Tags git en el repo | **0** |

### El veredicto, en dos partes

**Sobre la calidad del producto: está mejor de lo que el encuadre sugiere, y eso hay que decirlo
primero porque cambia dónde gastar el presupuesto.** El RBAC es deny-by-default con 50 reglas
razonadas una por una; `errores.js` centraliza la forma del error en 314 llamadas y no filtra un
solo mensaje crudo de Postgres; el SQL está parametrizado en los 36 archivos sin una sola
excepción; el cierre por SIGTERM drena llamadas de verdad; la API arranca y se mantiene viva sin
Postgres y sin Asterisk, con `/health` devolviendo 503 `degraded`; `migrate.js` es transaccional
con advisory lock; el failover de troncales y el generador de dialplan de la DISA están escritos
por alguien que ya se quemó y explican el incidente que los motivó. Nada de eso es lo que hay que
arreglar.

**Sobre la entrega y la integración: NO está listo, y el motivo no es la calidad del código.**
Es que este producto está construido como **API privada de un panel propio**, y lo que se va a
entregar es un **contrato público para un sistema**. Las cuatro piezas que eso exige faltan por
completo —no están a medias—:

1. **No existe ningún evento saliente de negocio.** No hay `call.started`, `call.ended` ni
   `recording.ready`, no hay webhooks, no hay outbox. **La mitad «la central avisa» de la
   integración bidireccional hoy no existe.**
2. **No hay credencial de sistema.** Sólo JWT de persona (12 h) y token de teléfono (30 d). El
   backoffice tendría que guardar la contraseña de un admin de carne y hueso, y no hay forma de
   revocar nada.
3. **No hay versionado ni contrato publicado.** 346 rutas sin `/v1`, sin OpenAPI, y el documento
   que hace de contrato (`docs/CONTRATOS.md` §3) declara «285 rutas» y describe 6 endpoints que
   ya no existen.
4. **No hay paginación ni idempotencia.** `GET /api/cdr` acepta `limit` (tope 500) y `ext`, sin
   rango de fechas: **la conciliación de llamadas es imposible con la API de hoy.** Y un POST
   reintentado crea dos clientes o dispara una segunda llamada.

Y hay un quinto punto, que es el más caro de todos porque toca el requisito no negociable:
**hoy una llamada SÍ se puede caer porque el backoffice tardó.** `crmLookup()`
(`ai-pipeline.js:133`) hace `fetch()` **sin timeout** y se lo espera con `await` dentro del turno
de una llamada en curso. Medido: `fetch` de Node v22.22.2 contra un servidor que acepta la
conexión TCP y nunca responde **no aborta a los 90 s**. El resto del código sabe hacerlo bien
—19 usos de `AbortSignal.timeout`—; la única que corre con un humano en línea es la que no lo
tiene.

**Recomendación:** no entregar sin cerrar la Tanda 0 y la Tanda 1 de §5 (≈3-4 semanas). El resto
se puede entregar como deuda documentada, que es una posición honesta; lo de arriba no.

---

## 2. Lo que bloquea la entrega

54 hallazgos vinieron marcados como bloqueantes por las nueve secciones. Deduplicados —muchos son
el mismo problema visto desde distintos ángulos— quedan **26 temas**. Están agrupados por familia
y ordenados por qué tan caro sale no arreglarlos.

### A. El camino de la llamada (lo que se cobra y lo que no se puede caer)

| # | Tema | Cómo falla | Esfuerzo |
|---|---|---|---|
| **A1** | **`crmLookup()` sin timeout dentro de la llamada** (`ai-pipeline.js:133`, esperado con `await` en `:204` y `:214`) | El backoffice acepta la conexión TCP y no responde. Medido: `fetch` sigue colgado a los 90 s. El que llama escucha **silencio absoluto** hasta que corta, y en el CDR queda como atendida y de duración normal: ni siquiera aparece en los reportes como un problema. | horas |
| **A2** | **Los 4 `CURL()` del dialplan corren sin timeout** — 0 apariciones de `CURLOPT`/`curltimeout`/`conntimeout` en todo el repo, no existe `curl.conf` | `${CURL()}` es **bloqueante**: retiene el canal. El wake está en el camino de TODA llamada a un interno sin contacto registrado; la DISA retiene al que ya marcó su PIN. El diseño está pensado para la API **caída** (vuelve vacío, lado seguro), no para la API **lenta**, que es el caso frecuente. | horas |
| **A3** | **`apps.js` mete datos del usuario crudos en el dialplan** — 1 sola lista blanca en 940 líneas, y es para nombres de audio | Medido corriendo `buildIvrDialplan` real: una opción de IVR con `dest_type:'ringgroup'` y `dest_value:'00598991234567'` genera `Goto(internal,00598991234567,1)`, y en `internal` viven las rutas salientes. **Cada llamada que entra al DID y marca 1 es un internacional facturado a la central**, sin pasar por ninguna restricción de ruta. El backoffice va a cargar IVRs por API. | días |
| **A4** | **El contexto `ivr` es tan compartido como `internal` y no tiene candado** — 6 familias publican ahí con DELETE+INSERT | Reproducido de punta a punta: creo un ring group en 600, creo una sala en 600 → el grupo desaparece del dialplan en silencio y la tabla sigue diciendo que existe; borro el grupo → se lleva puesto el dialplan de la **sala**. Es literalmente el bug que `dueno-internal.js` documenta como resuelto, vivo en el contexto de al lado. | días |
| **A5** | **El IVR cicla sin tope** — sin contador de intentos, sin `TIMEOUT(absolute)`, sin salida | Un autodialer o un teléfono descolgado deja el canal entrante **contestado y tomado** dando vueltas hasta que el otro extremo cuelgue. Es la única pieza de dialplan del producto sin tope: la DISA, el failover y el camino de internos sí lo tienen. | días |
| **A6** | **El dialplan estático de `internal` es invisible para el candado, el plan de numeración y el catálogo de códigos** | Asterisk resuelve lo estático antes del `switch => Realtime`. Apagar «Mi buzón» devuelve 200 y `*97` sigue andando. Una DISA en 1500 —el rango que el propio `numbering.plan()` propone— se publica con 201 y **nunca contesta** porque `_[1-9]XXX` la tapa. *(No verificado corriendo Asterisk: se afirma por la documentación del orden de resolución y por el parche `DIALPLAN_EXISTS` de `extensions.conf:101`, que es exactamente este problema resuelto para un solo contexto.)* | días |
| **A7** | **La API confirma que una extensión graba y la central no graba** | Medido con AMI caído: `POST /api/endpoints {record:true}` → **HTTP 201 limpio**, `pbxng_record=true`, `GET /api/endpoints` informa `record=true`, y la clave `rec/9001` nunca se escribió en la AstDB. El dialplan lee la AstDB. Nadie se entera hasta que alguien pide una grabación que no existe —típicamente semanas después, y cuando hace falta—. | horas |
| **A8** | **`infra/asterisk/` es un segundo árbol de configuración desincronizado, y la documentación de operaciones lo manda usar** | 5 archivos divergen. Su `extensions.conf` tiene 87 líneas contra 194: le faltan aparcado, captura, el guardia `__SALTOS` y todos los desvíos, y su `*97` es la versión vieja sin el guard por `CHANNEL(endpoint)`. `skill/pbx-ng/references/operations.md:129` apunta ahí. | horas |

### B. El contrato público (sin esto no hay integración)

| # | Tema | Cómo falla | Esfuerzo |
|---|---|---|---|
| **B1** | **No existe ningún evento saliente de negocio** | 6 `emit()` en todo `control-plane/`, ninguno de llamada. El backoffice sólo puede polear `/api/calls/live` (estado completo, no delta) y `/api/cdr`. Con el tope de 500 y sin rango de fechas, si el backoffice se cae 20 minutos **las llamadas de ese hueco no se recuperan de ninguna forma**. Pérdida silenciosa y sin manera de detectarla. | semanas |
| **B2** | **No hay credencial de sistema, y el JWT no se puede revocar** | El equipo externo guarda usuario+contraseña de un admin y re-loguea cada 12 h. Consecuencias: la auditoría no distingue «lo hizo Juan» de «lo hizo el backoffice»; borrar ese usuario **no invalida el token** (0 apariciones de `jti`/`denylist`/`token_version`); rotar la credencial implica cambiarle la clave a una persona; y como el RBAC reparte por roles de persona, el backoffice termina siendo `admin` con permiso para borrar troncales y bajar respaldos. | semanas |
| **B3** | **Cero paginación, y `/api/cdr` sin rango de fechas** | 0 apariciones de `offset`/`cursor`/`page`/`after`/`before` y 0 `OFFSET $` en todo `control-plane/`. `/api/cdr` acepta exactamente `limit` (tope duro 500) y `ext`. **No se puede pedir «las llamadas de ayer».** Con 300 llamadas/día eso cubre día y medio: se factura de menos y nadie se entera hasta que un cliente reclama. Detalle: `limit=abc` degrada a 400 por accidente (SQLSTATE 22P02), no por validación. | semanas |
| **B4** | **No hay versionado de API** | 0 coincidencias de `/v1`, `/api/v[0-9]`, `X-API-Version` o `Accept-Version`. Hoy no molesta porque el único consumidor es el panel, que se despliega en la misma imagen. El día que `phones` pase de arreglo de texto a arreglo de objetos, PBX-NG pasa su CI, el panel anda perfecto, y el backoffice muestra teléfonos vacíos **sin un error HTTP, sin una línea de log y sin nadie a quien avisarle**. | días |
| **B5** | **Ninguna escritura es idempotente** | `POST /api/calls/dial` reintentado tras un timeout de red origina **un segundo canal**: dos tramos facturados por una intención, y un cliente que atiende y no hay nadie. `POST /api/clients` reintentado deja dos fichas —verificado que `pbxng_clients` no tiene ningún UNIQUE—. `POST /api/endpoints` reintentado **rota la contraseña SIP** de un interno que andaba (`ON CONFLICT … SET password=EXCLUDED.password`) y deja el teléfono sin registrar. | días |
| **B6** | **Los eventos no pueden tener identidad: el CDR no expone `uniqueid`/`linkedid`** | Las columnas existen en la tabla y `GET /api/cdr` devuelve 12 columnas sin ninguna de las dos. Sin `call_id` estable no hay idempotencia, no hay orden, no hay conciliación. El equipo externo va a inventar una clave `src+dst+timestamp`, que colisiona en cuanto dos agentes llaman al mismo número en el mismo segundo. Hay que decidir **primero** si el id de una llamada es el `linkedid` (sobrevive transferencias) o el `uniqueid` (una pata). | días |
| **B7** | **La grabación no se puede ligar a la llamada** | `pbxng_recordings` **tiene** columna `linkedid` y el indexador nunca la escribe (0 apariciones en `recordings.js`). La correlación real es una heurística de ±300 s por extensión. Un interno con tres llamadas en cinco minutos puede recibir el `src`/`dst` de otra: **el agente que abre la grabación de un reclamo escucha otra conversación.** | días |
| **B8** | **La documentación de la API describe familias, no endpoints, y contradice al código** | `CONTRATOS.md` §3 son 810 líneas de buena prosa arquitectónica, pero declara «285 rutas» contra 346 reales, sólo 68 pares método+path aparecen explícitos, y **6 de esos ya no existen** (`DELETE /api/ccreport/schedules`, `DELETE /api/feriados`, `DELETE /api/horarios`, `GET /api/npm/test`, `POST /api/routes/inbound/:id`, `PUT /api/routes/inbound`). *(Que falte OpenAPI ya es deuda conocida: `EVALUACION-2026-09.md:225`. Lo nuevo es que el documento miente en seis lugares.)* | días |
| **B9** | **El canal de tiempo real no sirve como bus y no tiene una sola prueba** | El socket.io emite un `snapshot` de estado **completo** con debounce, y si hay uno en vuelo `broadcast()` hace `if (busy) return` y **saltea el siguiente entero**: un consumidor externo no vería la transición. Sin secuencia, sin replay, sin acuse. Cero pruebas abren un socket. | días |

### C. Seguridad

| # | Tema | Cómo falla | Esfuerzo |
|---|---|---|---|
| **C1** | **Tres de los cuatro agentes HTTP del producto no tienen ninguna autenticación** | `:8091` (turn-agent) entrega el `turnserver.conf` crudo con `TURN_PASS` y `cli-password` en claro y **deja reescribirlo**; `:8080` (voz) publica `/admin/config`, `/admin/logs` y `/admin/restart` —y `/admin/config` lanza un `subprocess.Popen(["bash","-c",…])`—; `:1984` (go2rtc) reparte las URL RTSP de las cámaras con usuario y clave. Y **`docs/FIREWALL.md:50` afirma que 8091 va «solo la API, con token»**: el documento describe un control que en el código no existe. *(Deducido del bind `0.0.0.0` + `network_mode: host` / `ports:`; no confirmado con un curl contra una central instalada.)* | horas |
| **C2** | **El límite de la ruta pública de click-to-call se saltea con una cabecera** | Medido: sin cabecera, 12 intentos → 6 pasan y 6 dan 429 (el límite anda). Rotando `X-Forwarded-For`: **30 de 30 pasan, 0 × 429**, y un cliente sin sesión creó 36 endpoints PJSIP registrables y 180 filas de dialplan en segundos. La causa es `app.js:657` tomando el **primer** valor de `X-Forwarded-For` — exactamente lo que `CONTRATOS.md` §2 prohíbe con todas las letras y lo que `auth.js` ya hace bien. Además 200.000 pedidos con IP inventada dejan 200.000 entradas en un `Map` sin poda (61,8 MB de heap medidos; `mem_limit` de la api: 768m). | horas |
| **C3** | **El coturn no restringe a dónde relaya, y la credencial la reparte `/api/ice` sin sesión** | 0 apariciones de `denied-peer-ip`/`allowed-peer-ip` en el repo. `/api/ice` es público por diseño (el softphone necesita ICE antes de autenticarse), así que la clave del relay es pública y lo único que podía contener el abuso —la lista de destinos prohibidos— no está. Con `network_mode: host`, eso es la LAN entera del cliente. Nota: la regla `pbxng-mgmt` acepta AMI y ARI desde redes privadas, y el tráfico que sale del relay hacia la IP LAN del host **es** privado. *(No se pudo probar un Allocate real.)* | horas |
| **C4** | **`GET /api/internal/wake` es la única `internal/*` sin loopback ni token** | Verificado en el código: tres líneas, sin una sola comprobación. Sus tres hermanas tienen loopback estricto + token en tiempo constante, con el razonamiento escrito. `curl 'https://…/backend/api/internal/wake?ext=1005&from=099111222&name=Banco%20Central'` sin sesión hace sonar una notificación push falsa con el nombre que uno quiera, diez por minuto por interno. Sirve para phishing de voz y para inutilizar el softphone de cualquiera. **Es exactamente la clase de trampa que sólo conoce quien escribió el código.** | horas |
| **C5** | **Un agente sin interno asignado puede escuchar grabaciones ajenas** | `extPropia()` devuelve `''` para «agente sin interno», y `''` matchea con todo: en `/api/recordings/:id/audio` alcanza con que uno de los tres campos sea NULL. Reproducido en node con la lógica exacta: agente sin interno + grabación con `src` NULL → **PASA**; `GET /api/recordings/match?from=&to=…` → **PASA**. `/api/cdr` sí contempla el borde (`if (propio === '') return 403`), así que el autor lo conocía en un lugar y no en los otros dos. | horas |
| **C6** | **Si `/etc/pbxng/agent.token` no se puede escribir, los dos extremos degradan a «red privada alcanza» sin avisar** | El `catch` devuelve cadena vacía y la API arranca igual; el guard es `if (TOKEN && !tokenOk(req))`; el agente cae a `return src.is_private or src.is_loopback`. Y lo que ese agent_auth protege incluye `POST /netmode`, que ejecuta **una lista de argv que viene en el cuerpo del pedido**, como root. El único rastro es una línea de `console.error` del arranque. *(No reproducido: haría falta un host con Docker.)* | días |
| **C7** | **El instalador verifica 4 de los 7 secretos y ninguna actualización vuelve a mirar** | `preflight_secrets` deja afuera `TURN_PASS`, `TURN_CLI_PASS` y `ADMIN_DEFAULT_PASS`, y `pbxng-ctl up` / `docker compose pull` / `deploy.sh` nunca vuelven a llamar a `gen_shared_secrets`. **Ese es el mecanismo por el que una central instalada antes de 1.4.0 se queda con un secreto de ejemplo para siempre**, y va a volver a pasar con el próximo secreto que se agregue. | horas |

### D. Datos, despliegue y verificación

| # | Tema | Cómo falla | Esfuerzo |
|---|---|---|---|
| **D1** | **La tabla `cdr` no tiene ni un índice ni clave primaria** | Medido con 1.000.000 de filas: la consulta del wallboard —que el panel pide **cada 8 s** con la pantalla abierta— tarda **137-143 ms** y lee 199 MB de buffers; con un índice en `(start DESC)`: **1,4 ms**. El indexador de grabaciones escanea el CDR completo **por cada grabación nueva** (75,7 ms) con un predicado no sargable; reescrito como `start BETWEEN`: **0,28 ms**. Costo de los 3 índices: 90 MB sobre una tabla de 200 MB. No es disco (209 bytes/llamada, 218 MB en 3 años): es CPU y latencia, y crece para siempre. | horas |
| **D2** | **El checksum de las migraciones se guarda y nunca se compara** | Medido: edité una migración ya aplicada y `migrate.js` respondió **«DB al día (sin migraciones nuevas)»**, salida 0, la columna nueva no existe. La regla «no se edita una migración aplicada» está documentada pero **nada la hace cumplir**, y editar el SQL que escribiste ayer es lo primero que hace un equipo que recién llega. | horas |
| **D3** | **No hay respaldo antes de migrar, ni migraciones inversas, ni camino de vuelta — y `RELEASE.md` documenta un rollback que no funciona** | Medido inyectando un error en la 0012: quedan **11 migraciones commiteadas**, el deploy aborta, y la base ya cambió. `0018_sin_fax` dropea 4 tablas y borra filas de `extensions` y `pbxng_inbound_routes`. Volver a la versión anterior levanta código viejo contra una base donde sus tablas ya no existen. El único camino de vuelta es el respaldo nocturno: hasta 24 h de configuración perdida. *(Que no haya rollback ya es deuda conocida, `EVALUACION` §3.14; que no haya respaldo previo y que el procedimiento esté documentado como si funcionara, no.)* | días |
| **D4** | **`migrate.js` no detecta deriva de esquema, y hay 10 tablas propias que sólo viven en el pg_dump** | Medido: borré `pbxng_ringgroups`, `pbxng_paging`, `pbxng_sysprompts` e `pbxng_ivr_options` —ninguna migración las crea y ningún `CREATE TABLE IF NOT EXISTS` del código las crea— y `migrate.js` dijo **«DB al día»** con salida 0. Acto seguido tres rutas devolvían **500**. El operador ve «migraciones OK» en el log y tres pantallas muertas en el panel. | días |
| **D5** | **La imagen de la API se construye con el `node_modules` de quien la arma, no con el lock** | `control-plane/` **no tiene `.dockerignore`** (`dashboard/` sí). Medido: contexto de build 44 MB, 1,6 MB sin `node_modules`; ese `node_modules` tiene 254 paquetes e **incluye eslint**. El `COPY . .` monta eso encima del `npm ci --omit=dev`. Y las dos líneas son `npm ci … || npm install …`: si el lock no coincide, resuelven versiones frescas en silencio mientras la CI corre `npm ci` estricto. **El equipo externo, buildeando el mismo commit en su CI limpia, obtiene una imagen distinta de la probada.** | horas |
| **D6** | **Instalar por imagen (`--release`) y el bundle air-gapped no arrancan** | `install.sh` escribe `PBXNG_COMPOSE_FILE` y **nunca** escribe `PBXNG_REGISTRY` ni `PBXNG_VERSION` (0 apariciones en los dos instaladores). El compose busca `pbxng/asterisk:latest` en Docker Hub y muere con `pull access denied`. En air-gapped el `docker load` deja las imágenes como `ghcr.io/…` y el compose sigue buscando `pbxng/…`: el tarball carga bien y el stack igual no levanta. **Ni el bundle ni el `.env` guardan con qué registry y versión se armaron.** | horas |
| **D7** | **La compuerta de paridad dev/release es ciega justo a las imágenes** | Medido con el script real: cambié `postgres:16-alpine` por `15-alpine` **sólo en el release** → «OK: es espejo», exit 0. Apunté el servicio `api` a la imagen del `dashboard` → también OK. (Para contraste: borrarle un montaje **sí** lo caza con exit 1, o sea que el script funciona para lo que nació.) En el cliente, un PGDATA escrito por 16 no arranca en 15 y la central queda sin base. | horas |
| **D8** | **Un typo en un perfil apaga un módulo en silencio — el incidente de 1.11.0, otra vez** | Medido: `COMPOSE_PROFILES=core,turno` resuelve 4 servicios **sin coturn**, exit 0, sin un solo aviso. `pbxng-ctl` valida el nombre del módulo; `install.sh` no. Es exactamente lo que pasó en producción: `/api/ice` repartiéndole a softphones WebRTC la dirección de un relay que nadie corría, con el panel mostrando el módulo encendido. | horas |
| **D9** | **Ninguna compuerta de CI toca lo que realmente se entrega** | Los 4 jobs de `ci.yml` no construyen una imagen ni ejecutan `install.sh`, `deploy.sh` o `release.sh` (la única mención de `install.sh` en los workflows es un comentario). Un Dockerfile roto recién aparece en el job de release, **después de 30-50 minutos de runner**. Y de `install.sh` —el pedido explícito del dueño— sólo se verifica que parsee. | días |
| **D10** | **El proceso de release que documenta `RELEASE.md` nunca se ejecutó como está escrito** | **0 tags git en el repo.** `VERSION`=1.11.0, el último commit se llama «1.11.1», y el `CHANGELOG` más nuevo es `[1.11.0]`. `release.yml` dispara con `on: push tags [v*]`, así que los releases salieron por `workflow_dispatch` con la versión tipeada a mano y sin validar contra nada. Si se publica `:1.11.1`, `deploy.sh` sin la variable exportada va a pedir imágenes `:1.11.0` que no existen. **El equipo externo no tiene forma de saber qué versión es la buena.** | horas |
| **D11** | **Actualizar exige SSH, y la central no sabe qué versión corre** | 0 endpoints de actualización. Peor: `APP_VERSION` **no aparece en ninguno de los dos compose**, y `backup.js` graba `version: process.env.APP_VERSION \|\| null`: **cada respaldo se guarda con `version: null`**. El día que haya que restaurar, nadie sabe de qué esquema salió ese tar.gz — y como no hay migraciones inversas, restaurar es una apuesta. | días |
| **D12** | **`npm test` da verde habiendo ejecutado el 30 % de los casos cuando falta PostgreSQL** | Verificado ocultando los binarios de Postgres: «# pass 43, # fail 0, # skipped 13», **salida 0**, en 4 s en vez de 44. Son ~110 de 158 casos (70 %) que desaparecen. Está documentado como decisión deliberada en `CONTRATOS` §10 y para el equipo de hoy es razonable; **para un equipo externo que monte su propio CI es una trampa perfecta: verde, rápido, y no probó nada.** | horas |
| **D13** | **Ninguna prueba distingue «Asterisk lo aplicó» de «lo guardé en la base»** | Es el caso que el dueño pidió mirar. Reproducido con AMI a un puerto cerrado: `POST /api/parking/apply` → **200 `{"ok":true,…,"salida":""}`**; `POST /api/moh/apply` → **200 `{"ok":true,…}`**; el GET posterior confirma el cambio. El archivo se escribió, el `module reload` nunca llegó. **`astconf.js` documenta la falla en su propia cabecera**: «sin el reload, el panel dice guardado y Asterisk sigue con lo de antes». El contraejemplo bueno está en el mismo repo: `/api/calls/dial` devuelve 503. | días |
| **D14** | **La tabla RBAC reporta 100 % de cobertura y 28 de sus 50 reglas nunca se ejercitan** | Medido instrumentando `rolesPara()`: 401 decisiones, 276 al default `admin`, sólo 22 índices de regla activados. Las 28 que no incluyen justo las que deciden si un agente baja la grabación o el CDR de otro interno. **Probé esos casos a mano y hoy funcionan bien** (403 / filtrado por extensión propia). El problema es que nada los fija: el día que alguien toque `recordings.js`, la cobertura va a seguir diciendo 100 %. | días |
| **D15** | **246 de 350 rutas no reciben un solo request en toda la suite** | Sin ninguna prueba: las 18 de grabaciones, las 12 de seguridad (una lista blanca mal escrita deja la central abierta o al cliente afuera), 9 de `/api/calls` —escucha, susurro, irrupción, transferencia, aparcado: **justo lo que el backoffice va a ordenar**—, 9 de respaldo incluida la restauración que corre un `psql -f` sobre toda la base, 8 de colas, 7 de IVR. El primer refactor de `recordings.js` no rompe ninguna prueba. | semanas |

### E. Panel

| # | Tema | Cómo falla | Esfuerzo |
|---|---|---|---|
| **E1** | **`check:deps` da OK sobre la trampa exacta que fue creado para atrapar** | El guardián sólo marca fallbacks **literales** (`\|\| []`). `troncales/page.jsx:114` es `const astTrunks = ownTrunks` donde `ownTrunks = trunks.filter(...)`: arreglo nuevo por render, invisible para el regex. **ESLint sí lo ve y grita en la línea 134.** Un desarrollador externo ve 31 warnings, agrega `astTrunks` a las deps —es el arreglo que sugiere el propio mensaje—, corre `check:deps`, le dice **OK**, y `/troncales` queda en blanco con React #185. Ya pasó dos veces en este repo. | días |
| **E2** | **La autenticación del panel es un monkey-patch de `window.fetch`, no una capa** | `auth.jsx` reemplaza `window.fetch` al importarse y sólo inyecta el token si `u.indexOf('/backend') === 0` —literal y posicional—. Una URL absoluta o un cliente HTTP propio da false, la API responde 401, el parche **borra el JWT y redirige a `/login`**: el desarrollador queda deslogueado sin ninguna pista que relacione causa y efecto. Y no hay forma de descubrirlo leyendo `api.js`, que es donde uno busca. | días |
| **E3** | **Ocho clientes HTTP distintos y 77 `fetch` crudos conviviendo con `app/api.js`** | Cuatro copias **literales** de un `const j = …` que convierte cualquier error en `null`. Concreto: si `/clients/:id` devuelve 500, la ficha del cliente queda vacía, sin spinner y sin un mensaje — **idéntico a «este cliente no tiene datos»**. El operador no puede distinguir «no hay ficha» de «la base está caída», y el equipo externo tampoco cuando le llegue el ticket. | semanas |
| **E4** | **1.067 líneas muertas, y el contrato las documenta como si estuvieran vivas** | 9 archivos sin un solo importador. **`CONTRATOS.md` §2 cita `SipLadder` (3 s) como una de las tres únicas cadencias de segundos autorizadas**, y la ruta que lo hospedaba ya no existe. El comentario de `check-deps-inestables.mjs` explica el bug #185 con `SbcFlow.jsx`, que es huérfano: alguien va a tocar ese archivo creyendo que arregla `/troncales` y no va a pasar nada. Arrastre: `PcapCapture.jsx` quedó inalcanzable y los 5 endpoints `/api/capture/*` están vivos sin pantalla — **funcionalidad de diagnóstico pagada y no entregada, justo la que necesita alguien que no sabe telefonía**. | horas |
| **E5** | **Cuatro `page.jsx` de Next usados como componentes hijos de otra página** | `/cdr` importa `../historial/page` y `../grabaciones/page`. Next las sigue tratando como rutas (170-237 kB de bundle propio que nada enlaza) y al abrir `/cdr` **se montan los dos encuestados a la vez**. Trampa para el equipo externo: modificar `/historial` cambia `/cdr` sin que nada lo diga, y alguien puede «limpiar» esas rutas huérfanas y romper dos pantallas que sí se usan. | días |

### F. Estructura y dueños

| # | Tema | Cómo falla | Esfuerzo |
|---|---|---|---|
| **F1** | **`app.js` tiene 18 dominios y el bloque de Portería contradice la regla de dueño único del propio contrato** | `CONTRATOS.md` §1 declara al agente `porteria` dueño de `clients`/`persons`/`spaces`/`devices`/`intercom`/`survey`, y ese código vive dentro de `app.js`, cuyo dueño es `api`. **La regla «cada archivo tiene UN dueño» está rota hoy**, y después de la entrega son dos equipos editando el mismo archivo de 2.389 líneas, con 6 de 127 rutas cubiertas por pruebas. Es también donde aparecieron las 11 respuestas de 200-con-error y 3 de los 7 `rows[0] \|\| {}`: la densidad de inconsistencias es más alta justo en el archivo sin dueño. | semanas |
| **F2** | **Tres documentos de despliegue contradicen al código** | `README.md:203` y `PACKAGING.md:40` ofrecen un all-in-one como «opción 2 del instalador» y el menú tiene 1) all y 2) core; `PACKAGING.md:91` y `docker/README.md:105` dicen que el compose «todavía no reenvía» seis variables **que reenvía las seis**, y mandan a editarlo a mano —tocando el archivo que la compuerta de paridad compara—; `RELEASE.md:22` lista `redis`, que salió del stack en 1.4.0. | horas |

---

## 3. Hallazgos por sección

Los bloqueantes ya están en §2. Acá va el resto, por área, ordenado por gravedad. Lo que ya está
anotado como deuda conocida se marca como tal y **no cuenta como descubrimiento**.

### 3.1 API y contrato público

- **[alto] La forma de las respuestas es inconsistente y hay 200 que mienten.** Tres problemas de
  la misma familia: 32 rutas devuelven arreglo pelado, 80 devuelven `{ok:true,…}`, 30 respuestas
  201 y **0 cabeceras `Location`**; **11 lugares** hacen `res.json({ok:false, error})` sin tocar
  el status; **7 lugares** hacen `rows[0] || {}` y devuelven 200 donde iba 404. Concreto:
  `PUT /api/clients/47` sobre una ficha que alguien borró responde `200 {}`; el backoffice ve
  2xx, marca la sincronización como exitosa y **la divergencia entre los dos sistemas crece en
  silencio**. Falta además un campo `code` estable al lado del `error` legible: los mensajes de
  `errorHttp()` son prosa en castellano para un toast («el interno 101 no esta en una llamada
  puenteada») y **un sistema no puede ramificar sobre eso**. *Días.*
- **[medio] Las pruebas cubren 36 % de las familias de `/api` y ninguna verifica la forma del
  contrato.** Las 11 respuestas de 200-con-error y los 7 `rows[0] || {}` pasaron las 158 pruebas
  sin que ninguna se quejara, porque ninguna mira esa propiedad. *Días.*
- **[medio] IP hardcodeada en el dialplan de `infra/asterisk/extensions.conf:61`** (una IP de una instalación concreta, con puerto de la API)
  mientras el árbol de docker usa el marcador `@@API_URL@@`. Fallo silencioso: `${CURL()}` vuelve
  vacío y el dialplan sigue, así que se manifiesta como «a veces el teléfono no suena». *Ver A8.*

### 3.2 Backend

- **[medio] 14 de 34 `fetch()` salientes sin timeout, uno disparado por evento de llamada.**
  Aclaración importante y verificada: `notifyIntegrations` se llama **sin `await`** desde un
  handler de AMI, así que Asterisk NO espera y la llamada NO se cae. Lo que sí pasa: con el
  contenedor de WhatsApp mudo (acepta y no responde), cada llamada perdida arranca un fetch que
  no termina nunca — cientos de promesas y sockets por hora, sin techo. El síntoma que ve el
  cliente es una API que se pone lenta y se reinicia **días después** de haber tocado la
  integración, sin relación evidente. Mismo patrón en `syncGo2rtc`, que además barre todos los
  porteros en serie. *Horas: `AbortSignal.timeout(N)` en las 14; 20 de las 34 ya lo usan.*
- **[medio] No hay límite de tasa fuera del login.** Medido: 100 peticiones concurrentes a
  `/api/system` → 100 × 200 en 200 ms, **0 × 429**. **No pude provocar agotamiento del pool**, así
  que no afirmo que se caiga: lo honesto es que no hay nada que lo impida y el margen se descubre
  en producción. La asimetría es el punto: la API se defiende del que adivina contraseñas y no del
  que la consume mal, que es justo el riesgo que introduce la integración. *Horas.*
- **[medio] 185 `catch` vacíos, y el lint los permite a propósito.** *Deuda conocida* (`EVALUACION`
  §3.7, que contaba 97). La gran mayoría son legítimos y cambiarlos en bloque sería ruido; los que
  importan son **14 que se tragan una ESCRITURA** que el usuario cree hecha. Dos que vale mirar:
  `c2cCleanup` borra cinco cosas con `.catch(() => {})` dentro de un `catch(_){}` —si la limpieza
  empieza a fallar, las cuentas WebRTC se acumulan y **no queda una línea de log**—; y `guard.js:463`
  pierde en silencio la cuenta de hits de IPs bloqueadas, o sea la evidencia de un ataque en curso. *Días.*
- **[medio] La contraseña del admin de arranque va al log en claro y el default es `admin`.**
  *Deuda conocida* (`EVALUACION` §3.11) **sin cerrar y mudada de archivo** (de `app.js:647` a
  `auth.js:297`, así que la referencia del documento ya no lleva a ningún lado). Atenúa que se crea
  con `must_change=true`, pero `docker logs | grep BOOTSTRAP` devuelve la clave, y un despliegue
  hecho con `docker compose up` a mano queda con admin/admin más un `GET /api/auth/setup` público
  que lo anuncia. *Horas.*
- **[bajo] Las 4 vulnerabilidades moderadas vienen de `ari-client` y no se arreglan con npm.**
  *Deuda conocida y confirmada* (`CHANGELOG` línea 892). El riesgo real es bajo (`request` habla con
  ARI en 127.0.0.1). **El impacto es de entrega:** el equipo externo va a correr `npm audit` el primer
  día y, si no está escrito, va a hacer `npm audit fix --force`, que **baja `ari-client` a 1.2.0 y
  rompe el control de llamadas**. Hay que decirlo en el README del control-plane, no sólo en el CHANGELOG.

### 3.3 Panel

- **[alto] El `usePoll` compartido repinta la pantalla entera aunque no haya cambiado nada.**
  `setData(d)` en cada vuelta sin comparar. `/seguridad` se dio cuenta, escribió su propio `usePoll`
  con firma por payload y dejó el comentario que describe el síntoma con precisión («la hacía
  temblar, perder el scroll y saltar mientras uno leía una fila») — y **nunca lo subió al
  compartido**. El wallboard, que es literalmente una pantalla de pared, repinta cada 8 s haya o no
  llamadas. *(El mecanismo está confirmado por lectura y por el comentario de quien lo sufrió; la
  magnitud en CPU no se midió con profiler.)* *Horas.*
- **[alto] 38 de 52 encuestados descartan el error.** Con la API devolviendo 500 en `/api/trunks`,
  `/troncales` renderiza lista vacía y un solo nodo: **idéntico a una central recién instalada**.
  El operador concluye «se borraron las troncales» y el equipo externo recibe un ticket de pérdida
  de datos por lo que era un 500 transitorio. El error ya viene en la mano (`.status` + mensaje en
  español) y nadie lo dibuja. *Días.*
- **[medio] `/seguridad` y `/grabaciones` esconden sus controles de admin para un supervisor que
  nunca puede entrar.** Las dos pantallas hicieron el trabajo completo de esconder-por-rol (14
  controles condicionados, dos pedidos salteados), `rbac.js` **sí** le da al supervisor los GET
  correspondientes, y `SUP_OK` no las incluye: **la capacidad está pagada dos veces y entregada
  cero veces**. Hay que decidir y escribirlo; lo que no puede quedar es la tercera opción actual,
  que es las dos cosas a la vez. *Horas.*
- **[medio] Dos `setInterval` violan la política de encuestado de `CONTRATOS` §2.4**, uno sin
  `clearInterval`. El de `shell.jsx:43` es el que importa: consulta `/backend/health` cada 30 s
  **sin mirar `document.hidden` y sólo se activa cuando la API no responde** — que es cuando menos
  le conviene recibir pedidos. Con cinco pestañas en segundo plano, 10 pedidos por minuto de
  pestañas que nadie mira mientras la API intenta levantar. *Horas.*
- **[medio] De los 31 warnings de `exhaustive-deps`, 4 esconden riesgo real, 1 es una omisión
  deliberada cuyo «arreglo» sería una regresión, y 26 son ruido — y nada en el repo dice cuál es
  cuál.** Arreglar los (a) rompe `/troncales`; arreglar el (b) —`RecordingPlayer.jsx:93`, que no
  incluye `dark` a propósito— **destruye y recrea wavesurfer al cambiar el tema y corta la
  reproducción**; arreglar los (c) no hace nada. La diferencia vive hoy únicamente en la cabeza de
  quien escribió el panel: **la definición de defecto de entrega**. *Días.*
- **[medio] 127 botones de sólo-ícono con 11 `aria-label`.** *(Indicio medido, no veredicto: no se
  probó con lector de pantalla ni navegación por teclado.)* El caso concreto es el botón de eliminar
  una grabación, que es irreversible y llega a un `confirm()` nativo después de haber apretado a
  ciegas. *Días.*
- **[medio] React Flow entero en tres rutas: `/troncales` 319 kB de First Load JS** contra 87,9 kB
  de bundle compartido. `/troncales` es donde se diagnostica una troncal caída, muchas veces desde
  un enlace lento, y el diagrama es lo **último** que uno mira. El patrón `dynamic(…, {ssr:false})`
  ya se usa y funciona en el repo, sólo que no en los lienzos. *(Los kB son los que reporta Next,
  sin comprimir; no se midió el peso transferido real.)* *Días.*
- **[bajo] Duplicados concretos:** `Timer` escrito dos veces **línea por línea idéntica**
  (`Softphone.jsx:12` y `phone/page.jsx:48`), el mismo avatar con el mismo degradado dos veces, 16
  formateos de fecha fuera de `fmt.js` con tres `fmtFecha` redefinidos, y cuatro archivos para los
  toasts de los cuales dos están muertos. Ya pasó: la misma central muestra la misma fecha con dos
  formatos según la pantalla. *Días.*
- **[bajo] 510 colores hex hardcodeados contra 6 archivos que consultan el tema.** `/troncales` fija
  el fondo del lienzo en `#f6f8fb` y los paneles flotantes en blanco translúcido: en modo oscuro la
  pantalla queda partida en dos temas. *(No se vio renderizado; lo medido es que el color no sale
  del tema y por lo tanto no puede seguirlo. Parte de los 510 son legítimos.)* *Días.*

### 3.4 Telefonía

- **[alto] El `did` de la ruta entrante entra crudo al dialplan, al lado de la lista blanca que
  valida a su hermano.** `dest_type` y `dest_value` tienen `DEST_OK`/`VALOR_OK` con el comentario
  que explica el riesgo; el `did`, en el mismo cuerpo, sólo pasa por `if (!did …) return 400` — y
  se interpola dentro del `appdata` de cuatro aplicaciones. `did:'2900,1'` publica un `Goto` de
  cuatro argumentos que Asterisk **rechaza en tiempo de llamada y corta**, con un 201 en el panel y
  el error sólo en el log de Asterisk. **Es la excepción exacta que el equipo externo no va a
  sospechar: el campo de al lado tiene lista blanca y comentario.** *Horas.*
- **[alto] `name`, `context` y `outbound_prefix` de la troncal no se validan.** El caso caro es
  `context`: `POST /api/trunks {context:'internal'}` hace que **toda llamada que entre por esa
  troncal aterrice donde viven las rutas salientes, los códigos de función y las DISA**.
  `[from-trunk]` está separado de `[internal]` a propósito y esta ruta lo deshace con un campo del
  formulario. La regex `TRONCAL_OK` **ya existe en el mismo archivo** y se aplica al nombre de
  troncal que llega en una ruta saliente, no a la troncal cuando se la crea. Y `outbound_strip:-5`
  genera `${EXTEN:-5}`, que en Asterisk son los **últimos** 5 dígitos: marca un número distinto del
  que el usuario marcó. *Horas.*
- **[alto] La API acepta extensiones que el dialplan no sabe rutear, y dos de los tres caminos de
  alta ni consultan el plan de numeración.** `numbering.check()` acepta `\d{2,6}`; `internal` sólo
  tiene `_[1-9]XXX`. Un interno `250` se crea, registra y aparece «en línea» — y es **inalcanzable**.
  Por `POST /api/phones` ni siquiera se valida el número. Y el `check()` que sí existe está envuelto
  en un `.catch(() => ({ok:true}))` que convierte cualquier error de base en «libre». *Días.*
- **[alto] Un desvío puesto desde el teléfono mientras la API reinicia se revierte solo en el
  próximo arranque.** El dialplan escribe la AstDB **primero** y avisa a la API después; el
  resultado del CURL no se mira, así que le locuta «activado» igual. En el arranque siguiente,
  `syncFeatures()` vuelca Postgres → AstDB y **borra** lo que el teléfono había escrito. El usuario
  se fue convencido a las 18:00, el sígueme funcionó toda la noche, y a la mañana desapareció sin
  que nadie lo apagara y sin una línea de log. *Días.*
- **[medio] Los gates de módulos protegen `app_disa.so`, que nadie usa, y no protegen el voceo ni
  la grabación, que sí se usan.** La disciplina está bien construida y bien probada, pero la
  comprobación es «todo `require` está en los tres lados», no «toda aplicación que el dialplan usa
  existe en la imagen». Si `app_mixmonitor.so` queda fuera —el modo de falla que el propio Dockerfile
  describe: «menuselect deja AFUERA SIN AVISAR lo que no encuentra»— **el build sale verde, la imagen
  se publica, las llamadas cursan, y la grabación no graba.** *Horas.*
- **[medio] Cualquier interno registrado puede alternar el modo noche de toda la central marcando
  `*28`.** Del lado del panel es admin; el camino del teléfono no tiene equivalente: sin PIN, sin
  lista de autorizados. Un visitante en la sala de reuniones deja a la empresa atendiendo como si
  fuera feriado hasta que alguien mire el panel. Es rastreable a posteriori pero nada lo impide, y
  **un cliente que entrega la central a un tercero va a preguntar por esto**. *Días.*
- **[medio] Una ruta entrante con destino «app» puede apuntar a una ruta saliente o a un código de
  función.** `VALOR_OK.app` es `/^[*#0-9]{1,16}$/` y en `internal` conviven las DISA, los prefijos
  de salida y los códigos: la regex no los puede distinguir. `dest_value:'00598991234567'` convierte
  un DID en una máquina de facturar; `'*28'` hace que cada llamada entrante alterne el modo noche.
  **No hace falta que sea malicioso:** «app» es el tipo que el panel ofrece para mandar un DID a una
  DISA. El arreglo no es una regex: es preguntarle a `dueno-internal.reclamos()` qué familia ocupa
  ese número. *Horas.*
- **[medio] `pjsip.conf` deja `anonymous` en el orden de identificación de endpoints.** **Hoy no
  falla**: el producto no siembra ningún endpoint con ese nombre, así que la llamada se rechaza
  igual. Se reporta como superficie innecesaria: el día que alguien cree una troncal llamada
  `anonymous`, o restaure un respaldo de otra central que sí lo tenía, todo INVITE sin identificar
  entra con el contexto de ese endpoint — y ese contexto, por el punto de arriba, puede ser
  `internal`. *Horas.*
- **[bajo] Dos detalles que ensucian el diagnóstico:** `*8` pide el canal `PJSIP/*8`, que nunca
  existe (la captura la hace el `Pickup()` de la línea siguiente), así que **cada captura de grupo
  deja un error en el log** y manda a investigar un problema que no existe; y el camino de despertar
  softphones sondea hasta 8 s **sin `Ringing()` ni `Progress()`**, o sea silencio absoluto para el
  que llama. *Horas.*

### 3.5 Seguridad

- **[alto] El PIN de la DISA se puede barrer: el contador de intentos se indexa por el CallerID, que
  lo pone el que llama.** El límite por llamada lo hace el bucle del dialplan, pero cada llamada
  nueva arranca de cero. Con un PIN de 4 dígitos son ~3.400 llamadas: una tarde con un generador SIP.
  El premio es marcado saliente por las rutas de la DISA, o sea la factura del cliente. Secundario:
  cada CallerID inventado deja una entrada en un `Map` que sólo se limpia en el éxito. *Días.*
- **[medio] NPM sale de fábrica con `admin@example.com` / `changeme` en `:81` de todas las
  interfaces**, y nada fuerza el cambio. Está documentado —pero documentado no es cerrado, y el
  equipo externo hereda una instalación que ya tiene esto andando—. Es el camino más corto a
  comprometer la central entera y no requiere ningún conocimiento del producto. *Horas.*
- **[medio] El `.env.example` promete que las claves de terceros se guardan cifradas, y no hay
  cifrado en ninguna parte del repo** (0 coincidencias de `createCipheriv`/`aes-256`/`scrypt`). Lo
  que sí está bien es el **enmascarado de salida** (`has_password`, `has_apikey`, `rtspMask`). Lo
  barato y honesto hoy es corregir la nota: decir que se guardan en la base y que hay que proteger
  la base y los respaldos. *Días.*
- **[medio] El respaldo es un volcado de credenciales sin cifrar, descargable por HTTP.** El aviso
  del manifiesto es honesto sobre los **certificados** y no nombra lo demás: claves SIP de todos los
  internos y troncales, claves de aprovisionamiento, SMTP, S3/NAS, enrolamiento. **Leyendo el aviso,
  la conclusión razonable es «cuidado con los certificados»; nadie deduce que el mismo archivo abre
  todas las troncales del cliente.** Y mover respaldos entre entornos es lo primero que hace un
  equipo nuevo para reproducir un problema. *Días (el cifrado) / horas (el aviso).*
- **[bajo] Código muerto con dientes:** `agents/pbxng-rec-server.py` levanta un servidor en
  `0.0.0.0:8089` que sirve `GET /list` y el audio de cualquier grabación **sin autenticación**. En
  el camino de Docker ya no se usa, pero los archivos siguen en el repo, 8089 no está en
  `FW_MGMT_PORTS`, y **el `.env.example` de la raíz todavía documenta `VM_AGENT` como si fuera parte
  del producto**. Un equipo que arme un despliegue bare-metal siguiendo esa documentación entrega
  todas las grabaciones del cliente a cualquiera que llegue al puerto. *Horas.*
- **[bajo] La clave SIP generada tiene ~38 bits con un formato publicado en el repositorio**
  (`'Pbx' + 8 hex + '#' + 2 dígitos`, y los dos dígitos salen de `Math.random()`). El riesgo real
  hoy es bajo porque `guard.js` contiene el ataque, pero depende por entero de que el módulo esté
  prendido. Subir a `randomBytes(16).toString('base64url')` no cuesta nada: la clave la copia el
  aparato desde el QR, nadie la tipea. *Horas.*
- **[bajo] SVG servido en una ruta pública, con la CSP de la API deshabilitada a mano.** Escalada
  admin→admin, por eso es bajo, pero es una primitiva de XSS almacenado en el origen del panel —que
  guarda el JWT en localStorage— sin ninguna barrera. Vale revisar por qué helmet tiene la CSP
  apagada en la API cuando el panel sí tiene una desde 1.8.0. *Horas.*

### 3.6 Datos

- **[crítico] Borrar una troncal deja huérfana la ruta saliente que la usa como principal.**
  Reproducido en base real: el handler es cuidadoso con los **respaldos** (los saca de la lista y
  reescribe el dialplan, con comentario explicando por qué) y **nunca consulta `WHERE trunk = $1`**.
  La ruta queda con `troncal_existe=0` y la fila de `extensions` sigue diciendo
  `Dial(PJSIP/…@antel,20)`: **toda llamada por ese prefijo sale contra un endpoint que no existe**,
  el que llama escucha congestión, y en el panel la ruta se ve perfecta. *Horas.*
- **[alto] 101 tablas, 5 claves foráneas y 0 CHECK: la integridad vive sólo en los handlers.** La
  base acepta hoy sin chistar `dest_type='banana'`, `hora=99`, `trunk='troncal-que-no-existe'`,
  `horario_id=424242`. La API valida varias de esas y **está bien hecho**, así que por la puerta del
  panel no entra basura; el problema es que el contrato con el backoffice va a ser bidireccional.
  Un caso que ya funciona así: un `horario_id` inexistente hace que la ruta se publique **como si no
  tuviera horario** — el DID atiende 24 h en vez de sólo en oficina, en silencio, con el panel
  mostrando el horario asignado. Algunas ausencias de FK **están decididas a propósito y bien
  argumentadas** (`pbxng_ext_features.ext`, explicado en la 0011); el problema es que ese criterio
  no está aplicado como criterio sino como ausencia general. *Días.*
- **[alto] El restore no puede distinguir un restore bueno de uno roto.** Corre
  `psql -v ON_ERROR_STOP=0`, descarta el resultado, **nunca verifica los sha256 que él mismo guardó
  en el manifiesto**, y devuelve `ok:true` siempre. El caso feliz anda (medido: 0 errores, 101
  tablas, 1M filas, sobre base vacía y encima de una con datos). El infeliz le dice «restaurado OK»
  al operador sobre una base a la que le faltan tablas — **y un operador que acaba de perder un
  disco deja de buscar otro respaldo**. *Horas.*
- **[medio] Siete tablas crecen sin tope ni poda** (`cdr`, `pbxng_alerts`, `pbxng_marcacion_log`,
  `pbxng_call_geo`, `pbxng_vm_sent`, `pbxng_enroll`, `pbxng_call_surveys`). En disco **no es una
  catástrofe** y conviene decirlo con números: 209 bytes/llamada, 218 MB en 3 años. Donde duele es
  en el costo de cada seq scan y en que `pbxng_marcacion_log` —el registro de intentos de DISA— **se
  llena a ritmo de ataque y no se poda nunca**, que es justo cuando uno quiere la base rápida.
  Además la poda de `pbxng_sec_events` arranca recién 6 h después del arranque: una central que se
  reinicia seguido **nunca poda**. *Horas.*
- **[medio] Las capturas de paquetes se guardan como `bytea` dentro de Postgres, sin tope, sin poda,
  y entran en cada respaldo.** Es la decisión contraria a la que la migración 0016 argumenta
  correctamente para el fax («un TIFF en una columna bytea hace que el respaldo lógico pase de
  megabytes a gigabytes»). Tres capturas de diagnóstico olvidadas llevan la base **y los 14 respaldos
  retenidos** a varios GB sin que nadie relacione una cosa con la otra. *(No medido con tráfico
  real: se da el mecanismo, no un número.)* *Días.*
- **[medio] Las migraciones de DATOS nunca se prueban con datos.** El helper aplica esquema +
  migraciones en cada corrida —genuinamente bueno— pero **siempre sobre base vacía**: 0 `INSERT`
  previos. Las que tocan datos (0004, 0006, 0008, 0017 y sobre todo **0018, que repunta o BORRA
  rutas entrantes y su dialplan**) no tienen cobertura. La 0018 se probó a mano y funciona; el punto
  es que si mañana alguien toca la condición, **el primer lugar donde se descubre es la central de un
  cliente perdiendo un DID**. *Días.*
- **[medio] Cuando una migración borra datos, el aviso queda sólo en el log de arranque.** El
  mecanismo es bueno y deliberado (`RAISE NOTICE` + el listener de `notice` que node-pg descarta si
  nadie escucha). Pero termina en una línea JSON y en ningún lado más: sin fila en `pbxng_alerts`,
  sin Notificaciones, sin bandera. Reproducido: la 0018 borra la ruta y dice por qué, y **si el que
  actualizó no estaba mirando `docker logs` en ese minuto, el cliente descubre que un número dejó de
  atender cuando alguien llama.** Cinco líneas y reusa un motor que ya está. *Horas.*
- **[bajo] `volcarPendientes()` hace N INSERT secuenciales por lote.** Lo medí antes de reportarlo y
  **no es un problema real**: 2000 IP tardan 766 ms en serie contra 38 ms en multi-fila (20×), pero
  766 ms es el 5 % del presupuesto de 15 s. Oportunidad barata, no riesgo. *(Medido sobre socket
  unix local; con la base en otra máquina el número sube.)* *Horas.*
- **[bajo] El esquema vive en tres lugares y los agentes Python siguen creando tablas en caliente.**
  Hoy las tres definiciones coinciden (comparadas columna por columna), así que no hay síntoma. El
  riesgo apunta directo al equipo que recibe: la pregunta «¿dónde está definido el esquema?» tiene
  hoy **tres respuestas**. *Horas.*

### 3.7 Despliegue

- **[alto] El build no es reproducible: nada de lo que se baja está fijado ni verificado.** Tarball
  de Asterisk sin checksum, `acme.sh` desde la **rama master** de un repo de terceros ejecutado como
  root dentro de la imagen que atiende la API, **8 paquetes pip sin una sola versión fijada** en la
  imagen de voz, y cuatro imágenes de terceros en `:latest`. Dos builds del mismo commit con una
  semana de diferencia producen imágenes distintas: **cuando un cliente reporte un bug en 1.11.0 no
  hay forma de reconstruir la imagen que tiene.** *(Lo de go2rtc/NPM ya es deuda conocida, `EVALUACION`
  §3.14; esto lo extiende al resto.)* *Días.*
- **[alto] `pbxng-proxmox.sh` clona `main`, compila en cada LXC, y reporta «desplegado» aunque el
  build falle.** Las dos líneas de build terminan en `|| y "(algunos servicios pueden tardar…)"`: un
  fallo se imprime como aviso amarillo y el script sigue hasta el cartel verde. **El operador lee
  «PBX-NG desplegado», anota la IP del panel y se va; el cliente descubre que no hay central.**
  Aparte, el `.env` se escribe con un heredoc que **pisa** el `cp -n .env.example`, así que queda sin
  TZ, sin `MEM_*`, sin `BACKUP_KEEP` y sin `PBXNG_COMPOSE_FILE`, y no se instala el cron de respaldo. *Días.*
- **[alto] `install.sh` no valida lo que le contestan ni verifica la máquina.** Sin `openssl`,
  `gen()` cae a `x$RANDOM$RANDOM$RANDOM`: medí 8 muestras, 13-16 caracteres, ~45 bits de un PRNG de
  bash. `preflight_secrets` no lo detecta porque sólo compara contra literales, así que imprime
  «✓ Secretos verificados» sobre un **JWT_SECRET adivinable** — con el que se forjan sesiones de
  admin. Y si sale de 13 caracteres, `app.js:49` aborta y **la central no arranca, después de que el
  instalador dijo OK**. El helper `tcpok()` está escrito y **no se usa en ninguna línea**. *Horas.*
- **[alto] `release.sh --bundle` puede entregar un bundle incompleto y terminar diciendo OK.** El
  tar termina en `2>/dev/null || true` y el pull de terceros en `|| true`, con `set -e` activo. Si
  el tar falla, el bundle sale trunco **sin un byte de error** y el script cierra con «OK v1.11.0»;
  el problema aparece en el sitio sin internet, que es el peor lugar para descubrirlo. Si no hay red,
  `docker save` usa la copia local que quedó de hace seis meses. *Horas.*
- **[alto] La zona horaria nunca se pregunta y el default es Uruguay.** `TZ` no aparece ni una vez en
  los dos instaladores. De `TZ` dependen `GotoIfTime()` y `STRFTIME()` del dialplan: horarios de
  atención, feriados y modo noche. Para cualquier cliente fuera de UTC-3 **la central atiende con el
  horario corrido**. Hoy funciona porque las instalaciones son uruguayas: es una suposición del
  autor, no una propiedad del producto. *Horas.*
- **[medio] El reconciliador puede revivir un módulo que el panel apagó, y no coordina con el
  operador.** Su helper `PSQL` termina en `|| true`, así que **un fallo de consulta es
  indistinguible de «no hay fila»**: en ese tick toma el default, y si el default es 1, llama a
  `pbxng-ctl enable turn` contra la voluntad del panel —y `drain_if_recreate` puede llegar a drenar
  Asterisk—. Tampoco hay lock entre el timer y `pbxng-ctl`. *(No reproducido: sin daemon Docker.)* *Horas.*
- **[medio] Todos los contenedores propios corren como root.** No es explotable por sí solo, pero
  cambia el tamaño del agujero: una RCE en cualquiera de las 254 dependencias que viajan en la imagen
  es root adentro del contenedor, y en el de Asterisk además con `NET_ADMIN` y `network_mode: host`.
  **Es lo que el equipo de seguridad del proveedor del backoffice va a preguntar en la primera
  revisión.** *Días.*
- **[bajo] `put()` corrompe el `.env` si un valor trae `|` o `&`.** Poco probable y fácil de
  descartar; se anota porque el arreglo son dos líneas. *Horas.*
- **NO MEDIDO:** el tamaño real de las imágenes y la cantidad de capas (no hay daemon Docker en el
  entorno de auditoría). Y **no se pudo verificar que nftables funcione desde el contenedor de
  Asterisk en un LXC no privilegiado de Proxmox** (`network_mode: host` + `NET_ADMIN` dentro de un
  unprivileged LXC con nesting). Si no funciona, **el panel va a decir que bloqueó una IP que sigue
  entrando**. Hay que verificarlo antes de entregar.

### 3.8 Pruebas

- **[medio] Cero pruebas del panel**: 50 páginas, 109 `.jsx`, y la CI corre `next lint` + `next build`
  + `check:deps`. Eso detecta que compila, no que la pantalla muestre lo correcto — **y el panel es
  donde nace literalmente el problema «el panel dice una cosa»**. Ya pasó dos veces (la fila del
  TURN, el Resumen repitiéndose) y ninguna prueba habría agarrado ninguna. *(La e2e de humo
  login → topología → troncales ya es deuda conocida: `EVALUACION` §5 bloque 5.)* *Semanas.*
- **[medio] No hay datos de prueba realistas ni forma de levantar una central poblada.** Cada prueba
  se arma sus filas a mano, lo que explica por qué nadie escribe pruebas de las pantallas de reporte:
  preparar el escenario cuesta más que la prueba. Y el equipo externo **va a integrarse contra una
  central vacía** donde `/api/cdr` devuelve `[]`: no van a descubrir los casos raros hasta el cliente. *Días.*
- **[medio] Cero pruebas de carga y ningún número de capacidad publicado.** Es el riesgo específico
  de esta integración: el requisito dice que una llamada nunca se cae porque el backoffice tardó, y
  **hoy nadie puede afirmarlo ni desmentirlo con un número**. Señal concreta: `bcrypt` síncrono
  bloqueaba el event loop ~90 ms por intento de login (`EVALUACION` §3.3, corregido en 1.4.0) — esa
  clase de bloqueo la encuentra una prueba de carga y nunca una funcional. *Semanas.*
- **[medio] El reconciliador de módulos —el mecanismo anti-deriva— sólo se verifica con `bash -n`.**
  Su propia cabecera documenta el incidente que lo justifica. La lógica de defaults está **duplicada
  en dos lugares que tienen que coincidir** (`DEF` en el script y `moduleEnabled()` en `app.js`), y
  hoy coinciden sólo para `turn`. Que dos fuentes de verdad diverjan sin que nada avise es
  exactamente el patrón que `metricas-nodo.test.js` ya resuelve bien para otro caso. *Días.*
- **[medio] Los módulos de operación desatendida son los menos probados**: `alerts.js` 29,8 % de
  línea y **12,3 % de ramas**, `backup.js` 37,5 %, `recstore.js` 21,4 %. Son los que corren solos, de
  noche, sin nadie mirando. Si las alertas dejan de disparar, la central se cae en silencio; si
  disparan de más, el operador las apaga y volvemos al mismo lugar. Y **nadie probó nunca que un
  respaldo de la versión N se restaure en la N+1**. *Días.*
- **[bajo] Las diez esperas fijas de `guard.test.js` son el único candidato plausible a prueba
  intermitente**, junto con `puertoLibre()`, que pide un puerto y lo suelta antes de que el hijo lo
  tome (el propio comentario reconoce la ventana). **No se observó ninguna inestabilidad** en tres
  corridas completas. Se anota con su tamaño (bajo), no como falla vista. *Horas.*

### 3.9 Integración con el backoffice (diseño, no auditoría)

Esta sección no audita: **diseña**, porque lo que hay que construir no existe. Lo importante es que
**PBX-NG ya tiene todo lo que hace falta para emitir eventos y nada de lo que hace falta para
entregarlos**: el motor ARI ya recibe `ChannelCreated`/`StateChange`/`Destroyed`, el AMI ya da
`DialBegin`/`DialEnd` con `dialstatus`, `guard.js` ya detecta el ataque, y `ccreport.js` **ya escribe
eventos a ritmo de llamada sin romper nada**. Falta la cañería.

**La decisión de diseño que hay que tomar antes de escribir una línea:** el dialplan **nunca le
pregunta al backoffice**. Le pregunta a PBX-NG, PBX-NG contesta de su propia caché en un presupuesto
duro (**200 ms**, medidos en Asterisk, no en la API), y la consulta al backoffice va por afuera del
camino de la llamada, empujada al panel del agente cuando llegue. Y hay que **escribir la excepción
al fail-safe**: para la DISA, un CURL vacío significa «rechazá» y está bien; para el screen-pop,
vacío significa «sin ficha», **nunca «cortá»**. Si eso no queda escrito al lado del otro, el próximo
que toque el dialplan lo va a romper.

- **[alto] El catálogo de eventos: qué emitir y qué lleva cada uno.** No es un defecto, es la pieza
  de diseño que falta. Sobre público `{evento_id, tipo, version, ts, call_id, leg_id, secuencia,
  datos}` idéntico para todos, y **siete tipos, sólo siete**: `llamada.entrante`, `llamada.contestada`,
  `llamada.terminada`, `llamada.transferida`, `grabacion.lista`, `interno.registrado/desregistrado`
  (con debounce: un teléfono con red mala hace flapping y no hay que contarlo 40 veces) y
  `seguridad.ataque` (agregado y con throttle, copiando el criterio que `alerts.js` ya aplica al
  correo). `version` **por tipo**, no global. Cada tipo se suscribe por separado. *Semanas.*
- **[alto] Lo que el backoffice va a ordenar: la mitad existe.** `callengine.js` ya expone dial,
  hangup, hold, unhold, transfer a ciegas, park, spy y `calls/live`. Faltan dos cosas y **ninguna es
  un endpoint**: idempotencia (ver B5) y transferencia atendida (*ya anotada como faltante*,
  `EVALUACION:207`). Para la descarga de grabaciones conviene un enlace firmado de corta vida en vez
  de exigir el token en cada GET, para que el backoffice pueda embeberlo sin filtrar la credencial. *Semanas.*
- **[medio] Las salidas HTTP existentes no degradan, y el dedup se autodestruye.** `pushDedup`,
  `missedDedup` e `incomingPushDedup` hacen `map.clear()` al pasar el tope: **borran la memoria de
  todas, no las entradas viejas**. Una central con 201 llamadas en vuelo llega al tope y el siguiente
  `DialBegin` de una llamada ya notificada **vuelve a disparar el push**. Copiar ese patrón para el
  outbox significaría reenviar eventos ya entregados justo en el momento de más carga. Para el
  outbox la unicidad la garantiza Postgres (`evento_id PK`); si hace falta caché en memoria, que
  expire **por entrada**. *Horas.*
- **[medio] No hay observabilidad de la integración.** `alerts.js` vigila troncales, failover,
  servicios, nodos, fraude y colas, y **no tiene ninguna regla para «la integración con el
  backoffice»**. Si el backoffice cambia su certificado y todos los POST fallan, los eventos se
  acumulan, el worker reintenta, el log escupe errores — y nadie mira el log. A las 72 h vencen. **El
  modo de falla es silencioso y diferido, que es el peor para un producto que se entrega a un
  tercero.** *Días.*
- **[medio] La caché de clientes del screen-pop necesita su propio contrato de sincronización.** Hay
  que decidir si reusa `pbxng_clients` —la libreta manual del CRM propio— o es tabla aparte. Si se
  reusa, el primer sync masivo **duplica la libreta que el cliente cargó a mano** (`POST /api/clients`
  no tiene `ON CONFLICT` de ninguna clase). Si es aparte y nadie lo dice, el agente ve dos fichas del
  mismo cliente en la misma pantalla. La recomendación es tabla separada con el número **ya
  normalizado como clave primaria**, porque un SELECT por PK es lo único que entra en 200 ms de forma
  confiable. *Días.*

**Esfuerzo total del camino completo de integración: 6-9 semanas de un desarrollador**, de las cuales
**las primeras 2 no se pueden paralelizar** (identidad de llamada + outbox + auth de sistemas),
porque todo lo demás cuelga de ellas.

---

## 4. Lo que está bien y NO hay que tocar

**Esta sección es tan importante como §2.** Un equipo que no conoce el producto rompe lo que no
entiende, y varias de estas piezas *parecen* mejorables hasta que uno lee el incidente que las
motivó. Todas tienen el porqué escrito en el propio código: **ese comentario es el activo, no el
código**.

### Las cinco que hay que leer antes de tocar nada

1. **`control-plane/errores.js` (88 líneas).** El mejor archivo del repo. Una sola regla de contrato
   («el cliente recibe `{error}` en castellano y **nunca** un mensaje crudo de Postgres»), traducción
   de SQLSTATE a status con criterio (23505→409, 57014→504, clase 08→503) y detección de errores de
   pg por **tres vías distintas** por si alguno llega sin `code`. Se usa en 314 lugares y deja un
   solo `e.message` crudo en todo el proyecto. **Lo único que le falta es un campo `code` estable al
   lado del mensaje legible: agregar, no rehacer.**

2. **`control-plane/rbac.js`.** Una sola tabla, deny-by-default, recorrida en orden, primera
   coincidencia gana, con el encabezado explicando qué **NO** hace el módulo. La propiedad que
   importa: **una ruta nueva agregada sin pensar en permisos nace cerrada, no abierta** — que es
   exactamente lo que hay que garantizarle a un equipo externo. La credencial de servicio debe
   **extender** esta tabla, no esquivarla. Y algunas excepciones son honestidad pura: la de
   `routes/outbound/failover` dice «era una promesa que ninguna pantalla cumple» y se bajó a admin.

3. **El gate de autenticación de `auth.js:125-158`.** Toda `/api` exige JWT salvo una allowlist
   explícita de 17 entradas, y **cada entrada no obvia tiene escrito al lado POR QUÉ es pública y qué
   la protege en su lugar**. El comentario sobre por qué «red privada» no servía de filtro —el panel
   proxya `/backend/**` y con `trust proxy = 1` la IP que ve la API es la del navegador de cualquiera
   en la LAN— es el tipo de razonamiento que normalmente se pierde y hay que redescubrir rompiendo
   algo. **No tocar la estructura; sólo falta taparle el agujero de `internal/wake`.**

4. **`control-plane/dueno-internal.js` (200 líneas).** Verificado contra el código, no contra el
   comentario: los **tres** módulos que publican en `internal` llaman `exigirLibre()` antes de
   escribir y `borrarPropio()` antes de borrar, sin excepción. Tres detalles que se ven poco y son
   los que lo hacen funcionar: el `ORDER BY (clave::text = $2) ASC` que pone la fila propia **última**
   (poniéndola primera el choque real quedaría tapado), la normalización de `_` en los dos lados, y
   el `continue` en vez de `return` cuando la fila es propia. **No tocar la lógica: generalizarla al
   contexto `ivr`.**

5. **`control-plane/test/helpers/db.js` (329 líneas).** Vale más que la mitad de las pruebas que
   sostiene: levanta un PostgreSQL efímero (bajando privilegios cuando corre como root, porque
   `initdb` se niega), aplica el esquema real **más `node migrate.js` — el mismo camino que el
   entrypoint** — y arranca `app.js` como proceso hijo. Una base y una API por archivo, sin estado
   compartido, en paralelo. **Todo lo que falta en este informe se construye encima de esto sin
   reescribir nada:** escribir una prueba nueva cuesta minutos.

### El camino de la llamada

- **El failover de troncales (`filasSalida()`, `trunks.js:358`).** La pieza mejor hecha del repo:
  saltos sólo hacia adelante con prioridades calculadas, `TOPE` chequeado **antes de cada Dial** para
  que tres troncales no sean tres timeouts encadenados, `HangupCauseClear` antes de cada intento para
  que la causa del anterior no se confunda, la marca `DB(rutasal/<id>)` escrita **antes** del Dial
  (con el comentario que explica que estaba después y por eso `alerts.js` nunca veía la transición),
  y la lectura de `HANGUPCAUSE` salteada cuando no hay claves **para no ensuciar el log**.
- **`rutaGanadora()`/`matchPatron()` (`marcacion.js:212-320`).** Reimplementan `ext_cmp1()` de
  `pbx.c` para contestar «¿por CUÁL ruta saldría de verdad este número?» en vez de «¿alguna
  matchea?». Es la diferencia entre una DISA que **dice** «sólo nacional» y una que lo **cumple**, y
  el comentario documenta el incidente exacto que lo motivó. El `empate` que niega cuando dos
  patrones son igual de específicos es lo que lo vuelve correcto y no aproximado.
- **El guardia de bucle `__SALTOS` (`extensions.conf:103-118`).** Doble guion bajo para que la
  variable sea heredable y el canal Local del sígueme se lleve el contador puesto. Un error que casi
  nadie ve hasta que la central gira sola, resuelto bien, explicado bien, **y con una prueba que lo
  verifica** (incluido que no quedó ningún `Set(SALTOS=` sin prefijo).
- **`salas.js` entero como generador de dialplan.** Prioridades fijas para que el salto no dependa de
  cuántas opciones tenga la sala, el PIN vacío rechazado **antes** de comparar (con el comentario que
  explica que `$[""=""]` metía como MODERADOR al que se quedaba callado), y `republicarDialplan()`
  comparando antes de escribir para no hacer DELETE+INSERT en cada arranque sobre una tabla que
  Asterisk lee en vivo.
- **El manejo de identidad en `*97` y en `MIEXT`:** la identidad sale de `CHANNEL(endpoint)` y no de
  `CALLERID(num)`. **Es la diferencia entre un buzón de voz y un buzón de voz de cualquiera.**
  Resuelto igual en los dos lugares y explicado en los dos.
- **El guard de `/api/internal/feature|disa|callback`:** loopback estricto + token comparado en
  tiempo constante, con el razonamiento escrito de por qué el PIN de la DISA no está en el dialplan
  (ahí lo vería cualquiera con `dialplan show`). **Es el modelo a copiar para `internal/wake` y para
  cualquier integración que el equipo externo agregue por CURL desde el dialplan.**

### Operación y resiliencia

- **El cierre ordenado por SIGTERM/SIGINT.** Deja de aceptar conexiones, cierra socket.io, corta las
  supervisiones de ARI una por una, cierra ARI/AMI/AudioSocket, espera hasta 10 s a que el pool
  suelte las consultas, y **si algo se traba, a los 15 s fuerza la salida**. Es lo que hay que hacer
  y casi nadie hace.
- **`asterisk-drain.sh`.** Reconoce que SIGTERM corta las llamadas activas, hace `core stop
  gracefully`, informa cuántas quedan cada 5 s, y **para el contenedor a propósito** para que
  `restart: unless-stopped` no lo levante aceptando llamadas justo antes del `up -d`. Y `deploy.sh`
  sólo lo llama si `--dry-run` dice que asterisk se va a recrear.
- **La degradación cuando falta infraestructura.** Medido con Postgres, ARI y AMI en puertos
  cerrados: el proceso queda **vivo**, `/health` responde 503 `degraded` en 1 ms distinguiendo
  `degraded` de `shutting_down`, y ARI reintenta 2s→4s→8s. Y `pool.on('error')` está puesto, que es
  lo que evita que un reinicio de Postgres tumbe la API entera.
- **La configuración del pool**, con el comentario de por qué cada valor. El `query_timeout` puesto a
  `statement_timeout + 5000` —por si el servidor no contesta ni a la cancelación— es un detalle que
  se le escapa a casi todos.
- **La disciplina de try/catch.** Express 4 **no** atrapa el rechazo de un handler async: una ruta
  async sin try deja la petición colgada para siempre. Acá está cubierto: 3 rutas async sin try de
  141 en `app.js`, **y se verificó una por una que ninguna de las tres puede rechazar**. Suele ser el
  agujero número uno en un Express 4 y acá no lo es.
- **`migrate.js`.** Transacción por archivo, `pg_advisory_lock` para que dos réplicas no migren a la
  vez, salida 1 que impide arrancar con esquema viejo, y **el listener del evento `notice`** que
  rescata los `RAISE NOTICE` que node-pg descarta en silencio si nadie escucha. 65 líneas que hacen
  lo correcto. Lo único que le falta es comparar el checksum que ya guarda.
- **El criterio de las migraciones.** Casi todas explican **por qué**, no sólo qué: la 0006 explica
  qué se rompe sin `Path`; la 0014 dedica 28 líneas a argumentar por qué **no** le pone PIN a las
  salas que ya existen; la 0015 explica que «una actualización nunca debe encender sola algo que
  gasta plata». **Para un equipo que no conoce telefonía esto vale más que la documentación.**
  `0018_sin_fax.sql` es el modelo de cómo se retira una función y **hay que copiarlo la próxima vez**.
- **El consumidor de eventos de cola de `ccreport.js`.** Buffer acotado con descarte y aviso a lo
  sumo una vez por minuto, un solo INSERT multi-fila, una sola conexión ocupada por vez. El
  comentario dice la regla que hay que conservar: **«el informe puede perder filas, la central no
  puede perder la llamada»**. Ese criterio es el que hay que aplicarle al outbox de eventos hacia el
  backoffice: copiarlo literalmente, no inventar otro.
- **`control-plane/guard.js`.** Protección real contra fuerza bruta SIP: consume eventos del AMI,
  banea en nftables **nunca por shell** (argv siempre, IPs validadas), detecta enumeración de cuentas
  a la primera, lista blanca y geo-bloqueo. Reemplazó a un fail2ban que no existía y tiene 18 pruebas
  propias.
- **El freno a la fuerza bruta del login:** dos límites encadenados (IP+usuario e IP sola) **con el
  razonamiento de por qué hacen falta los dos** —el primero solo no frena el password spraying, el
  segundo solo deja que cualquiera bloquee a un usuario legítimo desde otra red— y contando sólo los
  fallidos. Usa `ipKeyGenerator`, o sea maneja bien IPv6.
- **`dashboard/server.js:65-98`:** la construcción de `X-Forwarded-For` está bien pensada y bien
  explicada —el **último** elemento es siempre el cliente real, se recortan exactamente `TRUST_PROXY`
  saltos, y nunca se recorta el último—, así que un `TRUST_PROXY` mal puesto degrada a «cupo
  compartido» y no a «IP inventada». **Esa es la referencia; lo que falta es que `app.js:657` la use.**
- **El gate de módulos del Dockerfile de Asterisk.** Dos listas separadas **por consecuencia**
  (`REQUERIDOS` vs `ESPERADOS`) y el build **corta** si falta uno. Es el patrón que le falta al resto
  del empaquetado: convertir «esto tiene que estar» en una verificación en vez de un comentario. El
  mecanismo está bien; **sólo hay que corregir el contenido de la lista** (ver 3.4).
- **El `.dockerignore` raíz como lista blanca**, con el porqué arriba: negar todo y re-incluir, para
  que una carpeta nueva no se cuele en el contexto sin que nadie lo note. **Ese criterio es el que
  hay que copiar a `control-plane/`, que no tiene ninguno.**
- **`backup-cron.sh`:** `flock` para que no arranque un respaldo encima del de ayer, recorta su
  propio log al pasar 1 MB, y verifica que la API esté corriendo antes de intentar nada. El script
  más prolijo del conjunto.

### Panel

- **`app/api.js` es una buena capa y no hay que reescribirla:** normaliza el cuerpo aunque no sea
  JSON (un 502 con HTML del proxy no tapa el status real), convierte el status en un `Error` con
  `.status` y mensaje en español listo para un toast, distingue `AbortError` de un error de verdad,
  y `usePoll` pausa con `document.hidden` y recarga al volver. **El trabajo no es cambiarla: es que
  la usen los 29 archivos que todavía no.**
- **El manejo del limbo de sesión.** `user` arranca en `undefined`, `esAdmin()` resuelve del lado
  prudente, y el menú dibuja un esqueleto en vez de elegir un rol. **No tocar: la alternativa obvia
  (`!user || role==='admin'`) ya rompió antes**, y el código deja por escrito el criterio para
  agregar una pantalla a `SUP_OK`.
- **La política de encuestado de `CONTRATOS` §2 está mayormente CUMPLIDA**, y eso es raro y vale
  decirlo: verificadas las 52 llamadas, la configuración se encuesta a 30-60 s y de 31 `setInterval`,
  **29 cumplen o son relojes locales de UI que corresponde que sigan corriendo** (el cronómetro de
  llamada, la cuenta regresiva del rollback de red, el `getStats` de WebRTC durante una llamada).
- **`useLive.js` comparte UNA sola conexión de socket entre las 13 pantallas que la usan**, con el
  porqué escrito: cada socket extra es otro long-polling por el proxy.
- **`fmt.js` tiene la parte difícil bien resuelta:** `estadoInfra()` y `estadoNodo()` devuelven
  `{color, texto, detalle, medido}` y **se niegan a pintar de verde lo que no se midió** («no se
  puede comprobar» en vez de un badge verde de adorno). **Dibujar lo medido, no lo deseado** es de lo
  mejor que tiene el panel: hay que extenderlo, no diluirlo.
- **Las dos capas de error de React** (`app/error.jsx` de segmento + `ErrorBoundary` con
  `resetKey={path}`) son complementarias: una pantalla que explota no se lleva el panel.
- **`Slot.jsx` y el botón de tema** resuelven los errores de hidratación #418/#423 con el patrón
  correcto y con el comentario que explica por qué.

### Pruebas

- **`calls.test.js` es el modelo de lo que tiene que hacer el resto.** Verifica el contrato de
  degradación honesta: sin ARI, `/api/calls/live` devuelve `via:'sin-ari'` con listas vacías y
  `/api/calls/dial` devuelve **503, no 200**. Y prueba que el alcance por extensión se aplica
  **antes** que la falta de ARI. **Son 46 líneas y 16 aserciones que dicen exactamente lo correcto:
  la regla de «cómo debe responder un endpoint cuando la central no está» ya está escrita ahí.**
- **`metricas-nodo.test.js` e `imagen-asterisk.test.js`: pruebas de invariante nacidas de incidentes
  reales, estáticas, sin Docker ni base, que corren siempre.** Esta clase —barata, que fija un
  invariante que ya se rompió— es la que hay que multiplicar.
- **`marcacion.test.js` verifica el dialplan GENERADO, no sólo el 200:** que el PIN no aparezca en
  ninguna fila, que el `Dial` vaya después del `GotoIf` que valida, que haya un `TIMEOUT(absolute)`
  acotado, **que ningún salto apunte a una prioridad inexistente y que no quede ninguna etiqueta
  `<<x>>` sin resolver** — esos dos últimos son un verificador genérico que sirve para cualquier
  módulo nuevo que genere dialplan.
- **Las cabeceras de los archivos de prueba**, que abren explicando el incidente que previenen con el
  número medido. **Para un equipo externo son la mejor documentación de dominio del repositorio,
  mejor que varios de los docs.** Cualquier prueba nueva debería obligarse a lo mismo.
- **Higiene impecable:** 0 `.only`, 0 `skip`/`todo` hardcodeados, 0 aserciones tautológicas, y 62 %
  de las 873 aserciones miran cuerpo de respuesta o filas de la base, no el código HTTP.
- **La CI del backend está bien armada:** Postgres como servicio con healthcheck **más una espera
  adicional desde el job**, porque el healthcheck mira dentro del contenedor y no desde afuera
  (detalle que se aprende sufriéndolo); cuatro jobs en paralelo; y `release.yml` con `needs: ci`, así
  que un tag con pruebas rotas no publica. **La CI no es el problema; lo que corre dentro de ella sí.**

### Y una que no es código

**`docs/CONTRATOS.md` como práctica.** Documenta el mapa de dueños, los techos medidos, lo que se
paga por cada decisión y el porqué de las que parecen raras. Es la razón por la que esta auditoría
pudo trabajar sobre lo que hay en vez de adivinar. **La contrapartida es que es de cumplimiento
obligatorio:** cada pieza nueva —el outbox, los scopes, el presupuesto de 200 ms, la excepción al
fail-safe— tiene que entrar ahí **en el mismo commit que el código**, o el documento deja de ser
cierto y pierde todo su valor para el equipo que lo recibe. Los seis endpoints fantasma de §3 y las
dos contradicciones de §6 son la prueba de lo rápido que se desactualiza.

---

## 5. Plan priorizado

**Criterio del orden**, explícito para que se pueda discutir:

1. **Primero lo que ya está roto y cuesta plata o privacidad**, aunque sea barato. Un `AbortSignal`
   que evita que una llamada se muera de mutismo vale más que cualquier refactor.
2. **Después lo que no se puede paralelizar.** Identidad de llamada (`call_id`), outbox y credencial
   de servicio son el cimiento: todo lo demás de la integración cuelga de ellos. Cuanto más tarde se
   definan, más código hay que rehacer.
3. **Después las compuertas**, antes que el volumen de pruebas. Una prueba de propiedades sobre las
   346 rutas cubre más que 30 pruebas escritas a mano y **no hay que actualizarla cuando nazca la
   ruta 347**.
4. **La estructura va última y es opcional.** No falla en producción: falla en la entrega. Y mover
   código sin red de pruebas debajo es cómo se rompe lo que andaba.

### Tanda 0 — Antes de cualquier otra cosa (≈1 semana)

Todo horas, todo con consecuencia medida, nada que requiera decidir arquitectura.

| Ref | Qué | Por qué primero |
|---|---|---|
| A1 | `AbortSignal.timeout(2500)` en `crmLookup()` + `Promise.race` contra la frase de degradación que el código ya tiene escrita | Es el único lugar donde una llamada se cae por el backoffice. Medido a 90 s. |
| A2 | `CURLOPT(conntimeout)`/`(timeout)` en los 4 puntos del dialplan + `curl.conf` | Mismo problema por el otro camino, y es lo que el equipo externo va a copiar |
| C4 | Guard de loopback+token a `/api/internal/wake` (reusar el de `telefonia.js`) | Tres líneas. Push falso sin sesión a cualquier interno |
| C2 | `req.ip` en `app.js:657` + `express-rate-limit` (ya es dependencia) | Una línea. 30/30 medido, y un `Map` sin poda contra un `mem_limit` de 768m |
| C5 | `if (propio === '') return 403` en las dos rutas de grabaciones | Dos líneas. `/api/cdr` ya lo hace: es copiar |
| A7 | `UPDATE pbxng_record` dentro de la transacción + `await setRecFlag()` + campo de aviso en la respuesta | El patrón de aviso ya existe en `telefonia.js` y `salas.js` desde 1.11.0 |
| D1 | Migración con 3 índices sobre `cdr` + reescribir el predicado de `recordings.js:293` como `start BETWEEN` | 100× y 270× medidos. 90 MB de costo |
| D2 | Comparar el checksum que `migrate.js` ya calcula | Un `if` de cinco líneas que convierte un error silencioso en un contenedor que no arranca |
| D5 | `control-plane/.dockerignore` + sacar los `\|\| npm install` de los dos Dockerfiles | La imagen deja de depender de la máquina de quien la arma |
| C7 | `preflight_secrets` sobre los 7 secretos, y correrlo también en el camino de actualización | Tres nombres en un `for`. Es el mecanismo por el que sobrevive un secreto de ejemplo |
| D6 | `install.sh` escribe `PBXNG_REGISTRY`/`PBXNG_VERSION`; el bundle lleva su propio `.env` | Hoy el camino `--release` y el air-gapped **no arrancan** |
| D10 | Taguear el estado actual + job de CI que valide `VERSION` ↔ tag ↔ `CHANGELOG` | El equipo externo no tiene forma de saber qué versión es la buena |
| E4 | Borrar los 9 archivos muertos **en el mismo commit** que corrige `CONTRATOS` §2 y el comentario de `check-deps-inestables.mjs` | El contrato cita como vivo lo que nadie importa |
| F2 + B8 | Corregir las contradicciones documentación↔código (3 de despliegue, 6 endpoints fantasma, `CONTRATOS` §9 vs §Salas) | Media hora perdida cada una, y una de ellas invita a romper la paridad del compose |

**Decisión aparte, explícita y no por omisión:** si la captura de paquetes tiene que existir, colgar
`PcapCapture` de `/red` o `/asterisk`; si no, borrar también `/api/capture/*`. Hoy son 5 endpoints
vivos sin pantalla (*pedido a `api` y a `panel`*).

### Tanda 1 — El cimiento de la integración (≈2-3 semanas, no paralelizable)

Nada de esto se puede empezar por la mitad, y **cuanto más tarde se decida, más código hay que
rehacer**.

1. **Identidad de llamada (B6).** Decidir y escribir en `CONTRATOS`: `call_id = linkedid`,
   `leg_id = uniqueid`. Agregar las dos columnas al SELECT de `/api/cdr`. Sin esto no hay
   idempotencia, ni orden, ni conciliación.
2. **Credencial de servicio (B2).** Tabla `pbxng_api_clients` con `client_id`, hash del secreto,
   alcances, `revoked_at`, `last_used_at`. Token con `scope:'service'` y verificación **contra la
   tabla**, no sólo la firma, para que revocar sea un UPDATE. **Extender la tabla de `rbac.js`, no
   esquivarla.** El repo ya diseñó esta forma para el producto hermano (`docs/SBC-NG-SPLIT.md`
   §attach): copiarla.
3. **Outbox de eventos (B1).** Tabla `pbxng_eventos_salida`, productor que **encola en memoria y no
   toca el pool**, volcado en INSERT multi-fila, worker con backoff y concurrencia 1 por destino,
   orden **por llamada** (no global), retención y tope con descarte del más viejo + alerta.
   **Copiar `ccreport.js` literalmente** y escribir el techo en `CONTRATOS` como se escribió el suyo.
4. **`/api/v1` (B4).** Congelar **las 20-30 rutas que el backoffice necesita**, no las 346. Política
   de compatibilidad en una línea que el equipo externo pueda citar: dentro de `v1` sólo se agregan
   campos; un cambio incompatible es `v2` con las dos en paralelo por un plazo.
5. **Idempotencia (B5).** Middleware de `Idempotency-Key` con tabla `(client_id, key) → (status,
   cuerpo)` y vencimiento de 24 h. **Es un middleware, no un cambio por ruta.** Más la guarda propia
   de `/api/calls/dial` (409 ante un originate repetido hacia el mismo `(from,to)` dentro de la
   ventana) y el UNIQUE en `pbxng_clients` que `errores.js` ya traduce a 409.
6. **Paginación del CDR (B3).** `from`/`to` con rango máximo, cursor sobre `(start, uniqueid)`,
   `{items, next_cursor}`, y **el tope aplicado explícito en la respuesta** para que un truncamiento
   nunca sea silencioso.
7. **La decisión de diseño del screen-pop (§3.9).** Presupuesto de 200 ms, caché local con el número
   normalizado como PK, y **la excepción al fail-safe escrita en `CONTRATOS` al lado del original**.

### Tanda 2 — Compuertas (≈2 semanas) — *empieza en paralelo con la Tanda 1*

Estas pruebas no cubren casos: **fijan propiedades**, así que cubren las 346 rutas de una y no hay
que mantenerlas.

| Ref | Prueba | Qué habría atrapado |
|---|---|---|
| D12 | `npm test` **falla** sin Postgres salvo `PBXNG_TEST_ALLOW_SKIP=1`, y la CI corta si `skipped > 0` | **Primero de todo: sin esto, todo lo demás se puede desactivar sin querer** |
| — | Propiedades sobre `app._router.stack`: ningún 2xx con campo `error`, toda ruta de lista con tope, cada entrada de `PUBLIC_API` con guardia o excepción escrita | Las 11 respuestas de 200-con-error, los 7 `rows[0] \|\| {}` y `internal/wake` |
| D14 | Barrido de RBAC **generado desde la tabla**: 50 reglas × 3 roles + aserción de completitud | Las 28 reglas que hoy no se ejercitan, incluidas las de grabaciones y CDR |
| D13 | AMI falso (siguiendo `turn-falso.js`, que ya existe) + una prueba por endpoint `*/apply` | Los 200 con Asterisk ausente, medidos |
| D4 | Conformidad de esquema: dos bases, comparar `information_schema` | «DB al día» con tres pantallas devolviendo 500 |
| B8 | La documentación no miente: lista de rutas del router vs. OpenAPI | Las 6 rutas fantasma y el conteo de «285» |
| A4 | Choque en el contexto `ivr` (5 combinaciones cruzadas) — el molde ya está escrito en `trunks.test.js` y `marcacion.test.js` para `internal` | El ring group que borra el dialplan de la sala |
| A1 | Degradación: servidor que acepta y no responde, `crmLookup()` devuelve en <3 s. **En CI, para que no se pierda** | La llamada que se muere de mutismo |
| D9 | Job que construya las 5 imágenes sin push + job que corra `install.sh` en un runner limpio | Un Dockerfile roto que hoy aparece 30-50 min después, en el release |
| D7/D8 | Paridad extendida al mapa servicio→imagen, con sus propias pruebas negativas; y validar los perfiles contra la lista de módulos | `postgres:15` en el release, y `core,turno` |

### Tanda 3 — Cobertura por costo del error (≈3-4 semanas)

No apuntar a un porcentaje: **apuntar a las rutas que cuestan plata si se rompen**. En este orden:
`/api/calls` completo (9 rutas: escucha, susurro, irrupción, transferencia, aparcado — es lo que el
backoffice va a ordenar) → `/api/recordings` + `/api/cdr` (datos del cliente final) → `/api/security`
(una lista blanca mal escrita deja la central abierta o al cliente afuera) → `/api/backup` incluida
la restauración → `apps.js` (colas, IVR, buzones: **49 rutas, 940 líneas, cero pruebas**). Meta de
primera vuelta: **200 de 350 rutas**.

Junto con: las listas blancas de `apps.js` (A3), el tope del IVR (A5), la coherencia
estático↔realtime (A6), las validaciones de troncal y DID (3.4), y **el juego de datos de demo**
(`docker/config/seed/demo.sql` detrás de un perfil), que habilita las pruebas de reportes, sirve de
demo y **es cómo el equipo externo va a entender el dominio**.

### Tanda 4 — Estructura (opcional, ver §5.1)

### Tanda 5 — Lo que no cierra sin laboratorio

El **laboratorio con Asterisk y llamadas sintéticas** (SIPp sobre el compose que ya existe) es lo más
caro de todo el informe: **1-2 semanas de montaje, ~1 hora por caso después** *(estimación, no
medición: no se construyó la imagen)*. Es lo único que cierra el camino de la llamada de verdad, y
es el prerrequisito de la e2e de humo del panel, de la prueba de carga combinada (30 llamadas
cursando mientras se martilla `/api/cdr`), y de verificar A6 y A2 contra un Asterisk corriendo.

**Además, antes de entregar hay que verificar dos cosas que esta auditoría no pudo:**
(a) que **nftables funcione desde el contenedor de Asterisk en un LXC no privilegiado de Proxmox**
—si no funciona, el panel dice que bloqueó una IP que sigue entrando—; y (b) el **ciclo de
actualización A→B→A con datos adentro**, que nadie corrió nunca y es donde vive el riesgo de pérdida
de datos de las migraciones destructivas.

---

### 5.1 Los dos refactores, como opciones

El dueño pidió **auditar y medir antes de decidir**. Estos dos no están decididos: van con su riesgo
y su beneficio medidos, para que se elija.

#### Opción A — Cortar `app.js`

**Lo medido:** 2.389 líneas, 152 registros de ruta, 127 rutas `/api` distintas, 63 funciones de nivel
superior, **18 dominios**. Sólo **6 de 127 rutas (4,7 %)** aparecen en alguna prueba. Es donde
aparecieron las 11 respuestas de 200-con-error y 3 de los 7 `rows[0] || {}`: **la densidad de
inconsistencias es más alta justo en el archivo sin dueño, que es lo esperable.**

**El beneficio no es que funcione mejor — funciona bien.** Es que (1) la regla «cada archivo tiene UN
dueño» de `CONTRATOS` §1 **está rota hoy** (Portería vive dentro del archivo de `api`) y después de
la entrega son dos equipos editando el mismo archivo; (2) un equipo que no conoce telefonía y abre
`app.js` por primera vez tiene que entender 18 dominios para cambiar uno; (3) las rutas del contrato
público más relevantes —todo el CRM de `/api/clients`— están mezcladas con el arranque del proceso,
el montaje del gate de auth y la conexión AMI/ARI.

**El riesgo es real y desparejo, y por eso el orden importa.** Corte propuesto, cada paso un commit
verde:

| Paso | Qué | Riesgo | Por qué |
|---|---|---|---|
| **1** | **`porteria.js`**: líneas 2073-2338 (265 líneas, 26 rutas) + sus auxiliares | **BAJO, verificado** | Bloque contiguo que termina justo antes del 404; los cuatro auxiliares (`crmNormNum`, `rtspMask`, `deviceSafe`, `syncGo2rtc`) **no se usan en ninguna otra parte del archivo**; sólo necesita `pool`, `logger`, `errorHttp` y `GO2RTC_MGMT`. Y le da al agente `porteria` el archivo que el contrato ya le adjudicó |
| **2** | **`respaldos.js`**: 9 rutas + `bkSchedule`/`bkTick` | **BAJO** | Bloque contiguo; `backup.js` ya existe como auxiliar |
| **3** | **`endpoints-sip.js`**: sacar `createSipEndpoint`, `createWebrtcEndpoint` y `setDialplan` a un módulo compartido | **MEDIO** | **No mueve rutas, sólo funciones — pero toca ocho consumidores.** Hay que hacerlo **antes** del paso 6, porque esas tres las usan a la vez `/api/endpoints`, el provisioning y el click-to-call |
| **4** | **`host.js`**: captura pcap, `/api/net/mode/*`, `/api/asterisk/*` (18 rutas) | **MEDIO** | `astFwd` lo usan también `apps.js`, `guard.js` y `trunks.js` por deps: **o se queda en `app.js` o sale a su propio módulo primero** |
| **5** | **`audios.js`**: prompts, sysprompts y voz (19 rutas) | **MEDIO** | Por estar disperso en cuatro bloques, no por el contenido, que es autónomo |
| **6** | **`internos.js`**: extensions, endpoints, integrations, settings | **ALTO sin el paso 3; BAJO con él** | — |

**Regla operativa que ya está escrita en `CONTRATOS` §1.1 y hay que respetar en cada paso:** los
módulos se registran **después** del gate de auth y de `rbac.middleware`, y el 404 de `/api` más
`errores.middlewareFinal` quedan últimos. El comentario del gate dice textualmente que `callengine.js`
ya quedó una vez fuera del gate por registrar rutas antes.

**Quedan ~1.200 líneas en `app.js`:** arranque, configuración, pool, ARI/AMI, socket.io, salud y
cableado — que es lo que `app.js` debería ser.

**Recomendación:** hacer **el paso 1 ahora** (riesgo bajo verificado, resuelve una violación del
propio contrato, y es donde están las rutas del contrato público). Los pasos 3-6 **después de la
Tanda 3**, porque mover código con 4,7 % de cobertura debajo es cómo se rompe lo que andaba.

#### Opción B — Reestructurar el panel

**Lo medido, y es distinto de lo que parece:** «60 componentes sueltos en la raíz» **no son 60
componentes**. Son **9 archivos muertos** (1.067 líneas), **32 archivos con exactamente UN
importador** —o sea secciones de una página que viven en la raíz por costumbre— y **apenas 11 piezas
realmente compartidas** (>2 importadores).

**La regla que propone la auditoría es medible y no opinable: si un archivo tiene un solo importador,
no es compartido y no va en la raíz.** Estructura por **dominio y no por tipo**, porque la tabla de
dueños de `CONTRATOS` §1 ya reparte el trabajo por dominio: así cada dueño tiene una carpeta y no una
lista de 68 nombres.

**Beneficio:** un desarrollador externo que abre `dashboard/app/` hoy ve 68 archivos en una lista
plana y **no tiene forma de saber cuáles puede tocar sin afectar a otra pantalla**. Concreto:
`TurnOrigen.jsx` (299 líneas) y `TurnConsole.jsx` (168) *parecen* compartidos por estar junto a
`PageHeader.jsx` y son secciones exclusivas de `/configuracion`; al revés, `RecordingPlayer.jsx` y
`Intercom.jsx` sí son compartidos y están mezclados sin ninguna señal.

**Riesgo: ALTO, y hay que decirlo sin adornos. `dashboard/` no tiene NI UNA prueba.** Mover 68
archivos sin una sola red debajo es la peor relación riesgo/beneficio del informe. **Es también el
refactor menos urgente:** no falla en producción y no bloquea la integración.

**Recomendación: no hacerlo todavía.** Hacer primero lo que sí es urgente y **de bajo riesgo** en el
panel: (1) borrar los 9 archivos muertos con la corrección del contrato en el mismo commit (E4,
Tanda 0); (2) ampliar `check:deps` para marcar expresiones inestables sin fallback literal **y** poner
un `eslint-disable` **con la razón escrita** en cada omisión deliberada (E1) —un warning silenciado
con razón es documentación, uno suelto es una invitación a romperlo—; (3) subir la firma de payload
del `usePoll` de `/seguridad` al compartido; (4) el componente `<EstadoCarga>` por las 52 llamadas.
**La reestructura de carpetas, después de que exista el smoke test de navegación.**

---

## 6. Contradicciones entre secciones (sin resolver)

Las secciones se auditaron en paralelo y algunas midieron lo mismo con métodos distintos. **No se
eligió una:** quedan acá para que las decida el dueño, porque cuál se elija cambia lo que el equipo
externo va a leer.

1. **El conteo de rutas.** `api` mide 352 registros / 346 método+path únicos; `backend` 350 / 272
   «distintas»; `seguridad` 352; `pruebas` 350 Express / 269 distintas; `integracion` 269.
   **Verificación propia hoy:** 361 registros `app.<método>(` y **346 pares método+path únicos bajo
   `/api`**. Las diferencias son metodológicas (¿se cuenta `app.use`? ¿se colapsan los `:id`? ¿se
   cuentan las rutas fuera de `/api`?). **Hay que fijar UNA definición y escribirla**, porque
   `CONTRATOS` §3 ya declara un número («285») que nadie puede reproducir.
2. **La cantidad de pruebas.** Cinco secciones dicen **158 casos**; `datos` dice **«216 pruebas en
   `control-plane/test/`»**. Verificado: 20 archivos `.test.js`. Probablemente `datos` contó
   aserciones o subtests. **Prevalece 158 hasta que alguien lo reconcilie.**
3. **La cobertura de rutas.** `backend` reporta **50 de 272 (18 %)**, contando rutas *citadas* en los
   archivos de prueba; `pruebas` reporta **104 de 350 (29,7 %)**, midiendo *requests reales* con un
   middleware instrumentado. **La segunda es más confiable por método**, pero la primera es más
   conservadora. Ninguna cambia la conclusión.
4. **Los `catch` vacíos.** `backend` cuenta **185** (incluyendo `.catch(() => {})`), `pruebas` **176**,
   y `EVALUACION` §3.7 registra **97**. Criterios de conteo distintos. Lo que **no** cambia: son **14
   los que envuelven una escritura**, y esos son los únicos que importan.
5. **Los `fetch()` sin timeout.** `backend` dice **14 de 34**; `integracion` dice **18 de 34**. La
   diferencia probablemente está en si se cuentan los del pipeline de IA y los de go2rtc. **Hay que
   contarlos una vez y arreglarlos todos**, que es más barato que discutir el número.
6. **`PUBLIC_API`.** `api` y `seguridad` cuentan **17 entradas**; `integracion` cuenta **16**.
7. **`CONTRATOS.md` se contradice consigo mismo sobre la migración 0014.** §9 dice que «le pone un
   PIN al azar a las salas viejas que no tenían»; la §Salas del **mismo documento** dice, en negrita,
   que **«la migración 0014 *no* les pone PIN»**. **El archivo de migración confirma la segunda
   versión y dedica 28 líneas a explicar por qué se sacó ese UPDATE.** El párrafo de §9 quedó de la
   versión anterior. No es una falla de software: es una falla de entrega, y §9 es justamente la
   sección «migraciones» que el equipo externo va a leer para contestarle a un cliente «¿mis salas
   viejas quedaron protegidas?».

---

## 7. Qué NO se pudo medir

Para que nadie lea este informe como si fuera exhaustivo:

- **No hay Asterisk corriendo en el entorno de auditoría.** Todo lo de dialplan sale de leer el
  código y de correr los generadores en node, no de cursar una llamada. En particular: la precedencia
  estático↔realtime (A6) se afirma por la documentación de Asterisk y por el parche `DIALPLAN_EXISTS`
  del propio repo; el timeout por defecto de `func_curl` no se midió, sólo se verificó que **no hay
  ninguno configurado**.
- **No hay daemon Docker.** No se pesaron las imágenes ni se contaron capas; no se reprodujo la
  degradación del `agent.token` ni la carrera entre `pbxng-ctl` y el reconciliador.
- **No se probó una central instalada.** La exposición de `:8091`, `:8080` y `:1984` se deduce del
  bind y del compose; no se confirmó con un `curl` desde afuera. Tampoco se probó un relay TURN
  contra una dirección privada, ni se confirmó contra la imagen real que go2rtc arranque sin auth.
- **No se pudo provocar agotamiento del pool.** 100 peticiones concurrentes sobre una base vacía
  dieron 100 × 200 en 200 ms. **No se afirma que el pool de 10 sea insuficiente**: se afirma que no
  hay nada que impida averiguarlo en producción.
- **No se midió el panel corriendo contra una API viva:** ni el conteo real de renders por ciclo, ni
  el peso transferido con compresión, ni el tiempo hasta el primer píxel, ni la accesibilidad con
  lector de pantalla (el conteo de `aria-label` es un indicio, no un veredicto).
- **No se conoce el tamaño ni el ritmo de crecimiento de la base en ninguna instalación real.** Los
  bytes por fila están medidos para que se proyecte con volúmenes propios.
- **Tres corridas no alcanzan para afirmar nada sobre inestabilidad de las pruebas.** No se observó
  ninguna.
