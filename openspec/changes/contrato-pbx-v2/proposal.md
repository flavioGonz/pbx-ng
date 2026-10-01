# Proposal

> **Depende de `conexion-con-pbx`** (la rama del mismo nombre, todavía sin mergear): modifica
> la capacidad `ia-externa` que ese cambio agrega. Hay que archivar `conexion-con-pbx` antes
> que este.

## Why

El backend del asistente de voz corre como N instancias iguales detrás de un balanceador round
robin. El contrato de `conexion-con-pbx` (`docs/CONTRATOS.md` §11) supone una sola, y así no
funciona:
- **El aviso y el relay pueden caer en instancias distintas.** La central avisa la llamada nueva
  por el canal de control, que cae en una instancia, y abre el relay de esa llamada, que el
  balanceador puede mandar a otra. La primera espera un relay que no le llega y la llamada va al
  respaldo.
- **Las órdenes salen de la instancia del canal**, y si esa instancia se cae, se pierden.
- **Si se cae la instancia que conduce una llamada, la llamada va al respaldo**, aunque la
  sesión con GPT-Live siga viva en la central: quien llama y el modelo se siguen escuchando;
  lo que se pierde es la conducción.
- **Un despliegue del backend corta las llamadas en curso.**

El dueño del backend decidió (01/10) que el backend tiene que escalar a N instancias, y ajustar
el contrato: una versión 2, que reemplaza a la 1 y se despliega junto con el backend, sin
transición.

## What Changes

- **BREAKING (contrato con el backend): cada llamada es autocontenida en su relay.**
  - El primer mensaje del relay es el aviso de la llamada nueva, con los mismos datos que hoy
    van por el canal de control, más `reanudar`.
  - Por el relay viajan también las órdenes de esa llamada (colgar, transferir, DTMF) con su
    id, sus acks y sus hechos (colgó, DTMF, orden fallida).
- **La central numera los mensajes del relay** (`seq`) y guarda los últimos (el tope de hoy,
  2000), para reenviar desde donde quedó el backend.
- **Reanudación:**
  - si el relay de una llamada en curso se corta sin que la llamada termine, la central lo
    reabre (enseguida y después cada 1 s, durante la ventana `resumeWindowMs` que publica el
    backend);
  - avisa la llamada con `reanudar: true`, y reenvía desde el `seq` que le pide el backend;
  - recién al vencer la ventana aplica el respaldo.
- **"Reubicar":** si el backend cierra el relay con el código 4001, la central lo reabre al
  instante. Es el apagado ordenado de una instancia.
- **Las órdenes repetidas no se ejecutan dos veces** mientras dure la llamada, aunque cambie el
  relay.
- **Hechos que llegan cuando la llamada ya terminó** (el resultado de la transferencia, con el
  relay cerrado): por HTTP, `POST /api/pbx/llamadas/:pbxCallId/hechos`.
- **El canal de control queda solo para el latido y `refrescar_config`.** Si está caído, ya no
  manda las llamadas al respaldo: cada llamada va por su relay.
- **Sin cambios:** la configuración publicada (salvo el campo nuevo `resumeWindowMs`), el
  audio, el barge-in, el tono de llamada y el video.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `ia-externa`: el aviso, las órdenes, los acks y los hechos de una llamada pasan al relay; el
  canal de control queda para la configuración; requisitos nuevos para reanudar el relay y
  reubicar; cambian el respaldo y la configuración publicada (`resumeWindowMs`).

## Impact

- **Código:** `control-plane/ia-externa.js` (canal solo de configuración, relay v2, cola de
  órdenes por llamada, hechos por HTTP) y `control-plane/ai-pipeline.js` (reapertura del
  relay, `seq` y buffer, respaldo por ventana).
- **Contrato:** `docs/CONTRATOS.md` §11 pasa a la v2.
- **Despliegue:** coordinado con el backend (cambio gemelo `contrato-pbx-v2` en su repo). Una
  central v1 contra un backend v2, o al revés, manda las llamadas al respaldo.
- **No cambia:** Asterisk, el dialplan ni la imagen de Asterisk; solo la API.
