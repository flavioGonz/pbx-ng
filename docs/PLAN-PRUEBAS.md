# Plan de pruebas de PBX-NG

Documento de trabajo, no de archivo. Se escribió para la entrega a un equipo de desarrollo
externo —el del proveedor del software de gestión backoffice— que **no conoce telefonía ni este
producto**, y para una integración **bidireccional**: la central avisa lo que pasa y el backoffice
le ordena cosas.

Dueño: agente `docs`. Cada bloque nombra al agente que tiene que escribir las pruebas.
Complementa `docs/CONTRATOS.md` §10 (la red de seguridad que YA existe) y
`docs/EVALUACION-2026-09.md` §5 bloque 5 (lo que ya estaba anotado como pendiente).
Si algo de acá contradice a uno de esos dos, gana el que esté verificado en el código y hay que
corregir el otro en el mismo commit.

---

## 0. Cómo se lee este documento

Cada ítem del plan trae cinco cosas y ninguna es opcional:

| Campo | Qué dice |
|---|---|
| **Qué se prueba** | La propiedad, no el endpoint. «Un 2xx nunca trae un campo `error`», no «probar /api/clients». |
| **Tipo** | Unitaria con mocks · Integración (API real + Postgres efímero) · Estática (archivo contra código) · Propiedad (recorre TODO el router) · E2E · Carga |
| **Dato** | De dónde sale el escenario: base vacía, semilla `demo.sql`, mock, volcado real. |
| **Aprobado si** | La condición binaria. Si no se puede escribir como una condición, la prueba no está definida todavía. |
| **Quién** | 🟢 **Externo**: lo puede escribir alguien que no sabe telefonía, leyendo el código. 🔴 **Telefonía**: hace falta alguien que sepa qué hace Asterisk con eso. 🟡 **Mixto**: el externo lo escribe, alguien de telefonía define el criterio de aprobado. |

Y además el **esfuerzo** en horas / días / semanas, con el mismo criterio que la auditoría.

---

## 1. Punto de partida, medido

Esto es lo que hay hoy. Los números son de esta auditoría, re-verificados sobre el repo:

- **350 registros de ruta** (`app.<método>(`) en `control-plane/*.js`, **346 pares método+path
  únicos bajo `/api`**, repartidos en **13 archivos**.
- **20 archivos de prueba**, **53 pruebas de nivel superior**, **158 casos**, **~44 s**, 0 fallos
  en tres corridas. Sin un solo `.only`, sin `skip`/`todo` hardcodeados, sin aserciones
  tautológicas.
- **873 aserciones**; **539 (62 %)** miran cuerpo de respuesta o filas de la base, no sólo el
  código HTTP. Es una relación sana y hay que conservarla.
- **Cobertura de rutas: 104 de 350 reciben al menos un request en toda la suite (29,7 %)**, medido
  instrumentando un middleware de log. `recordings.js` 0/18, `sipconf.js` 0/3, `app.js` 13/152
  (9 %), `apps.js` 5/49 (10 %).
- Cobertura de línea del código fuente ≈ 67,5 %; `app.js` 55,8 % de líneas pero **23,3 % de
  funciones** — ese segundo número es el honesto: la mitad de los manejadores nunca corre.
- **Tabla RBAC: 22 de 50 reglas se ejercitan alguna vez.** `rbac.js` reporta 100 % de líneas.
- **0 pruebas** en `dashboard/` (50 páginas, 109 `.jsx`), en `softphone-app/`, en `voice-service/`
  y en `agents/`. **0 pruebas abren un socket.io.** **0 tocan una salida HTTP** (webhooks,
  Telegram, WhatsApp). **0 llamadas sintéticas**: no hay Asterisk en ningún circuito de prueba,
  ni SIPp ni equivalente en el repo.
- **No hay OpenAPI** y **no hay ninguna ruta versionada** (`/api/v1`): no existe contrato que un
  tercero pueda verificar automáticamente.
- CI: 4 jobs (`api`, `dashboard`, `compose`, `shell`). **Ninguno construye una imagen Docker**
  y ninguno ejecuta `install.sh`, `deploy.sh` ni `release.sh`.

**Lo que está bien y no hay que rehacer:** `control-plane/test/helpers/db.js` (329 líneas) levanta
un PostgreSQL efímero con el esquema real (`01-schema.sql` + `node migrate.js`, el mismo camino
que `docker-entrypoint.sh`) y arranca `app.js` como proceso hijo. Una base y una API por archivo,
en paralelo. **Todo lo de este plan se construye encima de eso sin reescribir andamiaje**: escribir
una prueba nueva cuesta minutos.

---

## 2. Contradicciones entre los informes, antes de citar un número

Las nueve secciones de la auditoría midieron por su cuenta y no coinciden. No elijo una: las dejo
anotadas para que el equipo que reciba no cite el número equivocado en una propuesta.

| Magnitud | Valores reportados | Qué pasa |
|---|---|---|
| Rutas registradas | 352 (api, seguridad) · 350 (backend, pruebas, integración) | **Medido de nuevo: 350** `app.<método>(`. El 352 incluye `app.use('/api…')`. |
| Rutas `/api` distintas | 346 método+path (api) · 272 (backend) · 269 (integración) | **346** son pares método+path; 272/269 cuentan *paths* colapsando métodos. Son tres magnitudes distintas con el mismo nombre. **Hay que fijar una definición en `CONTRATOS.md` §3** y usar siempre esa. |
| `catch` vacíos en el backend | 185 (backend, incluye `.catch(() => {})`) · 176 (pruebas) · 97 (`EVALUACION` §3.7) | Los tres contaron cosas distintas y ninguno lo dice. El número que importa no es el total: son los **14 que envuelven una ESCRITURA**. |
| Casos de prueba | 158 (seis secciones) · 216 (datos) | **158**, verificado. |
| Familias `/api` | 82 (api) — no reportado por el resto | Sin contraste. |

**Pedido a `api`:** definir en `CONTRATOS.md` §3 qué cuenta como «una ruta» y publicar el comando
exacto que la cuenta, para que el conteo deje de ser una opinión. Hoy §3 declara «285 rutas
(1.6.0)» contra 350 reales.

---

## 3. Qué se considera una prueba que sirve

Reglas de aceptación para toda prueba nueva de este plan. No son estilo: son lo que separa una
suite que protege de una que da verde.

1. **Cabecera obligatoria.** Cada archivo abre explicando *qué incidente previene*, con el número
   medido cuando lo hubo. El repo ya lo hace y es la mejor documentación de dominio que tiene
   (`metricas-nodo.test.js`: «los tres agentes contestaban `mem_total_mb` 35948, `ncpu` 12 y
   `uptime_s` 3130369 — IDÉNTICOS hasta el segundo»). Para un equipo que no sabe telefonía, esa
   cabecera vale más que un comentario en el código.
2. **Prueba negativa obligatoria.** Toda prueba de degradación necesita el caso feo, no el fácil:
   un servidor que **acepta la conexión TCP y nunca responde** (no uno que rechaza — un rechazo es
   instantáneo y no prueba nada).
3. **Preferir propiedades a listas.** Una prueba que recorre `app._router.stack` y afirma un
   invariante sobre las 350 rutas no hay que actualizarla cuando nazca la 351. Una lista escrita a
   mano sí, y nadie la actualiza.
4. **Sin esperas fijas** salvo donde el timing sea el objeto de la prueba. Hoy hay 13 (`guard` 10,
   `ccreport-consumidor` 3, ~360 ms sumados) y son el único candidato plausible a intermitencia.
5. **Aserción sobre el efecto, no sobre el código HTTP.** Mantener la relación de 62 % que ya
   existe: se verifica la fila en la base o el campo del cuerpo, no que la ruta devolvió 200.

---

## 4. Orden de construcción

Siete bloques. El orden importa: **B0 y B1 no se pueden paralelizar** porque todo lo demás cuelga
de ellos, y sin B0 cualquier cosa de este plan se puede desactivar sin querer.

```
B0  Guardas del arnés          (horas)     ← sin esto, el resto es decorativo
B1  Propiedades del contrato   (días)      ← cubre las 350 rutas de una
B2  Degradación honesta        (días)      ← "el panel dice ≠ la central hace"
B3  Cobertura por costo        (semanas)   ← las familias que cuestan plata
B4  Contrato con el backoffice (semanas)   ← depende de que exista /v1 y la credencial de sistema
B5  Esquema, datos y respaldo  (días)      ← el peor día
B6  Laboratorio de llamadas    (semanas)   ← lo único que cierra el camino de la llamada
B7  Carga y capacidad          (días+B6)   ← el número que va en una propuesta
```

---

## B0 — Guardas del arnés · horas · 🟢 externo · dueño: `api`

Lo primero, antes que todo lo demás.

### B0.1 · `npm test` no puede dar verde sin haber probado

- **Qué se prueba:** que la suite falle en vez de saltear cuando falta PostgreSQL.
- **Tipo:** guarda del arnés + paso de CI.
- **Medido hoy:** con los binarios de Postgres ocultos, `node --test test/*.test.js` da
  **«# pass 43, # fail 0, # skipped 13», código de salida 0** — contra «# pass 158» con Postgres.
  Son **~110 de 158 casos (70 %) que desaparecen en silencio**: toda la integración de auth, RBAC,
  usuarios, troncales, telefonía, marcación, salas, buzón, portería, ccreport y calls.
- **Por qué importa para la entrega:** está documentado como decisión deliberada en
  `CONTRATOS.md` §10 («nunca falla por falta de infraestructura: eso taparía fallos reales»), y
  para el equipo de hoy es razonable. Para un equipo externo que monte su propio CI es una trampa
  perfecta: verde en 4 segundos en vez de 44, sin que se haya tocado una sola ruta.
- **Aprobado si:** sin base y sin `PBXNG_TEST_ALLOW_SKIP=1`, el archivo **falla** con el mismo
  mensaje claro que hoy imprime; y un paso de CI lee el resumen TAP y corta si `skipped > 0`.
- **Esfuerzo:** 4 líneas en `db.js`, 3 en `ci.yml`.
- **Pedido a `docs`:** corregir `CONTRATOS.md` §10, que hoy documenta el salteo silencioso como
  política correcta.

### B0.2 · Quitar la intermitencia antes de que aparezca

- **Qué se prueba:** nada nuevo; se saca el timing real de `guard.test.js` (10 esperas) usando
  `MockTimers` de `node:test`, y `puertoLibre()` deja de adivinar (el hijo escucha en el puerto 0
  e informa por stdout cuál consiguió).
- **Estado medido:** **no observé ninguna intermitencia** en tres corridas completas. Lo anoto
  como riesgo dimensionado, no como falla vista: el propio comentario de `puertoLibre()` reconoce
  la ventana entre el `close()` y el `spawn`, y la suite abre 4 puertos por archivo con 20
  archivos en paralelo.
- **Aprobado si:** 50 corridas consecutivas de la suite completa sin un fallo.

---

## B1 — Propiedades del contrato · días · 🟢 externo · dueño: `api`

Una prueba que recorre **todas** las rutas registradas vale más que veinte escritas a mano, y no
hay que tocarla cuando nazca la ruta 351. Estas cuatro juntas habrían atrapado, sin conocer el
producto: las 11 respuestas de 200-con-error, los 7 `rows[0] || {}`, `/api/internal/wake` sin
guarda y las 6 rutas fantasma de la documentación.

### B1.1 · Invariantes sobre el router entero

- **Qué se prueba**, recorriendo `app._router.stack` y no una lista:
  - (a) Ninguna respuesta 2xx trae un campo `error`. *Medido hoy: **11 lugares** hacen
    `res.json({ok:false, error})` o `res.json({error})` sin tocar el status —
    `app.js:943, 1004, 1005, 1007, 1010, 1016, 1017, 1019, 1023, 2303, 2304`.*
  - (b) Un recurso que no existe devuelve 404, no 200 con cuerpo vacío. *Medido: **7 lugares**
    hacen `rows[0] || {}` / `|| null` — `app.js:2258`, `recordings.js:244` y `:256`,
    `app.js:1717`, `alerts.js:30`, `apps.js:464`, `telefonia.js:441`.*
  - (c) Toda ruta de lista aplica un tope.
  - (d) **Cada entrada de `PUBLIC_API` tiene un guardia o una excepción declarada por escrito.**
- **Tipo:** propiedad + integración.
- **Aprobado si:** cero violaciones, o una lista blanca con el motivo escrito al lado de cada
  excepción.
- **Cómo falla hoy, concreto:** el backoffice hace `PUT /api/clients/47` sobre una ficha que
  alguien borró mientras tanto. `UPDATE … RETURNING *` no afecta ninguna fila, `rows[0]` es
  `undefined`, la API responde **`200 {}`**, el cliente HTTP marca la sincronización como exitosa
  y sigue. La divergencia entre los dos sistemas crece en silencio.
- **Esfuerzo:** un archivo, ~120 líneas.

### B1.2 · Barrido de RBAC generado desde la tabla

- **Qué se prueba:** para cada una de las **50 reglas** de `PERMISOS` × cada uno de los 3 roles, un
  request real y una aserción de 403 / no-403. Más una aserción de completitud: toda ruta declarada
  en Express coincide con una regla o está en una lista blanca explícita del default.
- **Por qué es urgente:** `rbac.js` reporta **100 % de líneas y 94 % de ramas** y **28 de las 50
  reglas nunca se ejercitan**. El bucle recorre la tabla: con que UNA regla coincida, la línea del
  bucle queda cubierta. Las 28 no ejercitadas incluyen justamente las que dicen `TODOS` porque
  confían en que la RUTA acote después por extensión propia: `GET /api/cdr`,
  `GET /api/recordings/\d+/audio`, `GET /api/recordings/match`, `GET|POST /api/vm*`, `* /api/me`.
- **Estado real, verificado a mano:** hoy **funcionan bien** (403 / filtrado por extensión propia).
  Esto **no es un arreglo, es un congelamiento**: `recordings.js` está al 41 % de línea y 0/18
  rutas probadas, y el día que alguien toque `extPropia()` la cobertura va a seguir diciendo 100 %
  mientras un agente se baja las grabaciones de todos.
- **Aprobado si:** 150 aserciones pasan y ninguna ruta cae al default sin estar declarada.
- **Esfuerzo:** ~80 líneas. **Quién: 🟡 mixto** — el externo lo escribe; quién decide qué rol debe
  ver qué es de acá.

### B1.3 · Alcance por extensión sobre datos de otro

- **Qué se prueba:** agente del interno A pidiendo CDR, grabaciones, audio de grabación, buzón,
  audio de buzón y transcripción del interno B. Seis rutas × (agente, supervisor, admin).
- **Dato:** dos internos y filas de CDR/grabaciones de cada uno.
- **Caso borde obligatorio**, que hoy **falla**: `extPropia()` devuelve `''` para un agente sin
  interno asignado, y `''` matchea con todo. Reproducido: agente sin interno + grabación con `src`
  NULL → **PASA**; `GET /api/recordings/match?from=&to=…` → **PASA** y devuelve el id, que después
  se descarga por `/audio`. `/api/cdr` sí contempla el caso (`if (propio === '') return 403`), las
  otras dos no.
- **Aprobado si:** 403 en las tres rutas para un usuario con alcance limitado y sin `ext`.
- **Quién: 🟡 mixto.** Es privacidad de llamadas de terceros, no una regla de permisos cualquiera.

### B1.4 · La documentación no puede mentir

- **Qué se prueba:** generar la lista de rutas del router y compararla contra el OpenAPI (cuando
  exista) o contra la tabla de `CONTRATOS.md` §3; fallar si divergen.
- **Medido hoy:** §3 declara «285 rutas (1.6.0)» contra 350 reales — **67 rutas nacieron sin que
  el conteo se moviera**. Sólo 68 pares método+path aparecen explícitos, y **6 de esos ya no
  existen en el código**: `DELETE /api/ccreport/schedules`, `DELETE /api/feriados`,
  `DELETE /api/horarios`, `GET /api/npm/test`, `POST /api/routes/inbound/:id`,
  `PUT /api/routes/inbound`.
- **Aprobado si:** cero rutas documentadas que no existan y cero rutas del contrato público sin
  documentar.
- **Nota honesta:** que falte OpenAPI **ya está anotado como deuda conocida**
  (`EVALUACION-2026-09.md` §4, línea 225). Lo nuevo es que el documento que hace de contrato
  contradice al código en seis lugares.

### B1.5 · Prohibido leer `x-forwarded-for` crudo

- **Qué se prueba:** una prueba estática (grep sobre `control-plane/*.js`) que permita sólo los dos
  usos legítimos —`telefonia.js` y `marcacion.js`, que lo usan para **rechazar**— y falle ante
  cualquier lectura nueva.
- **Por qué:** `CONTRATOS.md` §2 lo prohíbe con todas las letras («La IP es siempre `req.ip` …
  nunca el primer valor de `X-Forwarded-For`») y `app.js:657` lo hace igual. Es una prueba de
  cuatro líneas que evita que el error vuelva.
- **Aprobado si:** exactamente 2 coincidencias, las dos declaradas.

---

## B2 — Degradación honesta: «el panel dice ≠ la central hace» · días · 🟡 mixto · dueño: `api` + `telefonia`

Esta es la clase de prueba que **hoy no existe en ninguna forma** y la que ataca directamente el
problema de entrega. El patrón correcto **ya está escrito en el repo**: `calls.test.js` verifica
que sin ARI, `/api/calls/live` devuelve `via:'sin-ari'` con listas vacías y `/api/calls/dial`
devuelve **503**, no 200. Son 46 líneas y 16 aserciones que dicen exactamente lo correcto. Falta
aplicarlo parejo.

### B2.1 · Helper `ami-falso.js`

Siguiendo el patrón de `turn-falso.js`, que ya existe y funciona: acepta la conexión y **registra
los comandos recibidos**. Medio día. Es la pieza de la que cuelga todo B2.

### B2.2 · Los `*/apply` no pueden mentir

- **Qué se prueba:** para cada endpoint que aplica configuración a Asterisk: se escribió el
  archivo, **se mandó el reload EXACTO**, y si el reload no se confirmó la respuesta **NO es 200**.
- **Medido hoy, con AMI apuntando a un puerto cerrado:**
  - `POST /api/parking/apply` → **`200 {"ok":true,"cfg":{…},"salida":""}`**
  - `POST /api/moh/apply` → **`200 {"ok":true,"clases":0,"salida":""}`**
  - y el `GET` posterior devuelve la configuración nueva, o sea que el panel muestra el cambio
    aplicado.
  El archivo `pbxng.d/*.conf` se escribió; el `module reload` nunca llegó a ningún lado y el campo
  `salida` viene vacío, que es la única pista y nadie la mira. `astconf.js` lo dice en su propia
  cabecera: *«Sin el reload, el panel dice guardado y Asterisk sigue con lo de antes»*. Su
  cobertura es 39 % y `parking()` y `moh()` **nunca se ejecutan en ninguna prueba**.
- **Aprobado si:** con AMI ausente, 503 o `{ok:false, aplicado:false, motivo}` explícito. Nunca
  200 con campo vacío.

### B2.3 · La marca de grabación no puede divergir

- **Qué se prueba:** `POST /api/endpoints {record:true}` con AMI caído debe devolver un campo de
  aviso, y `ps_endpoints.pbxng_record` no debe quedar en `true` sin que la AstDB lo confirme.
- **Medido hoy:** devuelve **HTTP 201** con
  `{"created":"9001","webrtc":false,"video":false,"vm_mailbox":"9001","vm_pin":"725574"}` — ni un
  campo de aviso. `pbxng_record` queda en `true`, `GET /api/endpoints` informa `record=true`, y la
  clave `rec/<ext>` **nunca se escribió en la AstDB**. El dialplan lee la AstDB
  (`ExecIf($["${DB(rec/${EXTEN})}"="1"]?Set(DOREC=1))`), no Postgres.
- **Por qué es de las peores:** el panel dice que el interno graba, las llamadas de ese interno
  **no se graban**, y nadie se entera hasta que alguien pide una grabación que no existe —
  típicamente semanas después y típicamente cuando hace falta por un reclamo. El backoffice va a
  crear extensiones por API, así que va a pisar esto en el alta masiva.
- **Aprobado si:** el 201/200 trae el aviso y las dos fuentes de verdad no divergen.
- **Quién: 🔴 telefonía** para definir qué significa «confirmado».

### B2.4 · Regla general de degradación

- **Qué se prueba:** barrer las ~30 rutas que dependen de ARI, AMI o del agente de Asterisk y
  afirmar que con el dependiente caído devuelven 503 o `{ok:false, motivo}`, nunca 200 con campo
  vacío.
- **Lo que YA está bien y hay que preservar, no rehacer:** arrancar sin Postgres, sin ARI y sin AMI
  **no tumba el proceso** — medido: queda vivo, `/health` responde **503 `degraded` en 1 ms**
  distinguiendo `degraded` de `shutting_down`, y ARI reintenta con backoff 2 s → 4 s → 8 s. Eso
  hoy se comprueba a mano y **debería ser una prueba de humo automática**.
- **Aprobado si:** cero rutas que contesten 200 con la dependencia caída, y la prueba de humo de
  arranque degradado corre en CI.

### B2.5 · Toda salida HTTP tiene timeout

- **Qué se prueba:** apuntar cada integración saliente a un socket que **acepta y no responde**, y
  verificar que la petición se aborta en ≤ 5 s y queda logueada.
- **Medido:** de 34 `fetch()` en el backend, **14 no llevan `AbortSignal` ni timeout**. `fetch` de
  Node v22.22.2 contra un servidor que acepta la conexión TCP y nunca responde **NO aborta a los
  90 s** (verificado con un script propio). Las 20 que sí lo llevan muestran que el equipo conoce
  el patrón: es homogeneizar, no diseñar.
- **El caso que corre con un humano en línea:** `crmLookup()` (`ai-pipeline.js:133-141`) hace
  `fetch()` **sin timeout** y se lo espera con `await` **dentro del turno de la conversación**
  (`:204` y `:214`, y en `:214` el resultado va directo a `speak()`). El que llamó escucha silencio
  absoluto desde que dijo su consulta hasta que corta, y en el CDR queda como atendida y de
  duración normal: **ni siquiera aparece como un problema en los reportes**.
- **Aprobado si:** `crmLookup()` devuelve la frase de degradación que el propio código ya tiene
  escrita (*«No pude consultar el CRM en este momento»*) **en menos de 3 s**. Hoy sigue colgado a
  los 90 s. **Esta prueba corre en CI**: es la que garantiza el requisito de que una llamada no se
  cae porque el backoffice tardó.

---

## B3 — Cobertura por costo del error · semanas · 🟡 mixto

**No apuntar a un porcentaje: apuntar a las rutas que cuestan plata si se rompen.** Con el arnés que
ya existe, un archivo nuevo por familia son ~150 líneas y sale en un día.

Orden, por costo del error y no por cantidad:

| # | Familia | Rutas hoy sin ninguna prueba | Por qué primero | Quién |
|---|---|---|---|---|
| 1 | `/api/calls` | 9 de 10 (sólo `dial` y `live` tienen) | Escucha, susurro, irrupción, transferencia, aparcado: es lo que el backoffice va a **ordenar**. | 🔴 |
| 2 | `/api/recordings` + `/api/cdr` | 18 + 0 | Datos de terceros, y son las dos familias que el backoffice va a golpear más. | 🟡 |
| 3 | `apps.js` (colas, IVR, buzones) | 5 de 49, 940 líneas, **cero archivo de prueba** | Es el camino por el que entra toda llamada de afuera. | 🔴 |
| 4 | `/api/security` | 12 | Una lista blanca mal escrita deja la central abierta o encierra al cliente afuera. | 🟡 |
| 5 | `/api/endpoints` (alta de internos) | — | Es lo primero que va a usar el backoffice. | 🟡 |
| 6 | `/api/backup` | 9, incluida la restauración | Corre un `psql -f` sobre toda la base. | 🟢 |
| 7 | `/prov/*` (teléfonos físicos) | 4 | MAC desconocida → 404, token mal → 403, `.cfg` bien formado. | 🟢 |

**Meta de primera vuelta: 200 de 350 rutas.** Hoy son 104.

### B3.1 · `apps.test.js`, el que más falta

`apps.js` es el segundo mayor generador de dialplan del repo (7 escrituras a la tabla `extensions`,
empatado con `trunks.js`) y no tiene ni un archivo de prueba. Contenido mínimo, copiando el molde
de `salas.test.js` —que verifica filas, prioridades y saltos exactos—:

- Alta / edición / baja de cola, verificando las filas de `queues` y `queue_members`.
- **El dialplan generado de un IVR de dos niveles**, fila por fila. 🔴
- Alta de buzón por el camino único de `vmpin.js`.
- Códigos de función y su choque con `marcacion.js` en el contexto compartido `internal`.
- **Lista blanca por campo**: para cada campo que llega al `appdata` (`exten`, `greeting`,
  `timeout`, `digit`, `dest_value`, `name` de cola, `members`, `timeout_value`), afirmar que un
  valor con coma, con `)`, con `"` o con `?` devuelve **400**.

  *Medido corriendo la función real (`buildIvrDialplan` extraída de `apps.js:370`):*
  `dest_value='1001,30,g&PJSIP/00598991234567@salida'` → `Dial(PJSIP/1001,30,g&PJSIP/00598991234567@salida,30)`;
  `greeting='demo,9,,9,60'` → `Read(SEL,demo,9,,9,60,1,,1,10)`;
  `digit='1"]?40:100'` → `GotoIf($["${SEL}"="1"]?40:100"]?100)`.
  **Ninguno de los cuatro casos es rechazado ni registrado.** Es el equivalente de lo que
  `trunks.test.js` ya hace para `VALOR_OK`. 🔴
- **Tope del IVR:** generar el dialplan de un IVR y afirmar que el camino de «no marcó nada» llega
  a un `Hangup` en un número acotado de vueltas, y que hay un `TIMEOUT(absolute)`. Hoy no hay
  ninguna de las dos cosas: el IVR cierra con `Goto(<exten>,2)` y vuelve a empezar sin contador.
  Es la única pieza de dialplan del producto sin tope — la DISA tiene `max_intentos` y
  `TIMEOUT(absolute)`, el failover tiene `TOPE=$[${EPOCH} + total]`, el camino de internos tiene el
  guardia `__SALTOS` **y hasta una prueba que lo verifica**. 🔴

### B3.2 · Choque de números en el contexto `ivr`

- **Qué se prueba:** crear una cola, un grupo de timbrado, un voceo y una sala en el **mismo**
  `access_exten` debe dar **409** en el segundo; y borrar el primero **no** debe llevarse el
  dialplan del que quedó. Más las cinco combinaciones cruzadas.
- **Reproducido de punta a punta:** grupo de timbrado en un número → sala en el mismo número: el
  dialplan del grupo desaparece y `pbxng_ringgroups` sigue diciendo que existe. Después se borra el
  grupo → **se lleva puesto el dialplan de la sala**, que queda existiendo en la tabla sin atender a
  nadie. Es literalmente el bug que el encabezado de `dueno-internal.js` describe como resuelto,
  vivo en el contexto hermano.
- **El molde ya está escrito:** `trunks.test.js:187` y `marcacion.test.js:308` hacen exactamente
  esto para `internal`.
- **Aprobado si:** 409 en el segundo y el dialplan del primero intacto tras el borrado.
- **Quién: 🔴 telefonía.**

### B3.3 · Coherencia estático ↔ realtime

- **Qué se prueba:** parsear las extensiones del `[internal]` de
  `docker/config/asterisk/extensions.conf` y afirmar (a) que todas están en `numbering.RESERVADOS`
  o su equivalente, y (b) que `telefonia.publicar()` rechaza publicar un código sobre cualquiera de
  ellas. Más: todo formato que `numbering.check()` acepte como `ok:true` tiene que matchear algún
  patrón del `[internal]`.
- **Medido:** `[internal]` tiene **15 extensiones estáticas**; `numbering.RESERVADOS` lista **7**.
  Faltan `700` (aparcado), `*8` y `_**.` (captura), el patrón `_[1-9]XXX` y las `vm-*`.
  `numbering.check()` acepta `/^\d{2,6}$/` y el dialplan sólo rutea `_[1-9]XXX` (4 dígitos
  empezando en 1-9): todo lo demás queda creado, registrado y **mudo**.
- **Tipo:** estática (archivo contra código), del mismo tipo que los cuatro que ya tiene
  `imagen-asterisk.test.js`.
- **Quién: 🔴 telefonía.**

### B3.4 · Las aplicaciones usadas están cubiertas por el gate de módulos

- **Qué se prueba:** recorrer los nombres de aplicación que aparecen en las llamadas a
  `setDialplan`/`INSERT INTO extensions` de los cinco generadores **más** `extensions.conf`, y
  fallar si alguna no está mapeada a un módulo de las listas del Dockerfile/entrypoint. Es el
  reverso del test que ya existe en `imagen-asterisk.test.js:43`.
- **Medido:** el gate protege `app_disa.so`, que **ningún dialplan generado usa** (la DISA de
  `marcacion.js` está hecha a mano con `Read`/`Dial`), y **no** protege `Page` (voceo) ni
  `MixMonitor` (grabación de colas y de llamadas internas), que sí se usan. Si un cambio de
  `menuselect` deja fuera `app_mixmonitor.so`, el build sale verde, Asterisk arranca perfecto, las
  llamadas cursan, **y la grabación no graba**.
- **Quién: 🔴 telefonía.**

### B3.5 · Los módulos de operación desatendida

`alerts.js` está al **29,8 % de línea y 12,28 % de ramas**; `backup.js` 37,5 %; `recstore.js`
21,4 %; `sysmon.js` 22,0 %. Son los que corren solos, de noche, sin nadie mirando.

- **Alertas**, con el enfoque de `guard.test.js` (que está al 78 % y es buen código): pool y SMTP
  falsos, y afirmar dedupe, severidad, umbrales y detección de login desde IP nueva. **Si dejan de
  disparar, la central se cae en silencio; si disparan de más, el operador las apaga y volvemos al
  mismo lugar.** 🟢
- **Respaldo:** ver B5.3.

---

## B4 — Contrato con el backoffice · semanas · 🟢 externo (el criterio, 🟡) · dueño: `api`

**Bloqueado:** estas pruebas no se pueden escribir hasta que existan `/api/v1`, la credencial de
sistema y la idempotencia. Se diseñan junto con el mecanismo, no después. Las dejo definidas porque
**son las que definen el arreglo**.

### B4.1 · Prueba de contrato del esquema

- **Qué se prueba:** cada respuesta de `/api/v1` validada contra su esquema OpenAPI con `ajv`
  dentro de la suite.
- **Aprobado si:** renombrar un campo o cambiarle el tipo **se pone rojo acá**, no en el cliente.
- **Hoy:** las 539 aserciones de cuerpo miran campos sueltos elegidos a mano, no un esquema. Y
  `/api/cdr` y `/api/recordings` —los dos que un backoffice consume sí o sí— tienen **0 aserciones
  sobre su respuesta porque tienen 0 requests**.

### B4.2 · Autenticación de sistema

- **Qué se prueba:** (a) un token de servicio **revocado deja de funcionar en la petición
  siguiente**, no dentro de 12 h; (b) sus alcances se aplican de verdad — un token con `cdr:read`
  recibe 403 en `POST /api/calls/dial`; (c) la actividad queda atribuida al `client_id` y no a un
  usuario humano.
- **Hoy no se puede escribir**, y esa es exactamente la razón por la que está en la lista: sólo
  existen JWT de panel de 12 h (atado a una fila de usuario humano) y token de teléfono de 30 d.
  Cero coincidencias de `jti`, `revoke`, `denylist`, `blacklist` o `token_version` en todo
  `control-plane/`; `auth()` sólo hace `jwt.verify`.

### B4.3 · Idempotencia

- **Qué se prueba:** el mismo POST con la misma `Idempotency-Key` dos veces crea **un solo**
  recurso y devuelve la misma respuesta; con claves distintas crea dos.
- **Casos concretos, medidos:**
  - `POST /api/calls/dial`: `ari.channels.originate()` sin ninguna clave de deduplicación.
    Reintento tras un timeout de red → **dos tramos facturados por una sola intención**, el interno
    recibe dos llamadas y el destino suena dos veces.
  - `POST /api/clients`: `INSERT` pelado, y verificado en `docs/db-schema.reference.sql:1275-1284`
    que `pbxng_clients` **no tiene ninguna restricción UNIQUE** — ni `name`, ni `doc`, ni `phones`.
    El reintento deja dos fichas del mismo cliente y nada lo impide ni lo detecta después.
  - `POST /api/endpoints` sobre un id existente: el `ON CONFLICT (id) DO UPDATE SET
    password=EXCLUDED.password` de `createSipEndpoint` **rota la contraseña SIP de un interno que
    estaba funcionando** — el teléfono se desregistra hasta que alguien reaprovisione. **Prueba
    destructiva obligatoria.**
- **Aprobado si:** un solo efecto por clave, y `POST /api/calls/dial` repetido hacia el mismo
  `(from,to)` dentro de la ventana devuelve **409 sin originar un segundo canal**.

### B4.4 · Paginación y conciliación del CDR

- **Qué se prueba:** pedir un rango de fechas, verificar que **el corte se avisa explícitamente en
  vez de truncar en silencio**, y que paginar por cursor recorre el conjunto completo sin repetir
  ni saltear filas cuando entran registros nuevos durante el recorrido.
- **Hoy no hay dónde engancharla:** `/api/cdr` acepta exactamente 2 parámetros, `limit`
  (`Math.min(+limit, 500)`) y `ext`. **Sin `from`/`to`, sin cursor.** Cero coincidencias de
  `req.query.offset|cursor|page|after|before` y cero `OFFSET $` en todo `control-plane/`.
  Pedir 501 devuelve 500 igual, recortado en silencio.
- **Detalle medido del mismo handler:** `limit=abc` hace `+('abc')` → `NaN` → `LIMIT 'NaN'` →
  SQLSTATE 22P02 → `errores.js` lo traduce a 400. **Degrada bien, pero por accidente, no por
  validación** — y por lo tanto no hay nada que impida que deje de degradar.

### B4.5 · Canal de eventos (socket.io / webhooks)

- **Qué se prueba:** conexión con token válido y con token inválido; forma del evento `snapshot`
  contra su esquema; que **un cliente que no lee no frene a los demás**; que al reconectar ARI el
  emisor se repone.
- **Hoy: 0 pruebas abren un socket.io**, verificado por grep sobre los 20 archivos. Y es el canal
  por el que la central avisa que entró una llamada.
- **Trampa a probar explícitamente:** `broadcast()` hace `if (busy) return` — si un snapshot está
  en vuelo, **el siguiente se saltea entero**. Un consumidor externo no vería la transición, vería
  un estado nuevo sin saber qué pasó en el medio.
- **Esfuerzo:** ~120 líneas con el arnés actual.

### B4.6 · El backoffice caído: la prueba que decide si la entrega está lista

- **Qué se prueba:** la API con un destino de webhook que devuelve 500 (o que acepta y no responde)
  durante **60 minutos** con tráfico simulado.
- **Aprobado si, al final:** (a) ningún evento perdido; (b) el `pg.Pool` **nunca superó 1 conexión
  ocupada** por el worker — medible con `pg_stat_activity`; (c) un `CURL()` de dialplan simulado
  contra `/api/internal/disa` siguió respondiendo por debajo del presupuesto durante todo el
  período.
- **Por qué (b) es el número que importa:** el pool es de **10 conexiones** y lo comparte la API
  HTTP, el socket, el motor de alertas, el consumidor de call center **y los `CURL()` del
  dialplan** — está escrito en `CONTRATOS.md` §614. El techo a respetar ya existe y está medido en
  `ccreport.js`: **1 conexión de 10, 1 adquisición cada 2 s**, buffer con tope y descarte con aviso.
  Cualquier pieza nueva copia ese techo, no inventa otro.
- **Quién: 🟡 mixto.** El externo la monta; el criterio de «por debajo del presupuesto» es de acá.

---

## B5 — Esquema, datos y respaldo · días · 🟢 externo · dueño: `datos`

### B5.1 · Deriva de checksum de migraciones

- **Qué se prueba:** aplicar las migraciones, **editar una ya aplicada**, correr `migrate.js` y
  exigir que **falle nombrando el archivo**.
- **Medido:** `migrate.js` calcula un sha256 por archivo y lo guarda en
  `pbxng_schema_migrations.checksum`, y **nunca lo compara**: el bucle decide sólo por nombre. Le
  agregué una línea a una migración ya aplicada y reportó **«DB al día (sin migraciones nuevas)»**,
  la columna nueva no existe y el código de salida es 0.
- **Por qué es de entrega y no de código:** la regla «una migración aplicada no se edita, se agrega
  otra» está escrita en `0001_baseline.sql`, en `CONTRATOS.md` §9 y en `RELEASE.md:49` — pero
  **editar el archivo es lo intuitivo** cuando encontrás un error en el SQL que escribiste ayer, y
  es el primer error que comete un equipo que recién llega. En su máquina funciona; en cualquier
  central que ya la tenía aplicada, no se aplica nunca y nadie avisa.
- **Aprobado si:** salida 1 con los dos checksums a la vista. Como el entrypoint corta cuando
  `migrate.js` sale con 1, el contenedor no arranca — que es la política que el resto del archivo
  ya aplica bien.

### B5.2 · Conformidad de esquema

- **Qué se prueba:** congelar un dump de una versión vieja como fixture; levantar dos bases, una con
  `01-schema.sql` + migraciones y otra con el fixture viejo + migraciones; comparar
  `information_schema.tables` y `information_schema.columns` de ambas y fallar ante cualquier
  diferencia no declarada.
- **Medido, y es el caso que la prueba impide:** `0001_baseline.sql` es literalmente `SELECT 1;` —
  el esquema base existe **únicamente** como pg_dump (`01-schema.sql`, 4.724 líneas). Las
  migraciones solas no lo reconstruyen (fallan en `0002`). Borré cuatro tablas que **ninguna
  migración crea y ningún `CREATE TABLE IF NOT EXISTS` del código crea** —`pbxng_ringgroups`,
  `pbxng_paging`, `pbxng_sysprompts`, `pbxng_ivr_options`— corrí `migrate.js`, dijo **«DB al día»**
  con salida 0, y `GET /api/ringgroups`, `/api/paging` y `/api/sysprompts` devolvieron **500**. El
  operador ve «migraciones OK» en el log y tres pantallas muertas en el panel.
- **Consecuencia para el plan:** el arnés **siempre** parte del dump, así que hoy **ninguna prueba
  puede existir** para el camino «instalación vieja que se actualiza».
- **Pedido a `datos`:** son 10 tablas propias de PBX-NG que sólo viven en el dump. Recrearlas en una
  migración es de otro dueño; la prueba es lo que impide que vuelva a pasar.

### B5.3 · Migraciones de DATOS, con datos

- **Qué se prueba:** base con el esquema previo + **filas sembradas** + correr esa migración +
  verificar el estado resultante.
- **Hoy:** el helper aplica `01-schema.sql` + `migrate.js` en cada corrida —lo cual es genuinamente
  bueno: una migración que no aplica rompe el build— pero **siempre sobre una base vacía**: cero
  `INSERT` previos. Las que sólo crean esquema quedan cubiertas; las que **tocan datos** no tienen
  ninguna cobertura.
- **Casos:** `0004` (dos buzones para el mismo interno, uno con email → queda uno), `0008`
  (`operator`/`viewer` → `supervisor`/`agente`), `0017` (un callback en modo pin encendido → queda
  apagado y su extensión desaparece de `extensions`), y los **tres caminos de `0018`** (destino
  fuera de hora / destino principal con IVR / destino principal sin IVR).
- **Nota honesta:** `0018` la probé a mano con datos de fax reales, incluido el camino peor (central
  sin ningún IVR), y **hace exactamente lo que documenta**, aviso incluido. Que ande hoy no es el
  punto: el punto es que si mañana alguien toca la condición, nada en CI lo detecta y el primer
  lugar donde se descubre es la central de un cliente perdiendo un DID.

### B5.4 · Respaldo de ida y vuelta

- **Qué se prueba:** crear respaldo → ensuciar o borrar la base → restaurar → verificar recuento de
  tablas, filas de las tablas que importan, **y que los sha256 del manifiesto se comprobaron**.
  Más el mismo ciclo **entre el esquema de la versión anterior y el actual**.
- **Y las restauraciones que DEBEN fallar:** manifiesto de otro producto (ya cubierto por
  `compatibilidad()`), tar truncado, dump con un objeto que choca. **Hoy los tres devuelven
  `ok:true`**: el restore corre `psql -v ON_ERROR_STOP=0`, descarta el resultado, y
  `hechas.push('base')` es incondicional.
- **El caso feliz anda** y lo medí: 0 errores, 101 tablas, 1.000.000 de filas, tanto sobre base
  vacía como encima de una con datos. El problema es que el código **no puede darse cuenta de que
  salió mal**, y un operador que acaba de perder un disco y ve «OK» deja de buscar otro respaldo.
- **Deuda ya anotada:** la verificación automática de la restauración está pendiente en
  `EVALUACION-2026-09.md` §4. Lo repito porque sin esto el rollback no tiene red de contención.

### B5.5 · Rendimiento con volumen, como assert de plan y no de tiempo

- **Qué se prueba:** sembrar ~200k filas de CDR y exigir que la consulta de `/api/wallboard` y la de
  `recordings.js:293` **se resuelvan por índice** — assert sobre el plan de `EXPLAIN`, **no sobre el
  tiempo**, que es inestable en CI.
- **Medido con 1.000.000 de filas:** la tabla `cdr` **no tiene ni un índice ni clave primaria**. La
  consulta del wallboard —que el panel pide cada 8 s con la pantalla abierta— tarda **137-143 ms**
  contra **1,4 ms** con un índice en `(start DESC)`, y lee 199 MB de buffers con el 37 % desde
  disco. `recordings.js:293` corre **una consulta por grabación nueva** (cada 45 s y además en cada
  `Hangup` del AMI): **75,7 ms**, y con índice **sigue siendo seq scan** porque el predicado
  `abs(extract(epoch from start) - $2) < 300` no es sargable; reescrito como `start BETWEEN` baja a
  **0,28 ms**.
- **Por qué la prueba, y no sólo el arreglo:** es lo que evita que el índice se vuelva a perder en
  un `pg_dump` futuro.

---

## B6 — Laboratorio de llamadas de verdad · semanas · 🔴 telefonía

**Hoy no hay ningún Asterisk en el circuito de pruebas.** Las pruebas de marcación y telefonía son
de las mejores del repo —`marcacion.test.js`, 390 líneas y 145 aserciones, verifica que el PIN de la
DISA **no** quede dentro del dialplan, que el `Dial` vaya después del `GotoIf` que valida, que el
número marcado pase por `FILTER(0-9,…)`, que haya un `TIMEOUT(absolute)` acotado, que ningún salto
apunte a una prioridad inexistente y que no quede ninguna etiqueta `<<x>>` sin resolver— pero **todo
eso mira filas de la tabla `extensions`**. Nadie comprueba que Asterisk las interprete como se
espera.

La separación entre «las filas son correctas» y «la llamada sale por donde debe» no la cubre nada.
Un `${FILTER()}` mal anidado, un contexto que Asterisk resuelve distinto de lo que el generador
asumió, un `exten => i` que no cuelga: las filas pasan la prueba y **la llamada sale por la troncal
equivocada**. En rutas salientes eso es plata directa.

### Qué haría falta montar

Un **perfil de laboratorio sobre el compose que ya existe** (trae Asterisk, Postgres, API y coturn):
agregar un servicio **SIPp** y un script que registre 2-3 extensiones y curse llamadas sintéticas
contra el dialplan generado por el panel.

### Los casos que valen (una docena)

1. Interno ↔ interno.
2. Saliente por **cada patrón** de ruta.
3. Entrante con horario, **dentro y fuera**.
4. Failover de troncal.
5. DISA con PIN bueno y con PIN malo.
6. Cola con agentes y **sin** agentes.
7. Buzón y su correo.
8. IVR: el camino «no marcó nada» **termina** (ver B3.1).
9. Un `${CURL()}` hacia una API que **no responde** no retiene el canal más allá del timeout
   configurado. *Hoy: **0 coincidencias** de `CURLOPT`, `curltimeout` o `conntimeout` en todo el
   repo, y **no existe** `curl.conf`/`res_curl.conf` — los cuatro `CURL()` del camino de la llamada
   (wake de internos, DISA, callback, códigos de función) corren con el default de `func_curl`.*
10. El wake apunta a la API resuelta por el despliegue y **no a una IP escrita a mano**. *Medido:
    `infra/asterisk/extensions.conf:61` tiene una IP hardcodeada, mientras el árbol equivalente
    `docker/config/asterisk/extensions.conf:130` usa el marcador que el despliegue reemplaza.*
11. Un desvío puesto desde el teléfono con la API caída: el dialplan **no** le dice «activado» al
    usuario si el aviso no llegó.
12. Captura de grupo (`*8`) **sin errores en el log de Asterisk**. *Hoy cada captura deja un error:
    `PickupChan(PJSIP/${EXTEN})` pide el canal `PJSIP/*8`, que nunca existe.*

### Costo

**Estimación, no medición: no construí la imagen.** 1 a 2 semanas de montaje, ~1 hora por caso
nuevo después. Es lo más caro de este plan y **lo único que cierra de verdad el camino de la
llamada**.

### Un chequeo estático que sale gratis hoy

Que `infra/asterisk/` **no diverja** de `docker/config/asterisk/` — o, mejor, que `infra/asterisk/`
no exista. **Medido: 4 archivos iguales, 5 distintos** (`extensions.conf` 87 vs 194 líneas,
`modules.conf` 51 vs 97 sin ninguno de los siete `require =`) y 5 que sólo existen en `infra/`. El
`extensions.conf` de `infra/` todavía tiene el `*97` viejo, sin el guard por `CHANNEL(endpoint)`.
Ninguna prueba lo mira, y hay documentación de operaciones que manda usar ese árbol. 🟢 para el
chequeo, 🔴 para decidir qué se borra.

---

## B7 — Carga y capacidad · días (la parte HTTP) + B6 (la parte SIP) · 🟡 mixto

**Hoy no existe ningún número de capacidad defendible.** Nadie sabe cuántas llamadas simultáneas
aguanta este equipo, y eso hay que poder escribirlo en una propuesta.

### B7.1 · Carga HTTP

- **Qué se prueba:** k6 o autocannon, 50 conexiones sostenidas sobre las rutas del contrato, medir
  **p95** y afirmar un techo. Corre de noche en la CI, 5 minutos.
- **Lo medido hoy, y lo que NO afirma:** una ráfaga de 100 peticiones concurrentes a `/api/system` y
  `/api/wallboard` dio **100 × HTTP 200 en 200 ms y 125 ms, cero 429**. **No pude provocar
  agotamiento del pool** sobre una base vacía, así que **no afirmo que el pool de 10 sea
  insuficiente**: lo que sí es seguro es que **no hay nada que lo impida**. `express-rate-limit`
  sólo se usa en `POST /api/auth/login` y `POST /api/phone/token`; las otras ~348 rutas no tienen
  límite alguno. La asimetría es la que importa: la API se defiende del que adivina contraseñas y
  no del que la consume mal, que es justo el riesgo que introduce la integración.

### B7.2 · Carga combinada sobre el pool de 10

- **Qué se prueba:** N `CURL()` de dialplan concurrentes + el worker de eventos + un informe de call
  center a la vez, midiendo la latencia del `CURL()` en el **percentil 99**.
- **Por qué:** es la prueba que cierra el riesgo que `CONTRATOS.md` §614 ya describe en prosa y que
  **nadie ejerció nunca**. El `statement_timeout` de 30 s acota el daño a 30 s, no a infinito, pero
  el escenario —la DISA rechazando PINes correctos porque el pool está tomado— está descrito y no
  medido.
- **Señal de que vale la pena:** `bcrypt` en el login era síncrono y bloqueaba el event loop ~90 ms
  por intento (anotado en `EVALUACION-2026-09.md` §3.3, **ya corregido en 1.4.0**). Esa clase de
  bloqueo del único hilo es exactamente lo que una prueba de carga encuentra y una funcional nunca.

### B7.3 · Carga SIP (requiere B6)

- **Qué se prueba:** 30 llamadas simultáneas cursando mientras se martilla `/api/cdr` y
  `/api/calls/live`; verificar que **ninguna se cae ni se degrada el audio**.
- **Aprobado si:** cero llamadas caídas y el p95 de las dos rutas por debajo del techo de B7.1.
- **Lo que hay que poder escribir al final:** «N llamadas simultáneas con M colas y K agentes, con
  el panel abierto y el backoffice consultando». Hoy ese número **no existe**.

### B7.4 · Regresión del salto del límite de click-to-call

- **Qué se prueba:** 12 peticiones a `POST /api/c2c/public/:token/session` desde la misma IP **sin
  cabecera** → 6 × 200 y 6 × 429; 30 peticiones rotando `X-Forwarded-For` → **6 × 200 y 24 × 429**.
- **Medido hoy:** sin cabecera, 6 pasan y 6 dan 429 (el límite funciona). Rotando
  `X-Forwarded-For`: **30 de 30 pasan, 0 dan 429**, y quedaron 36 filas en `ps_endpoints` y 180
  filas de dialplan creadas por un cliente **sin sesión**, en segundos. Y el Map de límite nunca
  poda: 200.000 pedidos con IP inventada → 200.000 entradas, **61,8 MB de heap**, sobre un
  contenedor con `mem_limit: 768m`.
- **Es el test que hubiera impedido que esto entrara.** 🟢

---

## 5. Regresión de lo que ya nos mordió

Estas son baratas, estáticas y fijan un invariante **que ya se rompió una vez**. Es la clase de
prueba que hay que multiplicar, y el repo ya tiene dos ejemplares muy buenos.

| Incidente | Prueba que lo fija | Estado | Quién |
|---|---|---|---|
| Los tres agentes reportaban la RAM del hipervisor y el panel dibujaba la misma máquina cuatro veces | `metricas-nodo.test.js` | ✅ existe | — |
| Un `require = modulo.so` de `modules.conf` faltaba en las listas de la imagen y Asterisk quedaba en crash-loop sin teléfonos | `imagen-asterisk.test.js` | ✅ existe | — |
| El panel mostraba TURN encendido y el contenedor coturn no existía; `/api/ice` repartía la dirección de un relay que nadie corría | **falta**: comparar `DEF` de `pbxng-reconciler.sh` contra `moduleEnabled()` de `app.js` y fallar ante divergencia no declarada, más un `bats` con `pbxng-ctl` y `psql` falsos verificando las tres decisiones (sin fila / fila 0 / fila 1) | ❌ | 🟡 |
| Un typo en un perfil apaga un módulo en silencio | **falta**: comparar los servicios que `docker compose` resuelve contra los esperados por perfil. *Medido: `COMPOSE_PROFILES=core,turno` resuelve 4 servicios sin coturn, exit 0, sin un solo aviso.* | ❌ | 🟢 |
| El compose de release divergió del canónico y un cliente perdió volúmenes | `check-compose-parity.sh` ✅ — pero **ciego a las imágenes**: medido, cambiar `postgres:16-alpine` por `15-alpine` sólo en el release da **«OK: es espejo», exit 0**, y apuntar el servicio `api` a la imagen del `dashboard` también. Borrar un montaje sí lo caza (exit 1). **Faltan sus propias pruebas negativas.** | ⚠️ parcial | 🟢 |
| React #185 tumbó `/troncales` dos veces | `check-deps-inestables.mjs` ✅ — pero **da OK sobre la trampa exacta que fue creado para atrapar**: sólo marca fallbacks literales (`\|\| []`, `? x : []`), y `troncales/page.jsx:114` es `const astTrunks = ownTrunks` con `ownTrunks = trunks.filter(...)`, invisible para el regex. ESLint **sí** lo ve. **Falta**: una prueba de renders (montar con datos, dos ciclos de encuestado, fallar si supera un umbral) — el análisis estático siempre va a tener agujeros. | ⚠️ parcial | 🟢 |
| `setDialplan()` recibiendo el pool en vez del cliente de la transacción dejaría un DID sin dialplan en una ventana | **falta**: prueba estática de que los 19 puntos de llamada pasan un cliente de transacción. *Verificado a mano hoy: los 19 lo hacen.* Es fácil de romper sin darse cuenta. | ❌ | 🟡 |

---

## 6. El panel dice una cosa y la central hace otra

Es el síntoma que más caro sale y **nace en dos lugares distintos**. Las dos mitades necesitan
pruebas distintas y hay que tratarlas por separado.

**Mitad A — la API confirma lo que no pasó.** Está cubierta por **B2** completo. Es el
`parking/apply` devolviendo 200 sin Asterisk, la marca de grabación que diverge, y las 11
respuestas de 200-con-error.

**Mitad B — el panel interpreta mal lo que la API sí dijo.** Hoy **cero pruebas** en `dashboard/`:
la CI corre `next lint`, `next build` y `check:deps`. Eso detecta que compila; no que la pantalla
muestre lo correcto.

- **B.1 · Humo E2E con Playwright** sobre el laboratorio de B6: login → topología → troncales.
  **Ya anotado como deuda conocida** en `EVALUACION-2026-09.md` §5 bloque 5 — no lo cuento como
  descubrimiento. **Ampliarlo** a que los badges de estado reflejen el JSON de la API y no un color
  por defecto. 🟢
- **B.2 · Smoke de navegación con la API devolviendo 500 en todos los endpoints**: ninguna de las 37
  rutas del menú debe quedar en blanco, y **todas deben mostrar un mensaje de error distinguible de
  «no hay datos»**.
  *Por qué: de 52 llamadas a `usePoll`/`useApi`, **sólo 14 desestructuran `error`** y de esas apenas
  dos lo muestran en pantalla; 38 lo tiran. Con la API devolviendo 500 en `GET /api/trunks`,
  `troncales/page.jsx` renderiza la lista vacía y el diagrama con un solo nodo — **idéntico a una
  central recién instalada sin troncales configuradas**. El operador concluye «se borraron las
  troncales» y el equipo externo recibe un ticket de pérdida de datos por un 500 transitorio.* 🟢
- **B.3 · Unitarias con Testing Library sólo de los componentes que deciden un color o un estado a
  partir de una respuesta.** Son pocos y son los que mienten. El criterio correcto **ya está escrito
  en el repo** y hay que extenderlo, no diluirlo: `fmt.js` → `estadoInfra()` y `estadoNodo()`
  devuelven `{color, texto, detalle, medido}` y **se niegan a pintar de verde lo que no se midió**
  («no se puede comprobar» en vez de un badge verde de adorno). 🟢
- **B.4 · Unitaria de `app/api.js`**, que es la pieza de la que va a colgar toda la integración y
  hoy **no tiene una sola prueba**: 401 (¿borra el JWT y redirige?), 403 (¿toast una sola vez con el
  dedupe de 3 s?), 500 con cuerpo HTML del proxy (¿el mensaje sale del status y no del HTML?), 204
  sin cuerpo, `AbortError` al desmontar (¿NO setea error?). 🟢
- **B.5 · Roles de la UI contra `control-plane/rbac.js`**: para cada rol, que el conjunto de ítems
  de menú y rutas alcanzables sea **exactamente** el que permite la tabla `PERMISOS`.
  *Habría atrapado la discordancia medida: `/seguridad` y `/grabaciones` no están en `SUP_OK`, así
  que el supervisor no las puede abrir — mientras `rbac.js` **sí** le da `GET security` y
  `GET recordings`, y las dos pantallas ya tienen escrito el código para mostrárselas sin los
  botones de admin. La capacidad está pagada dos veces y entregada cero veces.* 🟡

---

## 7. Datos de prueba

**Hoy no hay ninguno.** Una instalación nueva nace con el admin, la empresa y cuatro filas de
configuración. Cada prueba se arma sus propias filas a mano, lo que explica por qué las que existen
son puntuales y por qué nadie escribe pruebas de las pantallas de reporte: **preparar el escenario
cuesta más que la prueba**.

- **Qué:** `docker/config/seed/demo.sql` detrás de un perfil de compose, para que nunca se cuele a
  producción.
- **Contenido:** ~40 internos, 6 grupos de timbrado, 2 colas con 8 agentes, una troncal con 5 rutas
  salientes y 3 entrantes con horario, feriados, ~3.000 CDR repartidos en 60 días con distribución
  creíble de contestadas/perdidas, 20 grabaciones de audio corto.
- **Paga tres veces:** habilita las pruebas de reportes y de carga, sirve de demo, **y es cómo el
  equipo externo va a entender el dominio**. Hoy van a integrar contra una central vacía donde
  `/api/cdr` devuelve `[]` y `/api/queues` no tiene colas, así que no van a descubrir los casos
  raros hasta el cliente.
- **Quién: 🔴 telefonía** para que los datos sean creíbles; 🟢 para cargarlos.

---

## 8. Puertas de CI

En qué orden se encienden. Una puerta que no corta el merge no es una puerta.

| # | Puerta | Qué corta | Bloque | Cuándo |
|---|---|---|---|---|
| 1 | `skipped > 0` en el resumen TAP | Que la suite dé verde sin haber probado | B0.1 | ya |
| 2 | Invariantes del router | 200-con-error, 200-donde-iba-404, `PUBLIC_API` sin guarda | B1.1 | ya |
| 3 | Barrido de RBAC + completitud | Una ruta nueva sin permiso declarado | B1.2 | ya |
| 4 | Deriva de checksum de migraciones | Editar una migración aplicada | B5.1 | ya |
| 5 | `x-forwarded-for` crudo | Que vuelva el salto del límite | B1.5 | ya |
| 6 | Timeout en toda salida HTTP | Que una llamada se caiga porque el backoffice tardó | B2.5 | ya |
| 7 | **Build de las 5 imágenes, sin push**, en PR que toquen `docker/`, `control-plane/` o `dashboard/` | Un Dockerfile roto. *Hoy aparece recién en el job de release, tras 30-50 minutos de runner* | — | pronto |
| 8 | **`install.sh --role=all --yes` en un runner limpio**: 5 contenedores healthy y `/health/ready` 200 | Que el instalador se rompa sin que nadie lo note. *Hoy de `install.sh` sólo se verifica que parsee* | — | pronto |
| 9 | Paridad de compose **incluyendo el mapa servicio → imagen** | El cambio de `postgres:16` a `15` que hoy pasa como «OK» | §5 | pronto |
| 10 | Conformidad de esquema | La deriva que hoy reporta «DB al día» | B5.2 | pronto |
| 11 | Guardia de bundle del panel (techo de First Load JS por ruta) | Una librería pesada en importación estática. *Medido: `/troncales` 319 kB contra 87,9 kB compartido* | — | después |
| 12 | Guardia de código muerto (`knip` o equivalente) | Que un archivo de `app/` quede sin importadores. *Medido: 9 archivos, 1.067 líneas, y `CONTRATOS.md` §2 sigue citando a uno de ellos como vivo* | — | después |
| 13 | Contrato OpenAPI validado con `ajv` | Renombrar un campo del contrato público | B4.1 | tras `/v1` |
| 14 | Carga HTTP nocturna con techo de p95 | Una regresión de latencia | B7.1 | tras B7 |

**Puerta 8 es el pedido explícito del dueño** y hoy no existe en ninguna forma. `scripts/verify-pbxng.sh`
ya hace buena parte de esa verificación a mano: el trabajo es automatizarla, no inventarla.

---

## 9. Reparto: qué puede hacer el equipo externo y qué no

**Regla de corte:** el externo puede escribir toda prueba cuyo criterio de aprobado se pueda leer
del código o del contrato. No puede escribir ninguna cuyo criterio sea «qué hace Asterisk con esto».

### 🟢 Íntegramente del equipo externo (no hace falta saber telefonía)

- B0 completo (guardas del arnés).
- B1.1, B1.4, B1.5 (invariantes del router, documentación que no miente, `x-forwarded-for`).
- B2.5 (timeouts de salida) — el criterio de «3 s» ya está fijado acá.
- B3 ítems 6 y 7 (respaldo, provisioning).
- B3.5 alertas.
- B4.1, B4.3 (contrato de esquema, idempotencia) una vez que exista el mecanismo.
- B5 completo (esquema, migraciones de datos, respaldo de ida y vuelta, plan de consulta).
- B7.1 y B7.4 (carga HTTP, regresión del c2c).
- §6 mitades B.1 a B.4 (panel).
- §5 filas de perfiles y paridad de compose.
- Puertas de CI 1-10 y 13-14.

### 🟡 El externo escribe, alguien de telefonía define el aprobado

- B1.2 (RBAC: qué rol **debe** ver qué).
- B1.3 (alcance por extensión: privacidad de llamadas de terceros).
- B2.2, B2.4 (qué significa «Asterisk lo aplicó»).
- B3 ítems 2, 4, 5.
- B4.6 (cuál es el presupuesto de tiempo que no se puede pasar).
- B7.2, B7.3.
- §5 fila del reconciliador y de `setDialplan()`.
- §6 mitad B.5.

### 🔴 Requiere a alguien que sepa telefonía

- B2.3 (marca de grabación: la AstDB contra Postgres contra el dialplan).
- B3.1 (dialplan generado de un IVR, listas blancas por campo, tope del IVR).
- B3.2 (choque de números en el contexto compartido).
- B3.3 (estático ↔ realtime, precedencia de resolución de Asterisk).
- B3.4 (qué aplicación necesita qué módulo).
- **B6 completo** (laboratorio, los 12 casos, qué se borra de `infra/asterisk/`).
- §7 (que los datos de la semilla sean creíbles).

**Lo mínimo que el equipo externo necesita de este lado para arrancar sin bloquearse:** el OpenAPI
del contrato (B4.1), la semilla `demo.sql` (§7), y una definición escrita de «ruta» para que los
conteos dejen de contradecirse (§2).

---

## 10. Qué NO se prueba, y por qué

Honestidad sobre los límites de este plan:

- **No se prueba contra un Asterisk real fuera de B6.** Todo lo de AMI/ARI se prueba con los puertos
  cerrados —que es el escenario de **degradación**, no el de carga ni el de comportamiento.
- **No hay un número de capacidad hasta que B6 + B7.3 estén.** Cualquier cifra que se escriba en una
  propuesta antes de eso es inventada.
- **No se probó el panel renderizado contra una API viva.** El conteo de renders por ciclo de
  encuestado está razonado sobre el código y sobre el comentario de quien ya lo sufrió, **no medido
  con profiler**. El peso transferido real con compresión, el tiempo hasta el primer píxel y la
  accesibilidad con lector de pantalla tampoco: el conteo de `aria-label` (11 contra 127 botones de
  sólo ícono) es **un indicio, no un veredicto**.
- **No se verificó nftables dentro de un LXC no privilegiado** con `network_mode: host` y `NET_ADMIN`.
  Si el bloqueo de IPs no funciona ahí, el panel va a decir que bloqueó una IP que sigue entrando.
  **Hay dudas serias y no se pudieron despejar.**
- **No se midió el tamaño real de las imágenes ni la cantidad de capas**: no hubo daemon Docker en el
  entorno de auditoría. Todo lo dicho de tamaño sale de leer los Dockerfiles.
- **No se midió el rendimiento del CDR sobre un volcado real de producción**, sólo sobre 1.000.000 de
  filas sintéticas.
- **Tres corridas no alcanzan para afirmar nada sobre intermitencia.** No se observó ninguna; el
  candidato más probable, si algún día parpadea, son las 10 esperas fijas de `guard.test.js`.

---

## 11. Resumen para decidir

| Bloque | Esfuerzo | Qué desbloquea | ¿Bloquea la entrega? |
|---|---|---|---|
| B0 Guardas del arnés | horas | Todo lo demás | **Sí** |
| B1 Propiedades del contrato | días | Cubre 350 rutas de una | **Sí** |
| B2 Degradación honesta | días | «El panel dice ≠ la central hace» | **Sí** |
| B5 Esquema y respaldo | días | El peor día | **Sí** |
| B3 Cobertura por costo | semanas | Las familias que cuestan plata | Parcial (ítems 1-3) |
| B4 Contrato con el backoffice | semanas | La integración bidireccional | **Sí**, tras `/v1` |
| B6 Laboratorio de llamadas | semanas | El camino de la llamada | No, pero nada lo reemplaza |
| B7 Carga y capacidad | días + B6 | El número de la propuesta | No |

**Lo que hay que decir en voz alta:** B0, B1, B2 y B5 son **días de trabajo** sobre un andamiaje que
ya existe y funciona, y cubren la mayor parte del riesgo de entrega. B6 es lo caro y lo único que
cierra el camino de la llamada. Postergar B6 es una decisión legítima; postergar B0 no, porque
desactiva silenciosamente todo lo demás.
