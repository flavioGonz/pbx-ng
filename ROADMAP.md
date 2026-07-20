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
| **Atención de llamadas** | IVR con diseñador visual, colas/ACD, grupos de timbrado, conferencias, buzón de voz por defecto en cada interno, **aparcado de llamadas y captura**, **música en espera administrable** |
| **Softphones** | Web/PWA WebRTC + **app de escritorio Windows** (Electron) con modo WebRTC **y** SIP nativo (UDP/TCP/TLS), SRTP, DTMF, transferencias, y **video H.264 en modo nativo** (recién implementado, sin probar en runtime) |
| **Operación** | CDR propio, grabaciones, monitor de componentes, topología en vivo, wallboard, panel de agente y panel de supervisor (escucha/susurro/irrupción) |
| **Diferenciales** | CRM propio (clientes/personas/espacios/dispositivos), **intercom de video** (porteros/cámaras vía go2rtc), **IA de voz** (TTS con voces uruguayas + STT), click-to-call web, aprovisionamiento de teléfonos, mapa de clientes |
| **Interoperabilidad** | Modo **DTMF por extensión** (RFC 4733 / SIP INFO, para porteros Dahua y Hikvision), **RFC 5626 (Outbound)** con Path, múltiples flujos y keepalive, documento de RFCs cumplidos in-panel |
| **Plataforma** | Appliance por módulos (Docker), instalador interactivo y no interactivo, imágenes versionadas con migraciones, manuales in-panel (instalación, configuración, usuario, escritorio, RFCs) |

---

## 2. Brechas reales para "PBX completa"

Verificado en el código el **2026-07-20**, no supuesto. Lo que cerramos desde la revisión
anterior salió de esta tabla y está en §1.

| Brecha | Estado real | Por qué importa |
|---|---|---|
| **Respaldo y restauración** | **No existe** (0 endpoints en el control-plane) | Es lo que separa un appliance de un proyecto. Hoy, si se muere un disco, recuperar depende de que alguien sepa qué copiar |
| **Reportería histórica** | **No existe** (hay wallboard en vivo y CDR crudo) | Nivel de servicio, abandono, tiempo medio de atención por cola/agente/troncal, exportable. Lo pide cualquier cliente con call center |
| **Migraciones automáticas** | Parcial: existe `migrate.js` pero **el servidor no tiene el directorio `migrations/`** | Hoy actualizar en casa de un cliente depende de acordarse de correr el SQL a mano. Funciona en el lab y falla en la instalación número siete |
| **API pública + webhooks** | No existe | Es lo que hace que un integrador elija esta central sobre otra |
| **Multi-inquilino** | Parcial (`TENANT_MODE`, pantalla de empresas) | Define si se puede vender la central **como servicio** a varios clientes desde una instalación |
| **Alta disponibilidad** | No existe | Requisito para clientes medianos y para pliegos públicos |
| **Horarios / condiciones de tiempo** | No existe | *Decisión de producto: fuera de alcance por ahora.* Se deja anotado porque es lo que más se pregunta en un pliego |
| **Fax / T.38** | No existe | Sólo si aparece la demanda: es trabajo aparte y el mercado se achica todos los años |

### Implementado pero sin probar

Esto es deuda distinta: el código está, nadie lo ejerció.

| Qué | Qué falta para darlo por cerrado |
|---|---|
| **Video en el softphone nativo (SIP, H.264)** | Build de Windows (`npm run dist`) y prueba de interoperabilidad contra Asterisk |
| **Modo router/switch del núcleo** | Un cambio de modo real con commit-confirm, en un equipo que se pueda dejar sin red |

---

## 3. Roadmap propuesto

### 3.1 Ahora — continuidad

1. **Respaldo y restauración desde el panel.** Un archivo con base + configuración +
   certificados + **manifiesto de versión**, y un restore que valide el manifiesto *antes* de
   tocar nada. No cuenta como hecho hasta que un restore real levante en el lab.
2. **Migraciones automáticas al arrancar**, registradas y transaccionales por archivo. Elimina
   una clase entera de fallas en campo.
3. **Probar el video del softphone nativo** y cerrar sus dos limitaciones conocidas (escalado
   audio→video en llamada, y video sobre SRTP — esto último depende del borde).

### 3.2 Próximo — profesionalizar la operación

4. **Reportería histórica** por cola/agente/troncal, exportable.
5. **API pública documentada + webhooks** de eventos de llamada.
6. **Multi-inquilino de verdad**: aislamiento por empresa en todas las pantallas y en la API,
   con administrador por inquilino.

### 3.3 Después — diferenciación y escala

7. **Alta disponibilidad**: núcleo activo/pasivo con base replicada.
8. **App móvil nativa** (hoy PWA): push real con la app cerrada, que es lo único que la PWA no
   resuelve bien.
9. **IA aplicada**: ya hay TTS/STT propios. El salto es transcripción y **resumen automático de
   llamadas** en la ficha del cliente, y detección de intención en el IVR. Acá hay
   diferenciación real frente a centrales tradicionales.
10. **Fax T.38**, sólo contra demanda concreta.

---

## 4. Criterio de "listo para vender sin asteriscos"

Una instalación nueva debería poder: instalarse en menos de una hora, dar de alta extensiones y
troncal, **atender según horario**, grabar, reportar, respaldarse desde el panel, y entregarle al
cliente su softphone de Windows y su PWA — con los manuales adentro del producto.

Hoy falta, de esa lista, **respaldo desde el panel** y **reportería**. (*Horarios* quedó fuera de
alcance por decisión de producto.) El resto está.

---

## 5. Relación con SBC-NG

Que la seguridad de borde viva en SBC-NG es correcto y hay que sostenerlo: la central se
concentra en comunicaciones y el borde en defensa. En la venta se posicionan como
**central + borde**, y PBX-NG debe seguir funcionando **con o sin** SBC-NG delante (hoy lo hace).
El roadmap del borde está en `ROADMAP.md` de SBC-NG.
