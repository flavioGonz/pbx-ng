# Design

## Context

Ver proposal.md, sección Why. Lo que existe hoy, en la rama `conexion-con-pbx`:

- **`ia-externa.js`:**
  - `CanalControl`: un canal por backend, con latido y reconexión (1, 2, 5 y 10 s), hechos de
    todas las llamadas y órdenes con ack;
  - las órdenes repetidas se contestan sin ejecutar, por id;
  - `abrirRelay` abre un WebSocket por llamada.
- **`ai-pipeline.js`, modo `externo`:**
  - el relay guarda lo que llega antes de que abra (`TOPE_PENDIENTES_RELAY`, 2000) y lo manda
    al abrir;
  - si el relay se cierra, `esperarOrden` espera 5 s (`ESPERA_ORDEN_MS`) y después
    `respaldoExterno` transfiere al destino de respaldo.
- **La sesión con GPT-Live** la abre la central (`realtime.js`) y no depende del relay: si el
  relay se corta, quien llama y el modelo se siguen escuchando.
- **El backend** pasa a ser N instancias detrás de un balanceador round robin. Su cambio gemelo
  (`contrato-pbx-v2` en el repo del asistente) define qué hace con cada mensaje.

## Goals / Non-Goals

**Goals:**
- Que la central funcione con un backend de N instancias detrás de un balanceador, sin afinidad.
- Que una llamada siga si se cae la instancia que la conducía, y que un despliegue del backend
  no la corte.

**Non-Goals:**
- Compatibilidad con un backend v1: se despliegan juntos.
- Retomar la llamada si se reinicia la API de la central: con ella se va la sesión de voz.
- Cambiar el audio, el barge-in, el tono de llamada, el video o el dialplan.

## Decisions

**1. Todo lo de una llamada va por su relay.**
- El primer mensaje es `{ type: 'llamada_nueva', pbxCallId, from, to, origen, configVersion,
  dtmfApertura, destinoAgentes, reanudar, ultimoSeq }`.
- Después, en el mismo socket, van los eventos de la sesión y los hechos (`colgo`, `dtmf`,
  `transferencia`), cada uno con su `seq`. Las respuestas a las órdenes (`ack`,
  `orden_fallida`) no se numeran: se recuerdan por llamada y se repiten si el backend
  reenvía la orden (decisión tomada al implementar, 01/10). Hacia la central llegan los tres comandos de sesión,
  `enganche_confirmado` (con `desde`), `enganche_rechazado` y las órdenes con id.
- **Descartado: dejar el aviso y las órdenes en el canal de control** y que el backend las
  reparta entre sus instancias. Lo evaluó el backend: necesita una cola de órdenes en su base y
  sigue sin poder retomar la llamada.

**2. La cola de órdenes es de la llamada, no del socket.** El registro de ids ya procesados y su
respuesta vive en la sesión de la llamada, así sobrevive a una reapertura del relay. Se limpia
al terminar la llamada.

**3. `seq` y buffer en la sesión de la llamada.**
- Cada evento y cada hecho hacia el backend se numera y se guarda en un buffer circular (el mismo tope de
  2000 que hoy guarda los pendientes, unos 20 s).
- Mientras el relay está cerrado, lo nuevo se sigue numerando y guardando.
- Al reabrir: `llamada_nueva` con `reanudar: true` y `ultimoSeq`. El backend contesta
  `enganche_confirmado` con `desde`, y la central reenvía desde ahí.

**4. Reapertura por ventana, no por espera de orden.**
- Si el relay se cierra sin que la llamada haya terminado:
  - la central reabre enseguida, después cada 1 s, hasta `resumeWindowMs` (lo publica el
    backend en `session-config`);
  - recién al vencer aplica `respaldoExterno`.
- `esperarOrden` (5 s) queda para su caso original: se cerró la sesión de voz y no llegó
  colgar ni transferir.
- Un cierre con 4001 ("reubicar") reabre sin esperar.
- Un cierre después de `session.close` no se reabre: es el final normal de la llamada.

**5. Hechos con el relay cerrado, por HTTP.** El resultado de una transferencia llega después de
que el backend cerró la sesión y el relay. Va por `POST /api/pbx/llamadas/:pbxCallId/hechos`, con
el token y pocos reintentos (3 intentos, con 1 y 2 s entre ellos y un tope de 5 s por intento: unos 18 s en el peor caso). Si no llega, queda en el log de la sesión.

**6. Canal de control solo para la configuración.**
- Se quitan los hechos y las órdenes de llamadas.
- Si el canal está caído, una llamada nueva ya no va al respaldo: intenta abrir el relay. El
  balanceador puede tener instancias sanas aunque la del canal se haya caído.
- Sin configuración bajada, sigue yendo al respaldo, como hoy.

**7. Parámetros.** `resumeWindowMs` llega en la configuración; la central lo acota (de 0 a 60 s)
y usa 20 s si no viene. El buffer y la cadencia de reintentos quedan fijos en la central.

## Risks / Trade-offs

- **[Breaking change]** Una central v1 contra un backend v2, o al revés, manda las llamadas al
  respaldo. → Despliegue coordinado; `docs/CONTRATOS.md` §11 documenta la v2.
- **[Memoria del buffer]** 2000 mensajes por llamada en curso, como el tope actual de los
  pendientes. → Se acepta; se libera al terminar la llamada.
- **[Un hueco más largo que el buffer]** → El backend se entera por el `seq` y sigue. Con la
  ventana de 20 s y unos 20 s de buffer, solo pasa en el límite.
- **[Durante la reapertura no hay conducción]** GPT-Live sigue hablando solo, y una frase que
  tocaba decir sale tarde. → Se acepta: es una caída y la llamada sigue.

## Migration Plan

1. Implementar y probar en local contra el backend v2 con dos instancias y su nginx.
2. Desplegar coordinado con el backend: reconstruir la imagen de la API (Asterisk no cambia).
3. **Rollback:** las dos puntas a la versión anterior juntas.

## Open Questions

Ninguna que cambie el contrato. La cadencia de reintentos y el tope del buffer se pueden ajustar
después de medir en la prueba.
