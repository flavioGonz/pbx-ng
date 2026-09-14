# Qué le falta a PBX-NG para competir con una Grandstream UCM o una Xorcom

Fecha: 2026-09-13 · Versión analizada: 1.8.0 (`45dd905`) · **Actualizado con lo que cerraron
1.9.0** (sprint 6: horarios y modo noche, desvíos / DND / sígueme, catálogo de códigos de
función) **y 1.10.0** (sprint 7: reportes de call center, failover de troncal, DISA / callback /
dial-by-name / marcación abreviada, salas de reunión y fax T.38). Lo marcado **✅ 1.9.0** y
**✅ 1.10.0** se verificó contra el código de cada sprint, no contra el informe de quien lo
hizo; el resto del inventario sigue siendo el de 1.8.0.
Método: inventario real del repo (rutas de la API, pantallas del panel, dialplan que genera
`apps.js`, códigos de función instalables) contra las listas de características **publicadas
por los fabricantes**: la hoja de datos de la serie UCM6300 y la lista de funciones de
CompletePBX 5. No es de memoria: lo que acá dice «no está» se verificó con grep.

## 1. En una frase

PBX-NG ya es mejor que las dos en **seguridad, diagnóstico, IA y verticales propias**, y está
por detrás en **telefonía clásica de oficina**: lo que falta no son cosas difíciles, son cosas
que todo el mundo espera y que se notan en los primeros diez minutos de una demo.

**Con 1.9.0 esa frase se achicó**: los tres agujeros que más se notaban en la demo —horarios y
modo noche, desvíos/DND/sígueme y un catálogo de códigos de función de verdad— están cerrados.
**Con 1.10.0 se cerró casi todo el bloque B**, que es el que se pide por escrito: reportes de
call center, failover de troncal, DISA/callback/dial-by-name/marcación abreviada, salas de
reunión y fax. Queda abierto lo que sigue pesando en un pliego: **alta disponibilidad** (ítem 11,
sin empezar) y, del bloque A, el **control de gasto saliente** (COS/PIN), las **listas negras y
blancas** y el **import/export de internos por CSV**.

## 2. Dónde estamos parados

| Área | PBX-NG 1.10.0 | UCM6300 | CompletePBX 5 |
|---|---|---|---|
| Internos, troncales, rutas | ✅ | ✅ | ✅ |
| IVR (con diseñador visual) | ✅ | ✅ | ✅ |
| Colas, grupos de timbrado, captura, paging, aparcado, MoH | ✅ | ✅ | ✅ |
| Buzón + buzón al correo | ✅ | ✅ | ✅ |
| Grabación (por interno y global) + CDR | ✅ | ✅ | ✅ |
| Supervisión (escuchar / susurrar / irrumpir) | ✅ ARI snoop | ✅ | ✅ |
| Aprovisionamiento de teléfonos | ✅ Grandstream, Yealink | ✅ (propias) | ✅ muchas marcas |
| Softphone propio (escritorio + móvil) | ✅ Windows OTA + PWA | ✅ Wave | ✅ Cloudphone |
| **Horarios / modo noche** | ✅ **1.9.0** | ✅ | ✅ |
| **Desvíos (CFU/CFB/CFNA), DND, sígueme** | ✅ **1.9.0** | ✅ | ✅ |
| **Códigos de función** | ✅ **1.9.0** 15, con el código editable | ✅ decenas | ✅ decenas |
| **COS / PIN de salida / códigos de autorización** | ❌ | ✅ | ✅ |
| **Listas negras y blancas de entrantes** | ❌ | ✅ | ✅ |
| **Fax (T.38, a correo, desde la web)** | ✅ **1.10.0** · el servidor todavía necesita paquetes (ver ítem 7) | ✅ | ✅ |
| **DISA, callback, marcación abreviada, dial-by-name** | ✅ **1.10.0** (API y dialplan; falta la pantalla) | ✅ | ✅ |
| **Portal de autoservicio del usuario** | ⚠️ **1.9.0** el agente cambia sus desvíos desde `/agente` y desde el teléfono; no hay portal aparte | ✅ | ✅ |
| **Salas de reunión (PIN, agenda)** | ✅ **1.10.0** | ✅ | ✅ |
| **Reportes de call center (SLA, abandono)** | ✅ **1.10.0** (sin histórico previo a la actualización) | ✅ | ✅ |
| **Alta disponibilidad** | ❌ **sigue pendiente** | ✅ Hot Standby | ✅ TwinStar |
| **Multi-tenant real** | ⚠️ `tenant_id` decorativo | — | ✅ MT Manager |
| **Failover de troncal / LCR** | ✅ **1.10.0** el failover; el LCR sigue siendo del SBC-NG | ✅ | ✅ |
| **Importar/exportar internos (CSV)** | ❌ | ✅ | ✅ |
| **Idiomas** | ⚠️ sólo español | ✅ | ✅ |
| **Interfaces TDM (E1/PRI, FXO/FXS)** | ❌ sólo SIP | ✅ hardware | ✅ hardware |
| **Hotelería (PMS, wake-up, hot desking)** | ❌ | ⚠️ parcial | ✅ fuerte |
| SOC de seguridad (geo-bloqueo, mapa, vivo) | ✅ **mejor que ambas** | ⚠️ fail2ban básico | ⚠️ IDS básico |
| IVR con IA conversacional | ✅ **no lo tienen** | ❌ | ❌ |
| CRM + encuestas + click-to-call web | ✅ **no lo tienen** | ❌ | ❌ |
| Porteros/intercom con video | ✅ **no lo tienen** | ⚠️ | ❌ |
| Topología y diagnóstico de red | ✅ **no lo tienen** | ❌ | ⚠️ |

## 3. Lo que ya ganamos (y conviene no perder de vista)

No hay que copiar todo: estas cinco cosas son la razón por la que alguien elegiría PBX-NG
en vez de comprar una caja, y ninguna de las dos las tiene.

1. **IVR con IA de verdad** (ARI + AudioSocket + STT/LLM/TTS, voces uruguayas propias).
2. **Centro de operaciones de seguridad**: bloqueo real con nftables, geo-bloqueo por país,
   registro en vivo, mapa. Hoy en pbx01 está frenando ataques solo.
3. **CRM propio, encuestas post-llamada y click-to-call web** — eso en UCM es «integrá por API».
4. **Porteros y cámaras** (Akuvox, Dahua, Hikvision) integrados con video: encaja exactamente
   con el negocio de ÁreaInfo y con lo que ya instalás.
5. **Se mantiene**: Docker versionado, migraciones, tests, CI, panel con contrato. Una UCM es
   una caja negra; esto se puede auditar, extender y vender con código propio.

## 4. Las brechas, por impacto comercial

### Bloque A — sin esto no se vende (lo pregunta el cliente en la primera reunión)

1. **✅ 1.9.0 · Horarios / condiciones de tiempo / modo noche.** Pantalla
   **Telefonía → Horarios y modo noche**: horarios con tramos (`mon-fri 09:00-18:00`), feriados
   anuales y puntuales, y el modo noche en `auto | abierto | cerrado` con indicador en el menú.
   A una ruta entrante se le asigna un horario y un destino fuera de hora, y el DID pasa a
   ocupar tres extensiones (`<did>` decide, `abierto-<did>`, `cerrado-<did>`) con `GotoIfTime`
   por tramo y `DB_EXISTS(hol/…)` para el feriado. La decisión sale de la AstDB, así que poner
   un feriado o apretar el modo noche no recarga dialplan. *Queda*: el estado que muestra el
   panel mira un solo horario, mientras el dialplan evalúa el de cada DID.
2. **✅ 1.9.0 · Desvíos y DND por interno**, incondicional / si ocupado / si no contesta, más
   **sígueme** con tiempo de timbrado configurable. Se cambian desde el panel (solapa «Desvíos y
   no molestar» en Extensiones, tarjeta «Mis desvíos» en el panel de agente) o **desde el
   teléfono** con los códigos; las dos vías dejan Postgres y Asterisk al día. *Queda*: no se
   aplican a llamadas que entran por cola, grupo de timbrado o DID directo a interno, y el
   portal de autoservicio como pantalla propia sigue pendiente (§6, sprint 9).
3. **✅ 1.9.0 · Códigos de función de verdad.** De 4 a 15, y con el **código editable** desde el
   panel (la tabla tiene como clave la acción, no el código): `*78`/`*79` no molestar,
   `*21`/`*22`/`*23` los tres desvíos, `*24` sígueme, `*28` modo noche, más `*43`, `*65`, `*97`
   y `*98`. *Queda*: esos cuatro últimos siguen en el dialplan estático, que gana contra
   realtime, así que se muestran editables sin serlo del todo; y faltan captura dirigida en el
   catálogo, grabación bajo demanda y marcación abreviada.
4. **Control de gasto saliente**: clase de servicio por interno (quién puede llamar a celular,
   larga distancia o internacional), PIN de salida y códigos de autorización con registro en CDR.
   Esto no es una función: es el argumento de venta de una central a un gerente.
5. **Listas negras y blancas de entrantes** (bloquear un número molesto en dos clics).
6. **Importar y exportar internos por CSV.** Toda migración desde otra central empieza ahí.

### Bloque B — cierra licitaciones y clientes medianos

7. **✅ 1.10.0 · Fax**: T.38 entrante/saliente, fax a correo y enviar desde el panel.
   `control-plane/fax.js`, migración `0016_fax.sql`, pantalla `/fax` (bandeja de recibidos y de
   enviados con descarga del PDF, formulario de envío y configuración de cajas y T.38). Una ruta
   entrante se marca como **Fax** y entra a una caja: `ReceiveFAX` → TIFF → PDF → correo, con el
   TIFF guardado. Detección de tono (CNG) en rutas de voz por `fax_detect` del endpoint, que manda
   la llamada a la extensión `fax` del contexto. El envío es una **cola con reintentos** (un fax
   que no entra a la primera es lo normal) y sale por la ruta saliente de siempre, con su troncal,
   su prefijo y su failover. T.38 se pide con `z` pero siempre con respaldo en audio (`f`): con
   SBC-NG en el medio o sin él, el fax sale. Contrato en `docs/CONTRATOS.md` §3 y §5.
   *Queda, y es lo que hay que decir en una demo*: **el fax todavía no funciona en el servidor**.
   La imagen de la API (node:20-slim) no trae `ghostscript` ni `libtiff-tools`, y la de Asterisk
   compila sin `libspandsp-dev`, así que `res_fax_spandsp` no se construye y
   `ReceiveFAX`/`SendFAX` no existen (verificado en `control-plane/Dockerfile` y
   `docker/images/asterisk/Dockerfile`). **Pedido a `empaquetado`**, junto con un volumen de fax
   propio: hoy usa un subdirectorio del volumen `recordings`. Mientras no estén, `GET
   /api/fax/estado` lo detecta y la pantalla lo muestra en rojo con el nombre del paquete. El fax
   por interno (un DID directo a un aparato de fax analógico detrás de un ATA) sigue siendo del
   gateway, no de esto.
8. **✅ 1.10.0 · Reportes de call center**: nivel de servicio, abandono, espera media y máxima
   y conversación media y total, por cola y por agente, con CSV, informe A4 (Imprimir → Guardar
   como PDF, con la misma marca que el informe del CDR) y envío programado por correo diario,
   semanal o mensual. Pantalla **Operación → Reportes de call center**. La fuente **no es el
   CDR** —que no distingue «esperó 40 s en cola y colgó» de «sonó 40 s en un interno»— sino
   `pbxng_queue_events`, que llena un consumidor de eventos AMI de cola. *Queda*: no hay datos
   anteriores a la actualización (la tabla empieza vacía y el informe lo avisa), y no se mide
   todavía el tiempo de pausa ni de sesión del agente.
9. **✅ 1.10.0 · Salas de reunión** con PIN, agenda e invitación por correo (antes había un
   ConfBridge suelto): `control-plane/salas.js`, migración `0014_salas_reunion.sql`, pantalla
   `/salas` (dos PIN, tope de participantes, MoH hasta el moderador, anuncios, grabación,
   agenda, invitación por correo y vista en vivo con silenciar y expulsar). Contrato en
   `docs/CONTRATOS.md` §3. *Queda*: el menú no le muestra la pantalla al supervisor aunque la
   API lo deje moderar (pedido a `panel`).
10. **✅ 1.10.0 · Failover de troncal**: cada ruta saliente tiene una principal y una lista ordenada de
    respaldos. Salta a la siguiente sólo cuando el corte es de la troncal (no responde, congestión,
    503) y **no** cuando lo dijo el destino (486 ocupado, no contesta, número inexistente): eso
    sería hacer sonar el teléfono dos veces y cobrar dos llamadas. El tiempo total está acotado
    (20 s por intento, 45 s de tope) y el aviso por correo (`trunk.failover`) sale **una vez por
    transición**, no una por llamada. En el panel, en Rutas → Salientes, se ordenan los respaldos y
    se ve por cuál troncal está saliendo cada ruta ahora mismo. *Queda*: el LCR de verdad (elegir
    operador por costo y prefijo) sigue siendo del SBC-NG.
11. **❌ SIGUE PENDIENTE · Alta disponibilidad** (un segundo nodo en espera con la base
    replicada). UCM la vende como «Hot Standby» y Xorcom como «TwinStar»; en todo pliego de
    licitación aparece. **Es lo único del bloque B que 1.10.0 no tocó**: no hay una línea de
    código al respecto en el repo, y la respuesta honesta hoy es el procedimiento escrito de
    §7, no una función del producto.
12. **✅ 1.10.0 · DISA, callback, dial-by-name y marcación abreviada** (`control-plane/marcacion.js`,
    migración `0015_marcacion.sql`). **DISA y callback nacen apagados**: son la puerta clásica del
    fraude de tarifación. El PIN vive en bcrypt en Postgres y **nunca** en el dialplan (ahí lo vería
    cualquiera con `dialplan show` o con acceso a la base): el dialplan pregunta por CURL a
    `/api/internal/disa` —loopback + token del agente, el mismo candado que `/api/internal/feature`—
    y la API compara, cuenta intentos por CallerID de origen, bloquea y registra cada uso en
    `pbxng_marcacion_log`. El PIN no puede ser el número de un interno. Qué puede marcar una DISA se
    decide contra la lista de rutas salientes que tiene habilitadas, la duración está acotada con
    `TIMEOUT(absolute)` y se marca con `Local/<num>@internal` para reusar las rutas salientes con su
    prefijo, su CallerID y su failover. El callback exige lista blanca de números (o PIN), con
    tiempo de espera entre llamadas y tope diario. El dial-by-name es `Directory()` con los prompts
    `dir-*`, que ya venían en el paquete de audios en español uruguayo. El callback en modo PIN
    exige además su propia lista de rutas habilitadas (migración `0017_callback_rutas.sql`), que
    **apaga** los que ya estuvieran encendidos: el CallerID al que se devuelve la llamada se
    falsea en cualquier softphone. *Queda, y es lo que impide demostrarlo*: **no hay pantalla en
    el panel**; hoy se configura por API (pedido a `panel`).

### Bloque C — abre mercados nuevos

13. **Multi-tenant real.** Hoy `tenant_id` está en las tablas pero no aísla nada. Con esto
    PBX-NG deja de ser «una central por cliente» y pasa a ser un servicio que se factura por
    empresa: es el cambio de modelo de negocio más grande disponible.
14. **Idiomas (pt-BR e inglés).** El panel es sólo español. Brasil está en el plan de ÁreaInfo
    y de FrioLink; sin portugués no se entra.
15. **Hotelería**: wake-up calls, hot desking, check-in/check-out y interfaz PMS. Es el nicho
    donde Xorcom es fuerte, y en Punta del Este y Gramado hay mercado.
16. **LDAP/Active Directory** y **chat interno** (SIP MESSAGE) para empresas con IT propio.

## 5. Lo que NO conviene copiar

- **Interfaces TDM (E1/PRI, FXO/FXS).** Son hardware. Se resuelve con un gateway SIP de
  terceros y se documenta; meterse ahí es fabricar cajas, no software.
- **Nube del fabricante** (RemoteConnect / GDMS). Ya tenemos proxy propio, ACME y SBC-NG.
- **Tarifación/billing completo.** Con clase de servicio y CDR exportable alcanza para el 90%
  de los casos; facturar es otro producto.

## 6. Plan sugerido

| Sprint | Contenido | Por qué en ese orden |
|---|---|---|
| ~~6~~ **hecho en 1.9.0** | Horarios + modo noche + desvíos/DND/sígueme + catálogo de códigos de función | Es lo que falta para que sea «una central normal» |
| ~~7~~ **hecho en 1.10.0** | Reportes de call center + failover de troncal + DISA/callback/dial-by-name/abreviada + salas de reunión + fax T.38 | Bloque B: es lo que se pide por escrito en una licitación y lo que firma un supervisor |
| 8 | Pantalla de DISA/callback/abreviada + los paquetes de fax + COS/PIN de salida + listas negras/blancas + import/export CSV | Cierra lo que 1.10.0 dejó a medias y lo que queda del Bloque A (control de gasto y migraciones desde otra central) |
| 9 | Portal de autoservicio del usuario | Lo que se ve en la demo |
| 10 | Alta disponibilidad | Pliegos de cliente mediano; es lo único del Bloque B sin empezar |
| 11+ | Multi-tenant real, i18n (pt-BR/en), hotelería | Cambian el mercado, no el producto |

Los sprints 6 y 7 son los que más movieron la aguja y fueron, casi todos, dialplan generado
desde el panel: la maquinaria (`apps.js`, `setDialplan`, realtime) ya estaba, había que usarla.
El 8 es más barato de lo que parece —dos pantallas y dos `apt-get`— y es lo que convierte tres
funciones que hoy existen sólo en la API en algo que se puede mostrar.

## 7. La parte incómoda

Una UCM no gana sólo por funciones: gana porque es **una caja que se compra, se enchufa, se
actualiza desde la propia interfaz y tiene un fabricante detrás**. Para competir de verdad
faltan tres cosas que no son código de telefonía:

- **Actualización desde el panel** (hoy la actualización es `git` + build en el servidor).
- **Instalador y licenciamiento** presentables para un cliente que no es Infratec.
- **Soporte y repuesto**: qué pasa si el servidor se muere un viernes. La alta disponibilidad
  del bloque B es la mitad de la respuesta; la otra mitad es un procedimiento escrito.

Ver también: `docs/EVALUACION-2026-09.md` (deuda técnica interna) y `docs/CONTRATOS.md`.

Fuentes: hoja de datos de la serie UCM6300 (Grandstream) y lista de funciones de CompletePBX 5
(Xorcom), consultadas el 2026-09-13.
