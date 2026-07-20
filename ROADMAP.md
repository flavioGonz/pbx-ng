# PBX-NG · Roadmap de producto

> Revisión hecha sobre el código real (36 pantallas del panel, control-plane y config de
> Asterisk), no sobre intenciones. Cada brecha de acá se verificó buscándola en el repo.
>
> **PBX-NG es la central.** El borde (seguridad perimetral, troncales, anclaje de medios,
> ocultamiento de topología) es **SBC-NG**, que es un producto aparte con su propio roadmap.
> Esa separación es una fortaleza comercial: se venden juntos o por separado.

---

## 1. Dónde estamos

Esto ya está hecho y es sólido. Conviene tenerlo presente porque es más de lo que ofrece
mucha competencia:

| Área | Estado |
|---|---|
| **Telefonía base** | Extensiones (realtime en base), troncales, rutas entrantes y salientes, dialplan explicado en el panel |
| **Atención de llamadas** | IVR con diseñador visual, colas/ACD, grupos de timbrado, conferencias, buzón de voz por defecto en cada interno |
| **Softphones** | Web/PWA WebRTC + **app de escritorio Windows** (Electron) con modo WebRTC **y** SIP nativo (UDP/TCP/TLS), SRTP, DTMF, transferencias, y **video H.264 en modo nativo** (recién implementado, sin probar en runtime) |
| **Operación** | CDR propio, grabaciones, monitor de componentes, topología en vivo, wallboard, panel de agente y panel de supervisor (escucha/susurro/irrupción) |
| **Diferenciales** | CRM propio (clientes/personas/espacios/dispositivos), **intercom de video** (porteros/cámaras vía go2rtc), **IA de voz** (TTS con voces uruguayas + STT), click-to-call web, aprovisionamiento de teléfonos, mapa de clientes |
| **Plataforma** | Appliance por módulos (Docker), instalador interactivo y no interactivo, imágenes versionadas con migraciones, manuales in-panel (instalación, configuración, usuario, escritorio, RFCs) |

---

## 2. Brechas reales para "PBX completa"

Estas son funciones **clásicas** que un cliente o un competidor va a preguntar y hoy **no
están** (verificado en el código, no supuesto):

| Brecha | Estado real | Por qué importa |
|---|---|---|
| **Horarios / condiciones de tiempo** | Prácticamente ausente | Es *la* función que pide todo cliente: "de 9 a 18 al IVR, fuera de hora al buzón". Sin esto, la central no se puede vender como completa |
| **Música en espera gestionable** | Mínima, sin administración | Subir/elegir MoH por cola o por sistema es expectativa básica |
| **Fax / T.38** | **No existe** | Todavía hay clientes (estudios, salud, gobierno) que lo exigen para licitar |
| **Aparcado de llamadas (parking)** | **No existe** | Función de recepción clásica: "te la dejo en la 701" |
| **Captura de llamada (pickup)** | **No existe** | "Atender el teléfono del compañero que suena" — se pide siempre en oficinas |
| **Multi-inquilino** | Parcial (`TENANT_MODE`, pantalla de empresas) | Define si podés vender la central **como servicio** a varios clientes desde una instalación |
| **Respaldo y restauración** | Parcial, sin flujo en el panel | Hoy hay que saber qué copiar. Un producto se respalda y restaura desde la pantalla |

---

## 3. Roadmap propuesto

### 3.1 Ahora — cerrar lo que impide decir "PBX completa"

Son las que más ruido hacen en una demo o en un pliego, y ninguna es enorme:

1. **Horarios / condiciones de tiempo.** Tabla de franjas + feriados, y un nodo en el
   diseñador de IVR y en las rutas entrantes: *si está en horario → X; si no → Y*.
2. **Aparcado (parking) y captura (pickup).** Ambas se resuelven en el dialplan con
   configuración; el trabajo real es la UI y los códigos de marcado.
3. **Música en espera administrable.** Subir audios desde el panel (ya tenés el pipeline de
   audios de la IA de voz) y elegir MoH por cola/sistema.
4. **Probar el video del softphone nativo** y cerrar sus dos limitaciones conocidas
   (escalado audio→video en llamada, y video sobre SRTP).

### 3.2 Próximo — profesionalizar la operación

5. **Respaldo y restauración desde el panel**: un botón que exporta base + `.env` + grabaciones
   con un manifiesto de versión, y un restore verificado. Es lo que separa un appliance de un
   proyecto.
6. **Reportería histórica** por cola/agente/troncal (hoy hay wallboard en vivo y CDR crudo):
   nivel de servicio, abandono, tiempo medio de atención, exportable.
7. **Multi-inquilino de verdad**: aislamiento por empresa en todas las pantallas y en la API,
   con administrador por inquilino. Habilita el modelo "PBX como servicio".
8. **API pública documentada + webhooks**: eventos de llamada hacia sistemas del cliente. Es
   lo que hace que un integrador elija tu central sobre otra.

### 3.3 Después — diferenciación y escala

9. **Fax T.38** (o pasarela fax-a-email), sólo si aparece la demanda: es trabajo aparte y
   el mercado se achica todos los años.
10. **Alta disponibilidad**: núcleo activo/pasivo con base replicada. Es requisito para
    clientes medianos y para pliegos públicos.
11. **App móvil nativa** (hoy PWA): push real para llamadas entrantes con la app cerrada, que
    es lo único que la PWA no resuelve bien.
12. **IA aplicada**: ya tenés TTS/STT propios. El salto es transcripción y **resumen automático
    de llamadas** en la ficha del cliente, y detección de intención en el IVR. Acá hay
    diferenciación real frente a centrales tradicionales.

---

## 4. Criterio de "listo para vender sin asteriscos"

Una instalación nueva debería poder: instalarse en menos de una hora, dar de alta extensiones y
troncal, **atender según horario**, grabar, reportar, respaldarse desde el panel, y entregarle al
cliente su softphone de Windows y su PWA — con los manuales adentro del producto.

Hoy falta, de esa lista, **horarios** y **respaldo desde el panel**. El resto está.

---

## 5. Relación con SBC-NG

Que la seguridad de borde viva en SBC-NG es correcto y hay que sostenerlo: la central se
concentra en comunicaciones y el borde en defensa. En la venta se posicionan como
**central + borde**, y PBX-NG debe seguir funcionando **con o sin** SBC-NG delante (hoy lo hace).
El roadmap del borde está en `ROADMAP.md` de SBC-NG.
