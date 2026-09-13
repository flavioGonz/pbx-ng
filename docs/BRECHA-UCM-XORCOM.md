# Qué le falta a PBX-NG para competir con una Grandstream UCM o una Xorcom

Fecha: 2026-09-13 · Versión analizada: 1.8.0 (`45dd905`) · **Actualizado con lo que cerró
1.9.0** (sprint 6: horarios y modo noche, desvíos / DND / sígueme, catálogo de códigos de
función). Lo marcado **✅ 1.9.0** se verificó contra el diff de ese sprint; el resto del
inventario sigue siendo el de 1.8.0.
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
Del bloque A quedan abiertos el control de gasto saliente (COS/PIN), las listas negras y blancas
y el import/export de internos por CSV, que es el sprint 7.

## 2. Dónde estamos parados

| Área | PBX-NG 1.9.0 | UCM6300 | CompletePBX 5 |
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
| **Fax (T.38, a correo, desde la web)** | ❌ | ✅ | ✅ |
| **DISA, callback, marcación abreviada, dial-by-name** | ❌ | ✅ | ✅ |
| **Portal de autoservicio del usuario** | ⚠️ **1.9.0** el agente cambia sus desvíos desde `/agente` y desde el teléfono; no hay portal aparte | ✅ | ✅ |
| **Salas de reunión (PIN, agenda)** | ⚠️ ConfBridge básico | ✅ | ✅ |
| **Reportes de call center (SLA, abandono)** | ⚠️ CDR crudo | ✅ | ✅ |
| **Alta disponibilidad** | ❌ | ✅ Hot Standby | ✅ TwinStar |
| **Multi-tenant real** | ⚠️ `tenant_id` decorativo | — | ✅ MT Manager |
| **Failover de troncal / LCR** | ❌ (el LCR es del SBC-NG) | ✅ | ✅ |
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
   portal de autoservicio como pantalla propia sigue siendo del sprint 8.
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

7. **Fax**: T.38 entrante/saliente, fax a correo y enviar desde el panel. En Uruguay todavía
   lo piden estudios contables, escribanías y organismos públicos.
8. **Reportes de call center**: nivel de servicio, abandono, tiempo medio de espera y de
   conversación, por cola y por agente, con export PDF/CSV y envío programado por correo.
   Hoy hay CDR crudo y métricas en vivo, pero no el informe que firma un supervisor.
9. **Salas de reunión** con PIN, agenda e invitación por correo (hoy hay ConfBridge suelto).
10. **Failover de troncal**: si la principal no responde, salir por la otra, con aviso.
11. **Alta disponibilidad** (un segundo nodo en espera con la base replicada). UCM la vende
    como «Hot Standby» y Xorcom como «TwinStar»; en todo pliego de licitación aparece.
12. **DISA, callback, dial-by-name y marcación abreviada** — baratos y muy visibles en demo.

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
| 7 | COS/PIN de salida + listas negras/blancas + import/export CSV + DISA, callback, abreviada, dial-by-name | Control de gasto y migraciones; todo Bloque A cerrado |
| 8 | Portal de autoservicio del usuario + salas de reunión + reportes de call center | Lo que se ve en la demo y lo que firma el supervisor |
| 9 | Fax (T.38 + a correo + desde el panel) + failover de troncal | Licitaciones |
| 10 | Alta disponibilidad | Pliegos de cliente mediano |
| 11+ | Multi-tenant real, i18n (pt-BR/en), hotelería | Cambian el mercado, no el producto |

Los sprints 6 y 7 son los que más mueven la aguja y son, casi todos, dialplan generado desde
el panel: la maquinaria (`apps.js`, `setDialplan`, realtime) ya está, hay que usarla.

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
